import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node's native TypeScript runner requires the extension.
import { canCancelUnactivatedPendingShare, canStopRetainedUpdates, findPendingOwnedShare, isHostedTeamMembershipEnabled, mayApplyTeamMemoryResult } from "./team-memory-settings.guards.ts";
import type { OwnedShareItem } from "@koed/shared/collaboration";

test("same-scope refresh permits its replacement read and rejects stale settings results", () => {
  const request = {
    active: true,
    requestGeneration: 4,
    currentGeneration: 4,
    requestAuthority: "backend:user-a",
    currentAuthority: "backend:user-a",
    requestTeamId: "team-a",
    currentTeamId: "team-a"
  };
  assert.equal(mayApplyTeamMemoryResult(request), true);
  assert.equal(mayApplyTeamMemoryResult({ ...request, active: false }), false);
  assert.equal(mayApplyTeamMemoryResult({ ...request, currentGeneration: 5 }), false);
  assert.equal(mayApplyTeamMemoryResult({ ...request, requestGeneration: 5, currentGeneration: 5 }), true);
  assert.equal(mayApplyTeamMemoryResult({ ...request, currentAuthority: "backend:user-b" }), false);
  assert.equal(mayApplyTeamMemoryResult({ ...request, currentTeamId: "team-b" }), false);
});

test("hosted Team navigation accepts only the API's enabled membership status", () => {
  assert.equal(isHostedTeamMembershipEnabled("enabled"), true);
  assert.equal(isHostedTeamMembershipEnabled("active"), false);
  assert.equal(isHostedTeamMembershipEnabled("pending"), false);
  assert.equal(isHostedTeamMembershipEnabled(undefined), false);
});

test("only retained active grants can use the scoped Stop updates operation", () => {
  const active = { retentionEnabled: true, updatesActive: true, shareGrantId: "grant-a", grantVersion: 2 };
  assert.equal(canStopRetainedUpdates(active), true);
  assert.equal(canStopRetainedUpdates({ ...active, retentionEnabled: false }), false);
  assert.equal(canStopRetainedUpdates({ ...active, updatesActive: false }), false);
});

test("pending replacements with an associated grant cannot be cancelled independently", () => {
  const pending = { pendingShareId: "pending-a", grantId: null, state: "preparing", workspaceAccessState: "active" };
  assert.equal(canCancelUnactivatedPendingShare(pending), true);
  assert.equal(canCancelUnactivatedPendingShare({ ...pending, grantId: "grant-a" }), false);
  assert.equal(canCancelUnactivatedPendingShare({ ...pending, state: "revoked" }), false);
});

test("paged scan finds an exact pending destination after the first page", async () => {
  const item = {
    kind: "pending",
    pendingShare: {
      logicalMemoryId: "memory-a",
      teamId: "team-a",
      workspaceId: "workspace-a",
      state: "preparing"
    }
  } as unknown as OwnedShareItem;
  const cursors: Array<string | null> = [];
  const result = await findPendingOwnedShare({
    loadPage: async (cursor) => {
      cursors.push(cursor);
      return cursor === null
        ? { shares: [], nextCursor: "page-2" }
        : { shares: [item], nextCursor: null };
    },
    isCurrent: () => true,
    logicalMemoryId: "memory-a",
    teamId: "team-a",
    workspaceId: "workspace-a",
    pageLimit: 10
  });
  assert.deepEqual(cursors, [null, "page-2"]);
  assert.deepEqual(result, { found: true, complete: true });
});

test("paged scan fails closed at its bound and stops after scope changes", async () => {
  let pageCalls = 0;
  const bounded = await findPendingOwnedShare({
    loadPage: async () => {
      pageCalls += 1;
      return { shares: [], nextCursor: `page-${pageCalls + 1}` };
    },
    isCurrent: () => true,
    logicalMemoryId: "memory-a",
    teamId: "team-a",
    workspaceId: "workspace-a",
    pageLimit: 2
  });
  assert.deepEqual(bounded, { found: false, complete: false });
  assert.equal(pageCalls, 2);

  let current = true;
  let staleCalls = 0;
  const stale = await findPendingOwnedShare({
    loadPage: async () => {
      staleCalls += 1;
      current = false;
      return { shares: [], nextCursor: "page-2" };
    },
    isCurrent: () => current,
    logicalMemoryId: "memory-a",
    teamId: "team-a",
    workspaceId: "workspace-a",
    pageLimit: 10
  });
  assert.deepEqual(stale, { found: false, complete: false });
  assert.equal(staleCalls, 1);
});
