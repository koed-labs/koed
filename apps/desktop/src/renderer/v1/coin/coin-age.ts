/** A coin's finish: gleaming when its Conversation was active today,
 * patinated after 30 days untouched. kin-engine leaves this choice to the
 * app (its suggested threshold is also 30 days). */
export type CoinAge = "fresh" | "current" | "aged";

export const AGED_AFTER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function coinAge(latestAt: string, now: Date): CoinAge {
  const at = Date.parse(latestAt);
  if (!Number.isFinite(at)) return "current";
  const then = new Date(at);
  if (
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate()
  )
    return "fresh";
  return now.getTime() - at >= AGED_AFTER_DAYS * DAY_MS ? "aged" : "current";
}
