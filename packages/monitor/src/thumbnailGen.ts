import sharp from "sharp";

const WIDTH = 1280;
const HEIGHT = 720;
const ACCENT = "#00ff41";

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

function svgVariantA(headline: string, subtitle: string): Buffer {
  const headlineLines = wrapText(headline, 28);
  const headlineY = HEIGHT / 2 - (headlineLines.length - 1) * 42;

  const headlineSvg = headlineLines
    .map((line, i) => `<text x="640" y="${headlineY + i * 84}" text-anchor="middle" font-family="monospace, 'Courier New'" font-size="72" font-weight="bold" fill="white">${escapeXml(line)}</text>`)
    .join("\n");

  return Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#0a0a0a"/>
    <rect width="${WIDTH}" height="4" fill="${ACCENT}"/>
    <text x="1200" y="80" text-anchor="middle" font-size="80" fill="white" opacity="0.3">&#9760;</text>
    ${headlineSvg}
    <text x="640" y="${headlineY + headlineLines.length * 84 + 20}" text-anchor="middle" font-family="monospace, 'Courier New'" font-size="28" fill="${ACCENT}">${escapeXml(subtitle)}</text>
    <text x="30" y="${HEIGHT - 20}" font-family="monospace, 'Courier New'" font-size="18" fill="#555555">AI DOOM SCROLL</text>
  </svg>`);
}

function svgVariantBOverlay(headline: string): Buffer {
  const headlineLines = wrapText(headline, 32);
  const stripTop = HEIGHT - 220;
  const textStartY = stripTop + 60;

  const headlineSvg = headlineLines
    .slice(0, 2)
    .map((line, i) => `<text x="40" y="${textStartY + i * 72}" font-family="Arial, Helvetica, sans-serif" font-size="64" font-weight="bold" fill="white">${escapeXml(line)}</text>`)
    .join("\n");

  return Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="rgba(0,0,0,0.35)"/>
    <rect y="${stripTop - 3}" width="${WIDTH}" height="3" fill="${ACCENT}"/>
    <rect y="${stripTop}" width="${WIDTH}" height="220" fill="rgba(0,0,0,0.85)"/>
    ${headlineSvg}
    <text x="30" y="30" font-family="Arial, Helvetica, sans-serif" font-size="18" fill="white" opacity="0.7">AI DOOM SCROLL</text>
  </svg>`);
}

function svgVariantCOverlay(headline: string): Buffer {
  const hook = extractHook(headline);
  const hookLines = wrapText(hook, 16);
  const hookY = HEIGHT / 2 - (hookLines.length - 1) * 60;

  const hookSvg = hookLines
    .map((line, i) => `<text x="640" y="${hookY + i * 120}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="110" font-weight="900" fill="white">${escapeXml(line)}</text>`)
    .join("\n");

  const fullTitleY = hookY + hookLines.length * 120 + 30;

  return Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="rgba(0,0,0,0.65)"/>
    <rect width="${WIDTH}" height="4" fill="${ACCENT}"/>
    ${hookSvg}
    <text x="640" y="${fullTitleY}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="32" fill="white" opacity="0.6">${escapeXml(headline)}</text>
  </svg>`);
}

/**
 * Generate 3 thumbnail variants from a frame image buffer.
 */
export async function generateThumbnailVariants(
  frameBuffer: Buffer,
  headline: string,
  subtitle: string,
): Promise<{ a: Buffer; b: Buffer; c: Buffer }> {
  // Variant A — Terminal (pure text, no frame)
  const a = await sharp(svgVariantA(headline, subtitle))
    .resize(WIDTH, HEIGHT)
    .jpeg({ quality: 90 })
    .toBuffer();

  // Variant B — Frame + strip
  const bOverlay = svgVariantBOverlay(headline);
  const b = await sharp(frameBuffer)
    .resize(WIDTH, HEIGHT, { fit: "cover" })
    .composite([{ input: bOverlay, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();

  // Variant C — Frame blurred + big text
  const cOverlay = svgVariantCOverlay(headline);
  const blurred = await sharp(frameBuffer)
    .resize(WIDTH, HEIGHT, { fit: "cover" })
    .blur(8)
    .toBuffer();
  const c = await sharp(blurred)
    .composite([{ input: cOverlay, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();

  return { a, b, c };
}
