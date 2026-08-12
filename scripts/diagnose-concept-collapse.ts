/**
 * Why does one concept dominate a projected timeline?
 *
 *   npx tsx scripts/diagnose-concept-collapse.ts            # deterministic, no network
 *   npx tsx scripts/diagnose-concept-collapse.ts --retrieve # also searches Pexels (read-only)
 *
 * Read-only. It never writes a row, never buys narration, never renders and
 * never uploads. `--retrieve` performs Pexels *searches* only, which cost
 * nothing, to show what the queries actually return.
 *
 * Two AI Doom candidates failed `no-dominant-concept` at factory 50% and 52%
 * on unrelated topics, while two published videos sat at 35.7% and 39.1%. That
 * pattern is about the pipeline, not the topics, so this separates the stages
 * that could produce it:
 *
 *   A  query generation  — what did we ASK the library for?
 *   B  retrieval         — what did the library RETURN for that?
 *   C  classification    — what concept did we FILE the result under?
 *   D  selection         — which of the acceptable assets did we PICK?
 *
 * A and C are pure functions of durable data, so they replay exactly. B and D
 * depend on the live catalogue and are only shown under --retrieve.
 */
import { prisma, disconnect } from "@yt-pipeline/pipeline-core";
import {
  buildSearchQueries, classifyConcept, scoreRelevance, AI_SUBJECTS,
  searchPexelsCandidates,
} from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const RETRIEVE = process.argv.includes("--retrieve");
const CHANNEL = "ai-doom-scroll" as const;

/** The comparison set: two failures, two published successes, one rejected asset. */
export const SUBJECTS: { label: string; videoId: string; verdict: string }[] = [
  { label: "FAIL-1 OCR (factory 50%)",        videoId: "cmsql4dco0002p90edn2a4skx", verdict: "REFUSED" },
  { label: "FAIL-2 enterprise (factory 52%)", videoId: "cmsqmgt4200b4ns0evkpfr1wa", verdict: "REFUSED" },
  { label: "OK-2 AMrrTvdL2tI (39.1%)",        videoId: "cmsexx3n80002mb1gd988zvee", verdict: "PUBLISHED" },
  { label: "HBM uVQ-vcJHWNk (51.4%)",         videoId: "cms9970di0002mbti2m9avpui", verdict: "HUMAN-REJECTED" },
  { label: "OK-1 rrb0A_piLEM (35.7%)",        videoId: "cmsdrtafn0002mbdzwpmndnix", verdict: "PUBLISHED" },
];

interface Seg { segmentIndex: number; title: string; narration: string; visual_prompt: string }

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const hr = (t: string) => console.log(`\n${"═".repeat(78)}\n  ${t}\n${"═".repeat(78)}`);

/** Concept share over a map of concept → weight. */
export function shares(m: Map<string, number>): { concept: string; share: number; weight: number }[] {
  const total = [...m.values()].reduce((a, b) => a + b, 0) || 1;
  return [...m.entries()]
    .map(([concept, weight]) => ({ concept, weight, share: weight / total }))
    .sort((a, b) => b.weight - a.weight);
}

// ── A. What did the queries ask for? ──────────────────────────────────────

/**
 * Query-side concept pressure.
 *
 * Each generated query is classified with the SAME taxonomy the asset side
 * uses, so "what we asked for" and "what we filed it under" are measured on
 * one scale. If factory dominates here, the collapse happened before Pexels
 * ever saw a request.
 */
export function queryPressure(segs: Seg[]): {
  perSegment: { idx: number; prompt: string; promptConcept: string; queries: string[]; queryConcepts: string[] }[];
  pressure: Map<string, number>;
} {
  const pressure = new Map<string, number>();
  const perSegment = segs.map((s) => {
    const queries = buildSearchQueries(s.visual_prompt ?? "", s.title ?? "", CHANNEL);
    const promptConcept = classifyConcept(s.visual_prompt ?? "", AI_SUBJECTS).concept;
    const queryConcepts = queries.map((q) => classifyConcept(q, AI_SUBJECTS).concept);
    for (const c of queryConcepts) pressure.set(c, (pressure.get(c) ?? 0) + 1);
    return { idx: s.segmentIndex, prompt: s.visual_prompt ?? "", promptConcept, queries, queryConcepts };
  });
  return { perSegment, pressure };
}

// ── C. What did we file the real assets under? ────────────────────────────

/**
 * Replay classification over the assets a published video ACTUALLY used,
 * weighted by real on-screen seconds. This is ground truth for the concept
 * mix a viewer saw, and it is what the historical calibration was measured on.
 */
