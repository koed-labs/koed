import { describe, expect, it } from "vitest";
import {
  managedConversationSettingsKey,
  parseManagedConversationSettings
} from "./ai-client-contract.js";

describe("Conversation settings boundary", () => {
  const settings = {
    model: "gpt-test",
    reasoningEffort: null,
    permissionMode: "supervised"
  };
  it("rejects owner changes, missing permissions, and malformed settings", () => {
    for (const value of [
      null,
      [],
      { ...settings, provider: "claude" },
      { model: "gpt-test", reasoningEffort: null },
      { ...settings, permissionMode: "bypass" },
      { ...settings, reasoningEffort: " " },
      { ...settings, model: "x".repeat(513) }
    ]) {
      expect(() => parseManagedConversationSettings(value)).toThrow(TypeError);
    }
  });
  it("compares all turn settings independently of object property order", () => {
    const parsed = parseManagedConversationSettings(settings);
    expect(managedConversationSettingsKey(parsed)).toBe(
      managedConversationSettingsKey({
        permissionMode: parsed.permissionMode,
        reasoningEffort: null,
        model: parsed.model
      })
    );
    expect(managedConversationSettingsKey(parsed)).not.toBe(
      managedConversationSettingsKey({
        ...parsed,
        permissionMode: "full_access"
      })
    );
  });
});
