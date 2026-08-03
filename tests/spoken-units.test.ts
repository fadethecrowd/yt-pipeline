import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  buildSpokenUnits, spokenScriptText, spokenCharacterCount, SPOKEN_UNIT_SEPARATOR,
} from "../packages/pipeline-core/src/lib/spokenUnits";
import {
  planExhaustiveBeats, verifyExhaustive, splitSentences,
} from "../packages/pipeline-core/src/lib/exhaustiveBeats";

/**
 * The orphaned hook/CTA defect, pinned permanently.
 *
 * WHAT HAPPENED
 *
 * A script carries `hook`, `segments[]` and `cta`. The generator folds the
 * hook into segments[0] and the CTA into the last segment, so `segments` alone
 * is the whole spoken script. An editorial shortening pass then rewrote the
 * segment bodies and left the top-level `hook` and `cta` fields standing —
 * no longer contained anywhere in `segments`.
 *
 * Voiceover synthesised `segments` only, so 570 characters of hook and 323 of
 * CTA were simply never spoken: the video would have opened mid-thought with
 * no hook and ended with no call to action. Meanwhile the beat planner sized
 * the runtime from a character count that DID include them. Each path was
 * internally consistent, so nothing failed — the two just described different
 * videos.
 *
 * The fix is one builder both paths consume. These tests exist so the two can
 * never drift apart again.
 */

const SCRIPT = "tmp/qual-dc/script.revised.json";
const ORIGINAL = "tmp/qual-dc/script.json";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const load = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

const synthetic = {
  hook: "This is the hook sentence.",
  cta: "Like and subscribe, please.",
  segments: [
    { segmentIndex: 0, narration: "Body zero opens here. It has two sentences." },
    { segmentIndex: 1, narration: "Body one is a single sentence." },
    { segmentIndex: 2, narration: "Body two closes the piece." },
  ],
};

describe("spoken units contain every field exactly once", () => {
  test("hook leads the first unit, CTA trails the last", () => {
    const u = buildSpokenUnits(synthetic);
    assert.equal(u.length, 3, "one unit per segment — the request count is unchanged");
    assert.ok(u[0]!.text.startsWith(synthetic.hook));
    assert.ok(u[2]!.text.endsWith(synthetic.cta));
    assert.deepEqual(u[0]!.parts.map((p) => p.field), ["hook", "segment"]);
    assert.deepEqual(u[1]!.parts.map((p) => p.field), ["segment"]);
    assert.deepEqual(u[2]!.parts.map((p) => p.field), ["segment", "cta"]);
  });

  test("every field appears exactly once across the whole spoken script", () => {
    const whole = spokenScriptText(buildSpokenUnits(synthetic));
    const occurrences = (h: string, n: string) => h.split(n).length - 1;
    assert.equal(occurrences(whole, synthetic.hook), 1, "hook must be spoken once");
    assert.equal(occurrences(whole, synthetic.cta), 1, "CTA must be spoken once");
    for (const s of synthetic.segments) {
      assert.equal(occurrences(whole, s.narration), 1, `segment ${s.segmentIndex} once`);
    }
  });

  test("ordering is hook, segments in index order, CTA", () => {
    const whole = spokenScriptText(buildSpokenUnits(synthetic));
    const at = (n: string) => whole.indexOf(n);
    const order = [synthetic.hook, ...synthetic.segments.map((s) => s.narration), synthetic.cta];
    for (let i = 1; i < order.length; i++) {
      assert.ok(at(order[i]!) > at(order[i - 1]!), `element ${i} out of order`);
    }
  });

  test("the separator is exactly the documented one", () => {
    assert.equal(SPOKEN_UNIT_SEPARATOR, "\n\n");
    const u = buildSpokenUnits(synthetic);
    assert.equal(u[0]!.text, synthetic.hook + "\n\n" + synthetic.segments[0]!.narration);
  });

  test("billed characters are the exact submitted strings, separators included", () => {
    const u = buildSpokenUnits(synthetic);
    const expected = synthetic.hook.length + synthetic.cta.length
      + synthetic.segments.reduce((a, s) => a + s.narration.length, 0)
      + 2 * SPOKEN_UNIT_SEPARATOR.length;
    assert.equal(spokenCharacterCount(u), expected);
    assert.equal(spokenCharacterCount(u), u.reduce((a, x) => a + x.text.length, 0));
  });
});

