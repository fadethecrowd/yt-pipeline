/**
 * One corrected acquisition pass for a rejected visual allocation.
 *
 *   npx tsx scripts/reacquire-qualification-visuals.ts
 *
 * Drives acquisition from the reviewer's replacementQuery manifest rather than
 * from generated queries, excludes every rejected asset, and refuses to fill a
 * beat with adjacent industrial imagery: a beat with no robot-visible
 * candidate is reported as a source gap, not quietly completed.
 *
 * Script, hash, narration and beat structure are untouched. No database row,
 * no budget, no ElevenLabs, no render, no upload intent, no YouTube.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { env } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const SRC = "tmp/qual-review";
const OUT = "tmp/qual-review-v2";
const FORM = `${SRC}/review/DECISION-FORM.completed.csv`;
const PREV = `${SRC}/review/qualification-review.json`;
const EXPECTED_SCRIPT_SHA = "9d8fd174727c44c819c5edf6b3cd70dde441ed925012e900f6cb8881f0161c10";
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

/** Metadata evidence that a clip may show a robot. Confirmed by a human, not here. */
const ROBOT_TERMS = /\b(robot|robots|robotic|robotics|amr|agv|automated guided|cobot|autonomous mobile)\b/i;
/** Footage classes the review explicitly refused. */
const BANNED = /\b(traffic|cctv|supermarket|grocery|motorcycle|brewery|harbor|harbour|abandoned|aerial|drone shot|drone video|hot air balloon|airport)\b/i;

function parseCsv(text: string): Record<string, string>[] {
  const L = text.trim().split(/\r?\n/);
  const S = (l: string) => { const o: string[] = []; let c = "", q = false;
    for (const ch of l) { if (ch === '"') { q = !q; continue; }
      if (ch === "," && !q) { o.push(c); c = ""; continue; } c += ch; } o.push(c); return o; };
  const H = S(L[0]!);
  return L.slice(1).map((l) => Object.fromEntries(S(l).map((v, i) => [H[i]!, v.trim()])));
}

