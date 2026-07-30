import { join } from "node:path";
import { mkdir, rm, writeFile, rename } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { google } from "googleapis";
import {
  prisma, env, prepareUpload, confirmUploadState,
  readManifest, readAlignments, buildLongformCaptions, buildShortsCaptions,
  resolveHookWindow, validateHookWindow, HookAlignmentError,
  TITLE_CARD_DURATION,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult } from "@yt-pipeline/pipeline-core";

const execFile = promisify(execFileCb);

const FFMPEG_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FFMPEG = existsSync(FFMPEG_FULL) ? FFMPEG_FULL : "ffmpeg";

const HOOK_DURATION_SECS = 2.5;
const SHORT_MAX_SECS = 55;
const MIN_SHORT_SECS = 30;
const SHORT_CAPTION_FONT_SIZE = 72;
const NUM_VISUAL_CLIPS = 3;

// ── Bikini hook ───────────────────────────────────────────────────────────

const BIKINI_KEYWORDS = [
  "bikini beach",
  "bikini boat",
  "bikini marina",
  "beach bikini woman",
  "paddleboard woman",
  "jet ski woman",
  "marina lifestyle",
  "boat bikini woman",
  "dock bikini",
  "marine lifestyle woman",
];

async function searchPexelsHook(
  query: string,
  apiKey: string,
): Promise<string | null> {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&size=medium`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) return null;
  const data = (await res.json()) as any;
  if (!data.videos?.length) return null;
  for (const video of data.videos) {
    const files = (video.video_files as any[])
      .filter((f: any) => f.width >= 720)
      .sort((a: any, b: any) => b.width - a.width);
    const link = files[0]?.link ?? null;
    if (link) return link as string;
  }
  return null;
}

// Searches for and transcodes the hook clip without concatenating — determines
// hookOffset before short.mp4 exists so audio seek and captions can be pre-shifted.
async function tryPrepareHookClip(
  tmpDir: string,
  pexelsApiKey: string,
): Promise<boolean> {
  let hookUrl: string | null = null;
  for (const kw of BIKINI_KEYWORDS) {
    try {
      hookUrl = await searchPexelsHook(kw, pexelsApiKey);
    } catch (err) {
      console.warn(`[wc:shorts] Pexels hook search failed for keyword "${kw}": ${err instanceof Error ? err.message : err}`);
    }
    if (hookUrl) break;
  }
  if (!hookUrl) return false;

  const rawHookPath = join(tmpDir, "hook-raw.mp4");
  const hookReadyPath = join(tmpDir, "hook-ready.mp4");

  try {
    const dlRes = await fetch(hookUrl);
    if (!dlRes.ok) {
      console.warn(`[wc:shorts] Hook clip download failed: HTTP ${dlRes.status} for ${hookUrl}`);
      return false;
    }
    await writeFile(rawHookPath, Buffer.from(await dlRes.arrayBuffer()));

    const hookAudioPath = join(tmpDir, "hook-audio.aac");
    const hasHookAudio = existsSync(hookAudioPath);
    const hookAudioInput: string[] = hasHookAudio
      ? ["-i", hookAudioPath]
      : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];

    await execFile(FFMPEG, [
      "-y", "-loglevel", "error",
      "-i", rawHookPath,
      ...hookAudioInput,
      "-t", String(HOOK_DURATION_SECS),
      "-vf", "crop=ih*9/16:ih,scale=1080:1920,setsar=1,format=yuv420p",
      "-r", "30",
      "-c:v", "libx264", "-preset", "fast",
      "-c:a", "aac", "-b:a", "128k",
      "-map", "0:v", "-map", "1:a",
      hookReadyPath,
    ], { maxBuffer: 50 * 1024 * 1024 });

    return true;
  } catch (err) {
    console.warn(
      `[wc:shorts] Hook clip preparation failed: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

// ── Fresh Pexels clips for visual track ──────────────────────────────────

async function searchPexelsMulti(
  query: string,
  apiKey: string,
  count: number,
): Promise<string[]> {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${count * 2}&orientation=landscape&size=medium`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) return [];
  const data = (await res.json()) as any;
  if (!data.videos?.length) return [];
  const links: string[] = [];
  for (const video of data.videos) {
    if (links.length >= count) break;
    const files = (video.video_files as any[])
      .filter((f: any) => f.width >= 1280)
      .sort(
        (a: any, b: any) =>
          Math.abs(a.height - 1080) - Math.abs(b.height - 1080),
      );
    const link = files[0]?.link ?? null;
    if (link) links.push(link as string);
  }
  return links;
}

// The former trimToSentenceBoundary() estimated a sentence boundary by
// character proportion of an estimated duration. The clip window is now
// resolved against real word timings by resolveHookWindow(), which snaps to
// actual sentence-ending words, so the estimator has been removed.

// ── Shorts ASS captions ───────────────────────────────────────────────────

// The former generateShortsASS() lived here. It divided the hook text into
// fixed 5-word chunks of equal duration (totalDuration / chunkCount), which
// ignored pauses and speech-rate variation and drifted exactly the way the
// long-form path used to. It has been removed rather than deprecated so it
// cannot be selected again by accident; Shorts captions are now built by
// buildShortsCaptions() from the narration manifest's real word timings.

function escapeASSPath(p: string): string {
  return p
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'\\''");
}

// ── Shared helpers ────────────────────────────────────────────────────────

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

// ── Main ──────────────────────────────────────────────────────────────────

export async function wcShortsGenerator(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();

  // Startup diagnostic — confirm env flags before any early returns
  console.log(
    `[wc:shorts] WC_SHORTS_BIKINI_HOOK=${process.env.WC_SHORTS_BIKINI_HOOK ?? "unset"}`,
  );
  console.log(
    `[wc:shorts] DISABLE_ELEVEN=${process.env.DISABLE_ELEVEN ?? "unset"}`,
  );
  console.log(`[wc:shorts] DRY_RUN=${process.env.DRY_RUN ?? "unset"}`);

  if (process.env.DISABLE_ELEVEN === "true") {
    console.log("[wc:guard] DISABLE_ELEVEN active — skipping Shorts generation");
    return { success: true, durationMs: Date.now() - start };
  }

  const video = await prisma.wcVideo.findUnique({
    where: { id: ctx.video.id },
    include: { topic: true },
  });

  if (!video?.hookSegment) {
    console.log("[wc:shortsGenerator] No hookSegment — skipping Short");
    return { success: true, durationMs: Date.now() - start };
  }

  if (!video.videoPath || !existsSync(video.videoPath)) {
    console.log("[wc:shortsGenerator] Video file not on disk — skipping Short");
    return { success: true, durationMs: Date.now() - start };
  }

  if (!video.youtubeId) {
    console.log("[wc:shortsGenerator] No youtubeId — skipping Short");
    return { success: true, durationMs: Date.now() - start };
  }

  let hook: HookSegment;
  try {
    hook = JSON.parse(video.hookSegment);
  } catch {
    console.warn("[wc:shortsGenerator] Invalid hookSegment JSON — skipping");
    return { success: true, durationMs: Date.now() - start };
  }

  // ── Resolve the clip window from the FINAL audio ─────────────────────
  //
  // hookSegment's timestamps come from the script's estimated
  // duration_seconds, which never matches the real narration. Locate the hook
  // text in the actual spoken words instead and snap the window to word
  // boundaries. If it cannot be aligned we skip the Short — we never fall back
  // to a words-per-minute estimate.
  const audioDir = join(process.cwd(), "audio", ctx.video.id);
  const manifest = await readManifest(audioDir);
  if (!manifest) {
    console.warn("[wc:shortsGenerator] No narration manifest — cannot align hook, skipping Short");
    return { success: true, durationMs: Date.now() - start };
  }

  const alignments = await readAlignments(manifest);
  const allCaptions = buildLongformCaptions(
    alignments,
    manifest.segments.map((s) => s.offsetS),
    TITLE_CARD_DURATION,
  );

  let window;
  try {
    window = resolveHookWindow({
      words: allCaptions.words,
      hookText: hook.text ?? "",
      maxDurationS: SHORT_MAX_SECS,
      minDurationS: MIN_SHORT_SECS,
    });
    validateHookWindow(window, allCaptions.words);
  } catch (err) {
    if (err instanceof HookAlignmentError) {
      console.warn(`[wc:shortsGenerator] ${err.message} — skipping Short (no estimated fallback)`);
      return { success: true, durationMs: Date.now() - start };
    }
    throw err;
  }

  const startSec = window.startS;
  const trimDuration = window.durationS;
  console.log(
    `[wc:shorts] Hook window from final audio: ${window.startS.toFixed(2)}s–${window.endS.toFixed(2)}s ` +
      `(${trimDuration.toFixed(2)}s, ${window.words.length} words, match ${(window.matchRatio * 100).toFixed(0)}%)`,
  );

  const tmpDir = join(process.cwd(), "tmp", `short-${ctx.video.id}`);
  await mkdir(tmpDir, { recursive: true });
  const shortPath = join(tmpDir, "short.mp4");

  try {
    const config = env();
    const topicQuery = video.topic?.title ?? "boating";

    // ── 1. Extract voiceover audio from hook time range ────────────────

    const audioPath = join(tmpDir, "hook-audio.aac");
    await execFile(FFMPEG, [
      "-y", "-loglevel", "error",
      "-ss", String(startSec),
      "-i", video.videoPath,
      "-t", String(trimDuration),
      "-vn",
      "-c:a", "aac", "-b:a", "128k",
      audioPath,
    ], { maxBuffer: 50 * 1024 * 1024 });

    // ── 1b. Prepare bikini hook — hook-audio.aac is ready at this point ──
    // Must run before step 4 so hookOffset is known for caption + audio sync.

    let hookInserted = false;
    if (process.env.WC_SHORTS_BIKINI_HOOK === "true") {
      console.log("[wc:shorts] Bikini hook enabled — preparing clip");
      hookInserted = await tryPrepareHookClip(tmpDir, config.PEXELS_API_KEY);
      console.log(hookInserted
        ? "[wc:shorts] Bikini hook clip prepared"
        : "[wc:shorts] Bikini hook skipped — no suitable clip found");
    }
    const hookOffset = hookInserted ? HOOK_DURATION_SECS : 0;

    // ── 2. Fetch 3 fresh Pexels clips for visual variety ───────────────

    const clipLinks = await searchPexelsMulti(
      topicQuery,
      config.PEXELS_API_KEY,
      NUM_VISUAL_CLIPS,
    );
    console.log(
      `[wc:shorts] Pexels returned ${clipLinks.length} clip(s) for "${topicQuery}"`,
    );

    const clipDuration = trimDuration / NUM_VISUAL_CLIPS;
    const preparedClips: string[] = [];

    for (let i = 0; i < NUM_VISUAL_CLIPS; i++) {
      const clipPath = join(tmpDir, `visual-${i}.mp4`);
      const link = clipLinks[i];
      let ok = false;

      if (link) {
        try {
          const rawPath = join(tmpDir, `raw-${i}.mp4`);
          const dlRes = await fetch(link);
          if (dlRes.ok) {
            await writeFile(rawPath, Buffer.from(await dlRes.arrayBuffer()));
            // -stream_loop -1 loops the clip until -t is satisfied
            await execFile(FFMPEG, [
              "-y", "-loglevel", "error",
              "-stream_loop", "-1",
              "-i", rawPath,
              "-t", String(clipDuration),
              "-vf", "crop=ih*9/16:ih,scale=1080:1920,setsar=1,format=yuv420p",
              "-r", "30",
              "-c:v", "libx264", "-preset", "fast",
              "-an",
              clipPath,
            ], { maxBuffer: 50 * 1024 * 1024 });
            ok = true;
          }
        } catch (err) {
          console.warn(
            `[wc:shorts] Visual clip ${i} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      if (!ok) {
        const escapedQuery = topicQuery.replace(/'/g, "\\'");
        // Fallback: dark blue card matching long-form title card style
        await execFile(FFMPEG, [
          "-y", "-loglevel", "error",
          "-f", "lavfi",
          "-i", `color=c=#1a1a2e:s=1080x1920:d=${clipDuration}:r=30`,
          "-vf", `drawtext=text='${escapedQuery}':fontsize=48:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`,
          "-c:v", "libx264", "-preset", "fast",
          clipPath,
        ], { maxBuffer: 50 * 1024 * 1024 });
      }

      preparedClips.push(clipPath);
      console.log(
        `[wc:shorts] Visual clip ${i + 1}/${NUM_VISUAL_CLIPS}: ${ok ? "pexels" : "fallback"} (${clipDuration.toFixed(1)}s)`,
      );
    }

    // ── 3. Concat visual clips ─────────────────────────────────────────

    const concatFile = join(tmpDir, "concat.txt");
    await writeFile(
      concatFile,
      preparedClips.map((p) => `file '${p}'`).join("\n"),
    );
    const visualPath = join(tmpDir, "visual.mp4");
    await execFile(FFMPEG, [
      "-y", "-loglevel", "error",
      "-f", "concat", "-safe", "0",
      "-i", concatFile,
      "-c", "copy",
      visualPath,
    ], { maxBuffer: 50 * 1024 * 1024 });

    // ── 4. Generate mobile-optimised captions ──────────────────────────

    const assPath = join(tmpDir, "captions.ass");
    // Captions are burned into the MAIN short. In the final concat the main
    // short begins at absolute t=hookOffset, and its audio is seeked by
    // -ss hookOffset (step 5), so main-local time t carries narration time
    // window.startS + hookOffset + t. buildShortsCaptions re-bases the real
    // word timings onto that local timeline, so the hook offset is applied
    // exactly once and the cues keep the pauses the speaker actually took.
    const shortCaptions = buildShortsCaptions(
      allCaptions.words,
      window.startS + hookOffset,
      window.endS,
      0,
    );
    await writeFile(assPath, shortCaptions.ass);
    console.log(
      `[wc:shorts] ${shortCaptions.cues.length} caption cues from real word timings ` +
        `(first ${shortCaptions.firstCueStart.toFixed(2)}s, last ends ${shortCaptions.lastCueEnd.toFixed(2)}s, hookOffset ${hookOffset}s)`,
    );

    // ── 5. Combine visual + captions + audio → short.mp4 ──────────────

    await execFile(FFMPEG, [
      "-y", "-loglevel", "error",
      "-i", visualPath,
      ...(hookOffset > 0 ? ["-ss", String(hookOffset)] : []),
      "-i", audioPath,
      "-vf", `subtitles=${escapeASSPath(assPath)}`,
      "-af", "apad=pad_dur=1.5",
      "-c:v", "libx264", "-preset", "fast",
      "-c:a", "aac", "-b:a", "128k",
      "-map", "0:v", "-map", "1:a",
      "-movflags", "+faststart",
      shortPath,
    ], { maxBuffer: 50 * 1024 * 1024 });

    console.log(`[wc:shortsGenerator] Generated: ${shortPath}`);

    // ── 6. Prepend hook clip prepared in step 1b ───────────────────────

    if (hookInserted) {
      const hookReadyPath = join(tmpDir, "hook-ready.mp4");
      const combinedPath = join(tmpDir, "combined.mp4");
      await execFile(FFMPEG, [
        "-y", "-loglevel", "error",
        "-i", hookReadyPath,
        "-i", shortPath,
        "-filter_complex", "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[outv][outa]",
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "libx264", "-preset", "fast",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        combinedPath,
      ], { maxBuffer: 50 * 1024 * 1024 });
      await rename(combinedPath, shortPath);
      console.log("[wc:shorts] Bikini hook inserted successfully");
    }

    // ── 7. DRY_RUN — skip upload, leave file on disk for inspection ────

    if (process.env.DRY_RUN === "true") {
      console.log(
        `[wc:shorts] DRY_RUN active — skipping upload. Inspect: ${shortPath}`,
      );
      return {
        success: true,
        data: { shortPath },
        durationMs: Date.now() - start,
      };
    }

    // ── 8. Upload ──────────────────────────────────────────────────────

    // Shorts previously uploaded with a hardcoded privacyStatus of "public",
    // bypassing the launch gate and every test-mode guard the long-form path
    // has. Route them through the same upload-safety decision instead.
    const decision = await prepareUpload({
      channelKey: "wet-circuit",
      serviceLabel: "wc:shorts",
      existingYoutubeId: video.shortsUrl?.split("/").pop() ?? null,
      scheduledSlot: null,
    });

    if (decision.alreadyUploaded) {
      console.log(`[wc:shorts] Short already uploaded (${video.shortsUrl}) — skipping`);
      await rm(tmpDir, { recursive: true, force: true });
      return { success: true, data: { shortsUrl: video.shortsUrl }, durationMs: Date.now() - start };
    }

    const youtube = getYouTubeClient();
    const title = `${video.seoTitle ?? video.topic?.title ?? ctx.topic.title} #Shorts`;

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
      console.error("[wc:shortsGenerator] YouTube API returned no Short ID");
      return { success: true, durationMs: Date.now() - start };
    }

    const shortsUrl = `https://youtube.com/shorts/${shortYoutubeId}`;
    console.log(`[wc:shortsGenerator] Uploaded Short (${decision.privacyStatus}): ${shortsUrl}`);

    await confirmUploadState({
      channelKey: "wet-circuit",
      serviceLabel: "wc:shorts",
      youtubeId: shortYoutubeId,
      expectPrivate: true,
      videoId: ctx.video.id,
    }).catch((e) => console.warn(`[wc:shorts] Upload confirmation failed: ${e}`));

    await prisma.wcVideo.update({
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
    console.error(
      `[wc:shortsGenerator] Failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
    return { success: true, durationMs: Date.now() - start };
  }
}
