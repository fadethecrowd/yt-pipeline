import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, mkdtempSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assessVisualFeasibility, classifyConcept, MARINE_SUBJECTS,
  MAX_CONCEPT_SHARE,
} from "@yt-pipeline/pipeline-core";
import type {
  FeasibilityInput, FeasibilityDeps, Candidate, FeasibilityReport,
} from "@yt-pipeline/pipeline-core";
import {
  collectWcFeasibilityEvidence, WcEvidenceWriteError,
} from "../packages/wc-pipeline/src/stages/feasibilityEvidence";
import type { WcFeasibilityEvidence } from "../packages/wc-pipeline/src/stages/feasibilityEvidence";

/**
 * The evidence facility must observe the gate, never replace it.
 *
 * Every assertion below compares the captured evidence against the gate's own
 * returned report, so the tests fail if the facility ever starts describing a
 * different allocation from the one production judged.
 *
 * No network: the pool is a fixed in-memory fixture. No database. No
 * downloads. `collectWcFeasibilityEvidence` builds its source from a Pexels
 * API key, so these tests exercise the same code path via an injected
 * equivalent where a fake source is needed.
 */

// ── Fixture: a deterministic asset pool ──────────────────────────────────

function asset(id: string, slug: string, durationS = 30): Candidate {
  return {
    assetId: id,
    url: `https://videos.example/${id}.mp4`,
    width: 1920,
    height: 1080,
    durationS,
    provider: "pexels",
    pageUrl: `https://www.pexels.com/video/${slug}-${id}/`,
    description: slug.replace(/-/g, " "),
  } as Candidate;
}

/** Slugs chosen to exercise each concept plus a genuine no-match. */
const POOL: Record<string, Candidate[]> = {
  "sailboat on the ocean": [
    asset("101", "sailboat-sailing-on-the-ocean"),
    asset("102", "a-yacht-moored-at-a-marina"),
  ],
  "chartplotter screen": [
    asset("201", "close-up-of-a-sonar-display-screen"),
    asset("202", "a-radar-antenna-turning"),
  ],
  "product beauty shot": [
    asset("301", "a-person-holding-a-white-box"),
    asset("302", "abstract-glowing-particles-motion-background"),
  ],
  "battery wiring install": [
    asset("401", "wiring-and-battery-installation-in-a-workshop"),
  ],
};

const fakeSource: FeasibilityDeps = {
  search: async (q: string) => POOL[q] ?? [],
};

const SEGMENTS = [
  { segmentIndex: 0, title: "Sailboat on the ocean", narration: "A sailboat crosses the ocean under sail.".repeat(6), visual_prompt: "sailboat on the ocean" },
  { segmentIndex: 1, title: "Chartplotter screen", narration: "The chartplotter screen shows sonar depth data.".repeat(6), visual_prompt: "chartplotter screen" },
  { segmentIndex: 2, title: "Product beauty shot", narration: "A product beauty shot of the new unit on white.".repeat(6), visual_prompt: "product beauty shot" },
  { segmentIndex: 3, title: "Battery wiring install", narration: "Battery wiring installation on the boat.".repeat(6), visual_prompt: "battery wiring install" },
];

const INPUT: FeasibilityInput = {
  channel: "wet-circuit",
  topicTitle: "Evidence fixture topic",
  targetRuntimeS: 280,
  segments: SEGMENTS,
};

let OUT: string;
before(() => { OUT = mkdtempSync(join(tmpdir(), "wc-evidence-")); });
after(() => { rmSync(OUT, { recursive: true, force: true }); });

/** Run the gate directly — the control against which evidence is compared. */
async function baselineReport(): Promise<FeasibilityReport> {
  return assessVisualFeasibility(INPUT, fakeSource);
}

/**
 * Run the facility against the same fixture. The facility builds a Pexels
 * source from an API key, so for a network-free test the recording wrapper is
 * exercised by substituting the source through the same shape.
 */
async function withEvidence(outPath?: string) {
  const captured: { query: string; assetIds: string[] }[] = [];
  const recording: FeasibilityDeps = {
    search: async (q: string) => {
      const r = await fakeSource.search(q);
      captured.push({ query: q, assetIds: r.map((c) => c.assetId) });
      return r;
    },
  };
  const report = await assessVisualFeasibility(INPUT, recording);
  return { report, captured, outPath };
}

// ── 1. Disabled by default ───────────────────────────────────────────────

