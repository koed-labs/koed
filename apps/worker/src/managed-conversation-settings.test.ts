import { describe, expect, it } from "vitest";
import type { ManagedConversationExecutionRecord } from "@koed/db";
import { assertManagedConversationTurnSettings } from "./managed-conversation-settings.js";

describe("managed turn settings admission", () => {
  const execution = {
    ownerUserId: "owner",
    provider: "codex",
    aiClientInstanceId: "codex.default",
    model: "gpt-test",
    reasoningEffort: "high",
    permissionMode: "supervised"
  } as ManagedConversationExecutionRecord;
  const instance = {
    instanceId: "codex.default",
    driverId: "codex",
    enabled: true,
    configIdentityHash: "identity"
  };
  const snapshot = {
    instanceId: "codex.default",
    installationIdentityHash: "identity",
    authenticationState: "authenticated",
    healthState: "healthy",
    expiresAt: "2099-01-01T00:00:00Z",
    models: [{ id: "gpt-test", supportedReasoningEfforts: ["low", "high"] }],
    capabilities: {
      descriptors: {
        managed_conversation_send: { support: "supported", readiness: "ready" }
      }
    }
  };
  const repository = (changes = {}, instanceChanges = {}) =>
    ({
      listAiClientInstances: async () => [{ ...instance, ...instanceChanges }],
      listCurrentAiClientCapabilitySnapshots: async () => [
        { ...snapshot, ...changes }
      ]
    }) as unknown as Parameters<
      typeof assertManagedConversationTurnSettings
    >[0];
  it("accepts settings only from the execution owner's current catalog", async () => {
    await expect(
      assertManagedConversationTurnSettings(repository(), execution)
    ).resolves.toBeUndefined();
    await expect(
      assertManagedConversationTurnSettings(repository(), {
        ...execution,
        model: "another-model"
      })
    ).rejects.toThrow("unavailable");
    await expect(
      assertManagedConversationTurnSettings(repository(), {
        ...execution,
        reasoningEffort: "max"
      })
    ).rejects.toThrow("unavailable");
  });
  it.each([
    { expiresAt: "2000-01-01T00:00:00Z" },
    { installationIdentityHash: "changed" },
    { authenticationState: "unauthenticated" },
    { models: [] }
  ])("rejects stale capability evidence: %j", async (changes) => {
    await expect(
      assertManagedConversationTurnSettings(repository(changes), execution)
    ).rejects.toThrow("unavailable");
  });
  it("does not substitute another provider or a disabled instance", async () => {
    await expect(
      assertManagedConversationTurnSettings(
        repository({}, { driverId: "claude" }),
        execution
      )
    ).rejects.toThrow("unavailable");
    await expect(
      assertManagedConversationTurnSettings(
        repository({}, { enabled: false }),
        execution
      )
    ).rejects.toThrow("unavailable");
  });
});
