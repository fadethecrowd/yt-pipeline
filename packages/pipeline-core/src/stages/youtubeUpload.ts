import { createReadStream, existsSync } from "node:fs";
import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { buildYouTubeClient } from "../youtubeAuth";
import {
  prepareUpload,
  confirmUploadState,
  assertNoDuplicateUploadRecord,
} from "../lib/uploadSafety";
import {
  currentPilot, uploadPolicyFor, assertPilotUploadAllowed,
  claimPilotSlot, releasePilotSlot, confirmPilotSlot,
} from "../lib/pilot";
import {
  guardedUpload, createGoogleYouTubePort, prismaIntentStore, UploadBlockedError,
} from "../lib/uploadIntent";
import { sha256File, sha256Manifest } from "../lib/approvedArtifact";
import { sceneRecordsFor } from "../lib/visuals";
import { currentTestStage } from "../lib/testStage";
import type { PipelineContext, StageResult, UploadResult } from "../types";

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the publish slot for the current pipeline run.
 *
 * Always publishes same-day: if today is Mon/Wed/Fri, use today at
 * 2 PM EST (19:00 UTC). Multiple videos per day is allowed — AI news
 * gets stale fast so same-day publish is the priority.
 *
 * If today is not a publish day (Tue/Thu/Sat/Sun), use the next
 * Mon/Wed/Fri at 2 PM EST.
 */
function getNextPublishSlot(): Date {
  const PUBLISH_DAYS = [1, 3, 5]; // Mon, Wed, Fri
  const PUBLISH_HOUR_UTC = 19; // 2 PM EST = 19:00 UTC

  const now = new Date();
  const today = new Date(now);
  today.setUTCHours(PUBLISH_HOUR_UTC, 0, 0, 0);

  // Same-day slot only if it is still in the future — YouTube requires
  // publishAt to be ahead of upload time; runs after 19:00 UTC on a
  // publish day fall through to the next-day search below.
  if (PUBLISH_DAYS.includes(today.getUTCDay()) && today > now) {
    console.log(`[youtubeUpload] Using same-day slot: ${today.toISOString()}`);
    return today;
  }

  // Find the next Mon/Wed/Fri
  for (let i = 1; i <= 7; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + i);
    if (PUBLISH_DAYS.includes(d.getUTCDay())) {
      console.log(`[youtubeUpload] Next publish day: ${d.toISOString()}`);
      return d;
    }
  }

  // Should never reach here, but fallback to tomorrow
  const fallback = new Date(today);
  fallback.setUTCDate(fallback.getUTCDate() + 1);
  return fallback;
}

/**
 * Create an authenticated YouTube Data API v3 client.
 *
 * Delegates to the shared constructor so the uploader, the duplicate guard,
 * the reconciler and the preflight can never authenticate as different
 * identities.
 */
function getYouTubeClient() {
  return buildYouTubeClient();
}

// ── Main ─────────────────────────────────────────────────────────────────

/**
 * Stage: Upload video via YouTube Data API v3 with scheduled publish.
 */
