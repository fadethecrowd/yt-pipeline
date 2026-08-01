/**
 * Pre-TTS topic screening through the complete repaired gate.
 *
 *   npx tsx scripts/screen-topics-semantic.ts
 *
 * The earlier screening measured aggregate pool size, duration, categories and
 * concept share. ai1r passed all of that and still could not be made, because
 * nothing checked whether any individual beat had footage of what its sentence
 * was about. This screens with the real pre-TTS system: repaired concept
 * classification, structured query construction, per-beat semantic scoring,
 * composition policy, compositional allocation and joint-match requirements.
 *
 * Screening only. Creates no Video row, opens no budget, reserves no credits,
 * calls no ElevenLabs, renders nothing, creates no upload intent and never
 * contacts YouTube. Uses short representative outlines rather than production
 * narration — enough to measure the library, not enough to be a script.
 */
import { writeFileSync } from "node:fs";
import {
  disconnect, env, pexelsOnlySource, deriveRequirement, derivePolicy,
  buildBeatQueries, composeBeat, scoreSemantic, assessSemanticCoverage, BEAT_MAX_S,
} from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const MIN_FRAGMENT_S = 3;
const BEAT_S = 18;

interface Outline { key: string; title: string; beats: { narration: string; visual: string }[] }

/** Five candidates: the two previously rejected, plus three physical-footage topics. */
const TOPICS: Outline[] = [
  { key: "warehouse-robots", title: "Warehouse Robots Stopped Needing a Map", beats: [
    { narration: "The robot moving across this warehouse floor has no map of the building.",
      visual: "Autonomous mobile robot driving across a warehouse floor between racking" },
    { narration: "For years, warehouse automation meant magnetic tape stuck to the concrete.",
      visual: "Warehouse floor with guided vehicle following a marked line past pallets" },
    { narration: "Workers now share the aisles with machines that reroute around them.",
      visual: "Warehouse worker walking past a mobile robot in a packing aisle" },
    { narration: "Conveyors and pick stations are being torn out and replaced.",
      visual: "Conveyor system and pick station inside a distribution centre" },
    { narration: "The fleet reorganises itself as orders change through the day.",
      visual: "Multiple robots and forklifts operating in a large warehouse interior" },
  ]},
  { key: "humanoid-manufacturing", title: "Humanoid Robots Are Walking Into Factories", beats: [
    { narration: "This machine has legs because the factory was built for people.",
      visual: "Humanoid robot standing on a factory production line" },
    { narration: "Assembly lines are shaped around human reach and human height.",
      visual: "Factory production line with workers assembling components" },
    { narration: "Robot arms already dominate the parts of the line that never move.",
      visual: "Industrial robot arm welding on an assembly line" },
    { narration: "Engineers test the machines against real production tasks.",
      visual: "Engineer in a laboratory testing a robotic arm on a workbench" },
    { narration: "The economics only work if the machine outlasts the shift it replaces.",
      visual: "Factory floor machinery and workers in safety helmets" },
  ]},
  { key: "delivery-robots", title: "Delivery Robots Took Over the Sidewalk", beats: [
    { narration: "A cooler on six wheels is now competing for your pavement.",
      visual: "Small delivery robot driving along a city street pavement" },
    { narration: "Pedestrians step around them without thinking about it.",
      visual: "City street pedestrians walking past on a busy sidewalk" },
    { narration: "Each one is loaded at a depot before it ever reaches a customer.",
      visual: "Worker loading parcels into a delivery vehicle at a depot" },
    { narration: "Cameras and sensors read the kerb, the crossing and the traffic.",
      visual: "Urban street traffic with vehicles at a city intersection" },
    { narration: "Cities are writing rules for machines that were never in the plan.",
      visual: "Pedestrian crossing with people and traffic in a city centre" },
  ]},
  { key: "datacenter-buildout", title: "The Data Centres Eating the Grid", beats: [
    { narration: "This building draws more power than the town beside it.",
      visual: "Modern data centre exterior in an industrial area" },
    { narration: "Inside, the racks run hot enough to need their own weather.",
      visual: "Data centre server room with racks and cooling" },
    { narration: "Technicians move between aisles that never get quiet.",
      visual: "Technician working on servers in a server room" },
    { narration: "The power comes from substations built for a different century.",
      visual: "Electrical substation with transformers and power lines" },
    { narration: "Cooling towers now decide where the next one gets built.",
      visual: "Industrial cooling towers and power plant infrastructure" },
  ]},
  { key: "autonomous-traffic", title: "The Cars Are Driving Themselves Now", beats: [
    { narration: "The car in the next lane is making its own decisions.",
      visual: "Autonomous vehicle driving on a city street among traffic" },
    { narration: "A spinning sensor on the roof maps everything within a block.",
      visual: "Lidar sensor mounted on the roof of a self driving car" },
    { narration: "Traffic cameras watch the same intersection from above.",
      visual: "Traffic camera on a pole above a city intersection" },
    { narration: "Control rooms track the fleet across the whole network.",
      visual: "Traffic management control room with monitors and operators" },
    { narration: "Every near miss becomes training data for the next version.",
      visual: "Busy urban street traffic with vehicles and pedestrians" },
  ]},
];

