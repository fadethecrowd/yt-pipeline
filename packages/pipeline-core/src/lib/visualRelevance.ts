/**
 * Scene-level semantic relevance for stock visuals.
 *
 * Retrieval alone is not enough: searching "single researcher silhouetted
 * against large monitors" returned "video of a woman singing", which the
 * technical checks (1080p, not black, not frozen) all passed. Relevance is
 * therefore scored explicitly against what the narration is actually about,
 * and unrelated subjects are rejected rather than accepted as the first
 * technically-valid candidate.
 *
 * The signal is the asset's own description. Pexels page URLs carry a
 * natural-language slug — /video/close-up-of-a-cpu-7140928/ — which is the
 * only human-written description the API exposes.
 */

export type Channel = "ai-doom-scroll" | "wet-circuit";

export interface RelevanceInput {
  channel: Channel;
  /** The narration this scene sits under. */
  narration: string;
  /** The search/generation prompt used to find the asset. */
  prompt: string;
  /** Human-readable description of the candidate asset. */
  description: string;
}

export type Verdict = "STRONG" | "ACCEPTABLE" | "GENERIC" | "REJECT";

export interface RelevanceResult {
  score: number;
  verdict: Verdict;
  reasons: string[];
  /** Coarse subject label, used to stop consecutive scenes repeating a concept. */
  concept: string;
}

// ── Vocabulary ────────────────────────────────────────────────────────────

/** Subjects that make a visual clearly on-topic for AI Doom Scroll. */
const AI_SUBJECTS: Record<string, string[]> = {
  compute: ["cpu", "gpu", "chip", "processor", "semiconductor", "motherboard",
            "circuit board", "silicon", "wafer", "microchip", "graphics card"],
  datacenter: ["data center", "data centre", "server", "server rack", "server room",
               "rack", "cooling", "datacenter", "mainframe", "supercomputer"],
  robotics: ["robot", "robotic", "humanoid", "robot arm", "android", "automation",
             "automated", "mechanical arm", "cobot", "drone"],
  factory: ["factory", "assembly line", "warehouse", "manufacturing", "industrial",
            "conveyor", "logistics", "production line"],
  vision: ["machine vision", "computer vision", "facial recognition", "face detection",
           "object detection", "lidar", "sensor", "camera array", "scanner"],
  research: ["laboratory", "lab", "researcher", "scientist", "engineer", "whiteboard",
             "research", "experiment"],
  software: ["code", "coding", "programming", "software", "screen", "monitor",
             "terminal", "developer", "dashboard", "interface", "algorithm", "data"],
  network: ["network", "neural network", "connection", "node", "graph", "cloud computing",
            "fiber optic", "cable", "infrastructure"],
  // Includes studio/microphone vocabulary because these ARE the right visuals
  // once the narration is genuinely about voice AI — the performance veto above
  // is what stops them being used for anything else.
  voiceai: ["waveform", "audio interface", "speech", "speaking", "voice", "vocal",
            "spectrogram", "sound wave", "audio editing", "synthesis",
            "microphone", "recording studio", "headphones", "audio mixer"],
  surveillance: ["surveillance", "cctv", "security camera", "monitoring", "tracking"],
  autonomy: ["autonomous", "self-driving", "self driving", "driverless", "navigation"],
  energy: ["power plant", "electricity", "energy", "grid", "transformer", "turbine",
           "cooling tower", "power consumption"],
};

/** Subjects that make a visual clearly on-topic for Wet Circuit. */
const MARINE_SUBJECTS: Record<string, string[]> = {
  vessel: ["boat", "yacht", "vessel", "hull", "kayak", "ship", "sailboat", "dinghy"],
  electronics: ["sonar", "radar", "chartplotter", "fishfinder", "transducer", "display",
                "instrument", "gauge", "screen", "antenna", "gps"],
  water: ["water", "ocean", "sea", "lake", "marina", "harbor", "harbour", "wake", "dock"],
  fishing: ["fishing", "angler", "rod", "reel", "catch", "trolling"],
  install: ["wiring", "cable", "battery", "installation", "workshop", "tools", "engine"],
};

