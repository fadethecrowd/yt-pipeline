/**
 * One read-only answer to "is it safe to start Monday's work?".
 *
 *   npx tsx scripts/monday-preflight.ts
 *
 * Ends in MONDAY_PREFLIGHT = PASS or FAIL with reasons. It mutates nothing, and
 * it must never be made to mutate something in order to reach PASS — a preflight
 * that fixes what it inspects is a preflight nobody can trust. Every FAIL here
 * names the command a human runs to resolve it.
 *
 * Deliberately covers the whole surface rather than one channel, because the
 * failures worth catching on a Monday morning are the cross-cutting ones: a
 * service running the wrong commit, a scheduler that got armed, a leftover
 * reservation, an upload intent nobody resolved.
 *
 * LOCAL ONLY. No runtime imports this.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { prisma, disconnect, isSchedulerEnabled, isUnattendedMode } from "@yt-pipeline/pipeline-core";
import { takeSnapshot } from "./production-snapshot";
import "dotenv/config";

interface Check {
  ok: boolean;
  label: string;
  detail: string;
  /** What a human does about it. Only meaningful when ok is false. */
  remedy?: string;
}

const checks: Check[] = [];
function ck(ok: boolean, label: string, detail: string, remedy?: string): void {
  checks.push({ ok, label, detail, remedy });
}

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const FEASIBILITY_MAX_AGE_H = 24;
const WC_CANDIDATE = "cmshxoekx0006mbnax92xyygl";
/** Must match VERIFICATION_PATH in scripts/wc-canary-control.ts. */
const VERIFICATION_PATH = "tmp/wc-feasibility-verification.json";

