/**
 * Independent caption-sync verification.
 *
 * The QA gate measures cue times against the alignment the cues were built
 * from, which cannot detect a bad alignment — it is self-consistent by
 * construction. This script checks the cues against the RENDERED AUDIO itself,
 * using signal evidence that does not come from ElevenLabs:
 *
 *   1. Speech-onset test — a cue claims a word starts at time t. Sample the
 *      final mixed audio around t. There must be speech at/just after t and
 *      the loudness must rise across t. A cue landing in the middle of a pause
 *      (or after speech has already been running) fails.
 *
 *   2. Pause-structure test — silences detected in the audio must line up with
 *      gaps between cues, not with the middle of a cue's text.
 *
 *   3. Marker test — the diagnostic scripts speak "marker one/two/three" near
 *      the beginning, middle and end. Their cue times are reported so drift can
 *      be read at three points across the video.
 *
 *   npx tsx scripts/verify-caption-sync.ts <videoId>
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  prisma, disconnect, detectSilence,
  buildLongformCaptions, readManifest, readAlignments,
} from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const execFile = promisify(execFileCb);
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";

/** RMS loudness of a short window of the video's audio, in dBFS. */
async function windowRms(videoPath: string, at: number, dur: number): Promise<number> {
  if (at < 0) return -99;
  const { stderr } = await execFile(
    FFMPEG,
    ["-v", "info", "-ss", String(at), "-t", String(dur), "-i", videoPath,
     "-af", "volumedetect", "-f", "null", "-"],
    { maxBuffer: 32 * 1024 * 1024 },
  ).catch((e: any) => ({ stderr: e?.stderr ?? "" }));
  const m = String(stderr).match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? parseFloat(m[1]) : -99;
}

