import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_CONCEPT_SHARE, qualityProfile,
  PREMIUM_AUTOMATED_VISUAL_QUALITY, FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY,
} from "@yt-pipeline/pipeline-core";
import type { FeasibilityReport } from "@yt-pipeline/pipeline-core";
import {
  tieAwareConceptAccounting, tieAwareChecks, resolveConceptShareTolerance,
} from "../packages/wc-pipeline/src/stages/conceptAccounting";
import { longestNoNewConceptRun } from "../packages/wc-pipeline/src/stages/monotonyDiagnostics";

/**
 * Wet Circuit may opt one run into the repository's existing
 * FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY concept-share tolerance.
 *
 * The profile already existed and already owned 0.60; nothing here invents a
 * threshold. What is new is a run-scoped, explicit, fail-closed selector so a
 * bounded private canary can be evaluated under the tolerance that was
 * authorised for exactly this purpose — while ordinary Wet Circuit production
 * and AI Doom stay strict.
 */

// ── Fixtures built from the three measured candidates' concept shares ────

function reportWithShares(shares: Record<string, number>, timelineS = 100): FeasibilityReport {
  // One fragment per concept, sized to the requested share, each a SINGLE.
  const beats = Object.entries(shares).map(([concept, share], i) => ({
    index: i + 1, startS: 0, endS: 0, durationS: share * timelineS,
    narration: "n", segmentIndex: 0, cardSecondsS: 0, hasCard: false,
    fragments: [{
      assetId: `a${i}`,
      // A slug that classifies to exactly this concept, so the accounting
      // reproduces the intended share.
      description: {
        vessel: "the hull of a wooden boat", water: "a view of sea water",
        electronics: "close up shot of a sonar display", fishing: "a fishing rod and reel",
        install: "wiring and battery installation in a workshop",
      }[concept] ?? concept,
      durationS: share * timelineS, relevanceScore: 0.9,
      verdict: "ACCEPTABLE", concept, brandRisk: false,
    }],
  }));
  return {
    topic: "fixture", channel: "wet-circuit", targetRuntimeS: timelineS + 4,
    plannedVisualDurationS: timelineS, expectedBeatCount: beats.length,
    searchQueries: [], totalCandidates: 0, relevantCandidates: 0,
    strongCandidates: 0, acceptableCandidates: 0, genericCandidates: 0,
    rejectedCandidates: 0, brandRiskCandidates: 0,
    uniqueUsableAssets: 0, uniqueUsableAssetsExcludingBrandRisk: 0,
    totalUsableDurationS: 0, minUniqueAssetsRequired: 0, requiredPoolWithSafety: 0,
    conceptBreakdown: [], distinctConcepts: 0,
    predictedBeats: beats,
    estimatedCardCount: 0, estimatedCardPct: 0, estimatedConsecutiveCardRisk: 0,
    checks: [
      { name: "fallback-card-share", ok: true, detail: "" },
      { name: "no-consecutive-cards", ok: true, detail: "" },
      { name: "unique-assets-cover-timeline", ok: true, detail: "" },
      { name: "pool-safety-margin", ok: true, detail: "" },
      { name: "usable-duration-margin", ok: true, detail: "" },
      { name: "brand-risk-not-load-bearing", ok: true, detail: "" },
      { name: "concept-diversity", ok: false, detail: "SHARED" },
      { name: "no-dominant-concept", ok: false, detail: "SHARED" },
    ],
    pass: false, failureReason: "shared",
  } as FeasibilityReport;
}

const FINITE = "FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY" as const;

/** The three measured candidates, by their tie-aware concept distribution. */
const MEASURED = {
  A: { vessel: 0.442, water: 0.366, electronics: 0.095, fishing: 0.061, install: 0.035 },
  B: { vessel: 0.656, water: 0.311, electronics: 0.034 },
  C: { water: 0.456, vessel: 0.233, fishing: 0.200, install: 0.074, electronics: 0.037 },
};

const dominantOk = (k: keyof typeof MEASURED, opts: object) => {
  const r = reportWithShares(MEASURED[k]);
  const acct = tieAwareConceptAccounting(r, opts);
  return {
    ok: acct.checks.find((c) => c.name === "no-dominant-concept")!.ok,
    share: acct.dominantAnyShare,
    cap: acct.tolerance.maxConceptShare,
    mode: acct.tolerance.mode,
    profile: acct.tolerance.profileName,
  };
};

// ── 1–4. Selector semantics ──────────────────────────────────────────────

