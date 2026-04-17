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
  [["battery", "lithium", "agm", "charge", "voltage", "amp"], "battery"],
  [["wire", "wiring", "fuse", "circuit", "ground", "short"], "wiring"],
  [["sink", "overload", "capsize", "swamp", "flood"], "sinking"],
  [["bilge", "pump", "water ingress", "leak"], "bilge"],
  [["sonar", "fishfinder", "livescope", "transducer", "chartplotter", "screen"], "sonar"],
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
  default:     ["artificial intelligence futuristic dark", "robot technology dramatic"],
};

const AIDOOM_KEYWORD_MAP: Array<[string[], string]> = [
  [["robot", "humanoid", "gr00t", "embodied", "physical ai"], "robot"],
  [["watch", "surveillance", "tracking", "spy", "monitor", "privacy"], "surveillance"],
  [["brain", "neural", "thinking", "reasoning", "cognition"], "brain"],
  [["terminal", "code", "coding", "codex", "sdk", "developer"], "terminal"],
  [["network", "infrastructure", "server", "data center", "cloud"], "network"],
  [["phone", "app", "feed", "recommendation", "notification"], "phone"],
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

async function treatImage(
  buffer: Buffer,
  channel: ChannelKey,
  width: number,
  height: number,
): Promise<Buffer> {
  // Resize to fill frame, crop center
  let img = sharp(buffer).resize(width, height, { fit: "cover", position: "centre" });

  // Darken substantially so text remains readable
  img = img.modulate({ brightness: 0.35 });

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

  return sharp(await img.toBuffer())
    .composite([{ input: tintOverlay, blend: "over" }])
    .toBuffer();
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
