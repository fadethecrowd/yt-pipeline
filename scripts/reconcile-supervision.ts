/**
 * Independent recovery for abandoned supervised runs.
 *
 *   npx tsx scripts/reconcile-supervision.ts            # report only
 *   npx tsx scripts/reconcile-supervision.ts --apply    # close stale leases, relock
 *
 * This exists because `ai-doom-pilot-control --run` cannot be trusted to clean
 * up after itself. Its `finally` survives exceptions but not being killed, and
 * on 2026-08-13 it was killed between removing the auth_check lock and putting
 * it back — leaving Railway production-capable while the container spent 5,683
 * characters unattended.
 *
 * Nothing here depends on that controller still existing. It reads durable
 * state, closes leases nobody is renewing, and restores the safe resting
 * configuration when the environment claims more capability than any live
 * lease justifies.
 *
 * Idempotent by construction: every close is a conditional UPDATE, so running
 * this twice — or two copies at once — settles on the same terminal state.
 *
 * It never starts anything, never spends, and never touches a candidate.
 */
import {
  prisma, disconnect, activeLeaseFor, reconcileLeases,
  checkSupervisedLease, environmentNeedsRelock, SAFE_RESTING_STATE,
} from "@yt-pipeline/pipeline-core";
import type { SupervisedLeaseRow } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const APPLY = process.argv.includes("--apply");
const SERVICE = "yt-pipeline";
const ENVIRONMENT = "production";

async function railway(args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("railway", args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function readVars(): Promise<Record<string, string>> {
  const out = await railway(["variables", "--service", SERVICE, "--environment", ENVIRONMENT, "--kv"]);
  const kv: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return kv;
}

async function main() {
  const now = new Date();
  console.log(`SUPERVISION RECONCILER — ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);

  // ── 1. Durable leases ────────────────────────────────────────────────
  const all = (await (prisma as never as { supervisedLease: any }).supervisedLease.findMany({
    where: { status: "ACTIVE" },
  })) as SupervisedLeaseRow[];
  console.log(`  active leases: ${all.length}`);
  for (const l of all) {
    const v = checkSupervisedLease({ lease: l, now, channel: l.channel as never });
    console.log(`    ${l.id} ${l.channel} pilot=${l.pilotId} ` +
      `${v.live ? "LIVE" : `STALE — ${v.reason}`}`);
  }

  let closed: { id: string; channel: string; reason: string }[] = [];
  if (APPLY) {
    closed = await reconcileLeases(now);
    for (const c of closed) console.log(`    ✓ closed ${c.id} (${c.channel}) — ${c.reason}`);
  }

  // ── 2. Is anything still legitimately supervised? ────────────────────
  const live = await activeLeaseFor("ai-doom-scroll");
  const stillLive = live
    ? checkSupervisedLease({ lease: live, now, channel: "ai-doom-scroll" }).live
    : false;

  // ── 3. Does the environment claim more than that justifies? ──────────
  let vars: Record<string, string>;
  try { vars = await readVars(); }
  catch (e) {
    console.log(`\n  ! could not read Railway variables: ${(e as Error).message}`);
    console.log("    (durable leases were still reconciled — the pipeline refuses without one)");
    await disconnect();
    return;
  }
  console.log(`\n  PIPELINE_MODE=${vars.PIPELINE_MODE} DISABLE_ELEVEN=${vars.DISABLE_ELEVEN}` +
    `  liveLease=${stillLive}`);

  const need = environmentNeedsRelock(vars, stillLive);
  if (!need.needed) {
    console.log(`  ✓ environment consistent — ${need.reason}`);
    console.log(`\nRECONCILER = ${APPLY ? "APPLIED" : "CLEAN"} (${closed.length} lease(s) closed)`);
    await disconnect();
    return;
  }

  console.log(`  ✗ ${need.reason}`);
  if (!APPLY) {
    console.log("    → re-run with --apply to restore the safe resting state");
    process.exitCode = 1;
    await disconnect();
    return;
  }
  await railway([
    "variables", "set",
    `PIPELINE_MODE=${SAFE_RESTING_STATE.PIPELINE_MODE}`,
    `DISABLE_ELEVEN=${SAFE_RESTING_STATE.DISABLE_ELEVEN}`,
    "--service", SERVICE, "--environment", ENVIRONMENT,
  ]);
  const after = await readVars();
  const ok = after.PIPELINE_MODE === SAFE_RESTING_STATE.PIPELINE_MODE
    && after.DISABLE_ELEVEN === SAFE_RESTING_STATE.DISABLE_ELEVEN;
  console.log(`  ${ok ? "✓" : "✗✗"} relocked — stored PIPELINE_MODE=${after.PIPELINE_MODE} ` +
    `DISABLE_ELEVEN=${after.DISABLE_ELEVEN}`);
  if (!ok) process.exitCode = 1;
  console.log(`\nRECONCILER = APPLIED (${closed.length} lease(s) closed)`);
  await disconnect();
}

if (process.argv[1]?.includes("reconcile-supervision")) {
  main().catch((e) => { console.error("RECONCILER FAILED:", e); process.exitCode = 1; })
    .finally(() => disconnect());
}
