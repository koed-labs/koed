import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createProjectHqConversationClient,
  type ProjectHqAuthority
} from "./project-hq-conversation-client.js";

const authority = (
  families = ["personal_collaboration_write", "managed_execution"]
): ProjectHqAuthority => ({
  key: `owner:local:${families.join(",")}`,
  ownerId: randomUUID(),
  apiOrigin: "http://127.0.0.1:3300",
  authorization: "Koed-Desktop test",
  operationFamilies: families
});

const unlinkedHq = (projectId: string) => {
  const section = { availability: "not_implemented" };
  return {
    project: {
      id: projectId,
      name: "Private Project",
      key: "PRIVATE",
      folderPath: null,
      lifecycle: "active",
      deletionPhase: null,
      deleteBatchId: null,
      deletedAt: null,
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
      version: 1,
      teamBackendId: null,
      workspaceProjectId: null
    },
    sections: {
      conversations: section,
      workItems: section,
      sources: section,
      decks: section,
      scheduledJobs: section
    }
  };
};

describe("Project HQ Conversation main client", () => {
  it("sends the sealed Team read credential only in the trusted linked catch-up header", async () => {
    const projectId = randomUUID();
    const workspaceProjectId = randomUUID();
    const bound = authority();
    const teamCredential = vi.fn(() => "Koed-Device sealed:credential");
    const section = { availability: "not_implemented" };
    const requestJson = vi.fn(
      async (
        path: string,
        _init: RequestInit,
        _authority: ProjectHqAuthority
      ) => {
        void [_init, _authority];
        return path.endsWith("/hq")
          ? {
              project: {
                id: projectId,
                name: "Launch",
                key: "LAUNCH",
                folderPath: null,
                lifecycle: "active",
                deletionPhase: null,
                deleteBatchId: null,
                deletedAt: null,
                createdAt: "2026-10-20T10:00:00.000Z",
                updatedAt: "2026-10-20T10:00:00.000Z",
                version: 1,
                teamBackendId: "team-backend",
                workspaceProjectId
              },
              sections: {
                conversations: section,
                workItems: section,
                sources: section,
                decks: section,
                scheduledJobs: section
              }
            }
          : { status: "nothing" };
      }
    );
    const client = createProjectHqConversationClient({
      authority: async () => bound,
      teamCredential,
      requestJson
    });
    await expect(
      client({ operation: "catch_up", projectId })
    ).resolves.toMatchObject({
      operation: "catch_up",
      status: "nothing"
    });
    expect(teamCredential).toHaveBeenCalledExactlyOnceWith("team-backend");
    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      `/v1/projects/${projectId}/hq`,
      { method: "GET" },
      bound
    );
    const [, init] = requestJson.mock.calls[1]!;
    expect(new Headers(init.headers).get("x-koed-team-client-credential")).toBe(
      "Koed-Device sealed:credential"
    );
    expect(init.body).toBe("{}");
    expect(init.body).not.toContain("credential");
  });

  it("blocks a linked catch-up after profile change or an unsealed Team credential", async () => {
    const projectId = randomUUID();
    const workspaceProjectId = randomUUID();
    const bound = authority();
    const project = {
      id: projectId,
      name: "Launch",
      key: "LAUNCH",
      folderPath: null,
      lifecycle: "active",
      deletionPhase: null,
      deleteBatchId: null,
      deletedAt: null,
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
      version: 1,
      teamBackendId: "team-backend",
      workspaceProjectId
    };
    const section = { availability: "not_implemented" };
    const hq = {
      project,
      sections: {
        conversations: section,
        workItems: section,
        sources: section,
        decks: section,
        scheduledJobs: section
      }
    };
    const requestJson = vi.fn(async () => hq);
    const changing = vi
      .fn()
      .mockResolvedValueOnce(bound)
      .mockResolvedValueOnce(bound)
      .mockResolvedValueOnce({ ...bound, key: "other-profile" });
    const teamCredential = vi.fn(() => "Koed-Device sealed:credential");
    await expect(
      createProjectHqConversationClient({
        authority: changing,
        teamCredential,
        requestJson
      })({ operation: "catch_up", projectId })
    ).rejects.toThrow("profile changed");
    expect(teamCredential).not.toHaveBeenCalled();
    expect(requestJson).toHaveBeenCalledTimes(1);
    await expect(
      createProjectHqConversationClient({
        authority: async () => bound,
        teamCredential: () => "Bearer personal-api-token",
        requestJson
      })({ operation: "catch_up", projectId })
    ).rejects.toThrow("Linked Team Project authority is unavailable");
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it("sends a short first message and the selected document as distinct typed fields", async () => {
    const projectId = randomUUID();
    const selectedDocumentSourceId = randomUUID();
    const bound = authority();
    const requestJson = vi.fn(
      async (
        _path: string,
        _init: RequestInit,
        _authority: ProjectHqAuthority
      ) => {
        void [_path, _init, _authority];
        return {
          execution: { id: randomUUID(), projectId },
          command: { id: randomUUID(), state: "queued" }
        };
      }
    );
    const client = createProjectHqConversationClient({
      authority: async () => bound,
      requestJson
    });
    await client({
      operation: "start",
      projectId,
      prompt: "Turn Plan.md into tickets",
      permissionMode: "supervised",
      selectedDocumentSourceId
    });
    const sent = JSON.parse(
      (requestJson.mock.calls[0]![1] as RequestInit).body as string
    );
    expect(sent).toEqual({
      prompt: "Turn Plan.md into tickets",
      permissionMode: "supervised",
      selectedDocumentSourceId
    });
    expect(sent.prompt).not.toContain(selectedDocumentSourceId);
  });
  it("sends an empty, owner-bound catch-up request and checks the profile afterward", async () => {
    const projectId = randomUUID();
    const executionId = randomUUID();
    const bound = authority();
    const requestJson = vi.fn(async (path: string) =>
      path.endsWith("/hq")
        ? unlinkedHq(projectId)
        : { status: "starting", executionId }
    );
    const client = createProjectHqConversationClient({
      authority: async () => bound,
      requestJson
    });
    await expect(client({ operation: "catch_up", projectId })).resolves.toEqual(
      {
        operation: "catch_up",
        projectId,
        status: "starting",
        executionId,
        commandId: null
      }
    );
    expect(requestJson).toHaveBeenLastCalledWith(
      `/v1/projects/${projectId}/hq/catch-up`,
      expect.objectContaining({ method: "POST", body: "{}" }),
      bound
    );
  });
  it.each(["retry_available", "reconciliation_required", "recovered"] as const)(
    "keeps a %s catch-up outcome visible without resending a provider turn",
    async (status) => {
      const projectId = randomUUID();
      const executionId = randomUUID();
      const commandId = randomUUID();
      const requestJson = vi.fn(async (path: string) =>
        path.endsWith("/hq")
          ? unlinkedHq(projectId)
          : { status, executionId, commandId }
      );
      const client = createProjectHqConversationClient({
        authority: async () => authority(),
        requestJson
      });
      await expect(
        client({ operation: "catch_up", projectId })
      ).resolves.toMatchObject({
        status,
        projectId,
        executionId,
        commandId
      });
      expect(requestJson).toHaveBeenCalledTimes(2);
    }
  );
  it("sends only an explicit stable retry ID for a proven pre-send catch-up", async () => {
    const projectId = randomUUID();
    const failedCommandId = randomUUID();
    const retryRequestId = randomUUID();
    const executionId = randomUUID();
    const commandId = randomUUID();
    const bound = authority();
    const requestJson = vi.fn(async (path: string) =>
      path.endsWith("/hq")
        ? unlinkedHq(projectId)
        : {
            status: "queued",
            executionId,
            commandId,
            commandState: "queued"
          }
    );
    const client = createProjectHqConversationClient({
      authority: async () => bound,
      requestJson
    });
    await expect(
      client({
        operation: "retry_catch_up",
        projectId,
        failedCommandId,
        retryRequestId
      })
    ).resolves.toMatchObject({
      operation: "retry_catch_up",
      projectId,
      executionId,
      commandId
    });
    expect(requestJson).toHaveBeenCalledWith(
      `/v1/projects/${projectId}/hq/catch-up/retry`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ failedCommandId, retryRequestId })
      }),
      bound
    );
  });
  it("reads an empty or captured HQ identity through GET without write authority", async () => {
    const id = randomUUID();
    const executionId = randomUUID();
    const capturedSessionId = randomUUID();
    const graphProjectId = "/local/project-folder";
    const graphThreadId = "graph-thread";
    const bound = authority(["personal_collaboration_read"]);
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({ conversation: null, execution: null })
      .mockResolvedValueOnce({
        conversation: {
          projectId: id,
          executionId,
          createdAt: new Date().toISOString()
        },
        execution: {
          state: "stopped",
          capturedSessionId,
          threadId: "provider-thread",
          graphProjectId,
          graphThreadId,
          provider: "codex",
          aiClientInstanceId: "codex.default"
        }
      });
    const client = createProjectHqConversationClient({
      authority: async () => bound,
      requestJson
    });
    await expect(client({ operation: "read", projectId: id })).resolves.toEqual(
      { operation: "read", value: { conversation: null, execution: null } }
    );
    await expect(
      client({ operation: "read", projectId: id })
    ).resolves.toMatchObject({
      operation: "read",
      value: {
        conversation: { projectId: id, executionId },
        execution: {
          capturedSessionId,
          threadId: "provider-thread",
          graphProjectId,
          graphThreadId
        }
      }
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
    for (const call of requestJson.mock.calls) {
      expect(call[0]).toBe(`/v1/projects/${id}/hq/conversation`);
      expect(call[1]).toMatchObject({ method: "GET" });
      expect(call[1].body).toBeUndefined();
      expect(call[2]).toBe(bound);
    }
  });

  it("rejects foreign Project read responses and a profile change after GET", async () => {
    const id = randomUUID();
    const other = randomUUID();
    const bound = authority(["personal_collaboration_read"]);
    const conversation = {
      projectId: other,
      executionId: null,
      createdAt: new Date().toISOString()
    };
    await expect(
      createProjectHqConversationClient({
        authority: async () => bound,
        requestJson: async () => ({ conversation, execution: null })
      })({ operation: "read", projectId: id })
    ).rejects.toThrow("identity mismatch");
    const changed = { ...bound, key: "changed-profile" };
    const current = vi
      .fn()
      .mockResolvedValueOnce(bound)
      .mockResolvedValueOnce(bound)
      .mockResolvedValueOnce(changed);
    const requestJson = vi.fn(async () => ({
      conversation: null,
      execution: null
    }));
    await expect(
      createProjectHqConversationClient({ authority: current, requestJson })({
        operation: "read",
        projectId: id
      })
    ).rejects.toThrow("profile changed");
    expect(requestJson).toHaveBeenCalledOnce();
  });

  it("binds a write to one owner authority and correlates Project identity", async () => {
    const id = randomUUID();
    const bound = authority();
    const requestJson = vi.fn(
      async (
        _path: string,
        _init: RequestInit,
        received: ProjectHqAuthority
      ) => {
        expect(received).toBe(bound);
        return {
          projectId: id,
          executionId: null,
          createdAt: new Date().toISOString()
        };
      }
    );
    const client = createProjectHqConversationClient({
      authority: async () => bound,
      requestJson
    });
    await expect(
      client({ operation: "reserve", projectId: id })
    ).resolves.toMatchObject({
      operation: "reserve",
      value: { projectId: id, executionId: null }
    });
    expect(requestJson).toHaveBeenCalledWith(
      `/v1/projects/${id}/hq/conversation`,
      expect.objectContaining({ method: "POST" }),
      bound
    );
  });

  it("rejects missing authority, changed profile, and a cross-Project start", async () => {
    const id = randomUUID();
    const other = randomUUID();
    const readOnly = authority(["personal_collaboration_read"]);
    const never = vi.fn();
    await expect(
      createProjectHqConversationClient({
        authority: async () => readOnly,
        requestJson: never
      })({ operation: "reserve", projectId: id })
    ).rejects.toThrow("authority is unavailable");
    expect(never).not.toHaveBeenCalled();

    const writeOnly = authority(["personal_collaboration_write"]);
    await expect(
      createProjectHqConversationClient({
        authority: async () => writeOnly,
        requestJson: never
      })({ operation: "start", projectId: id, prompt: "Hello" })
    ).rejects.toThrow("authority is unavailable");

    const first = authority();
    const next = { ...first, key: "changed" };
    const changing = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(next);
    await expect(
      createProjectHqConversationClient({
        authority: changing,
        requestJson: async () => ({
          projectId: id,
          executionId: null,
          createdAt: new Date().toISOString()
        })
      })({ operation: "reserve", projectId: id })
    ).rejects.toThrow("profile changed");

    await expect(
      createProjectHqConversationClient({
        authority: async () => first,
        requestJson: async () => ({
          execution: { id: randomUUID(), projectId: other },
          command: { id: randomUUID(), state: "blocked" }
        })
      })({ operation: "start", projectId: id, prompt: "Hello" })
    ).rejects.toThrow("Project identity mismatch");
  });
});
