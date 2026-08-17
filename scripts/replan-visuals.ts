/**
 * Re-run ONLY visual planning for an existing run, and render a contact sheet.
 *
 *   npx tsx scripts/replan-visuals.ts --run <runId>
 *   npx tsx scripts/replan-visuals.ts --video <videoId> --legacy
 *
 * Iterating on visual quality used to cost a production run: narration, render,
 * upload and a tranche attempt, for a defect visible in the first thirty
 * seconds of the plan. This does prompt generation, retrieval, scoring and
 * selection — and stops there.
 *
 * NOT DONE HERE, by construction: no narration (no ElevenLabs call, no spend),
 * no download, no ffmpeg, no render, no upload, no tranche claim, and NO WRITES
 * TO ANY TABLE. The plan is written to a JSON file and read back by
 * scripts/contact-sheet.ts. The only network call is a Pexels search, which is
 * free, read-only, and the thing being diagnosed.
 *
 * `--legacy` reproduces the pre-fix behaviour — prompt-only pooling, prompt-only
 * scoring, no outro treatment — so the known-bad baseline can be reproduced and
 * compared against on the same script.
 *
 * THREE DEPENDENCIES HAD TO BE DECOUPLED (see the report):
 *   1. beat boundaries came from ElevenLabs word alignments; `planPreliminaryBeats`
 *      derives them from the script text instead, which is what the pre-TTS
 *      feasibility gate already does
 *   2. beat DURATIONS came from decoded segment audio; the runtime is taken from
 *      the recorded scene timeline, or `--runtime`
 *   3. clip length came from probing the downloaded file; provider metadata is
 *      used instead, so a source that lies about its duration is not caught here
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  prisma, disconnect, env, AssetLedger, VisualPlan, scoreRelevance,
  searchPexelsCandidates, buildSearchQueries, planPreliminaryBeats,
  comparisonVehicles, borrowedFromVehicle, subjectTerms, isOutroBeat,
  deVehicle, withheldDomains, classifyConcept, AI_SUBJECTS, MARINE_SUBJECTS,
} from "@yt-pipeline/pipeline-core";
import { fitFragment, MIN_FRAGMENT_S, outroCardPlan } from "@yt-pipeline/pipeline-core/dist/lib/visualBeats";
import type { Candidate } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
};
const has = (f: string) => process.argv.includes(f);

const TITLE_CARD_DURATION = 4;

interface PlannedScene {
  sceneNumber: number; narration: string; startTimeS: number; endTimeS: number;
  prompt: string; subjectPrompt: string | null; retrievalQuery: string;
  assetSource: string; assetId: string | null; assetUrl: string | null;
  assetDescription: string | null; durationS: number;
  relevanceScore: number | null; relevanceVerdict: string | null;
  relevanceReasons: string[]; renderStatus: string;
  runnerUps: { assetId: string; description: string; score: number; verdict: string; concept: string }[];
}

async function main(): Promise<void> {
  const runId = arg("--run");
  const videoArg = arg("--video");
  const legacy = has("--legacy");
  if (!runId && !videoArg) {
    console.error("✗ --run <runId> or --video <videoId> is required");
    process.exitCode = 2; return;
  }

  let videoId = videoArg;
  if (runId) {
    const run = await prisma.pipelineRun.findUnique({ where: { id: runId } });
    if (!run?.videoId) { console.error(`✗ no pipeline_run ${runId} with a candidate`); process.exitCode = 1; return; }
    videoId = run.videoId;
  }

  const video = await prisma.video.findUnique({
    where: { id: videoId! }, include: { topic: { select: { title: true } } },
  });
  if (!video) { console.error(`✗ no candidate ${videoId}`); process.exitCode = 1; return; }
  const raw = (video as unknown as { scriptJson: unknown }).scriptJson;
  const script = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!script?.segments?.length) {
    console.error(`✗ candidate ${videoId} has no script to replan`);
    process.exitCode = 1; return;
  }
  const channel = (video as unknown as { channel?: string }).channel === "wet-circuit"
    ? "wet-circuit" : "ai-doom-scroll";

  // Runtime: the timeline this run actually produced, so the replan is
  // comparable to the sheet it is being checked against.
  const existing = await (prisma as never as {
    sceneRecord: { findMany(a: unknown): Promise<{ endTimeS: number }[]> };
  }).sceneRecord.findMany({ where: { videoId }, orderBy: { endTimeS: "desc" }, take: 1 });
  const runtimeS = Number(arg("--runtime") ?? 0)
    || (existing[0] ? existing[0].endTimeS - TITLE_CARD_DURATION : 360);

  const segments = script.segments;
  const scriptText = [script.hook, ...segments.map((s: { narration: string }) => s.narration), script.cta]
    .filter(Boolean).join("\n");
  const vehicles = comparisonVehicles(scriptText);
  console.log(`\n[replan] ${legacy ? "LEGACY (pre-fix)" : "CURRENT"} — ${segments.length} segments, ${runtimeS.toFixed(0)}s`);
  console.log(`[replan] comparison vehicles: ${vehicles.length ? vehicles.map((v) => `"${v.slice(0, 50)}"`).join(", ") : "none"}`);

  // ── Per-segment subject resolution and pooling ───────────────────────
  const key = env().PEXELS_API_KEY;
  const subjects = new Map<number, {
    prompt: string; subject: string; queries: string[]; borrowed: string[]; unjustified: string | null; withheld: Set<string>; vehicles: string[];
  }>();
  const pool: Candidate[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    const borrowed = legacy ? [] : borrowedFromVehicle(seg.visual_prompt, vehicles);
    const subject = legacy ? "" : subjectTerms({ narration: seg.narration, scriptText }).join(" ");
    const taxonomy = channel === "wet-circuit" ? MARINE_SUBJECTS : AI_SUBJECTS;
    const subjectText = deVehicle(seg.narration, vehicles);
    const withheld = legacy ? new Set<string>() : withheldDomains(subjectText, taxonomy);
    const asked = classifyConcept(seg.visual_prompt, taxonomy).concept;
    const unjustified = !legacy && withheld.has(asked) ? asked : null;
    const prompt = (borrowed.length > 0 || unjustified !== null) && subject.length > 0
      ? subject : seg.visual_prompt;
    const queries = [
      ...buildSearchQueries(prompt, seg.title, channel),
      ...(!legacy && subject.length > 0 ? buildSearchQueries(subject, seg.title, channel) : []),
    ];
    const uniq = [...new Set(queries)];
    subjects.set(seg.segmentIndex, { prompt, subject, queries: uniq, borrowed, unjustified, withheld, vehicles });
    for (const q of uniq) {
      for (const c of await searchPexelsCandidates(q, key, { perPage: 40 })) {
        if (!seen.has(c.assetId)) { seen.add(c.assetId); pool.push(c); }
      }
    }
    console.log(
      `[replan] seg ${seg.segmentIndex}: ${uniq.length} queries`
      + (borrowed.length || unjustified
        ? ` — ${borrowed.length ? `borrowed "${borrowed.join(", ")}"` : `unjustified "${unjustified}"`}`
          + `, retrieving for "${subject}"`
        : ""),
    );
  }
  console.log(`[replan] pool: ${pool.length} unique assets`);

  // ── Beat planning, decoupled from narration audio ────────────────────
  const beats = planPreliminaryBeats(
    segments.map((s: { segmentIndex: number; narration: string }) => ({
      segmentIndex: s.segmentIndex, narration: s.narration,
    })),
    channel,
    runtimeS,
  );

  // `planPreliminaryBeats` gives each beat ONE representative sentence and, when
  // a segment has more sentences than beats, drops the rest — including the
  // segment's trailing CTA, so no outro beat was ever detected here. Assembly
  // does not have this problem: its beats come from the words actually spoken.
  // Sentences are therefore re-spread contiguously so every one lands in a beat.
  const bySegment = new Map<number, typeof beats>();
  for (const b of beats) {
    if (!bySegment.has(b.segmentIndex)) bySegment.set(b.segmentIndex, []);
    bySegment.get(b.segmentIndex)!.push(b);
  }
  for (const [segIndex, segBeats] of bySegment) {
    const seg = segments[segIndex];
    if (!seg) continue;
    const sentences = seg.narration.split(/(?<=[.!?])\s+/).map((x: string) => x.trim()).filter(Boolean);
    if (sentences.length === 0) continue;
    segBeats.forEach((b, i) => {
      const from = Math.floor((i * sentences.length) / segBeats.length);
      const to = Math.max(from + 1, Math.floor(((i + 1) * sentences.length) / segBeats.length));
      b.narration = sentences.slice(from, to).join(" ");
    });
  }

  const ledger = new AssetLedger(1);
  const plan = new VisualPlan();
  const scenes: PlannedScene[] = [];

  for (const beat of beats) {
    const seg = segments[beat.segmentIndex] ?? segments[segments.length - 1];
    const sub = subjects.get(seg.segmentIndex)!;
    let cursor = beat.startS;
    let remaining = beat.durationS;
    let fragment = 0;

    if (!legacy && isOutroBeat(beat.narration)) {
      // Mirrors renderOutroBeat: several cards, not one held frame.
      const lines = channel === "wet-circuit"
        ? ["Thanks for watching", "Subscribe for more", "See you next time"]
        : ["Like & Subscribe", "Drop a comment", "New videos weekly"];
      const slices = outroCardPlan(remaining, lines.length);
      for (let i = 0; i < slices.length; i++) {
        const dur = slices[i]!;
        scenes.push({
          sceneNumber: beat.index * 100 + i + 1, narration: beat.narration,
          startTimeS: TITLE_CARD_DURATION + cursor, endTimeS: TITLE_CARD_DURATION + cursor + dur,
          prompt: `[outro] ${lines[i]}`, subjectPrompt: "[outro] fixed branded treatment",
          retrievalQuery: "(bypassed)", assetSource: "outro-card", assetId: null, assetUrl: null,
          assetDescription: `outro card: ${lines[i]}`, durationS: dur,
          relevanceScore: null, relevanceVerdict: null, relevanceReasons: [],
          renderStatus: "RENDERED_OUTRO", runnerUps: [],
        });
        cursor += dur;
      }
      continue;
    }

    const scored = pool
      .map((c) => ({
        c,
        r: scoreRelevance({
          channel, narration: legacy ? beat.narration : deVehicle(beat.narration, sub.vehicles),
          prompt: legacy ? seg.visual_prompt : sub.prompt,
          description: c.description ?? "",
        }),
      }))
      .filter((x) => !sub.withheld.has(x.r.concept))
      .sort((a, b) => b.r.score - a.r.score);

    const tried = new Set<string>();
    while (remaining >= MIN_FRAGMENT_S) {
      const ranked = scored
        .filter((x) => !tried.has(x.c.assetId) && ledger.isAvailable(x.c.assetId))
        .map((x) => ({ candidate: x.c, relevance: x.r }));
      const pick = plan.selectCandidate(ranked, (c) => ledger.isAvailable(c.assetId));
      if (!pick) break;
      const c = pick.candidate;
      tried.add(c.assetId);
      // No download here, so provider metadata is the only duration available.
      const fit = fitFragment(remaining, c.durationS || 0);
      if (!fit) continue;
      ledger.claim(c.assetId);
      plan.claim(pick.relevance);
      fragment += 1;
      scenes.push({
        sceneNumber: beat.index * 100 + fragment, narration: beat.narration,
        startTimeS: TITLE_CARD_DURATION + cursor, endTimeS: TITLE_CARD_DURATION + cursor + fit.useS,
        prompt: seg.visual_prompt,
        subjectPrompt: sub.prompt === seg.visual_prompt ? null : sub.prompt,
        retrievalQuery: sub.queries.join(" | "),
        assetSource: c.provider, assetId: c.assetId, assetUrl: c.pageUrl ?? c.url,
        assetDescription: c.description ?? null, durationS: fit.useS,
        relevanceScore: pick.relevance.score, relevanceVerdict: pick.relevance.verdict,
        relevanceReasons: pick.relevance.reasons, renderStatus: "PLANNED",
        runnerUps: scored.filter((x) => x.c.assetId !== c.assetId).slice(0, 3).map((x) => ({
          assetId: x.c.assetId, description: x.c.description ?? "",
          score: +x.r.score.toFixed(3), verdict: x.r.verdict, concept: x.r.concept,
        })),
      });
      cursor += fit.useS;
      remaining -= fit.useS;
    }

    if (remaining > 0.5) {
      scenes.push({
        sceneNumber: beat.index * 100 + fragment + 1, narration: beat.narration,
        startTimeS: TITLE_CARD_DURATION + cursor, endTimeS: TITLE_CARD_DURATION + cursor + remaining,
        prompt: seg.visual_prompt, subjectPrompt: null,
        retrievalQuery: sub.queries.join(" | "), assetSource: "branded-card",
        assetId: null, assetUrl: null, assetDescription: "branded card", durationS: remaining,
        relevanceScore: null, relevanceVerdict: null,
        relevanceReasons: ["no unused relevant clip available for this fragment"],
        renderStatus: "RENDERED_FALLBACK", runnerUps: [],
      });
    }
  }

  const cards = scenes.filter((s) => s.assetSource === "branded-card").length;
  const outros = scenes.filter((s) => s.assetSource === "outro-card").length;
  console.log(
    `[replan] ${beats.length} beats -> ${scenes.length} scenes, `
    + `${cards} fallback card(s) (${((cards / scenes.length) * 100).toFixed(1)}%), ${outros} outro(s)`,
  );

  const outDir = arg("--out") ?? "tmp/replans";
  const tag = legacy ? "legacy" : "current";
  const outPath = resolve(`${outDir}/${videoId}.${tag}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    videoId, runId, mode: tag, title: video.topic?.title ?? null,
    runtimeS, vehicles, generatedAt: new Date().toISOString(), scenes,
  }, null, 2));
  console.log(`[replan] plan -> ${outPath}`);
  console.log(`[replan] sheet: npx tsx scripts/contact-sheet.ts --plan ${outPath}\n`);
  await disconnect();
}

main().catch(async (e) => { console.error(e); await disconnect(); process.exitCode = 1; });
