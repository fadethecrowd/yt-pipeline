/**
 * Does embedding-based semantic relevance beat the shipped scorer?
 *
 *   npm install --no-save @xenova/transformers   # evaluation-only, NOT a project dep
 *   npx tsx scripts/bench-embedding-relevance.ts [--rank]
 *
 * The model runtime is deliberately NOT in package.json. Nothing in production
 * imports this file, and adding onnxruntime to the deployed image is exactly
 * the decision this benchmark exists to inform — so it stays an explicit local
 * install until that decision is made.
 *
 * Evaluated against the FIXED judged corpus in tests/fixtures/relevance-corpus.json.
 * No ElevenLabs spend, no database writes, no network beyond the model download.
 *
 * The model runs locally (transformers.js, all-MiniLM-L6-v2, quantized ~23MB),
 * so this needs no new secret, has no per-call cost, and is deterministic —
 * the same text always yields the same vector, which is what makes caching
 * trivial and a test fixture possible.
 *
 * AI_SUBJECTS is not an input anywhere in this file. The whole point is to
 * measure relevance WITHOUT the taxonomy that currently decides it.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { classifyConcept, AI_SUBJECTS, scoreRelevance } from "@yt-pipeline/pipeline-core";
import type { CorpusRow, Metrics } from "./bench-relevance-scorers";
import { evaluate, currentScorer } from "./bench-relevance-scorers";
import "dotenv/config";

const CORPUS_PATH = "tests/fixtures/relevance-corpus.json";
const VEC_CACHE = "tmp/embedding-cache.json";
const MODEL = "Xenova/all-MiniLM-L6-v2";

// ── Embedding with a deterministic on-disk cache ──────────────────────────

type Vec = number[];
const cache: Record<string, Vec> = existsSync(VEC_CACHE)
  ? JSON.parse(readFileSync(VEC_CACHE, "utf8")) : {};

/** Cache key includes the model, so a model change can never reuse old vectors. */
const keyOf = (text: string) =>
  `${MODEL}:${createHash("sha256").update(text.trim().toLowerCase()).digest("hex").slice(0, 32)}`;

let extractor: any = null;
async function embedAll(texts: string[]): Promise<Map<string, Vec>> {
  const out = new Map<string, Vec>();
  const missing: string[] = [];
  for (const t of texts) {
    const k = keyOf(t);
    if (cache[k]) out.set(t, cache[k]);
    else if (!missing.includes(t)) missing.push(t);
  }
  if (missing.length) {
    if (!extractor) {
      const { pipeline, env: xenv } = await import("@xenova/transformers");
      xenv.allowLocalModels = false;
      extractor = await pipeline("feature-extraction", MODEL, { quantized: true });
    }
    const BATCH = 32;
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      const res = await extractor(chunk, { pooling: "mean", normalize: true });
      const dim = res.dims[res.dims.length - 1];
      for (let j = 0; j < chunk.length; j++) {
        const v = Array.from(res.data.slice(j * dim, (j + 1) * dim)) as Vec;
        cache[keyOf(chunk[j])] = v;
        out.set(chunk[j], v);
      }
    }
    writeFileSync(VEC_CACHE, JSON.stringify(cache));
  }
  return out;
}

/** Vectors are L2-normalised by the pipeline, so a dot product IS cosine. */
const cos = (a: Vec, b: Vec) => a.reduce((s, x, i) => s + x * b[i], 0);

// ── Formulations under test ──────────────────────────────────────────────

type Form = (sims: { prompt: number; narration: number; both: number }) => number;
const FORMS: [string, Form][] = [
  ["desc~prompt", (s) => s.prompt],
  ["desc~narration", (s) => s.narration],
  ["desc~prompt+narr", (s) => s.both],
  ["max(prompt,narr)", (s) => Math.max(s.prompt, s.narration)],
  ["0.7p+0.3n", (s) => 0.7 * s.prompt + 0.3 * s.narration],
];

const p = (x: number) => `${(x * 100).toFixed(1)}%`;

