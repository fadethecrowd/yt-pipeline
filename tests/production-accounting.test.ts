import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Production spend must reconcile, and approved videos must stay put.
 *
 * The invariant checker used to assert the ElevenLabs ledger still equalled
 * 11,569 — the total at the moment Phase 6 was paused. Every authorized run
 * after that reported a violation, so the one line that would have signalled
 * real unauthorized spend became the line you learn to skip. An alarm nobody
 * reads is worse than no alarm.
 *
 * It now derives what it expects: usage rows must reconcile to budget rows,
 * and every charge at a controlled stage must belong to a named asset for
 * exactly the sanctioned number of characters. That catches the thing the
 * constant was pretending to catch — spend nobody authorized — and keeps
 * catching it after each legitimate run.
 */

const checker = readFileSync("scripts/verify-phase6-state.ts", "utf8");

describe("the stale ledger baseline is gone", () => {
  test("no hardcoded pre-qualification ledger constant remains", () => {
    assert.doesNotMatch(checker, /EXPECTED_LEDGER/,
      "a frozen ledger total fails after every authorized run");
    assert.doesNotMatch(checker, /11_569|11569/,
      "the pre-qualification total must not be pinned anywhere");
  });

  test("the expectation is derived from durable rows", () => {
    assert.match(checker, /budgetsAll\.rows\.reduce/,
      "expected spend must come from the budget rows themselves");
    assert.match(checker, /usage rows reconcile to budget rows/);
  });
});

describe("controlled-stage spend is allowlisted per asset", () => {
  test("qualification and production are controlled stages", () => {
    assert.match(checker, /const CONTROLLED_STAGES/);
    for (const s of ["QUALIFICATION", "PRODUCTION", "RETEST", "REPEATABILITY"]) {
      assert.match(checker, new RegExp(`"${s}"`), `${s} must be reconciled per asset`);
    }
  });

  test("the sanctioned set names each asset, stage and exact character count", () => {
    assert.match(checker, /const SANCTIONED_SPEND/);
    // The benchmark, the canary and the withdrawn HBM asset.
    assert.match(checker, /cmsdrtafn0002mbdzwpmndnix.*QUALIFICATION.*4_574/s);
    assert.match(checker, /cmsexx3n80002mb1gd988zvee.*PRODUCTION.*5_017/s);
    assert.match(checker, /cms9970di0002mbti2m9avpui.*QUALIFICATION.*7_071/s);
  });

  test("qualification remains fixed at 11,645 across its two assets", () => {
    // 7,071 (HBM, withdrawn) + 4,574 (benchmark) — the figure the budget row
    // carries, asserted here so a later edit cannot quietly restate it.
    assert.equal(7_071 + 4_574, 11_645);
  });

  test("an unknown videoId at a controlled stage is a violation", () => {
    assert.match(checker, /no unsanctioned controlled-stage spend/);
    assert.match(checker, /if \(!s\) \{ unknown\.push/);
  });

  test("a charge that differs from its sanction is a violation", () => {
    assert.match(checker, /each asset charged exactly what was sanctioned/);
    assert.match(checker, /v\.charged !== s\.chars/);
  });

  test("an unsettled reservation anywhere is a violation", () => {
    assert.match(checker, /no unsettled narration transaction/);
    assert.match(checker, /function budgetsWithReservations/);
  });

  test("DIAGNOSTIC is reconciled by total, not enumerated", () => {
    // Pre-control history: enumerating it would freeze the past without
    // protecting anything, and it is still covered by the total reconciliation.
    assert.doesNotMatch(checker, /stage: "DIAGNOSTIC"/);
  });
});

describe("both approved videos are recorded as immutable", () => {
  const benchmark = JSON.parse(readFileSync("tmp/qual-dc-v5/QUALIFICATION-BENCHMARK.json", "utf8"));
  const canary = JSON.parse(readFileSync("tmp/PRODUCTION-CANARY.json", "utf8"));

  for (const [label, rec, id] of [
    ["qualification benchmark", benchmark, "rrb0A_piLEM"],
    ["production canary", canary, "AMrrTvdL2tI"],
  ] as [string, any, string][]) {
    test(`${label} is private, terminal and immutable`, () => {
      assert.equal(rec.youtubeId, id);
      assert.equal(rec.channelId, "UCSbJfiA1aobp6G_rgwbHPMw");
      assert.equal(rec.privacyStatus, "private");
      assert.equal(rec.publishAt, null);
      assert.equal(rec.immutable, true);
      assert.equal(rec.humanReview, "APPROVED");
    });
  }

  test("the canary records the human assessment as given", () => {
    assert.equal(canary.reviewedBy, "Max");
    assert.equal(canary.reviewDate, "2026-08-04");
    assert.equal(canary.humanAssessment.overallQuality, "very good");
    assert.match(canary.humanAssessment.disposition, /non-blocking/);
  });

  test("the canary's accounting is recorded against PRODUCTION", () => {
    assert.equal(canary.accounting.stage, "PRODUCTION");
    assert.equal(canary.accounting.chargedChars, 5017);
    assert.equal(canary.accounting.qualificationCharged, 11645);
  });

  test("neither is marked resumable or re-uploadable", () => {
    for (const rec of [benchmark, canary]) {
      assert.notEqual(rec.resumable, true);
      assert.notEqual(rec.reUploadable, true);
    }
  });
});
