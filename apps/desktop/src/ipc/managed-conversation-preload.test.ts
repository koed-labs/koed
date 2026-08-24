import { describe, expect, it, vi } from "vitest";

import { createManagedConversationPreloadApi } from "./managed-conversation-preload.js";
import { managedConversationCommandChannel } from "./managed-conversation-protocol.js";

const identity = {
  executionId: "execution-1",
  projectId: "project-1",
  capturedSessionId: "captured-1",
  threadId: "thread-1",
  executionOwner: {
    driverId: "codex" as const,
    instanceId: "codex.default"
  }
};

describe("Managed Conversation preload bridge", () => {
  it("accepts unavailable registered AI Clients in launch options", async () => {
    const invoke = vi.fn(async () => ({
      operation: "launch_options",
      options: {
        runners: [
          {
            kind: "local_device",
            deploymentId: "deployment-1",
            deviceId: "device-1",
            displayName: "This device"
          }
        ],
        instances: [
          {
            instanceId: "pi.default",
            driverId: "pi",
            displayName: "Pi",
            ready: false,
            readiness: "authentication_required",
            models: [],
            capabilities: {
              defaultPermissionMode: "full_access",
              permissionModes: [
                { mode: "supervised", support: "unsupported" },
                { mode: "supervised", support: "unsupported" },
                { mode: "auto_edit", support: "unsupported" },
                { mode: "full_access", support: "unsupported" }
              ]
            }
          }
        ]
      }
    }));
    const api = createManagedConversationPreloadApi(invoke);

    await expect(api.launchOptions()).resolves.toMatchObject({
      options: {
        instances: [
          {
            instanceId: "pi.default",
            driverId: "pi",
            ready: false
          }
        ]
      }
    });
  });

  it("exposes exact validated methods without transport or filesystem authority", async () => {
    const invoke = vi.fn(async () => ({
      operation: "start",
      status: "ready",
      executionId: "execution-1",
      conversation: identity
    }));
    const api = createManagedConversationPreloadApi(invoke);
    await expect(
      api.start({
        projectId: "project-1",
        aiClientDriverId: "codex",
        aiClientInstanceId: "codex.default",
        model: "gpt-test",
        reasoningEffort: "low",
        permissionMode: "full_access",
        runnerKind: "local_device",
        idempotencyKey: "start-request-1"
      })
    ).resolves.toMatchObject({
      status: "ready",
      conversation: identity
    });
    expect(Object.keys(api).sort()).toEqual([
      "deleteDraft",
      "fork",
      "handoff",
      "inspect",
      "interrupt",
      "launchOptions",
      "readDraft",
      "respond",
      "resume",
      "runtime",
      "send",
      "start",
      "stop",
      "targets",
      "transferStatus",
      "usage",
      "writeDraft"
    ]);
    expect(invoke).toHaveBeenCalledWith(managedConversationCommandChannel, {
      operation: "start",
      projectId: "project-1",
      aiClientDriverId: "codex",
      aiClientInstanceId: "codex.default",
      model: "gpt-test",
      reasoningEffort: "low",
      permissionMode: "full_access",
      runnerKind: "local_device",
      idempotencyKey: "start-request-1"
    });
  });

  it("exposes target discovery and correlated transfer commands", async () => {
    const invoke = vi.fn(async (_channel, request: any) => {
      if (request.operation === "targets") {
        return {
          operation: "targets",
          devices: [
            {
              deviceId: "device-2",
              deploymentId: "deployment-2",
              label: "Laptop"
            }
          ]
        };
      }
      if (request.operation === "transfer_status") {
        return {
          operation: "transfer_status",
          executionId: request.executionId,
          handoff: {
            operation: "handoff",
            operationId: "handoff-1",
            state: "restoring",
            targetDeviceId: "device-2",
            childExecutionId: null,
            failureCode: null,
            updatedAt: "2026-07-27T12:00:00.000Z"
          },
          fork: null
        };
      }
      return {
        operation: request.operation,
        status: "queued",
        executionId: request.executionId,
        operationId: request.operationId,
        targetDeviceId: request.targetDeviceId
      };
    });
    const api = createManagedConversationPreloadApi(invoke);

    await expect(api.targets()).resolves.toMatchObject({
      devices: [{ deviceId: "device-2" }]
    });
    await expect(api.transferStatus("execution-1")).resolves.toMatchObject({
      handoff: { operationId: "handoff-1", state: "restoring" }
    });
    await expect(
      api.handoff({
        actionGrantId: "grant-handoff-1",
        executionId: "execution-1",
        operationId: "handoff-1",
        targetDeviceId: "device-2"
      })
    ).resolves.toMatchObject({ operation: "handoff", status: "queued" });
    await expect(
      api.fork({
        actionGrantId: "grant-fork-1",
        executionId: "execution-1",
        operationId: "fork-1",
        targetDeviceId: "device-2",
        reason: "independent_work"
      })
    ).resolves.toMatchObject({ operation: "fork", status: "queued" });

    expect(invoke).toHaveBeenLastCalledWith(managedConversationCommandChannel, {
      operation: "fork",
      actionGrantId: "grant-fork-1",
      executionId: "execution-1",
      operationId: "fork-1",
      targetDeviceId: "device-2",
      reason: "independent_work"
    });
  });

  it("exposes only validated provider-attributed Conversation usage", async () => {
    const invoke = vi.fn(async (_channel, request: any) => ({
      operation: "usage",
      executionId: request.executionId,
      provider: "codex",
      usage: {
        model: "gpt-5.6",
        modelContextWindow: 258_000,
        usedTokens: 42_000,
        totalProcessedTokens: 125_000,
        inputTokens: 40_000,
        cachedInputTokens: 30_000,
        outputTokens: 2_000,
        reasoningOutputTokens: 500,
        usageAccuracy: "provider_reported",
        observedAt: "2026-08-18T04:00:00.000Z"
      }
    }));
    const api = createManagedConversationPreloadApi(invoke);

    await expect(api.usage("execution-1")).resolves.toMatchObject({
      provider: "codex",
      usage: { usedTokens: 42_000, modelContextWindow: 258_000 }
    });
    expect(invoke).toHaveBeenCalledWith(managedConversationCommandChannel, {
      operation: "usage",
      executionId: "execution-1"
    });
  });

  it("validates runtime interactions and exact control correlation", async () => {
    const now = "2026-08-18T05:00:00.000Z";
    const invoke = vi.fn(async (_channel, request: any) => {
      if (request.operation === "runtime") {
        return {
          operation: "runtime",
          executionId: request.executionId,
          executionGeneration: 3,
          executionStateVersion: 4,
          executionState: "running",
          executionLastErrorCode: null,
          latestCommand: {
            clientUserMessageId: null,
            id: "77777777-7777-4777-8777-777777777777",
            sequence: 2,
            executionGeneration: 3,
            commandKind: "prompt",
            state: "indeterminate",
            lastErrorCode: "ManagedConversationRunnerInterruptedError",
            updatedAt: now
          },
          items: [
            {
              id: "runtime-item-1",
              executionGeneration: 3,
              providerTurnId: "turn-1",
              providerItemId: "item-1",
              itemKind: "user_input",
              presentation: {
                mode: "expanded",
                renderer: "user_input",
                policyKey: "user_input",
                policyRevision: 1,
                reason: "presentation-policy:user_input"
              },
              state: "pending",
              payload: { questions: [] },
              revision: 1,
              createdAt: now,
              updatedAt: now,
              answered: false
            }
          ]
        };
      }
      if (request.operation === "runtime_respond") {
        return {
          operation: "runtime_respond",
          accepted: true,
          itemId: request.itemId
        };
      }
      return {
        operation: request.operation,
        status: "queued",
        executionId: request.executionId,
        commandId: `${request.operation}-command`
      };
    });
    const api = createManagedConversationPreloadApi(invoke);

    await expect(api.runtime("execution-1")).resolves.toMatchObject({
      executionGeneration: 3,
      latestCommand: { state: "indeterminate" },
      items: [{ itemKind: "user_input" }]
    });
    await expect(
      api.respond({
        executionId: "execution-1",
        itemId: "runtime-item-1",
        itemKind: "user_input",
        executionGeneration: 3,
        answers: { target: ["Core"] }
      })
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      api.interrupt({
        executionId: "execution-1",
        executionGeneration: 3,
        idempotencyKey: "interrupt-1"
      })
    ).resolves.toMatchObject({ commandId: "interrupt-command" });
    await expect(
      api.stop({
        executionId: "execution-1",
        executionGeneration: 3,
        idempotencyKey: "stop-1"
      })
    ).resolves.toMatchObject({ commandId: "stop-command" });
  });

  it("rejects malformed inputs before IPC", async () => {
    const invoke = vi.fn();
    const api = createManagedConversationPreloadApi(invoke);
    await expect(
      api.send({
        executionId: "execution-1",
        capturedSessionId: "captured-1",
        threadId: "thread-1",
        idempotencyKey: "bad key with spaces",
        clientUserMessageId: "00000000-0000-4000-8000-000000000010",
        prompt: "Hello"
      })
    ).rejects.toThrow();
    await expect(
      api.start({ projectId: "project-1", path: "/secret" } as never)
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("validates results and exact send correlation", async () => {
    const malformed = createManagedConversationPreloadApi(
      vi.fn(async () => ({
        operation: "send",
        status: "queued",
        conversation: identity,
        idempotencyKey: "different",
        clientUserMessageId: "00000000-0000-4000-8000-000000000010"
      }))
    );
    await expect(
      malformed.send({
        executionId: "execution-1",
        capturedSessionId: "captured-1",
        threadId: "thread-1",
        idempotencyKey: "expected",
        clientUserMessageId: "00000000-0000-4000-8000-000000000010",
        prompt: "Hello"
      })
    ).rejects.toThrow("send correlation");

    const rejected = createManagedConversationPreloadApi(
      vi.fn(async () => ({
        operation: "send",
        status: "rejected",
        conversation: identity,
        idempotencyKey: "expected",
        clientUserMessageId: "00000000-0000-4000-8000-000000000010",
        message: "The prompt was not sent."
      }))
    );
    await expect(
      rejected.send({
        executionId: "execution-1",
        capturedSessionId: "captured-1",
        threadId: "thread-1",
        idempotencyKey: "expected",
        clientUserMessageId: "00000000-0000-4000-8000-000000000010",
        prompt: "Hello"
      })
    ).resolves.toMatchObject({ status: "rejected" });

    const leaking = createManagedConversationPreloadApi(
      vi.fn(async () => ({
        operation: "resume",
        status: "ready",
        conversation: identity,
        transcriptPath: "/secret"
      }))
    );
    await expect(leaking.resume(identity)).rejects.toThrow();

    const mismatchedTransfer = createManagedConversationPreloadApi(
      vi.fn(async () => ({
        operation: "handoff",
        status: "queued",
        executionId: "execution-1",
        operationId: "different",
        targetDeviceId: "device-2"
      }))
    );
    await expect(
      mismatchedTransfer.handoff({
        actionGrantId: "grant-handoff-1",
        executionId: "execution-1",
        operationId: "expected",
        targetDeviceId: "device-2"
      })
    ).rejects.toThrow("handoff correlation");
  });
});
