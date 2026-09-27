import type { HomeViewItem } from "./studio-home";

export type StudioAttentionTier = "blocking" | "waiting" | "fyi";
export type StudioClearedAttention = Record<string, string>;

const TIER_ORDER: StudioAttentionTier[] = ["blocking", "waiting", "fyi"];
const STORAGE_PREFIX = "koed.studio.home.cleared.v1";

export function studioAttentionTier(
  urgency: HomeViewItem["urgency"]
): StudioAttentionTier {
  if (urgency === "now") return "blocking";
  if (urgency === "soon") return "waiting";
  return "fyi";
}

function itemSignature(item: HomeViewItem) {
  return JSON.stringify([item.title, item.detail, item.kicker]);
}

export function studioAttentionStorageKey(scopeKey: string | null) {
  return scopeKey ? `${STORAGE_PREFIX}:${encodeURIComponent(scopeKey)}` : null;
}

export function parseStudioClearedAttention(
  value: unknown
): StudioClearedAttention {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const cleared: StudioClearedAttention = {};
  for (const [id, signature] of Object.entries(value)) {
    if (
      id.length > 300 ||
      typeof signature !== "string" ||
      signature.length > 4000
    )
      continue;
    cleared[id] = signature;
  }
  return cleared;
}

export function studioAttentionIsCleared(
  item: HomeViewItem,
  cleared: StudioClearedAttention
) {
  return cleared[item.id] === itemSignature(item);
}

export function clearStudioAttentionItem(
  item: HomeViewItem,
  cleared: StudioClearedAttention
): StudioClearedAttention {
  return { ...cleared, [item.id]: itemSignature(item) };
}

export function restoreStudioAttentionItem(
  itemId: string,
  cleared: StudioClearedAttention
): StudioClearedAttention {
  const next = { ...cleared };
  delete next[itemId];
  return next;
}

export function partitionStudioAttention<T extends HomeViewItem>(
  items: T[],
  cleared: StudioClearedAttention
) {
  const visible: T[] = [];
  const clearedItems: T[] = [];
  for (const item of items) {
    (studioAttentionIsCleared(item, cleared) ? clearedItems : visible).push(
      item
    );
  }
  const sortByTier = (left: T, right: T) =>
    TIER_ORDER.indexOf(studioAttentionTier(left.urgency)) -
      TIER_ORDER.indexOf(studioAttentionTier(right.urgency)) ||
    items.indexOf(left) - items.indexOf(right);
  return {
    visible: visible.sort(sortByTier),
    cleared: clearedItems.sort(sortByTier)
  };
}
