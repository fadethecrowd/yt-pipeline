import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  scriptBudget, runtimeForChars, charsForRuntime, runtimeRange,
  CHARS_PER_SECOND, TITLE_CARD_S, RATE_OPTIMISM, RuntimeTargetError,
} from "@yt-pipeline/pipeline-core";
import { correctionDecision, MAX_CORRECTABLE_OVERFLOW } from "../src/stages/scriptGenerator";

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

// ── 14-30. The bounded correction ────────────────────────────────────────

describe("14-30. exactly one shortening pass, narrowly eligible", () => {
  const b = scriptBudget(AI, LF, PROD);
  const decide = (spokenChars: number) =>
    correctionDecision({ spokenChars, maxChars: b.maxChars, targetChars: b.targetChars });

  test("14. the real failed script is eligible for exactly one correction", () => {
    const d = decide(6181);
    assert.equal(d.needed, true);
    assert.equal(d.eligible, true);
    assert.ok(d.overflowRatio > 0 && d.overflowRatio <= MAX_CORRECTABLE_OVERFLOW);
    assert.equal(d.targetChars, b.targetChars);
  });

  test("21/22. correction targets headroom, never the ceiling", () => {
    const d = decide(6181);
    assert.ok(d.targetChars < d.maxChars, "trimming to the cap would land back outside");
    assert.ok(runtimeForChars(AI, d.targetChars) < b.maxS);
  });

  test("a script inside budget is never corrected", () => {
    for (const chars of [b.targetChars, b.maxChars, b.maxChars - 1]) {
      const d = decide(chars);
      assert.equal(d.needed, false, `${chars} triggered a correction`);
      assert.equal(d.eligible, false);
    }
  });

  test("29. overflow beyond the band is not a trim job", () => {
    const far = Math.ceil(b.maxChars * (1 + MAX_CORRECTABLE_OVERFLOW + 0.01));
    const d = decide(far);
    assert.equal(d.needed, true);
    assert.equal(d.eligible, false);
    assert.match(d.reason, /beyond the/);
  });

  test("the eligibility boundary is exact", () => {
    const edge = Math.floor(b.maxChars * (1 + MAX_CORRECTABLE_OVERFLOW));
    assert.equal(decide(edge).eligible, true);
    assert.equal(decide(Math.ceil(b.maxChars * (1 + MAX_CORRECTABLE_OVERFLOW)) + 1).eligible, false);
  });

  test("20. there is exactly one correction call site and no loop", () => {
    assert.equal((SRC.match(/shortenScript\(/g) ?? []).length, 2,
      "one definition, one call — a second call site would be a loop");
    assert.ok(!/while\s*\(|for\s*\(;;/.test(SRC.slice(SRC.indexOf("correctionDecision({"))),
      "the correction must not be inside a loop");
  });

  test("15/16/17. correction touches no identity and no authorization", () => {
    // It rewrites a script in memory. It cannot create a candidate, a run, or
    // consume tranche capacity, because it references none of them.
    const region = SRC.slice(SRC.indexOf("async function shortenScript"));
    for (const forbidden of ["claimSlot", "video.create", "RunSummary", "productionTranche", "settleSlot"]) {
      assert.ok(!region.includes(forbidden), `the correction must not touch ${forbidden}`);
    }
  });

  test("18/19. correction cannot spend, and runs before narration exists", () => {
    // "voiceover" appears in the schema example and a comment about which
    // fields the voiceover stage reads; what must not exist is any spend CALL.
    for (const forbidden of ["withBudgetWindow(", "reserveCredits(", "elevenlabs", "authorizeNarrationWindow("]) {
      assert.ok(!SRC.toLowerCase().includes(forbidden.toLowerCase()),
        `the script stage must not reference ${forbidden}`);
    }
  });

  test("23/24. the corrected script is judged from the beginning", () => {
    // Correction happens inside scriptGenerator, before quality and the runtime
    // check run at all, so no earlier PASS can be carried forward.
    assert.ok(SRC.indexOf("correctionDecision({") < SRC.indexOf("hookSegment"),
      "correction must precede everything downstream");
    assert.match(SRC, /no earlier PASS is\s*\n\s*\* carried forward|judged from the beginning/);
  });

  test("25/26. a corrected script that still misses is not corrected again", () => {
    // The decision is computed once; the block has no retry path.
    assert.equal((SRC.match(/correctionDecision\(\{/g) ?? []).length, 1);
    // And a still-over script simply proceeds to the checks, which refuse it.
    const stillOver = decide(b.maxChars + 10);
    assert.equal(stillOver.needed, true);
  });

  test("27/28. only length overflow triggers it", () => {
    // The decision function takes character counts and nothing else — it cannot
    // see quality scores, asset pools or policy verdicts.
    const d = decide(6181);
    assert.deepEqual(Object.keys(d).sort(),
      ["eligible", "maxChars", "needed", "overflowRatio", "reason", "spokenChars", "targetChars"].sort());
  });

  test("30. nothing in the correction path refunds a tranche attempt", () => {
    const store = readFileSync("packages/pipeline-core/src/lib/productionTrancheStore.ts", "utf8");
    assert.ok(!/consumedCandidates: *\{ *decrement/.test(store));
    assert.ok(!SRC.includes("consumedCandidates"));
  });
});

// ── No-spend replay of the real candidate ────────────────────────────────

describe("replay: cmstndj720001mbhnung9cual under the corrected contract", () => {
  test("old estimate, new estimate, and what would happen now", () => {
    const b = scriptBudget(AI, LF, PROD);
    const chars = 6181;
    const projected = runtimeForChars(AI, chars);
    const d = correctionDecision({ spokenChars: chars, maxChars: b.maxChars, targetChars: b.targetChars });

    // What the generator claimed, versus what the text actually implies.
    assert.ok(projected > 480, "the model's ~312s claim was never reachable from this text");

    // Under the new contract the generator would have been told to write to
    // targetChars, and this script would be trimmed once toward it.
    assert.equal(d.eligible, true);
    assert.ok(d.targetChars < chars);

    // And a script that lands on target passes the envelope with room to spare.
    const after = runtimeForChars(AI, d.targetChars);
    assert.ok(after >= b.minS && after <= b.maxS,
      `trimmed script projects ${after.toFixed(1)}s, outside ${b.minS}-${b.maxS}s`);
  });

  test("the historical candidate is not touched by any of this", () => {
    // Nothing here reads or writes that row; the replay is arithmetic only.
    assert.ok(!SRC.includes("cmstndj720001mbhnung9cual"));
  });
});
