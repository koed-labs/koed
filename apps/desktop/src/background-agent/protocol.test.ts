import { describe, expect, it } from "vitest";
import {
  backgroundAgentRequestSchema,
  backgroundAgentResponseSchema
} from "./protocol.js";

describe("background-agent XPC protocol", () => {
  const identity = {
    protocolVersion: 1,
    requestId: "9b7a11fa-bc3a-49d9-a678-324cb0a2d325",
    installationId: "f640991c-0a70-4719-a2fc-e8edc0c240b5",
    homeIdentity: "a".repeat(64)
  };

  it("accepts a read-only hello before the client knows the agent generation", () => {
    expect(
      backgroundAgentRequestSchema.safeParse({ ...identity, kind: "hello" })
        .success
    ).toBe(true);
  });

  it.each(["start", "stop"])(
    "requires a nonnegative expected generation for %s",
    (kind) => {
      expect(
        backgroundAgentRequestSchema.safeParse({
          ...identity,
          kind,
          expectedGeneration: 4,
          explicit: true
        }).success
      ).toBe(true);
      expect(
        backgroundAgentRequestSchema.safeParse({ ...identity, kind }).success
      ).toBe(false);
      expect(
        backgroundAgentRequestSchema.safeParse({
          ...identity,
          kind,
          expectedGeneration: -1,
          explicit: true
        }).success
      ).toBe(false);
    }
  );

  it("rejects unknown commands and extra fields instead of accepting a proxy payload", () => {
    expect(
      backgroundAgentRequestSchema.safeParse({ ...identity, kind: "exec" })
        .success
    ).toBe(false);
    expect(
      backgroundAgentRequestSchema.safeParse({
        ...identity,
        kind: "stop",
        expectedGeneration: 4,
        args: ["arbitrary", "command"]
      }).success
    ).toBe(false);
  });

  it("accepts only bounded lifecycle responses without credentials", () => {
    const response = {
      ...identity,
      kind: "status",
      generation: 4,
      state: "ready",
      ok: true
    };
    expect(backgroundAgentResponseSchema.safeParse(response).success).toBe(
      true
    );
    expect(
      backgroundAgentResponseSchema.safeParse({
        ...response,
        apiToken: "must-not-cross-xpc"
      }).success
    ).toBe(false);
  });
});
