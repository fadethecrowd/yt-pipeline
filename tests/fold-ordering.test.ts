import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildSpokenUnits, spokenCharacterCount, validateScriptStructure,
  scriptBudget, segmentBudgets, charsForRuntime, runtimeRange,
} from "@yt-pipeline/pipeline-core";
import type { Script } from "@yt-pipeline/pipeline-core";
import { enforceScriptLength, foldHookAndCtaIntoSegments } from "../src/stages/scriptGenerator";

/**
 * Folding is now the LAST transformation, and the only origin of hook/CTA text.
 *
 * The shipped defect was one bug with two faces. `foldHookAndCtaIntoSegments`
 * prepended the 661-char hook into segment 0; `enforceScriptLength` then trimmed
 * the inflated narration blind to which part was structural and ate the entire
 * body, leaving 417 chars of pure hook prefix; `buildSpokenUnits` saw the
 * containment check fail on that prefix and read the hook again.
 *
 * The persisted fixture cannot demonstrate the repair, because the body it lost
 * was destroyed at generation time and never written anywhere. So the proof is
 * on the pipeline: a pre-fold script goes through enforcement, then folding,
 * then unit assembly, and the body has to still be there.
 */

const AI = "ai-doom-scroll" as const;
const B = scriptBudget(AI, "LONGFORM" as never, "PRODUCTION" as never);
const SEGS = segmentBudgets(B, 6);
const F = JSON.parse(readFileSync(
  "tests/fixtures/regressions/2026-08-16-credit-resale/script.final.json", "utf8"));

const BODY0 = "Token brokers sit between the labs and the buyers. " +
  "They purchase capacity at volume tiers ordinary customers never reach. " +
  "That margin is the entire business, and it is bigger than most people assume.";

/** A pre-fold script: hook and CTA in their own fields, bodies untouched. */
function preFold(bodyChars = 700): Script {
  const filler = (i: number) => {
    let t = "";
    let n = 0;
    while (t.length < bodyChars) t += `${t ? " " : ""}Body sentence ${n++} for segment ${i}.`;
    return t;
  };
  return {
    hook: F.hook, cta: F.cta, estimatedTotalDuration: 420,
    segments: Array.from({ length: 6 }, (_, i) => ({
      segmentIndex: i, title: `Segment ${i}`,
      narration: i === 0 ? BODY0 : filler(i),
      visual_prompt: "a factory floor", duration_seconds: 60,
    })),
  } as unknown as Script;
}

const noModel = async () => null;

