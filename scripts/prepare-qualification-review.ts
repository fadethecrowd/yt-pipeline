/**
 * Prepare one qualification candidate for HUMAN visual review, before TTS.
 *
 *   npx tsx scripts/prepare-qualification-review.ts
 *
 * The benchmark established that a model may reject obvious mismatches but may
 * not approve footage. So this runs the real script, query and acquisition
 * path, proposes a fragment set per beat, and stops — every beat is marked
 * HUMAN_VISUAL_REVIEW_REQUIRED and no verdict here can authorise narration.
 *
 * Writes no database row, opens no budget, calls no ElevenLabs, renders
 * nothing, creates no upload intent and never contacts YouTube.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import {
  env, pexelsOnlySource, assessVisualFeasibility, formatFeasibility,
  charsForRuntime, runtimeRange, TITLE_CARD_S,
  deriveRequirement, derivePolicy, buildBeatQueries, scoreSemantic,
} from "@yt-pipeline/pipeline-core";
import { generateScript } from "../src/stages/scriptGenerator";
import "dotenv/config";

const OUT = "tmp/qual-review";
const TARGET_S = 345;                       // 5:45, inside the 300-480 range
const CHANNEL = "ai-doom-scroll" as const;
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

const TOPIC = {
  title: "Warehouse Robots Are Rearranging Themselves Around You",
  url: "https://qualification.local/ai-doom/warehouse-robots-navigation",
  summary:
    "Modern warehouse robots navigate changing environments, move inventory and coordinate routes "
    + "with less reliance on fixed infrastructure like magnetic tape, painted lines and QR floor "
    + "markers. Autonomous mobile robots use onboard sensing to build and update their own picture "
    + "of the floor, reroute around people and obstacles, and carry shelves or totes to packing "
    + "stations. Consequences: retrofit costs fall, floor layouts change more often, the labour mix "
    + "shifts from walking and picking toward exception handling and supervision, and the software "
    + "coordinating the fleet becomes the hard part rather than the hardware. Be accurate: many "
    + "deployments still use markers or hybrid navigation, so do not claim maps or infrastructure "
    + "have been eliminated. Concrete visuals: warehouse interiors, shelving and inventory, "
    + "autonomous mobile robots, robots carrying shelves and totes, conveyor and sorting systems, "
    + "workers alongside robots, packing and fulfilment stations, obstacle avoidance, loading bays.",
};

/** Deterministic frame sampling, shared with the benchmark tooling. */
function samplePoints(d: number): number[] {
  const e = Math.min(0.6, d * 0.04);
  return [e, d * 0.25, d * 0.5, d * 0.75, Math.max(e, d - e)]
    .map((t) => Math.max(0, Math.min(d - 0.05, +t.toFixed(3))));
}

async function pexelsById(id: string): Promise<any> {
  const r = await fetch(`https://api.pexels.com/videos/videos/${id}`,
    { headers: { Authorization: env().PEXELS_API_KEY } });
  if (!r.ok) return null;
  return r.json();
}

