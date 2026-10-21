import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createProjectHqConversationPreloadApi } from "./project-hq-conversation-preload.js";
import { projectHqConversationChannel } from "./project-hq-conversation-protocol.js";

describe("Project HQ Conversation preload", () => {
  it("correlates the server-owned catch-up to the requested Project", async () => {
    const projectId = randomUUID();
    const invoke = vi.fn(async () => ({
      operation: "catch_up",
      projectId,
      status: "nothing",
      executionId: null,
      commandId: null
    }));
    const api = createProjectHqConversationPreloadApi(invoke);
    await expect(api.catchUp(projectId)).resolves.toEqual({
      projectId,
      status: "nothing",
      executionId: null,
      commandId: null
    });
    expect(invoke).toHaveBeenCalledWith(projectHqConversationChannel, {
      operation: "catch_up",
      projectId
    });
  });
  it("keeps explicit catch-up Retry tied to one Project and request ID", async () => {
    const projectId = randomUUID();
    const failedCommandId = randomUUID();
    const retryRequestId = randomUUID();
    const executionId = randomUUID();
    const commandId = randomUUID();
    const invoke = vi.fn(async () => ({
      operation: "retry_catch_up",
      projectId,
      status: "queued",
      executionId,
      commandId,
      commandState: "queued"
    }));
    const api = createProjectHqConversationPreloadApi(invoke);
    await expect(
      api.retryCatchUp(projectId, failedCommandId, retryRequestId)
    ).resolves.toMatchObject({ projectId, executionId, commandId });
    expect(invoke).toHaveBeenCalledWith(projectHqConversationChannel, {
      operation: "retry_catch_up",
      projectId,
      failedCommandId,
      retryRequestId
    });
  });
  it("preserves the first prompt and permission mode while rejecting invalid requests before IPC", async () => {
    const projectId = randomUUID();
    const executionId = randomUUID();
    const commandId = randomUUID();
    const prompt = "  Review this Project.\nKeep the spacing exactly.  ";
    const invoke = vi.fn().mockResolvedValue({
      operation: "start",
      projectId,
      executionId,
      commandId,
      commandState: "queued"
    });
    const api = createProjectHqConversationPreloadApi(invoke);

    await expect(api.start(projectId, prompt, "auto_edit")).resolves.toEqual({
      projectId,
      executionId,
      commandId,
      commandState: "queued"
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      projectHqConversationChannel,
      { operation: "start", projectId, prompt, permissionMode: "auto_edit" }
    );

    await expect(api.start("not-a-uuid", prompt)).rejects.toThrow();
    await expect(api.start(projectId, "   ")).rejects.toThrow();
    await expect(api.read("not-a-uuid")).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("keeps the selected document ID separate from the visible first message", async () => {
    const projectId = randomUUID();
    const sourceId = randomUUID();
    const invoke = vi.fn().mockResolvedValue({
      operation: "start",
      projectId,
      executionId: randomUUID(),
      commandId: randomUUID(),
      commandState: "queued"
    });
    const api = createProjectHqConversationPreloadApi(invoke);
    await api.start(
      projectId,
      "Turn Plan.md into tickets",
      "supervised",
      sourceId
    );
    expect(invoke).toHaveBeenCalledWith(projectHqConversationChannel, {
      operation: "start",
      projectId,
      prompt: "Turn Plan.md into tickets",
      permissionMode: "supervised",
      selectedDocumentSourceId: sourceId
    });
    await expect(
      api.start(
        projectId,
        "Turn Plan.md into tickets",
        "supervised",
        randomUUID().slice(0, 8)
      )
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects responses for a different operation or Project", async () => {
    const projectId = randomUUID();
    const foreignProjectId = randomUUID();
    const createdAt = "2026-10-20T00:00:00.000Z";
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        operation: "reserve",
        value: { projectId, executionId: null, createdAt }
      })
      .mockResolvedValueOnce({
        operation: "read",
        value: {
          conversation: {
            projectId: foreignProjectId,
            executionId: null,
            createdAt
          },
          execution: null
        }
      })
      .mockResolvedValueOnce({
        operation: "reserve",
        value: { projectId: foreignProjectId, executionId: null, createdAt }
      })
      .mockResolvedValueOnce({
        operation: "start",
        projectId: foreignProjectId,
        executionId: randomUUID(),
        commandId: randomUUID(),
        commandState: "queued"
      });
    const api = createProjectHqConversationPreloadApi(invoke);

    await expect(api.read(projectId)).rejects.toThrow("correlation");
    await expect(api.read(projectId)).rejects.toThrow("identity");
    await expect(api.reserve(projectId)).rejects.toThrow("identity");
    await expect(api.start(projectId, "Start here")).rejects.toThrow("start");
  });
});
