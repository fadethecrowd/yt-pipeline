import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { VideoStatus } from "@prisma/client";
import { prisma, env } from "@yt-pipeline/pipeline-core";
import type { PipelineContext, ScriptSegment, StageResult } from "@yt-pipeline/pipeline-core";

const execFile = promisify(execFileCb);

const TITLE_CARD_DURATION = 4;
const MIN_CLIP_DURATION = 3;
const DURATION_TOLERANCE = 5;

// ── Helpers ──────────────────────────────────────────────────────────────

const FFMPEG_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FFPROBE_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe";

const FFMPEG = existsSync(FFMPEG_FULL) ? FFMPEG_FULL : "ffmpeg";
const FFPROBE = existsSync(FFPROBE_FULL) ? FFPROBE_FULL : "ffprobe";

async function ff(...args: string[]): Promise<void> {
  console.log(`[wc:assembly] ffmpeg ${args.slice(0, 4).join(" ")}...`);
  await execFile(FFMPEG, ["-y", "-loglevel", "error", ...args], {
    maxBuffer: 50 * 1024 * 1024,
  });
}

async function ffRaw(args: string[]): Promise<void> {
  console.log(`[wc:assembly] ffmpeg ${args.slice(0, 6).join(" ")}...`);
  await execFile(FFMPEG, args, { maxBuffer: 50 * 1024 * 1024 });
}

async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFile(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    filePath,
  ]);
  const dur = parseFloat(stdout.trim());
  if (isNaN(dur)) throw new Error(`Could not probe duration: ${filePath}`);
  return dur;
}

async function searchPexels(
  query: string,
  apiKey: string,
): Promise<string | null> {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape&size=medium`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) {
    console.warn(`[wc:assembly] Pexels search failed: ${res.status}`);
    return null;
  }
  const data = (await res.json()) as any;
  if (!data.videos?.length) return null;

  for (const video of data.videos) {
    const files = video.video_files as any[];
    const best = files
      .filter((f: any) => f.width >= 1280)
      .sort(
        (a: any, b: any) =>
          Math.abs(a.height - 1080) - Math.abs(b.height - 1080),
      )[0];
    const link = best?.link || files[0]?.link;
    if (link) return link;
  }
  return null;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

function wrapText(text: string, maxChars = 35): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > maxChars && line.length > 0) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function formatSRTTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const ms = Math.round((totalSeconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function generateSRT(
  segments: ScriptSegment[],
  actualDurations: number[],
  titleOffset: number,
): string {
  const entries: string[] = [];
  let idx = 1;
  let offset = titleOffset;

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const duration = actualDurations[s];
    const words = seg.narration.split(/\s+/);
    const WORDS_PER_CHUNK = 10;
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) {
      chunks.push(words.slice(i, i + WORDS_PER_CHUNK).join(" "));
    }
    const chunkDur = duration / chunks.length;

    for (let i = 0; i < chunks.length; i++) {
      const start = offset + i * chunkDur;
      const end = offset + (i + 1) * chunkDur;
      entries.push(
        `${idx}\n${formatSRTTime(start)} --> ${formatSRTTime(end)}\n${chunks[i]}`,
      );
      idx++;
    }
    offset += duration;
  }

  return entries.join("\n\n") + "\n";
}

function escapeFilterPath(p: string): string {
  return p
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'\\''");
}

// ── Clip preparation ────────────────────────────────────────────────────

async function generateFallbackClip(
  titleText: string,
  duration: number,
  outputPath: string,
  tmpDir: string,
  segIdx: number,
): Promise<void> {
  const titleFile = join(tmpDir, `seg-title-${segIdx}.txt`);
  await writeFile(titleFile, wrapText(titleText));
  await ff(
    "-f", "lavfi",
    "-i", `color=c=#2d2d44:s=1920x1080:d=${duration}:r=30`,
    "-vf", `format=yuv420p,drawtext=textfile='${escapeFilterPath(titleFile)}':fontsize=40:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`,
    "-c:v", "libx264", "-preset", "fast",
    "-t", String(duration),
    outputPath,
  );
}