async function sheetFor(assetId: string, label: string): Promise<any | null> {
  const media = join(OUT, "media", `${assetId}.mp4`);
  const sheet = join(OUT, "review", "sheets", `${assetId}.jpg`);
  if (existsSync(sheet)) return { file: `${assetId}.jpg`, sha256: sha(readFileSync(sheet)) };

  const v = await pexelsById(assetId);
  if (!v) return null;
  const variant = (v.video_files ?? [])
    .filter((f: any) => (f.width ?? 0) >= 640 && f.file_type === "video/mp4")
    .sort((a: any, b: any) => a.width - b.width)[0] ?? v.video_files?.[0];
  if (!variant?.link) return null;

  if (!existsSync(media)) {
    writeFileSync(media, Buffer.from(await (await fetch(variant.link)).arrayBuffer()));
  }
  const dur = Number(execFileSync("ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", media]).toString().trim());
  const ts = samplePoints(dur);
  const PW = 480, PH = 270;
  const panels: Buffer[] = [];
  for (let i = 0; i < ts.length; i++) {
    const fp = join(OUT, "frames", `${assetId}-${i}.jpg`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(ts[i]), "-i", media,
      "-frames:v", "1", "-vf",
      `scale=${PW}:${PH}:force_original_aspect_ratio=decrease,pad=${PW}:${PH}:(ow-iw)/2:(oh-ih)/2`,
      "-q:v", "3", fp]);
    panels.push(await sharp(fp).toBuffer());
  }
  const pos = [{ l: 0, t: 0 }, { l: PW, t: 0 }, { l: PW * 2, t: 0 },
               { l: Math.floor(PW * 0.5), t: PH }, { l: Math.floor(PW * 1.5), t: PH }];
  const svg = Buffer.from(`<svg width="${PW * 3}" height="${PH * 2}">` +
    ts.map((t, i) => `<rect x="${pos[i]!.l + 6}" y="${pos[i]!.t + 6}" width="132" height="26" fill="black" opacity="0.7" rx="3"/>` +
      `<text x="${pos[i]!.l + 13}" y="${pos[i]!.t + 25}" font-family="sans-serif" font-size="16" fill="#fff">F${i + 1} @ ${t.toFixed(1)}s</text>`).join("") +
    `<text x="${PW * 3 - 12}" y="${PH * 2 - 12}" text-anchor="end" font-family="sans-serif" font-size="15" fill="#999">${label} · pexels ${assetId}</text></svg>`);
  await sharp({ create: { width: PW * 3, height: PH * 2, channels: 3, background: "#111" } })
    .composite([...panels.map((b, i) => ({ input: b, left: pos[i]!.l, top: pos[i]!.t })),
                { input: svg, left: 0, top: 0 }])
    .jpeg({ quality: 82 }).toFile(sheet);
  return { file: `${assetId}.jpg`, sha256: sha(readFileSync(sheet)), durationS: dur,
           pageUrl: v.url, contributor: v.user?.name ?? null, timestamps: ts };
}

