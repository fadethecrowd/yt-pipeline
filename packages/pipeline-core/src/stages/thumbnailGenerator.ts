import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { prisma } from "../lib/db";
import type { PipelineContext, StageResult } from "../types";

const execFile = promisify(execFileCb);

const WIDTH = 1280;
const HEIGHT = 720;
const ACCENT = "#00ff41";
const ACCENT_RGB = { r: 0, g: 255, b: 65 };

// ── Helpers ──────────────────────────────────────────────────────────────

async function getVideoDuration(videoPath: string): Promise<number> {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    videoPath,
  ]);
  return parseFloat(stdout.trim());
}

async function extractFrame(videoPath: string, outputPath: string, timestamp: number): Promise<void> {
  await execFile("ffmpeg", [
    "-y",
    "-ss", String(timestamp),
    "-i", videoPath,
    "-frames:v", "1",
    "-q:v", "2",
    outputPath,
  ]);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && (current + " " + word).length > maxCharsPerLine) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function extractHook(title: string): string {
  const words = title.split(/\s+/).filter((w) => w.length > 2);
  return words.slice(0, 4).join(" ");
}

// ── Punch-word detection ────────────────────────────────────────────────

const PUNCH_PRIORITY = [
  "HACKS", "KILLS", "BREAKS", "WATCHES", "REMEMBERS",
  "EXPLOITS", "EXPOSED", "UNSAFE",
];

const PUNCH_COLOR = "#00ffff"; // CYAN — distinct from ACCENT (matrix green)

/**
 * Pick one focal word from the headline. Priority list first; fallback to
 * longest ALL-CAPS word; final fallback to longest word overall.
 * Returns the text flanking the punch word so it can be rendered on
 * separate visual lines (punch 2.5× bigger than the flanking lines).
 */
function detectPunchWord(
  headline: string,
): { before: string; punch: string; after: string } {
  const words = headline.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return { before: "", punch: "", after: "" };

  // Priority-list match first (case-insensitive on the word)
  let idx = words.findIndex((w) => PUNCH_PRIORITY.includes(w.toUpperCase()));

  // Fallback: longest ALL-CAPS word (len tiebreak → first occurrence)
  if (idx === -1) {
    let bestIdx = -1;
    let bestLen = 0;
    for (let i = 0; i < words.length; i++) {
      if (/^[A-Z]+$/.test(words[i]) && words[i].length > bestLen) {
        bestIdx = i;
        bestLen = words[i].length;
      }
    }
    idx = bestIdx;
  }

  // Final fallback: longest word overall
  if (idx === -1) {
    let bestIdx = 0;
    for (let i = 1; i < words.length; i++) {
      if (words[i].length > words[bestIdx].length) bestIdx = i;
    }
    idx = bestIdx;
  }

  return {
    before: words.slice(0, idx).join(" "),
    punch: words[idx],
    after: words.slice(idx + 1).join(" "),
  };
}

// ── SVG text overlay generators ─────────────────────────────────────────

