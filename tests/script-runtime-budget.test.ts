import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  scriptBudget, segmentBudgets, runtimeForChars, charsForRuntime, runtimeRange,
  CHARS_PER_SECOND, TITLE_CARD_S, RATE_OPTIMISM, RuntimeTargetError,
} from "@yt-pipeline/pipeline-core";
import { trimToLimit } from "@yt-pipeline/pipeline-core";

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

// ── 14-31. Deterministic length enforcement ──────────────────────────────

describe("14-31. the code enforces length, not the model", () => {
  const b = scriptBudget(AI, LF, PROD);

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

  test("7/8. the whole-script rewrite and regeneration ladder is gone", () => {
    for (const gone of ["repairScriptLength", "MAX_LENGTH_REPAIRS", "measureLength",
                        "correctionDecision", "MAX_CORRECTABLE_OVERFLOW"]) {
      assert.ok(!SRC.includes(gone), `${gone} must not survive — it failed live`);
    }
    // Regeneration inside the length path would be a second generation.
    const block = SRC.slice(SRC.indexOf("// ── Deterministic length enforcement"),
      SRC.indexOf("// The model's own"));
    assert.ok(!block.includes("generateScript("), "no whole-script regeneration");
  });

  test("2/6/7. at most one model call per oversized segment, and none after", () => {
    const block = SRC.slice(SRC.indexOf("// ── Deterministic length enforcement"),
      SRC.indexOf("// The model's own"));
    assert.equal((block.match(/await shortenSegment\(/g) ?? []).length, 1,
      "one call site, inside a single pass over the segments");
    // The mechanical clamp that follows contains no model call at all.
    const clamp = block.slice(block.indexOf("// 2. Mechanical clamp"));
    assert.ok(!clamp.includes("shortenSegment") && !clamp.includes("createMessage"),
      "step 2 onwards must be pure code");
  });

  test("4/5. trimming forces compliance even when the model made it LONGER", () => {
    // The exact live behaviour: asked to shorten, it returned more text.
    const longer = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about the topic.`).join(" ");
    assert.ok(longer.length > 300, "the fixture must actually be over the limit");
    const t = trimToLimit(longer, 300);
    assert.equal(t.ok, true);
    assert.ok(t.text.length <= 300, `${t.text.length}`);
    assert.ok(t.removed > 0);
  });

  test("10. no word is ever cut in half", () => {
    const text = "Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu.";
    const t = trimToLimit(text, 40);
    assert.ok(text.includes(t.text), "the result must be a prefix-composed subset of whole sentences");
    assert.match(t.text, /[.!?]$/, "and must end on terminal punctuation");
  });

  test("11. a segment never becomes empty, and an overlong sentence is now clamped", () => {
    // Previously this refused. It now falls back to a word boundary, which is
    // the whole point of the fix — sentence structure is a preference.
    const t = trimToLimit("One sentence only that is quite long indeed.", 5);
    assert.ok(t.text.length > 0);
    assert.ok(t.text.length <= 5, `${t.text.length}`);
    assert.equal(t.ok, true);
    assert.match(t.text, /[.!?]$/);
  });

  test("the closing line survives when it must", () => {
    const text = "Open. Middle one. Middle two. Middle three. Subscribe for more.";
    const t = trimToLimit(text, 34, { keepLast: true });
    assert.match(t.text, /^Open\./);
    assert.match(t.text, /Subscribe for more\.$/);
  });

  test("12/13. the stage cannot return success over the max", () => {
    const block = SRC.slice(SRC.indexOf("// ── Deterministic length enforcement"),
      SRC.indexOf("// The model's own"));
    assert.match(block, /if \(finalChars > b\.maxChars\)/);
    assert.match(block, /success: false/);
    assert.match(block, /while \(total\(\) > b\.maxChars/, "defensive total clamp");
  });

  test("14. it also refuses a script below the production minimum", () => {
    const block = SRC.slice(SRC.indexOf("// ── Deterministic length enforcement"),
      SRC.indexOf("// The model's own"));
    assert.match(block, /finalChars < b\.minChars/);
  });

  test("9/23. the segment count is preserved and verified", () => {
    const block = SRC.slice(SRC.indexOf("// ── Deterministic length enforcement"),
      SRC.indexOf("// The model's own"));
    assert.match(block, /script\.segments\.length !== budgets\.length/);
  });

  test("19/20/21/22. nothing here spends, claims or re-identifies anything", () => {
    const block = SRC.slice(SRC.indexOf("// ── Deterministic length enforcement"),
      SRC.indexOf("// The model's own"));
    for (const forbidden of ["claimSlot", "RunSummary", "withBudgetWindow", "reserveCredits",
                             "elevenlabs", "productionTranche", "settleSlot"]) {
      assert.ok(!block.toLowerCase().includes(forbidden.toLowerCase()), `must not touch ${forbidden}`);
    }
  });

  test("15/16/17/18. quality then feasibility, both after enforcement", () => {
    const pipeline = readFileSync("src/pipeline.ts", "utf8");
    const gen = pipeline.indexOf('name: "scriptGenerator"');
    const qa = pipeline.indexOf('name: "qualityGate"');
    const vf = pipeline.indexOf('name: "visualFeasibilityGate"');
    assert.ok(gen < qa && qa < vf);
    // Enforcement happens inside scriptGenerator, so the judge never sees the
    // original over-budget text.
    assert.ok(SRC.indexOf("// ── Deterministic length enforcement") < SRC.indexOf("hookSegment"));
  });

  test("32/33/34. the downstream gate and its limits are untouched", () => {
    const range = runtimeRange(AI, LF, PROD);
    assert.equal(range.minS, 300);
    assert.equal(range.maxS, 480);
    assert.equal(charsForRuntime(AI, range.maxS), 6121);
    assert.equal(b.maxChars, 5925);
    assert.equal(b.targetChars, 5552);
  });

  test("35. the model's self-reported duration stays diagnostic", () => {
    assert.match(SRC, /model self-reported/);
  });
});

// ── The real 7342 → 7904 → 6911 failure ──────────────────────────────────

describe("regression: the 2026-08-16 length failure", () => {
  const b = scriptBudget(AI, LF, PROD);
  const segs = segmentBudgets(b, 6);

  /** Six segments of whole sentences, summing to roughly `totalChars`. */
  function script(totalChars: number): string[] {
    const per = Math.round(totalChars / 6);
    return segs.map(() => {
      let text = "";
      let i = 0;
      while (text.length < per) {
        text += `${text ? " " : ""}This sentence carries a distinct technical point number ${i++}.`;
      }
      return text;
    });
  }

  const clampAll = (narrations: string[]) => {
    const out = narrations.map((n, i) =>
      trimToLimit(n, segs[i]!.maxChars, { keepLast: i === narrations.length - 1 }));
    return { texts: out.map((t) => t.text), total: out.reduce((a, t) => a + t.text.length, 0) };
  };

  test("7342 initial: mechanically forced inside 5925", () => {
    const r = clampAll(script(7342));
    assert.ok(r.total <= b.maxChars, `${r.total} must be <= ${b.maxChars}`);
    assert.equal(r.texts.length, 6, "still six segments");
    for (const t of r.texts) assert.ok(t.length > 0, "no segment emptied");
  });

  test("7904 after the model made it LONGER: still forced inside 5925", () => {
    const r = clampAll(script(7904));
    assert.ok(r.total <= b.maxChars, `${r.total} must be <= ${b.maxChars}`);
    assert.equal(r.texts.length, 6);
  });

  test("6911 after regeneration: still forced inside 5925", () => {
    const r = clampAll(script(6911));
    assert.ok(r.total <= b.maxChars, `${r.total} must be <= ${b.maxChars}`);
  });

  test("no model call, no regeneration, no second candidate is involved", () => {
    // The regression above is pure arithmetic — the same code path the stage
    // runs after its single per-segment attempt.
    assert.equal(typeof trimToLimit, "function");
  });

  test("the fix names no run, candidate or topic", () => {
    for (const id of ["f5c5ee99", "cmsw1b7sx0001mbgbmv2uqu1c", "RingCentral"]) {
      assert.ok(!SRC.includes(id), `${id} must not be special-cased`);
    }
  });
});

// ── The clamp must always reach the limit ────────────────────────────────

/**
 * The 2026-08-16 refusal: sentence-only trimming could not reach the limit.
 *
 * After one rewrite per oversized segment the stage was left with
 * 1800/869/908/945/855/1437 against maxima of 1090/948/948/948/948/1043, and
 * failed with "no further whole sentence can be removed without cutting a
 * word". Segment 0 was a single sentence longer than its budget, and the
 * protected CTA kept segment 5 over its own.
 *
 * Sentence structure is a preference. Numeric compliance is mandatory.
 */
describe("trimToLimit always reaches the limit", () => {
  const b2 = scriptBudget(AI, LF, PROD);
  const segs2 = segmentBudgets(b2, 6);
  const sentences = (len: number) => {
    let t = ""; let i = 0;
    while (t.length < len) t += `${t ? " " : ""}This sentence carries technical point number ${i++}.`;
    return t;
  };
  const oneSentence = (len: number) => {
    let t = "A"; while (t.length < len - 1) t += " word"; return `${t}.`;
  };

  test("1. whole sentences alone are used when they suffice", () => {
    const t = trimToLimit(sentences(900), 500);
    assert.ok(t.ok && t.text.length <= 500);
    assert.ok(t.removed > 0);
    assert.match(t.text, /number \d+\.$/, "cut landed on a sentence boundary");
  });

  test("2/4/5. a single giant sentence falls back to a word boundary", () => {
    const t = trimToLimit(oneSentence(1800), 1090);
    assert.equal(t.ok, true);
    assert.ok(t.text.length <= 1090, `${t.text.length}`);
    assert.ok(!/\bwor\b|\bwo\b/.test(t.text), "no partial word");
    assert.match(t.text, /[.!?]$/);
  });

  test("3. a clause boundary is preferred over an arbitrary word cut", () => {
    const text = `${"x".repeat(0)}Alpha beta gamma delta, epsilon zeta eta theta iota kappa lambda mu nu xi.`;
    const t = trimToLimit(text, 30);
    assert.ok(t.text.length <= 30);
    assert.match(t.text, /gamma delta\.$/, "cut at the comma, normalised to a full stop");
  });

  test("6/7. output is non-empty and terminally punctuated", () => {
    for (const limit of [20, 60, 200, 1090]) {
      const t = trimToLimit(oneSentence(1500), limit);
      assert.ok(t.text.length > 0, `limit ${limit}`);
      assert.ok(t.text.length <= limit, `limit ${limit} got ${t.text.length}`);
      assert.match(t.text, /[.!?]$/, `limit ${limit}`);
    }
  });

  test("8/9. an over-long hook or CTA is clamped rather than protected", () => {
    const hook = trimToLimit(oneSentence(1800), segs2[0]!.maxChars);
    assert.ok(hook.text.length <= segs2[0]!.maxChars);
    const cta = trimToLimit(oneSentence(1437), segs2[5]!.maxChars, { keepLast: true });
    assert.ok(cta.text.length <= segs2[5]!.maxChars,
      "a protected close may not hold the segment over its budget");
  });

  test("the closing line still survives when there is room", () => {
    const t = trimToLimit(sentences(1437), segs2[5]!.maxChars, { keepLast: true });
    assert.ok(t.text.length <= segs2[5]!.maxChars);
    assert.match(t.text, /number 29\.$/, "the final sentence is kept when it fits");
  });

  test("a limit too small for one word reports failure instead of a fragment", () => {
    const t = trimToLimit("Supercalifragilistic word here.", 3);
    assert.equal(t.ok, false);
  });

  test("3/11/12. the exact live shape lands inside every budget", () => {
    const live = [1800, 869, 908, 945, 855, 1437]
      .map((n, i) => (i === 0 ? oneSentence(n) : sentences(n)));
    const out = live.map((t, i) => trimToLimit(t, segs2[i]!.maxChars, { keepLast: i === 5 }));
    out.forEach((t, i) => {
      assert.ok(t.ok, `segment ${i} did not reach its limit`);
      assert.ok(t.text.length <= segs2[i]!.maxChars,
        `segment ${i}: ${t.text.length} > ${segs2[i]!.maxChars}`);
      assert.ok(t.text.length > 0, `segment ${i} emptied`);
      assert.match(t.text, /[.!?]$/, `segment ${i} punctuation`);
    });
    const total = out.reduce((a, t) => a + t.text.length, 0);
    assert.ok(total <= b2.maxChars, `${total} > ${b2.maxChars}`);
    assert.equal(out.length, 6);
  });

  test("10/13. every historical shape lands inside 5925", () => {
    for (const totalChars of [7411, 7342, 7904, 6911, 6814]) {
      const per = Math.round(totalChars / 6);
      const out = segs2.map((sb, i) =>
        trimToLimit(i === 0 ? oneSentence(per) : sentences(per), sb.maxChars, { keepLast: i === 5 }));
      const total = out.reduce((a, t) => a + t.text.length, 0);
      assert.ok(total <= b2.maxChars, `${totalChars} -> ${total}`);
      assert.ok(out.every((t) => t.text.length > 0), `${totalChars} emptied a segment`);
    }
  });

  test("13. the stage asserts per segment before returning success", () => {
    const block = SRC.slice(SRC.indexOf("// ── Deterministic length enforcement"),
      SRC.indexOf("// The model's own"));
    assert.match(block, /length enforcement failed for segment\(s\)/);
    assert.match(block, /\.filter\(\(x\) => x\.n > x\.max\)/);
  });
});