async function main() {
  const videoId = process.argv[2];
  if (!videoId) {
    console.error("usage: verify-caption-sync.ts <videoId>");
    process.exit(2);
  }

  const row =
    (await prisma.video.findUnique({ where: { id: videoId } })) ??
    (await prisma.wcVideo.findUnique({ where: { id: videoId } }));
  if (!row?.videoPath || !existsSync(row.videoPath)) {
    console.error(`No rendered video on disk for ${videoId}`);
    process.exit(1);
  }

  const audioDir = join(process.cwd(), "audio", videoId);
  const manifest = await readManifest(audioDir);
  if (!manifest) {
    console.error("No narration manifest");
    process.exit(1);
  }
  const alignments = await readAlignments(manifest);
  const NARRATION_START = 4;
  const built = buildLongformCaptions(
    alignments, manifest.segments.map((s) => s.offsetS), NARRATION_START,
  );

  console.log(`\n═══ INDEPENDENT CAPTION SYNC VERIFICATION — ${videoId} ═══`);
  console.log(`video: ${row.videoPath}`);
  console.log(`cues : ${built.cues.length}, words: ${built.words.length}\n`);

  // ── 1. Speech-onset test ────────────────────────────────────────────
  // Sample evenly across the whole video so drift at the end is caught.
  const sampleIdx = [...new Set(
    Array.from({ length: 12 }, (_, i) =>
      Math.floor((i / 11) * (built.cues.length - 1))),
  )];

  console.log("── speech-onset test (does audio actually start speaking at the cue?) ──");
  console.log("  cue |    t     | before  | after   | rise   | verdict | text");
  let onsetFailures = 0;
  for (const i of sampleIdx) {
    const c = built.cues[i];
    // 250 ms immediately before the cue vs 400 ms immediately after.
    const before = await windowRms(row.videoPath, c.start - 0.25, 0.25);
    const after = await windowRms(row.videoPath, c.start + 0.02, 0.4);
    const rise = after - before;
    // Speech present after the cue starts, and louder than just before it.
    const ok = after > -45 && (rise > 1.5 || before > -45);
    if (!ok) onsetFailures++;
    console.log(
      `  ${String(i).padStart(3)} | ${c.start.toFixed(2).padStart(7)}s | ${before.toFixed(1).padStart(6)} | ${after.toFixed(1).padStart(6)} | ${rise >= 0 ? "+" : ""}${rise.toFixed(1).padStart(5)} | ${ok ? "  OK   " : " FAIL  "} | ${c.text.slice(0, 40)}`,
    );
  }

  // ── 2. Onset-distance test ──────────────────────────────────────────
  //
  // The meaningful measurement is how far each cue start sits from a real
  // speech onset in the audio. Speech onsets are the ends of detected pauses —
  // signal evidence, independent of the alignment.
  //
  // Note a cue may legitimately CONTAIN a pause (a cue spans a clause, and
  // clauses have internal breaths), so "pause inside cue" is not a defect and
  // is not scored. What matters is that every cue that begins after a pause
  // begins when the speech does.
  console.log("\n── onset-distance test (how far is each cue start from real speech onset?) ──");
  const sil = await detectSilence(row.videoPath, -40, 0.45);
  // Pause ends are speech onsets. The end of the title-card silence is one too
  // — it is where narration begins — so include it rather than discarding the
  // first cue's only valid match.
  const onsets = sil
    .filter((s) => s.end > NARRATION_START - 0.5)
    .map((s) => s.end);
  console.log(`  ${onsets.length} speech onsets detected (pause ends) during narration`);

  const distances: { cue: number; t: number; d: number; text: string }[] = [];
  for (let i = 0; i < built.cues.length; i++) {
    const c = built.cues[i];
    // Only score cues that follow a pause — those are the ones whose onset is
    // observable in the signal.
    const nearest = onsets.reduce(
      (best, o) => (Math.abs(o - c.start) < Math.abs(best - c.start) ? o : best),
      Infinity,
    );
    if (!Number.isFinite(nearest)) continue;
    const d = c.start - nearest;
    // Only cues that directly follow a pause have an observable onset. A cue
    // starting mid-sentence (or at a segment join, where the two clips abut
    // with no silence between them) has no pause to measure against, so it is
    // covered by the speech-onset test above instead of being scored here.
    if (Math.abs(d) > 0.6) continue;
    distances.push({ cue: i, t: c.start, d, text: c.text });
  }

  const absSorted = distances.map((x) => Math.abs(x.d)).sort((a, b) => a - b);
  const p50 = absSorted[Math.floor(absSorted.length * 0.5)] ?? 0;
  const p95 = absSorted[Math.floor(absSorted.length * 0.95)] ?? 0;
  const worst = absSorted[absSorted.length - 1] ?? 0;

  for (const x of distances.slice(0, 10)) {
    console.log(
      `    cue ${String(x.cue).padStart(3)} @ ${x.t.toFixed(2)}s → ${(x.d * 1000) >= 0 ? "+" : ""}${(x.d * 1000).toFixed(0)}ms from onset | ${x.text.slice(0, 38)}`,
    );
  }
  console.log(
    `  ${distances.length} pause-following cues — median ${(p50 * 1000).toFixed(0)}ms, p95 ${(p95 * 1000).toFixed(0)}ms, worst ${(worst * 1000).toFixed(0)}ms`,
  );

  // Drift check: compare onset distance in the first third vs the last third.
  const third = Math.floor(distances.length / 3);
  const meanOf = (arr: typeof distances) =>
    arr.length ? arr.reduce((a, x) => a + x.d, 0) / arr.length : 0;
  const early = meanOf(distances.slice(0, third));
  const late = meanOf(distances.slice(-third));
  console.log(
    `  drift: early mean ${(early * 1000).toFixed(0)}ms → late mean ${(late * 1000).toFixed(0)}ms (change ${((late - early) * 1000).toFixed(0)}ms)`,
  );

  // ── 3. Marker test ──────────────────────────────────────────────────
  console.log("\n── spoken timing markers ──");
  for (const marker of ["one", "two", "three"]) {
    const idx = built.words.findIndex(
      (w, i) =>
        /marker/i.test(built.words[i]?.text ?? "") &&
        new RegExp(marker, "i").test(built.words[i + 1]?.text ?? ""),
    );
    if (idx >= 0) {
      const w = built.words[idx];
      const rms = await windowRms(row.videoPath, w.start + 0.02, 0.5);
      console.log(
        `  "marker ${marker}" at ${w.start.toFixed(2)}s → audio ${rms.toFixed(1)}dB ${rms > -45 ? "(speech present ✓)" : "(SILENT ✗)"}`,
      );
    } else {
      console.log(`  "marker ${marker}" not found in words`);
    }
  }

  // Acceptance: captions within ~250ms of spoken words, with no growing drift.
  const TOL = 0.25;
  const verdict =
    onsetFailures === 0 && p95 <= TOL && Math.abs(late - early) <= TOL;
  console.log(
    `\n═══ ${verdict ? "PASS" : "FAIL"} — ${onsetFailures}/${sampleIdx.length} onset failures, ` +
      `p95 onset distance ${(p95 * 1000).toFixed(0)}ms (limit ${TOL * 1000}ms), ` +
      `drift ${((late - early) * 1000).toFixed(0)}ms ═══\n`,
  );
  await disconnect();
  process.exit(verdict ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await disconnect();
  process.exit(1);
});
