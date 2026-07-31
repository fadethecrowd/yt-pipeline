/**
 * Final disposition for AI Doom qualification asset #1 (the HBM memory
 * bottleneck topic).
 *
 *   npx tsx scripts/record-hbm-disposition.ts [--apply]
 *
 * The asset's audio, captions and content all passed. Its visual relevance
 * logic and beat-pacing architecture both worked as designed — the timeline
 * contains no looped, reused, frozen or off-topic footage. What failed is the
 * SOURCE LIBRARY: Pexels does not carry enough distinct HBM, wafer, packaging
 * or semiconductor-production footage to cover a 7-minute runtime, so 15 of 39
 * beats (38.5%) fell back to branded cards against a 15% cap.
 *
 * The remedies that would have forced it through — lowering the relevance
 * threshold, reusing assets, looping, or accepting the card share — all reduce
 * quality below the accepted standard, so the asset is withdrawn from active
 * Phase 6 qualification instead.
 *
 * Nothing is deleted. The script, narration, generation IDs, every V1–V4 render
 * artifact, scene manifests, QA records, failure evidence, immutable hashes and
 * credit records are all preserved; this script only WRITES a terminal record
 * describing what happened.
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

/** AI Doom qualification asset #1 — "The AI Chip Shortage Moved From GPUs to Memory". */
export const HBM_VIDEO_ID = "cms9970di0002mbti2m9avpui";

export const DISPOSITION = "VISUAL_SOURCE_INCOMPATIBLE_WITH_CURRENT_LIBRARY";

/**
 * The disposition payload. Written to `qa_record.checks` so it is queryable
 * alongside the QA history rather than living only in a commit message.
 */
export function buildDisposition(evidence: {
  sceneCount: number;
  cardCount: number;
  uniqueAssets: number;
  runtimeS: number;
  creditsCharged: number;
  generationIds: string[];
  renderArtifacts: string[];
  priorQaRecordIds: string[];
  approvedHashes: { qaRecordId: string; fileSha256: string; manifestSha256: string }[];
}) {
  const cardPct = (evidence.cardCount / evidence.sceneCount) * 100;
  return {
    disposition: DISPOSITION,
    assetKey: "ai1",
    topic: "The AI Chip Shortage Moved From GPUs to Memory",

    // ── What passed ──────────────────────────────────────────────────
    audio: "PASS",
    captions: "PASS",
    content: "PASS",
    visualRelevanceLogic: "FUNCTIONING",
    visualPacingArchitecture: "FUNCTIONING",

    // ── What failed ──────────────────────────────────────────────────
    finalVisualCoverage: "FAIL",
    failureCategory: "insufficient unique relevant source material",
    currentSourceLimitation:
      "Pexels lacks adequate HBM, wafer, packaging, and semiconductor-production footage",
    rejectedRemedies:
      "Further threshold reduction, footage reuse, looping, or excessive cards would "
      + "reduce quality below the accepted standard",

    // ── Status ───────────────────────────────────────────────────────
    removedFromActivePhase6Qualification: true,
    narrationRetained:
      "Narration retained for possible future reuse with an improved visual source",
    deleted: "nothing",

    // ── Measured evidence ────────────────────────────────────────────
    evidence: {
      runtimeS: evidence.runtimeS,
      beatsRendered: evidence.sceneCount,
      fallbackCards: evidence.cardCount,
      fallbackCardPct: Number(cardPct.toFixed(1)),
      fallbackCardCapPct: 15,
      uniqueAssetsAvailable: evidence.uniqueAssets,
      loopedAssets: 0,
      reusedAssets: 0,
      creditsCharged: evidence.creditsCharged,
      generationIds: evidence.generationIds,
      renderArtifactsPreserved: evidence.renderArtifacts,
      priorQaRecordIds: evidence.priorQaRecordIds,
      approvedHashes: evidence.approvedHashes,
    },

    // ── Upload state ─────────────────────────────────────────────────
    uploads: {
      v2Uploaded: false,
      v3Uploaded: false,
      v4Uploaded: false,
      note:
        "No render of this asset was uploaded by this disposition run. The only "
        + "YouTube artifact associated with the failed attempt stays private and "
        + "unchanged.",
    },
  };
}

