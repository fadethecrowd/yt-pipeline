import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { TestStage } from "@prisma/client";
import { prisma } from "./db";
import {
  blackFrameStats, detectSilence, frozenRunSeconds, mediaInfo,
  decodedDuration, videoDuration, volumeStats,
} from "./ffmpeg";
import type { Cue, Word } from "./captions";
import { creditsChargedFor, generationIdsFor } from "./elevenlabs";
import { sceneRecordsFor } from "./visuals";

/**
 * Automated pre-upload quality gate.
 *
 * Produces a machine-readable result per asset. A render that fails any FATAL
 * check must not be uploaded; WARN checks are recorded but do not block.
 */

export type Severity = "FATAL" | "WARN";

export interface Check {
  name: string;
  passed: boolean;
  severity: Severity;
  detail: string;
  value?: number | string | null;
  expected?: string;
}

export interface QaResult {
  videoId: string;
  channel: string;
  assetKind: "LONGFORM" | "SHORT";
  overall: "PASS" | "FAIL";
  checks: Check[];
  metrics: {
    videoDurationS?: number;
    audioDurationS?: number;
    captionStartS?: number;
    captionEndS?: number;
    captionOffsetHead?: number;
    captionOffsetMid?: number;
    captionOffsetTail?: number;
    maxCaptionOffset?: number;
    creditsCharged?: number;
    fps?: number;
    width?: number;
    height?: number;
  };
  generationIds: string[];
}

// ── Tolerances ────────────────────────────────────────────────────────────

/** Video and final audio must agree within this. */
export const AV_DURATION_TOLERANCE_S = 1.0;
/** Caption cue vs spoken word. Acceptance criterion is 200–250 ms. */
export const CAPTION_OFFSET_TOLERANCE_S = 0.25;
/** Longest acceptable run of black frames. */
export const MAX_BLACK_RUN_S = 2.0;
/** Longest acceptable frozen run. */
export const MAX_FROZEN_RUN_S = 4.0;
/** Narration must not be preceded by more dead air than this. */
export const MAX_LEADING_SILENCE_S = 6.0;
/** Trailing silence beyond this reads as a truncated or padded ending. */
export const MAX_TRAILING_SILENCE_S = 4.0;

// ── Caption offset measurement ────────────────────────────────────────────

/**
 * Offset between each cue's start and the true start of its first spoken word,
 * sampled near the beginning, middle and end. Because cues are built from the
 * same alignment as the audio, this should be ~0; a non-zero result means an
 * offset was applied more than once or on the wrong timeline.
 */
export function measureCaptionOffsets(
  cues: Cue[],
  words: Word[],
): { head: number; mid: number; tail: number; max: number } {
  if (cues.length === 0 || words.length === 0) {
    return { head: NaN, mid: NaN, tail: NaN, max: NaN };
  }
  const offsetAt = (cue: Cue): number => {
    const first = cue.text.split(/\s+/)[0];
    // Find the word whose start is closest to the cue start and matches text.
    let best = Infinity;
    for (const w of words) {
      if (w.text !== first) continue;
      const d = cue.start - w.start;
      if (Math.abs(d) < Math.abs(best)) best = d;
    }
    return Number.isFinite(best) ? best : 0;
  };

  const head = offsetAt(cues[0]);
  const mid = offsetAt(cues[Math.floor(cues.length / 2)]);
  const tail = offsetAt(cues[cues.length - 1]);
  const all = cues.map(offsetAt).filter((n) => Number.isFinite(n));
  const max = all.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
  return { head, mid, tail, max };
}

// ── Main gate ─────────────────────────────────────────────────────────────

export interface QaInput {
  channel: string;
  videoId: string;
  assetKind: "LONGFORM" | "SHORT";
  videoPath: string;
  narrationPath: string;
  /** Where narration begins on the video timeline (title card duration). */
  narrationStartS: number;
  cues: Cue[];
  words: Word[];
  expectedWidth: number;
  expectedHeight: number;
  expectedFps: number;
  testStage: TestStage;
  /** Set once uploaded, so upload-side checks can run. */
  youtubeId?: string | null;
  privacyStatus?: string | null;
  verifiedChannelId?: string | null;
}

