import { describe, expect, it } from "vitest";
import {
  boundPullRequestListWidth,
  matchesPullRequestFilter
} from "./PullRequestsView.helpers";

function pullRequest(
  overrides: Record<string, unknown> = {}
): Parameters<typeof matchesPullRequestFilter>[0] {
  return {
    number: 1,
    title: "Example pull request",
    state: "open",
    draft: false,
    merged: false,
    author: "operator",
    requestedReviewers: [],
    headSha: "head",
    baseSha: "base",
    headBranch: "feature/example",
    baseBranch: "main",
    updatedAt: "2026-09-22T00:00:00.000Z",
    url: "https://github.com/example/repo/pull/1",
    ...overrides
  } as Parameters<typeof matchesPullRequestFilter>[0];
}

describe("pull request list helpers", () => {
  it("keeps status filters exclusive", () => {
    expect(matchesPullRequestFilter(pullRequest(), "all")).toBe(true);
    expect(matchesPullRequestFilter(pullRequest(), "open")).toBe(true);
    expect(matchesPullRequestFilter(pullRequest({ draft: true }), "open")).toBe(
      false
    );
    expect(
      matchesPullRequestFilter(pullRequest({ draft: true }), "draft")
    ).toBe(true);
    expect(
      matchesPullRequestFilter(
        pullRequest({ state: "closed", draft: true }),
        "draft"
      )
    ).toBe(false);
    expect(
      matchesPullRequestFilter(
        pullRequest({ state: "closed", merged: true }),
        "merged"
      )
    ).toBe(true);
    expect(
      matchesPullRequestFilter(pullRequest({ state: "closed" }), "closed")
    ).toBe(true);
    expect(
      matchesPullRequestFilter(
        pullRequest({ state: "closed", merged: true }),
        "closed"
      )
    ).toBe(false);
  });

  it("bounds list width to the available detail layout", () => {
    expect(boundPullRequestListWidth(100)).toBe(280);
    expect(boundPullRequestListWidth(900)).toBe(620);
    expect(boundPullRequestListWidth(500, 700)).toBe(420);
    expect(boundPullRequestListWidth(500, 500)).toBe(280);
    expect(boundPullRequestListWidth(Number.NaN)).toBe(280);
  });
});
