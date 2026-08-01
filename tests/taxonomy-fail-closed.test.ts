import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  deriveRequirement, scoreSemantic, composeBeat,
} from "../packages/pipeline-core/src/lib/semanticCoverage";
import type { BeatRequirement } from "../packages/pipeline-core/src/lib/semanticCoverage";

/**
 * The unknown-domain fail-open defect, pinned permanently.
 *
 * WHAT HAPPENED
 *
 * Five replacement topics — warehouse robots, humanoid manufacturing, delivery
 * robots, data-centre buildout, autonomous traffic — were screened and every
 * one returned 5/5 beats supported, 0% cards, with every beat reporting 100%
 * subject share and 100% setting share. None of that was real.
 *
 * `deriveRequirement` recognises subjects and settings by looking them up in a
 * hand-maintained FAMILIES vocabulary. That vocabulary was built for a
 * retail-surveillance script, so it had no families for robots, vehicles, data
 * centres or drones. Those topics produced EMPTY requirement lists, and
 * `scoreSemantic` treated an empty list as "satisfied":
 *
 *     subjectMatch = req.primarySubjects.length === 0 || <matched>
 *
 * An empty requirement therefore passed unconditionally, so every candidate
 * scored DIRECT. A hot air balloon over a field scored DIRECT against a
 * data-centre server-room beat.
 *
 * WHY THE FIX IS NOT "ADD MORE VOCABULARY"
 *
 * Extending the taxonomy topic-by-topic leaves the same structure in place: the
 * next unfamiliar domain silently returns to a degenerate pass. Vocabulary
 * coverage is not knowledge of what footage depicts. The taxonomy may hint
 * queries, veto obvious contradictions, and explain decisions — it must never
 * be the thing that produces a POSITIVE verdict for a domain it does not know.
 *
 * These tests exist so that property cannot regress silently.
 */

const req = (visualPrompt: string, narration: string): BeatRequirement =>
  deriveRequirement({ beatIndex: 1, segmentIndex: 0, narration, visualPrompt });

// Deliberately outside the FAMILIES vocabulary.
const UNKNOWN_DOMAIN = req(
  "Data centre server room with racks and cooling",
  "Inside, the racks run hot enough to need their own weather.",
);
const NONSENSE = "a hot air balloon drifting over an empty field";

describe("unknown required concepts fail closed", () => {
  test("an unrecognised domain yields an empty requirement, not a satisfied one", () => {
    assert.equal(UNKNOWN_DOMAIN.primarySubjects.length, 0,
      "fixture must genuinely be outside the taxonomy for this test to mean anything");
    assert.equal(UNKNOWN_DOMAIN.settings.length, 0);
  });

  test("a hot air balloon is NOT direct evidence for a data-centre beat", () => {
    const s = scoreSemantic(UNKNOWN_DOMAIN, NONSENSE);
    assert.notEqual(s.verdict, "DIRECT",
      "this exact case scored DIRECT before the fix and produced five fake topic passes");
    assert.equal(s.subjectMatch, false);
    assert.equal(s.settingMatch, false);
  });

  test("no candidate can become DIRECT merely because nothing matched", () => {
    for (const d of [NONSENSE, "an empty parking lot", "a bowl of soup",
                     "waves breaking on a beach", "a person tying a shoelace"]) {
      assert.notEqual(scoreSemantic(UNKNOWN_DOMAIN, d).verdict, "DIRECT", d);
    }
  });

  test("a required but unrecognised SUBJECT cannot pass", () => {
    // Setting is known, subject is not: the beat must not read as fully covered.
    const r = req("Supermarket aisle with an autonomous inventory drone overhead",
                  "A drone counts the shelves overnight.");
    const s = scoreSemantic(r, "small quadcopter drone flying indoors");
    assert.notEqual(s.verdict, "DIRECT",
      "an unrecognised subject must not be treated as satisfied");
  });

  test("a required but unrecognised SETTING cannot pass", () => {
    const r = req("Security camera mounted inside a nuclear containment building",
                  "The camera watches the containment floor.");
    const s = scoreSemantic(r, "dome security camera mounted on a ceiling");
    // Subject is recognised, setting is not — at best RELATED, never DIRECT.
    assert.notEqual(s.verdict, "DIRECT");
  });

  test("a genuinely optional component differs from an unrecognised required one", () => {
    // Known subject, NO setting named by the prompt: setting is genuinely not
    // required, so a subject-only asset is legitimately DIRECT.
    const subjectOnly = req("Close view of a dome security camera",
                            "The camera never blinks.");
    assert.equal(subjectOnly.settings.length, 0, "no setting is required here");
    assert.equal(
      scoreSemantic(subjectOnly, "dome security camera mounted on a ceiling").verdict,
      "DIRECT",
      "an absent requirement must not be confused with an unmet one",
    );
    // Whereas the unknown-domain beat, whose requirements are empty because the
    // taxonomy failed rather than because nothing was required, cannot be DIRECT.
    assert.notEqual(scoreSemantic(UNKNOWN_DOMAIN, NONSENSE).verdict, "DIRECT");
  });
});

describe("unknown-domain topics cannot report full semantic support", () => {
  test("a beat outside the taxonomy is not coverable by arbitrary footage", () => {
    const r = composeBeat(UNKNOWN_DOMAIN, "COMPOSITIONAL_MATCH_ALLOWED", 18, [
      { assetId: "a", description: NONSENSE, durationS: 20, brandRisk: false },
      { assetId: "b", description: "an empty parking lot", durationS: 20, brandRisk: false },
    ], { beatMaxS: 30, minFragmentS: 3 });
    assert.equal(r.covered, false,
      "before the fix this returned covered=true with 100% subject and setting share");
    assert.equal(r.subjectShare, 0);
    assert.equal(r.settingShare, 0);
  });

  test("100% shares cannot be produced from an empty requirement", () => {
    const r = composeBeat(UNKNOWN_DOMAIN, "SUBJECT_DOMINANT", 18, [
      { assetId: "a", description: NONSENSE, durationS: 20, brandRisk: false },
    ], { beatMaxS: 30, minFragmentS: 3 });
    assert.ok(!(r.subjectShare === 1 && r.covered),
      "the degenerate 100%/covered result must be unreachable");
  });

  test("a joint match cannot be claimed for an unrecognised requirement", () => {
    const r = composeBeat(UNKNOWN_DOMAIN, "JOINT_MATCH_REQUIRED", 18, [
      { assetId: "a", description: NONSENSE, durationS: 20, brandRisk: false },
    ], { beatMaxS: 30, minFragmentS: 3 });
    assert.equal(r.covered, false);
    assert.equal(r.jointMatchAsset, undefined);
  });
});
