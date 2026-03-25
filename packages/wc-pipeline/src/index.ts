// Entry point — re-exports for convenience, main logic in pipeline.ts
export { runPipeline } from "./pipeline";

import { runPipeline } from "./pipeline";
import { disconnect } from "@yt-pipeline/pipeline-core";

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
