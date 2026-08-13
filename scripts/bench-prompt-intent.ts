/**
 * Should visual concentration be measured from BEAT INTENT rather than from
 * individual asset descriptions?
 *
 *   npx tsx scripts/bench-prompt-intent.ts --augment   # attach prompts (one-off)
 *   npx tsx scripts/bench-prompt-intent.ts             # analyse
 *
 * Read-only research. No ElevenLabs, no database writes, no production change.
 *
 * Asset-description clustering failed because cosine similarity between stock
 * captions is a finer thing than "the same kind of shot": no global threshold
 * both detected real monotony and left diffuse timelines alone. The human
 * labels look like they track what each BEAT was trying to show, so this tests
 * that directly — group the 5-8 visual intents, then let every fragment
 * inherit its beat's group and weight by real duration.
 *
 * The obvious failure mode is measured explicitly: if every beat becomes its
 * own group, dominant share collapses to "the biggest beat", which would pass
 * everything by construction. Phase 2 checks whether humans actually reuse a
 * group across beats before any of this is taken seriously.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  prisma, disconnect, env, assessVisualFeasibility, pexelsOnlySource,
  classifyConcept, AI_SUBJECTS, spokenOutlineSegments, buildSpokenUnits,
  spokenCharacterCount, CHARS_PER_SECOND, TITLE_CARD_S,
} from "@yt-pipeline/pipeline-core";
import type { Script } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const CHANNEL = "ai-doom-scroll" as const;
const BASE = "tests/fixtures/concentration-timelines.json";
const AUG = "tests/fixtures/concentration-timelines-intent.json";
const VEC_CACHE = "tmp/embedding-cache.json";
const MODEL = process.env.EMB_MODEL ?? "Xenova/bge-base-en-v1.5";

const VIDEO_IDS: Record<string, string> = {
  power: "cmsdrtafn0002mbdzwpmndnix", ewaste: "cmsexx3n80002mb1gd988zvee",
  hbm: "cms9970di0002mbti2m9avpui", ocr: "cmsql4dco0002p90edn2a4skx",
  enterprise: "cmsqmgt4200b4ns0evkpfr1wa", olmoearth: "cmsqn4iam0002ld0e3dfv7xx7",
  signlang: "cmsqtbgzm0002li0egizu9vlc",
};

interface Frag {
  script: string; source: string; outcome: string; beat: number;
  description: string; seconds: number; label: string;
  prompt?: string; narration?: string; segment?: number;
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

// ── Augment: attach each fragment's beat intent ───────────────────────────

async function augment() {
  const frags = JSON.parse(readFileSync(BASE, "utf8")) as Frag[];
  const key = env().PEXELS_API_KEY;
  const scripts = [...new Set(frags.map((f) => f.script))];

  for (const s of scripts) {
    const group = frags.filter((f) => f.script === s);
    if (group[0].source === "RENDERED") {
      // Exact join: scene_record carries the prompt the scene was acquired for.
      const rows: any[] = await prisma.$queryRawUnsafe(
        `SELECT "sceneNumber","prompt","narration" FROM scene_record WHERE "videoId"=$1`, VIDEO_IDS[s]);
      const m = new Map(rows.map((r) => [r.sceneNumber, r]));
      for (const f of group) {
        const r = m.get(f.beat);
        f.prompt = r?.prompt ?? ""; f.narration = r?.narration ?? "";
        f.segment = Math.floor(f.beat / 100); // sceneNumber encodes segment
      }
    } else {
      // Beat -> segment comes from the PLAN, which is derived from runtime and
      // segment weights and is independent of what retrieval returned.
      const v: any = await (prisma as any).video.findUnique({ where: { id: VIDEO_IDS[s] }, include: { topic: true } });
      const script = v.scriptJson as Script;
      const submitChars = spokenCharacterCount(buildSpokenUnits(script));
      const videoS = submitChars / CHARS_PER_SECOND[CHANNEL] + TITLE_CARD_S;
      const segs = spokenOutlineSegments(script).map((x) => ({
        segmentIndex: x.segmentIndex, title: x.title, narration: x.narration, visual_prompt: x.visual_prompt,
      }));
      const rep = await assessVisualFeasibility(
        { channel: CHANNEL, topicTitle: v.topic?.title ?? "", targetRuntimeS: Math.round(videoS), segments: segs },
        pexelsOnlySource(key),
      );
      const beatSeg = new Map(rep.predictedBeats.map((b) => [b.index, b.segmentIndex]));
      for (const f of group) {
        const si = beatSeg.get(f.beat) ?? 0;
        const sg = segs[si] ?? segs[0];
        f.prompt = sg.visual_prompt; f.narration = sg.narration; f.segment = si;
      }
    }
    console.log(`${s}: attached intent to ${group.length} fragments ` +
      `(${new Set(group.map((f) => f.prompt)).size} distinct prompts)`);
  }
  writeFileSync(AUG, JSON.stringify(frags, null, 1));
  console.log(`\nwrote ${AUG}`);
}

// ── Grouping over INTENTS ─────────────────────────────────────────────────

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 12).join(" ");

/** Complete-link over a small set of intents; deterministic. */
function completeLink(items: string[], V: Map<string, Vec>, t: number): string[] {
  let groups = items.map((_, i) => [i]);
  const sim = (a: number[], b: number[]) => {
    let m = Infinity;
    for (const x of a) for (const y of b) m = Math.min(m, cos(V.get(items[x])!, V.get(items[y])!));
    return m;
  };
  for (;;) {
    let bi = -1, bj = -1, best = t;
    for (let i = 0; i < groups.length; i++)
      for (let j = i + 1; j < groups.length; j++) {
        const s = sim(groups[i], groups[j]);
        if (s >= best + 1e-12 || (bi === -1 && s >= t)) { best = s; bi = i; bj = j; }
      }
    if (bi === -1) break;
    groups[bi] = [...groups[bi], ...groups[bj]];
    groups = groups.filter((_, k) => k !== bj);
  }
  const out = items.map(() => "");
  groups.forEach((g) => { const id = `g${Math.min(...g)}`; g.forEach((i) => (out[i] = id)); });
  return out;
}

