import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { env } from "../config";
import type { PipelineContext, ScriptSegment, StageResult } from "../types";

const execFile = promisify(execFileCb);

const TITLE_CARD_DURATION = 4;
const MIN_CLIP_DURATION = 3; // seconds — clips shorter than this are rejected
const DURATION_TOLERANCE = 5; // seconds — allowed drift in final duration validation

// ── Helpers ──────────────────────────────────────────────────────────────

// Use ffmpeg-full on macOS for drawtext filter support; fall back to PATH ffmpeg elsewhere
const FFMPEG_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FFPROBE_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe";

const FFMPEG = existsSync(FFMPEG_FULL) ? FFMPEG_FULL : "ffmpeg";
const FFPROBE = existsSync(FFPROBE_FULL) ? FFPROBE_FULL : "ffprobe";

async function ff(...args: string[]): Promise<void> {
  console.log(`[assembly] ffmpeg ${args.slice(0, 4).join(" ")}...`);
  await execFile(FFMPEG, ["-y", "-loglevel", "error", ...args], {
    maxBuffer: 50 * 1024 * 1024,
  });
}

/**
 * Run ffmpeg with raw args (no -y / -loglevel prepended).
 * Used when -stream_loop must be the very first input flag.
 */
async function ffRaw(args: string[]): Promise<void> {
  console.log(`[assembly] ffmpeg ${args.slice(0, 6).join(" ")}...`);
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
    console.warn(`[assembly] Pexels search failed: ${res.status}`);
    return null;
  }
  const data = (await res.json()) as any;
  if (!data.videos?.length) return null;

  // Try up to 3 results to find a usable clip
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

function formatASSTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const cs = Math.round((totalSeconds % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// Max chars per rendered subtitle line. Sized so a line stays well inside
// the center 9:16 crop (608 / 1920 ≈ 32% of source width) that shortsGenerator
// takes out of the burned long-form video. Tightened from 40 → 32 after
// real WC scripts produced 40+ char lines even under the balanced-split
// wrap (long compound words like "corrosion-resistant components" push
// both halves past a 40-char midpoint when the whole chunk is 70+ chars).
const SUBTITLE_MAX_CHARS_PER_LINE = 32;

// Pixel-width budget for one rendered subtitle line at FontSize=20+Outline=2
// on 1920-wide source, given the MarginL=MarginR=740 column. Used only as
// a pre-render estimator to warn when a wrapped line will likely overflow.
const SUBTITLE_COLUMN_PX = 440;

// Conservative per-character pixel-width table for FontSize=20 bold
// libass-rendered text with Outline=2 (outline adds ~2px padding per
// character side, ~2px effective net after adjacent-char overlap).
// Upper bound tuned so the sum is never below the real libass render.
function estimateRenderedWidthPx(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === " ") w += 7;
    else if (/[.,:;'"!?\-]/.test(ch)) w += 8;
    else if (/[ijlt]/.test(ch)) w += 7;
    else if (/[0-9]/.test(ch)) w += 12;
    else if (/[A-Z]/.test(ch)) w += 14;
    else if (/[mwW]/.test(ch)) w += 17;
    else if (/[a-z]/.test(ch)) w += 11;
    else w += 13; // unicode / emoji / fallback
    w += 2; // outline padding per char
  }
  return w;
}

/**
 * Wrap a subtitle cue into multiple lines so NO line exceeds `maxChars`.
 *
 * First pass: balanced midpoint split at the word boundary closest to
 * the character midpoint. If both halves still exceed `maxChars` (long
 * compound input) the function recurses on each half. Output therefore
 * grows to 3+ lines only for pathological inputs — every line is
 * guaranteed ≤ `maxChars` when any word boundary exists to split on.
 *
 * If the input is a single word longer than `maxChars` (impossible to
 * split on word boundaries), it's returned unchanged and flagged by
 * the caller's post-wrap assertion.
 */
function wrapSubtitleText(
  text: string,
  maxChars = SUBTITLE_MAX_CHARS_PER_LINE,
): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= maxChars) return clean;

  const words = clean.split(" ");
  if (words.length < 2) return clean; // single overlong word — unsplittable

  const mid = clean.length / 2;
  let bestSplit = 1;
  let bestDelta = Infinity;
  let running = 0;
  for (let i = 0; i < words.length - 1; i++) {
    running += words[i].length + (i > 0 ? 1 : 0);
    const delta = Math.abs(running - mid);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestSplit = i + 1;
    }
  }
  const line1 = words.slice(0, bestSplit).join(" ");
  const line2 = words.slice(bestSplit).join(" ");

  // Recurse if either half still overflows — guarantees ≤ maxChars per
  // line when word boundaries allow. Produces 3+ lines on pathologically
  // long chunks, which is acceptable vs. off-screen clipping.
  const needsRecurseA = line1.length > maxChars;
  const needsRecurseB = line2.length > maxChars;
  const wrappedA = needsRecurseA ? wrapSubtitleText(line1, maxChars) : line1;
  const wrappedB = needsRecurseB ? wrapSubtitleText(line2, maxChars) : line2;
  return `${wrappedA}\n${wrappedB}`;
}

