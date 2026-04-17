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
  transducer_install: ["fishfinder transducer mount closeup kayak hull"],
  battery:  ["corroded marine battery closeup", "damaged boat battery corrosion"],
  wiring:   ["marine electrical wiring damage", "boat electrical fire sparks"],
  sinking:  ["small boat sinking water dramatic", "overloaded boat low waterline"],
  bilge:    ["flooded boat bilge pump", "water inside boat hull"],
  sonar:    ["fishfinder sonar screen underwater", "boat electronics screen display"],
  motor:    ["outboard motor boat closeup", "trolling motor underwater"],
  corrosion:["metal corrosion saltwater closeup", "corroded marine hardware bolt"],
  default:  ["dramatic boat ocean storm", "marine electronics boat dashboard"],
};

const WC_KEYWORD_MAP: Array<[string[], string]> = [
  // transducer_install MUST be first — catches install/mount topics before
  // the broader "sonar" category claims them via "transducer"/"fishfinder".
  [["transducer", "mount", "mounting", "hull", "scupper", "fishfinder install", "garmin striker", "lowrance", "hobie outback"], "transducer_install"],
  [["battery", "lithium", "agm", "charge", "voltage", "amp"], "battery"],
  [["wire", "wiring", "fuse", "circuit", "ground", "short"], "wiring"],
  [["sink", "overload", "capsize", "swamp", "flood"], "sinking"],
  [["bilge", "pump", "water ingress", "leak"], "bilge"],
  [["sonar", "livescope", "chartplotter", "screen"], "sonar"],
  [["motor", "trolling", "outboard", "minn kota", "prop"], "motor"],
  [["corrode", "corrosion", "rust", "electrolysis", "galvanic"], "corrosion"],
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
  const category = pickCategory(text, map);
  const candidates = queries[category] ?? queries.default;
  return candidates[0];
}

// ── Pexels fetch ────────────────────────────────────────────────────────

async function fetchFromPexels(
  query: string,
  apiKey: string,
): Promise<Buffer | null> {
  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
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
    const photoUrl = data.photos?.[0]?.src?.landscape ?? data.photos?.[0]?.src?.large;
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
  img = img.modulate({ brightness: 0.47 });

  // Channel-specific color tint via an overlay
  const tintColor =
    channel === "wet-circuit"
      ? { r: 10, g: 22, b: 40, alpha: 0.45 }   // navy tint
      : { r: 0, g: 15, b: 5, alpha: 0.4 };      // dark green tint

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