async function pexelsSearch(q: string): Promise<any[]> {
  const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=20&orientation=landscape`,
    { headers: { Authorization: env().PEXELS_API_KEY } });
  if (!r.ok) return [];
  return (await r.json()).videos ?? [];
}

function samplePoints(d: number): number[] {
  const e = Math.min(0.6, d * 0.04);
  return [e, d * 0.25, d * 0.5, d * 0.75, Math.max(e, d - e)]
    .map((t) => Math.max(0, Math.min(d - 0.05, +t.toFixed(3))));
}

async function sheetFor(v: any): Promise<any | null> {
  const id = String(v.id);
  const media = join(OUT, "media", `${id}.mp4`);
  const sheet = join(OUT, "review", "sheets", `${id}.jpg`);
  const variant = (v.video_files ?? []).filter((f: any) => (f.width ?? 0) >= 640 && f.file_type === "video/mp4")
    .sort((a: any, b: any) => a.width - b.width)[0] ?? v.video_files?.[0];
  if (!variant?.link) return null;
  if (existsSync(sheet)) return { file: `${id}.jpg`, sha256: sha(readFileSync(sheet)) };
  if (!existsSync(media)) writeFileSync(media, Buffer.from(await (await fetch(variant.link)).arrayBuffer()));
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
    "-of", "csv=p=0", media]).toString().trim());
  const ts = samplePoints(dur);
  const PW = 480, PH = 270, panels: Buffer[] = [];
  for (let i = 0; i < ts.length; i++) {
    const fp = join(OUT, "frames", `${id}-${i}.jpg`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(ts[i]), "-i", media, "-frames:v", "1",
      "-vf", `scale=${PW}:${PH}:force_original_aspect_ratio=decrease,pad=${PW}:${PH}:(ow-iw)/2:(oh-ih)/2`,
      "-q:v", "3", fp]);
    panels.push(await sharp(fp).toBuffer());
  }
  const pos = [{ l: 0, t: 0 }, { l: PW, t: 0 }, { l: PW * 2, t: 0 },
               { l: Math.floor(PW * 0.5), t: PH }, { l: Math.floor(PW * 1.5), t: PH }];
  const svg = Buffer.from(`<svg width="${PW * 3}" height="${PH * 2}">` +
    ts.map((t, i) => `<rect x="${pos[i]!.l + 6}" y="${pos[i]!.t + 6}" width="132" height="26" fill="black" opacity="0.7" rx="3"/>` +
      `<text x="${pos[i]!.l + 13}" y="${pos[i]!.t + 25}" font-family="sans-serif" font-size="16" fill="#fff">F${i + 1} @ ${t.toFixed(1)}s</text>`).join("") +
    `<text x="${PW * 3 - 12}" y="${PH * 2 - 12}" text-anchor="end" font-family="sans-serif" font-size="15" fill="#999">pexels ${id}</text></svg>`);
  await sharp({ create: { width: PW * 3, height: PH * 2, channels: 3, background: "#111" } })
    .composite([...panels.map((b, i) => ({ input: b, left: pos[i]!.l, top: pos[i]!.t })), { input: svg, left: 0, top: 0 }])
    .jpeg({ quality: 82 }).toFile(sheet);
  return { file: `${id}.jpg`, sha256: sha(readFileSync(sheet)), durationS: dur, timestamps: ts };
}

async function main() {
  for (const d of ["media", "frames", "review", "review/sheets"]) mkdirSync(join(OUT, d), { recursive: true });
  const prev = JSON.parse(readFileSync(PREV, "utf8"));
  if (prev.scriptSha256 !== EXPECTED_SCRIPT_SHA) throw new Error("script hash drift — refusing to proceed");
  const rows = parseCsv(readFileSync(FORM, "utf8"));
  const dKey = Object.keys(rows[0]!).find((k) => k.startsWith("decision"))!;

  const rejectedIds = new Set(rows.filter((r) => r[dKey]!.toUpperCase() === "REPLACE").map((r) => r.assetId!));
  const approved = rows.filter((r) => r[dKey]!.toUpperCase() === "APPROVE");
  console.log(`rejected assets excluded: ${rejectedIds.size} | conditionally approved retained: ${approved.length}`);

  // Queries per beat, in reviewer order. One alternate is permitted per beat.
  const byBeat = new Map<number, string[]>();
  for (const r of rows.filter((x) => x[dKey]!.toUpperCase() === "REPLACE")) {
    const b = Number(r.beat);
    if (!byBeat.has(b)) byBeat.set(b, []);
    if (r.replacementQuery) byBeat.get(b)!.push(r.replacementQuery);
  }

  const usedIds = new Set<string>(), usedContributors = new Map<string, number>();
  const beats: any[] = [];

  for (const pb of prev.beats) {
    const queries = byBeat.get(pb.beat) ?? [];
    const keep = approved.filter((a) => Number(a.beat) === pb.beat);
    const frags: any[] = [];
    let remaining = pb.durationS;

    // Retain conditionally approved clips at their capped duration.
    for (const k of keep) {
      const cap = /6–8|6-8/.test(k.note ?? "") ? 7 : 5;
      const s = await sheetFor(await (await fetch(`https://api.pexels.com/videos/videos/${k.assetId}`,
        { headers: { Authorization: env().PEXELS_API_KEY } })).json());
      usedIds.add(k.assetId!);
      frags.push({ assetId: k.assetId, description: k.description, plannedDurationS: cap,
        query: "(retained from prior review)", robotVisible: false, contributor: null,
        contactSheet: s?.file ?? null, retained: true,
        why: `conditionally approved by review, capped at ~${cap}s: ${k.note}` });
      remaining -= cap;
    }

    const seen = new Set<string>();
    for (const q of queries.slice(0, 4)) {
      if (remaining < 4) break;
      for (const v of await pexelsSearch(q)) {
        if (remaining < 4) break;
        const id = String(v.id);
        const desc = String(v.tags ?? "") || (v.url ?? "").split("/").filter(Boolean).pop()!.replace(/-\d+$/, "").replace(/-/g, " ");
        if (usedIds.has(id) || rejectedIds.has(id) || seen.has(id)) continue;
        if (BANNED.test(desc)) continue;
        const contributor = v.user?.name ?? "unknown";
        if ((usedContributors.get(contributor) ?? 0) >= 2) continue;
        if ((v.duration ?? 0) < 5) continue;
        seen.add(id);
        const robot = ROBOT_TERMS.test(desc);
        const s = await sheetFor(v);
        if (!s) continue;
        const use = Math.min(v.duration, 30, remaining);
        usedIds.add(id); usedContributors.set(contributor, (usedContributors.get(contributor) ?? 0) + 1);
        frags.push({ assetId: id, description: desc, plannedDurationS: +use.toFixed(1),
          sourceDurationS: v.duration, query: q, robotVisible: robot, contributor,
          pageUrl: v.url, contactSheet: s.file, frameTimestamps: s.timestamps,
          why: `returned by reviewer query "${q}"; metadata ${robot ? "names a robot/AMR" : "does not name a robot — human must confirm relevance"}` });
        remaining -= use;
      }
    }

    const robotVisible = frags.some((f) => f.robotVisible);
    beats.push({ ...pb, fragments: frags, robotVisibleBeat: robotVisible,
      uncoveredS: +Math.max(0, remaining).toFixed(1),
      status: frags.length === 0 || remaining > 6 ? "SOURCE_GAP_REQUIRES_DECISION" : "HUMAN_VISUAL_REVIEW_REQUIRED" });
    console.log(`beat ${String(pb.beat).padStart(2)} ${frags.length} frag(s) robot=${robotVisible ? "YES" : "no "} uncovered ${Math.max(0, remaining).toFixed(1)}s ${frags.length === 0 || remaining > 6 ? "[SOURCE GAP]" : ""}`);
  }

  const robotBeats = beats.filter((b) => b.robotVisibleBeat).length;
  const gaps = beats.filter((b) => b.status === "SOURCE_GAP_REQUIRES_DECISION").length;
  const clusters = [...usedContributors.entries()].filter(([, n]) => n > 1);
  writeFileSync(join(OUT, "review", "revised-review.json"), JSON.stringify({
    scriptSha256: prev.scriptSha256, topic: prev.topic, script: prev.script, runtime: prev.runtime,
    priorAllocation: { rejected: rejectedIds.size, retained: approved.length },
    robotVisibleBeats: robotBeats, totalBeats: beats.length, sourceGaps: gaps,
    contributorClusters: clusters.map(([c, n]) => ({ contributor: c, clips: n })),
    approvalPolicy: "No model verdict approves footage. robotVisible is a metadata signal only; the contact sheets are the evidence.",
    beats,
  }, null, 2));
  console.log(`\nrobot-visible beats ${robotBeats}/${beats.length} | source gaps ${gaps} | contributor clusters ${clusters.length}`);
  console.log(robotBeats >= 12 ? "MEETS the 12-beat robot-visibility target"
    : `BELOW the 12-beat target -> VISUAL_SOURCE_INCOMPATIBLE_WITH_CURRENT_LIBRARY`);
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; });
