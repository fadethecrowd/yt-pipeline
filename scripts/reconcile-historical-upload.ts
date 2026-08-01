/**
 * One-off historical reconciliation for the ai1 HBM remote orphan.
 *
 *   npx tsx scripts/reconcile-historical-upload.ts          # dry run
 *   npx tsx scripts/reconcile-historical-upload.ts --apply  # transactional write
 *
 * uVQ-vcJHWNk is the ai1 HBM qualification asset. It exists privately on
 * AI Doom Scroll and its YouTube identity is independently verifiable, but it
 * predates the correlation-marker mechanism and no surviving record binds it
 * to specific uploaded bytes — the immutable-approval mechanism landed after
 * the upload. It is therefore adopted as RECONCILED_HISTORICAL_UPLOAD, which
 * blocks further uploads exactly like a completed one while declining to claim
 * marker-backed or hash-verified provenance.
 *
 * Writes exactly two rows: one upload_intent, and youtubeId on the HBM Video
 * row. Quarantine, status, QA records, scene records, credit rows and render
 * artifacts are untouched. No YouTube call mutates anything.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  prisma, disconnect, CHANNELS, createGoogleYouTubePort, correlationIdFromTags,
} from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const HBM_VIDEO_ID = "cms9970di0002mbti2m9avpui";
const YOUTUBE_ID = "uVQ-vcJHWNk";
const ASSET_KEY = "ai1";
const CHANNEL_KEY = "ai-doom-scroll" as const;
/** Local correlation id. Retrospective and local-only — NOT in the remote tags. */
const LOCAL_CORRELATION_ID = `local-historical-${ASSET_KEY}-${YOUTUBE_ID}`;
/** Best-supported candidate artifact: uniquely matches the upload-run runtime. */
const CANDIDATE = `output/${HBM_VIDEO_ID}/final-v2-FAILED-MANUAL-QA.mp4`;

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`\n═══ HISTORICAL RECONCILIATION — ${apply ? "APPLY" : "DRY RUN"} ═══\n`);

  // ── Preconditions, all read-only ──────────────────────────────────────
  const video = await prisma.video.findUnique({ where: { id: HBM_VIDEO_ID } });
  if (!video) throw new Error(`HBM video row ${HBM_VIDEO_ID} is missing — stopping`);
  if (video.youtubeId) {
    console.log(`  video row already has youtubeId=${video.youtubeId} — nothing to do`);
    return;
  }
  const existingIntents = await prisma.uploadIntent.findMany({ where: { videoId: HBM_VIDEO_ID } });
  if (existingIntents.length > 0) {
    throw new Error(`${existingIntents.length} upload intent(s) already exist for HBM — stopping`);
  }
  const dupes = await prisma.video.count({ where: { youtubeId: YOUTUBE_ID } });
  const dupesWc = await prisma.wcVideo.count({ where: { youtubeId: YOUTUBE_ID } });
  if (dupes + dupesWc !== 0) throw new Error(`${dupes + dupesWc} row(s) already claim ${YOUTUBE_ID} — stopping`);

  const quarantine = await prisma.jobQuarantine.findFirst({
    where: { videoId: HBM_VIDEO_ID, releasedAt: null },
  });
  if (!quarantine) throw new Error("HBM is not quarantined — stopping rather than adopting a live asset");

  // ── Remote verification, read-only ────────────────────────────────────
  const port = createGoogleYouTubePort();
  const remote = await port.getVideo(YOUTUBE_ID);
  if (!remote) throw new Error(`${YOUTUBE_ID} is not visible to this credential — stopping`);
  const spec = CHANNELS[CHANNEL_KEY];
  const problems: string[] = [];
  if (remote.channelId !== spec.id) problems.push(`channel ${remote.channelId} != ${spec.id}`);
  if (remote.privacyStatus !== "private") problems.push(`privacy ${remote.privacyStatus} != private`);
  if (remote.publishAt) problems.push(`publishAt ${remote.publishAt} present`);
  if (problems.length) throw new Error(`remote does not match expectations: ${problems.join("; ")}`);

  const markerInRemote = correlationIdFromTags(remote.tags);

  // ── Inferred artifact binding ─────────────────────────────────────────
  const candidateExists = existsSync(CANDIDATE);
  const inferredFileSha256 = candidateExists ? await sha256File(CANDIDATE) : null;

  const evidenceNote =
    `Historical reconciliation of a pre-marker remote upload. VERIFIED: YouTube id ${YOUTUBE_ID}, ` +
    `channel ${remote.channelId} (${spec.title}), privacyStatus=${remote.privacyStatus}, ` +
    `publishAt absent, duration ${remote.durationS}s, publishedAt ${remote.publishedAt}; ` +
    `QaRecord cms9bvq98000bmbrkv7rfrv0n (created 2026-07-31T19:21:07.245Z) independently records ` +
    `youtubeId=${YOUTUBE_ID}, privacyStatus=private, verifiedChannelId=${spec.id}, uploadResult=PASS. ` +
    `NOT VERIFIED: which exact bytes were sent. The immutable-approval mechanism (commit b9d158c, ` +
    `2026-07-31T19:54:45Z) landed AFTER the upload, so no fileSha256 or scene-manifest hash was ` +
    `recorded at upload time and no scene manifest existed. Candidate ${CANDIDATE} is the ` +
    `best-supported artifact solely because its runtime (435.166667s) uniquely matches the ` +
    `upload-run QA record among the five preserved renders; that is circumstantial, not ` +
    `cryptographic. The correlationId on this row is LOCAL and RETROSPECTIVE — the remote video ` +
    `carries no correlation marker (remote tags: ${remote.tags.join(", ") || "none"}).`;

  // ── Show the exact writes ─────────────────────────────────────────────
  const intentData = {
    correlationId: LOCAL_CORRELATION_ID,
    channel: CHANNEL_KEY,
    channelId: spec.id,
    testStage: "QUALIFICATION" as const,
    format: "LONGFORM",
    assetKey: ASSET_KEY,
    videoId: HBM_VIDEO_ID,
    sourceTable: "video",
    fileSha256: null,
    manifestSha256: null,
    metadataFingerprint: "unknown-historical",
    expectedTitle: remote.title ?? "",
    expectedPrivacy: "private",
    publishAtAbsent: true,
    expectedDurationS: remote.durationS,
    durationToleranceS: 2,
    state: "RECONCILED_HISTORICAL_UPLOAD" as const,
    youtubeId: YOUTUBE_ID,
    remoteEtag: remote.etag ?? null,
    remotePublishedAt: remote.publishedAt ? new Date(remote.publishedAt) : null,
    adopted: true,
    provenance: "HISTORICAL_RECONCILIATION",
    remoteMarkerPresent: false,
    fileHashVerified: false,
    manifestHashVerified: false,
    inferredFileSha256,
    inferredManifestSha256: null,
    evidenceNote,
    reconcileNote:
      "Adopted retrospectively. Terminal and upload-blocking; asset remains quarantined and " +
      "visually disqualified. Status deliberately left at ASSEMBLY_DONE — resumability is " +
      "prevented by the active quarantine, which resumableJobs() excludes.",
    resolvedAt: new Date(),
  };

  console.log("  WRITE 1 — INSERT upload_intent:");
  for (const [k, v] of Object.entries(intentData)) {
    const s = v instanceof Date ? v.toISOString() : String(v);
    console.log(`    ${k.padEnd(23)} ${s.length > 108 ? s.slice(0, 108) + "…" : s}`);
  }
  console.log(`\n  WRITE 2 — UPDATE Video ${HBM_VIDEO_ID}:`);
  console.log(`    youtubeId               NULL -> ${YOUTUBE_ID}`);
  console.log(`    status                  ${video.status} (UNCHANGED)`);
  console.log(`    everything else         UNCHANGED`);
  console.log(`\n  UNTOUCHED: quarantine ${quarantine.id}, QA records, scene records, ` +
    `credit rows, render artifacts, YouTube metadata/privacy/tags/schedule.`);
  console.log(`  remote correlation marker: ${markerInRemote ?? "NONE (predates mechanism) ✓"}`);

  if (!apply) {
    console.log("\n  DRY RUN — nothing written. Re-run with --apply to commit.\n");
    return;
  }

  // ── Transactional write ───────────────────────────────────────────────
  const result = await prisma.$transaction(async (tx) => {
    const intent = await tx.uploadIntent.create({ data: intentData });
    const updated = await tx.video.updateMany({
      where: { id: HBM_VIDEO_ID, youtubeId: null },
      data: { youtubeId: YOUTUBE_ID },
    });
    if (updated.count !== 1) {
      throw new Error(`expected to update exactly 1 Video row, updated ${updated.count} — rolling back`);
    }
    const claimants = await tx.video.count({ where: { youtubeId: YOUTUBE_ID } });
    if (claimants !== 1) {
      throw new Error(`expected exactly 1 Video row claiming ${YOUTUBE_ID}, found ${claimants} — rolling back`);
    }
    const stillQuarantined = await tx.jobQuarantine.count({
      where: { videoId: HBM_VIDEO_ID, releasedAt: null },
    });
    if (stillQuarantined !== 1) {
      throw new Error(`quarantine count is ${stillQuarantined}, expected 1 — rolling back`);
    }
    return { intentId: intent.id, videoRowsUpdated: updated.count, claimants, stillQuarantined };
  });

  console.log("\n  ✓ TRANSACTION COMMITTED");
  console.log(`    upload_intent inserted   : 1 (${result.intentId})`);
  console.log(`    Video rows updated       : ${result.videoRowsUpdated}`);
  console.log(`    rows claiming ${YOUTUBE_ID}: ${result.claimants}`);
  console.log(`    active quarantines       : ${result.stillQuarantined}\n`);
}

main()
  .catch((e) => {
    console.error("\nRECONCILIATION FAILED (nothing committed):", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => disconnect());
