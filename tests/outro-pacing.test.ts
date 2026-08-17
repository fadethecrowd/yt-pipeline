import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { outroCardPlan, MIN_FRAGMENT_S } from "../packages/pipeline-core/src/lib/visualBeats";

/**
 * The outro is cards, so the only question is how long any one of them holds.
 *
 * Run e704334a closed on a single branded card held for 19 seconds — one frame
 * of flat navy, unchanging, under the whole CTA. Motion cannot fix that here: a
 * zoom over a solid colour field is invisible, so the text is the only thing
 * that can change, and it changes by cutting to another card.
 */
describe("an outro is split into several cards, never one held frame", () => {
  test("a 19s outro becomes three cards, none held too long", () => {
    const p = outroCardPlan(19, 3);
    assert.equal(p.length, 3);
    for (const d of p) assert.ok(d >= MIN_FRAGMENT_S, `card of ${d}s is below the ${MIN_FRAGMENT_S}s floor`);
    assert.ok(Math.max(...p) <= 7.5, `longest card ${Math.max(...p)}s still reads as a held frame`);
  });

  test("the cards tile the beat exactly", () => {
    for (const dur of [19, 12.4, 25, 6.2, 40]) {
      const p = outroCardPlan(dur, 3);
      const sum = p.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - dur) < 1e-6, `${dur}s beat covered by ${sum}s of cards`);
    }
  });

  test("a short outro stays a single card rather than flashing", () => {
    // Below two fragments there is no room to cut without producing a flash.
    assert.deepEqual(outroCardPlan(8, 3), [8]);
    assert.equal(outroCardPlan(11.9, 3).length, 1);
    assert.equal(outroCardPlan(12, 3).length, 2);
  });

  test("never more cards than the channel has lines to say", () => {
    assert.equal(outroCardPlan(120, 3).length, 3);
    assert.equal(outroCardPlan(120, 1).length, 1);
  });

  test("no card is ever shorter than a fragment", () => {
    for (let d = 6; d <= 60; d += 0.5) {
      for (const n of [1, 2, 3, 4]) {
        for (const s of outroCardPlan(d, n)) {
          assert.ok(s >= MIN_FRAGMENT_S - 1e-6, `${d}s / ${n} lines produced a ${s}s card`);
        }
      }
    }
  });

  test("a degenerate beat produces nothing rather than a zero-length clip", () => {
    assert.deepEqual(outroCardPlan(0, 3), []);
    assert.deepEqual(outroCardPlan(-1, 3), []);
    assert.deepEqual(outroCardPlan(19, 0), []);
  });
});
