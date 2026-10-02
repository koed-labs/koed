import { describe, it, expect } from "vitest";
import {
  changedLines,
  validatePullRequestInlineFindings
} from "./pull-request-publication.js";
describe("PR inline publication evidence", () => {
  const patch = "@@ -10,3 +10,3 @@\n unchanged\n-old\n+new\n unchanged";
  it("uses hunk coordinates for both sides", () => {
    const lines = changedLines(patch);
    expect([...lines.LEFT]).toEqual([10, 11, 12]);
    expect([...lines.RIGHT]).toEqual([10, 11, 12]);
  });
  it("rejects guessed lines and truncated patches", () => {
    const finding = {
      path: "src/code.ts",
      line: 11,
      side: "RIGHT" as const,
      body: "Check this."
    };
    expect(
      validatePullRequestInlineFindings(
        [finding],
        [{ path: finding.path, patch }]
      )
    ).toHaveLength(1);
    expect(() =>
      validatePullRequestInlineFindings(
        [{ ...finding, line: 99 }],
        [{ path: finding.path, patch }]
      )
    ).toThrow("PullRequestInlineAnchorInvalid");
    expect(() =>
      validatePullRequestInlineFindings(
        [finding],
        [{ path: finding.path, patch, patchTruncated: true }]
      )
    ).toThrow("PullRequestInlineAnchorInvalid");
    expect(() =>
      validatePullRequestInlineFindings(
        [{ ...finding, path: "../secret" }],
        [{ path: "../secret", patch }]
      )
    ).toThrow("PullRequestInlineAnchorInvalid");
  });
});
