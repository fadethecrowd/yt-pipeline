import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
import { prisma } from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult } from "@yt-pipeline/pipeline-core";

// ── Brand palette ───────────────────────────────────────────────────────────

const NAVY       = "#0A1628";
const CYAN       = "#00C4D4";
const ORANGE     = "#E85D2B";
const WHITE      = "#F0EDE6";
const SECONDARY  = "#8A9BB5";

const WIDTH  = 1280;
const HEIGHT = 720;

// Left text area = 55% width, right product area = 45%
const TEXT_W    = Math.round(WIDTH * 0.55);  // 704
const PRODUCT_X = TEXT_W;
const PRODUCT_W = WIDTH - TEXT_W;            // 576

// ── Pillar → badge label mapping ────────────────────────────────────────────

type Pillar = "RANKED_LIST" | "HEAD_TO_HEAD" | "NEW_OWNER" | "NEW_DROP";

const PILLAR_BADGES: Record<Pillar, string> = {
  RANKED_LIST:  "TOP 5",
  HEAD_TO_HEAD: "VS",
  NEW_OWNER:    "BUYER'S GUIDE",
  NEW_DROP:     "NEW DROP",
};

function extractPillar(summary: string): Pillar {
  const match = summary.match(/^\[(RANKED_LIST|HEAD_TO_HEAD|NEW_OWNER|NEW_DROP)\]/);
  if (match) return match[1] as Pillar;
  return "NEW_OWNER";
}

// ── SVG helpers ─────────────────────────────────────────────────────────────

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && (current + " " + word).length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Wet Circuit logo mark: wave-to-circuit SVG path.
 * Rendered inside a viewBox="0 0 62 40" so it scales to any container.
 */
function logoSvg(
  x: number,
  y: number,
  w: number,
  h: number,
  strokeColor: string,
): string {
  return `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 62 40">
    <path d="M2 20 Q9 6 16 20 Q23 34 30 20 L36 20 L36 8 L42 8 L42 32 L48 32 L48 20 L56 20 L60 20"
          stroke="${strokeColor}" stroke-width="2.5" stroke-linecap="round" fill="none"/>
  </svg>`;
}

/** "WET CIRCUIT" wordmark — "WET" in accent color, "CIRCUIT" in white */
function wordmarkSvg(x: number, y: number, accentColor: string): string {
  return `<text x="${x}" y="${y}" font-family="'Helvetica Neue', Arial, sans-serif" font-size="16" font-weight="700" letter-spacing="3">
    <tspan fill="${accentColor}">WET</tspan><tspan fill="${WHITE}" dx="6">CIRCUIT</tspan>
  </text>`;
}

/** Pill badge (rounded rect with label) */
function pillBadgeSvg(
  x: number,
  y: number,
  label: string,
  bgColor: string,
  textColor: string,
): string {
  const textLen = label.length * 10 + 24;
  const pillW = Math.max(textLen, 80);
  const pillH = 32;
  const r = pillH / 2;
  return `<rect x="${x}" y="${y}" width="${pillW}" height="${pillH}" rx="${r}" ry="${r}" fill="${bgColor}"/>
    <text x="${x + pillW / 2}" y="${y + 22}" text-anchor="middle" font-family="'Helvetica Neue', Arial, sans-serif" font-size="14" font-weight="700" letter-spacing="1.5" fill="${textColor}">${escapeXml(label)}</text>`;
}

// ── Variant SVG generators ──────────────────────────────────────────────────

/**
 * Variant A — Standard brand layout (cyan accents)
 * Text left, product placeholder right, full brand treatment
 */
