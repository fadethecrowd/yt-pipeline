import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assessVisualFeasibility, MAX_CARD_SHARE, MIN_DISTINCT_CONCEPTS,
} from "@yt-pipeline/pipeline-core";
import { MIN_FRAGMENT_S, fitFragment } from "../packages/pipeline-core/src/lib/visualBeats";
import type { Candidate, FeasibilityDeps, OutlineSegment } from "@yt-pipeline/pipeline-core";

/**
 * Two fallback cards in a row, from 237 usable assets.
 *
 * Candidate cmsw0oo590003mb6ni969zizf failed pre-spend on 2026-08-16 with every
 * feasibility check passing except one: `no-consecutive-cards`, one adjacent
 * pair. It had 23 beats, 522 candidates, 237 usable, 203 non-brand-risk,
 * 3960 s of usable footage against 23 required assets, and only 2 predicted
 * cards (8.7%, well under the 15% cap).
 *
 * That is not a shortage. Tracing the planner explains it:
 *
 *   - assignment is greedy and single-pass over beats, and the ledger allows
 *     each asset once
 *   - `fitFragment` refuses any fit that would leave a sliver shorter than
 *     MIN_FRAGMENT_S, which is correct and is what keeps sub-six-second cards
 *     out of the timeline
 *   - so a beat left with 6-12 s can only be closed by an asset long enough to
 *     cover the whole remainder, and the fill loop has already tried every
 *     asset still available
 *   - meaning at card time no available asset was long enough — the long ones
 *     were spent earlier, on beats a shorter clip would have served
 *
 * The repair is therefore a SWAP, never a lookup: move a long clip from a beat
 * that does not need its length onto the beat that cannot close, and backfill
 * the donor with an unused clip covering exactly the same seconds.
 *
 * The rule itself is untouched. Adjacent cards remain prohibited; what changed
 * is that the planner now tries to rearrange before giving up.
 */

const CH = "ai-doom-scroll" as const;

function candidate(assetId: string, description: string, durationS: number): Candidate {
  return {
    assetId, url: `https://videos.example/${assetId}.mp4`,
    width: 1920, height: 1080, durationS, provider: "pexels",
    pageUrl: `https://www.pexels.com/video/${assetId}/`,
    description,
  };
}
const fixed = (pool: Candidate[]): FeasibilityDeps => ({ search: async () => pool });

/** Robotics/compute narration, so the pool below is genuinely on-beat. */
const SEGMENTS: OutlineSegment[] = Array.from({ length: 6 }, (_, i) => ({
  segmentIndex: i,
  title: `Segment ${i}`,
  narration: ("Industrial robot arms now run the automated assembly line inside modern manufacturing " +
    "plants, machine vision cameras inspect every part, and engineers monitor the line from a " +
    "research workstation. ").repeat(10),
  visual_prompt: "A manufacturing plant floor with automated assembly line machinery, robot arms, " +
    "machine vision cameras, and engineers monitoring from a research workstation",
}));

const input = () => ({
  channel: CH, topicTitle: "Consecutive card repair fixture",
  targetRuntimeS: 450, segments: SEGMENTS,
});

/**
 * A pool with plenty of on-beat footage but a deliberately limited supply of
 * LONG clips — the shape that produces the defect. Short clips are abundant.
 */
function pool(opts: { longClips: number; shortClips: number }): Candidate[] {
  // On-beat for an automated plant floor, and deliberately spanning several
  // concepts so concept-diversity is exercised rather than accidentally met.
  const subjects = [
    "robot arm in operation",
    "industrial robot arm on an automated assembly line",
    "automated manufacturing plant floor with machinery",
    "conveyor system in an automated industrial plant",
    "machine vision camera inspecting parts",
    "engineer at a laboratory research workstation",
  ];
  const out: Candidate[] = [];
  for (let i = 0; i < opts.longClips; i++) {
    out.push(candidate(`long-${i}`, `${subjects[i % subjects.length]} number ${i}`, 40));
  }
  for (let i = 0; i < opts.shortClips; i++) {
    out.push(candidate(`short-${i}`, `${subjects[i % subjects.length]} shot ${i}`, 9));
  }
  return out;
}

const checkOf = (r: { checks: { name: string; ok: boolean; detail: string }[] }, name: string) =>
  r.checks.find((c) => c.name === name)!;

// ── The rule itself is unchanged ─────────────────────────────────────────

