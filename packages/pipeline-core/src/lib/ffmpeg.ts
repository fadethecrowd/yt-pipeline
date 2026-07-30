import { execFile as execFileCb, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const FFMPEG_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FFPROBE_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe";

export const FFMPEG = existsSync(FFMPEG_FULL) ? FFMPEG_FULL : "ffmpeg";
export const FFPROBE = existsSync(FFPROBE_FULL) ? FFPROBE_FULL : "ffprobe";

const BIG = 128 * 1024 * 1024;

export async function ff(args: string[], label = "ffmpeg"): Promise<void> {
  console.log(`[${label}] ffmpeg ${args.slice(0, 6).join(" ")}…`);
  await execFile(FFMPEG, ["-y", "-loglevel", "error", ...args], { maxBuffer: BIG });
}

export async function ffRaw(args: string[], label = "ffmpeg"): Promise<void> {
  console.log(`[${label}] ffmpeg ${args.slice(0, 8).join(" ")}…`);
  await execFile(FFMPEG, args, { maxBuffer: BIG });
}

export async function ffprobeJson(args: string[]): Promise<any> {
  const { stdout } = await execFile(
    FFPROBE,
    ["-v", "error", "-of", "json", ...args],
    { maxBuffer: BIG },
  );
  return JSON.parse(stdout);
}

/**
 * Container-header duration. Fast, but for MP3 this is an ESTIMATE derived
 * from the Xing/bitrate header — it does not match the decoded sample count.
 * Use `decodedDuration` for anything that drives a timeline.
 */
export async function headerDuration(path: string): Promise<number> {
  const { stdout } = await execFile(
    FFPROBE,
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { maxBuffer: BIG },
  );
  const d = parseFloat(stdout.trim());
  if (Number.isNaN(d)) throw new Error(`Could not probe duration: ${path}`);
  return d;
}

/**
 * Exact decoded audio duration, from the real sample count.
 *
 * This is the only duration safe to build a timeline on. Header duration on a
 * concatenated MP3 disagrees with the decoded stream by ~30 ms per join, which
 * silently desynchronises captions and video from the audio actually rendered.
 */
export async function decodedDuration(path: string): Promise<number> {
  const SAMPLE_RATE = 44100;
  const BYTES_PER_SAMPLE = 2; // s16le, mono

  return new Promise<number>((resolve, reject) => {
    // Decode to raw PCM on stdout and count bytes. Streaming, so memory stays
    // constant, and the byte count is the exact decoded sample count — which
    // ffprobe's container metadata is not.
    const proc = spawn(FFMPEG, [
      "-v", "error",
      "-i", path,
      "-f", "s16le", "-acodec", "pcm_s16le",
      "-ac", "1", "-ar", String(SAMPLE_RATE),
      "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let bytes = 0;
    let err = "";
    proc.stdout.on("data", (c: Buffer) => { bytes += c.length; });
    proc.stderr.on("data", (c: Buffer) => { err += c.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0 && bytes === 0) {
        reject(new Error(`Could not decode audio (${path}): ${err.slice(0, 300)}`));
        return;
      }
      resolve(bytes / BYTES_PER_SAMPLE / SAMPLE_RATE);
    });
  });
}

export async function videoDuration(path: string): Promise<number> {
  const j = await ffprobeJson([
    "-select_streams", "v:0",
    "-show_entries", "stream=duration:format=duration",
    path,
  ]);
  const d = Number(j.streams?.[0]?.duration ?? j.format?.duration);
  if (!Number.isFinite(d)) throw new Error(`Could not probe video duration: ${path}`);
  return d;
}

export interface MediaInfo {
  width?: number;
  height?: number;
  fps?: number;
  vCodec?: string;
  aCodec?: string;
  durationS?: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export async function mediaInfo(path: string): Promise<MediaInfo> {
  const j = await ffprobeJson(["-show_streams", "-show_format", path]);
  const v = (j.streams ?? []).find((s: any) => s.codec_type === "video");
  const a = (j.streams ?? []).find((s: any) => s.codec_type === "audio");
  let fps: number | undefined;
  if (v?.avg_frame_rate && v.avg_frame_rate !== "0/0") {
    const [n, d] = v.avg_frame_rate.split("/").map(Number);
    if (d) fps = n / d;
  }
  return {
    width: v?.width, height: v?.height, fps,
    vCodec: v?.codec_name, aCodec: a?.codec_name,
    durationS: Number(j.format?.duration) || undefined,
    hasAudio: Boolean(a), hasVideo: Boolean(v),
  };
}

export interface NarrationTrack {
  path: string;
  /** Exact decoded duration of the assembled track. */
  durationS: number;
  /** Exact start offset of each source segment inside the track. */
  segmentOffsets: number[];
  /** Exact decoded duration of each source segment. */
  segmentDurations: number[];
}

/**
 * Assemble per-segment MP3s into one narration track, sample-exactly.
 *
 * The previous implementation byte-concatenated the MP3 files. That leaves
 * each file's ID3/Xing header inline, so the decoded result is longer than the
 * sum of the parts and the container header reports a third value again. Every
 * downstream timeline was built on the wrong number.
 *
 * Here the segments are decoded and joined with the `concat` filter, which
 * operates on PCM samples, then encoded once. Segment offsets are therefore
 * the exact cumulative decoded durations and carry no join error.
 */
export async function buildNarrationTrack(
  segmentPaths: string[],
  outPath: string,
  label = "audio",
): Promise<NarrationTrack> {
  if (segmentPaths.length === 0) throw new Error("No narration segments to assemble");

  const segmentDurations: number[] = [];
  for (const p of segmentPaths) segmentDurations.push(await decodedDuration(p));

  const inputs = segmentPaths.flatMap((p) => ["-i", p]);
  const filter =
    segmentPaths.map((_, i) => `[${i}:a]`).join("") +
    `concat=n=${segmentPaths.length}:v=0:a=1[out]`;

  await ff(
    [
      ...inputs,
      "-filter_complex", filter,
      "-map", "[out]",
      "-ar", "44100", "-ac", "1",
      "-c:a", "libmp3lame", "-b:a", "192k",
      outPath,
    ],
    label,
  );

  const durationS = await decodedDuration(outPath);

  const segmentOffsets: number[] = [];
  let acc = 0;
  for (const d of segmentDurations) {
    segmentOffsets.push(acc);
    acc += d;
  }

  const joinError = Math.abs(durationS - acc);
  console.log(
    `[${label}] narration track: ${durationS.toFixed(3)}s from ${segmentPaths.length} segments ` +
      `(sum of parts ${acc.toFixed(3)}s, join error ${(joinError * 1000).toFixed(1)}ms)`,
  );
  if (joinError > 0.05) {
    console.warn(
      `[${label}] WARNING: narration join error ${(joinError * 1000).toFixed(1)}ms exceeds 50ms`,
    );
  }

  return { path: outPath, durationS, segmentOffsets, segmentDurations };
}

/** Silence windows, used to detect dead air and verify narration is present. */
export async function detectSilence(
  path: string,
  noiseDb = -40,
  minDurS = 1.0,
): Promise<{ start: number; end: number }[]> {
  const { stderr } = await execFile(
    FFMPEG,
    ["-v", "info", "-i", path, "-af", `silencedetect=noise=${noiseDb}dB:d=${minDurS}`, "-f", "null", "-"],
    { maxBuffer: BIG },
  ).catch((e: any) => ({ stderr: e?.stderr ?? "", stdout: "" }));

  const out: { start: number; end: number }[] = [];
  let cur: number | null = null;
  for (const line of String(stderr).split("\n")) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (s) cur = parseFloat(s[1]);
    if (e && cur !== null) {
      out.push({ start: cur, end: parseFloat(e[1]) });
      cur = null;
    }
  }
  return out;
}

/** Mean volume / peak, used to prove the track is not silent and not clipping. */
export async function volumeStats(
  path: string,
): Promise<{ meanDb: number; maxDb: number }> {
  const { stderr } = await execFile(
    FFMPEG,
    ["-v", "info", "-i", path, "-af", "volumedetect", "-f", "null", "-"],
    { maxBuffer: BIG },
  ).catch((e: any) => ({ stderr: e?.stderr ?? "" }));
  const mean = String(stderr).match(/mean_volume:\s*(-?[\d.]+) dB/);
  const max = String(stderr).match(/max_volume:\s*(-?[\d.]+) dB/);
  return {
    meanDb: mean ? parseFloat(mean[1]) : NaN,
    maxDb: max ? parseFloat(max[1]) : NaN,
  };
}

/**
 * Fraction of sampled frames that are (near) black, and the longest run of
 * consecutive black frames in seconds.
 */
export async function blackFrameStats(
  path: string,
): Promise<{ blackSeconds: number; longestRunS: number }> {
  const { stderr } = await execFile(
    FFMPEG,
    ["-v", "info", "-i", path, "-vf", "blackdetect=d=0.5:pic_th=0.98", "-an", "-f", "null", "-"],
    { maxBuffer: BIG },
  ).catch((e: any) => ({ stderr: e?.stderr ?? "" }));

  let total = 0;
  let longest = 0;
  for (const m of String(stderr).matchAll(/black_start:(-?[\d.]+) black_end:(-?[\d.]+) black_duration:([\d.]+)/g)) {
    const d = parseFloat(m[3]);
    total += d;
    if (d > longest) longest = d;
  }
  return { blackSeconds: total, longestRunS: longest };
}

/**
 * Detect frozen video: mean absolute frame-to-frame difference per second.
 * Returns the longest run (seconds) where consecutive frames are ~identical.
 */
export async function frozenRunSeconds(path: string): Promise<number> {
  const { stderr } = await execFile(
    FFMPEG,
    ["-v", "info", "-i", path, "-vf", "freezedetect=n=-60dB:d=2", "-an", "-f", "null", "-"],
    { maxBuffer: BIG },
  ).catch((e: any) => ({ stderr: e?.stderr ?? "" }));

  let longest = 0;
  for (const m of String(stderr).matchAll(/freeze_duration:\s*([\d.]+)/g)) {
    const d = parseFloat(m[1]);
    if (d > longest) longest = d;
  }
  return longest;
}

export async function extractFrame(
  videoPath: string,
  atSeconds: number,
  outPath: string,
): Promise<void> {
  await ff(
    ["-ss", String(atSeconds), "-i", videoPath, "-frames:v", "1", "-q:v", "2", outPath],
    "frame",
  );
}
