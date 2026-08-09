import { join } from "node:path";
import { rm } from "node:fs/promises";
import { TopicStatus, VideoStatus } from "@prisma/client";
import {
  prisma,
  disconnect,
  withAdvisoryLock,
  withRetry,
  quarantinedVideoIds,
  env,
  voiceover,
  videoAssembly,
  thumbnailGenerator,
  youtubeUpload,
  notify,
  RunSummary,
  assertRunnable, remainingSlots, PilotBlockedError,
  openUnattendedGate, isUnattendedMode, unattendedClaimantId,
  createAndAttachCandidate, settleCycle, getCycle,
  type ActiveCycle,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, Script, SEOMetadata, StageDefinition, StageResult } from "@yt-pipeline/pipeline-core";

import { topicDiscovery } from "./stages/topicDiscovery";
import { scriptGenerator } from "./stages/scriptGenerator";
import { qualityGate } from "./stages/qualityGate";
import { seoGenerator } from "./stages/seoGenerator";
import { shortsGenerator } from "./stages/shortsGenerator";
import { visualFeasibilityGate } from "./stages/visualFeasibilityGate";
import { thumbnailHeadlineGenerator } from "./stages/thumbnailHeadlineGenerator";
import { finalVideoQa, assertFinalQaPassed, QaBlockedError } from "./stages/finalVideoQa";
import { resolveAiDoomPilot, assertAiDoomPilotWindow } from "./pilotBinding";

/**
 * Upload, refused unless the authoritative QA verdict passes for these exact
 * bytes.
 *
 * Stage ordering alone is not a control. A resumed run, a hand-edited status,
 * or a re-render after QA all reach upload without QA having seen the current
 * artifact, so the gate is asked again here, at the moment of upload, rather
 * than inferred from having walked through the stage earlier.
 *
 * Wraps the shared `youtubeUpload` instead of modifying it: pipeline-core must
 * not import from `src/`, and Wet Circuit has its own upload stage that already
 * carries its own equivalent gate. Neither channel's behaviour changes for the
 * other.
 */
async function guardedYoutubeUpload(ctx: PipelineContext): Promise<StageResult> {
  const start = Date.now();

  if (process.env.DISABLE_ELEVEN === "true") {
    // Dry runs assemble nothing real to measure; finalVideoQa skipped on the
    // same switch, so there is no verdict to consult.
    return youtubeUpload(ctx);
  }

  const video = await prisma.video.findUnique({ where: { id: ctx.video.id } });
  const videoPath = video?.videoPath;
  if (!videoPath) {
    return {
      success: false,
      error: "upload refused: no assembled video on the record",
      durationMs: Date.now() - start,
    };
  }

  try {
    const { qaId, sha256 } = await assertFinalQaPassed(ctx.video.id, videoPath);
    console.log(
      `[youtubeUpload] final-video QA ${qaId} PASS for sha256 ${sha256.slice(0, 16)}… — upload allowed`,
    );
  } catch (err) {
    if (err instanceof QaBlockedError) {
      return {
        success: false,
        error: `upload refused [${err.code}]: ${err.message}`,
        durationMs: Date.now() - start,
      };
    }
    throw err;
  }

  return youtubeUpload(ctx);
}

// ── Stage definitions (sequential) ────────────────────────────────────────

const STAGES: StageDefinition[] = [
  { name: "topicDiscovery", execute: topicDiscovery, retries: 2 },
  { name: "scriptGenerator", execute: scriptGenerator, retries: 2 },
  { name: "qualityGate", execute: qualityGate, retries: 0 },
  // Before ANY ElevenLabs budget opens. A retry here would re-query the stock
  // library for the same verdict, so it gets none.
  { name: "visualFeasibilityGate", execute: visualFeasibilityGate, retries: 0 },
  { name: "voiceover", execute: voiceover, retries: 3 },
  { name: "videoAssembly", execute: videoAssembly, retries: 3 },
  { name: "thumbnailHeadlineGenerator", execute: thumbnailHeadlineGenerator, retries: 2 },
  { name: "thumbnailGenerator", execute: thumbnailGenerator, retries: 2 },
  { name: "seoGenerator", execute: seoGenerator, retries: 2 },
  // Validates the assembled video and its captions, and binds the verdict to
  // the artifact's hash. Placed immediately before upload so the smallest
  // possible window exists between measuring the bytes and sending them. A
  // retry would re-measure the same bytes for the same answer, so it gets none.
  { name: "finalVideoQa", execute: finalVideoQa, retries: 0 },
  { name: "youtubeUpload", execute: guardedYoutubeUpload, retries: 3 },
  // Skipped during a pilot: a Short is a second video, a second narration and a
  // second upload, none of which the pilot authorises. Gated by the durable
  // pilot config rather than by commenting the stage out, so ordinary
  // production keeps it.
  { name: "shortsGenerator", execute: shortsGenerator, retries: 1, skipDuringPilot: true },
  { name: "notify", execute: notify, retries: 2 },
];

