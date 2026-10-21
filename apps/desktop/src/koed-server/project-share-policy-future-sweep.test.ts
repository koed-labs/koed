import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createProjectSharePolicyFutureSweep } from "./project-share-policy-future-sweep.js";

const project = () => ({
  projectId: randomUUID(),
  teamBackendId: "team-primary",
  workspaceProjectId: randomUUID(),
  policyVersion: 3
});

it("rotates Project pages and advances only one Session page per Project", async () => {
  const [a, b, c] = [project(), project(), project()];
  const list = vi.fn(async (cursor?: string) =>
    cursor
      ? { projects: [c], nextCursor: null, hasMore: false }
      : { projects: [a, b], nextCursor: "page-2", hasMore: true }
  );
  const stage = vi.fn(async (selected: typeof a, cursor?: string) => ({
    hasMore: selected.projectId === a.projectId && !cursor,
    nextCursor:
      selected.projectId === a.projectId && !cursor ? "session-page-2" : null
  }));
  const sweep = createProjectSharePolicyFutureSweep({ list, stage });
  const signal = new AbortController().signal;
  expect(await sweep.reconcile("owner-a", signal)).toEqual({ hasMore: true });
  expect(stage.mock.calls.map(([item]) => item.projectId)).toEqual([
    a.projectId,
    b.projectId
  ]);
  expect(await sweep.reconcile("owner-a", signal)).toEqual({ hasMore: true });
  expect(stage.mock.calls[2]?.[0].projectId).toBe(c.projectId);
  expect(await sweep.reconcile("owner-a", signal)).toEqual({ hasMore: true });
  expect(stage.mock.calls[3]?.[0].projectId).toBe(a.projectId);
  expect(stage.mock.calls[3]?.[1]).toBe("session-page-2");
  expect(stage.mock.calls[4]?.[0].projectId).toBe(b.projectId);
});

it("never carries a Project cursor across owner/profile authority", async () => {
  const selected = project();
  const list = vi.fn(async () => ({
    projects: [selected],
    nextCursor: null,
    hasMore: false
  }));
  const stage = vi.fn(async (_item: typeof selected, cursor?: string) => ({
    hasMore: !cursor,
    nextCursor: cursor ? null : "session-page-2"
  }));
  const sweep = createProjectSharePolicyFutureSweep({ list, stage });
  const signal = new AbortController().signal;
  await sweep.reconcile("owner-a", signal);
  await sweep.reconcile("owner-b", signal);
  expect(stage.mock.calls[1]?.[1]).toBeUndefined();
  expect(list).toHaveBeenCalledTimes(2);
});

it("paginates issue readback independently and clears its cursor on authority change", async () => {
  const selected = project();
  const list = vi.fn(async () => ({
    projects: [selected],
    nextCursor: null,
    hasMore: false
  }));
  const stage = vi.fn(async () => ({ hasMore: false, nextCursor: null }));
  const reconcileIssues = vi.fn(
    async (_item: typeof selected, cursor?: string) => ({
      hasMore: !cursor,
      nextCursor: cursor ? null : "issue-page-2"
    })
  );
  const sweep = createProjectSharePolicyFutureSweep({
    list,
    stage,
    reconcileIssues
  });
  const signal = new AbortController().signal;
  await sweep.reconcile("owner-a", signal);
  await sweep.reconcile("owner-a", signal);
  expect(reconcileIssues.mock.calls[1]?.[1]).toBe("issue-page-2");
  await sweep.reconcile("owner-b", signal);
  expect(reconcileIssues.mock.calls[2]?.[1]).toBeUndefined();
});
