import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  prisma, currentTestStage,
  runQa, persistQa, formatQa,
  readManifest, readAlignments,
  buildLongformCaptions, TITLE_CARD_DURATION,
  sha256File,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult, Check } from "@yt-pipeline/pipeline-core";

/**
 * Automated final-video QA for Wet Circuit, run before upload.
 *
 * Until this existed, `runQa`/`persistQa` were reachable only from the
 * qualification scripts — no production path on either channel validated the
 * assembled video or its captions, so a canary would have uploaded whatever
 * assembly happened to produce.
 *
 * This is Wet Circuit only. AI Doom Scroll's runner is unchanged and does not
 * import this module.
 *
 * The stage does two things:
 *   1. runs the repository's existing QA gate against the real assembled
 *      artifact and the real caption timings, and
 *   2. binds the result to the exact bytes it measured, by recording the final
 *      video's SHA-256 as a check inside the persisted record.
 *
 * (2) is what makes the upload-side gate meaningful. A QA row that merely says
 * "this videoId passed" is satisfied by a stale pass from an earlier render;
 * a row that says "this videoId passed, and the file was <hash>" is not.
 */

const CHANNEL = "wet-circuit" as const;
const LOG = "[wc:finalVideoQa]";

/** Check name carrying the SHA-256 of the artifact QA actually measured. */
export const ARTIFACT_CHECK = "final_video_sha256";

/** Assembly renders at a fixed profile; QA asserts the render matches it. */
const EXPECTED_WIDTH = 1920;
const EXPECTED_HEIGHT = 1080;
const EXPECTED_FPS = 30;

export class WcQaBlockedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WcQaBlockedError";
  }
}

/**
 * Rebuild QA's inputs from durable artifacts rather than from pipeline context.
 *
 * The narration manifest on disk is the same timeline assembly rendered
 * against, so this reproduces the exact caption timings without re-deriving
 * them from MP3 headers — and it works identically on a resumed run, where the
 * in-memory assembly outcome is long gone.
 */
async function qaInputsFor(videoId: string, videoPath: string) {
  const audioDir = join(process.cwd(), "audio", videoId);
  const manifest = await readManifest(audioDir);
  if (!manifest) {
    throw new WcQaBlockedError(
      "QA_NO_MANIFEST",
      `no narration manifest at ${audioDir} — cannot verify caption timing`,
    );
  }
  const alignments = await readAlignments(manifest);
  const captions = buildLongformCaptions(
    alignments,
    manifest.segments.map((s) => s.offsetS),
    TITLE_CARD_DURATION,
  );
  return {
    channel: CHANNEL,
    videoId,
    assetKind: "LONGFORM" as const,
    videoPath,
    narrationPath: manifest.finalPath,
    narrationStartS: TITLE_CARD_DURATION,
    cues: captions.cues,
    words: captions.words,
    expectedWidth: EXPECTED_WIDTH,
    expectedHeight: EXPECTED_HEIGHT,
    expectedFps: EXPECTED_FPS,
    testStage: currentTestStage(),
  };
}

/**
 * Stage: validate the assembled video and its captions, and persist the verdict.
 *
 * Fails closed. A QA failure marks the candidate FAILED via the orchestrator's
 * normal stage-failure path, so it never reaches upload.
 */
export async function wcFinalVideoQa(ctx: PipelineContext): Promise<StageResult> {
  const start = Date.now();

  if (process.env.DISABLE_ELEVEN === "true") {
    // The dry-run path produces no real render to measure, and the upload
    // stage short-circuits before its QA gate on the same switch.
    console.log(`${LOG} DISABLE_ELEVEN active — skipping final-video QA`);
    return { success: true, durationMs: Date.now() - start };
  }

  const video = await prisma.wcVideo.findUnique({ where: { id: ctx.video.id } });
  if (!video?.videoPath || !existsSync(video.videoPath)) {
    return {
      success: false,
      error: `final-video QA: no assembled video at ${video?.videoPath ?? "(unset)"}`,
      durationMs: Date.now() - start,
    };
  }

  let input;
  try {
    input = await qaInputsFor(ctx.video.id, video.videoPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `final-video QA: ${msg}`, durationMs: Date.now() - start };
  }

  const result = await runQa(input);

  // Bind the verdict to the exact bytes measured. Recorded as a check so it
  // travels into `qa_record.checks` through the existing persistence path —
  // no schema change, no new table, no new column.
  const fileSha256 = await sha256File(video.videoPath);
  const binding: Check = {
    name: ARTIFACT_CHECK,
    passed: true,
    severity: "FATAL",
    detail: `QA measured the artifact with sha256 ${fileSha256}`,
    value: fileSha256,
  };
  result.checks.push(binding);

  const qaId = await persistQa(input, result);
  console.log(formatQa(result));
  console.log(`${LOG} persisted ${qaId} overall=${result.overall} sha256=${fileSha256.slice(0, 16)}…`);

  if (result.overall !== "PASS") {
    return {
      success: false,
      error: `final-video QA ${result.overall} — refusing to upload (record ${qaId})`,
      durationMs: Date.now() - start,
    };
  }
  return { success: true, durationMs: Date.now() - start };
}

