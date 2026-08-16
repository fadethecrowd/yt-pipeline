import { classifyConcept, conceptProfile } from "./visualRelevance";

/**
 * What a beat is ABOUT, as opposed to what it is compared to.
 *
 * Run e704334a explained token brokering by analogy: "Imagine buying wholesale
 * electricity, then reselling it at a markup to your neighbors. Now replace
 * electricity with AI processing power." The script generator then wrote, as
 * segment 0's visual_prompt, "A busy wholesale warehouse with workers moving
 * large pallets of boxed goods", and for segment 5 "An open-air agricultural
 * commodity market with traders negotiating over crates of produce".
 *
 * Retrieval faithfully returned warehouses, forklifts and a rapeseed field. The
 * scorer rated them 0.25-0.30 and passed them, because ACCEPTABLE is a passing
 * verdict. The wrong thing was asked for, so the right answer to the wrong
 * question is what shipped.
 *
 * The structural defect is upstream of all of that: `gatherCandidates` pools
 * candidates from `buildSearchQueries(seg.visual_prompt, …)` and NOTHING ELSE.
 * The narration never reaches retrieval. So when a prompt is wrong the pool
 * contains only wrong assets, and scoring — which does read the narration — can
 * do no better than pick the least-wrong warehouse.
 *
 * This module supplies the missing half: queries derived from the narration
 * itself, with the analogy's vehicle excised so borrowed vocabulary cannot
 * steer the search.
 *
 * It does not try to judge a prompt semantically. Three lexical formulations —
 * shared-term corroboration, head-phrase corroboration, and scoring the prompt
 * as its own candidate — were measured against this script's six prompts, and
 * none separated the sound prompts from the analogical ones without fitting to
 * the sample. What is implemented is only what can be shown: an analogy's own
 * words (`borrowedFromVehicle`), an outro's own markers (`isOutroBeat`), and a
 * demand that literal physical imagery be literally justified
 * (`withheldDomains`). Each flags segments 0 and 5 of that script and leaves
 * 1 through 4 alone.
 */

/**
 * Comparison frames, each capturing the VEHICLE — the thing compared TO.
 *
 * Bare "like" is deliberately absent: it is the commonest comparison word in
 * English and also sits in "hit the like button", which this channel writes in
 * every outro. Matching it would excise a CTA and mark real subject text as
 * borrowed. Only unambiguous multi-word forms are matched.
 */
const COMPARISON_FRAMES: RegExp[] = [
  /\breplace\s+(.+?)\s+with\b/gi,
  /\b(?:imagine|picture)\s+(.+?)(?=[.;!?—]|$)/gi,
  /\bthink of (?:it|them|this) (?:as|like)\s+(.+?)(?=[.;!?—]|$)/gi,
  /\bit'?s (?:basically|essentially|kind of|sort of|like|the same as)\s+(.+?)(?=[.;!?—]|$)/gi,
  /\b(?:just|much|kind of|sort of|not unlike|akin to|analogous to)\s+like\s+(.+?)(?=[.;!?—]|$)/gi,
  /\bthe same way (?:that\s+)?(.+?)(?=[.;!?—]|$)/gi,
  /\bas if\s+(.+?)(?=[.;!?—]|$)/gi,
];

/** Every comparison vehicle stated anywhere in `text`. */
export function comparisonVehicles(text: string): string[] {
  const out: string[] = [];
  for (const re of COMPARISON_FRAMES) {
    for (const m of text.matchAll(re)) {
      const v = (m[1] ?? "").trim();
      if (v.length > 2) out.push(v);
    }
  }
  return out;
}

/**
 * Outro and CTA markers. These beats have no retrievable subject — "Subscribe
 * so you don't miss our next deep dive" depicts nothing — so a search for one
 * returns whatever the surrounding prompt happened to say. Here, farmland.
 */
const OUTRO_MARKERS = [
  "subscribe", "like button", "hit like", "smash that", "drop a comment",
  "comment below", "read every comment", "thanks for watching",
  "link in the description", "let me know in the comments", "next deep dive",
  "hit the bell", "turn on notifications",
];

/**
 * Whether this beat is outro/CTA rather than editorial content.
 *
 * Word boundaries, not substrings: a plain `includes` reads "under-subscribed
 * enterprise tiers" — ordinary prose in this very script — as "subscribe", and
 * would replace a content beat with an end card.
 */