/**
 * Generic technology filler. Usable sparingly as a transition, never as the
 * substance of a video.
 */
const GENERIC_TERMS = [
  "binary", "binary code", "digital space", "digital rain", "matrix",
  "abstract", "particles", "glowing", "bokeh", "futuristic", "hologram",
  "holographic", "neon", "cyber", "cyberspace", "technology background",
  "digital background", "motion background", "loop animation", "3d render",
  "light streaks", "data stream", "digital world", "blue technology",
];

/**
 * Human-performance subjects. These are the failure mode that produced the
 * singing footage: they read as "person + studio + technology" to a keyword
 * search but have nothing to do with the narration.
 */
const PERFORMANCE_TERMS = [
  "singing", "singer", "sings", "vocalist", "microphone", "mic ", "karaoke",
  "concert", "band", "guitar", "piano", "drummer", "drums", "musician",
  "music video", "recording studio", "podcast", "radio host", "dj",
  "dancing", "dancer", "model posing", "fashion", "performance", "stage",
];

/**
 * Narration topics that legitimately justify a microphone / studio / voice
 * performance visual. Matching the bare word "voice" is deliberately NOT
 * enough — "the voice of the industry" must not unlock singer footage.
 */
const VOICE_AI_TOPICS = [
  "voice ai", "voice clone", "voice cloning", "voice model", "speech synthesis",
  "synthetic speech", "synthetic voice", "text to speech", "text-to-speech",
  "tts", "audio generation", "music generation", "generative audio",
  "voice actor", "voice fraud", "voice scam", "deepfake audio", "audio deepfake",
  "podcast automation", "synthetic performer", "speech recognition",
  "voice assistant", "voice interface", "audio model",
];

// ── Helpers ───────────────────────────────────────────────────────────────

function norm(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ")} `;
}

function hits(haystack: string, terms: string[]): string[] {
  return terms.filter((t) => haystack.includes(` ${t}`) || haystack.includes(`${t} `));
}

/** Extract the human-written description from a Pexels page URL slug. */
export function describeFromPexelsUrl(pageUrl: string): string {
  const m = pageUrl.match(/\/video\/([a-z0-9-]+?)-(\d+)\/?$/i);
  if (!m) return "";
  return m[1].replace(/-/g, " ");
}

/** True when the narration is genuinely about voice/audio AI. */
export function narrationIsAboutVoiceAI(narration: string): boolean {
  const n = norm(narration);
  return VOICE_AI_TOPICS.some((t) => n.includes(t));
}

// ── Scoring ───────────────────────────────────────────────────────────────

export const REJECT_THRESHOLD = 0.25;

