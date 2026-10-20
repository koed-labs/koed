import { describe, expect, it, vi } from "vitest";
import { createCuratedMemoryClient } from "./curated-memory-client.js";
import type { ProjectsAuthority } from "./projects-client.js";

const owner = "00000000-0000-4000-8000-000000000101";
const project = "00000000-0000-4000-8000-000000000102";
const id = "00000000-0000-4000-8000-000000000103";
const authority: ProjectsAuthority = {
  key: "owner-profile",
  ownerId: owner,
  apiOrigin: "http://127.0.0.1:43300",
  authorization: "Koed-Desktop fixture",
  canWrite: true
};
const assertion = {
  id,
  ownerUserId: owner,
  visibility: "personal",
  scope: "project",
  projectId: project,
  kind: "decision",
  authorKind: "user",
  authorRef: owner,
  classificationVersion: 1,
  assertionText: "Ship the small launch",
  status: "current",
  createdAt: "2026-10-20T08:00:00Z",
  observedAt: "2026-10-20T08:00:00Z",
  updatedAt: "2026-10-20T08:00:00Z",
  suppressionToken: null,
  sources: [],
  replaces: []
};

describe("Curated Memory Desktop client", () => {
  it("passes the since boundary and rejects earlier assertions", async () => {
    const request = vi.fn(async (path: string) => {
      expect(path).toContain("/v1/memory/curated/assertions?");
      return { assertions: [assertion], next_cursor: null };
    });
    const client = createCuratedMemoryClient(request, async () => authority);
    const since = "2026-10-20T00:00:00+02:00";
    await client({
      operation: "list",
      scope: "project",
      projectId: project,
      since
    });
    expect(request.mock.calls[0]?.[0]).toContain(
      `since=${encodeURIComponent(since)}`
    );
    await expect(
      client({
        operation: "list",
        scope: "project",
        projectId: project,
        since: "2026-10-21T00:00:00+02:00"
      })
    ).rejects.toThrow("scope");
  });
  it("bounds Project lists to the owner and selected Project", async () => {
    const request = vi.fn(
      async (
        ...args: [string, RequestInit, ProjectsAuthority]
      ): Promise<Record<string, unknown>> => {
        expect(args[2]).toEqual(authority);
        return { assertions: [assertion] };
      }
    );
    const client = createCuratedMemoryClient(request, async () => authority);
    await expect(
      client({ operation: "list", scope: "project", projectId: project })
    ).resolves.toMatchObject({ assertions: [assertion] });
    expect(request.mock.calls[0]?.[0]).toContain(
      `scope=project&status=current&include_sources=true&limit=249&project_id=${project}`
    );
    request.mockResolvedValueOnce({
      assertions: [
        { ...assertion, ownerUserId: "00000000-0000-4000-8000-000000000104" }
      ]
    });
    await expect(
      client({ operation: "list", scope: "project", projectId: project })
    ).rejects.toThrow("crossed owner");
    request.mockResolvedValueOnce({
      assertions: [{ ...assertion, scope: "me", projectId: null }]
    });
    await expect(
      client({ operation: "list", scope: "project", projectId: project })
    ).rejects.toThrow("scope");
  });
  it("checks write authority and profile continuity before Forget", async () => {
    const request = vi.fn(async (_path: string, init: RequestInit) => ({
      assertion: {
        ...assertion,
        status: init.method === "POST" ? "suppressed" : "current"
      }
    }));
    await expect(
      createCuratedMemoryClient(request, async () => ({
        ...authority,
        canWrite: false
      }))({ operation: "forget", assertionId: id })
    ).rejects.toThrow("write authority");
    expect(request).not.toHaveBeenCalled();
    let calls = 0;
    await expect(
      createCuratedMemoryClient(request, async () => ({
        ...authority,
        key: ++calls === 1 ? "first" : "second"
      }))({ operation: "forget", assertionId: id })
    ).rejects.toThrow("profile changed");
    expect(request).not.toHaveBeenCalled();
  });
  it("sends exact Undo token and rejects a cross-owner detail", async () => {
    const request = vi.fn(async (_path: string, init: RequestInit) => ({
      assertion: {
        ...assertion,
        status: init.method === "POST" ? "current" : "current"
      }
    }));
    const client = createCuratedMemoryClient(request, async () => authority);
    await client({
      operation: "undo",
      assertionId: id,
      suppressionToken: "1792490400123456"
    });
    expect(request.mock.calls[0]?.[0]).toBe(
      `/v1/memory/curated/assertions/${id}/unsuppress`
    );
    expect(JSON.parse(String(request.mock.calls[0]?.[1].body))).toEqual({
      suppression_token: "1792490400123456"
    });
    request.mockResolvedValueOnce({
      assertion: {
        ...assertion,
        ownerUserId: "00000000-0000-4000-8000-000000000104"
      }
    });
    await expect(
      client({ operation: "detail", assertionId: id })
    ).rejects.toThrow("crossed owner");
  });
  it("returns the exact Forget mutation token without a follow-up GET", async () => {
    const firstToken = "1792490400123456";
    const laterToken = "1792490400123457";
    const request = vi.fn(
      async (
        _path: string,
        init: RequestInit
      ): Promise<Record<string, unknown>> => {
        if (init.method !== "POST")
          throw new Error("GET unavailable after mutation");
        return {
          assertion: {
            ...assertion,
            status: "suppressed",
            suppressionToken: firstToken,
            replaces: undefined
          }
        };
      }
    );
    const client = createCuratedMemoryClient(request, async () => authority);
    const result = await client({ operation: "forget", assertionId: id });
    expect(result).toMatchObject({
      operation: "forget",
      assertion: { suppressionToken: firstToken }
    });
    expect(
      result.operation === "forget" && result.assertion.suppressionToken
    ).not.toBe(laterToken);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({
      assertion: { ...assertion, status: "suppressed", suppressionToken: null }
    });
    await expect(
      client({ operation: "forget", assertionId: id })
    ).rejects.toThrow("crossed owner");
  });
  it("validates Undo and Move response correlation", async () => {
    const request = vi.fn(
      async (): Promise<Record<string, unknown>> => ({
        assertion: {
          ...assertion,
          scope: "me",
          projectId: null,
          classificationVersion: 2
        },
        operation: { state: "complete" }
      })
    );
    const client = createCuratedMemoryClient(request, async () => authority);
    await expect(
      client({
        operation: "move",
        assertionId: id,
        scope: "project",
        projectId: project,
        expectedVersion: 1
      })
    ).rejects.toThrow("crossed owner");
    request.mockResolvedValueOnce({
      assertion: { ...assertion, status: "suppressed", suppressionToken: "1" }
    });
    await expect(
      client({ operation: "undo", assertionId: id, suppressionToken: "1" })
    ).rejects.toThrow("crossed owner");
  });
  it("carries a bounded cursor to the next owner-scoped page", async () => {
    const request = vi.fn(
      async (path: string): Promise<Record<string, unknown>> => {
        expect(path).toContain("scope=project");
        return {
          assertions: [assertion],
          next_cursor: { updated_at: assertion.updatedAt, id }
        };
      }
    );
    const client = createCuratedMemoryClient(request, async () => authority);
    const first = await client({
      operation: "list",
      scope: "project",
      projectId: project
    });
    expect(first).toMatchObject({
      nextCursor: { updatedAt: assertion.updatedAt, id }
    });
    await expect(
      client({
        operation: "list",
        scope: "project",
        projectId: project,
        cursor: { updatedAt: assertion.updatedAt, id }
      })
    ).rejects.toThrow("did not advance");
    expect(request.mock.calls[1]?.[0]).toContain("before_updated_at=");
    expect(request.mock.calls[1]?.[0]).toContain(`before_id=${id}`);
  });
});
