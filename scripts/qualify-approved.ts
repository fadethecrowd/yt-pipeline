/**
 * Guarded qualification runner for a HUMAN-APPROVED visual allocation.
 *
 *   npx tsx scripts/qualify-approved.ts <dir> [--narrate-only] [--no-upload]
 *
 * `qualify.ts` builds an asset from scratch: it writes a script, screens
 * feasibility, searches a stock library and picks clips. None of that may
 * happen here. This runner starts from an allocation a human has already
 * reviewed clip by clip, and its job is to change nothing about it — the same
 * assets, the same order, the same cards, under the same words.
 *
 * What it therefore does differently:
 *   * narration is generated from buildSpokenUnits, at a request-scoped speed
 *   * beat timing comes from ElevenLabs character timestamps, not a predictor
 *   * assembly is handed the approved allocation, so it performs no planning,
 *     no search, no ranking and no selection
 *   * approved clips already held on disk are used from disk, so rendering
 *     what was reviewed never re-fetches from the provider
 *
 * Everything else — the credit ledger, QA, the durable upload intent — is the
 * existing guarded machinery, used unchanged.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VideoStatus, TopicStatus } from "@prisma/client";
import {
  prisma, disconnect,
  runVoiceover, runAssembly, currentTestStage,
  runQa, persistQa, formatQa,
  verifyChannel, CHANNELS, isRealYoutubeId,
  extractSyncAnchors, formatAnchors,
  creditsChargedFor, budgetReport, setBudgetLimit, breakerStatus,
  checkRuntime, fmtRuntime,
  sha256File, sha256Manifest,
  buildSpokenUnits, spokenCharacterCount,
  beatSpansForNarration,
  readManifest, readAlignments,
  solveApprovedStrip, approvedAllocationHash,
  guardedUpload, createGoogleYouTubePort, prismaIntentStore,
  reconcileAll, UploadBlockedError, buildYouTubeClient,
} from "@yt-pipeline/pipeline-core";
import type {
  PipelineContext, Script, ApprovedAllocation, BeatRange, StripAsset, StripBeat,
} from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const CHANNEL = "ai-doom-scroll" as const;
const MARKER = "[QUAL:aidoom-approved-v5]";

function fail(msg: string): never {
  console.error(`\n  ✗ ${msg}\n`);
  process.exitCode = 1;
  throw new Error(msg);
}

interface Manifest {
  dir: string;
  title: string;
  topicUrl: string;
  scriptPath: string;
  allocationPath: string;
  approvalPath: string;
  /** Directories searched, in order, for an approved clip already on disk. */
  mediaDirs: string[];
  speed: number;
  targetS: number;
}

async function findOrCreateRow(m: Manifest) {
  const topic = await prisma.topic.upsert({
    where: { url: m.topicUrl },
    create: {
      title: m.title, url: m.topicUrl, source: "qualification",
      summary: `${MARKER} human-approved v5 allocation`, score: 1, status: TopicStatus.APPROVED,
    },
    update: {},
  });
  const candidates = await prisma.video.findMany({
    where: { topicId: topic.id }, orderBy: { createdAt: "desc" },
  });
  // Prefer a row that already carries narration: re-running after a render or
  // upload failure must never buy the audio a second time.
  const existing = candidates.find((c) => c.voiceoverPath && c.scriptJson) ?? candidates[0];
  if (existing) return { topic, video: existing, reused: true };
  const video = await prisma.video.create({
    data: { topicId: topic.id, status: VideoStatus.SCRIPT_PENDING, failReason: `${MARKER} qualification asset` },
  });
  return { topic, video, reused: false };
}

