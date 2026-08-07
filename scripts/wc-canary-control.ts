/**
 * Wet Circuit private-canary control.
 *
 *   npx tsx scripts/wc-canary-control.ts                 # CHECK (default)
 *   npx tsx scripts/wc-canary-control.ts --arm           # ARM  (not invoked yet)
 *   npx tsx scripts/wc-canary-control.ts --run           # RUN  (not invoked yet)
 *
 * CHECK is read-only and is the default. ARM and RUN each require their own
 * explicit flag AND `--i-understand-this-spends-credits`, so no accidental
 * invocation can mutate anything or spend.
 *
 * Nothing here embeds a credential, changes Railway, or opens a budget on its
 * own. ARM performs exactly one compare-and-set on the candidate row plus one
 * pilot activation; RUN is deliberately not implemented yet and refuses.
 */
import { createHash } from "node:crypto";
import { VideoStatus } from "@prisma/client";
import {
  prisma, disconnect, budgetReport, resumableJobs, prismaIntentStore,
  buildSpokenUnits, spokenCharacterCount, currentTestStage, runtimeRange,
  CHARS_PER_SECOND, TITLE_CARD_S,
} from "@yt-pipeline/pipeline-core";
import type { PilotConfig, Script } from "@yt-pipeline/pipeline-core";
import {
  WC_CANARY_AUTHORIZATIONS, resolveWcCanaryAuthorization,
  evaluateWcCanaryWindow, scriptSha256,
} from "../packages/wc-pipeline/src/canary/authorization";
import "dotenv/config";

const ARM = process.argv.includes("--arm");
const RUN = process.argv.includes("--run");
const CONFIRMED = process.argv.includes("--i-understand-this-spends-credits");
const PHASE = RUN ? "RUN" : ARM ? "ARM" : "CHECK";

const AUTH = WC_CANARY_AUTHORIZATIONS[0]!;
const pilots = (prisma as never as { productionPilot: any }).productionPilot;

