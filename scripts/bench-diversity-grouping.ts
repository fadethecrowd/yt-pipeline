/**
 * Can embeddings group footage the way a human would, for monotony detection?
 *
 *   npx tsx scripts/bench-diversity-grouping.ts --build   # freeze the labels (Claude)
 *   npx tsx scripts/bench-diversity-grouping.ts           # evaluate + LOSO
 *
 * Relevance decides whether an asset belongs. This is the OTHER half: given
 * assets that do belong, would a reviewer say two of them are "the same kind of
 * shot" — which is what the 40% dominant-concept gate is really asking.
 *
 * Ground truth is a taxonomy-blind free-text concept label per asset, one
 * Claude call per batch, rather than O(n^2) pair judgements. Two assets are
 * "same group" iff they carry the same label. That yields full pairwise truth
 * cheaply and is frozen on disk once built.
 *
 * No ElevenLabs. No database writes. No production code is touched.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  env, createMessage, classifyConcept, AI_SUBJECTS,
} from "@yt-pipeline/pipeline-core";
import type { CorpusRow } from "./bench-relevance-scorers";
import "dotenv/config";

const RELEVANCE_CORPUS = "tests/fixtures/relevance-corpus.json";
const LABELS_PATH = "tests/fixtures/grouping-labels.json";
const VEC_CACHE = "tmp/embedding-cache.json";
const MODEL = process.env.EMB_MODEL ?? "Xenova/bge-base-en-v1.5";
const BUILD = process.argv.includes("--build");

interface Labelled { script: string; description: string; label: string }

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

// ── Ground-truth labelling ────────────────────────────────────────────────

async function build() {
  const rows = JSON.parse(readFileSync(RELEVANCE_CORPUS, "utf8")) as CorpusRow[];
  // Only RELEVANT assets matter here: the gate measures the timeline, and the
  // timeline is built from footage that belongs.
  const relevant = rows.filter((r) => r.relevant);
  const a = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
  const out: Labelled[] = [];
  const byScript = new Map<string, CorpusRow[]>();
  for (const r of relevant) byScript.set(r.script, [...(byScript.get(r.script) ?? []), r]);

  for (const [script, group] of byScript) {
    const descs = [...new Set(group.map((g) => g.description))];
    for (let i = 0; i < descs.length; i += 30) {
      const chunk = descs.slice(i, i + 30);
      const msg = await createMessage(a, {
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system:
          "You label stock footage by the BROAD KIND OF IMAGERY it shows, for " +
          "detecting whether a video is visually repetitive. Two clips get the " +
          "SAME label when a viewer would think 'this looks like more of the " +
          "same kind of shot', and DIFFERENT labels when the imagery would read " +
          "as a genuine change of scene. Use short lowercase labels of one or " +
          "two words, e.g. 'office', 'factory floor', 'farmland', 'sign " +
          "language', 'hospital', 'data center', 'city street'. Reuse a label " +
          "whenever it fits. Respond ONLY with a JSON array of strings, one per " +
          "numbered item, in order.",
        messages: [{
          role: "user",
          content: `FOOTAGE:\n${chunk.map((d, j) => `${j}. ${d}`).join("\n")}\n\n` +
            `JSON array of ${chunk.length} labels:`,
        }],
      });
      const text = (msg.content ?? [])
        .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : "")).join("");
      let raw = text.trim();
      if (raw.startsWith("```")) raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      let labels: string[];
      try { labels = JSON.parse(raw) as string[]; } catch { continue; }
      chunk.forEach((d, j) => {
        if (labels[j]) out.push({ script, description: d, label: String(labels[j]).toLowerCase().trim() });
      });
    }
    console.log(`labelled ${script}: ${out.filter((o) => o.script === script).length}`);
  }
  writeFileSync(LABELS_PATH, JSON.stringify(out, null, 1));
  console.log(`\nwrote ${out.length} labelled assets -> ${LABELS_PATH}`);
}

// ── Grouping strategies ───────────────────────────────────────────────────

/** Deterministic single-link agglomeration at a global cosine threshold. */
export function clusterAt(items: string[], vecs: Map<string, Vec>, t: number): number[] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => { const a = find(i), b = find(j); if (a !== b) parent[a] = b; };
  // Order-independent: every pair is examined, and union-find is commutative.
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (cos(vecs.get(items[i])!, vecs.get(items[j])!) >= t) union(i, j);
    }
  }
  return items.map((_, i) => find(i));
}

/** Pair-level agreement between a predicted partition and the labelled one. */
export function pairMetrics(pred: number[], truth: string[]) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < pred.length; i++) {
    for (let j = i + 1; j < pred.length; j++) {
      const same = pred[i] === pred[j];
      const should = truth[i] === truth[j];
      if (same && should) tp++;
      else if (same && !should) fp++;      // false merge
      else if (!same && should) fn++;      // false split
      else tn++;
    }
  }
  return {
    tp, fp, fn, tn,
    falseMergeRate: fp + tn ? fp / (fp + tn) : 0,
    falseSplitRate: tp + fn ? fn / (tp + fn) : 0,
    pairPrecision: tp + fp ? tp / (tp + fp) : 0,
    pairRecall: tp + fn ? tp / (tp + fn) : 0,
  };
}

