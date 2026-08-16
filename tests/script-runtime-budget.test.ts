import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  scriptBudget, segmentBudgets, runtimeForChars, charsForRuntime, runtimeRange,
  CHARS_PER_SECOND, TITLE_CARD_S, RATE_OPTIMISM, RuntimeTargetError,
} from "@yt-pipeline/pipeline-core";
import { measureLength, MAX_LENGTH_REPAIRS } from "../src/stages/scriptGenerator";

/**
 * Why a script the generator called "~312s total" was measured at 8.1 minutes.
 *
 * The first real ordinary-production candidate (cmstndj720001mbhnung9cual,
 * "Google is making private AI practical with homomorphic encryption") passed
 * quality at 88/100 and was then refused before spend:
 *
 *   visual feasibility: 6181 spoken chars renders 8.1 min, outside 5-8 min
 *
 * Two estimates of the same script, 174 seconds apart. Neither was noise:
 *
 *   - "~312s total" was `estimatedTotalDuration`, a number the MODEL declares
 *     in its own JSON output. Nothing computed it from the text and nothing
 *     checked it.
 *   - "8.1 min" was 6181 chars ÷ 12.86 chars/s + a 4 s title card, from the
 *     speech rate measured off real renders.
 *
 * They disagreed because the generator had no numeric budget at all.
 * `lengthInstruction()` read TARGET_RUNTIME_SECONDS from the environment and,
 * when absent, returned the bare string "3-6 minutes". Only `qualify.ts` and
 * `prepare-qualification-review.ts` ever set that variable — which is exactly
 * why both qualification videos landed inside the envelope and the first
 * ordinary production run did not.
 *
 * The gate was right, and it is generous: at the rate measured from real
 * renders that script would have run 8.33 minutes, not 8.1.
 */

const AI = "ai-doom-scroll" as const;
const PROD = "PRODUCTION" as const;
const LF = "LONGFORM" as const;

/** Measured end to end from the two published qualification videos. */
const REAL = [
  { id: "3wAZeMbs3nc", chars: 5263, runtimeS: 424.2 },
  { id: "KD2QDUsr0HA", chars: 5528, runtimeS: 449.566667 },
];

const SRC = readFileSync("src/stages/scriptGenerator.ts", "utf8");

// ── 1-8. One contract ────────────────────────────────────────────────────

describe("1-8. generator and gate share one length contract", () => {
  test("1/2. the generator's budget comes from the shared module", () => {
    assert.match(SRC, /scriptBudget\(AI_DOOM_CHANNEL, "LONGFORM", currentTestStage\(\)\)/);
    // The inline copy of the speech rate is gone.
    assert.ok(!/12\.86/.test(SRC), "the generator must not carry its own copy of the rate");
  });

  test("the env-var dependency and its unbudgeted fallback are gone", () => {
    // Named in the doc comment that explains the history; what must be gone is
    // the READ, which is what made production fall back to no budget at all.
    assert.ok(!/process\.env\.TARGET_RUNTIME_SECONDS/.test(SRC),
      "production must not depend on a variable only the qualification scripts set");
    assert.ok(!/return "3-6 minutes"/.test(SRC),
      "there must be no path that ships a script with no numeric budget");
  });

  test("3. the character ceiling is derived, not restated", () => {
    const b = scriptBudget(AI, LF, PROD);
    const range = runtimeRange(AI, LF, PROD);
    assert.equal(b.minChars, charsForRuntime(AI, range.minS));
    assert.equal(b.maxS, range.maxS);
    assert.equal(b.minS, range.minS);
  });

  test("4. the generator's cap sits BELOW the gate's ceiling", () => {
    const b = scriptBudget(AI, LF, PROD);
    const gateCeiling = charsForRuntime(AI, b.maxS);
    assert.ok(b.maxChars < gateCeiling,
      `generator cap ${b.maxChars} must be under the gate ceiling ${gateCeiling}`);
    assert.ok(b.targetChars < b.maxChars, "the target must leave room under the cap");
  });

  test("a script written to the cap still lands inside the envelope at the REAL rate", () => {
    const b = scriptBudget(AI, LF, PROD);
    const measured = REAL.reduce((a, r) => a + r.chars / (r.runtimeS - TITLE_CARD_S), 0) / REAL.length;
    const actualS = b.maxChars / measured + TITLE_CARD_S;
    assert.ok(actualS <= b.maxS,
      `a script at the cap renders ${actualS.toFixed(1)}s, over the ${b.maxS}s envelope`);
  });

  test("5. the generator no longer permits a 20% overshoot", () => {
    assert.ok(!/words \* 1\.2/.test(SRC),
      "a 20% overshoot allowance is a third of the way out of the envelope");
    assert.match(SRC, /NEVER exceed/);
  });

  test("6. an unknown channel fails closed", () => {
    assert.throws(() => scriptBudget("mystery" as never, LF, PROD), RuntimeTargetError);
    assert.throws(() => runtimeForChars("mystery" as never, 1000), RuntimeTargetError);
  });

  test("7/8. Wet Circuit keeps its own distinct envelope", () => {
    const ai = scriptBudget(AI, LF, PROD);
    const wc = scriptBudget("wet-circuit" as never, LF, PROD);
    assert.notEqual(wc.maxS, ai.maxS);
    assert.notEqual(wc.charsPerSecond, ai.charsPerSecond);
    assert.equal(wc.charsPerSecond, CHARS_PER_SECOND["wet-circuit"]);
    const wcSrc = readFileSync("packages/wc-pipeline/src/stages/scriptGenerator.ts", "utf8");
    assert.ok(!wcSrc.includes("scriptBudget"), "WC's generator is deliberately untouched here");
  });
});

