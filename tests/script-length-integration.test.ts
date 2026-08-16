import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { scriptBudget, segmentBudgets, buildSpokenUnits, spokenCharacterCount } from "@yt-pipeline/pipeline-core";
import type { Script } from "@yt-pipeline/pipeline-core";
import { enforceScriptLength } from "../src/stages/scriptGenerator";

/**
 * The 2026-08-16 wiring bug, driven through the REAL production function.
 *
 * `trimToLimit` was correct and its unit tests passed. The stage still emitted:
 *
 *   segment 0 rewritten once → 1944 / 1090, trimmed 3 sentence(s) → 1614 / 1090
 *   segment 5 rewritten once → 1673 / 1043, trimmed 3 sentence(s) → 1398 / 1043
 *   length enforcement failed for segment(s) 0 (1614 > 1090), 5 (1398 > 1043)
 *
 * Budgets are measured against the SPOKEN UNIT. After
 * `foldHookAndCtaIntoSegments` the unit equals the narration, so clamping the
 * narration clamped the right thing — until the model rewrote a segment. Its
 * text then no longer contained the hook or CTA verbatim, `buildSpokenUnits`
 * re-added them, and the unit became the clamped narration PLUS several hundred
 * characters. The clamp was working perfectly on the wrong quantity.
 *
 * A helper-only test could never have caught that, which is why this one calls
 * the same function the stage calls.
 */

const AI = "ai-doom-scroll" as const;
const B = scriptBudget(AI, "LONGFORM" as never, "PRODUCTION" as never);
const SEGS = segmentBudgets(B, 6);

const HOOK = "Here is the opening line that hooks the viewer immediately and sets up the whole story.";
const CTA = "Subscribe for more breakdowns like this one every single week.";

/** Sentences until roughly `len` characters. */
function prose(len: number, seed = 0): string {
  let t = ""; let i = seed;
  while (t.length < len) t += `${t ? " " : ""}This sentence carries technical point number ${i++} about the subject.`;
  return t;
}

/** A folded script: hook inside segment 0, CTA inside segment 5. */
function foldedScript(lengths: number[]): Script {
  const segments = lengths.map((len, i) => {
    let narration = prose(len, i * 7);
    if (i === 0) narration = `${HOOK} ${narration}`;
    if (i === lengths.length - 1) narration = `${narration} ${CTA}`;
    return { segmentIndex: i, title: `Segment ${i}`, narration,
      visual_prompt: "a factory floor", duration_seconds: 60 };
  });
  return { hook: HOOK, cta: CTA, segments, estimatedTotalDuration: 420 } as unknown as Script;
}

const unitLens = (s: Script) => buildSpokenUnits(s).map((u) => u.text.length);
const totalOf = (s: Script) => spokenCharacterCount(buildSpokenUnits(s));

