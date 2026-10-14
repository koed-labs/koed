import { describe, expect, it } from "vitest";
import { homeItemSchema, homeSourceSchema } from "./home.js";

describe("Home native Agent activity contract", () => {
  it("accepts source-specific native reminder identities and Agent work items", () => {
    const source = homeSourceSchema.parse("native_agent_activity");
    expect(source).toBe("native_agent_activity");
    expect(
      homeItemSchema.parse({
        sourceEventId: "delivery:8c2d53c4-23ef-4a1d-8f1a-2c0c7e71357b",
        source,
        sourceId: "8c2d53c4-23ef-4a1d-8f1a-2c0c7e71357b",
        sourceRevision: "n43d3be0c4c1bb3c114c2dc0e33e9ddaa",
        kind: "agent_work",
        state: "ongoing",
        title: "Home Agent is working",
        summary: "Native Agent work is in progress.",
        updatedAt: "2026-10-14T12:00:00.000Z",
        destination: {
          kind: "execution",
          executionId: "e619352e-5c4b-4bb2-9a9b-39ee26b69c2a"
        }
      })
    ).toMatchObject({ source, kind: "agent_work", state: "ongoing" });
  });
});
