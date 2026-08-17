import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { outroCardPlan, OUTRO_CARD_MAX_S } from "../packages/pipeline-core/src/lib/visualBeats";
import { MAX_FROZEN_RUN_S } from "../packages/pipeline-core/src/lib/qa";
import { lastOutroBeatIndex } from "../packages/pipeline-core/src/stages/assemblyShared";

/**
 * The outro is cards, so two things can go wrong: one card holds too long, or
 * the whole treatment fires more than once.
 *
 * Run e704334a closed on a single card held 19 seconds. The fix cut it into
 * three, and run c28dd19c then fired the treatment TWICE — beat 23 ended "…hit
 * subscribe" and beat 24 opened "Drop a comment below" — for five cards and
 * 35.3s of static ending, with QA reporting `no_frozen_sections: longest frozen
 * run 5.13s`. Every frozen run in that render fell inside the outro.
 */

describe("no outro card outlasts the frozen-frame gate", () => {
  test("the card cap sits at or under the QA threshold", () => {
    assert.ok(OUTRO_CARD_MAX_S <= MAX_FROZEN_RUN_S,
      `outro cards may hold ${OUTRO_CARD_MAX_S}s but QA flags anything over ${MAX_FROZEN_RUN_S}s`);
  });

  test("c28dd19c's own outro beats now stay under the gate", () => {
    for (const dur of [20.20, 15.07]) {
      for (const card of outroCardPlan(dur)) {
        assert.ok(card <= MAX_FROZEN_RUN_S + 1e-9, `${dur}s beat produced a ${card}s card`);
      }
    }
  });

  test("no card exceeds the cap at any beat length", () => {
    for (let d = 0.5; d <= 60; d += 0.25) {
      for (const card of outroCardPlan(d)) {
        assert.ok(card <= OUTRO_CARD_MAX_S + 1e-9, `${d}s produced a ${card}s card`);
      }
    }
  });

  test("the cards tile the beat exactly", () => {
    for (const dur of [19, 20.2, 15.07, 12.4, 6.2, 40]) {
      const sum = outroCardPlan(dur).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - dur) < 1e-6, `${dur}s beat covered by ${sum}s of cards`);
    }
  });

  test("a short outro is a single card, not a flash sequence", () => {
    assert.deepEqual(outroCardPlan(3.2), [3.2]);
    assert.equal(outroCardPlan(4).length, 1);
  });

  test("a degenerate beat produces nothing rather than a zero-length clip", () => {
    assert.deepEqual(outroCardPlan(0), []);
    assert.deepEqual(outroCardPlan(-1), []);
    assert.deepEqual(outroCardPlan(Number.NaN), []);
  });
});

describe("the treatment fires exactly once per video", () => {
  const beat = (index: number, narration: string) => ({ index, narration });

  test("c28dd19c's two CTA beats resolve to one outro, the last", () => {
    // Both of these matched isOutroBeat and both were carded.
    const beats = [
      beat(22, "As AI tools proliferate and attackers mature, the gap will narrow."),
      beat(23, "The Defender's Window is one of the most important frameworks for thinking "
        + "about AI and security published this year, and it came straight from OpenAI. If this "
        + "kind of deep-dive into AI's real-world stakes is useful to you, hit subscribe so you "
        + "don't miss the next one."),
      beat(24, "Drop a comment below — do you think defenders can actually win this race, or is "
        + "the window already closing? Like this video if you want more breakdowns like this."),
    ];
    assert.equal(lastOutroBeatIndex(beats), 24, "the LAST CTA beat is the outro");
  });

  test("earlier CTA-bearing beats keep their footage", () => {
    const beats = [
      beat(1, "hit subscribe so you don't miss the next one"),
      beat(2, "Drop a comment below."),
    ];
    const idx = lastOutroBeatIndex(beats);
    assert.equal(idx, 2);
    assert.notEqual(idx, 1, "beat 1 must be rendered as an ordinary beat");
  });

  test("a video with no CTA beat gets no outro at all", () => {
    assert.equal(lastOutroBeatIndex([beat(1, "Attackers only need to be right once.")]), -1);
  });

  test("ordinary prose containing 'under-subscribed' is not an outro", () => {
    assert.equal(lastOutroBeatIndex([
      beat(1, "brokers move volume that would sit unused in under-subscribed enterprise tiers"),
    ]), -1);
  });
});
