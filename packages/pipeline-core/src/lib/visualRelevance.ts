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
export const AI_SUBJECTS: Record<string, string[]> = {
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
  // Phrases, not bare tokens, so a control room reads as monitoring rather
  // than as "a room with screens in it".
  surveillance: ["surveillance", "cctv", "security camera", "monitoring", "tracking",
                 "control room", "security control room", "video monitoring",
                 "traffic monitoring", "surveillance monitor", "video wall",
                 "security operations center", "security operations centre",
                 "monitoring station", "security footage", "camera feed",
                 "closed circuit"],
  autonomy: ["autonomous", "self-driving", "self driving", "driverless", "navigation"],
  energy: ["power plant", "electricity", "energy", "grid", "transformer", "turbine",
           "cooling tower", "power consumption"],
};

/** Subjects that make a visual clearly on-topic for Wet Circuit. */
/**
 * Exported read-only so a diagnostic caller can re-run `classifyConcept`
 * against the SAME taxonomy the gate used, and so distinguish a genuine
 * no-term-match from an `ambiguous` tie that `scoreRelevance` remaps to
 * "none". Nothing here reads it back; exporting a const changes no behaviour
 * and no call site.
 */
export const MARINE_SUBJECTS: Record<string, string[]> = {
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

/**
 * Light plural folding so "screens" matches "screen" and "cameras" matches
 * "camera", without the prefix collisions raw substring matching produced.
 */
function singular(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function tokenize(s: string): string[] {
  return norm(s).trim().split(/[\s-]+/).filter(Boolean).map(singular);
}

/** Does `term` appear in `hay` as a whole token or contiguous token phrase? */
function matchesTerm(hay: string[], term: string): boolean {
  const t = term.trim().toLowerCase().split(/[\s-]+/).filter(Boolean).map(singular);
  if (t.length === 0) return false;
  outer: for (let i = 0; i + t.length <= hay.length; i++) {
    for (let j = 0; j < t.length; j++) if (hay[i + j] !== t[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Terms matched in `haystack`, by whole token or phrase.
 *
 * Previously this was raw substring matching against a space-padded string,
 * so a leading-space test succeeded on any prefix: "monitoring" matched the
 * software term "monitor" and "screens" matched "screen". Every control-room
 * and video-monitoring asset was therefore scored as generic software, and
 * because ties fell to whichever concept was declared first — software sits
 * above surveillance in AI_SUBJECTS — surveillance could never win. On the
 * ai1r plan that misfiled 42s of control-room footage and pushed the software
 * share from 39% to 51%, failing a gate the plan should have failed on its
 * own merits rather than on a measurement error.
 */
function hits(haystack: string, terms: string[]): string[] {
  const hay = tokenize(haystack);
  return terms.filter((t) => matchesTerm(hay, t));
}

/**
 * Attributive modifiers that describe manner or a component rather than the
 * subject itself, and that recur across concepts: "automated" appears in
 * robotics but describes half of all factory footage; "rack" means a server
 * rack in a data centre and a test-tube rack in a laboratory. Scored at half
 * weight so a genuine subject noun wins without needing a special case.
 */
const WEAK_TERMS = new Set([
  "automated", "automation", "industrial", "data", "screen", "monitor",
  "rack", "interface", "dashboard", "sensor", "cable", "tracking", "scanner",
]);

/** Token count of a term — multiword phrases are more specific evidence. */
function termSpecificity(term: string): number {
  return term.trim().split(/[\s-]+/).filter(Boolean).length;
}

/** Weighted evidence: a 2-word phrase outranks any number of single tokens. */
function termWeight(term: string): number {
  const n = termSpecificity(term);
  if (n >= 3) return 6;
  if (n === 2) return 3;
  return WEAK_TERMS.has(term.trim().toLowerCase()) ? 0.5 : 1;
}

export interface ConceptMatch {
  concept: string;
  score: number;
  /** Terms matched by the winning concept. */
  matched: string[];
  /** Terms matched across ALL concepts — feeds the relevance score. */
  totalMatched: number;
}

/**
 * Pick the concept with the strongest evidence.
 *
 * Ordering is explicit rather than incidental: total weighted score, then the
 * longest single phrase matched, then concept name. A genuine tie on both
 * score and specificity resolves to "ambiguous" instead of silently taking
 * whichever key happens to be declared first.
 */
export function classifyConcept(
  text: string,
  taxonomy: Record<string, string[]>,
): ConceptMatch {
  const hay = tokenize(text);
  const scored = Object.entries(taxonomy)
    .map(([concept, terms]) => {
      const matched = terms.filter((t) => matchesTerm(hay, t));
      return {
        concept,
        score: matched.reduce((a, t) => a + termWeight(t), 0),
        longest: matched.reduce((a, t) => Math.max(a, termSpecificity(t)), 0),
        matched,
      };
    })
    .filter((c) => c.score > 0);

  const totalMatched = scored.reduce((a, c) => a + c.matched.length, 0);
  if (scored.length === 0) return { concept: "none", score: 0, matched: [], totalMatched: 0 };
  scored.sort(
    (a, b) => b.score - a.score || b.longest - a.longest || a.concept.localeCompare(b.concept),
  );
  const top = scored[0]!;
  const next = scored[1];
  if (next && next.score === top.score && next.longest === top.longest) {
    return { concept: "ambiguous", score: top.score, matched: top.matched, totalMatched };
  }
  return { concept: top.concept, score: top.score, matched: top.matched, totalMatched };
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
  const match = classifyConcept(desc, taxonomy);
  const best = { concept: match.concept === "ambiguous" ? "none" : match.concept, n: match.score };
  const subjectHits = match.totalMatched;
  const subjectEvidence = match.score;
  if (subjectHits > 0) {
    reasons.push(
      `matches ${input.channel} subject "${match.concept}" (${match.matched.join(", ")})`,
    );
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
  // Strength of on-topic subject evidence, capped at 0.75 as before.
  //
  // This reads the WEIGHTED score of the identified subject rather than a raw
  // count of term hits across every concept. The old count double-counted
  // substrings — "microchip" scored both "microchip" and "chip" — so removing
  // that overlap would otherwise have deflated every on-topic asset by up to
  // 0.25 and pushed genuinely relevant footage below REJECT_THRESHOLD. Phrase
  // matches now weigh more than bare tokens, which is what "strong evidence
  // for one subject" should mean. The cap and REJECT_THRESHOLD are unchanged.
  score += Math.min(subjectEvidence, 3) * 0.25; // up to 0.75
  score += Math.min(promptOverlap, 3) * 0.08;     // up to 0.24
  score += Math.min(narrationOverlap, 3) * 0.05;  // up to 0.15
  // A justified performance visual is the correct choice for a voice-AI
  // segment, so it is credited rather than merely tolerated.
  if (perf.length > 0) score += 0.35;
  if (generic.length > 0) score -= 0.2 * Math.min(generic.length, 2);
  score = Math.max(0, Math.min(1, score));

  // The hard relevance threshold is applied FIRST, before any generic
  // classification. Previously the GENERIC branch was evaluated first, so
  // "glowing electric sphere with energy pulses" scored 0.10 — far below the
  // threshold — yet was labelled GENERIC rather than REJECT. GENERIC is
  // admissible, so it took the single generic-asset slot and then blocked
  // "futuristic circuit board with glowing microchip" (STRONG 0.66) from a
  // later scene. Sub-threshold assets can no longer consume the allowance.
  let verdict: Verdict;
  if (score < REJECT_THRESHOLD) {
    verdict = "REJECT";
    reasons.push(`relevance ${score.toFixed(2)} below ${REJECT_THRESHOLD} threshold`);
  } else if (score >= 0.6) {
    verdict = "STRONG";
  } else if (generic.length > 0) {
    verdict = "GENERIC";
  } else {
    verdict = "ACCEPTABLE";
  }

  // Terms like "code" and "data" appear in genuinely generic stock footage
  // ("binary code flow in digital space"), so a generic hit dominates the
  // concept label unless the asset scored strongly on real subject matter.
  const concept = verdict === "GENERIC" ? "generic-abstract" : best.concept;

  return { score, verdict, reasons, concept };
}

// ── Search-query construction ─────────────────────────────────────────────

/**
 * Words that describe how a shot looks rather than what it contains. Useful in
 * a generation prompt, actively harmful in a stock-library keyword search.
 */
/**
 * Relative pronouns and connectives. They survived the style filter and ate
 * query slots — "wide warehouse interior where" spent a quarter of its budget
 * on a pronoun.
 */
const CONNECTIVES = new Set([
  "where", "which", "that", "who", "whose", "when", "into", "onto", "from",
  "over", "under", "through", "between", "across", "along", "around", "above",
  "below", "beneath", "behind", "before", "after", "during", "without", "within",
  "part", "hard", "left", "changes", "stopping", "everything", "carrying",
  "what", "for", "are", "was", "were", "has", "have", "had", "its", "not",
  "but", "how", "why", "who", "all", "any", "one", "two", "own", "out", "off",
]);

/**
 * Words that name what a shot is OF. A query missing its subject is not a
 * weaker query, it is a query for something else — so these are lifted out of
 * the prompt wherever they appear rather than being left to word order.
 */
const SUBJECT_ANCHORS = new Set([
  "robot", "robots", "robotic", "amr", "amrs", "agv", "drone", "drones",
  "forklift", "conveyor", "pallet", "shelving", "shelves", "rack", "racks",
  "tote", "totes", "warehouse", "fulfilment", "fulfillment", "packing",
  "picking", "inventory", "camera", "cameras", "cctv", "surveillance",
  "checkout", "supermarket", "aisle", "server", "servers", "datacenter",
  "rig", "turbine", "vehicle", "vehicles", "car", "truck", "train", "worker",
  "workers", "operator", "operators", "engineer", "technician", "scanner",
  "sensor", "lidar", "gantry", "crane", "machine", "machinery", "assembly",
  "factory", "laboratory", "microchip", "wafer", "semiconductor",
]);

const STYLE_WORDS = new Set([
  "footage", "shot", "shots", "close", "closeup", "close-up", "cinematic",
  "documentary", "framing", "angle", "lighting", "realistic", "daylight",
  "slow", "fast", "motion", "camera", "push", "pan", "aerial", "visible",
  "modern", "high", "density", "detail", "while", "with", "and", "the", "a",
  "an", "of", "in", "on", "at", "to", "inside", "beside", "their", "its",
  "no", "text", "showing", "clearly", "rather", "than", "quiet", "still",
]);

/**
 * Motion-graphics vocabulary. A scriptwriter uses these to describe an
 * animation they picture; a stock-footage search treats them as the subject
 * and returns design templates or nothing relevant at all.
 */
const GRAPHIC_WORDS = new Set([
  "animated", "animation", "diagram", "infographic", "graphic", "graphics",
  "chart", "bar", "pie", "graph", "timeline", "overlay", "split-screen",
  "splitscreen", "split", "screen-recording", "screenrecording", "label",
  "labels", "callout", "callouts", "title", "card", "render", "3d",
  "cross-section", "crosssection", "map", "logos", "logo", "percentages",
  "text", "showing", "shows", "cut", "then", "side", "left", "right",
]);

/** Canonical stock-library queries for each subject concept. */
const CONCEPT_QUERIES: Record<string, string> = {
  compute: "computer chip processor macro",
  datacenter: "data center server room",
  robotics: "industrial robot arm",
  factory: "automated factory assembly line",
  vision: "computer vision camera sensor",
  research: "engineer laboratory computer",
  software: "programmer code screen",
  network: "network server cables",
  voiceai: "audio waveform studio monitor",
  surveillance: "security camera surveillance",
  autonomy: "autonomous vehicle sensor",
  energy: "power plant electricity substation",
  vessel: "boat on water",
  electronics: "marine electronics display",
  water: "ocean water boat",
  fishing: "fishing boat angler",
  install: "boat wiring installation",
};

/**
 * Turn a descriptive scene prompt into short keyword queries a stock library
 * can actually match.
 *
 * A 20-word cinematic prompt is precise for a human and useless for Pexels,
 * whose search is keyword-based — "close-up footage of high-density GPU server
 * racks operating inside a modern data centre, cooling systems and status
 * lights visible, cinematic documentary framing" returned a motion-blurred
 * conveyor belt. Queries are ordered most-specific first.
 */
export function buildSearchQueries(
  prompt: string,
  title: string,
  channel: Channel,
): string[] {
  const queries: string[] = [];

  // Scriptwriters describe motion graphics they imagine ("Animated diagram
  // showing…", "Split-screen graphic:", "Infographic showing three logos",
  // "Bar chart showing…"). Searching a stock library for those returns design
  // templates and, worse, unrelated footage — this is how a drum player and a
  // cultural parade became candidates for a memory-shortage video. Prefer the
  // filmable B-roll the prompt names, and drop the graphic-design framing.
  const broll = [...prompt.matchAll(/b-?roll of ([^.;]+)/gi)].map((m) => m[1]);
  for (const b of broll) {
    const cleaned = b
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STYLE_WORDS.has(w) && !GRAPHIC_WORDS.has(w));
    if (cleaned.length) queries.push(cleaned.slice(0, 4).join(" "));
  }

  // Strip any "Text overlay: '…'" instruction — the renderer burns no such text.
  const withoutOverlay = prompt.replace(/text overlay:\s*'[^']*'/gi, " ");

  const content = withoutOverlay
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STYLE_WORDS.has(w) && !GRAPHIC_WORDS.has(w)
      && !CONNECTIVES.has(w));

  // Subject-anchored, not leading-word.
  //
  // This took the first four surviving words of the prompt. For "Wide shot of a
  // warehouse interior where autonomous mobile robots are lifting and
  // transporting shelves" that produced "wide warehouse interior where": the
  // subject — robots — sits past the truncation point and never reached the
  // search. Nineteen warehouse-robot beats were acquired without the word
  // "robot" appearing in a single query.
  //
  // Anchor terms are taken from anywhere in the prompt, so a subject named late
  // in a sentence still drives the search.
  const anchors = content.filter((w) => SUBJECT_ANCHORS.has(w));
  const rest = content.filter((w) => !anchors.includes(w));
  if (anchors.length) {
    // Subject first, then the nearest concrete context words.
    queries.push([...new Set([...anchors.slice(0, 2), ...rest.slice(0, 3)])].join(" "));
    for (const a of anchors.slice(0, 2)) {
      if (rest.length) queries.push([a, ...rest.slice(0, 2)].join(" "));
    }
  }
  if (content.length) queries.push(content.slice(0, 4).join(" "));
  if (content.length > 2) queries.push(content.slice(0, 2).join(" "));

  // Canonical query for the concept the prompt is closest to.
  //
  // Only when the classification is actually supported by the prompt. A
  // warehouse fleet-software beat mentioning a "control room" classified as
  // surveillance and pulled in "security camera surveillance", which is how
  // traffic-control and CCTV footage entered a warehouse-robot video. An
  // ambiguous classification injects nothing: a canonical query for a concept
  // the prompt does not clearly belong to is cross-domain contamination.
  const taxonomy = channel === "wet-circuit" ? MARINE_SUBJECTS : AI_SUBJECTS;
  const best = classifyConcept(prompt, taxonomy);
  if (best.concept && best.concept !== "ambiguous" && best.concept !== "none"
      && best.score >= 3 && CONCEPT_QUERIES[best.concept]) {
    // ...and only when the canonical query actually shares vocabulary with this
    // prompt. "warehouse control room where operators monitor screens"
    // classifies as surveillance on the phrase "control room", but the
    // canonical "security camera surveillance" shares nothing with it and is
    // how CCTV footage reached a warehouse-robot beat.
    const canon = CONCEPT_QUERIES[best.concept]!.split(" ");
    if (canon.some((w) => content.includes(w))) queries.push(CONCEPT_QUERIES[best.concept]!);
  }

  // The segment title is prose, not a subject. "The fleet software is the hard
  // part" and "From painted lines to onboard sensing" were searched verbatim,
  // and a stock library answers an abstract phrase with whatever it likes —
  // motorcycles, breweries, harbours, abandoned buildings. Titles are used only
  // for their concrete anchor words, never as a whole phrase.
  if (title) {
    const tw = title.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !STYLE_WORDS.has(w) && !GRAPHIC_WORDS.has(w)
        && !CONNECTIVES.has(w));
    const tAnchor = tw.filter((w) => SUBJECT_ANCHORS.has(w));
    // Needs a subject AND real context, or it degenerates into word salad
    // ("workers what for floor"). Prose titles contribute nothing otherwise.
    if (tAnchor.length && tw.length >= 3) {
      queries.push([...new Set([...tAnchor, ...tw])].slice(0, 4).join(" "));
    }
  }

  // De-duplicate while preserving order.
  return [...new Set(queries.filter((q) => q.trim().length > 2))];
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

  /**
   * Whether this candidate may be used for the next scene.
   *
   * `strict` applies the composition rules (generic cap, consecutive-concept
   * diversity). Those are preferences, not correctness requirements — see
   * `selectCandidate`, which retries without them rather than letting a
   * diversity rule push the pipeline onto a less relevant asset.
   */
  admits(r: RelevanceResult, strict = true): { ok: boolean; reason?: string } {
    // Relevance is never negotiable, in either pass.
    if (r.verdict === "REJECT") {
      return { ok: false, reason: r.reasons.join("; ") };
    }
    if (!strict) return { ok: true };

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

  /**
   * Pick the best candidate for the next scene, in the required order:
   *
   *   1. sub-threshold candidates are already REJECT and cannot compete
   *   2. remaining candidates are ranked by relevance (caller sorts)
   *   3. STRICT pass — honour generic cap and consecutive-concept diversity
   *   4. RELAXED pass — drop the diversity rules, keep the relevance
   *      threshold, and prefer non-generic assets over generic ones
   *   5. nothing relevant → null, so the caller renders a branded,
   *      topic-specific fallback card rather than unrelated stock footage
   *
   * Diversity therefore shapes the result when it can, but never forces a
   * less relevant or unrelated asset onto the timeline.
   */
  selectCandidate<T>(
    ranked: { candidate: T; relevance: RelevanceResult }[],
    isAvailable: (c: T) => boolean,
  ): { candidate: T; relevance: RelevanceResult; relaxed: boolean } | null {
    const usable = ranked.filter(
      (x) => isAvailable(x.candidate) && x.relevance.verdict !== "REJECT",
    );

    for (const x of usable) {
      if (this.admits(x.relevance, true).ok) {
        return { candidate: x.candidate, relevance: x.relevance, relaxed: false };
      }
    }

    // Relaxed: prefer any non-generic asset before falling back to generic.
    const nonGeneric = usable.filter((x) => x.relevance.concept !== "generic-abstract");
    for (const x of [...nonGeneric, ...usable]) {
      if (this.admits(x.relevance, false).ok) {
        return { candidate: x.candidate, relevance: x.relevance, relaxed: true };
      }
    }

    return null;
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
