import { expect, it } from "vitest";
import { codexPublicProgress } from "../src/codex-public-progress.js";
it("exports only provider public summary deltas, never raw reasoning", () => {
  const params = {
    threadId: "thread",
    turnId: "turn",
    itemId: "thought",
    summaryIndex: 1,
    delta: "Checking the page"
  };
  expect(
    codexPublicProgress("item/reasoning/summaryTextDelta", params)
  ).toMatchObject({
    id: "thought:summary:1",
    detail: "Checking the page",
    delta: true
  });
  expect(codexPublicProgress("item/reasoning/textDelta", params)).toBeNull();
  expect(
    codexPublicProgress("item/started", {
      ...params,
      item: { id: "thought", type: "reasoning", content: ["secret"] }
    })
  ).toBeNull();
  expect(
    codexPublicProgress("item/reasoning/summaryTextDelta", {
      ...params,
      turnId: null
    })
  ).toBeNull();
  expect(
    codexPublicProgress("item/reasoning/summaryTextDelta", {
      ...params,
      delta: "x".repeat(3000)
    })?.detail
  ).toHaveLength(2000);
});
it("reports tool phases without exposing arguments, commands or output", () => {
  const params = {
    threadId: "thread",
    turnId: "turn",
    item: {
      id: "tool",
      type: "commandExecution",
      command: "secret",
      aggregatedOutput: "private"
    }
  };
  expect(codexPublicProgress("item/started", params)).toEqual({
    threadId: "thread",
    turnId: "turn",
    id: "tool",
    title: "Running a command"
  });
  expect(codexPublicProgress("item/completed", params)?.title).toBe(
    "Command finished"
  );
  expect(
    codexPublicProgress("item/completed", {
      ...params,
      item: { id: "tool", type: "unknown" }
    })
  ).toBeNull();
});
