import sharp from "sharp";
import { env } from "../config";

// ── Types ────────────────────────────────────────────────────────────────

export type ChannelKey = "ai-doom-scroll" | "wet-circuit";

export interface SubjectLayerResult {
  buffer: Buffer;
  query: string;
}

// ── Query mappings ──────────────────────────────────────────────────────
// Each category has a ranked list of Pexels search queries. pickQuery()
// scans the topic text for category keywords, falls back to "default".

const WC_QUERIES: Record<string, string[]> = {
  transducer_install: [
    "fishfinder mounted bow kayak fishing",
    "boat electronics install marine",
    "garmin striker mounted hull",
    "transducer cable boat wiring",
    "fish finder screen boat dashboard",
    "marine electronics boat install",
  ],
  capacity: [
    "small fishing boat low waterline",
    "jon boat loaded gear fishing",
    "overloaded aluminum boat water",
    "pond prowler small boat fishing",
    "boat weight limit waterline",
    "fisherman small aluminum boat lake",
  ],
  battery: [
    "marine battery boat engine",
    "boat electrical system battery",
    "lithium battery marine install",
    "corroded marine battery terminal",
    "boat battery wiring closeup",
    "agm battery boat storage",
  ],
  wiring: [
    "boat electrical wiring panel",
    "marine fuse box wiring",
    "boat engine wiring harness",
    "marine electrical panel closeup",
    "boat wiring install dashboard",
    "waterproof marine connector wiring",
  ],
  sinking: [
    "small boat sinking water dramatic",
    "overloaded boat low waterline",
    "flooded boat taking water",
    "capsized small boat lake",
    "boat swamped water flooding",
    "jon boat water over gunwale",
  ],
  bilge: [
    "flooded boat bilge pump",
    "water inside boat hull",
    "boat bilge water pooling",
    "marine bilge pump install",
    "boat hull water damage",
    "standing water aluminum boat floor",
  ],
  sonar: [
    "fishfinder screen fish underwater",
    "garmin chartplotter boat dashboard",
    "humminbird fish finder display",
    "marine electronics screen boat",
    "sonar fish underwater view",
    "boat gps chartplotter navigation",
  ],
  motor: [
    "trolling motor boat bow fishing",
    "minn kota trolling motor deployed",
    "outboard motor jon boat lake",
    "electric trolling motor fishing",
    "outboard engine boat water",
    "fisherman trolling motor lake action",
  ],
  corrosion: [
    "corroded metal bolt marine closeup",
    "saltwater corrosion boat hardware",
    "rusted marine fitting closeup",
    "electrolysis boat hull damage",
    "corroded outboard motor salt",
    "marine stainless steel corrosion",
  ],
  gear: [
    "fishing gear organized boat storage",
    "tackle box fishing equipment boat",
    "rod holder boat rail fishing",
    "fish finder mount ram ball",
    "boat dry bag gear storage",
    "fishing rod boat rack organized",
  ],
  default: [
    "fishing boat lake sunrise action",
    "bass boat fishing tournament",
    "boat dock marina lifestyle",
    "fisherman casting lake boat",
    "marine electronics boat cockpit",
    "open water fishing boat action",
  ],
};

