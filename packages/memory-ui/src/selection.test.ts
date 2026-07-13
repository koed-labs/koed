import { describe, expect, it } from "vitest";
import { sessionSelectionId, threadSelectionKey } from "./selection.js";

describe("shared memory UI selection contracts", () => {
  it("creates the same encoded Project/thread key for every UI consumer", () => {
    expect(
      threadSelectionKey({
        projectId: "/Users/jedd/agents/koed",
        id: "session:1"
      })
    ).toBe("%2FUsers%2Fjedd%2Fagents%2Fkoed:session%3A1");
  });

  it("prefers the stable Captured Session id at the Desktop boundary", () => {
    expect(sessionSelectionId({ id: "thread-1", sessionId: "session-1" })).toBe(
      "session-1"
    );
    expect(sessionSelectionId({ id: "thread-1" })).toBe("thread-1");
  });
});
