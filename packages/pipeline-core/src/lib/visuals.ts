import { writeFile } from "node:fs/promises";
import { prisma } from "./db";
import { blackFrameStats, frozenRunSeconds, mediaInfo, videoDuration } from "./ffmpeg";
import { describeFromPexelsUrl } from "./visualRelevance";

/**
 * Stock-visual retrieval, validation and de-duplication.
 *
 * Every candidate clip is checked before it can reach the timeline, and every
 * accepted or rejected asset is written to `scene_record` so each frame on
 * screen is traceable to a source, a prompt and a validation verdict.
 */

// ── Acceptance thresholds ─────────────────────────────────────────────────

export const MIN_WIDTH = 1280;
export const MIN_HEIGHT = 720;
export const MIN_CLIP_SECONDS = 3;
/** A clip more than this fraction black is unusable. */
export const MAX_BLACK_FRACTION = 0.15;
/** A still-frame run this long reads as a frozen clip. */
export const MAX_FROZEN_SECONDS = 3.0;
/** Landscape source must be at least this wide relative to height. */
export const MIN_ASPECT = 1.2;

export interface Candidate {
  assetId: string;
  url: string;
  width: number;
  height: number;
  durationS: number;
  provider: string;
  /** Provider page URL — carries the human-written slug. */
  pageUrl?: string;
  /** Human-readable description of what the asset shows. */
  description?: string;
}

export interface ValidationOutcome {
  ok: boolean;
  reason?: string;
}

export interface SceneAssetPlan {
  sceneNumber: number;
  narration: string;
  prompt: string;
  startTimeS: number;
  endTimeS: number;
}

// ── Pexels search ─────────────────────────────────────────────────────────

/**
 * Return ranked candidates for a query. Unlike the previous single-result
 * search, this keeps the asset ID so the caller can reject duplicates, and it
 * never falls back to an arbitrary low-resolution file when no rendition meets
 * the resolution floor.
 */
