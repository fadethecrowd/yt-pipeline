import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  scoreRelevance, classifyConcept, AI_SUBJECTS, MARINE_SUBJECTS,
  REJECT_THRESHOLD, MAX_CONCEPT_SHARE, MIN_DISTINCT_CONCEPTS,
} from "@yt-pipeline/pipeline-core";

/**
 * Why two unrelated AI Doom scripts both projected ~50% "factory".
 *
 * The taxonomy is not only a label — it is the de facto relevance filter.
 * `scoreRelevance` awards up to 0.75 for subject evidence and only 0.39 for
 * agreeing with the prompt and narration, against a 0.25 reject threshold, so
 * an asset matching NO taxonomy term is almost always rejected. A gap in
 * coverage is therefore not a missing label, it is a rejection.
 *
 * Measured on the two refused candidates: 70 of 74 rejected assets were
 * rejected as "none", and they were exactly the footage the prompts asked for
 * — library aisles, newspaper printing, call centres, office floors. The only
 * bucket that could still name ordinary workplace B-roll was `factory`, whose
 * terms ("industrial", "warehouse", "logistics", "manufacturing", "conveyor")
 * cover a huge share of stock descriptions. So the acceptable pool collapsed
 * into factory: 29.3% of returned candidates became 81.0% of the survivors.
 *
 * The fixtures below are REAL Pexels descriptions observed during that
 * diagnostic, not invented examples.
 */

const OCR_NARRATION =
  "Optical character recognition turns scanned documents and paperwork into text.";
const OCR_PROMPT =
  "A university library archive room with a researcher turning pages of documents";

const INDUSTRIAL_NARRATION =
  "Robots now run the assembly line inside modern manufacturing plants.";
const INDUSTRIAL_PROMPT =
  "A manufacturing plant floor with automated assembly line machinery";

const ai = (description: string, narration: string, prompt: string) =>
  scoreRelevance({ channel: "ai-doom-scroll" as never, narration, prompt, description });

// ── The bug: on-topic footage was rejected for being unnameable ───────────

describe("knowledge-work footage is recognised instead of discarded", () => {
  /** Every one of these was REJECTED as "none" before the taxonomy gained coverage. */
  const PREVIOUSLY_REJECTED = [
    "cozy library aisle with bookshelves",
    "high speed newspaper printing process close up",
    "a girl studying in the library",
  ];

  /**
   * Office/call-centre footage came from the OCR script's post-office and
   * customs beats, not from this library-archive one. Beat-level scoring now
   * judges each against its OWN beat, so they are listed separately rather
   * than asserted against a beat they never belonged to.
   */
  const PREVIOUSLY_REJECTED_WORKPLACE = [
    "people working in a call center",
    "busy office environment in bangladesh",
  ];
  const WORKPLACE_BEAT = {
    narration: "Clerks in a busy back office sort stacks of paperwork by hand all day.",
    prompt: "A busy open-plan office where staff process paper forms at their desks",
  };

  test("it is accepted rather than rejected", () => {
    for (const d of PREVIOUSLY_REJECTED) {
      const r = ai(d, OCR_NARRATION, OCR_PROMPT);
      assert.notEqual(r.verdict, "REJECT",
        `"${d}" is exactly what the prompt asked for and must survive relevance`);
      assert.ok(r.score >= REJECT_THRESHOLD, `${d} scored ${r.score}`);
    }
  });

  test("workplace footage survives on a workplace beat", () => {
    for (const d of PREVIOUSLY_REJECTED_WORKPLACE) {
      const r = ai(d, WORKPLACE_BEAT.narration, WORKPLACE_BEAT.prompt);
      assert.notEqual(r.verdict, "REJECT", `${d} scored ${r.score}`);
      assert.ok(["workplace", "documents"].includes(r.concept), `${d} → ${r.concept}`);
    }
  });

  test("it is filed under what it actually shows, not under factory", () => {
    for (const d of PREVIOUSLY_REJECTED) {
      const c = ai(d, OCR_NARRATION, OCR_PROMPT).concept;
      assert.ok(["documents", "workplace", "research"].includes(c),
        `"${d}" classified as ${c}`);
      assert.notEqual(c, "factory");
    }
  });

  test("a document-heavy script no longer reads as an industrial one", () => {
    // The five fixtures above are the visual substance of the OCR script.
    const concepts = PREVIOUSLY_REJECTED.map((d) => ai(d, OCR_NARRATION, OCR_PROMPT).concept);
    assert.equal(concepts.filter((c) => c === "factory").length, 0,
      "generic knowledge-work narration must not collapse into factory footage");
  });
});

