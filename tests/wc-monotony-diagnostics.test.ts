import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  longestNoNewConceptRun, wcLocalMonotonyDiagnostics, concreteSetOf,
} from "../packages/wc-pipeline/src/stages/monotonyDiagnostics";
import type { FragmentAllocation } from "../packages/wc-pipeline/src/stages/conceptAccounting";

/**
 * Local-monotony measurement, pinned.
 *
 * This metric gates nothing. These tests fix the algorithm — in particular that
 * the run's vocabulary is fixed at its first fragment and never widened, which
 * is the whole difference between "the palette went stale" and "one broad
 * concept stayed on screen".
 */

// ── Fixture builder ──────────────────────────────────────────────────────

let n = 0;
function frag(
  set: string[],
  durationS: number,
  opts: { outcome?: FragmentAllocation["outcome"]; asset?: string; beat?: number } = {},
): FragmentAllocation {
  const each = set.length ? durationS / set.length : 0;
  const allocation: Record<string, number> = {};
  for (const c of set) allocation[c] = each;
  if (set.length === 0) allocation[opts.outcome === "NON_CONCRETE" ? "card" : "none"] = durationS;
  return {
    beatIndex: opts.beat ?? ++n,
    assetId: opts.asset ?? `asset-${n}`,
    description: "",
    projectedSeconds: durationS,
    conceptFinal: set[0] ?? "none",
    conceptRaw: set.length > 1 ? "ambiguous" : (set[0] ?? "none"),
    outcome: opts.outcome ?? (set.length > 1 ? "TIE" : set.length === 1 ? "SINGLE" : "GENUINE_NONE"),
    tiedConcepts: set.length > 1 ? [...set] : [],
    score: 1,
    longest: 1,
    allocation,
  };
}

// ── 1–4. The core algorithm ──────────────────────────────────────────────

describe("no-new-concept run: the core rules", () => {
  test("1. one concept repeated is a single drought spanning everything", () => {
    const r = longestNoNewConceptRun([
      frag(["vessel"], 10), frag(["vessel"], 10), frag(["vessel"], 10),
    ])!;
    assert.equal(r.seconds, 30);
    assert.equal(r.fragmentCount, 3);
    assert.equal(r.shareOfTimeline, 1);
    assert.deepEqual(r.initialConcreteConcepts, ["vessel"]);
  });

  test("2. alternating INSIDE the established set stays one drought", () => {
    const r = longestNoNewConceptRun([
      frag(["vessel", "water"], 10), frag(["vessel"], 10),
      frag(["water"], 10), frag(["vessel", "water"], 10),
    ])!;
    assert.equal(r.seconds, 40, "nothing new was introduced");
    assert.equal(r.fragmentCount, 4);
    assert.deepEqual(r.initialConcreteConcepts, ["vessel", "water"]);
    assert.ok(r.conceptSetChangeCount > 0, "the sets do change — that is not the same as new");
  });

  test("3. a newly introduced concept ends the run before that fragment", () => {
    const r = longestNoNewConceptRun([
      frag(["vessel", "water"], 10), frag(["vessel"], 10), frag(["electronics"], 10),
    ])!;
    assert.equal(r.seconds, 20);
    assert.equal(r.endFragmentIndex, 1, "the run ends BEFORE the electronics fragment");
    assert.ok(!r.allConcreteConceptsSeen.includes("electronics"));
  });

  test("4. the starting vocabulary is never widened mid-run", () => {
    // {vessel} then {vessel,water}: water is new relative to the START, so the
    // run ends. It must NOT absorb water and continue.
    const seq = [
      frag(["vessel"], 10), frag(["vessel", "water"], 10),
      frag(["vessel", "water"], 10), frag(["vessel", "water"], 10),
    ];
    const r = longestNoNewConceptRun(seq)!;
    // The longest run is the {vessel,water} tail (fragments 1..3 = 30s),
    // NOT a widened 40s run beginning at fragment 0.
    assert.equal(r.seconds, 30);
    assert.equal(r.startFragmentIndex, 1);
    assert.deepEqual(r.initialConcreteConcepts, ["vessel", "water"]);
    assert.notEqual(r.seconds, 40, "the vocabulary must not grow as the run proceeds");
  });

  test("a subset of the starting vocabulary never ends a run", () => {
    const r = longestNoNewConceptRun([
      frag(["vessel", "water", "fishing"], 10), frag(["vessel"], 10), frag(["fishing"], 10),
    ])!;
    assert.equal(r.seconds, 30);
  });
});

// ── 5–6. Ties and unclassifiable footage ─────────────────────────────────

