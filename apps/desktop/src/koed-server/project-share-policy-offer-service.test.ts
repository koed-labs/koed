import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_CONTRACT_VERSION } from "@koed/shared";

const { currentForWrite } = vi.hoisted(() => ({ currentForWrite: vi.fn() }));
vi.mock("./project-share-policy-client.js", () => ({
  createProjectSharePolicyClient: () => ({ currentForWrite })
}));

import { createProjectSharePolicyService } from "./project-share-policy-service.js";

const instant = new Date(Date.now() + 60_000).toISOString();
const hash = "a".repeat(64);

describe("trusted explicit Project chat offer broker", () => {
  beforeEach(() => currentForWrite.mockReset());

  const run = async (approve: boolean) => {
    const owner = randomUUID();
    const projectId = randomUUID();
    const workspaceProjectId = randomUUID();
    const sessionId = randomUUID();
    const logicalMemoryId = randomUUID();
    const teamId = randomUUID();
    const workspaceId = randomUUID();
    const teamPrincipalId = randomUUID();
    const offerId = randomUUID();
    const mutationId = randomUUID();
    const itemId = randomUUID();
    const backendId = "explicit-team";
    const source = {
      kind: "captured_session" as const,
      sessionId,
      logicalMemoryId
    };
    const sourceCapabilities = [
      "lcm_rollups",
      "lcm_leaves",
      "memory_events",
      "curated_assertions"
    ] as const;
    const item = {
      id: itemId,
      representation: "lcm_leaves" as const,
      sequence: 1,
      occurredAt: instant,
      summaryText: "A reviewed summary of the chat.",
      lexicalAnchors: ["summary"],
      sourceCount: 1,
      sourceRevision: "source-revision-0001"
    };
    const manifest = [{ sourceId: itemId, revisionHash: hash }];
    const offer = {
      offerId,
      mutationId,
      expiresAt: instant,
      sessionId,
      workspaceProjectId,
      reason: "moved_in" as const,
      mappingRevision: 1,
      sourceRevision: 1,
      source,
      logicalMemoryId,
      sourceCapabilities,
      activationRepresentation: "lcm_leaves" as const,
      maximumFidelity: "lcm_leaves" as const,
      mode: "continuous" as const,
      includeCuratedMemory: false as const,
      candidateHash: hash,
      itemCount: 1,
      excludedItemCount: 0,
      manifest,
      byteCount: 80,
      candidateExpiresAt: instant
    };
    currentForWrite.mockResolvedValue({
      link: {
        ownerUserId: owner,
        teamBackendId: backendId,
        workspaceProjectId
      },
      context: { principalId: teamPrincipalId },
      policy: { teamId, workspaceId, ownerTeamMemberId: randomUUID() }
    });
    const events: string[] = [];
    const personal = {
      createExplicitProjectShareOffer: vi.fn(async () => offer),
      readExplicitProjectShareOffer: vi.fn(async () => ({
        ...offer,
        state: "prepared",
        teamPrincipalUserId: teamPrincipalId,
        deviceCredentialId: randomUUID(),
        remotePendingShareId: null,
        remoteShareGrantId: null,
        remoteGrantVersion: null
      })),
      settleExplicitProjectShareOffer: vi.fn(async () => ({
        state: "pending"
      })),
      explicitProjectShareOfferStatus: vi.fn(async () => ({
        offerId,
        mutationId,
        state: "absent"
      })),
      fenceExplicitProjectShareOffer: vi.fn(async () => ({ state: "fenced" }))
    };
    const directId = randomUUID();
    const nativeId = randomUUID();
    const review = {
      version: 1,
      title: "Share a summary of this chat?",
      description: "Project members can use this summary.",
      consequence: "The summary follows this exact chat consent.",
      confirmLabel: "Share summary",
      details: [{ label: "Project", value: "Study Project" }]
    };
    const grantStatus = (id: string, native: boolean, state: string) => ({
      version: 1,
      actionGrant: { id },
      approvalTier: native ? "native_review" : "direct",
      review: native ? review : null,
      state,
      activationUrl: null,
      expiresAt: instant
    });
    const candidate = {
      source,
      logicalMemoryId,
      sourceCapabilities,
      activationRepresentation: "lcm_leaves",
      mode: "continuous",
      expiresAt: instant,
      sourceRevision: 1,
      candidateHash: hash,
      itemCount: 1,
      excludedItemCount: 0,
      manifest,
      byteCount: 80,
      items: [item]
    };
    const preview = {
      source,
      logicalMemoryId,
      teamId,
      workspaceId,
      sourceCapabilities,
      activationRepresentation: "lcm_leaves",
      maximumFidelity: "lcm_leaves",
      includeCuratedMemory: false,
      mode: "continuous",
      previewRevision: 1,
      sourceRevision: 1,
      policyRevision: 1,
      contentPolicyVersion: 1,
      classifierVersion: 1,
      sourceContentHash: hash,
      previewHash: "b".repeat(64),
      itemCount: 1,
      items: [item],
      nextCursor: null
    };
    const pendingShare = {
      source,
      sourceCapabilities,
      id: randomUUID(),
      mutationId,
      logicalGrantId: randomUUID(),
      consentId: randomUUID(),
      logicalMemoryId,
      teamId,
      workspaceId,
      activationRepresentation: "lcm_leaves",
      maximumFidelity: "lcm_leaves",
      includeCuratedMemory: false,
      mode: "continuous",
      sourceRevision: 1,
      state: "preparing",
      stage: "accepted",
      workspaceAccessState: "none",
      sourceUpdateState: "preparing",
      operationVersion: 1,
      attemptCount: 0,
      redactedFailureCode: null,
      lastProgressAt: instant,
      createdAt: instant,
      updatedAt: instant,
      activatedAt: null,
      revokedAt: null,
      grantId: null,
      grantVersion: null
    };
    const sendCollaboration = vi.fn(
      async (command: {
        command: string;
        requestId: string;
        input: Record<string, unknown>;
      }) => {
        events.push(command.command);
        let data: unknown;
        if (command.command === "collaboration.preview_shared_memory_candidate")
          data = { candidate };
        else if (command.command === "collaboration.preview_shared_memory")
          data = { preview };
        else if (command.command === "collaboration.share_memory")
          data = {
            pendingShare: {
              ...pendingShare,
              logicalGrantId: command.input.logicalGrantId,
              consentId: command.input.consentId
            }
          };
        else {
          const intent = command.input.intent as
            | { intent?: string }
            | undefined;
          const native =
            intent?.intent === "collaboration.share_memory" ||
            (command.input.actionGrant as { id?: string } | undefined)?.id ===
              nativeId;
          const state =
            command.command === "collaboration.confirm_action_grant"
              ? approve
                ? "approved"
                : "canceled"
              : native
                ? "review_required"
                : "approved";
          data = {
            status: grantStatus(native ? nativeId : directId, native, state)
          };
        }
        return {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          ok: true,
          command: command.command,
          data
        };
      }
    );
    const confirmNative = vi.fn(async () => {
      events.push("Native review");
      return approve;
    });
    const service = createProjectSharePolicyService({
      identity: new AsyncLocalStorage<string>(),
      authority: async () => ({
        key: "current",
        ownerId: owner,
        apiOrigin: "http://localhost",
        authorization: "fixture",
        canWrite: true
      }),
      personal: personal as never,
      loadContext: async () => ({ state: "ready" }) as never,
      sendPolicy: async () => ({}),
      sendCollaboration: sendCollaboration as never,
      confirmNative: confirmNative as never
    });
    const context = {
      ownerId: owner,
      signal: new AbortController().signal,
      emitCollaborationEvent: () => undefined
    };
    const outcome = await service.runWithContext(context, () =>
      service.offerChat(projectId, sessionId, "moved_in")
    );
    return {
      outcome,
      events,
      confirmNative,
      personal,
      sendCollaboration,
      projectId,
      sessionId,
      offer
    };
  };

  it("uses a Direct candidate preview grant, then a separate Native Pending Share decision", async () => {
    const result = await run(true);
    expect(result.outcome).toEqual({ state: "pending" });
    expect(result.events).toEqual([
      "collaboration.preview_shared_memory_candidate",
      "collaboration.request_action_grant",
      "collaboration.await_action_grant",
      "collaboration.preview_shared_memory",
      "collaboration.request_action_grant",
      "Native review",
      "collaboration.await_action_grant",
      "collaboration.confirm_action_grant",
      "collaboration.share_memory"
    ]);
    expect(result.confirmNative).toHaveBeenCalledOnce();
    expect(
      result.personal.settleExplicitProjectShareOffer
    ).toHaveBeenCalledOnce();
    expect(result.sendCollaboration.mock.calls.at(-1)?.[0].input).toMatchObject(
      {
        workspaceProjectId: result.offer.workspaceProjectId,
        maximumFidelity: "lcm_leaves",
        includeCuratedMemory: false
      }
    );
  });

  it("fences a canceled Native Pending Share without dispatching it", async () => {
    const result = await run(false);
    expect(result.outcome).toEqual({ state: "canceled" });
    expect(result.events).not.toContain("collaboration.share_memory");
    expect(
      result.personal.fenceExplicitProjectShareOffer
    ).toHaveBeenCalledOnce();
  });
});
