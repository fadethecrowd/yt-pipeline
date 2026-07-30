import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  wordsFromAlignment, cuesFromWords, buildLongformCaptions, buildShortsCaptions,
} from "../packages/pipeline-core/src/lib/captions";
import type { Alignment, Word } from "../packages/pipeline-core/src/lib/captions";
import {
  resolveHookWindow, validateHookWindow, HookAlignmentError, normalizeToken,
} from "../packages/pipeline-core/src/lib/hookWindow";
import { classifyModelResponse, isRetryable } from "../packages/pipeline-core/src/lib/modelResponse";
import { RESUMABLE_STATUSES, QUARANTINE_STATUS } from "../packages/pipeline-core/src/lib/quarantine";
import { isTestStage, currentTestStage } from "../packages/pipeline-core/src/lib/testStage";
import { isRealYoutubeId } from "../packages/pipeline-core/src/lib/uploadSafety";
import { measureCaptionOffsets } from "../packages/pipeline-core/src/lib/qa";

// ── Fixtures ──────────────────────────────────────────────────────────────

/**
 * Build a character alignment for `text` where every character takes
 * `charDur` seconds, except characters after a "|" marker which are preceded
 * by a `pauseDur` gap. Lets a test encode uneven pacing deliberately.
 */
function makeAlignment(text: string, charDur = 0.05, pauses: Record<number, number> = {}): Alignment {
  const characters: string[] = [];
  const startTimes: number[] = [];
  const endTimes: number[] = [];
  let t = 0;
  for (let i = 0; i < text.length; i++) {
    if (pauses[i]) t += pauses[i];
    characters.push(text[i]);
    startTimes.push(Number(t.toFixed(6)));
    t += charDur;
    endTimes.push(Number(t.toFixed(6)));
  }
  return { characters, startTimes, endTimes };
}

// ── Caption alignment ─────────────────────────────────────────────────────