describe("the real enforcement path, with the model making segments LONGER", () => {
  /** Reproduces the live behaviour: asked to shorten, returns much more text. */
  const makesItLonger = (targets: Record<number, number>) => {
    const calls: number[] = [];
    let idx = 0;
    const shorten = async (narration: string) => {
      // Identify which segment by matching its current text length order.
      const i = idx++;
      calls.push(i);
      const grow = targets[i];
      return grow ? prose(grow, 900 + i) : narration;
    };
    return { shorten, calls };
  };

  test("segment 0: 1944 → <= 1090, segment 5: 1673 → <= 1043", async () => {
    const script = foldedScript([1413, 869, 908, 945, 855, 1291]);
    const before = unitLens(script);
    assert.ok(before[0]! > SEGS[0]!.maxChars, `segment 0 fixture ${before[0]}`);
    assert.ok(before[5]! > SEGS[5]!.maxChars, `segment 5 fixture ${before[5]}`);

    const oversized = before.filter((n, i) => n > SEGS[i]!.maxChars).length;
    // Every oversized segment gets exactly one call, and the mock answers each
    // with MORE text than it was given — the live 1944 / 1673 behaviour.
    let call = 0;
    const grown = [1944, 1673];
    const shorten = async () => prose(grown[call++] ?? 1500, 500);

    const r = await enforceScriptLength(script, B, SEGS, shorten);
    assert.equal(r.ok, true, (r as { error?: string }).error);

    const after = unitLens(script);
    assert.ok(after[0]! <= SEGS[0]!.maxChars, `segment 0: ${after[0]} > ${SEGS[0]!.maxChars}`);
    assert.ok(after[5]! <= SEGS[5]!.maxChars, `segment 5: ${after[5]} > ${SEGS[5]!.maxChars}`);
    assert.equal(call, oversized, "exactly one model call per oversized segment, and no more");
  });

  test("every segment is inside its own budget and the total inside 5925", async () => {
    const script = foldedScript([1413, 869, 908, 945, 855, 1291]);
    let call = 0;
    const grown = [1944, 1673];
    const r = await enforceScriptLength(script, B, SEGS, async () => prose(grown[call++] ?? 0, 500));
    assert.equal(r.ok, true);

    const after = unitLens(script);
    after.forEach((n, i) => assert.ok(n <= SEGS[i]!.maxChars, `segment ${i}: ${n} > ${SEGS[i]!.maxChars}`));
    const total = totalOf(script);
    assert.ok(total <= B.maxChars, `${total} > ${B.maxChars}`);
    assert.ok(total >= B.minChars, `${total} < ${B.minChars}`);
  });

  test("six non-empty segments, no split words, terminal punctuation", async () => {
    const script = foldedScript([1413, 869, 908, 945, 855, 1291]);
    let call = 0;
    const grown = [1944, 1673];
    await enforceScriptLength(script, B, SEGS, async () => prose(grown[call++] ?? 0, 500));

    assert.equal(script.segments.length, 6);
    for (const [i, seg] of script.segments.entries()) {
      assert.ok(seg.narration.trim().length > 0, `segment ${i} emptied`);
      assert.match(seg.narration.trim(), /[.!?]$/, `segment ${i} punctuation`);
      assert.ok(!/\s\w{1,2}$/.test(seg.narration.trim().replace(/[.!?]$/, "")),
        `segment ${i} looks like a severed word`);
    }
  });

  test("no model call is made for a script already inside budget", async () => {
    const script = foldedScript([700, 700, 700, 700, 700, 700]);
    let calls = 0;
    const r = await enforceScriptLength(script, B, SEGS, async (n) => { calls++; return n; });
    assert.equal(r.ok, true, (r as { error?: string }).error);
    assert.equal(calls, 0);
  });

  test("a model that refuses entirely still ends inside every budget", async () => {
    const script = foldedScript([1413, 869, 908, 945, 855, 1291]);
    const r = await enforceScriptLength(script, B, SEGS, async () => null);
    assert.equal(r.ok, true, (r as { error?: string }).error);
    unitLens(script).forEach((n, i) =>
      assert.ok(n <= SEGS[i]!.maxChars, `segment ${i}: ${n} > ${SEGS[i]!.maxChars}`));
    assert.ok(totalOf(script) <= B.maxChars);
  });

  test("the 7411 / 7342 / 7904 / 6911 / 6814 shapes all land inside 5925", async () => {
    for (const totalChars of [7411, 7342, 7904, 6911, 6814]) {
      const per = Math.round(totalChars / 6);
      const script = foldedScript([per, per, per, per, per, per]);
      const r = await enforceScriptLength(script, B, SEGS, async () => null);
      assert.equal(r.ok, true, `${totalChars}: ${(r as { error?: string }).error}`);
      const total = totalOf(script);
      assert.ok(total <= B.maxChars, `${totalChars} -> ${total}`);
      unitLens(script).forEach((n, i) =>
        assert.ok(n <= SEGS[i]!.maxChars, `${totalChars} segment ${i}: ${n}`));
    }
  });

  test("no provider, candidate, run or tranche is touched", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/stages/scriptGenerator.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function enforceScriptLength"),
      src.indexOf("/**\n * Stage 2:"));
    for (const forbidden of ["claimSlot", "RunSummary", "withBudgetWindow", "reserveCredits",
                             "elevenlabs", "productionTranche", "prisma", "generateScript("]) {
      assert.ok(!fn.toLowerCase().includes(forbidden.toLowerCase()), `must not touch ${forbidden}`);
    }
  });

  test("the stage calls exactly this function, and nothing else clamps", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/stages/scriptGenerator.ts", "utf8");
    assert.equal((src.match(/await enforceScriptLength\(/g) ?? []).length, 1);
    // trimToLimit is reached only through the enforcement function.
    const fn = src.slice(src.indexOf("export async function enforceScriptLength"),
      src.indexOf("/**\n * Stage 2:"));
    assert.equal((src.match(/trimToLimit\(/g) ?? []).length,
      (fn.match(/trimToLimit\(/g) ?? []).length);
  });
});
