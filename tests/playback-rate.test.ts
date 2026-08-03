import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  solvePlaybackRates, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE, AllocationConflictError,
} from "../packages/pipeline-core/src/lib/approvedAllocation";
import type { ApprovedBeat } from "../packages/pipeline-core/src/lib/approvedAllocation";

/**
 * Narration speed and stock playback rate.
 *
 * The approved allocation filled every beat to the second, so most clips used
 * 100% of their source and no beat could absorb narration running long. Rather
 * than rebuild the allocation and discard the human review, narration is
 * delivered slightly faster and stock may be nudged within a bounded range.
 * Identity never moves — only how long each approved clip is on screen.
 */

const beat = (over: Partial<ApprovedBeat> = {}): ApprovedBeat => ({
  beat: 1, durationS: 17.3, narration: "x",
  fragments: [{ assetId: "a", plannedDurationS: 17.3, sourceDurationS: 20 }],
  ...over,
});

describe("rate selection prefers 1.0", () => {
  test("ample source covers the beat at exactly 1.0", () => {
    const r = solvePlaybackRates(beat(), 17.3);
    assert.equal(r.rate, 1, "trimming should cover this, not stretching");
    assert.equal(r.fragments[0]!.playbackRate, 1);
  });

  test("a longer target still uses 1.0 while source allows", () => {
    assert.equal(solvePlaybackRates(beat(), 19.5).rate, 1);
  });

  test("only a genuine shortfall slows playback, and only as far as needed", () => {
    const r = solvePlaybackRates(beat(), 21);            // 20s source, 21s needed
    assert.ok(r.rate < 1 && r.rate >= MIN_PLAYBACK_RATE, `rate ${r.rate}`);
    assert.ok(Math.abs(r.rate - 20 / 21) < 1e-3, "the minimum slowdown that covers it");
  });

  test("output duration is exact after the rate is applied", () => {
    const r = solvePlaybackRates(beat(), 21);
    const shown = r.fragments.reduce((a, f) => a + f.plannedDurationS, 0);
    assert.ok(Math.abs(shown - 21) < 0.01, `shown ${shown}`);
  });
});

describe("bounds fail closed", () => {
  test("a shortfall needing less than 0.92x throws", () => {
    assert.throws(() => solvePlaybackRates(beat(), 30), AllocationConflictError);
  });

  test("the authorised range is exactly 0.92-1.08", () => {
    assert.equal(MIN_PLAYBACK_RATE, 0.92);
    assert.equal(MAX_PLAYBACK_RATE, 1.08);
  });

  test("the renderer rejects an out-of-range rate", () => {
    const src = readFileSync("packages/pipeline-core/src/stages/assemblyShared.ts", "utf8");
    assert.match(src, /rate < MIN_PLAYBACK_RATE|rate > MAX_PLAYBACK_RATE/);
    assert.match(src, /outside \$\{MIN_PLAYBACK_RATE\}-\$\{MAX_PLAYBACK_RATE\}/);
  });

  test("source overrun accounts for the rate", () => {
    const src = readFileSync("packages/pipeline-core/src/stages/assemblyShared.ts", "utf8");
    assert.match(src, /sourceNeeded = \+\(useDur \* rate\)/,
      "screen seconds at rate r consume useDur*r of source");
  });

  test("a fragment shrinking below the floor throws", () => {
    const b = beat({ fragments: [
      { assetId: "a", plannedDurationS: 16, sourceDurationS: 30 },
      { assetId: "b", plannedDurationS: 1.3, sourceDurationS: 2 }] });
    assert.throws(() => solvePlaybackRates(b, 8), AllocationConflictError);
  });
});

