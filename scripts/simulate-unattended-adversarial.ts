/**
 * Adversarial simulation of unattended production, both channels.
 *
 *   npx tsx scripts/simulate-unattended-adversarial.ts
 *
 * Drives the cycle state machine through the failure modes that actually
 * threaten the invariant — crash at every step, redeploy storms, concurrent
 * containers, ambiguous uploads — and asserts that ONE AUTHORIZATION produced
 * AT MOST ONE VIDEO in every one of them.
 *
 * Runs entirely in memory. It deliberately opens NO database connection: the
 * only database this repository is wired to is production, and a simulation
 * that writes real ProductionCycle rows to prove a safety property would be the
 * exact accident the property exists to prevent. The compare-and-set predicates
 * modelled here are pinned against the real SQL by tests/production-cycle.test.ts
 * and tests/unattended-runtime.test.ts.
 *
 * LOCAL ONLY. No runtime imports this.
 */
import { unattendedClaimantId, isAmbiguousFailure } from "@yt-pipeline/pipeline-core";

type Status = "AUTHORIZED" | "CLAIMED" | "COMPLETED" | "FAILED" | "RECONCILIATION_REQUIRED";

interface Row {
  id: string; channel: string; slot: number; status: Status;
  claimantId: string | null; videoId: string | null; claimedAt: number | null;
}

/** The table, its unique index, and the guards from productionCycle.ts. */
class World {
  rows: Row[] = [];
  videos: { id: string; cycleId: string }[] = [];
  private seq = 0;

  authorize(channel: string, slot: number): Row {
    const existing = this.rows.find((r) => r.channel === channel && r.slot === slot);
    if (existing) return existing;                      // unique (channel, slot)
    const row: Row = { id: `cyc-${++this.seq}`, channel, slot, status: "AUTHORIZED",
      claimantId: null, videoId: null, claimedAt: null };
    this.rows.push(row); return row;
  }

  runnable(channel: string, now: number): Row | null {
    return this.rows.filter((r) => r.channel === channel && r.slot > now &&
      (r.status === "AUTHORIZED" || r.status === "CLAIMED"))
      .sort((a, b) => a.slot - b.slot)[0] ?? null;
  }

  claim(id: string, claimant: string, at: number): Row | null {
    const r = this.rows.find((x) => x.id === id);
    if (!r || (r.status !== "AUTHORIZED" && r.status !== "CLAIMED")) return null;
    if (r.claimantId !== null && r.claimantId !== claimant) return null;
    r.status = "CLAIMED"; r.claimantId = claimant; r.claimedAt ??= at;
    return r;
  }

  /** One transaction: the video exists only if the attach matched. */
  createAndAttach(id: string, claimant: string, videoId: string): boolean {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.claimantId !== claimant || r.status !== "CLAIMED" || r.videoId !== null) return false;
    this.videos.push({ id: videoId, cycleId: id });
    r.videoId = videoId; return true;
  }

  complete(id: string, claimant: string): boolean {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.claimantId !== claimant || r.status !== "CLAIMED" || !r.videoId) return false;
    r.status = "COMPLETED"; return true;
  }

  settleFail(id: string, claimant: string, stage: string): boolean {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.claimantId !== claimant || r.status !== "CLAIMED") return false;
    r.status = isAmbiguousFailure(stage) ? "RECONCILIATION_REQUIRED" : "FAILED";
    return true;
  }

  videosFor(cycleId: string): number {
    return this.videos.filter((v) => v.cycleId === cycleId).length;
  }
}

/**
 * One container start, as the wired runtime performs it.
 *
 * `crashAfter` names the step at which the process dies — no settlement, no
 * cleanup, exactly what a SIGKILL or an OOM leaves behind. `lockHeld` models a
 * live sibling container: `pg_try_advisory_lock` refuses and runPipeline throws
 * before the gate is ever reached.
 */
function containerStart(
  w: World, channel: string, now: number,
  opts: { crashAfter?: "claim" | "create" | "stages"; lockHeld?: boolean; failAt?: string } = {},
): string {
  if (opts.lockHeld) return "refused: advisory lock held by a live container";

  const cycle = w.runnable(channel, now);
  if (!cycle) return "declined: no video owed";

  const claimant = unattendedClaimantId(channel);
  const claimed = w.claim(cycle.id, claimant, now);
  if (!claimed) return `declined: held by ${cycle.claimantId}`;
  if (opts.crashAfter === "claim") return "CRASHED after claim";

  if (!claimed.videoId) {
    const ok = w.createAndAttach(cycle.id, claimant, `vid-${w.videos.length + 1}`);
    if (!ok) return "refused: cycle already carries a candidate";
    if (opts.crashAfter === "create") return "CRASHED after create+attach";
  }
  if (opts.crashAfter === "stages") return "CRASHED mid-stages";

  if (opts.failAt) { w.settleFail(cycle.id, claimant, opts.failAt); return `failed at ${opts.failAt}`; }
  w.complete(cycle.id, claimant);
  return "completed";
}

