import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  assessVisualFeasibility, assertVisuallyFeasible, withVisualFeasibilityGate,
  planPreliminaryBeats, feasibilityQueries, VisualFeasibilityError,
  MAX_CARD_SHARE, POOL_SAFETY_FACTOR,
} from "../packages/pipeline-core/src/lib/visualFeasibility";
import { fitFragment } from "../packages/pipeline-core/src/lib/visualBeats";
import type {
  FeasibilityDeps, FeasibilityInput, OutlineSegment,
} from "../packages/pipeline-core/src/lib/visualFeasibility";
import type { Candidate } from "../packages/pipeline-core/src/lib/visuals";

/**
 * These tests reproduce the failure that cost 7,071 ElevenLabs credits: AI Doom
 * qualification asset #1 was narrated, rendered and only then discovered to be
 * unillustratable from the configured source library.
 *
 * Nothing here touches the network. Each case supplies the candidate pool the
 * gate would have received, so a regression shows up as a verdict change rather
 * than as a flaky live-search result.
 */

// ── Fixtures ──────────────────────────────────────────────────────────────

function candidate(
  assetId: string,
  description: string,
  durationS: number,
  opts: { width?: number; height?: number } = {},
): Candidate {
  return {
    assetId,
    url: `https://videos.example/${assetId}.mp4`,
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    durationS,
    provider: "pexels",
    pageUrl: `https://www.pexels.com/video/${description.replace(/\s+/g, "-")}-${assetId}/`,
    description,
  };
}

/** A source that returns the same fixed pool for every query. */
function fixedSource(pool: Candidate[]): FeasibilityDeps {
  return { search: async () => pool };
}

/**
 * The five real segments of AI Doom qualification asset #1, with their real
 * visual prompts, taken from the stored script.
 */
const HBM_SEGMENTS: OutlineSegment[] = [
  {
    segmentIndex: 0,
    title: "What Is HBM and Why Does It Matter?",
    narration: "High bandwidth memory sits beside the accelerator die on the same package. ".repeat(20),
    visual_prompt:
      "Animated diagram showing a traditional DRAM chip far from a GPU on a circuit board, then cut to a 3D render of HBM stacks bonded directly onto an accelerator die. Text overlay: 'HBM = Memory + Speed + Proximity'. B-roll of cleanroom wafer inspection.",
  },
  {
    segmentIndex: 1,
    title: "The Shift: From GPU Shortage to Memory Shortage",
    narration: "The constraint moved from the logic die to the memory stack bonded next to it. ".repeat(12),
    visual_prompt:
      "Split-screen graphic: left side shows GPU supply/demand timeline with 'Easing' label, right side shows HBM supply timeline with 'Sold Out' warning. B-roll of semiconductor fab exterior and wafer production lines.",
  },
  {
    segmentIndex: 2,
    title: "Three Companies Control the Supply",
    narration: "Three suppliers produce high bandwidth memory at volume and all are sold out. ".repeat(12),
    visual_prompt:
      "Infographic showing three logos — SK Hynix, Samsung, Micron — with market share percentages. Animated world map showing fab locations in South Korea and the US. Text overlay: 'HBM Suppliers Worldwide: 3'.",
  },
  {
    segmentIndex: 3,
    title: "The Second Bottleneck: Packaging",
    narration: "Advanced packaging capacity is the second chokepoint behind the memory stacks. ".repeat(12),
    visual_prompt:
      "Animated cross-section diagram of CoWoS packaging showing GPU die and HBM stacks connected through interposer layer. B-roll of TSMC facility exterior. Text overlay: 'CoWoS: The Hidden Chokepoint'.",
  },
  {
    segmentIndex: 4,
    title: "Who Gets Hurt and Who Profits?",
    narration: "Memory vendors capture value that used to accrue to the chip designers. ".repeat(12),
    visual_prompt:
      "Bar chart showing AI infrastructure value distribution shifting from GPU designers to memory vendors year over year. B-roll of large data center buildout, server racks being installed. Text overlay: 'Memory Vendors Capture Growing Value Share'.",
  },
];

/**
 * The 24 unique assets the HBM run actually managed to accept from Pexels,
 * with the durations it actually used. This is the whole usable library that
 * topic had — note how little of it depicts memory, wafers or packaging.
 */
