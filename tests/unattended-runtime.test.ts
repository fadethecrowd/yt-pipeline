import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isUnattendedMode, unattendedClaimantId, isClaimStale, isAmbiguousFailure,
  UNATTENDED_MODE, CLAIM_STALE_AFTER_MS,
} from "@yt-pipeline/pipeline-core";
import type { ProductionCycle, CycleStatus } from "@yt-pipeline/pipeline-core";
import {
  doCheck, doAuthorize, doVerify, AUTHORIZE_ACK,
  type CycleDeps,
} from "../scripts/production-cycle-control";

/**
 * Unattended production: a container start is not an authorization.
 *
 * The invariant under test is ONE AUTHORIZATION → AT MOST ONE VIDEO, held
 * across crashes, restarts, redeploys and concurrent containers. Two mechanisms
 * hold it together and the tests keep them separate on purpose:
 *
 *   - the Postgres advisory lock excludes CONCURRENT runners;
 *   - the stable claimant identity lets a RESTARTED runner resume its own work.
 *
 * Conflating them is the failure mode. A random per-process claimant would make
 * restart recovery impossible (the restarted process could never match the row
 * it left CLAIMED); dropping the claimant check entirely would let any process
 * adopt any cycle. The tests below pin both halves.
 */

const GATE = readFileSync("packages/pipeline-core/src/lib/unattendedGate.ts", "utf8");
const AI_PIPE = readFileSync("src/pipeline.ts", "utf8");
const WC_PIPE = readFileSync("packages/wc-pipeline/src/pipeline.ts", "utf8");
const CONTROL = readFileSync("scripts/production-cycle-control.ts", "utf8");

/** Source with comments removed, so assertions cannot match prose. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const AI_CODE = code(AI_PIPE);
const WC_CODE = code(WC_PIPE);
const GATE_CODE = code(GATE);

// ── An in-memory model of the cycle table + its compare-and-set guards ────

interface Row {
  id: string; channel: string; slot: number; status: CycleStatus;
  claimantId: string | null; videoId: string | null;
  claimedAt: number | null; failureCode: string | null;
}

class FakeCycles {
  rows: Row[] = [];
  videos: string[] = [];
  private seq = 0;

  authorize(channel: string, slot: number): { id: string; created: boolean } {
    const existing = this.rows.find((r) => r.channel === channel && r.slot === slot);
    if (existing) return { id: existing.id, created: false }; // the unique index
    const id = `cyc-${++this.seq}`;
    this.rows.push({ id, channel, slot, status: "AUTHORIZED", claimantId: null,
      videoId: null, claimedAt: null, failureCode: null });
    return { id, created: true };
  }

  runnable(channel: string, now: number): Row | null {
    return this.rows.filter((r) => r.channel === channel && r.slot > now &&
      (r.status === "AUTHORIZED" || r.status === "CLAIMED"))
      .sort((a, b) => a.slot - b.slot)[0] ?? null;
  }

  /** UPDATE … WHERE status IN (AUTHORIZED,CLAIMED) AND (claimant IS NULL OR = $2) */
  claim(id: string, claimant: string, at = 0): Row | null {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return null;
    if (r.status !== "AUTHORIZED" && r.status !== "CLAIMED") return null;
    if (r.claimantId !== null && r.claimantId !== claimant) return null;
    r.status = "CLAIMED"; r.claimantId = claimant;
    r.claimedAt = r.claimedAt ?? at;
    return r;
  }

  /** The create+attach transaction: both land, or neither does. */
  createAndAttach(id: string, claimant: string, videoId: string): boolean {
    const r = this.rows.find((x) => x.id === id);
    const ok = !!r && r.claimantId === claimant && r.status === "CLAIMED" && r.videoId === null;
    if (!ok) return false;              // rolled back — no video row survives
    this.videos.push(videoId);
    r!.videoId = videoId;
    return true;
  }

  complete(id: string, claimant: string): boolean {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.claimantId !== claimant || r.status !== "CLAIMED" || !r.videoId) return false;
    r.status = "COMPLETED"; return true;
  }

  fail(id: string, claimant: string, code: string, reconcile: boolean): boolean {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.claimantId !== claimant || r.status !== "CLAIMED") return false;
    r.status = reconcile ? "RECONCILIATION_REQUIRED" : "FAILED";
    r.failureCode = code; return true;
  }
}

const CH = "ai-doom-scroll";
const CLAIMANT = unattendedClaimantId(CH);
const FUTURE = 1_000;

