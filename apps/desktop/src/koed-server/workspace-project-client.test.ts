import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceProjectClient } from "./workspace-project-client.js";

describe("Workspace Project client", () => {
  const teamId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const personalProjectId = randomUUID();
  const ownerTeamMemberId = randomUUID();
  const project = {
    id: projectId,
    teamId,
    workspaceId,
    ownerTeamMemberId,
    name: "Atlas",
    key: "ATL",
    lifecycle: "active",
    version: 1,
    copiedAt: null
  };
  it("marks Personal collaboration moved only after confirmed Team copy, including retry", async () => {
    let copyAttempt = 0;
    const markPersonalMoved = vi.fn(async () => {});
    const loadPersonalCopy = vi.fn(async () => ({
      personalProjectVersion: 1,
      workItems: [
        {
          id: randomUUID(),
          kind: "todo" as const,
          title: "Ship",
          goal: "Ship",
          status: "todo" as const
        }
      ],
      sources: []
    }));
    const sendTeam = vi.fn(async (path: string) => {
      if (path === "/v1/workspace-projects") return project;
      copyAttempt += 1;
      if (copyAttempt === 1) throw new Error("Team copy interrupted");
      return { ...project, copiedAt: new Date().toISOString(), version: 2 };
    });
    const client = createWorkspaceProjectClient({
      sendTeam,
      loadPersonalCopy,
      markPersonalMoved,
      loadPersonalSource: async () => {
        throw new Error("not used");
      },
      loadLinkedPersonalSources: async () => [],
      onAuthoritativeInvalidation: async () => {}
    });
    const input = {
      teamId,
      workspaceId,
      name: "Atlas",
      key: "ATL",
      shareAttemptKey: "share-attempt-atlas",
      personalProjectId,
      teamBackendId: "team-backend"
    };
    await expect(client.firstShare(input)).rejects.toThrow("interrupted");
    expect(markPersonalMoved).not.toHaveBeenCalled();
    await client.firstShare(input);
    expect(markPersonalMoved).toHaveBeenCalledExactlyOnceWith(
      personalProjectId,
      projectId,
      "team-backend",
      workspaceId,
      1
    );
    expect(loadPersonalCopy).toHaveBeenCalledTimes(2);
  });
  it("keeps the last Team snapshot read-only while offline", async () => {
    let online = true;
    const sendTeam = vi.fn(async (path: string) => {
      if (!online) throw new Error("offline");
      if (path.endsWith("/lifecycle"))
        return {
          id: projectId,
          version: 1,
          memberVersion: 1,
          active: true,
          canWrite: true
        };
      if (path.includes("/work-items?"))
        return { items: [], nextOffset: null, projectVersion: 1 };
      if (path.includes("/sources?"))
        return { items: [], nextOffset: null, projectVersion: 1 };
      if (path.endsWith("/activity/summary"))
        return {
          days: Array.from({ length: 7 }, (_, index) => ({
            date: `2026-10-${String(14 + index).padStart(2, "0")}`,
            count: 0
          })),
          done: 0,
          merged: 0
        };
      return project;
    });
    const client = createWorkspaceProjectClient({
      sendTeam,
      loadPersonalCopy: async () => ({
        personalProjectVersion: 1,
        workItems: [],
        sources: []
      }),
      markPersonalMoved: async () => {},
      loadPersonalSource: async () => {
        throw new Error("not used");
      },
      loadLinkedPersonalSources: async () => [],
      onAuthoritativeInvalidation: async () => {}
    });
    expect((await client.refresh(projectId)).readOnly).toBe(false);
    online = false;
    const state = await client.refresh(projectId);
    expect(state.readOnly).toBe(true);
    expect(state.project?.id).toBe(projectId);
    await expect(
      client.patchWorkItem(projectId, randomUUID(), {
        expectedVersion: 1,
        status: "done"
      })
    ).rejects.toThrow("read-only");
  });
  it("clears cached Team records after explicit access denial without Personal detachment", async () => {
    let statusCode: number | null = null;
    const invalidation = vi.fn(async () => {});
    const sendTeam = vi.fn(async (path: string) => {
      if (statusCode) throw Object.assign(new Error("denied"), { statusCode });
      if (path.endsWith("/lifecycle"))
        return {
          id: projectId,
          version: 1,
          memberVersion: 1,
          active: true,
          canWrite: true
        };
      if (path.includes("/work-items?"))
        return { items: [], nextOffset: null, projectVersion: 1 };
      if (path.includes("/sources?"))
        return { items: [], nextOffset: null, projectVersion: 1 };
      if (path.endsWith("/activity/summary"))
        return {
          days: Array.from({ length: 7 }, (_, index) => ({
            date: `2026-10-${String(14 + index).padStart(2, "0")}`,
            count: 0
          })),
          done: 0,
          merged: 0
        };
      return project;
    });
    const client = createWorkspaceProjectClient({
      sendTeam,
      loadPersonalCopy: async () => ({
        personalProjectVersion: 1,
        workItems: [],
        sources: []
      }),
      markPersonalMoved: async () => {},
      loadPersonalSource: async () => {
        throw new Error("not used");
      },
      loadLinkedPersonalSources: async () => [],
      onAuthoritativeInvalidation: invalidation
    });
    expect((await client.refresh(projectId)).project?.id).toBe(projectId);
    statusCode = 503;
    expect((await client.refresh(projectId)).project?.id).toBe(projectId);
    statusCode = 403;
    const denied = await client.refresh(projectId);
    expect(denied).toMatchObject({
      project: null,
      workItems: [],
      sources: [],
      activity: null,
      readOnly: true
    });
    expect(invalidation).not.toHaveBeenCalled();
  });
  it("collects every bounded Work Item page and rejects a changed Project between pages", async () => {
    const now = "2026-10-20T00:00:00.000Z";
    const item = (id: string) => ({
      id,
      sourceOwnerTeamMemberId: ownerTeamMemberId,
      sourceWorkItemId: null,
      kind: "todo",
      key: null,
      title: "Task",
      goal: "Do it",
      status: "todo",
      dueOn: null,
      doneAt: null,
      assigneeDisplayName: null,
      stepLabel: null,
      dispatchKey: null,
      prUrl: null,
      prState: null,
      version: 1,
      createdAt: now,
      updatedAt: now
    });
    const first = Array.from({ length: 50 }, () => item(randomUUID()));
    const last = item(randomUUID());
    const source = () => ({
      id: randomUUID(),
      uploaderTeamMemberId: ownerTeamMemberId,
      sourceProjectSourceId: randomUUID(),
      name: "Plan",
      kind: "doc",
      status: "ready",
      personalNoteId: null,
      personalNoteRevisionId: null,
      version: 1
    });
    const sourceFirst = Array.from({ length: 100 }, source);
    const sourceLast = source();
    let changed = false;
    const sendTeam = vi.fn(async (path: string) => {
      if (path.endsWith("/lifecycle"))
        return {
          id: projectId,
          version: 1,
          memberVersion: 1,
          active: true,
          canWrite: true
        };
      if (path.includes("/work-items?")) {
        const offset = Number(
          new URL(path, "http://team.test").searchParams.get("offset")
        );
        return offset === 0
          ? { items: first, nextOffset: 50, projectVersion: 1 }
          : {
              items: [last],
              nextOffset: null,
              projectVersion: changed ? 2 : 1
            };
      }
      if (path.includes("/sources?")) {
        const offset = Number(
          new URL(path, "http://team.test").searchParams.get("offset")
        );
        return offset === 0
          ? { items: sourceFirst, nextOffset: 100, projectVersion: 1 }
          : {
              items: [sourceLast],
              nextOffset: null,
              projectVersion: changed ? 2 : 1
            };
      }
      if (path.endsWith("/activity/summary"))
        return {
          days: Array.from({ length: 7 }, (_, index) => ({
            date: `2026-10-${String(14 + index).padStart(2, "0")}`,
            count: 0
          })),
          done: 0,
          merged: 0
        };
      return project;
    });
    const client = createWorkspaceProjectClient({
      sendTeam,
      loadPersonalCopy: async () => ({
        personalProjectVersion: 1,
        workItems: [],
        sources: []
      }),
      markPersonalMoved: async () => {},
      loadPersonalSource: async () => {
        throw new Error("not used");
      },
      loadLinkedPersonalSources: async () => [],
      onAuthoritativeInvalidation: async () => {}
    });
    const complete = await client.refresh(projectId);
    expect(complete.workItems).toHaveLength(51);
    expect(complete.sources).toHaveLength(101);
    changed = true;
    const stale = await client.refresh(projectId);
    expect(stale.readOnly).toBe(true);
    expect(stale.workItems).toHaveLength(51);
    expect(stale.sources).toHaveLength(101);
    expect(stale.notice).toContain("changed while loading");
  });
});
