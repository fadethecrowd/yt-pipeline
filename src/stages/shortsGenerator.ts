import { join } from "node:path";
import { mkdir, rm, rename, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  prisma, prepareUpload, confirmUploadState, buildYouTubeClient,
  readManifest, readAlignments, buildLongformCaptions, buildShortsCaptions,
  resolveHookWindow, validateHookWindow, HookAlignmentError,
  TITLE_CARD_DURATION,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult, HookWindow } from "@yt-pipeline/pipeline-core";

const execFile = promisify(execFileCb);

const FFMPEG_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FFMPEG = existsSync(FFMPEG_FULL) ? FFMPEG_FULL : "ffmpeg";

interface HookSegment {
  text: string;
  startTime: string;
  endTime: string;
  segmentIndex: number;
}

/**
 * Clip bounds, in seconds of narration.
 *
 * 55 rather than 60 leaves headroom under YouTube's Shorts ceiling: the window
 * ends on a word, so the last word may run slightly past the target and the
 * mux adds its own rounding. The hard 60s guard below stays as a backstop.
 *
 * AI Doom enforced no minimum at all before this, which is how a badly aligned
 * hook could have produced a two-second Short. 20s is a floor, not a target —
 * segment 0 runs 80s+ on every script measured, so in practice the maximum is
 * what binds.
 */
const SHORT_MAX_SECS = 55;
const SHORT_MIN_SECS = 20;

export interface ShortBuild {
  /** The finished, captioned MP4. */
  path: string;
  /** Directory the caller owns and should clean up. */
  tmpDir: string;
  /** The window actually clipped, on the video timeline. */
  window: HookWindow;
  cueCount: number;
  usedCleanMaster: boolean;
}

/**
 * Build the Short's MP4 from stored artifacts. No DB writes, no upload.
 *
 * Split out from the stage so a Short can be produced and watched without
 * touching YouTube or the database — the review path and the production path
 * then run the same code, which is the only way a local preview means anything.
 *
 * The window comes from `resolveHookWindow`, not from `hookSegment`'s
 * timestamps. Those were derived from the script's ESTIMATED
 * `duration_seconds` and clamped to `0:04-0:59`, so every AI Doom Short would
 * have been the same fixed 55s slice regardless of where sentences actually
 * fell. On JomCkkxN-AM that cut after "Attackers only need to be right once"
 * and dropped the answering clause. Locating the hook text in the real word
 * timings snaps both edges to word boundaries and prefers the last sentence
 * that fits.
 *
 * Throws on any condition that should mean "no Short" — never falls back to an
 * estimate.
 */
