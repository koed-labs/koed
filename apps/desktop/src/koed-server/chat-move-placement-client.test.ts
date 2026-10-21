import { describe, expect, it, vi } from "vitest";
import type { ProjectsAuthority } from "./projects-client.js";
import { createChatMovePlacementClient } from "./chat-move-placement-client.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionId = uuid(1),
  targetProjectId = uuid(2),
  oldProjectId = uuid(3);
const authority = {
  key: "owner-a|profile-a",
  ownerId: uuid(4),
  apiOrigin: "http://local",
  authorization: "Bearer local",
  canWrite: true
};
const target = {
  id: targetProjectId,
  name: "Empty Project",
  key: "EP",
  folderPath: "/trusted/project",
  lifecycle: "active",
  deletionPhase: null,
  deleteBatchId: null,
  deletedAt: null,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  version: 3
};
const move = {
  action: "move" as const,
  sessionId,
  targetProjectId,
  expectedProjectId: oldProjectId
};
const session = (
  canonicalId: string | null,
  technicalId = canonicalId ?? "lp_chats",
  override = true
) => ({
  session: {
    id: sessionId,
    project: { id: technicalId },
    projectOverride: override ? { id: technicalId } : null,
    projectOverridePersonalProjectId: override ? canonicalId : null,
    automaticPersonalProjectId: override ? oldProjectId : canonicalId
  }
});

