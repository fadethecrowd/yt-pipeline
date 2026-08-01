/**
 * Beat-level semantic coverage.
 *
 * The numeric feasibility gate measures the pool: how many assets came back,
 * how many seconds they run to, how evenly the concepts are spread. ai1r
 * attempt 2 passed all of it — 117 assets, 2,006 usable seconds, five
 * concepts, largest 37% — while half the timeline was airport terminals,
 * industrial aerials, a hot-air balloon and tomatoes on a conveyor belt, and
 * not one supermarket aisle existed for a script whose every visual prompt
 * asked for one.
 *
 * Three things made that possible:
 *
 *   1. Acquisition pools every beat's queries into one flat list.
 *   2. A candidate is scored against ALL beats and keeps its BEST score, so
 *      being plausible for one beat buys entry to the pool for all of them.
 *   3. The pool statistics are global, so a large diverse pool hides a beat
 *      with nothing relevant in it.
 *
 * This module asks a different question, per beat: does the library actually
 * contain footage of the thing this sentence is about? A candidate must match
 * the beat's required SUBJECT and its required SETTING — separately — and must
 * not be contradicted. Belonging to the right broad concept is not enough:
 * an airport is surveillance-adjacent and still cannot illustrate a
 * supermarket aisle.
 */

// ── Domain families ──────────────────────────────────────────────────────
//
// Families are subject/setting vocabularies, not topics. They are shared by
// every channel and script; nothing here is specific to one asset.

export interface Family {
  /** Phrases that mean this family is depicted. */
  terms: string[];
  /** Phrases that positively contradict it. */
  contradicts?: string[];
  /** True for settings (places), false for subjects (things/actors). */
  isSetting?: boolean;
}

export const FAMILIES: Record<string, Family> = {
  // ── Subjects ──
  "security-camera": {
    terms: ["security camera", "surveillance camera", "cctv", "cctv camera", "dome camera",
            "closed circuit", "camera mounted", "traffic camera", "surveillance sign",
            "surveillance warning", "camera lens on wall", "video surveillance"],
  },
  "surveillance-operator": {
    terms: ["control room", "security operations", "video wall", "monitoring station",
            "operator monitoring", "security guard watching", "police officer monitoring",
            "watching monitor", "monitoring operations", "traffic management control"],
  },
  "software-screen": {
    terms: ["source code", "code on screen", "programming", "terminal window", "command line",
            "python", "software developer", "dashboard interface", "data dashboard",
            "code editor", "software interface", "analytics dashboard"],
  },
  "vision-processing": {
    terms: ["object detection", "facial recognition", "face detection", "computer vision",
            "bounding box", "machine vision", "detection overlay", "recognition system"],
  },
  "worker-person": {
    terms: ["worker", "employee", "staff", "cashier", "operator", "shopper", "customer",
            "person", "people"],
  },

  // ── Settings ──
  "retail-space": {
    isSetting: true,
    terms: ["supermarket", "grocery store", "grocery", "retail store", "shop interior",
            "store aisle", "aisle", "shelves stocked", "checkout", "self-checkout",
            "cash register", "till", "shopping trolley", "shopping cart", "shopper",
            "store entrance", "retail", "convenience store"],
  },
  "warehouse-space": {
    isSetting: true,
    terms: ["warehouse", "packing station", "distribution centre", "distribution center",
            "fulfilment", "fulfillment", "loading bay", "warehouse shelving",
            "warehouse worker", "forklift", "packing table"],
    // An exterior aerial is a picture of a roof, not of work being monitored.
    contradicts: ["aerial view", "drone shot", "drone video", "aerial shot", "from above outside"],
  },
  "street-public": {
    isSetting: true,
    terms: ["street", "pedestrian", "crosswalk", "city intersection", "public square",
            "sidewalk", "traffic", "urban street", "transit station", "train platform"],
  },
  "control-room-space": {
    isSetting: true,
    terms: ["control room", "operations centre", "operations center", "monitoring room",
            "security office", "video wall"],
  },
  "checkpoint-space": {
    isSetting: true,
    terms: ["turnstile", "access gate", "entry gate", "checkpoint", "barrier gate",
            "id scanner", "badge reader", "biometric"],
  },
  "factory-space": {
    isSetting: true,
    terms: ["factory floor", "assembly line", "production line", "conveyor", "machinery",
            "manufacturing floor"],
    contradicts: ["aerial view", "drone shot", "drone video", "aerial shot"],
  },
};