function armed(): { db: FakeCycles; id: string } {
  const db = new FakeCycles();
  const { id } = db.authorize(CH, FUTURE);
  return { db, id };
}

// ── 1–8: the runtime mode is fail-closed ──────────────────────────────────

describe("unattended mode", () => {
  const cases: [string, Record<string, string>, boolean][] = [
    ["unset", {}, false],
    ["empty", { PRODUCTION_MODE: "" }, false],
    ["exact", { PRODUCTION_MODE: "unattended" }, true],
    ["padded", { PRODUCTION_MODE: "  unattended  " }, true],
    ["capitalised", { PRODUCTION_MODE: "Unattended" }, false],
    ["typo", { PRODUCTION_MODE: "unatended" }, false],
    ["truthy", { PRODUCTION_MODE: "true" }, false],
    ["adjacent value", { PRODUCTION_MODE: "unattended-production" }, false],
  ];
  for (const [label, env, expected] of cases) {
    test(`${label} → ${expected ? "enabled" : "disabled"}`, () => {
      assert.equal(isUnattendedMode(env as NodeJS.ProcessEnv), expected);
    });
  }
  test("the enabling literal is the exported constant", () => {
    assert.equal(isUnattendedMode({ PRODUCTION_MODE: UNATTENDED_MODE } as NodeJS.ProcessEnv), true);
  });
});

// ── 10–15: claimant identity survives a real crash ────────────────────────

