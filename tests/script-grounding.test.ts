import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The generator prompt must ask for visuals that can actually be obtained.
 *
 * The first ai1r script passed content validation and then failed the
 * pre-TTS feasibility gate: its planned visuals were python package installs,
 * financial trading terminals, generic code displays and warehouse aerials,
 * with no camera, shop, checkout or control room anywhere — for a script whose
 * opening line is about the camera above the cereal aisle. The old rule
 * invited exactly that by describing visual prompts as "b-roll, graphics, text
 * overlays" with no requirement that the subject be filmable or on-topic.
 *
 * These assertions pin the requirement, not any particular wording of a
 * script, so they stay meaningful for every topic and both channels.
 */

/** Source with newlines and indentation collapsed, so assertions survive wrapping. */
const flat = (p: string) => readFileSync(p, "utf8").replace(/\s+/g, " ");
const PROMPT = flat("src/stages/scriptGenerator.ts");
const WC_PROMPT = flat("packages/wc-pipeline/src/stages/scriptGenerator.ts");

describe("generator asks for concrete, obtainable visuals", () => {
  test("requires a filmable subject", () => {
    assert.match(PROMPT, /concrete, filmable subject/i);
    assert.match(PROMPT, /physical place, object, machine, person, or activity/i);
  });

  test("ties the visual to what the narration is saying at that moment", () => {
    assert.match(PROMPT, /what the narration is literally talking about/i);
  });

  test("prefers the real-world setting over screens", () => {
    assert.match(PROMPT, /real-world setting where the story physically happens/i);
  });

  test("requires distribution across different physical settings", () => {
    assert.match(PROMPT, /DIFFERENT physical settings/);
    assert.match(PROMPT, /No single kind of location or object may carry most/i);
  });

  test("abstract software imagery cannot be the backbone", () => {
    assert.match(PROMPT, /Screens, code, terminals, dashboards/i);
    assert.match(PROMPT, /genuinely about software, code or infrastructure/i);
    assert.match(PROMPT, /never as the backbone/i);
  });

  test("forbids padding with irrelevant variety", () => {
    assert.match(PROMPT, /Do not add an unrelated location just to look varied/i);
  });

  test("forbids brand-identifiable footage", () => {
    assert.match(PROMPT, /real company, product, logo or branded facility/i);
  });

  test("asks for a shot description, not search keywords", () => {
    assert.match(PROMPT, /not as a list of search keywords/i);
  });

  test("no longer invites graphics and text overlays as the visual plan", () => {
    assert.doesNotMatch(
      PROMPT,
      /Visual prompts describe what the viewer sees on screen \(b-roll, graphics, text overlays\)/,
    );
  });
});

describe("existing editorial requirements are intact", () => {
  test("hook, segment count, TTS suitability and CTA survive", () => {
    assert.match(PROMPT, /hook must grab attention/i);
    assert.match(PROMPT, /4-6 body segments/);
    assert.match(PROMPT, /suitable for text-to-speech/i);
    assert.match(PROMPT, /CTA should encourage likes, subscribes/i);
    assert.match(PROMPT, /Total video length/);
  });

  test("the JSON contract is unchanged", () => {
    for (const field of ["hook", "segments", "segmentIndex", "narration",
                         "visual_prompt", "duration_seconds", "cta",
                         "estimatedTotalDuration"]) {
      assert.ok(PROMPT.includes(`"${field}"`), `missing ${field} in output contract`);
    }
  });

  test("internal gate vocabulary never leaks into the prompt", () => {
    for (const leak of ["feasibility gate", "MAX_CONCEPT_SHARE", "fallback card",
                        "concept share", "no-dominant-concept"]) {
      assert.ok(
        !PROMPT.toLowerCase().includes(leak.toLowerCase()),
        `generator prompt must not mention "${leak}"`,
      );
    }
  });

  test("Wet Circuit's generator is untouched by this change", () => {
    assert.ok(WC_PROMPT.length > 0);
    assert.doesNotMatch(WC_PROMPT, /VISUAL GROUNDING/);
  });
});

describe("feasibility thresholds are not relaxed anywhere", () => {
  test("caps and margins hold their values", async () => {
    const f = await import("../packages/pipeline-core/src/lib/visualFeasibility");
    assert.equal(f.MAX_CONCEPT_SHARE, 0.4);
    assert.equal(f.MIN_DISTINCT_CONCEPTS, 3);
  });
});