/** The subset of a qa_record this decision needs. */
export interface QaRecordLike {
  id: string;
  overall: string;
  checks: unknown;
  createdAt: Date;
}

export type QaDecision =
  | { ok: true; qaId: string }
  | { ok: false; code: string; message: string };

/**
 * The one record that decides, chosen deterministically.
 *
 * "Latest wins" is the whole precedence rule: a newer FAIL, ERROR, WARN,
 * malformed record or differently-bound PASS must supersede an older PASS, and
 * no older record may be consulted once a newer one exists. Anything that
 * searched backward for a passing record would make a stale PASS permanently
 * sufficient — the exact failure this control exists to prevent.
 *
 * `createdAt` alone is not enough to order them. Postgres `now()` is
 * transaction-start time, so two records written in one transaction share a
 * timestamp exactly, and equal timestamps leave the winner to the planner. A
 * tie between an older PASS and a newer FAIL would then be decided arbitrarily.
 * `id` breaks it: cuids are timestamp-prefixed, so descending id agrees with
 * creation order and is a total order regardless.
 */
export function authoritativeQaRecord<T extends QaRecordLike>(records: T[]): T | null {
  if (records.length === 0) return null;
  return [...records].sort((a, b) => {
    const t = b.createdAt.getTime() - a.createdAt.getTime();
    return t !== 0 ? t : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  })[0];
}

/**
 * Whether the authoritative record authorizes uploading `actualSha256`.
 *
 * Pure, so every precedence case is provable without a database, a render or a
 * network call. Evaluates exactly one record — the caller has already chosen
 * it — and never falls back to another.
 */
export function decideQaAuthorization(
  record: QaRecordLike | null,
  actualSha256: string,
): QaDecision {
  if (!record) {
    return { ok: false, code: "QA_ABSENT", message: "no final-video QA record — upload refused" };
  }
  if (record.overall !== "PASS") {
    return {
      ok: false, code: "QA_NOT_PASSED",
      message: `latest final-video QA is ${record.overall} (record ${record.id}) — upload refused`,
    };
  }
  if (!Array.isArray(record.checks)) {
    return {
      ok: false, code: "QA_INCOMPLETE",
      message: `QA record ${record.id} has no check list — cannot prove which artifact it measured`,
    };
  }
  const bound = (record.checks as Check[]).find((c) => c?.name === ARTIFACT_CHECK);
  const recorded = typeof bound?.value === "string" ? bound.value : null;
  if (!recorded || !/^[0-9a-f]{64}$/.test(recorded)) {
    return {
      ok: false, code: "QA_INCOMPLETE",
      message: `QA record ${record.id} carries no usable ${ARTIFACT_CHECK} binding — upload refused`,
    };
  }
  if (recorded !== actualSha256) {
    return {
      ok: false, code: "QA_STALE_ARTIFACT",
      message:
        `QA record ${record.id} measured ${recorded.slice(0, 16)}… but the file to upload is ` +
        `${actualSha256.slice(0, 16)}… — the artifact changed after QA; upload refused`,
    };
  }
  return { ok: true, qaId: record.id };
}

/**
 * Upload precondition: the LATEST QA verdict is a PASS bound to the artifact
 * about to be sent.
 *
 * Stage ordering alone is not a control — a resumed run, a hand-edited status,
 * or a re-render after QA all reach upload without QA having seen the current
 * bytes. So the upload stage asks this directly and refuses on anything short
 * of an exact match against the authoritative record.
 */
export async function assertWcFinalQaPassed(
  videoId: string,
  videoPath: string,
): Promise<{ qaId: string; sha256: string }> {
  if (!existsSync(videoPath)) {
    throw new WcQaBlockedError("QA_ARTIFACT_MISSING", `no artifact at ${videoPath}`);
  }
  const actual = await sha256File(videoPath);

  // Every record for this asset is fetched and the authoritative one chosen in
  // one place, rather than asking the database for "the newest" and trusting a
  // single-column sort to be total. Rows per video are a handful.
  const records = await prisma.qaRecord.findMany({
    where: { videoId, channel: CHANNEL, assetKind: "LONGFORM" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const record = authoritativeQaRecord(records);

  const decision = decideQaAuthorization(record, actual);
  if (!decision.ok) {
    throw new WcQaBlockedError(decision.code, decision.message);
  }
  return { qaId: decision.qaId, sha256: actual };
}
