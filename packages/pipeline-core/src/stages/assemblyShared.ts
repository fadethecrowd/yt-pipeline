import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestStage } from "@prisma/client";
import { env } from "../config";
import {
  buildNarrationTrack, decodedDuration, ff, ffRaw, mediaInfo, videoDuration,
} from "../lib/ffmpeg";
import { buildLongformCaptions } from "../lib/captions";
import type { BuiltCaptions } from "../lib/captions";
import {
  AssetLedger, recordScene, searchPexelsCandidates,
  validateCandidateMeta, validateDownloadedClip, writeCardTextFile,
} from "../lib/visuals";
import { scoreRelevance, VisualPlan } from "../lib/visualRelevance";
import { readAlignments, readManifest } from "./voiceoverShared";
import type { NarrationManifest } from "./voiceoverShared";
import type { PipelineContext, ScriptSegment, StageResult } from "../types";

/** Title card shown before narration. Narration is delayed by exactly this. */
export const TITLE_CARD_DURATION = 4;
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;

/**
 * Final video duration must match narrationStart + narration duration within
 * this. The old code compared against a sum of MP3 header durations, which
 * disagreed with the rendered audio, so the check passed while the video was
 * out of sync.
 */
export const DURATION_TOLERANCE = 0.75;

/** Bounded retrieval — never loop indefinitely looking for a usable clip. */
const MAX_CANDIDATES = 12;

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "'\\''");
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

export interface AssemblyDeps {
  channel: string;
  label: string;
  testStage: TestStage;
  getVideo: (id: string) => Promise<any>;
  updateVideo: (id: string, data: Record<string, unknown>) => Promise<unknown>;
  setStatus: (id: string, status: string) => Promise<unknown>;
}

export interface AssemblyOutcome {
  videoPath: string;
  /** Same timeline without burned captions — source for the Shorts crop. */
  cleanVideoPath: string;
  narrationPath: string;
  narrationStartS: number;
  videoDurationS: number;
  narrationDurationS: number;
  captions: BuiltCaptions;
  manifest: NarrationManifest;
}

/**
 * Build one segment's clip: search, validate, download, re-validate, fit to the
 * segment's exact audio duration. Falls back to a titled card only after real
 * candidates have been tried and rejected — and the rejection reason is
 * recorded rather than silently swallowed.
 */
