export type PullRequestFilter = "all" | "open" | "draft" | "merged" | "closed";

export type PullRequestInboxSnapshotVersion = {
  operationId: string;
  revision: number;
  completedAt: string | null;
};

export const MIN_LIST_WIDTH = 280;
export const MAX_LIST_WIDTH = 620;

export function shouldApplyPullRequestInboxSnapshot(
  previous: PullRequestInboxSnapshotVersion | null,
  next: PullRequestInboxSnapshotVersion
) {
  if (!previous) return true;
  // A completed operation is immutable for inbox purposes. Re-observing it
  // must not reset the user's current page or replace locally loaded cards.
  if (previous.operationId === next.operationId) return false;
  const previousTime = previous.completedAt
    ? Date.parse(previous.completedAt)
    : Number.NaN;
  const nextTime = next.completedAt ? Date.parse(next.completedAt) : Number.NaN;
  return !Number.isFinite(previousTime) || !Number.isFinite(nextTime)
    ? true
    : nextTime >= previousTime;
}

export function mergePartialPullRequestInbox<
  T extends {
    number: number;
    repositoryFullName?: string;
  }
>(current: T[], next: T[]) {
  const key = (item: T) => `${item.repositoryFullName ?? ""}#${item.number}`;
  const merged = new Map(current.map((item) => [key(item), item]));
  for (const item of next) merged.set(key(item), item);
  return [...merged.values()];
}

type PullRequestFilterInput = {
  state: "open" | "closed";
  draft: boolean;
  merged?: boolean;
};

export function matchesPullRequestFilter(
  pullRequest: PullRequestFilterInput,
  filter: PullRequestFilter
) {
  switch (filter) {
    case "open":
      return pullRequest.state === "open" && !pullRequest.draft;
    case "draft":
      return pullRequest.state === "open" && pullRequest.draft;
    case "merged":
      return pullRequest.merged === true;
    case "closed":
      return pullRequest.state === "closed" && !pullRequest.merged;
    case "all":
      return true;
  }
}

export function boundPullRequestListWidth(
  value: number,
  availableWidth = Number.POSITIVE_INFINITY
) {
  const safeValue = Number.isFinite(value) ? value : MIN_LIST_WIDTH;
  const safeAvailableWidth = Number.isFinite(availableWidth)
    ? availableWidth
    : Number.POSITIVE_INFINITY;
  const maxWidth = Math.min(
    MAX_LIST_WIDTH,
    safeAvailableWidth - MIN_LIST_WIDTH
  );
  return Math.round(
    Math.min(
      Math.max(MIN_LIST_WIDTH, safeValue),
      Math.max(MIN_LIST_WIDTH, maxWidth)
    )
  );
}
