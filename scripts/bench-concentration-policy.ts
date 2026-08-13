/**
 * What visual-concentration policy should AI Doom actually have?
 *
 *   npx tsx scripts/bench-concentration-policy.ts --build   # freeze labels (Claude)
 *   npx tsx scripts/bench-concentration-policy.ts           # calibrate + policy analysis
 *
 * Read-only. No ElevenLabs, no database writes, no production code touched.
 *
 * The earlier grouping set labelled assets drawn from a RELEVANCE pool, which
 * answers "are these two clips alike" but not "how concentrated was the video".
 * The gate measures a TIMELINE, so this labels timelines:
 *
 *   RENDERED  — scene_record rows for videos that actually exist, weighted by
 *               real on-screen seconds. This is ground truth, not a proxy.
 *   PROJECTED — the predicted fragments assessVisualFeasibility itself builds,
 *               weighted by predicted seconds, for candidates that never
 *               rendered. Clearly separated everywhere from RENDERED.
 *
 * Labels are taxonomy-blind free text: "would a viewer call these the same kind
 * of shot, for spotting repetitive footage". Two fragments share a group iff
 * they share a label.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  prisma, disconnect, env, createMessage, assessVisualFeasibility, pexelsOnlySource,
  classifyConcept, AI_SUBJECTS, spokenOutlineSegments, buildSpokenUnits,
  spokenCharacterCount, CHARS_PER_SECOND, TITLE_CARD_S,
} from "@yt-pipeline/pipeline-core";
import type { Script } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const CHANNEL = "ai-doom-scroll" as const;
const OUT = "tests/fixtures/concentration-timelines.json";
const VEC_CACHE = "tmp/embedding-cache.json";
const MODEL = process.env.EMB_MODEL ?? "Xenova/bge-base-en-v1.5";
const BUILD = process.argv.includes("--build");

/** `outcome` is the HUMAN verdict, never the automated gate's. */
const CASES = [
  { key: "power",      videoId: "cmsdrtafn0002mbdzwpmndnix", outcome: "PUBLISHED",     note: "rrb0A_piLEM" },
  { key: "ewaste",     videoId: "cmsexx3n80002mb1gd988zvee", outcome: "PUBLISHED",     note: "AMrrTvdL2tI" },
  { key: "hbm",        videoId: "cms9970di0002mbti2m9avpui", outcome: "HUMAN-REJECTED", note: "unillustratable" },
  { key: "ocr",        videoId: "cmsql4dco0002p90edn2a4skx", outcome: "PRE-SPEND-FAIL", note: "" },
  { key: "enterprise", videoId: "cmsqmgt4200b4ns0evkpfr1wa", outcome: "PRE-SPEND-FAIL", note: "" },
  { key: "olmoearth",  videoId: "cmsqn4iam0002ld0e3dfv7xx7", outcome: "PRE-SPEND-FAIL", note: "" },
  { key: "signlang",   videoId: "cmsqtbgzm0002li0egizu9vlc", outcome: "PRE-SPEND-FAIL", note: "" },
];

interface Frag {
  script: string; source: "RENDERED" | "PROJECTED"; outcome: string;
  beat: number; description: string; seconds: number; label?: string;
}

// ── Embeddings ────────────────────────────────────────────────────────────
type Vec = number[];
const cache: Record<string, Vec> = existsSync(VEC_CACHE) ? JSON.parse(readFileSync(VEC_CACHE, "utf8")) : {};
const keyOf = (t: string) =>
  `${MODEL}:${createHash("sha256").update(t.trim().toLowerCase()).digest("hex").slice(0, 32)}`;
let extractor: any = null;
async function embed(texts: string[]): Promise<Map<string, Vec>> {
  const out = new Map<string, Vec>(); const missing: string[] = [];
  for (const t of texts) {
    const k = keyOf(t);
    if (cache[k]) out.set(t, cache[k]); else if (!missing.includes(t)) missing.push(t);
  }
  if (missing.length) {
    if (!extractor) {
      const { pipeline, env: xenv } = await import("@xenova/transformers");
      (xenv as any).allowLocalModels = false;
      extractor = await pipeline("feature-extraction", MODEL, { quantized: true });
    }
    for (let i = 0; i < missing.length; i += 32) {
      const chunk = missing.slice(i, i + 32);
      const res = await extractor(chunk, { pooling: "mean", normalize: true });
      const dim = res.dims[res.dims.length - 1];
      chunk.forEach((t, j) => {
        const v = Array.from(res.data.slice(j * dim, (j + 1) * dim)) as Vec;
        cache[keyOf(t)] = v; out.set(t, v);
      });
    }
    writeFileSync(VEC_CACHE, JSON.stringify(cache));
  }
  return out;
}
const cos = (a: Vec, b: Vec) => a.reduce((s, x, i) => s + x * b[i], 0);

// ── Build ─────────────────────────────────────────────────────────────────

