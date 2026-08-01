/**
 * Frame-backed visual-semantic benchmark preparation (free).
 *
 *   npx tsx scripts/prepare-visual-benchmark.ts
 *
 * Benchmark v1 referenced synthetic asset IDs invented from descriptions, so
 * only 2 of its 8 DIRECT positives mapped to footage that exists. It cannot
 * certify a vision judge. This sources REAL Pexels assets, samples frames
 * deterministically, builds one contact sheet per candidate, and emits a
 * review manifest whose labels are explicitly PROVISIONAL until a human
 * approves them.
 *
 * Uses only the already-configured Pexels API, ffmpeg and sharp. Calls no
 * paid model, opens no budget, touches no YouTube or Railway state.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import "dotenv/config";

export const SAMPLING_VERSION = "frames-v2";
/**
 * Contact sheet: 3 panels on the top row, 2 on the bottom, each 640x360.
 *
 * The first pass tiled five 320x180 panels in a single 1600x180 strip, which
 * was too small to resolve details that decide a verdict — whether a gantry
 * over a motorway actually carries a camera, for instance. A 3+2 grid at 640
 * wide per panel is four times the linear resolution for a little over four
 * times the image tokens, which is the right trade when the whole point is to
 * judge what is visibly there.
 */
export const PANEL_W = 640, PANEL_H = 360;
export const SHEET_W = PANEL_W * 3, SHEET_H = PANEL_H * 2;   // 1920x720
const OUT = "tmp/bench2";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export interface Role {
  id: string; role: string; query?: string; pexelsId?: string;
  requirement: { primarySubjects: string[]; settings: string[]; action?: string };
  narration: string; visualPrompt: string; compositionPolicy: string;
  jointRequired: boolean; expected: string; safetyCritical: boolean; rationale: string;
}

/** Deterministic sample points, nudged off the very edges to dodge leader/end cards. */
export function samplePoints(durationS: number): number[] {
  const edge = Math.min(0.6, durationS * 0.04);
  return [edge, durationS * 0.25, durationS * 0.5, durationS * 0.75, Math.max(edge, durationS - edge)]
    .map((t) => Math.max(0, Math.min(durationS - 0.05, +t.toFixed(3))));
}

async function pexels(path: string): Promise<any> {
  const r = await fetch(`https://api.pexels.com/videos/${path}`, {
    headers: { Authorization: process.env.PEXELS_API_KEY ?? "" },
  });
  if (!r.ok) throw new Error(`pexels ${path} -> ${r.status}`);
  return r.json();
}

/** Smallest file at or above 640px wide — readable in a panel, cheap to fetch. */
function pickVariant(files: any[]): any {
  const ok = files.filter((f) => (f.width ?? 0) >= 640 && f.file_type === "video/mp4")
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return ok[0] ?? files[0];
}

export async function prepareCandidate(role: Role) {
  let video: any;
  if (role.pexelsId) video = await pexels(`videos/${role.pexelsId}`);
  else {
    const res = await pexels(`search?query=${encodeURIComponent(role.query!)}&per_page=15&orientation=landscape`);
    video = res.videos?.[0];
    if (!video) return { ...role, status: "UNAVAILABLE_SOURCE_TARGET", reason: "no Pexels result" };
  }
  const variant = pickVariant(video.video_files ?? []);
  if (!variant?.link) return { ...role, status: "UNAVAILABLE_SOURCE_TARGET", reason: "no usable file variant" };

  const media = join(OUT, "media", `${video.id}.mp4`);
  if (!existsSync(media)) {
    const buf = Buffer.from(await (await fetch(variant.link)).arrayBuffer());
    writeFileSync(media, buf);
  }
  const mediaHash = sha(readFileSync(media));

  const dur = Number(execFileSync("ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", media]).toString().trim());
  const ts = samplePoints(dur);

  const frames: { index: number; t: number; sha256: string; path: string }[] = [];
  for (let i = 0; i < ts.length; i++) {
    const fp = join(OUT, "frames", `${video.id}-${i}.jpg`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(ts[i]), "-i", media,
      "-frames:v", "1", "-vf", `scale=${SHEET_W / 5}:${SHEET_H / 5}:force_original_aspect_ratio=decrease,pad=${SHEET_W / 5}:${SHEET_H / 5}:(ow-iw)/2:(oh-ih)/2`,
      "-q:v", "3", fp]);
    frames.push({ index: i, t: ts[i]!, sha256: sha(readFileSync(fp)), path: fp });
  }

  // One labelled contact sheet, composed with sharp.
  //
  // This ffmpeg build has no drawtext filter (no libfreetype), so panel labels
  // are drawn as an SVG overlay instead. Panels read left to right as F1..F5.
  const PW = Math.floor(SHEET_W / 5), PH = Math.floor(SHEET_H / 5);
  const sheet = join(OUT, "sheets", `${role.id}__${video.id}.jpg`);
  const panels = await Promise.all(frames.map(async (f) =>
    sharp(f.path).resize(PW, PH, { fit: "contain", background: "#000" }).toBuffer()));
  const labelSvg = Buffer.from(
    `<svg width="${SHEET_W}" height="${PH}">` +
    frames.map((f, i) =>
      `<rect x="${i * PW + 4}" y="4" width="150" height="22" fill="black" opacity="0.65"/>` +
      `<text x="${i * PW + 10}" y="21" font-family="sans-serif" font-size="15" fill="white">` +
      `F${i + 1} @ ${f.t.toFixed(1)}s</text>`).join("") + `</svg>`);
  await sharp({ create: { width: SHEET_W, height: PH, channels: 3, background: "#000" } })
    .composite([
      ...panels.map((b, i) => ({ input: b, left: i * PW, top: 0 })),
      { input: labelSvg, left: 0, top: 0 },
    ])
    .jpeg({ quality: 82 })
    .toFile(sheet);

  return {
    ...role,
    status: "PREPARED",
    pexels: {
      id: String(video.id), pageUrl: video.url, durationS: dur,
      width: video.width, height: video.height,
      variant: { width: variant.width, height: variant.height, quality: variant.quality },
      variantCount: (video.video_files ?? []).length,
      user: video.user?.name ?? null, license: "Pexels License (free use, attribution appreciated)",
    },
    sourceQuery: role.query ?? `id:${role.pexelsId}`,
    mediaSha256: mediaHash,
    samplingVersion: SAMPLING_VERSION,
    frames: frames.map((f) => ({ index: f.index, timestampS: f.t, sha256: f.sha256 })),
    contactSheet: { path: sheet, sha256: sha(readFileSync(sheet)), width: SHEET_W, height: Math.floor(SHEET_H / 5) },
    labelStatus: "PROVISIONAL_CLAUDE_REVIEW",
  };
}
