/**
 * End-to-end pipeline test runner.
 *
 * Runs the full 8-stage pipeline against live services (DB, Claude, ElevenLabs,
 * Pexels, YouTube). Requires all env vars to be set.
 *
 * Usage:  npx tsx test-pipeline.ts
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ── Helpers ──────────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(0);
  return `${m}m${s}s`;
}

interface StageReport {
  name: string;
  status: "pass" | "fail" | "skipped";
  durationMs: number;
  error?: string;
}

const STAGE_NAMES = [
  "topicDiscovery",
  "scriptGenerator",
  "qualityGate",
  "voiceover",
  "videoAssembly",
  "seoGenerator",
  "youtubeUpload",
  "notify",
];

// ── Intercept pipeline logs to extract stage timings ─────────────────────

const reports: StageReport[] = [];
let currentStage: string | null = null;
let currentStageStart = 0;
let pipelineFailed = false;

const origLog = console.log;
const origError = console.error;

function interceptLog(method: "log" | "error", args: any[]) {
  const msg = args.map(String).join(" ");

  // Stage started
  const startMatch = msg.match(/\[pipeline\] ▸ (\w+) started at/);
  if (startMatch) {
    currentStage = startMatch[1];
    currentStageStart = Date.now();
  }

  // Stage succeeded
  const successMatch = msg.match(/\[pipeline\] ✓ (\w+) ended at/);
  if (successMatch) {
    reports.push({
      name: successMatch[1],
      status: "pass",
      durationMs: Date.now() - currentStageStart,
    });
    currentStage = null;
  }

  // Stage threw
  const throwMatch = msg.match(/\[pipeline\] ✗ (\w+) threw: (.+)/);
  if (throwMatch) {
    reports.push({
      name: throwMatch[1],
      status: "fail",
      durationMs: Date.now() - currentStageStart,
      error: throwMatch[2],
    });
    pipelineFailed = true;
    currentStage = null;
  }

  // Stage rejected
  const rejectMatch = msg.match(/\[pipeline\] ✗ (\w+) rejected: (.+)/);
  if (rejectMatch) {
    reports.push({
      name: rejectMatch[1],
      status: "fail",
      durationMs: Date.now() - currentStageStart,
      error: rejectMatch[2],
    });
    pipelineFailed = true;
    currentStage = null;
  }

  // No viable topics
  if (msg.includes("No viable topics")) {
    pipelineFailed = true;
  }
}

console.log = (...args: any[]) => {
  interceptLog("log", args);
  origLog(...args);
};
console.error = (...args: any[]) => {
  interceptLog("error", args);
  origError(...args);
};

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  origLog("╔════════════════════════════════════════════════════╗");
  origLog("║        yt-pipeline  end-to-end test runner        ║");
  origLog("╚════════════════════════════════════════════════════╝");
  origLog();

  const runStart = Date.now();

  // ── Pre-flight checks ────────────────────────────────────────────────

  origLog("[test] Pre-flight: checking database connection...");
  try {
    await prisma.$queryRaw`SELECT 1`;
    origLog("[test] Pre-flight: database OK");
  } catch (err) {
    origError("[test] Pre-flight: database connection failed:", err);
    process.exit(1);
  }

  const topicsBefore = await prisma.topic.count();
  const videosBefore = await prisma.video.count();
  origLog(
    `[test] Pre-flight: ${topicsBefore} topics, ${videosBefore} videos in DB`
  );
  origLog();

  // ── Run the pipeline ─────────────────────────────────────────────────

  origLog("─".repeat(60));

  let pipelineError: string | null = null;
  try {
    const { runPipeline } = await import("./src/pipeline");
    await runPipeline();
  } catch (err: any) {
    pipelineError = err.message ?? String(err);
    origError(`[test] Pipeline threw: ${pipelineError}`);
  }

  origLog("─".repeat(60));

  // ── Fill in skipped stages ──────────────────────────────────────────

  const reportedNames = new Set(reports.map((r) => r.name));
  for (const name of STAGE_NAMES) {
    if (!reportedNames.has(name)) {
      reports.push({ name, status: "skipped", durationMs: 0 });
    }
  }

  // Sort reports to match stage order
  reports.sort(
    (a, b) => STAGE_NAMES.indexOf(a.name) - STAGE_NAMES.indexOf(b.name)
  );

  // ── Post-run DB checks ──────────────────────────────────────────────

  const topicsAfter = await prisma.topic.count();
  const videosAfter = await prisma.video.count();

  const latestVideo = await prisma.video.findFirst({
    orderBy: { createdAt: "desc" },
    include: { topic: true },
  });

  // ── Report ──────────────────────────────────────────────────────────

  // Restore original console methods for clean output
  console.log = origLog;
  console.error = origError;

  console.log();
  console.log("╔════════════════════════════════════════════════════╗");
  console.log("║                   TEST RESULTS                    ║");
  console.log("╠════════════════════════════════════════════════════╣");

  for (const r of reports) {
    const icon =
      r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "○";
    const dur = r.durationMs > 0 ? fmtDuration(r.durationMs) : "-";
    const line = `  ${icon} ${r.name.padEnd(20)} ${r.status.padEnd(8)} ${dur}`;
    console.log("║" + line.padEnd(52) + "║");
    if (r.error) {
      const errLine = `    └─ ${r.error.slice(0, 44)}`;
      console.log("║" + errLine.padEnd(52) + "║");
    }
  }

  console.log("╠════════════════════════════════════════════════════╣");

  const totalDuration = Date.now() - runStart;
  const passCount = reports.filter((r) => r.status === "pass").length;
  const failCount = reports.filter((r) => r.status === "fail").length;
  const skipCount = reports.filter((r) => r.status === "skipped").length;

  console.log(
    `║  Total: ${passCount} passed, ${failCount} failed, ${skipCount} skipped`.padEnd(
      53
    ) + "║"
  );
  console.log(`║  Duration: ${fmtDuration(totalDuration)}`.padEnd(53) + "║");
  console.log("╠════════════════════════════════════════════════════╣");
  console.log("║  DB Summary:".padEnd(53) + "║");
  console.log(
    `║    Topics: ${topicsBefore} → ${topicsAfter} (+${topicsAfter - topicsBefore})`.padEnd(
      53
    ) + "║"
  );
  console.log(
    `║    Videos: ${videosBefore} → ${videosAfter} (+${videosAfter - videosBefore})`.padEnd(
      53
    ) + "║"
  );

  if (latestVideo) {
    console.log(
      `║    Latest: ${latestVideo.status} (${latestVideo.id.slice(0, 12)}…)`.padEnd(
        53
      ) + "║"
    );
    if (latestVideo.topic) {
      const title =
        latestVideo.topic.title.length > 38
          ? latestVideo.topic.title.slice(0, 35) + "…"
          : latestVideo.topic.title;
      console.log(`║    Topic: ${title}`.padEnd(53) + "║");
    }
    if (latestVideo.youtubeId) {
      console.log(
        `║    YouTube: https://youtu.be/${latestVideo.youtubeId}`.padEnd(53) +
          "║"
      );
    }
    if (latestVideo.failReason) {
      const reason =
        latestVideo.failReason.length > 40
          ? latestVideo.failReason.slice(0, 37) + "…"
          : latestVideo.failReason;
      console.log(`║    Fail: ${reason}`.padEnd(53) + "║");
    }
  }

  if (pipelineError) {
    console.log("╠════════════════════════════════════════════════════╣");
    const errTrunc =
      pipelineError.length > 48
        ? pipelineError.slice(0, 45) + "…"
        : pipelineError;
    console.log(`║  Error: ${errTrunc}`.padEnd(53) + "║");
  }

  console.log("╚════════════════════════════════════════════════════╝");

  if (failCount > 0 || pipelineError) {
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("[test] Fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