// ── 9-13. Calibration against real renders ───────────────────────────────

describe("9-13. the gate's model is the one that matches reality", () => {
  test("9/10. both published videos are predicted within 5%", () => {
    for (const r of REAL) {
      const predicted = runtimeForChars(AI, r.chars);
      const errPct = Math.abs(predicted - r.runtimeS) / r.runtimeS;
      assert.ok(errPct < 0.05,
        `${r.id}: predicted ${predicted.toFixed(1)}s vs actual ${r.runtimeS}s (${(errPct * 100).toFixed(1)}%)`);
    }
  });

  test("the error is consistently SHORT, which is why targets need headroom", () => {
    for (const r of REAL) {
      assert.ok(runtimeForChars(AI, r.chars) < r.runtimeS,
        `${r.id}: the model must under-predict, not over-predict`);
    }
    // And the documented optimism matches what the two videos actually show.
    const measured = REAL.map((r) => r.chars / (r.runtimeS - TITLE_CARD_S));
    const mean = measured.reduce((a, b) => a + b, 0) / measured.length;
    const optimism = (CHARS_PER_SECOND[AI] - mean) / mean;
    assert.ok(Math.abs(optimism - RATE_OPTIMISM) < 0.01,
      `RATE_OPTIMISM ${RATE_OPTIMISM} should track the measured ${optimism.toFixed(3)}`);
  });

  test("11. the failed 6,181-char script is correctly outside the envelope", () => {
    const b = scriptBudget(AI, LF, PROD);
    const projected = runtimeForChars(AI, 6181);
    assert.ok(projected > b.maxS,
      `6181 chars projects ${projected.toFixed(1)}s, which must exceed ${b.maxS}s`);
    assert.ok(Math.abs(projected / 60 - 8.1) < 0.05, "reproduces the 8.1 min the gate reported");
  });

  test("12. the old '~312s' is explained: it was the model's own claim", () => {
    // Nothing in the codebase computes 312 from 6,181 characters. The only way
    // to that number is a field the model filled in itself.
    assert.match(SRC, /estimatedTotalDuration: z\.number\(\)\.positive\(\)/);
    const fromText = runtimeForChars(AI, 6181);
    assert.ok(fromText > 400, `a text-derived estimate is ${fromText.toFixed(0)}s, nowhere near 312s`);
  });

  test("13. the log now reports the computed estimate, labelling the model's claim", () => {
    assert.match(SRC, /spoken chars/);
    assert.match(SRC, /projected/);
    assert.match(SRC, /model self-reported/);
  });
});

// ── 14-31. Bounded length repair ─────────────────────────────────────────