// ── The same defect, one domain further out ───────────────────────────────

describe("outdoor and environmental footage is recognised", () => {
  const EARTH_NARRATION =
    "The model turns satellite imagery into embeddings for tracking deforestation and wildfire.";
  const EARTH_PROMPT =
    "An aerial drone shot above a patchwork of farmland and forest edge showing deforestation";

  /**
   * Real Pexels descriptions returned for the OlmoEarth script's outdoor
   * beats. Every one was REJECTED as "none" before `environment` existed,
   * while "clouds behind flying drone" was ACCEPTED as robotics — so a beat
   * asking for aerial farmland was illustrated with a picture of a drone.
   * Acceptance on those beats ran 17-25% against 50-60% on the indoor beats.
   */
  const PREVIOUSLY_REJECTED_OUTDOOR = [
    "aerial view of expansive rural farmland",
    "serene cornfield sunset with a farmer",
    "wild fire in the forest",
    "aerial view of scenic austrian farmland",
  ];

  test("it survives relevance instead of being discarded", () => {
    for (const d of PREVIOUSLY_REJECTED_OUTDOOR) {
      const r = ai(d, EARTH_NARRATION, EARTH_PROMPT);
      assert.notEqual(r.verdict, "REJECT",
        `"${d}" is what the prompt asked for and must survive`);
      assert.equal(r.concept, "environment", `"${d}" classified as ${r.concept}`);
    }
  });

  test("naming outdoors did not take anything from the industrial concepts", () => {
    // The e-waste/mining story legitimately mixes both; neither may swallow
    // the other.
    assert.equal(ai("aerial view of industrial conveyor belt system",
      INDUSTRIAL_NARRATION, INDUSTRIAL_PROMPT).concept, "factory");
    assert.equal(ai("aerial view of large industrial warehouse facility",
      INDUSTRIAL_NARRATION, INDUSTRIAL_PROMPT).concept, "factory");
  });

  test("environment does not admit unrelated scenery", () => {
    // A landscape with no narration support is still irrelevant.
    assert.equal(
      ai("a dog running on a beach at sunset", OCR_NARRATION, OCR_PROMPT).verdict,
      "REJECT");
  });
});

// ── The thing that must NOT regress: genuine industry ─────────────────────

describe("genuinely industrial narration still uses factory footage heavily", () => {
  const REAL_INDUSTRIAL = [
    "workers in an industrial factory with machinery",
    "efficient assembly line in modern factory",
    "factory conveyor belt",
    "industrial warehouse with glass storage racks",
  ];

  test("it still classifies as factory", () => {
    for (const d of REAL_INDUSTRIAL) {
      const r = ai(d, INDUSTRIAL_NARRATION, INDUSTRIAL_PROMPT);
      assert.equal(r.concept, "factory", `"${d}" must remain factory`);
      assert.notEqual(r.verdict, "REJECT");
    }
  });

  test("it still scores strongly — nothing was taken away from factory", () => {
    for (const d of REAL_INDUSTRIAL) {
      assert.ok(ai(d, INDUSTRIAL_NARRATION, INDUSTRIAL_PROMPT).score >= 0.4, d);
    }
  });

  test("factory's own vocabulary is untouched", () => {
    assert.deepEqual(AI_SUBJECTS.factory, [
      "factory", "assembly line", "warehouse", "manufacturing", "industrial",
      "conveyor", "logistics", "production line",
    ], "the fix adds coverage elsewhere; it must never narrow factory");
  });
});

// ── Relevance was not traded away for diversity ───────────────────────────

describe("diversity is not manufactured by lowering the bar", () => {
  test("the reject threshold is unchanged", () => {
    assert.equal(REJECT_THRESHOLD, 0.25);
  });

  test("genuinely irrelevant footage is still rejected", () => {
    for (const d of [
      "a man eating a sandwich in a park",
      "glowing abstract particles in digital space",
      "a dog running on a beach at sunset",
    ]) {
      assert.equal(ai(d, OCR_NARRATION, OCR_PROMPT).verdict, "REJECT", d);
    }
  });

  test("no randomness or jitter was introduced — scoring is deterministic", () => {
    const once = ai("cozy library aisle with bookshelves", OCR_NARRATION, OCR_PROMPT);
    for (let i = 0; i < 5; i++) {
      const again = ai("cozy library aisle with bookshelves", OCR_NARRATION, OCR_PROMPT);
      assert.equal(again.score, once.score);
      assert.equal(again.concept, once.concept);
    }
    const src = readFileSync("packages/pipeline-core/src/lib/visualRelevance.ts", "utf8");
    assert.ok(!/Math\.random/.test(src), "relevance must never be randomised");
  });
});