describe("ties and genuine-none", () => {
  test("5. a tie contributes its FULL concrete set, never 'ambiguous'", () => {
    const f = frag(["vessel", "water"], 10);
    assert.equal(f.outcome, "TIE");
    assert.deepEqual(concreteSetOf(f), ["vessel", "water"]);
    assert.ok(!concreteSetOf(f).includes("ambiguous"));
    const r = longestNoNewConceptRun([f, frag(["water"], 10)])!;
    assert.equal(r.seconds, 20, "water is inside the tie's own set");
  });

  test("6. genuine-none introduces no concept and cannot end a run", () => {
    const r = longestNoNewConceptRun([
      frag(["vessel"], 10), frag([], 10), frag(["vessel"], 10),
    ])!;
    assert.equal(r.seconds, 30, "unclassifiable footage is not new vocabulary");
    assert.equal(r.genuineNoneSeconds, 10, "but it is reported separately");
  });

  test("6b. genuine-none does not create fake diversity either", () => {
    const r = longestNoNewConceptRun([frag([], 10), frag([], 10), frag([], 10)])!;
    assert.equal(r.seconds, 30);
    assert.deepEqual(r.initialConcreteConcepts, [], "no concrete vocabulary at all");
    assert.equal(r.genuineNoneSeconds, 30);
  });

  test("a concrete concept after an empty-set start DOES end the run", () => {
    // Starting vocabulary is empty, so anything concrete is new.
    const r = longestNoNewConceptRun([frag([], 10), frag(["vessel"], 10), frag(["vessel"], 10)])!;
    assert.equal(r.seconds, 20, "the {vessel} tail is longer than the 10s empty start");
    assert.equal(r.startFragmentIndex, 1);
  });
});

// ── 11. Cards / non-concrete ─────────────────────────────────────────────

describe("cards and other non-concrete labels", () => {
  test("11. a card yields an empty concrete set and cannot be a new concept", () => {
    const card = frag([], 10, { outcome: "NON_CONCRETE" });
    assert.deepEqual(concreteSetOf(card), [], "card is not a concrete category");
    const r = longestNoNewConceptRun([frag(["vessel"], 10), card, frag(["vessel"], 10)])!;
    assert.equal(r.seconds, 30, "a card does not break a drought");
    assert.equal(r.nonConcreteSeconds, 10, "but it is reported separately");
    assert.equal(r.genuineNoneSeconds, 0, "and is distinguished from genuine-none");
  });

  test("card seconds still count as elapsed screen time", () => {
    const r = longestNoNewConceptRun([
      frag(["vessel"], 10), frag([], 30, { outcome: "NON_CONCRETE" }),
    ])!;
    assert.equal(r.seconds, 40);
  });
});

// ── 7–10. Arithmetic, position, reporting ────────────────────────────────

describe("arithmetic and reporting", () => {
  test("7. run seconds are exact and never exceed the timeline", () => {
    const seq = [frag(["vessel"], 16.93), frag(["vessel"], 19.25), frag(["water"], 18.32)];
    const total = seq.reduce((a, f) => a + f.projectedSeconds, 0);
    const r = longestNoNewConceptRun(seq)!;
    assert.ok(Math.abs(r.seconds - 36.18) < 1e-9);
    assert.ok(r.seconds <= total + 1e-9);
    assert.ok(Math.abs(r.shareOfTimeline - 36.18 / total) < 1e-9);
  });

  test("8. fractional durations are handled deterministically", () => {
    const a = longestNoNewConceptRun([frag(["vessel"], 1 / 3), frag(["vessel"], 2 / 3)])!;
    assert.ok(Math.abs(a.seconds - 1) < 1e-12);
    const b = longestNoNewConceptRun([frag(["vessel"], 1 / 3), frag(["vessel"], 2 / 3)])!;
    assert.equal(a.seconds, b.seconds, "same input, same output");
  });

  test("9. the longest run can start in the middle", () => {
    const r = longestNoNewConceptRun([
      frag(["vessel"], 5), frag(["water"], 5),
      frag(["fishing"], 20), frag(["fishing"], 20), frag(["fishing"], 20),
    ])!;
    assert.equal(r.seconds, 60);
    assert.equal(r.startFragmentIndex, 2);
    assert.equal(r.endFragmentIndex, 4);
    assert.equal(r.startS, 10);
    assert.equal(r.endS, 70);
  });

  test("10. assets, fragments and beats are reported correctly", () => {
    const r = longestNoNewConceptRun([
      frag(["vessel"], 10, { asset: "x", beat: 1 }),
      frag(["vessel"], 10, { asset: "y", beat: 1 }),
      frag(["vessel"], 10, { asset: "x", beat: 2 }),
    ])!;
    assert.equal(r.fragmentCount, 3);
    assert.equal(r.beatCount, 2, "two distinct beats");
    assert.equal(r.uniqueAssetCount, 2, "x counted once");
    assert.deepEqual([...r.assetIds].sort(), ["x", "y"]);
  });

  test("an empty sequence returns null rather than a fabricated zero", () => {
    assert.equal(longestNoNewConceptRun([]), null);
    assert.equal(wcLocalMonotonyDiagnostics([]).longestNoNewConceptRun, null);
  });

  test("concept-set change rate is reported within the run", () => {
    const r = longestNoNewConceptRun([
      frag(["vessel", "water"], 10), frag(["vessel"], 10), frag(["vessel"], 10),
    ])!;
    assert.equal(r.conceptSetChangeCount, 1);
    assert.ok(Math.abs(r.conceptSetChangeRate - 0.5) < 1e-9);
  });
});

