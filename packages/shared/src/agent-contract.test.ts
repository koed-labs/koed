import { describe, expect, it } from "vitest";
import { agentLookSchema } from "./agent-contract.js";

describe("Agent look metadata", () => {
  it("accepts empty and bounded JSON metadata", () => {
    expect(agentLookSchema.safeParse({}).success).toBe(true);
    expect(
      agentLookSchema.safeParse({ shape: "round", color: "blue", top: null })
        .success
    ).toBe(true);
  });
  it("rejects non-JSON values and cycles without throwing", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [
      cycle,
      { x: 1n },
      { x: undefined },
      { x: new Date() },
      { x: Number.NaN },
      { x: 1e308 },
      { x: 1e-308 },
      { x: "bad\u0000text" },
      { "bad\u0000key": "x" }
    ])
      expect(agentLookSchema.safeParse(value).success).toBe(false);
  });
  it("reserves JSONB serialization overhead below the database byte cap", () => {
    expect(agentLookSchema.safeParse({ color: "x".repeat(3100) }).success).toBe(
      false
    );
    expect(
      agentLookSchema.safeParse({ one: "x".repeat(500), two: "y".repeat(500) })
        .success
    ).toBe(true);
  });
});
