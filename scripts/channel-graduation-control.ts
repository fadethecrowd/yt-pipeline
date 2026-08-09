/**
 * Channel graduation: private pilot → human acceptance → ordinary production.
 *
 *   npx tsx scripts/channel-graduation-control.ts --channel ai-doom-scroll
 *   npx tsx scripts/channel-graduation-control.ts --channel wet-circuit --verify
 *   ... --complete-pilot --i-have-reviewed-and-approved-all-required-pilot-videos
 *
 * COMPLETED now means one thing only: a human reviewed the required pilot
 * videos and accepted them. It used to be written automatically the moment
 * `successVideoIds` reached `maxSuccesses`, which conflated the authorisation
 * ceiling with acceptance — and for a progressively authorised pilot those are
 * different events. A pilot at 1/1 has merely spent its current ceiling.
 *
 * That auto-completion also made the progression unreachable: a COMPLETED pilot
 * is not ACTIVE, so neither `assertRunnable` nor the cap-advance control would
 * touch it, and video #2 could never happen.
 *
 * CHECK and VERIFY are read-only. COMPLETE-PILOT is one compare-and-set and
 * needs an explicit acknowledgement. LOCAL ONLY — no runtime imports this.
 */
import { VideoStatus } from "@prisma/client";
import { prisma, disconnect, budgetReport, completePilot } from "@yt-pipeline/pipeline-core";
import type { PilotConfig } from "@yt-pipeline/pipeline-core";
import {
  authoritativeQaRecord, decideQaAuthorization, ARTIFACT_CHECK,
} from "../src/stages/finalVideoQa";
import "dotenv/config";

export type ChannelKey = "ai-doom-scroll" | "wet-circuit";

export interface ChannelSpec {
  key: ChannelKey;
  model: "video" | "wcVideo";
  pilotId: string;
  service: string;
  /** Videos a human must review before the pilot may complete. */
  qualificationTarget: number;
}

export const SPECS: Record<ChannelKey, ChannelSpec> = {
  "ai-doom-scroll": {
    key: "ai-doom-scroll", model: "video", pilotId: "ai-doom-private-pilot-1",
    service: "yt-pipeline", qualificationTarget: 3,
  },
  "wet-circuit": {
    key: "wet-circuit", model: "wcVideo", pilotId: "wet-circuit-private-canary-1",
    service: "wc-pipeline", qualificationTarget: 1,
  },
};

// ── Injected surface ──────────────────────────────────────────────────────

export interface VideoRow {
  id: string; youtubeId: string | null; status: string;
  scheduledAt: Date | null; videoPath: string | null;
}
export interface QaRow { id: string; overall: string; checks: unknown; createdAt: Date }

export interface GradDeps {
  readPilot(pilotId: string): Promise<PilotConfig | null>;
  readRow(model: string, id: string): Promise<VideoRow | null>;
  readQa(channel: string, videoId: string): Promise<QaRow[]>;
  fileSha256(path: string): Promise<string | null>;
  unresolvedIntentCount(): Promise<number>;
  totalReserved(): Promise<number>;
  controlledLimits(): Promise<{ key: string; limit: number }[]>;
  activeRunCount(): Promise<number>;
  readVars(service: string): Promise<Record<string, string>>;
  /** ACTIVE → COMPLETED compare-and-set. Rows affected. */
  complete(pilotId: string, expected: number): Promise<number>;
  log(line: string): void;
}

export type Phase =
  | "PILOT_MISSING"
  | "NOT_ACTIVATED"
  | "IN_PROGRESS"
  | "CAP_EXHAUSTED_REVIEW_REQUIRED"
  | "READY_TO_COMPLETE"
  | "COMPLETED"
  | "RECONCILIATION_REQUIRED"
  | "CONFIG_INVALID";

export interface Check { ok: boolean; label: string; detail: string }
export interface GradReport { checks: Check[]; phase: Phase; ready: boolean; pilot: PilotConfig | null }

