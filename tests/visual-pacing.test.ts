import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planSegmentBeats, planVisualBeats, summarizeBeats, minimumBeatsFor, BEAT_MAX_S, BEAT_MIN_S,
} from "../packages/pipeline-core/src/lib/visualBeats";
import {
  checkBrandFromMetadata, brandCheckFromFrameInspection, brandAdmits,
  narrationMentionsBrand, isHighBrandRiskFootage,
} from "../packages/pipeline-core/src/lib/brandGuard";
import {
  sha256File, sha256Manifest, verifyApproved, ArtifactMismatchError,
} from "../packages/pipeline-core/src/lib/approvedArtifact";
import type { Word } from "../packages/pipeline-core/src/lib/captions";

/** Build words for `sentences`, each word 0.4s, sentences ending in ".". */
function words(sentences: string[], start = 0): Word[] {
  const out: Word[] = [];
  let t = start;
  for (const s of sentences) {
    for (const w of s.split(" ")) {
      out.push({ text: w, start: t, end: t + 0.35 });
      t += 0.4;
    }
  }
  return out;
}

const SENTENCE = "high bandwidth memory sits beside the accelerator die on the same package today.";

describe("visual beats — scene density", () => {
  test("a 120s segment yields many beats, not one", () => {
    // Regression: the opening 119.8s segment rendered a single looped clip.
    const w = words(Array(38).fill(SENTENCE)); // ~121s
    const beats = planSegmentBeats(w, 0);
    assert.ok(beats.length >= 4, `expected several beats, got ${beats.length}`);
    const total = beats.reduce((a, b) => a + b.durationS, 0);
    assert.ok(Math.abs(total - (w[w.length - 1].end - w[0].start)) < 1, "beats must tile the segment");
  });

  test("no beat exceeds the 30s hard cap", () => {
    const beats = planSegmentBeats(words(Array(60).fill(SENTENCE)), 0);
    for (const b of beats) {
      assert.ok(b.durationS <= BEAT_MAX_S + 0.5, `beat ${b.index} is ${b.durationS}s`);
    }
  });

  test("beats are contiguous and non-overlapping", () => {
    const beats = planSegmentBeats(words(Array(40).fill(SENTENCE)), 0);
    for (let i = 0; i < beats.length - 1; i++) {
      assert.ok(beats[i].endS <= beats[i + 1].startS + 1e-6, "beats must not overlap");
      assert.ok(Math.abs(beats[i + 1].startS - beats[i].endS) < 1e-6, "beats must not leave gaps");
    }
  });

  test("beats cut on sentence boundaries", () => {
    const beats = planSegmentBeats(words(Array(20).fill(SENTENCE)), 0);
    for (const b of beats.slice(0, -1)) {
      assert.match(b.narration.trim(), /\.$/, `beat should end a sentence: "${b.narration.slice(-30)}"`);
    }
  });

  test("very short trailing content merges rather than flashing", () => {
    const beats = planSegmentBeats(words([...Array(12).fill(SENTENCE), "and that is it."]), 0);
    const last = beats[beats.length - 1];
    assert.ok(last.durationS >= BEAT_MIN_S || beats.length === 1, `trailing beat only ${last.durationS}s`);
  });

  test("a 431s narration produces a realistic beat count", () => {
    const segs = Array.from({ length: 5 }, (_, i) => words(Array(27).fill(SENTENCE), i * 86));
    const beats = planVisualBeats(segs);
    const s = summarizeBeats(beats);
    assert.ok(s.count >= 15, `expected 15+ beats for ~7 minutes, got ${s.count}`);
    assert.ok(s.maxS <= BEAT_MAX_S + 0.5);
    assert.ok(s.averageS >= 10 && s.averageS <= 26, `average ${s.averageS}s should sit in the 15-25s band`);
  });

  test("minimum beat floor scales with runtime", () => {
    assert.ok(minimumBeatsFor(431) >= 14, "a 7-minute video needs many visual changes");
    assert.ok(minimumBeatsFor(431) > minimumBeatsFor(120));
  });

  test("five beats would fail the floor for a 431s video", () => {
    assert.ok(5 < minimumBeatsFor(431), "the shipped 5-asset timeline must be rejected");
  });
});

