import { describe, expect, it, vi } from "vitest";
import { createManagedMemoryActionClient } from "./managed-memory-action-client.js";
import { createManagedMemoryActionPreloadApi } from "../ipc/managed-memory-action-preload.js";
import type { ProjectsAuthority } from "./projects-client.js";

const executionId = "00000000-0000-4000-8000-000000003071";
const actionId = "00000000-0000-4000-8000-000000003072";
const ownerId = "00000000-0000-4000-8000-000000003073";
const action = {
  id: actionId,
  executionId,
  actionKind: "forget",
  state: "completed",
  outcome: "undone",
  message: "Restored this memory.",
  createdAt: "2026-10-20T10:00:00Z",
  completedAt: "2026-10-20T10:01:00Z"
} as const;
const authority: ProjectsAuthority = {
  key: "profile-a",
  ownerId,
  apiOrigin: "http://127.0.0.1:43300",
  authorization: "Koed-Desktop private-fixture",
  canWrite: true
};

describe("durable memory action Desktop boundary", () => {
  it("uses exact owner-bound paths and sends no renderer token or authority fields", async () => {
    const send = vi.fn<
      (
        path: string,
        init: RequestInit,
        bound: ProjectsAuthority
      ) => Promise<Record<string, unknown>>
    >(async () => ({ operation: "undo", executionId, action }));
    const client = createManagedMemoryActionClient(send, async () => authority);
    expect(await client({ operation: "undo", executionId, actionId })).toEqual({
      operation: "undo",
      executionId,
      action
    });
    expect(send).toHaveBeenCalledWith(
      `/v1/managed-conversations/${executionId}/memory-actions/${actionId}/undo`,
      { method: "POST" },
      authority
    );
    expect(JSON.stringify(send.mock.calls[0]?.slice(0, 2))).not.toContain(
      authority.authorization
    );
  });

  it("denies read-only connections and rejects late responses after a profile change", async () => {
    const send = vi.fn(async () => ({
      operation: "list",
      executionId,
      actions: [action]
    }));
    await expect(
      createManagedMemoryActionClient(send, async () => ({
        ...authority,
        canWrite: false
      }))({ operation: "undo", executionId, actionId })
    ).rejects.toThrow("authority");
    expect(send).not.toHaveBeenCalled();
    let calls = 0;
    const client = createManagedMemoryActionClient(send, async () => ({
      ...authority,
      key: ++calls < 3 ? "profile-a" : "profile-b"
    }));
    await expect(client({ operation: "list", executionId })).rejects.toThrow(
      "profile changed"
    );
  });

  it("rejects cross-Conversation results and leaked private payloads", async () => {
    const other = "00000000-0000-4000-8000-000000003074";
    for (const payload of [
      {
        operation: "list",
        executionId,
        actions: [{ ...action, executionId: other }]
      },
      {
        operation: "list",
        executionId,
        actions: [{ ...action, suppressionToken: "123456" }]
      }
    ]) {
      const client = createManagedMemoryActionClient(
        async () => payload,
        async () => authority
      );
      await expect(
        client({ operation: "list", executionId })
      ).rejects.toThrow();
    }
  });

  it("validates preload requests and exact Undo correlation", async () => {
    const invoke = vi.fn(async () => ({
      operation: "undo",
      executionId,
      action: { ...action, id: ownerId }
    }));
    const api = createManagedMemoryActionPreloadApi(invoke);
    await expect(api.undo(executionId, actionId)).rejects.toThrow(
      "different action"
    );
    expect(invoke).toHaveBeenCalledWith("koed:managed-memory-action:command", {
      operation: "undo",
      executionId,
      actionId
    });
    await expect(api.list("not-an-id")).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