// ── 12. No verdict anywhere in the API ───────────────────────────────────

describe("the diagnostic carries no verdict and gates nothing", () => {
  const src = readFileSync("packages/wc-pipeline/src/stages/monotonyDiagnostics.ts", "utf8");

  test("12. no PASS/FAIL, ok, threshold or cap in the module", () => {
    assert.doesNotMatch(src, /\bok\s*:/, "no ok field");
    assert.doesNotMatch(src, /"PASS"|"FAIL"|\bpassed\b/, "no verdict");
    assert.doesNotMatch(src, /MAX_|THRESHOLD|_CAP\b/, "no threshold constant");
    assert.doesNotMatch(src, /0\.4\b|\b40\b/, "no cap value");
  });

  test("the returned shape is structured, not a bare scalar", () => {
    const r = longestNoNewConceptRun([frag(["vessel"], 10)])!;
    for (const k of [
      "seconds", "shareOfTimeline", "startS", "endS", "startFragmentIndex",
      "endFragmentIndex", "fragmentCount", "beatCount", "initialConcreteConcepts",
      "allConcreteConceptsSeen", "genuineNoneSeconds", "nonConcreteSeconds",
      "uniqueAssetCount", "assetIds", "conceptSetChangeCount", "conceptSetChangeRate",
    ]) {
      assert.ok(k in r, `missing ${k}`);
    }
  });

  test("no gate, candidate-status, upload or budget path references the metric", () => {
    const gate = readFileSync("packages/wc-pipeline/src/stages/visualFeasibilityGate.ts", "utf8");
    const upload = readFileSync("packages/wc-pipeline/src/stages/youtubeUpload.ts", "utf8");
    const voice = readFileSync("packages/wc-pipeline/src/stages/voiceover.ts", "utf8");
    const acct = readFileSync("packages/wc-pipeline/src/stages/conceptAccounting.ts", "utf8");

    // The gate may LOG it, but its verdict must not consult it.
    const failBlock = gate.slice(gate.indexOf("if (failed.length > 0)"));
    assert.doesNotMatch(failBlock, /longestNoNewConceptRun|monotony/i,
      "the failure decision must not reference the diagnostic");
    assert.doesNotMatch(gate, /run\.(seconds|shareOfTimeline)\s*[<>]=?/,
      "no comparison of the metric against anything");
    assert.doesNotMatch(acct, /longestNoNewConceptRun|monotony/i,
      "concept accounting must not consult it");
    for (const [name, s] of [["upload", upload], ["voiceover", voice]] as const) {
      assert.doesNotMatch(s, /longestNoNewConceptRun|monotonyDiagnostics/,
        `${name} must not reference the diagnostic`);
    }
  });

  test("the concept checks are unchanged and still drive the verdict", () => {
    const gate = readFileSync("packages/wc-pipeline/src/stages/visualFeasibilityGate.ts", "utf8");
    assert.match(gate, /const checks = tieAwareChecks\(report, accounting\)/);
    assert.match(gate, /const failed = checks\.filter\(\(c\) => !c\.ok\)/);
  });

  test("MAX_CONCEPT_SHARE is untouched at 0.40", async () => {
    const { MAX_CONCEPT_SHARE } = await import("../packages/pipeline-core/src/lib/visualFeasibility");
    assert.equal(MAX_CONCEPT_SHARE, 0.4);
  });

  test("14. AI Doom does not import the diagnostic", () => {
    const aiGate = readFileSync("src/stages/visualFeasibilityGate.ts", "utf8");
    const aiPipeline = readFileSync("src/pipeline.ts", "utf8");
    const coreUpload = readFileSync("packages/pipeline-core/src/stages/youtubeUpload.ts", "utf8");
    for (const [name, s] of [["AI gate", aiGate], ["AI pipeline", aiPipeline], ["core upload", coreUpload]] as const) {
      assert.doesNotMatch(s, /monotonyDiagnostics|longestNoNewConceptRun/, `${name} must be untouched`);
    }
  });
});

