/**
 * Integration tests against the real database and YouTube API.
 *
 * Read-only or additive-only: nothing here publishes, uploads, renders, or
 * calls ElevenLabs. The budget test reserves and immediately releases.
 *
 * Requires DATABASE_URL. The wrong-channel test additionally requires YouTube
 * credentials and is skipped when they are absent.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import "dotenv/config";

import { prisma, disconnect } from "../packages/pipeline-core/src/lib/db";
import { reserveCredits, settleCredits, budgetReport, BudgetExceededError, setBudgetLimit } from "../packages/pipeline-core/src/lib/budget";
import { quarantinedVideoIds, resumableJobs } from "../packages/pipeline-core/src/lib/quarantine";
import { verifyChannel, CHANNELS } from "../packages/pipeline-core/src/youtubeAuth";
import { breakerStatus } from "../packages/pipeline-core/src/lib/circuitBreaker";

const QUARANTINED = ["cmn6fm5du0001oe0e5wsaiboi", "cmnc34ck1000hr20e3gduhwpv"];
const hasYouTube = Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_REFRESH_TOKEN);

/**
 * Budget mechanics are exercised against a channel that does not exist, never
 * against a real one. These tests previously raised ai-doom-scroll/RETEST to
 * 1,000 and left it there, so merely running the suite reopened a generation
 * budget on a production channel.
 */
const SCRATCH = "__budget-test__";

after(async () => {
  await prisma.creditBudget.deleteMany({ where: { channel: SCRATCH } });
  await disconnect();
});

describe("credit budget — production stays locked at zero", () => {
  test("PRODUCTION budget limit is zero on both channels", async () => {
    const rep = await budgetReport();
    for (const ch of ["ai-doom-scroll", "wet-circuit"]) {
      const row = rep.rows.find((r) => r.channel === ch && r.stage === "PRODUCTION");
      if (row) {
        // The limit is the invariant. While it is zero nothing can spend at
        // PRODUCTION without a caller explicitly opening a window and closing
        // it again, which is what the next test proves.
        //
        // `charged` is deliberately NOT asserted to be zero. It was, until the
        // authorized production canary spent 5,017 characters here — that is
        // history, not a guarantee, and pinning it would mean this suite fails
        // permanently after any sanctioned production run. Spend that already
        // happened cannot be prevented by a test; spend that has not yet
        // happened is prevented by the limit.
        assert.equal(row.limit, 0, `${ch} PRODUCTION limit must be 0, got ${row.limit}`);
        assert.equal(row.reserved, 0, `${ch} PRODUCTION must hold no open reservation`);
      }
    }
  });

  test("reserving against PRODUCTION is refused", async () => {
    await assert.rejects(
      () => reserveCredits("ai-doom-scroll", "PRODUCTION", 1),
      (e: unknown) => e instanceof BudgetExceededError,
      "production generation must be blocked while the budget is zero",
    );
  });

  test("a reservation beyond a stage limit is refused", async () => {
    await setBudgetLimit(SCRATCH, "RETEST", 100);
    await assert.rejects(
      () => reserveCredits(SCRATCH, "RETEST", 1_000_000),
      (e: unknown) => e instanceof BudgetExceededError,
    );
  });

  test("reserve then settle leaves the ledger balanced", async () => {
    await setBudgetLimit(SCRATCH, "RETEST", 1000);
    const before = await budgetReport();
    const b0 = before.rows.find((r) => r.channel === SCRATCH && r.stage === "RETEST")!;
    await reserveCredits(SCRATCH, "RETEST", 50);
    await settleCredits(SCRATCH, "RETEST", 50, 0); // released, nothing charged
    const after = await budgetReport();
    const b1 = after.rows.find((r) => r.channel === SCRATCH && r.stage === "RETEST")!;
    assert.equal(b1.reserved, b0.reserved, "reservation must be released");
    assert.equal(b1.charged, b0.charged, "nothing should have been charged");
  });

  test("no real channel budget has spendable headroom", async () => {
    // The two tests above used to raise ai-doom-scroll/RETEST to 1,000 and
    // leave it there, so running the suite silently reopened a generation
    // budget on a production channel. They now use SCRATCH; this asserts the
    // real ones stayed shut.
    const rep = await budgetReport();
    const open = rep.rows.filter(
      (r) => r.channel !== SCRATCH && r.remaining > 0,
    );
    assert.deepEqual(
      open.map((r) => `${r.channel}/${r.stage}=${r.remaining}`), [],
      "running the test suite must never open a real channel's budget",
    );
  });

  test("global target is 297,000", async () => {
    const rep = await budgetReport();
    assert.equal(rep.globalTarget, 297_000);
  });
});

describe("stale-job quarantine — live state", () => {
  test("both March rows are quarantined", async () => {
    const ids = await quarantinedVideoIds();
    for (const id of QUARANTINED) {
      assert.ok(ids.includes(id), `${id} must be quarantined`);
    }
  });

  test("quarantine records preserve the original status", async () => {
    for (const id of QUARANTINED) {
      const rec = await prisma.jobQuarantine.findFirst({ where: { videoId: id, releasedAt: null } });
      assert.ok(rec, `${id} must have an active quarantine record`);
      assert.equal(rec!.originalStatus, "ASSEMBLY_PENDING");
      assert.equal(rec!.newStatus, "FAILED");
      assert.ok(rec!.reason.length > 0);
      assert.ok(rec!.operator.length > 0);
      assert.ok(rec!.actionSource.length > 0);
    }
  });

  test("their artifacts are untouched", async () => {
    for (const id of QUARANTINED) {
      const row = await prisma.video.findUnique({ where: { id } });
      assert.ok(row, `${id} must still exist — quarantine never deletes`);
      assert.ok(row!.scriptJson, "script must be preserved");
    }
  });

  test("neither channel has any auto-resumable job", async () => {
    for (const ch of ["ai-doom-scroll", "wet-circuit"] as const) {
      const jobs = await resumableJobs(ch);
      assert.equal(jobs.length, 0,
        `${ch} would auto-resume ${jobs.map((j) => `${j.id}(${j.status})`).join(", ")}`);
    }
  });
});