async function prepareSegmentClip(
  seg: ScriptSegment,
  sceneNumber: number,
  segStart: number,
  segDuration: number,
  ledger: AssetLedger,
  plan: VisualPlan,
  tmpDir: string,
  clipPath: string,
  deps: AssemblyDeps,
  videoId: string,
  pexelsKey: string,
): Promise<void> {
  const { label, channel } = deps;
  const base = {
    channel, videoId, sceneNumber,
    narration: seg.narration,
    startTimeS: segStart,
    endTimeS: segStart + segDuration,
    prompt: seg.visual_prompt,
  };

  // Bounded retrieval: a few distinct queries, then give up cleanly. Never an
  // unbounded loop.
  const queries = [seg.visual_prompt, seg.title].filter(Boolean);
  const seen = new Set<string>();
  let candidates: typeof queries extends never ? never : Awaited<ReturnType<typeof searchPexelsCandidates>> = [];
  for (const q of queries) {
    for (const c of await searchPexelsCandidates(q, pexelsKey)) {
      if (!seen.has(c.assetId)) { seen.add(c.assetId); candidates.push(c); }
    }
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  // Rank by semantic relevance to the narration before anything is downloaded,
  // so the first technically-valid clip is no longer automatically the winner.
  const scored = candidates.map((c) => ({
    c,
    r: scoreRelevance({
      channel: deps.channel as "ai-doom-scroll" | "wet-circuit",
      narration: seg.narration,
      prompt: seg.visual_prompt,
      description: c.description ?? "",
    }),
  }));
  scored.sort((a, b) => b.r.score - a.r.score);

  for (const { c, r } of scored.slice(0, MAX_CANDIDATES)) {
    if (!ledger.isAvailable(c.assetId)) {
      console.log(`[${label}] scene ${sceneNumber}: skip ${c.assetId} — already used`);
      continue;
    }

    const admitted = plan.admits(r);
    if (!admitted.ok) {
      console.log(
        `[${label}] scene ${sceneNumber}: reject ${c.assetId} "${c.description}" — ${admitted.reason}`,
      );
      await recordScene({
        ...base, assetSource: c.provider, assetId: c.assetId, assetUrl: c.pageUrl ?? c.url,
        assetDescription: c.description, width: c.width, height: c.height,
        relevanceScore: r.score, relevanceVerdict: r.verdict, relevanceReasons: r.reasons,
        validation: "REJECT", rejectionReason: admitted.reason, renderStatus: "REJECTED",
      });
      continue;
    }

    const meta = validateCandidateMeta(c, segDuration);
    if (!meta.ok) {
      console.log(`[${label}] scene ${sceneNumber}: reject ${c.assetId} — ${meta.reason}`);
      continue;
    }

    const rawPath = join(tmpDir, `raw-${sceneNumber}.mp4`);
    try {
      await downloadTo(c.url, rawPath);
    } catch (e) {
      console.warn(`[${label}] scene ${sceneNumber}: download failed — ${e}`);
      continue;
    }

    const content = await validateDownloadedClip(rawPath, segDuration);
    if (!content.ok) {
      console.log(`[${label}] scene ${sceneNumber}: reject ${c.assetId} — ${content.reason}`);
      await recordScene({
        ...base, assetSource: c.provider, assetId: c.assetId, assetUrl: c.url,
        width: c.width, height: c.height, durationS: c.durationS,
        validation: "REJECT", rejectionReason: content.reason, renderStatus: "REJECTED",
      });
      continue;
    }

    // Loop if the source is shorter than the segment, then fit exactly.
    const srcDur = await videoDuration(rawPath).catch(() => 0);
    let input = rawPath;
    if (srcDur > 0 && srcDur < segDuration) {
      const looped = join(tmpDir, `looped-${sceneNumber}.mp4`);
      await ffRaw(
        ["-y", "-loglevel", "error",
         "-stream_loop", String(Math.ceil(segDuration / srcDur)),
         "-i", rawPath, "-t", String(segDuration),
         "-c:v", "libx264", "-preset", "fast", "-an", looped],
        label,
      );
      input = looped;
    }

    await ff(
      ["-i", input, "-t", String(segDuration),
       "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,format=yuv420p`,
       "-r", String(FPS), "-c:v", "libx264", "-preset", "fast", "-an", clipPath],
      label,
    );

    const finalDur = await videoDuration(clipPath).catch(() => 0);
    if (Math.abs(finalDur - segDuration) > 0.5) {
      console.warn(
        `[${label}] scene ${sceneNumber}: fitted clip ${finalDur.toFixed(2)}s vs needed ${segDuration.toFixed(2)}s`,
      );
    }

    ledger.claim(c.assetId);
    plan.claim(r);
    await recordScene({
      ...base, assetSource: c.provider, assetId: c.assetId, assetUrl: c.pageUrl ?? c.url,
      assetDescription: c.description,
      localPath: clipPath, width: c.width, height: c.height, durationS: finalDur,
      cropMethod: "scale-increase+centre-crop",
      relevanceScore: r.score, relevanceVerdict: r.verdict, relevanceReasons: r.reasons,
      validation: "PASS", renderStatus: "RENDERED",
    });
    console.log(
      `[${label}] scene ${sceneNumber}: ${c.provider}:${c.assetId} "${c.description}" ` +
        `${c.width}x${c.height} → ${finalDur.toFixed(2)}s [${r.verdict} ${r.score.toFixed(2)} ${r.concept}]`,
    );
    return;
  }

  // ── Fallback card ───────────────────────────────────────────────────
  const titleFile = join(tmpDir, `card-${sceneNumber}.txt`);
  await writeCardTextFile(titleFile, seg.title);
  await ff(
    ["-f", "lavfi", "-i", `color=c=#2d2d44:s=${WIDTH}x${HEIGHT}:d=${segDuration}:r=${FPS}`,
     "-vf", `format=yuv420p,drawtext=textfile='${escapeFilterPath(titleFile)}':fontsize=40:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`,
     "-c:v", "libx264", "-preset", "fast", "-t", String(segDuration), clipPath],
    label,
  );
  await recordScene({
    ...base, assetSource: "fallback-card", localPath: clipPath,
    width: WIDTH, height: HEIGHT, durationS: segDuration,
    cropMethod: "n/a",
    validation: "PASS",
    rejectionReason: `no candidate passed validation (${candidates.length} tried)`,
    renderStatus: "RENDERED_FALLBACK",
  });
  console.warn(`[${label}] scene ${sceneNumber}: FELL BACK to card (${candidates.length} candidates rejected)`);
}

/**
 * Assemble the long-form video.
 *
 * The timeline is derived entirely from the narration manifest written by the
 * voiceover stage: each segment's clip is cut to that segment's exact decoded
 * audio duration, and captions come from the ElevenLabs character alignments
 * offset by the same exact positions. The title-card delay is applied to the
 * audio exactly once, in the final mux.
 */
export async function runAssembly(
  ctx: PipelineContext,
  deps: AssemblyDeps,
): Promise<StageResult<AssemblyOutcome>> {
  const start = Date.now();
  const { label } = deps;

  if (process.env.DISABLE_ELEVEN === "true") {
    console.log(`[${label}] DISABLE_ELEVEN active — skipping video assembly`);
    const outputDir = join(process.cwd(), "output", ctx.video.id);
    await mkdir(outputDir, { recursive: true });
    const placeholder = join(outputDir, "final.mp4");
    await writeFile(placeholder, Buffer.from([]));
    await deps.updateVideo(ctx.video.id, {
      videoPath: placeholder, status: "ASSEMBLY_DONE",
    });
    ctx.videoUrl = placeholder;
    return { success: true, durationMs: Date.now() - start };
  }

  if (!ctx.script || ctx.script.segments.length === 0) {
    return { success: false, error: "No script segments", durationMs: Date.now() - start };
  }

  const video = await deps.getVideo(ctx.video.id);
  if (!video?.voiceoverPath) {
    return { success: false, error: "Missing voiceoverPath on video record", durationMs: Date.now() - start };
  }

  await deps.setStatus(ctx.video.id, "ASSEMBLY_PENDING");

  const config = env();
  const tmpDir = join(process.cwd(), "tmp", ctx.video.id);
  const outputDir = join(process.cwd(), "output", ctx.video.id);
  const audioDir = join(process.cwd(), "audio", ctx.video.id);
  await mkdir(tmpDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const segments = ctx.script.segments;

  // ── 1. Timeline truth: the narration manifest ────────────────────────
  let manifest = await readManifest(audioDir);
  if (!manifest) {
    // Resumed run whose manifest is gone — rebuild it from the segment files.
    console.warn(`[${label}] no narration manifest; rebuilding from segment files`);
    const paths = segments.map((s) => join(audioDir, `segment-${s.segmentIndex}.mp3`));
    for (const p of paths) {
      if (!existsSync(p)) {
        return { success: false, error: `Missing narration segment ${p}`, durationMs: Date.now() - start };
      }
    }
    const track = await buildNarrationTrack(paths, video.voiceoverPath, label);
    manifest = {
      version: 1,
      finalPath: video.voiceoverPath,
      durationS: track.durationS,
      segments: segments.map((s, i) => ({
        segmentIndex: s.segmentIndex,
        path: paths[i],
        alignmentPath: join(audioDir, `segment-${s.segmentIndex}.alignment.json`),
        offsetS: track.segmentOffsets[i],
        durationS: track.segmentDurations[i],
        chargedChars: null, generationId: null, requestId: null, reused: true,
      })),
    };
  }

  const narrationDurationS = manifest.durationS;
  console.log(
    `[${label}] narration ${narrationDurationS.toFixed(3)}s across ${manifest.segments.length} segments`,
  );

  // ── 2. Captions from real character alignments ───────────────────────
  const alignments = await readAlignments(manifest);
  const captions = buildLongformCaptions(
    alignments,
    manifest.segments.map((s) => s.offsetS),
    TITLE_CARD_DURATION,
  );
  const assPath = join(tmpDir, "subtitles.ass");
  await writeFile(assPath, captions.ass);
  console.log(
    `[${label}] captions: ${captions.cues.length} cues, ` +
      `first ${captions.firstCueStart.toFixed(2)}s, last ends ${captions.lastCueEnd.toFixed(2)}s`,
  );

  // ── 3. Per-segment clips, cut to exact audio durations ───────────────
  const ledger = new AssetLedger(1);
  const plan = new VisualPlan();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const m = manifest.segments[i];
    const clipPath = join(tmpDir, `clip-${seg.segmentIndex}.mp4`);
    try {
      await prepareSegmentClip(
        seg, i + 1, TITLE_CARD_DURATION + m.offsetS, m.durationS,
        ledger, plan, tmpDir, clipPath, deps, ctx.video.id, config.PEXELS_API_KEY,
      );
    } catch (err) {
      console.warn(`[${label}] scene ${i + 1}: ${err instanceof Error ? err.message : err}`);
      const titleFile = join(tmpDir, `card-${i + 1}.txt`);
      await writeCardTextFile(titleFile, seg.title);
      await ff(
        ["-f", "lavfi", "-i", `color=c=#2d2d44:s=${WIDTH}x${HEIGHT}:d=${m.durationS}:r=${FPS}`,
         "-vf", `format=yuv420p,drawtext=textfile='${escapeFilterPath(titleFile)}':fontsize=40:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`,
         "-c:v", "libx264", "-preset", "fast", "-t", String(m.durationS), clipPath],
        label,
      );
      await recordScene({
        channel: deps.channel, videoId: ctx.video.id, sceneNumber: i + 1,
        narration: seg.narration, startTimeS: TITLE_CARD_DURATION + m.offsetS,
        endTimeS: TITLE_CARD_DURATION + m.offsetS + m.durationS,
        prompt: seg.visual_prompt, assetSource: "fallback-card",
        localPath: clipPath, validation: "PASS",
        rejectionReason: `error: ${err instanceof Error ? err.message : err}`,
        renderStatus: "RENDERED_FALLBACK",
      });
    }
  }
  if (ledger.duplicateCount > 0) {
    console.warn(`[${label}] ${ledger.duplicateCount} duplicate visual asset(s) used`);
  }
  const composition = plan.summary();
  console.log(
    `[${label}] visual composition: ${composition.strongCount} strong, ` +
      `${composition.genericCount} generic, concepts=[${composition.concepts.join(", ")}]`,
  );
  if (!composition.meetsMinimum) {
    console.warn(
      `[${label}] WARNING: only ${composition.strongCount} strongly on-topic visual(s) — minimum is 2`,
    );
  }

  // ── 4. Title card ────────────────────────────────────────────────────
  const titleTextFile = join(tmpDir, "title.txt");
  await writeCardTextFile(titleTextFile, ctx.topic.title);
  const titlePath = join(tmpDir, "title.mp4");
  await ff(
    ["-f", "lavfi", "-i", `color=c=#1a1a2e:s=${WIDTH}x${HEIGHT}:d=${TITLE_CARD_DURATION}:r=${FPS}`,
     "-vf", `format=yuv420p,drawtext=textfile='${escapeFilterPath(titleTextFile)}':fontsize=54:fontcolor=white:x=(w-tw)/2:y=(h-th)/2:line_spacing=10`,
     "-c:v", "libx264", "-preset", "fast", "-t", String(TITLE_CARD_DURATION), titlePath],
    label,
  );

  // ── 5. Concat visual track ───────────────────────────────────────────
  const concatFile = join(tmpDir, "concat.txt");
  await writeFile(
    concatFile,
    [titlePath, ...segments.map((s) => join(tmpDir, `clip-${s.segmentIndex}.mp4`))]
      .map((p) => `file '${p}'`).join("\n"),
  );
  const concatPath = join(tmpDir, "concat.mp4");
  await ff(["-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", concatPath], label);

  // ── 6. Final mux: burn captions, delay narration by the title card ───
  //
  // Two outputs. `final.mp4` carries burned captions and is what gets
  // uploaded. `final-clean.mp4` is the same timeline WITHOUT captions, so the
  // Shorts path can crop it and burn Short-sized captions of its own instead
  // of inheriting long-form ones sized for a different frame.
  const finalPath = join(outputDir, "final.mp4");
  const cleanPath = join(outputDir, "final-clean.mp4");

  const audioArgs = [
    // Applied exactly once, here. No other stage shifts the narration.
    "-af", `adelay=${Math.round(TITLE_CARD_DURATION * 1000)}:all=1`,
    "-c:a", "aac", "-b:a", "192k",
    "-map", "0:v", "-map", "1:a",
    "-movflags", "+faststart",
  ];

  await ff(
    ["-i", concatPath, "-i", manifest.finalPath,
     "-c:v", "libx264", "-preset", "fast",
     ...audioArgs, cleanPath],
    label,
  );

  await ff(
    ["-i", concatPath, "-i", manifest.finalPath,
     "-vf", `subtitles=${escapeFilterPath(assPath)}`,
     "-c:v", "libx264", "-preset", "fast",
     ...audioArgs, finalPath],
    label,
  );

  // ── 7. Verify against the real audio, not an estimate ────────────────
  const finalDuration = await videoDuration(finalPath);
  const expected = TITLE_CARD_DURATION + narrationDurationS;
  const drift = finalDuration - expected;
  console.log(
    `[${label}] final ${finalDuration.toFixed(3)}s vs expected ${expected.toFixed(3)}s (drift ${(drift * 1000).toFixed(0)}ms)`,
  );
  if (Math.abs(drift) > DURATION_TOLERANCE) {
    return {
      success: false,
      error: `Final video duration ${finalDuration.toFixed(2)}s differs from narration timeline ${expected.toFixed(2)}s by ${drift.toFixed(2)}s (tolerance ±${DURATION_TOLERANCE}s)`,
      durationMs: Date.now() - start,
    };
  }

  await deps.updateVideo(ctx.video.id, { videoPath: finalPath, status: "ASSEMBLY_DONE" });
  ctx.videoUrl = finalPath;

  return {
    success: true,
    data: {
      videoPath: finalPath,
      cleanVideoPath: cleanPath,
      narrationPath: manifest.finalPath,
      narrationStartS: TITLE_CARD_DURATION,
      videoDurationS: finalDuration,
      narrationDurationS,
      captions,
      manifest,
    },
    durationMs: Date.now() - start,
  };
}

/** Keep tmp artifacts when explicitly asked, so a failed render can be inspected. */
export async function cleanupAssemblyTmp(videoId: string): Promise<void> {
  if (process.env.KEEP_RENDER_ARTIFACTS === "true") {
    console.log(`[assembly] KEEP_RENDER_ARTIFACTS=true — leaving tmp/${videoId}`);
    return;
  }
  await rm(join(process.cwd(), "tmp", videoId), { recursive: true, force: true });
}

export { mediaInfo, decodedDuration };
