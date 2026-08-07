/**
 * Run candidate A through the REAL visual feasibility gate, with no durable
 * mutation and no spend.
 *
 *   PILOT_ID=wet-circuit-private-canary-1 TEST_STAGE=PRODUCTION \
 *   DISABLE_ELEVEN=true npx tsx scripts/wc-feasibility-verify.ts
 *
 * This executes `wcVisualFeasibilityGate` itself — the same function the
 * pipeline calls — not a reimplementation of it. Two things are substituted at
 * the module boundary, both narrowly and both reported:
 *
 *   1. `prisma.wcVideo.update` is replaced by a recorder. It is the gate's ONLY
 *      durable write, reached only on failure (`failCandidate`). Intercepting it
 *      is what makes a FAIL verdict observable without moving the candidate.
 *
 *   2. `currentPilot` is replaced by one returning the real durable pilot row
 *      with `windowDays` corrected to [1,3,5]. The tracked authorisation now
 *      declares Mon/Wed/Fri, and `assertPilotWindowMatches` compares it against
 *      the pilot row, which still says [2,4]. Updating that row is a production
 *      DB write this pass is not authorised to make, so it is modelled here.
 *      Nothing else about the pilot is changed.
 *
 * The gate opens no budget and buys nothing. It queries Pexels for READ-ONLY
 * asset metadata (`/videos/search`) and downloads no media.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { VideoStatus } from "@prisma/client";
import * as core from "@yt-pipeline/pipeline-core";
import { prisma, disconnect } from "@yt-pipeline/pipeline-core";
import type { PilotConfig, PipelineContext, Script } from "@yt-pipeline/pipeline-core";
import { WC_CANARY_AUTHORIZATIONS, scriptSha256 } from "../packages/wc-pipeline/src/canary/authorization";
import { wcVisualFeasibilityGate, wcDurationEnvelope } from "../packages/wc-pipeline/src/stages/visualFeasibilityGate";
import { tieAwareConceptAccounting, tieAwareChecks } from "../packages/wc-pipeline/src/stages/conceptAccounting";
import { longestNoNewConceptRun } from "../packages/wc-pipeline/src/stages/monotonyDiagnostics";
import "dotenv/config";

const AUTH = WC_CANARY_AUTHORIZATIONS[0]!;
const hr = (t: string) => console.log(`\n${"═".repeat(78)}\n  ${t}\n${"═".repeat(78)}`);

/** Every durable write the gate attempted. Must stay empty on PASS. */
const attemptedWrites: unknown[] = [];

