/**
 * Can a hybrid semantic classifier measure visual concentration well enough
 * for the unchanged 40% gate to behave like a human?
 *
 *   npx tsx scripts/bench-hybrid-classification.ts
 *
 * Read-only research. No ElevenLabs, no database writes, no production code.
 * Ground truth is the frozen tests/fixtures/concentration-timelines.json:
 * 239 duration-weighted fragments over 7 real timelines, human-labelled
 * taxonomy-blind.
 *
 * The taxonomy's error is ONE-DIRECTIONAL over-merging (+23.6pp, always over),
 * so the hybrids here all attack merging rather than splitting. BGE alone sat
 * at MAE 11.3pp using single-link union-find, which chains: A~B and B~C puts
 * A and C together however unlike they are. Complete-link is the obvious
 * control for that and is tested as its own arm.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { classifyConcept, AI_SUBJECTS } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const CORPUS = "tests/fixtures/concentration-timelines.json";
const VEC_CACHE = "tmp/embedding-cache.json";
const MODEL = process.env.EMB_MODEL ?? "Xenova/bge-base-en-v1.5";

interface Frag {
  script: string; source: string; outcome: string;
  beat: number; description: string; seconds: number; label: string;
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

// ── Clustering primitives (deterministic, order-independent) ─────────────

/** Single-link: transitive closure of the similarity graph. Chains. */
export function singleLink(items: string[], V: Map<string, Vec>, t: number): string[] {
  const par = items.map((_, i) => i);
  const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (cos(V.get(items[i])!, V.get(items[j])!) >= t) {
        const a = find(i), b = find(j); if (a !== b) par[Math.max(a, b)] = Math.min(a, b);
      }
  return items.map((_, i) => `c${find(i)}`);
}

/**
 * Complete-link: two clusters merge only if EVERY cross pair clears the
 * threshold, so a cluster stays internally cohesive and cannot chain.
 * Deterministic: merges the best-scoring pair, ties broken by lowest index.
 */
export function completeLink(items: string[], V: Map<string, Vec>, t: number): string[] {
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
  groups.forEach((g) => { const id = `c${Math.min(...g)}`; g.forEach((i) => (out[i] = id)); });
  return out;
}

// ── Hybrids ───────────────────────────────────────────────────────────────

export type Grouper = (items: string[], V: Map<string, Vec>, p: Params) => string[];
export interface Params { t: number; purity: number }

const tax = (d: string) => classifyConcept(d, AI_SUBJECTS).concept;

/** A: taxonomy gives a coarse bucket; BGE splits inside it. Never merges across. */
export const hybridA: Grouper = (items, V, p) => {
  const out = items.map(() => "");
  const buckets = new Map<string, number[]>();
  items.forEach((d, i) => {
    const b = tax(d);
    buckets.set(b, [...(buckets.get(b) ?? []), i]);
  });
  for (const [b, idx] of buckets) {
    const sub = completeLink(idx.map((i) => items[i]), V, p.t);
    idx.forEach((i, k) => (out[i] = `${b}/${sub[k]}`));
  }
  return out;
};

/** B: BGE groups first; taxonomy may only corroborate an existing merge. */
export const hybridB: Grouper = (items, V, p) => completeLink(items, V, p.t);

/**
 * C: keep taxonomy grouping ONLY for buckets whose purity clears a global
 * criterion measured on the TRAINING folds; BGE-cluster everything else.
 * The pure-bucket set is passed in via `pureBuckets` (fold-scoped).
 */
export function hybridC(pure: Set<string>): Grouper {
  return (items, V, p) => {
    const out = items.map(() => "");
    const rest: number[] = [];
    items.forEach((d, i) => {
      const b = tax(d);
      if (pure.has(b)) out[i] = `tax:${b}`; else rest.push(i);
    });
    const sub = completeLink(rest.map((i) => items[i]), V, p.t);
    rest.forEach((i, k) => (out[i] = `bge:${sub[k]}`));
    return out;
  };
}

/** D: BGE with cohesion — complete-link is itself the cohesion rule. */
export const hybridD: Grouper = (items, V, p) => completeLink(items, V, p.t);

/** Baselines. */
export const taxonomyOnly: Grouper = (items) => items.map((d) => tax(d));
export const bgeSingle: Grouper = (items, V, p) => singleLink(items, V, p.t);

// ── Metrics ───────────────────────────────────────────────────────────────

export function domShare(secs: number[], groups: string[]): number {
  const m = new Map<string, number>();
  groups.forEach((g, i) => m.set(g, (m.get(g) ?? 0) + secs[i]));
  const total = secs.reduce((a, b) => a + b, 0) || 1;
  return Math.max(...m.values()) / total;
}
const nGroups = (g: string[]) => new Set(g).size;

