import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assessVisualFeasibility, FEASIBILITY_POLICY, feasibilityPolicyFor,
  MAX_CONCEPT_SHARE, MIN_DISTINCT_CONCEPTS, MAX_CARD_SHARE,
  POOL_SAFETY_FACTOR, DURATION_SAFETY_FACTOR,
} from "@yt-pipeline/pipeline-core";
import type {
  Candidate, FeasibilityDeps, OutlineSegment,
} from "@yt-pipeline/pipeline-core";

/**
 * The AI Doom dominant-concept cap was retired on 2026-08-13 and Wet Circuit's
 * was not. These tests pin both halves of that, and the reason.
 *
 * Seven real AI Doom timelines were labelled taxonomy-blind and weighted by
 * real on-screen seconds. Human dominant share ran 14.0%-36.6% and nothing
 * reached 40%, while the automated measure fired on five of the seven — every
 * one a false positive, overstating by +23.6pp on average. Four supervised
 * qualification attempts were blocked by it; the human labels say all four
 * were varied videos with 8-18 distinct kinds of shot. The evidence is frozen
 * in tests/fixtures/concentration-timelines.json and re-checkable with
 * scripts/bench-concentration-policy.ts.
 *
 * What must NOT change is everything else: the cap was one control among
 * eight, and the other seven are what caught the real defects.
 */

function candidate(assetId: string, description: string, durationS: number): Candidate {
  return {
    assetId, url: `https://videos.example/${assetId}.mp4`,
    width: 1920, height: 1080, durationS, provider: "pexels",
    pageUrl: `https://www.pexels.com/video/${description.replace(/\s+/g, "-")}-${assetId}/`,
    description,
  };
}
const fixed = (pool: Candidate[]): FeasibilityDeps => ({ search: async () => pool });

const SEGMENTS: OutlineSegment[] = Array.from({ length: 5 }, (_, i) => ({
  segmentIndex: i,
  title: `Segment ${i}`,
  narration: "Robots now run the assembly line inside modern manufacturing plants. ".repeat(18),
  visual_prompt: "A manufacturing plant floor with automated assembly line machinery and workers",
}));

const input = (channel: "ai-doom-scroll" | "wet-circuit") => ({
  channel, topicTitle: "Concentration policy fixture", targetRuntimeS: 420, segments: SEGMENTS,
});

/**
 * Deliberately concentrated: every clip is the same broad industrial concept,
 * but there are plenty of them, they are long, distinct and non-brand-risk —
 * so ONLY the dominant-concept check has any reason to complain.
 */
function monotonePool(n = 60): Candidate[] {
  // Weighted so ONE concept dominates well past 40% while three others are
  // still present — otherwise the diversity floor objects first and the test
  // would prove nothing about the cap.
  const subjects = [
    "industrial factory assembly line with machinery",
    "automated factory conveyor belt in operation",
    "manufacturing plant production line overview",
    "industrial warehouse conveyor system",
    "industrial factory floor with heavy machinery",
    "factory production line robotic welding",
    "data center server room with racks",
    "close up of a computer processor chip",
    "engineer at a laboratory research workstation",
  ];
  return Array.from({ length: n }, (_, i) =>
    candidate(`m-${i}`, `${subjects[i % subjects.length]} number ${i}`, 26));
}

// ── The policy itself ─────────────────────────────────────────────────────

describe("the dominant-concept policy is stated per channel, not inferred", () => {
  test("both channels are listed explicitly", () => {
    assert.deepEqual(Object.keys(FEASIBILITY_POLICY).sort(), ["ai-doom-scroll", "wet-circuit"]);
    assert.equal(FEASIBILITY_POLICY["ai-doom-scroll"].enforceDominantConceptCap, false);
    assert.equal(FEASIBILITY_POLICY["wet-circuit"].enforceDominantConceptCap, true);
  });

  test("an unknown channel fails closed", () => {
    assert.equal(feasibilityPolicyFor("mystery" as never).enforceDominantConceptCap, true);
  });

  test("the retirement is a policy flag, not a neutralised threshold", () => {
    // The constant must NOT have been quietly set to 1.0 or similar — the cap
    // still means 40% for whoever enforces it.
    assert.equal(MAX_CONCEPT_SHARE, 0.4);
    const src = readFileSync("packages/pipeline-core/src/lib/visualFeasibility.ts", "utf8");
    assert.match(src, /enforceDominantConceptCap/);
    assert.ok(!/MAX_CONCEPT_SHARE = 1/.test(src), "the threshold must not be neutralised");
    assert.ok(!/process\.env\.\w*CONCEPT/.test(src),
      "the policy must not hang off an ambient environment variable");
  });
});

// ── AI Doom: the cap no longer fails a candidate ──────────────────────────

describe("AI Doom does not fail on dominant concept share alone", () => {
  test("a heavily concentrated but otherwise healthy pool PASSES", async () => {
    const r = await assessVisualFeasibility(input("ai-doom-scroll"), fixed(monotonePool()));
    const dom = r.conceptBreakdown[0]?.share ?? 0;
    assert.ok(dom > MAX_CONCEPT_SHARE,
      `fixture must actually exceed the old cap, got ${dom}`);
    const ndc = r.checks.find((c) => c.name === "no-dominant-concept")!;
    assert.equal(ndc.ok, true, "the check must not fail an AI Doom candidate");
    assert.match(ndc.detail, /DIAGNOSTIC ONLY/);
    assert.equal(r.pass, true, `expected PASS, got: ${r.failureReason}`);
  });

  test("the share is still measured and reported for diagnostics", async () => {
    const r = await assessVisualFeasibility(input("ai-doom-scroll"), fixed(monotonePool()));
    assert.ok(r.conceptBreakdown.length > 0);
    assert.match(r.checks.find((c) => c.name === "no-dominant-concept")!.detail,
      /holds \d+% of projected timeline/);
  });
});

