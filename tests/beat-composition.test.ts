import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  deriveRequirement, buildBeatQueries, stripFraming, derivePolicy, composeBeat,
  MIN_SUBJECT_SHARE, MIN_SUBJECT_SHARE_DOMINANT, MIN_SETTING_SHARE,
} from "../packages/pipeline-core/src/lib/semanticCoverage";
import type {
  BeatRequirement, CandidateLike,
} from "../packages/pipeline-core/src/lib/semanticCoverage";

/**
 * Query construction and compositional coverage.
 *
 * Two defects motivated this. Queries were built from the leading words of the
 * visual prompt, so a supermarket-aisle beat searched for "wide-angle looking
 * down long" and never for "supermarket aisle" — 152 candidates arrived and
 * none were aisles. And beat support required every individual clip to contain
 * both subject and setting, which rejected a 105-second self-checkout clip as
 * merely RELATED because no camera was visible in frame.
 */

const req = (visualPrompt: string, narration: string): BeatRequirement =>
  deriveRequirement({ beatIndex: 1, segmentIndex: 0, narration, visualPrompt });

const AISLE_JOINT = req(
  "Wide-angle shot looking down a long supermarket aisle from ceiling height, showing a dome security camera mounted above shelving units",
  "That camera above the cereal aisle isn't just recording anymore.",
);
// A general discussion beat: cameras and retail are both required, but the
// sentence asserts no specific physical relationship, so it may compose.
const RETAIL_GENERAL = req(
  "Supermarket interior with shoppers, self checkout stations, and CCTV cameras",
  "Computer vision is spreading through retail, from the aisle to the checkout.",
);
const OPTS = { beatMaxS: 30, minFragmentS: 3 };

const cand = (id: string, description: string, durationS: number, brandRisk = false): CandidateLike =>
  ({ assetId: id, description, durationS, brandRisk });

// ── Query construction ───────────────────────────────────────────────────

describe("queries are built from subjects and settings", () => {
  test("a supermarket beat searches for supermarkets and cameras", () => {
    const qs = buildBeatQueries(AISLE_JOINT).map((q) => q.query);
    assert.ok(qs.some((q) => q.includes("supermarket") || q.includes("grocery")),
      `no retail query in ${JSON.stringify(qs)}`);
    assert.ok(qs.some((q) => q.includes("security camera") || q.includes("cctv")),
      `no camera query in ${JSON.stringify(qs)}`);
  });

  test("subject+setting composites come first", () => {
    const qs = buildBeatQueries(AISLE_JOINT);
    assert.equal(qs[0]!.klass, "EXACT_COMPOSITE");
    assert.ok(qs[0]!.query.includes("camera"));
  });

  test("a self-checkout prompt produces self-checkout queries", () => {
    const r = req("Close-up of a self checkout station in a retail store with a security camera above it",
                  "Self checkout is where the cameras watch hardest.");
    const qs = buildBeatQueries(r).map((q) => q.query);
    assert.ok(qs.some((q) => q.includes("self checkout")), JSON.stringify(qs));
  });

  test("cinematography words are stripped from the semantic core", () => {
    const s = stripFraming("Wide-angle shot looking down a long supermarket aisle, close-up cinematic b-roll");
    for (const bad of ["wide-angle", "looking down", "close-up", "cinematic", "b-roll", "shot of"]) {
      assert.ok(!s.includes(bad), `"${bad}" survived stripping: ${s}`);
    }
    assert.ok(s.includes("supermarket"));
  });

  test("meaningless prose fragments are never emitted as queries", () => {
    const qs = buildBeatQueries(AISLE_JOINT).map((q) => q.query);
    for (const junk of ["wide-angle looking down long", "wide-angle looking",
                        "from recording to real-time analysis"]) {
      assert.ok(!qs.includes(junk), `emitted junk query "${junk}"`);
    }
  });

  test("query count is bounded and deduplicated", () => {
    const qs = buildBeatQueries(AISLE_JOINT);
    assert.ok(qs.length <= 8, `${qs.length} queries`);
    assert.equal(new Set(qs.map((q) => q.query)).size, qs.length);
    for (const q of qs) assert.ok(q.satisfies.length > 0, "every query declares what it satisfies");
  });
});

// ── Composition policy ───────────────────────────────────────────────────