function generateASS(
  segments: ScriptSegment[],
  actualDurations: number[],
  titleOffset: number,
): string {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,740,740,140,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const lines: string[] = [];
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
      const wrapped = wrapSubtitleText(chunks[i]);
      // Post-wrap safety assertions:
      //   (a) char-count cap — should always hold after recursive wrap
      //   (b) pixel-width estimate — conservative check that this line
      //       will fit inside the MarginL/MarginR column once rendered.
      //       Logs a distinctive warning so operator sees pathological
      //       content (e.g. long URL/number runs) that char count misses.
      for (const line of wrapped.split("\n")) {
        if (line.length > SUBTITLE_MAX_CHARS_PER_LINE) {
          console.warn(
            `[assembly/subtitle] Line exceeds ${SUBTITLE_MAX_CHARS_PER_LINE}-char cap after wrap: "${line}" (${line.length} ch) — cue ${idx}`,
          );
        }
        const estPx = estimateRenderedWidthPx(line);
        if (estPx > SUBTITLE_COLUMN_PX) {
          console.warn(
            `[assembly/subtitle] Line may overflow ${SUBTITLE_COLUMN_PX}px column at render: "${line}" (est ${estPx}px, ${line.length} ch) — cue ${idx}`,
          );
        }
      }
      lines.push(
        `Dialogue: 0,${formatASSTime(start)},${formatASSTime(end)},Default,,0,0,0,,${wrapped.replace(/\n/g, "\\N")}`,
      );
      idx++;
    }
    offset += duration;
  }

  return header + "\n" + lines.join("\n") + "\n";
}

// Escape path for ffmpeg filter graph (outside quotes)
function escapeFilterPath(p: string): string {
  return p
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'\\''");
}

// ── Clip preparation ────────────────────────────────────────────────────

/**
 * Generate a solid-color fallback card with segment title text.
 * Used when Pexels returns nothing or clip is too short.
 */
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

/**
 * Download a Pexels clip, verify duration, loop if needed, scale, and trim.
 * Returns true if successful, false if fallback should be used.
 */
