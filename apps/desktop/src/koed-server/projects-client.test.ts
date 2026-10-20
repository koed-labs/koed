import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createProjectsClient } from "./projects-client.js";
import type { ProjectsAuthority } from "./projects-client.js";

const auth = (key: string): ProjectsAuthority => ({
  key,
  ownerId: "owner",
  apiOrigin: "http://127.0.0.1:4000",
  authorization: "test",
  canWrite: true
});

const now = "2026-10-20T00:00:00.000Z";
const project = (id: string) => ({
  id,
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

describe("Projects main client", () => {
  it("reads every owner page and rejects a profile change during pagination", async () => {
    const first = project(randomUUID());
    const second = project(randomUUID());
    const read = vi.fn(async (path: string) =>
      path.includes("cursor=next")
        ? { projects: [second], nextCursor: null }
        : { projects: [first], nextCursor: "next" }
    );
    const authority = vi.fn(async () => auth("owner-profile-a"));
    const client = createProjectsClient(read, authority);
    await expect(client({ operation: "list" })).resolves.toEqual({
      operation: "list",
      projects: [first, second]
    });
    expect(read).toHaveBeenCalledTimes(2);
    authority
      .mockResolvedValueOnce(auth("owner-profile-a"))
      .mockResolvedValueOnce(auth("owner-profile-b"));
    await expect(client({ operation: "list" })).rejects.toThrow(
      "profile changed"
    );
  });

  it("validates Project HQ identity and read responses", async () => {
    const id = randomUUID();
    const sections = Object.fromEntries(
      ["conversations", "workItems", "sources", "decks", "scheduledJobs"].map(
        (key) => [key, { availability: "not_implemented" }]
      )
    );
    const read = vi.fn(async () => ({
      project: project(randomUUID()),
      sections
    }));
    const client = createProjectsClient(read, async () =>
      auth("owner-profile-a")
    );
    await expect(client({ operation: "hq", projectId: id })).rejects.toThrow(
      "identity mismatch"
    );
    read.mockResolvedValueOnce({ project: project(id), sections });
    await expect(
      client({ operation: "hq", projectId: id })
    ).resolves.toMatchObject({ operation: "hq", value: { project: { id } } });
  });
});

describe("Projects mutation boundary", () => {
  it("sends a write with the captured owner credential and rejects read-only authority", async () => {
    const id = randomUUID();
    const bound = auth("owner-profile-a");
    const request = vi.fn(
      async (_path: string, _init: RequestInit, captured: typeof bound) => {
        expect(captured).toBe(bound);
        return project(id);
      }
    );
    const client = createProjectsClient(request, async () => bound);
    await expect(
      client({
        operation: "create",
        value: { name: "Atlas", folderPath: null, idempotencyKey: "intent-1" }
      })
    ).resolves.toMatchObject({ operation: "create", value: { id } });
    expect(request).toHaveBeenCalledWith(
      "/v1/projects",
      expect.objectContaining({ method: "POST" }),
      bound
    );
    const readOnly = createProjectsClient(request, async () => ({
      ...bound,
      canWrite: false
    }));
    await expect(
      readOnly({
        operation: "create",
        value: { name: "Atlas", idempotencyKey: "intent-2" }
      })
    ).rejects.toThrow("write authority");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects a profile switch before sending and a mismatched delete batch", async () => {
    const id = randomUUID();
    const batchId = randomUUID();
    const authority = vi
      .fn()
      .mockResolvedValueOnce(auth("old"))
      .mockResolvedValueOnce(auth("new"));
    const request = vi.fn(async () => ({}));
    const switched = createProjectsClient(request, authority);
    await expect(
      switched({ operation: "deleteStatus", projectId: id, batchId })
    ).rejects.toThrow("profile changed");
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce({
      project: {
        ...project(id),
        lifecycle: "deleted",
        deletionPhase: "complete",
        deleteBatchId: randomUUID(),
        deletedAt: now
      },
      operation: { batchId: randomUUID(), state: "complete" },
      complete: true,
      retryable: false,
      pendingFreezeCount: 0,
      pendingExecutionCount: 0,
      pendingReviews: [],
      cancellationPending: false
    });
    const stable = createProjectsClient(request, async () => auth("stable"));
    await expect(
      stable({ operation: "deleteStatus", projectId: id, batchId })
    ).rejects.toThrow("batch identity");
  });

  it("treats only an authoritative status 404 as an absent batch", async () => {
    const id = randomUUID(),
      batchId = randomUUID();
    const missing = Object.assign(new Error("not_found"), {
      code: "not_found"
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(new Error("offline"));
    const client = createProjectsClient(request, async () => auth("stable"));
    await expect(
      client({ operation: "deleteStatus", projectId: id, batchId })
    ).resolves.toEqual({ operation: "deleteStatus", value: null });
    await expect(
      client({ operation: "deleteStatus", projectId: id, batchId })
    ).rejects.toThrow("offline");
  });

  it("rejects a released restore response if the Project entered another delete batch", async () => {
    const id = randomUUID();
    const batchId = randomUUID();
    const nextBatchId = randomUUID();
    const request = vi.fn(async () => ({
      project: {
        ...project(id),
        lifecycle: "deleted",
        deletionPhase: "complete",
        deleteBatchId: nextBatchId,
        deletedAt: now,
        version: 3
      },
      released: true
    }));
    const client = createProjectsClient(request, async () => auth("stable"));
    await expect(
      client({ operation: "restoreReconcile", projectId: id, batchId })
    ).rejects.toThrow("lifecycle mismatch");
    expect(request).toHaveBeenCalledWith(
      `/v1/projects/${id}/restore-reconcile`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ batchId })
      }),
      expect.anything()
    );
  });
});
