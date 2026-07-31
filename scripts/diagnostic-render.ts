/**
 * Stage-1 diagnostic render.
 *
 * Produces a short (60–90 s) private render per channel whose script exercises
 * the failures this pipeline had: pauses of differing lengths, varying pace,
 * long caption phrases, heavy punctuation and multiple visual changes.
 *
 * Synchronisation is measured at three points using NATURAL anchor sentences
 * (see ANCHORS) rather than spoken "marker one/two/three" artefacts, so the
 * script reads as publishable content.
 *
 *   npx tsx scripts/diagnostic-render.ts <ai-doom-scroll|wet-circuit> [--no-upload]
 *
 * Uploads are always private. Nothing here can publish.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createReadStream, existsSync } from "node:fs";
import { google } from "googleapis";
import { VideoStatus, TopicStatus } from "@prisma/client";
import {
  prisma, disconnect, env,
  runVoiceover, runAssembly, currentTestStage,
  runQa, persistQa, formatQa,
  prepareUpload, confirmUploadState,
  CHANNELS, budgetReport, setBudgetLimit,
  extractSyncAnchors, formatAnchors, findDiagnosticMarkers,
  sceneRecordsFor,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, Script } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

type ChannelKey = "ai-doom-scroll" | "wet-circuit";

// ── Diagnostic scripts ────────────────────────────────────────────────────
//
// Real, on-brand copy — not filler — so the credits spent here still buy
// something reviewable, per the "don't waste credits on meaningless test
// scripts" rule. Nothing unnatural is spoken.

const SCRIPTS: Record<ChannelKey, Script> = {
  // Topic: AI data-centre power demand. Concrete, visual, and genuinely
  // publishable — no spoken markers of any kind. Synchronisation is measured
  // against the natural anchor sentences declared in ANCHORS below.
  "ai-doom-scroll": {
    hook: "A single AI data centre can now draw more electricity than a small city.",
    cta: "",
    estimatedTotalDuration: 80,
    segments: [
      {
        segmentIndex: 0,
        title: "The Power Bill Nobody Budgeted For",
        narration:
          "A single AI data centre can now draw more electricity than a small city. " +
          "That is not a projection. That is the grid connection request already sitting with utilities in Virginia, Ohio and Texas. " +
          "Training a frontier model is a construction project before it is a software project.",
        visual_prompt:
          "close-up footage of high-density GPU server racks operating inside a modern data centre, "
          + "cooling systems and status lights visible, cinematic documentary framing",
        duration_seconds: 26,
      },
      {
        segmentIndex: 1,
        title: "Where The Electricity Actually Goes",
        narration:
          "Here is where it goes. The chips themselves take roughly half. Cooling takes most of the rest. " +
          "Every watt that enters the building has to leave it as heat, which is why the new sites are being built beside rivers and power stations rather than beside cities. " +
          "The constraint stopped being talent and started being transformers.",
        visual_prompt:
          "industrial cooling towers and electrical transformers at a power substation supplying a data centre, "
          + "steam and high-voltage lines, daylight documentary footage",
        duration_seconds: 27,
      },
      {
        segmentIndex: 2,
        title: "What This Actually Changes",
        narration:
          "So what changes for the rest of us? Two things. Electricity prices rise fastest in the regions that welcomed these campuses. " +
          "And the companies training these systems are quietly becoming energy companies that happen to sell software. " +
          "Watch the grid connection queue. It tells you more about the next model than any benchmark will.",
        visual_prompt:
          "engineer inspecting racks of computer hardware in a server room while checking a monitoring dashboard on screen, "
          + "technical maintenance work, realistic lighting",
        duration_seconds: 24,
      },
    ],
  },
  "wet-circuit": {
    hook: "Every season somebody asks the same question: will this transducer work on my hull?",
    cta: "",
    estimatedTotalDuration: 80,
    segments: [
      {
        segmentIndex: 0,
        title: "The Transducer Question",
        narration:
          "Every season somebody asks the same question: will this transducer work on my hull? " +
          "The honest answer is that it depends on three things, and only one of them is the transducer. " +
          "Deadrise angle, mounting height, and where the water actually separates from the hull at speed.",
        visual_prompt: "boat hull cutting through open water, transducer and wake detail",
        duration_seconds: 26,
      },
      {
        segmentIndex: 1,
        title: "The Fast Middle",
        narration:
          "Now the failure modes — cavitation, turbulence, aeration, bad grounding, loose fittings, and interference. " +
          "Six problems, and five of them look identical on the screen. " +
          "But here is the one that catches almost everybody, and it is worth taking slowly: your transducer is probably mounted too high.",
        visual_prompt: "marine electronics display showing sonar readout, close detail",
        duration_seconds: 27,
      },
      {
        segmentIndex: 2,
        title: "The Slow Close",
        narration:
          "So before you buy anything else, do this. " +
          "Run the boat at cruising speed, look at the screen, and note the exact speed where the bottom reading breaks up. " +
          "That number tells you more than any spec sheet will.",
        visual_prompt: "calm marina at golden hour, boats moored, slow drift",
        duration_seconds: 24,
      },
    ],
  },
};

/**
 * Natural synchronisation anchors — ordinary sentences from the script, one
 * near the beginning, middle and end. These replace the spoken "marker one/
 * two/three" artefacts: alignment is still measurable at three points, but
 * nothing unnatural is said aloud.
 */
