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
import { scoreRelevance, VisualPlan, buildSearchQueries } from "../lib/visualRelevance";
import { planVisualBeats, summarizeBeats, minimumBeatsFor, BEAT_MAX_S } from "../lib/visualBeats";
import type { VisualBeat } from "../lib/visualBeats";
import { checkBrandFromMetadata, brandAdmits, isHighBrandRiskFootage } from "../lib/brandGuard";
import type { BrandCheck } from "../lib/brandGuard";
import { wordsFromAlignment } from "../lib/captions";
import type { Candidate } from "../lib/visuals";
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

/** Candidates pooled per segment; beats draw unique assets from this pool. */
const CANDIDATE_POOL = 40;

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
  beats: RenderedBeat[];
}

/**
 * Build one segment's clip: search, validate, download, re-validate, fit to the
 * segment's exact audio duration. Falls back to a titled card only after real
 * candidates have been tried and rejected — and the rejection reason is
 * recorded rather than silently swallowed.
 */
/** One rendered visual beat, with full provenance for the QA timeline. */
export interface RenderedBeat {
  index: number;
  startS: number;
  endS: number;
  durationS: number;
  narration: string;
  assetId: string | null;
  assetDescription: string | null;
  assetUrl: string | null;
  sourceStartS: number;
  sourceEndS: number;
  looped: false;
  reused: false;
  relevanceScore: number | null;
  concept: string | null;
  brand: BrandCheck;
  decision: "RENDERED" | "FALLBACK_CARD";
  clipPath: string;
}

/**
 * Build a pooled, de-duplicated candidate list for a segment.
 *
 * Beats need many unique assets, so candidates are gathered once per segment
 * across several queries rather than re-searched per beat.
 */
async function gatherCandidates(
  seg: ScriptSegment,
  channel: "ai-doom-scroll" | "wet-circuit",
  pexelsKey: string,
  label: string,
): Promise<Candidate[]> {
  const queries = buildSearchQueries(seg.visual_prompt, seg.title, channel);
  const seen = new Set<string>();
  const pool: Candidate[] = [];
  for (const q of queries) {
    for (const c of await searchPexelsCandidates(q, pexelsKey, { perPage: 20 })) {
      if (!seen.has(c.assetId)) { seen.add(c.assetId); pool.push(c); }
    }
    if (pool.length >= CANDIDATE_POOL) break;
  }
  console.log(`[${label}] segment ${seg.segmentIndex}: pooled ${pool.length} candidates from ${queries.length} queries`);
  return pool;
}

/**
 * Render one visual beat.
 *
 * A clip is CUT to the beat length, never looped. If the source is shorter
 * than the beat it is rejected here and a different asset is tried; when
 * nothing suitable remains the caller falls back to a branded card. No
 * reversing, ping-ponging, replaying, speed-changing or frame-freezing is used
 * to stretch footage.
 */
