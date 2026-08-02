import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  qualityProfile, NON_NEGOTIABLE,
  PREMIUM_AUTOMATED_VISUAL_QUALITY, FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY,
} from "../packages/pipeline-core/src/lib/qualityProfile";

/**
 * Quality profiles relax how a video LOOKS, never what it CLAIMS.
 *
 * FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY is an authorised product decision:
 * convert the remaining credits into watchable videos on a shallow free
 * library rather than produce none. These tests exist so that decision cannot
 * later drift into relaxing anything that protects a viewer or the budget.
 */

describe("the relaxed profile moves only aesthetic tolerances", () => {
  const p = FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY;
  const d = PREMIUM_AUTOMATED_VISUAL_QUALITY;

  test("aesthetic tolerances are relaxed as authorised", () => {
    assert.equal(p.maxConceptShare, 0.6);
    assert.equal(p.maxPerShootCluster, 4);
    assert.equal(p.maxAerialShare, 0.5);
    assert.equal(p.maxCardShare, 0.25);
    assert.equal(p.allowConceptualBRoll, true);
  });

  test("the premium default is untouched", () => {
    assert.equal(d.maxConceptShare, 0.4);
    assert.equal(d.maxPerShootCluster, 2);
    assert.equal(d.maxCardShare, 0.15);
    assert.equal(d.allowConceptualBRoll, false);
  });

  test("no profile can express an honesty, safety or spend rule", () => {
    const keys = new Set(Object.keys(p));
    for (const forbidden of ["allowReuse", "allowLoops", "allowFrozenExtension",
                             "allowReverse", "allowUnrelatedFootage", "allowBrands",
                             "allowConsecutiveCards", "allowSilentSpend",
                             "allowUploadWithoutIntent", "allowPublicUpload"]) {
      assert.ok(!keys.has(forbidden), `profile exposes "${forbidden}" — not a profile concern`);
    }
  });

  test("the non-negotiable list names what stays fixed", () => {
    for (const rule of ["no exact asset reuse", "no loops", "no consecutive cards",
                        "no silent ElevenLabs spending", "no public upload during qualification"]) {
      assert.ok(NON_NEGOTIABLE.includes(rule as never), `missing invariant: ${rule}`);
    }
  });

  test("every profile carries a rationale, so a relaxation is always accountable", () => {
    for (const prof of [p, d]) {
      assert.ok(prof.rationale.length > 80, `${prof.name} has no meaningful rationale`);
    }
    assert.match(p.rationale, /Authorised by Max/);
  });

  test("relaxations are bounded — a profile cannot disable a gate entirely", () => {
    assert.ok(p.maxConceptShare < 1, "a single concept may never fill the timeline");
    assert.ok(p.maxAerialShare < 1, "aerials may never be the whole video");
    assert.ok(p.maxCardShare < 0.5, "cards may never carry most of the video");
    assert.ok(p.maxPerShootCluster < 10, "one shoot may never supply the whole video");
  });

  test("an unknown profile name throws rather than defaulting to the loose one", () => {
    assert.throws(() => qualityProfile("SOMETHING_ELSE" as never), /unknown quality profile/);
    assert.equal(qualityProfile("FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY").maxConceptShare, 0.6);
  });
});
