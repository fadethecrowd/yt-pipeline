import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TestStage } from "@prisma/client";
import { env } from "../config";
import { buildNarrationTrack } from "../lib/ffmpeg";
import { buildSpokenUnits } from "../lib/spokenUnits";
import { synthesizeSegment } from "../lib/elevenlabs";
import type { Alignment } from "../lib/elevenlabs";
import type { PipelineContext, StageResult, VoiceoverResult } from "../types";

/**
 * Manifest written next to the audio so later stages (and any resumed run)
 * build their timeline from the SAME numbers the narration was assembled with,
 * rather than re-probing MP3 headers and getting a different answer.
 */
export interface NarrationManifest {
  version: 1;
  finalPath: string;
  /** Exact decoded duration of the assembled narration track. */
  durationS: number;
  segments: {
    segmentIndex: number;
    path: string;
    alignmentPath: string;
    /** Exact decoded start offset within the narration track. */
    offsetS: number;
    /** Exact decoded duration of this segment. */
    durationS: number;
    chargedChars: number | null;
    generationId: string | null;
    requestId: string | null;
    reused: boolean;
  }[];
}

export function manifestPath(audioDir: string): string {
  return join(audioDir, "narration.json");
}

export async function readManifest(audioDir: string): Promise<NarrationManifest | null> {
  const p = manifestPath(audioDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf8")) as NarrationManifest;
  } catch {
    return null;
  }
}

export async function readAlignments(m: NarrationManifest): Promise<Alignment[]> {
  const out: Alignment[] = [];
  for (const s of m.segments) {
    out.push(JSON.parse(await readFile(s.alignmentPath, "utf8")) as Alignment);
  }
  return out;
}

export interface VoiceoverDeps {
  channel: string;
  label: string;
  testStage: TestStage;
  runId?: string;
  /** Persists stage results to the channel's own table. */
  updateVideo: (id: string, data: Record<string, unknown>) => Promise<unknown>;
  setStatus: (id: string, status: string) => Promise<unknown>;
  /**
   * Request-scoped delivery speed. Absent leaves the request body and every
   * existing caller unchanged.
   */
  speed?: number;
}

/**
 * Generate narration for every script segment and assemble a single track.
 *
 * Idempotent per segment: audio already generated for the same text/voice/model
 * is reused from disk at zero credit cost, so a failed assembly, caption,
 * thumbnail or upload step never re-charges for audio that already exists.
 */
export async function runVoiceover(
  ctx: PipelineContext,
  deps: VoiceoverDeps,
): Promise<StageResult> {
  const start = Date.now();
  const { label } = deps;

  if (process.env.DISABLE_ELEVEN === "true") {
    console.log(`[${label}] DISABLE_ELEVEN active — skipping ElevenLabs calls`);
    const audioDir = join(process.cwd(), "audio", ctx.video.id);
    await mkdir(audioDir, { recursive: true });
    const placeholder = join(audioDir, "final.mp3");
    await writeFile(placeholder, Buffer.from([]));
    await deps.updateVideo(ctx.video.id, {
      voiceoverPath: placeholder,
      voiceoverUrls: [placeholder],
      status: "VOICEOVER_DONE",
    });
    ctx.voiceoverUrls = [placeholder];
    return { success: true, durationMs: Date.now() - start };
  }

  if (!ctx.script || ctx.script.segments.length === 0) {
    return { success: false, error: "No script segments", durationMs: Date.now() - start };
  }

  await deps.setStatus(ctx.video.id, "VOICEOVER_PENDING");

  const config = env();
  const voiceId = config.ELEVENLABS_VOICE_ID;
  const audioDir = join(process.cwd(), "audio", ctx.video.id);
  await mkdir(audioDir, { recursive: true });

  const results: VoiceoverResult[] = [];
  const segmentPaths: string[] = [];
  const synth: Awaited<ReturnType<typeof synthesizeSegment>>[] = [];

  // What actually gets spoken. Synthesising `segment.narration` directly left
  // a hand-edited script's hook and CTA unspoken whenever the editorial pass
  // rewrote the segment bodies without folding them back in. Both this path
  // and visual planning now read the same builder, so they cannot disagree.
  const units = buildSpokenUnits(ctx.script);

  for (const unit of units) {
    const segment = ctx.script.segments[unit.index]!;
    console.log(
      `[${label}] unit ${unit.index} (${unit.text.length} chars, ` +
      `${unit.parts.map((p) => p.field).join("+")}): "${segment.title}"`,
    );
    const r = await synthesizeSegment({
      channel: deps.channel,
      videoId: ctx.video.id,
      segmentIndex: segment.segmentIndex,
      text: unit.text,
      voiceId,
      apiKey: config.ELEVENLABS_API_KEY,
      speed: deps.speed,
      audioDir,
      testStage: deps.testStage,
      runId: deps.runId,
    });
    synth.push(r);
    segmentPaths.push(r.path);
    results.push({ segmentIndex: segment.segmentIndex, url: r.path, durationMs: Date.now() - start });
  }

  // ── Assemble the narration track sample-exactly ──────────────────────
  const finalPath = join(audioDir, "final.mp3");
  const track = await buildNarrationTrack(segmentPaths, finalPath, label);

  const manifest: NarrationManifest = {
    version: 1,
    finalPath,
    durationS: track.durationS,
    segments: ctx.script.segments.map((seg, i) => ({
      segmentIndex: seg.segmentIndex,
      path: synth[i].path,
      alignmentPath: synth[i].alignmentPath,
      offsetS: track.segmentOffsets[i],
      durationS: track.segmentDurations[i],
      chargedChars: synth[i].chargedChars,
      generationId: synth[i].generationId,
      requestId: synth[i].requestId,
      reused: synth[i].reused,
    })),
  };
  await writeFile(manifestPath(audioDir), JSON.stringify(manifest, null, 2));

  const totalCharged = synth.reduce((a, s) => a + (s.chargedChars ?? 0), 0);
  const reusedCount = synth.filter((s) => s.reused).length;
  console.log(
    `[${label}] narration ready: ${track.durationS.toFixed(2)}s, ` +
      `${totalCharged} credits charged, ${reusedCount}/${synth.length} segments reused`,
  );

  await deps.updateVideo(ctx.video.id, {
    voiceoverUrls: segmentPaths,
    voiceoverPath: finalPath,
    status: "VOICEOVER_DONE",
  });

  ctx.voiceoverUrls = segmentPaths;
  return { success: true, data: results, durationMs: Date.now() - start };
}