function show(name: string, m: Metrics) {
  return `  ${name.padEnd(20)} recall=${p(m.recall)} prec=${p(m.precision)} F1=${p(m.f1)} ` +
    `FP=${p(m.fpRate)} pool=${m.poolAccepted}/${m.poolTotal} ` +
    `nameable=${p(m.acceptRelevantNameable)} unnameable=${p(m.acceptRelevantUnnameable)} gap=${p(m.disparity)}`;
}

async function main() {
  const rows = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as CorpusRow[];
  console.log(`CORPUS n=${rows.length} relevant=${rows.filter((r) => r.relevant).length}`);
  console.log(`MODEL ${MODEL} (local, quantized)\n`);

  const texts = new Set<string>();
  for (const r of rows) {
    texts.add(r.description); texts.add(r.visualPrompt);
    texts.add(r.narration.slice(0, 900));
    texts.add(`${r.visualPrompt} ${r.narration.slice(0, 900)}`);
  }
  const t0 = Date.now();
  const vecs = await embedAll([...texts]);
  console.log(`embedded ${texts.size} unique strings in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const sims = rows.map((r) => {
    const d = vecs.get(r.description)!;
    return {
      prompt: cos(d, vecs.get(r.visualPrompt)!),
      narration: cos(d, vecs.get(r.narration.slice(0, 900))!),
      both: cos(d, vecs.get(`${r.visualPrompt} ${r.narration.slice(0, 900)}`)!),
    };
  });

  const base = evaluate(rows, currentScorer);
  console.log("── BASELINE ──");
  console.log(show("CURRENT", base));

  // ── Threshold sweep per formulation ──────────────────────────────────
  console.log("\n── EMBEDDING SWEEP (whole corpus, for shape only) ──");
  const best: Record<string, { t: number; f1: number }> = {};
  for (const [fname, f] of FORMS) {
    let bt = 0, bf1 = -1;
    const lines: string[] = [];
    for (let t = 0.10; t <= 0.60; t += 0.02) {
      const m = evaluate(rows, (r) => f(sims[rows.indexOf(r)]) >= t);
      if (m.f1 > bf1) { bf1 = m.f1; bt = t; }
      if (Math.abs(t - 0.20) < 1e-9 || Math.abs(t - 0.30) < 1e-9 || Math.abs(t - 0.40) < 1e-9) {
        lines.push(`    t=${t.toFixed(2)} ${show("", m).trim()}`);
      }
    }
    best[fname] = { t: bt, f1: bf1 };
    console.log(`  ${fname}  best F1=${p(bf1)} at t=${bt.toFixed(2)}`);
    lines.forEach((l) => console.log(l));
  }

  // ── Leave-one-script-out ─────────────────────────────────────────────
  console.log("\n── LEAVE-ONE-SCRIPT-OUT (threshold chosen on the OTHER scripts) ──");
  const keys = [...new Set(rows.map((r) => r.script))];
  const idx = new Map(rows.map((r, i) => [r, i]));
  for (const [fname, f] of FORMS) {
    console.log(`\n  ${fname}`);
    let aggTP = 0, aggFP = 0, aggFN = 0, aggTN = 0, aggRN = 0, aggRNA = 0, aggRU = 0, aggRUA = 0;
    for (const k of keys) {
      const train = rows.filter((r) => r.script !== k);
      const held = rows.filter((r) => r.script === k);
      // Choose t on TRAIN only.
      //
      // NOT by F1: the corpus is 16% positive, so F1 chases precision and
      // picks a threshold that empties the pool — under that rule the held-out
      // HBM script accepted 0 of 94 assets. The operational requirement is the
      // one stated up front: cut false positives WITHOUT materially reducing
      // recall. So take the most precise threshold that still keeps train
      // recall at or above the floor. The floor is a policy input, not a
      // fitted parameter.
      const RECALL_FLOOR = 0.75;
      let bt = 0.10, bestPrec = -1;
      for (let t = 0.10; t <= 0.60; t += 0.02) {
        const m = evaluate(train, (r) => f(sims[idx.get(r)!]) >= t);
        if (m.recall >= RECALL_FLOOR && m.precision > bestPrec) { bestPrec = m.precision; bt = t; }
      }
      const m = evaluate(held, (r) => f(sims[idx.get(r)!]) >= bt);
      aggTP += m.tp; aggFP += m.fp; aggFN += m.fn; aggTN += m.tn;
      const rn = held.filter((r) => r.relevant && !["none", "ambiguous", "generic-abstract", "unknown"]
        .includes(classifyConcept(r.description, AI_SUBJECTS).concept));
      const ru = held.filter((r) => r.relevant && ["none", "ambiguous", "generic-abstract", "unknown"]
        .includes(classifyConcept(r.description, AI_SUBJECTS).concept));
      aggRN += rn.length; aggRNA += rn.filter((r) => f(sims[idx.get(r)!]) >= bt).length;
      aggRU += ru.length; aggRUA += ru.filter((r) => f(sims[idx.get(r)!]) >= bt).length;
      console.log(`    ${k.padEnd(11)} t=${bt.toFixed(2)} recall=${p(m.recall)} prec=${p(m.precision)} ` +
        `FP=${p(m.fpRate)} pool=${m.poolAccepted}/${m.poolTotal}`);
    }
    const recall = aggTP + aggFN ? aggTP / (aggTP + aggFN) : 0;
    const prec = aggTP + aggFP ? aggTP / (aggTP + aggFP) : 0;
    const fpr = aggFP + aggTN ? aggFP / (aggFP + aggTN) : 0;
    console.log(`    POOLED     recall=${p(recall)} prec=${p(prec)} FP=${p(fpr)} ` +
      `nameable=${p(aggRN ? aggRNA / aggRN : 0)} unnameable=${p(aggRU ? aggRUA / aggRU : 0)} ` +
      `gap=${p((aggRN ? aggRNA / aggRN : 0) - (aggRU ? aggRUA / aggRU : 0))}`);
  }
}

const direct = process.argv[1]?.includes("bench-embedding-relevance");
if (direct) main().catch((e) => { console.error(e); process.exitCode = 1; });

/**
 * Rank-based admission, appended as a second experiment.
 *
 * A global similarity cutoff does not transfer between topics: cosine
 * distributions shift with how concrete a script's prompts are, so the
 * threshold that suits an e-waste script empties an HBM one. Taking the top
 * fraction of candidates WITHIN each beat is scale-free and immune to that
 * shift, which is the standard retrieval answer to the same problem.
 */
export async function rankExperiment() {
  const rows = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as CorpusRow[];
  const texts = new Set<string>();
  for (const r of rows) { texts.add(r.description); texts.add(r.visualPrompt); }
  const vecs = await embedAll([...texts]);
  const sim = (r: CorpusRow) => cos(vecs.get(r.description)!, vecs.get(r.visualPrompt)!);

  const byBeat = new Map<string, CorpusRow[]>();
  for (const r of rows) {
    const k = `${r.script}#${r.beatIndex}`;
    byBeat.set(k, [...(byBeat.get(k) ?? []), r]);
  }
  console.log("\n── RANK-BASED ADMISSION (top fraction within each beat) ──");
  for (const frac of [0.3, 0.4, 0.5, 0.6]) {
    const admit = new Set<CorpusRow>();
    for (const [, group] of byBeat) {
      const sorted = [...group].sort((a, b) => sim(b) - sim(a));
      sorted.slice(0, Math.max(3, Math.ceil(group.length * frac))).forEach((r) => admit.add(r));
    }
    const m = evaluate(rows, (r) => admit.has(r));
    console.log(`  top ${(frac * 100).toFixed(0)}%  ${show("", m).trim()}`);
    // Per-script pool coverage — the number that killed the global threshold.
    const per = [...new Set(rows.map((r) => r.script))].map((k) => {
      const held = rows.filter((r) => r.script === k);
      return `${k}=${held.filter((r) => admit.has(r)).length}/${held.length}`;
    });
    console.log(`          pools: ${per.join(" ")}`);
  }
}
if (process.argv.includes("--rank")) rankExperiment().catch((e) => console.error(e));
