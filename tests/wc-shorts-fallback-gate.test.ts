import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A Short is the only artifact on this channel that no gate ever measured.
 *
 * `shortsGenerator` is stage 75. `finalVideoQa` is stage 69. So the Short is
 * built AFTER the only QA in the pipeline has run and passed on a different
 * file, and goes straight to `youtube.videos.insert`. Nothing looked at its
 * frames.
 *
 * That mattered because clip search sent the whole topic title to Pexels as a
 * single keyword string — "Reading Structure on Sonar: Finding What Holds Fish"
 * — which matches nothing. The miss is silent: each unmatched clip falls back
 * to a dark card with the title drawn on it, so the Short became three
 * captioned title cards and published.
 *
 * The long-form path refuses exactly this: `fallback_cards_bounded` caps cards
 * at 15% of scenes and `no_consecutive_fallback_cards` forbids runs of them,
 * both FATAL. Those checks caught a real render in the 2026-09-12 batch
 * (6/23 cards) and the feasibility gate refused three more before spend.
 * Shorts bypassed all of it.
 *
 * Source assertions, in the style of wc-canary-one-shot: the behaviour lives in
 * an I/O-heavy stage, and what must not drift is its SHAPE — that the bound
 * exists, that it refuses rather than fails, and that it refuses before paying
 * for the encode.
 */

const SHORTS = readFileSync("packages/wc-pipeline/src/stages/shortsGenerator.ts", "utf8");

describe("a Short that is mostly title cards is never published", () => {
  test("the fallback bound is 2 of 3 clips", () => {
    assert.match(SHORTS, /const MAX_FALLBACK_CLIPS = 2;/);
    assert.match(SHORTS, /const NUM_VISUAL_CLIPS = 3;/);
  });

  test("fallbacks are counted, not merely logged", () => {
    // The stage always logged "pexels" vs "fallback" per clip. Logging is not
    // a gate; the count has to exist as a value the code branches on.
    assert.match(SHORTS, /let fallbackCount = 0;/);
    assert.match(SHORTS, /if \(!ok\) fallbackCount\+\+;/);
    assert.match(SHORTS, /if \(fallbackCount >= MAX_FALLBACK_CLIPS\)/);
  });

  test("refusing skips the Short and does NOT fail the run", () => {
    // The long-form video is already uploaded by this stage. Failing the run
    // for the sake of an optional Short would mark a shipped video FAILED and
    // trip the halt guard on the next iteration.
    // Window from the gate to its return, rather than to the first "}" —
    // which lands inside the template literal, not the end of the block.
    const from = SHORTS.indexOf("if (fallbackCount >= MAX_FALLBACK_CLIPS)");
    const ret = SHORTS.slice(from, SHORTS.indexOf("durationMs: Date.now() - start };", from) + 40);
    assert.match(ret, /success: true/);
    assert.doesNotMatch(ret, /success: false/);
    assert.match(ret, /skipped: "fallback-cards"/);
  });

  test("the refusal happens BEFORE the encode, not just before the upload", () => {
    // Once the outcome is known the concat and mux are pure waste. The gate
    // needs nothing the clip loop has not already produced, so it belongs
    // above them.
    const gateAt = SHORTS.indexOf("if (fallbackCount >= MAX_FALLBACK_CLIPS)");
    const concatAt = SHORTS.indexOf("concat.txt");
    const muxAt = SHORTS.indexOf("apad=pad_dur");
    const uploadAt = SHORTS.indexOf("videos.insert");
    assert.ok(gateAt > 0 && concatAt > 0 && muxAt > 0 && uploadAt > 0);
    assert.ok(gateAt < concatAt, "gate must precede the concat");
    assert.ok(gateAt < muxAt, "gate must precede the caption/audio mux");
    assert.ok(gateAt < uploadAt, "gate must precede the upload");
  });

  test("the abrupt-ending pad is still present", () => {
    // Survived 667dfb6's hook restructure; assert it so this edit cannot lose it.
    assert.match(SHORTS, /"apad=pad_dur=1\.5"/);
  });
});

describe("Shorts search with the long-form subject terms, not the raw title", () => {
  test("the searcher takes several queries", () => {
    assert.match(SHORTS, /async function searchPexelsMulti\(\s*queries: string\[\]/);
  });

  test("queries come from the assembler's own subject extraction", () => {
    assert.match(SHORTS, /resolveSegmentSubject\(hookSegment, scriptText, "wet-circuit"\)\.queries/);
  });

  test("the raw title survives only as the last resort", () => {
    // A resumed run can reach this stage with no script in context. A weak
    // query still beats no query, because the alternative is a card.
    assert.match(SHORTS, /const searchQueries = \[\.\.\.subjectQueries, topicQuery\];/);
  });

  test("the bare title is no longer what is searched", () => {
    assert.doesNotMatch(
      SHORTS,
      /searchPexelsMulti\(\s*topicQuery,/,
      "passing the whole title as the only query is the bug this replaced",
    );
  });

  test("one failing query cannot lose the clips the others found", () => {
    const fn = SHORTS.slice(
      SHORTS.indexOf("async function searchPexelsMulti"),
      SHORTS.indexOf("// The former trimToSentenceBoundary"),
    );
    assert.match(fn, /continue;/, "a bad query continues to the next");
    assert.match(fn, /const seen = new Set<string>\(\)/, "clips are deduped across queries");
  });

  test("selection is shuffled so a retry does not rebuild the same Short", () => {
    const fn = SHORTS.slice(SHORTS.indexOf("async function searchPexelsMulti"));
    assert.match(fn, /Math\.random\(\)/);
  });
});
