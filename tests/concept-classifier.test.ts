import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyConcept, AI_SUBJECTS } from "../packages/pipeline-core/src/lib/visualRelevance";

/**
 * Concept-classification fixtures.
 *
 * The ai1r qualification plan reported software at 51% and failed the 40% cap.
 * 42s of that was control-room surveillance footage misfiled as software:
 * matching was raw substring against a space-padded string, so "monitoring"
 * matched the software term "monitor" and "screens" matched "screen". Ties
 * then fell to whichever concept was declared first, and software sits above
 * surveillance in AI_SUBJECTS — so surveillance could never win.
 *
 * These fixtures pin both directions: monitoring environments must read as
 * surveillance, and genuine software imagery must still read as software.
 */

const classify = (d: string) => classifyConcept(d, AI_SUBJECTS).concept;

describe("surveillance is not swallowed by software", () => {
  // The exact descriptions observed in the failed ai1r plan.
  const observed = [
    "traffic control room with monitoring screens",
    "modern control room monitoring operations",
    "high tech control room with traffic monitoring",
    "high tech control room monitoring operations",
    "high tech control room for traffic monitoring",
  ];

  for (const d of observed) {
    test(`"${d}" → surveillance`, () => {
      assert.equal(classify(d), "surveillance");
    });
  }

  test("all five together no longer count as software", () => {
    assert.equal(observed.filter((d) => classify(d) === "software").length, 0);
    assert.equal(observed.filter((d) => classify(d) === "surveillance").length, 5);
  });

  const alsoSurveillance = [
    "cctv camera mounted on a building",
    "security camera in a retail store",
    "video wall in a security operations center",
    "bank of surveillance monitors",
    "closed circuit television display",
  ];
  for (const d of alsoSurveillance) {
    test(`"${d}" → surveillance`, () => assert.equal(classify(d), "surveillance"));
  }
});

describe("genuine software imagery is still software", () => {
  const software = [
    "a computer code running on screen",
    "downloading python packages on terminal screen",
    "terminal screen with python package installation",
    "close up of computer screen code display",
    "dynamic code display on computer screen",
    "software developer",
    "programming on a laptop",
    "application dashboard interface",
  ];
  for (const d of software) {
    test(`"${d}" → software`, () => assert.equal(classify(d), "software"));
  }
});

describe("no accidental substring matches", () => {
  test('"monitoring" does not match the software token "monitor"', () => {
    // Surveillance-only vocabulary: if "monitor" still matched, software would score.
    const m = classifyConcept("monitoring operations", AI_SUBJECTS);
    assert.equal(m.concept, "surveillance");
    assert.ok(!m.matched.includes("monitor"), "must not match the bare token 'monitor'");
  });

  test('"screens" folds to "screen" but only as a whole token', () => {
    assert.equal(classify("code on screens"), "software");
  });

  test("a longer word never matches a shorter term by prefix", () => {
    // "codebase"/"networking" must not match "code"/"network".
    const a = classifyConcept("codebase archaeology", AI_SUBJECTS);
    assert.ok(!a.matched.includes("code"), '"codebase" must not match "code"');
    const b = classifyConcept("networking event", AI_SUBJECTS);
    assert.ok(!b.matched.includes("network"), '"networking" must not match "network"');
  });
});

describe("evidence ordering is explicit, not declaration order", () => {
  test("a multiword phrase outranks a single generic token", () => {
    // "control room" (phrase, surveillance) beats "screen" (token, software).
    const m = classifyConcept("control room with screens", AI_SUBJECTS);
    assert.equal(m.concept, "surveillance");
  });

  test("scores reflect specificity weighting", () => {
    const m = classifyConcept("security camera", AI_SUBJECTS);
    assert.equal(m.concept, "surveillance");
    assert.ok(m.score >= 3, "a two-word phrase must weigh more than one token");
  });

  test("a genuine tie resolves to ambiguous rather than the first key", () => {
    // One single-token hit for each of two concepts, equal specificity.
    const m = classifyConcept("robot server", AI_SUBJECTS);
    assert.equal(m.concept, "ambiguous");
  });

  test("no match returns none", () => {
    assert.equal(classify("a bowl of soup"), "none");
  });
});

describe("thresholds are untouched by this change", () => {
  test("MAX_CONCEPT_SHARE is still 0.40", async () => {
    const { MAX_CONCEPT_SHARE, MIN_DISTINCT_CONCEPTS } = await import(
      "../packages/pipeline-core/src/lib/visualFeasibility"
    );
    assert.equal(MAX_CONCEPT_SHARE, 0.4);
    assert.equal(MIN_DISTINCT_CONCEPTS, 3);
  });
});
