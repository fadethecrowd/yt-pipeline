import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyConcept, MARINE_SUBJECTS, AI_SUBJECTS,
  MAX_CONCEPT_SHARE, MIN_DISTINCT_CONCEPTS,
} from "@yt-pipeline/pipeline-core";
import type { FeasibilityReport } from "@yt-pipeline/pipeline-core";
import {
  tieAwareConceptAccounting, tieAwareChecks,
} from "../packages/wc-pipeline/src/stages/conceptAccounting";

/**
 * Wet Circuit divides a tied fragment between the concepts that tied.
 *
 * Production previously filed every tie as "none", so "sailboat sailing in
 * lake at dawn" counted as footage with no recognisable subject. A replay of
 * both failed candidates showed 100% of their "none" seconds were ties of this
 * kind. These tests pin the corrected accounting and, just as importantly,
 * that splitting never invents or loses a second.
 */

// ── Fixture builder ──────────────────────────────────────────────────────

let nextId = 1;
function frag(description: string, durationS: number, concept = "none") {
  return {
    assetId: `a${nextId++}`,
    description,
    durationS,
    relevanceScore: 0.9,
    verdict: "ACCEPTABLE",
    concept,
    brandRisk: false,
  };
}

function reportWith(
  fragments: { assetId: string; description: string; durationS: number; relevanceScore: number; verdict: string; concept: string; brandRisk: boolean }[],
): FeasibilityReport {
  return {
    topic: "fixture", channel: "wet-circuit", targetRuntimeS: 280,
    plannedVisualDurationS: 276, expectedBeatCount: fragments.length,
    searchQueries: [], totalCandidates: 0, relevantCandidates: 0,
    strongCandidates: 0, acceptableCandidates: 0, genericCandidates: 0,
    rejectedCandidates: 0, brandRiskCandidates: 0,
    uniqueUsableAssets: 0, uniqueUsableAssetsExcludingBrandRisk: 0,
    totalUsableDurationS: 0, minUniqueAssetsRequired: 0, requiredPoolWithSafety: 0,
    conceptBreakdown: [], distinctConcepts: 0,
    predictedBeats: fragments.map((f, i) => ({
      index: i + 1, startS: 0, endS: f.durationS, durationS: f.durationS,
      narration: "n", segmentIndex: 0, fragments: [f], cardSecondsS: 0, hasCard: false,
    })),
    estimatedCardCount: 0, estimatedCardPct: 0, estimatedConsecutiveCardRisk: 0,
    checks: [
      { name: "fallback-card-share", ok: true, detail: "" },
      { name: "no-consecutive-cards", ok: true, detail: "" },
      { name: "unique-assets-cover-timeline", ok: true, detail: "" },
      { name: "pool-safety-margin", ok: true, detail: "" },
      { name: "usable-duration-margin", ok: true, detail: "" },
      { name: "brand-risk-not-load-bearing", ok: true, detail: "" },
      { name: "concept-diversity", ok: false, detail: "SHARED" },
      { name: "no-dominant-concept", ok: false, detail: "SHARED" },
    ],
    pass: false, failureReason: "shared",
  } as FeasibilityReport;
}

const acc = (fragments: Parameters<typeof reportWith>[0]) =>
  tieAwareConceptAccounting(reportWith(fragments));

// ── Slug fixtures, verified against the real classifier ──────────────────

describe("fixture slugs classify as intended", () => {
  test("single-concept slug wins outright", () => {
    assert.equal(classifyConcept("a fishing rod and reel", MARINE_SUBJECTS).concept, "fishing");
  });
  test("vessel+water slug ties", () => {
    const r = classifyConcept("a boat on the water", MARINE_SUBJECTS);
    assert.equal(r.concept, "ambiguous");
    assert.deepEqual([...(r.tied ?? [])].sort(), ["vessel", "water"]);
  });
  test("a three-way tie is possible and fully enumerated", () => {
    const r = classifyConcept("a boat on the water with a sonar", MARINE_SUBJECTS);
    assert.equal(r.concept, "ambiguous");
    assert.deepEqual([...(r.tied ?? [])].sort(), ["electronics", "vessel", "water"]);
  });
  test("electronics+install slug ties", () => {
    const r = classifyConcept("a gauge and some wiring", MARINE_SUBJECTS);
    assert.equal(r.concept, "ambiguous");
    assert.deepEqual([...(r.tied ?? [])].sort(), ["electronics", "install"]);
  });
  test("a genuinely unrecognisable slug matches nothing", () => {
    assert.equal(classifyConcept("a person holding a white box", MARINE_SUBJECTS).concept, "none");
  });
});

// ── 1–4. The four accounting rules ───────────────────────────────────────

