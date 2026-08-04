import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A production canary is not qualification spend.
 *
 * Credit reservation keys on (channel, testStage), so the stage IS the
 * accounting boundary — `reserveCredits(channel, stage, chars)` and
 * `settleCredits` both write to the CreditBudget row unique on that pair.
 * Running the canary at PRODUCTION therefore charges a different durable row
 * from QUALIFICATION, with no schema change and no new mechanism: the same
 * atomic reservation, the same settle-on-failure, the same idempotency.
 *
 * These tests pin the wiring that makes that true, so a later edit cannot
 * quietly route canary spend back into the qualification row while still
 * printing "canary" in the log.
 */

const qualify = readFileSync("scripts/qualify.ts", "utf8");

describe("the canary is accounted at PRODUCTION, not QUALIFICATION", () => {
  test("the expected stage is derived from the spec, not hardcoded", () => {
    assert.match(qualify, /const expectedStage = spec!\.canary \? "PRODUCTION" : "QUALIFICATION"/,
      "the stage must follow the asset kind");
  });

  test("a stage mismatch refuses to run", () => {
    assert.match(qualify, /if \(stage !== expectedStage\)/);
    assert.match(qualify, /fail\(`TEST_STAGE is \$\{stage\}, expected \$\{expectedStage\}/);
  });

  test("no stage is hardcoded into the spending or QA path", () => {
    // The literal may still appear in comments and in expectedStage above; what
    // must not survive is a hardcoded testStage passed to a stage-sensitive call.
    assert.doesNotMatch(qualify, /testStage: "QUALIFICATION"/,
      "a hardcoded stage would charge canary spend to the qualification row");
    assert.doesNotMatch(qualify, /"LONGFORM", "QUALIFICATION"\)/,
      "runtime checking must follow the run's actual stage");
  });

  test("voiceover, assembly and QA all receive the resolved stage", () => {
    const hits = qualify.match(/testStage: stage/g) ?? [];
    assert.ok(hits.length >= 3, `expected voiceover, assembly and QA to take the stage, found ${hits.length}`);
  });
});

describe("the reservation mechanism is unchanged", () => {
  const budget = readFileSync("packages/pipeline-core/src/lib/budget.ts", "utf8");
  const eleven = readFileSync("packages/pipeline-core/src/lib/elevenlabs.ts", "utf8");

  test("budgets are unique per (channel, stage)", () => {
    const schema = readFileSync("packages/monitor/prisma/schema.prisma", "utf8");
    assert.match(schema, /@@unique\(\[channel, testStage\]\)/,
      "without this, two stages would share one allowance");
  });

  test("PRODUCTION is a real stage, so no migration is involved", () => {
    const schema = readFileSync("packages/monitor/prisma/schema.prisma", "utf8");
    const enumBlock = schema.slice(schema.indexOf("enum TestStage"), schema.indexOf("enum TestStage") + 200);
    assert.match(enumBlock, /PRODUCTION/);
    assert.match(enumBlock, /QUALIFICATION/);
  });

  test("reservation is atomic and conditional on the limit", () => {
    assert.match(budget, /"chargedChars" \+ "reservedChars" \+ \$\{chars\} <= "limitChars"/,
      "the limit must be enforced inside the same statement that reserves");
  });

  test("every synthesis path settles what it reserved", () => {
    assert.match(eleven, /await reserveCredits\(channel, testStage, text\.length\)/);
    const settles = eleven.match(/await settleCredits\(channel, testStage,/g) ?? [];
    assert.ok(settles.length >= 3,
      `reserve must be settled on success, failure and reuse; found ${settles.length} settle calls`);
  });

  test("reuse settles zero, so a rerun costs nothing", () => {
    assert.match(eleven, /await settleCredits\(channel, testStage, text\.length, 0\)/,
      "a reused generation must release its reservation without charging");
  });

  test("the same reservation path serves both stages", () => {
    // reserveCredits takes the stage as a parameter — there is no
    // qualification-only branch that a canary could miss.
    assert.doesNotMatch(eleven, /reserveCredits\([^)]*"QUALIFICATION"/);
    assert.doesNotMatch(eleven, /reserveCredits\([^)]*"PRODUCTION"/);
  });
});

describe("a canary allowance cannot be spent by anything else", () => {
  test("the runner takes exactly one asset key per invocation", () => {
    assert.match(qualify, /const key = process\.argv\[2\]/);
    assert.match(qualify, /const spec = ASSETS\.find\(\(a\) => a\.key === key\)/);
  });

  test("canary is a distinct flag from phase6Authorized", () => {
    assert.match(qualify, /canary\?: boolean/);
    assert.match(qualify, /phase6Authorized\?: boolean/);
    // The invariant checker derives authorized qualification assets from
    // phase6Authorized; a canary must not appear in that set.
    assert.doesNotMatch(qualify, /canary: true,\s*\n\s*phase6Authorized: true/);
  });
});