export async function buildShortFile(opts: {
  videoId: string;
  videoPath: string;
  hookText: string;
  /** Defaults to tmp/short-<videoId>. */
  outDir?: string;
  log?: (m: string) => void;
}): Promise<ShortBuild> {
  const log = opts.log ?? (() => {});
  const tmpDir = opts.outDir ?? join(process.cwd(), "tmp", `short-${opts.videoId}`);
  await mkdir(tmpDir, { recursive: true });
  const shortPath = join(tmpDir, "short.mp4");

  // Crop the caption-free master when it exists, so the Short gets captions
  // sized for a 1080x1920 frame instead of inheriting long-form captions that
  // were sized for 1920x1080 and then upscaled by the crop.
  const cleanMaster = opts.videoPath.replace(/final\.mp4$/, "final-clean.mp4");
  const usedCleanMaster = existsSync(cleanMaster);
  const source = usedCleanMaster ? cleanMaster : opts.videoPath;
  log(usedCleanMaster
    ? "[shorts] Using caption-free master for the crop"
    : "[shorts] No caption-free master found — cropping the burned video; captions will be small");

  const manifest = await readManifest(join(process.cwd(), "audio", opts.videoId));
  if (!manifest) throw new Error("no narration manifest — cannot align the hook");
  const alignments = await readAlignments(manifest);
  const all = buildLongformCaptions(
    alignments, manifest.segments.map((s) => s.offsetS), TITLE_CARD_DURATION,
  );

  const window = resolveHookWindow({
    words: all.words,
    hookText: opts.hookText,
    maxDurationS: SHORT_MAX_SECS,
    minDurationS: SHORT_MIN_SECS,
  });
  validateHookWindow(window, all.words);

  // Backstop: the resolver caps at SHORT_MAX_SECS, but YouTube's own ceiling is
  // the thing that actually matters and it is checked against the real number.
  if (window.durationS <= 0 || window.durationS > 60) {
    throw new Error(`resolved window ${window.durationS.toFixed(2)}s outside the 0-60s Shorts ceiling`);
  }
  log(
    `[shorts] window ${window.startS.toFixed(2)}s-${window.endS.toFixed(2)}s ` +
    `(${window.durationS.toFixed(2)}s, ${window.words.length} words, ` +
    `match ${(window.matchRatio * 100).toFixed(0)}%)`,
  );

  const vf = ["crop=ih*9/16:ih", "scale=1080:1920", "setsar=1"].join(",");
  await execFile(FFMPEG, [
    "-y", "-loglevel", "error",
    "-ss", String(window.startS),
    "-i", source,
    "-t", String(window.durationS),
    "-vf", vf,
    "-c:v", "libx264", "-preset", "fast",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    shortPath,
  ], { maxBuffer: 50 * 1024 * 1024 });

  // Captions re-based onto clip-local time. The crop already seeked to
  // window.startS, so narration time window.startS + t is clip time t; passing
  // the window start as the base applies that shift exactly once.
  let cueCount = 0;
  if (usedCleanMaster) {
    const shorts = buildShortsCaptions(all.words, window.startS, window.endS, 0);
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
    cueCount = shorts.cues.length;
    log(`[shorts] Burned ${cueCount} Short-sized caption cues`);
  }

  return { path: shortPath, tmpDir, window, cueCount, usedCleanMaster };
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
    return { success: true, data: { outcome: "SKIPPED", reason: "DISABLE_ELEVEN" }, durationMs: Date.now() - start };
  }

  const video = await prisma.video.findUnique({
    where: { id: ctx.video.id },
    include: { topic: true },
  });

  if (!video?.hookSegment) {
    console.log("[shortsGenerator] No hookSegment — skipping Short");
    return { success: true, data: { outcome: "SKIPPED", reason: "no hookSegment" }, durationMs: Date.now() - start };
  }

  if (!video.videoPath || !existsSync(video.videoPath)) {
    console.log(`[shortsGenerator] Video file not on disk — skipping Short`);
    return { success: true, data: { outcome: "SKIPPED", reason: "master not on disk" }, durationMs: Date.now() - start };
  }

  if (!video.youtubeId) {
    console.log("[shortsGenerator] No youtubeId — skipping Short");
    return { success: true, data: { outcome: "SKIPPED", reason: "no youtubeId" }, durationMs: Date.now() - start };
  }

  let hook: HookSegment;
  try {
    hook = JSON.parse(video.hookSegment);
  } catch {
    console.warn("[shortsGenerator] Invalid hookSegment JSON — skipping");
    return { success: true, data: { outcome: "SKIPPED", reason: "hookSegment is not valid JSON" }, durationMs: Date.now() - start };
  }

  const build = await buildShortFile({
    videoId: ctx.video.id,
    videoPath: video.videoPath,
    hookText: hook.text ?? "",
    log: (m) => console.log(m),
  }).catch((err: unknown) => err instanceof Error ? err : new Error(String(err)));

  if (build instanceof Error) {
    const reason = build.message;
    console.warn(`[shortsGenerator] ${reason} — no Short produced`);
    return {
      success: true,
      data: { outcome: "SKIPPED", reason },
      durationMs: Date.now() - start,
    };
  }
  const { path: shortPath, tmpDir, window } = build;

  try {
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

    const youtube = buildYouTubeClient();
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
      // The upload may well have landed; we just cannot name it. Say so rather
      // than returning a bare success that reads as "no Short was wanted".
      const reason = "YouTube accepted the upload but returned no Short ID";
      console.error(`[shortsGenerator] ${reason}`);
      return { success: true, data: { outcome: "FAILED", reason }, durationMs: Date.now() - start };
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
      data: {
        outcome: "GENERATED", shortsUrl,
        windowStartS: +window.startS.toFixed(3),
        windowEndS: +window.endS.toFixed(3),
        windowDurationS: +window.durationS.toFixed(3),
      },
      durationMs: Date.now() - start,
    };
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[shortsGenerator] Failed (non-fatal): ${reason}`);
    // Still non-fatal — a Short must never block publishing the long-form —
    // but the reason now travels in the result instead of vanishing into a
    // bare success, so a caller or the run summary can see what happened.
    return { success: true, data: { outcome: "FAILED", reason }, durationMs: Date.now() - start };
  }
}