describe("an already-folded script is not folded twice", () => {
  test("a hook already inside segment 0 is not duplicated", () => {
    const folded = {
      hook: "This is the hook sentence.",
      cta: "Like and subscribe, please.",
      segments: [
        { segmentIndex: 0, narration: "This is the hook sentence. Body zero continues." },
        { segmentIndex: 1, narration: "Body one ends. Like and subscribe, please." },
      ],
    };
    const whole = spokenScriptText(buildSpokenUnits(folded));
    assert.equal(whole.split(folded.hook).length - 1, 1, "hook would have been said twice");
    assert.equal(whole.split(folded.cta).length - 1, 1, "CTA would have been said twice");
  });

  test("folding is whitespace-insensitive, so a reflowed copy still counts", () => {
    const reflowed = {
      hook: "This is\nthe hook sentence.",
      segments: [{ segmentIndex: 0, narration: "This is the hook sentence. And more." }],
    };
    const u = buildSpokenUnits(reflowed);
    assert.deepEqual(u[0]!.parts.map((p) => p.field), ["segment"]);
  });

  test("the real generator-shaped script is unaffected", { skip: !load(ORIGINAL) }, () => {
    const o = load(ORIGINAL)!;
    const u = buildSpokenUnits(o);
    // The original folds both, so units must be byte-identical to the segments.
    assert.deepEqual(u.map((x) => x.text), o.segments.map((s: any) => s.narration));
  });
});

describe("the canonical data-centre script", { skip: !load(SCRIPT) }, () => {
  const s = load(SCRIPT)!;
  const units = buildSpokenUnits(s);

  test("produces five units", () => assert.equal(units.length, 5));

  test("hook and CTA are folded, because this script orphaned them", () => {
    assert.deepEqual(units[0]!.parts.map((p) => p.field), ["hook", "segment"]);
    assert.deepEqual(units[4]!.parts.map((p) => p.field), ["segment", "cta"]);
  });

  test("nothing is lost and nothing is repeated", () => {
    const whole = spokenScriptText(units);
    assert.equal(whole.split(s.hook).length - 1, 1);
    assert.equal(whole.split(s.cta).length - 1, 1);
    for (const seg of s.segments) assert.equal(whole.split(seg.narration).length - 1, 1);
  });

  test("billed total is derived, never asserted", () => {
    const raw = s.hook.length + s.cta.length
      + s.segments.reduce((a: number, g: any) => a + g.narration.length, 0);
    assert.equal(spokenCharacterCount(units), raw + 2 * SPOKEN_UNIT_SEPARATOR.length);
  });
});

describe("exhaustive beats partition the narration", () => {
  const units = buildSpokenUnits(synthetic);

  test("beats reconstruct every unit byte for byte", () => {
    const beats = planExhaustiveBeats(units, 60);
    const v = verifyExhaustive(units, beats);
    assert.deepEqual(v.problems, []);
    assert.equal(v.ok, true);
  });

  test("no gaps and no overlaps", () => {
    const beats = planExhaustiveBeats(units, 60);
    for (const u of units) {
      const mine = beats.filter((b) => b.unitIndex === u.index);
      let cursor = 0;
      for (const b of mine) {
        assert.equal(b.startOffset, cursor, `gap or overlap at beat ${b.beat}`);
        cursor = b.endOffset;
      }
      assert.equal(cursor, u.text.length, `unit ${u.index} not fully covered`);
    }
  });

  test("no beat spans two units", () => {
    const beats = planExhaustiveBeats(units, 60);
    for (const b of beats) {
      const u = units[b.unitIndex]!;
      assert.ok(b.endOffset <= u.text.length);
      assert.equal(b.narration, u.text.slice(b.startOffset, b.endOffset));
    }
  });

  test("stored hashes match the stored text", () => {
    for (const b of planExhaustiveBeats(units, 60)) {
      assert.equal(b.narrationSha256, sha(b.narration));
    }
  });

  test("output is deterministic", () => {
    const a = planExhaustiveBeats(units, 60);
    const b = planExhaustiveBeats(units, 60);
    assert.deepEqual(a, b);
  });

  test("the representative sentence is metadata, not the narration", () => {
    const beats = planExhaustiveBeats(buildSpokenUnits(synthetic), 60);
    const multi = beats.find((b) => b.narration.trim() !== b.representativeSentence);
    assert.ok(multi, "at least one beat must hold more than its representative sentence");
    assert.ok(multi!.narration.includes(multi!.representativeSentence.slice(0, 20)));
  });

  test("a sampled sentence can no longer masquerade as full coverage", () => {
    // The v4 defect in miniature: sampling one sentence per beat covered a
    // fraction of the text. Exhaustive beats must cover all of it.
    const beats = planExhaustiveBeats(units, 60);
    const covered = beats.reduce((a, b) => a + b.narration.length, 0);
    const total = units.reduce((a, u) => a + u.text.length, 0);
    assert.equal(covered, total, "coverage must be exactly 100%");
  });
});

describe("sentence splitting keeps every character", () => {
  for (const t of [
    "One. Two! Three? Four.",
    "No terminator at all",
    "Trailing space. ",
    "Quote inside. \"He said so.\" After.",
    "Ellipsis... then more.",
  ]) {
    test(JSON.stringify(t), () => {
      assert.equal(splitSentences(t).map((s) => s.text).join(""), t);
    });
  }
});