describe("captions — built from real alignment, not uniform chunks", () => {
  test("word times come from the alignment", () => {
    const a = makeAlignment("Hi there.");
    const words = wordsFromAlignment(a);
    assert.equal(words.length, 2);
    assert.equal(words[0].text, "Hi");
    assert.equal(words[0].start, 0);
    // "there." starts after "Hi" (2 chars) + space (1 char) = 3 chars
    assert.ok(Math.abs(words[1].start - 0.15) < 1e-6, `got ${words[1].start}`);
  });

  test("a long pause is reflected in cue timing, not averaged away", () => {
    // 3s pause before the second sentence.
    const text = "One two. Three four.";
    const a = makeAlignment(text, 0.05, { 9: 3.0 });
    const words = wordsFromAlignment(a);
    const cues = cuesFromWords(words);
    const second = cues.find((c) => c.text.startsWith("Three"));
    assert.ok(second, "expected a cue starting at 'Three'");
    // Uniform chunking would place it near the midpoint (~0.5s); the real
    // alignment puts it after the 3s pause.
    assert.ok(second!.start > 3.0, `cue should follow the pause, got ${second!.start}`);
  });

  test("offset is applied exactly once", () => {
    const a = makeAlignment("Hello world.");
    const built = buildLongformCaptions([a], [0], 4);
    assert.equal(built.cues[0].start, 4, "first cue must start at the title-card offset");
    const twice = buildLongformCaptions([a], [0], 8);
    assert.equal(twice.cues[0].start, 8);
  });

  test("segment offsets accumulate exactly", () => {
    const a1 = makeAlignment("First segment.");
    const a2 = makeAlignment("Second segment.");
    const built = buildLongformCaptions([a1, a2], [0, 10], 4);
    const second = built.cues.find((c) => c.text.startsWith("Second"));
    assert.ok(second);
    assert.equal(second!.start, 14, "10s segment offset + 4s title card");
  });

  test("cues never overlap", () => {
    const a = makeAlignment("One. Two. Three. Four. Five. Six seven eight nine ten.");
    const cues = buildLongformCaptions([a], [0], 4).cues;
    for (let i = 0; i < cues.length - 1; i++) {
      assert.ok(cues[i].end <= cues[i + 1].start + 1e-9,
        `cue ${i} ends ${cues[i].end} after cue ${i + 1} starts ${cues[i + 1].start}`);
    }
  });

  test("no cumulative drift across many sentences", () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i}.`).join(" ");
    const a = makeAlignment(sentences, 0.05);
    const built = buildLongformCaptions([a], [0], 4);
    const off = measureCaptionOffsets(built.cues, built.words);
    assert.ok(Math.abs(off.head) < 1e-6);
    assert.ok(Math.abs(off.tail) < 1e-6, `tail offset ${off.tail} should be ~0`);
    assert.ok(Math.abs(off.tail - off.head) < 0.25, "no drift head→tail");
  });
});

describe("Wet Circuit Shorts captions — real word timings", () => {
  const a = makeAlignment(
    "Marker one. Every season somebody asks the same question. Will this transducer work. The honest answer depends.",
    0.05,
    { 12: 0.8, 60: 1.2 },
  );
  const all = buildLongformCaptions([a], [0], 4);

  test("window cues are re-based onto the Short's own timeline", () => {
    const windowStart = all.words[3].start; // 4th word
    const windowEnd = all.words[10].end;
    const shorts = buildShortsCaptions(all.words, windowStart, windowEnd, 0);
    assert.ok(shorts.cues.length > 0);
    assert.ok(shorts.cues[0].start >= 0, "no negative cue times");
    assert.ok(Math.abs(shorts.cues[0].start) < 0.5,
      `first cue should sit near the window start, got ${shorts.cues[0].start}`);
  });

  test("hook offset is applied exactly once", () => {
    const windowStart = all.words[0].start;
    const windowEnd = all.words[8].end;
    const hookOffset = 2.5;
    const shifted = buildShortsCaptions(all.words, windowStart + hookOffset, windowEnd, 0);
    for (const c of shifted.cues) {
      assert.ok(c.start >= 0, "a double-applied offset would push cues negative");
    }
    const noHook = buildShortsCaptions(all.words, windowStart, windowEnd, 0);
    assert.ok(shifted.cues.length <= noHook.cues.length,
      "shifting past the hook drops the words spoken under it");
  });

  test("cue spacing follows the real pauses, not equal division", () => {
    const shorts = buildShortsCaptions(all.words, all.words[0].start, all.words[all.words.length - 1].end, 0);
    const gaps = shorts.cues.slice(1).map((c, i) => c.start - shorts.cues[i].start);
    const uniform = gaps.every((g) => Math.abs(g - gaps[0]) < 1e-6);
    assert.ok(!uniform, "cue starts must not be uniformly spaced");
  });
});

// ── Hook window ───────────────────────────────────────────────────────────

describe("hook window — resolved from real audio", () => {
  const a = makeAlignment(
    "Marker one three seconds in. Every season somebody asks the same question about transducers. " +
    "The honest answer is that it depends on three separate things today. And here is the last part of it.",
    0.06,
  );
  const words = wordsFromAlignment(a, 4);

  test("locates the hook and snaps to word boundaries", () => {
    const w = resolveHookWindow({
      words, hookText: "Marker one three seconds in. Every season somebody asks the same question about transducers.",
      maxDurationS: 55, minDurationS: 2,
    });
    validateHookWindow(w, words);
    assert.ok(words.some((x) => x.start === w.startS), "start is a word start");
    assert.ok(words.some((x) => x.end === w.endS), "end is a word end");
  });

  test("never begins or ends mid-word", () => {
    const w = resolveHookWindow({
      words, hookText: "Marker one three seconds in. Every season somebody asks the same question about transducers.",
      maxDurationS: 55, minDurationS: 2,
    });
    const straddling = words.filter(
      (x) => (x.start < w.startS && x.end > w.startS) || (x.start < w.endS && x.end > w.endS),
    );
    assert.deepEqual(straddling, []);
  });

  test("respects the maximum duration", () => {
    const w = resolveHookWindow({
      words, hookText: words.map((x) => x.text).join(" "),
      maxDurationS: 3, minDurationS: 1,
    });
    assert.ok(w.durationS <= 3.05, `window ${w.durationS}s exceeded the 3s cap`);
  });

  test("fails closed when the hook is absent — no wpm fallback", () => {
    assert.throws(
      () => resolveHookWindow({
        words, hookText: "completely unrelated sentence about aviation databases",
        maxDurationS: 55, minDurationS: 2,
      }),
      (e: unknown) => e instanceof HookAlignmentError,
    );
  });

  test("fails closed on empty hook text and empty narration", () => {
    assert.throws(() => resolveHookWindow({ words, hookText: "", maxDurationS: 55, minDurationS: 2 }),
      (e: unknown) => e instanceof HookAlignmentError);
    assert.throws(() => resolveHookWindow({ words: [], hookText: "x", maxDurationS: 55, minDurationS: 2 }),
      (e: unknown) => e instanceof HookAlignmentError);
  });

  test("fails closed when the resolved window is too short", () => {
    assert.throws(
      () => resolveHookWindow({
        words, hookText: "Marker one", maxDurationS: 55, minDurationS: 30,
      }),
      (e: unknown) => e instanceof HookAlignmentError,
    );
  });

  test("validateHookWindow rejects a window cutting a word", () => {
    const bad = {
      startS: words[2].start + 0.01, endS: words[6].end, durationS: 1,
      words: [], text: "", firstWordIndex: 2, lastWordIndex: 6, matchRatio: 1,
    };
    assert.throws(() => validateHookWindow(bad as never, words),
      (e: unknown) => e instanceof HookAlignmentError);
  });

  test("normalizeToken strips punctuation and case", () => {
    assert.equal(normalizeToken("Transducer,"), "transducer");
    assert.equal(normalizeToken("“Quoted”"), "quoted");
  });
});

// ── Model response classification ─────────────────────────────────────────

describe("model responses — refusals never parsed as scripts", () => {
  const REAL_REFUSALS = [
    // Verbatim openings from the recorded wc_video failures.
    `I need to pause here before writing this script.\n\n**The topic doesn't fit the channel.**\n\nWet Circuit is a marine electronics channel. The Garmin Catalyst R1 is a **racing radar for motorsports**`,
    `I can't write this script. The topic — Garmin expanding their **avionics navigation database to Africa** — is an aviation story, not a marine electronics story.`,
    `I need to flag something important before writing this script.\n\n**This topic is not marine electronics.**\n\nThe zūmo XT3 is a **motorcycle GPS navigator**`,
  ];

  for (const [i, text] of REAL_REFUSALS.entries()) {
    test(`recorded refusal ${i + 1} is classified, not parsed`, () => {
      const c = classifyModelResponse(text, "end_turn");
      assert.notEqual(c.type, "VALID", "a refusal must never be VALID");
      assert.ok(["MODEL_REFUSAL", "OFF_TOPIC"].includes(c.type), `got ${c.type}`);
    });
  }

  test("thin-source decline is classified as THIN_SOURCE", () => {
    const c = classifyModelResponse(
      `The source content is extremely thin — just a tagline and a series name with no actual specs, model numbers, screen sizes, pricing, or feature details.`,
      "end_turn",
    );
    assert.equal(c.type, "THIN_SOURCE");
  });

  test("earnings-release decline is classified", () => {
    const c = classifyModelResponse(
      `The source content here is a financial earnings press release — not a product announcement. There are no new products, model numbers, specs, or prices to report.`,
      "end_turn",
    );
    assert.notEqual(c.type, "VALID");
  });

  test("valid JSON is VALID", () => {
    const c = classifyModelResponse(`{"hook":"h","segments":[],"cta":"c","estimatedTotalDuration":400}`, "end_turn");
    assert.equal(c.type, "VALID");
  });

  test("fenced JSON is VALID", () => {
    const c = classifyModelResponse("```json\n{\"a\":1}\n```", "end_turn");
    assert.equal(c.type, "VALID");
  });

  test("truncated JSON is TRUNCATED_JSON, not MALFORMED", () => {
    const c = classifyModelResponse(`{"hook":"h","segments":[{"title":"a"`, "max_tokens");
    assert.equal(c.type, "TRUNCATED_JSON");
  });

  test("unterminated JSON without a stop reason is still detected as truncated", () => {
    const c = classifyModelResponse(`{"hook":"h","segments":[{"title":"a"`, "end_turn");
    assert.equal(c.type, "TRUNCATED_JSON");
  });

  test("genuinely malformed JSON is MALFORMED_JSON", () => {
    const c = classifyModelResponse(`{"hook": "h",, }`, "end_turn");
    assert.equal(c.type, "MALFORMED_JSON");
  });

  test("empty response is EMPTY_RESPONSE", () => {
    assert.equal(classifyModelResponse("", "end_turn").type, "EMPTY_RESPONSE");
    assert.equal(classifyModelResponse("   \n ", "end_turn").type, "EMPTY_RESPONSE");
  });

  test("unrecognised prose is treated as a refusal, never parsed", () => {
    const c = classifyModelResponse("Here are some thoughts about boats instead.", "end_turn");
    assert.equal(c.type, "MODEL_REFUSAL");
  });

  test("refusals and scope objections are not retried", () => {
    assert.equal(isRetryable("MODEL_REFUSAL"), false);
    assert.equal(isRetryable("OFF_TOPIC"), false);
    assert.equal(isRetryable("THIN_SOURCE"), false);
    assert.equal(isRetryable("API_ERROR"), true);
    assert.equal(isRetryable("TRUNCATED_JSON"), true);
  });
});

