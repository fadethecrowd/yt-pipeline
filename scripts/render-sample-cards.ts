/**
 * Render one still of every card type the pipeline can put on screen.
 *
 *   npx tsx scripts/render-sample-cards.ts [--out tmp/cards]
 *
 * Cards are the fallback whenever footage cannot be found, and the outro
 * treatment now routes beats to one deliberately — so they need to be looked at
 * before more work is pointed their way.
 *
 * The SVG here mirrors `renderTextStillClip` in assemblyShared.ts, which is the
 * no-drawtext path that ffmpeg builds without libfreetype take. The drawtext
 * path produces the same colours, sizes and layout by a different mechanism.
 * Read-only: writes PNGs to the output directory and touches nothing else.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { wrapCardText } from "@yt-pipeline/pipeline-core";

const WIDTH = 1920;
const HEIGHT = 1080;

const CARDS = [
  {
    name: "title-card",
    note: "shown for 4s before narration; from finishAssembly()",
    text: "AI Credits Are Being Resold for Profit",
    background: "#1a1a2e", fontSize: 54, lineSpacing: 10, offsetY: 0, badge: undefined,
  },
  {
    name: "branded-fallback-card",
    note: "no unused relevant clip for this fragment; from renderBeat()",
    text: "What Are Token Brokers?",
    background: "#243257", fontSize: 64, lineSpacing: 14, offsetY: -40, badge: "AI DOOM SCROLL",
  },
  {
    name: "outro-card",
    note: "fixed treatment for a CTA beat; from renderOutroBeat()",
    text: "Like & Subscribe",
    background: "#243257", fontSize: 64, lineSpacing: 14, offsetY: -40, badge: "AI DOOM SCROLL",
  },
  {
    name: "approved-card",
    note: "card a human approved in an allocation; from renderApprovedBeat()",
    text: "The Markup Game and Margin Structure",
    background: "#243257", fontSize: 64, lineSpacing: 14, offsetY: -40, badge: "AI DOOM SCROLL",
  },
  {
    name: "outro-card-wet-circuit",
    note: "the same outro treatment on the other channel",
    text: "Thanks for watching",
    background: "#243257", fontSize: 64, lineSpacing: 14, offsetY: -40, badge: "WET CIRCUIT",
  },
];

function svgFor(c: typeof CARDS[number]): string {
  const lines = wrapCardText(c.text).split("\n");
  const lineH = c.fontSize + c.lineSpacing;
  const top = HEIGHT / 2 + c.offsetY - ((lines.length - 1) * lineH) / 2;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">`
    + `<rect width="100%" height="100%" fill="${c.background}"/>`
    + lines.map((l, i) =>
        `<text x="${WIDTH / 2}" y="${top + i * lineH}" text-anchor="middle" dominant-baseline="middle" `
        + `font-family="Helvetica,Arial,sans-serif" font-size="${c.fontSize}" fill="#ffffff">${esc(l)}</text>`).join("")
    + (c.badge
        ? `<text x="${WIDTH / 2}" y="${HEIGHT - 140}" text-anchor="middle" dominant-baseline="middle" `
          + `font-family="Helvetica,Arial,sans-serif" font-size="30" fill="#8899ff">${esc(c.badge)}</text>`
        : "")
    + `</svg>`;
}

async function main(): Promise<void> {
  const i = process.argv.indexOf("--out");
  const outDir = resolve(i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : "tmp/cards");
  mkdirSync(outDir, { recursive: true });
  for (const c of CARDS) {
    const p = `${outDir}/${c.name}.png`;
    await sharp(Buffer.from(svgFor(c))).png().toFile(p);
    console.log(`  ${c.name.padEnd(26)} ${c.background}  ${c.note}`);
    console.log(`  ${" ".repeat(26)} -> ${p}`);
  }
  console.log(`\n${CARDS.length} card type(s) rendered to ${outDir}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
