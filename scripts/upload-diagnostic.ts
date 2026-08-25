/**
 * Private upload of an already-rendered diagnostic.
 *
 *   npx tsx scripts/upload-diagnostic.ts <ai-doom-scroll|wet-circuit> [--dry]
 *
 * Uploads ONLY an existing render. It never generates narration, never renders,
 * and never calls ElevenLabs. Every pre-flight check must pass or it aborts.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { VideoStatus } from "@prisma/client";
import {
  prisma, disconnect, buildYouTubeClient,
  verifyChannel, CHANNELS, currentTestStage, isTestStage,
  creditsChargedFor, generationIdsFor, breakerStatus, isRealYoutubeId,
} from "@yt-pipeline/pipeline-core";
import "dotenv/config";

type ChannelKey = "ai-doom-scroll" | "wet-circuit";

const TITLES: Record<ChannelKey, string> = {
  "ai-doom-scroll": "[PRIVATE DIAGNOSTIC] AI Doom Scroll Sync and Visual QA",
  "wet-circuit": "[PRIVATE DIAGNOSTIC] Wet Circuit Sync and Visual QA",
};

/** Allows a corrected re-run to be labelled distinctly (e.g. V2). */
function titleFor(channel: ChannelKey): string {
  return process.env.DIAGNOSTIC_TITLE?.trim() || TITLES[channel];
}

const DESCRIPTION = [
  "PRIVATE DIAGNOSTIC RENDER — not for publication.",
  "",
  "Stage-1 pipeline verification asset. Caption/audio synchronisation is",
  "measured at three natural anchor sentences near the beginning, middle and",
  "end; the script also varies pace and pause length deliberately.",
  "",
  "This video is not channel content and must remain private.",
].join("\n");

function fail(msg: string): never {
  console.error(`\n✗ PRE-FLIGHT FAILED: ${msg}\n`);
  process.exit(1);
}