describe("chat move owner-bound placement client", () => {
  it("resumes only the exact already prepared text-action batch", async () => {
    const actionId = uuid(8),
      batchId = uuid(9);
    const pending = {
      sessionId,
      batchId,
      pending: true,
      complete: false,
      projectId: oldProjectId,
      pendingReviews: []
    };
    const complete = {
      ...pending,
      pending: false,
      complete: true,
      projectId: targetProjectId
    };
    const requestJson = vi.fn(async (_path: string, init: RequestInit) =>
      init.method === "GET" ? { status: pending } : complete
    );
    const client = createChatMovePlacementClient({
      authority: async () => authority,
      requestJson
    });
    expect(await client.lookupTextActionMove({ sessionId, actionId })).toEqual(
      pending
    );
    await expect(
      client.resumeTextActionMove({ sessionId, actionId, batchId })
    ).resolves.toEqual(complete);
    expect(requestJson.mock.calls.at(-1)?.[0]).toBe(
      `/v1/memory/graph/sessions/${sessionId}/move-progress`
    );
    expect(
      requestJson.mock.calls.every(([path]) => !path.endsWith("/project"))
    ).toBe(true);
    const wrong = createChatMovePlacementClient({
      authority: async () => authority,
      requestJson: vi.fn(async () => ({
        status: {
          ...pending,
          batchId: uuid(10)
        }
      }))
    });
    await expect(
      wrong.resumeTextActionMove({ sessionId, actionId, batchId })
    ).rejects.toThrow("batch changed");
  });
  it("resolves a UUID Project with zero chats and PATCHes its authoritative details once", async () => {
    const requestJson = vi.fn(
      async (path: string, _init: RequestInit, _bound: ProjectsAuthority) => {
        void _init;
        void _bound;
        return path.startsWith("/v1/projects?")
          ? { projects: [target], nextCursor: null }
          : session(targetProjectId);
      }
    );
    const client = createChatMovePlacementClient({
      authority: async () => authority,
      requestJson
    });
    await expect(client.assign(move)).resolves.toEqual({
      projectId: targetProjectId
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requestJson.mock.calls[0]?.[0]).toBe("/v1/projects?limit=100");
    const patch = requestJson.mock.calls[1];
    expect(patch?.[0]).toBe(`/v1/memory/graph/sessions/${sessionId}/project`);
    expect(patch?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      action: "move",
      expectedProjectId: oldProjectId,
      project: {
        id: targetProjectId,
        name: target.name,
        path: target.folderPath
      }
    });
    expect(patch?.[2]).toBe(authority);
  });

  it("passes one exact text action ID through the owner-bound placement request", async () => {
    const requestJson = vi.fn(async (path: string, init: RequestInit) => {
      if (path.startsWith("/v1/projects?")) {
        expect(init.method).toBe("GET");
        return { projects: [target], nextCursor: null };
      }
      expect(init.method).toBe("PATCH");
      return session(targetProjectId);
    });
    const client = createChatMovePlacementClient({
      authority: async () => authority,
      requestJson
    });
    await client.assign({ ...move, textActionId: uuid(9) });
    expect(
      JSON.parse(String(requestJson.mock.calls[1]?.[1]?.body))
    ).toMatchObject({
      textActionId: uuid(9),
      expectedProjectId: oldProjectId,
      project: { id: targetProjectId }
    });
  });

  it("preserves exact expected placement and pending batch without promoting a local move", async () => {
    const requestJson = vi.fn(
      async (path: string, _init: RequestInit, _bound: ProjectsAuthority) => {
        void _init;
        void _bound;
        return path.startsWith("/v1/projects?")
          ? { projects: [target], nextCursor: null }
          : {
              ...session(oldProjectId, "lp_old_project", false),
              pending: true,
              batchId: uuid(5),
              pendingReviews: [{ bindingId: uuid(6), actionGrantId: uuid(7) }]
            };
      }
    );
    const client = createChatMovePlacementClient({
      authority: async () => authority,
      requestJson
    });
    await expect(client.assign(move)).resolves.toEqual({
      projectId: oldProjectId,
      pending: true,
      batchId: uuid(5),
      pendingReviews: [{ bindingId: uuid(6), actionGrantId: uuid(7) }]
    });
    expect(
      JSON.parse(String(requestJson.mock.calls[1]?.[1]?.body)).expectedProjectId
    ).toBe(oldProjectId);
  });

  it("rejects missing CAS and legacy technical target IDs before dispatch", async () => {
    const requestJson = vi.fn(async () => ({
      projects: [target],
      nextCursor: null
    }));
    const client = createChatMovePlacementClient({
      authority: async () => authority,
      requestJson
    });
    await expect(
      client.assign({ action: "move", sessionId, targetProjectId })
    ).rejects.toThrow("requires expected Project placement");
    await expect(
      client.assign({ ...move, targetProjectId: "graph-thread-id" })
    ).rejects.toThrow("first-class Project ID");
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("does not replay an uncertain PATCH, including loose and Undo", async () => {
    const requestJson = vi.fn(
      async (_path: string, _init: RequestInit, _bound: ProjectsAuthority) => {
        void _path;
        void _init;
        void _bound;
        throw new Error("timeout after dispatch");
      }
    );
    const client = createChatMovePlacementClient({
      authority: async () => authority,
      requestJson
    });
    await expect(
      client.assign({
        action: "loose",
        sessionId,
        expectedProjectId: oldProjectId
      })
    ).rejects.toThrow("timeout after dispatch");
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(requestJson.mock.calls[0]?.[1]?.body))).toEqual({
      action: "loose",
      expectedProjectId: oldProjectId
    });
    requestJson.mockClear();
    await expect(
      client.assign({
        action: "undo_move",
        sessionId,
        batchId: uuid(8),
        expectedProjectId: null
      })
    ).rejects.toThrow("timeout after dispatch");
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(requestJson.mock.calls[0]?.[1]?.body))).toEqual({
      action: "undo_move",
      batchId: uuid(8),
      expectedProjectId: null
    });
  });

  it("maps the technical lp_chats override to canonical null on loose placement", async () => {
    const requestJson = vi.fn(async () => session(null, "lp_chats"));
    const client = createChatMovePlacementClient({
      authority: async () => authority,
      requestJson
    });
    await expect(
      client.assign({
        action: "loose",
        sessionId,
        expectedProjectId: oldProjectId
      })
    ).resolves.toEqual({ projectId: null });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it("aborts on a profile flip before mutation and never replays after dispatch", async () => {
    let current = authority;
    const requestJson = vi.fn(
      async (path: string, _init: RequestInit, _bound: ProjectsAuthority) => {
        void _init;
        void _bound;
        if (path.startsWith("/v1/projects?")) {
          current = { ...authority, ownerId: uuid(9) };
          return { projects: [target], nextCursor: null };
        }
        return session(targetProjectId);
      }
    );
    const client = createChatMovePlacementClient({
      authority: async () => current,
      requestJson
    });
    await expect(client.assign(move)).rejects.toThrow("owner profile changed");
    expect(requestJson).toHaveBeenCalledTimes(1);

    current = authority;
    requestJson.mockClear().mockImplementation(async () => {
      current = { ...authority, key: "other-profile" };
      return session(null);
    });
    await expect(
      client.assign({
        action: "loose",
        sessionId,
        expectedProjectId: oldProjectId
      })
    ).rejects.toThrow("owner profile changed");
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched session, stale pending placement, and final placement", async () => {
    for (const payload of [
      { ...session(null), session: { ...session(null).session, id: uuid(10) } },
      { ...session(targetProjectId), pending: true, batchId: uuid(11) },
      session(oldProjectId)
    ]) {
      const client = createChatMovePlacementClient({
        authority: async () => authority,
        requestJson: async (path) =>
          path.startsWith("/v1/projects?")
            ? { projects: [target], nextCursor: null }
            : payload
      });
      await expect(client.assign(move)).rejects.toThrow(
        /response session changed|pending placement changed|final placement changed/
      );
    }
  });
});