async function screen(t: Outline, search: (q: string) => Promise<any[]>) {
  const claimed = new Set<string>();
  const coverages: any[] = [];
  const concepts = new Map<string, number>();
  let acceptedIds = new Set<string>(), acceptedSecs = 0, brandDep = false;

  for (let i = 0; i < t.beats.length; i++) {
    const b = t.beats[i]!;
    const req = deriveRequirement({
      beatIndex: i + 1, segmentIndex: i, narration: b.narration, visualPrompt: b.visual,
      isHighSalience: i === 0,
    });
    const policy = derivePolicy(req);
    const queries = buildBeatQueries(req);

    const cands: any[] = []; const seen = new Set<string>();
    for (const q of queries) {
      for (const c of await search(q.query)) {
        if (seen.has(c.assetId)) continue;
        seen.add(c.assetId);
        cands.push({ assetId: c.assetId, description: c.description ?? "",
                     durationS: c.durationS ?? 0, brandRisk: false });
      }
    }
    const comp = composeBeat(req, policy, BEAT_S, cands, {
      beatMaxS: BEAT_MAX_S, minFragmentS: MIN_FRAGMENT_S, claimed,
    });
    for (const f of comp.fragments) { claimed.add(f.assetId); acceptedIds.add(f.assetId); acceptedSecs += f.durationS; }
    if (comp.fragments.some((f) => f.brandRisk)) brandDep = true;
    for (const f of comp.fragments) {
      const fam = scoreSemantic(req, f.description).subjectMatch ? req.primarySubjects[0] : req.settings[0];
      if (fam) concepts.set(fam, (concepts.get(fam) ?? 0) + f.durationS);
    }
    coverages.push({
      requirement: req, plannedS: BEAT_S,
      directCandidates: comp.fragments.map((f) => ({ assetId: f.assetId, description: f.description,
        usableS: f.durationS, brandRisk: f.brandRisk })),
      relevantSeconds: comp.fragments.reduce((a, f) => a + f.durationS, 0),
      nonBrandRiskSeconds: comp.fragments.filter((f) => !f.brandRisk).reduce((a, f) => a + f.durationS, 0),
      rejected: [], supported: comp.covered,
      needsCard: !comp.covered && req.cardPermitted,
      unsupported: !comp.covered && !req.cardPermitted,
      policy, subjectShare: comp.subjectShare, settingShare: comp.settingShare,
      candidateCount: cands.length, queries: queries.map((q) => q.query),
    });
  }

  const f = assessSemanticCoverage(coverages as any);
  const total = [...concepts.values()].reduce((a, b) => a + b, 0) || 1;
  const dist = [...concepts.entries()].map(([c, s]) => ({ concept: c, share: s / total }))
    .sort((a, b) => b.share - a.share);
  return { topic: t, f, coverages, acceptedAssets: acceptedIds.size, acceptedSecs,
           categories: dist.length, largest: dist[0], dist, brandDep };
}

async function main() {
  const search = pexelsOnlySource(env().PEXELS_API_KEY).search;
  const results: any[] = [];
  for (const t of TOPICS) {
    const r = await screen(t, search);
    results.push(r);
    const n = t.beats.length;
    console.log(`\n═══ ${t.key} — ${t.title} ═══`);
    for (const c of r.coverages) {
      console.log(`  beat ${c.requirement.beatIndex} ${c.supported ? "SUPPORTED  " : c.unsupported ? "UNSUPPORTED" : "CARD       "} [${c.policy}] subj ${(c.subjectShare*100).toFixed(0)}% set ${(c.settingShare*100).toFixed(0)}%  ${c.candidateCount} cands`);
    }
    console.log(`  supported ${r.f.supportedBeats}/${n} | cards ${r.f.cardBeats} (${(r.f.cardPct*100).toFixed(1)}%) | unsupported ${r.f.unsupportedBeats}`);
    console.log(`  accepted ${r.acceptedAssets} assets, ${r.acceptedSecs.toFixed(1)}s | categories ${r.categories} | largest ${r.largest ? `${r.largest.concept} ${(r.largest.share*100).toFixed(0)}%` : "n/a"} | brand-dep ${r.brandDep}`);
    console.log(`  SEMANTIC: ${r.f.pass ? "PASS" : "FAIL"}${r.f.failureReason ? ` — ${r.f.failureReason.slice(0,90)}` : ""}`);
  }
  writeFileSync("output/topic-screening-semantic.json", JSON.stringify(
    results.map((r) => ({ key: r.topic.key, title: r.topic.title,
      supported: r.f.supportedBeats, cards: r.f.cardBeats, cardPct: r.f.cardPct,
      unsupported: r.f.unsupportedBeats, acceptedAssets: r.acceptedAssets,
      acceptedSeconds: +r.acceptedSecs.toFixed(1), categories: r.categories,
      largestConcept: r.largest, distribution: r.dist, brandRiskDependent: r.brandDep,
      semanticPass: r.f.pass, failureReason: r.f.failureReason,
      beats: r.coverages.map((c: any) => ({ beat: c.requirement.beatIndex, policy: c.policy,
        supported: c.supported, unsupported: c.unsupported, queries: c.queries,
        candidates: c.candidateCount, subjectShare: c.subjectShare, settingShare: c.settingShare })) })),
    null, 2));
  console.log("\nwritten: output/topic-screening-semantic.json");
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => disconnect());
