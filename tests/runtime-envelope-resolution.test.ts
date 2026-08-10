import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  runtimeRange, checkRuntime, currentTestStage,
  CONFIGURED_RANGE, OBSERVED_RANGE,
} from "@yt-pipeline/pipeline-core";
import type { TestStage } from "@prisma/client";
import { WC_CANARY_AUTHORIZATIONS } from "../packages/wc-pipeline/src/canary/authorization";

/**
 * Which runtime envelope a candidate is judged against.
 *
 * The failure this pins: the Wet Circuit canary was verified with TEST_STAGE
 * unset, `currentTestStage()` defaulted to DIAGNOSTIC, and the gate compared a
 * 281.2s long-form asset against the DIAGNOSTIC band of 55-100s — reported as
 * "outside 0.9-1.7 min". The candidate is comfortably inside its real 210-340s
 * policy. Nothing was wrong with the candidate; the envelope was selected by an
 * absent environment variable.
 *
 * The inverse is the dangerous direction and is pinned too: a PASS obtained
 * under DIAGNOSTIC must never be accepted as evidence for a PRODUCTION run.
 */

const AUTH = WC_CANARY_AUTHORIZATIONS[0]!;
const CANDIDATE_S = 281.2;
const VERIFY = readFileSync("scripts/wc-feasibility-verify.ts", "utf8");
const CONTROL = readFileSync("scripts/wc-canary-control.ts", "utf8");
const GATE = readFileSync("packages/wc-pipeline/src/stages/visualFeasibilityGate.ts", "utf8");

// ── The envelopes themselves ──────────────────────────────────────────────

describe("Wet Circuit long-form envelope", () => {
  test("PRODUCTION long-form is the grounded 210-340s band", () => {
    const r = runtimeRange("wet-circuit", "LONGFORM", "PRODUCTION");
    assert.equal(r.minS, 210);
    assert.equal(r.maxS, 340);
  });

  test("the canary candidate's 281.2s sits inside it", () => {
    const c = checkRuntime(CANDIDATE_S, "wet-circuit", "LONGFORM", "PRODUCTION");
    assert.ok(c.ok, c.detail);
  });

  test("281.2s is OUTSIDE the diagnostic band — the reported failure", () => {
    const c = checkRuntime(CANDIDATE_S, "wet-circuit", "LONGFORM", "DIAGNOSTIC");
    assert.equal(c.ok, false);
    assert.equal(c.range.minS, 55);
    assert.equal(c.range.maxS, 100);
    // 55-100s is exactly the "0.9-1.7 min" the gate reported.
    assert.equal((c.range.minS / 60).toFixed(1), "0.9");
    assert.equal((c.range.maxS / 60).toFixed(1), "1.7");
  });

  test("a genuinely too-short long-form script still fails at PRODUCTION", () => {
    assert.equal(checkRuntime(120, "wet-circuit", "LONGFORM", "PRODUCTION").ok, false);
  });

  test("a genuinely too-long long-form script still fails at PRODUCTION", () => {
    assert.equal(checkRuntime(600, "wet-circuit", "LONGFORM", "PRODUCTION").ok, false);
    // The old 6-8 minute configured ask would now be rejected, which is the
    // point: OBSERVED behaviour governs, not the prompt's aspiration.
    assert.equal(checkRuntime(CONFIGURED_RANGE["wet-circuit"].minS,
      "wet-circuit", "LONGFORM", "PRODUCTION").ok, false);
  });

  test("the band is consistent with what the channel actually publishes", () => {
    const obs = OBSERVED_RANGE["wet-circuit"];
    const r = runtimeRange("wet-circuit", "LONGFORM", "PRODUCTION");
    assert.ok(r.minS <= obs.minS, "policy must admit the shortest published video");
    assert.ok(r.maxS >= obs.maxS, "policy must admit the longest published video");
    assert.ok(obs.medianS >= r.minS && obs.medianS <= r.maxS);
  });
});

// ── Stage selection cannot swap envelopes silently ────────────────────────

