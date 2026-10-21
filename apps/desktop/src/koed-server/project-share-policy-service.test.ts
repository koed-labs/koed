import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { collaborationActionGrantStatusSchema } from "@koed/shared";
import {
  createProjectSharePolicyMoveFenceRelease,
  createProjectSharePolicyMovePreflight,
  knownCanceledProjectMove,
  requireDirectProjectCandidatePreviewGrant
} from "./project-share-policy-service.js";

const directStatus = (id = randomUUID()) =>
  collaborationActionGrantStatusSchema.parse({
    version: 1,
    actionGrant: { id },
    approvalTier: "direct",
    review: null,
    state: "approved",
    activationUrl: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });

describe("exact Project Conversation preview grant", () => {
  it("uses the registry Direct approval with fresh offer checks and no Native decision", async () => {
    const status = directStatus();
    const events: string[] = [];
    const revalidate = vi.fn(async () => {
      events.push("revalidate");
    });
    const request = vi.fn(async () => {
      events.push("request");
      return status;
    });
    const read = vi.fn(async () => {
      events.push("read");
      return status;
    });
    await expect(
      requireDirectProjectCandidatePreviewGrant({
        revalidate,
        request,
        read,
        isCurrent: () => true
      })
    ).resolves.toBe(status.actionGrant.id);
    expect(events).toEqual(["revalidate", "request", "revalidate", "read"]);
    expect(read).toHaveBeenCalledWith(status.actionGrant.id);
  });

  it("rejects a changed or stale Direct grant before preview consumption", async () => {
    const status = directStatus();
    const changed = directStatus();
    await expect(
      requireDirectProjectCandidatePreviewGrant({
        revalidate: async () => undefined,
        request: async () => status,
        read: async () => changed,
        isCurrent: () => true
      })
    ).rejects.toThrow("grant changed");
    let current = true;
    await expect(
      requireDirectProjectCandidatePreviewGrant({
        revalidate: async () => undefined,
        request: async () => {
          current = false;
          return status;
        },
        read: async () => status,
        isCurrent: () => current
      })
    ).rejects.toThrow("grant changed");
  });
});

