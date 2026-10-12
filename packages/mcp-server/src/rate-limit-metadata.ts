export type RateLimitSource = "local" | "remote";

export const rateLimitSourceFrom = (
  value: unknown
): RateLimitSource | undefined =>
  value === "local" || value === "remote" ? value : undefined;

export const retryAfterMsFrom = (
  value: string | null,
  now = Date.now()
): number | undefined => {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  const delay = /^\d+$/.test(text)
    ? Number(text) * 1000
    : Date.parse(text) - now;
  return Number.isFinite(delay) && delay > 0
    ? Math.min(300_000, Math.ceil(delay))
    : undefined;
};