describe("stage selection", () => {
  const REAL_STAGES: TestStage[] = ["QUALIFICATION", "RETEST", "REPEATABILITY", "PRODUCTION"];

  test("every non-diagnostic stage gets the real channel band", () => {
    for (const s of REAL_STAGES) {
      const r = runtimeRange("wet-circuit", "LONGFORM", s);
      assert.equal(r.minS, 210, `${s} resolved ${r.minS}`);
      assert.equal(r.maxS, 340, `${s} resolved ${r.maxS}`);
    }
  });

  test("only DIAGNOSTIC gets the short diagnostic band", () => {
    const d = runtimeRange("wet-circuit", "LONGFORM", "DIAGNOSTIC");
    assert.equal(d.minS, 55);
    for (const s of REAL_STAGES) {
      assert.notDeepEqual(runtimeRange("wet-circuit", "LONGFORM", s), d);
    }
  });

  test("currentTestStage defaults to DIAGNOSTIC — the trap that caused this", () => {
    const saved = process.env.TEST_STAGE;
    try {
      delete process.env.TEST_STAGE;
      assert.equal(currentTestStage(), "DIAGNOSTIC");
      process.env.TEST_STAGE = "PRODUCTIN"; // misspelt
      assert.equal(currentTestStage(), "DIAGNOSTIC",
        "a typo silently selects the diagnostic envelope");
    } finally {
      if (saved === undefined) delete process.env.TEST_STAGE;
      else process.env.TEST_STAGE = saved;
    }
  });

  test("the DIAGNOSTIC default is kept — it is fail-safe for SPEND", () => {
    // Defaulting to DIAGNOSTIC is correct for budget: the diagnostic allocation
    // is the smallest. The fix belongs in stage RESOLUTION for the canary, not
    // in changing this default, which would loosen a cost control.
    assert.match(readFileSync("packages/pipeline-core/src/lib/testStage.ts", "utf8"),
      /return "DIAGNOSTIC";/);
  });
});

// ── SHORT vs LONGFORM stay separate ───────────────────────────────────────

