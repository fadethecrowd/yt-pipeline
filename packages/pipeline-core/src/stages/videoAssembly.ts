import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { env } from "../config";
import type { PipelineContext, ScriptSegment, StageResult } from "../types";

const execFile = promisify(execFileCb);

const TITLE_CARD_DURATION = 4;

// ── Helpers ──────────────────────────────────────────────────────────────

// Use ffmpeg-full on macOS for drawtext filter support; fall back to PATH ffmpeg elsewhere
const FFMPEG_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FFPROBE_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe";

const FFMPEG = require("fs").existsSync(FFMPEG_FULL) ? FFMPEG_FULL : "ffmpeg";
const FFPROBE = require("fs").existsSync(FFPROBE_FULL) ? FFPROBE_FULL : "ffprobe";

async function ff(...args: string[]): Promise<void> {
  console.log(`[assembly] ffmpeg ${args.slice(0, 4).join(" ")}...`);
  await execFile(FFMPEG, ["-y", "-loglevel", "error", ...args], {
    maxBuffer: 50 * 1024 * 1024,
  });
}

async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFile(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    filePath,
  ]);
  return parseFloat(stdout.trim());
}

async function searchPexels(
  query: string,
  apiKey: string
): Promise<string | null> {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape&size=medium`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) {
    console.warn(`[assembly] Pexels search failed: ${res.status}`);
    return null;
  }
  const data = (await res.json()) as any;
  if (!data.videos?.length) return null;

  const files = data.videos[0].video_files as any[];
  // Prefer HD quality closest to 1080p
  const best = files
    .filter((f: any) => f.width >= 1280)
    .sort(
      (a: any, b: any) =>
        Math.abs(a.height - 1080) - Math.abs(b.height - 1080)
    )[0];
  return best?.link || files[0]?.link || null;
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
  titleOffset: number
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
        `${idx}\n${formatSRTTime(start)} --> ${formatSRTTime(end)}\n${chunks[i]}`
      );
      idx++;
    }
    offset += duration;
  }

  return entries.join("\n\n") + "\n";
}

// Escape path for ffmpeg filter graph (outside quotes)
function escapeFilterPath(p: string): string {
  return p
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'\\''");
}

// ── Main ─────────────────────────────────────────────────────────────────

/**
 * Stage: Search Pexels for stock clips, assemble video with ffmpeg.
 * Lays voiceover audio, burns subtitles, adds title card.
 */
export async function videoAssembly(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();

  if (!ctx.script || ctx.script.segments.length === 0) {
    return {
      success: false,
      error: "No script segments",
      durationMs: Date.now() - start,
    };
  }

  // Re-read video from DB to get voiceoverPath set by previous stage
  const video = await prisma.video.findUnique({
    where: { id: ctx.video.id },
  });
  if (!video?.voiceoverPath) {
    return {
      success: false,
      error: "Missing voiceoverPath on video record",
      durationMs: Date.now() - start,
    };
  }

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: { status: VideoStatus.ASSEMBLY_PENDING },
  });

  const config = env();
  const tmpDir = join(process.cwd(), "tmp", ctx.video.id);
  const outputDir = join(process.cwd(), "output", ctx.video.id);
  await mkdir(tmpDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const segments = ctx.script.segments;

  // ── 1. Probe actual audio durations from segment MP3s ──────────────

  const audioDir = join(process.cwd(), "audio", ctx.video.id);
  const actualDurations: number[] = [];
  for (const seg of segments) {
    const mp3Path = join(audioDir, `segment-${seg.segmentIndex}.mp3`);
    const dur = await probeDuration(mp3Path);
    actualDurations.push(dur);
    console.log(
      `[assembly] Segment ${seg.segmentIndex} audio: ${dur.toFixed(1)}s (script estimate: ${seg.duration_seconds}s)`
    );
  }

  // ── 2. Download Pexels clips & prepare each segment ────────────────

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const duration = actualDurations[s];
    const idx = seg.segmentIndex;
    const clipPath = join(tmpDir, `clip-${idx}.mp4`);

    console.log(
      `[assembly] Segment ${idx}: searching Pexels for "${seg.visual_prompt.slice(0, 50)}..."`
    );
    const clipUrl = await searchPexels(seg.visual_prompt, config.PEXELS_API_KEY);

    if (clipUrl) {
      const rawPath = join(tmpDir, `raw-${idx}.mp4`);
      console.log(`[assembly] Downloading clip for segment ${idx}...`);
      await downloadFile(clipUrl, rawPath);

      // Scale to 1080p, trim/loop to actual audio duration
      await ff(
        "-stream_loop", "-1",
        "-i", rawPath,
        "-t", String(duration),
        "-vf",
        "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p",
        "-r", "30",
        "-c:v", "libx264", "-preset", "fast",
        "-an",
        clipPath
      );
      console.log(
        `[assembly] Prepared clip-${idx}.mp4 (${duration.toFixed(1)}s)`
      );
    } else {
      // Fallback: dark background with segment title
      console.log(
        `[assembly] No Pexels result for segment ${idx}, using fallback`
      );
      const titleFile = join(tmpDir, `seg-title-${idx}.txt`);
      await writeFile(titleFile, wrapText(seg.title));
      await ff(
        "-f", "lavfi",
        "-i",
        `color=c=#2d2d44:s=1920x1080:d=${duration}:r=30`,
        "-vf",
        `format=yuv420p,drawtext=textfile='${escapeFilterPath(titleFile)}':fontsize=40:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`,
        "-c:v", "libx264", "-preset", "fast",
        "-t", String(duration),
        clipPath
      );
    }
  }

  // ── 2. Title card ──────────────────────────────────────────────────

  const titleTextFile = join(tmpDir, "title.txt");
  await writeFile(titleTextFile, wrapText(ctx.topic.title));
  const titlePath = join(tmpDir, "title.mp4");
  await ff(
    "-f", "lavfi",
    "-i",
    `color=c=#1a1a2e:s=1920x1080:d=${TITLE_CARD_DURATION}:r=30`,
    "-vf",
    `format=yuv420p,drawtext=textfile='${escapeFilterPath(titleTextFile)}':fontsize=54:fontcolor=white:x=(w-tw)/2:y=(h-th)/2:line_spacing=10`,
    "-c:v", "libx264", "-preset", "fast",
    "-t", String(TITLE_CARD_DURATION),
    titlePath
  );
  console.log(`[assembly] Created title card (${TITLE_CARD_DURATION}s)`);

  // ── 3. Generate SRT subtitles ──────────────────────────────────────

  const srtPath = join(tmpDir, "subtitles.srt");
  await writeFile(srtPath, generateSRT(segments, actualDurations, TITLE_CARD_DURATION));
  console.log(`[assembly] Generated subtitles.srt`);

  // ── 4. Concatenate all clips ───────────────────────────────────────

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
    concatPath
  );
  console.log(
    `[assembly] Concatenated ${segments.length + 1} clips`
  );

  // ── 5. Final pass: add audio + burn subtitles ──────────────────────

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
    finalPath
  );
  console.log(`[assembly] Final video: ${finalPath}`);

  // ── 6. Cleanup tmp ─────────────────────────────────────────────────

  await rm(tmpDir, { recursive: true, force: true });

  // ── 7. Update DB ───────────────────────────────────────────────────

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      videoPath: finalPath,
      status: VideoStatus.ASSEMBLY_DONE,
    },
  });

  ctx.videoUrl = finalPath;

  return {
    success: true,
    data: { videoPath: finalPath },
    durationMs: Date.now() - start,
  };
}
