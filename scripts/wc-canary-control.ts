/**
 * Wet Circuit private-canary control.
 *
 *   npx tsx scripts/wc-canary-control.ts                 # CHECK (default)
 *   npx tsx scripts/wc-canary-control.ts --arm  --i-understand-this-spends-credits
 *   npx tsx scripts/wc-canary-control.ts --run  --i-understand-this-spends-credits
 *
 * CHECK is read-only and is the default. ARM and RUN each require their own
 * explicit flag AND `--i-understand-this-spends-credits`, so no accidental
 * invocation can mutate anything or spend. Both refuse unless every pre-flight
 * check passes, and they are separate invocations on purpose: arming is
 * reviewable before anything is spent.
 *
 * Nothing here embeds a credential or changes Railway. ARM performs exactly one
 * compare-and-set on the candidate row plus one pilot activation, and opens no
 * budget. RUN opens no budget either: it executes `runWcCanaryOnce`, which
 * re-enters at `visualFeasibilityGate`, and the `voiceover` stage opens its own
 * window only if that gate passes. A feasibility failure costs zero characters.
 *
 * This tool is the ONLY way to start the canary. The deployed service's start
 * command runs `dist/index.js` → `runPipeline()`, which cannot select a
 * VOICEOVER_PENDING row, so no container boot, redeploy, or ON_FAILURE restart
 * can execute the canary.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { VideoStatus } from "@prisma/client";
import {
  prisma, disconnect, budgetReport, resumableJobs, prismaIntentStore,
  buildSpokenUnits, spokenCharacterCount, currentTestStage, runtimeRange,
  CHARS_PER_SECOND, TITLE_CARD_S, RunSummary, MANUAL_SUPERVISED,
} from "@yt-pipeline/pipeline-core";
import type { PilotConfig, Script } from "@yt-pipeline/pipeline-core";
import {
  WC_CANARY_AUTHORIZATIONS, resolveWcCanaryAuthorization,
  evaluateWcCanaryWindow, scriptSha256,
} from "../packages/wc-pipeline/src/canary/authorization";
import { runWcCanaryOnce } from "../packages/wc-pipeline/src/pipeline";
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
 *
 * runMode also flips to LIVE. The candidate was prepared under
 * DISABLE_ELEVEN=true, so its row still says DRY_RUN, and the halt guard only
 * blocks on `status = FAILED AND runMode = 'LIVE'`. Left as DRY_RUN, a canary
 * that failed after spending real credits would not halt anything: the next run
 * would sail past the guard, find nothing resumable, and start a brand-new
 * video. The row must describe the run that is about to happen.
 */