describe("claimant identity", () => {
  test("is stable across calls — not a per-process random value", () => {
    assert.equal(unattendedClaimantId(CH), unattendedClaimantId(CH));
  });

  test("is derived only from the channel, so a fresh process reproduces it", () => {
    // Simulates a restart: nothing from the old process is carried over.
    const beforeCrash = unattendedClaimantId(CH);
    const afterRestart = unattendedClaimantId(CH);
    assert.equal(afterRestart, beforeCrash);
  });

  test("differs per channel", () => {
    assert.notEqual(unattendedClaimantId(CH), unattendedClaimantId("wet-circuit"));
  });

  test("contains no uuid/random/pid/timestamp component", () => {
    const id = unattendedClaimantId(CH);
    assert.match(id, /^unattended:[a-z-]+$/);
    assert.doesNotMatch(id, /[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  test("source does not mint a random or pid-based claimant", () => {
    assert.doesNotMatch(GATE_CODE, /randomUUID|Math\.random|process\.pid|Date\.now\(\)/);
  });

  test("CRASH RECOVERY: restarted process re-claims its own CLAIMED cycle", () => {
    const { db, id } = armed();
    assert.ok(db.claim(id, CLAIMANT), "original process claims");
    db.createAndAttach(id, CLAIMANT, "vid-1");
    // process dies here — the advisory lock is released with its connection
    const resumed = db.claim(id, unattendedClaimantId(CH)); // fresh process, no memory
    assert.ok(resumed, "restart must be able to resume");
    assert.equal(resumed!.videoId, "vid-1", "resumes the SAME candidate");
    assert.equal(db.videos.length, 1, "no second video");
  });

  test("EXCLUSIVITY: a foreign claimant cannot adopt a CLAIMED cycle", () => {
    const { db, id } = armed();
    db.claim(id, CLAIMANT);
    assert.equal(db.claim(id, "unattended:wet-circuit"), null);
    assert.equal(db.claim(id, "manual-operator"), null);
  });

  test("claimedAt is not reset by a re-claim, so staleness stays measurable", () => {
    const { db, id } = armed();
    db.claim(id, CLAIMANT, 100);
    const again = db.claim(id, CLAIMANT, 900);
    assert.equal(again!.claimedAt, 100);
  });
});

// ── 18–23: one authorization → at most one candidate ──────────────────────

describe("one authorization, one candidate", () => {
  test("first create+attach succeeds", () => {
    const { db, id } = armed();
    db.claim(id, CLAIMANT);
    assert.equal(db.createAndAttach(id, CLAIMANT, "v1"), true);
    assert.equal(db.videos.length, 1);
  });

  test("second create+attach on the same cycle is refused and creates nothing", () => {
    const { db, id } = armed();
    db.claim(id, CLAIMANT);
    db.createAndAttach(id, CLAIMANT, "v1");
    assert.equal(db.createAndAttach(id, CLAIMANT, "v2"), false);
    assert.deepEqual(db.videos, ["v1"], "the loser's video row must not survive");
  });

  test("attach is refused when the cycle was never claimed", () => {
    const { db, id } = armed();
    assert.equal(db.createAndAttach(id, CLAIMANT, "v1"), false);
    assert.equal(db.videos.length, 0);
  });

  test("attach is refused after the cycle is terminal", () => {
    const { db, id } = armed();
    db.claim(id, CLAIMANT);
    db.createAndAttach(id, CLAIMANT, "v1");
    db.complete(id, CLAIMANT);
    assert.equal(db.createAndAttach(id, CLAIMANT, "v2"), false);
    assert.equal(db.videos.length, 1);
  });

  test("two racing processes: exactly one candidate exists", () => {
    const { db, id } = armed();
    assert.ok(db.claim(id, CLAIMANT));
    const a = db.createAndAttach(id, CLAIMANT, "vA");
    const b = db.createAndAttach(id, CLAIMANT, "vB");
    assert.equal([a, b].filter(Boolean).length, 1);
    assert.equal(db.videos.length, 1);
  });

  test("duplicate authorization for one slot buys no second video", () => {
    const db = new FakeCycles();
    const first = db.authorize(CH, FUTURE);
    const second = db.authorize(CH, FUTURE);
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);
    assert.equal(db.rows.length, 1);
  });
});

// ── 24–30: every cycle state behaves ──────────────────────────────────────

describe("cycle states at runtime", () => {
  test("AUTHORIZED is runnable", () => {
    const { db } = armed();
    assert.ok(db.runnable(CH, 0));
  });

  test("CLAIMED is runnable (so a crash can be resumed)", () => {
    const { db, id } = armed();
    db.claim(id, CLAIMANT);
    assert.ok(db.runnable(CH, 0));
  });

  for (const terminal of ["COMPLETED", "FAILED", "RECONCILIATION_REQUIRED"] as CycleStatus[]) {
    test(`${terminal} is never runnable`, () => {
      const { db, id } = armed();
      db.rows[0].status = terminal;
      assert.equal(db.runnable(CH, 0), null, `${id} must not be handed out again`);
    });
  }

  test("a past slot is never runnable", () => {
    const { db } = armed();
    assert.equal(db.runnable(CH, FUTURE + 1), null);
  });

  test("no cycle at all → nothing runnable", () => {
    assert.equal(new FakeCycles().runnable(CH, 0), null);
  });
});

// ── 31–35: settlement, including the ambiguous upload ─────────────────────

describe("settlement", () => {
  test("success requires a video on the cycle", () => {
    const { db, id } = armed();
    db.claim(id, CLAIMANT);
    assert.equal(db.complete(id, CLAIMANT), false, "no video → cannot complete");
    db.createAndAttach(id, CLAIMANT, "v1");
    assert.equal(db.complete(id, CLAIMANT), true);
  });

  test("an upload failure is ambiguous and holds for reconciliation", () => {
    assert.equal(isAmbiguousFailure("youtubeUpload"), true);
    const { db, id } = armed();
    db.claim(id, CLAIMANT);
    db.createAndAttach(id, CLAIMANT, "v1");
    db.fail(id, CLAIMANT, "youtubeUpload: timeout", isAmbiguousFailure("youtubeUpload"));
    assert.equal(db.rows[0].status, "RECONCILIATION_REQUIRED");
    assert.equal(db.runnable(CH, 0), null, "must never auto-retry");
  });

  test("a pre-upload failure is an ordinary FAILED", () => {
    for (const stage of ["scriptGenerator", "qualityGate", "voiceover", "videoAssembly", "finalVideoQa"]) {
      assert.equal(isAmbiguousFailure(stage), false, stage);
    }
    const { db, id } = armed();
    db.claim(id, CLAIMANT);
    db.createAndAttach(id, CLAIMANT, "v1");
    db.fail(id, CLAIMANT, "voiceover: boom", false);
    assert.equal(db.rows[0].status, "FAILED");
    assert.equal(db.runnable(CH, 0), null);
  });

  test("a foreign claimant cannot settle someone else's cycle", () => {
    const { db, id } = armed();
    db.claim(id, CLAIMANT);
    db.createAndAttach(id, CLAIMANT, "v1");
    assert.equal(db.complete(id, "someone-else"), false);
    assert.equal(db.fail(id, "someone-else", "x", false), false);
  });

  test("settlement never throws out of the pipeline", () => {
    assert.match(GATE_CODE, /export async function settleCycle[\s\S]*?catch \(err\)/);
  });
});

// ── 36–39: stale claims are reported, never stolen ────────────────────────

describe("stale claims", () => {
  const base = new Date("2026-08-10T12:00:00Z");
  const cyc = (over: Partial<ProductionCycle>): ProductionCycle => ({
    id: "c", channel: CH, targetPublishSlot: base, status: "CLAIMED",
    claimantId: CLAIMANT, videoId: null, pipelineRunId: null, failureCode: null,
    authorizedAt: base, claimedAt: base, completedAt: null, failedAt: null, ...over,
  });

  test("a fresh claim is not stale", () => {
    assert.equal(isClaimStale(cyc({}), new Date(base.getTime() + 60_000)), false);
  });
  test("a claim past the threshold is stale", () => {
    assert.equal(isClaimStale(cyc({}), new Date(base.getTime() + CLAIM_STALE_AFTER_MS + 1)), true);
  });
  test("only CLAIMED cycles can be stale", () => {
    const late = new Date(base.getTime() + CLAIM_STALE_AFTER_MS + 1);
    assert.equal(isClaimStale(cyc({ status: "COMPLETED" }), late), false);
    assert.equal(isClaimStale(cyc({ status: "RECONCILIATION_REQUIRED" }), late), false);
  });
  test("nothing in the gate steals or clears a foreign claim", () => {
    assert.doesNotMatch(GATE_CODE, /claimantId"\s*=\s*NULL/i);
    assert.match(GATE_CODE, /refusing to steal/);
  });
});

// ── 40–47: the runtime wiring is where it has to be ───────────────────────

describe("runtime wiring", () => {
  const pipes: [string, string][] = [["ai-doom", AI_CODE], ["wet-circuit", WC_CODE]];

  for (const [name, src] of pipes) {
    test(`${name}: gate runs inside the advisory lock`, () => {
      const lock = src.indexOf("withAdvisoryLock");
      const gate = src.indexOf("openUnattendedGate");
      assert.ok(lock >= 0 && gate > lock, "gate must be inside the lock");
    });

    test(`${name}: gate runs BEFORE the resume query`, () => {
      const gate = src.indexOf("openUnattendedGate");
      const resume = src.search(/findFirst\(/);
      assert.ok(gate < resume, "a declined start must not even look for work");
    });

    test(`${name}: gate runs BEFORE topic discovery`, () => {
      assert.ok(src.indexOf("openUnattendedGate") < src.indexOf("topicDiscovery({}"));
    });

    test(`${name}: a declined unattended start returns without creating anything`, () => {
      const m = src.match(/if \(!gate\.run\) \{[\s\S]{0,200}?\n\s*\}/);
      assert.ok(m, "expected a decline branch");
      assert.match(m![0], /return;/);
    });

    test(`${name}: candidate creation goes through the atomic attach`, () => {
      assert.match(src, /createAndAttachCandidate\(\s*\n?\s*activeCycle\.id, activeCycle\.claimantId/);
    });

    test(`${name}: an unattended resume is scoped to its own cycle's video`, () => {
      assert.match(src, /activeCycle\s*\n?\s*\? \{ equals: cycleVideoId/);
    });

    test(`${name}: both success and failure paths settle the cycle`, () => {
      assert.ok((src.match(/settleCycle\(activeCycle, \{ ok: true \}\)/g) ?? []).length >= 1);
      assert.match(src, /settleCycle\(activeCycle, \{ ok: false, stage: stageName, reason \}\)/);
    });

    test(`${name}: not-unattended runs are unchanged`, () => {
      assert.match(src, /if \(isUnattendedMode\(\)\) \{/);
    });
  }
});

// ── 48–55: the control plane ──────────────────────────────────────────────

function ctlDeps(db: FakeCycles, now = 0): CycleDeps {
  const toCycle = (r: Row): ProductionCycle => ({
    id: r.id, channel: r.channel, targetPublishSlot: new Date(r.slot),
    status: r.status, claimantId: r.claimantId, videoId: r.videoId,
    pipelineRunId: null, failureCode: r.failureCode,
    authorizedAt: new Date(0), claimedAt: r.claimedAt === null ? null : new Date(r.claimedAt),
    completedAt: null, failedAt: null,
  });
  // A real Mon 15:00 ET slot, so assertValidSlot is exercised for real.
  const VALID_SLOT = new Date("2026-08-10T19:00:00.000Z");
  return {
    authorize: async (channel, slot) => {
      const { id, created } = db.authorize(channel, slot.getTime());
      return { cycle: toCycle(db.rows.find((r) => r.id === id)!), created };
    },
    runnable: async (channel) => {
      const r = db.runnable(channel, now); return r ? toCycle(r) : null;
    },
    list: async (channel, limit) =>
      db.rows.filter((r) => r.channel === channel).slice(0, limit).map(toCycle),
    read: async (id) => { const r = db.rows.find((x) => x.id === id); return r ? toCycle(r) : null; },
    nextSlot: async () => VALID_SLOT,
  };
}

describe("production-cycle-control", () => {
  test("authorize refuses without the acknowledgement", async () => {
    const db = new FakeCycles();
    const r = await doAuthorize(ctlDeps(db), CH, false);
    assert.equal(r.outcome, "REFUSED");
    assert.equal(db.rows.length, 0, "nothing may be written");
  });

  test("authorize writes exactly one cycle", async () => {
    const db = new FakeCycles();
    const r = await doAuthorize(ctlDeps(db), CH, true);
    assert.equal(r.outcome, "AUTHORIZED");
    assert.equal(db.rows.length, 1);
  });

  test("authorize refuses while a cycle is still open", async () => {
    const db = new FakeCycles();
    await doAuthorize(ctlDeps(db), CH, true);
    const again = await doAuthorize(ctlDeps(db), CH, true);
    assert.equal(again.outcome, "REFUSED");
    assert.match(again.reason, /one open cycle at a time/);
    assert.equal(db.rows.length, 1);
  });

  test("authorize refuses a slot that is not a real publication slot", async () => {
    const db = new FakeCycles();
    const r = await doAuthorize(ctlDeps(db), CH, true, new Date(0),
      new Date("2026-08-11T19:00:00.000Z")); // a Tuesday
    assert.equal(r.outcome, "REFUSED");
    assert.match(r.reason, /CYCLE_SLOT_WRONG_DAY/);
    assert.equal(db.rows.length, 0);
  });

  test("the acknowledgement phrase names what it buys", () => {
    assert.match(AUTHORIZE_ACK, /authorizes-one-unattended-video/);
  });

  test("check reports no runnable cycle as doing nothing", async () => {
    const db = new FakeCycles();
    const r = await doCheck(ctlDeps(db), CH);
    assert.equal(r.runnable, null);
    assert.equal(r.needsAttention.length, 0);
  });

  test("check surfaces a cycle held for reconciliation", async () => {
    const db = new FakeCycles();
    const { id } = db.authorize(CH, FUTURE);
    db.claim(id, CLAIMANT); db.createAndAttach(id, CLAIMANT, "v1");
    db.fail(id, CLAIMANT, "youtubeUpload: timeout", true);
    const r = await doCheck(ctlDeps(db), CH);
    assert.equal(r.runnable, null, "never handed back to a runner");
    assert.equal(r.needsAttention.length, 1);
  });

  test("verify flags a cycle claimed by something other than the runner", async () => {
    const db = new FakeCycles();
    const { id } = db.authorize(CH, FUTURE);
    db.claim(id, "manual-operator");
    const r = await doVerify(ctlDeps(db), CH, id);
    assert.equal(r.consistent, false);
    assert.ok(r.problems.some((p) => /not the unattended runner/.test(p)));
  });

  test("verify flags COMPLETED without a video", async () => {
    const db = new FakeCycles();
    const { id } = db.authorize(CH, FUTURE);
    db.rows[0].status = "COMPLETED";
    const r = await doVerify(ctlDeps(db), CH, id);
    assert.ok(r.problems.some((p) => /COMPLETED without a video/.test(p)));
  });

  test("verify passes a clean completed cycle", async () => {
    const db = new FakeCycles();
    const { id } = db.authorize(CH, new Date("2026-08-10T19:00:00.000Z").getTime());
    db.claim(id, CLAIMANT); db.createAndAttach(id, CLAIMANT, "v1"); db.complete(id, CLAIMANT);
    const r = await doVerify(ctlDeps(db), CH, id);
    assert.deepEqual(r.problems, []);
    assert.equal(r.consistent, true);
  });

  test("the control never runs a pipeline", () => {
    assert.doesNotMatch(code(CONTROL), /runPipeline|runWcCanaryOnce|spawn|exec\(/);
  });

  test("the control is local-only", () => {
    assert.match(CONTROL, /const isDirectRun =/);
  });
});