export async function evaluate(deps: GradDeps, spec: ChannelSpec): Promise<GradReport> {
  const checks: Check[] = [];
  const add = (ok: boolean, label: string, detail: string) => checks.push({ ok, label, detail });

  const pilot = await deps.readPilot(spec.pilotId);
  add(!!pilot, "pilot row exists", pilot ? pilot.pilotId : "MISSING");
  if (!pilot) return { checks, phase: "PILOT_MISSING", ready: false, pilot: null };

  add(pilot.channel === spec.key, "pilot bound to this channel", pilot.channel);

  const target = spec.qualificationTarget;
  add(pilot.successCount === target, `successCount = ${target}`, String(pilot.successCount));
  add(pilot.maxSuccesses === target, `maxSuccesses = ${target}`, String(pilot.maxSuccesses));
  const remaining = Math.max(0, pilot.maxSuccesses - pilot.successCount);
  add(remaining === 0, "authorisation ceiling fully consumed", String(remaining));
  add(pilot.successVideoIds.length === target,
    `exactly ${target} confirmed success video(s)`, String(pilot.successVideoIds.length));

  // Every claimed success must be a real, uploaded, private, QA-passed video.
  for (const id of pilot.successVideoIds) {
    const row = await deps.readRow(spec.model, id);
    if (!row) { add(false, `success ${id.slice(0, 10)}… row exists`, "MISSING"); continue; }
    add(!!row.youtubeId, `success ${id.slice(0, 10)}… has youtubeId`, row.youtubeId ?? "null");
    add(row.status === VideoStatus.UPLOADED, `success ${id.slice(0, 10)}… UPLOADED`, row.status);
    add(row.scheduledAt === null, `success ${id.slice(0, 10)}… unscheduled (private)`,
      row.scheduledAt ? row.scheduledAt.toISOString() : "null");

    const qa = authoritativeQaRecord(await deps.readQa(spec.key, id));
    if (!qa) { add(false, `success ${id.slice(0, 10)}… final QA`, "none"); continue; }
    const sha = row.videoPath ? await deps.fileSha256(row.videoPath) : null;
    if (sha) {
      const d = decideQaAuthorization(qa, sha);
      add(d.ok, `success ${id.slice(0, 10)}… QA PASS bound to artifact`,
        d.ok ? qa.id : `${d.code}`);
    } else {
      // The local render may be long gone; the binding and verdict must still
      // stand, and that limitation is stated rather than silently skipped.
      const bound = Array.isArray(qa.checks)
        ? (qa.checks as { name?: string; value?: unknown }[]).find((c) => c?.name === ARTIFACT_CHECK)
        : undefined;
      const ok = qa.overall === "PASS" && typeof bound?.value === "string"
        && /^[0-9a-f]{64}$/.test(bound.value);
      add(ok, `success ${id.slice(0, 10)}… QA PASS + binding (local file absent)`,
        ok ? qa.id : `overall=${qa.overall}`);
    }
  }

  const unresolved = await deps.unresolvedIntentCount();
  const reserved = await deps.totalReserved();
  const limits = await deps.controlledLimits();
  const active = await deps.activeRunCount();
  const vars = await deps.readVars(spec.service);
  add(unresolved === 0, "no unresolved upload intent", String(unresolved));
  add(reserved === 0, "zero reservations", String(reserved));
  const nz = limits.filter((l) => l.limit !== 0);
  add(nz.length === 0, "controlled budgets locked at 0",
    nz.length ? nz.map((l) => `${l.key}=${l.limit}`).join(" ") : "all 0");
  add(active === 0, "no active pipeline run", String(active));
  add(vars.PIPELINE_MODE === "auth_check", "service locked (auth_check)", vars.PIPELINE_MODE ?? "<unset>");
  add(vars.DISABLE_ELEVEN === "true", "DISABLE_ELEVEN=true", vars.DISABLE_ELEVEN ?? "<unset>");

  // ── Phase ─────────────────────────────────────────────────────────
  let phase: Phase;
  if (pilot.status === "COMPLETED") phase = "COMPLETED";
  else if (unresolved > 0) phase = "RECONCILIATION_REQUIRED";
  else if (pilot.status === "PREPARED" || !pilot.activatedAt) phase = "NOT_ACTIVATED";
  else if (pilot.status !== "ACTIVE") phase = "CONFIG_INVALID";
  else if (pilot.successCount < target) {
    phase = remaining === 0 ? "CAP_EXHAUSTED_REVIEW_REQUIRED" : "IN_PROGRESS";
  } else phase = checks.every((c) => c.ok) ? "READY_TO_COMPLETE" : "CONFIG_INVALID";

  return { checks, phase, ready: phase === "READY_TO_COMPLETE", pilot };
}

export async function doCheck(deps: GradDeps, spec: ChannelSpec): Promise<GradReport> {
  const r = await evaluate(deps, spec);
  deps.log(`── GRADUATION CONTROL — CHECK (${spec.key})`);
  deps.log(`   pilot ${spec.pilotId}  qualification target ${spec.qualificationTarget}`);
  for (const c of r.checks) deps.log(`   ${c.ok ? "✓" : "✗"} ${c.label.padEnd(48)} ${c.detail}`);
  if (r.pilot) {
    deps.log(`   status ${r.pilot.status}  ${r.pilot.successCount}/${r.pilot.maxSuccesses}` +
      `  confirmed ${r.pilot.successVideoIds.length}`);
  }
  deps.log(`   human approval : NOT YET ASSERTED (CHECK never completes)`);
  deps.log(`   PHASE          : ${r.phase}`);
  if (r.phase === "COMPLETED") deps.log(`   → channel is eligible for ordinary production`);
  return r;
}

export interface CompleteResult { completed: boolean; reason: string; rows: number }