describe("diagnostic renders — reusable without new ElevenLabs calls", () => {
  test("both diagnostics have recorded generations and on-disk audio", async () => {
    const qa = await prisma.qaRecord.findMany({
      where: { testStage: "DIAGNOSTIC", overall: "PASS" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(qa.length >= 2, `expected 2 passing diagnostics, found ${qa.length}`);

    for (const ch of ["ai-doom-scroll", "wet-circuit"]) {
      const rec = qa.find((q) => q.channel === ch);
      assert.ok(rec, `no passing diagnostic QA record for ${ch}`);

      const usage = await prisma.elevenLabsUsage.findMany({
        where: { videoId: rec!.videoId, success: true },
      });
      assert.ok(usage.length > 0, `${ch} has no usage rows`);

      // Every generation must still be reusable: audio + alignment on disk.
      const originals = usage.filter((u) => !u.reused);
      for (const u of originals) {
        assert.ok(u.outputPath && existsSync(u.outputPath),
          `${ch} segment ${u.segmentIndex} audio missing at ${u.outputPath}`);
        const alignment = u.outputPath!.replace(/\.mp3$/, ".alignment.json");
        assert.ok(existsSync(alignment),
          `${ch} segment ${u.segmentIndex} alignment missing at ${alignment}`);
        assert.ok(u.generationId, "generation id must be recorded for reuse");
      }
    }
  });

  test("a reuse costs zero credits", async () => {
    const reused = await prisma.elevenLabsUsage.findMany({ where: { reused: true } });
    assert.ok(reused.length > 0, "expected at least one recorded reuse");
    for (const r of reused) {
      assert.equal(r.chargedChars, 0, "a reused generation must charge nothing");
    }
  });

  test("the rendered files referenced by the QA records exist", async () => {
    const qa = await prisma.qaRecord.findMany({
      where: { testStage: "DIAGNOSTIC", overall: "PASS" },
    });
    for (const rec of qa) {
      const v = rec.channel === "wet-circuit"
        ? await prisma.wcVideo.findUnique({ where: { id: rec.videoId } })
        : await prisma.video.findUnique({ where: { id: rec.videoId } });
      assert.ok(v?.videoPath && existsSync(v.videoPath),
        `render for ${rec.channel} missing at ${v?.videoPath}`);
    }
  });
});

describe("circuit breaker", () => {
  test("no breaker is tripped", async () => {
    const rows = await breakerStatus();
    const tripped = rows.filter((r) => r.tripped);
    assert.deepEqual(tripped.map((t) => t.channel), [],
      `tripped breakers: ${tripped.map((t) => `${t.channel}=${t.trigger}`).join(", ")}`);
  });
});

/**
 * Which channel the configured credentials actually authenticate as.
 *
 * Presence of YOUTUBE_* is not enough — the repository's local .env token is
 * revoked, so it is present but unusable. Probing tells the difference between
 * "no working credentials, skip honestly" and "credentials work, assert hard".
 * Run with a service's Railway credentials to exercise this suite:
 *   npm run test:youtube
 */
async function authenticatedChannel(): Promise<"ai-doom-scroll" | "wet-circuit" | null> {
  if (!hasYouTube) return null;
  for (const key of ["ai-doom-scroll", "wet-circuit"] as const) {
    try {
      await verifyChannel(CHANNELS[key], "test-probe");
      return key;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A mismatch proves the token works but belongs to the other channel.
      if (/channel ID mismatch/i.test(msg)) continue;
      // invalid_grant / network / revoked — no usable credentials at all.
      return null;
    }
  }
  return null;
}

let authed: "ai-doom-scroll" | "wet-circuit" | null = null;
before(async () => { authed = await authenticatedChannel(); });

describe("wrong-channel upload rejection", () => {
  test("verification against the WRONG channel fails closed", async (t) => {
    if (!authed) return t.skip("no usable YouTube credentials (token absent or revoked)");
    const wrong = authed === "ai-doom-scroll" ? "wet-circuit" : "ai-doom-scroll";
    await assert.rejects(
      () => verifyChannel(CHANNELS[wrong], "test"),
      /channel ID mismatch|no channel returned/i,
      `credentials authenticate as ${authed}; verifying as ${wrong} must throw`,
    );
  });

  test("verification against the MATCHING channel succeeds", async (t) => {
    if (!authed) return t.skip("no usable YouTube credentials (token absent or revoked)");
    await verifyChannel(CHANNELS[authed], "test");
  });

  test("credentials authenticate as exactly one channel", async (t) => {
    if (!authed) return t.skip("no usable YouTube credentials (token absent or revoked)");
    const results = await Promise.allSettled([
      verifyChannel(CHANNELS["ai-doom-scroll"], "test"),
      verifyChannel(CHANNELS["wet-circuit"], "test"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  });
});
