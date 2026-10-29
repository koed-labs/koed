import { describe, expect, it } from "vitest";
import { codexReasoningEffort } from "./managed-conversation-service.js";

describe("Chief of Staff reasoning effort", () => {
  it("answers a Chief of Staff conversation at a low effort unless one was chosen", () => {
    expect(
      codexReasoningEffort({ reasoningEffort: null, isProjectHq: true })
    ).toBe("low");
    expect(
      codexReasoningEffort({ reasoningEffort: "high", isProjectHq: true })
    ).toBe("high");
    expect(
      codexReasoningEffort({ reasoningEffort: null, isProjectHq: false })
    ).toBeNull();
  });
});