type Method = (frs: Frag[], V: Map<string, Vec>, t: number) => string[];

/** A: lexical normalization of the prompt only. */
const methodA: Method = (frs) => frs.map((f) => norm(f.prompt ?? ""));
/** B: BGE over distinct prompts, fragments inherit their prompt's group. */
const methodB: Method = (frs, V, t) => {
  const prompts = [...new Set(frs.map((f) => f.prompt ?? ""))];
  const g = completeLink(prompts, V, t);
  const m = new Map(prompts.map((p, i) => [p, g[i]]));
  return frs.map((f) => m.get(f.prompt ?? "")!);
};
/** C: BGE over prompt+narration, to separate visually-similar but different intents. */
const methodC: Method = (frs, V, t) => {
  const keys = [...new Set(frs.map((f) => `${f.prompt} ${(f.narration ?? "").slice(0, 300)}`))];
  const g = completeLink(keys, V, t);
  const m = new Map(keys.map((k, i) => [k, g[i]]));
  return frs.map((f) => m.get(`${f.prompt} ${(f.narration ?? "").slice(0, 300)}`)!);
};
/** Control: every beat its own group — the degenerate case that must be rejected. */
const methodBeat: Method = (frs) => frs.map((f) => `b${f.segment ?? f.beat}`);

export function domShare(secs: number[], groups: string[]): number {
  const m = new Map<string, number>();
  groups.forEach((g, i) => m.set(g, (m.get(g) ?? 0) + secs[i]));
  return Math.max(...m.values()) / (secs.reduce((a, b) => a + b, 0) || 1);
}

