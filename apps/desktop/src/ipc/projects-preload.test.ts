import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectsPreloadApi } from "./projects-preload.js";
import { projectsCommandChannel } from "./projects-protocol.js";

describe("Projects preload", () => {
  it("requires the exact linked Personal Project after a Team join", async () => {
    const workspaceProjectId = randomUUID();
    const now = "2026-10-21T00:00:00.000Z";
    const project = {
      id: randomUUID(),
      name: "Joined Project",
      key: "JOIN",
      folderPath: null,
      lifecycle: "active",
      deletionPhase: null,
      deleteBatchId: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 2,
      teamBackendId: "team-backend",
      teamWorkspaceId: randomUUID(),
      workspaceProjectId
    };
    const invoke = vi.fn(async () => ({
      operation: "sharedJoinProject",
      project
    }));
    const api = createProjectsPreloadApi(invoke);
    await expect(
      api.sharedJoinProject!(workspaceProjectId, "team-backend")
    ).resolves.toEqual(project);
    expect(invoke).toHaveBeenCalledWith(projectsCommandChannel, {
      operation: "sharedJoinProject",
      workspaceProjectId,
      teamBackendId: "team-backend"
    });
    invoke.mockResolvedValueOnce({
      operation: "sharedJoinProject",
      project: { ...project, workspaceProjectId: randomUUID() }
    });
    await expect(
      api.sharedJoinProject!(workspaceProjectId, "team-backend")
    ).rejects.toThrow("joined Project identity");
  });
  it("rejects a cross-Project activity result before the renderer can use it", async () => {
    const id = randomUUID();
    const other = randomUUID();
    const invoke = vi.fn(async () => ({
      operation: "activitySeen",
      projectId: other,
      value: { cursor: "cursor", at: null }
    }));
    const api = createProjectsPreloadApi(invoke);
    await expect(api.activitySeen!(id)).rejects.toThrow("activity seen result");
    expect(invoke).toHaveBeenCalledWith(projectsCommandChannel, {
      operation: "activitySeen",
      projectId: id
    });
  });

  it("validates both directions and operation correlation", async () => {
    const invoke = vi.fn(
      async (channel: string, request: unknown): Promise<unknown> => {
        expect(channel).toBe(projectsCommandChannel);
        expect(request).toEqual({ operation: "list" });
        return { operation: "list", projects: [] };
      }
    );
    const api = createProjectsPreloadApi(invoke);
    await expect(api.list()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith(projectsCommandChannel, {
      operation: "list"
    });
    await expect(api.hq("not-a-project-id")).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    invoke.mockResolvedValueOnce({ operation: "hq", value: {} });
    await expect(api.list()).rejects.toThrow();
    invoke.mockResolvedValueOnce({
      operation: "list",
      projects: [],
      extra: true
    });
    await expect(api.list()).rejects.toThrow();
  });

  it("rejects cross-Project and cross-batch mutation results", async () => {
    const id = randomUUID(),
      other = randomUUID(),
      batchId = randomUUID();
    const now = "2026-10-20T00:00:00.000Z";
    const project = (projectId: string) => ({
      id: projectId,
      name: "Atlas",
      key: "ATLAS",
      folderPath: null,
      lifecycle: "active",
      deletionPhase: null,
      deleteBatchId: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 1
    });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        operation: "deletePreview",
        value: {
          project: project(other),
          executionSetHash: "a".repeat(64),
          activeExecutions: []
        }
      })
      .mockResolvedValueOnce({
        operation: "deleteStatus",
        value: {
          project: project(id),
          operation: { batchId: other, state: "preparing" },
          complete: false,
          retryable: true,
          pendingFreezeCount: 0,
          pendingExecutionCount: 0,
          pendingReviews: [],
          cancellationPending: false
        }
      })
      .mockResolvedValueOnce({ operation: "deleteStatus", value: null })
      .mockResolvedValueOnce({ operation: "pickFolder", path: "/tmp/project" });
    const api = createProjectsPreloadApi(invoke);
    await expect(api.deletePreview(id)).rejects.toThrow("identity correlation");
    await expect(api.deleteStatus(id, batchId)).rejects.toThrow(
      "batch correlation"
    );
    await expect(api.deleteStatus(id, batchId)).resolves.toBeNull();
    await expect(api.pickFolder()).resolves.toBe("/tmp/project");
  });
});