async function main() {
  const channel = process.argv[2] as ChannelKey;
  const dry = process.argv.includes("--dry");
  if (channel !== "ai-doom-scroll" && channel !== "wet-circuit") {
    console.error("usage: upload-diagnostic.ts <ai-doom-scroll|wet-circuit> [--dry]");
    process.exit(2);
  }
  const isWc = channel === "wet-circuit";
  const spec = CHANNELS[channel];

  console.log(`\n═══ PRIVATE DIAGNOSTIC UPLOAD — ${channel} ═══\n`);

  // ── 1. Locate the approved render via its passing QA record ──────────
  const qa = await prisma.qaRecord.findFirst({
    where: { channel, testStage: "DIAGNOSTIC", overall: "PASS", assetKind: "LONGFORM" },
    orderBy: { createdAt: "desc" },
  });
  if (!qa) fail(`no passing DIAGNOSTIC QA record for ${channel}`);
  console.log(`  QA record        : ${qa!.id} (${qa!.createdAt.toISOString()})`);

  const video = isWc
    ? await prisma.wcVideo.findUnique({ where: { id: qa!.videoId } })
    : await prisma.video.findUnique({ where: { id: qa!.videoId } });
  if (!video) fail(`video row ${qa!.videoId} not found`);
  console.log(`  video row        : ${video!.id}`);

  // ── 2. Render artifact present and matching the QA record ────────────
  if (!video!.videoPath || !existsSync(video!.videoPath)) {
    fail(`render missing at ${video!.videoPath}`);
  }
  const st = statSync(video!.videoPath);
  const sha = createHash("sha256").update(readFileSync(video!.videoPath)).digest("hex");
  console.log(`  file             : ${video!.videoPath}`);
  console.log(`  size / sha256    : ${st.size} bytes / ${sha.slice(0, 16)}…`);

  const checks = (qa!.checks ?? []) as { name: string; passed: boolean; severity: string }[];
  const fatalFails = Array.isArray(checks)
    ? checks.filter((c) => !c.passed && c.severity === "FATAL")
    : [];
  if (fatalFails.length) fail(`QA record has ${fatalFails.length} FATAL failures`);
  console.log(`  QA              : PASS (${Array.isArray(checks) ? checks.length : "?"} checks, 0 fatal failures)`);
  console.log(`  caption offsets  : head=${qa!.captionOffsetHead}s mid=${qa!.captionOffsetMid}s tail=${qa!.captionOffsetTail}s`);
  console.log(`  durations        : video=${qa!.videoDurationS?.toFixed(3)}s audio=${qa!.audioDurationS?.toFixed(3)}s`);

  // ── 3. Audio reusable; zero new ElevenLabs requests needed ───────────
  const usage = await prisma.elevenLabsUsage.findMany({
    where: { videoId: video!.id, success: true, reused: false },
  });
  if (usage.length === 0) fail("no successful ElevenLabs generations recorded");
  for (const u of usage) {
    if (!u.outputPath || !existsSync(u.outputPath)) {
      fail(`segment ${u.segmentIndex} audio missing at ${u.outputPath}`);
    }
    const alignment = u.outputPath.replace(/\.mp3$/, ".alignment.json");
    if (!existsSync(alignment)) fail(`segment ${u.segmentIndex} alignment missing`);
  }
  const generationIds = await generationIdsFor(video!.id);
  const creditsBefore = await creditsChargedFor(video!.id);
  console.log(`  generations      : ${generationIds.length} reusable (${generationIds.join(", ")})`);
  console.log(`  credits so far   : ${creditsBefore} (upload requires 0 more)`);

  // ── 4. Test stage ────────────────────────────────────────────────────
  const stage = currentTestStage();
  if (stage !== "DIAGNOSTIC") fail(`TEST_STAGE is ${stage}, expected DIAGNOSTIC`);
  if (!isTestStage(stage)) fail("stage must force private uploads");
  console.log(`  TEST_STAGE       : ${stage} (forces private, no publishAt)`);

  // ── 5. No existing upload ────────────────────────────────────────────
  if (isRealYoutubeId(video!.youtubeId)) {
    fail(`already uploaded as ${video!.youtubeId} — refusing to duplicate`);
  }
  console.log(`  existing upload  : none`);

  // ── 6. Channel verification ──────────────────────────────────────────
  await verifyChannel(spec, `${channel}:diag-upload`);
  console.log(`  expected channel : ${spec.id} (${spec.title})`);

  // ── 7. Circuit breaker ───────────────────────────────────────────────
  const tripped = (await breakerStatus()).filter((b) => b.tripped);
  if (tripped.length) fail(`circuit breaker tripped: ${tripped.map((t) => t.channel).join(", ")}`);
  console.log(`  circuit breaker  : clear`);

  if (dry) {
    console.log(`\n  --dry given — all pre-flight checks passed, not uploading.\n`);
    await disconnect();
    return;
  }

  // ── 8. Upload ────────────────────────────────────────────────────────
  // Same builder step 6's verifyChannel() used. Uploading on a second
  // credential would have let the check pass on one channel and the video
  // land on another.
  const yt = buildYouTubeClient();

  console.log(`\n  uploading "${titleFor(channel)}" …`);
  const res = await yt.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: titleFor(channel),
        description: DESCRIPTION,
        categoryId: "28",
        tags: ["diagnostic", "internal", "qa"],
      },
      status: {
        privacyStatus: "private", // never anything else on a test stage
        selfDeclaredMadeForKids: false,
        // deliberately no publishAt
      },
    },
    media: { body: createReadStream(video!.videoPath) },
  });

  const youtubeId = res.data.id;
  if (!youtubeId) fail("YouTube returned no video id");

  // ── 9. Store the id (keeping the row quarantined) ────────────────────
  const data = { youtubeId } as Record<string, unknown>;
  if (isWc) await prisma.wcVideo.update({ where: { id: video!.id }, data: data as never });
  else await prisma.video.update({ where: { id: video!.id }, data: data as never });

  await prisma.qaRecord.update({
    where: { id: qa!.id },
    data: { youtubeId, privacyStatus: "private", verifiedChannelId: spec.id },
  });

  // ── 10. Post-flight verification against the API ─────────────────────
  console.log(`\n── post-upload verification ──`);
  const check = await yt.videos.list({ part: ["status", "snippet"], id: [youtubeId!] });
  const item = check.data.items?.[0];
  const privacy = item?.status?.privacyStatus ?? null;
  const owner = item?.snippet?.channelId ?? null;
  const publishAt = (item?.status as { publishAt?: string } | undefined)?.publishAt ?? null;

  console.log(`  youtube id       : ${youtubeId}`);
  console.log(`  watch url        : https://www.youtube.com/watch?v=${youtubeId}`);
  console.log(`  studio url       : https://studio.youtube.com/video/${youtubeId}/edit`);
  console.log(`  owning channel   : ${owner} ${owner === spec.id ? "✓ matches expected" : "✗ MISMATCH"}`);
  console.log(`  privacyStatus    : ${privacy} ${privacy === "private" ? "✓" : "✗ NOT PRIVATE"}`);
  console.log(`  publishAt        : ${publishAt ?? "none ✓"}`);
  console.log(`  title            : ${item?.snippet?.title}`);

  const dupA = await prisma.video.count({ where: { youtubeId } });
  const dupW = await prisma.wcVideo.count({ where: { youtubeId } });
  console.log(`  duplicate rows   : ${dupA + dupW} ${dupA + dupW === 1 ? "✓ exactly one" : "✗"}`);

  const creditsAfter = await creditsChargedFor(video!.id);
  console.log(`  credits charged  : ${creditsAfter} (was ${creditsBefore}, delta ${creditsAfter - creditsBefore}) ${creditsAfter === creditsBefore ? "✓ zero new" : "✗"}`);

  const q = await prisma.jobQuarantine.findFirst({ where: { videoId: video!.id, releasedAt: null } });
  console.log(`  quarantined      : ${q ? "yes ✓ (monitor will skip it)" : "NO — monitor may poll it"}`);

  const stillClear = (await breakerStatus()).filter((b) => b.tripped);
  console.log(`  circuit breaker  : ${stillClear.length === 0 ? "clear ✓" : "TRIPPED ✗"}`);

  const ok =
    owner === spec.id && privacy === "private" && !publishAt &&
    dupA + dupW === 1 && creditsAfter === creditsBefore && stillClear.length === 0;
  console.log(`\n═══ ${ok ? "VERIFIED" : "VERIFICATION FAILED"} ═══\n`);

  await disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await disconnect();
  process.exit(1);
});
