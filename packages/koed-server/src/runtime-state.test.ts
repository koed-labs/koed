import { describe, expect, it } from "vitest";
import { isRuntimeGenerationState } from "./runtime-state.js";

const validState = () => ({
  schemaVersion: 1,
  generationId: "a".repeat(64),
  pid: 1234,
  processIdentity: "host:linux:boot-id:process-start",
  startedAt: "2026-10-05T00:00:00.000Z",
  owner: { kind: "desktop", installationId: "koed-desktop" },
  pinToken: "b".repeat(64)
});

describe("runtime generation state", () => {
  it("accepts exact generation pin state", () => {
    expect(isRuntimeGenerationState(validState())).toBe(true);
  });

  it.each([
    { ...validState(), unknown: true },
    { ...validState(), generationId: "not-a-digest" },
    { ...validState(), pid: 0 },
    { ...validState(), processIdentity: "" },
    { ...validState(), startedAt: "invalid" },
    { ...validState(), owner: { kind: "public", installationId: "spoof" } },
    { ...validState(), pinToken: "short" }
  ])("rejects malformed or unbound pin state %#", (state) => {
    expect(isRuntimeGenerationState(state)).toBe(false);
  });
});