async function labelBatch(a: Anthropic, descs: string[]): Promise<string[]> {
  const msg = await createMessage(a, {
    model: "claude-sonnet-4-6", max_tokens: 1600,
    system:
      "You label stock footage by the BROAD KIND OF IMAGERY it shows, for judging " +
      "whether a video is visually repetitive. Two clips get the SAME label when a " +
      "viewer would think 'more of the same kind of shot'; DIFFERENT labels when the " +
      "imagery reads as a genuine change of scene. Short lowercase labels, one or two " +
      "words, reused whenever they fit. Respond ONLY with a JSON array of strings, one " +
      "per numbered item, in order.",
    messages: [{ role: "user", content: `FOOTAGE:\n${descs.map((d, i) => `${i}. ${d}`).join("\n")}\n\nJSON array of ${descs.length} labels:` }],
  });
  const text = (msg.content ?? [])
    .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : "")).join("");
  let raw = text.trim();
  if (raw.startsWith("```")) raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(raw) as string[];
}

async function build() {
  const a = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
  const key = env().PEXELS_API_KEY;
  const frags: Frag[] = [];
  let calls = 0;

  for (const c of CASES) {
    // RENDERED first — real seconds beat any projection.
    const scenes: any[] = await prisma.$queryRawUnsafe(`
      SELECT "sceneNumber","assetDescription","startTimeS","endTimeS","renderStatus"
        FROM scene_record WHERE "videoId"=$1 ORDER BY "sceneNumber"`, c.videoId);
    const rendered = scenes.filter((s) => s.assetDescription && s.renderStatus !== "RENDERED_FALLBACK");
    if (rendered.length >= 10) {
      for (const s of rendered) {
        frags.push({
          script: c.key, source: "RENDERED", outcome: c.outcome, beat: s.sceneNumber,
          description: String(s.assetDescription),
          seconds: Math.max(0, (s.endTimeS ?? 0) - (s.startTimeS ?? 0)),
        });
      }
      console.log(`${c.key}: ${rendered.length} RENDERED scenes`);
      continue;
    }

    // PROJECTED — the gate's own predicted timeline.
    const v: any = await (prisma as any).video.findUnique({ where: { id: c.videoId }, include: { topic: true } });
    const script = v?.scriptJson as Script | undefined;
    if (!script?.segments?.length) { console.log(`${c.key}: SKIP (no rendered scenes, no script)`); continue; }
    const submitChars = spokenCharacterCount(buildSpokenUnits(script));
    const videoS = submitChars / CHARS_PER_SECOND[CHANNEL] + TITLE_CARD_S;
    const rep = await assessVisualFeasibility(
      {
        channel: CHANNEL, topicTitle: v.topic?.title ?? "", targetRuntimeS: Math.round(videoS),
        segments: spokenOutlineSegments(script).map((s) => ({
          segmentIndex: s.segmentIndex, title: s.title, narration: s.narration, visual_prompt: s.visual_prompt,
        })),
      },
      pexelsOnlySource(key),
    );
    for (const b of rep.predictedBeats) {
      for (const f of b.fragments) {
        frags.push({
          script: c.key, source: "PROJECTED", outcome: c.outcome, beat: b.index,
          description: f.description, seconds: f.durationS,
        });
      }
    }
    console.log(`${c.key}: ${rep.predictedBeats.reduce((n, b) => n + b.fragments.length, 0)} PROJECTED fragments`);
  }

  // Label every unique description once.
  const uniq = [...new Set(frags.map((f) => f.description))];
  const labels = new Map<string, string>();
  for (let i = 0; i < uniq.length; i += 30) {
    const chunk = uniq.slice(i, i + 30);
    try {
      const got = await labelBatch(a, chunk); calls++;
      chunk.forEach((d, j) => { if (got[j]) labels.set(d, String(got[j]).toLowerCase().trim()); });
    } catch { /* skip batch */ }
  }
  for (const f of frags) f.label = labels.get(f.description);
  const kept = frags.filter((f) => f.label);
  writeFileSync(OUT, JSON.stringify(kept, null, 1));
  console.log(`\nwrote ${kept.length} labelled fragments (${uniq.length} unique descriptions, ${calls} Claude calls) -> ${OUT}`);
}

// ── Analysis ──────────────────────────────────────────────────────────────

/** Duration-weighted share of the largest group. */
function domShare(items: { seconds: number; g: string }[]): { share: number; group: string; second: number; groups: number } {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.g, (m.get(i.g) ?? 0) + i.seconds);
  const total = [...m.values()].reduce((a, b) => a + b, 0) || 1;
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    share: sorted[0] ? sorted[0][1] / total : 0,
    group: sorted[0]?.[0] ?? "—",
    second: sorted[1] ? sorted[1][1] / total : 0,
    groups: m.size,
  };
}

/** Deterministic single-link agglomeration at a global cosine threshold. */
function clusterAt(items: string[], vecs: Map<string, Vec>, t: number): string[] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => { const a = find(i), b = find(j); if (a !== b) parent[a] = b; };
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (cos(vecs.get(items[i])!, vecs.get(items[j])!) >= t) union(i, j);
  return items.map((_, i) => `c${find(i)}`);
}