async function main() {
  const apply = process.argv.includes("--apply");

  const video = await prisma.video.findUnique({
    where: { id: HBM_VIDEO_ID },
    include: { topic: true },
  });
  if (!video) throw new Error(`No Video row ${HBM_VIDEO_ID}`);

  // ── Collect the evidence that must be preserved ─────────────────────
  const usage = await prisma.elevenLabsUsage.findMany({
    where: { videoId: HBM_VIDEO_ID },
    orderBy: [{ segmentIndex: "asc" }, { attempt: "asc" }],
  });
  const generationIds = [...new Set(usage.map((u) => u.generationId).filter(Boolean))] as string[];
  const creditsCharged = usage.reduce((a, u) => a + (u.chargedChars ?? 0), 0);

  const scenes = await prisma.sceneRecord.findMany({ where: { videoId: HBM_VIDEO_ID } });
  const cardCount = scenes.filter((s) => s.assetSource === "branded-card").length;
  const uniqueAssets = new Set(scenes.map((s) => s.assetId).filter(Boolean)).size;

  const priorQa = await prisma.qaRecord.findMany({
    where: { videoId: HBM_VIDEO_ID },
    orderBy: { createdAt: "asc" },
  });
  const approvedHashes = priorQa
    .map((q) => {
      const ap = (q.checks as Record<string, any>)?.approvedArtifact;
      return ap
        ? { qaRecordId: q.id, fileSha256: ap.fileSha256, manifestSha256: ap.manifestSha256 }
        : null;
    })
    .filter(Boolean) as { qaRecordId: string; fileSha256: string; manifestSha256: string }[];

  const latestRuntime = priorQa.filter((q) => q.runtimeS).slice(-1)[0]?.runtimeS ?? 0;

  const disposition = buildDisposition({
    sceneCount: scenes.length,
    cardCount,
    uniqueAssets,
    runtimeS: latestRuntime,
    creditsCharged,
    generationIds,
    renderArtifacts: [
      "output/cms9970di0002mbti2m9avpui/final-v1-FAILED-VISUAL-QA.mp4",
      "output/cms9970di0002mbti2m9avpui/final-clean-v1.mp4",
      "output/cms9970di0002mbti2m9avpui/final-v2-FAILED-MANUAL-QA.mp4",
      "output/cms9970di0002mbti2m9avpui/final-clean.mp4",
      "output/cms9970di0002mbti2m9avpui/final.mp4",
      "output/cms9970di0002mbti2m9avpui/render-v1.log",
      "output/cms9970di0002mbti2m9avpui/frames/",
      "audio/cms9970di0002mbti2m9avpui/ (narration + alignments)",
    ],
    priorQaRecordIds: priorQa.map((q) => q.id),
    approvedHashes,
  });

  console.log(`\n═══ HBM QUALIFICATION ASSET — FINAL DISPOSITION ═══`);
  console.log(JSON.stringify(disposition, null, 2));

  if (!apply) {
    console.log("\n(dry run — pass --apply to write the terminal qualification record)");
    return;
  }

  // The disposition is a NEW terminal record. Prior QA records are left exactly
  // as they are: they are the failure evidence.
  const record = await prisma.qaRecord.create({
    data: {
      channel: "ai-doom-scroll",
      testStage: "QUALIFICATION",
      videoId: HBM_VIDEO_ID,
      assetKind: "LONGFORM",
      runtimeS: latestRuntime,
      creditsCharged,
      generationIds,
      audioResult: "PASS",
      captionResult: "PASS",
      visualResult: "FAIL",
      metadataResult: "PASS",
      uploadResult: "NOT_UPLOADED",
      overall: DISPOSITION,
      failureNotes:
        "Final visual coverage FAIL — insufficient unique relevant source material. "
        + "Pexels lacks adequate HBM, wafer, packaging and semiconductor-production footage. "
        + `${cardCount}/${scenes.length} beats (${((cardCount / scenes.length) * 100).toFixed(1)}%) `
        + "fell back to branded cards against a 15% cap. Audio, captions and content all PASS; "
        + "visual relevance logic and visual pacing architecture both functioning.",
      requiredRepair:
        "Improved visual source required. Further threshold reduction, footage reuse, "
        + "looping or excessive cards would reduce quality below the accepted standard. "
        + "Asset removed from active Phase 6 qualification; narration retained for possible "
        + "future reuse with an improved visual source.",
      reviewer: "Max (decision) via Claude Code — no artifact deleted, no render uploaded",
      checks: disposition as unknown as object,
    },
  });

  console.log(`\n✓ terminal qualification record written: ${record.id}`);
  console.log(`  overall = ${DISPOSITION}`);
}

main()
  .catch((e) => {
    console.error("\nDISPOSITION RUN FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
