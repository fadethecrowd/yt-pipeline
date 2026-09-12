import { normalize } from "./scriptStructure";

/**
 * Metadata may not assert what the script disclaims.
 *
 * `titleFidelity` guards the TITLE against claims the script never established.
 * This module guards everything the title stage does not reach: the thumbnail
 * headline and subtext, the description, the tags and the chapter labels. Those
 * stages run after the script and see almost none of it — the WC thumbnail
 * stage was passed the topic, the SEO title and the script's HOOK, and nothing
 * else — so they cannot tell that the narration they are advertising spent six
 * minutes refusing to do the thing they claim it did.
 *
 * The 2026-09-11 batch shipped three shapes of this, all from source-less
 * scripts whose narration was otherwise careful:
 *
 *   "ALL THREE TESTED"          — script's CTA promises that comparison as a
 *                                 FUTURE video; nothing was tested.
 *   "LIVESCOPE KILLS MEGA LIVE" — script concludes "None of them are bad."
 *   "WRONG AIS KILLS YOU"       — script asserts no fatality anywhere.
 *
 * None of these were model error in the ordinary sense. The thumbnail prompt
 * asks for "one technology beating or killing another", offers "MEGA LIVE BEATS
 * LIVESCOPE" as a target shape, and instructs the model to prioritise
 * consequential framing "over descriptive accuracy". The generator did as it
 * was told. So the prompt is constrained at the call site AND the output is
 * checked here, because a prompt cannot be relied on to bind a claim.
 *
 * Deterministic and lexical, for the same reason `titleFidelity` is: asking a
 * model whether its own headline was justified is the failure mode this exists
 * to catch.
 */

// ── Promissory evidence ────────────────────────────────────────────────────

/**
 * Markers of work the script promises rather than performs.
 *
 * This is the subtlety that makes a naive synonym check useless here. The
 * forward-facing-sonar script DOES contain the phrase "real on-water testing" —
 * inside "We're going deep on each of these systems individually — real
 * on-water testing ... Subscribe and you'll see each video the week it drops."
 * Matching "testing" anywhere in the script would let that sentence license a
 * "TESTED" badge, which is precisely backwards: the sentence is the proof that
 * no test happened.
 *
 * So evidence is read a sentence at a time and a promissory sentence licenses
 * nothing. A claim has to be earned by prose that says the work was done.
 */
