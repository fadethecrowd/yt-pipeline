/**
 * Phase 6 state verification.
 *
 *   npx tsx scripts/verify-phase6-state.ts
 *
 * Read-only. Asserts every safety invariant that must hold while Phase 6 is
 * paused: nothing resumable, nothing uploading, budgets closed, the withdrawn
 * HBM asset intact and unpublished, and no other qualification asset started.
 *
 * Exits non-zero if any invariant is violated.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { prisma, disconnect, resumableJobs, budgetReport } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const HBM = "cms9970di0002mbti2m9avpui";

/** Ledger total at the point Phase 6 was paused. */
const EXPECTED_LEDGER = 11_569;

const failures: string[] = [];
function check(ok: boolean, label: string, detail: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(38)} ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

async function main() {
  console.log("\n═══ PHASE 6 STATE VERIFICATION ═══\n");

  // ── Resumable work ──────────────────────────────────────────────────
  const aiJobs = await resumableJobs("ai-doom-scroll");
  const wcJobs = await resumableJobs("wet-circuit");
  check(aiJobs.length === 0, "zero resumable ai-doom jobs", `${aiJobs.length} found`);
  check(wcJobs.length === 0, "zero resumable wet-circuit jobs", `${wcJobs.length} found`);

  // ── Credit ledger ───────────────────────────────────────────────────
  const ledger = await prisma.elevenLabsUsage.aggregate({ _sum: { chargedChars: true } });
  const total = ledger._sum.chargedChars ?? 0;
  check(total === EXPECTED_LEDGER, "ElevenLabs ledger unchanged", `${total} (expected ${EXPECTED_LEDGER})`);

  // ── Budgets ─────────────────────────────────────────────────────────
  const budgets = await budgetReport();
  const open = budgets.rows.filter((r) => r.remaining > 0);
  check(
    open.length === 0,
    "every generation budget at zero",
    open.length === 0
      ? "no budget has spendable headroom"
      : open.map((r) => `${r.channel}/${r.stage}=${r.remaining}`).join(", "),
  );
  check(
    budgets.totalReserved === 0,
    "no outstanding reservations",
    `${budgets.totalReserved} chars reserved`,
  );

  // ── The withdrawn HBM asset ─────────────────────────────────────────
  const hbm = await prisma.video.findUnique({ where: { id: HBM } });
  check(hbm !== null, "HBM record preserved", hbm ? "present" : "MISSING");
  check(!hbm?.youtubeId, "HBM never uploaded", hbm?.youtubeId ?? "no youtubeId ✓");
  check(
    Boolean(hbm?.scriptJson) && Boolean(hbm?.voiceoverPath),
    "HBM script and narration retained",
    `script=${Boolean(hbm?.scriptJson)} narration=${Boolean(hbm?.voiceoverPath)}`,
  );

  const quarantined = await prisma.jobQuarantine.findFirst({
    where: { videoId: HBM, releasedAt: null },
  });
  check(quarantined !== null, "HBM job quarantined", quarantined?.reason ?? "NOT QUARANTINED");

  const disposition = await prisma.qaRecord.findFirst({
    where: { videoId: HBM, overall: "VISUAL_SOURCE_INCOMPATIBLE_WITH_CURRENT_LIBRARY" },
  });
  check(
    disposition !== null,
    "terminal disposition recorded",
    disposition ? `${disposition.id} audio=${disposition.audioResult} captions=${disposition.captionResult} visual=${disposition.visualResult}` : "MISSING",
  );

  const usage = await prisma.elevenLabsUsage.count({ where: { videoId: HBM } });
  const scenes = await prisma.sceneRecord.count({ where: { videoId: HBM } });
  const qaCount = await prisma.qaRecord.count({ where: { videoId: HBM } });
  check(usage === 36 && scenes === 39, "HBM evidence rows intact",
    `${usage} credit rows, ${scenes} scene records, ${qaCount} QA records`);

  // ── Render artifacts on disk ────────────────────────────────────────
  const artifacts = [
    "final-v1-FAILED-VISUAL-QA.mp4",
    "final-clean-v1.mp4",
    "final-v2-FAILED-MANUAL-QA.mp4",
    "final-clean.mp4",
    "final.mp4",
    "render-v1.log",
  ];
  const dir = join(process.cwd(), "output", HBM);
  const present = artifacts.filter((a) => existsSync(join(dir, a)));
  check(
    present.length === artifacts.length,
    "all HBM render artifacts preserved",
    `${present.length}/${artifacts.length} present`,
  );
  for (const a of present) {
    const s = statSync(join(dir, a));
    console.log(`      ${a.padEnd(34)} ${(s.size / 1_048_576).toFixed(1)} MB`);
  }

  // ── No other Phase 6 asset started ──────────────────────────────────
  const qualTopics = await prisma.topic.findMany({
    where: { url: { startsWith: "https://qualification.local/" } },
    include: { videos: true },
  });
  const started = qualTopics.flatMap((t) =>
    t.videos.filter((v) => v.id !== HBM).map((v) => `${t.title} → ${v.id} (${v.status})`),
  );
  check(
    started.length === 0,
    "no other Phase 6 asset started",
    started.length === 0 ? "only the withdrawn ai1 row exists" : started.join("; "),
  );

  const wcQual = await prisma.wcTopic.findMany({
    where: { url: { startsWith: "https://qualification.local/" } },
    include: { videos: true },
  });
  check(
    wcQual.flatMap((t) => t.videos).length === 0,
    "no Wet Circuit qualification started",
    `${wcQual.flatMap((t) => t.videos).length} row(s)`,
  );

  console.log(
    failures.length === 0
      ? "\n  ✓ ALL INVARIANTS HOLD\n"
      : `\n  ✗ ${failures.length} INVARIANT(S) VIOLATED:\n    - ${failures.join("\n    - ")}\n`,
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error("VERIFICATION FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => disconnect());
