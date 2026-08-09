// Entry point — re-exports for convenience, main logic in pipeline.ts
export { runPipeline } from "./pipeline";

import { runPipeline } from "./pipeline";
import {
  disconnect,
  verifyChannel,
  CHANNELS,
  RunSummary,
  PIPELINE_HARD_TIMEOUT_MS,
} from "@yt-pipeline/pipeline-core";

// ── Hard timeout: kill the process if pipeline exceeds 30 minutes ────────
const PIPELINE_TIMEOUT_MS = PIPELINE_HARD_TIMEOUT_MS;
const killTimer = setTimeout(() => {
  console.error(`[pipeline] HARD TIMEOUT: pipeline exceeded ${PIPELINE_TIMEOUT_MS / 60000} minutes — forcing exit`);
  process.exit(1);
}, PIPELINE_TIMEOUT_MS);
killTimer.unref(); // don't keep process alive just for the timer

// ── SIGTERM handler for Railway container restarts ───────────────────────
process.on("SIGTERM", async () => {
  console.log("[pipeline] Received SIGTERM — shutting down");
  await disconnect();
  process.exit(0);
});

// ── Run pipeline ─────────────────────────────────────────────────────────
const runMode = process.env.DISABLE_ELEVEN === "true" ? "DRY_RUN" : "LIVE";
const summary = new RunSummary("ai-doom-scroll", runMode);

verifyChannel(CHANNELS["ai-doom-scroll"], "pipeline")
  .then(async () => {
    summary.setVerifiedChannel(
      CHANNELS["ai-doom-scroll"].title,
      CHANNELS["ai-doom-scroll"].id,
    );
    if (process.env.PIPELINE_MODE === "auth_check") {
      console.log(
        "[pipeline] PIPELINE_MODE=auth_check — skipping runPipeline(), exiting 0",
      );
      await summary.persist();
      await disconnect();
      process.exit(0);
    }
    return runPipeline(summary);
  })
  .then(async () => {
    await summary.persist();
    await disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[pipeline] Fatal:", err);
    if (!summary.hasVerifiedChannel()) {
      summary.markCritical(
        err instanceof Error ? err.message : String(err),
      );
    } else {
      summary.markFailed("__top_level__", err);
    }
    await summary.persist();
    await disconnect();
    process.exit(1);
  });