describe("composition policy", () => {
  test("a co-location claim requires a joint match", () => {
    assert.equal(derivePolicy(AISLE_JOINT), "JOINT_MATCH_REQUIRED");
  });

  test("a general retail-surveillance discussion may compose", () => {
    assert.equal(derivePolicy(RETAIL_GENERAL), "COMPOSITIONAL_MATCH_ALLOWED");
  });

  test("a beat with no required setting is subject-dominant", () => {
    const r = req("Screen showing object detection bounding boxes around people",
                  "The software scores every person it detects.");
    assert.equal(derivePolicy(r), "SUBJECT_DOMINANT");
  });
});

// ── Compositional success ────────────────────────────────────────────────

describe("compositional coverage succeeds on genuinely relevant fragments", () => {
  test("aisle + security camera supports a general retail-surveillance beat", () => {
    const r = composeBeat(RETAIL_GENERAL, "COMPOSITIONAL_MATCH_ALLOWED", 20, [
      cand("a", "customers shopping at supermarket aisle", 12),
      cand("b", "dome security camera mounted on a ceiling", 12),
    ], OPTS);
    assert.equal(r.covered, true, r.reasons.join("; "));
    assert.ok(r.subjectShare >= MIN_SUBJECT_SHARE);
    assert.ok(r.settingShare >= MIN_SETTING_SHARE);
  });

  test("self-checkout + control-room supports a general checkout-surveillance beat", () => {
    const r = composeBeat(RETAIL_GENERAL, "COMPOSITIONAL_MATCH_ALLOWED", 20, [
      cand("a", "young adult scanning groceries at self checkout", 12),
      cand("b", "high tech control room with multiple cctv monitors", 12),
    ], OPTS);
    assert.equal(r.covered, true, r.reasons.join("; "));
  });
});

// ── Compositional failure ────────────────────────────────────────────────

describe("compositional coverage fails on filler and mismatch", () => {
  const failures: { name: string; cands: CandidateLike[] }[] = [
    { name: "aisle plus airport", cands: [
      cand("a", "customers shopping at supermarket aisle", 12),
      cand("b", "people walking through an airport terminal with luggage", 12)] },
    { name: "camera plus warehouse roof aerial", cands: [
      cand("a", "dome security camera mounted on a ceiling", 12),
      cand("b", "aerial view of industrial warehouse roofs with solar panels", 12)] },
    { name: "generic code plus aisle", cands: [
      cand("a", "customers shopping at supermarket aisle", 12),
      cand("b", "downloading python packages on terminal screen", 12)] },
    { name: "trading screens plus camera", cands: [
      cand("a", "dome security camera mounted on a ceiling", 12),
      cand("b", "financial trading data on screens in dark room", 12)] },
  ];

  for (const f of failures) {
    test(`${f.name} does not cover the beat`, () => {
      const r = composeBeat(RETAIL_GENERAL, "COMPOSITIONAL_MATCH_ALLOWED", 24, f.cands, OPTS);
      const fillerAdmitted = r.fragments.some((x) =>
        /airport|aerial|python|trading/i.test(x.description));
      assert.ok(!fillerAdmitted || !r.covered,
        `filler was admitted and the beat passed: ${r.reasons.join("; ")}`);
    });
  }

  test("one second of subject cannot legitimise seventeen of setting", () => {
    const r = composeBeat(RETAIL_GENERAL, "COMPOSITIONAL_MATCH_ALLOWED", 18, [
      cand("a", "customers shopping at supermarket aisle", 17),
      cand("b", "dome security camera mounted on a ceiling", 3),
    ], { ...OPTS, minFragmentS: 1 });
    if (r.covered) {
      assert.ok(r.subjectShare >= MIN_SUBJECT_SHARE,
        `subject share ${r.subjectShare} below floor but beat passed`);
    }
  });

  test("all setting and no subject fails", () => {
    const r = composeBeat(RETAIL_GENERAL, "COMPOSITIONAL_MATCH_ALLOWED", 20, [
      cand("a", "customers shopping at supermarket aisle", 12),
      cand("b", "woman shopping in grocery aisle", 12),
    ], OPTS);
    assert.equal(r.covered, false);
    assert.ok(r.reasons.some((x) => /subject/.test(x)), r.reasons.join("; "));
  });

  test("all subject and no required setting fails", () => {
    const r = composeBeat(RETAIL_GENERAL, "COMPOSITIONAL_MATCH_ALLOWED", 20, [
      cand("a", "dome security camera mounted on a ceiling", 12),
      cand("b", "cctv camera on a pole", 12),
    ], OPTS);
    assert.equal(r.covered, false);
    assert.ok(r.reasons.some((x) => /setting/.test(x)), r.reasons.join("; "));
  });

  test("an uncoverable duration fails rather than looping", () => {
    const r = composeBeat(RETAIL_GENERAL, "COMPOSITIONAL_MATCH_ALLOWED", 40, [
      cand("a", "customers shopping at supermarket aisle", 6),
      cand("b", "dome security camera mounted on a ceiling", 6),
    ], OPTS);
    assert.equal(r.covered, false);
    assert.ok(r.reasons.some((x) => /uncovered/.test(x)));
  });
});

