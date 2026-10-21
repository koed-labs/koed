import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { projectSharePolicyReviewHtml } from "./project-share-policy-native-review.js";

it("renders all 100 source labels in an isolated, scrollable Native review", () => {
  const reviewSources = Array.from({ length: 100 }, (_, index) => ({
    sessionId: randomUUID(),
    reviewLabel: `Chapter <${index}> & notes`,
    eligible: index % 2 === 0
  }));
  const html = projectSharePolicyReviewHtml(
    {
      version: 1,
      title: "Share summaries?",
      description: "Check the list.",
      consequence: "Each source still needs separate consent.",
      confirmLabel: "Share eligible summaries",
      details: [{ label: "Project", value: "Exam" }],
      reviewSources
    },
    "https://koed.invalid/project-policy-approve/nonce"
  );
  expect(html).toContain("Captured Sessions (100)");
  expect(html).toContain("overflow:auto");
  expect(html).toContain("default-src 'none'");
  expect(html).toContain("Chapter &lt;0&gt; &amp; notes");
  expect(html).toContain("Chapter &lt;99&gt; &amp; notes");
  expect(html).not.toContain("Chapter <99>");
  expect(html).not.toContain(reviewSources[0]!.sessionId);
  expect((html.match(/class="number"/g) ?? []).length).toBe(100);
});