function svgVariantA(
  headline: string,
  subtext: string,
  badge: string,
  optionalBadge?: string,
): Buffer {
  const headlineLines = wrapText(headline.toUpperCase(), 18);
  const headlineY = 260;
  const lineHeight = 56;

  const headlineSvg = headlineLines.slice(0, 3).map((line, i) =>
    `<text x="48" y="${headlineY + i * lineHeight}" font-family="'Helvetica Neue', Arial, sans-serif" font-size="48" font-weight="800" fill="${WHITE}" letter-spacing="1">${escapeXml(line)}</text>`,
  ).join("\n");

  const subtextY = headlineY + headlineLines.slice(0, 3).length * lineHeight + 16;
  const subtextLines = wrapText(subtext, 28);
  const subtextSvg = subtextLines.slice(0, 2).map((line, i) =>
    `<text x="48" y="${subtextY + i * 28}" font-family="'Helvetica Neue', Arial, sans-serif" font-size="22" font-weight="500" fill="${CYAN}">${escapeXml(line)}</text>`,
  ).join("\n");

  const optBadgeSvg = optionalBadge
    ? pillBadgeSvg(48, HEIGHT - 72, optionalBadge, "rgba(0,196,212,0.15)", CYAN)
    : "";

  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <!-- Background -->
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${NAVY}"/>

    <!-- Left text area -->
    ${logoSvg(40, 36, 48, 32, CYAN)}
    ${wordmarkSvg(96, 60, CYAN)}
    ${pillBadgeSvg(48, 100, badge, CYAN, NAVY)}

    ${headlineSvg}
    ${subtextSvg}
    ${optBadgeSvg}

    <!-- Right product area -->
    <line x1="${PRODUCT_X}" y1="24" x2="${PRODUCT_X}" y2="${HEIGHT - 24}" stroke="${CYAN}" stroke-width="2" opacity="0.6"/>
    <rect x="${PRODUCT_X + 24}" y="24" width="${PRODUCT_W - 48}" height="${HEIGHT - 48}" rx="8" ry="8"
          fill="rgba(0,196,212,0.04)" stroke="${CYAN}" stroke-width="1" opacity="0.3"/>
    <text x="${PRODUCT_X + PRODUCT_W / 2}" y="${HEIGHT / 2}" text-anchor="middle"
          font-family="'Helvetica Neue', Arial, sans-serif" font-size="16" fill="${SECONDARY}" opacity="0.5">PRODUCT IMAGE</text>

    <!-- Bottom accent bar -->
    <rect y="${HEIGHT - 3}" width="${WIDTH}" height="3" fill="${CYAN}"/>
  </svg>`;

  return Buffer.from(svg);
}

/**
 * Variant B — Signal orange accent
 * Same layout as A, but pill badge, divider, bottom bar, and subtext use signal orange
 */
function svgVariantB(
  headline: string,
  subtext: string,
  badge: string,
  optionalBadge?: string,
): Buffer {
  const headlineLines = wrapText(headline.toUpperCase(), 18);
  const headlineY = 260;
  const lineHeight = 56;

  const headlineSvg = headlineLines.slice(0, 3).map((line, i) =>
    `<text x="48" y="${headlineY + i * lineHeight}" font-family="'Helvetica Neue', Arial, sans-serif" font-size="48" font-weight="800" fill="${WHITE}" letter-spacing="1">${escapeXml(line)}</text>`,
  ).join("\n");

  const subtextY = headlineY + headlineLines.slice(0, 3).length * lineHeight + 16;
  const subtextLines = wrapText(subtext, 28);
  const subtextSvg = subtextLines.slice(0, 2).map((line, i) =>
    `<text x="48" y="${subtextY + i * 28}" font-family="'Helvetica Neue', Arial, sans-serif" font-size="22" font-weight="500" fill="${ORANGE}">${escapeXml(line)}</text>`,
  ).join("\n");

  const optBadgeSvg = optionalBadge
    ? pillBadgeSvg(48, HEIGHT - 72, optionalBadge, "rgba(232,93,43,0.15)", ORANGE)
    : "";

  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${NAVY}"/>

    ${logoSvg(40, 36, 48, 32, ORANGE)}
    ${wordmarkSvg(96, 60, ORANGE)}
    ${pillBadgeSvg(48, 100, badge, ORANGE, WHITE)}

    ${headlineSvg}
    ${subtextSvg}
    ${optBadgeSvg}

    <line x1="${PRODUCT_X}" y1="24" x2="${PRODUCT_X}" y2="${HEIGHT - 24}" stroke="${ORANGE}" stroke-width="2" opacity="0.6"/>
    <rect x="${PRODUCT_X + 24}" y="24" width="${PRODUCT_W - 48}" height="${HEIGHT - 48}" rx="8" ry="8"
          fill="rgba(232,93,43,0.04)" stroke="${ORANGE}" stroke-width="1" opacity="0.3"/>
    <text x="${PRODUCT_X + PRODUCT_W / 2}" y="${HEIGHT / 2}" text-anchor="middle"
          font-family="'Helvetica Neue', Arial, sans-serif" font-size="16" fill="${SECONDARY}" opacity="0.5">PRODUCT IMAGE</text>

    <rect y="${HEIGHT - 3}" width="${WIDTH}" height="3" fill="${ORANGE}"/>
  </svg>`;

  return Buffer.from(svg);
}

/**
 * Variant C — Centered bold layout
 * Full-width text, no product area split, larger headline, gradient accent
 */
