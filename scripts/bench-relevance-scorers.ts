/**
 * Benchmark candidate relevance scorers against a fixed, judged corpus.
 *
 *   npx tsx scripts/bench-relevance-scorers.ts --build   # build + save the corpus (Claude)
 *   npx tsx scripts/bench-relevance-scorers.ts           # evaluate scorers (no API calls)
 *   npx tsx scripts/bench-relevance-scorers.ts --loso    # leave-one-script-out
 *
 * The corpus is built ONCE and stored, so ground truth is fixed and every
 * later comparison is deterministic and free. Rebuilding is an explicit flag,
 * because silently re-judging would let the benchmark drift under the answer.
 *
 * No ElevenLabs spend, no database writes, no rendering, no upload.
 *
 * Scorers under test:
 *   CURRENT  — scoreRelevance, the shipped taxonomy-dominated arithmetic
 *   SEMANTIC — scoreSemantic, the family/polysemy layer that already exists in
 *              pipeline-core but is wired only into screening scripts
 *
 * AI_SUBJECTS is deliberately NOT an input to the SEMANTIC scorer, so the
 * benchmark cannot be contaminated by the taxonomy it is meant to replace.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  prisma, disconnect, env, createMessage,
  buildSearchQueries, classifyConcept, scoreRelevance, AI_SUBJECTS,
  searchPexelsCandidates, deriveRequirement, scoreSemantic,
} from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const CHANNEL = "ai-doom-scroll" as const;
const CORPUS_PATH = "tests/fixtures/relevance-corpus.json";
const BUILD = process.argv.includes("--build");
const LOSO = process.argv.includes("--loso");

const SCRIPTS: { key: string; label: string; videoId: string; verdict: string }[] = [
  { key: "power",      label: "rrb0A_piLEM power/grid",  videoId: "cmsdrtafn0002mbdzwpmndnix", verdict: "UPLOADED" },
  { key: "ewaste",     label: "AMrrTvdL2tI e-waste",     videoId: "cmsexx3n80002mb1gd988zvee", verdict: "UPLOADED" },
  { key: "hbm",        label: "HBM chips",               videoId: "cms9970di0002mbti2m9avpui", verdict: "HUMAN-REJECTED" },
  { key: "ocr",        label: "OCR documents",           videoId: "cmsql4dco0002p90edn2a4skx", verdict: "REFUSED" },
  { key: "enterprise", label: "enterprise business",     videoId: "cmsqmgt4200b4ns0evkpfr1wa", verdict: "REFUSED" },
  { key: "olmoearth",  label: "OlmoEarth geospatial",    videoId: "cmsqn4iam0002ld0e3dfv7xx7", verdict: "REFUSED" },
  { key: "signlang",   label: "sign-language a11y",      videoId: "cmsqtbgzm0002li0egizu9vlc", verdict: "REFUSED" },
];

export interface CorpusRow {
  script: string;
  beatIndex: number;
  narration: string;
  visualPrompt: string;
  description: string;
  /** Ground truth: Claude, taxonomy-blind. Never edited by a scorer. */
  relevant: boolean;
}

// ── Corpus construction (Claude; run once) ────────────────────────────────

async function judge(a: Anthropic, narration: string, prompt: string, descs: string[]): Promise<boolean[]> {
  const msg = await createMessage(a, {
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system:
      "You judge whether stock footage is a good visual match for a video beat. " +
      "Answer only about whether a viewer would find the footage a sensible, " +
      "on-topic illustration of the narration and the requested shot. Ignore " +
      "production quality. Respond ONLY with a JSON array of booleans, one per " +
      "numbered item, in order.",
    messages: [{
      role: "user",
      content: `NARRATION: ${narration.slice(0, 700)}\n\nREQUESTED SHOT: ${prompt.slice(0, 400)}\n\n` +
        `FOOTAGE:\n${descs.map((d, i) => `${i}. ${d}`).join("\n")}\n\nJSON array of ${descs.length} booleans:`,
    }],
  });
  const text = (msg.content ?? [])
    .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : "")).join("");
  let raw = text.trim();
  if (raw.startsWith("```")) raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  const arr = JSON.parse(raw) as boolean[];
  return descs.map((_, i) => arr[i] === true);
}