describe("21. no-consecutive-cards remains a hard zero-pair invariant", () => {
  test("the check still fails on any adjacent pair", () => {
    const src = readFileSync("packages/pipeline-core/src/lib/visualFeasibility.ts", "utf8");
    assert.match(src, /name: "no-consecutive-cards"/);
    assert.match(src, /consecutiveCardRisk === 0/,
      "zero pairs, not a tolerance");
  });

  test("the repair runs BEFORE the statistics, so nothing is graded pre-repair", () => {
    const src = readFileSync("packages/pipeline-core/src/lib/visualFeasibility.ts", "utf8");
    assert.ok(src.indexOf("repairConsecutiveCards({") < src.indexOf("// ── 5. Timeline statistics"),
      "checks must see the repaired timeline");
  });

  test("12. the repair is one pass with no loop back into itself", () => {
    const src = readFileSync("packages/pipeline-core/src/lib/visualFeasibility.ts", "utf8");
    assert.equal((src.match(/repairConsecutiveCards\(\{/g) ?? []).length, 1,
      "a second call site would be an optimisation loop");
    // Slice from the declaration so the doc comment above it, which names the
    // function in prose, is not mistaken for a call.
    const fn = src.slice(src.indexOf("function repairConsecutiveCards(input:"),
      src.indexOf("// ── The gate ─"));
    const body = fn.slice(fn.indexOf("{"));
    assert.ok(!body.includes("repairConsecutiveCards("), "it must not recurse");
  });
});

// ── 1-8. The repair works when the pool allows it ────────────────────────

describe("1-8. a repairable arrangement is repaired, then fully re-checked", () => {
  test("1/2. abundant alternatives: the plan passes with zero adjacent cards", async () => {
    const r = await assessVisualFeasibility(input(), fixed(pool({ longClips: 40, shortClips: 120 })));
    assert.equal(checkOf(r, "no-consecutive-cards").ok, true, checkOf(r, "no-consecutive-cards").detail);
    assert.equal(r.pass, true, `expected PASS, got: ${r.failureReason}`);
  });

  test("3. the fallback-card cap is never raised, and share stays under it", async () => {
    const r = await assessVisualFeasibility(input(), fixed(pool({ longClips: 40, shortClips: 120 })));
    assert.equal(MAX_CARD_SHARE, 0.15);
    assert.equal(checkOf(r, "fallback-card-share").ok, true);
  });

  test("4. every fragment on the repaired timeline is a real relevance match", async () => {
    const r = await assessVisualFeasibility(input(), fixed(pool({ longClips: 40, shortClips: 120 })));
    for (const b of r.predictedBeats) {
      for (const f of b.fragments) {
        assert.notEqual(f.verdict, "REJECT",
          `beat ${b.index} carries a rejected asset — relevance must never be relaxed to avoid a card`);
      }
    }
  });

  test("5. no asset appears twice after repair", async () => {
    const r = await assessVisualFeasibility(input(), fixed(pool({ longClips: 40, shortClips: 120 })));
    const ids = r.predictedBeats.flatMap((b) => b.fragments.map((f) => f.assetId));
    assert.equal(new Set(ids).size, ids.length, "a swap must not introduce reuse");
  });

  test("6/7. brand-risk and concept diversity are still enforced afterwards", async () => {
    const r = await assessVisualFeasibility(input(), fixed(pool({ longClips: 40, shortClips: 120 })));
    assert.equal(checkOf(r, "brand-risk-not-load-bearing").ok, true);
    assert.equal(checkOf(r, "concept-diversity").ok, true);
    assert.ok(MIN_DISTINCT_CONCEPTS >= 3);
  });

  test("8. the whole suite of checks runs on the repaired plan", async () => {
    const r = await assessVisualFeasibility(input(), fixed(pool({ longClips: 40, shortClips: 120 })));
    for (const name of ["fallback-card-share", "no-consecutive-cards", "unique-assets-cover-timeline",
                        "pool-safety-margin", "usable-duration-margin", "brand-risk-not-load-bearing",
                        "concept-diversity", "no-dominant-concept"]) {
      assert.ok(r.checks.some((c) => c.name === name), `${name} must still be evaluated`);
    }
  });

  test("timeline coverage is preserved — a swap moves seconds, it does not create them", async () => {
    const r = await assessVisualFeasibility(input(), fixed(pool({ longClips: 40, shortClips: 120 })));
    for (const b of r.predictedBeats) {
      const covered = b.fragments.reduce((a, f) => a + f.durationS, 0) + b.cardSecondsS;
      assert.ok(Math.abs(covered - b.durationS) < 0.05,
        `beat ${b.index}: ${covered.toFixed(2)}s covered vs ${b.durationS.toFixed(2)}s`);
    }
  });
});

// ── 13-14, 19. When it must still fail ───────────────────────────────────

describe("13-14, 19. an unrepairable plan still fails", () => {
  test("13/14. no long clip to donate: the candidate fails as before", async () => {
    // Every clip is a 9-second short. Nothing can ever close a 6-12s remainder
    // that a short clip cannot cover, and there is nothing to swap.
    const r = await assessVisualFeasibility(input(), fixed(pool({ longClips: 0, shortClips: 200 })));
    if (!checkOf(r, "no-consecutive-cards").ok) {
      assert.equal(r.pass, false, "adjacency must remain terminal when it cannot be repaired");
    }
  });

  test("19. a starved pool fails on its real defect, not on adjacency", async () => {
    const r = await assessVisualFeasibility(input(), fixed(pool({ longClips: 2, shortClips: 4 })));
    assert.equal(r.pass, false);
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
    assert.ok(failed.some((n) => n === "pool-safety-margin" || n === "usable-duration-margin"
      || n === "unique-assets-cover-timeline"),
      `a genuinely insufficient pool must fail on supply: ${failed.join(", ")}`);
  });

  test("an empty pool fails and repairs nothing", async () => {
    const r = await assessVisualFeasibility(input(), fixed([]));
    assert.equal(r.pass, false);
  });
});

// ── 15-18. What a repair may and may not use ─────────────────────────────

describe("15-18. the swap obeys every constraint it could otherwise trade away", () => {
  const FN = (() => {
    const src = readFileSync("packages/pipeline-core/src/lib/visualFeasibility.ts", "utf8");
    return src.slice(src.indexOf("function repairConsecutiveCards(input:"), src.indexOf("// ── The gate ─"));
  })();

  test("15. a rejected asset can never be used, on either side of the swap", () => {
    assert.equal((FN.match(/verdict === "REJECT"/g) ?? []).length, 2,
      "both the donated asset and the backfill must clear the relevance bar");
    assert.equal((FN.match(/score < REJECT_THRESHOLD/g) ?? []).length, 2);
  });

  test("16. the backfill must be unused — uniqueness is checked, not assumed", () => {
    assert.match(FN, /ledger\.isAvailable\(backfill\.candidate\.assetId\)/);
    assert.match(FN, /ledger\.claim\(pick\.backfill\.candidate\.assetId\)/);
  });

  test("17/18. ranking prefers non-brand-risk, then the strongest match", () => {
    assert.match(FN, /Number\(a\.brandRisk\) - Number\(b\.brandRisk\) \|\|\s*\n\s*b\.targetScore - a\.targetScore/);
    assert.match(FN, /b\.backfillScore - a\.backfillScore/);
    assert.match(FN, /localeCompare/, "ties must break deterministically");
  });

  test("the donated asset must close the beat outright, not shrink the card", () => {
    assert.match(FN, /donorAsset\.usableS < need/);
    assert.match(FN, /target\.hasCard = false/);
  });

  test("the backfill must cover exactly the seconds it replaces", () => {
    assert.match(FN, /backfill\.usableS < frag\.durationS/);
    assert.match(FN, /Math\.abs\(fit\.useS - frag\.durationS\) > 0\.01/);
  });

  test("9/10/11. it touches no candidate, run, tranche or spend path", () => {
    for (const forbidden of ["claimSlot", "RunSummary", "withBudgetWindow", "reserveCredits",
                             "elevenlabs", "productionTranche", "prisma"]) {
      assert.ok(!FN.toLowerCase().includes(forbidden.toLowerCase()),
        `the repair must not reference ${forbidden}`);
    }
  });
});

// ── The real 23-beat shape ───────────────────────────────────────────────

describe("regression: the 2026-08-16 shape", () => {
  /**
   * Reconstructed from the logged feasibility result, not from stored
   * fragments — the gate records `predictedBeats` on the result it returns but
   * the historical row kept only the summary, so exact per-beat assignments
   * cannot be replayed. The fixture reproduces the CONDITIONS that produced it:
   * many beats, abundant on-beat footage, and a long-clip supply thin enough
   * that greedy assignment strands a late beat.
   */
  test("abundant assets, few cards, and adjacency is resolved rather than fatal", async () => {
    const r = await assessVisualFeasibility(input(), fixed(pool({ longClips: 30, shortClips: 210 })));
    assert.ok(r.uniqueUsableAssets > 100, `${r.uniqueUsableAssets} usable assets`);
    assert.equal(checkOf(r, "no-consecutive-cards").ok, true);
    const cards = r.predictedBeats.filter((b) => b.hasCard).length;
    assert.ok(cards / r.predictedBeats.length <= MAX_CARD_SHARE,
      `${cards}/${r.predictedBeats.length} cards`);
    assert.equal(r.pass, true, r.failureReason);
  });

  test("the fix is general — no run, candidate or topic is named anywhere", () => {
    const src = readFileSync("packages/pipeline-core/src/lib/visualFeasibility.ts", "utf8");
    for (const id of ["cmsw0oo590003mb6ni969zizf", "0c9501d2", "Dali Rajic", "OpenAI appoints"]) {
      assert.ok(!src.includes(id), `${id} must not be special-cased`);
    }
  });

  test("the sliver rule that makes this possible is unchanged", () => {
    assert.equal(MIN_FRAGMENT_S, 6);
    assert.equal(fitFragment(8.6, 8.0), null, "a 0.6s sliver is still refused");
    assert.deepEqual(fitFragment(10, 40), { useS: 10 }, "a long clip still closes a beat outright");
  });
});
