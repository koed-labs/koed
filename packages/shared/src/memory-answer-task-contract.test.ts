import { describe, expect, it } from "vitest";
import {
  MEMORY_ANSWER_TASK_CONTRACT_VERSION,
  isTeamMemoryAnswerTaskCapability
} from "./memory-answer-task-contract.js";

const capability = {
  availability: "available",
  version: MEMORY_ANSWER_TASK_CONTRACT_VERSION,
  supportedScopes: ["personal", "team"]
};

describe("Team Memory Answer task capability", () => {
  it("accepts the current available contract with Team scope", () => {
    expect(isTeamMemoryAnswerTaskCapability(capability)).toBe(true);
    expect(
      isTeamMemoryAnswerTaskCapability({
        ...capability,
        supportedScopes: ["team"]
      })
    ).toBe(true);
  });

  it.each([
    null,
    undefined,
    [],
    "available",
    {},
    { ...capability, availability: "partial" },
    { ...capability, availability: "unavailable" },
    { ...capability, version: MEMORY_ANSWER_TASK_CONTRACT_VERSION - 1 },
    { ...capability, version: MEMORY_ANSWER_TASK_CONTRACT_VERSION + 1 },
    { ...capability, version: String(MEMORY_ANSWER_TASK_CONTRACT_VERSION) },
    { ...capability, supportedScopes: ["personal"] },
    { ...capability, supportedScopes: "team" },
    { ...capability, supportedScopes: undefined }
  ])("rejects unsupported or malformed descriptors: %j", (value) => {
    expect(isTeamMemoryAnswerTaskCapability(value)).toBe(false);
  });
});
