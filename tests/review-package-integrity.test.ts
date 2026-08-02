import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

/**
 * A review package must not contradict itself.
 *
 * The data-centre package flagged eight brand-risk fragments in its manifest,
 * its CSV and its HTML — correctly. The prose summary that accompanied it said
 * "zero brand-risk fragments, zero marginal beats", because the summary was
 * written from an impression rather than re-read from the manifest after a
 * later repair step changed the allocation.
 *
 * That is the most dangerous class of error here: the artefact is right and the
 * summary talks the reviewer past it. Brand risk and marginal footage are
 * exactly what a human reviewer is being asked to look at, so a summary that
 * under-reports them removes the reason to look.
 *
 * These assertions are derived from the package itself, so they hold for any
 * package produced in future, not just this one.
 */

const PKG = "tmp/qual-dc-v2/review/qualification-review.json";
const CSV = "tmp/qual-dc-v2/review/DECISION-FORM.csv";
const HTML = "tmp/qual-dc-v2/review/index.html";
const present = existsSync(PKG);

/** Recompute every summary figure from the beats, the single source of truth. */
export function deriveSummary(pkg: any) {
  const frags = pkg.beats.flatMap((b: any) => b.fragments.map((f: any) => ({ beat: b.beat, ...f })));
  return {
    fragmentCount: frags.length,
    uniqueAssets: new Set(frags.map((f: any) => f.assetId)).size,
    brandRisk: frags.filter((f: any) => f.brandRisk === true)
      .map((f: any) => ({ beat: f.beat, assetId: f.assetId })),
    marginalBeats: pkg.beats.filter((b: any) => b.marginal).map((b: any) => b.beat),
    cardCount: pkg.beats.filter((b: any) => b.hasCard).length,
    aerialCount: frags.filter((f: any) => f.aerial).length,
  };
}

describe("summary figures match the beats they claim to summarise", { skip: !present }, () => {
  const pkg = present ? JSON.parse(readFileSync(PKG, "utf8")) : null;

  test("brand-risk count is never under-reported", () => {
    const d = deriveSummary(pkg);
    assert.equal(pkg.brandRiskFragments.length, d.brandRisk.length,
      "summary brand-risk count disagrees with the fragments");
    assert.ok(!(d.brandRisk.length > 0 && pkg.brandRiskFragments.length === 0),
      "a package reported zero brand risk while carrying flagged fragments");
    for (const f of d.brandRisk) {
      assert.ok(pkg.brandRiskFragments.some((x: any) => x.assetId === f.assetId),
        `flagged asset ${f.assetId} missing from the summary`);
    }
  });

  test("marginal beats are never under-reported", () => {
    const d = deriveSummary(pkg);
    assert.deepEqual([...pkg.marginalBeats].sort(), [...d.marginalBeats].sort());
  });

  test("fragment, unique-asset, card and aerial counts are consistent", () => {
    const d = deriveSummary(pkg);
    assert.equal(pkg.fragmentCount, d.fragmentCount);
    assert.equal(pkg.uniqueAssets, d.uniqueAssets);
    assert.equal(pkg.cardCount, d.cardCount);
    assert.equal(pkg.noSourceReuse, d.fragmentCount === d.uniqueAssets);
  });

  test("the CSV exposes every brand-risk fragment to the reviewer", () => {
    if (!existsSync(CSV)) return;
    const lines = readFileSync(CSV, "utf8").trim().split(/\r?\n/);
    const hdr = lines[0]!.split(",");
    const bi = hdr.indexOf("brandRisk"), ai = hdr.indexOf("assetId");
    const flaggedInCsv = lines.slice(1)
      .map((l) => l.split(","))
      .filter((c) => c[bi] === "true")
      .map((c) => c[ai]);
    for (const f of deriveSummary(pkg).brandRisk) {
      assert.ok(flaggedInCsv.includes(f.assetId),
        `asset ${f.assetId} is flagged in the manifest but not in the decision form`);
    }
  });

  test("the HTML names each brand-risk asset rather than summarising it away", () => {
    if (!existsSync(HTML)) return;
    const html = readFileSync(HTML, "utf8");
    const d = deriveSummary(pkg);
    if (d.brandRisk.length === 0) return;
    assert.ok(!/Brand-risk fragments<\/th><td>none/.test(html),
      "HTML claims no brand risk while fragments are flagged");
    for (const f of d.brandRisk) {
      assert.ok(html.includes(f.assetId), `HTML does not mention flagged asset ${f.assetId}`);
    }
  });
});

describe("the derivation itself is honest", () => {
  test("a package that hides brand risk fails the check", () => {
    const rigged = { beats: [{ beat: 1, marginal: false, hasCard: false,
      fragments: [{ assetId: "x", brandRisk: true, aerial: false }] }],
      brandRiskFragments: [], marginalBeats: [], fragmentCount: 1, uniqueAssets: 1,
      cardCount: 0, noSourceReuse: true };
    const d = deriveSummary(rigged);
    assert.equal(d.brandRisk.length, 1);
    assert.notEqual(rigged.brandRiskFragments.length, d.brandRisk.length,
      "the check must notice a zeroed brand-risk summary");
  });
});