function pairRates(pred: string[], truth: string[]) {
  let fp = 0, fn = 0, tp = 0, tn = 0;
  for (let i = 0; i < pred.length; i++)
    for (let j = i + 1; j < pred.length; j++) {
      const s = pred[i] === pred[j], b = truth[i] === truth[j];
      if (s && b) tp++; else if (s && !b) fp++; else if (!s && b) fn++; else tn++;
    }
  return { falseMerge: fp + tn ? fp / (fp + tn) : 0, falseSplit: tp + fn ? fn / (tp + fn) : 0 };
}

const p = (x: number) => `${(x * 100).toFixed(1)}%`;
const pp = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pp`;

async function main() {
  const frags = JSON.parse(readFileSync(CORPUS, "utf8")) as Frag[];
  const scripts = [...new Set(frags.map((f) => f.script))];
  const V = await embed([...new Set(frags.map((f) => f.description))]);

  // ── PHASE 1: where does the inflation come from? ─────────────────────
  console.log("── PHASE 1: taxonomy bucket purity (all 239 fragments) ──");
  const byBucket = new Map<string, Frag[]>();
  for (const f of frags) byBucket.set(tax(f.description), [...(byBucket.get(tax(f.description)) ?? []), f]);
  const rows = [...byBucket.entries()].map(([b, fs]) => {
    const labels = new Map<string, number>();
    for (const f of fs) labels.set(f.label, (labels.get(f.label) ?? 0) + f.seconds);
    const total = fs.reduce((a, f) => a + f.seconds, 0);
    const top = Math.max(...labels.values());
    return {
      bucket: b, n: fs.length, humanGroups: labels.size,
      purity: top / total, secs: total,
      merged: total - top, // seconds wrongly held together
    };
  }).sort((a, b) => b.merged - a.merged);
  for (const r of rows) {
    console.log(`  ${r.bucket.padEnd(16)} n=${String(r.n).padStart(3)} humanGroups=${String(r.humanGroups).padStart(2)} ` +
      `purity=${p(r.purity)} secs=${r.secs.toFixed(0)} wronglyMerged=${r.merged.toFixed(0)}s`);
  }

  // ── PHASES 2-4: LOSO over hybrids ────────────────────────────────────
  const T_GRID = [0.50, 0.55, 0.60, 0.64, 0.68, 0.72, 0.74, 0.76, 0.80, 0.84];
  const PURITY_GRID = [0.6, 0.7, 0.8];

  interface Arm { name: string; make: (train: Frag[], p: Params) => Grouper; grid: Params[] }
  const arms: Arm[] = [
    { name: "AI_SUBJECTS (baseline)", make: () => taxonomyOnly, grid: [{ t: 0, purity: 0 }] },
    { name: "BGE single-link", make: () => bgeSingle, grid: T_GRID.map((t) => ({ t, purity: 0 })) },
    { name: "A taxonomy→BGE split", make: () => hybridA, grid: T_GRID.map((t) => ({ t, purity: 0 })) },
    { name: "B/D BGE complete-link", make: () => hybridB, grid: T_GRID.map((t) => ({ t, purity: 0 })) },
    {
      name: "C pure-tax + BGE", grid: T_GRID.flatMap((t) => PURITY_GRID.map((purity) => ({ t, purity }))),
      make: (train, prm) => {
        // Purity measured on TRAIN folds only.
        const b2 = new Map<string, Frag[]>();
        for (const f of train) b2.set(tax(f.description), [...(b2.get(tax(f.description)) ?? []), f]);
        const pure = new Set<string>();
        for (const [b, fs] of b2) {
          if (b === "none" || b === "ambiguous") continue;
          const labels = new Map<string, number>();
          for (const f of fs) labels.set(f.label, (labels.get(f.label) ?? 0) + f.seconds);
          const total = fs.reduce((a, f) => a + f.seconds, 0);
          if (total > 0 && Math.max(...labels.values()) / total >= prm.purity) pure.add(b);
        }
        return hybridC(pure);
      },
    },
  ];

  console.log("\n── PHASES 2-4: LOSO dominant-share accuracy ──");
  const perArm: Record<string, { script: string; human: number; pred: number; err: number }[]> = {};
  for (const arm of arms) {
    const results: { script: string; human: number; pred: number; err: number }[] = [];
    for (const held of scripts) {
      const train = frags.filter((f) => f.script !== held);
      const trainScripts = scripts.filter((s) => s !== held);
      // Choose params on TRAIN only, minimising mean |error|.
      let bp = arm.grid[0], bestErr = Infinity;
      for (const prm of arm.grid) {
        const g = arm.make(train, prm);
        let e = 0;
        for (const s of trainScripts) {
          const fs = frags.filter((f) => f.script === s);
          const pred = g(fs.map((f) => f.description), V, prm);
          e += Math.abs(domShare(fs.map((f) => f.seconds), pred)
            - domShare(fs.map((f) => f.seconds), fs.map((f) => f.label)));
        }
        if (e / trainScripts.length < bestErr) { bestErr = e / trainScripts.length; bp = prm; }
      }
      const g = arm.make(train, bp);
      const fs = frags.filter((f) => f.script === held);
      const pred = g(fs.map((f) => f.description), V, bp);
      const secs = fs.map((f) => f.seconds);
      const h = domShare(secs, fs.map((f) => f.label));
      const q = domShare(secs, pred);
      results.push({ script: held, human: h, pred: q, err: q - h });
      if (arm.name.startsWith("C ") || arm.name.startsWith("A ") || arm.name.startsWith("B/D")) {
        const pr = pairRates(pred, fs.map((f) => f.label));
        console.log(`   ${arm.name.slice(0, 12).padEnd(13)} ${held.padEnd(11)} t=${bp.t.toFixed(2)}` +
          `${bp.purity ? ` pur=${bp.purity}` : ""} human=${p(h)} pred=${p(q)} err=${pp(q - h)} ` +
          `groups ${new Set(fs.map((f) => f.label)).size}->${nGroups(pred)} ` +
          `fMerge=${p(pr.falseMerge)} fSplit=${p(pr.falseSplit)}`);
      }
    }
    perArm[arm.name] = results;
  }

  console.log("\n── AGGREGATE (held-out) ──");
  for (const [name, res] of Object.entries(perArm)) {
    const mae = res.reduce((a, r) => a + Math.abs(r.err), 0) / res.length;
    const rmse = Math.sqrt(res.reduce((a, r) => a + r.err * r.err, 0) / res.length);
    const bias = res.reduce((a, r) => a + r.err, 0) / res.length;
    const max = Math.max(...res.map((r) => Math.abs(r.err)));
    const worstFF = Math.max(...res.map((r) => (r.human <= 0.4 ? r.pred : 0)));
    console.log(`  ${name.padEnd(24)} MAE=${p(mae)} RMSE=${p(rmse)} bias=${pp(bias)} ` +
      `max=${p(max)} highestPredOnSub40=${p(worstFF)}`);
  }

  // ── PHASE 5: controlled monotony, built from real labelled fragments ──
  console.log("\n── PHASE 5: controlled monotony (out-of-sample behaviour) ──");
  const pool = frags.slice();
  const byLabel = new Map<string, Frag[]>();
  for (const f of pool) byLabel.set(f.label, [...(byLabel.get(f.label) ?? []), f]);
  const bigLabels = [...byLabel.entries()].filter(([, v]) => v.length >= 6).sort((a, b) => b[1].length - a[1].length);

  const best = arms.find((a) => a.name.startsWith("B/D"))!;

  for (const target of [0.25, 0.40, 0.50, 0.60, 0.75]) {
    // Build a timeline: `target` of seconds from ONE human group, rest spread
    // across as many other groups as possible. Deterministic selection.
    const [domLabel, domFrags] = bigLabels[0];
    const others = pool.filter((f) => f.label !== domLabel);
    const totalTarget = 300;
    const domSecs = totalTarget * target;
    const chosen: Frag[] = [];
    let acc = 0;
    for (const f of domFrags) { if (acc >= domSecs) break; chosen.push(f); acc += f.seconds; }
    let acc2 = 0; const seen = new Set<string>();
    for (const f of others) {
      if (acc2 >= totalTarget - acc) break;
      if (seen.has(f.label) && seen.size < 8) continue;
      seen.add(f.label); chosen.push(f); acc2 += f.seconds;
    }
    const secs = chosen.map((f) => f.seconds);
    const h = domShare(secs, chosen.map((f) => f.label));
    const line: string[] = [];
    for (const t of [0.50, 0.60, 0.68, 0.74, 0.80]) {
      const g = best.make(frags, { t, purity: 0 });
      const q = domShare(secs, g(chosen.map((f) => f.description), V, { t, purity: 0 }));
      line.push(`t${t.toFixed(2)}=${p(q)}${q > 0.4 ? "F" : "P"}`);
    }
    console.log(`  target~${p(target)} n=${chosen.length} human=${p(h)}${h > 0.4 ? "F" : "P"} | ${line.join("  ")}`);
  }

  // ── PHASE 6: gate confusion on the seven real timelines ──────────────
  console.log("\n── PHASE 6: 40% gate on real timelines ──");
  for (const [name, res] of Object.entries(perArm)) {
    let ff = 0, agree = 0;
    for (const r of res) {
      const hFail = r.human > 0.4, qFail = r.pred > 0.4;
      if (!hFail && qFail) ff++;
      if (hFail === qFail) agree++;
    }
    console.log(`  ${name.padEnd(24)} agree=${agree}/${res.length} falseFails=${ff} ` +
      `minMarginToLine=${p(Math.min(...res.map((r) => Math.abs(0.4 - r.pred))))}`);
  }
}

if (process.argv[1]?.includes("bench-hybrid-classification")) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