// ── The specific false positive that was provable ─────────────────────────

describe("a bare 'terminal' no longer makes an airport into software", () => {
  test("an airport terminal is not software", () => {
    assert.notEqual(
      classifyConcept("modern airport terminal with travelers", AI_SUBJECTS).concept,
      "software");
  });

  test("a shell is still software", () => {
    assert.equal(
      classifyConcept("developer typing in a terminal window on a laptop", AI_SUBJECTS).concept,
      "software");
  });
});

// ── The gate itself is unchanged ──────────────────────────────────────────

describe("feasibility enforcement is untouched", () => {
  test("the cap constant and diversity floor are unchanged", () => {
    // The cap was RETIRED FOR AI DOOM by policy on 2026-08-13, not by moving
    // the number: Wet Circuit still enforces exactly 40%. Which channel
    // enforces it is pinned in tests/feasibility-policy.test.ts.
    assert.equal(MAX_CONCEPT_SHARE, 0.4);
    assert.equal(MIN_DISTINCT_CONCEPTS, 3);
    const vf = readFileSync("packages/pipeline-core/src/lib/visualFeasibility.ts", "utf8");
    assert.match(vf, /export const MAX_CONCEPT_SHARE = 0\.4;/);
    assert.match(vf, /policy\.enforceDominantConceptCap/,
      "enforcement must be a stated per-channel policy");
    assert.match(vf, /\(conceptBreakdown\[0\]\?\.share \?\? 0\) <= MAX_CONCEPT_SHARE/,
      "where enforced, the cap still applies to the largest bucket of any kind");
  });

  test("the replay of the known-good and known-bad candidates is recorded", () => {
    // Documented outcomes of scripts/replay-feasibility.ts against durable
    // scripts, so the calibration claim is auditable rather than remembered:
    //   OK-2  AMrrTvdL2tI  factory 37.9%  PASS   (published — must keep passing)
    //   HBM   uVQ-vcJHWNk  compute 42.6%  FAIL   (human-rejected — must keep failing)
    // Both are re-runnable with `npx tsx scripts/replay-feasibility.ts`.
    const replay = readFileSync("scripts/replay-feasibility.ts", "utf8");
    assert.match(replay, /assessVisualFeasibility/);
    assert.ok(!/prisma\.video\.update|\.create\(/.test(replay),
      "the replay harness must never mutate a candidate");
  });
});

// ── Wet Circuit is untouched ──────────────────────────────────────────────

describe("Wet Circuit behaviour is unchanged", () => {
  test("the marine taxonomy is byte-for-byte what it was", () => {
    assert.deepEqual(Object.keys(MARINE_SUBJECTS),
      ["vessel", "electronics", "water", "fishing", "install"]);
    assert.deepEqual(MARINE_SUBJECTS.vessel,
      ["boat", "yacht", "vessel", "hull", "kayak", "ship", "sailboat", "dinghy"]);
    assert.deepEqual(MARINE_SUBJECTS.electronics,
      ["sonar", "radar", "chartplotter", "fishfinder", "transducer", "display",
       "instrument", "gauge", "screen", "antenna", "gps"]);
  });

  test("WC scoring reads the marine taxonomy, never the AI one", () => {
    const r = scoreRelevance({
      channel: "wet-circuit" as never,
      narration: "The boat's sonar and chartplotter guide the vessel.",
      prompt: "A yacht on the water with marine electronics",
      description: "marine chartplotter display on a helm",
    });
    assert.equal(r.concept, "electronics");
    assert.equal(r.verdict, "STRONG");
    // The new AI concepts must be unreachable from the marine channel.
    for (const c of ["workplace", "documents"]) {
      assert.ok(!Object.keys(MARINE_SUBJECTS).includes(c),
        `${c} must not leak into Wet Circuit`);
    }
  });

  test("a marine asset is not reclassified by the new AI concepts", () => {
    // "office" and "document" vocabulary must not touch a marine description.
    const r = scoreRelevance({
      channel: "wet-circuit" as never,
      narration: "Installing the new display at the helm station.",
      prompt: "Boat wiring installation in a workshop",
      description: "boat workshop with tools and cable installation",
    });
    assert.equal(r.concept, "install");
  });
});
