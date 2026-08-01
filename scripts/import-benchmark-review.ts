/**
 * Import the frozen independent label review into an approved benchmark.
 *
 *   npx tsx scripts/import-benchmark-review.ts
 *
 * Reads tmp/bench2/review/REVIEW-FORM.completed.csv and emits
 * tests/fixtures/visual-semantic-benchmark.v2.approved.json. The provisional
 * manifest is left untouched: it is the record of what was proposed, and the
 * approved file is the record of what a human actually accepted.
 *
 * Only cases the reviewer approved or corrected become eligible for metrics.
 * Anything marked AMBIGUOUS or REJECT is carried through with its reason and
 * excluded, so it can never quietly re-enter a precision or recall figure.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CSV = "tmp/bench2/review/REVIEW-FORM.completed.csv";
const PROVISIONAL = "tests/fixtures/visual-semantic-benchmark.v2.review.json";
const APPROVED = "tests/fixtures/visual-semantic-benchmark.v2.approved.json";

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  const split = (l: string) => {
    const out: string[] = []; let cur = "", q = false;
    for (const ch of l) {
      if (ch === '"') { q = !q; continue; }
      if (ch === "," && !q) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur); return out;
  };
  const hdr = split(lines[0]!);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [hdr[i]!, v.trim()])));
}

function main() {
  const rows = parseCsv(readFileSync(CSV, "utf8"));
  const prov = JSON.parse(readFileSync(PROVISIONAL, "utf8"));
  const csvSha = sha(readFileSync(CSV, "utf8"));
  const decisionKey = Object.keys(rows[0]!).find((k) => k.startsWith("decision"))!;

  const byId = new Map(rows.map((r) => [r.caseId!, r]));
  let approved = 0, changed = 0, excluded = 0;

  const cases = prov.cases.map((c: any) => {
    const r = byId.get(c.caseId);
    if (!r) throw new Error(`case ${c.caseId} has no review row — refusing to guess`);
    const decision = (r[decisionKey] ?? "").toUpperCase();
    const corrected = (r.correctedVerdict ?? "").toUpperCase();
    const base = {
      ...c,
      review: { decision, correctedVerdict: corrected || null, note: r.note || null,
                reviewedIn: CSV, reviewSha256: csvSha },
    };

    if (decision === "APPROVE") {
      approved++;
      return { ...base, labelStatus: "INDEPENDENTLY_APPROVED", includeInMetrics: true,
               expected: { finalVerdict: c.provisionalExpected.finalVerdict } };
    }
    if (decision === "CHANGE") {
      if (!corrected) throw new Error(`${c.caseId} marked CHANGE with no correctedVerdict`);
      changed++;
      return { ...base, labelStatus: "INDEPENDENTLY_APPROVED", includeInMetrics: true,
               expected: { finalVerdict: corrected } };
    }
    excluded++;
    return { ...base, labelStatus: decision === "REJECT" ? "REJECTED" : "AMBIGUOUS",
             includeInMetrics: false, expected: { finalVerdict: corrected || "AMBIGUOUS" } };
  });

  // Split integrity: a clip reused across cases must not straddle the split.
  const bySource = new Map<string, Set<string>>();
  for (const c of cases) {
    if (!c.source) continue;
    if (!bySource.has(c.source.id)) bySource.set(c.source.id, new Set());
    bySource.get(c.source.id)!.add(c.split);
  }
  const leaks = [...bySource.entries()].filter(([, s]) => s.size > 1).map(([id]) => id);
  if (leaks.length) throw new Error(`split leakage on pexels id(s): ${leaks.join(", ")}`);

  const metric = cases.filter((c: any) => c.includeInMetrics);
  const out = {
    version: 2, kind: "approved",
    derivedFrom: { provisional: PROVISIONAL, review: CSV, reviewSha256: csvSha },
    status: "INDEPENDENT_REVIEW_FROZEN",
    note: "Labels here were set by an independent reviewer, not by Claude Code. The provisional manifest is preserved unchanged as the record of what was proposed. Cases excluded from metrics can never re-enter precision or recall.",
    samplingVersion: prov.samplingVersion,
    contactSheet: prov.contactSheet,
    splitSeed: prov.splitSeed, splitMethod: prov.splitMethod,
    counts: {
      total: cases.length, approvedAsProposed: approved, corrected: changed, excluded,
      metricCases: metric.length,
      direct: metric.filter((c: any) => c.expected.finalVerdict === "DIRECT").length,
      related: metric.filter((c: any) => c.expected.finalVerdict === "RELATED").length,
      irrelevant: metric.filter((c: any) => c.expected.finalVerdict === "IRRELEVANT").length,
      safetyCritical: metric.filter((c: any) => c.safetyCritical).length,
      calibration: metric.filter((c: any) => c.split === "calibration").length,
      holdout: metric.filter((c: any) => c.split === "holdout").length,
    },
    cases,
  };
  writeFileSync(APPROVED, JSON.stringify(out, null, 2));
  writeFileSync(APPROVED + ".sha256", sha(readFileSync(APPROVED, "utf8")));

  console.log(`review sha256      : ${csvSha}`);
  console.log(`approved as proposed: ${approved}  corrected: ${changed}  excluded: ${excluded}`);
  console.log(`metric cases        : ${metric.length}`);
  console.log(`  DIRECT ${out.counts.direct} | RELATED ${out.counts.related} | IRRELEVANT ${out.counts.irrelevant}`);
  console.log(`  safety-critical ${out.counts.safetyCritical} | calibration ${out.counts.calibration} | holdout ${out.counts.holdout}`);
  console.log(`split leakage       : none`);
  console.log(`excluded cases      : ${cases.filter((c: any) => !c.includeInMetrics).map((c: any) => `${c.caseId}(${c.labelStatus})`).join(", ")}`);
  console.log(`approved sha256     : ${sha(readFileSync(APPROVED, "utf8"))}`);
}
main();