/**
 * Where a stuck video resumes, BY STAGE NAME.
 *
 * This used to be numeric indices into STAGES, with a comment tracking how far
 * they had shifted the last time a stage was inserted. Adding
 * visualFeasibilityGate would have shifted every one of them again, silently
 * resuming a narrated video at the wrong stage. Names cannot drift.
 */
const RESUME_FROM: Partial<Record<VideoStatus, string>> = {
  [VideoStatus.VOICEOVER_DONE]: "videoAssembly",
  [VideoStatus.ASSEMBLY_DONE]: "thumbnailHeadlineGenerator",
  // SEO_DONE resumes into finalVideoQa, not youtubeUpload. Resuming straight
  // to upload would be refused anyway — the upload gate compares the artifact's
  // hash to the persisted one — but it would burn an upload attempt to discover
  // that. Re-running QA against whatever artifact is on disk NOW is both
  // cheaper and the only answer that is actually about the current bytes.
  [VideoStatus.SEO_DONE]: "finalVideoQa",
};

/** Fails closed rather than resuming at an arbitrary stage. */
function resumeIndex(stages: StageDefinition[], status: VideoStatus): number {
  const name = RESUME_FROM[status];
  const idx = name ? stages.findIndex((s) => s.name === name) : -1;
  if (idx < 0) throw new Error(`no resume stage named "${name}" for status ${status}`);
  return idx;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

/**
 * The production cycle this process owns, or null when not unattended.
 *
 * Module-scoped on purpose. The run has many terminal points — two success
 * paths and four failure paths — and threading a cycle handle through every one
 * of them is how a path gets missed and a cycle is left CLAIMED forever. One
 * process runs one pipeline at a time (the advisory lock guarantees it), so a
 * single slot is an honest model of "the cycle this run owns".
 */
let activeCycle: ActiveCycle | null = null;

/** Cycle channel key. Matches the pilot binding's channel, deliberately. */
const AI_DOOM_CHANNEL = "ai-doom-scroll";

async function failVideo(
  ctx: PipelineContext,
  stageName: string,
  reason: string
) {
  // Settle first: the cycle's terminal state is what governs whether another
  // container may act, and it must not depend on the notification succeeding.
  await settleCycle(activeCycle, { ok: false, stage: stageName, reason });
  activeCycle = null;

  const failReason = `${stageName}: ${reason}`;
  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      status: VideoStatus.FAILED,
      failReason,
      retryCount: { increment: 1 },
    },
  });
  ctx.video = { ...ctx.video, failReason };

  // Best-effort failure notification
  await notify(ctx).catch(() => {});
}

async function cleanupTmpDir(videoId: string): Promise<void> {
  const tmpDir = join(process.cwd(), "tmp", videoId);
  try {
    await rm(tmpDir, { recursive: true, force: true });
    console.log(`[pipeline] Cleaned up ${tmpDir}`);
  } catch {
    // non-fatal
  }
}

// ── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Populate summary outputs from the final state of a Video DB row + run
 * the runMode-aware output verification. Called at the successful end of
 * either the resume path or the fresh-pipeline path.
 */
