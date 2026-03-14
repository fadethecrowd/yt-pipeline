// Entry point — re-exports for convenience, main logic in pipeline.ts
export { runPipeline } from "./pipeline";

import { runPipeline } from "./pipeline";

runPipeline().catch((err) => {
  console.error("[pipeline] Fatal:", err);
  process.exit(1);
});
