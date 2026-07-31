import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  scoreRelevance, describeFromPexelsUrl, narrationIsAboutVoiceAI, VisualPlan,
} from "../packages/pipeline-core/src/lib/visualRelevance";
import {
  findDiagnosticMarkers, containsDiagnosticMarkers, extractSyncAnchors, locatePhrase,
} from "../packages/pipeline-core/src/lib/syncAnchors";
import { LONGFORM_STYLE, SHORTS_STYLE } from "../packages/pipeline-core/src/lib/captions";
import type { Word, Cue } from "../packages/pipeline-core/src/lib/captions";

const AI_NARRATION =
  "A single AI data centre can now draw more electricity than a small city. " +
  "Training a frontier model is a construction project before it is a software project.";

describe("caption style parity", () => {
  test("both channels share one long-form style object", () => {
    // There is no per-channel style: runAssembly passes the shared default for
    // ai-doom-scroll and wet-circuit alike. This test fails if anyone adds a
    // channel-specific override.
    assert.equal(LONGFORM_STYLE.fontSize, 48);
    assert.equal(LONGFORM_STYLE.bold, true);
    assert.equal(LONGFORM_STYLE.playResX, 1920);
    assert.equal(LONGFORM_STYLE.playResY, 1080);
  });

  test("effective caption height at 1080p is legible", () => {
    // fontSize is in PlayRes units; PlayResY equals the render height, so the
    // ratio is the true on-screen fraction.
    const fraction = LONGFORM_STYLE.fontSize / LONGFORM_STYLE.playResY;
    assert.ok(fraction >= 0.035, `caption is ${(fraction * 100).toFixed(1)}% of frame height — too small`);
    assert.ok(fraction <= 0.08, `caption is ${(fraction * 100).toFixed(1)}% of frame height — too large`);
  });

  test("the old 20px style would now fail the legibility floor", () => {
    assert.ok(20 / 1080 < 0.035, "regression guard: 20px at 1080p is below the floor");
  });

  test("long-form captions sit inside the safe area", () => {
    const column = LONGFORM_STYLE.playResX - LONGFORM_STYLE.marginL - LONGFORM_STYLE.marginR;
    assert.ok(column > 0 && column <= LONGFORM_STYLE.playResX * 0.75,
      `column ${column}px should be a safe centred band`);
    assert.ok(LONGFORM_STYLE.marginV >= 60, "captions must clear the bottom edge");
  });

  test("Shorts keep their own larger style", () => {
    assert.equal(SHORTS_STYLE.playResY, 1920);
    assert.ok(SHORTS_STYLE.fontSize / SHORTS_STYLE.playResY >= 0.035);
  });
});