describe("folding last: the body survives enforcement", () => {
  test("segment 0 keeps the model's body, and unit 0 is hook + that body", async () => {
    const s = preFold();
    const r = await enforceScriptLength(s, B, SEGS, noModel);
    assert.equal(r.ok, true, (r as { error?: string }).error);
    // Enforcement never saw structural text, so the body is intact.
    assert.equal(s.segments[0]!.narration, BODY0, "the body must survive untouched");

    const folded = foldHookAndCtaIntoSegments(s);
    const units = buildSpokenUnits(folded);
    assert.equal(units[0]!.text, `${F.hook} ${BODY0}`,
      "unit 0 is exactly hook + separator + body");
    assert.equal(units[0]!.text.length, F.hook.length + 1 + BODY0.length);
    assert.ok(units[0]!.text.length <= SEGS[0]!.maxChars,
      `${units[0]!.text.length} exceeds the segment ceiling ${SEGS[0]!.maxChars}`);
  });

  test("the hook is spoken exactly once", async () => {
    const s = preFold();
    await enforceScriptLength(s, B, SEGS, noModel);
    const units = buildSpokenUnits(foldHookAndCtaIntoSegments(s));
    const joined = units.map((u) => u.text).join(" ");
    const first = F.hook.split(/(?<=[.!?])\s+/)[0]!;
    assert.equal(joined.split(first).length - 1, 1);
  });

  test("the validator is clean: no HOOK_DUPLICATED, no folding-induced repeat", async () => {
    const s = preFold();
    await enforceScriptLength(s, B, SEGS, noModel);
    const folded = foldHookAndCtaIntoSegments(s);
    const v = validateScriptStructure(folded);
    assert.equal(v.ok, true, v.rejections.join("; "));
    assert.deepEqual(v.issues.filter((i) => i.code === "HOOK_DUPLICATED"), []);
    assert.deepEqual(v.issues.filter((i) => i.code === "SENTENCE_REPEATED"), []);
  });

  test("the whole script stays inside the budget and the downstream ceiling", async () => {
    const s = preFold();
    await enforceScriptLength(s, B, SEGS, noModel);
    const total = spokenCharacterCount(buildSpokenUnits(foldHookAndCtaIntoSegments(s)));
    assert.ok(total <= B.maxChars, `${total} > generator max ${B.maxChars}`);
    assert.ok(total <= charsForRuntime(AI, runtimeRange(AI, "LONGFORM" as never, "PRODUCTION" as never).maxS),
      "must stay under the hard downstream ceiling");
    assert.ok(total >= B.minChars, `${total} < min ${B.minChars}`);
  });

  test("bodies that alone exceed budget are trimmed, with folding overhead reserved", async () => {
    const s = preFold(2000);      // every body far over its segment budget
    const before = s.segments.map((x) => x.narration.length);
    const r = await enforceScriptLength(s, B, SEGS, noModel);
    assert.equal(r.ok, true, (r as { error?: string }).error);
    assert.ok(s.segments.some((x, i) => x.narration.length < before[i]!), "trimming happened");

    const folded = foldHookAndCtaIntoSegments(s);
    const units = buildSpokenUnits(folded).map((u) => u.text.length);
    units.forEach((n, i) => assert.ok(n <= SEGS[i]!.maxChars,
      `POST-FOLD segment ${i}: ${n} > ${SEGS[i]!.maxChars} — overhead was not reserved`));
    const total = spokenCharacterCount(buildSpokenUnits(folded));
    assert.ok(total <= B.maxChars, `post-fold total ${total} > ${B.maxChars}`);
  });

  test("enforcement never sees folded structural text", () => {
    const src = readFileSync("src/stages/scriptGenerator.ts", "utf8");
    // generateScript returns the unfolded script; folding happens after.
    assert.match(src, /return \{ script: validation\.data \};/);
    assert.ok(src.indexOf("await enforceScriptLength(") <
      src.indexOf("script = foldHookAndCtaIntoSegments(script);"),
      "folding must follow enforcement");
    assert.match(src, /const overhead = \(i: number\) =>/);
  });

  /**
   * The containment check is KEPT, deliberately.
   *
   * Deleting it was the brief, but it turns out to carry a documented
   * dependency: a HAND-EDITED script leaves the hook and CTA standing alone in
   * their fields, never folded, and the check is what makes them still spoken
   * and still counted by visual planning. Removing it silently drops the hook
   * from both — the v4 defect that tests/feasibility-spoken-coupling.test.ts
   * exists to prevent.
   *
   * With folding moved last it is also no longer load-bearing for generated
   * scripts: they arrive already folded, containment is true, and nothing is
   * re-derived. So the ordering fix stands on its own and the check goes back
   * to doing only the job it was actually for.
   */
  test("re-derivation cannot fire for a folded script", async () => {
    const s = preFold();
    await enforceScriptLength(s, B, SEGS, noModel);
    const folded = foldHookAndCtaIntoSegments(s);
    const units = buildSpokenUnits(folded);
    // One part per unit: the narration already holds everything.
    assert.deepEqual(units[0]!.parts.map((p) => p.field), ["segment"]);
    assert.deepEqual(units[units.length - 1]!.parts.map((p) => p.field), ["segment"]);
  });

  test("but an unfolded hand-edited script still gains them, exactly once", () => {
    const handEdited = {
      hook: "Standalone hook sentence.", cta: "Standalone closing line.",
      segments: [
        { segmentIndex: 0, title: "a", narration: "Body one.", visual_prompt: "v", duration_seconds: 60 },
        { segmentIndex: 1, title: "b", narration: "Body two.", visual_prompt: "v", duration_seconds: 60 },
      ],
      estimatedTotalDuration: 120,
    } as unknown as Script;
    const joined = buildSpokenUnits(handEdited).map((u) => u.text).join(" ");
    assert.equal(joined.split("Standalone hook sentence.").length - 1, 1);
    assert.equal(joined.split("Standalone closing line.").length - 1, 1);
  });
});

describe("CTA written into a body is repaired, not rejected", () => {
  test("the model's outro boilerplate in the body is removed, the field kept", async () => {
    const s = preFold();
    const ctaLine = "I read every comment and the best ones make it into future scripts.";
    const last = s.segments[s.segments.length - 1]!;
    last.narration = `${last.narration} ${ctaLine}`;
    await enforceScriptLength(s, B, SEGS, noModel);
    const folded = foldHookAndCtaIntoSegments(s);

    const v = validateScriptStructure(folded);
    assert.equal(v.ok, true, `should repair, not reject: ${v.rejections.join("; ")}`);
    const joined = buildSpokenUnits(folded).map((u) => u.text).join(" ");
    assert.equal(joined.split(ctaLine).length - 1, 1, "the line is spoken exactly once");
  });

  test("the generator is told not to write outro boilerplate into bodies", () => {
    const src = readFileSync("src/stages/scriptGenerator.ts", "utf8");
    assert.match(src, /dedicated fields/i);
    assert.match(src, /do NOT write\s*\n?\s*CTA or outro boilerplate/i);
    assert.match(src, /do NOT repeat the hook's wording/i);
  });
});
