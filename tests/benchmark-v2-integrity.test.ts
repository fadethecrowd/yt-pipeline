import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { samplePoints, SAMPLING_VERSION } from "../scripts/prepare-visual-benchmark";

/**
 * Integrity of the frame-backed benchmark manifest.
 *
 * Benchmark v1 referenced asset IDs invented from descriptions, so only 2 of
 * its 8 DIRECT positives corresponded to footage that exists and recall would
 * have been measured on n=2. These tests keep v1 honestly labelled and stop v2
 * from being used to certify anything before a human has approved its labels.
 */
const V1 = JSON.parse(readFileSync("tests/fixtures/visual-semantic-benchmark.v1.json", "utf8"));
const V2 = JSON.parse(readFileSync("tests/fixtures/visual-semantic-benchmark.v2.review.json", "utf8"));
const prepared = V2.cases.filter((c: any) => c.labelStatus === "PROVISIONAL_CLAUDE_REVIEW");

describe("v1 is honestly labelled as not frame-backed", () => {
  test("carries the synthetic-reference classification", () => {
    assert.equal(V1.assetReferenceKind, "SYNTHETIC_DESCRIPTION_REFERENCE");
    assert.equal(V1.frameBacked, false);
    assert.match(V1.reclassification, /cannot certify a vision judge/i);
  });
  test("its history is preserved, not rewritten", () => {
    assert.equal(V1.cases.length, 23);
    assert.equal(V1.version, 1);
  });
});

describe("v2 metric cases are backed by real assets and real frames", () => {
  test("every prepared case names a numeric Pexels id and page url", () => {
    for (const c of prepared) {
      assert.match(String(c.source.id), /^\d+$/, `${c.caseId} has a non-numeric id`);
      assert.match(c.source.pageUrl, /^https:\/\/www\.pexels\.com\//, c.caseId);
      assert.ok(c.source.durationS > 0, c.caseId);
    }
  });
  test("every prepared case has five hashed frames and a hashed sheet", () => {
    for (const c of prepared) {
      assert.equal(c.frames.length, 5, c.caseId);
      for (const f of c.frames) assert.match(f.sha256, /^[0-9a-f]{64}$/, c.caseId);
      assert.match(c.contactSheet.sha256, /^[0-9a-f]{64}$/, c.caseId);
      assert.match(c.mediaSha256, /^[0-9a-f]{64}$/, c.caseId);
    }
  });
  test("frame timestamps are inside the clip and strictly ordered", () => {
    for (const c of prepared) {
      const ts = c.frames.map((f: any) => f.timestampS);
      for (const t of ts) assert.ok(t >= 0 && t < c.source.durationS, `${c.caseId} t=${t}`);
      assert.deepEqual(ts, [...ts].sort((a: number, b: number) => a - b), c.caseId);
    }
  });
  test("sampling is deterministic and versioned", () => {
    assert.deepEqual(samplePoints(20), samplePoints(20));
    assert.equal(samplePoints(20).length, 5);
    for (const c of prepared) assert.equal(c.samplingVersion, SAMPLING_VERSION, c.caseId);
  });
});

describe("provisional labels cannot certify anything", () => {
  test("no case is marked independently approved", () => {
    for (const c of V2.cases) {
      assert.notEqual(c.labelStatus, "INDEPENDENTLY_APPROVED", `${c.caseId} was approved without review`);
    }
  });
  test("no case counts toward metrics yet", () => {
    for (const c of V2.cases) assert.equal(c.includeInMetrics, false, c.caseId);
  });
  test("the manifest says so in its status and warning", () => {
    assert.equal(V2.status, "AWAITING_INDEPENDENT_LABEL_REVIEW");
    assert.match(V2.warning, /PROVISIONAL/);
    assert.match(V2.warning, /none of it is verified ground truth/i);
  });
});

describe("balance and split", () => {
  test("meets the requested composition targets", () => {
    const direct = prepared.filter((c: any) => c.provisionalExpected.finalVerdict === "DIRECT");
    const neg = prepared.filter((c: any) => c.provisionalExpected.finalVerdict === "IRRELEVANT");
    assert.ok(direct.length >= 10, `only ${direct.length} DIRECT positives`);
    assert.ok(neg.length >= 10, `only ${neg.length} hard negatives`);
    assert.ok(prepared.filter((c: any) => c.role === "joint").length >= 4);
    const component = prepared.filter((c: any) =>
      ["subject-only", "setting-only", "action"].includes(c.role));
    assert.ok(component.length >= 4, `only ${component.length} component-only cases`);
    assert.ok(prepared.length >= 28 && prepared.length <= 40, `${prepared.length} cases`);
  });

  test("no source clip straddles the calibration/holdout split", () => {
    const bySource = new Map<string, Set<string>>();
    for (const c of prepared) {
      if (!bySource.has(c.source.id)) bySource.set(c.source.id, new Set());
      bySource.get(c.source.id)!.add(c.split);
    }
    for (const [id, splits] of bySource) {
      assert.equal(splits.size, 1, `pexels ${id} appears in both splits — leakage`);
    }
  });

  test("both splits are non-empty", () => {
    assert.ok(prepared.filter((c: any) => c.split === "calibration").length > 0);
    assert.ok(prepared.filter((c: any) => c.split === "holdout").length > 0);
  });
});

describe("no label leakage into anything a judge would see", () => {
  test("requirements carry no verdict or rationale hints", () => {
    for (const c of prepared) {
      const judgeVisible = JSON.stringify({
        requirement: c.requirement, narration: c.narration,
        visualPrompt: c.visualPrompt, compositionPolicy: c.compositionPolicy,
        jointRequired: c.jointRequired,
      });
      for (const leak of ["DIRECT", "IRRELEVANT", "AMBIGUOUS", "safetyCritical",
                          "positive control", "hard negative", "expected"]) {
        assert.ok(!judgeVisible.includes(leak),
          `${c.caseId} judge-visible payload leaks "${leak}"`);
      }
    }
  });
});
