/**
 * Acquisition-only semantic coverage report.
 *
 *   npx tsx scripts/semantic-coverage-report.ts <assetKey>
 *
 * Runs the real query and acquisition path against the stored script and
 * reports, per beat, whether the library actually contains footage of what
 * the sentence is about. Read-only with respect to money and YouTube: it
 * opens no budget, reserves no credits, calls no ElevenLabs, renders nothing,
 * creates no upload intent and contacts no YouTube API.
 */
import { writeFileSync } from "node:fs";
import {
  prisma, disconnect, env, pexelsOnlySource, planPreliminaryBeats,
  deriveRequirement, assessSemanticCoverage, buildBeatQueries, derivePolicy,
  composeBeat, scoreSemantic, TITLE_CARD_S, BEAT_MAX_S,
} from "@yt-pipeline/pipeline-core";
import { ASSETS } from "./qualify";
import "dotenv/config";

const MIN_FRAGMENT_S = 3;

async function main() {
  const key = process.argv[2] ?? "ai1r";
  const spec = ASSETS.find((a) => a.key === key);
  if (!spec) throw new Error(`unknown asset ${key}`);

  const topic = await prisma.topic.findFirst({ where: { url: spec.topicUrl }, include: { videos: true } });
  const row = topic?.videos[0];
  if (!row?.scriptJson) throw new Error("no stored script — refusing to generate one");
  const script = row.scriptJson as any;

  const plannedVisualDurationS = spec.targetS - TITLE_CARD_S;
  const beats = planPreliminaryBeats(script.segments, spec.channel, plannedVisualDurationS);
  const search = pexelsOnlySource(env().PEXELS_API_KEY).search;

  console.log(`\n═══ SEMANTIC COVERAGE — ${key} ═══`);
  console.log(`  beats ${beats.length} | planned ${plannedVisualDurationS}s\n`);

  const claimed = new Set<string>();
  const coverages = [];
  const perBeat: any[] = [];

  for (const beat of beats) {
    const seg = script.segments[beat.segmentIndex] ?? script.segments[script.segments.length - 1];
    const req = deriveRequirement({
      beatIndex: beat.index, segmentIndex: beat.segmentIndex,
      narration: beat.narration, visualPrompt: seg.visual_prompt,
      // The first beat of the video carries the thesis and may not be carded.
      isHighSalience: beat.index === 1,
    });
    const policy = derivePolicy(req);
    const beatQueries = buildBeatQueries(req);

    // Query provenance: every candidate remembers which query produced it,
    // that query's class, and what it was meant to satisfy.
    const cands: any[] = [];
    const seen = new Set<string>();
    for (const bq of beatQueries) {
      const results = await search(bq.query);
      results.forEach((c: any, rank: number) => {
        if (seen.has(c.assetId)) return;
        seen.add(c.assetId);
        cands.push({
          assetId: c.assetId, description: c.description ?? "",
          durationS: c.durationS ?? 0, brandRisk: false,
          query: bq.query, queryClass: bq.klass, satisfies: bq.satisfies, rank,
        });
      });
    }

    const comp = composeBeat(req, policy, beat.durationS, cands, {
      beatMaxS: BEAT_MAX_S, minFragmentS: MIN_FRAGMENT_S, claimed,
    });
    for (const f of comp.fragments) claimed.add(f.assetId);

    const direct = cands.filter((c) => scoreSemantic(req, c.description).verdict === "DIRECT");
    const cov = {
      requirement: req, plannedS: beat.durationS,
      directCandidates: comp.fragments.map((f) => ({
        assetId: f.assetId, description: f.description, usableS: f.durationS, brandRisk: f.brandRisk,
      })),
      relevantSeconds: comp.fragments.reduce((a, f) => a + f.durationS, 0),
      nonBrandRiskSeconds: comp.fragments.filter((f) => !f.brandRisk).reduce((a, f) => a + f.durationS, 0),
      rejected: cands.filter((c) => !comp.fragments.some((f) => f.assetId === c.assetId))
        .slice(0, 40)
        .map((c) => { const sc = scoreSemantic(req, c.description);
          return { assetId: c.assetId, description: c.description, verdict: sc.verdict,
                   reason: sc.reasons.join("; ") }; }),
      supported: comp.covered,
      needsCard: !comp.covered && req.cardPermitted,
      unsupported: !comp.covered && !req.cardPermitted,
    };
    coverages.push(cov as any);

    const status = cov.supported ? "SUPPORTED" : cov.unsupported ? "UNSUPPORTED" : "CARD";
    console.log(`── beat ${String(beat.index).padStart(2)} (${beat.durationS.toFixed(1)}s) ${status}  [${policy}]`);
    console.log(`   narration : ${beat.narration.slice(0, 84)}`);
    console.log(`   subject   : ${req.primarySubjects.join(", ") || "(none)"}   setting: ${req.settings.join(", ") || "(none)"}`);
    console.log(`   queries   : ${beatQueries.map((q) => q.query).slice(0, 4).join(" | ")}`);
    console.log(`   candidates: ${cands.length}  DIRECT: ${direct.length}  fragments: ${comp.fragments.length}`);
    console.log(`   shares    : subject ${(comp.subjectShare * 100).toFixed(0)}%  setting ${(comp.settingShare * 100).toFixed(0)}%${comp.jointMatchAsset ? `  joint=${comp.jointMatchAsset}` : ""}`);
    for (const f of comp.fragments.slice(0, 3)) {
      console.log(`      ✓ ${f.durationS.toFixed(1)}s ${f.carriesSubject ? "S" : "-"}${f.carriesSetting ? "P" : "-"} "${f.description.slice(0, 58)}"`);
    }
    console.log(`   verdict   : ${comp.reasons.join("; ").slice(0, 150)}`);
    console.log();

    perBeat.push({
      beat: beat.index, plannedS: +beat.durationS.toFixed(1), status,
      narration: beat.narration, visualPrompt: seg.visual_prompt,
      requiredSubjects: req.primarySubjects, requiredSettings: req.settings,
      policy, queries: beatQueries, candidateCount: cands.length,
      directCount: direct.length, fragments: comp.fragments,
      subjectShare: +comp.subjectShare.toFixed(3), settingShare: +comp.settingShare.toFixed(3),
      jointMatchAsset: comp.jointMatchAsset ?? null, compositionReasons: comp.reasons,
      relevantSeconds: +cov.relevantSeconds.toFixed(1),
      nonBrandRiskSeconds: +cov.nonBrandRiskSeconds.toFixed(1),
      accepted: cov.directCandidates.slice(0, 5),
      rejectedSample: cov.rejected.slice(0, 5),
    });
  }

  const f = assessSemanticCoverage(coverages);
  console.log("═══ SEMANTIC FEASIBILITY ═══");
  for (const c of f.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(32)} ${c.detail}`);
  console.log(`\n  supported ${f.supportedBeats}/${coverages.length} (${(f.supportedPct * 100).toFixed(1)}%)`);
  console.log(`  cards     ${f.cardBeats} (${(f.cardPct * 100).toFixed(1)}%)`);
  console.log(`  unsupported ${f.unsupportedBeats}`);
  console.log(`  semantically accepted assets ${f.acceptedAssets}, ${f.acceptedSeconds.toFixed(1)}s`);
  console.log(`\n  VERDICT: ${f.pass ? "SEMANTIC PASS" : "SEMANTIC FAIL"}`);
  if (f.failureReason) console.log(`  reason : ${f.failureReason}`);

  writeFileSync(`output/${key}-semantic-coverage.json`,
    JSON.stringify({ asset: key, scriptChars: script.segments.reduce((a: number, s: any) => a + s.narration.length, 0),
                     summary: { supportedBeats: f.supportedBeats, cardBeats: f.cardBeats,
                                unsupportedBeats: f.unsupportedBeats, supportedPct: f.supportedPct,
                                cardPct: f.cardPct, consecutiveCards: f.consecutiveCards,
                                acceptedAssets: f.acceptedAssets, acceptedSeconds: f.acceptedSeconds,
                                brandRiskDependent: f.brandRiskDependent, pass: f.pass,
                                failureReason: f.failureReason },
                     checks: f.checks, beats: perBeat }, null, 2));
  console.log(`\n  written: output/${key}-semantic-coverage.json`);
}

main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => disconnect());