describe("14-31. bounded, deterministic length repair", () => {
  const b = scriptBudget(AI, LF, PROD);
  const m = (spokenChars: number) => measureLength({
    spokenChars, targetChars: b.targetChars, maxChars: b.maxChars, minChars: b.minChars,
  });

  test("16/17. per-segment budgets are derived and sum to the total", () => {
    for (const n of [4, 5, 6]) {
      const seg = segmentBudgets(b, n);
      assert.equal(seg.length, n);
      assert.equal(seg.reduce((a, x) => a + x.targetChars, 0), b.targetChars, `${n} segments`);
      assert.equal(seg.reduce((a, x) => a + x.maxChars, 0), b.maxChars, `${n} segments`);
    }
  });

  test("the first and last segments carry the hook and CTA, so they run longer", () => {
    const seg = segmentBudgets(b, 6);
    assert.ok(seg[0]!.targetChars > seg[2]!.targetChars);
    assert.ok(seg[5]!.targetChars > seg[2]!.targetChars);
  });

  test("a nonsensical segment count fails closed", () => {
    for (const n of [0, -1, 2.5, Number.NaN]) {
      assert.throws(() => segmentBudgets(b, n), RuntimeTargetError, `${n}`);
    }
  });

  test("18. a script inside the envelope needs no repair", () => {
    for (const chars of [b.minChars, b.targetChars, b.maxChars]) {
      assert.equal(m(chars).verdict, "OK", `${chars}`);
    }
  });

  test("19/20. the real 7226-char script is OVER and gets repair attempts", () => {
    const state = m(7226);
    assert.equal(state.verdict, "OVER");
    assert.ok(state.spokenChars / state.maxChars - 1 > 0.20, "this is the 22% case");
    // The old rule refused anything past 15%; the bound is now on attempts.
    assert.equal(MAX_LENGTH_REPAIRS, 2);
  });

  test("the previous 15% eligibility band is gone", () => {
    assert.ok(!/MAX_CORRECTABLE_OVERFLOW|0\.15/.test(SRC),
      "a threshold nobody measured must not decide whether repair is attempted");
  });

  test("29. a short script is repaired toward target, not ignored", () => {
    const state = m(3000);
    assert.equal(state.verdict, "UNDER");
    assert.match(state.detail, /under the .* minimum/);
  });

  test("21/22/23. repair keeps the candidate, run and tranche untouched", () => {
    const region = SRC.slice(SRC.indexOf("async function repairScriptLength"));
    for (const forbidden of ["claimSlot", "video.create", "RunSummary", "settleSlot",
                             "withBudgetWindow", "reserveCredits", "elevenlabs"]) {
      assert.ok(!region.toLowerCase().includes(forbidden.toLowerCase()),
        `repair must not touch ${forbidden}`);
    }
  });

  test("24/25/26. the ladder is generate → repair → regenerate, counting each time", () => {
    const ladder = SRC.slice(SRC.indexOf("// ── Bounded length repair"), SRC.indexOf("// The model's own"));
    assert.match(ladder, /attempt <= MAX_LENGTH_REPAIRS/);
    assert.match(ladder, /attempt === 1\s*\n?\s*\? await repairScriptLength/);
    assert.match(ladder, /: await generateScript\(anthropic, ctx\)/);
    assert.match(ladder, /state = measure\(script\)/, "every step must re-count from the text");
  });

  test("27/28. after the bound it terminates — no third action, no loop", () => {
    const ladder = SRC.slice(SRC.indexOf("// ── Bounded length repair"), SRC.indexOf("// The model's own"));
    assert.match(ladder, /if \(state\.verdict !== "OK"\) \{/);
    assert.match(ladder, /success: false/);
    assert.match(ladder, /repair attempt\(s\)/);
    // The only loop is the bounded for; nothing recurses.
    assert.equal((ladder.match(/for \(/g) ?? []).length, 1);
    assert.ok(!/while \(/.test(ladder));
  });

  test("30/31. qualityGate only ever sees a length-valid script", () => {
    const pipeline = readFileSync("src/pipeline.ts", "utf8");
    const gen = pipeline.indexOf('name: "scriptGenerator"');
    const qa = pipeline.indexOf('name: "qualityGate"');
    const vf = pipeline.indexOf('name: "visualFeasibilityGate"');
    assert.ok(gen < qa && qa < vf, "ordering must stay generate → quality → feasibility");
    // Length is settled inside scriptGenerator, so an over-budget script never
    // reaches the judge.
    const ladder = SRC.slice(SRC.indexOf("// ── Bounded length repair"), SRC.indexOf("// The model's own"));
    assert.match(ladder, /return \{\s*\n?\s*success: false/);
    // A returned failure is not retried — withRetry only retries a throw — so
    // the ladder is exactly one generation plus MAX_LENGTH_REPAIRS actions.
    const retry = readFileSync("packages/pipeline-core/src/lib/retry.ts", "utf8");
    assert.match(retry, /catch \(err\)/);
    assert.ok(!/if \(!result\.success\) continue/.test(retry));
  });

  test("32/33/34. the downstream gate and its limits are untouched", () => {
    const range = runtimeRange(AI, LF, PROD);
    assert.equal(range.minS, 300);
    assert.equal(range.maxS, 480);
    assert.equal(charsForRuntime(AI, range.maxS), 6121, "the hard ceiling must not move");
    const vf = readFileSync("src/stages/visualFeasibilityGate.ts", "utf8");
    assert.ok(vf.length > 0, "the gate still exists and still runs after quality");
  });

  test("35. the model's self-reported duration stays diagnostic", () => {
    assert.match(SRC, /model self-reported/);
    assert.ok(!/estimatedTotalDuration > |estimatedTotalDuration <|estimatedTotalDuration >=/.test(SRC),
      "nothing may branch on the model's own duration claim");
  });
});

// ── No-spend replay of both real failures ────────────────────────────────

describe("replay: both real pre-spend rejections under the new contract", () => {
  const b = scriptBudget(AI, LF, PROD);
  const m = (spokenChars: number) => measureLength({
    spokenChars, targetChars: b.targetChars, maxChars: b.maxChars, minChars: b.minChars,
  });

  /** A: cmstndj720001mbhnung9cual — 6181 chars, refused at 8.1 min. */
  test("A. the 6,181-char script is OVER and repairable", () => {
    const state = m(6181);
    assert.equal(state.verdict, "OVER");
    assert.ok(runtimeForChars(AI, 6181) > b.maxS, "reproduces the original refusal");
    // 4.3% over: one targeted rewrite is very likely to land it.
    assert.ok(state.spokenChars / state.maxChars - 1 < 0.05);
    assert.ok(m(b.targetChars).verdict === "OK", "the target it is trimmed toward is valid");
  });

  /** B: cmsvv9n9e0008mb34c3tkappb — 7226 chars, refused at 9.4 min. */
  test("B. the 7,226-char script is OVER, 22% over, and still gets both actions", () => {
    const state = m(7226);
    assert.equal(state.verdict, "OVER");
    assert.ok(Math.abs(runtimeForChars(AI, 7226) / 60 - 9.4) < 0.1, "reproduces the 9.4 min");
    const overPct = (state.spokenChars / state.maxChars - 1) * 100;
    assert.ok(overPct > 20 && overPct < 25, `${overPct.toFixed(1)}% over`);
    // The old rule stopped here. The bound is now on attempts, not on a guess
    // about which overages are winnable.
    assert.equal(MAX_LENGTH_REPAIRS, 2);
  });

  test("B. its segment allocation is stated, and a landed repair fits", () => {
    const seg = segmentBudgets(b, 6);
    assert.equal(seg.reduce((a, x) => a + x.maxChars, 0), b.maxChars);
    // 7226 across 6 segments is ~1204 each against a ~948 middle budget: every
    // segment has a concrete number to cut toward.
    assert.ok(7226 / 6 > seg[2]!.maxChars);
    // A repair that reaches target is inside the envelope with room to spare.
    const after = runtimeForChars(AI, b.targetChars);
    assert.ok(after >= b.minS && after <= b.maxS, `${after.toFixed(1)}s`);
    assert.equal(m(b.targetChars).verdict, "OK");
  });

  test("neither historical row is referenced by any of this", () => {
    for (const id of ["cmstndj720001mbhnung9cual", "cmsvv9n9e0008mb34c3tkappb",
                      "ef5999ea", "00959a09"]) {
      assert.ok(!SRC.includes(id), `${id} must not be special-cased`);
    }
  });
});