async function beatsOf(videoId: string) {
  const v: any = await (prisma as any).video.findUnique({ where: { id: videoId } });
  const segs = (v?.scriptJson as any)?.segments ?? [];
  if (segs.length) return segs.map((s: any) => ({ narration: s.narration ?? "", visualPrompt: s.visual_prompt ?? "" }));
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT ON ("prompt") "prompt","narration" FROM scene_record WHERE "videoId"=$1`, videoId);
  return rows.map((r) => ({ narration: r.narration ?? "", visualPrompt: r.prompt ?? "" }));
}

async function build() {
  const a = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
  const key = env().PEXELS_API_KEY;
  const rows: CorpusRow[] = [];
  for (const s of SCRIPTS) {
    const beats = (await beatsOf(s.videoId)).slice(0, 4);
    for (let bi = 0; bi < beats.length; bi++) {
      const b = beats[bi];
      const seen = new Set<string>();
      const descs: string[] = [];
      for (const q of buildSearchQueries(b.visualPrompt, "", CHANNEL).slice(0, 2)) {
        let c: any[] = [];
        try { c = await searchPexelsCandidates(q, key, { perPage: 15 }); } catch { continue; }
        for (const x of c) {
          const d = (x.description ?? "").trim();
          if (d && !seen.has(d)) { seen.add(d); descs.push(d); }
        }
      }
      if (descs.length < 3) continue;
      const sample = descs.slice(0, 24);
      let truth: boolean[];
      try { truth = await judge(a, b.narration, b.visualPrompt, sample); } catch { continue; }
      sample.forEach((d, i) => rows.push({
        script: s.key, beatIndex: bi, narration: b.narration,
        visualPrompt: b.visualPrompt, description: d, relevant: truth[i] ?? false,
      }));
    }
    console.log(`built ${s.key}: ${rows.filter((r) => r.script === s.key).length} rows`);
  }
  writeFileSync(CORPUS_PATH, JSON.stringify(rows, null, 1));
  console.log(`\nwrote ${rows.length} judged rows -> ${CORPUS_PATH}`);
}

// ── Scorers ───────────────────────────────────────────────────────────────

export type Scorer = (r: CorpusRow) => boolean;

/** Shipped arithmetic: taxonomy <=0.75, semantics <=0.39, threshold 0.25. */
export const currentScorer: Scorer = (r) =>
  scoreRelevance({
    channel: CHANNEL as never, narration: r.narration,
    prompt: r.visualPrompt, description: r.description,
  }).verdict !== "REJECT";

/**
 * The family layer already in pipeline-core. DIRECT means the beat's subject
 * (and its named setting, when it has one) is actually depicted.
 */
export const semanticScorer = (acceptRelated: boolean): Scorer => (r) => {
  const req = deriveRequirement({
    beatIndex: r.beatIndex, segmentIndex: r.beatIndex,
    narration: r.narration, visualPrompt: r.visualPrompt,
  });
  const v = scoreSemantic(req, r.description).verdict;
  return acceptRelated ? v !== "IRRELEVANT" : v === "DIRECT";
};

// ── Metrics ───────────────────────────────────────────────────────────────

const NON_CONCRETE = new Set(["none", "ambiguous", "generic-abstract", "unknown"]);
const nameable = (d: string) => !NON_CONCRETE.has(classifyConcept(d, AI_SUBJECTS).concept);

export interface Metrics {
  tp: number; fp: number; tn: number; fn: number;
  recall: number; precision: number; f1: number;
  fpRate: number; fnRate: number;
  acceptRelevantNameable: number; acceptRelevantUnnameable: number; disparity: number;
  poolAccepted: number; poolTotal: number;
}

export function evaluate(rows: CorpusRow[], scorer: Scorer): Metrics {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  let rn = 0, rnA = 0, ru = 0, ruA = 0;
  for (const r of rows) {
    const acc = scorer(r);
    if (r.relevant && acc) tp++;
    else if (!r.relevant && acc) fp++;
    else if (!r.relevant && !acc) tn++;
    else fn++;
    if (r.relevant) {
      if (nameable(r.description)) { rn++; if (acc) rnA++; }
      else { ru++; if (acc) ruA++; }
    }
  }
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const aRN = rn ? rnA / rn : 0;
  const aRU = ru ? ruA / ru : 0;
  return {
    tp, fp, tn, fn, recall, precision,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    fpRate: fp + tn ? fp / (fp + tn) : 0,
    fnRate: tp + fn ? fn / (tp + fn) : 0,
    acceptRelevantNameable: aRN, acceptRelevantUnnameable: aRU,
    disparity: aRN - aRU,
    poolAccepted: tp + fp, poolTotal: rows.length,
  };
}

const p = (x: number) => `${(x * 100).toFixed(1)}%`;
const line = (name: string, m: Metrics) =>
  `  ${name.padEnd(20)} recall=${p(m.recall)} prec=${p(m.precision)} F1=${p(m.f1)} ` +
  `FP=${p(m.fpRate)} pool=${m.poolAccepted}/${m.poolTotal} ` +
  `nameable=${p(m.acceptRelevantNameable)} unnameable=${p(m.acceptRelevantUnnameable)} ` +
  `gap=${p(m.disparity)}`;

async function main() {
  if (BUILD) { await build(); await disconnect(); return; }
  if (!existsSync(CORPUS_PATH)) {
    console.error(`no corpus at ${CORPUS_PATH} — run with --build first`);
    process.exitCode = 1; return;
  }
  const rows = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as CorpusRow[];
  const scorers: [string, Scorer][] = [
    ["CURRENT", currentScorer],
    ["SEMANTIC direct", semanticScorer(false)],
    ["SEMANTIC +related", semanticScorer(true)],
  ];

  console.log(`CORPUS n=${rows.length}  relevant=${rows.filter((r) => r.relevant).length}\n`);
  console.log("── WHOLE CORPUS ──");
  for (const [n, s] of scorers) console.log(line(n, evaluate(rows, s)));

  if (LOSO) {
    console.log("\n── LEAVE-ONE-SCRIPT-OUT (evaluated on the held-out script only) ──");
    const keys = [...new Set(rows.map((r) => r.script))];
    for (const [n, s] of scorers) {
      console.log(`\n  ${n}`);
      for (const k of keys) {
        const held = rows.filter((r) => r.script === k);
        if (!held.length) continue;
        const m = evaluate(held, s);
        console.log(`    ${k.padEnd(11)} recall=${p(m.recall)} prec=${p(m.precision)} ` +
          `FP=${p(m.fpRate)} pool=${m.poolAccepted}/${m.poolTotal} gap=${p(m.disparity)}`);
      }
    }
    console.log("\n  Note: neither scorer has a tunable threshold fitted on this corpus,");
    console.log("  so per-script numbers ARE the held-out numbers — nothing was fitted.");
  }
  await disconnect();
}

const direct = process.argv[1]?.includes("bench-relevance-scorers");
if (direct) main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnect());
