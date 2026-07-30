import { join } from "node:path";
import { mkdir, rm, rename, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { google } from "googleapis";
import {
  prisma, env, prepareUpload, confirmUploadState,
  readManifest, readAlignments, buildLongformCaptions, buildShortsCaptions,
  TITLE_CARD_DURATION,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult } from "@yt-pipeline/pipeline-core";

const execFile = promisify(execFileCb);

const FFMPEG_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FFMPEG = existsSync(FFMPEG_FULL) ? FFMPEG_FULL : "ffmpeg";

interface HookSegment {
  text: string;
  startTime: string;
  endTime: string;
  segmentIndex: number;
}

function parseTimestamp(ts: string): number {
  const parts = ts.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function getYouTubeClient() {
  const config = env();
  const auth = new google.auth.OAuth2(
    config.YOUTUBE_CLIENT_ID,
    config.YOUTUBE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: config.YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: "v3", auth });
}

/**
 * Stage: Generate a YouTube Short from the video's hook segment.
 *
 * Runs after youtubeUpload while the video file is still on disk.
 * Clips the hookSegment timestamp range, center-crops to 9:16 vertical,
 * uploads as "[title] #Shorts", stores shortsUrl on the Video record.
 *
 * Non-fatal: if hookSegment is missing or ffmpeg fails, the stage
 * succeeds with a warning (don't block notify over a Short).
 */
export async function shortsGenerator(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();

  if (process.env.DISABLE_ELEVEN === "true") {
    console.log("[guard] DISABLE_ELEVEN active — skipping Shorts generation");
    return { success: true, durationMs: Date.now() - start };
  }

  const video = await prisma.video.findUnique({
    where: { id: ctx.video.id },
    include: { topic: true },
  });

  if (!video?.hookSegment) {
    console.log("[shortsGenerator] No hookSegment — skipping Short");
    return { success: true, durationMs: Date.now() - start };
  }

  if (!video.videoPath || !existsSync(video.videoPath)) {
    console.log(`[shortsGenerator] Video file not on disk — skipping Short`);
    return { success: true, durationMs: Date.now() - start };
  }

  if (!video.youtubeId) {
    console.log("[shortsGenerator] No youtubeId — skipping Short");
    return { success: true, durationMs: Date.now() - start };
  }

  let hook: HookSegment;
  try {
    hook = JSON.parse(video.hookSegment);
  } catch {
    console.warn("[shortsGenerator] Invalid hookSegment JSON — skipping");
    return { success: true, durationMs: Date.now() - start };
  }

  const startSec = parseTimestamp(hook.startTime);
  const endSec = parseTimestamp(hook.endTime);
  const duration = endSec - startSec;

  if (duration <= 0 || duration > 60) {
    console.warn(`[shortsGenerator] Invalid duration ${duration}s — skipping`);
    return { success: true, durationMs: Date.now() - start };
  }

  const tmpDir = join(process.cwd(), "tmp", `short-${ctx.video.id}`);
  await mkdir(tmpDir, { recursive: true });
  const shortPath = join(tmpDir, "short.mp4");

  try {
    // Crop the caption-free master when it exists, so the Short gets captions
    // sized for a 1080x1920 frame instead of inheriting long-form captions
    // that were sized for 1920x1080 and then upscaled by the crop.
    const cleanMaster = video.videoPath.replace(/final\.mp4$/, "final-clean.mp4");
    const source = existsSync(cleanMaster) ? cleanMaster : video.videoPath;
    if (source === cleanMaster) {
      console.log("[shortsGenerator] Using caption-free master for the crop");
    } else {
      console.warn(
        "[shortsGenerator] No caption-free master found — cropping the burned video; captions will be small",
      );
    }

    // Clip, center-crop to 9:16 vertical, scale to 1080x1920
    const vf = ["crop=ih*9/16:ih", "scale=1080:1920", "setsar=1"].join(",");

    console.log(`[shortsGenerator] Clipping ${hook.startTime}-${hook.endTime} (${duration}s)`);
    await execFile(FFMPEG, [
      "-y", "-loglevel", "error",
      "-ss", String(startSec),
      "-i", source,
      "-t", String(duration),
      "-vf", vf,
      "-c:v", "libx264", "-preset", "fast",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      shortPath,
    ], { maxBuffer: 50 * 1024 * 1024 });

    // Burn Short-sized captions from the narration word timings.
    const manifest = await readManifest(join(process.cwd(), "audio", ctx.video.id));
    if (manifest && source === cleanMaster) {
      const alignments = await readAlignments(manifest);
      const all = buildLongformCaptions(
        alignments, manifest.segments.map((s) => s.offsetS), TITLE_CARD_DURATION,
      );
      const shorts = buildShortsCaptions(all.words, startSec, startSec + duration, 0);
      const assPath = join(tmpDir, "captions.ass");
      await writeFile(assPath, shorts.ass);
      const burned = join(tmpDir, "short-captioned.mp4");
      await execFile(FFMPEG, [
        "-y", "-loglevel", "error",
        "-i", shortPath,
        "-vf", `subtitles=${assPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "'\\''")}`,
        "-c:v", "libx264", "-preset", "fast",
        "-c:a", "copy",
        "-movflags", "+faststart",
        burned,
      ], { maxBuffer: 50 * 1024 * 1024 });
      await rename(burned, shortPath);
      console.log(`[shortsGenerator] Burned ${shorts.cues.length} Short-sized caption cues`);
    }

    console.log(`[shortsGenerator] Generated: ${shortPath}`);

    // Shorts previously uploaded with a hardcoded privacyStatus of "public",
    // bypassing every test-mode and scheduling guard the long-form path has.
    // Route them through the same upload-safety decision instead.
    const decision = await prepareUpload({
      channelKey: "ai-doom-scroll",
      serviceLabel: "shorts",
      existingYoutubeId: video.shortsUrl?.split("/").pop() ?? null,
      scheduledSlot: null,
    });

    if (decision.alreadyUploaded) {
      console.log(`[shortsGenerator] Short already uploaded (${video.shortsUrl}) — skipping`);
      await rm(tmpDir, { recursive: true, force: true });
      return { success: true, data: { shortsUrl: video.shortsUrl }, durationMs: Date.now() - start };
    }

    const youtube = getYouTubeClient();
    const title = `${video.seoTitle ?? video.topic.title} #Shorts`;

    const res = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: title.slice(0, 100),
          description: `Watch the full video: https://youtu.be/${video.youtubeId}\n\n#Shorts`,
          tags: [...(video.seoTags ?? []).slice(0, 5), "Shorts"],
          categoryId: "28",
        },
        status: {
          privacyStatus: decision.privacyStatus,
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: createReadStream(shortPath),
      },
    });

    const shortYoutubeId = res.data.id;
    if (!shortYoutubeId) {
      console.error("[shortsGenerator] YouTube API returned no Short ID");
      return { success: true, durationMs: Date.now() - start };
    }

    const shortsUrl = `https://youtube.com/shorts/${shortYoutubeId}`;
    console.log(`[shortsGenerator] Uploaded Short (${decision.privacyStatus}): ${shortsUrl}`);

    await confirmUploadState({
      channelKey: "ai-doom-scroll",
      serviceLabel: "shorts",
      youtubeId: shortYoutubeId,
      expectPrivate: true,
      videoId: ctx.video.id,
    }).catch((e) => console.warn(`[shortsGenerator] Upload confirmation failed: ${e}`));

    // Store shortsUrl on the Video record
    await prisma.video.update({
      where: { id: ctx.video.id },
      data: { shortsUrl },
    });

    await rm(tmpDir, { recursive: true, force: true });

    return {
      success: true,
      data: { shortsUrl },
      durationMs: Date.now() - start,
    };
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    console.error(`[shortsGenerator] Failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    // Non-fatal — don't block the pipeline over a Short
    return { success: true, durationMs: Date.now() - start };
  }
}