const HBM_OBSERVED_POOL: Candidate[] = [
  candidate("8381452", "a scientist working inside a laboratory", 11.9),
  candidate("32386534", "automated factory conveyor with electronic components", 7.1),
  candidate("8381399", "a scientist holding a form in a laboratory", 8.4),
  candidate("32386533", "automated industrial production line in action", 10.2),
  candidate("9573753", "scientists working in a laboratory", 15.1),
  candidate("32386619", "modern automated warehouse conveyor system", 8.7),
  candidate("9574133", "a person holding a test tube rack in a laboratory", 12.3),
  candidate("37208842", "industrial warehouse storage racks overview", 8.5),
  candidate("38779097", "traffic control room with monitoring screens", 8.9),
  candidate("32386620", "efficient assembly line in modern factory", 8.2),
  candidate("32386606", "automated solar panel production line", 10.3),
  candidate("38736672", "spacious industrial warehouse with high shelves", 23.5),
  candidate("37533331", "automated conveyor with packaging process", 15.0),
  candidate("32386530", "modern semiconductor manufacturing facility", 8.7),
  candidate("32386582", "healthcare worker in laboratory with ppe", 7.6),
  candidate("29064797", "industrial factory operation with machinery and workers", 14.7),
  candidate("38779099", "high tech control room with traffic monitoring", 12.0),
  candidate("32386626", "modern technology automated factory scene", 14.3),
  candidate("30915833", "aerial view of industrial power plant facility", 6.3),
  candidate("32610950", "automated factory peach packaging process", 12.2),
  candidate("38081600", "modern data center in urban business district", 17.6),
  candidate("38540416", "monitors display financial data and charts", 16.0),
  candidate("5028622", "database storage of a server", 19.6),
  candidate("30899654", "aerial view of large industrial factory", 19.8),
];

const HBM_INPUT: FeasibilityInput = {
  channel: "ai-doom-scroll",
  topicTitle: "The AI Chip Shortage Moved From GPUs to Memory",
  targetRuntimeS: 450,
  segments: HBM_SEGMENTS,
};

/** A healthy pool: many distinct, long, on-topic robotics/warehouse clips. */
function healthyPool(n: number, durationS = 26): Candidate[] {
  // Beat-appropriate for HBM_SEGMENTS, which are about DRAM, GPUs, wafers,
  // fabs and packaging. The previous list (robots, warehouses, conveyors,
  // lidar) was "AI-ish" rather than about these beats, and only counted as a
  // healthy pool while scoring asked "is this asset on-topic for the channel?"
  // instead of "does this illustrate this beat?". Still spans four concepts,
  // so the diversity floor is exercised exactly as before.
  const subjects = [
    "close up of a computer processor chip",
    "silicon wafer inspection in a cleanroom",
    "semiconductor manufacturing production line",
    "gpu graphics card on a circuit board",
    "data center server room with racks",
    "engineer inspecting a circuit board in a laboratory",
    "automated wafer production line in a fab",
    "motherboard with microchip close up",
  ];
  return Array.from({ length: n }, (_, i) =>
    candidate(`ok-${i}`, subjects[i % subjects.length], durationS),
  );
}

// ── Preliminary beat planning ─────────────────────────────────────────────