async function main(): Promise<void> {
  console.log("\n══ MONDAY PREFLIGHT ══════════════════════════════════════════════\n");

  // ── Git / release ───────────────────────────────────────────────────
  const head = sh("git", ["rev-parse", "HEAD"]);
  sh("git", ["fetch", "-q", "origin"]);
  const originMain = sh("git", ["rev-parse", "origin/main"]);
  const dirty = sh("git", ["status", "--short", "--untracked-files=no"]);
  ck(head === originMain, "local HEAD equals origin/main",
    `HEAD=${head.slice(0, 8)} origin/main=${originMain.slice(0, 8)}`,
    "release the reviewed feature HEAD: git push origin HEAD:main");
  ck(dirty === "", "working tree clean (tracked files)", dirty || "clean",
    "commit or stash before operating");

  // ── Railway: exact deployed commit per service ──────────────────────
  const services = ["yt-pipeline", "wc-pipeline", "monitor-ai-doom", "monitor-wc"];
  for (const svc of services) {
    const raw = sh("railway", ["deployment", "list", "--service", svc, "--json"]);
    if (!raw) {
      ck(false, `${svc} deployment readable`, "railway CLI unavailable or not linked",
        `run: railway status  (and railway link if needed)`);
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const rows = (Array.isArray(parsed) ? parsed : []) as {
        status?: string; meta?: { branch?: string; commitHash?: string } }[];
      // The question is "has Railway evaluated canonical main for this
      // service", not "did it rebuild". SKIPPED means Watch Paths matched
      // nothing in that commit, so the running build is already correct — a
      // release touching only scripts/, docs/ or tests/ legitimately skips all
      // four services. Treating SKIPPED as stale produces a false FAIL on
      // exactly the safest kind of release, so both count as up to date; only
      // a FAILED or still-building newest deployment is a real problem.
      const newest = rows[0];
      const commit = newest?.meta?.commitHash ?? "";
      const branch = newest?.meta?.branch ?? "?";
      const status = newest?.status ?? "?";
      const settled = status === "SUCCESS" || status === "SKIPPED";
      const onMain = commit.startsWith(originMain.slice(0, 8)) ||
        originMain.startsWith(commit.slice(0, 8));
      ck(settled && onMain && branch === "main",
        `${svc} at canonical main`,
        `${status} ${branch}@${commit.slice(0, 8)} (want ${originMain.slice(0, 8)})`,
        status === "FAILED" ? `deploy failed — check: railway logs --service ${svc}`
          : `redeploy: railway redeploy --service ${svc} --yes`);
    } catch {
      ck(false, `${svc} deployment readable`, "could not parse railway output", "check railway CLI");
    }
  }

  // ── Runtime modes ───────────────────────────────────────────────────
  for (const svc of ["yt-pipeline", "wc-pipeline"]) {
    const kv = sh("railway", ["variables", "--service", svc, "--kv"]);
    if (!kv) { ck(false, `${svc} variables readable`, "railway CLI unavailable", "check railway link"); continue; }
    const get = (k: string): string =>
      kv.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1) ?? "<unset>";
    ck(get("PIPELINE_MODE") === "auth_check", `${svc} PIPELINE_MODE=auth_check`,
      get("PIPELINE_MODE"), `railway variables set PIPELINE_MODE=auth_check --service ${svc} --skip-deploys`);
    ck(get("DISABLE_ELEVEN") === "true", `${svc} DISABLE_ELEVEN=true`,
      get("DISABLE_ELEVEN"), `only RUN may flip this; relock immediately after`);
    ck(get("SCHEDULER_ENABLED") !== "true", `${svc} scheduler not armed`,
      get("SCHEDULER_ENABLED"), `railway variables set SCHEDULER_ENABLED=false --service ${svc} --skip-deploys`);
    ck(get("PRODUCTION_MODE") !== "unattended", `${svc} not in unattended mode`,
      get("PRODUCTION_MODE"), `unattended production must be off during a pilot`);
  }
  for (const svc of ["monitor-ai-doom", "monitor-wc"]) {
    const kv = sh("railway", ["variables", "--service", svc, "--kv"]);
    if (!kv) continue;
    const get = (k: string): string =>
      kv.split("\n").find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1) ?? "<unset>";
    ck(get("MONITOR_MODE") === "health_only", `${svc} MONITOR_MODE=health_only`, get("MONITOR_MODE"),
      `railway variables set MONITOR_MODE=health_only --service ${svc} --skip-deploys`);
    ck(get("MONITOR_AI_ENABLED") !== "true", `${svc} monitor AI disabled`, get("MONITOR_AI_ENABLED"));
    ck(get("SCHEDULER_ENABLED") !== "true", `${svc} scheduler not armed`, get("SCHEDULER_ENABLED"),
      `the scheduler must stay disabled until unattended production is intended`);
  }

  // ── Local runtime flags ─────────────────────────────────────────────
  ck(!isSchedulerEnabled(), "local SCHEDULER_ENABLED not set",
    process.env.SCHEDULER_ENABLED ?? "<unset>");
  ck(!isUnattendedMode(), "local PRODUCTION_MODE not unattended",
    process.env.PRODUCTION_MODE ?? "<unset>");

  // ── Database state ──────────────────────────────────────────────────
  const snap = await takeSnapshot();
  const cycleRows = snap.tables.find((t) => t.table === "production_cycle")?.rows ?? -1;
  ck(cycleRows === 0, "production_cycle empty (no unattended work owed)", `${cycleRows} row(s)`,
    "npx tsx scripts/production-cycle-control.ts --check --channel <ch>");

  ck(snap.activeRuns.length === 0, "no in-flight pipeline run",
    `${snap.activeRuns.length}`, "investigate before starting anything");
  ck(snap.unresolvedIntents.length === 0, "no unresolved upload intent",
    `${snap.unresolvedIntents.length}`,
    "reconcile before any upload — see docs/YOUTUBE_PRODUCTION_OPERATIONS.md");
  ck(snap.futureScheduled.length === 0, "no future scheduled video (no publication collision)",
    `${snap.futureScheduled.length}`);
  const reserved = snap.budgets.filter((b) => b.reserved !== 0);
  ck(reserved.length === 0, "zero narration reservations",
    reserved.length ? JSON.stringify(reserved) : "all 0",
    "a stuck reservation blocks the budget window");
  const tripped = snap.breakers.filter((b) => b.tripped);
  ck(tripped.length === 0, "no circuit breaker tripped",
    tripped.length ? tripped.map((b) => b.channel).join(",") : "all clear");

  // ── Pilots ──────────────────────────────────────────────────────────
  for (const p of snap.pilots) {
    ck(p.status === "PREPARED" || p.status === "ACTIVE", `pilot ${p.pilotId} in a runnable state`,
      `${p.status} ${p.successCount}/${p.maxSuccesses}`);
    ck(p.successCount === p.successVideoIds.length,
      `pilot ${p.pilotId} success accounting consistent`,
      `${p.successCount} claimed vs ${p.successVideoIds.length} recorded`);
  }

  // ── Wet Circuit candidate + feasibility freshness ───────────────────
  const cand = await prisma.$queryRawUnsafe<{ status: string; youtubeId: string | null }[]>(
    `SELECT "status"::text AS status, "youtubeId" FROM "wc_video" WHERE "id" = $1`, WC_CANDIDATE);
  ck(cand[0]?.status === "QUALITY_FAILED", "WC canary candidate at its armed resting state",
    cand[0]?.status ?? "MISSING",
    "ARM requires QUALITY_FAILED; any other status means the candidate moved");
  ck(!cand[0]?.youtubeId, "WC canary candidate never uploaded", cand[0]?.youtubeId ?? "none");

  let feasAgeH = Infinity;
  let feasResult = "NONE";
  try {
    const v = JSON.parse(readFileSync(VERIFICATION_PATH, "utf8")) as
      { verifiedAt: string; result: string; candidateId: string };
    feasAgeH = (Date.now() - Date.parse(v.verifiedAt)) / 3600000;
    feasResult = v.candidateId === WC_CANDIDATE ? v.result : "WRONG_CANDIDATE";
  } catch { /* no record */ }
  ck(feasResult === "PASS" && feasAgeH <= FEASIBILITY_MAX_AGE_H,
    "WC feasibility verification fresh",
    feasResult === "NONE" ? "no record" : `${feasResult}, ${feasAgeH.toFixed(1)}h old (max ${FEASIBILITY_MAX_AGE_H}h)`,
    "DISABLE_ELEVEN=true npx tsx scripts/wc-feasibility-verify.ts   (required before ARM)");

  // ── Report ──────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.label.padEnd(46)} ${c.detail}`);
  }
  console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log("\n  BLOCKERS:");
    for (const c of failed) {
      console.log(`    ✗ ${c.label}: ${c.detail}`);
      if (c.remedy) console.log(`      → ${c.remedy}`);
    }
  }
  console.log(`\n  MONDAY_PREFLIGHT = ${failed.length === 0 ? "PASS" : "FAIL"}\n`);
  if (failed.length) process.exitCode = 1;
}

const isDirectRun =
  process.argv[1]?.endsWith("monday-preflight.ts") ||
  process.argv[1]?.endsWith("monday-preflight.js");

if (isDirectRun) {
  main().catch((e) => { console.error("PREFLIGHT FAILED:", e); process.exitCode = 1; })
    .finally(() => disconnect());
}