// ── Quarantine ────────────────────────────────────────────────────────────

describe("stale-job quarantine", () => {
  test("the quarantine status is not resumable", () => {
    assert.ok(!RESUMABLE_STATUSES.includes(QUARANTINE_STATUS),
      "a quarantined job must not sit in a resumable status");
  });

  test("resumable set matches the documented statuses", () => {
    for (const s of ["SEO_DONE", "VOICEOVER_DONE", "ASSEMBLY_DONE", "ASSEMBLY_PENDING", "UPLOAD_PENDING"]) {
      assert.ok(RESUMABLE_STATUSES.includes(s as never), `${s} should be resumable`);
    }
  });
});

// ── Test-stage / privacy enforcement ──────────────────────────────────────

describe("private test-stage enforcement", () => {
  const orig = process.env.TEST_STAGE;
  test("non-production stages are test stages", () => {
    for (const s of ["DIAGNOSTIC", "QUALIFICATION", "RETEST", "REPEATABILITY"] as const) {
      assert.equal(isTestStage(s), true, `${s} must force private`);
    }
    assert.equal(isTestStage("PRODUCTION"), false);
  });

  test("an unset or bogus TEST_STAGE defaults to DIAGNOSTIC, never PRODUCTION", () => {
    delete process.env.TEST_STAGE;
    assert.equal(currentTestStage(), "DIAGNOSTIC");
    process.env.TEST_STAGE = "not-a-stage";
    assert.equal(currentTestStage(), "DIAGNOSTIC");
    process.env.TEST_STAGE = orig ?? "DIAGNOSTIC";
  });
});

describe("duplicate-upload prevention", () => {
  test("a real YouTube id blocks re-upload", () => {
    assert.equal(isRealYoutubeId("dQw4w9WgXcQ"), true);
  });
  test("dry-run placeholders are not real uploads", () => {
    assert.equal(isRealYoutubeId("dryrun-abc123"), false);
  });
  test("absent ids are not real uploads", () => {
    assert.equal(isRealYoutubeId(null), false);
    assert.equal(isRealYoutubeId(undefined), false);
    assert.equal(isRealYoutubeId(""), false);
  });
});