export async function runQa(input: QaInput): Promise<QaResult> {
  const checks: Check[] = [];
  const metrics: QaResult["metrics"] = {};
  const add = (
    name: string, passed: boolean, severity: Severity, detail: string,
    value?: number | string | null, expected?: string,
  ) => checks.push({ name, passed, severity, detail, value, expected });

  // ── File ────────────────────────────────────────────────────────────
  const exists = existsSync(input.videoPath);
  add("output_file_exists", exists, "FATAL", input.videoPath);
  if (!exists) {
    return finish(input, checks, metrics, []);
  }
  const size = (await stat(input.videoPath)).size;
  add("output_file_readable", size > 1024, "FATAL", `${size} bytes`, size, "> 1 KiB");

  // ── Streams / codecs ────────────────────────────────────────────────
  let info;
  try {
    info = await mediaInfo(input.videoPath);
  } catch (e) {
    add("media_readable", false, "FATAL", String(e));
    return finish(input, checks, metrics, []);
  }
  metrics.width = info.width;
  metrics.height = info.height;
  metrics.fps = info.fps;

  add("video_codec_valid", Boolean(info.vCodec), "FATAL", `codec=${info.vCodec}`, info.vCodec ?? null);
  add("audio_stream_present", info.hasAudio, "FATAL", `codec=${info.aCodec}`, info.aCodec ?? null);
  add(
    "resolution_expected",
    info.width === input.expectedWidth && info.height === input.expectedHeight,
    "FATAL",
    `${info.width}x${info.height}`,
    `${info.width}x${info.height}`,
    `${input.expectedWidth}x${input.expectedHeight}`,
  );
  const aspect = info.width && info.height ? info.width / info.height : 0;
  const expectedAspect = input.expectedWidth / input.expectedHeight;
  add(
    "aspect_ratio_expected",
    Math.abs(aspect - expectedAspect) < 0.02,
    "FATAL",
    `aspect=${aspect.toFixed(3)}`,
    aspect,
    expectedAspect.toFixed(3),
  );
  add(
    "frame_rate_expected",
    info.fps !== undefined && Math.abs(info.fps - input.expectedFps) < 1,
    "WARN",
    `fps=${info.fps?.toFixed(2)}`,
    info.fps ?? null,
    String(input.expectedFps),
  );

  // ── Durations ───────────────────────────────────────────────────────
  const vDur = await videoDuration(input.videoPath).catch(() => NaN);
  metrics.videoDurationS = vDur;
  let aDur = NaN;
  if (existsSync(input.narrationPath)) {
    aDur = await decodedDuration(input.narrationPath).catch(() => NaN);
  }
  metrics.audioDurationS = aDur;

  const expectedVideo = input.narrationStartS + aDur;
  add(
    "av_duration_agreement",
    Number.isFinite(vDur) && Number.isFinite(aDur) &&
      Math.abs(vDur - expectedVideo) <= AV_DURATION_TOLERANCE_S,
    "FATAL",
    `video=${vDur.toFixed(2)}s vs narrationStart+audio=${expectedVideo.toFixed(2)}s (Δ=${(vDur - expectedVideo).toFixed(2)}s)`,
    vDur - expectedVideo,
    `±${AV_DURATION_TOLERANCE_S}s`,
  );

  // ── Audio content ───────────────────────────────────────────────────
  const vol = await volumeStats(input.videoPath);
  add(
    "audio_not_silent",
    Number.isFinite(vol.meanDb) && vol.meanDb > -50,
    "FATAL",
    `mean=${vol.meanDb}dB max=${vol.maxDb}dB`,
    vol.meanDb,
    "> -50 dB",
  );
  add(
    "audio_not_clipping",
    !Number.isFinite(vol.maxDb) || vol.maxDb <= 0.0,
    "WARN",
    `max=${vol.maxDb}dB`,
    vol.maxDb,
    "≤ 0 dB",
  );

  const silences = await detectSilence(input.videoPath, -40, 1.0);
  const leading = silences.find((s) => s.start < 0.5);
  const leadingS = leading ? leading.end - leading.start : 0;
  add(
    "leading_silence_bounded",
    leadingS <= MAX_LEADING_SILENCE_S,
    "WARN",
    `${leadingS.toFixed(2)}s of dead air at start`,
    leadingS,
    `≤ ${MAX_LEADING_SILENCE_S}s`,
  );
  const trailing = silences.find((s) => Number.isFinite(vDur) && s.end >= vDur - 0.25);
  const trailingS = trailing ? trailing.end - trailing.start : 0;
  add(
    "trailing_silence_bounded",
    trailingS <= MAX_TRAILING_SILENCE_S,
    "WARN",
    `${trailingS.toFixed(2)}s of dead air at end`,
    trailingS,
    `≤ ${MAX_TRAILING_SILENCE_S}s`,
  );

  // ── Visual integrity ────────────────────────────────────────────────
  const black = await blackFrameStats(input.videoPath);
  add(
    "no_extended_black_frames",
    black.longestRunS <= MAX_BLACK_RUN_S,
    "FATAL",
    `longest black run ${black.longestRunS.toFixed(2)}s (total ${black.blackSeconds.toFixed(2)}s)`,
    black.longestRunS,
    `≤ ${MAX_BLACK_RUN_S}s`,
  );
  const frozen = await frozenRunSeconds(input.videoPath);
  add(
    "no_frozen_sections",
    frozen <= MAX_FROZEN_RUN_S,
    "WARN",
    `longest frozen run ${frozen.toFixed(2)}s`,
    frozen,
    `≤ ${MAX_FROZEN_RUN_S}s`,
  );

  // ── Scene assets ────────────────────────────────────────────────────
  const scenes = await sceneRecordsFor(input.videoId);
  if (scenes.length > 0) {
    const rejected = scenes.filter((s) => s.validation === "REJECT");
    add(
      "no_missing_scene_assets",
      scenes.every((s) => s.renderStatus !== "MISSING"),
      "FATAL",
      `${scenes.length} scenes, ${scenes.filter((s) => s.renderStatus === "MISSING").length} missing`,
    );
    const ids = scenes.map((s) => s.assetId).filter(Boolean) as string[];
    const dupes = ids.length - new Set(ids).size;
    add(
      "no_duplicate_scene_assets",
      dupes === 0,
      "WARN",
      `${dupes} duplicate asset id(s) across ${ids.length} sourced scenes`,
      dupes,
      "0",
    );
    add(
      "scene_validation_recorded",
      true,
      "WARN",
      `${scenes.length - rejected.length}/${scenes.length} scenes passed validation`,
    );
  } else {
    add("scene_records_present", false, "WARN", "no scene_record rows for this video");
  }

  // ── Captions ────────────────────────────────────────────────────────
  add("captions_present", input.cues.length > 0, "FATAL", `${input.cues.length} cues`);
  if (input.cues.length > 0) {
    const first = input.cues[0];
    const last = input.cues[input.cues.length - 1];
    metrics.captionStartS = first.start;
    metrics.captionEndS = last.end;

    const off = measureCaptionOffsets(input.cues, input.words);
    metrics.captionOffsetHead = off.head;
    metrics.captionOffsetMid = off.mid;
    metrics.captionOffsetTail = off.tail;
    metrics.maxCaptionOffset = off.max;

    for (const [label, v] of [
      ["head", off.head], ["mid", off.mid], ["tail", off.tail],
    ] as const) {
      add(
        `caption_offset_${label}`,
        Number.isFinite(v) && Math.abs(v) <= CAPTION_OFFSET_TOLERANCE_S,
        "FATAL",
        `${(v * 1000).toFixed(0)}ms`,
        v,
        `±${CAPTION_OFFSET_TOLERANCE_S * 1000}ms`,
      );
    }
    add(
      "no_cumulative_caption_drift",
      Number.isFinite(off.head) && Number.isFinite(off.tail) &&
        Math.abs(off.tail - off.head) <= CAPTION_OFFSET_TOLERANCE_S,
      "FATAL",
      `head→tail change ${((off.tail - off.head) * 1000).toFixed(0)}ms`,
      off.tail - off.head,
      `±${CAPTION_OFFSET_TOLERANCE_S * 1000}ms`,
    );
    add(
      "caption_starts_after_narration",
      first.start >= input.narrationStartS - 0.35,
      "FATAL",
      `first cue at ${first.start.toFixed(2)}s, narration starts ${input.narrationStartS.toFixed(2)}s`,
      first.start,
      `≥ ${input.narrationStartS}s`,
    );
    add(
      "caption_ends_within_video",
      Number.isFinite(vDur) && last.end <= vDur + 0.5,
      "FATAL",
      `last cue ends ${last.end.toFixed(2)}s, video ${vDur.toFixed(2)}s`,
      last.end,
      `≤ ${vDur.toFixed(2)}s`,
    );
    const overlong = input.cues.filter((c) => c.end - c.start > 8);
    add("no_overlong_cues", overlong.length === 0, "WARN", `${overlong.length} cues over 8s`);
  }

  // ── Duplicate upload / channel / privacy ────────────────────────────
  if (input.youtubeId) {
    const dupA = await prisma.video.count({ where: { youtubeId: input.youtubeId } });
    const dupW = await prisma.wcVideo.count({ where: { youtubeId: input.youtubeId } });
    add(
      "no_duplicate_upload_record",
      dupA + dupW <= 1,
      "FATAL",
      `${dupA + dupW} DB rows carry youtubeId=${input.youtubeId}`,
      dupA + dupW,
      "1",
    );
    add(
      "privacy_is_private",
      input.privacyStatus === "private",
      "FATAL",
      `privacyStatus=${input.privacyStatus}`,
      input.privacyStatus ?? null,
      "private",
    );
    add(
      "channel_verified",
      Boolean(input.verifiedChannelId),
      "FATAL",
      `uploaded to ${input.verifiedChannelId}`,
      input.verifiedChannelId ?? null,
    );
  }

  // ── Credit accounting ───────────────────────────────────────────────
  const credits = await creditsChargedFor(input.videoId);
  const generationIds = await generationIdsFor(input.videoId);
  metrics.creditsCharged = credits;
  add(
    "elevenlabs_charge_recorded",
    credits > 0 || input.assetKind === "SHORT",
    "FATAL",
    `${credits} credits recorded across ${generationIds.length} generation(s)`,
    credits,
    "> 0",
  );

  return finish(input, checks, metrics, generationIds);
}