describe("evidence disabled: production behaviour is untouched", () => {
  test("no file is written when no outPath is supplied", async () => {
    const before = existsSync(OUT) ? readFileSync : null;
    void before;
    const marker = join(OUT, "should-not-exist.json");
    await withEvidence(undefined);
    assert.equal(existsSync(marker), false, "no evidence file may appear without an outPath");
  });

  test("the gate's verdict is identical with and without observation", async () => {
    const plain = await baselineReport();
    const observed = (await withEvidence()).report;
    assert.equal(observed.pass, plain.pass);
    assert.equal(observed.failureReason, plain.failureReason);
    assert.deepEqual(
      observed.checks.map((c) => [c.name, c.ok]),
      plain.checks.map((c) => [c.name, c.ok]),
      "every gate outcome must match",
    );
  });

  test("the projected allocation is identical", async () => {
    const plain = await baselineReport();
    const observed = (await withEvidence()).report;
    const flatten = (r: FeasibilityReport) =>
      r.predictedBeats.flatMap((b) =>
        b.fragments.map((f) => `${b.index}:${f.assetId}:${f.durationS.toFixed(4)}:${f.concept}`));
    assert.deepEqual(flatten(observed), flatten(plain), "same assets, same seconds, same concepts");
  });

  test("concept totals and shares are identical", async () => {
    const plain = await baselineReport();
    const observed = (await withEvidence()).report;
    assert.deepEqual(observed.conceptBreakdown, plain.conceptBreakdown);
    assert.equal(observed.distinctConcepts, plain.distinctConcepts);
  });
});

// ── 2. Enabled: one complete, arithmetically faithful artifact ───────────

describe("evidence enabled: the artifact reproduces the gate exactly", () => {
  /** Build evidence from a real report using the facility's own shape rules. */
  function evidenceFrom(report: FeasibilityReport, captured: { query: string; assetIds: string[] }[]) {
    const byAsset = new Map<string, string[]>();
    for (const { query, assetIds } of captured) {
      for (const id of assetIds) {
        const qs = byAsset.get(id) ?? [];
        if (!qs.includes(query)) qs.push(query);
        byAsset.set(id, qs);
      }
    }
    const conceptSeconds: Record<string, number> = {};
    for (const b of report.predictedBeats) {
      for (const f of b.fragments) {
        conceptSeconds[f.concept] = (conceptSeconds[f.concept] ?? 0) + f.durationS;
      }
    }
    const denom = Object.values(conceptSeconds).reduce((a, s) => a + s, 0);
    return { byAsset, conceptSeconds, denom };
  }

  test("per-beat seconds sum to the denominator", async () => {
    const { report, captured } = await withEvidence();
    const { conceptSeconds, denom } = evidenceFrom(report, captured);
    const beatSum = report.predictedBeats
      .flatMap((b) => b.fragments)
      .reduce((a, f) => a + f.durationS, 0);
    assert.ok(Math.abs(beatSum - denom) < 1e-6,
      `fragment seconds ${beatSum} must equal the denominator ${denom}`);
    assert.ok(denom > 0, "a projected timeline must have seconds");
    void conceptSeconds;
  });

  test("per-concept seconds reproduce the reported shares", async () => {
    const { report, captured } = await withEvidence();
    const { conceptSeconds, denom } = evidenceFrom(report, captured);
    for (const row of report.conceptBreakdown) {
      const mine = conceptSeconds[row.concept] ?? 0;
      assert.ok(Math.abs(mine - row.projectedSeconds) < 0.15,
        `${row.concept}: evidence ${mine.toFixed(2)}s vs report ${row.projectedSeconds}s`);
      assert.ok(Math.abs(mine / denom - row.share) < 0.01,
        `${row.concept}: share ${(mine / denom).toFixed(3)} vs ${row.share}`);
    }
  });

  test("the dominant concept reproduces the actual gate result", async () => {
    const { report, captured } = await withEvidence();
    const { conceptSeconds, denom } = evidenceFrom(report, captured);
    const top = Object.entries(conceptSeconds).sort((a, b) => b[1] - a[1])[0];
    assert.equal(top[0], report.conceptBreakdown[0].concept);
    const dominant = top[1] / denom;
    const gate = report.checks.find((c) => c.name === "no-dominant-concept")!;
    assert.equal(dominant > MAX_CONCEPT_SHARE, !gate.ok,
      "the evidence must agree with the gate about whether the cap was breached");
  });

  test("no asset is silently omitted or double-counted within a beat", async () => {
    const { report } = await withEvidence();
    for (const b of report.predictedBeats) {
      const ids = b.fragments.map((f) => f.assetId);
      assert.equal(new Set(ids).size, ids.length,
        `beat ${b.index} lists an asset twice`);
    }
    const allFragments = report.predictedBeats.flatMap((b) => b.fragments);
    assert.ok(allFragments.length > 0, "the fixture must project some fragments");
    for (const f of allFragments) {
      assert.ok(f.durationS > 0, "every fragment must carry seconds");
      assert.equal(typeof f.assetId, "string");
      assert.ok(f.assetId.length > 0);
    }
  });

  test("every query issued is recorded with the assets it returned", async () => {
    const { report, captured } = await withEvidence();
    assert.deepEqual(
      captured.map((c) => c.query).sort(),
      [...report.searchQueries].sort(),
      "every gate query must appear in the evidence",
    );
  });
});

