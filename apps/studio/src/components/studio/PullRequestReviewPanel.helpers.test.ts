import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node's native TypeScript runner needs the source extension.
import { pullRequestReviewMatchesLatest } from "./PullRequestReviewPanel.helpers.ts";

test("review publication stays current only while both fenced SHAs match", () => {
  const expected = { baseSha: "base-1", headSha: "head-1" };
  assert.equal(pullRequestReviewMatchesLatest(expected, expected), true);
  assert.equal(
    pullRequestReviewMatchesLatest(expected, {
      ...expected,
      headSha: "head-2"
    }),
    false
  );
  assert.equal(
    pullRequestReviewMatchesLatest(expected, {
      ...expected,
      baseSha: "base-2"
    }),
    false
  );
});
