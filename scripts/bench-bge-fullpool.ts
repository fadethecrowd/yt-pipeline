/**
 * Would BGE admission leave enough real footage to satisfy the feasibility margins?
 *
 *   npm install --no-save @xenova/transformers
 *   npx tsx scripts/bench-bge-fullpool.ts
 *
 * The frozen relevance corpus samples 2 queries on 4 beats per script, which is
 * a fine benchmark for a scorer and a bad one for pool size. Production runs
 * retrieve every query on every beat and see 450-650 candidates. This rebuilds
 * pools at that scale and asks the only question that can stop the whole idea:
 * does BGE admission still clear `pool >= minUniqueAssets x 1.25` and the
 * usable-duration margin?
 *
 * Read-only: Pexels search plus a local model. No ElevenLabs, no database
 * writes, no rendering, no upload.
 *
 * The baseline report comes from the REAL `assessVisualFeasibility`, so the
 * required-pool and duration numbers are the production ones rather than a
 * reimplementation. Candidate retrieval for the BGE side is reconstructed with
 * the same `buildSearchQueries`, so it is a faithful rebuild rather than a
 * byte-identical replay — stated plainly because it matters.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  prisma, disconnect, env, assessVisualFeasibility, pexelsOnlySource,
  buildSearchQueries, searchPexelsCandidates, classifyConcept, scoreRelevance,
  AI_SUBJECTS, spokenOutlineSegments, buildSpokenUnits, spokenCharacterCount,
  CHARS_PER_SECOND, TITLE_CARD_S, BEAT_MAX_S,
} from "@yt-pipeline/pipeline-core";
import type { Script } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const CHANNEL = "ai-doom-scroll" as const;
const MODEL = process.env.EMB_MODEL ?? "Xenova/bge-base-en-v1.5";
const VEC_CACHE = "tmp/embedding-cache.json";
const THRESHOLDS = [0.62, 0.64, 0.66, 0.68, 0.70];

const CASES: { key: string; label: string; videoId: string; verdict: string }[] = [
  { key: "power",      label: "rrb0A_piLEM power/grid", videoId: "cmsdrtafn0002mbdzwpmndnix", verdict: "UPLOADED" },
  { key: "ewaste",     label: "AMrrTvdL2tI e-waste",    videoId: "cmsexx3n80002mb1gd988zvee", verdict: "UPLOADED" },
  { key: "hbm",        label: "HBM chips",              videoId: "cms9970di0002mbti2m9avpui", verdict: "HUMAN-REJECTED" },
  { key: "ocr",        label: "OCR documents",          videoId: "cmsql4dco0002p90edn2a4skx", verdict: "REFUSED" },
  { key: "enterprise", label: "enterprise business",    videoId: "cmsqmgt4200b4ns0evkpfr1wa", verdict: "REFUSED" },
  { key: "olmoearth",  label: "OlmoEarth geospatial",   videoId: "cmsqn4iam0002ld0e3dfv7xx7", verdict: "REFUSED" },
  { key: "signlang",   label: "sign-language a11y",     videoId: "cmsqtbgzm0002li0egizu9vlc", verdict: "REFUSED" },
];

// ── Embeddings, cached deterministically by model + text hash ─────────────

type Vec = number[];
const cache: Record<string, Vec> = existsSync(VEC_CACHE) ? JSON.parse(readFileSync(VEC_CACHE, "utf8")) : {};
const keyOf = (t: string) =>
  `${MODEL}:${createHash("sha256").update(t.trim().toLowerCase()).digest("hex").slice(0, 32)}`;

let extractor: any = null;
async function embed(texts: string[]): Promise<Map<string, Vec>> {
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

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const key = env().PEXELS_API_KEY;
  console.log(`FULL-POOL BGE REPLAY — model ${MODEL}\n` +
    `baseline pool/margins from the real assessVisualFeasibility; ` +
    `BGE-side candidates reconstructed via buildSearchQueries\n`);

  for (const c of CASES) {
    const v: any = await (prisma as any).video.findUnique({
      where: { id: c.videoId }, include: { topic: true },
    });
    const script = v?.scriptJson as Script | undefined;
    if (!script?.segments?.length) {
      console.log(`── ${c.label}: NO DURABLE SCRIPT — cannot replay (scene records only)\n`);
      continue;
    }
    const submitChars = spokenCharacterCount(buildSpokenUnits(script));
    const videoS = submitChars / CHARS_PER_SECOND[CHANNEL] + TITLE_CARD_S;
    const segs = spokenOutlineSegments(script).map((s) => ({
      segmentIndex: s.segmentIndex, title: s.title,
      narration: s.narration, visual_prompt: s.visual_prompt,
    }));

    // Production baseline — the real gate, real numbers.
    const rep = await assessVisualFeasibility(
      { channel: CHANNEL, topicTitle: v.topic?.title ?? "", targetRuntimeS: Math.round(videoS), segments: segs },
      pexelsOnlySource(key),
    );

    // Reconstructed candidate pool for the BGE side: every query, every segment.
    const seen = new Map<string, { desc: string; dur: number; seg: number }>();
    for (const s of segs) {
      for (const q of buildSearchQueries(s.visual_prompt, s.title, CHANNEL)) {
        let cands: any[] = [];
        try { cands = await searchPexelsCandidates(q, key, { perPage: 15 }); } catch { continue; }
        for (const x of cands) {
          const d = (x.description ?? "").trim();
          if (!d || seen.has(x.assetId)) continue;
          seen.set(x.assetId, { desc: d, dur: Math.min(x.durationS || 0, BEAT_MAX_S), seg: s.segmentIndex });
        }
      }
    }
    const assets = [...seen.values()];
    const prompts = [...new Set(segs.map((s) => s.visual_prompt))];
    const vecs = await embed([...assets.map((a) => a.desc), ...prompts]);

    // An asset is admitted if it is close enough to ANY beat prompt — the
    // production pool is shared across beats, so per-beat exclusivity would be
    // the wrong test.
    const best = assets.map((a) => ({
      ...a,
      sim: Math.max(...prompts.map((pr) => cos(vecs.get(a.desc)!, vecs.get(pr)!))),
    }));

    console.log(`── ${c.label}  [${c.verdict}]`);
    console.log(`   production baseline: candidates=${rep.totalCandidates} usable=${rep.uniqueUsableAssets} ` +
      `required=${rep.requiredPoolWithSafety} (min ${rep.minUniqueAssetsRequired}) ` +
      `usableDur=${rep.totalUsableDurationS}s vs need ${Math.round(rep.plannedVisualDurationS * 1.25)}s`);
    console.log(`   reconstructed pool : ${assets.length} unique assets, ${prompts.length} prompts`);

    for (const t of THRESHOLDS) {
      const adm = best.filter((a) => a.sim >= t);
      const dur = adm.reduce((s, a) => s + a.dur, 0);
      const needDur = Math.round(rep.plannedVisualDurationS * 1.25);
      const poolOK = adm.length >= rep.requiredPoolWithSafety;
      const durOK = dur >= needDur;
      const unnamed = adm.filter((a) =>
        ["none", "ambiguous", "generic-abstract", "unknown"]
          .includes(classifyConcept(a.desc, AI_SUBJECTS).concept)).length;
      const perBeat = (adm.length / Math.max(1, rep.expectedBeatCount)).toFixed(1);
      console.log(`     t=${t.toFixed(2)} admitted=${String(adm.length).padStart(3)} ` +
        `(${((adm.length / assets.length) * 100).toFixed(0)}%) pool${poolOK ? "OK" : "FAIL"} ` +
        `dur=${dur}s ${durOK ? "OK" : "FAIL"} perBeat=${perBeat} unnamed=${unnamed} ` +
        `(${((unnamed / Math.max(1, adm.length)) * 100).toFixed(0)}%)`);
    }
    console.log();
  }
  await disconnect();
}

if (process.argv[1]?.includes("bench-bge-fullpool")) {
  main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnect());
}