describe("profile selection is explicit, run-scoped and fails closed", () => {
  test("1. no explicit profile → strict 0.40", () => {
    const t = resolveConceptShareTolerance({});
    assert.equal(t.mode, "STRICT");
    assert.equal(t.profileName, null);
    assert.equal(t.maxConceptShare, 0.4);
    assert.equal(t.maxConceptShare, MAX_CONCEPT_SHARE,
      "the default is the module constant, not the profile's copy of it");
  });

  test("2. explicit finite-credit → the profile's own 0.60", () => {
    const t = resolveConceptShareTolerance({ qualityProfileName: FINITE });
    assert.equal(t.mode, "FINITE_CREDIT");
    assert.equal(t.profileName, FINITE);
    assert.equal(t.maxConceptShare, 0.6);
    assert.equal(t.maxConceptShare, FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY.maxConceptShare,
      "the value is owned by the profile and never restated in WC code");
  });

  test("3. an unknown profile refuses rather than falling back to relaxed", () => {
    assert.throws(
      () => resolveConceptShareTolerance({ qualityProfileName: "NOT_A_PROFILE" as never }),
      /unknown quality profile/,
    );
    assert.throws(() => qualityProfile("" as never), /unknown quality profile/);
  });

  test("4. ordinary WC production cannot inherit the relaxed profile", () => {
    const gate = readFileSync("packages/wc-pipeline/src/stages/visualFeasibilityGate.ts", "utf8");
    assert.match(gate, /tieAwareConceptAccounting\(report\)/,
      "the production gate calls the accounting with NO profile — strict by construction");
    assert.doesNotMatch(gate, /FINITE_CREDIT|qualityProfileName/,
      "the production gate must not name a relaxed profile");
    // And there is no env or global switch anywhere in WC.
    const acct = readFileSync("packages/wc-pipeline/src/stages/conceptAccounting.ts", "utf8");
    assert.doesNotMatch(acct, /process\.env/, "no environment switch");
    assert.doesNotMatch(acct, /PILOT_ID/, "a pilot must not imply a relaxed profile");
  });

  test("explicit PREMIUM is still strict", () => {
    const t = resolveConceptShareTolerance({ qualityProfileName: "PREMIUM_AUTOMATED_VISUAL_QUALITY" });
    assert.equal(t.mode, "STRICT");
    assert.equal(t.maxConceptShare, PREMIUM_AUTOMATED_VISUAL_QUALITY.maxConceptShare);
  });
});

// ── 5–10. The three measured candidates ──────────────────────────────────

describe("eligibility of the three measured candidates", () => {
  test("5. A strict → concept-share FAIL", () => {
    const r = dominantOk("A", {});
    assert.equal(r.ok, false);
    assert.ok(Math.abs(r.share - 0.442) < 0.005, `${r.share}`);
    assert.equal(r.cap, 0.4);
  });

  test("6. A finite-credit → concept-share PASS", () => {
    const r = dominantOk("A", { qualityProfileName: FINITE });
    assert.equal(r.ok, true);
    assert.equal(r.cap, 0.6);
    assert.equal(r.mode, "FINITE_CREDIT");
  });

  test("7. B strict → FAIL", () => {
    assert.equal(dominantOk("B", {}).ok, false);
  });

  test("8. B finite-credit → STILL FAIL — the monotonous counterexample is not admitted", () => {
    const r = dominantOk("B", { qualityProfileName: FINITE });
    assert.equal(r.ok, false, "65.6% exceeds even the relaxed 60% tolerance");
    assert.ok(r.share > 0.6, `${r.share} must exceed the relaxed cap`);
  });

  test("9. C strict → FAIL", () => {
    assert.equal(dominantOk("C", {}).ok, false);
  });

  test("10. C finite-credit → PASS", () => {
    assert.equal(dominantOk("C", { qualityProfileName: FINITE }).ok, true);
  });

  test("the relaxed tolerance admits A and C but not B", () => {
    const admitted = (["A", "B", "C"] as const)
      .filter((k) => dominantOk(k, { qualityProfileName: FINITE }).ok);
    assert.deepEqual(admitted, ["A", "C"]);
  });
});

// ── 11. Non-targeted gates untouched ─────────────────────────────────────

