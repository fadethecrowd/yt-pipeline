import { existsSync } from "node:fs";
import { mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { TestStage } from "@prisma/client";
import { env } from "../config";
import {
  buildNarrationTrack, decodedDuration, ff, ffRaw, hasDrawtext, mediaInfo, videoDuration,
} from "../lib/ffmpeg";
import { buildLongformCaptions } from "../lib/captions";
import type { BuiltCaptions } from "../lib/captions";
import {
  AssetLedger, recordScene, searchPexelsCandidates,
  validateCandidateMeta, validateDownloadedClip, wrapCardText, writeCardTextFile,
} from "../lib/visuals";
import {
  scoreRelevance, VisualPlan, buildSearchQueries, classifyConcept,
  AI_SUBJECTS, MARINE_SUBJECTS,
} from "../lib/visualRelevance";
import {
  comparisonVehicles, borrowedFromVehicle, subjectTerms, isOutroBeat,
  deVehicle, withheldDomains,
} from "../lib/visualSubject";
import { planVisualBeats, summarizeBeats, minimumBeatsFor, BEAT_MAX_S, MIN_FRAGMENT_S, fitFragment } from "../lib/visualBeats";
import type { VisualBeat } from "../lib/visualBeats";
import { checkBrandFromMetadata, brandAdmits, isHighBrandRiskFootage } from "../lib/brandGuard";
import type { BrandCheck } from "../lib/brandGuard";
import { wordsFromAlignment } from "../lib/captions";
import type { Candidate } from "../lib/visuals";
import { readAlignments, readManifest } from "./voiceoverShared";
import {
  alignToNarration, assertRealizedMatchesApproved, AllocationConflictError,
} from "../lib/approvedAllocation";
import type { ApprovedAllocation, ApprovedBeat } from "../lib/approvedAllocation";
import { MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE } from "../lib/approvedAllocation";
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
const CANDIDATE_POOL = 120;

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "'\\''");
}