// ── Joint match ──────────────────────────────────────────────────────────

describe("joint match refuses to imply an unshown relationship", () => {
  test("a camera visibly mounted in a store passes", () => {
    const r = composeBeat(AISLE_JOINT, "JOINT_MATCH_REQUIRED", 18, [
      cand("a", "security camera mounted above a supermarket aisle with shelves", 20),
    ], OPTS);
    assert.equal(r.covered, true, r.reasons.join("; "));
    assert.equal(r.jointMatchAsset, "a");
  });

  test("separate generic camera and generic aisle clips fail", () => {
    const r = composeBeat(AISLE_JOINT, "JOINT_MATCH_REQUIRED", 18, [
      cand("a", "dome security camera mounted on a ceiling", 12),
      cand("b", "customers shopping at supermarket aisle", 12),
    ], OPTS);
    assert.equal(r.covered, false);
    assert.match(r.reasons.join("; "), /does not show/);
  });

  test("a biometric scanner at an access gate passes its joint beat", () => {
    const gate = req("Traveller scanning a badge at an access gate turnstile",
                     "A biometric checkpoint mounted at the entry gate reads every face.");
    const r = composeBeat(gate, "JOINT_MATCH_REQUIRED", 15, [
      cand("a", "biometric access gate turnstile with badge reader scanner", 20),
    ], OPTS);
    assert.equal(r.covered, true, r.reasons.join("; "));
  });

  test("an unrelated scanner plus an airport exterior fails", () => {
    const gate = req("Traveller scanning a badge at an access gate turnstile",
                     "A biometric checkpoint mounted at the entry gate reads every face.");
    const r = composeBeat(gate, "JOINT_MATCH_REQUIRED", 15, [
      cand("a", "barcode scanner in a warehouse", 10),
      cand("b", "modern airport terminal exterior", 10),
    ], OPTS);
    assert.equal(r.covered, false);
  });
});

// ── Nothing is weakened ──────────────────────────────────────────────────

describe("no threshold is relaxed", () => {
  test("caps and margins hold", async () => {
    const v = await import("../packages/pipeline-core/src/lib/visualFeasibility");
    assert.equal(v.MAX_CONCEPT_SHARE, 0.4);
    assert.equal(v.MAX_CARD_SHARE, 0.15);
    assert.equal(v.MIN_DISTINCT_CONCEPTS, 3);
    assert.equal(v.POOL_SAFETY_FACTOR, 1.25);
    assert.equal(v.DURATION_SAFETY_FACTOR, 1.25);
  });

  test("share floors are the proposed conservative values", () => {
    assert.equal(MIN_SUBJECT_SHARE, 0.3);
    assert.equal(MIN_SUBJECT_SHARE_DOMINANT, 0.5);
    assert.equal(MIN_SETTING_SHARE, 0.3);
  });

  test("an asset claimed by an earlier beat is unavailable", () => {
    const r = composeBeat(RETAIL_GENERAL, "COMPOSITIONAL_MATCH_ALLOWED", 20, [
      cand("a", "customers shopping at supermarket aisle", 12),
      cand("b", "dome security camera mounted on a ceiling", 12),
    ], { ...OPTS, claimed: new Set(["a"]) });
    assert.equal(r.covered, false, "reuse across beats must not rescue a beat");
  });
});
