import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node's native TypeScript runner needs the source extension.
import { teamSummaryReplyForTurn } from "./team-agent-summary-state.ts";

test("summary editor receives only the assistant response paired with its prompt", () => {
  const messages = [
    { id: "old-user", role: "user" as const, content: "Earlier work" },
    { id: "old-reply", role: "assistant" as const, content: "Earlier answer" },
    { id: "summary-user", role: "user" as const, content: "Draft summary" },
    {
      id: "summary-part-1",
      role: "assistant" as const,
      content: "Completed the review."
    },
    {
      id: "summary-part-2",
      role: "assistant" as const,
      content: "Found two useful results."
    },
    { id: "later-user", role: "user" as const, content: "Another question" },
    {
      id: "later-reply",
      role: "assistant" as const,
      content: "Unrelated answer"
    }
  ];
  assert.equal(
    teamSummaryReplyForTurn(messages, "summary-user"),
    "Completed the review.\n\nFound two useful results."
  );
  assert.equal(teamSummaryReplyForTurn(messages, "missing-user"), null);
});