const hr = (t: string) => console.log(`\n${"═".repeat(78)}\n  ${t}\n${"═".repeat(78)}`);
const results: { ok: boolean; label: string; detail: string }[] = [];
function ck(ok: boolean, label: string, detail: string) {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(46)} ${detail}`);
}

/**
 * The single controlled transition ARM would perform.
 *
 * Compare-and-set: every precondition is in the WHERE clause, so a row that
 * has drifted matches nothing and zero rows update. It never overwrites a
 * candidate that has narrated, rendered or uploaded, and it cannot run twice.
 *
 * Target status is VOICEOVER_PENDING — the state `qualityGate` leaves a
 * passing candidate in, immediately before `visualFeasibilityGate`. It is
 * deliberately NOT in RESUME_FROM: adding it there would arm every
 * crashed-mid-narration row for an unattended re-spend. The canary is driven
 * explicitly by this tool instead, so A stays inert to ordinary runs.
 */
export function armTransitionSql(): string {
  return `UPDATE "wc_video"
     SET "status" = 'VOICEOVER_PENDING', "failReason" = NULL, "updatedAt" = NOW()
   WHERE "id" = $1
     AND "status" = 'QUALITY_FAILED'
     AND "qualityScore" = 88
     AND "scriptJson" IS NOT NULL
     AND "voiceoverPath" IS NULL
     AND "videoPath" IS NULL
     AND "youtubeId" IS NULL
     AND "scheduledAt" IS NULL
     AND "shortsUrl" IS NULL`;
}

async function main() {
  hr(`WET CIRCUIT PRIVATE CANARY — PHASE: ${PHASE}`);
  console.log(`  pilot        ${AUTH.pilotId}`);
  console.log(`  candidate    ${AUTH.candidateId}`);
  console.log(`  channel      ${AUTH.channel} (${AUTH.channelId})`);
  console.log(`  profile      ${AUTH.qualityProfileName}`);
  console.log(`  ceiling      ${AUTH.maxNarrationChars} chars`);
  console.log(`  runtime      ${AUTH.runtimeMinS}-${AUTH.runtimeMaxS}s`);
  console.log(`  window       days ${JSON.stringify(AUTH.window.days)} ` +
    `${AUTH.window.startHour}:00-${AUTH.window.endHour}:00 ${AUTH.window.timezone} (end exclusive)`);

  if (RUN) {
    console.error("\n✗ RUN is not implemented. Executing the canary is a separate authorised step.");
    process.exitCode = 2;
    return;
  }
  if (ARM && !CONFIRMED) {
    console.error("\n✗ ARM requires --i-understand-this-spends-credits. Refusing.");
    process.exitCode = 2;
    return;
  }

  // ── Pilot ──────────────────────────────────────────────────────────
  hr("PILOT");
  const pilot: PilotConfig | null = await pilots.findUnique({ where: { pilotId: AUTH.pilotId } });
  ck(!!pilot, "pilot record exists", pilot ? pilot.id : "MISSING");
  if (!pilot) { process.exitCode = 1; return; }
  ck(pilot.channel === AUTH.channel && pilot.channelId === AUTH.channelId,
    "pilot bound to the WC channel", `${pilot.channel}/${pilot.channelId}`);
  ck(pilot.status === "PREPARED", "pilot PREPARED (not yet activated)", pilot.status);
  ck(!pilot.activatedAt, "pilot has no activation timestamp", String(pilot.activatedAt));
  ck(pilot.successCount === 0 && pilot.maxSuccesses === 1,
    "pilot success cap 0/1", `${pilot.successCount}/${pilot.maxSuccesses}`);
  ck(pilot.privacyStatus === "private" && !pilot.allowPublishAt,
    "PRIVATE with publishAt forbidden", `${pilot.privacyStatus} allowPublishAt=${pilot.allowPublishAt}`);
  ck(!pilot.shortsEnabled, "Shorts disabled", String(pilot.shortsEnabled));
  ck(pilot.requireFeasibility && pilot.requireGuardedUpload,
    "feasibility + guarded upload required", "both true");

  // ── Candidate ──────────────────────────────────────────────────────
  hr("CANDIDATE");
  const cand = await prisma.wcVideo.findUnique({
    where: { id: AUTH.candidateId }, include: { topic: true },
  });
  ck(!!cand, "candidate exists", cand ? cand.id : "MISSING");
  if (!cand) { process.exitCode = 1; return; }
  ck(cand.status === VideoStatus.QUALITY_FAILED,
    "candidate at expected terminal status", cand.status);
  ck(!!cand.scriptJson, "durable script present", cand.scriptJson ? "yes" : "no");
  const script = cand.scriptJson as unknown as Script;
  const hash = scriptSha256(script);
  ck(hash === AUTH.scriptSha256, "script SHA-256 matches authorisation", `${hash.slice(0, 24)}…`);
  ck(cand.qualityScore === 88, "qualityScore 88", String(cand.qualityScore));
  ck(!cand.voiceoverPath, "no narration artifact", cand.voiceoverPath ?? "none");
  ck(!cand.videoPath, "no rendered video", cand.videoPath ?? "none");
  ck(!cand.youtubeId, "no youtubeId", cand.youtubeId ?? "none");
  ck(!cand.scheduledAt && !cand.shortsUrl, "no schedule, no Short", "none");
  ck((await prisma.elevenLabsUsage.count({ where: { videoId: cand.id } })) === 0,
    "zero credit rows", "0");
  ck((await prisma.qaRecord.count({ where: { videoId: cand.id } })) === 0, "zero QA records", "0");
  ck((await prisma.uploadIntent.count({ where: { videoId: cand.id } })) === 0,
    "zero upload intents", "0");
  ck((await prisma.jobQuarantine.count({ where: { videoId: cand.id, releasedAt: null } })) === 0,
    "not quarantined", "0");

  // ── Narration / runtime envelope ───────────────────────────────────
  hr("NARRATION AND RUNTIME");
  const units = buildSpokenUnits(script);
  const submitChars = spokenCharacterCount(units);
  const narrationS = submitChars / CHARS_PER_SECOND["wet-circuit"];
  const videoS = narrationS + TITLE_CARD_S;
  const range = runtimeRange("wet-circuit", "LONGFORM", "PRODUCTION");
  ck(submitChars <= AUTH.maxNarrationChars, "narration within ceiling",
    `${submitChars} / ${AUTH.maxNarrationChars}`);
  ck(range.minS === AUTH.runtimeMinS && range.maxS === AUTH.runtimeMaxS,
    "runtime envelope matches canonical source", `${range.minS}-${range.maxS}s`);
  ck(videoS >= range.minS && videoS <= range.maxS, "predicted runtime inside envelope",
    `${videoS.toFixed(1)}s`);

  // ── Authorisation resolution ───────────────────────────────────────
  hr("AUTHORISATION");
  try {
    const r = resolveWcCanaryAuthorization({ pilot, candidateId: cand.id, script, submitChars });
    ck(!!r, "authorisation resolves", r ? `${r.qualityProfileName}` : "null");
    if (r) ck(true, "effective concept-share tolerance",
      `${(r.effectiveMaxConceptShare * 100).toFixed(0)}% (profile-owned)`);
  } catch (e) {
    ck(false, "authorisation resolves", e instanceof Error ? e.message : String(e));
  }

  // ── Execution window ───────────────────────────────────────────────
  hr("EXECUTION WINDOW");
  const now = new Date();
  const w = evaluateWcCanaryWindow(now, AUTH);
  ck(w.allowed, "inside the authorised execution window", w.reason);
  console.log(`     now (local): ${w.nowLocal}`);

  // ── Global safety ──────────────────────────────────────────────────
  hr("GLOBAL SAFETY");
  const rep = await budgetReport();
  const wcProd = rep.rows.find((r) => r.channel === "wet-circuit" && r.stage === "PRODUCTION");
  ck((wcProd?.limit ?? -1) === 0, "wet-circuit/PRODUCTION budget locked at 0",
    `limit=${wcProd?.limit} charged=${wcProd?.charged} reserved=${wcProd?.reserved}`);
  ck(rep.totalReserved === 0, "zero reservations", String(rep.totalReserved));
  ck(process.env.DISABLE_ELEVEN === "true", "DISABLE_ELEVEN=true (pre-arm safety)",
    String(process.env.DISABLE_ELEVEN));
  ck((await prisma.pipelineRun.count({ where: { endTime: null } })) === 0, "no active run", "0");
  const locks = await prisma.$queryRawUnsafe<any[]>(
    `SELECT objid FROM pg_locks WHERE locktype = 'advisory'`);
  ck(locks.length === 0, "no advisory lock held", `${locks.length}`);
  ck((await resumableJobs("wet-circuit")).length === 0, "no resumable WC job", "0");
  ck((await prismaIntentStore.listUnresolved()).length === 0, "no unresolved upload intent", "0");
  ck(currentTestStage() === "PRODUCTION" || PHASE === "CHECK",
    "TEST_STAGE", `${currentTestStage()} (PRODUCTION required only at RUN)`);

  // ── Verdict ────────────────────────────────────────────────────────
  hr("VERDICT");
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log(`  ✓ ALL ${results.length} PRE-FLIGHT CHECKS PASS`);
  } else {
    console.log(`  ✗ ${failed.length}/${results.length} CHECK(S) FAILED:`);
    for (const f of failed) console.log(`     - ${f.label}: ${f.detail}`);
  }

  if (PHASE === "CHECK") {
    console.log(`\n  CHECK is read-only. Nothing was mutated.`);
    console.log(`  The transition ARM would perform (NOT executed):\n`);
    console.log(armTransitionSql().split("\n").map((l) => `     ${l}`).join("\n"));
    console.log(`\n     params: $1 = ${AUTH.candidateId}`);
    console.log(`     plus: productionPilot ${AUTH.pilotId} PREPARED → ACTIVE with activatedAt=NOW()`);
    console.log(`     plus: setBudgetLimit("wet-circuit","PRODUCTION",${submitChars}) at RUN, relocked after`);
    process.exitCode = failed.length === 0 ? 0 : 1;
    return;
  }

  // ARM would mutate here. Deliberately unreachable in this pass.
  console.error("\n✗ ARM is gated and was not executed in this build.");
  process.exitCode = 2;
}

// Only when executed directly. Importing this module (tests import
// `armTransitionSql` to pin the compare-and-set) must not run anything.
const isDirectRun =
  process.argv[1]?.endsWith("wc-canary-control.ts") ||
  process.argv[1]?.endsWith("wc-canary-control.js");

if (isDirectRun) {
  main().catch((e) => { console.error("CONTROL FAILED:", e); process.exitCode = 1; })
    .finally(() => disconnect());
}
