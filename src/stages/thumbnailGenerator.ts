import { join } from "node:path";
import { mkdir } from "node:fs/promises";
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

// ── SVG text overlay generators ─────────────────────────────────────────

function svgVariantA(headline: string, subtitle: string): Buffer {
  const headlineLines = wrapText(headline, 28);
  const headlineY = HEIGHT / 2 - (headlineLines.length - 1) * 42;

  const headlineSvg = headlineLines
    .map((line, i) => `<text x="640" y="${headlineY + i * 84}" text-anchor="middle" font-family="monospace, 'Courier New'" font-size="72" font-weight="bold" fill="white">${escapeXml(line)}</text>`)
    .join("\n");

  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#0a0a0a"/>
    <rect width="${WIDTH}" height="4" fill="${ACCENT}"/>
    <text x="1200" y="80" text-anchor="middle" font-size="80" fill="white" opacity="0.3">&#9760;</text>
    ${headlineSvg}
    <text x="640" y="${headlineY + headlineLines.length * 84 + 20}" text-anchor="middle" font-family="monospace, 'Courier New'" font-size="28" fill="${ACCENT}">${escapeXml(subtitle)}</text>
    <text x="30" y="${HEIGHT - 20}" font-family="monospace, 'Courier New'" font-size="18" fill="#555555">AI DOOM SCROLL</text>
  </svg>`;

  return Buffer.from(svg);
}

function svgVariantBOverlay(headline: string): Buffer {
  const headlineLines = wrapText(headline, 32);
  const stripTop = HEIGHT - 220;
  const textStartY = stripTop + 60;

  const headlineSvg = headlineLines
    .slice(0, 2)
    .map((line, i) => `<text x="40" y="${textStartY + i * 72}" font-family="Arial, Helvetica, sans-serif" font-size="64" font-weight="bold" fill="white">${escapeXml(line)}</text>`)
    .join("\n");

  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="rgba(0,0,0,0.35)"/>
    <rect y="${stripTop - 3}" width="${WIDTH}" height="3" fill="${ACCENT}"/>
    <rect y="${stripTop}" width="${WIDTH}" height="220" fill="rgba(0,0,0,0.85)"/>
    ${headlineSvg}
    <text x="30" y="30" font-family="Arial, Helvetica, sans-serif" font-size="18" fill="white" opacity="0.7">AI DOOM SCROLL</text>
  </svg>`;

  return Buffer.from(svg);
}

function svgVariantCOverlay(headline: string, hook: string): Buffer {
  const hookLines = wrapText(hook, 16);
  const hookY = HEIGHT / 2 - (hookLines.length - 1) * 60;

  const hookSvg = hookLines
    .map((line, i) => `<text x="640" y="${hookY + i * 120}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="110" font-weight="900" fill="white">${escapeXml(line)}</text>`)
    .join("\n");

  const fullTitleY = hookY + hookLines.length * 120 + 30;

  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="rgba(0,0,0,0.65)"/>
    <rect width="${WIDTH}" height="4" fill="${ACCENT}"/>
    ${hookSvg}
    <text x="640" y="${fullTitleY}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="32" fill="white" opacity="0.6">${escapeXml(headline)}</text>
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
 * Stage 6: Generate 3 thumbnail variants from the assembled video.
 */
export async function thumbnailGenerator(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();

  const video = await prisma.video.findUnique({ where: { id: ctx.video.id } });
  const videoPath = video?.videoPath ?? ctx.videoUrl;
  if (!videoPath) {
    return { success: false, error: "No videoPath available", durationMs: Date.now() - start };
  }

  const headline = video?.seoTitle ?? ctx.seo?.title ?? ctx.topic.title;
  const subtitle = ctx.topic.summary ?? ctx.topic.title;

  // Create output directory
  const outDir = join(process.cwd(), "tmp", ctx.video.id);
  await mkdir(outDir, { recursive: true });

  const framePath = join(outDir, "frame.jpg");
  const pathA = join(outDir, "thumbnail_a.jpg");
  const pathB = join(outDir, "thumbnail_b.jpg");
  const pathC = join(outDir, "thumbnail_c.jpg");

  // Extract frame at 20% duration
  const duration = await getVideoDuration(videoPath);
  const timestamp = duration * 0.2;
  console.log(`[thumbnailGenerator] Extracting frame at ${timestamp.toFixed(1)}s (20% of ${duration.toFixed(1)}s)`);
  await extractFrame(videoPath, framePath, timestamp);

  // Generate 3 variants
  console.log("[thumbnailGenerator] Generating variant A (Terminal)...");
  await generateVariantA(headline, subtitle, pathA);

  console.log("[thumbnailGenerator] Generating variant B (Frame + strip)...");
  await generateVariantB(framePath, headline, pathB);

  console.log("[thumbnailGenerator] Generating variant C (Frame + big text)...");
  await generateVariantC(framePath, headline, pathC);

  // Save paths to DB
  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      thumbnailA: pathA,
      thumbnailB: pathB,
      thumbnailC: pathC,
    },
  });

  ctx.thumbnailA = pathA;
  ctx.thumbnailB = pathB;
  ctx.thumbnailC = pathC;

  console.log(`[thumbnailGenerator] 3 thumbnails saved to ${outDir}`);

  return {
    success: true,
    data: { thumbnailA: pathA, thumbnailB: pathB, thumbnailC: pathC },
    durationMs: Date.now() - start,
  };
}