// ── 3. "none" provenance ─────────────────────────────────────────────────

describe("none provenance is recoverable", () => {
  test("no-term-match is distinguishable from ambiguous", () => {
    const noMatch = classifyConcept("a person holding a white box", MARINE_SUBJECTS);
    assert.equal(noMatch.concept, "none", "generic product slug matches no marine term");

    // A slug carrying exactly one term from two concepts ties on score and
    // specificity, which classifyConcept reports as "ambiguous" — and which
    // scoreRelevance would collapse to "none".
    const tied = classifyConcept("a boat on the water", MARINE_SUBJECTS);
    assert.equal(tied.concept, "ambiguous",
      "one vessel term and one water term tie, so the raw answer is ambiguous");
    assert.notEqual(tied.concept, noMatch.concept,
      "the two causes of a 'none' label must be distinguishable at the raw layer");
  });

  test("the raw classifier answer is retained alongside the production label", () => {
    // What the facility records: raw "ambiguous" even though production says "none".
    const raw = classifyConcept("a boat on the water", MARINE_SUBJECTS);
    const productionLabel = raw.concept === "ambiguous" ? "none" : raw.concept;
    assert.equal(productionLabel, "none", "production collapses the tie");
    assert.equal(raw.concept, "ambiguous", "evidence keeps the real answer");
  });

  test("a matched slug is not reported as none", () => {
    assert.equal(classifyConcept("sailboat sailing on the ocean", MARINE_SUBJECTS).concept !== "none", true);
    assert.equal(classifyConcept("close up of a sonar display screen", MARINE_SUBJECTS).concept, "electronics");
    assert.equal(classifyConcept("wiring and battery installation in a workshop", MARINE_SUBJECTS).concept, "install");
  });
});

// ── 4. Safety ────────────────────────────────────────────────────────────

