import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  authoritativeQaRecord, decideQaAuthorization, ARTIFACT_CHECK,
  QaBlockedError,
} from "../src/stages/finalVideoQa";
import type { QaRecordLike } from "../src/stages/finalVideoQa";

/**
 * Final-video QA on the AI Doom Scroll unattended path.
 *
 * The runner assembled an MP4 and went straight to YouTube: nothing validated
 * the final render, and nothing bound a verdict to the bytes that were sent.
 * Wet Circuit gained this protection first; these tests pin the same contract
 * on AI Doom's own runner, and pin that Wet Circuit is untouched by it.
 */

const read = (p: string) => readFileSync(p, "utf8");
const PIPELINE = read("src/pipeline.ts");
const QA = read("src/stages/finalVideoQa.ts");
const WC_QA = read("packages/wc-pipeline/src/stages/finalVideoQa.ts");
const WC_PIPELINE = read("packages/wc-pipeline/src/pipeline.ts");

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const rec = (over: Partial<QaRecordLike> & { sha?: string | null } = {}): QaRecordLike => ({
  id: over.id ?? "qa-1",
  overall: over.overall ?? "PASS",
  createdAt: over.createdAt ?? new Date("2026-08-07T12:00:00Z"),
  checks: "checks" in over ? over.checks : [
    { name: "some_other_check", passed: true, severity: "WARN", detail: "x" },
    ...(over.sha === null ? [] : [{
      name: ARTIFACT_CHECK, passed: true, severity: "FATAL",
      detail: "bound", value: over.sha ?? SHA_A,
    }]),
  ],
});