describe("brand relevance guard", () => {
  const hbm = "High bandwidth memory stacks are sold out. SK Hynix, Samsung and Micron are the only suppliers.";

  test("Volkswagen signage is rejected for the HBM narration", () => {
    const c = checkBrandFromFrame("Volkswagen Chattanooga", hbm);
    assert.equal(c.visibleBrandDetected, true);
    assert.equal(c.brandRelevantToNarration, false);
    assert.equal(c.brandDecision, "IRRELEVANT");
    assert.equal(brandAdmits(c), false);
    assert.match(c.rejectionReason!, /unrelated/i);
  });

  test("a brand the narration discusses is allowed", () => {
    const c = checkBrandFromFrame("SK Hynix", hbm);
    assert.equal(c.brandDecision, "RELEVANT");
    assert.equal(brandAdmits(c), true);
  });

  test("metadata surface catches branded slugs", () => {
    const c = checkBrandFromMetadata("aerial view of the volkswagen plant", "factory", hbm);
    assert.equal(c.brandDecision, "IRRELEVANT");
    assert.equal(c.source, "metadata");
  });

  test("unbranded footage passes cleanly", () => {
    const c = checkBrandFromMetadata("modern semiconductor manufacturing facility", "cleanroom", hbm);
    assert.equal(c.visibleBrandDetected, false);
    assert.equal(c.brandDecision, "NO_BRAND");
    assert.equal(brandAdmits(c), true);
  });

  test("narrationMentionsBrand needs a real mention", () => {
    assert.equal(narrationMentionsBrand(hbm, "micron"), true);
    assert.equal(narrationMentionsBrand(hbm, "volkswagen"), false);
  });

  test("brand names that are ordinary words need corroborating context", () => {
    // "arm" is a chip designer AND the part of a robot that moves. Matching the
    // bare token rejected "industrial robot arm on an assembly line", which is
    // the single most useful shot for any robotics topic.
    const robot = checkBrandFromMetadata(
      "industrial robot arm on an assembly line", "factory automation",
      "Warehouse robots now navigate without a fixed map.",
    );
    assert.equal(robot.visibleBrandDetected, false, "a robot arm is not Arm Holdings");
    assert.equal(brandAdmits(robot), true);

    // The company itself, named as such, is still caught.
    const holdings = checkBrandFromMetadata(
      "arm cortex processor die shot", "chip design",
      "Warehouse robots now navigate without a fixed map.",
    );
    assert.equal(holdings.visibleBrandDetected, true);
    assert.equal(brandAdmits(holdings), false, "unrelated Arm branding is still rejected");

    // Same treatment for the other everyday-word brands.
    const aim = checkBrandFromMetadata(
      "a camera target on a calibration board", "computer vision",
      "Vision systems are calibrated before deployment.",
    );
    assert.equal(aim.visibleBrandDetected, false, "a calibration target is not the retailer");
  });

  test("industrial aerials are flagged as brand-risk for frame inspection", () => {
    // The Volkswagen clip was described only as an industrial aerial — its
    // metadata carried no brand hint at all, so it must be flagged for the
    // frame-inspection surface.
    assert.equal(isHighBrandRiskFootage("aerial view of large industrial warehouse facility"), true);
    assert.equal(isHighBrandRiskFootage("drone shot of a big factory"), true);
    assert.equal(isHighBrandRiskFootage("close up of a memory module"), false);
  });

  function checkBrandFromFrame(signage: string, narration: string) {
    return brandCheckFromFrameInspection(signage, narration);
  }
});

describe("immutable approved artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-"));
  const file = join(dir, "final.mp4");
  writeFileSync(file, "approved bytes");
  const manifest = [
    { index: 1, startS: 0, endS: 19, durationS: 19, assetId: "a1", assetDescription: "x",
      looped: false, reused: false, relevanceScore: 0.7, concept: "compute",
      brandDecision: "NO_BRAND", decision: "RENDERED" },
  ];

  test("verification passes for the exact approved artifact", async () => {
    const fileSha256 = await sha256File(file);
    const manifestSha256 = sha256Manifest(manifest);
    await verifyApproved({ filePath: file, fileSha256, manifestSha256, manifest });
  });

  test("a changed file fails closed", async () => {
    const fileSha256 = await sha256File(file);
    const manifestSha256 = sha256Manifest(manifest);
    writeFileSync(file, "different bytes");
    await assert.rejects(
      () => verifyApproved({ filePath: file, fileSha256, manifestSha256, manifest }),
      (e: unknown) => e instanceof ArtifactMismatchError,
    );
    writeFileSync(file, "approved bytes");
  });

  test("a changed scene manifest fails closed", async () => {
    const fileSha256 = await sha256File(file);
    const manifestSha256 = sha256Manifest(manifest);
    const tampered = [{ ...manifest[0], assetId: "different-asset" }];
    await assert.rejects(
      () => verifyApproved({ filePath: file, fileSha256, manifestSha256, manifest: tampered }),
      (e: unknown) => e instanceof ArtifactMismatchError,
    );
  });

  test("a missing file fails closed", async () => {
    await assert.rejects(
      () => verifyApproved({
        filePath: join(dir, "gone.mp4"), fileSha256: "x", manifestSha256: "y", manifest,
      }),
      (e: unknown) => e instanceof ArtifactMismatchError,
    );
  });

  test("retrying verification reuses the same artifact and is stable", async () => {
    const fileSha256 = await sha256File(file);
    const manifestSha256 = sha256Manifest(manifest);
    for (let i = 0; i < 3; i++) {
      await verifyApproved({ filePath: file, fileSha256, manifestSha256, manifest });
    }
    assert.equal(await sha256File(file), fileSha256, "file must not change across retries");
  });

  test("the upload path invokes no generation stage", () => {
    // Static guarantee: upload() must not reference assembly, TTS, visual
    // search or caption rendering.
    const src = readFileSync("scripts/qualify.ts", "utf8");
    const body = src.slice(src.indexOf("async function upload("));
    for (const forbidden of [
      "runAssembly", "runVoiceover", "synthesizeSegment", "searchPexelsCandidates",
      "scoreRelevance", "buildLongformCaptions", "generateScript",
    ]) {
      assert.ok(!body.includes(forbidden), `upload() must not call ${forbidden}`);
    }
  });
});
