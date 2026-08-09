/**
 * Inspect and exercise the authorization scheduler.
 *
 *   npx tsx scripts/authorization-scheduler-control.ts --check
 *   npx tsx scripts/authorization-scheduler-control.ts --dry-run --channel ai-doom-scroll
 *   npx tsx scripts/authorization-scheduler-control.ts --run --channel ai-doom-scroll
 *
 * `--check` and `--dry-run` never write. `--run` performs a real tick, and even
 * then writes only if SCHEDULER_ENABLED is exactly "true" AND the computed slot
 * is inside the lead window AND no cycle is already open. Both conditions are
 * required; there is no path that mutates on one alone.
 *
 * The scheduler that actually runs in production is the tick embedded in the
 * monitor services, not this script. This exists so the same decision can be
 * inspected by a human without waiting for a tick, and so the enable state can
 * be confirmed from the outside.
 *
 * LOCAL ONLY. No runtime imports this.
 */
import {
  disconnect, describeSlot,
  schedulerTick, realSchedulerDeps, isSchedulerEnabled,
  nextCycleSlot, currentRunnableCycle,
  AUTHORIZATION_LEAD_MS, MINIMUM_LEAD_MS, SCHEDULER_ENABLED_VALUE,
} from "@yt-pipeline/pipeline-core";
import "dotenv/config";

export const CHANNELS = ["ai-doom-scroll", "wet-circuit"] as const;
export type ChannelKey = (typeof CHANNELS)[number];

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function reportChannel(channel: ChannelKey, now: Date): Promise<void> {
  const slot = await nextCycleSlot(channel, now);
  const open = await currentRunnableCycle(channel, now);
  const leadMs = slot.getTime() - now.getTime();
  console.log(`\n  ── ${channel} ──`);
  console.log(`  next slot   : ${describeSlot(slot)}`);
  console.log(`  lead        : ${(leadMs / 3600000).toFixed(1)}h ` +
    `(window ${MINIMUM_LEAD_MS / 3600000}h..${AUTHORIZATION_LEAD_MS / 3600000}h)`);
  console.log(`  in window   : ${leadMs <= AUTHORIZATION_LEAD_MS && leadMs >= MINIMUM_LEAD_MS ? "yes" : "no"}`);
  console.log(`  open cycle  : ${open ? `${open.id} (${open.status})` : "none"}`);
}

export async function main(): Promise<void> {
  const now = new Date();
  const enabled = isSchedulerEnabled();
  console.log(`\n  SCHEDULER_ENABLED : ${process.env.SCHEDULER_ENABLED ?? "<unset>"} ` +
    `→ ${enabled ? "ENABLED (writes permitted)" : "DISABLED (no writes possible)"}`);
  console.log(`  required literal  : "${SCHEDULER_ENABLED_VALUE}"`);
  console.log(`  lead window       : authorize between ${MINIMUM_LEAD_MS / 3600000}h and ` +
    `${AUTHORIZATION_LEAD_MS / 3600000}h before the slot`);

  // Modes are explicit. CHECK is the default, but an unrecognised flag must
  // refuse rather than silently becoming a read-only report that looks fine.
  const MODES = ["--check", "--dry-run", "--run"];
  const unknown = process.argv.slice(2).filter(
    (a) => a.startsWith("--") && !MODES.includes(a) && a !== "--channel");
  if (unknown.length) {
    console.error(`✗ unrecognised flag(s): ${unknown.join(" ")}`);
    console.error(`  modes: ${MODES.join(" | ")}`);
    process.exitCode = 2; return;
  }

  const channelArg = argValue(process.argv, "--channel") as ChannelKey | undefined;
  const channels = channelArg ? [channelArg] : [...CHANNELS];
  for (const c of channels) {
    if (!CHANNELS.includes(c)) {
      console.error(`✗ --channel must be one of ${CHANNELS.join(" | ")}`);
      process.exitCode = 2; return;
    }
  }

  if (process.argv.includes("--run")) {
    for (const channel of channels) {
      const r = await schedulerTick(channel, realSchedulerDeps(), { now });
      console.log(`\n  ── ${channel} ──`);
      console.log(`  OUTCOME : ${r.outcome}`);
      console.log(`  mutated : ${r.mutated ? "YES — a cycle row was written" : "no"}`);
      console.log(`  reason  : ${r.reason}`);
    }
    return;
  }

  if (process.argv.includes("--dry-run")) {
    for (const channel of channels) {
      const r = await schedulerTick(channel, realSchedulerDeps(), { now, dryRun: true });
      console.log(`\n  ── ${channel} ──`);
      console.log(`  OUTCOME : ${r.outcome}`);
      console.log(`  mutated : ${r.mutated ? "YES (BUG — dry run must never write)" : "no"}`);
      console.log(`  reason  : ${r.reason}`);
    }
    return;
  }

  for (const channel of channels) await reportChannel(channel, now);
}

const isDirectRun =
  process.argv[1]?.endsWith("authorization-scheduler-control.ts") ||
  process.argv[1]?.endsWith("authorization-scheduler-control.js");

if (isDirectRun) {
  main().catch((e) => { console.error("CONTROL FAILED:", e); process.exitCode = 1; })
    .finally(() => disconnect());
}
