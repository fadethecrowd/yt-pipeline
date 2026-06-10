import { join } from "node:path";
import { mkdir, rm, writeFile, rename } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { google } from "googleapis";
import { prisma, env } from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult } from "@yt-pipeline/pipeline-core";

const execFile = promisify(execFileCb);

const FFMPEG_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FFMPEG = existsSync(FFMPEG_FULL) ? FFMPEG_FULL : "ffmpeg";

const HOOK_DURATION_SECS = 2.5;
const SHORT_MAX_SECS = 55;
const MIN_SHORT_SECS = 30;
const SHORT_CAPTION_FONT_SIZE = 72;
const SHORT_WORDS_PER_CAPTION = 5;
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

async function tryPrependBikiniHook(
  shortPath: string,
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
  const combinedPath = join(tmpDir, "combined.mp4");

  try {
    const dlRes = await fetch(hookUrl);
    if (!dlRes.ok) {
      console.warn(`[wc:shorts] Hook clip download failed: HTTP ${dlRes.status} for ${hookUrl}`);
      return false;
    }
    await writeFile(rawHookPath, Buffer.from(await dlRes.arrayBuffer()));

    // crop/scale to 1080x1920, trim to HOOK_DURATION_SECS, use voiceover audio if available
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

    // concat hook + main short
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
    return true;
  } catch (err) {
    console.warn(
      `[wc:shorts] Hook clip processing failed: ${err instanceof Error ? err.message : err}`,
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

// ── Sentence-boundary duration trim ──────────────────────────────────────

function trimToSentenceBoundary(text: string, rawDuration: number): number {
  if (rawDuration <= SHORT_MAX_SECS) return rawDuration;

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0);
  if (sentences.length <= 1) return Math.min(rawDuration, SHORT_MAX_SECS);

  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
  let charsSoFar = 0;
  let bestEnd = 0;

  for (const sentence of sentences) {
    charsSoFar += sentence.length;
    const estimatedEnd = (charsSoFar / totalChars) * rawDuration;
    if (estimatedEnd <= SHORT_MAX_SECS) {
      bestEnd = estimatedEnd;
    } else {
      break;
    }
  }

  // If no good sentence boundary found above MIN_SHORT_SECS, hard-cap instead
  if (bestEnd >= MIN_SHORT_SECS) return bestEnd;
  return Math.min(rawDuration, SHORT_MAX_SECS);
}

// ── Shorts ASS captions ───────────────────────────────────────────────────

function formatASSTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const cs = Math.round((totalSeconds % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function generateShortsASS(
  text: string,
  totalDuration: number,
  fontSize: number,
  timeOffset = 0,
): string {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,1,2,60,60,300,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const words = text.trim().split(/\s+/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += SHORT_WORDS_PER_CAPTION) {
    chunks.push(words.slice(i, i + SHORT_WORDS_PER_CAPTION).join(" "));
  }

  const chunkDur = totalDuration / Math.max(chunks.length, 1);
  const lines: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const s = timeOffset + i * chunkDur;
    const e = timeOffset + (i + 1) * chunkDur;
    // A negative timeOffset (bikini-hook path) shifts cues earlier; cues
    // that end at/before 0 cover words spoken under the hook clip (which
    // has no captions burned) and are dropped. The cue straddling 0 is
    // clamped — formatASSTime can't represent negative timestamps.
    if (e <= 0) continue;
    lines.push(
      `Dialogue: 0,${formatASSTime(Math.max(0, s))},${formatASSTime(e)},Default,,0,0,0,,${chunks[i]}`,
    );
  }

  return header + "\n" + lines.join("\n") + "\n";
}

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

  const startSec = parseTimestamp(hook.startTime);
  const endSec = parseTimestamp(hook.endTime);
  const rawDuration = endSec - startSec;

  if (rawDuration <= 0 || rawDuration > 120) {
    console.warn(
      `[wc:shortsGenerator] Invalid duration ${rawDuration}s — skipping`,
    );
    return { success: true, durationMs: Date.now() - start };
  }

  const trimDuration = trimToSentenceBoundary(hook.text ?? "", rawDuration);
  console.log(
    `[wc:shorts] Selected end timestamp=${(startSec + trimDuration).toFixed(1)}s` +
      ` (trimDuration=${trimDuration.toFixed(1)}s, raw=${rawDuration.toFixed(1)}s)`,
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

    console.log(`[wc:shorts] Caption font size=${SHORT_CAPTION_FONT_SIZE}`);
    const assPath = join(tmpDir, "captions.ass");
    // Captions are burned into the MAIN short, which in the final concat
    // starts at absolute t=hookOffset and whose audio is seeked by
    // -ss hookOffset (step 5) — main-local time t carries voiceover time
    // t + hookOffset. Caption chunk i covers voiceover [i·d, (i+1)·d], so
    // cues must shift EARLIER by hookOffset (negative offset; cues fully
    // inside the hook window are dropped by generateShortsASS). A positive
    // shift here double-counts the hook and lags every caption by
    // 2×HOOK_DURATION_SECS. hookOffset=0 (hook off) is unaffected.
    await writeFile(
      assPath,
      generateShortsASS(hook.text ?? "", trimDuration, SHORT_CAPTION_FONT_SIZE, -hookOffset),
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
      console.error("[wc:shortsGenerator] YouTube API returned no Short ID");
      return { success: true, durationMs: Date.now() - start };
    }

    const shortsUrl = `https://youtube.com/shorts/${shortYoutubeId}`;
    console.log(`[wc:shortsGenerator] Uploaded Short: ${shortsUrl}`);

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