export async function doComplete(
  deps: GradDeps, spec: ChannelSpec, approved: boolean,
): Promise<CompleteResult> {
  if (!approved) {
    return { completed: false, rows: 0,
      reason: "--i-have-reviewed-and-approved-all-required-pilot-videos is required" };
  }
  const r = await evaluate(deps, spec);
  if (r.phase !== "READY_TO_COMPLETE") {
    return { completed: false, rows: 0, reason: `phase is ${r.phase}, expected READY_TO_COMPLETE` };
  }
  const rows = await deps.complete(spec.pilotId, spec.qualificationTarget);
  if (rows !== 1) {
    return { completed: false, rows, reason: `completion matched ${rows} rows, expected 1` };
  }
  deps.log(`   ✓ pilot ${spec.pilotId} ACTIVE → COMPLETED`);
  return { completed: true, rows: 1, reason: "completed" };
}

export async function doVerify(deps: GradDeps, spec: ChannelSpec): Promise<GradReport> {
  const r = await evaluate(deps, spec);
  deps.log(`   status ${r.pilot?.status ?? "MISSING"}  phase ${r.phase}`);
  return r;
}

// ── Real dependencies ─────────────────────────────────────────────────────

export function realDeps(): GradDeps {
  const models = prisma as unknown as Record<string, { findUnique(a: unknown): Promise<VideoRow | null> }>;
  const pilots = (prisma as never as { productionPilot: any }).productionPilot;
  return {
    readPilot: (pilotId) => pilots.findUnique({ where: { pilotId } }),
    readRow: (model, id) => models[model]!.findUnique({
      where: { id },
      select: { id: true, youtubeId: true, status: true, scheduledAt: true, videoPath: true },
    }) as never,
    readQa: (channel, videoId) => prisma.qaRecord.findMany({
      where: { videoId, channel, assetKind: "LONGFORM" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }) as never,
    async fileSha256(path) {
      const { existsSync, createReadStream } = await import("node:fs");
      const { createHash } = await import("node:crypto");
      if (!path || !existsSync(path)) return null;
      return new Promise((res, rej) => {
        const h = createHash("sha256");
        createReadStream(path).on("data", (c) => h.update(c)).on("error", rej)
          .on("end", () => res(h.digest("hex")));
      });
    },
    unresolvedIntentCount: () => prisma.uploadIntent.count({
      where: { NOT: { state: { in: ["PERSISTED", "RECONCILED_HISTORICAL_UPLOAD"] } } },
    }),
    async totalReserved() { return (await budgetReport()).totalReserved; },
    async controlledLimits() {
      const rep = await budgetReport();
      return (rep.rows as { channel: string; stage: string; limit: number }[])
        .filter((r) => r.stage !== "DIAGNOSTIC")
        .map((r) => ({ key: `${r.channel}/${r.stage}`, limit: r.limit }));
    },
    activeRunCount: () => prisma.pipelineRun.count({ where: { endTime: null } }),
    async readVars(service) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      const { stdout } = await run("railway",
        ["variables", "--service", service, "--environment", "production", "--kv"],
        { maxBuffer: 8 * 1024 * 1024 });
      const kv: Record<string, string> = {};
      for (const line of stdout.split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return kv;
    },
    complete: (pilotId, expected) => completePilot(pilotId, expected),
    log: (l) => console.log(l),
  };
}

// ── Entry point ───────────────────────────────────────────────────────────

export function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

export function selectedMode(argv: string[]): "COMPLETE" | "VERIFY" | "CHECK" | "AMBIGUOUS" {
  const picked = [argv.includes("--complete-pilot") && "COMPLETE", argv.includes("--verify") && "VERIFY"]
    .filter(Boolean) as string[];
  if (picked.length > 1) return "AMBIGUOUS";
  return (picked[0] as never) ?? "CHECK";
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

async function main(): Promise<void> {
  if (!assertKnownFlags(process.argv, ["--channel", "--complete-pilot", "--i-have-reviewed-and-approved-all-required-pilot-videos", "--verify"])) return;
  const mode = selectedMode(process.argv);
  if (mode === "AMBIGUOUS") { console.error("✗ more than one mode flag"); process.exitCode = 2; return; }
  const channel = argValue(process.argv, "--channel") as ChannelKey | null;
  if (!channel || !SPECS[channel]) {
    console.error("✗ --channel must be ai-doom-scroll or wet-circuit"); process.exitCode = 2; return;
  }
  const spec = SPECS[channel];
  const deps = realDeps();
  if (mode === "CHECK") { await doCheck(deps, spec); return; }
  if (mode === "VERIFY") { await doVerify(deps, spec); return; }
  const r = await doComplete(deps, spec,
    process.argv.includes("--i-have-reviewed-and-approved-all-required-pilot-videos"));
  if (!r.completed) { console.error(`✗ completion refused: ${r.reason}`); process.exitCode = 1; }
}

const isDirectRun =
  process.argv[1]?.endsWith("channel-graduation-control.ts") ||
  process.argv[1]?.endsWith("channel-graduation-control.js");

if (isDirectRun) {
  main().catch((e) => { console.error("CONTROL FAILED:", e); process.exitCode = 1; })
    .finally(() => disconnect());
}