describe("format selection", () => {
  test("SHORT is a distinct band and ignores the stage entirely", () => {
    const s = runtimeRange("wet-circuit", "SHORT", "PRODUCTION");
    assert.equal(s.minS, 20);
    assert.equal(s.maxS, 60);
    assert.deepEqual(runtimeRange("wet-circuit", "SHORT", "DIAGNOSTIC"), s);
  });

  test("the canary is LONGFORM, never SHORT", () => {
    assert.equal(AUTH.assetKind, "LONGFORM");
    assert.equal(checkRuntime(CANDIDATE_S, "wet-circuit", "SHORT", "PRODUCTION").ok, false,
      "281s would fail as a Short — the format must not be misresolved either");
  });

  test("the WC gate always asks for LONGFORM", () => {
    assert.match(GATE, /runtimeRange\(CHANNEL, "LONGFORM",/);
  });
});

// ── AI Doom is unaffected ─────────────────────────────────────────────────

describe("AI Doom target selection is unaffected", () => {
  test("its production band is its own", () => {
    const r = runtimeRange("ai-doom-scroll", "LONGFORM", "PRODUCTION");
    assert.equal(r.minS, 300);
    assert.equal(r.maxS, 480);
    assert.notDeepEqual(r, runtimeRange("wet-circuit", "LONGFORM", "PRODUCTION"));
  });

  test("its observed range still sits inside its policy", () => {
    const obs = OBSERVED_RANGE["ai-doom-scroll"];
    const r = runtimeRange("ai-doom-scroll", "LONGFORM", "PRODUCTION");
    assert.ok(obs.medianS >= r.minS && obs.medianS <= r.maxS);
  });
});

// ── The authorisation owns the stage ──────────────────────────────────────

describe("the canary authorisation pins its own stage", () => {
  test("it declares PRODUCTION explicitly", () => {
    assert.equal(AUTH.testStage, "PRODUCTION");
  });

  test("its runtime envelope matches what that stage resolves", () => {
    const r = runtimeRange("wet-circuit", "LONGFORM", AUTH.testStage);
    assert.equal(AUTH.runtimeMinS, r.minS);
    assert.equal(AUTH.runtimeMaxS, r.maxS);
  });

  test("the candidate sits inside the authorised envelope", () => {
    assert.ok(CANDIDATE_S >= AUTH.runtimeMinS && CANDIDATE_S <= AUTH.runtimeMaxS);
  });

  test("the authorisation resolves its envelope from its own stage, not a literal", () => {
    const src = readFileSync("packages/wc-pipeline/src/canary/authorization.ts", "utf8");
    assert.match(src, /runtimeRange\("wet-circuit", "LONGFORM", auth\.testStage\)/);
    assert.doesNotMatch(src, /runtimeRange\("wet-circuit", "LONGFORM", "PRODUCTION"\)/,
      "a hardcoded stage would drift from the declared one");
  });
});

// ── The verifier runs the same gate under the same stage ──────────────────

describe("verifier and production resolve the same policy", () => {
  test("the verifier executes the REAL gate, not a reimplementation", () => {
    assert.match(VERIFY, /import \{ wcVisualFeasibilityGate/);
    assert.match(VERIFY, /wcVisualFeasibilityGate\(/);
  });

  test("the verifier takes its stage from the authorisation", () => {
    assert.match(VERIFY, /function resolveVerificationStage\(\): TestStage/);
    assert.match(VERIFY, /const declared = AUTH\.testStage/);
    assert.match(VERIFY, /process\.env\.TEST_STAGE = declared/);
  });

  test("a conflicting ambient TEST_STAGE is refused, not overridden", () => {
    assert.match(VERIFY, /disagrees with the authorised stage/);
    assert.match(VERIFY, /process\.exit\(2\)/);
  });

  test("the verifier reports the band it used", () => {
    assert.match(VERIFY, /the band Monday's run uses/);
  });

  test("the verifier does not bypass or stub the runtime check", () => {
    // Only two substitutions are permitted, both documented: the durable write
    // and the pilot window. Nothing may stub the envelope itself.
    assert.doesNotMatch(VERIFY, /runtimeRange\s*=/);
    assert.doesNotMatch(VERIFY, /checkRuntime\s*=/);
    assert.doesNotMatch(VERIFY, /wcDurationEnvelope\s*=/);
  });
});

// ── A verification cannot be misapplied across stages ─────────────────────

describe("verification records carry their envelope", () => {
  test("the verifier records stage and band", () => {
    assert.match(VERIFY, /testStage: stage/);
    assert.match(VERIFY, /runtimeMinS: envelope\.minS/);
    assert.match(VERIFY, /runtimeMaxS: envelope\.maxS/);
  });

  test("CHECK refuses a verification from a different stage", () => {
    assert.match(CONTROL, /verification\.testStage !== AUTH\.testStage/);
    assert.match(CONTROL, /run requires \$\{AUTH\.testStage\}/);
  });

  test("CHECK refuses a verification from a different envelope", () => {
    assert.match(CONTROL, /verification\.runtimeMinS !== AUTH\.runtimeMinS/);
  });

  test("an unrecorded stage is treated as unusable, not as a pass", () => {
    // Older records have no testStage; `undefined !== "PRODUCTION"` must fail
    // the check rather than being skipped.
    const rec: { testStage?: string } = {};
    assert.notEqual(rec.testStage, AUTH.testStage);
  });
});

// ── No stale literal envelopes anywhere ───────────────────────────────────

describe("no hardcoded envelope can override the resolver", () => {
  test("nothing outside runtimeTargets defines a long-form band", () => {
    for (const [file, src] of [
      ["gate", GATE],
      ["verifier", VERIFY],
      ["canary control", CONTROL],
      ["authorization", readFileSync("packages/wc-pipeline/src/canary/authorization.ts", "utf8")],
    ] as const) {
      // The diagnostic band's own numbers must not appear as a literal pair.
      assert.ok(!/55\s*,\s*maxS:\s*100/.test(src), `${file} hardcodes the diagnostic band`);
      assert.ok(!/minS:\s*\d+\s*,\s*maxS:\s*\d+/.test(src),
        `${file} defines its own runtime band instead of resolving one`);
    }
  });

  test("the WC gate resolves rather than hardcodes", () => {
    assert.match(GATE, /runtimeRange\(/);
    assert.doesNotMatch(GATE, /\b0\.9\b|\b1\.7\b/);
  });
});

// ── The same trap, one layer down: PILOT_ID selects the PROFILE ───────────

describe("quality profile resolution", () => {
  const PILOT = readFileSync("packages/pipeline-core/src/lib/pilot.ts", "utf8");

  test("activePilotId returns null when PILOT_ID is missing", () => {
    // This is why the first corrected run still failed: a null pilot means
    // resolveWcCanaryAuthorization is never consulted, so the relaxed profile
    // never applies and the gate falls back to the STRICT 40% concept cap —
    // which the canary is explicitly authorised to exceed at 60%.
    assert.match(PILOT, /const id = process\.env\.PILOT_ID\?\.trim\(\)/);
    assert.match(PILOT, /return id && id\.length > 0 \? id : null/);
    assert.match(PILOT, /const id = activePilotId\(\);\s*\n\s*if \(!id\) return null;/);
  });

  test("the verifier pins the pilot from the authorisation", () => {
    assert.match(VERIFY, /function resolveVerificationPilot\(\): string/);
    assert.match(VERIFY, /const declared = AUTH\.pilotId/);
    assert.match(VERIFY, /process\.env\.PILOT_ID = declared/);
  });

  test("a conflicting ambient PILOT_ID is refused, not overridden", () => {
    const fn = VERIFY.slice(VERIFY.indexOf("function resolveVerificationPilot"));
    assert.match(fn, /disagrees with the authorised pilot/);
    assert.match(fn.slice(0, fn.indexOf("function resolveVerificationStage")), /process\.exit\(2\)/);
  });

  test("the Prisma-layer substitution alone could not have covered this", () => {
    // getPilot reads through the substituted findUnique, but currentPilot
    // returns null before reaching it. Both layers are needed.
    assert.match(VERIFY, /findUnique = async \(\) => modelled/);
    const stub = VERIFY.indexOf("findUnique = async () => modelled");
    const pin = VERIFY.indexOf("process.env.PILOT_ID = declared");
    assert.ok(pin >= 0 && pin < stub, "the id must be pinned before the row is substituted");
  });

  test("pinning the pilot arms nothing", () => {
    // Arming is a durable UPDATE performed only by wc-canary-control --arm.
    assert.doesNotMatch(VERIFY, /status['"]?\s*:\s*['"]ACTIVE/);
    assert.doesNotMatch(VERIFY, /activatedAt/);
    assert.match(CONTROL, /SET "status" = 'ACTIVE'/, "arming lives in the control, not the verifier");
  });

  test("the authorised tolerance is the profile's, never restated", () => {
    const AUTHSRC = readFileSync("packages/wc-pipeline/src/canary/authorization.ts", "utf8");
    assert.doesNotMatch(AUTHSRC, /maxConceptShare:\s*0?\.6/,
      "the manifest names the profile; the value belongs to the profile");
    assert.match(AUTHSRC, /qualityProfileName: "FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY"/);
  });

  test("a strict-profile candidate still fails the concept cap", () => {
    // The relaxation is opt-in per authorised candidate. Nothing about this fix
    // widens the cap for ordinary production.
    const GATESRC = readFileSync("packages/wc-pipeline/src/stages/visualFeasibilityGate.ts", "utf8");
    assert.match(GATESRC, /let tieAware: TieAwareOptions = \{\};/,
      "the default must be strict, with the profile applied only on resolution");
  });
});