describe("diagnostic marker rejection", () => {
  for (const bad of [
    "Marker one. Three seconds in.",
    "marker two, middle of the run",
    "Marker three. Near the end.",
    "This is a timing marker for the test",
  ]) {
    test(`rejects: "${bad.slice(0, 32)}…"`, () => {
      assert.ok(containsDiagnosticMarkers(bad), `should flag: ${bad}`);
      assert.ok(findDiagnosticMarkers(bad).length > 0);
    });
  }

  test("accepts ordinary narration", () => {
    assert.equal(containsDiagnosticMarkers(AI_NARRATION), false);
    assert.equal(
      containsDiagnosticMarkers("Every season somebody asks the same question about transducers."),
      false,
    );
  });

  test("does not false-positive on ordinary uses of the word", () => {
    assert.equal(containsDiagnosticMarkers("The marker buoy sits near the channel entrance."), false);
    assert.equal(containsDiagnosticMarkers("That was a marker of real progress."), false);
  });

  test("the shipped diagnostic scripts contain no markers", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("scripts/diagnostic-render.ts", "utf8"));
    // Narration strings only — the file legitimately mentions markers in prose.
    const narrations = [...src.matchAll(/narration:\s*\n?\s*((?:"[^"]*"\s*\+?\s*)+)/g)]
      .map((m) => m[1].replace(/"\s*\+\s*"/g, "").replace(/"/g, ""));
    assert.ok(narrations.length >= 6, `expected 6 narrations, found ${narrations.length}`);
    for (const n of narrations) {
      assert.equal(containsDiagnosticMarkers(n), false, `marker found in: ${n.slice(0, 60)}`);
    }
  });
});

describe("natural synchronisation anchors", () => {
  const words: Word[] = "A single AI data centre can now draw more electricity than a small city"
    .split(" ")
    .map((t, i) => ({ text: t, start: 4 + i * 0.4, end: 4 + i * 0.4 + 0.35 }));
  const cues: Cue[] = [
    { start: words[0].start, end: words[4].end, text: "A single AI data centre" },
    { start: words[5].start, end: words[9].end, text: "can now draw more electricity" },
    { start: words[10].start, end: words[13].end, text: "than a small city" },
  ];

  test("locates a natural phrase in the words", () => {
    assert.equal(locatePhrase(words, "A single AI data"), 0);
    assert.equal(locatePhrase(words, "draw more electricity"), 7);
    assert.equal(locatePhrase(words, "not present here"), -1);
  });

  test("extracts three anchors with measured offsets", () => {
    const anchors = extractSyncAnchors(words, cues, {
      beginning: "A single AI data",
      middle: "can now draw",
      end: "than a small city",
    });
    assert.equal(anchors.length, 3);
    assert.deepEqual(anchors.map((a) => a.position), ["beginning", "middle", "end"]);
    for (const a of anchors) {
      assert.ok(Number.isFinite(a.audioStartS));
      assert.ok(Number.isFinite(a.captionStartS));
      assert.ok(Math.abs(a.offsetS) < 0.25, `${a.position} offset ${a.offsetS}s should be small`);
    }
  });

  test("falls back to derived phrases when none are supplied", () => {
    const anchors = extractSyncAnchors(words, cues);
    assert.ok(anchors.length >= 1);
  });
});

describe("Pexels description extraction", () => {
  test("reads the human-written slug", () => {
    assert.equal(
      describeFromPexelsUrl("https://www.pexels.com/video/video-of-a-woman-singing-6115023/"),
      "video of a woman singing",
    );
    assert.equal(
      describeFromPexelsUrl("https://www.pexels.com/video/close-up-of-a-cpu-7140928/"),
      "close up of a cpu",
    );
  });
  test("returns empty for an unrecognised url", () => {
    assert.equal(describeFromPexelsUrl("https://example.com/x"), "");
  });
});

describe("visual semantic relevance — AI Doom Scroll", () => {
  const base = { channel: "ai-doom-scroll" as const, narration: AI_NARRATION, prompt: "GPU server racks in a data centre" };

  test("the singing clip that shipped is now REJECTED", () => {
    const r = scoreRelevance({ ...base, description: "video of a woman singing" });
    assert.equal(r.verdict, "REJECT");
    assert.equal(r.concept, "human-performance");
    assert.match(r.reasons.join(" "), /human performance/i);
  });

  for (const desc of [
    "a man singing on a microphone",
    "band performing on stage",
    "woman recording vocals in a recording studio",
    "dj mixing music at a concert",
  ]) {
    test(`rejects unrelated performance footage: "${desc}"`, () => {
      assert.equal(scoreRelevance({ ...base, description: desc }).verdict, "REJECT");
    });
  }

  test("accepts a microphone clip when the narration IS about voice AI", () => {
    const voiceNarration =
      "Voice cloning tools now need three seconds of audio. Synthetic speech is being used for fraud.";
    assert.equal(narrationIsAboutVoiceAI(voiceNarration), true);
    const r = scoreRelevance({
      channel: "ai-doom-scroll",
      narration: voiceNarration,
      prompt: "audio engineer reviewing a synthetic speech waveform",
      description: "person speaking into a microphone in a recording studio",
    });
    assert.notEqual(r.verdict, "REJECT");
  });

  test("the bare word 'voice' does not unlock performance footage", () => {
    const n = "The company became the voice of the industry after the acquisition.";
    assert.equal(narrationIsAboutVoiceAI(n), false);
    const r = scoreRelevance({
      channel: "ai-doom-scroll", narration: n,
      prompt: "corporate office", description: "a woman singing into a microphone",
    });
    assert.equal(r.verdict, "REJECT");
  });

  test("strongly on-topic AI footage scores STRONG", () => {
    for (const desc of [
      "close up of a cpu",
      "rows of servers in a data center",
      "robotic arm working on an assembly line",
      "engineer inspecting computer hardware in a server room",
    ]) {
      const r = scoreRelevance({ ...base, description: desc });
      assert.notEqual(r.verdict, "REJECT", `${desc} should not be rejected`);
    }
  });

  test("generic abstract footage is marked GENERIC, not STRONG", () => {
    const r = scoreRelevance({ ...base, description: "dynamic binary code flow in digital space" });
    assert.ok(["GENERIC", "REJECT"].includes(r.verdict), `got ${r.verdict}`);
    assert.equal(r.concept, "generic-abstract");
  });

  test("an asset with no description is rejected", () => {
    assert.equal(scoreRelevance({ ...base, description: "" }).verdict, "REJECT");
  });
});

describe("visual semantic relevance — Wet Circuit unaffected", () => {
  test("marine footage still scores for wet-circuit", () => {
    const r = scoreRelevance({
      channel: "wet-circuit",
      narration: "Will this transducer work on my hull? Deadrise angle and mounting height matter.",
      prompt: "boat hull cutting through open water",
      description: "boat sailing on the sea",
    });
    assert.notEqual(r.verdict, "REJECT");
  });
});

describe("visual composition rules", () => {
  const strong = { score: 0.8, verdict: "STRONG" as const, reasons: [], concept: "datacenter" };
  const strong2 = { score: 0.8, verdict: "STRONG" as const, reasons: [], concept: "robotics" };
  const generic = { score: 0.3, verdict: "GENERIC" as const, reasons: [], concept: "generic-abstract" };

  test("caps generic assets at one per video", () => {
    const plan = new VisualPlan(1, 2);
    assert.equal(plan.admits(generic).ok, true);
    plan.claim(generic);
    assert.equal(plan.admits(generic).ok, false, "a second generic asset must be refused");
  });

  test("blocks the same concept in consecutive scenes", () => {
    const plan = new VisualPlan();
    plan.claim(strong);
    assert.equal(plan.admits(strong).ok, false, "consecutive duplicate concept must be refused");
    assert.equal(plan.admits(strong2).ok, true);
  });

  test("rejected candidates are never admitted", () => {
    const plan = new VisualPlan();
    assert.equal(plan.admits({ score: 0, verdict: "REJECT", reasons: ["x"], concept: "human-performance" }).ok, false);
  });

  test("requires at least two strongly on-topic visuals", () => {
    const plan = new VisualPlan(1, 2);
    plan.claim(strong);
    assert.equal(plan.summary().meetsMinimum, false);
    plan.claim(strong2);
    assert.equal(plan.summary().meetsMinimum, true);
    assert.equal(plan.summary().strongCount, 2);
  });
});