// ── Polysemy ─────────────────────────────────────────────────────────────
//
// A word can carry two unrelated senses. Deciding which sense a candidate
// depicts is done from what else is in the description — never by a per-topic
// exception.

export interface Sense {
  /** Markers that select this sense. */
  markers: string[];
  /** Families this sense supports. */
  supports: string[];
}

export const POLYSEMY: Record<string, Record<string, Sense>> = {
  terminal: {
    computing: { markers: ["command", "shell", "python", "code", "console", "bash", "server", "script"],
                 supports: ["software-screen"] },
    transit: { markers: ["airport", "flight", "passenger", "luggage", "baggage", "departure",
                          "boarding", "check in", "bus", "train"],
               supports: ["street-public"] },
    payment: { markers: ["card", "payment", "pos", "checkout", "pay"], supports: ["retail-space"] },
  },
  monitor: {
    display: { markers: ["screen", "display", "desk", "computer", "office"], supports: ["software-screen"] },
    watching: { markers: ["monitoring", "surveillance", "control room", "security", "cctv", "operator"],
                supports: ["surveillance-operator", "security-camera"] },
  },
  camera: {
    security: { markers: ["security", "surveillance", "cctv", "dome", "mounted", "ceiling", "wall", "pole"],
                supports: ["security-camera"] },
    photography: { markers: ["photographer", "photo shoot", "dslr", "lens cap", "tripod", "studio",
                              "vlog", "filmmaker"],
                   supports: [] },
  },
  checkout: {
    retail: { markers: ["store", "supermarket", "shop", "till", "register", "scanner", "bagging", "queue"],
              supports: ["retail-space"] },
    other: { markers: ["hotel", "library", "book"], supports: [] },
  },
  tracking: {
    surveillance: { markers: ["camera", "cctv", "surveillance", "person", "face", "behaviour", "behavior"],
                    supports: ["security-camera", "vision-processing"] },
    logistics: { markers: ["parcel", "package", "shipment", "delivery", "fleet", "inventory"],
                 supports: ["warehouse-space"] },
    analytics: { markers: ["chart", "graph", "metric", "dashboard", "kpi"], supports: ["software-screen"] },
  },
};

// ── Text helpers ─────────────────────────────────────────────────────────