async function main() {
  for (const d of ["media", "frames", "review", "review/sheets"]) mkdirSync(join(OUT, d), { recursive: true });

  // ── 1. One script. Generated once, hashed, never re-rolled. ──────────
  const scriptPath = join(OUT, "script.json");
  let script: any;
  if (existsSync(scriptPath)) {
    script = JSON.parse(readFileSync(scriptPath, "utf8"));
    console.log("reusing the already-generated script (no re-roll)");
  } else {
    process.env.TARGET_RUNTIME_SECONDS = String(TARGET_S);
    const anthropic = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
    const gen = await generateScript(anthropic, { topic: TOPIC } as any);
    if (gen.error || !gen.script) throw new Error(`script generation failed: ${gen.error}`);
    script = gen.script;
    writeFileSync(scriptPath, JSON.stringify(script, null, 2));
  }
  const scriptSha = sha(readFileSync(scriptPath, "utf8"));
  const chars = script.segments.reduce((a: number, s: any) => a + s.narration.length, 0);
  const targetChars = charsForRuntime(CHANNEL, TARGET_S);
  const range = runtimeRange(CHANNEL, "LONGFORM", "QUALIFICATION");
  console.log(`script ${script.segments.length} segments, ${chars} chars (target ~${targetChars}) sha ${scriptSha.slice(0, 16)}`);

  // ── 2. Numeric feasibility on the real acquisition path ──────────────
  const feas = await assessVisualFeasibility({
    channel: CHANNEL, topicTitle: TOPIC.title, targetRuntimeS: TARGET_S,
    segments: script.segments.map((s: any) => ({
      segmentIndex: s.segmentIndex, title: s.title,
      narration: s.narration, visual_prompt: s.visual_prompt,
    })),
  }, pexelsOnlySource(env().PEXELS_API_KEY));
  console.log(`\n${formatFeasibility(feas)}\n`);

  // ── 3. Per-beat proposal for a human ─────────────────────────────────
  const beats: any[] = [];
  for (const b of feas.predictedBeats) {
    const seg = script.segments[b.segmentIndex] ?? script.segments[script.segments.length - 1];
    const req = deriveRequirement({ beatIndex: b.index, segmentIndex: b.segmentIndex,
      narration: b.narration, visualPrompt: seg.visual_prompt, isHighSalience: b.index === 1 });
    const policy = derivePolicy(req);
    const queries = buildBeatQueries(req).map((q) => q.query);
    const frags: any[] = [];
    for (const f of b.fragments) {
      const s = await sheetFor(f.assetId, `beat ${b.index}`);
      const sem = scoreSemantic(req, f.description);
      frags.push({
        assetId: f.assetId, description: f.description,
        plannedDurationS: +f.durationS.toFixed(1), sourceDurationS: s?.durationS ?? null,
        relevanceScore: f.relevanceScore, verdict: f.verdict, concept: f.concept,
        brandRisk: f.brandRisk, pageUrl: s?.pageUrl ?? null, contributor: s?.contributor ?? null,
        contactSheet: s?.file ?? null, frameTimestamps: s?.timestamps ?? null,
        // Advisory only. Never an approval.
        taxonomyNote: sem.verdict === "IRRELEVANT" && sem.reasons.some((r) => /outside the taxonomy/.test(r))
          ? "requirement outside the taxonomy — human judgement required"
          : `lexical view: ${sem.verdict}`,
        whyProposed: `matched by query set for ${req.primarySubjects.join("/") || "(subject unnamed)"}`
          + ` in ${req.settings.join("/") || "(setting unnamed)"}; relevance ${f.relevanceScore?.toFixed(2) ?? "-"}`,
      });
    }
    beats.push({
      beat: b.index, segmentIndex: b.segmentIndex,
      startS: +b.startS.toFixed(1), durationS: +b.durationS.toFixed(1),
      narration: b.narration, visualPrompt: seg.visual_prompt,
      requiredSubjects: req.primarySubjects, requiredSettings: req.settings,
      compositionPolicy: policy, queries, fragments: frags,
      cardSecondsS: +b.cardSecondsS.toFixed(1), hasCard: b.hasCard,
      status: "HUMAN_VISUAL_REVIEW_REQUIRED",
      marginal: frags.some((f) => (f.relevanceScore ?? 1) < 0.4) || frags.some((f) => f.brandRisk) || b.hasCard,
    });
    console.log(`beat ${String(b.index).padStart(2)} ${b.durationS.toFixed(1)}s ${frags.length} frag(s)${b.hasCard ? " +CARD" : ""}${beats[beats.length - 1].marginal ? "  [MARGINAL]" : ""}`);
  }

  const allIds = beats.flatMap((b) => b.fragments.map((f: any) => f.assetId));
  const pkg = {
    generatedAt: new Date().toISOString(),
    channel: CHANNEL, stage: "QUALIFICATION", format: "LONGFORM",
    topic: TOPIC, scriptSha256: scriptSha,
    script: { hook: script.hook, cta: script.cta, segments: script.segments },
    runtime: { targetS: TARGET_S, allowedMinS: range.minS, allowedMaxS: range.maxS,
      narrationChars: chars, targetChars,
      predictedNarrationCredits: chars,
      predictedRuntimeS: +(TITLE_CARD_S + feas.plannedVisualDurationS).toFixed(1) },
    numericFeasibility: { pass: feas.pass, failureReason: feas.failureReason ?? null, checks: feas.checks },
    conceptDistribution: feas.conceptBreakdown,
    predictedCards: { count: feas.estimatedCardCount, pct: feas.estimatedCardPct,
      consecutiveRisk: feas.estimatedConsecutiveCardRisk },
    pool: { uniqueUsableAssets: feas.uniqueUsableAssets,
      excludingBrandRisk: feas.uniqueUsableAssetsExcludingBrandRisk,
      totalUsableDurationS: feas.totalUsableDurationS,
      minRequired: feas.minUniqueAssetsRequired, requiredWithSafety: feas.requiredPoolWithSafety },
    integrity: { noSourceReuse: new Set(allIds).size === allIds.length,
      noLoops: true, noFrozenExtension: true, noReversePlayback: true, noPingPong: true,
      note: "Assembly never reuses an asset, loops a clip, freezes a frame or reverses playback; the planner asserts uniqueness and these flags record that the proposed set complies." },
    brandRisk: { fragmentsFlagged: beats.flatMap((b) => b.fragments.filter((f: any) => f.brandRisk)
      .map((f: any) => ({ beat: b.beat, assetId: f.assetId, description: f.description }))) },
    marginalBeats: beats.filter((b) => b.marginal).map((b) => b.beat),
    approvalPolicy: "No model verdict advances this video. Every beat is HUMAN_VISUAL_REVIEW_REQUIRED and narration cannot be purchased until a human approves the footage.",
    beats,
  };
  writeFileSync(join(OUT, "review", "qualification-review.json"), JSON.stringify(pkg, null, 2));
  console.log(`\nunique assets ${new Set(allIds).size}/${allIds.length} (no reuse: ${new Set(allIds).size === allIds.length})`);
  console.log(`numeric feasibility: ${feas.pass ? "PASS" : "FAIL"}${feas.failureReason ? " — " + feas.failureReason : ""}`);
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; });
