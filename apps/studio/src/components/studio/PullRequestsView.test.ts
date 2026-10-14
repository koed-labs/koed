import { describe, expect, it } from "vitest";
import {
  boundPullRequestListWidth,
  matchesPullRequestFilter,
  mergePartialPullRequestInbox,
  shouldApplyPullRequestInboxSnapshot
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

  it("keeps earlier cards when an inbox snapshot is partial", () => {
    const previous = [
      { number: 1, repositoryFullName: "org/one", title: "Earlier" },
      { number: 2, repositoryFullName: "org/two", title: "Selected" }
    ];
    const partial = [
      { number: 1, repositoryFullName: "org/one", title: "Updated" },
      { number: 3, repositoryFullName: "org/three", title: "New" }
    ];

    expect(mergePartialPullRequestInbox(previous, partial)).toEqual([
      { number: 1, repositoryFullName: "org/one", title: "Updated" },
      { number: 2, repositoryFullName: "org/two", title: "Selected" },
      { number: 3, repositoryFullName: "org/three", title: "New" }
    ]);
  });

  it("does not reapply the same snapshot or an older completion", () => {
    const applied = {
      operationId: "operation-new",
      revision: 3,
      completedAt: "2026-10-14T10:00:00.000Z"
    };
    expect(
      shouldApplyPullRequestInboxSnapshot(applied, {
        ...applied,
        revision: 4
      })
    ).toBe(false);
    expect(
      shouldApplyPullRequestInboxSnapshot(applied, {
        operationId: "operation-old",
        revision: 3,
        completedAt: "2026-10-14T09:00:00.000Z"
      })
    ).toBe(false);
    expect(
      shouldApplyPullRequestInboxSnapshot(applied, {
        operationId: "operation-later",
        revision: 2,
        completedAt: "2026-10-14T11:00:00.000Z"
      })
    ).toBe(true);
    expect(
      shouldApplyPullRequestInboxSnapshot(applied, {
        operationId: "operation-same-millisecond",
        revision: 2,
        completedAt: applied.completedAt
      })
    ).toBe(true);
  });
});
