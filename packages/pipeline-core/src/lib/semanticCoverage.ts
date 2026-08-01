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
  "access-control-device": {
    terms: ["badge reader", "id scanner", "biometric scanner", "face scanner",
            "fingerprint reader", "access reader", "card reader", "turnstile reader",
            "badge", "biometric", "scanning a badge"],
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
            "store entrance", "retail", "convenience store", "store", "shop"],
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
  /**
   * The prompt names a place, but no setting family recognised it.
   *
   * An empty `settings` list is ambiguous on its own: it means either "this
   * beat needs no particular place" or "this beat needs a place the taxonomy
   * cannot describe". Treating both as "no requirement" is the unknown-domain
   * fail-open in miniature, so the two are distinguished and the unrecognised
   * case fails closed.
   */
  unrecognisedSetting: boolean;
  /** The prompt names a concrete subject, but no subject family recognised it. */
  unrecognisedSubject: boolean;
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

  // Does the prompt point at a place or a thing the taxonomy could not name?
  const promptLower = input.visualPrompt.toLowerCase();
  const namesPlace = /\b(?:inside|within|in a|in an|in the|at a|at an|at the|on a|on the|outside)\s+[a-z]/.test(promptLower);
  const namesThing = /\b(?:showing|with a|with an|of a|of an|a |an )\s*[a-z]+/.test(promptLower);

  return {
    beatIndex: input.beatIndex,
    segmentIndex: input.segmentIndex,
    unrecognisedSetting: settings.length === 0 && namesPlace,
    unrecognisedSubject: subjects.length === 0 && namesThing,
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

  // Fail closed on an unrecognised requirement.
  //
  // Defaulting an empty requirement to "matched" is fail-OPEN: a beat whose
  // subject and setting are outside the taxonomy accepted anything, and a hot
  // air balloon scored DIRECT against a data-centre beat. An empty requirement
  // means the taxonomy cannot describe this beat, which is a reason to refuse
  // to judge it — never a reason to approve every candidate.
  const subjectMatch = req.primarySubjects.length > 0 &&
    req.primarySubjects.some((s) => effective.has(s) || senseSupported.has(s));
  const settingMatch = req.settings.length > 0 &&
    req.settings.some((s) => effective.has(s));

  if (subjectMatch) reasons.push(`subject ${req.primarySubjects.join("/") || "(any)"} satisfied`);
  else reasons.push(`missing subject ${req.primarySubjects.join("/")}`);
  if (req.settings.length) {
    reasons.push(settingMatch ? `setting ${req.settings.join("/")} satisfied`
                              : `missing setting ${req.settings.join("/")}`);
  }

  // A component that is genuinely not required does not need satisfying; one
  // that is required but unrecognised leaves the beat unjudgeable, and
  // unjudgeable must never read as satisfied.
  if (req.unrecognisedSubject || req.unrecognisedSetting) {
    reasons.push(
      `requirement outside the taxonomy (${req.unrecognisedSubject ? "subject" : ""}` +
      `${req.unrecognisedSubject && req.unrecognisedSetting ? "+" : ""}` +
      `${req.unrecognisedSetting ? "setting" : ""}) — cannot be judged, failing closed`,
    );
    return { verdict: "IRRELEVANT", subjectMatch: false, settingMatch: false,
             contradicted, reasons };
  }
  const subjectOk = req.primarySubjects.length === 0 ? null : subjectMatch;
  const settingOk = req.settings.length === 0 ? null : settingMatch;

  let verdict: SemanticVerdict;
  if (contradicted) verdict = "IRRELEVANT";
  else if (subjectOk === null && settingOk === null) verdict = "IRRELEVANT";
  else if (subjectOk !== false && settingOk !== false &&
           (subjectOk === true || settingOk === true)) {
    verdict = (subjectOk === true && settingOk === true) ||
      (subjectOk === true && settingOk === null) ||
      (settingOk === true && subjectOk === null) ? "DIRECT" : "RELATED";
  } else if (subjectOk === true || settingOk === true) verdict = "RELATED";
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

// ── Query construction ───────────────────────────────────────────────────
//
// Query building previously took the leading words of the visual prompt, so a
// beat asking for "Wide-angle shot looking down a long supermarket aisle …
// showing a dome security camera" searched for "wide-angle looking down long".
// The words that mattered — supermarket, aisle, security camera — were never
// sent. Queries are now built from the beat's semantic requirement.

/** Camera direction and prose framing: never the subject of a search. */
const FRAMING_TERMS = [
  "wide-angle", "wide angle", "close-up", "close up", "closeup", "looking down",
  "looking up", "cinematic", "shot of", "footage of", "view of", "ground-level",
  "ground level", "overhead shot", "aerial shot", "pov", "point of view",
  "b-roll", "broll", "slow motion", "timelapse", "time lapse", "handheld",
  "static shot", "tracking shot", "establishing shot", "wide shot", "medium shot",
];

/** One searchable phrase per family — what you would actually type. */
const FAMILY_QUERY_TERMS: Record<string, string[]> = {
  "security-camera": ["security camera", "cctv camera", "surveillance camera", "dome camera"],
  "surveillance-operator": ["security control room", "cctv monitoring room", "video wall operator"],
  "software-screen": ["software dashboard screen", "computer code screen"],
  "vision-processing": ["object detection overlay", "facial recognition screen"],
  "worker-person": ["worker", "staff member"],
  "retail-space": ["supermarket aisle", "grocery store", "self checkout", "retail store interior"],
  "warehouse-space": ["warehouse packing station", "warehouse interior worker"],
  "street-public": ["city street pedestrians", "urban street traffic"],
  "control-room-space": ["control room monitors", "security operations centre"],
  "checkpoint-space": ["access gate turnstile", "biometric checkpoint"],
  "factory-space": ["factory production line", "conveyor belt factory"],
};

export type QueryClass =
  | "EXACT_COMPOSITE" | "CONTROLLED_SYNONYM" | "COMPONENT_SUBJECT"
  | "COMPONENT_SETTING" | "COMPONENT_ACTION" | "BROAD_FALLBACK" | "GENERIC_FALLBACK";

export interface BeatQuery {
  query: string;
  klass: QueryClass;
  /** Requirement families this query is meant to satisfy. */
  satisfies: string[];
}

/** Strip framing vocabulary so it can never stand in for a subject noun. */
export function stripFraming(text: string): string {
  let t = ` ${text.toLowerCase()} `;
  for (const f of FRAMING_TERMS) t = t.split(f).join(" ");
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Controlled query set for one beat. Ordered most specific first, capped, and
 * deduplicated — never an uncontrolled combinatorial expansion.
 */
export function buildBeatQueries(req: BeatRequirement, max = 8): BeatQuery[] {
  const out: BeatQuery[] = [];
  const push = (query: string, klass: QueryClass, satisfies: string[]) => {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.length < 3) return;
    if (out.some((o) => o.query === q)) return;
    out.push({ query: q, klass, satisfies });
  };

  // Terms the prompt actually names come first: a beat about a self checkout
  // should search for self checkouts, not for whichever retail phrase happens
  // to be listed first.
  const promptText = ` ${stripFraming(`${req.visualPrompt} ${req.narration}`)} `;
  const prioritise = (terms: string[]) => {
    const named = terms.filter((t) => promptText.includes(` ${t} `) ||
      t.split(" ").every((w) => promptText.includes(` ${w} `)));
    return [...named, ...terms.filter((t) => !named.includes(t))];
  };
  const subjTerms = prioritise(req.primarySubjects.flatMap((f) => FAMILY_QUERY_TERMS[f] ?? []));
  const setTerms = prioritise(req.settings.flatMap((f) => FAMILY_QUERY_TERMS[f] ?? []));

  // 1. subject + setting — the thing, where it is.
  for (const s of subjTerms.slice(0, 2)) {
    for (const p of setTerms.slice(0, 2)) {
      push(`${s} ${p}`, "EXACT_COMPOSITE", [...req.primarySubjects, ...req.settings]);
    }
  }
  // 2. controlled synonyms of the same pairing.
  for (const s of subjTerms.slice(2, 3)) {
    for (const p of setTerms.slice(0, 1)) {
      push(`${s} ${p}`, "CONTROLLED_SYNONYM", [...req.primarySubjects, ...req.settings]);
    }
  }
  // 3. each component alone.
  for (const s of subjTerms.slice(0, 2)) push(s, "COMPONENT_SUBJECT", req.primarySubjects);
  for (const p of setTerms.slice(0, 2)) push(p, "COMPONENT_SETTING", req.settings);

  // 4. concrete nouns surviving in the prompt, framing removed.
  const stripped = stripFraming(req.visualPrompt);
  const nouns = stripped.split(/[,.;]/)[0]!.split(" ")
    .filter((w) => w.length > 3 && !["with", "from", "that", "this", "showing", "above",
                                      "below", "long", "their", "some"].includes(w));
  if (nouns.length >= 2) {
    push(nouns.slice(0, 3).join(" "), "BROAD_FALLBACK", [...req.primarySubjects, ...req.settings]);
  }

  return out.slice(0, max);
}

// ── Composition policy ───────────────────────────────────────────────────

export type CompositionPolicy =
  | "JOINT_MATCH_REQUIRED" | "COMPOSITIONAL_MATCH_ALLOWED"
  | "SUBJECT_DOMINANT" | "SETTING_DOMINANT";

/**
 * Sentences asserting that a thing is physically AT a place cannot be proved
 * by cutting a generic thing next to a generic place — that composition
 * asserts a co-location the footage does not show.
 */
const COLOCATION_MARKERS = [
  "above the", "mounted", "installed", "attached to", "over the", "at the checkout",
  "in the aisle", "on the ceiling", "overhead", "directly above", "watching the",
  "pointed at", "aimed at",
];

export function derivePolicy(req: BeatRequirement): CompositionPolicy {
  // The claim has to be made by THIS beat's narration. A segment's visual
  // prompt describes the ideal shot for the whole segment and is reused across
  // every beat inside it, so reading co-location from the prompt would make
  // "grainy footage sat on a hard drive" assert that a camera is mounted above
  // an aisle. Only the sentence actually being spoken can require a joint
  // match; the prompt merely raises it for a sentence already leaning that way.
  const narration = req.narration.toLowerCase();
  const assertsColocation = COLOCATION_MARKERS.some((m) => narration.includes(m));
  if (assertsColocation && req.primarySubjects.length > 0 && req.settings.length > 0) {
    return "JOINT_MATCH_REQUIRED";
  }
  if (req.settings.length === 0) return "SUBJECT_DOMINANT";
  if (req.primarySubjects.length === 0) return "SETTING_DOMINANT";
  return "COMPOSITIONAL_MATCH_ALLOWED";
}

// ── Compositional coverage ───────────────────────────────────────────────

/**
 * Minimum share of a beat that must actually show the primary subject.
 *
 * Without it, one second of camera would legitimise seventeen seconds of
 * aisle. 30% is deliberately conservative: it permits the normal
 * establish-then-show edit while refusing a token subject shot. Subject-
 * dominant beats require 50%, because there the subject IS the content.
 */
export const MIN_SUBJECT_SHARE = 0.3;
export const MIN_SUBJECT_SHARE_DOMINANT = 0.5;
export const MIN_SETTING_SHARE = 0.3;

export interface Fragment {
  assetId: string;
  description: string;
  durationS: number;
  brandRisk: boolean;
  carriesSubject: boolean;
  carriesSetting: boolean;
}

export interface CompositionResult {
  policy: CompositionPolicy;
  fragments: Fragment[];
  subjectShare: number;
  settingShare: number;
  jointMatchAsset?: string;
  covered: boolean;
  reasons: string[];
}

/**
 * Select a fragment set for one beat and decide whether it truthfully covers
 * the requirement. Every fragment must directly support a required component;
 * nothing is admitted merely to fill duration.
 */
export function composeBeat(
  req: BeatRequirement,
  policy: CompositionPolicy,
  plannedS: number,
  candidates: CandidateLike[],
  opts: { beatMaxS: number; minFragmentS: number; claimed?: Set<string> },
): CompositionResult {
  const claimed = opts.claimed ?? new Set<string>();
  const reasons: string[] = [];

  const scored = candidates
    .filter((c) => !claimed.has(c.assetId))
    .filter((c) => !(c.durationS > 0 && c.durationS < opts.minFragmentS))
    .map((c) => ({ c, s: scoreSemantic(req, c.description) }))
    // Only footage that directly supports a required component is admissible.
    .filter((x) => x.s.verdict === "DIRECT" || (x.s.verdict === "RELATED" && !x.s.contradicted))
    .filter((x) => x.s.subjectMatch || x.s.settingMatch)
    .filter((x) => !x.c.brandRisk);

  const joint = scored.find((x) => x.s.subjectMatch && x.s.settingMatch);

  if (policy === "JOINT_MATCH_REQUIRED") {
    if (!joint) {
      reasons.push(
        "narration asserts the subject is physically at the setting; no single asset shows both, " +
        "and cutting a generic subject beside a generic setting would assert a relationship the " +
        "footage does not show",
      );
      return { policy, fragments: [], subjectShare: 0, settingShare: 0, covered: false, reasons };
    }
    reasons.push(`joint match: ${joint.c.assetId}`);
  }

  // Prefer joint assets, then subject, then setting — establish-then-show.
  const ordered = [...scored].sort((a, b) => {
    const rank = (x: typeof a) =>
      (x.s.subjectMatch && x.s.settingMatch ? 0 : x.s.subjectMatch ? 1 : 2);
    return rank(a) - rank(b) || (b.c.durationS || 0) - (a.c.durationS || 0);
  });

  // Satisfy the requirements before filling time.
  //
  // A greedy longest-first pass fills the whole beat with one long setting
  // clip and leaves no room for the subject, which then reads as "no fragment
  // carries the primary subject" even though the library had one. Place a
  // subject-bearing fragment and a setting-bearing fragment first, each capped
  // so the other still fits, and only then fill whatever remains.
  const fragments: Fragment[] = [];
  const used = new Set<string>();
  let remaining = plannedS;

  const place = (x: (typeof ordered)[number], cap: number) => {
    const use = Math.min(x.c.durationS || 0, opts.beatMaxS, remaining, cap);
    if (use < opts.minFragmentS) return false;
    fragments.push({
      assetId: x.c.assetId, description: x.c.description, durationS: use,
      brandRisk: Boolean(x.c.brandRisk),
      carriesSubject: x.s.subjectMatch, carriesSetting: x.s.settingMatch,
    });
    used.add(x.c.assetId);
    remaining -= use;
    return true;
  };

  const needSetting = req.settings.length > 0 && policy !== "SUBJECT_DOMINANT";
  if (req.primarySubjects.length > 0) {
    const best = ordered.find((x) => x.s.subjectMatch && !used.has(x.c.assetId));
    // Leave room for the setting requirement — unless this fragment already
    // carries the setting itself, in which case nothing needs reserving.
    const reserveForSetting = needSetting && !best?.s.settingMatch;
    if (best) place(best, reserveForSetting ? plannedS * (1 - MIN_SETTING_SHARE) : plannedS);
  }
  if (needSetting) {
    const best = ordered.find((x) => x.s.settingMatch && !used.has(x.c.assetId));
    if (best) place(best, remaining);
  }
  for (const x of ordered) {
    if (remaining < opts.minFragmentS) break;
    if (used.has(x.c.assetId)) continue;
    place(x, remaining);
  }

  const total = fragments.reduce((a, f) => a + f.durationS, 0);
  const subjectS = fragments.filter((f) => f.carriesSubject).reduce((a, f) => a + f.durationS, 0);
  const settingS = fragments.filter((f) => f.carriesSetting).reduce((a, f) => a + f.durationS, 0);
  const subjectShare = total > 0 ? subjectS / total : 0;
  const settingShare = total > 0 ? settingS / total : 0;

  const needSubject = policy === "SUBJECT_DOMINANT"
    ? MIN_SUBJECT_SHARE_DOMINANT : MIN_SUBJECT_SHARE;

  let covered = true;
  if (remaining >= opts.minFragmentS) {
    covered = false;
    reasons.push(`${remaining.toFixed(1)}s of ${plannedS.toFixed(1)}s uncovered without reuse or looping`);
  }
  if (req.primarySubjects.length > 0 && !fragments.some((f) => f.carriesSubject)) {
    covered = false; reasons.push("no fragment carries the primary subject");
  } else if (req.primarySubjects.length > 0 && subjectShare < needSubject) {
    covered = false;
    reasons.push(`subject share ${(subjectShare * 100).toFixed(0)}% below ${needSubject * 100}%`);
  }
  if (req.settings.length > 0 && policy !== "SUBJECT_DOMINANT") {
    if (!fragments.some((f) => f.carriesSetting)) {
      covered = false; reasons.push("no fragment carries the required setting");
    } else if (settingShare < MIN_SETTING_SHARE) {
      covered = false;
      reasons.push(`setting share ${(settingShare * 100).toFixed(0)}% below ${MIN_SETTING_SHARE * 100}%`);
    }
  }
  if (covered) reasons.push(`covered by ${fragments.length} fragment(s)`);

  return {
    policy, fragments, subjectShare, settingShare,
    jointMatchAsset: joint?.c.assetId, covered, reasons,
  };
}