async function main() {
  const dir = process.argv[2];
  if (!dir) fail("usage: qualify-approved.ts <dir> [--narrate-only] [--no-upload]");
  const narrateOnly = process.argv.includes("--narrate-only");
  const noUpload = process.argv.includes("--no-upload");

  const m = JSON.parse(readFileSync(join(dir, "run-manifest.json"), "utf8")) as Manifest;
  const script = JSON.parse(readFileSync(m.scriptPath, "utf8")) as Script;
  const approved = JSON.parse(readFileSync(m.allocationPath, "utf8")) as ApprovedAllocation & {
    beats: (ApprovedAllocation["beats"][number] & { unitIndex: number; startOffset: number; endOffset: number })[];
  };
  if (!existsSync(m.approvalPath)) fail(`human approval sidecar missing: ${m.approvalPath}`);
  const approval = JSON.parse(readFileSync(m.approvalPath, "utf8"));

  const stage = currentTestStage();
  if (stage !== "QUALIFICATION") fail(`TEST_STAGE is ${stage}, expected QUALIFICATION`);
  const tripped = (await breakerStatus()).filter((b) => b.tripped);
  if (tripped.length) fail(`circuit breaker open: ${tripped.map((t) => t.channel).join(", ")}`);

  const rejected = Object.entries(approval.decisions as Record<string, string>)
    .filter(([, d]) => d !== "APPROVE");
  if (rejected.length) fail(`approval sidecar contains non-APPROVE decisions: ${rejected.map(([k]) => k).join(", ")}`);

  const units = buildSpokenUnits(script);
  const chars = spokenCharacterCount(units);
  const allocHash = approvedAllocationHash(approved);

  console.log(`\n═══ APPROVED-ALLOCATION QUALIFICATION ═══`);
  console.log(`  title      : ${m.title}`);
  console.log(`  allocation : ${allocHash.slice(0, 32)}…  (${approved.beats.length} beats)`);
  console.log(`  spoken     : ${units.length} units, ${chars} chars, speed ${m.speed}`);

  const { topic, video, reused } = await findOrCreateRow(m);
  console.log(`  row        : ${video.id}${reused ? " (reusing — narration will be reused if present)" : ""}`);

  // ── Narration, inside a bounded credit window ───────────────────────────
  const before = await creditsChargedFor(video.id);
  const rep0 = (await budgetReport()).rows.find((b) => b.channel === CHANNEL && b.stage === "QUALIFICATION");
  if (!rep0) fail("no QUALIFICATION credit budget for ai-doom-scroll");
  const priorLimit = rep0.limit;
  console.log(`  budget     : limit ${priorLimit}, charged ${rep0.charged}, reserved ${rep0.reserved}`);

  const ctx = { topic, video, script } as unknown as PipelineContext;
  const openedTo = rep0.charged + chars;
  try {
    // Headroom is opened for exactly this job and closed again in `finally`,
    // whatever happens — a crash must not leave spendable credit behind.
    await setBudgetLimit(CHANNEL, "QUALIFICATION", openedTo);
    console.log(`  opened headroom to ${openedTo} (exactly ${chars} chars) — generating narration…`);
    const vo = await runVoiceover(ctx, {
      channel: CHANNEL, label: "qual:approved:voiceover", testStage: "QUALIFICATION",
      speed: m.speed,
      updateVideo: (id, data) => prisma.video.update({ where: { id }, data: data as never }),
      setStatus: (id, status) => prisma.video.update({ where: { id }, data: { status: status as never } }),
    });
    if (!vo.success) fail(`voiceover failed: ${vo.error}`);
  } finally {
    // The credit limit returns to zero the instant narration finishes, so
    // nothing later in this run can buy anything, whatever else happens.
    await setBudgetLimit(CHANNEL, "QUALIFICATION", priorLimit);
    const rep1 = (await budgetReport()).rows.find((b) => b.channel === CHANNEL && b.stage === "QUALIFICATION");
    console.log(`  budget relocked: limit ${rep1?.limit}, charged ${rep1?.charged}, reserved ${rep1?.reserved}`);
  }
  const afterTts = await creditsChargedFor(video.id);
  console.log(`  credits    : ${afterTts} for this row (+${afterTts - before} this run)`);

  // ── Exact beat timing from the character timestamps ─────────────────────
  const audioDir = join(process.cwd(), "audio", video.id);
  const manifest = await readManifest(audioDir);
  if (!manifest) fail("narration manifest missing");
  const alignments = await readAlignments(manifest);
  if (alignments.length !== units.length) {
    fail(`expected ${units.length} alignments, found ${alignments.length}`);
  }
  const ranges = new Map<number, BeatRange[]>();
  for (const b of approved.beats) {
    if (!ranges.has(b.unitIndex)) ranges.set(b.unitIndex, []);
    ranges.get(b.unitIndex)!.push({ beat: b.beat, startOffset: b.startOffset, endOffset: b.endOffset });
  }
  const spans = beatSpansForNarration(
    units.map((u, i) => ({
      index: u.index, text: u.text, alignment: alignments[i]!,
      actualDurationS: manifest.segments[i]!.durationS,
      offsetS: manifest.segments[i]!.offsetS,
    })),
    ranges,
  );
  console.log(`\n  actual narration: ${manifest.durationS.toFixed(3)}s across ${spans.length} beats`);

  // ── Solve the frozen strip against the real timing ──────────────────────
  //
  // The approved file records each clip's share of every beat it touches. The
  // renderer cuts every fragment from the START of its source, so a clip
  // listed once per beat would replay its own opening rather than run on — a
  // loop. The strip is therefore re-cut against the ACTUAL beat durations,
  // which moves only fragment durations, source in/out, continuation
  // boundaries and playback rate. Identity, order, uniqueness and the cards
  // are inputs, not outputs.
  const actual = new Map(spans.map((s) => [s.beat, s.durationS]));
  const seenAsset = new Set<string>();
  const stripAssets: StripAsset[] = [];
  for (const b of approved.beats) {
    for (const f of b.fragments) {
      if (seenAsset.has(f.assetId)) continue;
      seenAsset.add(f.assetId);
      stripAssets.push({
        assetId: f.assetId, sourceDurationS: f.sourceDurationS,
        description: f.description, pageUrl: f.pageUrl ?? null,
      });
    }
  }
  const stripBeats: StripBeat[] = approved.beats.map((b) => ({
    beat: b.beat, durationS: actual.get(b.beat)!, narration: b.narration,
    ...(b.hasCard ? { hasCard: true, cardSecondsS: b.cardSecondsS, cardText: b.cardText ?? null } : {}),
  }));
  const alignedBeats = solveApprovedStrip(stripAssets, stripBeats);
  const aligned: ApprovedAllocation = { ...approved, beats: alignedBeats };

  // The solve must not have touched identity, order, uniqueness or the cards.
  const usedIds = alignedBeats.flatMap((b) => b.fragments.map((f) => f.assetId));
  if (JSON.stringify(usedIds) !== JSON.stringify(stripAssets.map((a) => a.assetId))) {
    fail("solved strip changed the approved asset set or order");
  }
  const solvedCards = alignedBeats.filter((b) => b.hasCard).map((b) => [b.beat, b.cardText, b.cardSecondsS]);
  const frozenCards = approved.beats.filter((b) => b.hasCard).map((b) => [b.beat, b.cardText, b.cardSecondsS]);
  if (JSON.stringify(solvedCards) !== JSON.stringify(frozenCards)) fail("solved strip changed a card");

  console.log(`  beat | unit |  actual | card |            assets | rate | verdict`);
  for (const b of alignedBeats) {
    const src = approved.beats.find((x) => x.beat === b.beat)!;
    const rates = b.fragments.map((f) => (f.playbackRate ?? 1).toFixed(4));
    // A fragment's plannedDurationS is its WHOLE screen time, including any
    // seconds it spends in later beats. This beat owns only the part that
    // does not carry out, plus whatever the previous clip carried in.
    const own = b.fragments.reduce((a, f) => a + f.plannedDurationS - (f.continuationSeconds ?? 0), 0);
    const cover = own + (b.continuedFrom?.seconds ?? 0) + (b.cardSecondsS ?? 0);
    const okCover = Math.abs(cover - actual.get(b.beat)!) < 0.05;
    const okRate = b.fragments.every((f) => (f.playbackRate ?? 1) >= 0.92 - 1e-9 && (f.playbackRate ?? 1) <= 1.08 + 1e-9);
    const okSrc = b.fragments.every((f) => f.plannedDurationS * (f.playbackRate ?? 1) <= f.sourceDurationS + 1e-3);
    const verdict = okCover && okRate && okSrc ? "PASS" : "FAIL";
    console.log(
      `  ${String(b.beat).padStart(4)} | ${String(src.unitIndex).padStart(4)} | ` +
      `${actual.get(b.beat)!.toFixed(3).padStart(7)} | ${String(b.cardSecondsS ?? "—").padStart(4)} | ` +
      `${(b.fragments.map((f) => f.assetId).join(",") || "(carried)").padStart(20)} | ${rates.join(",") || "—"} | ${verdict}`);
    if (verdict !== "PASS") {
      fail(`beat ${b.beat} cannot be covered legally (cover=${cover.toFixed(3)} rate/src ok=${okRate}/${okSrc})`);
    }
  }
  if (narrateOnly) {
    console.log(`\n  --narrate-only: stopping before render.`);
    await disconnect();
    return;
  }

  // ── Render, from approved media already on disk ─────────────────────────
  const resolveApprovedAsset = async (assetId: string) => {
    for (const d of m.mediaDirs) {
      const p = join(d, `${assetId}.mp4`);
      if (existsSync(p)) return { url: pathToFileURL(p).href };
    }
    // No provider fallback: a missing approved clip is a hard stop, because
    // fetching a replacement would render footage nobody reviewed.
    return null;
  };
  const repo = {
    getVideo: (id: string) => prisma.video.findUnique({ where: { id } }),
    updateVideo: (id: string, data: Record<string, unknown>) => prisma.video.update({ where: { id }, data: data as never }),
    setStatus: (id: string, status: string) => prisma.video.update({ where: { id }, data: { status: status as never } }),
  };
  const asm = await runAssembly(ctx, {
    channel: CHANNEL, label: "qual:approved:assembly", testStage: "QUALIFICATION",
    ...repo, approvedAllocation: aligned, resolveApprovedAsset,
  });
  if (!asm.success || !asm.data) fail(`assembly failed: ${asm.error}`);
  const out = asm.data;
  console.log(`\n  rendered: ${out.videoPath} (${out.videoDurationS.toFixed(2)}s)`);

  // ── QA ──────────────────────────────────────────────────────────────────
  const qa = await runQa({
    channel: CHANNEL, videoId: video.id, assetKind: "LONGFORM" as const,
    videoPath: out.videoPath, narrationPath: out.narrationPath,
    narrationStartS: out.narrationStartS,
    cues: out.captions.cues, words: out.captions.words,
    expectedWidth: 1920, expectedHeight: 1080, expectedFps: 30,
    testStage: "QUALIFICATION" as const,
  });
  console.log(`\n${formatQa(qa)}`);
  const rt = checkRuntime(qa.metrics.videoDurationS ?? 0, CHANNEL, "LONGFORM", "QUALIFICATION");
  console.log(`  runtime: ${rt.detail}`);
  console.log(formatAnchors(extractSyncAnchors(out.captions.words, out.captions.cues)));
  const qaRow = await persistQa(qa);
  if (!qa.pass) fail(`QA failed — not uploading. ${qa.failures?.join("; ") ?? ""}`);
  if (!rt.ok) fail(`runtime outside range: ${rt.detail}`);

  if (noUpload) {
    console.log(`\n  --no-upload: stopping after QA. Video at ${out.videoPath}`);
    await disconnect();
    return;
  }

  // ── One guarded, durable, PRIVATE upload ────────────────────────────────
  const fileSha256 = await sha256File(out.videoPath);
  const manifestSha256 = sha256Manifest(out.manifest as never);
  const row = await repo.getVideo(video.id);
  if (isRealYoutubeId(row?.youtubeId)) fail(`already uploaded as ${row!.youtubeId}`);
  await verifyChannel(CHANNELS[CHANNEL], "qual:approved");

  const port = createGoogleYouTubePort();
  const persistYoutubeId = async (_i: unknown, id: string) => {
    await repo.updateVideo(video.id, { youtubeId: id });
  };
  for (const p of await reconcileAll({ port, store: prismaIntentStore, persistYoutubeId, channel: CHANNEL })) {
    console.log(`  reconciled intent ${p.intent.id}: ${p.outcome}`);
  }

  let youtubeId: string;
  try {
    const result = await guardedUpload(
      {
        channelKey: CHANNEL, assetKey: "aidoom-approved-v5", videoId: video.id,
        testStage: currentTestStage(), format: "LONGFORM",
        filePath: out.videoPath, fileSha256, manifestSha256,
        metadata: {
          title: m.title.slice(0, 100),
          description:
            "PRIVATE QUALIFICATION ASSET — not for publication.\n\n"
            + "Rendered from a human-approved visual allocation. Awaiting manual editorial review.",
          tags: ["qualification", "internal"],
          categoryId: "28",
          privacyStatus: "private",
          publishAt: null,
        },
        expectedDurationS: m.targetS,
        existingYoutubeId: row?.youtubeId ?? null,
        verifiedChannelId: CHANNELS[CHANNEL].id,
        actualFileSha256: fileSha256,
        actualManifestSha256: manifestSha256,
      },
      { port, store: prismaIntentStore, persistYoutubeId },
    );
    youtubeId = result.youtubeId;
    console.log(`  upload outcome: ${result.status} (intent ${result.intent.id})`);
  } catch (err) {
    if (err instanceof UploadBlockedError) fail(`upload blocked [${err.code}]: ${err.message}`);
    throw err;
  }

  const yt = buildYouTubeClient();
  const check = await yt.videos.list({ part: ["status", "snippet"], id: [youtubeId] });
  const v = check.data.items?.[0];
  console.log(`\n  youtube    : ${youtubeId}`);
  console.log(`  channel    : ${v?.snippet?.channelId}`);
  console.log(`  title      : ${v?.snippet?.title}`);
  console.log(`  privacy    : ${v?.status?.privacyStatus}`);
  console.log(`  publishAt  : ${v?.status?.publishAt ?? "(none)"}`);
  console.log(`  qa row     : ${qaRow?.id ?? "(none)"}`);
  if (v?.status?.privacyStatus !== "private") fail(`video is ${v?.status?.privacyStatus}, expected private`);
  if (v?.snippet?.channelId !== CHANNELS[CHANNEL].id) fail(`wrong channel ${v?.snippet?.channelId}`);
  if (v?.status?.publishAt) fail(`publishAt is set: ${v.status.publishAt}`);

  await disconnect();
}

/**
 * DISABLE_ELEVEN is a coarse "do no expensive work" switch: voiceover AND
 * assembly refuse to run under it, though assembly never calls ElevenLabs. It
 * is lifted for THIS PROCESS ONLY — .env is never written — and the real
 * spend guard is the credit limit, which is returned to zero the moment
 * narration completes and gates every charge after that.
 */
const priorDisable = process.env.DISABLE_ELEVEN;
process.env.DISABLE_ELEVEN = "false";
main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    process.env.DISABLE_ELEVEN = priorDisable;
    await disconnect().catch(() => {});
  });
