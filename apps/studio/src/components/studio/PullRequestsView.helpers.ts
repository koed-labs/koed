export type PullRequestFilter = "all" | "open" | "draft" | "merged" | "closed";

export const MIN_LIST_WIDTH = 280;
export const MAX_LIST_WIDTH = 620;

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
