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
import {
  prisma, disconnect, resumableJobs, budgetReport,
  classifyUploadDisposition, createGoogleYouTubePort, prismaIntentStore,
  isUnresolved, CHANNELS,
} from "@yt-pipeline/pipeline-core";
import type { RemoteVideo } from "@yt-pipeline/pipeline-core";
import type { TestStage } from "@prisma/client";
import { ASSETS } from "./qualify";
import "dotenv/config";

/**
 * Phase 6 assets Max has explicitly authorized, derived from the runner's own
 * asset table. A withdrawn asset stays authorized — it exists legitimately.
 */
const AUTHORIZED_PHASE6_ASSETS = ASSETS.filter((a) => a.phase6Authorized);

const HBM = "cms9970di0002mbti2m9avpui";

/** Title fragment the HBM asset was uploaded under, for remote matching. */
const HBM_EXPECTED_TITLE = "The AI Chip Shortage Moved From GPUs to Memory";

/**
 * Assets whose ElevenLabs spend is sanctioned, and what each was authorized to
 * charge. The ledger total is DERIVED from this rather than frozen at a
 * constant: a hardcoded figure reports a violation after every authorized run,
 * which trains the reader to ignore it — and an alarm nobody reads is worse
 * than no alarm. What matters is not that the total never moves, but that
 * every character on it belongs to something that was allowed to spend.
 */
const SANCTIONED_SPEND: { videoId: string; stage: TestStage; chars: number; what: string }[] = [
  { videoId: "cms9970di0002mbti2m9avpui", stage: "QUALIFICATION", chars: 7_071, what: "HBM (withdrawn, quarantined)" },
  { videoId: "cmsdrtafn0002mbdzwpmndnix", stage: "QUALIFICATION", chars: 4_574, what: "qualification benchmark rrb0A_piLEM" },
  { videoId: "cmsexx3n80002mb1gd988zvee", stage: "PRODUCTION", chars: 5_017, what: "production canary AMrrTvdL2tI" },
];

/**
 * Stages whose every charge must map to a named asset above. DIAGNOSTIC spend
 * predates these controls and is reconciled by total only — enumerating it
 * would freeze history without protecting anything.
 */
const CONTROLLED_STAGES: TestStage[] = ["QUALIFICATION", "PRODUCTION", "RETEST", "REPEATABILITY"];