export function armTransitionSql(): string {
  return `UPDATE "wc_video"
     SET "status" = 'VOICEOVER_PENDING', "runMode" = 'LIVE',
         "failReason" = NULL, "updatedAt" = NOW()
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

/**
 * How long a feasibility verification stays current.
 *
 * Stock-library sourcing drifts: the pool that cleared the gate last week is
 * not the pool narration will be rendered against. A day keeps a verification
 * and its ARM in the same sitting without letting a stale PASS authorise spend.
 */
const FEASIBILITY_MAX_AGE_H = 24;

const VERIFICATION_PATH = "tmp/wc-feasibility-verification.json";

export interface FeasibilityVerification {
  candidateId: string;
  scriptSha256: string;
  profile: string;
  /**
   * The stage the verification was produced under, and the envelope that
   * implied. Runtime bands are stage-sensitive — DIAGNOSTIC is 55-100s while
   * PRODUCTION is the real 210-340s channel band — so a verification that does
   * not say which band it used cannot be trusted as evidence for a run under a
   * different one. Optional only so an older record is treated as unusable
   * rather than crashing the check.
   */
  testStage?: string;
  runtimeMinS?: number;
  runtimeMaxS?: number;
  videoS?: number;
  effectiveMaxConceptShare: number;
  dominantConcept: string;
  dominantShare: number;
  checksPassed: number;
  checksTotal: number;
  longestNoNewConceptRunS: number | null;
  result: "PASS" | "FAIL";
  verifiedAt: string;
  provenance: string;
}

/**
 * The most recent live feasibility verification, or null.
 *
 * Deliberately a local artifact, not a production DB row: this pass is not
 * authorised to write to the database, and a verification is evidence about a
 * moment, not durable candidate state.
 */
export function readFeasibilityVerification(): FeasibilityVerification | null {
  try {
    return JSON.parse(readFileSync(VERIFICATION_PATH, "utf8")) as FeasibilityVerification;
  } catch {
    return null;
  }
}


/**
 * Reject anything not in the flag surface.
 *
 * Every mode here falls through to a read-only CHECK when no mode flag matches,
 * which is safe but silent: a mistyped `--arm` produced a clean CHECK report
 * that an operator could easily read as "it armed". Refusing the command is the
 * only outcome that cannot be misread.
 */
function assertKnownFlags(argv: string[], known: string[]): boolean {
  const unknown = argv.slice(2).filter((a) => a.startsWith("--") && !known.includes(a));
  if (unknown.length === 0) return true;
  console.error(`\u2717 unrecognised flag(s): ${unknown.join(" ")}`);
  console.error(`  known flags: ${known.join(" ")}`);
  process.exitCode = 2;
  return false;
}

async function main() {
  if (!assertKnownFlags(process.argv, ["--arm", "--i-understand-this-spends-credits", "--run"])) return;
  hr(`WET CIRCUIT PRIVATE CANARY — PHASE: ${PHASE}`);
  console.log(`  pilot        ${AUTH.pilotId}`);
  console.log(`  candidate    ${AUTH.candidateId}`);
  console.log(`  channel      ${AUTH.channel} (${AUTH.channelId})`);
  console.log(`  profile      ${AUTH.qualityProfileName}`);
  console.log(`  ceiling      ${AUTH.maxNarrationChars} chars`);
  console.log(`  runtime      ${AUTH.runtimeMinS}-${AUTH.runtimeMaxS}s`);
  console.log(`  window       days ${JSON.stringify(AUTH.window.days)} ` +
    `${AUTH.window.startHour}:00-${AUTH.window.endHour}:00 ${AUTH.window.timezone} (end exclusive)`);

  if ((ARM || RUN) && !CONFIRMED) {
    console.error(`\n✗ ${PHASE} requires --i-understand-this-spends-credits. Refusing.`);
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
  // 0/1 is the pre-run state. Once the canary has produced its one video the
  // pilot stays ACTIVE at 1/1 with no slot left — a completed canary awaiting
  // human acceptance, not a failure. Completion is an explicit, acknowledged
  // step in the graduation control, because a private upload reaching YouTube
  // is evidence the machinery worked, not that a person approved it.
  const remaining = Math.max(0, pilot.maxSuccesses - pilot.successCount);
  ck(pilot.successCount === 0 && pilot.maxSuccesses === 1,
    "pilot success cap 0/1 (pre-run)", `${pilot.successCount}/${pilot.maxSuccesses}` +
      (remaining === 0 && pilot.successCount === 1
        ? " — CANARY_COMPLETE_REVIEW_REQUIRED: run graduation control"
        : ""));
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

  // The execution window is reported in its own section below, after global
  // safety, so that "authorised" and "may run right now" stay visibly separate.

  // ── Global safety ──────────────────────────────────────────────────
  hr("GLOBAL SAFETY");
  const rep = await budgetReport();
  const wcProd = rep.rows.find((r) => r.channel === "wet-circuit" && r.stage === "PRODUCTION");
  ck((wcProd?.limit ?? -1) === 0, "wet-circuit/PRODUCTION budget locked at 0",
    `limit=${wcProd?.limit} charged=${wcProd?.charged} reserved=${wcProd?.reserved}`);
  ck(rep.totalReserved === 0, "zero reservations", String(rep.totalReserved));
  // Phase-aware, and it has to be: CHECK and ARM must not be able to narrate,
  // but RUN cannot narrate with narration disabled. A single unconditional
  // "DISABLE_ELEVEN=true" would make RUN unreachable behind the clean-verdict
  // guard — a control that can never fire is not a control.
  const elevenOff = process.env.DISABLE_ELEVEN === "true";
  ck(PHASE === "RUN" ? !elevenOff : elevenOff,
    PHASE === "RUN" ? "DISABLE_ELEVEN off (RUN narrates)" : "DISABLE_ELEVEN=true (pre-arm safety)",
    String(process.env.DISABLE_ELEVEN));
  ck((await prisma.pipelineRun.count({ where: { endTime: null } })) === 0, "no active run", "0");
  const locks = await prisma.$queryRawUnsafe<any[]>(
    `SELECT objid FROM pg_locks WHERE locktype = 'advisory'`);
  ck(locks.length === 0, "no advisory lock held", `${locks.length}`);
  ck((await resumableJobs("wet-circuit")).length === 0, "no resumable WC job", "0");
  ck((await prismaIntentStore.listUnresolved()).length === 0, "no unresolved upload intent", "0");
  ck(currentTestStage() === "PRODUCTION" || PHASE === "CHECK",
    "TEST_STAGE", `${currentTestStage()} (PRODUCTION required only at RUN)`);

  // ── Execution window ───────────────────────────────────────────────────
  //
  // This control IS the supervision: nothing here runs without a human typing
  // the command and its acknowledgement flag. The time-of-day window therefore
  // no longer bounds an attempt — the tracked authorisation, the single-slot
  // cap, the per-candidate budget window and the relock do. The authorisation's
  // window fields are still validated (a malformed one refuses), and the
  // ordinary WC runner, which a container start can reach, still honours them.
  hr("EXECUTION WINDOW (manually supervised — time-of-day not enforced)");
  const wNow = evaluateWcCanaryWindow(new Date(), AUTH, MANUAL_SUPERVISED);
  console.log(`  now (local)  ${wNow.nowLocal}`);
  console.log(`  authorised   days ${JSON.stringify(AUTH.window.days)} (1=Mon 3=Wed 5=Fri)`);
  ck(wNow.allowed, "manual supervision — any day, any hour", wNow.reason);

  // ── Feasibility provenance ─────────────────────────────────────────
  //
  // The candidate has never passed feasibility in its own durable record: it
  // sits at QUALITY_FAILED precisely because the strict gate refused it. A
  // preserved evidence file from an earlier pass is NOT a current verdict, and
  // CHECK must never let one stand in for a live one — sourcing drifts, and the
  // question is whether TODAY's asset pool clears the gate.
  hr("FEASIBILITY VERIFICATION");
  const verification = readFeasibilityVerification();
  if (!verification) {
    ck(false, "feasibility CURRENTLY VERIFIED", "NOT YET VERIFIED — run wc-feasibility-verify.ts");
  } else if (verification.candidateId !== AUTH.candidateId) {
    ck(false, "feasibility CURRENTLY VERIFIED",
      `NOT YET VERIFIED — record is for ${verification.candidateId}`);
  } else if (verification.scriptSha256 !== AUTH.scriptSha256) {
    ck(false, "feasibility CURRENTLY VERIFIED",
      `NOT YET VERIFIED — script drifted since verification`);
  } else if (verification.profile !== AUTH.qualityProfileName) {
    ck(false, "feasibility CURRENTLY VERIFIED",
      `NOT YET VERIFIED — verified under ${verification.profile}`);
  } else if (verification.testStage !== AUTH.testStage) {
    // A verification produced under DIAGNOSTIC judged the candidate against a
    // 55-100s band. Accepting it as evidence for a PRODUCTION run would be the
    // dangerous inverse of the false FAIL that exposed this gap.
    ck(false, "feasibility CURRENTLY VERIFIED",
      `NOT YET VERIFIED — produced under stage ${verification.testStage ?? "<unrecorded>"}, ` +
      `run requires ${AUTH.testStage}`);
  } else if (verification.runtimeMinS !== AUTH.runtimeMinS ||
             verification.runtimeMaxS !== AUTH.runtimeMaxS) {
    ck(false, "feasibility CURRENTLY VERIFIED",
      `NOT YET VERIFIED — verified against ${verification.runtimeMinS}-${verification.runtimeMaxS}s, ` +
      `authorised envelope is ${AUTH.runtimeMinS}-${AUTH.runtimeMaxS}s`);
  } else {
    const ageH = (Date.now() - Date.parse(verification.verifiedAt)) / 3600000;
    const fresh = ageH <= FEASIBILITY_MAX_AGE_H;
    ck(verification.result === "PASS" && fresh,
      "feasibility CURRENTLY VERIFIED",
      `${verification.result} at ${verification.verifiedAt} (${ageH.toFixed(1)}h old, ` +
      `max ${FEASIBILITY_MAX_AGE_H}h)${fresh ? "" : " — STALE, re-verify"}`);
    console.log(`     stage ${verification.testStage} envelope ` +
      `${verification.runtimeMinS}-${verification.runtimeMaxS}s` +
      (verification.videoS ? `, candidate ${verification.videoS}s` : ""));
    console.log(`     dominant ${verification.dominantConcept} ${(verification.dominantShare * 100).toFixed(1)}%` +
      ` vs tolerance ${(verification.effectiveMaxConceptShare * 100).toFixed(0)}%`);
    console.log(`     ${verification.checksPassed}/${verification.checksTotal} checks passed`);
    console.log(`     provenance: ${verification.provenance}`);
  }

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
    console.log(`\n  RUN is a SEPARATE invocation. It opens NO budget window itself:`);
    console.log(`  runWcCanaryOnce("${AUTH.candidateId}") re-enters at`);
    console.log(`  visualFeasibilityGate, and only if that gate passes does the voiceover`);
    console.log(`  stage open its own ${submitChars}-char window and relock it afterwards.`);
    console.log(`  A feasibility failure therefore costs zero characters.`);
    console.log(`  The ordinary runner cannot start this candidate: VOICEOVER_PENDING is`);
    console.log(`  deliberately not resumable, so it would create a NEW video instead.`);
    process.exitCode = failed.length === 0 ? 0 : 1;
    return;
  }

  // Past this point every pre-flight check must have passed. ARM and RUN both
  // mutate; neither proceeds on a partial verdict.
  if (failed.length > 0) {
    console.error(`\n✗ ${PHASE} refused — pre-flight is not clean.`);
    process.exitCode = 1;
    return;
  }

  if (ARM) {
    hr("ARM");
    // One compare-and-set. Every precondition is in the WHERE clause, so a row
    // that has drifted matches nothing and zero rows update.
    const moved: number = await prisma.$executeRawUnsafe(armTransitionSql(), AUTH.candidateId);
    if (moved !== 1) {
      console.error(`\n✗ ARM matched ${moved} rows, expected 1 — candidate drifted. Nothing else was touched.`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ✓ candidate ${AUTH.candidateId} → ${VideoStatus.VOICEOVER_PENDING}`);

    // Activation is also a compare-and-set: only a PREPARED pilot activates, so
    // a second ARM cannot re-activate or reset the cap.
    const activated: number = await prisma.$executeRawUnsafe(
      `UPDATE "production_pilot"
          SET "status" = 'ACTIVE', "activatedAt" = NOW(), "updatedAt" = NOW()
        WHERE "pilotId" = $1 AND "status" = 'PREPARED' AND "activatedAt" IS NULL`,
      AUTH.pilotId,
    );
    if (activated !== 1) {
      console.error(`\n✗ pilot activation matched ${activated} rows, expected 1.`);
      console.error(`  The candidate IS armed. Re-run CHECK before RUN.`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ✓ pilot ${AUTH.pilotId} PREPARED → ACTIVE`);
    console.log(`\n  ARM complete. No budget was opened and nothing was spent.`);
    console.log(`  RUN is a separate invocation:`);
    console.log(`    npx tsx scripts/wc-canary-control.ts --run --i-understand-this-spends-credits`);
    process.exitCode = 0;
    return;
  }

  // ── RUN ────────────────────────────────────────────────────────────
  //
  // The ordinary root runner CANNOT execute this candidate: VOICEOVER_PENDING
  // is deliberately absent from RESUME_FROM, so `node dist/index.js` would not
  // select it — it would fall through to topicDiscovery and spend the pilot's
  // only slot on a different, brand-new video. Execution therefore goes through
  // runWcCanaryOnce(), which is addressed by id and has no discovery path.
  // RUN opens NO budget window of its own. The `voiceover` stage opens one,
  // sized to the exact spoken units, and relocks it in a finally. Opening an
  // outer window here would raise the PRODUCTION limit before
  // visualFeasibilityGate has run — precisely the pre-spend ordering this path
  // exists to guarantee. A feasibility failure must cost zero characters, and
  // it does only if nothing has been opened by the time it fails.
  hr("RUN");
  console.log(`  candidate    ${AUTH.candidateId}`);
  console.log(`  re-enters at visualFeasibilityGate — narration is unreachable until it passes`);
  console.log(`  wet-circuit/PRODUCTION stays at limit 0 until the voiceover stage opens`);
  console.log(`  its own ${submitChars}-char window, and relocks it on the way out.`);
  const summary = new RunSummary("wet-circuit", "LIVE");
  summary.setVerifiedChannel(AUTH.channel, AUTH.channelId);
  try {
    await runWcCanaryOnce(AUTH.candidateId, summary);
    console.log(`\n  ✓ RUN finished.`);
  } finally {
    await summary.persist();
  }
  process.exitCode = 0;
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