function norm(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function has(hayNorm: string, phrase: string): boolean {
  return hayNorm.includes(` ${phrase.toLowerCase()} `) ||
    hayNorm.includes(` ${phrase.toLowerCase()}s `) ||
    hayNorm.includes(` ${phrase.toLowerCase()} `.replace(/s $/, " "));
}

/**
 * Whole-word match tolerant of common inflections, used for polysemy lemmas:
 * "monitoring" and "monitored" are both the word "monitor" for the purpose of
 * deciding which sense the description depicts.
 */
function hasLemma(hayNorm: string, word: string): boolean {
  const w = word.toLowerCase();
  const forms = [w, `${w}s`, `${w}ing`, `${w}ed`, `${w}es`];
  if (w.endsWith("e")) forms.push(`${w.slice(0, -1)}ing`, `${w}d`);
  return forms.some((f) => hayNorm.includes(` ${f} `));
}

/** Families named by a piece of text. */
export function familiesIn(text: string): string[] {
  const n = norm(text);
  const out: string[] = [];
  for (const [name, f] of Object.entries(FAMILIES)) {
    if (f.terms.some((t) => has(n, t))) out.push(name);
  }
  return out;
}

/**
 * Resolve a polysemous word to the sense the text actually depicts.
 * Returns null when the word is absent or no sense marker is present.
 */
export function resolveSense(text: string, word: string): { sense: string; supports: string[] } | null {
  const n = norm(text);
  if (!hasLemma(n, word)) return null;
  const senses = POLYSEMY[word];
  if (!senses) return null;
  let best: { sense: string; supports: string[]; hits: number } | null = null;
  for (const [sense, def] of Object.entries(senses)) {
    const hits = def.markers.filter((m) => has(n, m)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { sense, supports: def.supports, hits };
  }
  return best ? { sense: best.sense, supports: best.supports } : null;
}

// ── Beat requirements ────────────────────────────────────────────────────

export interface BeatRequirement {
  beatIndex: number;
  segmentIndex: number;
  narration: string;
  visualPrompt: string;
  /** Families that must be depicted — the thing the sentence is about. */
  primarySubjects: string[];
  /** Places the shot must be in, when the prompt names one. */
  settings: string[];
  /** Helpful but not required. */
  supporting: string[];
  /** Families that positively disqualify a candidate for this beat. */
  disallowed: string[];
  /** True when the narration is genuinely about software/code/interfaces. */
  screensAllowed: boolean;
  /** A fallback card may stand in for this beat. */
  cardPermitted: boolean;
}

/**
 * Derive what a beat needs from its visual prompt AND its narration.
 *
 * The prompt says what the shot should be; the narration says what the shot
 * is for. Using only the prompt loses the context that decides polysemy.
 */
export function deriveRequirement(input: {
  beatIndex: number;
  segmentIndex: number;
  narration: string;
  visualPrompt: string;
  /** Beats that open a section carry the thesis and may not be carded. */
  isHighSalience?: boolean;
}): BeatRequirement {
  const promptFams = familiesIn(input.visualPrompt);
  const narrationFams = familiesIn(input.narration);
  const settings = promptFams.filter((f) => FAMILIES[f]?.isSetting);
  const subjects = promptFams.filter((f) => !FAMILIES[f]?.isSetting);

  // The narration can supply a subject the prompt only implies.
  for (const f of narrationFams) {
    if (!FAMILIES[f]?.isSetting && !subjects.includes(f)) subjects.push(f);
  }

  // Screens count as a legitimate subject only when the idea is about them.
  const screensAllowed =
    subjects.includes("software-screen") || subjects.includes("vision-processing") ||
    /software|algorithm|code|model|system flags|analy/i.test(input.narration);
  const primarySubjects = subjects.filter(
    (s) => s !== "worker-person" && (s !== "software-screen" || screensAllowed),
  );

  const disallowed: string[] = [];
  if (!screensAllowed) disallowed.push("software-screen");

  return {
    beatIndex: input.beatIndex,
    segmentIndex: input.segmentIndex,
    narration: input.narration,
    visualPrompt: input.visualPrompt,
    primarySubjects: primarySubjects.length ? primarySubjects : subjects,
    settings,
    supporting: narrationFams.filter((f) => !promptFams.includes(f)),
    disallowed,
    screensAllowed,
    cardPermitted: !input.isHighSalience,
  };
}

// ── Candidate scoring ────────────────────────────────────────────────────

export type SemanticVerdict = "DIRECT" | "RELATED" | "IRRELEVANT";

export interface SemanticScore {
  verdict: SemanticVerdict;
  subjectMatch: boolean;
  settingMatch: boolean;
  contradicted: boolean;
  reasons: string[];
}

/**
 * Score one candidate against one beat.
 *
 * DIRECT requires the beat's subject AND, when the prompt names a place, that
 * place. Only DIRECT footage may cover a beat: RELATED is real but off-target
 * (a control room for a checkout beat) and IRRELEVANT is everything else.
 */
export function scoreSemantic(req: BeatRequirement, description: string): SemanticScore {
  const n = norm(description);
  const reasons: string[] = [];
  const candFams = familiesIn(description);

  // Polysemy: a word only counts for the sense the description depicts.
  const senseSupported = new Set<string>();
  for (const word of Object.keys(POLYSEMY)) {
    const r = resolveSense(description, word);
    if (!r) continue;
    for (const f of r.supports) senseSupported.add(f);
    reasons.push(`"${word}" reads as ${r.sense}`);
  }

  // A family claimed only through a polysemous word must survive that word's
  // resolved sense. "airport terminal" must not satisfy software-screen.
  const effective = new Set<string>(candFams);
  for (const word of Object.keys(POLYSEMY)) {
    const r = resolveSense(description, word);
    if (!r) continue;
    for (const [fam, def] of Object.entries(FAMILIES)) {
      if (!effective.has(fam)) continue;
      const claimedOnlyByWord = def.terms.filter((t) => has(n, t)).every((t) => t.includes(word));
      if (claimedOnlyByWord && !r.supports.includes(fam)) {
        effective.delete(fam);
        reasons.push(`"${word}" (${r.sense}) does not support ${fam}`);
      }
    }
    for (const f of r.supports) effective.add(f);
  }

  // Explicit contradictions declared by the family itself.
  let contradicted = false;
  for (const fam of [...req.settings, ...req.primarySubjects]) {
    const bad = FAMILIES[fam]?.contradicts ?? [];
    if (bad.some((b) => has(n, b))) {
      contradicted = true;
      reasons.push(`contradicts ${fam} (${bad.find((b) => has(n, b))})`);
    }
  }
  for (const fam of req.disallowed) {
    if (effective.has(fam)) {
      contradicted = true;
      reasons.push(`beat disallows ${fam}`);
    }
  }

  const subjectMatch = req.primarySubjects.length === 0 ||
    req.primarySubjects.some((s) => effective.has(s) || senseSupported.has(s));
  const settingMatch = req.settings.length === 0 ||
    req.settings.some((s) => effective.has(s));

  if (subjectMatch) reasons.push(`subject ${req.primarySubjects.join("/") || "(any)"} satisfied`);
  else reasons.push(`missing subject ${req.primarySubjects.join("/")}`);
  if (req.settings.length) {
    reasons.push(settingMatch ? `setting ${req.settings.join("/")} satisfied`
                              : `missing setting ${req.settings.join("/")}`);
  }

  let verdict: SemanticVerdict;
  if (contradicted) verdict = "IRRELEVANT";
  else if (subjectMatch && settingMatch) verdict = "DIRECT";
  else if (subjectMatch || settingMatch) verdict = "RELATED";
  else verdict = "IRRELEVANT";

  return { verdict, subjectMatch, settingMatch, contradicted, reasons };
}

// ── Per-beat coverage ────────────────────────────────────────────────────

export interface CandidateLike {
  assetId: string;
  description: string;
  durationS: number;
  brandRisk?: boolean;
  /** Which query produced this candidate, and how broad that query was. */
  provenance?: QueryProvenance;
}

export type QueryProvenance = "exact" | "synonym" | "broad" | "generic";

export interface BeatCoverage {
  requirement: BeatRequirement;
  plannedS: number;
  directCandidates: { assetId: string; description: string; usableS: number; brandRisk: boolean }[];
  relevantSeconds: number;
  nonBrandRiskSeconds: number;
  rejected: { assetId: string; description: string; verdict: SemanticVerdict; reason: string }[];
  /** Covered by directly relevant footage without reuse or looping. */
  supported: boolean;
  needsCard: boolean;
  unsupported: boolean;
}

export interface SemanticCoverageOptions {
  /** Longest single fragment, mirroring assembly's cap. */
  beatMaxS: number;
  /** Shortest usable fragment. */
  minFragmentS: number;
  /** Asset ids already consumed by earlier beats — no reuse across beats. */
  claimed?: Set<string>;
}

/**
 * Decide whether one beat can be covered by directly relevant footage.
 *
 * Assets already claimed by an earlier beat are unavailable: reuse across
 * beats is forbidden, so coverage must be provable without it.
 */
export function coverBeat(
  req: BeatRequirement,
  plannedS: number,
  candidates: CandidateLike[],
  opts: SemanticCoverageOptions,
): BeatCoverage {
  const claimed = opts.claimed ?? new Set<string>();
  const direct: BeatCoverage["directCandidates"] = [];
  const rejected: BeatCoverage["rejected"] = [];

  for (const c of candidates) {
    const s = scoreSemantic(req, c.description);
    if (s.verdict !== "DIRECT") {
      rejected.push({
        assetId: c.assetId, description: c.description,
        verdict: s.verdict, reason: s.reasons.join("; "),
      });
      continue;
    }
    // A generic-fallback result must still satisfy the beat on its own merits,
    // which it just did — provenance is recorded, not excused.
    if (claimed.has(c.assetId)) continue;
    if (c.durationS > 0 && c.durationS < opts.minFragmentS) continue;
    direct.push({
      assetId: c.assetId, description: c.description,
      usableS: Math.min(c.durationS || 0, opts.beatMaxS),
      brandRisk: Boolean(c.brandRisk),
    });
  }

  direct.sort((a, b) => b.usableS - a.usableS);
  const relevantSeconds = direct.reduce((a, x) => a + x.usableS, 0);
  const nonBrandRiskSeconds = direct.filter((d) => !d.brandRisk).reduce((a, x) => a + x.usableS, 0);

  // Brand-risk footage may not be what makes a beat coverable.
  const supported = nonBrandRiskSeconds >= plannedS && direct.length > 0;

  return {
    requirement: req,
    plannedS,
    directCandidates: direct,
    relevantSeconds,
    nonBrandRiskSeconds,
    rejected,
    supported,
    needsCard: !supported && req.cardPermitted,
    unsupported: !supported && !req.cardPermitted,
  };
}

// ── Whole-script gate ────────────────────────────────────────────────────

/**
 * Re-exported from the numeric gate rather than redefined, so the two caps
 * cannot drift apart. This is the SAME 15% cap, applied to semantic coverage.
 */
import { MAX_CARD_SHARE } from "./visualFeasibility";
export { MAX_CARD_SHARE };

export interface SemanticFeasibility {
  beats: BeatCoverage[];
  supportedBeats: number;
  cardBeats: number;
  unsupportedBeats: number;
  supportedPct: number;
  cardPct: number;
  consecutiveCards: boolean;
  acceptedAssets: number;
  acceptedSeconds: number;
  brandRiskDependent: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  pass: boolean;
  failureReason?: string;
}

/**
 * Hard, fail-closed semantic gate. Runs before credit reservation, ElevenLabs,
 * rendering, upload intents and any YouTube call.
 */
export function assessSemanticCoverage(coverages: BeatCoverage[]): SemanticFeasibility {
  const supported = coverages.filter((c) => c.supported);
  const cards = coverages.filter((c) => c.needsCard);
  const unsupported = coverages.filter((c) => c.unsupported);
  const n = coverages.length || 1;

  let consecutive = false;
  for (let i = 1; i < coverages.length; i++) {
    if (coverages[i]!.needsCard && coverages[i - 1]!.needsCard) consecutive = true;
  }

  const ids = new Set<string>();
  let seconds = 0;
  for (const c of supported) {
    for (const d of c.directCandidates) {
      if (ids.has(d.assetId)) continue;
      ids.add(d.assetId);
      seconds += d.usableS;
    }
  }
  const brandRiskDependent = coverages.some(
    (c) => c.relevantSeconds >= c.plannedS && c.nonBrandRiskSeconds < c.plannedS,
  );

  const cardPct = cards.length / n;
  const cap = MAX_CARD_SHARE;
  const supportedPct = supported.length / n;

  const checks = [
    {
      name: "every-beat-has-direct-footage",
      ok: unsupported.length === 0,
      detail: unsupported.length === 0
        ? "every beat is either directly supported or a permitted card"
        : `${unsupported.length} beat(s) have no directly relevant footage and may not be carded: ` +
          unsupported.map((c) => `#${c.requirement.beatIndex}`).join(", "),
    },
    {
      name: "card-share-within-cap",
      ok: cardPct <= cap,
      detail: `${cards.length}/${n} beats (${(cardPct * 100).toFixed(1)}%) need a card; cap ${cap * 100}%`,
    },
    {
      name: "no-consecutive-cards",
      ok: !consecutive,
      detail: consecutive ? "two adjacent beats both need cards" : "no two card beats are adjacent",
    },
    {
      name: "brand-risk-not-load-bearing",
      ok: !brandRiskDependent,
      detail: brandRiskDependent
        ? "at least one beat is only coverable using brand-risk footage"
        : "no beat depends on brand-risk footage",
    },
  ];

  const failed = checks.find((c) => !c.ok);
  return {
    beats: coverages,
    supportedBeats: supported.length,
    cardBeats: cards.length,
    unsupportedBeats: unsupported.length,
    supportedPct,
    cardPct,
    consecutiveCards: consecutive,
    acceptedAssets: ids.size,
    acceptedSeconds: seconds,
    brandRiskDependent,
    checks,
    pass: !failed,
    failureReason: failed ? `${failed.name}: ${failed.detail}` : undefined,
  };
}
