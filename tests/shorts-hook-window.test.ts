import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  resolveHookWindow, validateHookWindow, HookAlignmentError,
} from "../packages/pipeline-core/src/lib/hookWindow";
import type { Word } from "../packages/pipeline-core/src/lib/captions";

/**
 * AI Doom's Shorts window came from an estimate, and the estimate was wrong
 * every time.
 *
 * `scriptGenerator` derived `hookSegment.startTime/endTime` from the script's
 * predicted `duration_seconds`, then clamped the end to 0:59 — so all six
 * eligible videos carried the identical window 0:04→0:59 regardless of where
 * sentences actually fell. Measured against the real alignments, all six ended
 * mid-sentence: "…only need to be right" (dropping "once."), "…exploring",
 * "…repository", "…by", "—".
 *
 * The window now comes from `resolveHookWindow` against real word timings.
 */

/** Words at a steady rate, with sentence ends where marked. */
function words(spec: string, rate = 0.4): Word[] {
  return spec.split(" ").map((text, i) => ({
    text, start: +(4 + i * rate).toFixed(3), end: +(4 + (i + 1) * rate).toFixed(3),
  })) as Word[];
}

describe("the clip never ends mid-sentence or mid-word", () => {
  const w = words("A B C D. E F G H. I J K L. M N O P.");
  const hookText = w.map((x) => x.text).join(" ");

  test("it prefers the last sentence that fits inside the cap", () => {
    const win = resolveHookWindow({ words: w, hookText, maxDurationS: 3.0, minDurationS: 0.5 });
    validateHookWindow(win, w);
    assert.match(win.words[win.words.length - 1]!.text, /[.!?]$/,
      `ended on "${win.words[win.words.length - 1]!.text}"`);
    assert.ok(win.durationS <= 3.0 + 1e-9);
  });

  test("both edges land exactly on word boundaries", () => {
    const win = resolveHookWindow({ words: w, hookText, maxDurationS: 4.0, minDurationS: 0.5 });
    assert.ok(w.some((x) => Math.abs(x.start - win.startS) < 1e-6));
    assert.ok(w.some((x) => Math.abs(x.end - win.endS) < 1e-6));
    assert.doesNotThrow(() => validateHookWindow(win, w));
  });

  test("no word straddles either edge", () => {
    const win = resolveHookWindow({ words: w, hookText, maxDurationS: 2.2, minDurationS: 0.5 });
    const straddling = w.filter(
      (x) => (x.start < win.startS && x.end > win.startS) || (x.start < win.endS && x.end > win.endS));
    assert.equal(straddling.length, 0);
  });

  test("a hook that cannot be aligned is refused, never estimated", () => {
    assert.throws(
      () => resolveHookWindow({ words: w, hookText: "totally absent wording", maxDurationS: 4, minDurationS: 0.5 }),
      HookAlignmentError);
  });

  test("a window under the floor is refused rather than shipped short", () => {
    assert.throws(
      () => resolveHookWindow({ words: w, hookText, maxDurationS: 4, minDurationS: 60 }),
      HookAlignmentError);
  });
});

describe("the AI Doom stage uses the resolver, not the estimate", () => {
  const SRC = readFileSync("src/stages/shortsGenerator.ts", "utf8");

  test("resolveHookWindow is called and the window is validated", () => {
    assert.match(SRC, /resolveHookWindow\(\{/);
    assert.match(SRC, /validateHookWindow\(window, all\.words\)/);
  });

  test("the estimate-derived timestamp parser is gone", () => {
    assert.ok(!/function parseTimestamp/.test(SRC),
      "parseTimestamp must not survive — it is how the 0:04→0:59 clamp got in");
    assert.ok(!/parseTimestamp\(hook\./.test(SRC));
  });

  test("the 60s Shorts ceiling is still enforced on the real number", () => {
    assert.match(SRC, /window\.durationS > 60/);
    assert.match(SRC, /const SHORT_MAX_SECS = 55/);
    assert.match(SRC, /const SHORT_MIN_SECS = 20/);
  });

  test("captions are re-based onto the clip's own timeline", () => {
    assert.match(SRC, /buildShortsCaptions\(all\.words, window\.startS, window\.endS, 0\)/);
  });

  test("the caption-free master is still preferred", () => {
    assert.match(SRC, /final-clean\.mp4/);
    assert.match(SRC, /usedCleanMaster/);
  });

  test("upload safety is untouched: private by default, double-upload guarded", () => {
    assert.match(SRC, /prepareUpload\(\{/);
    assert.match(SRC, /scheduledSlot: null/);
    assert.match(SRC, /decision\.privacyStatus/);
    assert.match(SRC, /decision\.alreadyUploaded/);
    assert.match(SRC, /confirmUploadState\(\{/);
  });

  test("every exit path reports an outcome instead of a bare success", () => {
    // The stage stays non-fatal — a Short must never block the long-form — but
    // the reason now travels in the result rather than vanishing.
    for (const outcome of ['outcome: "SKIPPED"', 'outcome: "GENERATED"', 'outcome: "FAILED"']) {
      assert.ok(SRC.includes(outcome), `missing ${outcome}`);
    }
    const bare = SRC.match(/return \{ success: true, durationMs: Date\.now\(\) - start \};/g) ?? [];
    assert.equal(bare.length, 0, `${bare.length} bare success returns remain`);
  });

  test("the builder does no uploading and no database writing", () => {
    const body = SRC.slice(SRC.indexOf("export async function buildShortFile"),
      SRC.indexOf("export async function shortsGenerator"));
    for (const forbidden of ["prisma.", "youtube.videos.insert", "prepareUpload", "getYouTubeClient"]) {
      assert.ok(!body.includes(forbidden), `buildShortFile must not reference ${forbidden}`);
    }
  });
});
