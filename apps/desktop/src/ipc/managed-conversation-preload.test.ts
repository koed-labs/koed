import { describe, expect, it, vi } from "vitest";

import { createManagedConversationPreloadApi } from "./managed-conversation-preload.js";
import { managedConversationCommandChannel } from "./managed-conversation-protocol.js";

const identity = {
  executionId: "execution-1",
  projectId: "project-1",
  capturedSessionId: "captured-1",
  threadId: "thread-1"
};

describe("Managed Conversation preload bridge", () => {
  it("exposes exact validated methods without transport or filesystem authority", async () => {
    const invoke = vi.fn(async () => ({
      operation: "start",
      status: "ready",
      executionId: "execution-1",
      conversation: identity
    }));
    const api = createManagedConversationPreloadApi(invoke);
    await expect(
      api.start("project-1", "start-request-1")
    ).resolves.toMatchObject({
      status: "ready",
      conversation: identity
    });
    expect(Object.keys(api).sort()).toEqual([
      "fork",
      "handoff",
      "inspect",
      "resume",
      "send",
      "start",
      "targets",
      "transferStatus"
    ]);
    expect(invoke).toHaveBeenCalledWith(managedConversationCommandChannel, {
      operation: "start",
      projectId: "project-1",
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

  it("rejects malformed inputs before IPC", async () => {
    const invoke = vi.fn();
    const api = createManagedConversationPreloadApi(invoke);
    await expect(
      api.send({
        capturedSessionId: "captured-1",
        threadId: "thread-1",
        idempotencyKey: "bad key with spaces",
        prompt: "Hello"
      })
    ).rejects.toThrow();
    await expect(
      api.start(
        { projectId: "project-1", path: "/secret" } as never,
        "start-request-1"
      )
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("validates results and exact send correlation", async () => {
    const malformed = createManagedConversationPreloadApi(
      vi.fn(async () => ({
        operation: "send",
        status: "queued",
        conversation: identity,
        idempotencyKey: "different"
      }))
    );
    await expect(
      malformed.send({
        capturedSessionId: "captured-1",
        threadId: "thread-1",
        idempotencyKey: "expected",
        prompt: "Hello"
      })
    ).rejects.toThrow("send correlation");

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
