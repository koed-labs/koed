export type DeckRating = "again" | "good" | "easy";
const goodDays = [1, 3, 7, 14, 30] as const;
const easyDays = [3, 7, 14, 30, 60] as const;

/** Advance by local calendar days so study follows the viewer's day across DST. */
export function nextDeckProgress(
  previous: { box: number; misses: number },
  rating: DeckRating,
  now = new Date()
) {
  if (rating === "again")
    return { box: 0, misses: previous.misses + 1, nextAt: now.toISOString() };
  const box = Math.min(previous.box + 1, 5);
  const interval = (rating === "good" ? goodDays : easyDays)[box - 1]!;
  const next = new Date(now);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + interval);
  return { box, misses: previous.misses, nextAt: next.toISOString() };
}
