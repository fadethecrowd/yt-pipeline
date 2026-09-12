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

/**
 * The voice each channel speaks in. Pinned, and checked before any spend.
 *
 * `ELEVENLABS_VOICE_ID` is a single global env var serving two channels, so the
 * voice a render uses is decided by whichever `.env` happened to be loaded —
 * exactly the shape of the split-credential bug that youtube-credential-
 * singularity exists to prevent, but with no guard on this side.
 *
 * It fired on 2026-09-12. A Wet Circuit batch was run with the repo-root
 * `.env`, which is configured for AI Doom (it also points YOUTUBE_TOKEN_FILE at
 * token-ai-doom-scroll.json). The YouTube credential was passed explicitly so
 * `verifyChannel` passed and the run looked correct — while the narration was
 * rendered in AI Doom's voice. Measured over 234 generations the two voices
 * differ by 26% in delivery rate (WC 15.81 chars/s, AI Doom 12.52), so the
 * video came out 5:59 against a 5:40 ceiling and was refused at QA. 4,373
 * credits bought an unusable render, and the only reason it was caught at all
 * is that the wrong voice happened to be slow enough to breach a duration gate.
 * A voice that differed in timbre but not pace would have published.
 *
 * Overridable per channel by env for a deliberate voice change; the point is
 * that the default cannot drift silently.
 */
export const CHANNEL_VOICE: Record<"wet-circuit" | "ai-doom-scroll", string> = {
  "wet-circuit": process.env.WC_ELEVENLABS_VOICE_ID ?? "VAnZB441uRGQ8uoZunqz",
  "ai-doom-scroll": process.env.AI_DOOM_ELEVENLABS_VOICE_ID ?? "pg7Nd5b8Y3tnfSndq5lh",
};

export class VoiceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceMismatchError";
  }
}

/**
 * The voice this channel must speak in, refusing a mismatch BEFORE any spend.
 *
 * Returns the pinned voice rather than merely validating the caller's, so a
 * stale `ELEVENLABS_VOICE_ID` cannot be used even by accident. Throws only when
 * the env explicitly disagrees, so the failure names the mistake instead of
 * silently substituting.
 */
export function voiceForChannel(
  /**
   * Deliberately `string`, not the union: this is a spend gate, and the
   * shared voiceover deps carry `channel: string`. A guard that can only run
   * where the types already line up is a guard that a refactor turns off.
   */
  channel: string,
  configured: string | undefined,
): string {
  const pinned = CHANNEL_VOICE[channel as keyof typeof CHANNEL_VOICE];
  if (!pinned) {
    throw new VoiceMismatchError(
      `no pinned ElevenLabs voice for channel "${channel}" — add it to CHANNEL_VOICE `
      + `before rendering, rather than falling back to whatever the environment holds.`,
    );
  }
  if (configured && configured !== pinned) {
    const other = (Object.keys(CHANNEL_VOICE) as Array<keyof typeof CHANNEL_VOICE>)
      .find((k) => CHANNEL_VOICE[k] === configured);
    throw new VoiceMismatchError(
      `ELEVENLABS_VOICE_ID is ${configured} but ${channel} speaks in ${pinned}`
      + (other ? ` — that is ${other}'s voice. The wrong .env is loaded.` : ".")
      + ` Refusing to spend credits on a render in the wrong voice.`,
    );
  }
  return pinned;
}

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
