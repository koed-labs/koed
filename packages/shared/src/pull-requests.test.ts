import { describe, expect, it } from "vitest";
import {
  pullRequestOperationPayloadSchema,
  pullRequestReviewDraftSchema
} from "./pull-requests.js";

describe("pull request contracts", () => {
  it("accepts typed publication references but rejects arbitrary transport commands", () => {
    expect(
      pullRequestOperationPayloadSchema.safeParse({
        kind: "publish_review",
        reviewId: "2d07bb3b-61df-47c7-a2d5-18e5aeea25e3",
        frozenReviewId: "71a41337-3d8b-4618-ae5a-28e00bb3d916",
        confirmationDigest: "0".repeat(64),
        expectedReviewRevision: 3
      }).success
    ).toBe(true);
    expect(
      pullRequestOperationPayloadSchema.safeParse({
        kind: "push",
        reviewId: "2d07bb3b-61df-47c7-a2d5-18e5aeea25e3",
        pushProposalId: "71a41337-3d8b-4618-ae5a-28e00bb3d916",
        confirmationDigest: "0".repeat(64),
        expectedReviewRevision: 3,
        command: "git push --force"
      }).success
    ).toBe(false);
  });

  it("requires findings to carry bounded inline location and content", () => {
    const base = {
      reviewId: "2d07bb3b-61df-47c7-a2d5-18e5aeea25e3",
      revision: 2,
      origin: "agent",
      executionGeneration: 1,
      accountId: "123",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      event: "REQUEST_CHANGES",
      body: "Please address this.",
      findings: [
        {
          path: "src/app.ts",
          line: 28,
          side: "RIGHT",
          body: "This branch skips authorization."
        }
      ],
      updatedAt: "2026-10-02T10:00:00.000Z"
    };
    expect(pullRequestReviewDraftSchema.safeParse(base).success).toBe(true);
    expect(
      pullRequestReviewDraftSchema.safeParse({
        ...base,
        findings: [{ path: "src/app.ts", line: -1, side: "RIGHT", body: "bad" }]
      }).success
    ).toBe(false);
  });
});

it("parses only one bounded explicit review envelope and keeps ordinary chat readable", async () => {
  const { parsePullRequestReviewOutput } = await import("./pull-requests.js");
  const block =
    "```json\n" +
    JSON.stringify({ koedReview: { body: "Review summary", findings: [] } }) +
    "\n```";
  expect(parsePullRequestReviewOutput("Done.\n" + block)).toEqual({
    body: "Review summary",
    findings: [],
    displayText: "Done."
  });
  expect(parsePullRequestReviewOutput(block + "\n" + block)).toBeNull();
  expect(parsePullRequestReviewOutput("normal chat")).toBeNull();
});