const WC_KEYWORD_MAP: Array<[string[], string]> = [
  // transducer_install MUST be first — catches install/mount topics before
  // the broader "sonar" category claims them via "transducer"/"fishfinder".
  [["transducer", "mount", "mounting", "hull", "scupper", "fishfinder install", "garmin striker", "lowrance", "hobie outback", "humminbird", "garmin", "striker", "livescope", "helix", "panoptix"], "transducer_install"],
  // capacity/overload MUST come before battery. Small-boat weight topics
  // (e.g. "10 ft pond prowler max weight") were previously matching broad
  // battery keywords like "amp"/"charge" and shipping battery imagery.
  [["pond prowler", "max weight", "weight capacity", "weight limit", "capacity", "overload", "overloaded", "10 foot boat", "10 ft boat", "tiny boat", "small boat", "weight", "jon boat", "aluminum boat", "jon", "skeeter", "pelican", "old town", "pdl"], "capacity"],
  // Battery keywords are intentionally narrow — only battery-explicit terms.
  // Dropped "amp" (matches "camp", "example"), "charge" (matches "in charge")
  // to prevent general boat topics falling into battery visuals.
  [["battery", "lithium", "agm", "lead acid", "voltage", "ionic", "power"], "battery"],
  [["wire", "wiring", "fuse", "circuit", "ground", "short"], "wiring"],
  [["sink", "capsize", "swamp", "flood"], "sinking"],
  [["bilge", "pump", "water ingress", "leak"], "bilge"],
  [["sonar", "livescope", "chartplotter", "screen", "humminbird", "helix", "garmin", "panoptix", "mega imaging"], "sonar"],
  [["motor", "trolling", "outboard", "minn kota", "prop", "autopilot", "pdl pro", "terrova", "riptide", "edge", "electric motor"], "motor"],
  [["corrode", "corrosion", "rust", "electrolysis", "galvanic"], "corrosion"],
  [["gear", "storage", "organize", "mount", "ram", "system", "tackle", "rod holder", "dry bag", "crate"], "gear"],
];

const AIDOOM_QUERIES: Record<string, string[]> = {
  robot:       ["humanoid robot face dramatic dark", "android robot closeup"],
  surveillance:["surveillance camera eye digital", "digital eye watching screen"],
  brain:       ["artificial intelligence brain glow", "neural network visualization dark"],
  terminal:    ["computer terminal code dark screen", "hacker screen green code"],
  network:     ["data center server racks dark", "network cables server room"],
  phone:       ["smartphone notification screen dark", "phone algorithm feed dark"],
  document:    ["document scanning OCR screen", "text recognition multilingual display"],
  benchmark:   ["data chart analysis screen dark", "performance benchmark graph display"],
  default:     ["artificial intelligence futuristic dark", "robot technology dramatic"],
};

const AIDOOM_KEYWORD_MAP: Array<[string[], string]> = [
  [["robot", "humanoid", "gr00t", "embodied", "physical ai"], "robot"],
  [["watch", "surveillance", "tracking", "spy", "monitor", "privacy"], "surveillance"],
  [["brain", "neural", "thinking", "reasoning", "cognition"], "brain"],
  [["terminal", "code", "coding", "codex", "sdk", "developer"], "terminal"],
  [["network", "infrastructure", "server", "data center", "cloud"], "network"],
  [["phone", "app", "feed", "recommendation", "notification"], "phone"],
  [["ocr", "document", "text recognition", "language", "translation", "multilingual", "synthetic data"], "document"],
  [["benchmark", "evaluation", "dataset", "leaderboard", "score", "eval"], "benchmark"],
];

// ── Query selection ─────────────────────────────────────────────────────

function pickCategory(
  text: string,
  keywordMap: Array<[string[], string]>,
): string {
  const lower = text.toLowerCase();
  for (const [keywords, category] of keywordMap) {
    if (keywords.some((kw) => lower.includes(kw))) return category;
  }
  return "default";
}

