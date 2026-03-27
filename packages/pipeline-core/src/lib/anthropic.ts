import Anthropic from "@anthropic-ai/sdk";

const MAX_529_RETRIES = 4;
const BASE_DELAY_MS = 2000;

function is529(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIError &&
    err.status === 529
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrapper around anthropic.messages.create that retries on 529 overloaded errors.
 *
 * 529s are transient availability errors and resolve quickly.
 * Retries up to 4 times with exponential backoff (2s → 4s → 8s → 16s).
 * These retries are separate from the stage-level withRetry budget.
 * Non-529 errors are thrown immediately.
 */
export async function createMessage(
  anthropic: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  for (let attempt = 0; attempt <= MAX_529_RETRIES; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      if (!is529(err) || attempt === MAX_529_RETRIES) throw err;

      const delay = BASE_DELAY_MS * 2 ** attempt;
      console.warn(
        `[anthropic] 529 overloaded (attempt ${attempt + 1}/${MAX_529_RETRIES}), retrying in ${delay / 1000}s...`,
      );
      await sleep(delay);
    }
  }

  throw new Error("unreachable");
}
