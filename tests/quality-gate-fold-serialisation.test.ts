import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { Script } from "@yt-pipeline/pipeline-core";
import { buildScoringPayload } from "../src/stages/qualityGate";

/**
 * The quality scorer must be shown the script that will be NARRATED, not the
 * intermediate object that still carries the fields folding copied from.
 *
 * Since the Aug 2026 fold reorder, `foldHookAndCtaIntoSegments` runs last and
 * is the single origin of hook and CTA text: it prepends the hook into
 * `segments[0].narration` and appends the CTA to the final segment, and leaves
 * `script.hook` / `script.cta` in place. `buildSpokenUnits` then narrates each
 * segment once, so the audio contains the hook exactly once.
 *
 * `JSON.stringify(script)` of that object contains it TWICE. Run 292d7cd2
 * (video cmtnc1mlk002qmby29mic5n6p) scored 79/100 and lost marks on two
 * dimensions for an opening "repeated verbatim as the first segment narration".
 * A human reviewed the render: there is no audible duplication. The scorer was
 * reading the payload correctly and the payload was lying.
 *
 * The correction is narrow on purpose. A field is dropped ONLY when its segment
 * provably already contains it — the exact co-occurrence folding creates. The
 * detector must survive: losing the ability to see a real repeat is worse than
 * the false positive, because that is the e704334a failure class, which shipped
 * a video whose opening was read twice.
 *
 * These tests fix both halves. If someone reverts to serialising the raw object
 * the first case fails; if someone "simplifies" by stripping hook and CTA
 * unconditionally, the genuine-duplication cases fail.
 */

const HOOK = "There's a new acronym spreading across the internet, and it is going to hit you right in the gut.";
const CTA = "Drop a comment below and subscribe so you don't miss what comes next.";
const BODY0 = "So let's get precise about the definition and where the term actually came from.";
const BODY1 = "By August 18th the post had climbed to number one, pulling more than six hundred comments.";

const seg = (i: number, narration: string) => ({
  segmentIndex: i,
  title: `Segment ${i}`,
  narration,
  visual_prompt: "a factory floor",
  duration_seconds: 60,
});

/** The shape folding produces: hook inlined into segment 0, CTA into the last. */
function folded(): Script {
  return {
    hook: HOOK,
    cta: CTA,
    estimatedTotalDuration: 420,
    segments: [seg(0, `${HOOK} ${BODY0}`), seg(1, `${BODY1} ${CTA}`)],
  } as unknown as Script;
}

/** A pre-fold script: hook and CTA live only in their own fields. */
function preFold(): Script {
  return {
    hook: HOOK,
    cta: CTA,
    estimatedTotalDuration: 420,
    segments: [seg(0, BODY0), seg(1, BODY1)],
  } as unknown as Script;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  const escaped = JSON.stringify(needle)
    .slice(1, -1)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (haystack.match(new RegExp(escaped, "g")) ?? []).length;
}

describe("the scorer sees folded hook and CTA exactly once", () => {
  test("a folded script presents the hook once, not twice", () => {
    const { json, foldedHook } = buildScoringPayload(folded());

    assert.equal(foldedHook, true, "segment 0 contains the hook, so it is folded");
    assert.equal(
      occurrences(json, HOOK), 1,
      "the hook must appear exactly once — as the head of segments[0].narration",
    );
    assert.equal(
      occurrences(JSON.stringify(folded(), null, 2), HOOK), 2,
      "guard: the raw object really does carry it twice, which is what this fixes",
    );
  });

  test("a folded script presents the CTA once, not twice", () => {
    const { json, foldedCta } = buildScoringPayload(folded());

    assert.equal(foldedCta, true);
    assert.equal(occurrences(json, CTA), 1);
  });

  test("the narration the model scores is byte-identical to what will be spoken", () => {
    const script = folded();
    const parsed = JSON.parse(buildScoringPayload(script).json);

    assert.equal(parsed.segments.length, script.segments.length);
    for (const [i, s] of script.segments.entries()) {
      assert.equal(
        parsed.segments[i].narration, s.narration,
        `segment ${i} narration must not be rewritten for scoring`,
      );
    }
  });

  test("an unfolded script is serialised exactly as before", () => {
    const script = preFold();
    const { json, foldedHook, foldedCta } = buildScoringPayload(script);

    assert.equal(foldedHook, false, "segment 0 does not contain the hook");
    assert.equal(foldedCta, false);
    assert.equal(
      json, JSON.stringify(script, null, 2),
      "with nothing folded the payload must be unchanged from the old behaviour",
    );
  });
});

describe("genuine duplication is still visible to the scorer", () => {
  test("a hook written into the body a second time still appears twice", () => {
    // The model wrote the hook line into segment 0's body as well, and folding
    // then prepended the field copy. This is real: it is narrated twice.
    const script = {
      hook: HOOK,
      cta: CTA,
      estimatedTotalDuration: 420,
      segments: [seg(0, `${HOOK} ${BODY0} ${HOOK}`), seg(1, `${BODY1} ${CTA}`)],
    } as unknown as Script;

    const { json } = buildScoringPayload(script);
    assert.equal(
      occurrences(json, HOOK), 2,
      "dropping the field must not hide a second copy living in the narration",
    );
  });

  test("a hook repeated as its own segment still appears twice", () => {
    const script = {
      hook: HOOK,
      cta: CTA,
      estimatedTotalDuration: 420,
      segments: [seg(0, `${HOOK} ${BODY0}`), seg(1, HOOK), seg(2, `${BODY1} ${CTA}`)],
    } as unknown as Script;

    const { json } = buildScoringPayload(script);
    assert.equal(
      occurrences(json, HOOK), 2,
      "a duplicate segment is untouched by the fold-aware view",
    );
  });

  test("a CTA duplicated in the body still appears twice", () => {
    const script = {
      hook: HOOK,
      cta: CTA,
      estimatedTotalDuration: 420,
      segments: [seg(0, `${HOOK} ${BODY0}`), seg(1, `${CTA} ${BODY1} ${CTA}`)],
    } as unknown as Script;

    const { json } = buildScoringPayload(script);
    assert.equal(occurrences(json, CTA), 2);
  });

  test("a partially folded hook keeps its field, so the repeat stays visible", () => {
    // enforceScriptLength trimmed the inlined hook to a prefix. buildSpokenUnits
    // would re-add the whole hook, so this IS spoken twice — the e704334a shape.
    const script = {
      hook: HOOK,
      cta: CTA,
      estimatedTotalDuration: 420,
      segments: [seg(0, `${HOOK.slice(0, 40)} ${BODY0}`), seg(1, `${BODY1} ${CTA}`)],
    } as unknown as Script;

    const { json, foldedHook } = buildScoringPayload(script);
    assert.equal(foldedHook, false, "a prefix is not containment — the field is kept");
    assert.ok(
      json.includes(JSON.stringify(HOOK).slice(1, -1)),
      "the full hook is still in the payload for the scorer to compare against",
    );
  });
});
