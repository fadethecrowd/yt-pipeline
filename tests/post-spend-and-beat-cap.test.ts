import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  planSegmentBeats, planVisualBeats, summarizeBeats, BEAT_MAX_S, BEAT_MIN_S,
} from "../packages/pipeline-core/src/lib/visualBeats";

/**
 * Two defects from the 2026-08-16 production run 8fc44982.
 *
 * The candidate bought 5,637 ElevenLabs characters, assembled its narration,
 * and was then refused by videoAssembly: "1 beat(s) exceed the 30s cap", max
 * beat 30.7s. The controller reported FAILED_BEFORE_SPEND.
 *
 * Both are narrow bugs. The planner emitted a beat its own downstream contract
 * forbids, and the classifier described a post-spend failure as pre-spend.
 */

type W = { text: string; start: number; end: number };
const words = (n: number, dur: number, sentenceEvery = 0): W[] => {
  const out: W[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const ends = sentenceEvery > 0 && (i + 1) % sentenceEvery === 0;
    out.push({ text: ends ? `w${i}.` : `w${i}`, start: t, end: t + dur });
    t += dur;
  }
  return out;
};

// ── Bug 1: the planner cannot emit a beat over the assembly cap ──────────

describe("no planned beat may exceed the assembly hard cap", () => {
  test("the cap check no longer fires AFTER the overshooting word", () => {
    // A run of short words followed by one long word. The old code added the
    // long word first and only then noticed the span, emitting a 38.5s beat.
    const w = words(40, 0.9);
    w.push({ text: "loooong.", start: 36, end: 38.5 });
    const beats = planSegmentBeats(w, 0);
    const max = Math.max(...beats.map((b) => b.durationS));
    assert.ok(max <= BEAT_MAX_S, `max beat ${max.toFixed(2)}s exceeds ${BEAT_MAX_S}s`);
  });

  test("a final short remainder is never force-merged past the cap", () => {
    // This is the shape that produced the live 30.7s: a nearly-full beat plus a
    // sub-minimum tail, merged because the final flush passed `force`.
    const w = words(32, 0.9, 32);
    w.push({ text: "tail.", start: 28.8, end: 30.8 });
    const beats = planSegmentBeats(w, 0);
    const max = Math.max(...beats.map((b) => b.durationS));
    assert.ok(max <= BEAT_MAX_S, `max beat ${max.toFixed(2)}s exceeds ${BEAT_MAX_S}s`);
    assert.ok(beats.length >= 2, "the remainder stands alone rather than breaching the cap");
  });

  test("400 randomised word streams never produce an over-cap beat", () => {
    let worst = 0;
    for (let seed = 0; seed < 400; seed++) {
      const w: W[] = [];
      let t = 0;
      const n = 20 + (seed * 7) % 160;
      for (let i = 0; i < n; i++) {
        const dur = 0.15 + ((seed * 13 + i * 29) % 47) / 10;
        w.push({ text: ((seed + i) % 11) === 0 ? `w${i}.` : `w${i}`, start: t, end: t + dur });
        t += dur;
      }
      const beats = planSegmentBeats(w, 0);
      for (const b of beats) {
        worst = Math.max(worst, b.durationS);
        assert.ok(b.durationS <= BEAT_MAX_S,
          `seed ${seed}: beat ${b.durationS.toFixed(2)}s exceeds ${BEAT_MAX_S}s`);
      }
    }
    assert.ok(worst > BEAT_MAX_S * 0.9, `sweep should approach the cap, worst was ${worst.toFixed(2)}s`);
  });

  test("beats still tile the narration with no gap or overlap", () => {
    for (const w of [words(120, 0.4, 9), words(60, 1.7, 5), words(200, 0.25, 13)]) {
      const beats = planSegmentBeats(w, 0);
      assert.equal(beats[0]!.startS, w[0]!.start, "coverage starts at the first word");
      assert.equal(beats[beats.length - 1]!.endS, w[w.length - 1]!.end, "coverage ends at the last word");
      for (let i = 1; i < beats.length; i++) {
        assert.ok(Math.abs(beats[i]!.startS - beats[i - 1]!.endS) < 1e-9,
          `gap/overlap between beat ${i - 1} and ${i}`);
      }
      // Durations sum to the span — no time invented or lost.
      const total = beats.reduce((a, b) => a + b.durationS, 0);
      assert.ok(Math.abs(total - (w[w.length - 1]!.end - w[0]!.start)) < 1e-6);
    }
  });

  test("the minimum-beat policy survives wherever it mathematically can", () => {
    const beats = planSegmentBeats(words(150, 0.5, 8), 0);
    const short = beats.filter((b) => b.durationS < BEAT_MIN_S);
    // At most the final remainder may be short, and only when merging it would
    // have breached the cap.
    assert.ok(short.length <= 1, `${short.length} short beats`);
    if (short.length === 1) assert.equal(short[0]!.index, beats[beats.length - 1]!.index);
  });

  test("assembly's own summary agrees the plan is legal", () => {
    const segs = [words(90, 0.6, 7), words(70, 0.9, 6), words(110, 0.45, 9)];
    let offset = 0;
    const shifted = segs.map((seg) => {
      const out = seg.map((w) => ({ ...w, start: w.start + offset, end: w.end + offset }));
      offset = out[out.length - 1]!.end;
      return out;
    });
    const summary = summarizeBeats(planVisualBeats(shifted));
    assert.equal(summary.overCap.length, 0,
      `the same check videoAssembly runs must be clean: ${JSON.stringify(summary.overCap)}`);
  });

  test("the assembly gate itself is untouched", () => {
    const asm = readFileSync("packages/pipeline-core/src/stages/assemblyShared.ts", "utf8");
    assert.match(asm, /beat\(s\) exceed the \$\{BEAT_MAX_S\}s cap/);
    assert.match(asm, /durationS > BEAT_MAX_S \+ 0\.5/, "the post-render pacing check still applies");
    const beats = readFileSync("packages/pipeline-core/src/lib/visualBeats.ts", "utf8");
    assert.match(beats, /export const BEAT_MAX_S = 30;/, "the cap must not have been raised");
  });
});