async function renderBeat(
  beat: VisualBeat,
  seg: ScriptSegment,
  pool: Candidate[],
  ledger: AssetLedger,
  plan: VisualPlan,
  tmpDir: string,
  deps: AssemblyDeps,
  videoId: string,
): Promise<RenderedBeat> {
  const { label, channel } = deps;
  const clipPath = join(tmpDir, `beat-${beat.index}.mp4`);
  const base = {
    channel, videoId, sceneNumber: beat.index,
    narration: beat.narration,
    startTimeS: TITLE_CARD_DURATION + beat.startS,
    endTimeS: TITLE_CARD_DURATION + beat.endS,
    prompt: seg.visual_prompt,
  };

  const scored = pool
    .filter((c) => ledger.isAvailable(c.assetId))
    .map((c) => ({
      c,
      r: scoreRelevance({
        channel: channel as "ai-doom-scroll" | "wet-circuit",
        narration: beat.narration,
        prompt: seg.visual_prompt,
        description: c.description ?? "",
      }),
    }))
    .sort((a, b) => b.r.score - a.r.score);

  const ranked = scored.map((x) => ({ candidate: x.c, relevance: x.r }));
  const tried = new Set<string>();

  for (let attempt = 0; attempt < MAX_CANDIDATES; attempt++) {
    const pick = plan.selectCandidate(
      ranked.filter((x) => !tried.has(x.candidate.assetId)),
      (c) => ledger.isAvailable(c.assetId),
    );
    if (!pick) break;
    const c = pick.candidate;
    const r = pick.relevance;
    tried.add(c.assetId);

    // ── Visible-brand relevance, before download ──────────────────────
    const brand = checkBrandFromMetadata(
      `${c.description ?? ""} ${c.pageUrl ?? ""}`,
      seg.visual_prompt,
      beat.narration,
    );
    if (!brandAdmits(brand)) {
      console.log(`[${label}] beat ${beat.index}: reject ${c.assetId} — ${brand.rejectionReason}`);
      await recordScene({
        ...base, assetSource: c.provider, assetId: c.assetId, assetUrl: c.pageUrl ?? c.url,
        assetDescription: c.description, relevanceScore: r.score, relevanceVerdict: r.verdict,
        relevanceReasons: [...r.reasons, brand.rejectionReason ?? ""],
        validation: "REJECT", rejectionReason: brand.rejectionReason, renderStatus: "REJECTED",
      });
      continue;
    }

    if (!validateCandidateMeta(c, beat.durationS).ok) continue;

    // ── Source must COVER the beat — no looping to fill ───────────────
    if (c.durationS > 0 && c.durationS < beat.durationS) {
      console.log(
        `[${label}] beat ${beat.index}: skip ${c.assetId} — source ${c.durationS}s shorter than beat ${beat.durationS.toFixed(1)}s (looping is forbidden)`,
      );
      continue;
    }

    const rawPath = join(tmpDir, `raw-${beat.index}.mp4`);
    try {
      await downloadTo(c.url, rawPath);
    } catch { continue; }

    const content = await validateDownloadedClip(rawPath, beat.durationS);
    if (!content.ok) {
      console.log(`[${label}] beat ${beat.index}: reject ${c.assetId} — ${content.reason}`);
      continue;
    }

    const srcDur = await videoDuration(rawPath).catch(() => 0);
    if (srcDur > 0 && srcDur < beat.durationS - 0.25) {
      console.log(`[${label}] beat ${beat.index}: skip ${c.assetId} — decoded ${srcDur.toFixed(1)}s < beat`);
      continue;
    }

    // Cut from the start of the source, trimmed to exactly the beat length.
    await ff(
      ["-i", rawPath, "-t", String(beat.durationS),
       "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,format=yuv420p`,
       "-r", String(FPS), "-c:v", "libx264", "-preset", "fast", "-an", clipPath],
      label,
    );

    ledger.claim(c.assetId);
    plan.claim(r);
    await recordScene({
      ...base, assetSource: c.provider, assetId: c.assetId, assetUrl: c.pageUrl ?? c.url,
      assetDescription: c.description, localPath: clipPath,
      width: c.width, height: c.height, durationS: beat.durationS,
      cropMethod: "scale-increase+centre-crop; cut (never looped)",
      relevanceScore: r.score, relevanceVerdict: r.verdict,
      relevanceReasons: [...r.reasons, `brand:${brand.brandDecision}`],
      validation: "PASS", renderStatus: "RENDERED",
    });
    console.log(
      `[${label}] beat ${beat.index} (${beat.durationS.toFixed(1)}s): ${c.assetId} "${c.description}" [${r.verdict} ${r.score.toFixed(2)} ${r.concept}]${isHighBrandRiskFootage(c.description ?? "") ? " ⚠ brand-risk: inspect frame" : ""}`,
    );
    return {
      index: beat.index, startS: beat.startS, endS: beat.endS, durationS: beat.durationS,
      narration: beat.narration, assetId: c.assetId, assetDescription: c.description ?? null,
      assetUrl: c.pageUrl ?? c.url, sourceStartS: 0, sourceEndS: beat.durationS,
      looped: false, reused: false, relevanceScore: r.score, concept: r.concept,
      brand, decision: "RENDERED", clipPath,
    };
  }

  // ── Branded, topic-specific card — preferred over repeated or unrelated footage ──
  const titleFile = join(tmpDir, `card-${beat.index}.txt`);
  await writeCardTextFile(titleFile, seg.title);
  await ff(
    ["-f", "lavfi", "-i", `color=c=#141428:s=${WIDTH}x${HEIGHT}:d=${beat.durationS}:r=${FPS}`,
     "-vf", `format=yuv420p,drawtext=textfile='${escapeFilterPath(titleFile)}':fontsize=64:fontcolor=white:x=(w-tw)/2:y=(h-th)/2-40:line_spacing=14,`
       + `drawtext=text='${deps.channel === "wet-circuit" ? "WET CIRCUIT" : "AI DOOM SCROLL"}':fontsize=30:fontcolor=0x8899ff:x=(w-tw)/2:y=h-140`,
     "-c:v", "libx264", "-preset", "fast", "-t", String(beat.durationS), clipPath],
    label,
  );
  await recordScene({
    ...base, assetSource: "branded-card", localPath: clipPath,
    width: WIDTH, height: HEIGHT, durationS: beat.durationS,
    validation: "PASS", rejectionReason: "no relevant unbranded clip long enough for this beat",
    renderStatus: "RENDERED_FALLBACK",
  });
  console.warn(`[${label}] beat ${beat.index}: branded card (no suitable clip)`);
  return {
    index: beat.index, startS: beat.startS, endS: beat.endS, durationS: beat.durationS,
    narration: beat.narration, assetId: null, assetDescription: "branded card",
    assetUrl: null, sourceStartS: 0, sourceEndS: beat.durationS,
    looped: false, reused: false, relevanceScore: null, concept: "card",
    brand: { visibleBrandDetected: false, detectedBrandOrSignage: null, brandRelevantToNarration: null, brandDecision: "NO_BRAND", rejectionReason: null, source: "none" },
    decision: "FALLBACK_CARD", clipPath,
  };
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

  // ── 3. Visual beats ──────────────────────────────────────────────────
  //
  // One clip per SEGMENT meant a 120s segment looped a 20s clip six times.
  // Segments are split into 15-25s beats at real sentence boundaries, each
  // taking its own unique asset, cut (never looped) to the beat length.
  const segmentWords = alignments.map((a, i) =>
    wordsFromAlignment(a, manifest!.segments[i].offsetS),
  );
  const beats = planVisualBeats(segmentWords);
  const planSummary = summarizeBeats(beats);
  const minBeats = minimumBeatsFor(narrationDurationS);
  console.log(
    `[${label}] visual plan: ${planSummary.count} beats, avg ${planSummary.averageS.toFixed(1)}s, ` +
      `max ${planSummary.maxS.toFixed(1)}s, min ${planSummary.minS.toFixed(1)}s (floor for this runtime: ${minBeats})`,
  );
  if (planSummary.overCap.length > 0) {
    return {
      success: false,
      error: `${planSummary.overCap.length} beat(s) exceed the ${BEAT_MAX_S}s cap`,
      durationMs: Date.now() - start,
    };
  }

  const ledger = new AssetLedger(1);
  const plan = new VisualPlan();
  const rendered: RenderedBeat[] = [];

  // Pool candidates once per segment; beats draw unique assets from it.
  const pools = new Map<number, Candidate[]>();
  for (const seg of segments) {
    pools.set(
      seg.segmentIndex,
      await gatherCandidates(seg, deps.channel as "ai-doom-scroll" | "wet-circuit", config.PEXELS_API_KEY, label),
    );
  }

  for (const beat of beats) {
    const seg = segments[beat.segmentIndex] ?? segments[segments.length - 1];
    let pool = pools.get(seg.segmentIndex) ?? [];
    // Top up from other segments' pools if this one is exhausted.
    if (pool.filter((c) => ledger.isAvailable(c.assetId)).length < 3) {
      pool = [...pool, ...[...pools.values()].flat()];
    }
    rendered.push(
      await renderBeat(beat, seg, pool, ledger, plan, tmpDir, deps, ctx.video.id),
    );
  }

  // ── Pacing invariants ────────────────────────────────────────────────
  const assetIds = rendered.map((b) => b.assetId).filter(Boolean) as string[];
  const duplicates = assetIds.length - new Set(assetIds).size;
  const overLong = rendered.filter((b) => b.durationS > BEAT_MAX_S + 0.5);
  const looped = rendered.filter((b) => b.looped);
  if (duplicates > 0 || overLong.length > 0 || looped.length > 0) {
    return {
      success: false,
      error: `visual pacing violation: ${duplicates} duplicate asset(s), ${overLong.length} over ${BEAT_MAX_S}s, ${looped.length} looped`,
      durationMs: Date.now() - start,
    };
  }
  if (rendered.length < minBeats) {
    return {
      success: false,
      error: `only ${rendered.length} visual beats for ${narrationDurationS.toFixed(0)}s narration (minimum ${minBeats})`,
      durationMs: Date.now() - start,
    };
  }

  const composition = plan.summary();
  const cards = rendered.filter((b) => b.decision === "FALLBACK_CARD").length;
  console.log(
    `[${label}] visuals: ${rendered.length} beats, ${assetIds.length} unique assets, ${cards} card(s), ` +
      `${composition.strongCount} strong, ${composition.genericCount} generic, 0 looped, 0 reused`,
  );

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
    [titlePath, ...rendered.map((b) => b.clipPath)]
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
      beats: rendered,
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
export type { RenderedBeat as AssemblyBeat };