/** Dominant-share under a partition, weighted by asset count. */
function dominantShare(groups: (number | string)[]): number {
  const c = new Map<string, number>();
  for (const g of groups) c.set(String(g), (c.get(String(g)) ?? 0) + 1);
  return Math.max(...c.values()) / groups.length;
}

const p = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main() {
  if (BUILD) { await build(); return; }
  if (!existsSync(LABELS_PATH)) { console.error("run --build first"); process.exitCode = 1; return; }
  const labelled = JSON.parse(readFileSync(LABELS_PATH, "utf8")) as Labelled[];
  const vecs = await embed(labelled.map((l) => l.description));
  const scripts = [...new Set(labelled.map((l) => l.script))];

  console.log(`GROUPING BENCHMARK — ${labelled.length} labelled relevant assets, model ${MODEL}`);
  console.log(`distinct human labels: ${new Set(labelled.map((l) => l.label)).size}\n`);

  // ── A. Current taxonomy as the grouping mechanism ────────────────────
  console.log("── A. AI_SUBJECTS taxonomy (baseline) ──");
  let aTP = 0, aFP = 0, aFN = 0, aTN = 0;
  for (const s of scripts) {
    const g = labelled.filter((l) => l.script === s);
    const pred = g.map((l) => classifyConcept(l.description, AI_SUBJECTS).concept);
    const m = pairMetrics(pred.map((x) => [...new Set(pred)].indexOf(x)), g.map((l) => l.label));
    aTP += m.tp; aFP += m.fp; aFN += m.fn; aTN += m.tn;
  }
  console.log(`   pairPrec=${p(aTP / (aTP + aFP || 1))} pairRecall=${p(aTP / (aTP + aFN || 1))} ` +
    `falseMerge=${p(aFP / (aFP + aTN || 1))} falseSplit=${p(aFN / (aTP + aFN || 1))}`);

  // ── B. BGE agglomeration, global threshold sweep ─────────────────────
  console.log("\n── B. BGE single-link agglomeration (global threshold) ──");
  for (let t = 0.60; t <= 0.86; t += 0.02) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const s of scripts) {
      const g = labelled.filter((l) => l.script === s);
      const pred = clusterAt(g.map((l) => l.description), vecs, t);
      const m = pairMetrics(pred, g.map((l) => l.label));
      tp += m.tp; fp += m.fp; fn += m.fn; tn += m.tn;
    }
    console.log(`   t=${t.toFixed(2)} pairPrec=${p(tp / (tp + fp || 1))} ` +
      `pairRecall=${p(tp / (tp + fn || 1))} falseMerge=${p(fp / (fp + tn || 1))} ` +
      `falseSplit=${p(fn / (tp + fn || 1))}`);
  }

  // ── LOSO: threshold picked on other scripts, dominant-share error ────
  console.log("\n── LOSO (threshold on other scripts; dominant-share vs human) ──");
  let errSum = 0, n = 0;
  for (const held of scripts) {
    const train = scripts.filter((s) => s !== held);
    let bt = 0.7, bestF = -1;
    for (let t = 0.60; t <= 0.86; t += 0.02) {
      let tp = 0, fp = 0, fn = 0;
      for (const s of train) {
        const g = labelled.filter((l) => l.script === s);
        const m = pairMetrics(clusterAt(g.map((l) => l.description), vecs, t), g.map((l) => l.label));
        tp += m.tp; fp += m.fp; fn += m.fn;
      }
      const pr = tp / (tp + fp || 1), rc = tp / (tp + fn || 1);
      const f = pr + rc ? (2 * pr * rc) / (pr + rc) : 0;
      if (f > bestF) { bestF = f; bt = t; }
    }
    const g = labelled.filter((l) => l.script === held);
    const pred = clusterAt(g.map((l) => l.description), vecs, bt);
    const m = pairMetrics(pred, g.map((l) => l.label));
    const humanDom = dominantShare(g.map((l) => l.label));
    const predDom = dominantShare(pred);
    const taxDom = dominantShare(g.map((l) => classifyConcept(l.description, AI_SUBJECTS).concept));
    errSum += Math.abs(predDom - humanDom); n++;
    console.log(`   ${held.padEnd(11)} t=${bt.toFixed(2)} pairPrec=${p(m.pairPrecision)} ` +
      `pairRecall=${p(m.pairRecall)} | dominant human=${p(humanDom)} BGE=${p(predDom)} ` +
      `taxonomy=${p(taxDom)}`);
  }
  console.log(`   mean |BGE dominant - human dominant| = ${p(errSum / (n || 1))}`);
}

if (process.argv[1]?.includes("bench-diversity-grouping")) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