const ANCHORS: Record<ChannelKey, { beginning: string; middle: string; end: string }> = {
  "ai-doom-scroll": {
    beginning: "A single AI data",
    middle: "Cooling takes most of",
    end: "Watch the grid connection",
  },
  "wet-circuit": {
    beginning: "Every season somebody asks",
    middle: "Now the failure modes",
    end: "So before you buy",
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────

function chars(s: Script): number {
  return s.segments.reduce((a, x) => a + x.narration.length, 0);
}

async function ensureDiagnosticTopic(channel: ChannelKey, runTag: string) {
  const url = `https://diagnostic.local/${channel}/${runTag}`;
  const title =
    channel === "ai-doom-scroll"
      ? "AI Data Centres Are Becoming Power Plants"
      : "Will This Transducer Work On My Hull?";

  if (channel === "wet-circuit") {
    return prisma.wcTopic.create({
      data: { title, url, source: "diagnostic", summary: "stage-1 diagnostic render", score: 1, status: TopicStatus.APPROVED },
    });
  }
  return prisma.topic.create({
    data: { title, url, source: "diagnostic", summary: "stage-1 diagnostic render", score: 1, status: TopicStatus.APPROVED },
  });
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const channel = process.argv[2] as ChannelKey;
  const noUpload = process.argv.includes("--no-upload");
  if (channel !== "ai-doom-scroll" && channel !== "wet-circuit") {
    console.error("usage: diagnostic-render.ts <ai-doom-scroll|wet-circuit> [--no-upload]");
    process.exit(2);
  }

  process.env.TEST_STAGE = process.env.TEST_STAGE ?? "DIAGNOSTIC";
  process.env.KEEP_RENDER_ARTIFACTS = "true";
  const stage = currentTestStage();

  const script = SCRIPTS[channel];
  console.log(
    `\n═══ DIAGNOSTIC RENDER — ${channel} — stage=${stage} — ${chars(script)} chars of narration ═══\n`,
  );

  await setBudgetLimit(channel, stage, Number(process.env.DIAGNOSTIC_BUDGET ?? 8000));

  const runTag = new Date().toISOString().replace(/[:.]/g, "-");
  const topic = await ensureDiagnosticTopic(channel, runTag);

  const video =
    channel === "wet-circuit"
      ? await prisma.wcVideo.create({
          data: { topicId: topic.id, status: VideoStatus.SCRIPT_PENDING, runMode: "LIVE", scriptJson: script as never },
        })
      : await prisma.video.create({
          data: { topicId: topic.id, status: VideoStatus.SCRIPT_PENDING, scriptJson: script as never },
        });

  console.log(`video row: ${video.id}\ntopic: "${topic.title}"\n`);

  const ctx = { topic, video, script } as unknown as PipelineContext;

  const repo =
    channel === "wet-circuit"
      ? {
          getVideo: (id: string) => prisma.wcVideo.findUnique({ where: { id } }),
          updateVideo: (id: string, data: Record<string, unknown>) =>
            prisma.wcVideo.update({ where: { id }, data: data as never }),
          setStatus: (id: string, status: string) =>
            prisma.wcVideo.update({ where: { id }, data: { status: status as VideoStatus } }),
        }
      : {
          getVideo: (id: string) => prisma.video.findUnique({ where: { id } }),
          updateVideo: (id: string, data: Record<string, unknown>) =>
            prisma.video.update({ where: { id }, data: data as never }),
          setStatus: (id: string, status: string) =>
            prisma.video.update({ where: { id }, data: { status: status as VideoStatus } }),
        };

  // ── 1. Voiceover ────────────────────────────────────────────────────
  console.log("── voiceover ──");
  const vo = await runVoiceover(ctx, {
    channel, label: `${channel}:diag:voiceover`, testStage: stage,
    updateVideo: repo.updateVideo, setStatus: repo.setStatus,
  });
  if (!vo.success) throw new Error(`voiceover failed: ${vo.error}`);

  // ── 2. Assembly ─────────────────────────────────────────────────────
  console.log("\n── assembly ──");
  const asm = await runAssembly(ctx, {
    channel, label: `${channel}:diag:assembly`, testStage: stage, ...repo,
  });
  if (!asm.success || !asm.data) throw new Error(`assembly failed: ${asm.error}`);
  const out = asm.data;

  // ── 3. Automated QA ─────────────────────────────────────────────────
  console.log("\n── automated QA ──");
  const qaInput = {
    channel, videoId: video.id, assetKind: "LONGFORM" as const,
    videoPath: out.videoPath, narrationPath: out.narrationPath,
    narrationStartS: out.narrationStartS,
    cues: out.captions.cues, words: out.captions.words,
    expectedWidth: 1920, expectedHeight: 1080, expectedFps: 30,
    testStage: stage,
  };
  const qa = await runQa(qaInput);
  console.log(formatQa(qa));

  // ── 4a. Refuse to ship diagnostic marker artefacts ───────────────────
  const markerHits = script.segments.flatMap((sg) => findDiagnosticMarkers(sg.narration));
  if (markerHits.length > 0) {
    throw new Error(
      `Diagnostic marker phrases present in narration: ${markerHits.join(", ")}. ` +
        `These must never be spoken — use natural anchors instead.`,
    );
  }

  // ── 4b. Natural synchronisation anchors ──────────────────────────────
  const anchors = extractSyncAnchors(out.captions.words, out.captions.cues, ANCHORS[channel]);
  console.log("\n── natural synchronisation anchors ──");
  console.log(formatAnchors(anchors));

  // ── 4c. Visual relevance summary ─────────────────────────────────────
  const scenes = await sceneRecordsFor(video.id);
  console.log("\n── visual relevance ──");
  for (const sc of scenes) {
    console.log(
      `  scene ${sc.sceneNumber}: [${sc.relevanceVerdict ?? "n/a"} ${sc.relevanceScore?.toFixed(2) ?? "-"}] ` +
        `"${sc.assetDescription ?? sc.assetSource}"`,
    );
  }

  console.log("\n── caption alignment vs spoken audio ──");
  const off = qa.metrics;
  const ms = (v?: number) => (v === undefined || !Number.isFinite(v) ? "n/a" : `${(v * 1000).toFixed(0)}ms`);
  console.log(`  beginning : ${ms(off.captionOffsetHead)}`);
  console.log(`  middle    : ${ms(off.captionOffsetMid)}`);
  console.log(`  end       : ${ms(off.captionOffsetTail)}`);
  console.log(`  worst     : ${ms(off.maxCaptionOffset)}`);
  console.log(
    `  drift (end − beginning): ${ms((off.captionOffsetTail ?? 0) - (off.captionOffsetHead ?? 0))}`,
  );
  console.log(
    `\n  video ${off.videoDurationS?.toFixed(3)}s | narration ${off.audioDurationS?.toFixed(3)}s ` +
      `| narration starts ${out.narrationStartS}s | expected video ${(out.narrationStartS + (off.audioDurationS ?? 0)).toFixed(3)}s`,
  );
  console.log(`  credits charged: ${off.creditsCharged}`);

  // ── 5. Private upload ────────────────────────────────────────────────
  let youtubeId: string | null = null;
  let privacyStatus: string | null = null;
  if (!noUpload && qa.overall === "PASS") {
    console.log("\n── private upload ──");
    const decision = await prepareUpload({
      channelKey: channel, serviceLabel: `${channel}:diag`,
      existingYoutubeId: null, scheduledSlot: null,
    });
    const config = env();
    const auth = new google.auth.OAuth2(config.YOUTUBE_CLIENT_ID, config.YOUTUBE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: config.YOUTUBE_REFRESH_TOKEN });
    const yt = google.youtube({ version: "v3", auth });

    const res = await yt.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: `[DIAGNOSTIC ${runTag}] ${topic.title}`.slice(0, 100),
          description: "Stage-1 diagnostic render. Private. Not for publication.",
          categoryId: "28",
        },
        status: { privacyStatus: decision.privacyStatus, selfDeclaredMadeForKids: false },
      },
      media: { body: createReadStream(out.videoPath) },
    });
    youtubeId = res.data.id ?? null;
    if (youtubeId) {
      const confirmed = await confirmUploadState({
        channelKey: channel, serviceLabel: `${channel}:diag`,
        youtubeId, expectPrivate: true, videoId: video.id,
      });
      privacyStatus = confirmed.privacyStatus;
      await repo.updateVideo(video.id, { youtubeId, status: VideoStatus.UPLOADED });
    }
  } else if (qa.overall !== "PASS") {
    console.log("\n── upload SKIPPED: automated QA did not pass ──");
  }

  const qaWithAnchors = {
    ...qa,
    checks: [
      ...qa.checks,
      ...anchors.map((a) => ({
        name: `sync_anchor_${a.position}`,
        passed: Math.abs(a.offsetS) <= 0.25,
        severity: "FATAL" as const,
        detail: `"${a.phrase}" spoken ${a.audioStartS.toFixed(2)}s, caption ${a.captionStartS.toFixed(2)}s, offset ${(a.offsetS * 1000).toFixed(0)}ms`,
        value: a.offsetS,
        expected: "±250ms",
      })),
    ],
  };
  const qaId = await persistQa(
    { ...qaInput, youtubeId, privacyStatus, verifiedChannelId: CHANNELS[channel].id },
    qaWithAnchors,
    { reviewer: "automated" },
  );

  // ── 6. Frames for visual review ──────────────────────────────────────
  const framesDir = join(process.cwd(), "output", video.id, "frames");
  await mkdir(framesDir, { recursive: true });
  const { extractFrame } = await import("@yt-pipeline/pipeline-core");
  const dur = off.videoDurationS ?? 60;
  for (const t of [1, 6, dur * 0.25, dur * 0.5, dur * 0.75, dur - 2]) {
    await extractFrame(out.videoPath, t, join(framesDir, `t${t.toFixed(1)}.jpg`)).catch(() => {});
  }

  console.log(`\n═══ RESULT: ${qa.overall} ═══`);
  console.log(`  video     : ${out.videoPath}`);
  console.log(`  frames    : ${framesDir}`);
  console.log(`  qa record : ${qaId}`);
  console.log(`  youtube   : ${youtubeId ?? "not uploaded"} (${privacyStatus ?? "n/a"})`);

  const rep = await budgetReport();
  console.log(
    `  budget    : ${rep.totalCharged} charged / ${rep.globalTarget} target (${rep.globalRemaining} remaining)`,
  );

  await disconnect();
  process.exit(qa.overall === "PASS" ? 0 : 1);
}

main().catch(async (e) => {
  console.error("\nDIAGNOSTIC FAILED:", e);
  await disconnect();
  process.exit(1);
});