describe("linked Project move preflight", () => {
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const ownerId = randomUUID();
  const backendId = "exact-team-backend";
  const workspaceProjectId = randomUUID();
  const authority = {
    key: "bound-window-and-profile",
    ownerId,
    apiOrigin: "http://localhost",
    authorization: "fixture",
    canWrite: true
  };
  const request = {
    action: "loose" as const,
    sessionId,
    expectedProjectId: projectId
  };
  const setup = (
    fence: () => Promise<{ state: string; fenceId?: string }>,
    issueCounts: { activated: number; pending: number } = {
      activated: 0,
      pending: 0
    }
  ) => {
    const identity = new AsyncLocalStorage<string>();
    const linkedProject = vi.fn(async () => {
      expect(identity.getStore()).toBe(authority.key);
      return {
        ownerUserId: ownerId,
        teamBackendId: backendId,
        workspaceProjectId
      };
    });
    const reconcileProjectSharePolicyIssues = vi.fn(async () => ({
      processed: issueCounts.activated + issueCounts.pending,
      activated: issueCounts.activated,
      pending: issueCounts.pending,
      hasMore: false,
      nextCursor: null
    }));
    const fenceUnpublishedProjectSharePolicyIssue = vi.fn(async () => {
      expect(identity.getStore()).toBe(authority.key);
      return fence();
    });
    const beforeMove = createProjectSharePolicyMovePreflight({
      identity,
      personal: {
        linkedProject,
        reconcileProjectSharePolicyIssues,
        fenceUnpublishedProjectSharePolicyIssue
      } as unknown as Parameters<
        typeof createProjectSharePolicyMovePreflight
      >[0]["personal"]
    });
    return {
      beforeMove,
      reconcileProjectSharePolicyIssues,
      fenceUnpublishedProjectSharePolicyIssue
    };
  };

  it("requires the exact Team no-issue fence even when reconciliation finds zero issues", async () => {
    const f = setup(async () => ({ state: "settled", fenceId: randomUUID() }));
    await f.beforeMove(request, authority);
    expect(f.reconcileProjectSharePolicyIssues).toHaveBeenCalledWith(
      projectId,
      backendId,
      workspaceProjectId,
      undefined,
      sessionId
    );
    expect(f.fenceUnpublishedProjectSharePolicyIssue).toHaveBeenCalledOnce();
  });

  it("blocks detach when the Team fence is unavailable", async () => {
    const f = setup(async () => {
      throw new Error("Team fence unavailable");
    });
    await expect(f.beforeMove(request, authority)).rejects.toThrow(
      "Team fence unavailable"
    );
    expect(f.fenceUnpublishedProjectSharePolicyIssue).toHaveBeenCalledOnce();
  });

  it("lets an already reconciled active grant continue into HQ107 freeze after Team exclusion ACK", async () => {
    const f = setup(async () => ({ state: "settled", fenceId: randomUUID() }), {
      activated: 1,
      pending: 0
    });
    await expect(f.beforeMove(request, authority)).resolves.toBeUndefined();
    expect(f.fenceUnpublishedProjectSharePolicyIssue).toHaveBeenCalledOnce();
  });

  it("releases only the acknowledged fence at the canceled move's exact mapping revision", async () => {
    const fenceId = randomUUID();
    const identity = new AsyncLocalStorage<string>();
    const currentForWrite = vi.fn(async () => ({
      link: {
        ownerUserId: ownerId,
        teamBackendId: backendId,
        workspaceProjectId
      },
      context: { principalId: randomUUID() }
    }));
    const fixedPrincipal = randomUUID();
    currentForWrite.mockImplementation(async () => ({
      link: {
        ownerUserId: ownerId,
        teamBackendId: backendId,
        workspaceProjectId
      },
      context: { principalId: fixedPrincipal }
    }));
    const currentUnpublishedProjectSharePolicyFence = vi.fn(async () => ({
      state: "acknowledged",
      fenceId,
      mappingRevision: 3
    }));
    const releaseUnpublishedProjectSharePolicyFence = vi.fn(async () => {
      expect(identity.getStore()).toBe(authority.key);
      return { state: "released" };
    });
    const release = createProjectSharePolicyMoveFenceRelease({
      identity,
      authority: async () => authority,
      currentForWrite,
      personal: {
        currentUnpublishedProjectSharePolicyFence,
        releaseUnpublishedProjectSharePolicyFence
      } as unknown as Parameters<
        typeof createProjectSharePolicyMoveFenceRelease
      >[0]["personal"]
    });
    await expect(
      release({
        sessionId,
        oldProjectId: projectId,
        mappingVersion: 2
      })
    ).rejects.toThrow("fence changed");
    expect(releaseUnpublishedProjectSharePolicyFence).not.toHaveBeenCalled();
    await release({ sessionId, oldProjectId: projectId, mappingVersion: 3 });
    expect(releaseUnpublishedProjectSharePolicyFence).toHaveBeenCalledWith(
      projectId,
      backendId,
      workspaceProjectId,
      sessionId,
      fenceId
    );
  });

  it("recognizes only a confirmed, completed Native cancel with unchanged placement", () => {
    const batchId = randomUUID();
    const reservation = { sessionId, batchId, oldProjectId: projectId };
    const status = {
      sessionId,
      batchId,
      complete: true,
      pending: false,
      pendingReviews: [],
      projectId
    };
    expect(
      knownCanceledProjectMove({
        confirmedCancel: true,
        reservation,
        status
      })
    ).toBe(true);
    expect(
      knownCanceledProjectMove({
        confirmedCancel: false,
        reservation,
        status
      })
    ).toBe(false);
    expect(
      knownCanceledProjectMove({
        confirmedCancel: true,
        reservation,
        status: { ...status, pending: true, complete: false }
      })
    ).toBe(false);
    expect(
      knownCanceledProjectMove({
        confirmedCancel: true,
        reservation,
        status: { ...status, projectId: randomUUID() }
      })
    ).toBe(false);
    expect(
      knownCanceledProjectMove({
        confirmedCancel: true,
        reservation,
        status: { ...status, batchId: randomUUID() }
      })
    ).toBe(false);
  });
});