describe("pre-TTS beat planning", () => {
  test("estimates a beat timeline without any word alignment", () => {
    const beats = planPreliminaryBeats(HBM_SEGMENTS, "ai-doom-scroll", 446);
    assert.ok(beats.length > 10, `expected a multi-beat timeline, got ${beats.length}`);
    for (const b of beats) {
      assert.ok(b.durationS <= 30.5, `beat ${b.index} runs ${b.durationS}s, past the 30s cap`);
      assert.ok(b.durationS >= 8, `beat ${b.index} runs ${b.durationS}s, under the 8s floor`);
    }
    // Beats must tile forward in time, never overlap.
    for (let i = 1; i < beats.length; i++) {
      assert.ok(beats[i].startS >= beats[i - 1].endS - 0.01, "beats must not overlap");
    }
    // And they must tile the WHOLE planned runtime.
    const total = beats.reduce((a, b) => a + b.durationS, 0);
    assert.ok(Math.abs(total - 446) < 0.5, `beats must tile 446s, got ${total.toFixed(1)}s`);
  });

  test("beat count follows the target runtime, not the length of the outline text", () => {
    // The same five-paragraph sketch describes both a 6-minute and a 10-minute
    // video. Deriving the timeline from the sketch would have said a
    // six-minute video needs five assets.
    const short = planPreliminaryBeats(HBM_SEGMENTS, "ai-doom-scroll", 200);
    const long = planPreliminaryBeats(HBM_SEGMENTS, "ai-doom-scroll", 600);
    assert.ok(
      long.length > short.length * 2,
      `a 600s runtime must demand far more beats than a 200s one (${short.length} vs ${long.length})`,
    );
  });

  test("builds concrete stock queries, stripping motion-graphics vocabulary", () => {
    const queries = feasibilityQueries(HBM_INPUT);
    assert.ok(queries.length > 0, "expected search queries");
    for (const q of queries) {
      assert.ok(!/infographic|split-screen|bar chart/i.test(q), `query leaked graphic vocabulary: "${q}"`);
    }
  });
});

// ── Fragment fitting ──────────────────────────────────────────────────────

describe("fragment fitting never leaves a sliver", () => {
  test("a source that closes the beat exactly is used whole", () => {
    assert.deepEqual(fitFragment(18, 18), { useS: 18 });
  });

  test("a long source is capped at what the beat still needs", () => {
    assert.deepEqual(fitFragment(12, 40), { useS: 12 });
  });

  test("a remainder another fragment can fill is left alone", () => {
    // 20s left, 12s source → 8s remainder, which is a usable fragment.
    assert.deepEqual(fitFragment(20, 12), { useS: 12 });
  });

  test("a source that would leave a sliver takes less, leaving a fillable remainder", () => {
    // 14s left, 10s source: taking all 10 leaves 4s, too short to be a shot.
    // Take 8s instead and leave exactly one usable fragment behind.
    const fit = fitFragment(14, 10);
    assert.deepEqual(fit, { useS: 8 });
    assert.equal(14 - fit!.useS, 6, "the remainder must itself be a usable fragment");
  });

  test("a source that cannot close the beat cleanly is refused rather than slivered", () => {
    // Regression: 8.6s left with an 8.0s source left 0.6s, which became a
    // 0.6-SECOND branded card. Ten of the HBM asset's fifteen cards were this.
    // The source cannot cover 8.6s, and taking 2.6s is below the minimum, so
    // the only correct answer is to try a different asset.
    assert.equal(fitFragment(8.6, 8.0), null);
    // A longer source closes the same beat with no card at all.
    assert.deepEqual(fitFragment(8.6, 12), { useS: 8.6 });
  });

  test("no fit ever produces a leftover between zero and the minimum fragment", () => {
    for (let remaining = 6; remaining <= 30; remaining += 0.1) {
      for (let src = 6; src <= 35; src += 0.5) {
        const fit = fitFragment(remaining, src);
        if (!fit) continue;
        assert.ok(fit.useS >= 6, `fragment ${fit.useS.toFixed(2)}s is below the minimum`);
        assert.ok(fit.useS <= src + 1e-9, "a fragment can never exceed its source — that would be looping");
        const leftover = remaining - fit.useS;
        assert.ok(
          leftover <= 0.01 || leftover >= 6 - 1e-9,
          `remaining=${remaining.toFixed(1)} src=${src.toFixed(1)} left a ${leftover.toFixed(2)}s sliver`,
        );
      }
    }
  });

  test("a source too short to be a fragment is refused outright", () => {
    assert.equal(fitFragment(20, 3), null, "a 3s source cannot be a fragment");
  });
});

describe("the simulated timeline contains no sliver cards", () => {
  test("every predicted card is at least one fragment long", async () => {
    const report = await assessVisualFeasibility(HBM_INPUT, fixedSource(healthyPool(200, 9)));
    for (const b of report.predictedBeats) {
      if (!b.hasCard) continue;
      assert.ok(
        b.cardSecondsS >= 6,
        `beat ${b.index} predicts a ${b.cardSecondsS.toFixed(1)}s card — a sliver, not a real fallback`,
      );
    }
  });
});