function pickQuery(
  topic: { title: string; summary?: string | null },
  channel: ChannelKey,
): string {
  const text = `${topic.title} ${topic.summary ?? ""}`;
  const map = channel === "wet-circuit" ? WC_KEYWORD_MAP : AIDOOM_KEYWORD_MAP;
  const queries = channel === "wet-circuit" ? WC_QUERIES : AIDOOM_QUERIES;

  // WC deterministic override: Pond Prowler is a specific small-hull line
  // and always refers to capacity/overload topics — never batteries. Pin
  // it here so ordering changes in WC_KEYWORD_MAP can't regress this case.
  const category =
    channel === "wet-circuit" && text.toLowerCase().includes("pond prowler")
      ? "capacity"
      : pickCategory(text, map);

  const candidates = queries[category] ?? queries.default;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ── Pexels fetch ────────────────────────────────────────────────────────

async function fetchFromPexels(
  query: string,
  apiKey: string,
): Promise<Buffer | null> {
  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=15&orientation=landscape`;
    const res = await fetch(url, {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.warn(`[subjectLayer] Pexels API ${res.status} for "${query}"`);
      return null;
    }
    const data = (await res.json()) as {
      photos?: Array<{ src?: { landscape?: string; large?: string } }>;
    };
    const photos = data.photos ?? [];
    const pick = photos[Math.floor(Math.random() * photos.length)];
    const photoUrl = pick?.src?.landscape ?? pick?.src?.large;
    if (!photoUrl) {
      console.warn(`[subjectLayer] No Pexels results for "${query}"`);
      return null;
    }
    const imgRes = await fetch(photoUrl, { signal: AbortSignal.timeout(10000) });
    if (!imgRes.ok) return null;
    return Buffer.from(await imgRes.arrayBuffer());
  } catch (err) {
    console.warn(
      `[subjectLayer] Pexels fetch failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

// ── Image treatment ─────────────────────────────────────────────────────

/**
 * Subtle rim-light glow for AI Doom subjects only.
 * Renders a thin cyan-green border stroke, blurs it, and composites
 * with "screen" blend so it brightens the edges without affecting the
 * interior or text readability. WC subjects do NOT get this.
 */
async function addRimLight(
  buffer: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const rimSvg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="3" y="3" width="${width - 6}" height="${height - 6}" ` +
      `fill="none" stroke="rgba(0,255,200,0.15)" stroke-width="6"/>` +
      `</svg>`,
  );
  const glow = await sharp(rimSvg).blur(6).ensureAlpha().png().toBuffer();
  return sharp(buffer)
    .composite([{ input: glow, blend: "screen" as const }])
    .toBuffer();
}

async function treatImage(
  buffer: Buffer,
  channel: ChannelKey,
  width: number,
  height: number,
): Promise<Buffer> {
  // Resize to fill frame, crop center
  let img = sharp(buffer).resize(width, height, { fit: "cover", position: "centre" });

  // Darken so text remains readable. 0.47 ≈ 45-50% perceived brightness —
  // bright enough to preserve hardware detail (WC) and face structure
  // (AI Doom), dark enough for white/cyan text to remain legible.
  // Previous value: 0.35 (too muddy on WC marine-hardware subjects).
  img = img.modulate({ brightness: channel === "ai-doom-scroll" ? 0.65 : 0.47 });

  // Channel-specific color tint via an overlay
  const tintColor =
    channel === "wet-circuit"
      ? { r: 10, g: 22, b: 40, alpha: 0.45 }   // navy tint
      : { r: 0, g: 15, b: 5, alpha: 0.22 };     // dark green tint

  const tintOverlay = await sharp({
    create: { width, height, channels: 4, background: tintColor },
  })
    .png()
    .toBuffer();

  let treated = await sharp(await img.toBuffer())
    .composite([{ input: tintOverlay, blend: "over" }])
    .toBuffer();

  // AI Doom only: subtle cyan-green rim-light for edge separation.
  if (channel === "ai-doom-scroll") {
    treated = await addRimLight(treated, width, height);
  }

  return treated;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Fetch a dramatic stock-photo subject layer for a thumbnail.
 *
 * Returns a treated image buffer sized to (width × height), darkened and
 * tinted for the channel palette. Designed to be composited UNDER the
 * text SVG overlay.
 *
 * Returns null on any failure (network, no results, timeout). Callers
 * should fall back to rendering without a subject — the thumbnail is
 * still valid without one.
 */
export async function createSubjectLayer(
  topic: { title: string; summary?: string | null },
  channel: ChannelKey,
  width: number = 1280,
  height: number = 720,
): Promise<SubjectLayerResult | null> {
  const config = env();
  const query = pickQuery(topic, channel);
  console.log(`[subjectLayer] query="${query}" channel=${channel}`);

  const raw = await fetchFromPexels(query, config.PEXELS_API_KEY);
  if (!raw) return null;

  const treated = await treatImage(raw, channel, width, height);
  console.log(`[subjectLayer] subject ready (${treated.length} bytes)`);
  return { buffer: treated, query };
}