const p = (x: number) => `${(x * 100).toFixed(1)}%`;
const pp = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pp`;

async function main() {
  if (process.argv.includes("--augment")) { await augment(); await disconnect(); return; }
  if (!existsSync(AUG)) { console.error("run --augment first"); process.exitCode = 1; return; }
  const frags = JSON.parse(readFileSync(AUG, "utf8")) as Frag[];
  const scripts = [...new Set(frags.map((f) => f.script))];
  const V = await embed([
    ...new Set(frags.map((f) => f.prompt ?? "")),
    ...new Set(frags.map((f) => `${f.prompt} ${(f.narration ?? "").slice(0, 300)}`)),
  ]);

  // ── PHASE 2: does human grouping follow the beat? ────────────────────
  console.log("── PHASE 2: human labels vs beat intent ──");
  let beatPure = 0, beatTotal = 0, crossBeat = 0, labelTotal = 0;
  for (const s of scripts) {
    const g = frags.filter((f) => f.script === s);
    const byBeat = new Map<number, Frag[]>();
    for (const f of g) byBeat.set(f.beat, [...(byBeat.get(f.beat) ?? []), f]);
    let pure = 0;
    for (const [, fs] of byBeat) { beatTotal++; if (new Set(fs.map((f) => f.label)).size === 1) { pure++; beatPure++; } }
    const byLabel = new Map<string, Set<number>>();
    for (const f of g) byLabel.set(f.label, (byLabel.get(f.label) ?? new Set()).add(f.segment ?? f.beat));
    let multi = 0;
    for (const [, segs] of byLabel) { labelTotal++; if (segs.size > 1) { multi++; crossBeat++; } }
    console.log(`  ${s.padEnd(11)} beats=${byBeat.size} single-label beats=${pure}/${byBeat.size} ` +
      `humanLabels=${byLabel.size} spanning>1 segment=${multi}`);
  }
  console.log(`  OVERALL single-label beats ${p(beatPure / beatTotal)} | ` +
    `human labels spanning >1 segment ${p(crossBeat / labelTotal)}`);

  // ── PHASES 3-4 + 8: LOSO over intent-grouping methods ────────────────
  const GRID = [0.60, 0.64, 0.68, 0.72, 0.76, 0.80, 0.84, 0.88];
  const methods: [string, Method, number[]][] = [
    ["beat-identity (control)", methodBeat, [0]],
    ["A lexical prompt", methodA, [0]],
    ["B BGE prompt", methodB, GRID],
    ["C BGE prompt+narr", methodC, GRID],
  ];

  console.log("\n── PHASES 3-4/8: LOSO dominant-share (parameters on other scripts) ──");
  const results: Record<string, { s: string; h: number; q: number }[]> = {};
  for (const [name, fn, grid] of methods) {
    const rs: { s: string; h: number; q: number }[] = [];
    for (const held of scripts) {
      const train = scripts.filter((x) => x !== held);
      let bt = grid[0], best = Infinity;
      for (const t of grid) {
        let e = 0;
        for (const s of train) {
          const g = frags.filter((f) => f.script === s);
          e += Math.abs(domShare(g.map((f) => f.seconds), fn(g, V, t))
            - domShare(g.map((f) => f.seconds), g.map((f) => f.label)));
        }
        if (e / train.length < best) { best = e / train.length; bt = t; }
      }
      const g = frags.filter((f) => f.script === held);
      const secs = g.map((f) => f.seconds);
      const h = domShare(secs, g.map((f) => f.label));
      const q = domShare(secs, fn(g, V, bt));
      rs.push({ s: held, h, q });
      if (name.startsWith("B ") || name.startsWith("C ")) {
        console.log(`   ${name.slice(0, 10).padEnd(11)} ${held.padEnd(11)} t=${bt.toFixed(2)} ` +
          `human=${p(h)} pred=${p(q)} err=${pp(q - h)} groups=${new Set(fn(g, V, bt)).size}` +
          ` (human ${new Set(g.map((f) => f.label)).size})`);
      }
    }
    results[name] = rs;
  }
  console.log("\n── AGGREGATE ──");
  for (const [name, rs] of Object.entries(results)) {
    const errs = rs.map((r) => r.q - r.h);
    const mae = errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length;
    const rmse = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);
    const bias = errs.reduce((a, e) => a + e, 0) / errs.length;
    const ff = rs.filter((r) => r.h <= 0.4 && r.q > 0.4).length;
    console.log(`  ${name.padEnd(24)} MAE=${p(mae)} RMSE=${p(rmse)} bias=${pp(bias)} ` +
      `max=${p(Math.max(...errs.map(Math.abs)))} falseFails=${ff}`);
  }

  // ── PHASE 5: controlled monotony at the INTENT level ─────────────────
  console.log("\n── PHASE 5: controlled monotony (intent-level) ──");
  const donor = frags.filter((f) => f.script === "enterprise");
  const intents = [...new Set(donor.map((f) => f.prompt ?? ""))];
  const others = frags.filter((f) => f.script !== "enterprise");
  for (const target of [0.20, 0.40, 0.50, 0.60, 0.75]) {
    const total = 300, want = total * target;
    const chosen: Frag[] = [];
    let acc = 0;
    // Repeat ONE real intent until it owns `target` of the timeline.
    const rep = donor.filter((f) => f.prompt === intents[0]);
    while (acc < want && rep.length) { const f = rep[chosen.length % rep.length]; chosen.push(f); acc += f.seconds; }
    // Fill with distinct other intents.
    const seen = new Set<string>(); let acc2 = 0;
    for (const f of others) {
      if (acc2 >= total - acc) break;
      if (seen.has(f.prompt ?? "")) continue;
      seen.add(f.prompt ?? ""); chosen.push(f); acc2 += f.seconds;
    }
    const secs = chosen.map((f) => f.seconds);
    const h = domShare(secs, chosen.map((f) => f.label));
    const line = [0.68, 0.76, 0.84].map((t) => {
      const q = domShare(secs, methodB(chosen, V, t));
      return `t${t.toFixed(2)}=${p(q)}${q > 0.4 ? "F" : "P"}`;
    });
    console.log(`  target~${p(target)} n=${chosen.length} human=${p(h)}${h > 0.4 ? "F" : "P"} | ${line.join("  ")}`);
  }

  // ── PHASE 6: real cases, all three measurements ──────────────────────
  console.log("\n── PHASE 6: real timelines ──");
  for (const s of scripts) {
    const g = frags.filter((f) => f.script === s);
    const secs = g.map((f) => f.seconds);
    const h = domShare(secs, g.map((f) => f.label));
    const bi = results["B BGE prompt"].find((r) => r.s === s)!.q;
    const tx = domShare(secs, g.map((f) => classifyConcept(f.description, AI_SUBJECTS).concept));
    console.log(`  ${s.padEnd(11)} ${g[0].source.padEnd(9)} ${g[0].outcome.padEnd(15)} ` +
      `human=${p(h)}${h > 0.4 ? "F" : "P"} intent=${p(bi)}${bi > 0.4 ? "F" : "P"} ` +
      `taxonomy=${p(tx)}${tx > 0.4 ? "F" : "P"}`);
  }
  await disconnect();
}

if (process.argv[1]?.includes("bench-prompt-intent")) {
  main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnect());
}
