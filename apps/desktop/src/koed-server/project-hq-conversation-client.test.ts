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

describe("Project HQ Conversation main client", () => {
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