describe("only the concept-share tolerance moves", () => {
  test("11. the six non-concept checks are byte-identical under both profiles", () => {
    const rep = reportWithShares(MEASURED.A);
    const strict = tieAwareChecks(rep, tieAwareConceptAccounting(rep, {}));
    const finite = tieAwareChecks(rep, tieAwareConceptAccounting(rep, { qualityProfileName: FINITE }));
    const others = (cs: typeof strict) => cs.filter((c) =>
      c.name !== "no-dominant-concept" && c.name !== "concept-diversity");
    assert.deepEqual(others(strict), others(finite), "no other gate may move");
    assert.equal(others(strict).length, 6);
  });

  test("concept-diversity is unaffected by the profile", () => {
    const rep = reportWithShares(MEASURED.A);
    const s = tieAwareConceptAccounting(rep, {}).checks.find((c) => c.name === "concept-diversity")!;
    const f = tieAwareConceptAccounting(rep, { qualityProfileName: FINITE }).checks
      .find((c) => c.name === "concept-diversity")!;
    assert.equal(s.ok, f.ok);
    assert.equal(s.detail, f.detail);
  });

  test("WC reads ONLY maxConceptShare from the profile", () => {
    const acct = readFileSync("packages/wc-pipeline/src/stages/conceptAccounting.ts", "utf8");
    for (const field of ["maxPerShootCluster", "maxAerialShare", "maxCardShare", "allowConceptualBRoll"]) {
      assert.doesNotMatch(acct, new RegExp(`\\.${field}\\b`),
        `${field} must not be read — selecting the profile must not relax an unrelated control`);
    }
    assert.match(acct, /p\.maxConceptShare/, "exactly one field is consumed");
  });

  test("the card cap is still the module constant, untouched by any profile", () => {
    const vf = readFileSync("packages/pipeline-core/src/lib/visualFeasibility.ts", "utf8");
    assert.match(vf, /export const MAX_CARD_SHARE = 0\.15/);
    assert.match(vf, /estimatedCardPct <= MAX_CARD_SHARE \* 100/);
    assert.doesNotMatch(vf, /qualityProfile|maxCardShare/,
      "the shared gate must not consult a profile");
  });
});

// ── 12–13. The monotony diagnostic stays a diagnostic ────────────────────

describe("the monotony diagnostic remains non-gating under either profile", () => {
  test("12. longestNoNewConceptRun does not affect PASS/FAIL", () => {
    const rep = reportWithShares(MEASURED.A);
    for (const opts of [{}, { qualityProfileName: FINITE }]) {
      const acct = tieAwareConceptAccounting(rep, opts);
      const before = acct.checks.map((c) => c.ok);
      const run = longestNoNewConceptRun(acct.fragments);
      assert.ok(run, "the diagnostic computes");
      const after = tieAwareConceptAccounting(rep, opts).checks.map((c) => c.ok);
      assert.deepEqual(before, after, "computing it changes nothing");
    }
  });

  test("13. no candidate-status or gate logic references the diagnostic", () => {
    const gate = readFileSync("packages/wc-pipeline/src/stages/visualFeasibilityGate.ts", "utf8");
    const acct = readFileSync("packages/wc-pipeline/src/stages/conceptAccounting.ts", "utf8");
    const failBlock = gate.slice(gate.indexOf("if (failed.length > 0)"));
    assert.doesNotMatch(failBlock, /longestNoNewConceptRun|monotony/i);
    assert.doesNotMatch(acct, /longestNoNewConceptRun|monotony/i);
  });

  test("no monotony threshold exists anywhere", () => {
    const mono = readFileSync("packages/wc-pipeline/src/stages/monotonyDiagnostics.ts", "utf8");
    assert.doesNotMatch(mono, /(seconds|shareOfTimeline)\s*[<>]=?\s*[0-9]/,
      "the diagnostic is never compared against a bound");
    assert.doesNotMatch(mono, /\bok\s*:|"PASS"|"FAIL"/);
  });
});

// ── 14–18. Safety invariants a profile may never touch ───────────────────