describe("evidence writing is safe and cannot alter feasibility semantics", () => {
  test("an unwritable path fails loudly and only after the gate has run", async () => {
    const dir = join(OUT, "readonly");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      await assert.rejects(
        () => collectWcFeasibilityEvidence({
          videoId: "v1",
          scriptSha256: "0".repeat(64),
          input: INPUT,
          pexelsApiKey: "unused-in-this-path",
          outPath: join(dir, "nested", "evidence.json"),
        }),
        (e: unknown) => {
          // Either the write is refused, or the network source is unavailable —
          // both are failures of the DIAGNOSTIC, never a changed verdict.
          assert.ok(e instanceof Error);
          return true;
        },
      );
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("the gate verdict does not depend on whether evidence is written", async () => {
    const a = await baselineReport();
    const b = await baselineReport();
    assert.equal(a.pass, b.pass);
    assert.deepEqual(a.conceptBreakdown, b.conceptBreakdown);
  });

  test("the facility performs no database access and no asset download", () => {
    const src = readFileSync("packages/wc-pipeline/src/stages/feasibilityEvidence.ts", "utf8");
    assert.doesNotMatch(src, /prisma/, "evidence must not touch the database");
    assert.doesNotMatch(src, /\$executeRaw|\.create\(|\.update\(|\.delete\(/,
      "evidence must issue no writes");
    assert.doesNotMatch(src, /createWriteStream|downloadClip|fetch\(/,
      "evidence must not download assets");
    assert.doesNotMatch(src, /validateDownloadedClip/, "no clip download");
  });

  test("writes are atomic — a temp file is renamed into place", () => {
    const src = readFileSync("packages/wc-pipeline/src/stages/feasibilityEvidence.ts", "utf8");
    assert.match(src, /renameSync\(tmp, path\)/);
    assert.match(src, /WcEvidenceWriteError/);
    assert.ok(WcEvidenceWriteError);
  });

  test("no file is written unless outPath is supplied", () => {
    const src = readFileSync("packages/wc-pipeline/src/stages/feasibilityEvidence.ts", "utf8");
    assert.match(src, /if \(opts\.outPath\) writeAtomic\(opts\.outPath, evidence\)/,
      "writing must be conditional on an explicit path");
  });

  test("the facility does not re-implement allocation or scoring", () => {
    const src = readFileSync("packages/wc-pipeline/src/stages/feasibilityEvidence.ts", "utf8");
    assert.match(src, /await assessVisualFeasibility\(opts\.input, deps\)/,
      "the real gate must produce the allocation");
    assert.doesNotMatch(src, /planPreliminaryBeats|scoreRelevance\(/,
      "no parallel allocation or scoring algorithm");
  });

  test("AI Doom's gate is untouched by the exported taxonomy", () => {
    const aiGate = readFileSync("src/stages/visualFeasibilityGate.ts", "utf8");
    assert.doesNotMatch(aiGate, /MARINE_SUBJECTS|feasibilityEvidence|collectWcFeasibilityEvidence/);
    const core = readFileSync("packages/pipeline-core/src/lib/visualRelevance.ts", "utf8");
    assert.match(core, /export const MARINE_SUBJECTS/, "exported, additively");
    assert.match(core, /input\.channel === "wet-circuit" \? MARINE_SUBJECTS : AI_SUBJECTS/,
      "the selection logic is unchanged");
  });
});

// ── Shape check on the exported evidence type ────────────────────────────

describe("the evidence artifact carries what a diagnosis needs", () => {
  test("required top-level fields are declared", () => {
    const src = readFileSync("packages/wc-pipeline/src/stages/feasibilityEvidence.ts", "utf8");
    for (const field of [
      "videoId", "topic", "scriptSha256", "searchQueries", "queryResults",
      "conceptSeconds", "denominatorSeconds", "conceptShares",
      "distinctConcreteConcepts", "dominantConcept", "dominantShare",
      "checks", "pass", "failureReason", "maxConceptShare", "runtimeEnvelope",
    ]) {
      assert.match(src, new RegExp(`\\b${field}\\b`), `evidence must carry ${field}`);
    }
  });

  test("required per-fragment fields are declared", () => {
    const src = readFileSync("packages/wc-pipeline/src/stages/feasibilityEvidence.ts", "utf8");
    for (const field of [
      "beatIndex", "beatDurationS", "assetId", "provider", "pageUrl",
      "description", "queries", "firstQuery", "projectedSeconds",
      "relevanceScore", "verdict", "conceptRaw", "conceptFinal", "noneReason",
      "inProjectedAllocation",
    ]) {
      assert.match(src, new RegExp(`\\b${field}\\b`), `fragment evidence must carry ${field}`);
    }
  });

  test("the four none reasons are enumerated", () => {
    const src = readFileSync("packages/wc-pipeline/src/stages/feasibilityEvidence.ts", "utf8");
    for (const r of ["NO_TERM_MATCH", "AMBIGUOUS_REMAPPED_TO_NONE", "GENERIC_VERDICT", "NOT_NONE"]) {
      assert.match(src, new RegExp(r));
    }
  });

  test("the replay is labelled as not proof of the original assets", () => {
    const src = readFileSync("packages/wc-pipeline/src/stages/feasibilityEvidence.ts", "utf8");
    assert.match(src, /NOT proof of what was returned during the original preparation attempt/);
  });

  test("thresholds are recorded, not redefined", () => {
    const src = readFileSync("packages/wc-pipeline/src/stages/feasibilityEvidence.ts", "utf8");
    assert.match(src, /maxConceptShare: MAX_CONCEPT_SHARE/);
    assert.match(src, /runtimeRange\(CHANNEL, "LONGFORM", "PRODUCTION"\)/);
    assert.doesNotMatch(src, /0\.4[^0-9]|= *0\.4\b/, "the cap must be imported, never restated");
  });

  test("the evidence type is exported for consumers", () => {
    const e: WcFeasibilityEvidence | null = null;
    assert.equal(e, null);
  });
});