// ── The HBM reproduction ──────────────────────────────────────────────────

describe("HBM topic under the current Pexels-only source", () => {
  test("fails visual feasibility", async () => {
    const report = await assessVisualFeasibility(HBM_INPUT, fixedSource(HBM_OBSERVED_POOL));

    assert.equal(report.pass, false, "HBM must not pass — this is the failure being prevented");
    assert.ok(report.failureReason, "a failing report must state why");
  });

  test("fails specifically because the source library is too small, not because scoring broke", async () => {
    const report = await assessVisualFeasibility(HBM_INPUT, fixedSource(HBM_OBSERVED_POOL));

    // Relevance scoring still works — the bulk of the pool is accepted, so the
    // verdict cannot be blamed on an over-strict scorer.
    assert.ok(
      report.uniqueUsableAssets >= 15,
      `expected the scorer to still accept the bulk of the pool, got ${report.uniqueUsableAssets}/${HBM_OBSERVED_POOL.length}`,
    );
    // What fails is coverage: not enough distinct seconds to fill the runtime.
    const durationCheck = report.checks.find((c) => c.name === "usable-duration-margin");
    assert.equal(durationCheck?.ok, false, "usable-duration margin should fail for HBM");
    assert.ok(
      report.totalUsableDurationS < report.plannedVisualDurationS,
      `usable source (${report.totalUsableDurationS}s) should not even reach the planned visual duration (${report.plannedVisualDurationS}s)`,
    );
  });

  test("would have predicted the card blowout before any narration was bought", async () => {
    const report = await assessVisualFeasibility(HBM_INPUT, fixedSource(HBM_OBSERVED_POOL));
    // The real render produced 15 cards across 39 beats (38.5%).
    assert.ok(
      report.estimatedCardPct > MAX_CARD_SHARE * 100,
      `expected the gate to predict a card share above ${MAX_CARD_SHARE * 100}%, got ${report.estimatedCardPct}%`,
    );
  });
});

// ── Individual failure modes ──────────────────────────────────────────────

describe("feasibility failure modes", () => {
  test("a large raw pool does not pass when few candidates survive relevance and duration checks", async () => {
    // 400 results, but they are generic filler, off-topic performance footage,
    // too short, or below the resolution floor.
    const junk: Candidate[] = [
      ...Array.from({ length: 150 }, (_, i) =>
        candidate(`gen-${i}`, "abstract glowing particles digital background loop animation", 30)),
      ...Array.from({ length: 100 }, (_, i) =>
        candidate(`perf-${i}`, "a woman singing into a microphone in a recording studio", 30)),
      ...Array.from({ length: 100 }, (_, i) =>
        candidate(`short-${i}`, "industrial robot arm on an assembly line", 2)),
      ...Array.from({ length: 50 }, (_, i) =>
        candidate(`lowres-${i}`, "modern automated warehouse conveyor system", 30, { width: 640, height: 360 })),
    ];

    const report = await assessVisualFeasibility(
      { ...HBM_INPUT, topicTitle: "Large but unusable pool" },
      fixedSource(junk),
    );

    assert.equal(report.totalCandidates, 400, "the raw pool really is large");
    assert.equal(report.pass, false, "a large raw pool must not pass on size alone");
    assert.ok(
      report.uniqueUsableAssets < 20,
      `almost nothing should survive, got ${report.uniqueUsableAssets} usable`,
    );
  });

  test("sub-threshold generic footage counts toward nothing", async () => {
    const report = await assessVisualFeasibility(
      HBM_INPUT,
      fixedSource(Array.from({ length: 200 }, (_, i) =>
        candidate(`gen-${i}`, "abstract glowing particles digital background loop animation", 30))),
    );
    assert.equal(report.uniqueUsableAssets, 0, "sub-threshold generic filler must not be counted as usable");
    assert.equal(report.pass, false);
  });

  test("fails when predicted card share exceeds 15%", async () => {
    // Enough assets to start the timeline, then nothing left — cards follow.
    const report = await assessVisualFeasibility(HBM_INPUT, fixedSource(healthyPool(6)));
    assert.ok(
      report.estimatedCardPct > MAX_CARD_SHARE * 100,
      `expected card share above the cap, got ${report.estimatedCardPct}%`,
    );
    const cardCheck = report.checks.find((c) => c.name === "fallback-card-share");
    assert.equal(cardCheck?.ok, false);
    assert.equal(report.pass, false);
  });

  test("fails when unique usable assets are insufficient for the timeline", async () => {
    const report = await assessVisualFeasibility(HBM_INPUT, fixedSource(healthyPool(5)));
    const uniqueCheck = report.checks.find((c) => c.name === "unique-assets-cover-timeline");
    assert.equal(uniqueCheck?.ok, false, "5 assets cannot cover a 7-minute timeline without reuse");
    assert.ok(report.uniqueUsableAssets < report.minUniqueAssetsRequired);
    assert.equal(report.pass, false);
  });

  test("requires the accepted pool to exceed the bare minimum by the safety factor", async () => {
    const bare = await assessVisualFeasibility(HBM_INPUT, fixedSource(healthyPool(200)));
    const needed = bare.minUniqueAssetsRequired;

    // Exactly the minimum, each clip long enough to fill a whole beat on its
    // own: the timeline is covered, but there is no margin for the
    // download/decode losses assembly will incur.
    const exact = await assessVisualFeasibility(HBM_INPUT, fixedSource(healthyPool(needed, 30)));
    assert.equal(
      exact.checks.find((c) => c.name === "unique-assets-cover-timeline")?.ok, true,
      "the bare minimum does cover the timeline",
    );
    assert.equal(
      exact.checks.find((c) => c.name === "pool-safety-margin")?.ok, false,
      `the bare minimum must still fail the ${POOL_SAFETY_FACTOR}x safety margin`,
    );
    assert.equal(exact.requiredPoolWithSafety, Math.ceil(needed * POOL_SAFETY_FACTOR));
  });
});

