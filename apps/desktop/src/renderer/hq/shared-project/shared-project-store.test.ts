import { describe, expect, it, vi } from "vitest";
import type {
  WorkspaceProjectState,
  WorkspaceProjectWorkItem
} from "@koed/shared";
import {
  SharedProjectStore,
  type SharedProjectIdentity
} from "./shared-project-store.js";

const identity = (suffix: string): SharedProjectIdentity => ({
  ownerId: `owner-${suffix}`,
  profileKey: `profile-${suffix}`,
  personalProjectId: `personal-${suffix}`,
  workspaceProjectId: `workspace-${suffix}`,
  teamBackendId: `backend-${suffix}`
});
const item = (version = 1): WorkspaceProjectWorkItem => ({
  id: "item-1",
  sourceOwnerTeamMemberId: "member-1",
  sourceWorkItemId: null,
  kind: "todo",
  key: null,
  title: "Review plan",
  goal: "Review plan",
  status: "todo",
  dueOn: null,
  assigneeDisplayName: null,
  stepLabel: null,
  doneAt: null,
  dispatchKey: null,
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
  prUrl: null,
  prState: null,
  version
});
const state = (
  workspaceProjectId: string,
  workItems: WorkspaceProjectWorkItem[] = [item()],
  readOnly = false
): WorkspaceProjectState => ({
  project: {
    id: workspaceProjectId,
    teamId: "team-1",
    workspaceId: "team-workspace-1",
    ownerTeamMemberId: "member-1",
    name: "Shared plan",
    key: "PLAN",
    lifecycle: "active",
    version: 1,
    copiedAt: null
  },
  memberVersion: 1,
  activity: null,
  workItems,
  sources: [],
  readOnly,
  notice: readOnly ? "Offline. Shared changes are paused." : null
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SharedProjectStore", () => {
  it("fences a stale refresh across owner, profile, project and backend changes", async () => {
    let resolveOld!: (value: WorkspaceProjectState) => void;
    const old = new Promise<WorkspaceProjectState>((resolve) => {
      resolveOld = resolve;
    });
    const refresh = vi.fn((projectId: string) =>
      projectId === "workspace-a"
        ? old
        : Promise.resolve(state("workspace-b", [item(2)]))
    );
    const store = new SharedProjectStore({ sharedRefresh: refresh });
    store.setIdentity(identity("a"));
    store.setIdentity(identity("b"));
    await tick();
    resolveOld(state("workspace-a"));
    await tick();
    expect(store.current().identity).toEqual(identity("b"));
    expect(store.current().state?.project?.id).toBe("workspace-b");
    expect(store.current().state?.workItems[0]?.version).toBe(2);
  });

  it("keeps the last state read-only during offline refresh and never sends a write", async () => {
    let offline = false;
    const patch = vi.fn();
    const store = new SharedProjectStore({
      sharedRefresh: vi.fn(async () => {
        if (offline) throw new Error("offline");
        return state("workspace-a");
      }),
      sharedPatchWorkItem: patch
    });
    store.setIdentity(identity("a"));
    await tick();
    offline = true;
    await store.refresh();
    expect(store.current().state?.workItems[0]?.title).toBe("Review plan");
    expect(store.current().state?.readOnly).toBe(true);
    expect(store.current().state?.notice).toBe(
      "Offline. Shared changes are paused."
    );
    expect(
      await store.patchWorkItem("item-1", {
        expectedVersion: 1,
        title: "New title"
      })
    ).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });

  it("clears private dispatch bindings and cached Team data on denial but retains a read-only copy on outage", async () => {
    let failure: number | null = null;
    const store = new SharedProjectStore({
      sharedRefresh: async () => {
        if (failure)
          throw Object.assign(new Error("refresh failed"), {
            statusCode: failure
          });
        return state("workspace-a");
      },
      sharedDispatches: async () => [
        {
          teamWorkItemId: "item-1",
          executionId: "private-execution",
          agentId: "my-agent"
        }
      ]
    });
    store.setIdentity(identity("a"));
    await tick();
    expect(store.current().dispatches).toHaveLength(1);
    failure = 503;
    await store.refresh();
    expect(store.current().state?.readOnly).toBe(true);
    expect(store.current().dispatches).toEqual([]);
    failure = 403;
    await store.refresh();
    expect(store.current().state).toBeNull();
    expect(store.current().dispatches).toEqual([]);
    expect(store.current().error).toContain("no longer have access");
  });

  it("shows an authoritative 409 state without retrying or losing edit intent", async () => {
    const patch = vi.fn(async () => ({
      status: "conflict" as const,
      state: state("workspace-a", [{ ...item(2), title: "Teammate title" }])
    }));
    const store = new SharedProjectStore({
      sharedRefresh: vi.fn(async () => state("workspace-a")),
      sharedPatchWorkItem: patch
    });
    store.setIdentity(identity("a"));
    await tick();
    expect(
      await store.patchWorkItem("item-1", {
        expectedVersion: 1,
        title: "My title"
      })
    ).toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(store.current().conflictItemId).toBe("item-1");
    expect(store.current().state?.workItems[0]?.title).toBe("Teammate title");
  });

  it("uses Team storage for new to-dos and leaves Personal storage untouched", async () => {
    const create = vi.fn(async () => ({
      status: "ok" as const,
      item: { ...item(), id: "new-item", title: "New to-do" }
    }));
    const store = new SharedProjectStore({
      sharedRefresh: vi.fn(async () => state("workspace-a", [])),
      sharedCreateWorkItem: create
    });
    store.setIdentity(identity("a"));
    await tick();
    expect(
      await store.createWorkItem({
        idempotencyKey: "intent-123",
        kind: "todo",
        title: "New to-do",
        goal: "New to-do",
        status: "todo",
        dueOn: null
      })
    ).toBe(true);
    expect(create).toHaveBeenCalledWith(
      "workspace-a",
      "backend-a",
      expect.objectContaining({ title: "New to-do" })
    );
    expect(store.current().state?.workItems).toHaveLength(1);
  });
});
