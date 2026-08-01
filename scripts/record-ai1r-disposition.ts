/**
 * Terminal disposition for ai1r.
 *
 *   npx tsx scripts/record-ai1r-disposition.ts          # dry run
 *   npx tsx scripts/record-ai1r-disposition.ts --apply
 *
 * ai1r passed every numeric feasibility check and failed semantic coverage:
 * the Pexels library holds abundant retail footage and abundant surveillance
 * footage but essentially nothing combining them, so the opening thesis beat
 * — "that camera above the cereal aisle" — has no asset showing a camera in a
 * store. Records the disposition and quarantines the asset fail-closed.
 *
 * Nothing is deleted: both scripts, both feasibility reports, the semantic
 * coverage report, the row and every QA record are preserved as evidence.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { prisma, disconnect, quarantineJob, resumableJobs, budgetReport } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const ROW = "cmsanc70m0002mb71194tnfcq";
const DISPOSITION = "VISUAL_SOURCE_INCOMPATIBLE_WITH_CURRENT_LIBRARY";
const EVIDENCE = [
  "output/ai1r-attempt-1-script.json",
  "output/ai1r-attempt-1-feasibility.json",
  "output/ai1r-attempt-1-analysis.json",
  "output/ai1r-attempt-2-script.json",
  "output/ai1r-attempt-2-feasibility.json",
  "output/ai1r-attempt-2-analysis.json",
  "output/ai1r-semantic-coverage.json",
];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`\n═══ ai1r DISPOSITION — ${apply ? "APPLY" : "DRY RUN"} ═══\n`);

  // ── Preconditions ────────────────────────────────────────────────────
  const v = await prisma.video.findUnique({ where: { id: ROW } });
  if (!v) throw new Error("ai1r row missing — stopping");
  if (v.youtubeId) throw new Error(`ai1r has youtubeId ${v.youtubeId} — stopping`);
  if (v.voiceoverPath || v.videoPath) throw new Error("ai1r has narration or render — stopping");
  if ((await prisma.uploadIntent.count({ where: { videoId: ROW } })) !== 0) {
    throw new Error("ai1r has an upload intent — stopping");
  }
  const charged = await prisma.elevenLabsUsage.aggregate({
    _sum: { chargedChars: true }, where: { videoId: ROW },
  });
  if ((charged._sum.chargedChars ?? 0) !== 0) throw new Error("ai1r has credit charges — stopping");

  const liveHash = sha(JSON.stringify(v.scriptJson, null, 2));
  const diskHash = sha(readFileSync("output/ai1r-attempt-2-script.json", "utf8"));
  if (liveHash !== diskHash) throw new Error("attempt-2 script drifted from preserved copy — stopping");
  for (const f of EVIDENCE) if (!existsSync(f)) throw new Error(`missing evidence ${f} — stopping`);

  const cov = JSON.parse(readFileSync("output/ai1r-semantic-coverage.json", "utf8"));
  const evidenceHashes = Object.fromEntries(
    EVIDENCE.map((f) => [f, sha(readFileSync(f, "utf8")).slice(0, 16)]),
  );

  const failureNotes =
    "Topic: computer-vision surveillance. Script attempt 2 (sha256 " + liveHash.slice(0, 16) + "). "
    + "Numeric feasibility PASS; semantic feasibility FAIL. "
    + `Supported beats ${cov.summary.supportedBeats}/${cov.beats.length}; `
    + `predicted cards ${cov.summary.cardBeats}/${cov.beats.length} `
    + `(${(cov.summary.cardPct * 100).toFixed(1)}%) against a 15% cap; `
    + "consecutive-card rule FAILED; unsupported high-salience beat: beat 1 "
    + '("That camera above the cereal aisle isn\'t just recording anymore"), which asserts '
    + "physical co-location and therefore requires a single asset showing both subject and setting. "
    + `Semantically accepted assets ${cov.summary.acceptedAssets}; `
    + `accepted usable duration ${cov.summary.acceptedSeconds.toFixed(1)}s; `
    + "brand-risk dependence: none. "
    + "Missing footage class: security/CCTV camera visibly present in a supermarket, store aisle, "
    + "checkout area or shop interior. Direct Pexels probing found abundant retail footage "
    + "(aisles, shoppers, self-checkout) and abundant surveillance footage (control rooms, traffic "
    + "cameras; 19 of 158 returned assets depict a camera as subject), but essentially no assets "
    + "combining the required retail setting with the surveillance-camera subject. "
    + "No ElevenLabs credits were spent; no render and no upload occurred.";

  const requiredRepair =
    "A visual source containing retail-surveillance footage is required. This classification is "
    + "scoped to the CURRENT Pexels-based library and is not a permanent rejection of the topic: "
    + "it may be revisited only if the available visual-source library materially changes. "
    + "Lowering the card cap, reusing assets, looping, or accepting semantically unrelated footage "
    + "would reduce quality below the accepted standard and are not permitted remedies.";

  console.log(failureNotes);
  console.log("\nEvidence preserved:");
  for (const [f, h] of Object.entries(evidenceHashes)) console.log(`  ${h}  ${f}`);

  if (!apply) {
    console.log("\n(dry run — pass --apply to write the disposition and quarantine)");
    return;
  }

  const record = await prisma.qaRecord.create({
    data: {
      channel: "ai-doom-scroll", testStage: "QUALIFICATION", videoId: ROW,
      assetKind: "LONGFORM",
      audioResult: "NOT_REACHED", captionResult: "NOT_REACHED",
      visualResult: "FAIL", metadataResult: "NOT_REACHED", uploadResult: "NOT_UPLOADED",
      overall: DISPOSITION,
      failureNotes,
      requiredRepair,
      reviewer: "Max (decision) via Claude Code — no artifact deleted, no credits spent",
      checks: { semanticCoverage: cov.summary, evidence: evidenceHashes,
                attempt2ScriptSha256: liveHash } as unknown as object,
    },
  });
  console.log(`\n  disposition record: ${record.id}`);

  const q = await quarantineJob({
    channel: "ai-doom-scroll", videoId: ROW, table: "Video",
    reason: "Phase 6 qualification asset ai1r — VISUAL_SOURCE_INCOMPATIBLE_WITH_CURRENT_LIBRARY; "
      + "never resume, narrate, render, poll or publish",
    operator: "Max", actionSource: "scripts/record-ai1r-disposition.ts",
  });
  console.log(`  quarantine: ${JSON.stringify(q)}`);

  // ── Verify fail-closed ───────────────────────────────────────────────
  const after = await prisma.video.findUnique({ where: { id: ROW } });
  const resumable = (await resumableJobs("ai-doom-scroll")).some((j) => j.id === ROW);
  const b = await budgetReport();
  console.log(`\n  status        : ${after?.status}`);
  console.log(`  resumable     : ${resumable ? "YES — UNEXPECTED" : "no ✓"}`);
  console.log(`  youtubeId     : ${after?.youtubeId ?? "none ✓"}`);
  console.log(`  upload intents: ${await prisma.uploadIntent.count({ where: { videoId: ROW } })}`);
  console.log(`  budgets with headroom: ${b.rows.filter((r) => r.remaining > 0).length}`);
  console.log(`  script preserved: ${Boolean(after?.scriptJson)}`);
}

main().catch((e) => { console.error("\nFAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => disconnect());
