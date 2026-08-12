import { describe, expect, it } from "vitest";

import {
  assertAiClientDriverId,
  assertAiClientInstanceId,
  defaultAiClientInstanceId,
  isSupportedAiClientDriverId
} from "./ai-client-contract.js";

describe("AI Client identifiers", () => {
  it("accepts open identifiers while recognizing built-in drivers", () => {
    expect(assertAiClientDriverId("future-client.v2")).toBe("future-client.v2");
    expect(assertAiClientInstanceId("future-client.work-account")).toBe(
      "future-client.work-account"
    );
    expect(isSupportedAiClientDriverId("future-client")).toBe(false);
    expect(isSupportedAiClientDriverId("claude")).toBe(true);
    expect(defaultAiClientInstanceId("claude")).toBe("claude.default");
  });

  it.each(["", "../claude", "Claude", "claude/default", "claude default"])(
    "rejects unsafe identifier %s",
    (value) => {
      expect(() => assertAiClientDriverId(value)).toThrow();
      expect(() => assertAiClientInstanceId(value)).toThrow();
    }
  );
});
