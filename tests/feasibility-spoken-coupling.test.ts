import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildSpokenUnits, spokenOutlineSegments, spokenCharacterCount,
} from "../packages/pipeline-core/src/lib/spokenUnits";

/**
 * Visual planning and narration must describe the same video.
 *
 * Feasibility sizes a runtime from character counts and builds its search
 * queries from each segment's narration. It read `script.segments` directly
 * while narration read `buildSpokenUnits`, so the two agreed only by luck —
 * they happen to be byte-identical for generator-produced scripts, which fold
 * the hook and CTA into the segment bodies. For a hand-edited script that left
 * them standing alone, the planner counted characters the voice would never
 * speak. That is the shape of the v4 defect, and it was still latent here.
 *
 * `spokenOutlineSegments` is now the single input to both.
 */

const generated = {
  hook: "This is the hook sentence.",
  cta: "Like and subscribe, please.",
  segments: [
    { segmentIndex: 0, title: "One", visual_prompt: "vp0",
      narration: "This is the hook sentence. Body zero continues here." },
    { segmentIndex: 1, title: "Two", visual_prompt: "vp1",
      narration: "Body one runs on. Like and subscribe, please." },
  ],
};

const handEdited = {
  hook: "This is the hook sentence.",
  cta: "Like and subscribe, please.",
  segments: [
    { segmentIndex: 0, title: "One", visual_prompt: "vp0", narration: "Body zero was rewritten." },
    { segmentIndex: 1, title: "Two", visual_prompt: "vp1", narration: "Body one was rewritten." },
  ],
};

const count = (h: string, n: string) => h.split(n).length - 1;

describe("feasibility and narration see byte-identical text", () => {
  for (const [label, script] of [["generated", generated], ["hand-edited", handEdited]] as const) {
    test(`${label}: every segment matches its spoken unit exactly`, () => {
      const units = buildSpokenUnits(script);
      const outline = spokenOutlineSegments(script);
      assert.equal(outline.length, units.length);
      outline.forEach((s, i) => {
        assert.equal(s.narration, units[i]!.text, `segment ${i} differs from what will be spoken`);
      });
    });

    test(`${label}: character totals agree`, () => {
      const planned = spokenOutlineSegments(script).reduce((a, s) => a + s.narration.length, 0);
      assert.equal(planned, spokenCharacterCount(buildSpokenUnits(script)),
        "the planner would size the runtime from a different character count than is billed");
    });
  }
});

describe("an already-folded script is untouched", () => {
  test("generated segments pass through byte-for-byte", () => {
    const outline = spokenOutlineSegments(generated);
    outline.forEach((s, i) => {
      assert.equal(s.narration, generated.segments[i]!.narration,
        "a generated script must not change shape when routed through spoken units");
    });
  });

  test("hook and CTA are not duplicated", () => {
    const whole = spokenOutlineSegments(generated).map((s) => s.narration).join("\n\n");
    assert.equal(count(whole, generated.hook), 1);
    assert.equal(count(whole, generated.cta), 1);
  });
});

describe("a hand-edited script gains its hook and CTA exactly once", () => {
  test("both appear, once each", () => {
    const whole = spokenOutlineSegments(handEdited).map((s) => s.narration).join("\n\n");
    assert.equal(count(whole, handEdited.hook), 1, "hook missing from planning");
    assert.equal(count(whole, handEdited.cta), 1, "CTA missing from planning");
  });

  test("planning now counts them, where before it did not", () => {
    const raw = handEdited.segments.reduce((a, s) => a + s.narration.length, 0);
    const planned = spokenOutlineSegments(handEdited).reduce((a, s) => a + s.narration.length, 0);
    assert.ok(planned > raw, "the fix must actually change this case");
    assert.equal(planned, spokenCharacterCount(buildSpokenUnits(handEdited)));
  });
});

describe("non-narration fields survive", () => {
  test("segmentIndex, title and visual_prompt are carried through", () => {
    for (const s of spokenOutlineSegments(generated)) {
      const orig = generated.segments.find((x) => x.segmentIndex === s.segmentIndex)!;
      assert.equal(s.title, orig.title);
      assert.equal(s.visual_prompt, orig.visual_prompt);
    }
  });

  test("segment order and count are preserved", () => {
    assert.deepEqual(
      spokenOutlineSegments(generated).map((s) => s.segmentIndex),
      generated.segments.map((s) => s.segmentIndex),
    );
  });
});