// ── No double counting ────────────────────────────────────────────────────

describe("assets cannot be counted more than once", () => {
  test("the same asset returned by many queries is pooled once", async () => {
    const one = candidate("dup-1", "industrial robot arm on an assembly line", 25);
    // Every query returns the same three assets, repeated within the response.
    const source: FeasibilityDeps = {
      search: async () => [one, one, one, candidate("dup-2", "modern automated warehouse conveyor system", 25)],
    };
    const report = await assessVisualFeasibility(HBM_INPUT, source);

    assert.equal(report.totalCandidates, 2, "de-duplication happens at retrieval");
    assert.ok(report.uniqueUsableAssets <= 2);
  });

  test("no asset appears twice on the predicted timeline", async () => {
    const report = await assessVisualFeasibility(HBM_INPUT, fixedSource(healthyPool(200)));
    const used = report.predictedBeats.flatMap((b) => b.fragments.map((f) => f.assetId));
    assert.equal(
      new Set(used).size, used.length,
      "an asset placed on the predicted timeline must never be placed again",
    );
  });

  test("usable duration credits each asset once, capped at one beat's length", async () => {
    // A 300s source clip cannot single-handedly cover a 300s timeline: assembly
    // caps any one clip at BEAT_MAX_S and never reuses it.
    const report = await assessVisualFeasibility(
      HBM_INPUT,
      fixedSource([candidate("huge", "industrial robot arm on an assembly line", 300)]),
    );
    assert.ok(
      report.totalUsableDurationS <= 30,
      `one clip must contribute at most one beat's worth, got ${report.totalUsableDurationS}s`,
    );
    assert.equal(report.pass, false);
  });
});

// ── Brand risk ────────────────────────────────────────────────────────────

