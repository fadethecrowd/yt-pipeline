// Entry point — re-exports for convenience, main logic in pipeline.ts
export { runPipeline } from "./pipeline";

import { runPipeline } from "./pipeline";
import { disconnect } from "@yt-pipeline/pipeline-core";

// ── Hard timeout: kill the process if pipeline exceeds 30 minutes ────────
const PIPELINE_TIMEOUT_MS = 30 * 60 * 1000;
const killTimer = setTimeout(() => {
  console.error(`[wc:pipeline] HARD TIMEOUT: pipeline exceeded ${PIPELINE_TIMEOUT_MS / 60000} minutes — forcing exit`);
  process.exit(1);
}, PIPELINE_TIMEOUT_MS);
killTimer.unref(); // don't keep process alive just for the timer

// ── SIGTERM handler for Railway container restarts ───────────────────────
process.on("SIGTERM", async () => {
  console.log("[wc:pipeline] Received SIGTERM — shutting down");
  await disconnect();
  process.exit(0);
});

// ── Run pipeline ─────────────────────────────────────────────────────────
runPipeline()
  .then(async () => {
    await disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[wc:pipeline] Fatal:", err);
    await disconnect();
    process.exit(1);
  });