describe("rule A — a single concrete concept takes the whole fragment", () => {
  test("10 s of fishing → fishing 10", () => {
    const a = acc([frag("a fishing rod and reel", 10)]);
    assert.equal(a.conceptSeconds.fishing, 10);
    assert.equal(a.denominatorSeconds, 10);
    assert.equal(a.fragments[0].outcome, "SINGLE");
  });
});

describe("rule B — N tied concepts split the fragment evenly", () => {
  test("10 s vessel+water → vessel 5, water 5", () => {
    const a = acc([frag("a boat on the water", 10)]);
    assert.equal(a.conceptSeconds.vessel, 5);
    assert.equal(a.conceptSeconds.water, 5);
    assert.equal(a.denominatorSeconds, 10, "splitting must not change the total");
    assert.equal(a.fragments[0].outcome, "TIE");
    assert.deepEqual([...a.fragments[0].tiedConcepts].sort(), ["vessel", "water"]);
  });

  test("12 s electronics+install → 6 and 6", () => {
    const a = acc([frag("a gauge and some wiring", 12)]);
    assert.equal(a.conceptSeconds.electronics, 6);
    assert.equal(a.conceptSeconds.install, 6);
    assert.equal(a.denominatorSeconds, 12);
  });

  test("12 s three-way tie → 4, 4, 4", () => {
    const a = acc([frag("a boat on the water with a sonar", 12)]);
    assert.equal(a.conceptSeconds.vessel, 4);
    assert.equal(a.conceptSeconds.water, 4);
    assert.equal(a.conceptSeconds.electronics, 4);
    assert.equal(a.denominatorSeconds, 12);
    assert.equal(a.fragments[0].tiedConcepts.length, 3);
  });

  test("a fragment's own allocation sums to its duration", () => {
    for (const [slug, dur] of [
      ["a boat on the water", 10],
      ["a boat on the water with a sonar", 12],
      ["a gauge and some wiring", 7],
      ["a fishing rod and reel", 9],
    ] as const) {
      const a = acc([frag(slug, dur)]);
      const sum = Object.values(a.fragments[0].allocation).reduce((x, y) => x + y, 0);
      assert.ok(Math.abs(sum - dur) < 1e-9, `${slug}: allocation ${sum} != ${dur}`);
    }
  });
});

describe("rule C — no match at all is genuine none", () => {
  test("10 s unrecognisable → none 10", () => {
    const a = acc([frag("a person holding a white box", 10)]);
    assert.equal(a.conceptSeconds.none, 10);
    assert.equal(a.genuineNoneSeconds, 10);
    assert.equal(a.fragments[0].outcome, "GENUINE_NONE");
  });
});

describe("rule D — ambiguous is never a concentration bucket", () => {
  test("no bucket named ambiguous appears for a concrete tie", () => {
    const a = acc([
      frag("a boat on the water", 20),
      frag("a gauge and some wiring", 20),
    ]);
    assert.equal(a.conceptSeconds.ambiguous, undefined,
      "a known tie must be divided, never bucketed as ambiguous");
    assert.ok(!a.concreteConcepts.includes("ambiguous"));
    assert.ok(!Object.keys(a.conceptShares).includes("ambiguous"));
  });

  test("unrelated tie pairs are not merged into one category", () => {
    const a = acc([
      frag("a boat on the water", 20),        // vessel+water
      frag("a gauge and some wiring", 20),    // electronics+install
    ]);
    assert.equal(a.conceptSeconds.vessel, 10);
    assert.equal(a.conceptSeconds.water, 10);
    assert.equal(a.conceptSeconds.electronics, 10);
    assert.equal(a.conceptSeconds.install, 10);
    assert.equal(a.distinctConcreteConcepts, 4,
      "four real categories, not one artificial 'ambiguous' block");
  });
});

// ── 5–6. Conservation of duration ────────────────────────────────────────

