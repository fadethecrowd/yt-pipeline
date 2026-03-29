import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "./lib/prisma";
import { youtube } from "./lib/youtube";
import { sendTelegram } from "./telegram";
import { ActionType } from "./lib/types";
import type { Decision } from "./lib/types";

const execFile = promisify(execFileCb);

const FFMPEG_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FFMPEG = existsSync(FFMPEG_FULL) ? FFMPEG_FULL : "ffmpeg";

async function ff(args: string[]): Promise<void> {
  console.log(`[shorts] ffmpeg ${args.slice(0, 6).join(" ")}...`);
  await execFile(FFMPEG, ["-y", "-loglevel", "error", ...args], {
    maxBuffer: 50 * 1024 * 1024,
  });
}

interface HookSegment {
  text: string;
  startTime: string; // "0:00"
  endTime: string;   // "0:52"
  segmentIndex: number;
}

function parseTimestamp(ts: string): number {
  const parts = ts.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

/**
 * Check for published videos that need Shorts generated.
 * Returns Decision[] — these are auto-executed (not approval-gated).
 */
export async function detectShortsNeeded(): Promise<Decision[]> {
  const decisions: Decision[] = [];

  const publishedVideos = await prisma.video.findMany({
    where: {
      youtubeId: { not: null },
      scheduledAt: { lte: new Date() },
      hookSegment: { not: null },
    },
    include: { topic: true },
  });

  for (const video of publishedVideos) {
    // Check if Short already generated
    const existing = await prisma.monitorAction.findFirst({
      where: {
        videoId: video.id,
        type: "GENERATE_SHORT",
        status: { in: ["PENDING", "EXECUTED", "AWAITING_APPROVAL"] },
      },
    });
    if (existing) continue;

    decisions.push({
      videoId: video.id,
      type: ActionType.GENERATE_SHORT,
      payload: { hookSegment: video.hookSegment },
      reason: "Generate YouTube Short from hook segment",
    });
  }

  return decisions;
}

/**
 * Generate a Short from the video's hook segment and upload it.
 */
export async function generateAndUploadShort(videoId: string): Promise<{ success: boolean; message: string }> {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    include: { topic: true },
  });

  if (!video?.videoPath || !video.hookSegment || !video.youtubeId) {
    return { success: false, message: "Missing videoPath, hookSegment, or youtubeId" };
  }

  let hook: HookSegment;
  try {
    hook = JSON.parse(video.hookSegment);
  } catch {
    return { success: false, message: "Invalid hookSegment JSON" };
  }

  const startSec = parseTimestamp(hook.startTime);
  const endSec = parseTimestamp(hook.endTime);
  const duration = endSec - startSec;

  if (duration <= 0 || duration > 60) {
    return { success: false, message: `Invalid Short duration: ${duration}s (must be 1-60s)` };
  }

  const tmpDir = join(process.cwd(), "tmp", `short-${videoId}`);
  await mkdir(tmpDir, { recursive: true });

  const shortPath = join(tmpDir, "short.mp4");

  try {
    // Clip, crop to 9:16 vertical (center crop), scale to 1080x1920
    // Add channel logo watermark in bottom-right if available
    const vf = [
      `crop=ih*9/16:ih`,           // center-crop to 9:16
      `scale=1080:1920`,           // scale to vertical HD
    ].join(",");

    await ff([
      "-ss", String(startSec),
      "-i", video.videoPath,
      "-t", String(duration),
      "-vf", vf,
      "-c:v", "libx264", "-preset", "fast",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      shortPath,
    ]);

    console.log(`[shorts] Generated short: ${shortPath} (${duration}s)`);

    // Upload to YouTube as a Short
    const yt = youtube();
    const title = `${video.seoTitle ?? video.topic.title} #Shorts`;

    const res = await yt.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: title.slice(0, 100),
          description: `Watch the full video: https://youtu.be/${video.youtubeId}\n\n#Shorts`,
          tags: [...(video.seoTags ?? []).slice(0, 5), "Shorts"],
          categoryId: "28",
        },
        status: {
          privacyStatus: "public",
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: createReadStream(shortPath),
      },
    });

    const shortYoutubeId = res.data.id;
    if (!shortYoutubeId) {
      return { success: false, message: "YouTube API returned no Short ID" };
    }

    const shortUrl = `https://youtube.com/shorts/${shortYoutubeId}`;
    console.log(`[shorts] Uploaded Short: ${shortUrl}`);

    // Send Telegram confirmation
    try {
      await sendTelegram(
        `Short uploaded — "${title.slice(0, 60)}"\n${shortUrl}\n\nFull video: https://youtu.be/${video.youtubeId}`,
      );
    } catch {
      // Non-fatal
    }

    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });

    return { success: true, message: `Short uploaded: ${shortUrl}` };
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[shorts] Failed: ${msg}`);
    return { success: false, message: msg };
  }
}
