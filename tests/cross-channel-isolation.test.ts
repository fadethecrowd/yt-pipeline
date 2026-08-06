import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  prisma, disconnect,
  reserveCredits, settleCredits, setBudgetLimit, withBudgetWindow,
  currentBudgetLimit, budgetReport, BudgetExceededError,
} from "@yt-pipeline/pipeline-core";
import "dotenv/config";

/**
 * Wet Circuit and AI Doom Scroll cannot consume each other's allowance.
 *
 * The boundary is the CreditBudget row, unique on (channel, testStage): every
 * reservation and settlement names both, so a Wet Circuit canary at PRODUCTION
 * writes to a different durable row from anything AI Doom has ever spent. These
 * tests exercise the real primitives against the real database rather than
 * asserting on source text, because the guarantee is a property of the atomic
 * conditional UPDATE, not of how the call site is written.
 *
 * Two synthetic channels are used so no real budget is touched, and both rows
 * are deleted afterwards. Nothing here spends an ElevenLabs credit: the
 * reservation path is exercised, and settlement is called with an explicit
 * actual charge, without any HTTP call.
 */

const A = "__wc-isolation-a__";
const B = "__wc-isolation-b__";
const STAGE = "PRODUCTION" as const;

/**
 * The live-database describes are opt-in.
 *
 * They necessarily hold open budget headroom for the duration of a
 * reservation, and tests/integration.test.ts asserts that no channel outside
 * its own scratch name has spendable headroom. Node runs test FILES
 * concurrently, so leaving these on by default makes that assertion fail for a
 * reason that has nothing to do with a real channel's budget — the opposite of
 * what it exists to catch. Run them explicitly:
 *
 *   WC_DB_TESTS=1 npx tsx --test tests/cross-channel-isolation.test.ts
 *
 * The structural describes at the bottom always run.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const liveEnabled = process.env.WC_DB_TESTS === "1";
const skip = !liveEnabled
  ? "live DB isolation tests are opt-in — set WC_DB_TESTS=1"
  : hasDb ? false : "DATABASE_URL not configured";

async function wipe() {
  await prisma.creditBudget.deleteMany({ where: { channel: { in: [A, B] } } });
}

async function row(channel: string) {
  return prisma.creditBudget.findUnique({
    where: { channel_testStage: { channel, testStage: STAGE } },
  });
}

describe("cross-channel budget isolation (live primitives)", { skip }, () => {
  before(async () => { await wipe(); });
  after(async () => {
    await wipe();
    const left = await prisma.creditBudget.count({ where: { channel: { in: [A, B] } } });
    assert.equal(left, 0, "synthetic budget rows must not survive the test run");
    await disconnect();
  });

  test("a reservation against one channel leaves the other untouched", async () => {
    await setBudgetLimit(A, STAGE, 1_000);
    await setBudgetLimit(B, STAGE, 1_000);

    await reserveCredits(A, STAGE, 400);

    const a = await row(A);
    const b = await row(B);
    assert.equal(a?.reservedChars, 400, "the reserving channel holds the reservation");
    assert.equal(b?.reservedChars, 0, "the other channel must be untouched");
    assert.equal(b?.chargedChars, 0);

    await settleCredits(A, STAGE, 400, 0);
    assert.equal((await row(A))?.reservedChars, 0, "settling releases the reservation");
  });

  test("exhausting one channel's allowance does not block the other", async () => {
    await wipe();
    await setBudgetLimit(A, STAGE, 500);
    await setBudgetLimit(B, STAGE, 500);

    await reserveCredits(A, STAGE, 500);
    await assert.rejects(
      () => reserveCredits(A, STAGE, 1),
      (e: unknown) => {
        assert.ok(e instanceof BudgetExceededError);
        assert.equal(e.channel, A);
        return true;
      },
      "the exhausted channel must refuse",
    );

    // The other channel is unaffected.
    await assert.doesNotReject(() => reserveCredits(B, STAGE, 500),
      "an unrelated channel must keep its full allowance");

    await settleCredits(A, STAGE, 500, 0);
    await settleCredits(B, STAGE, 500, 0);
  });

  test("a charge lands on the named channel and stage only", async () => {
    await wipe();
    await setBudgetLimit(A, STAGE, 1_000);
    await setBudgetLimit(B, STAGE, 1_000);

    await reserveCredits(A, STAGE, 300);
    await settleCredits(A, STAGE, 300, 275); // real cost differs from the estimate

    const a = await row(A);
    const b = await row(B);
    assert.equal(a?.chargedChars, 275, "the actual cost is recorded, not the estimate");
    assert.equal(a?.reservedChars, 0);
    assert.equal(b?.chargedChars, 0, "the other channel is never charged");
  });

  test("a zero-limit channel refuses every reservation", async () => {
    await wipe();
    await setBudgetLimit(A, STAGE, 0);
    await assert.rejects(() => reserveCredits(A, STAGE, 1), BudgetExceededError,
      "a locked budget must refuse even one character");
    assert.equal((await row(A))?.reservedChars, 0, "a refused reservation reserves nothing");
  });

  test("stages within one channel are separate allowances", async () => {
    await wipe();
    await setBudgetLimit(A, "PRODUCTION", 100);
    await setBudgetLimit(A, "QUALIFICATION", 0);

    await assert.doesNotReject(() => reserveCredits(A, "PRODUCTION", 100));
    await assert.rejects(() => reserveCredits(A, "QUALIFICATION", 1), BudgetExceededError,
      "PRODUCTION headroom must not unlock QUALIFICATION");

    await settleCredits(A, "PRODUCTION", 100, 0);
    await prisma.creditBudget.deleteMany({ where: { channel: A } });
  });
});

describe("the per-candidate budget window", { skip }, () => {
  before(async () => { await wipe(); });
  after(async () => { await wipe(); await disconnect(); });

  test("opens exactly the requested characters and relocks afterwards", async () => {
    await setBudgetLimit(A, STAGE, 0);

    let insideLimit = -1;
    await withBudgetWindow(A, STAGE, 250, async () => {
      insideLimit = await currentBudgetLimit(A, STAGE);
      await reserveCredits(A, STAGE, 250);
      await settleCredits(A, STAGE, 250, 250);
    });

    assert.equal(insideLimit, 250, "the window opens to exactly the submitted characters");
    assert.equal(await currentBudgetLimit(A, STAGE), 0, "the limit is restored afterwards");
    const a = await row(A);
    assert.equal(a?.chargedChars, 250, "the charge survives the window closing");
    assert.equal(a?.reservedChars, 0);
  });

  test("one character more than the window is refused", async () => {
    await wipe();
    await setBudgetLimit(A, STAGE, 0);

    await assert.rejects(
      () => withBudgetWindow(A, STAGE, 100, async () => {
        await reserveCredits(A, STAGE, 101);
      }),
      BudgetExceededError,
      "the window must be a hard per-candidate ceiling",
    );
    assert.equal(await currentBudgetLimit(A, STAGE), 0, "the limit is restored after a refusal");
    assert.equal((await row(A))?.reservedChars, 0, "a refused candidate reserves nothing");
  });

  test("the limit is restored even when the body throws", async () => {
    await wipe();
    await setBudgetLimit(A, STAGE, 7);

    await assert.rejects(
      () => withBudgetWindow(A, STAGE, 500, async () => { throw new Error("boom"); }),
      /boom/,
    );
    assert.equal(await currentBudgetLimit(A, STAGE), 7,
      "a throw must not leave the budget open");
  });

  test("the window accounts for characters already charged", async () => {
    await wipe();
    await setBudgetLimit(A, STAGE, 0);
    // Simulate a prior charge on the row.
    await setBudgetLimit(A, STAGE, 100);
    await reserveCredits(A, STAGE, 100);
    await settleCredits(A, STAGE, 100, 100);
    await setBudgetLimit(A, STAGE, 0);

    let insideLimit = -1;
    await withBudgetWindow(A, STAGE, 50, async () => {
      insideLimit = await currentBudgetLimit(A, STAGE);
    });
    assert.equal(insideLimit, 150,
      "the window opens to charged + reserved + this candidate, not to the candidate alone");
    assert.equal(await currentBudgetLimit(A, STAGE), 0);
  });

  test("a window on one channel does not open the other", async () => {
    await wipe();
    await setBudgetLimit(A, STAGE, 0);
    await setBudgetLimit(B, STAGE, 0);

    await withBudgetWindow(A, STAGE, 400, async () => {
      assert.equal(await currentBudgetLimit(B, STAGE), 0,
        "opening the WC window must not open AI Doom's");
      await assert.rejects(() => reserveCredits(B, STAGE, 1), BudgetExceededError);
    });
    assert.equal(await currentBudgetLimit(A, STAGE), 0);
  });

  test("a negative or non-finite request is refused before anything opens", async () => {
    await wipe();
    await setBudgetLimit(A, STAGE, 0);
    await assert.rejects(() => withBudgetWindow(A, STAGE, -1, async () => {}), /non-negative/);
    await assert.rejects(() => withBudgetWindow(A, STAGE, NaN, async () => {}), /non-negative/);
    assert.equal(await currentBudgetLimit(A, STAGE), 0);
  });
});

describe("the real Wet Circuit and AI Doom rows are distinct", { skip }, () => {
  after(async () => { await disconnect(); });

  test("every budget row names exactly one channel and one stage", async () => {
    const rep = await budgetReport();
    const keys = rep.rows.map((r) => `${r.channel}/${r.stage}`);
    assert.equal(new Set(keys).size, keys.length, "no (channel, stage) pair may appear twice");
  });

  test("wet-circuit and ai-doom-scroll never share a row", async () => {
    const rep = await budgetReport();
    const wc = rep.rows.filter((r) => r.channel === "wet-circuit");
    const ai = rep.rows.filter((r) => r.channel === "ai-doom-scroll");
    assert.ok(wc.length > 0 && ai.length > 0, "both channels must have budget rows");
    for (const w of wc) {
      assert.ok(!ai.some((a) => a.channel === w.channel),
        "a channel's rows must not appear under the other channel");
    }
  });

  test("AI Doom's production spend is not visible in the WC production row", async () => {
    const rep = await budgetReport();
    const wcProd = rep.rows.find((r) => r.channel === "wet-circuit" && r.stage === "PRODUCTION");
    const aiProd = rep.rows.find((r) => r.channel === "ai-doom-scroll" && r.stage === "PRODUCTION");
    assert.ok(wcProd, "wet-circuit/PRODUCTION must exist");
    assert.ok(aiProd, "ai-doom-scroll/PRODUCTION must exist");
    assert.equal(wcProd!.charged, 0, "Wet Circuit has never spent at PRODUCTION");
    assert.ok(aiProd!.charged > 0, "AI Doom's canary spend is recorded on its own row");
  });
});

describe("the isolation is structural, not conventional", () => {
  const budget = readFileSync("packages/pipeline-core/src/lib/budget.ts", "utf8");
  const wcVoiceover = readFileSync("packages/wc-pipeline/src/stages/voiceover.ts", "utf8");
  const wcAssembly = readFileSync("packages/wc-pipeline/src/stages/videoAssembly.ts", "utf8");

  test("every reservation names a channel and a stage", () => {
    assert.match(budget, /WHERE "channel"\s+= \$\{channel\}\s+AND "testStage" = \$\{stage\}/,
      "the reservation UPDATE must filter on both");
  });

  test("settlement names the same pair", () => {
    const settle = budget.slice(budget.indexOf("export async function settleCredits"));
    assert.match(settle, /"channel"\s+= \$\{channel\}/);
    assert.match(settle, /"testStage" = \$\{stage\}/);
  });

  test("the WC stages pass the wet-circuit channel key", () => {
    assert.match(wcVoiceover, /channel: "wet-circuit"/);
    assert.match(wcAssembly, /channel: "wet-circuit"/);
  });

  test("the WC voiceover stage never hardcodes a test stage", () => {
    assert.doesNotMatch(wcVoiceover, /testStage: "(PRODUCTION|QUALIFICATION|DIAGNOSTIC)"/,
      "a hardcoded stage would charge WC spend to the wrong durable row");
    assert.match(wcVoiceover, /currentTestStage\(\)/);
  });

  test("the WC budget window is scoped to wet-circuit", () => {
    assert.match(wcVoiceover, /withBudgetWindow\(\s*"wet-circuit"/,
      "the window must name the WC row explicitly");
  });

  test("the window is sized from spoken units, not raw segments", () => {
    assert.match(wcVoiceover, /spokenCharacterCount\(buildSpokenUnits\(script\)\)/,
      "raw segment text omits a folded hook and CTA and would under-open the window");
  });
});