describe("splitting conserves the timeline exactly", () => {
  const mixed = [
    frag("a fishing rod and reel", 11),                  // SINGLE
    frag("a boat on the water", 10),                     // 2-way
    frag("a boat on the water with a sonar", 12),        // 3-way
    frag("a gauge and some wiring", 7),                  // 2-way
    frag("a person holding a white box", 5),             // none
  ];
  const projected = 11 + 10 + 12 + 7 + 5;

  test("allocated seconds equal the projected denominator", () => {
    const a = acc(mixed);
    assert.ok(Math.abs(a.denominatorSeconds - projected) < 1e-9,
      `denominator ${a.denominatorSeconds} != projected ${projected}`);
    const summed = Object.values(a.conceptSeconds).reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(summed - projected) < 1e-9, "concept seconds must sum to the timeline");
  });

  test("shares sum to 1", () => {
    const a = acc(mixed);
    const total = Object.values(a.conceptShares).reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `shares sum to ${total}`);
  });

  test("a tie cannot double-count duration", () => {
    // If splitting duplicated instead of divided, a 3-way tie would inflate
    // the denominator by 2x its duration.
    const one = acc([frag("a boat on the water with a sonar", 30)]);
    assert.equal(one.denominatorSeconds, 30, "30s must stay 30s across three concepts");
    assert.equal(one.conceptSeconds.vessel + one.conceptSeconds.water + one.conceptSeconds.electronics, 30);
  });

  test("every fragment's allocation sums to its own seconds", () => {
    const a = acc(mixed);
    for (const f of a.fragments) {
      const sum = Object.values(f.allocation).reduce((x, y) => x + y, 0);
      assert.ok(Math.abs(sum - f.projectedSeconds) < 1e-9,
        `${f.assetId}: ${sum} != ${f.projectedSeconds}`);
    }
  });
});

// ── 7–9. Gate semantics ──────────────────────────────────────────────────

describe("the unchanged 40% cap is applied to the corrected accounting", () => {
  test("the cap constant is imported, not restated", () => {
    const src = readFileSync("packages/wc-pipeline/src/stages/conceptAccounting.ts", "utf8");
    assert.match(src, /MAX_CONCEPT_SHARE/);
    assert.match(src, /MIN_DISTINCT_CONCEPTS/);
    assert.doesNotMatch(src, /0\.4\b/, "the cap must never be hardcoded");
    assert.equal(MAX_CONCEPT_SHARE, 0.4);
    assert.equal(MIN_DISTINCT_CONCEPTS, 3);
  });

  test("a dominated timeline still fails", () => {
    const a = acc([
      frag("a fishing rod and reel", 90),
      frag("a boat on the water", 10),
    ]);
    assert.ok(a.dominantAnyShare > MAX_CONCEPT_SHARE);
    assert.equal(a.checks.find((c) => c.name === "no-dominant-concept")!.ok, false);
  });

  test("genuine none still participates in the cap", () => {
    const a = acc([
      frag("a person holding a white box", 60),  // none
      frag("a fishing rod and reel", 20),
      frag("a boat on the water", 20),
    ]);
    assert.equal(a.genuineNoneSeconds, 60);
    assert.equal(a.dominantAnyConcept, "none");
    assert.ok(a.dominantAnyShare > MAX_CONCEPT_SHARE);
    assert.equal(a.checks.find((c) => c.name === "no-dominant-concept")!.ok, false,
      "a timeline of unrecognisable footage must still fail");
  });

  test("a genuinely diverse timeline passes both concept checks", () => {
    const a = acc([
      frag("a fishing rod and reel", 25),
      frag("a boat on the water", 25),          // vessel 12.5 water 12.5
      frag("a gauge and some wiring", 25),      // electronics 12.5 install 12.5
      frag("a sonar display screen", 25),       // electronics
    ]);
    assert.ok(a.dominantAnyShare <= MAX_CONCEPT_SHARE,
      `dominant ${a.dominantAnyConcept} ${a.dominantAnyShare}`);
    assert.ok(a.distinctConcreteConcepts >= MIN_DISTINCT_CONCEPTS);
    assert.equal(a.concentrationOk, true);
  });

  test("distinctConcepts counts only concrete concepts with non-zero duration", () => {
    const a = acc([
      frag("a boat on the water", 20),                 // vessel, water
      frag("a person holding a white box", 20),        // none
    ]);
    assert.deepEqual([...a.concreteConcepts].sort(), ["vessel", "water"]);
    assert.equal(a.distinctConcreteConcepts, 2, "none must not earn diversity credit");
    assert.equal(a.checks.find((c) => c.name === "concept-diversity")!.ok, false);
  });

  test("only the two concept checks are replaced; the rest are the gate's own", () => {
    const report = reportWith([frag("a boat on the water", 10)]);
    const merged = tieAwareChecks(report, tieAwareConceptAccounting(report));
    assert.equal(merged.length, report.checks.length, "no check is added or dropped");
    assert.deepEqual(merged.map((c) => c.name), report.checks.map((c) => c.name),
      "order and names are preserved");
    for (const c of merged) {
      if (c.name === "concept-diversity" || c.name === "no-dominant-concept") {
        assert.notEqual(c.detail, "SHARED", `${c.name} must be recomputed`);
      } else {
        assert.equal(c.detail, "", `${c.name} must be the gate's own untouched check`);
      }
    }
  });
});

// ── 10. Evidence retains raw + final ─────────────────────────────────────