async function finalizeSummary(
  summary: RunSummary | undefined,
  videoDbId: string,
): Promise<void> {
  if (!summary) return;
  const v = await prisma.video.findUnique({ where: { id: videoDbId } });
  if (!v) return;
  summary.setVideoId(v.id);
  summary.setYoutubeId(v.youtubeId);
  summary.setScheduledAt(v.scheduledAt);
  summary.setShortsUrl(v.shortsUrl);
  summary.verifyOutputs({
    finalStatus: v.status,
    videoYoutubeId: v.youtubeId,
    videoScheduledAt: v.scheduledAt,
    videoShortsUrl: v.shortsUrl,
    thumbnailAPath: v.thumbnailA,
    assemblyCompleted: true, // reaching this function means stages all succeeded
  });
}

export async function runPipeline(summary?: RunSummary): Promise<void> {
  const config = env();
  const pipelineStart = Date.now();

  console.log(`[pipeline] ═══ Run started at ${ts()} ═══`);

  activeCycle = null;

  await withAdvisoryLock(prisma, config.PIPELINE_LOCK_ID, async () => {
    console.log("[pipeline] Advisory lock acquired");

    // ── Unattended production gate ────────────────────────────────────
    //
    // Sits here — inside the lock, ahead of the pilot gate and well ahead of
    // the resume query — because everything below it can produce a video, and
    // a container start is not an authorization. When the runtime is
    // unattended, a durable cycle must say a video is owed; otherwise this
    // returns and the start costs nothing. When it is not unattended, this is
    // a human-invoked run and the existing gates govern, unchanged.
    if (isUnattendedMode()) {
      const gate = await openUnattendedGate(AI_DOOM_CHANNEL);
      if (!gate.run) {
        console.log(`[pipeline] unattended run declined: ${gate.reason}`);
        return;
      }
      activeCycle = { id: gate.cycle.id, claimantId: unattendedClaimantId(AI_DOOM_CHANNEL) };
      console.log(`[pipeline] ${gate.reason}`);
    } else {
      console.log("[pipeline] not unattended — human-invoked run, existing gates govern");
    }

    // ── Pilot gate ────────────────────────────────────────────────────
    //
    // Every check reads the durable row, so a redeploy or a crash cannot
    // reset what the pilot has already used. The advisory lock above is the
    // first concurrency defence; the cap below fails closed independently of
    // it, because a lock that is somehow not held must not become permission
    // to exceed the limit.
    // Fails closed when the database says a pilot governs this channel but the
    // environment does not name it. `currentPilot()` alone returned null in
    // that case, which read as "ordinary production" and silently discarded
    // every pilot protection.
    const pilot = await resolveAiDoomPilot();
    if (pilot) {
      console.log(
        `[pipeline] PILOT ${pilot.pilotId}: status=${pilot.status} ` +
        `${pilot.successVideoIds.length}/${pilot.maxSuccesses} confirmed, ` +
        `${pilot.successCount} claimed, shorts=${pilot.shortsEnabled ? "on" : "off"}, ` +
        `publishAt=${pilot.allowPublishAt ? "permitted" : "forbidden"}`,
      );
      assertRunnable(pilot);
      const left = await remainingSlots(pilot.pilotId);
      if (left <= 0) {
        throw new PilotBlockedError("PILOT_CAP_REACHED",
          `pilot ${pilot.pilotId} has no slots left — refusing to create a candidate`);
      }
      // Hard gate. This used to log and continue, which made the window a
      // comment rather than a control. Refusing here precedes resume,
      // discovery, candidate creation, budget, narration, media and upload.
      const w = assertAiDoomPilotWindow(new Date(), pilot);
      console.log(`[pipeline] execution window OK — ${w.nowLocal} (${w.reason})`);
      // An unresolved upload from a prior pilot candidate must be reconciled
      // by a human before another candidate is created: it may already be a
      // video on the channel.
      const unresolved = await prisma.uploadIntent.count({
        where: { NOT: { state: { in: ["PERSISTED", "RECONCILED_HISTORICAL_UPLOAD"] } } },
      });
      if (unresolved > 0) {
        throw new PilotBlockedError("UNRESOLVED_INTENT",
          `${unresolved} unresolved upload intent(s) — reconcile before another pilot run`);
      }
      console.log(`[pipeline] pilot slots remaining: ${left}`);
    }
    const stages = STAGES.filter((s) => !(pilot && s.skipDuringPilot));
    if (pilot) {
      const skipped = STAGES.filter((s) => s.skipDuringPilot).map((s) => s.name);
      if (skipped.length) console.log(`[pipeline] pilot skips: ${skipped.join(", ")}`);
    }

    // ── Check for stuck videos that can be resumed ────────────────────

    const resumableStatuses = Object.keys(RESUME_FROM) as VideoStatus[];
    // Quarantined jobs are excluded explicitly as well as by status, so
    // restoring a row's status by hand cannot silently re-arm it.
    const quarantined = await quarantinedVideoIds();
    if (quarantined.length > 0) {
      console.log(`[pipeline] ${quarantined.length} quarantined job(s) excluded from resume`);
    }
    // An unattended run may only resume ITS OWN cycle's candidate. Without this
    // narrowing, a crashed run would restart, find some older unrelated stuck
    // row first (oldest-updatedAt wins), and drive that to publication under
    // this cycle's authorization — the cycle would then be COMPLETED by a video
    // it never created, and its own candidate would still be owed.
    const cycleVideoId = activeCycle ? (await getCycle(activeCycle.id))?.videoId ?? null : null;
    const stuckVideo = await prisma.video.findFirst({
      where: {
        status: { in: resumableStatuses },
        id: activeCycle
          ? { equals: cycleVideoId ?? "__none__", notIn: quarantined }
          : { notIn: quarantined.length ? quarantined : ["__none__"] },
      },
      include: { topic: true },
      orderBy: { updatedAt: "asc" }, // oldest stuck video first
    });

    if (stuckVideo) {
      const resumeStages = stages.slice(resumeIndex(stages, stuckVideo.status));
      console.log(
        `[pipeline] Resuming video ${stuckVideo.id} (stuck at ${stuckVideo.status}) from ${resumeStages[0].name}`
      );
      summary?.setVideoId(stuckVideo.id);

      // Rebuild context from DB fields
      const ctx: PipelineContext = {
        topic: stuckVideo.topic,
        video: stuckVideo,
        script: (stuckVideo.scriptJson as unknown as Script) ?? undefined,
        voiceoverUrls: stuckVideo.voiceoverUrls,
        videoUrl: stuckVideo.videoPath ?? undefined,
        seo:
          stuckVideo.seoTitle && stuckVideo.seoDescription
            ? {
                title: stuckVideo.seoTitle,
                description: stuckVideo.seoDescription,
                tags: stuckVideo.seoTags,
                chapters: (stuckVideo.seoChapters as unknown as SEOMetadata["chapters"]) ?? [],
              }
            : undefined,
      };

      for (const stage of resumeStages) {
        const stageStart = Date.now();
        console.log(`[pipeline] ▸ ${stage.name} started at ${ts()}`);

        let result: StageResult;
        try {
          result = await withRetry(() => stage.execute(ctx), {
            maxRetries: stage.retries,
            label: stage.name,
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.error(`[pipeline] ✗ ${stage.name} threw: ${reason}`);
          console.log(
            `[pipeline] ▸ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
          );
          summary?.markFailed(stage.name, err);
          await failVideo(ctx, stage.name, reason);
          return;
        }

        if (!result.success) {
          console.error(`[pipeline] ✗ ${stage.name} rejected: ${result.error}`);
          console.log(
            `[pipeline] ▸ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
          );
          summary?.markFailed(stage.name, new Error(result.error ?? "unknown error"));
          await failVideo(ctx, stage.name, result.error ?? "unknown error");
          return;
        }

        console.log(
          `[pipeline] ✓ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
        );
      }

      await settleCycle(activeCycle, { ok: true });
      activeCycle = null;
      await cleanupTmpDir(ctx.video.id);
      await finalizeSummary(summary, ctx.video.id);
      console.log(
        `[pipeline] ✓ Resumed complete — video ${ctx.video.id} → YouTube ${ctx.youtubeId ?? "n/a"}`
      );
      return;
    }

    // ── Stage 1: Topic Discovery (seeds the context) ──────────────────

    const discoveryStage = stages[0];
    const discoveryStart = Date.now();
    console.log(`[pipeline] ▸ ${discoveryStage.name} started at ${ts()}`);

    let discoveryResult: StageResult;
    try {
      discoveryResult = await withRetry(
        () => topicDiscovery({} as PipelineContext),
        { maxRetries: discoveryStage.retries, label: discoveryStage.name }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[pipeline] ✗ topicDiscovery failed: ${msg}`);
      console.log(
        `[pipeline] ▸ topicDiscovery ended at ${ts()} (${fmtDuration(Date.now() - discoveryStart)})`
      );
      summary?.markFailed("topicDiscovery", err);
      return;
    }

    console.log(
      `[pipeline] ✓ topicDiscovery ended at ${ts()} (${fmtDuration(Date.now() - discoveryStart)})`
    );

    if (!discoveryResult.success || !discoveryResult.data) {
      console.log("[pipeline] Discovery found no new topics, checking for existing APPROVED topics…");

      const fallbackTopic = await prisma.topic.findFirst({
        where: {
          status: TopicStatus.APPROVED,
          videos: { none: {} },
        },
        orderBy: [{ score: "desc" }, { createdAt: "desc" }],
      });

      if (!fallbackTopic) {
        console.log("[pipeline] No APPROVED fallback topics either, exiting");
        summary?.markIdle();
        return;
      }

      console.log(`[pipeline] Using fallback APPROVED topic: "${fallbackTopic.title}"`);
      discoveryResult = { success: true, data: fallbackTopic, durationMs: discoveryResult.durationMs };
    }

    const topic = discoveryResult.data as PipelineContext["topic"];

    // Create a video record to track through the pipeline.
    //
    // Under a cycle, the create and the cycle's record of it are one
    // transaction: a crash in between would otherwise leave an orphan candidate
    // and a cycle that still believes it may create one, which is how a single
    // authorization becomes two videos.
    const createVideo = (client: typeof prisma) => client.video.create({
      data: { topicId: topic.id, status: VideoStatus.SCRIPT_PENDING },
    });
    const video = activeCycle
      ? await createAndAttachCandidate(
          activeCycle.id, activeCycle.claimantId,
          (tx) => createVideo(tx as typeof prisma),
        ) as Awaited<ReturnType<typeof createVideo>>
      : await createVideo(prisma);

    const ctx: PipelineContext = { topic, video };
    summary?.setVideoId(video.id);
    console.log(`[pipeline] Video ${video.id} created for topic "${topic.title}"`);

    // ── Stages 2–8 ───────────────────────────────────────────────────

    for (const stage of stages.slice(1)) {
      const stageStart = Date.now();
      console.log(`[pipeline] ▸ ${stage.name} started at ${ts()}`);

      let result: StageResult;
      try {
        result = await withRetry(() => stage.execute(ctx), {
          maxRetries: stage.retries,
          label: stage.name,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[pipeline] ✗ ${stage.name} threw: ${reason}`);
        console.log(
          `[pipeline] ▸ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
        );
        summary?.markFailed(stage.name, err);
        await failVideo(ctx, stage.name, reason);
        return;
      }

      if (!result.success) {
        console.error(`[pipeline] ✗ ${stage.name} rejected: ${result.error}`);
        console.log(
          `[pipeline] ▸ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
        );
        summary?.markFailed(stage.name, new Error(result.error ?? "unknown error"));
        await failVideo(ctx, stage.name, result.error ?? "unknown error");
        return;
      }

      console.log(
        `[pipeline] ✓ ${stage.name} ended at ${ts()} (${fmtDuration(Date.now() - stageStart)})`
      );
    }

    await settleCycle(activeCycle, { ok: true });
    activeCycle = null;
    await cleanupTmpDir(ctx.video.id);
    await finalizeSummary(summary, ctx.video.id);
    console.log(
      `[pipeline] ✓ Complete — video ${ctx.video.id} → YouTube ${ctx.youtubeId ?? "n/a"}`
    );
  });

  console.log(
    `[pipeline] ═══ Run finished at ${ts()} — total ${fmtDuration(Date.now() - pipelineStart)} ═══`
  );
}

// ── Entry point (only when run directly) ──────────────────────────────────

const isDirectRun =
  process.argv[1]?.endsWith("pipeline.ts") ||
  process.argv[1]?.endsWith("pipeline.js");

if (isDirectRun) {
  runPipeline()
    .then(async () => {
      await disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("[pipeline] Fatal:", err);
      await disconnect();
      process.exit(1);
    });
}