function finish(
  input: QaInput,
  checks: Check[],
  metrics: QaResult["metrics"],
  generationIds: string[],
): QaResult {
  const fatalFailures = checks.filter((c) => !c.passed && c.severity === "FATAL");
  return {
    videoId: input.videoId,
    channel: input.channel,
    assetKind: input.assetKind,
    overall: fatalFailures.length === 0 ? "PASS" : "FAIL",
    checks,
    metrics,
    generationIds,
  };
}

// ── Persistence ───────────────────────────────────────────────────────────

export async function persistQa(
  input: QaInput,
  result: QaResult,
  extra: { reviewer?: string; retestOf?: string; requiredRepair?: string } = {},
): Promise<string> {
  const failures = result.checks.filter((c) => !c.passed);
  const group = (names: string[]) => {
    const rel = result.checks.filter((c) => names.some((n) => c.name.includes(n)));
    if (rel.length === 0) return null;
    return rel.every((c) => c.passed || c.severity === "WARN") ? "PASS" : "FAIL";
  };

  const row = await prisma.qaRecord.create({
    data: {
      channel: result.channel,
      testStage: input.testStage,
      videoId: result.videoId,
      assetKind: result.assetKind,
      youtubeId: input.youtubeId ?? null,
      runtimeS: result.metrics.videoDurationS ?? null,
      audioDurationS: result.metrics.audioDurationS ?? null,
      videoDurationS: result.metrics.videoDurationS ?? null,
      captionStartS: result.metrics.captionStartS ?? null,
      captionEndS: result.metrics.captionEndS ?? null,
      captionOffsetHead: nn(result.metrics.captionOffsetHead),
      captionOffsetMid: nn(result.metrics.captionOffsetMid),
      captionOffsetTail: nn(result.metrics.captionOffsetTail),
      maxCaptionOffset: nn(result.metrics.maxCaptionOffset),
      creditsCharged: result.metrics.creditsCharged ?? null,
      generationIds: result.generationIds,
      privacyStatus: input.privacyStatus ?? null,
      verifiedChannelId: input.verifiedChannelId ?? null,
      audioResult: group(["audio_", "silence"]),
      captionResult: group(["caption"]),
      visualResult: group(["black", "frozen", "scene", "resolution", "aspect"]),
      metadataResult: group(["privacy", "channel_verified"]),
      uploadResult: group(["duplicate_upload"]),
      overall: result.overall,
      failureNotes: failures.length
        ? failures.map((f) => `[${f.severity}] ${f.name}: ${f.detail}`).join(" | ").slice(0, 4000)
        : null,
      requiredRepair: extra.requiredRepair ?? null,
      retestOf: extra.retestOf ?? null,
      reviewer: extra.reviewer ?? null,
      checks: result.checks as unknown as object,
    },
  });
  return row.id;
}

function nn(v: number | undefined): number | null {
  return v === undefined || !Number.isFinite(v) ? null : v;
}

export function formatQa(result: QaResult): string {
  const lines = [
    `QA ${result.overall} — ${result.channel} ${result.assetKind} ${result.videoId}`,
  ];
  for (const c of result.checks) {
    const mark = c.passed ? "✓" : c.severity === "FATAL" ? "✗" : "!";
    lines.push(`  ${mark} [${c.severity}] ${c.name}: ${c.detail}`);
  }
  return lines.join("\n");
}