function budgetsWithReservations(rep: { rows: { channel: string; stage: string; reserved: number }[] }): string[] {
  return rep.rows.filter((r) => r.reserved > 0).map((r) => `${r.channel}/${r.stage}=${r.reserved}`);
}

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
  // The budgets are the durable accounting. Usage rows and budget rows are
  // written by the same settle call, so a divergence means a charge was
  // recorded against no budget — or a budget moved without a charge.
  const budgetsAll = await budgetReport();
  const budgetCharged = budgetsAll.rows.reduce((a, r) => a + r.charged, 0);
  check(total === budgetCharged, "usage rows reconcile to budget rows",
    `usage ${total} vs budgets ${budgetCharged}`);

  // Every charged row must belong to a sanctioned asset at the stage it was
  // sanctioned for. An unknown videoId here is spend nobody authorized.
  const rows = await prisma.elevenLabsUsage.findMany({
    where: { chargedChars: { gt: 0 }, testStage: { in: CONTROLLED_STAGES } },
    select: { videoId: true, testStage: true, chargedChars: true, segmentIndex: true },
  });
  const byAsset = new Map<string, { stage: string; charged: number }>();
  for (const r of rows) {
    const k = `${r.videoId}/${r.testStage}`;
    const cur = byAsset.get(k) ?? { stage: r.testStage, charged: 0 };
    cur.charged += r.chargedChars ?? 0;
    byAsset.set(k, cur);
  }
  const unknown: string[] = [];
  const mismatched: string[] = [];
  for (const [k, v] of byAsset) {
    const [videoId, stage] = k.split("/");
    const s = SANCTIONED_SPEND.find((x) => x.videoId === videoId && x.stage === stage);
    if (!s) { unknown.push(`${k}=${v.charged}`); continue; }
    if (v.charged !== s.chars) mismatched.push(`${s.what}: charged ${v.charged}, sanctioned ${s.chars}`);
  }
  check(unknown.length === 0, "no unsanctioned controlled-stage spend",
    unknown.length === 0 ? `${byAsset.size} asset(s), all sanctioned` : unknown.join(", "));
  check(mismatched.length === 0, "each asset charged exactly what was sanctioned",
    mismatched.length === 0 ? "all exact" : mismatched.join("; "));

  // A charged row with an open reservation means a transaction never settled.
  const unsettled = budgetsWithReservations(budgetsAll);
  check(unsettled.length === 0, "no unsettled narration transaction",
    unsettled.length === 0 ? "0 chars reserved anywhere" : unsettled.join(", "));

  // ── Budgets ─────────────────────────────────────────────────────────
  const budgets = budgetsAll;
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

  // ── Upload disposition, not "youtubeId is null" ─────────────────────
  //
  // The previous assertion here was `!hbm.youtubeId → "HBM never uploaded"`.
  // That is false. The asset WAS accepted by YouTube as uVQ-vcJHWNk and the
  // process died before the id was persisted, so this check reported a green
  // tick over a live remote video. Local absence is not remote absence: the
  // remote channel is now queried and the result is classified.
  const intents = await prismaIntentStore.findByVideo(HBM);
  let remoteMatches: RemoteVideo[] = [];
  let remoteChecked = true;
  try {
    const port = createGoogleYouTubePort();
    const uploads = await port.listChannelUploads();
    remoteMatches = uploads.filter(
      (v) =>
        v.channelId === CHANNELS["ai-doom-scroll"].id &&
        (v.title ?? "").includes(HBM_EXPECTED_TITLE),
    );
  } catch (err) {
    remoteChecked = false;
    console.log(`      remote check FAILED: ${err instanceof Error ? err.message : err}`);
  }

  const quarantinedNow = (await prisma.jobQuarantine.count({
    where: { videoId: HBM, releasedAt: null },
  })) === 1;
  const visualUnchanged = (await prisma.qaRecord.count({
    where: { videoId: HBM, overall: "VISUAL_SOURCE_INCOMPATIBLE_WITH_CURRENT_LIBRARY" },
  })) > 0;
  const resumableNow = (await resumableJobs("ai-doom-scroll")).some((j) => j.id === HBM);

  const uploadDisposition = classifyUploadDisposition({
    localYoutubeId: hbm?.youtubeId ?? null,
    intents,
    remoteMatches,
  });

  // An unverifiable remote is itself a failure — the suite must not report a
  // clean state it could not establish.
  check(remoteChecked, "HBM remote state verifiable", remoteChecked ? "queried YouTube ✓" : "COULD NOT QUERY YOUTUBE");
  check(
    !uploadDisposition.blocking,
    "HBM upload disposition",
    `${uploadDisposition.disposition} — ${uploadDisposition.detail}`,
  );
  // Report the constituent facts separately. The suite may go green once the
  // orphan is durably represented, but it must never imply marker-backed or
  // hash-verified provenance that does not exist.
  const hist = intents.find((i) => i.state === "RECONCILED_HISTORICAL_UPLOAD");
  if (hist || uploadDisposition.remoteIds.length > 0) {
    const f = (label: string, value: string) =>
      console.log(`      ${label.padEnd(46)} ${value}`);
    f("remote YouTube identity verified", remoteChecked ? "yes" : "NOT VERIFIABLE");
    f("local youtubeId persisted", hbm?.youtubeId ? `yes (${hbm.youtubeId})` : "no");
    f("historical orphan reconciled", hist ? `yes (intent ${hist.id})` : "no");
    f("remote correlation marker present",
      hist ? (hist.remoteMarkerPresent ? "yes" : "no — predates mechanism") : "n/a");
    f("exact uploaded file hash verified",
      hist ? (hist.fileHashVerified ? "yes" : "NO — inferred only, not cryptographic") : "n/a");
    f("exact uploaded manifest hash verified",
      hist ? (hist.manifestHashVerified ? "yes" : "NO — no manifest existed at upload time") : "n/a");
    if (hist?.inferredFileSha256) {
      f("best-supported candidate file sha256", `${hist.inferredFileSha256.slice(0, 24)}… (INFERRED)`);
    }
    f("quarantine active", quarantinedNow ? "yes" : "NO");
    f("visual-source incompatibility unchanged", visualUnchanged ? "yes" : "NO");
    f("resumable", resumableNow ? "YES — UNEXPECTED" : "no");
  }

  // No asset anywhere may sit on an unresolved intent.
  const openIntents = await prismaIntentStore.listUnresolved();
  check(
    openIntents.length === 0,
    "no unresolved upload intents",
    openIntents.length === 0
      ? "none"
      : openIntents.map((i) => `${i.videoId}:${i.state}`).join(", "),
  );
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
  // Authorization, not absence.
  //
  // This previously asserted "no other Phase 6 asset started", which was
  // written while Phase 6 was paused with only ai1 in existence. Once ai1r was
  // explicitly authorized the assertion reported a violation for doing exactly
  // what was approved. Deleting it would have removed the only guard against
  // an unapproved asset appearing, so it now checks authorization instead.
  //
  // The authorized set is derived from the asset table in scripts/qualify.ts —
  // the same durable configuration the runner itself uses — rather than from a
  // hardcoded exception, so authorizing a future asset needs no edit here.
  const authorized = new Set(AUTHORIZED_PHASE6_ASSETS.map((a) => a.topicUrl));
  const unauthorized = qualTopics.flatMap((t) =>
    t.videos
      .filter((v) => v.id !== HBM && !authorized.has(t.url))
      .map((v) => `${t.title} → ${v.id} (${v.status})`),
  );
  check(
    unauthorized.length === 0,
    "no unauthorized Phase 6 asset started",
    unauthorized.length === 0
      ? `only authorized assets exist (${AUTHORIZED_PHASE6_ASSETS.map((a) => a.key).join(", ")})`
      : unauthorized.join("; "),
  );

  // Report the state of each authorized attempt truthfully.
  for (const spec of AUTHORIZED_PHASE6_ASSETS) {
    const topic = qualTopics.find((t) => t.url === spec.topicUrl);
    const row = topic?.videos.find((v) => v.id !== HBM);
    if (!row) {
      console.log(`      ${spec.key.padEnd(6)} authorized, not started`);
      continue;
    }
    const [charges, intents, qa] = await Promise.all([
      prisma.elevenLabsUsage.aggregate({ _sum: { chargedChars: true }, where: { videoId: row.id } }),
      prisma.uploadIntent.count({ where: { videoId: row.id } }),
      prisma.qaRecord.count({ where: { videoId: row.id } }),
    ]);
    const resumable = (await resumableJobs("ai-doom-scroll")).some((j) => j.id === row.id);
    console.log(
      `      ${spec.key.padEnd(6)} authorized | ${row.status} | ` +
      `credits=${charges._sum.chargedChars ?? 0} | render=${row.videoPath ? "yes" : "none"} | ` +
      `approvals=${qa} | intents=${intents} | youtubeId=${row.youtubeId ?? "none"} | ` +
      `resumable=${resumable ? "YES" : "no"}`,
    );
  }

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
