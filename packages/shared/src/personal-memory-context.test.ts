import { describe, expect, it } from "vitest";

import { personalMemoryTurnContextSchema } from "./personal-memory-context.js";

const base = {
  schemaVersion: 1,
  status: "available",
  attributionNonce: "11111111-1111-4111-8111-111111111111",
  searchDomain: "global",
  projectId: null,
  evidence: []
};

describe("Personal Memory turn context", () => {
  it("defaults persisted evidence to Personal visibility", () => {
    expect(
      personalMemoryTurnContextSchema.parse({
        ...base,
        evidence: [
          {
            nodeId: "node-1",
            summaryText: "Remembered detail",
            citation: { nodeId: "node-1" }
          }
        ]
      }).evidence[0]?.visibility
    ).toBe("personal");
  });

  it("requires a Workspace for Team evidence and forbids evidence on skip", () => {
    expect(
      personalMemoryTurnContextSchema.safeParse({
        ...base,
        evidence: [
          {
            nodeId: "team-node",
            summaryText: "Shared detail",
            visibility: "team",
            citation: { nodeId: "team-node" }
          }
        ]
      }).success
    ).toBe(false);
    expect(
      personalMemoryTurnContextSchema.safeParse({
        ...base,
        status: "skipped",
        evidence: [
          {
            nodeId: "node-1",
            summaryText: "Remembered detail",
            citation: { nodeId: "node-1" }
          }
        ]
      }).success
    ).toBe(false);
  });
});