export function scoreRelevance(input: RelevanceInput): RelevanceResult {
  const desc = norm(input.description);
  const narration = norm(input.narration);
  const prompt = norm(input.prompt);
  const reasons: string[] = [];

  if (!input.description.trim()) {
    return {
      score: 0, verdict: "REJECT", concept: "unknown",
      reasons: ["asset has no description to judge relevance against"],
    };
  }

  // ── Hard veto: human performance without a voice-AI narration ────────
  const perf = hits(desc, PERFORMANCE_TERMS);
  if (perf.length > 0) {
    const justified = narrationIsAboutVoiceAI(input.narration);
    if (!justified) {
      return {
        score: 0,
        verdict: "REJECT",
        concept: "human-performance",
        reasons: [
          `asset depicts human performance (${perf.join(", ")}) but the narration is not about voice AI, speech synthesis or audio generation`,
        ],
      };
    }
    reasons.push(`performance imagery allowed — narration is about voice/audio AI`);
  }

  // ── Subject match ────────────────────────────────────────────────────
  const taxonomy = input.channel === "wet-circuit" ? MARINE_SUBJECTS : AI_SUBJECTS;
  let best = { concept: "none", n: 0 };
  let subjectHits = 0;
  for (const [concept, terms] of Object.entries(taxonomy)) {
    const n = hits(desc, terms).length;
    subjectHits += n;
    if (n > best.n) best = { concept, n };
  }
  if (subjectHits > 0) {
    reasons.push(`matches ${input.channel} subject "${best.concept}"`);
  }

  // ── Agreement with the narration and the prompt ───────────────────────
  const descWords = new Set(desc.split(" ").filter((w) => w.length > 3));
  const overlapWith = (text: string) =>
    [...descWords].filter((w) => text.includes(` ${w}`)).length;
  const narrationOverlap = overlapWith(narration);
  const promptOverlap = overlapWith(prompt);
  if (promptOverlap > 0) reasons.push(`${promptOverlap} term(s) shared with the scene prompt`);
  if (narrationOverlap > 0) reasons.push(`${narrationOverlap} term(s) shared with the narration`);

  // ── Generic filler ───────────────────────────────────────────────────
  const generic = hits(desc, GENERIC_TERMS);
  if (generic.length > 0) reasons.push(`generic imagery (${generic.join(", ")})`);

  // ── Composite score ──────────────────────────────────────────────────
  let score = 0;
  score += Math.min(subjectHits, 3) * 0.25;      // up to 0.75
  score += Math.min(promptOverlap, 3) * 0.08;     // up to 0.24
  score += Math.min(narrationOverlap, 3) * 0.05;  // up to 0.15
  // A justified performance visual is the correct choice for a voice-AI
  // segment, so it is credited rather than merely tolerated.
  if (perf.length > 0) score += 0.35;
  if (generic.length > 0) score -= 0.2 * Math.min(generic.length, 2);
  score = Math.max(0, Math.min(1, score));

  let verdict: Verdict;
  if (score >= 0.6) verdict = "STRONG";
  else if (generic.length > 0 && score < 0.6) verdict = "GENERIC";
  else if (score >= REJECT_THRESHOLD) verdict = "ACCEPTABLE";
  else verdict = "REJECT";

  if (verdict === "REJECT") {
    reasons.push(`relevance ${score.toFixed(2)} below ${REJECT_THRESHOLD} threshold`);
  }

  // Terms like "code" and "data" appear in genuinely generic stock footage
  // ("binary code flow in digital space"), so a generic hit dominates the
  // concept label unless the asset scored strongly on real subject matter.
  const concept = verdict === "GENERIC" ? "generic-abstract" : best.concept;

  return { score, verdict, reasons, concept };
}

// ── Per-video composition rules ───────────────────────────────────────────

/**
 * Enforces composition across a whole video: caps generic filler, blocks a
 * concept repeating in consecutive scenes, and requires a minimum number of
 * clearly on-topic visuals.
 */
export class VisualPlan {
  private used: { concept: string; verdict: Verdict }[] = [];

  constructor(
    private readonly maxGeneric = 1,
    private readonly minStrong = 2,
  ) {}

  get genericCount(): number {
    return this.used.filter((u) => u.concept === "generic-abstract").length;
  }

  get strongCount(): number {
    return this.used.filter((u) => u.verdict === "STRONG").length;
  }

  /** Whether this candidate may be used for the next scene. */
  admits(r: RelevanceResult): { ok: boolean; reason?: string } {
    if (r.verdict === "REJECT") {
      return { ok: false, reason: r.reasons.join("; ") };
    }
    if (r.concept === "generic-abstract" && this.genericCount >= this.maxGeneric) {
      return { ok: false, reason: `already used ${this.genericCount} generic asset(s); cap is ${this.maxGeneric}` };
    }
    const prev = this.used[this.used.length - 1];
    if (prev && prev.concept === r.concept && r.concept !== "none") {
      return { ok: false, reason: `concept "${r.concept}" would repeat in consecutive scenes` };
    }
    return { ok: true };
  }

  claim(r: RelevanceResult): void {
    this.used.push({ concept: r.concept, verdict: r.verdict });
  }

  /** Composition check for the finished video. */
  summary(): { genericCount: number; strongCount: number; meetsMinimum: boolean; concepts: string[] } {
    return {
      genericCount: this.genericCount,
      strongCount: this.strongCount,
      meetsMinimum: this.strongCount >= this.minStrong,
      concepts: this.used.map((u) => u.concept),
    };
  }
}