const p = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main() {
  if (BUILD) { await build(); await disconnect(); return; }
  if (!existsSync(OUT)) { console.error("run --build first"); process.exitCode = 1; return; }
  const frags = JSON.parse(readFileSync(OUT, "utf8")) as Required<Frag>[];
  const scripts = [...new Set(frags.map((f) => f.script))];
  const vecs = await embed([...new Set(frags.map((f) => f.description))]);

  // ── Phase 2: human ground truth ───────────────────────────────────────
  console.log("── HUMAN DOMINANT SHARE (duration-weighted) ──");
  const human = new Map<string, ReturnType<typeof domShare>>();
  for (const s of scripts) {
    const g = frags.filter((f) => f.script === s);
    const d = domShare(g.map((f) => ({ seconds: f.seconds, g: f.label })));
    human.set(s, d);
    const conf = g.length >= 25 ? "HIGH" : g.length >= 12 ? "MODERATE" : "TOO SPARSE";
    console.log(`  ${s.padEnd(11)} ${g[0].source.padEnd(9)} ${g[0].outcome.padEnd(15)} n=${String(g.length).padStart(3)} ` +
      `dom=${p(d.share)} "${d.group}" 2nd=${p(d.second)} groups=${d.groups} [${conf}]`);
  }

  // ── Phase 3: BGE grouping, LOSO ───────────────────────────────────────
  console.log("\n── BGE GROUPING vs HUMAN (threshold chosen on other scripts) ──");
  let se = 0, ae = 0, bias = 0, n = 0;
  const bge = new Map<string, number>();
  for (const held of scripts) {
    const train = scripts.filter((x) => x !== held);
    let bt = 0.76, best = Infinity;
    for (let t = 0.68; t <= 0.86; t += 0.02) {
      let err = 0;
      for (const s of train) {
        const g = frags.filter((f) => f.script === s);
        const cl = clusterAt(g.map((f) => f.description), vecs, t);
        err += Math.abs(domShare(g.map((f, i) => ({ seconds: f.seconds, g: cl[i] }))).share
          - domShare(g.map((f) => ({ seconds: f.seconds, g: f.label }))).share);
      }
      if (err / train.length < best) { best = err / train.length; bt = t; }
    }
    const g = frags.filter((f) => f.script === held);
    const cl = clusterAt(g.map((f) => f.description), vecs, bt);
    const est = domShare(g.map((f, i) => ({ seconds: f.seconds, g: cl[i] }))).share;
    const tru = human.get(held)!.share;
    const tax = domShare(g.map((f) => ({ seconds: f.seconds, g: classifyConcept(f.description, AI_SUBJECTS).concept }))).share;
    bge.set(held, est);
    const e = est - tru; ae += Math.abs(e); se += e * e; bias += e; n++;
    console.log(`  ${held.padEnd(11)} t=${bt.toFixed(2)} human=${p(tru)} BGE=${p(est)} err=${e >= 0 ? "+" : ""}${p(e)} taxonomy=${p(tax)}`);
  }
  console.log(`  MAE=${p(ae / n)} RMSE=${p(Math.sqrt(se / n))} bias=${bias / n >= 0 ? "+" : ""}${p(bias / n)}`);

  // ── Phase 4/5: does any threshold separate human outcomes? ────────────
  console.log("\n── POLICY: human dominant share vs HUMAN outcome ──");
  const good = scripts.filter((s) => frags.find((f) => f.script === s)!.outcome === "PUBLISHED");
  const bad = scripts.filter((s) => frags.find((f) => f.script === s)!.outcome === "HUMAN-REJECTED");
  const unk = scripts.filter((s) => frags.find((f) => f.script === s)!.outcome === "PRE-SPEND-FAIL");
  const fmt = (list: string[]) => list.map((s) => `${s}=${p(human.get(s)!.share)}`).join(" ");
  console.log(`  PUBLISHED (human-accepted): ${fmt(good)}`);
  console.log(`  HUMAN-REJECTED            : ${fmt(bad)}`);
  console.log(`  pre-spend failures (unjudged): ${fmt(unk)}`);

  console.log("\n── THRESHOLD SWEEP (on HUMAN shares; ensemble context in report) ──");
  for (const t of [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70]) {
    const goodPass = good.filter((s) => human.get(s)!.share <= t).length;
    const badPass = bad.filter((s) => human.get(s)!.share <= t).length;
    const unkPass = unk.filter((s) => human.get(s)!.share <= t).length;
    console.log(`  cap=${p(t)} published pass ${goodPass}/${good.length} | ` +
      `human-rejected pass ${badPass}/${bad.length} | recent-failures pass ${unkPass}/${unk.length}`);
  }
  await disconnect();
}

if (process.argv[1]?.includes("bench-concentration-policy")) {
  main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnect());
}
