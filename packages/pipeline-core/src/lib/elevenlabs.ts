import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestStage } from "@prisma/client";
import { prisma } from "./db";
import { reserveCredits, settleCredits } from "./budget";

// ── Constants ─────────────────────────────────────────────────────────────

/** Voice quality is deliberately NOT reduced to stretch the credit balance. */
export const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2";
export const ELEVEN_OUTPUT_FORMAT =
  process.env.ELEVENLABS_OUTPUT_FORMAT ?? "mp3_44100_128";
export const ELEVEN_STABILITY = Number(process.env.ELEVENLABS_STABILITY ?? 0.5);
export const ELEVEN_SIMILARITY = Number(process.env.ELEVENLABS_SIMILARITY ?? 0.75);

const API_BASE = "https://api.elevenlabs.io";

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * Character-level timing returned by ElevenLabs for the exact audio bytes it
 * also returned. Times are seconds relative to the start of THIS segment.
 */
export interface Alignment {
  characters: string[];
  startTimes: number[];
  endTimes: number[];
}

export interface SynthesisResult {
  segmentIndex: number;
  path: string;
  alignmentPath: string;
  alignment: Alignment;
  requestedChars: number;
  chargedChars: number | null;
  generationId: string | null;
  requestId: string | null;
  reused: boolean;
}

export interface SynthesizeOptions {
  channel: string;
  videoId: string;
  segmentIndex: number;
  text: string;
  voiceId: string;
  apiKey: string;
  audioDir: string;
  testStage: TestStage;
  runId?: string;
  /** Set on a deliberate regeneration so the usage row explains the re-charge. */
  retryReason?: string;
  /**
   * Delivery speed for this request only. Absent means the API default and an
   * unchanged request body. Part of the idempotency key, so audio generated at
   * one speed is never silently reused for another.
   */
  speed?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Identity of a generation request. Includes every input that changes the
 * audio, so a script edit or a voice/model/format change correctly misses the
 * cache while a downstream render/upload failure hits it.
 */
export function scriptHashFor(
  text: string,
  voiceId: string,
  model = ELEVEN_MODEL,
  outputFormat = ELEVEN_OUTPUT_FORMAT,
  stability = ELEVEN_STABILITY,
  similarity = ELEVEN_SIMILARITY,
  /** Included only when a request-scoped speed was used, so existing hashes are stable. */
  speed?: number,
): string {
  return createHash("sha256")
    .update(
      // `speed` is folded in only when set, so every hash produced before
      // request-scoped speed existed still matches and prior audio is reused.
      JSON.stringify(speed === undefined
        ? { text, voiceId, model, outputFormat, stability, similarity }
        : { text, voiceId, model, outputFormat, stability, similarity, speed }),
    )
    .digest("hex");
}

function parseAlignment(raw: any): Alignment {
  const a = raw?.alignment ?? raw?.normalized_alignment;
  if (!a) throw new Error("ElevenLabs response contained no alignment block");
  const characters: string[] = a.characters ?? [];
  const startTimes: number[] = a.character_start_times_seconds ?? [];
  const endTimes: number[] = a.character_end_times_seconds ?? [];
  if (
    characters.length === 0 ||
    characters.length !== startTimes.length ||
    characters.length !== endTimes.length
  ) {
    throw new Error(
      `Malformed alignment: chars=${characters.length} starts=${startTimes.length} ends=${endTimes.length}`,
    );
  }
  return { characters, startTimes, endTimes };
}

// ── Main ──────────────────────────────────────────────────────────────────

/**
 * Generate (or reuse) the voiceover for one script segment.
 *
 * Uses the `/with-timestamps` endpoint so we receive character-level timings
 * for the exact audio bytes we render. Captions are built from these — never
 * from words-per-minute estimates — which is what keeps them aligned to the
 * final narration.
 *
 * Idempotency: a successful ElevenLabsUsage row for
 * (videoId, segmentIndex, scriptHash) whose audio AND alignment sidecar are
 * still on disk is reused verbatim. A failed render, caption, thumbnail or
 * upload step therefore never re-charges for audio that already exists.
 *
 * Every attempt — success or failure — writes an ElevenLabsUsage row carrying
 * the real `character-cost`, `request-id` and `history-item-id` from the
 * response headers.
 */
export async function synthesizeSegment(
  opts: SynthesizeOptions,
): Promise<SynthesisResult> {
  const {
    channel, videoId, segmentIndex, text, voiceId, apiKey,
    audioDir, testStage, runId, retryReason, speed,
  } = opts;

  // Request-scoped delivery speed. Omitted entirely when not supplied, so the
  // default request body — and every existing caller — is byte-for-byte
  // unchanged. Only a caller that asks for a speed gets one.
  if (speed !== undefined && (speed < 0.7 || speed > 1.2)) {
    throw new Error(`ElevenLabs speed ${speed} outside the supported 0.7-1.2 range`);
  }

  const scriptHash = scriptHashFor(
    text, voiceId, ELEVEN_MODEL, ELEVEN_OUTPUT_FORMAT,
    ELEVEN_STABILITY, ELEVEN_SIMILARITY, speed,
  );
  const audioPath = join(audioDir, `segment-${segmentIndex}.mp3`);
  const alignmentPath = join(audioDir, `segment-${segmentIndex}.alignment.json`);
  await mkdir(audioDir, { recursive: true });

  // ── 1. Reuse an existing, complete generation ─────────────────────────
  if (!retryReason) {
    const prior = await prisma.elevenLabsUsage.findFirst({
      where: { videoId, segmentIndex, scriptHash, success: true },
      orderBy: { createdAt: "desc" },
    });
    if (prior && existsSync(audioPath) && existsSync(alignmentPath)) {
      const alignment = JSON.parse(await readFile(alignmentPath, "utf8")) as Alignment;
      await prisma.elevenLabsUsage.create({
        data: {
          channel, testStage, runId, videoId, segmentIndex, scriptHash,
          generationId: prior.generationId, requestId: prior.requestId,
          model: prior.model, voiceId, outputFormat: prior.outputFormat,
          requestedChars: text.length,
          chargedChars: 0, // reuse costs nothing
          attempt: prior.attempt,
          outputPath: audioPath,
          audioDurationS: prior.audioDurationS,
          success: true, reused: true,
        },
      });
      console.log(
        `[eleven] segment ${segmentIndex}: REUSED prior generation ${prior.generationId ?? "?"} (0 credits)`,
      );
      return {
        segmentIndex, path: audioPath, alignmentPath, alignment,
        requestedChars: text.length, chargedChars: 0,
        generationId: prior.generationId, requestId: prior.requestId,
        reused: true,
      };
    }
  }

  // ── 2. Reserve budget before spending ─────────────────────────────────
  const attempt =
    (await prisma.elevenLabsUsage.count({ where: { videoId, segmentIndex } })) + 1;

  await reserveCredits(channel, testStage, text.length);

  // ── 3. Call ElevenLabs ────────────────────────────────────────────────
  let res: Response;
  try {
    res = await fetch(
      `${API_BASE}/v1/text-to-speech/${voiceId}/with-timestamps?output_format=${ELEVEN_OUTPUT_FORMAT}`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: ELEVEN_MODEL,
          voice_settings: {
            stability: ELEVEN_STABILITY,
            similarity_boost: ELEVEN_SIMILARITY,
            ...(speed !== undefined ? { speed } : {}),
          },
        }),
      },
    );
  } catch (err) {
    await settleCredits(channel, testStage, text.length, 0);
    await recordFailure(opts, scriptHash, attempt, String(err));
    throw err;
  }

  const chargedChars = res.headers.get("character-cost")
    ? Number(res.headers.get("character-cost"))
    : null;
  const requestId = res.headers.get("request-id");
  const generationId = res.headers.get("history-item-id");

  if (!res.ok) {
    const body = await res.text();
    // A non-2xx response is not charged; release the full reservation.
    await settleCredits(channel, testStage, text.length, chargedChars ?? 0);
    await recordFailure(
      opts, scriptHash, attempt,
      `HTTP ${res.status}: ${body.slice(0, 300)}`,
      { chargedChars, requestId, generationId },
    );
    throw new Error(`ElevenLabs ${res.status} (segment ${segmentIndex}): ${body.slice(0, 300)}`);
  }

  const body = (await res.json()) as any;
  const alignment = parseAlignment(body);
  const audio = Buffer.from(body.audio_base64, "base64");

  await writeFile(audioPath, audio);
  await writeFile(alignmentPath, JSON.stringify(alignment));

  const audioDurationS = alignment.endTimes[alignment.endTimes.length - 1] ?? null;

  // Reconcile the reservation against what we were actually charged.
  await settleCredits(channel, testStage, text.length, chargedChars ?? text.length);

  await prisma.elevenLabsUsage.create({
    data: {
      channel, testStage, runId, videoId, segmentIndex, scriptHash,
      generationId, requestId,
      model: ELEVEN_MODEL, voiceId, outputFormat: ELEVEN_OUTPUT_FORMAT,
      requestedChars: text.length, chargedChars,
      attempt, retryReason,
      outputPath: audioPath, audioDurationS,
      success: true, reused: false,
    },
  });

  console.log(
    `[eleven] segment ${segmentIndex}: ${audio.length}B charged=${chargedChars ?? "?"} req=${requestId ?? "?"} gen=${generationId ?? "?"} dur=${audioDurationS?.toFixed(2) ?? "?"}s`,
  );

  return {
    segmentIndex, path: audioPath, alignmentPath, alignment,
    requestedChars: text.length, chargedChars, generationId, requestId,
    reused: false,
  };
}

