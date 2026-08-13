/**
 * Can semanticCoverage re-rank the pool the current scorer already admits?
 *
 *   npx tsx scripts/bench-reranking.ts          # whole corpus
 *   npx tsx scripts/bench-reranking.ts --loso   # leave-one-script-out
 *
 * Offline and deterministic: reads the frozen corpus, calls nothing, writes
 * nothing, spends nothing.
 *
 * Admission is held EXACTLY as it ships. The accepted pool is identical under
 * every formulation — only the order changes. That is the whole experiment:
 * `selectCandidate` is first-fit over the sorted list, so ordering decides
 * which asset actually lands on a beat, and ordering is the one thing that can
 * be changed without touching pool coverage.
 *
 * semanticCoverage has the profile of a ranker, not a filter: measured on this
 * corpus it rejects almost everything (recall 3.5%) but is right when it does
 * speak (FP 6.0%). High precision and low recall is exactly what you want from
 * a signal that reorders a list someone else built.
 */
import { readFileSync } from "node:fs";
import {
  scoreRelevance, classifyConcept, AI_SUBJECTS,
  deriveRequirement, scoreSemantic,
} from "@yt-pipeline/pipeline-core";
import type { CorpusRow } from "./bench-relevance-scorers";
import "dotenv/config";

const CHANNEL = "ai-doom-scroll" as const;
const CORPUS = "tests/fixtures/relevance-corpus.json";
const LOSO = process.argv.includes("--loso");

interface Row extends CorpusRow {
  current: number;      // shipped relevance score
  accepted: boolean;    // shipped admission — never varies
  sem: number;          // 2 DIRECT, 1 RELATED, 0 IRRELEVANT
  nameable: boolean;
}

const NON_CONCRETE = new Set(["none", "ambiguous", "generic-abstract", "unknown"]);

function prepare(rows: CorpusRow[]): Row[] {
  return rows.map((r) => {
    const sc = scoreRelevance({
      channel: CHANNEL as never, narration: r.narration,
      prompt: r.visualPrompt, description: r.description,
    });
    const req = deriveRequirement({
      beatIndex: r.beatIndex, segmentIndex: r.beatIndex,
      narration: r.narration, visualPrompt: r.visualPrompt,
    });
    const v = scoreSemantic(req, r.description).verdict;
    return {
      ...r,
      current: sc.score,
      accepted: sc.verdict !== "REJECT",
      sem: v === "DIRECT" ? 2 : v === "RELATED" ? 1 : 0,
      nameable: !NON_CONCRETE.has(classifyConcept(r.description, AI_SUBJECTS).concept),
    };
  });
}

// ── Formulations. Each returns a sort key; higher ranks earlier. ──────────

export type Ranker = { name: string; key: (r: Row, ctx: Ctx) => number };
interface Ctx { w: number }

export const RANKERS: Ranker[] = [
  { name: "SHIPPED (current only)", key: (r) => r.current },
  // A: current decides, semantic breaks ties.
  { name: "A current+tiebreak", key: (r) => r.current * 100 + r.sem },
  // B: weighted blend; current is 0..1, sem normalised to 0..1.
  { name: "B weighted", key: (r, c) => (1 - c.w) * r.current + c.w * (r.sem / 2) },
  // C: semantic leads among everything in a minimum current band.
  { name: "C semantic-first band", key: (r, c) => (r.current >= c.w ? 10 + r.sem : r.current) },
  // D: additive boost only on positive semantic evidence — never a demotion.
  { name: "D positive-only boost", key: (r, c) => r.current + (r.sem === 2 ? c.w : 0) },
  // E: reciprocal rank fusion, computed per beat in rankBeat.
  { name: "E rank fusion", key: (r) => r.current },
];

/** Order one beat's ACCEPTED assets under a formulation. */
function rankBeat(beat: Row[], ranker: Ranker, ctx: Ctx): Row[] {
  const pool = beat.filter((r) => r.accepted);
  if (ranker.name.startsWith("E")) {
    const byCur = [...pool].sort((a, b) => b.current - a.current);
    const bySem = [...pool].sort((a, b) => b.sem - a.sem || b.current - a.current);
    const rrf = new Map<Row, number>();
    const K = 10;
    byCur.forEach((r, i) => rrf.set(r, (rrf.get(r) ?? 0) + 1 / (K + i + 1)));
    bySem.forEach((r, i) => rrf.set(r, (rrf.get(r) ?? 0) + 1 / (K + i + 1)));
    return [...pool].sort((a, b) => rrf.get(b)! - rrf.get(a)!);
  }
  return [...pool].sort((a, b) => ranker.key(b, ctx) - ranker.key(a, ctx));
}

export interface RerankMetrics {
  beats: number;
  top1Relevant: number;
  top3RelevantRate: number;
  irrelevantInTop3: number;
  poolSize: number;
  unnameableInTop3: number;
  /** Mean rank improvement for relevant+unnameable assets (positive = better). */
  unnameableRankGain: number;
  nameableRankLoss: number;
}