// ── Scenarios ─────────────────────────────────────────────────────────────

interface Scenario { name: string; run(w: World, ch: string): void; }

const SCENARIOS: Scenario[] = [
  { name: "redeploy storm — 10 starts, one authorization", run(w, ch) {
      w.authorize(ch, 1000);
      for (let i = 0; i < 10; i++) containerStart(w, ch, i);
    } },
  { name: "crash after claim, then restart", run(w, ch) {
      w.authorize(ch, 1000);
      containerStart(w, ch, 1, { crashAfter: "claim" });
      containerStart(w, ch, 2);
    } },
  { name: "crash between create and stages, then restart", run(w, ch) {
      w.authorize(ch, 1000);
      containerStart(w, ch, 1, { crashAfter: "create" });
      containerStart(w, ch, 2);
    } },
  { name: "crash mid-stages, then three restarts", run(w, ch) {
      w.authorize(ch, 1000);
      containerStart(w, ch, 1, { crashAfter: "stages" });
      containerStart(w, ch, 2, { crashAfter: "stages" });
      containerStart(w, ch, 3, { crashAfter: "stages" });
      containerStart(w, ch, 4);
    } },
  { name: "concurrent container while the first holds the lock", run(w, ch) {
      w.authorize(ch, 1000);
      containerStart(w, ch, 1, { crashAfter: "stages" });   // first, holding
      containerStart(w, ch, 1, { lockHeld: true });          // sibling, refused
      containerStart(w, ch, 2);                              // first restarts
    } },
  { name: "foreign claimant holds the cycle", run(w, ch) {
      const c = w.authorize(ch, 1000);
      w.claim(c.id, "manual-operator", 0);
      containerStart(w, ch, 1);
      containerStart(w, ch, 2);
    } },
  { name: "duplicate authorization for the same slot", run(w, ch) {
      w.authorize(ch, 1000); w.authorize(ch, 1000); w.authorize(ch, 1000);
      containerStart(w, ch, 1);
      containerStart(w, ch, 2);
    } },
  { name: "ambiguous upload — never retried", run(w, ch) {
      w.authorize(ch, 1000);
      containerStart(w, ch, 1, { failAt: "youtubeUpload" });
      containerStart(w, ch, 2);
      containerStart(w, ch, 3);
    } },
  { name: "pre-upload failure — never retried either", run(w, ch) {
      w.authorize(ch, 1000);
      containerStart(w, ch, 1, { failAt: "voiceover" });
      containerStart(w, ch, 2);
    } },
  { name: "completed cycle, then more starts", run(w, ch) {
      w.authorize(ch, 1000);
      containerStart(w, ch, 1);
      for (let i = 0; i < 5; i++) containerStart(w, ch, 2 + i);
    } },
  { name: "slot passes while claimed", run(w, ch) {
      w.authorize(ch, 1000);
      containerStart(w, ch, 1, { crashAfter: "stages" });
      containerStart(w, ch, 1001);   // slot now in the past
    } },
  { name: "no authorization at all — 20 starts", run(w, ch) {
      for (let i = 0; i < 20; i++) containerStart(w, ch, i);
    } },
];

function main(): void {
  const channels = ["ai-doom-scroll", "wet-circuit"];
  let failures = 0;

  for (const channel of channels) {
    console.log(`\n══ ${channel} ══`);
    for (const s of SCENARIOS) {
      const w = new World();
      s.run(w, channel);

      const cycles = w.rows.length;
      const problems: string[] = [];
      for (const r of w.rows) {
        const n = w.videosFor(r.id);
        if (n > 1) problems.push(`cycle ${r.id} produced ${n} videos`);
        if (r.status === "COMPLETED" && n !== 1) problems.push(`cycle ${r.id} COMPLETED with ${n} videos`);
      }
      if (w.videos.length > cycles) problems.push(`${w.videos.length} videos for ${cycles} authorization(s)`);

      const ok = problems.length === 0;
      if (!ok) failures++;
      console.log(`  ${ok ? "✓" : "✗"} ${s.name}`);
      console.log(`      authorizations ${cycles}  videos ${w.videos.length}  ` +
        `states [${w.rows.map((r) => r.status).join(", ") || "—"}]`);
      for (const p of problems) console.log(`      ✗ ${p}`);
    }
  }

  console.log(`\n${failures === 0
    ? "✓ ALL SCENARIOS HELD: one authorization → at most one video"
    : `✗ ${failures} scenario(s) violated the invariant`}`);
  if (failures) process.exitCode = 1;
}

const isDirectRun =
  process.argv[1]?.endsWith("simulate-unattended-adversarial.ts") ||
  process.argv[1]?.endsWith("simulate-unattended-adversarial.js");

if (isDirectRun) main();