describe("brand-risk footage cannot silently satisfy the minimum", () => {
  test("a pool made entirely of brand-risk aerials fails even when large enough", async () => {
    // Aerial industrial footage is exactly the category that produced the
    // "Volkswagen Chattanooga" frame: admissible on metadata, high risk of
    // unrelated signage in the frame.
    const aerials = Array.from({ length: 200 }, (_, i) =>
      candidate(`aerial-${i}`, "aerial view of large industrial factory warehouse", 26));

    const report = await assessVisualFeasibility(HBM_INPUT, fixedSource(aerials));

    assert.ok(report.brandRiskCandidates > 0, "these must be flagged as brand-risk");
    assert.equal(
      report.uniqueUsableAssetsExcludingBrandRisk, 0,
      "there is no non-brand-risk footage in this pool",
    );
    assert.equal(
      report.checks.find((c) => c.name === "brand-risk-not-load-bearing")?.ok, false,
      "brand-risk footage must not be allowed to carry the minimum by itself",
    );
    assert.equal(report.pass, false);
  });

  test("footage carrying irrelevant visible branding is rejected outright", async () => {
    const branded = Array.from({ length: 100 }, (_, i) =>
      candidate(`vw-${i}`, "volkswagen assembly line robot arm", 26));
    const report = await assessVisualFeasibility(HBM_INPUT, fixedSource(branded));
    assert.equal(
      report.uniqueUsableAssets, 0,
      "narration never mentions Volkswagen, so the footage cannot be used",
    );
  });
});

// ── Ordering: the gate runs before ElevenLabs ─────────────────────────────

describe("the gate runs before ElevenLabs", () => {
  test("narration is purchased only after feasibility passes", async () => {
    const order: string[] = [];
    const source: FeasibilityDeps = {
      search: async () => { order.push("visual-search"); return healthyPool(200); },
    };

    const { report } = await withVisualFeasibilityGate(HBM_INPUT, source, async () => {
      order.push("elevenlabs");
      return "narration";
    });

    assert.equal(report.pass, true, "this pool should pass");
    assert.equal(order[0], "visual-search", "visual search must happen first");
    assert.equal(order[order.length - 1], "elevenlabs", "TTS must be last");
    assert.ok(
      order.indexOf("visual-search") < order.indexOf("elevenlabs"),
      "feasibility must be established before a single character is sent to TTS",
    );
  });

  test("a failed feasibility check consumes zero ElevenLabs credits", async () => {
    let charactersSent = 0;
    let ttsCalls = 0;

    await assert.rejects(
      () => withVisualFeasibilityGate(HBM_INPUT, fixedSource(HBM_OBSERVED_POOL), async () => {
        ttsCalls += 1;
        charactersSent += HBM_SEGMENTS.reduce((a, s) => a + s.narration.length, 0);
        return "narration";
      }),
      VisualFeasibilityError,
    );

    assert.equal(ttsCalls, 0, "TTS must not be invoked at all when feasibility fails");
    assert.equal(charactersSent, 0, "zero characters — therefore zero credits");
  });

  test("assertVisuallyFeasible throws rather than returning a failing report", async () => {
    await assert.rejects(
      () => assertVisuallyFeasible(HBM_INPUT, fixedSource(HBM_OBSERVED_POOL)),
      (e: unknown) => {
        assert.ok(e instanceof VisualFeasibilityError);
        assert.equal(e.report.pass, false);
        assert.ok(e.message.includes("no narration will be purchased"));
        return true;
      },
      "the gate must fail closed",
    );
  });
});

// ── The report itself ─────────────────────────────────────────────────────

describe("machine-readable feasibility report", () => {
  test("records every required field", async () => {
    const report = await assessVisualFeasibility(HBM_INPUT, fixedSource(HBM_OBSERVED_POOL));
    for (const field of [
      "topic", "targetRuntimeS", "expectedBeatCount", "searchQueries",
      "totalCandidates", "relevantCandidates", "strongCandidates",
      "acceptableCandidates", "genericCandidates", "rejectedCandidates",
      "brandRiskCandidates", "uniqueUsableAssets", "totalUsableDurationS",
      "estimatedCardCount", "estimatedCardPct", "estimatedConsecutiveCardRisk",
      "pass", "failureReason",
    ]) {
      assert.ok(field in report, `report is missing "${field}"`);
    }
    assert.ok(JSON.parse(JSON.stringify(report)), "report must serialise cleanly");
  });

  test("a passing topic reports no failure reason", async () => {
    const report = await assessVisualFeasibility(HBM_INPUT, fixedSource(healthyPool(200)));
    assert.equal(report.pass, true);
    assert.equal(report.failureReason, null);
    assert.ok(report.checks.every((c) => c.ok), "every check must pass on a passing report");
  });
});