/** The stage list AI Doom actually executes, in order. */
function stages(): string[] {
  const block = PIPELINE.slice(
    PIPELINE.indexOf("const STAGES: StageDefinition[] = ["),
    PIPELINE.indexOf("\n];"),
  );
  return [...block.matchAll(/\{ name: "([a-zA-Z]+)"/g)].map((m) => m[1]);
}

describe("1. stage ordering — assembly then QA then upload", () => {
  test("finalVideoQa sits between assembly and upload", () => {
    const s = stages();
    assert.ok(s.includes("finalVideoQa"), "AI Doom must have a finalVideoQa stage");
    assert.ok(s.indexOf("videoAssembly") < s.indexOf("finalVideoQa"));
    assert.ok(s.indexOf("finalVideoQa") < s.indexOf("youtubeUpload"));
  });

  test("QA is the stage immediately before upload", () => {
    const s = stages();
    assert.equal(s[s.indexOf("youtubeUpload") - 1], "finalVideoQa");
  });

  test("the full order is unchanged apart from the inserted gate", () => {
    assert.deepEqual(stages(), [
      "topicDiscovery", "scriptGenerator", "qualityGate", "visualFeasibilityGate",
      "voiceover", "videoAssembly", "thumbnailHeadlineGenerator", "thumbnailGenerator",
      "seoGenerator", "finalVideoQa", "youtubeUpload", "shortsGenerator", "notify",
    ]);
  });

  test("QA gets no retries — re-measuring the same bytes gives the same answer", () => {
    assert.match(PIPELINE, /\{ name: "finalVideoQa", execute: finalVideoQa, retries: 0 \}/);
  });

  test("upload goes through the guarded wrapper, not the raw shared stage", () => {
    assert.match(PIPELINE, /\{ name: "youtubeUpload", execute: guardedYoutubeUpload/);
  });
});

describe("2-8. artifact binding decides authorization", () => {
  test("2. PASS bound to the same SHA → eligible", () => {
    const d = decideQaAuthorization(rec({ sha: SHA_A }), SHA_A);
    assert.equal(d.ok, true);
    assert.equal(d.ok && d.qaId, "qa-1");
  });

  test("3. FAIL → blocked", () => {
    const d = decideQaAuthorization(rec({ overall: "FAIL" }), SHA_A);
    assert.equal(d.ok, false);
    assert.equal(!d.ok && d.code, "QA_NOT_PASSED");
  });

  test("4. ERROR → blocked", () => {
    const d = decideQaAuthorization(rec({ overall: "ERROR" }), SHA_A);
    assert.equal(!d.ok && d.code, "QA_NOT_PASSED");
  });

  test("5. WARN → blocked", () => {
    const d = decideQaAuthorization(rec({ overall: "WARN" }), SHA_A);
    assert.equal(!d.ok && d.code, "QA_NOT_PASSED");
  });

  test("6. absent QA → blocked", () => {
    const d = decideQaAuthorization(null, SHA_A);
    assert.equal(!d.ok && d.code, "QA_ABSENT");
  });

  test("7a. non-array checks → blocked", () => {
    const d = decideQaAuthorization(rec({ checks: "not-an-array" }), SHA_A);
    assert.equal(!d.ok && d.code, "QA_INCOMPLETE");
  });

  test("7b. no artifact binding at all → blocked", () => {
    const d = decideQaAuthorization(rec({ sha: null }), SHA_A);
    assert.equal(!d.ok && d.code, "QA_INCOMPLETE");
  });

  test("7c. malformed hash in the binding → blocked", () => {
    for (const bad of ["", "zz", "A".repeat(64), "a".repeat(63)]) {
      const d = decideQaAuthorization(rec({ sha: bad }), SHA_A);
      assert.equal(!d.ok && d.code, "QA_INCOMPLETE", `"${bad}" must not authorize`);
    }
  });

  test("8. PASS for an older render + changed video → blocked", () => {
    const d = decideQaAuthorization(rec({ sha: SHA_A }), SHA_B);
    assert.equal(!d.ok && d.code, "QA_STALE_ARTIFACT");
  });

  test("a PASS never authorizes an empty or absent actual hash", () => {
    const d = decideQaAuthorization(rec({ sha: SHA_A }), "");
    assert.equal(d.ok, false);
  });
});

describe("9-11. authoritative record precedence", () => {
  test("9. a newer FAIL beats an older PASS", () => {
    const older = rec({ id: "qa-old", overall: "PASS", createdAt: new Date("2026-08-07T10:00:00Z") });
    const newer = rec({ id: "qa-new", overall: "FAIL", createdAt: new Date("2026-08-07T11:00:00Z") });
    const chosen = authoritativeQaRecord([older, newer]);
    assert.equal(chosen?.id, "qa-new");
    assert.equal(decideQaAuthorization(chosen, SHA_A).ok, false);
  });

  test("10. a newer ERROR beats an older PASS", () => {
    const older = rec({ id: "qa-old", overall: "PASS", createdAt: new Date("2026-08-07T10:00:00Z") });
    const newer = rec({ id: "qa-new", overall: "ERROR", createdAt: new Date("2026-08-07T11:00:00Z") });
    assert.equal(authoritativeQaRecord([older, newer])?.id, "qa-new");
  });

  test("11. an exact timestamp tie is broken by descending id, not the planner", () => {
    const t = new Date("2026-08-07T10:00:00Z");
    const pass = rec({ id: "qa-aaa", overall: "PASS", createdAt: t });
    const fail = rec({ id: "qa-bbb", overall: "FAIL", createdAt: t });
    // Same instant — Postgres now() is transaction-start time, so this happens.
    assert.equal(authoritativeQaRecord([pass, fail])?.id, "qa-bbb");
    assert.equal(authoritativeQaRecord([fail, pass])?.id, "qa-bbb");
  });

  test("input order never changes the winner", () => {
    const a = rec({ id: "qa-1", overall: "PASS", createdAt: new Date("2026-08-07T10:00:00Z") });
    const b = rec({ id: "qa-2", overall: "FAIL", createdAt: new Date("2026-08-07T12:00:00Z") });
    const c = rec({ id: "qa-3", overall: "PASS", createdAt: new Date("2026-08-07T11:00:00Z") });
    for (const order of [[a, b, c], [c, b, a], [b, a, c], [c, a, b]]) {
      assert.equal(authoritativeQaRecord(order)?.id, "qa-2");
    }
  });

  test("no older record is consulted once a newer one exists", () => {
    const stalePass = rec({ id: "qa-1", overall: "PASS", createdAt: new Date("2026-08-07T10:00:00Z") });
    const newerFail = rec({ id: "qa-2", overall: "FAIL", createdAt: new Date("2026-08-07T11:00:00Z") });
    const d = decideQaAuthorization(authoritativeQaRecord([stalePass, newerFail]), SHA_A);
    assert.equal(!d.ok && d.code, "QA_NOT_PASSED");
  });

  test("empty history yields no record", () => {
    assert.equal(authoritativeQaRecord([]), null);
  });

  test("the DB query orders by createdAt then id, matching the pure chooser", () => {
    assert.match(QA, /orderBy: \[\{ createdAt: "desc" \}, \{ id: "desc" \}\]/);
  });
});

describe("12. resume re-checks rather than trusting prior state", () => {
  test("SEO_DONE resumes into finalVideoQa, not youtubeUpload", () => {
    const map = PIPELINE.slice(
      PIPELINE.indexOf("const RESUME_FROM"),
      PIPELINE.indexOf("/** Fails closed"),
    );
    assert.match(map, /\[VideoStatus\.SEO_DONE\]: "finalVideoQa"/);
    assert.ok(!/\[VideoStatus\.SEO_DONE\]: "youtubeUpload"/.test(map));
  });

  test("the upload gate asks QA again at upload time", () => {
    // Walking through the stage earlier is not proof about the current bytes.
    assert.match(PIPELINE, /await assertFinalQaPassed\(ctx\.video\.id, videoPath\)/);
  });

  test("the assertion re-hashes the file rather than trusting a stored hash", () => {
    assert.match(QA, /const actual = await sha256File\(videoPath\)/);
  });

  test("a missing artifact at upload time is refused", () => {
    assert.match(QA, /QA_ARTIFACT_MISSING/);
    assert.match(QA, /if \(!existsSync\(videoPath\)\)/);
  });

  test("no assembled video on the record refuses before any upload call", () => {
    assert.match(PIPELINE, /upload refused: no assembled video on the record/);
  });

  test("a blocked upload returns a failure, never proceeds", () => {
    const guard = PIPELINE.slice(
      PIPELINE.indexOf("async function guardedYoutubeUpload"),
      PIPELINE.indexOf("// ── Stage definitions"),
    );
    const blockIdx = guard.indexOf("upload refused [");
    const proceedIdx = guard.lastIndexOf("return youtubeUpload(ctx);");
    assert.ok(blockIdx > 0 && proceedIdx > blockIdx,
      "the refusal must return before the unguarded upload call");
  });

  test("resume statuses are still derived from RESUME_FROM, not a second list", () => {
    assert.match(PIPELINE, /Object\.keys\(RESUME_FROM\) as VideoStatus\[\]/);
  });
});

describe("13-16. pilot, privacy and budget behaviour unchanged", () => {
  test("13/14. the guard adds no privacy or publishAt handling of its own", () => {
    const guard = PIPELINE.slice(
      PIPELINE.indexOf("async function guardedYoutubeUpload"),
      PIPELINE.indexOf("// ── Stage definitions"),
    );
    for (const t of ["privacyStatus", "publishAt", "scheduledAt", "uploadPolicyFor"]) {
      assert.ok(!guard.includes(t), `the QA guard must not touch ${t}`);
    }
  });

  test("15. guarded upload-intent handling stays in the shared stage", () => {
    const shared = read("packages/pipeline-core/src/stages/youtubeUpload.ts");
    assert.match(shared, /uploadIntent/);
    assert.match(shared, /assertPilotUploadAllowed/);
  });

  test("16. the QA stage opens no budget and reserves nothing", () => {
    for (const t of ["withBudgetWindow", "reserveCredits", "settleCredits", "setBudgetLimit"]) {
      assert.ok(!QA.includes(t), `final-video QA must not call ${t}`);
    }
  });

  test("Shorts remain pilot-skipped and unmoved", () => {
    assert.match(PIPELINE, /\{ name: "shortsGenerator", execute: shortsGenerator, retries: 1, skipDuringPilot: true \}/);
  });

  test("QA reuses the repository's existing gate rather than a new engine", () => {
    assert.match(QA, /runQa, persistQa, formatQa/);
    assert.match(QA, /const result = await runQa\(input\)/);
    assert.match(QA, /await persistQa\(input, result\)/);
  });

  test("the verdict is bound via a check, needing no schema change", () => {
    assert.match(QA, /name: ARTIFACT_CHECK/);
    assert.match(QA, /result\.checks\.push\(binding\)/);
    assert.equal(ARTIFACT_CHECK, "final_video_sha256");
  });

  test("a non-PASS verdict fails the stage, so upload is never reached", () => {
    assert.match(QA, /if \(result\.overall !== "PASS"\)/);
    assert.match(QA, /refusing to upload/);
  });
});

describe("17-18. isolation", () => {
  test("17. AI Doom's QA is scoped to its own channel", () => {
    assert.match(QA, /const CHANNEL = "ai-doom-scroll" as const/);
    assert.match(QA, /channel: CHANNEL/);
    assert.match(QA, /prisma\.video\.findUnique/);
    assert.ok(!QA.includes("wcVideo"), "must not read Wet Circuit's model");
  });

  test("17. Wet Circuit's own QA is untouched and still wet-circuit scoped", () => {
    assert.match(WC_QA, /const CHANNEL = "wet-circuit" as const/);
    assert.match(WC_QA, /prisma\.wcVideo\.findUnique/);
    assert.match(WC_QA, /export async function assertWcFinalQaPassed/);
  });

  test("17. neither module imports the other", () => {
    assert.ok(!QA.includes("wc-pipeline"), "AI Doom QA must not import WC");
    assert.ok(!WC_QA.includes("src/stages"), "WC QA must not import AI Doom");
  });

  test("17. WC keeps its own upload stage and its own QA gate", () => {
    assert.match(WC_PIPELINE, /\{ name: "finalVideoQa",\s+execute: wcFinalVideoQa/);
    assert.match(WC_PIPELINE, /execute: wcYoutubeUpload/);
  });

  test("17. pipeline-core does not import from src/", () => {
    const shared = read("packages/pipeline-core/src/stages/youtubeUpload.ts");
    assert.ok(!shared.includes("src/stages"));
    assert.ok(!shared.includes("finalVideoQa"),
      "the shared upload stage is unchanged; the gate wraps it instead");
  });

  test("18. nothing in the change writes to Video rows outside the pipeline flow", () => {
    // The QA stage persists a qa_record and reads the video; it never updates
    // a Video row, so no already-approved upload can be altered by it.
    assert.ok(!QA.includes("prisma.video.update"));
    assert.ok(!QA.includes("prisma.video.updateMany"));
    assert.ok(!QA.includes("prisma.video.delete"));
  });

  test("the blocked-upload error type is AI Doom's own", () => {
    const e = new QaBlockedError("QA_ABSENT", "x");
    assert.equal(e.name, "QaBlockedError");
    assert.equal(e.code, "QA_ABSENT");
    assert.ok(e instanceof Error);
  });
});
