/**
 * Anthropic model identifiers used by the monitor.
 *
 * Reasoning-critical paths (decision engine, lifecycle drafting) stay on
 * Sonnet. Lightweight extract/classify/draft work (Reddit scraping and
 * Reddit post generation) runs on Haiku — same SDK, same prompt API,
 * lower cost and latency.
 *
 * Single source of truth — rotate models here, imports pick up automatically.
 */
export const MODEL_REASONING = "claude-sonnet-4-6";
export const MODEL_LIGHTWEIGHT = "claude-haiku-4-5";
