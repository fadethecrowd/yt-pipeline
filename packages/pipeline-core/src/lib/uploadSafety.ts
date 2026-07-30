import { google } from "googleapis";
import { env } from "../config";
import { CHANNELS, verifyChannel } from "../youtubeAuth";
import type { ChannelKey } from "../youtubeAuth";
import { currentTestStage, isTestStage } from "./testStage";
import { prisma } from "./db";
import { tripBreaker } from "./circuitBreaker";

/**
 * Upload-boundary safety.
 *
 * Three guarantees, enforced here rather than at each call site:
 *  1. The authenticated channel matches the channel this service is pinned to.
 *  2. Test and qualification renders are always uploaded private with no
 *     scheduled publish, regardless of the channel's normal configuration.
 *  3. An asset that already has a YouTube ID is never uploaded a second time.
 */

export interface UploadDecision {
  /** Skip the upload entirely — this asset is already on YouTube. */
  alreadyUploaded: boolean;
  existingYoutubeId?: string;
  privacyStatus: "private";
  /** null on test stages and pre-launch; a Date once publishing is enabled. */
  publishAt: Date | null;
  verifiedChannelId: string;
}

/** Placeholder IDs written by dry runs are not real uploads. */
export function isRealYoutubeId(id: string | null | undefined): boolean {
  return Boolean(id) && !id!.startsWith("dryrun-");
}

/**
 * Verify the channel and decide how this asset must be uploaded.
 *
 * @param existingYoutubeId  the ID already stored on the video row, if any
 * @param scheduledSlot      the publish slot the channel would normally use
 */
export async function prepareUpload(opts: {
  channelKey: ChannelKey;
  serviceLabel: string;
  existingYoutubeId?: string | null;
  scheduledSlot: Date | null;
}): Promise<UploadDecision> {
  const spec = CHANNELS[opts.channelKey];

  // 1. Fail closed on the wrong channel — before any write or upload.
  try {
    await verifyChannel(spec, opts.serviceLabel);
  } catch (err) {
    await tripBreaker(
      opts.channelKey,
      "WRONG_CHANNEL_AUTH",
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }

  // 2. Never upload the same asset twice.
  if (isRealYoutubeId(opts.existingYoutubeId)) {
    console.log(
      `[${opts.serviceLabel}] Upload skipped — asset already on YouTube as ${opts.existingYoutubeId}`,
    );
    return {
      alreadyUploaded: true,
      existingYoutubeId: opts.existingYoutubeId!,
      privacyStatus: "private",
      publishAt: null,
      verifiedChannelId: spec.id,
    };
  }

  // 3. Test stages are private with no publishAt, always.
  const stage = currentTestStage();
  let publishAt = opts.scheduledSlot;
  if (isTestStage(stage)) {
    if (publishAt) {
      console.log(
        `[${opts.serviceLabel}] TEST_STAGE=${stage} — dropping scheduled publish ${publishAt.toISOString()}; uploading fully private`,
      );
    }
    publishAt = null;
  }

  // YouTube rejects a publishAt in the past; treat it as "no schedule".
  if (publishAt && publishAt.getTime() <= Date.now()) {
    console.warn(
      `[${opts.serviceLabel}] Computed publishAt ${publishAt.toISOString()} is in the past — uploading private with no schedule`,
    );
    publishAt = null;
  }

  return {
    alreadyUploaded: false,
    privacyStatus: "private",
    publishAt,
    verifiedChannelId: spec.id,
  };
}

/**
 * Confirm with YouTube that an uploaded asset is in the expected privacy state
 * and on the expected channel. Trips the breaker if a private test asset is
 * live, or if it landed on the wrong channel.
 */
export async function confirmUploadState(opts: {
  channelKey: ChannelKey;
  serviceLabel: string;
  youtubeId: string;
  expectPrivate: boolean;
  videoId?: string;
}): Promise<{ privacyStatus: string | null; channelId: string | null }> {
  const config = env();
  const auth = new google.auth.OAuth2(config.YOUTUBE_CLIENT_ID, config.YOUTUBE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: config.YOUTUBE_REFRESH_TOKEN });
  const yt = google.youtube({ version: "v3", auth });

  const res = await yt.videos.list({ part: ["status", "snippet"], id: [opts.youtubeId] });
  const item = res.data.items?.[0];
  const privacyStatus = item?.status?.privacyStatus ?? null;
  const channelId = item?.snippet?.channelId ?? null;
  const expected = CHANNELS[opts.channelKey].id;

  console.log(
    `[${opts.serviceLabel}] Upload confirmed: id=${opts.youtubeId} privacy=${privacyStatus} channel=${channelId} (expected ${expected})`,
  );

  if (channelId && channelId !== expected) {
    await tripBreaker(
      opts.channelKey, "CROSS_CHANNEL_CONTAMINATION",
      `Asset ${opts.youtubeId} landed on channel ${channelId}, expected ${expected}`,
      opts.videoId ? [opts.videoId] : [],
    );
  }
  if (opts.expectPrivate && privacyStatus && privacyStatus !== "private") {
    await tripBreaker(
      opts.channelKey, "PRIVATE_CONTENT_WENT_PUBLIC",
      `Test asset ${opts.youtubeId} has privacyStatus=${privacyStatus}, expected private`,
      opts.videoId ? [opts.videoId] : [],
    );
  }

  return { privacyStatus, channelId };
}

/**
 * Guard against a second row claiming the same YouTube ID across either
 * channel's table.
 */
export async function assertNoDuplicateUploadRecord(
  youtubeId: string,
  channelKey: ChannelKey,
  videoId: string,
): Promise<void> {
  const [a, w] = await Promise.all([
    prisma.video.count({ where: { youtubeId } }),
    prisma.wcVideo.count({ where: { youtubeId } }),
  ]);
  if (a + w > 1) {
    await tripBreaker(
      channelKey, "DUPLICATE_UPLOAD",
      `youtubeId=${youtubeId} is referenced by ${a + w} video rows`,
      [videoId],
    );
  }
}