async function recordFailure(
  opts: SynthesizeOptions,
  scriptHash: string,
  attempt: number,
  errorMessage: string,
  extra: {
    chargedChars?: number | null;
    requestId?: string | null;
    generationId?: string | null;
  } = {},
): Promise<void> {
  await prisma.elevenLabsUsage.create({
    data: {
      channel: opts.channel, testStage: opts.testStage, runId: opts.runId,
      videoId: opts.videoId, segmentIndex: opts.segmentIndex, scriptHash,
      generationId: extra.generationId ?? null,
      requestId: extra.requestId ?? null,
      model: ELEVEN_MODEL, voiceId: opts.voiceId,
      outputFormat: ELEVEN_OUTPUT_FORMAT,
      requestedChars: opts.text.length,
      chargedChars: extra.chargedChars ?? 0,
      attempt, retryReason: opts.retryReason,
      success: false, reused: false,
      errorMessage: errorMessage.slice(0, 1000),
    },
  }).catch(() => { /* accounting must never mask the original error */ });
}

/** Total real credits charged for a video, across every attempt. */
export async function creditsChargedFor(videoId: string): Promise<number> {
  const rows = await prisma.elevenLabsUsage.aggregate({
    where: { videoId },
    _sum: { chargedChars: true },
  });
  return rows._sum.chargedChars ?? 0;
}

/** Generation IDs used by a video's final audio (successful, non-reused). */
export async function generationIdsFor(videoId: string): Promise<string[]> {
  const rows = await prisma.elevenLabsUsage.findMany({
    where: { videoId, success: true, reused: false, generationId: { not: null } },
    select: { generationId: true },
  });
  return rows.map((r) => r.generationId!).filter(Boolean);
}