export function measure(beats: Row[][], ranker: Ranker, ctx: Ctx): RerankMetrics {
  let n = 0, top1 = 0, t3rel = 0, t3tot = 0, t3irr = 0, pool = 0, t3un = 0;
  let unGain = 0, unN = 0, naLoss = 0, naN = 0;
  for (const beat of beats) {
    const base = rankBeat(beat, RANKERS[0], ctx);
    const ord = rankBeat(beat, ranker, ctx);
    if (!ord.length) continue;
    n++; pool += ord.length;
    if (ord[0].relevant) top1++;
    const top3 = ord.slice(0, 3);
    t3rel += top3.filter((r) => r.relevant).length;
    t3irr += top3.filter((r) => !r.relevant).length;
    t3un += top3.filter((r) => r.relevant && !r.nameable).length;
    t3tot += top3.length;
    const basePos = new Map(base.map((r, i) => [r, i]));
    const newPos = new Map(ord.map((r, i) => [r, i]));
    for (const r of ord) {
      if (!r.relevant) continue;
      const d = basePos.get(r)! - newPos.get(r)!; // positive = moved up
      if (r.nameable) { naN++; naLoss += d; } else { unN++; unGain += d; }
    }
  }
  return {
    beats: n,
    top1Relevant: n ? top1 / n : 0,
    top3RelevantRate: t3tot ? t3rel / t3tot : 0,
    irrelevantInTop3: t3tot ? t3irr / t3tot : 0,
    poolSize: pool,
    unnameableInTop3: t3tot ? t3un / t3tot : 0,
    unnameableRankGain: unN ? unGain / unN : 0,
    nameableRankLoss: naN ? naLoss / naN : 0,
  };
}

const p = (x: number) => `${(x * 100).toFixed(1)}%`;
const show = (name: string, m: RerankMetrics) =>
  `  ${name.padEnd(24)} top1=${p(m.top1Relevant)} top3rel=${p(m.top3RelevantRate)} ` +
  `irrTop3=${p(m.irrelevantInTop3)} unnamedRelTop3=${p(m.unnameableInTop3)} pool=${m.poolSize} ` +
  `unnameRank+${m.unnameableRankGain.toFixed(2)} nameRank${m.nameableRankLoss >= 0 ? "+" : ""}${m.nameableRankLoss.toFixed(2)}`;

function groupBeats(rows: Row[]): Row[][] {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.script}#${r.beatIndex}`;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return [...m.values()];
}

/** Parameter grids, searched only where a formulation has a parameter. */
const GRID: Record<string, number[]> = {
  "B weighted": [0.2, 0.3, 0.4, 0.5, 0.6],
  "C semantic-first band": [0.25, 0.3, 0.35, 0.4],
  "D positive-only boost": [0.1, 0.2, 0.3, 0.5],
};

function main() {
  const raw = JSON.parse(readFileSync(CORPUS, "utf8")) as CorpusRow[];
  const rows = prepare(raw);
  const accepted = rows.filter((r) => r.accepted);
  console.log(`CORPUS n=${rows.length} accepted=${accepted.length} relevant=${rows.filter((r) => r.relevant).length}`);
  console.log(`semantic verdicts among ACCEPTED: DIRECT=${accepted.filter((r) => r.sem === 2).length} ` +
    `RELATED=${accepted.filter((r) => r.sem === 1).length} IRRELEVANT=${accepted.filter((r) => r.sem === 0).length}\n`);

  const beats = groupBeats(rows);

  console.log("── WHOLE CORPUS (admission identical everywhere) ──");
  for (const r of RANKERS) {
    const ws = GRID[r.name] ?? [0];
    for (const w of ws) {
      const label = GRID[r.name] ? `${r.name} w=${w}` : r.name;
      console.log(show(label, measure(beats, r, { w })));
    }
  }

  if (!LOSO) return;

  console.log("\n── LEAVE-ONE-SCRIPT-OUT (parameter chosen on the OTHER scripts) ──");
  const keys = [...new Set(rows.map((r) => r.script))];
  for (const r of RANKERS) {
    console.log(`\n  ${r.name}`);
    let aggTop1 = 0, aggBeats = 0, aggT3rel = 0, aggT3tot = 0, aggPool = 0, basePool = 0, baseTop1 = 0;
    for (const k of keys) {
      const trainBeats = groupBeats(rows.filter((x) => x.script !== k));
      const heldBeats = groupBeats(rows.filter((x) => x.script === k));
      const ws = GRID[r.name] ?? [0];
      let bw = ws[0], bestT1 = -1;
      for (const w of ws) {
        const m = measure(trainBeats, r, { w });
        if (m.top1Relevant > bestT1) { bestT1 = m.top1Relevant; bw = w; }
      }
      const m = measure(heldBeats, r, { w: bw });
      const b = measure(heldBeats, RANKERS[0], { w: bw });
      aggTop1 += m.top1Relevant * m.beats; aggBeats += m.beats;
      aggT3rel += m.top3RelevantRate * 3 * m.beats; aggT3tot += 3 * m.beats;
      aggPool += m.poolSize; basePool += b.poolSize; baseTop1 += b.top1Relevant * b.beats;
      console.log(`    ${k.padEnd(11)} w=${bw} top1=${p(m.top1Relevant)} (base ${p(b.top1Relevant)}) ` +
        `top3rel=${p(m.top3RelevantRate)} (base ${p(b.top3RelevantRate)}) pool=${m.poolSize}/${b.poolSize}`);
    }
    console.log(`    POOLED     top1=${p(aggBeats ? aggTop1 / aggBeats : 0)} ` +
      `(base ${p(aggBeats ? baseTop1 / aggBeats : 0)}) ` +
      `top3rel=${p(aggT3tot ? aggT3rel / aggT3tot : 0)} pool=${aggPool}/${basePool}`);
  }
}

if (process.argv[1]?.includes("bench-reranking")) main();