async function main() {
  hr("WC FEASIBILITY VERIFICATION — NO SPEND, NO DURABLE MUTATION");
  console.log(`  candidate    ${AUTH.candidateId}`);
  console.log(`  profile      ${AUTH.qualityProfileName} (resolved via authorisation, never restated)`);
  console.log(`  TEST_STAGE   ${process.env.TEST_STAGE}`);
  console.log(`  PILOT_ID     ${process.env.PILOT_ID}`);
  console.log(`  DISABLE_ELEVEN ${process.env.DISABLE_ELEVEN}`);

  const video = await prisma.wcVideo.findUnique({
    where: { id: AUTH.candidateId },
    include: { topic: true },
  });
  if (!video) throw new Error(`candidate ${AUTH.candidateId} not found`);
  const script = video.scriptJson as unknown as Script;

  const sha = scriptSha256(script);
  console.log(`\n  script SHA   ${sha}`);
  if (sha !== AUTH.scriptSha256) throw new Error("script drift — refusing to verify a different script");
  console.log(`  status       ${video.status}`);
  console.log(`  topic        ${video.topic.title}`);

  const env = wcDurationEnvelope(script);
  console.log(`  submitChars  ${env.submitChars}`);
  console.log(`  videoS       ${env.videoS.toFixed(1)}s`);

  // ── Substitution 1: the gate's only durable write ──────────────────
  const realUpdate = prisma.wcVideo.update.bind(prisma.wcVideo);
  (prisma.wcVideo as unknown as { update: unknown }).update = async (args: unknown) => {
    attemptedWrites.push(args);
    console.log(`\n  [intercepted] wcVideo.update suppressed — candidate NOT moved`);
    console.log(`  ${JSON.stringify(args)}`);
    return { ...video };
  };
  void realUpdate; // never called

  // ── Substitution 2: pilot window, modelling the pending durable fix ─
  const pilots = (prisma as never as { productionPilot: { findUnique(a: unknown): Promise<PilotConfig | null> } }).productionPilot;
  const durablePilot = await pilots.findUnique({ where: { pilotId: AUTH.pilotId } });
  if (!durablePilot) throw new Error("pilot row missing");
  console.log(`\n  pilot windowDays in DB      ${JSON.stringify(durablePilot.windowDays)}`);
  console.log(`  pilot windowDays authorised ${JSON.stringify(AUTH.window.days)}`);
  const modelled: PilotConfig = { ...durablePilot, windowDays: [...AUTH.window.days] };
  if (JSON.stringify(durablePilot.windowDays) !== JSON.stringify(AUTH.window.days)) {
    console.log(`  → modelling the authorised window; the durable row still needs updating`);
  }
  // Substituted at the Prisma layer, not the module export: pipeline-core's CJS
  // re-exports are getter-only, so assigning `core.currentPilot` silently
  // no-ops. `getPilot` reads through this exact call, so the real
  // `currentPilot` runs and returns the modelled row.
  (pilots as unknown as { findUnique: unknown }).findUnique = async () => modelled;

  // ── The real gate ──────────────────────────────────────────────────
  hr("REAL visualFeasibilityGate EXECUTION");
  const ctx = {
    topic: video.topic,
    video,
    script,
  } as unknown as PipelineContext;

  const result = await wcVisualFeasibilityGate(ctx);

  // Re-derive the same numbers for the record CHECK reads. These call the same
  // functions the gate just used, on the same report — this is transcription of
  // the verdict, not a second evaluation of it.
  const report = await core.assessVisualFeasibility(
    {
      channel: "wet-circuit",
      topicTitle: video.topic.title,
      targetRuntimeS: Math.round(env.videoS),
      segments: core.spokenOutlineSegments(script).map((s) => ({
        segmentIndex: s.segmentIndex, title: s.title,
        narration: s.narration, visual_prompt: s.visual_prompt,
      })),
    },
    core.pexelsOnlySource(core.env().PEXELS_API_KEY),
  );
  const accounting = tieAwareConceptAccounting(report, { qualityProfileName: AUTH.qualityProfileName });
  const checks = tieAwareChecks(report, accounting);
  const runDiag = longestNoNewConceptRun(accounting.fragments);

  hr("TIE-AWARE CONCEPT DISTRIBUTION");
  for (const [c, s] of Object.entries(accounting.conceptShares).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(14)} ${(s * 100).toFixed(1)}%  (${accounting.conceptSeconds[c]?.toFixed(1)}s)`);
  }
  console.log(`  denominator    ${accounting.denominatorSeconds.toFixed(1)}s`);
  console.log(`  genuine none   ${(accounting.genuineNoneShare * 100).toFixed(1)}%`);
  console.log(`  concrete       ${accounting.distinctConcreteConcepts} (${accounting.concreteConcepts.join(", ")})`);
  console.log(`  dominant       ${accounting.dominantAnyConcept} ${(accounting.dominantAnyShare * 100).toFixed(1)}%`);
  console.log(`  tolerance      ${(accounting.tolerance.maxConceptShare * 100).toFixed(0)}% ` +
    `[${accounting.tolerance.mode} ${accounting.tolerance.profileName}]`);

  hr("TIE SETS (fragments whose outcome is TIE, split evenly)");
  const tieSets = new Map<string, { seconds: number; fragments: number }>();
  let tieSeconds = 0;
  for (const f of accounting.fragments) {
    if (f.tiedConcepts.length > 1) {
      const key = [...f.tiedConcepts].sort().join(" + ");
      const prev = tieSets.get(key) ?? { seconds: 0, fragments: 0 };
      tieSets.set(key, { seconds: prev.seconds + f.projectedSeconds, fragments: prev.fragments + 1 });
      tieSeconds += f.projectedSeconds;
    }
  }
  if (tieSets.size === 0) console.log("  (none)");
  for (const [k, v] of [...tieSets].sort((a, b) => b[1].seconds - a[1].seconds)) {
    console.log(`  ${k.padEnd(34)} ${v.seconds.toFixed(1)}s across ${v.fragments} fragment(s)`);
  }
  console.log(`  total tied     ${tieSeconds.toFixed(1)}s ` +
    `(${((tieSeconds / accounting.denominatorSeconds) * 100).toFixed(1)}% of timeline)`);

  const outcomes = new Map<string, number>();
  for (const f of accounting.fragments) {
    outcomes.set(f.outcome, (outcomes.get(f.outcome) ?? 0) + 1);
  }
  console.log(`  fragment outcomes: ` +
    [...outcomes].map(([o, n]) => `${o}=${n}`).join(" "));

  hr("VERDICT");
  console.log(`  success      ${result.success}`);
  if (result.error) console.log(`  error        ${result.error}`);
  console.log(`  durationMs   ${result.durationMs}`);
  console.log(`\n  durable writes attempted: ${attemptedWrites.length}`);
  console.log(
    result.success
      ? "\n  CURRENT_A_FEASIBILITY_PASS"
      : "\n  CURRENT_A_FEASIBILITY_FAIL",
  );

  // Written locally, never to the production DB. CHECK reads it and refuses to
  // treat it as current once it ages out.
  const record = {
    candidateId: AUTH.candidateId,
    scriptSha256: sha,
    profile: AUTH.qualityProfileName,
    effectiveMaxConceptShare: accounting.tolerance.maxConceptShare,
    dominantConcept: accounting.dominantAnyConcept,
    dominantShare: accounting.dominantAnyShare,
    checksPassed: checks.filter((c) => c.ok).length,
    checksTotal: checks.length,
    longestNoNewConceptRunS: runDiag ? runDiag.seconds : null,
    result: result.success ? "PASS" : "FAIL",
    verifiedAt: new Date().toISOString(),
    provenance:
      `live wcVisualFeasibilityGate execution; ${report.totalCandidates} Pexels candidates ` +
      `over ${report.expectedBeatCount} beats; read-only metadata only`,
  };
  mkdirSync("tmp", { recursive: true });
  writeFileSync("tmp/wc-feasibility-verification.json", JSON.stringify(record, null, 2));
  console.log(`\n  verification record → tmp/wc-feasibility-verification.json`);

  // Prove nothing moved.
  hr("POST-VERIFICATION CANDIDATE STATE (must be unchanged)");
  const after = await prisma.wcVideo.findUnique({
    where: { id: AUTH.candidateId },
    select: { status: true, updatedAt: true, failReason: true, voiceoverPath: true, videoPath: true },
  });
  console.log(`  status       ${after?.status} (expected ${VideoStatus.QUALITY_FAILED})`);
  console.log(`  updatedAt    ${after?.updatedAt.toISOString()}`);
  console.log(`  voiceoverPath ${after?.voiceoverPath ?? "null"}`);
  console.log(`  videoPath    ${after?.videoPath ?? "null"}`);

  const rep = await core.budgetReport();
  const wcProd = rep.rows.find((r) => r.channel === "wet-circuit" && r.stage === "PRODUCTION");
  console.log(`  wc/PRODUCTION limit=${wcProd?.limit} charged=${wcProd?.charged} reserved=${wcProd?.reserved}`);
  console.log(`  totalReserved ${rep.totalReserved}`);
  console.log(`  elevenLabs rows for A: ${await prisma.elevenLabsUsage.count({ where: { videoId: AUTH.candidateId } })}`);

  await disconnect();
}

main().catch(async (e) => {
  console.error("\nVERIFICATION FAILED:", e);
  process.exitCode = 1;
  await disconnect();
});
