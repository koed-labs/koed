import type {
  StudioNotificationClassification,
  StudioNotificationIntent
} from "@koed/shared/studio-notifications";

/** Stable identity for one user-visible event, independent of grouped-feed revisions. */
export const studioNotificationDedupeKey = (
  intent: StudioNotificationIntent,
  classification: StudioNotificationClassification
): string => {
  const authority = `${intent.source}\u0000${intent.accountScope}\u0000${intent.backendId ?? ""}`;
  return intent.source === "team_overview"
    ? `${authority}\u0000${intent.sourceEventId}\u0000${intent.messageId ?? ""}\u0000${classification}`
    : `${authority}\u0000${intent.sourceEventId}\u0000${classification}`;
};

export const trimStudioNotificationSeen = (
  seen: Set<string>,
  limit: number
): void => {
  while (seen.size > limit) seen.delete(seen.values().next().value!);
};

export const shouldEmitStudioNotification = (
  seen: Set<string>,
  intent: StudioNotificationIntent,
  classification: StudioNotificationClassification,
  options: { reseed: boolean; occurredAt?: string; after?: string | null }
): boolean => {
  const key = studioNotificationDedupeKey(intent, classification);
  const isNew = !seen.has(key);
  seen.add(key);
  if (!isNew || options.reseed) return false;
  if (options.after && options.occurredAt) {
    const cutoff = Date.parse(options.after);
    const occurredAt = Date.parse(options.occurredAt);
    if (
      Number.isFinite(cutoff) &&
      Number.isFinite(occurredAt) &&
      occurredAt <= cutoff
    )
      return false;
  }
  return true;
};
