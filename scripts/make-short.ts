/**
 * Build a Short from stored artifacts so a human can watch the cut.
 *
 *   npx tsx scripts/make-short.ts --video <candidateId> [--out tmp/shorts]
 *   npx tsx scripts/make-short.ts --video <candidateId> --compare
 *
 * Calls the SAME `buildShortFile` the production stage calls, so what you watch
 * is what the pipeline would upload. It stops there: no YouTube client is
 * constructed, no upload is attempted, and nothing is written to the database —
 * in particular `shortsUrl` is left alone, so this cannot be mistaken later for
 * a Short that actually shipped.
 *
 * `--compare` also reports the window the OLD estimate-derived logic would have
 * produced, for the same video, without rendering it.
 *
 * LOCAL ONLY. Read-only against the database.
 */
import { mkdirSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  prisma, disconnect, readManifest, readAlignments, buildLongformCaptions,
  TITLE_CARD_DURATION,
} from "@yt-pipeline/pipeline-core";
import { buildShortFile } from "../src/stages/shortsGenerator";
import "dotenv/config";

const execFile = promisify(execFileCb);
const FFPROBE = "ffprobe";

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
};
const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;

/** What the pre-fix code would have clipped: the estimated, clamped window. */
function legacyWindow(hook: { startTime: string; endTime: string }) {
  const p = (ts: string) => {
    const q = ts.split(":").map(Number);
    return q.length === 2 ? q[0]! * 60 + q[1]! : q.length === 3 ? q[0]! * 3600 + q[1]! * 60 + q[2]! : 0;
  };
  const startS = p(hook.startTime);
  const endS = p(hook.endTime);
  return { startS, endS, durationS: endS - startS };
}

async function main(): Promise<void> {
  const videoId = arg("--video");
  if (!videoId) {
    console.error("✗ --video <candidateId> is required");
    process.exitCode = 2; return;
  }

  const video = await prisma.video.findUnique({
    where: { id: videoId }, include: { topic: { select: { title: true } } },
  });
  if (!video) { console.error(`✗ no candidate ${videoId}`); process.exitCode = 1; return; }
  if (!video.hookSegment) { console.error("✗ candidate has no hookSegment"); process.exitCode = 1; return; }
  if (!video.videoPath || !existsSync(video.videoPath)) {
    console.error(`✗ master not on disk: ${video.videoPath}`); process.exitCode = 1; return;
  }
  const hook = JSON.parse(video.hookSegment) as
    { text: string; startTime: string; endTime: string };

  console.log(`\n  candidate : ${videoId}`);
  console.log(`  youtubeId : ${video.youtubeId ?? "(none)"}`);
  console.log(`  topic     : ${video.topic?.title ?? "(none)"}`);
  console.log(`  shortsUrl : ${video.shortsUrl ?? "null (untouched by this script)"}\n`);

  // ── The window the old code would have used ─────────────────────────
  const manifest = await readManifest(join(process.cwd(), "audio", videoId));
  if (!manifest) { console.error("✗ no narration manifest"); process.exitCode = 1; return; }
  const all = buildLongformCaptions(
    await readAlignments(manifest), manifest.segments.map((s) => s.offsetS), TITLE_CARD_DURATION,
  );
  const legacy = legacyWindow(hook);
  const inLegacy = all.words.filter((w) => w.start >= legacy.startS && w.end <= legacy.endS);
  console.log(`  OLD window (estimated, clamped): ${mmss(legacy.startS)} → ${mmss(legacy.endS)}  (${legacy.durationS.toFixed(2)}s)`);
  console.log(`    ends: …${inLegacy.slice(-12).map((w) => w.text).join(" ")}`);
  const nextWord = all.words.find((w) => w.start >= legacy.endS);
  console.log(`    next word dropped: "${nextWord?.text ?? "(none)"}"`);
  const legacyEndsSentence = /[.!?](["')\]]+)?$/.test(inLegacy[inLegacy.length - 1]?.text ?? "");
  console.log(`    ends on a complete sentence: ${legacyEndsSentence}\n`);

  if (process.argv.includes("--compare")) { await disconnect(); return; }

  // ── Build with the corrected logic ──────────────────────────────────
  const outDir = resolve(arg("--out") ?? "tmp/shorts", videoId);
  mkdirSync(outDir, { recursive: true });
  const build = await buildShortFile({
    videoId, videoPath: video.videoPath, hookText: hook.text ?? "",
    outDir, log: (m) => console.log(`  ${m}`),
  });

  console.log(`\n  NEW window (word-aligned):      ${mmss(build.window.startS)} → ${mmss(build.window.endS)}  (${build.window.durationS.toFixed(2)}s)`);
  console.log(`    ends: …${build.window.words.slice(-12).map((w) => w.text).join(" ")}`);
  const last = build.window.words[build.window.words.length - 1]?.text ?? "";
  console.log(`    ends on a complete sentence: ${/[.!?](["')\]]+)?$/.test(last)}`);

  const { stdout } = await execFile(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration",
    "-show_entries", "stream=width,height,codec_name",
    "-of", "default=noprint_wrappers=1", build.path,
  ]).catch(() => ({ stdout: "(ffprobe unavailable)" }));

  console.log(`\n  ✓ MP4: ${build.path}`);
  console.log(`    ${(statSync(build.path).size / 1024 / 1024).toFixed(1)} MB, ${build.cueCount} caption cues burned in`);
  for (const line of String(stdout).trim().split("\n")) console.log(`    ${line}`);
  console.log(`\n  NOT uploaded. No database row written.\n`);
  await disconnect();
}

main().catch(async (e) => { console.error(e); await disconnect(); process.exitCode = 1; });