async function downloadTo(url: string, dest: string): Promise<void> {
  // An approved allocation may resolve to media already held locally — the
  // very files a reviewer looked at. fetch() cannot read file: URLs, and
  // re-fetching from the provider to obtain bytes we already have would be a
  // fresh acquisition of footage that is supposed to be frozen.
  if (url.startsWith("file://")) {
    await copyFile(fileURLToPath(url), dest);
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * Build one card clip.
 *
 * Where ffmpeg has `drawtext` the filter graph is exactly what it always was,
 * so production output is unchanged. Where it does not — a build without
 * libfreetype fails the whole render on the first card — the same wrapped
 * text, colours and badge are composited to a still and held for the same
 * duration.
 */
async function renderCardClip(o: {
  text: string; channel: string; durationS: number;
  clipPath: string; titleFile: string; tmpDir: string; sceneNumber: number; label: string;
}): Promise<void> {
  const badge = o.channel === "wet-circuit" ? "WET CIRCUIT" : "AI DOOM SCROLL";
  if (await hasDrawtext()) {
    await ff(
      ["-f", "lavfi", "-i", `color=c=#243257:s=${WIDTH}x${HEIGHT}:d=${o.durationS}:r=${FPS}`,
       "-vf", `format=yuv420p,drawtext=textfile='${escapeFilterPath(o.titleFile)}':fontsize=64:fontcolor=white:x=(w-tw)/2:y=(h-th)/2-40:line_spacing=14,`
         + `drawtext=text='${badge}':fontsize=30:fontcolor=0x8899ff:x=(w-tw)/2:y=h-140`,
       "-c:v", "libx264", "-preset", "fast", "-t", String(o.durationS), o.clipPath],
      o.label,
    );
    return;
  }
  await renderTextStillClip({
    text: o.text, background: "#243257", fontSize: 64, lineSpacing: 14, offsetY: -40,
    badge, durationS: o.durationS,
    stillPath: join(o.tmpDir, `card-${o.sceneNumber}.png`), clipPath: o.clipPath, label: o.label,
  });
}

/** Composite centred, wrapped text to a still and hold it for `durationS`. */
async function renderTextStillClip(o: {
  text: string; background: string; fontSize: number; lineSpacing: number; offsetY: number;
  badge?: string; durationS: number; stillPath: string; clipPath: string; label: string;
}): Promise<void> {
  const lines = wrapCardText(o.text).split("\n");
  const lineH = o.fontSize + o.lineSpacing;
  const top = HEIGHT / 2 + o.offsetY - ((lines.length - 1) * lineH) / 2;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">`
    + `<rect width="100%" height="100%" fill="${o.background}"/>`
    + lines.map((l, i) =>
        `<text x="${WIDTH / 2}" y="${top + i * lineH}" text-anchor="middle" dominant-baseline="middle" `
        + `font-family="Helvetica,Arial,sans-serif" font-size="${o.fontSize}" fill="#ffffff">${esc(l)}</text>`).join("")
    + (o.badge
        ? `<text x="${WIDTH / 2}" y="${HEIGHT - 140}" text-anchor="middle" dominant-baseline="middle" `
          + `font-family="Helvetica,Arial,sans-serif" font-size="30" fill="#8899ff">${esc(o.badge)}</text>`
        : "")
    + `</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(o.stillPath);
  await ff(
    ["-loop", "1", "-i", o.stillPath, "-t", String(o.durationS), "-r", String(FPS),
     "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "fast", o.clipPath],
    o.label,
  );
}

export interface AssemblyDeps {
  channel: string;
  label: string;
  testStage: TestStage;
  getVideo: (id: string) => Promise<any>;
  updateVideo: (id: string, data: Record<string, unknown>) => Promise<unknown>;
  setStatus: (id: string, status: string) => Promise<unknown>;
  /**
   * A human-approved visual allocation. When supplied, assembly renders
   * exactly these assets in exactly this order and performs NO beat planning,
   * NO search and NO selection — re-acquiring would render footage the
   * reviewer never saw under an approval given to something else. When absent,
   * assembly behaves exactly as it always has.
   */
  approvedAllocation?: ApprovedAllocation;
  /** Resolves an approved asset id to a downloadable URL. Fails closed. */
  resolveApprovedAsset?: (assetId: string) => Promise<{ url: string; pageUrl?: string; description?: string } | null>;
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
  /**
   * `BRANDED_OUTRO` is a deliberate treatment for a beat with no subject, not a
   * retrieval failure, so it is not counted in the fallback-card share.
   */
  decision: "RENDERED" | "FALLBACK_CARD" | "BRANDED_OUTRO";
  clipPath: string;
}

/**
 * Build a pooled, de-duplicated candidate list for a segment.
 *
 * Beats need many unique assets, so candidates are gathered once per segment
 * across several queries rather than re-searched per beat.
 */
/**
 * What a segment should actually retrieve for.
 *
 * The prompt is the script's, unless it can be SHOWN to be depicting the
 * analogy's vehicle rather than the subject — segment 0 of run e704334a asked
 * for a "wholesale warehouse" off the back of "Imagine buying wholesale
 * electricity". Where that is provable the subject text replaces it; where it
 * is not, the prompt stands and the widened pool does the work.
 */
export interface SegmentSubject {
  prompt: string;
  subject: string;
  queries: string[];
  /** Words the prompt took from the analogy's vehicle. */
  borrowed: string[];
  /** Literal physical domain the prompt asked for without justification. */
  unjustified: string | null;
  /** Literal domains this narration cannot justify; never selected for it. */
  withheld: Set<string>;
  /** Comparison vehicles stated anywhere in the script. */
  vehicles: string[];
}

export function resolveSegmentSubject(
  seg: ScriptSegment,
  scriptText: string,
  channel: "ai-doom-scroll" | "wet-circuit",
): SegmentSubject {
  const vehicles = comparisonVehicles(scriptText);
  const borrowed = borrowedFromVehicle(seg.visual_prompt, vehicles);
  const subject = subjectTerms({ narration: seg.narration, scriptText }).join(" ");
  const subjectText = deVehicle(seg.narration, vehicles);
  const taxonomy = channel === "wet-circuit" ? MARINE_SUBJECTS : AI_SUBJECTS;
  const withheld = withheldDomains(subjectText, taxonomy);
  const asked = classifyConcept(seg.visual_prompt, taxonomy).concept;
  const unjustified = withheld.has(asked) ? asked : null;
  const replace = (borrowed.length > 0 || unjustified !== null) && subject.length > 0;
  const prompt = replace ? subject : seg.visual_prompt;
  // Both sources always search. Pooling from the prompt alone is what made a
  // bad prompt unrecoverable: every candidate was wrong in the same way, so
  // scoring could only choose the least-wrong warehouse.
  const queries = [
    ...buildSearchQueries(prompt, seg.title, channel),
    ...(subject.length > 0 ? buildSearchQueries(subject, seg.title, channel) : []),
  ];
  return {
    prompt, subject, queries: [...new Set(queries)], borrowed, unjustified,
    withheld,
    vehicles,
  };
}

async function gatherCandidates(
  seg: ScriptSegment,
  subject: SegmentSubject,
  pexelsKey: string,
  label: string,
): Promise<Candidate[]> {
  const seen = new Set<string>();
  const pool: Candidate[] = [];
  for (const q of subject.queries) {
    for (const c of await searchPexelsCandidates(q, pexelsKey, { perPage: 40 })) {
      if (!seen.has(c.assetId)) { seen.add(c.assetId); pool.push(c); }
    }
    if (pool.length >= CANDIDATE_POOL) break;
  }
  if (subject.borrowed.length > 0 || subject.unjustified) {
    const why = subject.borrowed.length > 0
      ? `borrowed the analogy's vocabulary (${subject.borrowed.join(", ")})`
      : `asked for unjustified "${subject.unjustified}" imagery`;
    console.log(
      `[${label}] segment ${seg.segmentIndex}: prompt ${why} — retrieving for "${subject.subject}" instead`,
    );
  }
  console.log(`[${label}] segment ${seg.segmentIndex}: pooled ${pool.length} candidates from ${subject.queries.length} queries`);
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
/**
 * Fill one visual beat with one or more consecutive UNIQUE clips.
 *
 * Requiring a single clip to cover a whole beat discarded most of the library:
 * of 40 candidates for "printed circuit board", only 22 run 15 s or longer,
 * while 39 run 8 s or longer. With no reuse permitted across 24 beats the pool
 * ran dry and half the timeline fell back to cards.
 *
 * A beat is therefore covered by consecutive fragments, each from a different
 * asset and each cut (never looped) from the start of its source. This is the
 * documented "split the narration section into smaller visual beats" fallback,
 * preferred over looping, reuse, or a card.
 */
/**
 * Render one approved beat verbatim.
 *
 * No candidate pool, no scoring, no substitution: each fragment is the asset a
 * human approved, cut to the duration alignment produced. A clip that cannot be
 * resolved, downloaded or cut to length is a hard failure — silently dropping
 * it would change the video away from what was approved.
 */
async function renderApprovedBeat(
  beat: ApprovedBeat,
  seg: ScriptSegment,
  tmpDir: string,
  deps: AssemblyDeps,
  videoId: string,
  cursorStartS: number,
): Promise<RenderedBeat[]> {
  const { label, channel } = deps;
  const out: RenderedBeat[] = [];
  let cursor = cursorStartS;
  let fragment = 0;

  // The card, when the approval includes one, at its approved length.
  if (beat.hasCard && (beat.cardSecondsS ?? 0) > 0) {
    const dur = beat.cardSecondsS!;
    const sceneNumber = beat.beat * 100 + ++fragment;
    const clipPath = join(tmpDir, `beat-${sceneNumber}.mp4`);
    const titleFile = join(tmpDir, `card-${sceneNumber}.txt`);
    await writeCardTextFile(titleFile, beat.cardText ?? seg.title);
    await renderCardClip({
      text: beat.cardText ?? seg.title, channel, durationS: dur,
      clipPath, titleFile, tmpDir, sceneNumber, label,
    });
    await recordScene({
      channel, videoId, sceneNumber, narration: beat.narration,
      startTimeS: TITLE_CARD_DURATION + cursor, endTimeS: TITLE_CARD_DURATION + cursor + dur,
      prompt: seg.visual_prompt, assetSource: "approved-card", localPath: clipPath,
      width: WIDTH, height: HEIGHT, durationS: dur,
      validation: "PASS", renderStatus: "RENDERED", rejectionReason: null,
    });
    out.push({
      index: beat.beat, startS: cursor, endS: cursor + dur, durationS: dur,
      narration: beat.narration, assetId: null, assetDescription: `approved card: ${beat.cardText ?? ""}`,
      assetUrl: null, sourceStartS: 0, sourceEndS: dur, looped: false, reused: false,
      relevanceScore: null, concept: "card",
      brand: { visibleBrandDetected: false, detectedBrandOrSignage: null, brandRelevantToNarration: null, brandDecision: "NO_BRAND", rejectionReason: null, source: "none" },
      decision: "FALLBACK_CARD", clipPath,
    });
    cursor += dur;
  }

  for (const f of beat.fragments) {
    const sceneNumber = beat.beat * 100 + ++fragment;
    if (!deps.resolveApprovedAsset) {
      throw new AllocationConflictError("approvedAllocation supplied without resolveApprovedAsset");
    }
    const resolved = await deps.resolveApprovedAsset(f.assetId);
    if (!resolved?.url) {
      throw new AllocationConflictError(`approved asset ${f.assetId} could not be resolved`);
    }
    const rawPath = join(tmpDir, `raw-${sceneNumber}.mp4`);
    try { await downloadTo(resolved.url, rawPath); }
    catch (e) { throw new AllocationConflictError(`approved asset ${f.assetId} failed to download: ${e}`); }

    const srcDur = await videoDuration(rawPath).catch(() => 0);
    const useDur = +f.plannedDurationS.toFixed(3);
    // Playback rate lets a clip cover slightly more or less screen time than
    // its own length. Bounded because beyond this the motion reads as wrong;
    // 1.0 is the default and the solver picks the value closest to it.
    const rate = f.playbackRate ?? 1;
    if (rate < MIN_PLAYBACK_RATE - 1e-9 || rate > MAX_PLAYBACK_RATE + 1e-9) {
      throw new AllocationConflictError(
        `approved asset ${f.assetId}: playback rate ${rate} outside ${MIN_PLAYBACK_RATE}-${MAX_PLAYBACK_RATE}`,
      );
    }
    // Screen seconds `useDur` at rate `rate` consume useDur*rate of source.
    const sourceNeeded = +(useDur * rate).toFixed(3);
    if (srcDur + 1e-3 < sourceNeeded) {
      throw new AllocationConflictError(
        `approved asset ${f.assetId}: need ${sourceNeeded}s of source at ${rate}x for ${useDur}s on screen, but source is ${srcDur.toFixed(2)}s`,
      );
    }

    const clipPath = join(tmpDir, `beat-${sceneNumber}.mp4`);
    // setpts stretches or compresses presentation time; no frames are dropped,
    // duplicated, frozen or reversed. -t clamps the result to exact screen time.
    const vf = (rate === 1 ? "" : `setpts=${(1 / rate).toFixed(6)}*PTS,`)
      + `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,format=yuv420p`;
    await ff(
      ["-i", rawPath, "-t", String(useDur), "-vf", vf,
       "-r", String(FPS), "-c:v", "libx264", "-preset", "fast", "-an", clipPath],
      label,
    );
    await recordScene({
      channel, videoId, sceneNumber, narration: beat.narration,
      startTimeS: TITLE_CARD_DURATION + cursor, endTimeS: TITLE_CARD_DURATION + cursor + useDur,
      prompt: seg.visual_prompt, assetSource: "pexels-approved", assetId: f.assetId,
      assetUrl: resolved.pageUrl ?? f.pageUrl ?? null,
      assetDescription: resolved.description ?? f.description ?? null,
      localPath: clipPath, durationS: useDur,
      cropMethod: "scale-increase+centre-crop; cut (never looped)",
      validation: "PASS", renderStatus: "RENDERED",
      rejectionReason: null,
    });
    console.log(
      `[${label}] beat ${beat.beat}.${fragment} (${useDur.toFixed(1)}s): ${f.assetId} [APPROVED]` +
      (f.continuesIntoBeat ? ` continues ${f.continuationSeconds}s into beat ${f.continuesIntoBeat}` : ""),
    );
    out.push({
      index: beat.beat, startS: cursor, endS: cursor + useDur, durationS: useDur,
      narration: beat.narration, assetId: f.assetId,
      assetDescription: resolved.description ?? f.description ?? null,
      assetUrl: resolved.pageUrl ?? f.pageUrl ?? null,
      sourceStartS: 0, sourceEndS: useDur, looped: false, reused: false,
      relevanceScore: null, concept: "approved",
      brand: { visibleBrandDetected: false, detectedBrandOrSignage: null, brandRelevantToNarration: null, brandDecision: "NO_BRAND", rejectionReason: null, source: "metadata" },
      decision: "RENDERED", clipPath,
    });
    cursor += useDur;
  }
  return out;
}

/**
 * The channel's end card, for a beat that is CTA rather than content.
 *
 * This is a FIXED treatment, not a fallback: it is chosen because the beat has
 * no subject, not because retrieval failed. It is therefore recorded as
 * `BRANDED_OUTRO` and excluded from the fallback-card share, which measures how
 * often the pipeline could not find footage it needed.
 */
async function renderOutroBeat(
  beat: VisualBeat,
  tmpDir: string,
  deps: AssemblyDeps,
  videoId: string,
  cursor: number,
): Promise<RenderedBeat> {
  const { label, channel } = deps;
  const sceneNumber = beat.index * 100 + 1;
  const clipPath = join(tmpDir, `beat-${sceneNumber}.mp4`);
  const titleFile = join(tmpDir, `card-${sceneNumber}.txt`);
  const text = channel === "wet-circuit" ? "Thanks for watching" : "Like & Subscribe";
  await writeCardTextFile(titleFile, text);
  await renderCardClip({
    text, channel, durationS: beat.durationS,
    clipPath, titleFile, tmpDir, sceneNumber, label,
  });
  await recordScene({
    channel, videoId, sceneNumber, narration: beat.narration,
    startTimeS: TITLE_CARD_DURATION + cursor,
    endTimeS: TITLE_CARD_DURATION + cursor + beat.durationS,
    prompt: `[outro] ${text}`, assetSource: "outro-card", localPath: clipPath,
    width: WIDTH, height: HEIGHT, durationS: beat.durationS,
    validation: "PASS", renderStatus: "RENDERED_OUTRO",
    rejectionReason: null, subjectPrompt: "[outro] fixed branded treatment",
  });
  console.log(`[${label}] beat ${beat.index}: outro card (${beat.durationS.toFixed(1)}s) — retrieval bypassed`);
  return {
    index: beat.index, startS: cursor, endS: cursor + beat.durationS,
    durationS: beat.durationS, narration: beat.narration, assetId: null,
    assetDescription: `outro card: ${text}`, assetUrl: null,
    sourceStartS: 0, sourceEndS: beat.durationS, looped: false, reused: false,
    relevanceScore: null, concept: "outro",
    brand: { visibleBrandDetected: false, detectedBrandOrSignage: null, brandRelevantToNarration: null, brandDecision: "NO_BRAND", rejectionReason: null, source: "none" },
    decision: "BRANDED_OUTRO", clipPath,
  };
}

async function renderBeat(
  beat: VisualBeat,
  seg: ScriptSegment,
  subject: SegmentSubject,
  pool: Candidate[],
  ledger: AssetLedger,
  plan: VisualPlan,
  tmpDir: string,
  deps: AssemblyDeps,
  videoId: string,
): Promise<RenderedBeat[]> {
  const { label, channel } = deps;
  const out: RenderedBeat[] = [];
  let remaining = beat.durationS;
  let cursor = beat.startS;
  let fragment = 0;

  // An outro beat has no retrievable subject. "Subscribe so you don't miss our
  // next deep dive" depicts nothing, so the search fell through to whatever the
  // segment prompt said and returned a rapeseed field. These get the channel's
  // own end card instead, and never reach retrieval.
  if (isOutroBeat(beat.narration)) {
    return [await renderOutroBeat(beat, tmpDir, deps, videoId, cursor)];
  }

  // Scored against the beat's narration with the analogy excised. The vehicle
  // is not what the beat is about, and leaving it in does not merely add noise:
  // for the opening beat of run e704334a — whose narration carries "Imagine
  // buying wholesale electricity, then reselling it at a markup" — it held every
  // one of 35 usable candidates to 0.24, a hair under the 0.25 threshold, so the
  // beat took a fallback card. With it removed the same candidates score 0.75.
  const beatNarration = deVehicle(beat.narration, subject.vehicles);
  const scored = pool
    .map((c) => ({
      c,
      r: scoreRelevance({
        channel: channel as "ai-doom-scroll" | "wet-circuit",
        narration: beatNarration,
        prompt: subject.prompt,
        description: c.description ?? "",
      }),
    }))
    // Having ruled that this narration does not justify literal `environment`
    // imagery, retrieving differently and then SELECTING a farm anyway would
    // re-admit exactly what was ruled out. The scorer still credits such an
    // asset 0.50 with the reason `subject "environment" is what this beat is
    // about`, which is untrue here; correcting that reason belongs to scoring,
    // so this only withholds the domain already judged unjustified.
    .filter((x) => !subject.withheld.has(x.r.concept))
    .sort((a, b) => b.r.score - a.r.score);

  /** The strongest candidates this scene's winner beat, for later diagnosis. */
  const runnerUpsFor = (winner: string) => scored
    .filter((x) => x.c.assetId !== winner)
    .slice(0, 3)
    .map((x) => ({
      assetId: x.c.assetId, description: x.c.description ?? "",
      score: +x.r.score.toFixed(3), verdict: x.r.verdict, concept: x.r.concept,
    }));

  const tried = new Set<string>();

  while (remaining >= MIN_FRAGMENT_S) {
    const ranked = scored
      .filter((x) => !tried.has(x.c.assetId) && ledger.isAvailable(x.c.assetId))
      .map((x) => ({ candidate: x.c, relevance: x.r }));
    const pick = plan.selectCandidate(ranked, (c) => ledger.isAvailable(c.assetId));
    if (!pick) break;

    const c = pick.candidate;
    const r = pick.relevance;
    tried.add(c.assetId);
    fragment += 1;

    const sceneNumber = beat.index * 100 + fragment;
    const base = {
      channel, videoId, sceneNumber,
      narration: beat.narration,
      startTimeS: TITLE_CARD_DURATION + cursor,
      endTimeS: TITLE_CARD_DURATION + cursor + Math.min(remaining, c.durationS || remaining),
      prompt: seg.visual_prompt,
    };

    const brand = checkBrandFromMetadata(
      `${c.description ?? ""} ${c.pageUrl ?? ""}`, seg.visual_prompt, beat.narration,
    );
    if (!brandAdmits(brand)) {
      console.log(`[${label}] beat ${beat.index}.${fragment}: reject ${c.assetId} — ${brand.rejectionReason}`);
      continue;
    }
    if (!validateCandidateMeta(c, MIN_FRAGMENT_S).ok) continue;
    if (c.durationS > 0 && c.durationS < MIN_FRAGMENT_S) continue;

    const rawPath = join(tmpDir, `raw-${sceneNumber}.mp4`);
    try { await downloadTo(c.url, rawPath); } catch { continue; }
    if (!(await validateDownloadedClip(rawPath, MIN_FRAGMENT_S)).ok) continue;

    const srcDur = await videoDuration(rawPath).catch(() => 0);
    if (srcDur < MIN_FRAGMENT_S) continue;

    // Use as much of this clip as the beat still needs, without leaving a
    // remainder too short to be a fragment. A source that cannot fit here is
    // skipped in favour of another asset rather than producing a sliver card.
    const fit = fitFragment(remaining, srcDur);
    if (!fit) {
      console.log(`[${label}] beat ${beat.index}.${fragment}: skip ${c.assetId} — ${srcDur.toFixed(1)}s source cannot fill ${remaining.toFixed(1)}s without leaving a sliver`);
      continue;
    }
    const useDur = fit.useS;

    const clipPath = join(tmpDir, `beat-${sceneNumber}.mp4`);
    await ff(
      ["-i", rawPath, "-t", String(useDur),
       "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,format=yuv420p`,
       "-r", String(FPS), "-c:v", "libx264", "-preset", "fast", "-an", clipPath],
      label,
    );

    ledger.claim(c.assetId);
    plan.claim(r);
    await recordScene({
      ...base, endTimeS: TITLE_CARD_DURATION + cursor + useDur,
      assetSource: c.provider, assetId: c.assetId, assetUrl: c.pageUrl ?? c.url,
      assetDescription: c.description, localPath: clipPath,
      width: c.width, height: c.height, durationS: useDur,
      cropMethod: "scale-increase+centre-crop; cut (never looped)",
      relevanceScore: r.score, relevanceVerdict: r.verdict,
      relevanceReasons: [...r.reasons, `brand:${brand.brandDecision}`],
      retrievalQuery: subject.queries.join(" | "),
      subjectPrompt: subject.prompt === seg.visual_prompt ? null : subject.prompt,
      runnerUps: runnerUpsFor(c.assetId),
      validation: "PASS", renderStatus: "RENDERED",
    });
    console.log(
      `[${label}] beat ${beat.index}.${fragment} (${useDur.toFixed(1)}s): ${c.assetId} "${c.description}" ` +
      `[${r.verdict} ${r.score.toFixed(2)} ${r.concept}]${isHighBrandRiskFootage(c.description ?? "") ? " ⚠ brand-risk" : ""}`,
    );

    out.push({
      index: beat.index, startS: cursor, endS: cursor + useDur, durationS: useDur,
      narration: beat.narration, assetId: c.assetId, assetDescription: c.description ?? null,
      assetUrl: c.pageUrl ?? c.url, sourceStartS: 0, sourceEndS: useDur,
      looped: false, reused: false, relevanceScore: r.score, concept: r.concept,
      brand, decision: "RENDERED", clipPath,
    });
    cursor += useDur;
    remaining -= useDur;
  }

  // Remainder (or the whole beat) with no usable footage → branded card.
  if (remaining > 0.5) {
    const sceneNumber = beat.index * 100 + fragment + 1;
    const clipPath = join(tmpDir, `beat-${sceneNumber}.mp4`);
    const titleFile = join(tmpDir, `card-${sceneNumber}.txt`);
    await writeCardTextFile(titleFile, seg.title);
    await ff(
      ["-f", "lavfi", "-i", `color=c=#243257:s=${WIDTH}x${HEIGHT}:d=${remaining}:r=${FPS}`,
       "-vf", `format=yuv420p,drawtext=textfile='${escapeFilterPath(titleFile)}':fontsize=64:fontcolor=white:x=(w-tw)/2:y=(h-th)/2-40:line_spacing=14,`
         + `drawtext=text='${deps.channel === "wet-circuit" ? "WET CIRCUIT" : "AI DOOM SCROLL"}':fontsize=30:fontcolor=0x8899ff:x=(w-tw)/2:y=h-140`,
       "-c:v", "libx264", "-preset", "fast", "-t", String(remaining), clipPath],
      label,
    );
    await recordScene({
      channel, videoId, sceneNumber, narration: beat.narration,
      startTimeS: TITLE_CARD_DURATION + cursor, endTimeS: TITLE_CARD_DURATION + cursor + remaining,
      prompt: seg.visual_prompt, assetSource: "branded-card", localPath: clipPath,
      width: WIDTH, height: HEIGHT, durationS: remaining,
      validation: "PASS", rejectionReason: "no unused relevant clip available for this fragment",
      renderStatus: "RENDERED_FALLBACK",
    });
    console.warn(`[${label}] beat ${beat.index}.${fragment + 1}: branded card (${remaining.toFixed(1)}s)`);
    out.push({
      index: beat.index, startS: cursor, endS: cursor + remaining, durationS: remaining,
      narration: beat.narration, assetId: null, assetDescription: "branded card",
      assetUrl: null, sourceStartS: 0, sourceEndS: remaining,
      looped: false, reused: false, relevanceScore: null, concept: "card",
      brand: { visibleBrandDetected: false, detectedBrandOrSignage: null, brandRelevantToNarration: null, brandDecision: "NO_BRAND", rejectionReason: null, source: "none" },
      decision: "FALLBACK_CARD", clipPath,
    });
  }

  return out;
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
  // ── Approved-allocation path ─────────────────────────────────────────
  //
  // When a human has approved specific clips, planning and acquisition are
  // skipped entirely: no planVisualBeats, no gatherCandidates, no search, no
  // scoring, no substitution. The approved beats are fitted to the durations
  // narration actually produced and rendered verbatim.
  if (deps.approvedAllocation) {
    const alloc = deps.approvedAllocation;
    console.log(`[${label}] APPROVED ALLOCATION — planning and acquisition bypassed (${alloc.beats.length} beats)`);
    const plannedTotal = alloc.beats.reduce((a, b) => a + b.durationS, 0);
    const scale = plannedTotal > 0 ? narrationDurationS / plannedTotal : 1;
    const aligned = alignToNarration(
      alloc,
      new Map(alloc.beats.map((b) => [b.beat, +(b.durationS * scale).toFixed(3)])),
    );
    const renderedApproved: RenderedBeat[] = [];
    let cur = 0;
    for (const ab of aligned) {
      const seg = segments[Math.min(ab.beat - 1, segments.length - 1)] ?? segments[segments.length - 1];
      const clips = await renderApprovedBeat(ab, seg, tmpDir, deps, ctx.video.id, cur);
      renderedApproved.push(...clips);
      cur = clips.length ? clips[clips.length - 1]!.endS : cur;
    }
    // Fail closed unless the render used exactly the approved set, in order.
    assertRealizedMatchesApproved(
      alloc,
      renderedApproved.filter((b) => b.assetId).map((b) => b.assetId!),
    );
    console.log(`[${label}] approved render: ${renderedApproved.length} clips, ${cur.toFixed(1)}s, asset set and order verified`);
    return await finishAssembly(
      ctx, deps, renderedApproved, manifest, captions, assPath,
      tmpDir, outputDir, narrationDurationS, start,
    );
  }

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
  const scriptText = [ctx.script.hook, ...segments.map((s) => s.narration), ctx.script.cta]
    .filter(Boolean).join("\n");
  const subjects = new Map<number, SegmentSubject>();
  const pools = new Map<number, Candidate[]>();
  for (const seg of segments) {
    const subject = resolveSegmentSubject(
      seg, scriptText, deps.channel as "ai-doom-scroll" | "wet-circuit",
    );
    subjects.set(seg.segmentIndex, subject);
    pools.set(seg.segmentIndex, await gatherCandidates(seg, subject, config.PEXELS_API_KEY, label));
  }

  // A 7-minute video needs ~24 unique assets, far more than one segment's
  // search yields. Beats draw from the UNION of every segment's pool and are
  // ranked against their own narration, so the best available match wins
  // regardless of which query surfaced it.
  const globalPool: Candidate[] = [];
  const globalSeen = new Set<string>();
  for (const c of [...pools.values()].flat()) {
    if (!globalSeen.has(c.assetId)) { globalSeen.add(c.assetId); globalPool.push(c); }
  }
  console.log(`[${label}] global candidate pool: ${globalPool.length} unique assets for ${beats.length} beats`);

  for (const beat of beats) {
    const seg = segments[beat.segmentIndex] ?? segments[segments.length - 1];
    const pool = globalPool;
    rendered.push(
      ...(await renderBeat(
        beat, seg, subjects.get(seg.segmentIndex)!, pool, ledger, plan, tmpDir, deps, ctx.video.id,
      )),
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
  const outros = rendered.filter((b) => b.decision === "BRANDED_OUTRO").length;
  console.log(
    `[${label}] visuals: ${rendered.length} beats, ${assetIds.length} unique assets, ${cards} card(s), ${outros} outro(s), ` +
      `${composition.strongCount} strong, ${composition.genericCount} generic, 0 looped, 0 reused`,
  );

  return await finishAssembly(
    ctx, deps, rendered, manifest, captions, assPath,
    tmpDir, outputDir, narrationDurationS, start,
  );
}

/**
 * Title card, concat, mux, duration verification and persistence.
 *
 * Shared verbatim by the normal path and the approved-allocation path, so a
 * human-approved render is muxed, captioned and duration-checked in exactly
 * the same way as any other — only the choice of clips differs.
 */
async function finishAssembly(
  ctx: PipelineContext,
  deps: AssemblyDeps,
  rendered: RenderedBeat[],
  manifest: NarrationManifest,
  captions: BuiltCaptions,
  assPath: string,
  tmpDir: string,
  outputDir: string,
  narrationDurationS: number,
  start: number,
): Promise<StageResult<AssemblyOutcome>> {
  const { label } = deps;
  // ── 4. Title card ────────────────────────────────────────────────────
  const titleTextFile = join(tmpDir, "title.txt");
  await writeCardTextFile(titleTextFile, ctx.topic.title);
  const titlePath = join(tmpDir, "title.mp4");
  if (await hasDrawtext()) {
    await ff(
      ["-f", "lavfi", "-i", `color=c=#1a1a2e:s=${WIDTH}x${HEIGHT}:d=${TITLE_CARD_DURATION}:r=${FPS}`,
       "-vf", `format=yuv420p,drawtext=textfile='${escapeFilterPath(titleTextFile)}':fontsize=54:fontcolor=white:x=(w-tw)/2:y=(h-th)/2:line_spacing=10`,
       "-c:v", "libx264", "-preset", "fast", "-t", String(TITLE_CARD_DURATION), titlePath],
      label,
    );
  } else {
    await renderTextStillClip({
      text: ctx.topic.title, background: "#1a1a2e", fontSize: 54, lineSpacing: 10,
      offsetY: 0, durationS: TITLE_CARD_DURATION,
      stillPath: join(tmpDir, "title.png"), clipPath: titlePath, label,
    });
  }

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
