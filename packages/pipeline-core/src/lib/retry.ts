/** Exponential backoff with jitter */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; baseDelayMs?: number; label?: string }
): Promise<T> {
  const { maxRetries, baseDelayMs = 1000, label = "operation" } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;

      const delay = baseDelayMs * 2 ** attempt + Math.random() * 500;
      console.warn(
        `[retry] ${label} attempt ${attempt + 1}/${maxRetries} failed, ` +
          `retrying in ${Math.round(delay)}ms: ${err instanceof Error ? err.message : err}`
      );
      await sleep(delay);
    }
  }

  throw new Error("unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