describe("evidence retains the raw classifier result alongside the accounting", () => {
  test("a tie records the raw answer, the tie set and the split", () => {
    const a = acc([frag("a boat on the water", 10)]);
    const f = a.fragments[0];
    assert.equal(f.conceptRaw, "ambiguous", "the raw answer is not discarded");
    assert.equal(f.conceptFinal, "none", "production's own label is retained");
    assert.deepEqual([...f.tiedConcepts].sort(), ["vessel", "water"]);
    assert.deepEqual(f.allocation, { vessel: 5, water: 5 });
    assert.ok(f.score > 0, "the score behind the decision is recorded");
    assert.equal(typeof f.longest, "number");
  });

  test("a genuine none is distinguishable from a tie in the evidence", () => {
    const a = acc([
      frag("a person holding a white box", 10),
      frag("a boat on the water", 10),
    ]);
    const none = a.fragments.find((f) => f.outcome === "GENUINE_NONE")!;
    const tie = a.fragments.find((f) => f.outcome === "TIE")!;
    assert.equal(none.conceptRaw, "none");
    assert.equal(none.tiedConcepts.length, 0);
    assert.equal(tie.conceptRaw, "ambiguous");
    assert.ok(tie.tiedConcepts.length > 1);
  });

  test("the evidence facility exposes the tie fields", () => {
    const src = readFileSync("packages/wc-pipeline/src/stages/feasibilityEvidence.ts", "utf8");
    for (const f of ["outcome", "tie", "tiedConcepts", "allocation", "genuineNoneSeconds",
                     "genuineNoneShare", "concreteConcepts", "dominantAnyConcept",
                     "sharedChecks", "sharedConceptBreakdown", "sharedPass"]) {
      assert.match(src, new RegExp(`\\b${f}\\b`), `evidence must carry ${f}`);
    }
  });
});

// ── 12. AI Doom is untouched ─────────────────────────────────────────────

describe("AI Doom classifier and gate behaviour are unchanged", () => {
  test("classifyConcept returns the same concept and score as before for AI subjects", () => {
    // Existing fields keep their exact prior values; `tied`/`longest` are additive.
    const cases: [string, string][] = [
      ["a server rack in a data center", "datacenter"],
      ["a robot arm on an assembly line", "robotics"],
      ["a close up of a gpu chip", "compute"],
      ["nothing relevant at all here", "none"],
    ];
    for (const [text, expected] of cases) {
      const r = classifyConcept(text, AI_SUBJECTS);
      assert.equal(r.concept, expected, `"${text}"`);
      assert.equal(typeof r.score, "number");
      assert.ok(Array.isArray(r.matched));
      assert.equal(typeof r.totalMatched, "number");
    }
  });

  test("a non-tied result carries no tied set", () => {
    const r = classifyConcept("a server rack in a data center", AI_SUBJECTS);
    assert.equal(r.tied, undefined, "tied is populated only for a genuine tie");
  });

  test("an AI Doom tie still reports 'ambiguous' exactly as before", () => {
    // Whatever ties, the concept label is unchanged — only `tied` is added.
    const r = classifyConcept("a robot in a factory", AI_SUBJECTS);
    if (r.concept === "ambiguous") {
      assert.ok((r.tied?.length ?? 0) > 1, "a tie enumerates its concepts");
    }
    assert.ok(["ambiguous", "robotics", "factory"].includes(r.concept));
  });

  test("AI Doom's gate does not import WC tie accounting", () => {
    const aiGate = readFileSync("src/stages/visualFeasibilityGate.ts", "utf8");
    assert.doesNotMatch(aiGate, /conceptAccounting|tieAwareConceptAccounting|tieAwareChecks/);
    assert.doesNotMatch(aiGate, /wc-pipeline/);
  });

  test("the shared feasibility gate's own concept accounting is unchanged", () => {
    const src = readFileSync("packages/pipeline-core/src/lib/visualFeasibility.ts", "utf8");
    // The shared gate still buckets by the production label, including "none".
    assert.match(src, /conceptSeconds\.get\(f\.concept\)/);
    assert.match(src, /c\.concept !== "generic-abstract" && c\.concept !== "none"/);
    assert.doesNotMatch(src, /tieAware|tiedConcepts/, "no WC accounting leaked into shared code");
  });

  test("scoreRelevance still collapses ambiguous to none for every caller", () => {
    const src = readFileSync("packages/pipeline-core/src/lib/visualRelevance.ts", "utf8");
    assert.match(src, /match\.concept === "ambiguous" \? "none" : match\.concept/,
      "the shared remap is deliberately unchanged — WC corrects it downstream");
  });
});
