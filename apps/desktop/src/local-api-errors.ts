export class LocalApiRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Koed is busy. Try again in ${retryAfterSeconds} seconds.`);
    this.name = "LocalApiRateLimitError";
  }
}

// Electron may prefix an IPC error. Extract only the bounded, display-safe message.
export const localApiRetryDelay = (error: unknown): number | null => {
  if (!(error instanceof Error)) return null;
  const match = error.message.match(
    /Koed is busy\. Try again in ([0-9]{1,5}) seconds\./
  );
  const seconds = match ? Number(match[1]) : 0;
  return seconds >= 1 && seconds <= 86400 ? seconds : null;
};