// ── 6 (Phase 6). Regression against the three measured candidates ────────

describe("regression: the three measured WC candidates", () => {
  const fx = JSON.parse(readFileSync("tests/fixtures/wc-monotony-sequences.json", "utf8")) as Record<
    string,
    { label: string; pillar: string; timelineSeconds: number;
      fragments: { beat: number; dur: number; set: string[]; outcome: string; asset: string }[] }
  >;

  const toAllocations = (k: string): FragmentAllocation[] =>
    fx[k].fragments.map((f) => {
      const each = f.set.length ? f.dur / f.set.length : 0;
      const allocation: Record<string, number> = {};
      for (const c of f.set) allocation[c] = each;
      if (f.set.length === 0) allocation.none = f.dur;
      return {
        beatIndex: f.beat, assetId: f.asset, description: "",
        projectedSeconds: f.dur,
        conceptFinal: f.set[0] ?? "none",
        conceptRaw: f.set.length > 1 ? "ambiguous" : (f.set[0] ?? "none"),
        outcome: f.outcome as FragmentAllocation["outcome"],
        tiedConcepts: f.set.length > 1 ? [...f.set] : [],
        score: 1, longest: 1, allocation,
      };
    });

  const expected: Record<string, { seconds: number; pct: number }> = {
    A: { seconds: 74.6, pct: 26.9 },
    B: { seconds: 225.7, pct: 80.3 },
    C: { seconds: 78.3, pct: 28.9 },
  };

  for (const k of ["A", "B", "C"]) {
    test(`${k} — ${fx[k].label} (${fx[k].pillar}) reproduces the measured run`, () => {
      const r = longestNoNewConceptRun(toAllocations(k))!;
      assert.ok(r, "a run must be found");
      assert.ok(Math.abs(r.seconds - expected[k].seconds) < 0.05,
        `${k}: ${r.seconds.toFixed(1)}s vs expected ${expected[k].seconds}s`);
      assert.ok(Math.abs(r.shareOfTimeline * 100 - expected[k].pct) < 0.05,
        `${k}: ${(r.shareOfTimeline * 100).toFixed(1)}% vs expected ${expected[k].pct}%`);
    });
  }

  test("fragment seconds sum to the recorded timeline for every candidate", () => {
    for (const k of ["A", "B", "C"]) {
      const total = fx[k].fragments.reduce((a, f) => a + f.dur, 0);
      // Fixture durations are rounded to 4 decimals, so a few tenths of a
      // millisecond of accumulation drift across ~20 fragments is expected.
      assert.ok(Math.abs(total - fx[k].timelineSeconds) < 0.01,
        `${k}: fragments ${total} vs timeline ${fx[k].timelineSeconds}`);
    }
  });

  test("the observed separation is recorded WITHOUT becoming a threshold", () => {
    const v = (k: string) => longestNoNewConceptRun(toAllocations(k))!;
    const a = v("A"), b = v("B"), c = v("C");
    const acMax = Math.max(a.seconds, c.seconds);
    assert.ok(Math.abs(acMax - 78.3) < 0.05, "observed A/C maximum");
    assert.ok(Math.abs(b.seconds - 225.7) < 0.05, "observed B");
    assert.ok(b.seconds > acMax, "B is the outlier on this measure");
    // Deliberately NO assertion of any value between them: three candidates
    // cannot calibrate a threshold, and encoding one here would smuggle a
    // policy decision into a test.
    const src = readFileSync("packages/wc-pipeline/src/stages/monotonyDiagnostics.ts", "utf8");
    assert.doesNotMatch(src, /78\.3|225\.7|\b78\b\s*s|\b226\b/,
      "no separation value may be encoded in the implementation");
    // Comparing candidate runs against each other to find the longest is the
    // algorithm. Comparing a run against a NUMERIC BOUND would be a threshold.
    assert.doesNotMatch(src, /(seconds|shareOfTimeline)\s*[<>]=?\s*[0-9]/,
      "the implementation must not compare the run against a numeric bound");
  });

  test("B's run is long BECAUSE nothing new appears, not because sets are static", () => {
    const b = longestNoNewConceptRun(toAllocations("B"))!;
    assert.ok(b.conceptSetChangeRate > 0.5,
      "B's sets change constantly inside the run — this metric is not measuring set stasis");
    assert.ok(b.uniqueAssetCount > 10, "and the assets are all distinct");
  });
});
