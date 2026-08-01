/**
 * Run a candidate visual-semantic judge against the versioned benchmark.
 *
 *   npx tsx scripts/run-semantic-benchmark.ts [approach]
 *
 * Approaches: "lexical" (the existing FAMILIES taxonomy). Others are added as
 * they become available. Read-only: no budget, no ElevenLabs, no YouTube.
 *
 * Labels come from tests/fixtures/visual-semantic-benchmark.v1.json and are
 * never produced by the judge under evaluation.
 */
import { readFileSync } from "node:fs";
import { deriveRequirement, scoreSemantic, composeBeat } from "@yt-pipeline/pipeline-core";
import type { BeatRequirement } from "@yt-pipeline/pipeline-core";

const BENCH = JSON.parse(readFileSync("tests/fixtures/visual-semantic-benchmark.v1.json", "utf8"));

function reqFor(c: any): BeatRequirement {
  return deriveRequirement({
    beatIndex: 1, segmentIndex: 0,
    narration: c.narration, visualPrompt: c.visualPrompt,
  });
}

function lexicalVerdict(c: any): string {
  const req = reqFor(c);
  if (c.candidateSet) {
    const r = composeBeat(req, c.compositionPolicy, 18,
      c.candidateSet.map((x: any) => ({ ...x, brandRisk: false })),
      { beatMaxS: 30, minFragmentS: 1 });
    return r.covered ? "DIRECT" : "IRRELEVANT";
  }
  return scoreSemantic(req, c.candidate.description).verdict;
}

function main() {
  const approach = process.argv[2] ?? "lexical";
  const judge = lexicalVerdict;
  const scored = BENCH.cases.filter((c: any) => c.includeInMetrics);

  let tp = 0, fp = 0, fn = 0, tn = 0;
  const safetyFailures: string[] = [];
  const falsePositives: string[] = [];
  const falseNegatives: string[] = [];

  const t0 = Date.now();
  for (const c of scored) {
    const expected = c.expected.finalVerdict;
    const got = judge(c);
    const expDirect = expected === "DIRECT";
    const gotDirect = got === "DIRECT";
    if (expDirect && gotDirect) tp++;
    else if (!expDirect && gotDirect) {
      fp++; falsePositives.push(`${c.id}: expected ${expected}, got DIRECT`);
      if (c.safetyCritical) safetyFailures.push(c.id);
    } else if (expDirect && !gotDirect) { fn++; falseNegatives.push(`${c.id}: expected DIRECT, got ${got}`); }
    else tn++;
  }
  const ms = Date.now() - t0;

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);

  console.log(`\n═══ BENCHMARK v${BENCH.version} — approach: ${approach} ═══\n`);
  console.log(`  cases scored        : ${scored.length} (of ${BENCH.cases.length}; ${BENCH.cases.length - scored.length} ambiguous excluded)`);
  console.log(`  confusion matrix    : TP=${tp} FP=${fp} FN=${fn} TN=${tn}`);
  console.log(`  DIRECT precision    : ${(precision * 100).toFixed(1)}%  (require >= 95%)`);
  console.log(`  DIRECT recall       : ${(recall * 100).toFixed(1)}%  (require >= 90%)`);
  console.log(`  safety-critical fails: ${safetyFailures.length}  (require 0)`);
  console.log(`  runtime             : ${ms}ms for ${scored.length} cases`);
  console.log(`  model download      : 0 MB (pure lexical)`);
  console.log(`  monetary cost       : $0.00`);
  console.log(`  uses actual frames  : NO — metadata only`);

  if (falsePositives.length) { console.log("\n  FALSE POSITIVES:"); for (const f of falsePositives) console.log(`    ✗ ${f}`); }
  if (falseNegatives.length) { console.log("\n  FALSE NEGATIVES:"); for (const f of falseNegatives) console.log(`    ✗ ${f}`); }
  if (safetyFailures.length) { console.log("\n  SAFETY-CRITICAL FAILURES:"); for (const f of safetyFailures) console.log(`    ✗✗ ${f}`); }

  const qualifies = safetyFailures.length === 0 && precision >= 0.95 && recall >= 0.90;
  console.log(`\n  QUALIFIES AS PRIMARY JUDGE: ${qualifies ? "YES" : "NO"}`);
  if (!qualifies) {
    console.log("  reason: " + [
      safetyFailures.length ? `${safetyFailures.length} safety-critical failure(s)` : null,
      precision < 0.95 ? `precision ${(precision * 100).toFixed(1)}% < 95%` : null,
      recall < 0.90 ? `recall ${(recall * 100).toFixed(1)}% < 90%` : null,
      "does not evaluate actual frames",
    ].filter(Boolean).join("; "));
  }
}
main();