async function prepareClip(
  seg: ScriptSegment,
  segAudioDuration: number,
  pexelsApiKey: string,
  tmpDir: string,
  clipPath: string,
): Promise<boolean> {
  const idx = seg.segmentIndex;

  // Step 1: Search Pexels
  console.log(`[assembly] Segment ${idx}: searching Pexels for "${seg.visual_prompt.slice(0, 50)}..."`);
  const clipUrl = await searchPexels(seg.visual_prompt, pexelsApiKey);
  if (!clipUrl) {
    console.log(`[assembly] Segment ${idx}: no Pexels result`);
    return false;
  }

  // Step 2: Download
  const rawPath = join(tmpDir, `raw-${idx}.mp4`);
  console.log(`[assembly] Segment ${idx}: downloading clip...`);
  await downloadFile(clipUrl, rawPath);

  // Step 3: Probe actual clip duration
  let clipDuration: number;
  try {
    clipDuration = await probeDuration(rawPath);
  } catch {
    console.warn(`[assembly] Segment ${idx}: could not probe downloaded clip, using fallback`);
    return false;
  }

  console.log(`[assembly] Segment ${idx}: clip duration ${clipDuration.toFixed(1)}s, need ${segAudioDuration.toFixed(1)}s`);

  // Step 4: Reject clips under minimum duration
  if (clipDuration < MIN_CLIP_DURATION) {
    console.warn(`[assembly] Segment ${idx}: clip too short (${clipDuration.toFixed(1)}s < ${MIN_CLIP_DURATION}s), using fallback`);
    return false;
  }

  // Step 5: Loop if clip is shorter than needed audio
  let inputPath = rawPath;
  if (clipDuration < segAudioDuration) {
    const loopCount = Math.ceil(segAudioDuration / clipDuration) - 1;
    const loopedPath = join(tmpDir, `looped-${idx}.mp4`);
    console.log(`[assembly] Segment ${idx}: looping ${loopCount + 1}x (${clipDuration.toFixed(1)}s × ${loopCount + 1} = ${((loopCount + 1) * clipDuration).toFixed(1)}s)`);

    // -stream_loop MUST be an input flag immediately before -i
    await ffRaw([
      "-y", "-loglevel", "error",
      "-stream_loop", String(loopCount),
      "-i", rawPath,
      "-t", String(segAudioDuration),
      "-c", "copy",
      loopedPath,
    ]);

    // Verify the looped file has sufficient duration
    const loopedDur = await probeDuration(loopedPath);
    if (loopedDur < segAudioDuration - 1) {
      console.warn(`[assembly] Segment ${idx}: loop produced ${loopedDur.toFixed(1)}s, need ${segAudioDuration.toFixed(1)}s — using fallback`);
      return false;
    }
    inputPath = loopedPath;
  }

  // Step 6: Scale to 1080p and trim to exact segment duration
  await ff(
    "-i", inputPath,
    "-t", String(segAudioDuration),
    "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p",
    "-r", "30",
    "-c:v", "libx264", "-preset", "fast",
    "-an",
    clipPath,
  );

  // Step 7: Verify final clip duration
  const finalDur = await probeDuration(clipPath);
  console.log(`[assembly] Segment ${idx}: final clip ${finalDur.toFixed(1)}s (target: ${segAudioDuration.toFixed(1)}s)`);
  if (finalDur < segAudioDuration - 1) {
    console.warn(`[assembly] Segment ${idx}: final clip short (${finalDur.toFixed(1)}s vs ${segAudioDuration.toFixed(1)}s) — using fallback`);
    return false;
  }

  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────

/**
 * Stage: Search Pexels for stock clips, assemble video with ffmpeg.
 * Lays voiceover audio, burns subtitles, adds title card.
 */
export async function videoAssembly(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();

  if (process.env.DISABLE_ELEVEN === "true") {
    console.log("[guard] DISABLE_ELEVEN active — skipping video assembly");
    const outputDir = join(process.cwd(), "video", ctx.video.id);
    await mkdir(outputDir, { recursive: true });
    const placeholderVideoPath = join(outputDir, "final.mp4");
    await writeFile(placeholderVideoPath, Buffer.from([]));
    await prisma.video.update({
      where: { id: ctx.video.id },
      data: {
        videoPath: placeholderVideoPath,
        status: VideoStatus.ASSEMBLY_DONE,
      },
    });
    ctx.videoUrl = placeholderVideoPath;
    return { success: true, durationMs: Date.now() - start };
  }

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
      `[assembly] Segment ${seg.segmentIndex} audio: ${dur.toFixed(1)}s (script estimate: ${seg.duration_seconds}s)`,
    );
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
      console.warn(`[assembly] Segment ${idx}: clip preparation error: ${err instanceof Error ? err.message : err}`);
    }

    if (!ok) {
      console.log(`[assembly] Segment ${idx}: generating fallback card`);
      await generateFallbackClip(seg.title, duration, clipPath, tmpDir, idx);
    }

    console.log(`[assembly] Prepared clip-${idx}.mp4 (${duration.toFixed(1)}s)`);
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
  console.log(`[assembly] Created title card (${TITLE_CARD_DURATION}s)`);

  // ── 4. Generate SRT subtitles ──────────────────────────────────────

  const assPath = join(tmpDir, "subtitles.ass");
  await writeFile(assPath, generateASS(segments, actualDurations, TITLE_CARD_DURATION));
  console.log(`[assembly] Generated subtitles.ass`);

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
  console.log(`[assembly] Concatenated ${segments.length + 1} clips`);

  // ── 6. Final pass: add audio + burn subtitles ──────────────────────

  const finalPath = join(outputDir, "final.mp4");
  // Subtitles are generated as ASS (not SRT) so that PlayResX=1920 /
  // PlayResY=1080 are explicit in the script header. With SRT, FFmpeg's
  // internal conversion uses the ASS default PlayResY=288, which makes
  // margin values scale as fractions of frame height rather than pixels
  // (MarginV=140 with PlayResY=288 lands near the vertical center).
  //
  // Pixel geometry with PlayResX=1920, PlayResY=1080 (all values are pixels):
  //   column = 1920 − 740 − 740 = 440 px wide, centered at x=960
  //   column bounds on source        = [740, 1180]
  //   shortsGenerator crop keeps     = [656, 1264]
  //   subtitle inside crop with      ≈ 80 px margin each side
  //   after scale to 1080×1920 Short = 440 × (1080/608) ≈ 782 px, centered
  //   MarginV=140 on source (1080px) → after Short scale: 140×(1920/1080) ≈ 249 px from bottom
  const subtitleFilter = `subtitles=${escapeFilterPath(assPath)}`;

  await ff(
    "-i", concatPath,
    "-i", video.voiceoverPath,
    "-vf", subtitleFilter,
    // Narration must start AFTER the title card: subtitle cues, chapter
    // timestamps, and segment visuals are all laid out assuming audio
    // begins at TITLE_CARD_DURATION. all=1 delays every channel (mono or
    // stereo) without needing per-channel values.
    "-af", `adelay=${TITLE_CARD_DURATION * 1000}:all=1`,
    "-c:v", "libx264", "-preset", "fast",
    "-c:a", "aac", "-b:a", "192k",
    "-map", "0:v", "-map", "1:a",
    "-shortest",
    "-movflags", "+faststart",
    finalPath,
  );
  console.log(`[assembly] Final video: ${finalPath}`);

  // ── 7. Validate final video duration ───────────────────────────────

  const finalDuration = await probeDuration(finalPath);
  const drift = Math.abs(finalDuration - expectedTotalDuration);
  console.log(`[assembly] Final duration: ${finalDuration.toFixed(1)}s (expected: ${expectedTotalDuration.toFixed(1)}s, drift: ${drift.toFixed(1)}s)`);

  if (drift > DURATION_TOLERANCE) {
    // Identify which segment(s) may have caused the mismatch
    let offset = TITLE_CARD_DURATION;
    for (let s = 0; s < segments.length; s++) {
      const clipPath = join(tmpDir, `clip-${segments[s].segmentIndex}.mp4`);
      if (existsSync(clipPath)) {
        try {
          const clipDur = await probeDuration(clipPath);
          const expected = actualDurations[s];
          const segDrift = Math.abs(clipDur - expected);
          if (segDrift > 2) {
            console.warn(
              `[assembly] WARNING: Segment ${segments[s].segmentIndex} ("${segments[s].title}") clip is ${clipDur.toFixed(1)}s but audio is ${expected.toFixed(1)}s (drift: ${segDrift.toFixed(1)}s)`,
            );
          }
        } catch {
          // clip may have been cleaned up already
        }
      }
      offset += actualDurations[s];
    }

    console.warn(`[assembly] WARNING: Final video duration drift ${drift.toFixed(1)}s exceeds ${DURATION_TOLERANCE}s tolerance`);
  }

  // ── 8. Cleanup tmp ─────────────────────────────────────────────────

  await rm(tmpDir, { recursive: true, force: true });

  // ── 9. Update DB ───────────────────────────────────────────────────

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
    data: { videoPath: finalPath, duration: finalDuration, expectedDuration: expectedTotalDuration },
    durationMs: Date.now() - start,
  };
}