function svgVariantA(headline: string, subtitle: string): Buffer {
  const { before, punch, after } = detectPunchWord(headline);

  const BASE_SIZE = 72;
  const PUNCH_SIZE = Math.round(BASE_SIZE * 2.5); // 180

  // Vertical layout: three text elements stacked. Baselines chosen so the
  // 180pt punch word lands near vertical center; flanking lines hug it.
  // Y positions here are SVG text baselines.
  //
  // Tightened spacing (vs previous 230 / 440 / 610 / subtitle=680):
  //   top padding     : 230 → 205   (-11%)
  //   before → punch  : 210 → 175   (-17%)
  //   punch → after   : 170 → 145   (-15%)
  //   after → subtitle:  70 →  60   (-14%)
  // Font sizes unchanged; highlighting/alignment/positioning rules preserved.
  const beforeY = 205;
  const punchY = 380;
  const afterY = 525;

  const parts: string[] = [];
  if (before) {
    parts.push(
      `<text x="640" y="${beforeY}" text-anchor="middle" font-family="'Bebas Neue', sans-serif" font-size="${BASE_SIZE}" fill="white">${escapeXml(before)}</text>`,
    );
  }
  if (punch) {
    parts.push(
      `<text x="640" y="${punchY}" text-anchor="middle" font-family="'Bebas Neue', sans-serif" font-size="${PUNCH_SIZE}" fill="${PUNCH_COLOR}">${escapeXml(punch)}</text>`,
    );
  }
  if (after) {
    parts.push(
      `<text x="640" y="${afterY}" text-anchor="middle" font-family="'Bebas Neue', sans-serif" font-size="${BASE_SIZE}" fill="white">${escapeXml(after)}</text>`,
    );
  }
  const headlineSvg = parts.join("\n");

  // Subtitle sits just above the footer watermark (y=700) to anchor the
  // bottom of the composition and eliminate the visible void that
  // appeared when the subtitle tracked the tightened internal gaps
  // (previously 585). Gap from `after` line is deliberately looser
  // (~135 vs 60 earlier) — fixed font sizes mean something has to give;
  // keeping the subtitle near the footer is the better visual trade.
  const subtitleY = 660;

  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#0a0a0a"/>
    <rect width="${WIDTH}" height="4" fill="${ACCENT}"/>
    <text x="1200" y="80" text-anchor="middle" font-size="80" fill="white" opacity="0.3">&#9760;</text>
    ${headlineSvg}
    <text x="640" y="${subtitleY}" text-anchor="middle" font-family="'Bebas Neue', sans-serif" font-size="28" fill="${ACCENT}">${escapeXml(subtitle)}</text>
    <text x="30" y="${HEIGHT - 20}" font-family="'Bebas Neue', sans-serif" font-size="18" fill="#555555">AI DOOM SCROLL</text>
  </svg>`;

  return Buffer.from(svg);
}

function svgVariantBOverlay(headline: string): Buffer {
  const headlineLines = wrapText(headline, 32);
  const stripTop = HEIGHT - 220;
  const textStartY = stripTop + 60;

  const headlineSvg = headlineLines
    .slice(0, 2)
    .map((line, i) => `<text x="40" y="${textStartY + i * 72}" font-family="'Bebas Neue', sans-serif" font-size="64" fill="white">${escapeXml(line)}</text>`)
    .join("\n");

  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="rgba(0,0,0,0.35)"/>
    <rect y="${stripTop - 3}" width="${WIDTH}" height="3" fill="${ACCENT}"/>
    <rect y="${stripTop}" width="${WIDTH}" height="220" fill="rgba(0,0,0,0.85)"/>
    ${headlineSvg}
    <text x="30" y="30" font-family="'Bebas Neue', sans-serif" font-size="18" fill="white" opacity="0.7">AI DOOM SCROLL</text>
  </svg>`;

  return Buffer.from(svg);
}