const PROMISSORY =
  /\b(?:coming soon|is coming|are coming|we'?re (?:putting|doing|working|going|planning)|we'?(?:ll|ve got)|we will|going to|next video|upcoming|in the works|stay tuned|subscribe|the week it drops|when it drops|it drops|day it drops|lands? in your feed|show up when|catch it when|find it in the description|link'?s? (?:is )?in the description)\b/i;

/** Split on sentence terminators and newlines; keep it cheap and predictable. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * `evidence` with every promissory sentence removed.
 *
 * Exported because the thumbnail stage logs what it actually judged against —
 * a claim rejected for lack of support is much easier to review when the
 * reviewer can see which half of the script was discarded and why.
 */
export function performedEvidence(evidence: string): string {
  return sentences(evidence).filter((s) => !PROMISSORY.test(s)).join(" ");
}

// ── Claim classes ──────────────────────────────────────────────────────────

/**
 * A claim that the work was performed: testing, measurement, proof.
 *
 * Note "REVIEWED" and "COMPARED" are absent. A video genuinely can compare
 * three products by reading their documentation, and calling that a comparison
 * is fair. Claiming it was TESTED is not.
 */
const PERFORMED_CLAIM = [
  /\btested\b/i, /\bwe test\b/i, /\btest results?\b/i, /\bproven\b/i,
  /\bproof\b/i, /\bmeasured\b/i, /\bbenchmarked\b/i, /\bhands on\b/i,
  /\bhands-on\b/i, /\breal world test/i, /\bon water test/i,
];
const PERFORMED_SUPPORT = [
  "tested", "test", "measured", "benchmark", "proof", "proven",
  "hands on", "we ran", "we tried", "our testing",
];

/**
 * A claim that one option won.
 *
 * "kills" belongs here despite being the channel's house style, because it is
 * only checked when the script has explicitly declined to name a winner. A
 * script that does pick a side keeps its punchy headline: "LITHIUM KILLS AGM"
 * over narration arguing for lithium is honest CTR work. The same headline over
 * "None of them are bad" is not.
 *
 * Three near-misses are deliberately NOT here, each because replaying the
 * 2026-09-11 batch through this check produced a false positive that would have
 * failed a legitimate chapter label:
 *
 *   bare "wrong" — "Why This Decision Is So Easy to Get Wrong" and "picking the
 *     wrong mount is the most common mistake" are error framing, not a verdict
 *     on a product. Only "the wrong one/choice/pick" asserts a loser, so only
 *     that is matched.
 *   bare "wins"  — "Which Mode Wins Each" is a PER-SCENARIO winner, which is
 *     exactly what an "it depends" script argues. "winner" singular stays.
 *   bare "best"  — "The Kayak and Bass Angler's Best Friend" is an idiom.
 *
 * A guard that blocks honest copy gets switched off, so the bar is a claim that
 * cannot be read any other way.
 */
const WINNER_CLAIM = [
  /\bkills?\b/i, /\bbeats?\b/i, /\bdestroys?\b/i, /\bcrushes\b/i,
  /\bdominates?\b/i, /\bwinner\b/i, /\bloses to\b/i,
  /\bbetter than\b/i,
  /\bbest\s+(?!friend|practice)/i,
  /\bwrong\s+(?:one|choice|pick|option)\b/i,
];

/**
 * The script explicitly refuses to name a winner.
 *
 * Presence of any of these makes a WINNER_CLAIM unearnable — there is no
 * sentence anywhere in the script that could support it, because the script's
 * stated position is the opposite.
 */
const NO_WINNER_STANCE = [
  /\bnone of (?:them|these|the three) (?:are|is) bad\b/i,
  /\bneither\b[^.]{0,60}\bis better\b/i,
  /\bnone (?:are|is) better\b/i,
  /\bthey(?:'re| are) teammates\b/i,
  /\bno single (?:best|winner|right answer)\b/i,
  /\bthere(?:'s| is) no (?:best|winner|right answer|wrong answer)\b/i,
  /\ball (?:three|four) (?:can|do|work)\b/i,
  /\bdepends entirely on\b/i,
  /\beach (?:one )?(?:has|earns)\b[^.]{0,40}\b(?:merits|its keep|a place)\b/i,
];

/** A claim that getting this wrong is lethal. */
const FATAL_CLAIM = [
  /\bkills? (?:you|me|us|your crew)\b/i, /\bdeadly\b/i, /\bfatal\b/i,
  /\b(?:you|they) (?:will )?die\b/i, /\bdeath\b/i, /\bkilled\b/i,
  /\blethal\b/i,
];
const FATAL_SUPPORT = [
  "fatal", "fatality", "death", "died", "killed", "drown", "lethal",
  "life threatening", "lose your life", "man overboard", "sinks",
  "sank", "capsize",
];

function anyMatch(patterns: RegExp[], text: string): RegExp | null {
  return patterns.find((re) => re.test(text)) ?? null;
}

function containsForm(haystack: string, form: string): boolean {
  return new RegExp(`\\b${normalize(form)}`, "u").test(haystack);
}

// ── Result ─────────────────────────────────────────────────────────────────

export type ClaimKind = "performed" | "winner" | "fatal";

export interface ClaimViolation {
  kind: ClaimKind;
  /** The pattern that fired, for review. */
  matched: string;
  reason: string;
}

export interface ClaimCheck {
  ok: boolean;
  violations: ClaimViolation[];
  reason: string;
}

/**
 * Does the script support the claims this piece of metadata makes?
 *
 * `claim` is normally one SHORT string — a thumbnail headline, a subtext, a
 * chapter label, a tag. `evidence` should be the FULL narration, not a summary:
 * every stance this checks for lives in the body of the script, and the hook
 * plus segment titles (all the WC thumbnail stage used to receive) contains
 * none of it.
 *
 * `kinds` narrows which classes apply, and long prose needs it. A 400-word
 * description legitimately contains "the most common mistake" and "picking the
 * wrong mount", so running the winner check over one would reject ordinary
 * marketing copy; "tested" and "deadly" in that same copy are still specific
 * assertions worth blocking. Short fields get all three.
 */
export function checkMetadataClaim(
  claim: string,
  evidence: string,
  kinds: ClaimKind[] = ["performed", "winner", "fatal"],
): ClaimCheck {
  const performed = performedEvidence(evidence);
  const nPerformed = normalize(performed);
  const violations: ClaimViolation[] = [];

  const perf = kinds.includes("performed") ? anyMatch(PERFORMED_CLAIM, claim) : null;
  if (perf && !PERFORMED_SUPPORT.some((s) => containsForm(nPerformed, s))) {
    violations.push({
      kind: "performed",
      matched: perf.source,
      reason: "claims work was performed; the script only promises it, or never mentions it",
    });
  }

  const win = kinds.includes("winner") ? anyMatch(WINNER_CLAIM, claim) : null;
  const stance = anyMatch(NO_WINNER_STANCE, evidence);
  if (win && stance) {
    violations.push({
      kind: "winner",
      matched: win.source,
      reason: `names a winner the script declines to name (script says: ${stance.source})`,
    });
  }

  const fatal = kinds.includes("fatal") ? anyMatch(FATAL_CLAIM, claim) : null;
  if (fatal && !FATAL_SUPPORT.some((s) => containsForm(normalize(evidence), s))) {
    violations.push({
      kind: "fatal",
      matched: fatal.source,
      reason: "asserts a lethal consequence the script never claims",
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    reason: violations.length === 0
      ? "no unsupported claim"
      : violations.map((v) => `${v.kind}: ${v.reason}`).join("; "),
  };
}

// ── Unresolved placeholders ────────────────────────────────────────────────

/**
 * Bracketed tokens that are template scaffolding, not prose.
 *
 * The WC SEO prompt asked for "[Product Name]: [AFFILIATE_LINK_placeholder]"
 * and the model complied literally, so 33 of those strings shipped in 8 of 10
 * descriptions in one batch. The prompt no longer asks for them; this exists
 * because "the prompt no longer asks" is not a guarantee, and a published
 * description is not revisable without an API write.
 *
 * Matched on SCAFFOLDING WORDS, not on shape. The first version of this matched
 * any bracketed ALL-CAPS token, which also swallows `[NEW_OWNER]` — the pillar
 * prefix every WC topic-library summary carries. A screen that eats the
 * channel's own taxonomy is worse than the leak it prevents, so the list is
 * explicit and additions are cheap.
 *
 * Ordinary bracketed prose — "[NEW_OWNER]", "[1]" citations, "[sic]" — is left
 * alone.
 */
const PLACEHOLDER_SOURCE =
  String.raw`\[[^\]]{0,60}?(?:AFFILIATE|PLACEHOLDER|TODO|TBD|FIXME|INSERT[_\s]|YOUR[_\s]|LINK[_\s]?HERE|URL[_\s]?HERE|XXX+)[^\]]{0,60}?\]|\{\{[^}]{1,80}\}\}`;

/**
 * Two instances, deliberately. A `/g` regex carries `lastIndex` across calls,
 * so reusing one for both `.test()` in a loop and `.replace()` skips matches
 * nondeterministically depending on where the previous call stopped.
 */
const PLACEHOLDER_ALL = () => new RegExp(PLACEHOLDER_SOURCE, "gi");
const PLACEHOLDER_ONE = new RegExp(PLACEHOLDER_SOURCE, "i");

/** Every unresolved placeholder in `text`, in order, deduplicated. */
export function findPlaceholders(text: string): string[] {
  return [...new Set(text.match(PLACEHOLDER_ALL()) ?? [])];
}

/**
 * Remove unresolved placeholders and any list scaffolding left holding them.
 *
 * A description line is "- Tinned Marine-Grade Wire (14 AWG): [AFFILIATE_LINK_placeholder]".
 * Deleting only the token leaves a dangling "- Product:" that reads worse than
 * the placeholder did, so a line whose only payload was the placeholder is
 * dropped whole, and a section heading left with no items goes with it.
 */
export function stripPlaceholders(text: string): string {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (!PLACEHOLDER_ONE.test(line)) { kept.push(line); continue; }
    const remainder = line.replace(PLACEHOLDER_ALL(), "").replace(/[\s:–—-]+$/u, "").trim();
    // "- Product Name:" with the link removed carries no information.
    if (/^[-*•\s]*$/u.test(remainder)) continue;
    kept.push(remainder);
  }

  // Drop a "GEAR MENTIONED..." style heading that now introduces nothing.
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i]!;
    const isHeading = /^[A-Z][A-Z\s]{4,}:$/.test(line.trim());
    if (isHeading) {
      const next = kept.slice(i + 1).find((l) => l.trim().length > 0);
      if (!next || /^[A-Z][A-Z\s]{4,}:$/.test(next.trim())) continue;
    }
    out.push(line);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Disallowed-term screen on generated output ─────────────────────────────

export interface DisallowedHit {
  field: string;
  /**
   * The offending excerpt, not the whole field.
   *
   * A 400-word description that matches somewhere reported its first 70
   * characters, which named prose that was perfectly fine and sent the reader
   * hunting. The excerpt is the line the pattern actually hit.
   */
  value: string;
  pattern: string;
}

/**
 * Screen GENERATED metadata against a channel's disallowed-subject list.
 *
 * Wet Circuit screens `WC_LIBRARY_DISALLOWED` when a topic is seeded, and that
 * is where the screen stopped. Nothing looked at what the script and SEO stages
 * then wrote, so a batch shipped a chapter titled "Trolling Motor Mount — The
 * Kayak and Bass Angler's Best Friend" plus `#kayakfishing` and a "kayak
 * fishing gear" tag on a channel whose seed gate blocks `/\bkayak/i`. The terms
 * were in the SEO prompt's own hashtag pool and tag examples, so the topic gate
 * was never the thing that failed.
 *
 * The pattern list is injected rather than defined here: the list is
 * channel-editorial (marine craft types for WC), the screen is not.
 */
export function screenDisallowed(
  fields: Record<string, string | string[] | undefined | null>,
  patterns: RegExp[],
): DisallowedHit[] {
  const hits: DisallowedHit[] = [];
  for (const [field, raw] of Object.entries(fields)) {
    if (raw == null) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (!value) continue;
      for (const re of patterns) {
        // A hashtag has no word boundary before "kayak" in "#kayakfishing",
        // so screen a space-separated form alongside the raw value.
        const spaced = value.replace(/[#_]+/g, " ");
        if (re.test(value) || re.test(spaced)) {
          // Report the line that actually matched, so a multi-line description
          // points at its own offending line rather than its opening sentence.
          const line = value.split("\n").find(
            (l) => re.test(l) || re.test(l.replace(/[#_]+/g, " ")),
          ) ?? value;
          hits.push({ field, value: line.trim().slice(0, 120), pattern: re.source });
          break;
        }
      }
    }
  }
  return hits;
}

/** Drop the entries a disallowed pattern matches. Used for tags and hashtags. */
export function dropDisallowed(values: string[], patterns: RegExp[]): string[] {
  return values.filter((v) =>
    !patterns.some((re) => re.test(v) || re.test(v.replace(/[#_]+/g, " "))),
  );
}