async function prepareClip(
  seg: ScriptSegment,
  segAudioDuration: number,
  pexelsApiKey: string,
  tmpDir: string,
  clipPath: string,
): Promise<boolean> {
  const idx = seg.segmentIndex;

  console.log(`[wc:assembly] Segment ${idx}: searching Pexels for "${seg.visual_prompt.slice(0, 50)}..."`);
  const clipUrl = await searchPexels(seg.visual_prompt, pexelsApiKey);
  if (!clipUrl) {
    console.log(`[wc:assembly] Segment ${idx}: no Pexels result`);
    return false;
  }

  const rawPath = join(tmpDir, `raw-${idx}.mp4`);
  console.log(`[wc:assembly] Segment ${idx}: downloading clip...`);
  await downloadFile(clipUrl, rawPath);

  let clipDuration: number;
  try {
    clipDuration = await probeDuration(rawPath);
  } catch {
    console.warn(`[wc:assembly] Segment ${idx}: could not probe downloaded clip, using fallback`);
    return false;
  }

  console.log(`[wc:assembly] Segment ${idx}: clip duration ${clipDuration.toFixed(1)}s, need ${segAudioDuration.toFixed(1)}s`);

  if (clipDuration < MIN_CLIP_DURATION) {
    console.warn(`[wc:assembly] Segment ${idx}: clip too short (${clipDuration.toFixed(1)}s < ${MIN_CLIP_DURATION}s), using fallback`);
    return false;
  }

  let inputPath = rawPath;
  if (clipDuration < segAudioDuration) {
    const loopCount = Math.ceil(segAudioDuration / clipDuration) - 1;
    const loopedPath = join(tmpDir, `looped-${idx}.mp4`);
    console.log(`[wc:assembly] Segment ${idx}: looping ${loopCount + 1}x (${clipDuration.toFixed(1)}s × ${loopCount + 1} = ${((loopCount + 1) * clipDuration).toFixed(1)}s)`);

    await ffRaw([
      "-y", "-loglevel", "error",
      "-stream_loop", String(loopCount),
      "-i", rawPath,
      "-t", String(segAudioDuration),
      "-c", "copy",
      loopedPath,
    ]);

    const loopedDur = await probeDuration(loopedPath);
    if (loopedDur < segAudioDuration - 1) {
      console.warn(`[wc:assembly] Segment ${idx}: loop produced ${loopedDur.toFixed(1)}s, need ${segAudioDuration.toFixed(1)}s — using fallback`);
      return false;
    }
    inputPath = loopedPath;
  }

  await ff(
    "-i", inputPath,
    "-t", String(segAudioDuration),
    "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p",
    "-r", "30",
    "-c:v", "libx264", "-preset", "fast",
    "-an",
    clipPath,
  );

  const finalDur = await probeDuration(clipPath);
  console.log(`[wc:assembly] Segment ${idx}: final clip ${finalDur.toFixed(1)}s (target: ${segAudioDuration.toFixed(1)}s)`);
  if (finalDur < segAudioDuration - 1) {
    console.warn(`[wc:assembly] Segment ${idx}: final clip short (${finalDur.toFixed(1)}s vs ${segAudioDuration.toFixed(1)}s) — using fallback`);
    return false;
  }

  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────

/**
 * Wet Circuit video assembly stage.
 * Identical to pipeline-core version but uses prisma.wcVideo for DB writes.
 */
export async function wcVideoAssembly(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();

  if (!ctx.script || ctx.script.segments.length === 0) {
    return { success: false, error: "No script segments", durationMs: Date.now() - start };
  }

  const video = await prisma.wcVideo.findUnique({
    where: { id: ctx.video.id },
  });
  if (!video?.voiceoverPath) {
    return { success: false, error: "Missing voiceoverPath on video record", durationMs: Date.now() - start };
  }

  await prisma.wcVideo.update({
    where: { id: ctx.video.id },
    data: { status: VideoStatus.ASSEMBLY_PENDING },
  });

  const config = env();
  const tmpDir = join(process.cwd(), "tmp", ctx.video.id);
  const outputDir = join(process.cwd(), "output", ctx.video.id);
  await mkdir(tmpDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const segments = ctx.script.segments;

  // ── 1. Probe actual audio durations ────────────────────────────────

  const audioDir = join(process.cwd(), "audio", ctx.video.id);
  const actualDurations: number[] = [];
  for (const seg of segments) {
    const mp3Path = join(audioDir, `segment-${seg.segmentIndex}.mp3`);
    const dur = await probeDuration(mp3Path);
    actualDurations.push(dur);
    console.log(`[wc:assembly] Segment ${seg.segmentIndex} audio: ${dur.toFixed(1)}s (script estimate: ${seg.duration_seconds}s)`);
  }

  const expectedTotalDuration = TITLE_CARD_DURATION + actualDurations.reduce((a, b) => a + b, 0);

  // ── 2. Download Pexels clips & prepare each segment ────────────────

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const duration = actualDurations[s];
    const idx = seg.segmentIndex;
    const clipPath = join(tmpDir, `clip-${idx}.mp4`);

    let ok = false;
    try {
      ok = await prepareClip(seg, duration, config.PEXELS_API_KEY, tmpDir, clipPath);
    } catch (err) {
      console.warn(`[wc:assembly] Segment ${idx}: clip preparation error: ${err instanceof Error ? err.message : err}`);
    }

    if (!ok) {
      console.log(`[wc:assembly] Segment ${idx}: generating fallback card`);
      await generateFallbackClip(seg.title, duration, clipPath, tmpDir, idx);
    }

    console.log(`[wc:assembly] Prepared clip-${idx}.mp4 (${duration.toFixed(1)}s)`);
  }

  // ── 3. Title card ──────────────────────────────────────────────────

  const titleTextFile = join(tmpDir, "title.txt");
  await writeFile(titleTextFile, wrapText(ctx.topic.title));
  const titlePath = join(tmpDir, "title.mp4");
  await ff(
    "-f", "lavfi",
    "-i", `color=c=#1a1a2e:s=1920x1080:d=${TITLE_CARD_DURATION}:r=30`,
    "-vf", `format=yuv420p,drawtext=textfile='${escapeFilterPath(titleTextFile)}':fontsize=54:fontcolor=white:x=(w-tw)/2:y=(h-th)/2:line_spacing=10`,
    "-c:v", "libx264", "-preset", "fast",
    "-t", String(TITLE_CARD_DURATION),
    titlePath,
  );
  console.log(`[wc:assembly] Created title card (${TITLE_CARD_DURATION}s)`);

  // ── 4. Generate SRT subtitles ──────────────────────────────────────

  const srtPath = join(tmpDir, "subtitles.srt");
  await writeFile(srtPath, generateSRT(segments, actualDurations, TITLE_CARD_DURATION));
  console.log(`[wc:assembly] Generated subtitles.srt`);

  // ── 5. Concatenate all clips ───────────────────────────────────────

  const concatEntries = [
    `file '${titlePath}'`,
    ...segments.map((s) => `file '${join(tmpDir, `clip-${s.segmentIndex}.mp4`)}'`),
  ].join("\n");
  const concatFile = join(tmpDir, "concat.txt");
  await writeFile(concatFile, concatEntries);

  const concatPath = join(tmpDir, "concat.mp4");
  await ff(
    "-f", "concat", "-safe", "0",
    "-i", concatFile,
    "-c", "copy",
    concatPath,
  );
  console.log(`[wc:assembly] Concatenated ${segments.length + 1} clips`);

  // ── 6. Final pass: add audio + burn subtitles ──────────────────────

  const finalPath = join(outputDir, "final.mp4");
  const subtitleFilter = `subtitles=${escapeFilterPath(srtPath)}:force_style='FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,MarginV=40'`;

  await ff(
    "-i", concatPath,
    "-i", video.voiceoverPath,
    "-vf", subtitleFilter,
    "-c:v", "libx264", "-preset", "fast",
    "-c:a", "aac", "-b:a", "192k",
    "-map", "0:v", "-map", "1:a",
    "-shortest",
    "-movflags", "+faststart",
    finalPath,
  );
  console.log(`[wc:assembly] Final video: ${finalPath}`);

  // ── 7. Validate final video duration ───────────────────────────────

  const finalDuration = await probeDuration(finalPath);
  const drift = Math.abs(finalDuration - expectedTotalDuration);
  console.log(`[wc:assembly] Final duration: ${finalDuration.toFixed(1)}s (expected: ${expectedTotalDuration.toFixed(1)}s, drift: ${drift.toFixed(1)}s)`);

  if (drift > DURATION_TOLERANCE) {
    for (let s = 0; s < segments.length; s++) {
      const clipPath = join(tmpDir, `clip-${segments[s].segmentIndex}.mp4`);
      if (existsSync(clipPath)) {
        try {
          const clipDur = await probeDuration(clipPath);
          const expected = actualDurations[s];
          const segDrift = Math.abs(clipDur - expected);
          if (segDrift > 2) {
            console.warn(
              `[wc:assembly] WARNING: Segment ${segments[s].segmentIndex} ("${segments[s].title}") clip is ${clipDur.toFixed(1)}s but audio is ${expected.toFixed(1)}s (drift: ${segDrift.toFixed(1)}s)`,
            );
          }
        } catch {
          // clip may have been cleaned up already
        }
      }
    }
    console.warn(`[wc:assembly] WARNING: Final video duration drift ${drift.toFixed(1)}s exceeds ${DURATION_TOLERANCE}s tolerance`);
  }

  // ── 8. Cleanup tmp ─────────────────────────────────────────────────

  await rm(tmpDir, { recursive: true, force: true });

  // ── 9. Update DB ───────────────────────────────────────────────────

  await prisma.wcVideo.update({
    where: { id: ctx.video.id },
    data: {
      videoPath: finalPath,
      status: VideoStatus.ASSEMBLY_DONE,
    },
  });

  ctx.videoUrl = finalPath;

  return {
    success: true,
    data: { videoPath: finalPath, duration: finalDuration, expectedDuration: expectedTotalDuration },
    durationMs: Date.now() - start,
  };
}
