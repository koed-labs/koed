import { expect, it } from "vitest";
import { pullRequestReviewOutput } from "./pull-request-review-output.js";
it("accepts explicit findings only at inspected diff coordinates", () => {
  const diff =
    "diff --git a/src/code.ts b/src/code.ts\n--- a/src/code.ts\n+++ b/src/code.ts\n@@ -10 +10 @@\n-old\n+new";
  const text =
    "Summary.\n```json\n" +
    JSON.stringify({
      koedReview: {
        body: "Check this change.",
        findings: [
          {
            path: "src/code.ts",
            line: 10,
            side: "RIGHT",
            body: "Valid location."
          },
          { path: "src/code.ts", line: 99, side: "RIGHT", body: "Not in diff." }
        ]
      }
    }) +
    "\n```";
  expect(pullRequestReviewOutput(text, diff)).toEqual({
    body: "Check this change.",
    findings: [
      { path: "src/code.ts", line: 10, side: "RIGHT", body: "Valid location." }
    ]
  });
  expect(pullRequestReviewOutput("ordinary prose", diff)).toEqual({
    body: "ordinary prose",
    findings: []
  });
});
it("keeps generated draft size bounded and excludes Koed's private attribution footer", () => {
  const result = pullRequestReviewOutput(
    "Review.\n<!-- koed-memory-attribution:v1:private -->",
    ""
  );
  expect(result.body).toBe("Review.");
  const long = pullRequestReviewOutput("x".repeat(80_000), "");
  expect(long.body.length).toBeLessThanOrEqual(65_536);
  expect(long.body).toContain("complete reply remains in the private chat");
});