// ── Wet Circuit keeps it ──────────────────────────────────────────────────

describe("Wet Circuit still enforces its dominant-concept cap", () => {
  test("the same concentrated pool FAILS on wet-circuit", async () => {
    const r = await assessVisualFeasibility(input("wet-circuit"), fixed(monotonePool()));
    const ndc = r.checks.find((c) => c.name === "no-dominant-concept")!;
    assert.equal(ndc.ok, false, "wet-circuit must still fail on concentration");
    assert.match(ndc.detail, /cap 40%/);
    assert.equal(r.pass, false);
    assert.match(r.failureReason!, /no-dominant-concept/);
  });

  test("wc-pipeline keeps its own independent enforcement too", () => {
    const acct = readFileSync("packages/wc-pipeline/src/stages/conceptAccounting.ts", "utf8");
    assert.match(acct, /name: "no-dominant-concept"/);
    assert.match(acct, /ok: dominantAnyShare <= tolerance\.maxConceptShare/);
    assert.ok(!/enforceDominantConceptCap/.test(acct),
      "WC's own accounting must not consult the AI Doom retirement flag");
  });
});

// ── Everything else must still bite ───────────────────────────────────────

describe("the other AI Doom feasibility gates are unchanged", () => {
  test("all eight checks are still produced", async () => {
    const r = await assessVisualFeasibility(input("ai-doom-scroll"), fixed(monotonePool()));
    assert.deepEqual(r.checks.map((c) => c.name).sort(), [
      "brand-risk-not-load-bearing", "concept-diversity", "fallback-card-share",
      "no-consecutive-cards", "no-dominant-concept", "pool-safety-margin",
      "unique-assets-cover-timeline", "usable-duration-margin",
    ]);
  });

  test("a starved pool still fails on coverage and margins", async () => {
    const r = await assessVisualFeasibility(input("ai-doom-scroll"),
      fixed(monotonePool(4)));
    assert.equal(r.pass, false);
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
    assert.ok(failed.includes("unique-assets-cover-timeline") || failed.includes("pool-safety-margin"),
      `expected a coverage/margin failure, got ${failed.join(",")}`);
    assert.ok(!failed.includes("no-dominant-concept"),
      "the retired cap must never be the reason");
  });

  test("card-share and consecutive-card gates still fail — the HBM defect", async () => {
    // Too few usable seconds to fill the beats, so the timeline falls back to
    // cards. This is exactly what actually caught HBM: 24% cards, not concept
    // share, whose human value was 20.4%.
    const shorts = Array.from({ length: 40 }, (_, i) =>
      candidate(`s-${i}`, `industrial factory assembly line clip ${i}`, 4));
    const r = await assessVisualFeasibility(input("ai-doom-scroll"), fixed(shorts));
    assert.equal(r.pass, false);
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
    assert.ok(failed.some((f) => f === "fallback-card-share" || f === "no-consecutive-cards"
      || f === "usable-duration-margin" || f === "unique-assets-cover-timeline"),
      `expected a card/duration failure, got ${failed.join(",")}`);
  });

  test("the diversity floor still operates on AI Doom", async () => {
    // One concept only: the floor, not the cap, is what should object.
    const single = Array.from({ length: 60 }, (_, i) =>
      candidate(`d-${i}`, `industrial factory assembly line machinery ${i}`, 26));
    const r = await assessVisualFeasibility(input("ai-doom-scroll"), fixed(single));
    const div = r.checks.find((c) => c.name === "concept-diversity")!;
    assert.equal(div.ok, false, "a single-concept pool must still trip the diversity floor");
    assert.equal(r.pass, false);
    assert.match(r.failureReason!, /concept-diversity/);
  });

  test("the other thresholds are untouched", () => {
    assert.equal(MIN_DISTINCT_CONCEPTS, 3);
    assert.equal(MAX_CARD_SHARE, 0.15);
    assert.equal(POOL_SAFETY_FACTOR, 1.25);
    assert.equal(DURATION_SAFETY_FACTOR, 1.25);
  });
});

// ── The evidence stays checkable ──────────────────────────────────────────

describe("the calibration evidence is preserved", () => {
  test("the frozen human timelines are still present", () => {
    const rows = JSON.parse(readFileSync("tests/fixtures/concentration-timelines.json", "utf8"));
    assert.ok(rows.length >= 200, `expected the frozen corpus, got ${rows.length} rows`);
    const scripts = new Set(rows.map((r: { script: string }) => r.script));
    for (const s of ["power", "ewaste", "hbm", "ocr", "enterprise", "olmoearth", "signlang"]) {
      assert.ok(scripts.has(s), `${s} must remain in the calibration corpus`);
    }
  });

  test("no human-measured AI Doom timeline reached the retired cap", () => {
    const rows = JSON.parse(readFileSync("tests/fixtures/concentration-timelines.json", "utf8")) as
      { script: string; seconds: number; label: string }[];
    for (const s of new Set(rows.map((r) => r.script))) {
      const g = rows.filter((r) => r.script === s);
      const m = new Map<string, number>();
      for (const r of g) m.set(r.label, (m.get(r.label) ?? 0) + r.seconds);
      const total = g.reduce((a, r) => a + r.seconds, 0);
      const dom = Math.max(...m.values()) / total;
      assert.ok(dom < MAX_CONCEPT_SHARE,
        `${s} human dominant share ${(dom * 100).toFixed(1)}% should be under the retired cap`);
    }
  });
});