function svgVariantC(
  headline: string,
  subtext: string,
  badge: string,
  optionalBadge?: string,
): Buffer {
  const headlineLines = wrapText(headline.toUpperCase(), 22);
  const totalTextH = headlineLines.slice(0, 3).length * 68;
  const headlineY = (HEIGHT - totalTextH) / 2 + 40;
  const lineHeight = 68;

  const headlineSvg = headlineLines.slice(0, 3).map((line, i) =>
    `<text x="${WIDTH / 2}" y="${headlineY + i * lineHeight}" text-anchor="middle" font-family="'Helvetica Neue', Arial, sans-serif" font-size="60" font-weight="900" fill="${WHITE}" letter-spacing="2">${escapeXml(line)}</text>`,
  ).join("\n");

  const subtextY = headlineY + headlineLines.slice(0, 3).length * lineHeight + 20;
  const subtextSvg = `<text x="${WIDTH / 2}" y="${subtextY}" text-anchor="middle" font-family="'Helvetica Neue', Arial, sans-serif" font-size="26" font-weight="500" fill="${CYAN}">${escapeXml(subtext)}</text>`;

  const badgeX = (WIDTH - (badge.length * 10 + 24)) / 2;

  const optBadgeSvg = optionalBadge
    ? `<text x="${WIDTH / 2}" y="${HEIGHT - 48}" text-anchor="middle" font-family="'Helvetica Neue', Arial, sans-serif" font-size="16" font-weight="600" letter-spacing="2" fill="${SECONDARY}">${escapeXml(optionalBadge)}</text>`
    : "";

  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${NAVY}"/>
        <stop offset="100%" stop-color="#0E1F38"/>
      </linearGradient>
    </defs>

    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bgGrad)"/>

    <!-- Centered logo + wordmark -->
    ${logoSvg((WIDTH - 48) / 2 - 40, 32, 48, 32, CYAN)}
    ${wordmarkSvg((WIDTH - 48) / 2 + 16, 56, CYAN)}

    <!-- Centered pill badge -->
    ${pillBadgeSvg(badgeX, 86, badge, CYAN, NAVY)}

    ${headlineSvg}
    ${subtextSvg}
    ${optBadgeSvg}

    <!-- Top + bottom accent bars -->
    <rect width="${WIDTH}" height="3" fill="${CYAN}"/>
    <rect y="${HEIGHT - 3}" width="${WIDTH}" height="3" fill="${CYAN}"/>
  </svg>`;

  return Buffer.from(svg);
}

// ── Stage entry point ───────────────────────────────────────────────────────

/**
 * Generate 3 Wet Circuit branded thumbnail variants.
 *
 * Reads headline/subtext from SEO title + topic summary.
 * Pillar badge derived from topic summary prefix [RANKED_LIST], [HEAD_TO_HEAD], etc.
 */
export async function wcThumbnailGenerator(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();

  const video = await prisma.wcVideo.findUnique({ where: { id: ctx.video.id } });
  const summary = ctx.topic.summary ?? "";
  const pillar = extractPillar(summary);
  const badge = PILLAR_BADGES[pillar];

  // Derive headline from SEO title, subtext from topic title
  const seoTitle = video?.seoTitle ?? ctx.seo?.title ?? ctx.topic.title;
  const headline = seoTitle;
  const subtext = seoTitle !== ctx.topic.title
    ? ctx.topic.title
    : summary.replace(/^\[.*?\]\s*/, "").slice(0, 60) || ctx.topic.title;

  // Optional badge (e.g. year)
  const year = new Date().getFullYear().toString();
  const optionalBadge = /\d{4}/.test(seoTitle) ? undefined : `${year} GUIDE`;

  console.log(`[wc:thumbnailGenerator] Pillar: ${pillar} → badge: "${badge}"`);
  console.log(`[wc:thumbnailGenerator] Headline: "${headline}"`);
  console.log(`[wc:thumbnailGenerator] Subtext: "${subtext}"`);

  // Create output directory
  const outDir = join(process.cwd(), "tmp", ctx.video.id);
  await mkdir(outDir, { recursive: true });

  const pathA = join(outDir, "thumbnail_a.jpg");
  const pathB = join(outDir, "thumbnail_b.jpg");
  const pathC = join(outDir, "thumbnail_c.jpg");

  // Generate 3 variants
  console.log("[wc:thumbnailGenerator] Generating variant A (cyan standard)...");
  await sharp(svgVariantA(headline, subtext, badge, optionalBadge))
    .resize(WIDTH, HEIGHT)
    .jpeg({ quality: 90 })
    .toFile(pathA);

  console.log("[wc:thumbnailGenerator] Generating variant B (orange accent)...");
  await sharp(svgVariantB(headline, subtext, badge, optionalBadge))
    .resize(WIDTH, HEIGHT)
    .jpeg({ quality: 90 })
    .toFile(pathB);

  console.log("[wc:thumbnailGenerator] Generating variant C (centered bold)...");
  await sharp(svgVariantC(headline, subtext, badge, optionalBadge))
    .resize(WIDTH, HEIGHT)
    .jpeg({ quality: 90 })
    .toFile(pathC);

  // Save paths to DB
  await prisma.wcVideo.update({
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

  console.log(`[wc:thumbnailGenerator] 3 thumbnails saved to ${outDir}`);

  return {
    success: true,
    data: { thumbnailA: pathA, thumbnailB: pathB, thumbnailC: pathC },
    durationMs: Date.now() - start,
  };
}