describe("a profile can never relax a safety control", () => {
  test("14. AI Doom is untouched by profile selection", () => {
    const aiGate = readFileSync("src/stages/visualFeasibilityGate.ts", "utf8");
    const aiPipeline = readFileSync("src/pipeline.ts", "utf8");
    const coreUpload = readFileSync("packages/pipeline-core/src/stages/youtubeUpload.ts", "utf8");
    for (const [name, s] of [["AI gate", aiGate], ["AI pipeline", aiPipeline], ["core upload", coreUpload]] as const) {
      assert.doesNotMatch(s, /qualityProfile|FINITE_CREDIT|conceptAccounting/,
        `${name} must not reference profile selection`);
    }
  });

  test("15. no profile field can make an upload public", () => {
    const profile = readFileSync("packages/pipeline-core/src/lib/qualityProfile.ts", "utf8");
    // Scope to the interface's own fields — NON_NEGOTIABLE's prose mentions
    // "no public upload during qualification", which is the opposite concern.
    const iface = profile.slice(
      profile.indexOf("export interface QualityProfile {"),
      profile.indexOf("export const PREMIUM_AUTOMATED_VISUAL_QUALITY"),
    );
    assert.doesNotMatch(iface, /privacy|public|publishAt|unlisted|upload/i,
      "privacy is not expressible as a profile field");
    // And the only numeric tolerances a profile owns are aesthetic ones.
    assert.deepEqual(
      [...iface.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]).sort(),
      ["allowConceptualBRoll", "maxAerialShare", "maxCardShare",
       "maxConceptShare", "maxPerShootCluster", "name", "rationale"],
      "the profile surface is exactly these fields",
    );
    const pilot = readFileSync("packages/pipeline-core/src/lib/pilot.ts", "utf8");
    assert.match(pilot, /privacyStatus: "private"/);
    assert.doesNotMatch(pilot, /qualityProfile/, "the pilot policy ignores profiles entirely");
  });

  test("16. profile selection cannot introduce a publishAt", () => {
    const wcUpload = readFileSync("packages/wc-pipeline/src/stages/youtubeUpload.ts", "utf8");
    assert.doesNotMatch(wcUpload, /qualityProfile|FINITE_CREDIT/,
      "the upload stage never consults a profile");
    assert.match(wcUpload, /assertPilotUploadAllowed\(policy, scheduledAt\)/,
      "the private/no-publishAt assertion is unchanged");
  });

  test("17. profile selection does not alter narration budget behaviour", () => {
    const voice = readFileSync("packages/wc-pipeline/src/stages/voiceover.ts", "utf8");
    assert.doesNotMatch(voice, /qualityProfile|FINITE_CREDIT|conceptAccounting/,
      "the budget window is independent of any quality profile");
    assert.match(voice, /withBudgetWindow\(\s*"wet-circuit"/);
    assert.match(voice, /spokenCharacterCount\(buildSpokenUnits\(script\)\)/);
  });

  test("18. profile selection does not alter the pilot success cap", () => {
    const pilotUpload = readFileSync("packages/wc-pipeline/src/stages/pilotUpload.ts", "utf8");
    assert.doesNotMatch(pilotUpload, /qualityProfile|FINITE_CREDIT/);
    assert.match(pilotUpload, /claimPilotSlot\(pilot\.pilotId\)/);
  });

  test("NON_NEGOTIABLE still excludes concept share and includes the real invariants", async () => {
    const { NON_NEGOTIABLE } = await import("../packages/pipeline-core/src/lib/qualityProfile");
    for (const rule of [
      "no exact asset reuse", "no loops", "no consecutive cards",
      "no silent ElevenLabs spending", "no upload without a durable upload intent",
      "no public upload during qualification",
    ]) {
      assert.ok((NON_NEGOTIABLE as readonly string[]).includes(rule), `missing: ${rule}`);
    }
    assert.ok(!(NON_NEGOTIABLE as readonly string[]).some((r) => /concept share/i.test(r)),
      "concept share is deliberately an aesthetic tolerance, not an invariant");
  });
});

// ── Threshold provenance ─────────────────────────────────────────────────

describe("no threshold was invented in this pass", () => {
  test("17/18. MAX_CONCEPT_SHARE is still exactly 0.40", () => {
    assert.equal(MAX_CONCEPT_SHARE, 0.4);
    const vf = readFileSync("packages/pipeline-core/src/lib/visualFeasibility.ts", "utf8");
    assert.match(vf, /export const MAX_CONCEPT_SHARE = 0\.4;/);
  });

  test("the finite-credit value is the profile's pre-existing 0.60", () => {
    assert.equal(FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY.maxConceptShare, 0.6);
    const profile = readFileSync("packages/pipeline-core/src/lib/qualityProfile.ts", "utf8");
    assert.match(profile, /maxConceptShare: 0\.6,/);
  });

  test("WC code never restates 0.4 or 0.6", () => {
    const acct = readFileSync("packages/wc-pipeline/src/stages/conceptAccounting.ts", "utf8");
    assert.doesNotMatch(acct, /=\s*0\.4\b|=\s*0\.6\b/,
      "both values are owned elsewhere and imported");
  });
});