export async function searchPexelsCandidates(
  query: string,
  apiKey: string,
  opts: { orientation?: "landscape" | "portrait"; perPage?: number } = {},
): Promise<Candidate[]> {
  const { orientation = "landscape", perPage = 15 } = opts;
  const url =
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}` +
    `&per_page=${perPage}&orientation=${orientation}&size=medium`;

  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) {
    console.warn(`[visuals] Pexels search failed for "${query}": ${res.status}`);
    return [];
  }
  const data = (await res.json()) as any;
  const out: Candidate[] = [];

  for (const video of data.videos ?? []) {
    const files = (video.video_files ?? []) as any[];
    // Only renditions that clear the resolution floor. No `|| files[0]`
    // fallback — that silently admitted 640x360 clips.
    const usable = files
      .filter((f) => (f.width ?? 0) >= MIN_WIDTH && (f.height ?? 0) >= MIN_HEIGHT)
      .sort((a, b) => Math.abs(a.height - 1080) - Math.abs(b.height - 1080));
    const best = usable[0];
    if (!best?.link) continue;
    const pageUrl = String(video.url ?? "");
    out.push({
      assetId: String(video.id),
      url: best.link,
      width: best.width,
      height: best.height,
      durationS: Number(video.duration ?? 0),
      provider: "pexels",
      pageUrl,
      // The page slug is the only human-written description Pexels exposes,
      // and it is what makes semantic relevance checking possible at all.
      description: describeFromPexelsUrl(pageUrl),
    });
  }
  return out;
}

// ── Validation ────────────────────────────────────────────────────────────

/** Metadata-level checks, run before download where possible. */
export function validateCandidateMeta(
  c: Candidate,
  neededSeconds: number,
): ValidationOutcome {
  if (c.width < MIN_WIDTH || c.height < MIN_HEIGHT) {
    return { ok: false, reason: `resolution ${c.width}x${c.height} below ${MIN_WIDTH}x${MIN_HEIGHT}` };
  }
  const aspect = c.width / c.height;
  if (aspect < MIN_ASPECT) {
    return { ok: false, reason: `aspect ${aspect.toFixed(2)} below ${MIN_ASPECT} (wrong orientation)` };
  }
  if (c.durationS > 0 && c.durationS < MIN_CLIP_SECONDS) {
    return { ok: false, reason: `source clip ${c.durationS}s under ${MIN_CLIP_SECONDS}s minimum` };
  }
  void neededSeconds;
  return { ok: true };
}

/**
 * Content-level checks on a downloaded file: readable, has video, correct
 * dimensions, not predominantly black, not frozen.
 */
export async function validateDownloadedClip(
  path: string,
  neededSeconds: number,
): Promise<ValidationOutcome> {
  let info;
  try {
    info = await mediaInfo(path);
  } catch (e) {
    return { ok: false, reason: `unreadable/corrupt file: ${e instanceof Error ? e.message : e}` };
  }
  if (!info.hasVideo) return { ok: false, reason: "no video stream" };
  if (!info.width || !info.height) return { ok: false, reason: "no dimensions" };
  if (info.width < MIN_WIDTH || info.height < MIN_HEIGHT) {
    return { ok: false, reason: `decoded resolution ${info.width}x${info.height} below floor` };
  }

  const dur = await videoDuration(path).catch(() => null);
  if (dur !== null && dur < MIN_CLIP_SECONDS) {
    return { ok: false, reason: `decoded duration ${dur.toFixed(1)}s under ${MIN_CLIP_SECONDS}s` };
  }

  const black = await blackFrameStats(path);
  const denom = dur ?? neededSeconds ?? 1;
  if (denom > 0 && black.blackSeconds / denom > MAX_BLACK_FRACTION) {
    return {
      ok: false,
      reason: `${((black.blackSeconds / denom) * 100).toFixed(0)}% black frames`,
    };
  }

  const frozen = await frozenRunSeconds(path);
  if (frozen > MAX_FROZEN_SECONDS) {
    return { ok: false, reason: `frozen for ${frozen.toFixed(1)}s` };
  }

  return { ok: true };
}

// ── De-duplication ────────────────────────────────────────────────────────

/**
 * Tracks which assets a video has already used so fallback logic cannot paper
 * over a failure by re-showing the same clip, and so a popular Pexels result
 * shared by two similar prompts is only used once.
 */
export class AssetLedger {
  private used = new Set<string>();

  constructor(private readonly maxReusePerAsset = 1) {}

  private count = new Map<string, number>();

  isAvailable(assetId: string): boolean {
    return (this.count.get(assetId) ?? 0) < this.maxReusePerAsset;
  }

  claim(assetId: string): void {
    this.count.set(assetId, (this.count.get(assetId) ?? 0) + 1);
    this.used.add(assetId);
  }

  get usedIds(): string[] {
    return [...this.used];
  }

  get duplicateCount(): number {
    let dupes = 0;
    for (const n of this.count.values()) if (n > 1) dupes += n - 1;
    return dupes;
  }
}

// ── Scene records ─────────────────────────────────────────────────────────

export interface SceneRecordInput {
  channel: string;
  videoId: string;
  sceneNumber: number;
  narration: string;
  startTimeS: number;
  endTimeS: number;
  prompt: string;
  assetSource: string;
  assetId?: string | null;
  assetUrl?: string | null;
  localPath?: string | null;
  width?: number | null;
  height?: number | null;
  durationS?: number | null;
  cropMethod?: string | null;
  validation: "PASS" | "REJECT";
  rejectionReason?: string | null;
  renderStatus: string;
  relevanceScore?: number | null;
  relevanceVerdict?: string | null;
  assetDescription?: string | null;
  relevanceReasons?: string[];
  /** The query actually issued to the stock library for this scene. */
  retrievalQuery?: string | null;
  /** What the narration was judged to be about, when it differed from the prompt. */
  subjectPrompt?: string | null;
  /** Top scored candidates the winner beat, so a diagnosis can see what was passed over. */
  runnerUps?: { assetId: string; description: string; score: number; verdict: string; concept: string }[];
}

export async function recordScene(input: SceneRecordInput): Promise<void> {
  await prisma.sceneRecord.upsert({
    where: {
      videoId_sceneNumber: { videoId: input.videoId, sceneNumber: input.sceneNumber },
    },
    create: {
      ...input,
      relevanceReasons: input.relevanceReasons ?? [],
      narration: input.narration.slice(0, 4000),
      prompt: input.prompt.slice(0, 2000),
    },
    update: {
      ...input,
      relevanceReasons: input.relevanceReasons ?? [],
      narration: input.narration.slice(0, 4000),
      prompt: input.prompt.slice(0, 2000),
    },
  });
}

export async function sceneRecordsFor(videoId: string) {
  return prisma.sceneRecord.findMany({
    where: { videoId },
    orderBy: { sceneNumber: "asc" },
  });
}

// ── Fallback card ─────────────────────────────────────────────────────────

export function wrapCardText(text: string, maxChars = 35): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > maxChars && line.length > 0) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

export async function writeCardTextFile(path: string, text: string): Promise<void> {
  await writeFile(path, wrapCardText(text));
}