describe("the fragment floor is honoured by redistribution, not by failing", () => {
  test("a short clip beside a long one is pinned to the floor", () => {
    // Beat 13's real shape: a 9.4s clip beside a 40.5s clip in a shrinking beat.
    const b = beat({ durationS: 20.5, hasCard: true, cardSecondsS: 4, fragments: [
      { assetId: "short", plannedDurationS: 9.4, sourceDurationS: 9.4 },
      { assetId: "long", plannedDurationS: 7.1, sourceDurationS: 40.5 }] });
    const r = solvePlaybackRates(b, 17.08);
    const shortF = r.fragments.find((f) => f.assetId === "short")!;
    const longF = r.fragments.find((f) => f.assetId === "long")!;
    assert.ok(shortF.plannedDurationS >= 3 - 1e-6, `short got ${shortF.plannedDurationS}s`);
    assert.ok(longF.plannedDurationS >= 3 - 1e-6);
    const total = r.fragments.reduce((a, f) => a + f.plannedDurationS, 0);
    assert.ok(Math.abs(total - (17.08 - 4)) < 0.02, `fragments cover ${total}s of 13.08s`);
  });

  test("redistribution never exceeds a source", () => {
    const b = beat({ durationS: 20, fragments: [
      { assetId: "short", plannedDurationS: 4, sourceDurationS: 4 },
      { assetId: "long", plannedDurationS: 16, sourceDurationS: 40 }] });
    const r = solvePlaybackRates(b, 12);
    for (const f of r.fragments) {
      assert.ok(f.plannedDurationS * (f.playbackRate ?? 1) <= f.sourceDurationS + 1e-6,
        `${f.assetId} overran its source`);
    }
  });

  test("a single-fragment beat may go below the floor rather than fail", () => {
    const r = solvePlaybackRates(beat({ fragments: [
      { assetId: "a", plannedDurationS: 17.3, sourceDurationS: 20 }] }), 2);
    assert.equal(r.fragments.length, 1);
  });
});

describe("cards and continuations are untouched by rate", () => {
  test("a card keeps its exact approved duration", () => {
    const b = beat({ hasCard: true, cardSecondsS: 4, durationS: 20,
      fragments: [{ assetId: "a", plannedDurationS: 16, sourceDurationS: 30 }] });
    const r = solvePlaybackRates(b, 22);
    const shown = r.fragments.reduce((a, f) => a + f.plannedDurationS, 0);
    assert.ok(Math.abs(shown - 18) < 0.01, "fragments cover target minus the fixed card");
  });

  test("carried-in continuation seconds are reserved, not rescaled away", () => {
    const b = beat({ continuedFrom: { assetId: "z", fromBeat: 0, seconds: 3 }, durationS: 20,
      fragments: [{ assetId: "a", plannedDurationS: 17, sourceDurationS: 30 }] });
    const r = solvePlaybackRates(b, 20);
    const shown = r.fragments.reduce((a, f) => a + f.plannedDurationS, 0);
    assert.ok(Math.abs(shown - 17) < 0.01, "own fragments cover target minus carried-in");
  });

  test("a fragment continuing onward never spends its carried seconds twice", () => {
    const b = beat({ durationS: 20, fragments: [
      { assetId: "a", plannedDurationS: 17, sourceDurationS: 20,
        continuesIntoBeat: 2, continuationSeconds: 3 }] });
    const r = solvePlaybackRates(b, 17);
    assert.ok(+(r.fragments[0]!.plannedDurationS * r.rate).toFixed(2) <= 20 - 3 + 0.01,
      "the 3s reserved for the next beat stays reserved");
  });
});

describe("elevenlabs speed is request-scoped", () => {
  const src = readFileSync("packages/pipeline-core/src/lib/elevenlabs.ts", "utf8");

  test("absent speed leaves the request body unchanged", () => {
    assert.match(src, /\.\.\.\(speed !== undefined \? \{ speed \} : \{\}\)/,
      "speed must be spread in only when supplied");
  });

  test("an out-of-range speed throws before any call", () => {
    assert.match(src, /speed < 0\.7 \|\| speed > 1\.2/);
  });

  test("speed joins the idempotency key without breaking existing hashes", () => {
    assert.match(src, /speed === undefined[\s\S]*?\{ text, voiceId, model, outputFormat, stability, similarity \}/,
      "hashes computed before speed existed must still match");
  });

  test("the voiceover stage threads it through", () => {
    const vs = readFileSync("packages/pipeline-core/src/stages/voiceoverShared.ts", "utf8");
    assert.match(vs, /speed\?: number/);
    assert.match(vs, /speed: deps\.speed/);
  });
});
