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
    permissionMode: "supervised",
    runnerDeviceId: "device-local",
    runnerDeploymentId: "deployment-local"
  } as ManagedConversationExecutionRecord;
  const instance = {
    instanceId: "codex.default",
    hostedInstanceId: "codex.default",
    sourceDeviceCredentialId: null,
    driverId: "codex",
    enabled: true,
    configIdentityHash: "identity"
  };
  const snapshot = {
    instanceId: "codex.default",
    hostedInstanceId: "codex.default",
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
      ],
      listDeviceCredentials: async () => []
    }) as unknown as Parameters<
      typeof assertManagedConversationTurnSettings
    >[0];
  const runner = { deviceId: "device-local", deploymentId: "deployment-local" };
  it("accepts settings only from the execution owner's current catalog", async () => {
    await expect(
      assertManagedConversationTurnSettings(repository(), execution, runner)
    ).resolves.toBeUndefined();
    await expect(
      assertManagedConversationTurnSettings(
        repository(),
        { ...execution, model: "another-model" },
        runner
      )
    ).rejects.toThrow("unavailable");
    await expect(
      assertManagedConversationTurnSettings(
        repository(),
        { ...execution, reasoningEffort: "max" },
        runner
      )
    ).rejects.toThrow("unavailable");
  });
  it.each([
    { expiresAt: "2000-01-01T00:00:00Z" },
    { installationIdentityHash: "changed" },
    { authenticationState: "unauthenticated" },
    { models: [] }
  ])("rejects stale capability evidence: %j", async (changes) => {
    await expect(
      assertManagedConversationTurnSettings(
        repository(changes),
        execution,
        runner
      )
    ).rejects.toThrow("unavailable");
  });
  it("does not substitute another provider or a disabled instance", async () => {
    await expect(
      assertManagedConversationTurnSettings(
        repository({}, { driverId: "claude" }),
        execution,
        runner
      )
    ).rejects.toThrow("unavailable");
    await expect(
      assertManagedConversationTurnSettings(
        repository({}, { enabled: false }),
        execution,
        runner
      )
    ).rejects.toThrow("unavailable");
  });

  it("uses the runner computer to admit the matching duplicate instance", async () => {
    const instances = [
      {
        ...instance,
        hostedInstanceId: "runner.device-a.codex.default",
        sourceDeviceCredentialId: "credential-a",
        enabled: false,
        configIdentityHash: "identity-a"
      },
      {
        ...instance,
        hostedInstanceId: "runner.device-b.codex.default",
        sourceDeviceCredentialId: "credential-b",
        enabled: true,
        configIdentityHash: "identity-b"
      }
    ];
    const snapshots = instances.map((candidate) => ({
      ...snapshot,
      hostedInstanceId: candidate.hostedInstanceId,
      installationIdentityHash: candidate.configIdentityHash,
      capabilities: {
        descriptors: {
          managed_conversation_send: {
            support: "supported",
            readiness: "ready"
          }
        }
      }
    }));
    const credentials = [
      {
        id: "credential-a",
        deviceInstanceId: "device-a",
        metadata: { protocolDeploymentId: "deployment-a" },
        revokedAt: null,
        expiresAt: null
      },
      {
        id: "credential-b",
        deviceInstanceId: "device-b",
        metadata: { protocolDeploymentId: "deployment-b" },
        revokedAt: null,
        expiresAt: null
      }
    ];
    const duplicateRepository = {
      listAiClientInstances: async () => instances,
      listCurrentAiClientCapabilitySnapshots: async () => snapshots,
      listDeviceCredentials: async () => credentials
    } as unknown as Parameters<typeof assertManagedConversationTurnSettings>[0];
    const executionOnB = {
      ...execution,
      runnerDeviceId: "device-b",
      runnerDeploymentId: "deployment-b"
    };

    await expect(
      assertManagedConversationTurnSettings(duplicateRepository, executionOnB, {
        deviceId: "device-b",
        deploymentId: "deployment-b"
      })
    ).resolves.toBeUndefined();
    await expect(
      assertManagedConversationTurnSettings(
        duplicateRepository,
        {
          ...executionOnB,
          runnerDeviceId: "device-a",
          runnerDeploymentId: "deployment-a"
        },
        { deviceId: "device-a", deploymentId: "deployment-a" }
      )
    ).rejects.toThrow("unavailable");

    const ambiguousRepository = {
      listAiClientInstances: async () => instances,
      listCurrentAiClientCapabilitySnapshots: async () => snapshots,
      listDeviceCredentials: async () => [
        {
          ...credentials[0],
          deviceInstanceId: "device-b",
          metadata: { protocolDeploymentId: "deployment-b" }
        },
        credentials[1]
      ]
    } as unknown as Parameters<typeof assertManagedConversationTurnSettings>[0];
    await expect(
      assertManagedConversationTurnSettings(ambiguousRepository, executionOnB, {
        deviceId: "device-b",
        deploymentId: "deployment-b"
      })
    ).rejects.toThrow("unavailable");
  });
});