export async function youtubeUpload(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();

  if (process.env.DISABLE_ELEVEN === "true") {
    console.log("[guard] DISABLE_ELEVEN active — skipping YouTube upload");
    const placeholderYoutubeId = `dryrun-${ctx.video.id}`;
    await prisma.video.update({
      where: { id: ctx.video.id },
      data: {
        youtubeId: placeholderYoutubeId,
        status: VideoStatus.UPLOADED,
      },
    });
    ctx.youtubeId = placeholderYoutubeId;
    return { success: true, durationMs: Date.now() - start };
  }

  // Re-read video from DB to get videoPath and SEO fields
  const video = await prisma.video.findUnique({
    where: { id: ctx.video.id },
  });
  if (!video?.videoPath) {
    return {
      success: false,
      error: "Missing videoPath on video record",
      durationMs: Date.now() - start,
    };
  }
  if (!ctx.seo) {
    return {
      success: false,
      error: "Missing SEO metadata in context",
      durationMs: Date.now() - start,
    };
  }

  // Verify channel, enforce private-on-test, and refuse a second upload of an
  // asset that already has a YouTube ID.
  // Pilot runs are private with no publish time. The restriction is scoped to
  // the pilot: ordinary production still receives its scheduled slot, so this
  // does not quietly redefine all PRODUCTION uploads as private forever.
  const pilot = await currentPilot();
  const policy = uploadPolicyFor(pilot, getNextPublishSlot());
  if (policy.source === "pilot") {
    console.log(`[youtubeUpload] pilot ${pilot!.pilotId}: private, no publishAt, guarded intent`);
  }
  const decision = await prepareUpload({
    channelKey: "ai-doom-scroll",
    serviceLabel: "youtubeUpload",
    existingYoutubeId: video.youtubeId,
    scheduledSlot: policy.scheduledSlot,
  });

  if (decision.alreadyUploaded) {
    ctx.youtubeId = decision.existingYoutubeId;
    await prisma.video.update({
      where: { id: ctx.video.id },
      data: { status: VideoStatus.UPLOADED },
    });
    return {
      success: true,
      data: { youtubeId: decision.existingYoutubeId!, scheduledAt: video.scheduledAt ?? new Date() },
      durationMs: Date.now() - start,
    };
  }

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: { status: VideoStatus.UPLOAD_PENDING },
  });

  const scheduledAt = policy.source === "pilot" ? null : decision.publishAt;
  // Refuse rather than upload if anything reintroduced a publish time.
  assertPilotUploadAllowed(policy, scheduledAt);
  console.log(
    `[youtubeUpload] privacy=private publishAt=${scheduledAt?.toISOString() ?? "none (fully private)"}`,
  );
  console.log(`[youtubeUpload] Title: ${ctx.seo.title}`);
  console.log(`[youtubeUpload] Video file: ${video.videoPath}`);

  // ── Pilot: guarded, durable, reconcilable upload ─────────────────────
  //
  // The direct insert below has no upload intent, so a crash between the API
  // call and the local write orphans a video nobody has a record of — the
  // failure that once required retrospective adoption. A pilot never reaches
  // it: the slot is claimed before any bytes move and released if the upload
  // does not complete, so an abandoned attempt cannot burn one of the three.
  if (policy.source === "pilot" && policy.requireGuardedUpload) {
    const fileSha256 = await sha256File(video.videoPath);
    const manifestSha256 = sha256Manifest(await sceneRecordsFor(ctx.video.id) as never);
    const port = createGoogleYouTubePort();
    const persistYoutubeId = async (_i: unknown, id: string) => {
      await prisma.video.update({ where: { id: ctx.video.id }, data: { youtubeId: id } });
    };
    const slot = await claimPilotSlot(pilot!.pilotId);
    console.log(`[youtubeUpload] pilot slot ${slot}/${pilot!.maxSuccesses} claimed`);
    let youtubeIdGuarded: string;
    try {
      const r = await guardedUpload(
        {
          channelKey: "ai-doom-scroll", assetKey: pilot!.pilotId, videoId: ctx.video.id,
          testStage: currentTestStage(), format: "LONGFORM",
          filePath: video.videoPath, fileSha256, manifestSha256,
          metadata: {
            title: ctx.seo.title, description: ctx.seo.description, tags: ctx.seo.tags,
            categoryId: "28", privacyStatus: "private", publishAt: null,
          },
          existingYoutubeId: video.youtubeId ?? null,
          verifiedChannelId: decision.verifiedChannelId,
          actualFileSha256: fileSha256, actualManifestSha256: manifestSha256,
        },
        { port, store: prismaIntentStore, persistYoutubeId },
      );
      youtubeIdGuarded = r.youtubeId;
      console.log(`[youtubeUpload] pilot upload ${r.status} (intent ${r.intent.id})`);
    } catch (err) {
      await releasePilotSlot(pilot!.pilotId);
      console.error(`[youtubeUpload] pilot slot released — upload did not complete`);
      if (err instanceof UploadBlockedError) {
        return { success: false, error: `upload blocked [${err.code}]: ${err.message}`, durationMs: Date.now() - start };
      }
      throw err;
    }
    await prisma.video.update({
      where: { id: ctx.video.id },
      data: { youtubeId: youtubeIdGuarded, scheduledAt: null, status: VideoStatus.UPLOADED },
    });
    const after = await confirmPilotSlot(pilot!.pilotId, ctx.video.id);
    console.log(`[youtubeUpload] pilot ${after.pilotId}: ${after.successVideoIds.length}/${after.maxSuccesses} confirmed, status ${after.status}`);
    await confirmUploadState({
      channelKey: "ai-doom-scroll", serviceLabel: "youtubeUpload",
      youtubeId: youtubeIdGuarded, expectPrivate: true, videoId: ctx.video.id,
    });
    await assertNoDuplicateUploadRecord(youtubeIdGuarded, "ai-doom-scroll", ctx.video.id);
    ctx.youtubeId = youtubeIdGuarded;
    return {
      success: true,
      data: { youtubeId: youtubeIdGuarded, scheduledAt: new Date() },
      durationMs: Date.now() - start,
    };
  }

  const youtube = getYouTubeClient();

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: ctx.seo.title,
        description: ctx.seo.description,
        tags: ctx.seo.tags,
        categoryId: "28", // Science & Technology
        defaultLanguage: "en",
      },
      status: {
        privacyStatus: decision.privacyStatus,
        ...(scheduledAt ? { publishAt: scheduledAt.toISOString() } : {}),
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: createReadStream(video.videoPath),
    },
  });

  const youtubeId = res.data.id;
  if (!youtubeId) {
    return {
      success: false,
      error: "YouTube API returned no video ID",
      durationMs: Date.now() - start,
    };
  }

  console.log(`[youtubeUpload] Uploaded: https://youtu.be/${youtubeId}`);

  // Auto-set thumbnail (Variant A) immediately after upload
  const thumbnailPath = ctx.thumbnailA;
  if (thumbnailPath && existsSync(thumbnailPath)) {
    try {
      await youtube.thumbnails.set({
        videoId: youtubeId,
        media: { body: createReadStream(thumbnailPath) },
      });
      console.log(`[youtubeUpload] Thumbnail applied: ${thumbnailPath}`);
    } catch (err) {
      console.error(`[youtubeUpload] Thumbnail set failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  } else {
    console.log("[youtubeUpload] No thumbnail available to set");
  }

  const result: UploadResult = { youtubeId, scheduledAt: scheduledAt ?? new Date() };

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      youtubeId,
      scheduledAt,
      status: VideoStatus.UPLOADED,
    },
  });

  // Confirm with YouTube that it is private and on the right channel, and that
  // no second row claims this ID.
  await confirmUploadState({
    channelKey: "ai-doom-scroll",
    serviceLabel: "youtubeUpload",
    youtubeId,
    expectPrivate: scheduledAt === null,
    videoId: ctx.video.id,
  }).catch((e) => console.warn(`[youtubeUpload] Upload confirmation failed: ${e}`));
  await assertNoDuplicateUploadRecord(youtubeId, "ai-doom-scroll", ctx.video.id);

  ctx.youtubeId = result.youtubeId;

  return { success: true, data: result, durationMs: Date.now() - start };
}