async function assetSideFromScenes(videoId: string) {
  const scenes: any[] = await prisma.$queryRawUnsafe(`
    SELECT "sceneNumber","narration","prompt","assetDescription","startTimeS","endTimeS","renderStatus"
      FROM scene_record WHERE "videoId"=$1 ORDER BY "sceneNumber"`, videoId);
  const m = new Map<string, number>();
  const rows: { n: number; secs: number; concept: string; raw: string; tied: string[]; desc: string }[] = [];
  for (const s of scenes) {
    if (s.renderStatus === "RENDERED_FALLBACK" || !s.assetDescription) continue;
    const secs = Math.max(0, (s.endTimeS ?? 0) - (s.startTimeS ?? 0));
    const raw = classifyConcept(s.assetDescription, AI_SUBJECTS);
    const r = scoreRelevance({
      channel: CHANNEL as never, narration: s.narration ?? "",
      prompt: s.prompt ?? "", description: s.assetDescription,
    });
    m.set(r.concept, (m.get(r.concept) ?? 0) + secs);
    rows.push({
      n: s.sceneNumber, secs, concept: r.concept, raw: raw.concept,
      tied: raw.tied ?? [], desc: String(s.assetDescription).slice(0, 62),
    });
  }
  return { rows, shares: shares(m) };
}

// ── B+D. What does the library return, and what would we pick? ────────────

async function retrievalSide(segs: Seg[]) {
  const returned = new Map<string, number>();
  const accepted = new Map<string, number>();
  const perQuery: { q: string; n: number; top: string[] }[] = [];
  for (const s of segs) {
    const queries = buildSearchQueries(s.visual_prompt ?? "", s.title ?? "", CHANNEL);
    for (const q of queries.slice(0, 3)) {
      let cands: any[] = [];
      try {
        cands = await searchPexelsCandidates(q, process.env.PEXELS_API_KEY ?? "", { perPage: 15 });
      } catch { continue; }
      const tops: string[] = [];
      for (const c of cands) {
        const desc = c.description ?? "";
        if (!desc) continue;
        const rc = classifyConcept(desc, AI_SUBJECTS).concept;
        returned.set(rc, (returned.get(rc) ?? 0) + 1);
        const r = scoreRelevance({
          channel: CHANNEL as never, narration: s.narration ?? "",
          prompt: s.visual_prompt ?? "", description: desc,
        });
        if (r.verdict !== "REJECT") {
          accepted.set(r.concept, (accepted.get(r.concept) ?? 0) + 1);
          if (tops.length < 3) tops.push(`${r.concept}:${r.score.toFixed(2)} ${desc.slice(0, 40)}`);
        }
      }
      perQuery.push({ q, n: cands.length, top: tops });
    }
  }
  return { returned: shares(returned), accepted: shares(accepted), perQuery };
}

// ── Report ────────────────────────────────────────────────────────────────

async function main() {
  console.log("CONCEPT COLLAPSE DIAGNOSTIC — read-only, no narration/render/upload");
  console.log(RETRIEVE ? "mode: deterministic + live Pexels search" : "mode: deterministic only");

  for (const subj of SUBJECTS) {
    const v: any = await (prisma as any).video.findUnique({
      where: { id: subj.videoId }, include: { topic: true },
    });
    if (!v) { console.log(`\n!! ${subj.label}: no row`); continue; }
    hr(`${subj.label}  [${subj.verdict}]  "${(v.topic?.title ?? "").slice(0, 52)}"`);

    const segs: Seg[] = ((v.scriptJson as any)?.segments ?? []) as Seg[];

    if (segs.length) {
      const { perSegment, pressure } = queryPressure(segs);
      console.log("\n  ── A. QUERY SIDE (deterministic) ──");
      for (const p of perSegment) {
        console.log(`   seg ${p.idx} promptConcept=${p.promptConcept}`);
        console.log(`     prompt: ${p.prompt.slice(0, 96)}`);
        p.queries.forEach((q, i) => console.log(`       q[${i}] "${q}" → ${p.queryConcepts[i]}`));
      }
      console.log(`   query concept pressure: ${shares(pressure)
        .map((c) => `${c.concept}=${pct(c.share)}`).join(" ")}`);
    } else {
      console.log("\n  ── A. QUERY SIDE: no durable script on this row ──");
    }

    const asset = await assetSideFromScenes(subj.videoId);
    if (asset.rows.length) {
      console.log("\n  ── C. ASSET SIDE (real rendered scenes, duration-weighted) ──");
      for (const r of asset.rows) {
        const tie = r.raw === "ambiguous" ? ` [TIE ${r.tied.join("/")}→${r.concept}]` : "";
        console.log(`   #${String(r.n).padStart(2)} ${r.secs.toFixed(1)}s ${r.concept.padEnd(16)}${tie} ${r.desc}`);
      }
      console.log(`   ASSET SHARES: ${asset.shares.map((c) => `${c.concept}=${pct(c.share)}`).join(" ")}`);
    }

    if (RETRIEVE && segs.length) {
      const r = await retrievalSide(segs);
      console.log("\n  ── B. RETURNED BY PEXELS (per candidate, unweighted) ──");
      console.log(`   ${r.returned.map((c) => `${c.concept}=${pct(c.share)}`).join(" ")}`);
      console.log("  ── D. SURVIVING RELEVANCE (acceptable pool) ──");
      console.log(`   ${r.accepted.map((c) => `${c.concept}=${pct(c.share)}`).join(" ")}`);
      for (const q of r.perQuery.slice(0, 12)) {
        console.log(`   "${q.q}" → ${q.n} candidates`);
        for (const t of q.top) console.log(`        ${t}`);
      }
    }
  }
  await disconnect();
}

const direct = process.argv[1]?.includes("diagnose-concept-collapse");
if (direct) main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnect());
