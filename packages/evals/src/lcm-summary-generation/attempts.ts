const sleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

export const runWithAttempts = async <T>(
  options: {
    maxAttempts: number;
    retryDelayMs: number;
    timeoutMs: number;
  },
  run: (input: { attempt: number; timeoutMs: number }) => Promise<T>
): Promise<T> => {
  const maxAttempts = Math.max(1, options.maxAttempts);
  const retryDelayMs = Math.max(0, options.retryDelayMs);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await run({
        attempt,
        timeoutMs: options.timeoutMs * attempt
      });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && retryDelayMs > 0) {
        await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  throw lastError;
};
