import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normaliseBrandRisk } from "../packages/pipeline-core/src/lib/brandRisk";

/**
 * brandRisk normalisation.
 *
 * The first vision benchmark lost 7 of 56 judgments to one validator rule that
 * accepted only the exact strings NONE / POSSIBLE / VISIBLE. Three of those
 * were otherwise-usable DIRECT judgments, so a strict spelling check became a
 * recall failure attributed to the model.
 *
 * IMPORTANT: the exact value the model returned in those seven calls was NOT
 * preserved — the runner recorded only the reason string "brandRisk invalid",
 * not the offending payload. The variants below are therefore plausible
 * spellings chosen to cover the space, NOT the observed value. That gap is
 * itself fixed: the runner now stores the raw response body and the raw
 * brandRisk value on every record.
 */

describe("recognised spellings normalise to their level", () => {
  for (const [input, expected] of [
    ["NONE", "NONE"], ["none", "NONE"], ["  None  ", "NONE"],
    ["no branding", "NONE"], ["no_visible_brand", "NONE"], ["NO-BRAND", "NONE"],
    ["POSSIBLE", "POSSIBLE"], ["possible", "POSSIBLE"], ["Low", "POSSIBLE"],
    ["moderate", "POSSIBLE"], ["unclear", "POSSIBLE"], ["minor branding", "POSSIBLE"],
    ["VISIBLE", "VISIBLE"], ["visible", "VISIBLE"], ["High", "VISIBLE"],
    ["clearly visible", "VISIBLE"], ["logo visible", "VISIBLE"],
  ] as const) {
    test(`"${input}" -> ${expected}`, () => {
      const r = normaliseBrandRisk(input);
      assert.equal(r.value, expected);
      assert.equal(r.recognised, true);
    });
  }
});

describe("anything unrecognised fails toward caution, never toward NONE", () => {
  const unknown = [
    "LOW_RISK_MINIMAL", "n/a", "unknown", "0", "brand risk: none detected",
    "NONE (no logos observed)", "", "   ",
    null, undefined, 0, 1, true, [], {}, { result: "NONE" }, ["NONE"],
  ];
  for (const v of unknown) {
    test(`${JSON.stringify(v) ?? String(v)} -> POSSIBLE`, () => {
      const r = normaliseBrandRisk(v);
      assert.equal(r.value, "POSSIBLE", "unknown input must never normalise to NONE");
      assert.equal(r.recognised, false);
    });
  }

  test("never throws, whatever it is handed", () => {
    for (const v of [Symbol("x"), () => {}, NaN, Infinity, new Date()]) {
      assert.doesNotThrow(() => normaliseBrandRisk(v));
      assert.equal(normaliseBrandRisk(v).value, "POSSIBLE");
    }
  });

  test("the raw value is retained for audit", () => {
    const r = normaliseBrandRisk("LOW_RISK_MINIMAL");
    assert.equal(r.raw, "LOW_RISK_MINIMAL");
    assert.equal(r.value, "POSSIBLE");
  });
});

describe("the asymmetry is the point", () => {
  test("no unrecognised input can produce NONE", () => {
    const probes = ["nope", "zero", "nil", "not applicable", "-", "?", "NONEISH",
                    "definitely no brands here at all", "0%", "false"];
    for (const p of probes) {
      assert.notEqual(normaliseBrandRisk(p).value, "NONE",
        `"${p}" must not be read as an absence of branding`);
    }
  });

  test("only the documented NONE aliases yield NONE", () => {
    assert.equal(normaliseBrandRisk("no visible branding").value, "NONE");
    assert.equal(normaliseBrandRisk("no visible branding whatsoever").value, "POSSIBLE");
  });
});