function svgVariantCOverlay(headline: string, hook: string): Buffer {
  const hookLines = wrapText(hook, 16);
  const hookY = HEIGHT / 2 - (hookLines.length - 1) * 60;

  const hookSvg = hookLines
    .map((line, i) => `<text x="640" y="${hookY + i * 120}" text-anchor="middle" font-family="'Bebas Neue', sans-serif" font-size="110" fill="white">${escapeXml(line)}</text>`)
    .join("\n");

  const fullTitleY = hookY + hookLines.length * 120 + 30;

  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="rgba(0,0,0,0.65)"/>
    <rect width="${WIDTH}" height="4" fill="${ACCENT}"/>
    ${hookSvg}
    <text x="640" y="${fullTitleY}" text-anchor="middle" font-family="'Bebas Neue', sans-serif" font-size="32" fill="white" opacity="0.6">${escapeXml(headline)}</text>
  </svg>`;

  return Buffer.from(svg);
}

// ── Variant generators ──────────────────────────────────────────────────

async function generateVariantA(
  headline: string,
  subtitle: string,
  outputPath: string,
): Promise<void> {
  const svg = svgVariantA(headline, subtitle);
  await sharp(svg)
    .resize(WIDTH, HEIGHT)
    .jpeg({ quality: 90 })
    .toFile(outputPath);
}

async function generateVariantB(
  framePath: string,
  headline: string,
  outputPath: string,
): Promise<void> {
  const overlay = svgVariantBOverlay(headline);
  await sharp(framePath)
    .resize(WIDTH, HEIGHT, { fit: "cover" })
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toFile(outputPath);
}

async function generateVariantC(
  framePath: string,
  headline: string,
  outputPath: string,
): Promise<void> {
  const hook = extractHook(headline);
  const overlay = svgVariantCOverlay(headline, hook);
  const blurred = await sharp(framePath)
    .resize(WIDTH, HEIGHT, { fit: "cover" })
    .blur(8)
    .toBuffer();

  await sharp(blurred)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toFile(outputPath);
}

// ── Stage entry point ───────────────────────────────────────────────────

/**
 * Stage: Generate 3 thumbnail variants from the assembled video.
 */
export async function thumbnailGenerator(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();

  // DISABLE_ELEVEN gate — skips rendering and writes 0-byte placeholders.
  // FORCE_THUMBNAIL_RENDER=true is an escape hatch that lets thumbnail
  // rendering execute even under DISABLE_ELEVEN, so we can validate
  // sharp/librsvg/Bebas Neue without burning ElevenLabs spend on
  // voiceover/assembly. Variants B and C may still fail if there's no
  // assembled video frame to extract — that's acceptable; we render
  // Variant A (pure SVG, no frame needed) as the validation target.
  const forceRender = process.env.FORCE_THUMBNAIL_RENDER === "true";
  if (process.env.DISABLE_ELEVEN === "true" && !forceRender) {
    console.log("[guard] DISABLE_ELEVEN active — skipping thumbnail generation");
    const thumbDir = join(process.cwd(), "thumbnail", ctx.video.id);
    await mkdir(thumbDir, { recursive: true });
    const placeholderPath = join(thumbDir, "placeholder.jpg");
    await writeFile(placeholderPath, Buffer.from([]));
    await prisma.video.update({
      where: { id: ctx.video.id },
      data: {
        thumbnailA: placeholderPath,
        thumbnailB: placeholderPath,
        thumbnailC: placeholderPath,
      },
    });
    ctx.thumbnailA = placeholderPath;
    ctx.thumbnailB = placeholderPath;
    ctx.thumbnailC = placeholderPath;
    return { success: true, durationMs: Date.now() - start };
  }
  if (forceRender) {
    console.log("[guard] FORCE_THUMBNAIL_RENDER active — rendering thumbnails despite DISABLE_ELEVEN");
  }

  const video = await prisma.video.findUnique({ where: { id: ctx.video.id } });
  const videoPath = video?.videoPath ?? ctx.videoUrl;

  // Under FORCE_THUMBNAIL_RENDER we tolerate a missing/empty video file
  // because variants B and C are best-effort in that mode. Variant A
  // (pure SVG) does not need a frame and will always render.
  if (!videoPath && !forceRender) {
    return { success: false, error: "No videoPath available", durationMs: Date.now() - start };
  }

  // Headline preference order: thumbnail-specific → seoTitle → ctx.seo.title → topic.title.
  // thumbnailHeadlineGenerator stage runs immediately before this stage in
  // the AI Doom pipeline and persists `thumbnailHeadline`/`thumbnailSubtext`
  // to the Video row. WC pipeline doesn't run that stage so these are null
  // and the existing fallback applies.
  const headline =
    video?.thumbnailHeadline ?? video?.seoTitle ?? ctx.seo?.title ?? ctx.topic.title;
  const subtitle =
    video?.thumbnailSubtext ?? ctx.topic.summary ?? ctx.topic.title;

  // Create output directory
  const outDir = join(process.cwd(), "tmp", ctx.video.id);
  await mkdir(outDir, { recursive: true });

  const framePath = join(outDir, "frame.jpg");
  const pathA = join(outDir, "thumbnail_a.jpg");
  const pathB = join(outDir, "thumbnail_b.jpg");
  const pathC = join(outDir, "thumbnail_c.jpg");

  // Extract frame at 20% duration. Wrapped in try/catch so a 0-byte mp4
  // (from DISABLE_ELEVEN videoAssembly placeholder) doesn't kill the stage —
  // Variant A renders without a frame.
  let frameAvailable = false;
  if (videoPath) {
    try {
      const duration = await getVideoDuration(videoPath);
      const timestamp = duration * 0.2;
      console.log(`[thumbnailGenerator] Extracting frame at ${timestamp.toFixed(1)}s (20% of ${duration.toFixed(1)}s)`);
      await extractFrame(videoPath, framePath, timestamp);
      frameAvailable = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (forceRender) {
        console.warn(`[thumbnailGenerator] Frame extraction failed under FORCE_THUMBNAIL_RENDER (Variants B/C will be skipped): ${msg}`);
      } else {
        throw err;
      }
    }
  }

  // Variant A is pure SVG — always rendered.
  console.log("[thumbnailGenerator] Generating variant A (Terminal)...");
  await generateVariantA(headline, subtitle, pathA);

  // Variants B and C require a real video frame.
  let variantBPath: string | null = null;
  let variantCPath: string | null = null;
  if (frameAvailable) {
    console.log("[thumbnailGenerator] Generating variant B (Frame + strip)...");
    await generateVariantB(framePath, headline, pathB);
    variantBPath = pathB;

    console.log("[thumbnailGenerator] Generating variant C (Frame + big text)...");
    await generateVariantC(framePath, headline, pathC);
    variantCPath = pathC;
  } else {
    console.log("[thumbnailGenerator] Frame unavailable — skipping Variants B and C");
  }

  // Save paths to DB. Only the variants we actually produced; null where skipped.
  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      thumbnailA: pathA,
      thumbnailB: variantBPath,
      thumbnailC: variantCPath,
    },
  });

  ctx.thumbnailA = pathA;
  ctx.thumbnailB = variantBPath ?? undefined;
  ctx.thumbnailC = variantCPath ?? undefined;

  const rendered = [pathA, variantBPath, variantCPath].filter(Boolean).length;
  console.log(`[thumbnailGenerator] ${rendered} thumbnail(s) saved to ${outDir}`);

  return {
    success: true,
    data: { thumbnailA: pathA, thumbnailB: variantBPath, thumbnailC: variantCPath },
    durationMs: Date.now() - start,
  };
}
