/**
 * Create (or re-assert) the Wet Circuit private-canary pilot record.
 *
 *   npx tsx scripts/prepare-wc-canary.ts          # report only
 *   npx tsx scripts/prepare-wc-canary.ts --apply  # create/repair the row
 *
 * Idempotent. Creates the row in PREPARED at 0/1 with no activation time, and
 * refuses to touch a row that has already been activated or has recorded a
 * success — repairing those is a human decision, not a script's.
 *
 * Never modifies any other pilot. The AI Doom row is read and asserted
 * unchanged, so running this cannot quietly disturb that pilot.
 */
import { prisma, disconnect } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const WC = {
  pilotId: "wet-circuit-private-canary-1",
  channel: "wet-circuit",
  channelId: "UC9iJDqlrKEs0uuMeIjb9DVA",
  status: "PREPARED",
  maxSuccesses: 1,
  successCount: 0,
  successVideoIds: [] as string[],
  activatedAt: null,
  completedAt: null,
  privacyStatus: "private",
  allowPublishAt: false,
  shortsEnabled: false,
  requireFeasibility: true,
  requireGuardedUpload: true,
  // Tuesday and Thursday, 5-8 PM America/New_York, daylight-saving aware.
  // This is an EXECUTION window. It is never a YouTube publishAt.
  windowDays: [2, 4],
  windowStartHour: 17,
  windowEndHour: 20,
  timezone: "America/New_York",
  notes:
    "Bounded private canary for Wet Circuit. Exactly one PRIVATE upload, no publishAt, " +
    "no Shorts, feasibility required before narration spend, guarded durable upload required. " +
    "Execution window Tue/Thu 17:00-20:00 America/New_York is when the pipeline may RUN; " +
    "it never becomes a publish time.",
};

const AI_DOOM_PILOT = "ai-doom-private-pilot-1";

const apply = process.argv.includes("--apply");
const pilots = (prisma as never as { productionPilot: any }).productionPilot;

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(24)} ${String(value)}`);
}

async function main() {
  console.log("\n═══ WET CIRCUIT PRIVATE CANARY — PILOT RECORD ═══\n");

  // ── AI Doom must be untouched ──────────────────────────────────────
  const aidBefore = await pilots.findUnique({ where: { pilotId: AI_DOOM_PILOT } });
  if (!aidBefore) throw new Error(`${AI_DOOM_PILOT} is missing — refusing to proceed`);
  const aidFingerprint = JSON.stringify({
    status: aidBefore.status, maxSuccesses: aidBefore.maxSuccesses,
    successCount: aidBefore.successCount, successVideoIds: aidBefore.successVideoIds,
    activatedAt: aidBefore.activatedAt, completedAt: aidBefore.completedAt,
  });
  console.log(`AI Doom pilot before: ${aidBefore.status} ${aidBefore.successCount}/${aidBefore.maxSuccesses} activatedAt=${aidBefore.activatedAt ?? "null"}`);

  const existing = await pilots.findUnique({ where: { pilotId: WC.pilotId } });

  if (existing) {
    console.log(`\nExisting row found (${existing.id}):`);
    line("status", existing.status);
    line("successCount", `${existing.successCount}/${existing.maxSuccesses}`);
    line("activatedAt", existing.activatedAt ?? "null");
    line("successVideoIds", JSON.stringify(existing.successVideoIds));

    // Fail closed: a row that has run is not something to silently rewrite.
    if (existing.activatedAt || existing.successCount > 0 || existing.successVideoIds.length > 0) {
      console.error(
        "\n✗ REFUSING: this canary has been activated or has recorded a success. " +
        "Resetting it would erase evidence of a real upload. Resolve by hand.",
      );
      process.exitCode = 1;
      return;
    }

    const drift = Object.entries({
      channel: WC.channel, channelId: WC.channelId, status: WC.status,
      maxSuccesses: WC.maxSuccesses, privacyStatus: WC.privacyStatus,
      allowPublishAt: WC.allowPublishAt, shortsEnabled: WC.shortsEnabled,
      requireFeasibility: WC.requireFeasibility, requireGuardedUpload: WC.requireGuardedUpload,
      windowStartHour: WC.windowStartHour, windowEndHour: WC.windowEndHour,
      timezone: WC.timezone,
    }).filter(([k, v]) => existing[k] !== v);
    const daysDrift = JSON.stringify(existing.windowDays) !== JSON.stringify(WC.windowDays);

    if (drift.length === 0 && !daysDrift) {
      console.log("\n✓ Row already matches the required configuration exactly.");
    } else {
      console.log("\nDrift from required configuration:");
      for (const [k, v] of drift) console.log(`  ${k}: ${existing[k]} → ${v}`);
      if (daysDrift) console.log(`  windowDays: ${JSON.stringify(existing.windowDays)} → ${JSON.stringify(WC.windowDays)}`);
      if (apply) {
        await pilots.update({ where: { pilotId: WC.pilotId }, data: WC });
        console.log("\n✓ Repaired.");
      } else {
        console.log("\n(dry run — pass --apply to repair)");
      }
    }
  } else if (apply) {
    const created = await pilots.create({ data: WC });
    console.log(`\n✓ Created ${created.id}`);
  } else {
    console.log("\nNo row exists. Would create:");
    for (const [k, v] of Object.entries(WC)) line(k, typeof v === "object" ? JSON.stringify(v) : v);
    console.log("\n(dry run — pass --apply to create)");
  }

  // ── Final state ────────────────────────────────────────────────────
  const after = await pilots.findUnique({ where: { pilotId: WC.pilotId } });
  if (after) {
    console.log("\nWC canary record now:");
    line("pilotId", after.pilotId);
    line("channel / channelId", `${after.channel} / ${after.channelId}`);
    line("status", after.status);
    line("successes", `${after.successCount}/${after.maxSuccesses}`);
    line("activatedAt", after.activatedAt ?? "null");
    line("privacy", after.privacyStatus);
    line("allowPublishAt", after.allowPublishAt);
    line("shortsEnabled", after.shortsEnabled);
    line("requireFeasibility", after.requireFeasibility);
    line("requireGuardedUpload", after.requireGuardedUpload);
    line("execution window", `days=${JSON.stringify(after.windowDays)} ${after.windowStartHour}:00-${after.windowEndHour}:00 ${after.timezone}`);
  }

  // ── AI Doom still untouched ────────────────────────────────────────
  const aidAfter = await pilots.findUnique({ where: { pilotId: AI_DOOM_PILOT } });
  const aidAfterFingerprint = JSON.stringify({
    status: aidAfter.status, maxSuccesses: aidAfter.maxSuccesses,
    successCount: aidAfter.successCount, successVideoIds: aidAfter.successVideoIds,
    activatedAt: aidAfter.activatedAt, completedAt: aidAfter.completedAt,
  });
  const unchanged = aidFingerprint === aidAfterFingerprint;
  console.log(
    `\nAI Doom pilot after:  ${aidAfter.status} ${aidAfter.successCount}/${aidAfter.maxSuccesses} ` +
    `activatedAt=${aidAfter.activatedAt ?? "null"}  → ${unchanged ? "UNCHANGED ✓" : "CHANGED ✗"}`,
  );
  if (!unchanged) process.exitCode = 1;

  const total = await pilots.count();
  console.log(`\ntotal pilot rows: ${total}`);
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => disconnect());
