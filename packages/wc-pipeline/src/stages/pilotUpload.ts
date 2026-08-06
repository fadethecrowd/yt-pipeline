import {
  claimPilotSlot, releasePilotSlot, confirmPilotSlot,
  guardedUpload, createGoogleYouTubePort, prismaIntentStore, UploadBlockedError,
  sha256File, sha256Manifest, sceneRecordsFor, currentTestStage,
} from "@yt-pipeline/pipeline-core";
import type { PilotConfig, UploadPolicy, UploadIntentRecord } from "@yt-pipeline/pipeline-core";

/**
 * Wet Circuit's pilot upload path.
 *
 * The direct `videos.insert` in youtubeUpload has no upload intent, so a crash
 * between the API call and the local write orphans a video nobody has a record
 * of. That has already happened four times on this channel — four rows sit at
 * UPLOADED with a null youtubeId and no intent. A canary never reaches it.
 *
 * Ordering is the whole guarantee:
 *   claim slot → guardedUpload (PREPARED → UPLOAD_STARTED → insert →
 *   REMOTE_CONFIRMED → row → PERSISTED) → confirm slot.
 * A slot that does not result in an upload is released, so an abandoned
 * attempt never burns the canary's single allowance.
 *
 * This is Wet Circuit's own copy. AI Doom Scroll performs the same sequence
 * inline in packages/pipeline-core/src/stages/youtubeUpload.ts and does not
 * import this module, so nothing here can alter AI Doom's behaviour.
 */

export interface WcPilotUploadDeps {
  videoId: string;
  videoPath: string;
  /** The youtubeId already on the row, if any. Blocks a second upload. */
  existingYoutubeId: string | null;
  verifiedChannelId: string;
  metadata: {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
  };
  /** Writes the id onto wc_video, before the intent reaches PERSISTED. */
  persistYoutubeId: (youtubeId: string) => Promise<unknown>;
}

export interface WcPilotUploadResult {
  youtubeId: string;
  intent: UploadIntentRecord;
  status: "uploaded" | "adopted" | "already_uploaded";
  slot: number;
}

export class WcPilotUploadRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WcPilotUploadRefused";
  }
}

const LOG = "[wc:youtubeUpload]";

/**
 * Claim a slot, upload under a durable intent, and return the id.
 *
 * `policy` must already have been produced by `uploadPolicyFor` and checked by
 * `assertPilotUploadAllowed`. Privacy and publishAt are NOT taken from the
 * caller: they are pinned here and re-asserted by `assertUploadable` inside
 * `guardedUpload`, which refuses anything that is not private with no publish
 * time regardless of what the caller believed.
 */
export async function runWcPilotUpload(
  pilot: PilotConfig,
  policy: UploadPolicy,
  deps: WcPilotUploadDeps,
): Promise<WcPilotUploadResult> {
  if (policy.source !== "pilot") {
    throw new WcPilotUploadRefused("NOT_A_PILOT", "runWcPilotUpload called with a non-pilot policy");
  }

  const fileSha256 = await sha256File(deps.videoPath);
  const manifestSha256 = sha256Manifest(await sceneRecordsFor(deps.videoId) as never);
  const port = createGoogleYouTubePort();

  const slot = await claimPilotSlot(pilot.pilotId);
  console.log(`${LOG} pilot slot ${slot}/${pilot.maxSuccesses} claimed`);

  try {
    const r = await guardedUpload(
      {
        channelKey: "wet-circuit",
        assetKey: pilot.pilotId,
        videoId: deps.videoId,
        sourceTable: "wc_video",
        testStage: currentTestStage(),
        format: "LONGFORM",
        filePath: deps.videoPath,
        fileSha256,
        manifestSha256,
        metadata: {
          title: deps.metadata.title,
          description: deps.metadata.description,
          tags: deps.metadata.tags,
          categoryId: deps.metadata.categoryId,
          privacyStatus: "private",
          publishAt: null,
        },
        existingYoutubeId: deps.existingYoutubeId,
        verifiedChannelId: deps.verifiedChannelId,
        actualFileSha256: fileSha256,
        actualManifestSha256: manifestSha256,
      },
      {
        port,
        store: prismaIntentStore,
        persistYoutubeId: async (_i: unknown, id: string) => {
          await deps.persistYoutubeId(id);
        },
      },
    );
    console.log(`${LOG} pilot upload ${r.status} (intent ${r.intent.id})`);
    return { youtubeId: r.youtubeId, intent: r.intent, status: r.status, slot };
  } catch (err) {
    await releasePilotSlot(pilot.pilotId);
    console.error(`${LOG} pilot slot released — upload did not complete`);
    if (err instanceof UploadBlockedError) {
      throw new WcPilotUploadRefused(err.code, err.message);
    }
    throw err;
  }
}

/** Record the confirmed upload against its claimed slot. */
export async function completeWcPilotUpload(
  pilot: PilotConfig,
  videoId: string,
): Promise<PilotConfig> {
  const after = await confirmPilotSlot(pilot.pilotId, videoId);
  console.log(
    `${LOG} pilot ${after.pilotId}: ${after.successVideoIds.length}/${after.maxSuccesses} ` +
    `confirmed, status ${after.status}`,
  );
  return after;
}
