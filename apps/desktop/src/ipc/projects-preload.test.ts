import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectsPreloadApi } from "./projects-preload.js";
import { projectsCommandChannel } from "./projects-protocol.js";

describe("Projects preload", () => {
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