// ── Bug 2: a post-spend failure is not pre-spend ─────────────────────────

describe("narration spend is never invisible to the controller", () => {
  const CTRL = readFileSync("scripts/ordinary-production-control.ts", "utf8");

  test("the taxonomy gained exactly one accurate category", () => {
    assert.match(CTRL, /\| "FAILED_AFTER_SPEND"/);
    // The existing ones keep their meaning.
    for (const kept of ["FAILED_BEFORE_SPEND", "FAILED_AFTER_RESERVATION",
                        "UPLOAD_AMBIGUOUS", "QUALITY_FAILED", "SUCCESS_SCHEDULED"]) {
      assert.match(CTRL, new RegExp(`"${kept}"`), `${kept} must still exist`);
    }
  });

  test("classification consults durable charged characters", () => {
    assert.match(CTRL, /narrationCharsFor\(videoId: string\): Promise<number>/);
    assert.match(CTRL, /const charged = video\?\.id \? await deps\.narrationCharsFor\(video\.id\) : 0;/);
    assert.match(CTRL, /elevenLabsUsage\.findMany/);
    assert.match(CTRL, /chargedChars \?\? r\.requestedChars/);
  });

  test("a settled reservation is explicitly not treated as proof of no spend", () => {
    assert.match(CTRL, /A settled reservation is not evidence of no spend/);
  });

  test("the precedence that protects irreversible states is unchanged", () => {
    // Unresolved intent and open reservation are still checked before any
    // terminal classification, and a youtubeId still forces ambiguity.
    const run = CTRL.slice(CTRL.indexOf("export async function doRun"));
    const postSpendAt = run.indexOf('"FAILED_AFTER_SPEND"');
    assert.ok(postSpendAt > 0);
    assert.ok(run.indexOf('outcome: "UPLOAD_AMBIGUOUS"') < postSpendAt,
      "an upload that may exist outranks a known post-spend failure");
    assert.ok(run.indexOf('outcome: "FAILED_AFTER_RESERVATION"') < postSpendAt,
      "an OPEN reservation still outranks a settled purchase");
    assert.match(run, /if \(video\?\.youtubeId\) \{/);
  });

  test("the monitor's post-spend policy is deliberately unchanged", () => {
    // Spend with nothing shipped remains a blocking finding: a human should
    // look when money was bought and no video exists.
    const health = readFileSync("packages/monitor/src/lib/videoHealth.ts", "utf8");
    assert.match(health, /narrationRows > 0/);
    assert.match(health, /provider spend occurred/);
    // And a genuinely clean pre-spend rejection stays diagnostic.
    assert.match(health, /CANDIDATE_REJECTED_BEFORE_SPEND/);
  });

  test("tranche accounting is untouched by the new category", () => {
    // Settlement still happens for every terminal branch, and never returns
    // capacity.
    assert.match(CTRL, /await settle\("FAILED", detail\)/);
    const store = readFileSync("packages/pipeline-core/src/lib/productionTrancheStore.ts", "utf8");
    assert.ok(!/consumedCandidates: *\{ *decrement/.test(store));
  });
});