export function isOutroBeat(narration: string): boolean {
  const n = narration.toLowerCase();
  return OUTRO_MARKERS.some((m) =>
    new RegExp(`(^|[^a-z])${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(n));
}

const STOP = new Set([
  "the", "a", "an", "and", "of", "in", "on", "at", "to", "with", "for", "from",
  "that", "this", "these", "those", "it", "its", "their", "they", "them", "you",
  "your", "our", "we", "are", "is", "was", "were", "be", "been", "has", "have",
  "had", "not", "but", "or", "so", "as", "by", "into", "over", "under", "out",
  "just", "very", "more", "most", "some", "any", "all", "one", "two", "who",
  "whose", "which", "what", "when", "where", "how", "why", "then", "than",
  "there", "here", "now", "also", "about", "can", "will", "would", "could",
  "still", "real", "actually", "genuinely", "really", "right", "well", "like",
  "get", "got", "make", "made", "look", "going", "want", "need", "know",
  "think", "much", "many", "every", "even", "because", "while", "does", "did",
  "here's", "there's", "that's", "you'd", "don't", "isn't", "doesn't",
]);

/**
 * De-pluralise without destroying words that simply end in s. A blanket
 * trailing-s strip turns "business" into "busines" and "businesses" into
 * "business", so the two stop matching.
 */
function stem(w: string): string {
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ss")) return w;
  if (w.endsWith("s") && w.length > 3) return w.slice(0, -1);
  return w;
}

/**
 * Content words. Adverbs and hyphenated compounds are dropped: ranking by
 * length alone surfaced "fastest-growing", "underneath" and "under-subscribed"
 * ahead of "broker" and "token", and none of those name a filmable thing.
 */
function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !w.endsWith("ly") && !w.includes("-"));
}

/**
 * Remove every vehicle span from `text`.
 *
 * Longest span first. Removing "electricity" before "buying wholesale
 * electricity, then reselling it…" destroys the longer span's own text, so the
 * longer excision then matches nothing and the whole analogy survives — which
 * is what left "wholesale" free to vouch for "wholesale warehouse".
 */
export function deVehicle(text: string, vehicles: string[]): string {
  let out = text;
  for (const v of [...vehicles].sort((a, b) => b.length - a.length)) {
    out = out.split(v).join(" ");
  }
  return out.replace(/\s+/g, " ").trim();
}

/** How many topical words describe a beat well enough to search for it. */
const SUBJECT_TERMS = 5;

/**
 * The words this passage is actually about, most topical first.
 *
 * Weighted by how often the BEAT says a word and by how often the WHOLE SCRIPT
 * says it. Beat frequency alone promotes whatever that passage happened to
 * repeat; adding the script-wide count promotes the words the video keeps
 * returning to — broker, provider, token, credit — which is what the video is
 * about. Measured on run e704334a: beat-only ranking produced "fastest-growing
 * underneath processing"; this produces "broker economy token credit".
 */
export function subjectTerms(o: { narration: string; scriptText: string }): string[] {
  const vehicles = comparisonVehicles(o.scriptText);
  const topic = new Map<string, number>();
  for (const w of words(deVehicle(o.scriptText, vehicles))) {
    topic.set(stem(w), (topic.get(stem(w)) ?? 0) + 1);
  }
  const local = new Map<string, number>();
  for (const w of words(deVehicle(o.narration, vehicles))) {
    local.set(stem(w), (local.get(stem(w)) ?? 0) + 1);
  }
  const weight = (w: string) => (local.get(w) ?? 0) * 2 + (topic.get(w) ?? 0);
  return [...local.keys()]
    .sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))
    .slice(0, SUBJECT_TERMS);
}


/**
 * Words the prompt borrowed from the analogy's vehicle.
 *
 * This is the one contamination claim that can be PROVEN rather than inferred:
 * the prompt is reusing the comparison's own vocabulary. Segment 0's "wholesale
 * warehouse" is caught here by "wholesale". Prompts that merely drift are not
 * claimed to be caught — widening the pool is what covers those.
 */
export function borrowedFromVehicle(prompt: string, vehicles: string[]): string[] {
  const vw = new Set(words(vehicles.join(" ")).map(stem));
  return [...new Set(words(prompt).map(stem))].filter((w) => vw.has(w));
}

/**
 * Concepts whose footage is unmistakably literal: farmland, warehouses, power
 * plants, boats. Nothing about them is figurative, so nothing but the narration
 * itself can justify asking for them.
 *
 * The other concepts are deliberately absent. "documents" or "workplace"
 * footage illustrates an abstract passage perfectly well — a script about
 * contracts is fairly served by a boardroom — and demanding literal
 * justification there rejected three of this script's four sound prompts.
 */
const LITERAL_DOMAINS = new Set([
  "environment", "factory", "energy", "vessel", "water", "fishing",
]);

/**
 * The literal domains this narration cannot justify, which therefore may not be
 * SELECTED for it however well they happen to score.
 *
 * Resolving the prompt is not enough on its own. The candidate pool is global —
 * every beat draws from every segment's search — so warehouse footage retrieved
 * for one segment can still be chosen for another, and `factory` is the widest
 * net in the taxonomy ("industrial", "warehouse", "logistics", "conveyor"), so
 * it collects almost any physical setting. Replanning run e704334a with only
 * the prompt fix still put "aerial view of industrial warehouse facility" over
 * narration about brokers aggregating model providers, scored 0.38 and
 * ACCEPTABLE.
 *
 * This withholds the domain rather than rescoring it: thresholds and verdict
 * bands are untouched, and a domain the narration DOES name stays available —
 * a marine script keeps its boats, an industrial one keeps its factories.
 */
export function withheldDomains(
  subjectText: string,
  taxonomy: Record<string, string[]>,
): Set<string> {
  const supported = new Set(
    conceptProfile(subjectText, taxonomy).filter((c) => c.score > 0).map((c) => c.concept),
  );
  return new Set([...LITERAL_DOMAINS].filter((d) => taxonomy[d] && !supported.has(d)));
}
