import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationApprovalReviewSchema,
  collaborationCommandResultSchema,
  collaborationRendererCommandSchema,
  type CollaborationActionGrantIntent,
  type CollaborationActionGrantStatus,
  type CollaborationRendererCommand
} from "@koed/shared";
import { createProjectSharePolicyClient } from "./project-share-policy-client.js";
import type { ProjectPolicyPrepared } from "./project-share-policy-client.js";
import { createProjectSharePolicyFutureLoop } from "./project-share-policy-future-loop.js";
import { createProjectSharePolicyFutureSweep } from "./project-share-policy-future-sweep.js";
import type { createWorkspaceProjectPersonalClient } from "./workspace-project-personal-client.js";
import type {
  DesktopCommandContext,
  KoedServerManagerOptions
} from "./manager.js";
import type { ProjectsAuthority } from "./projects-client.js";
import type { WorkspaceProjectShareContext } from "@koed/shared/workspace-project-contract";
import type { PersonalDesktopSessionProjectInput } from "@koed/shared/personal-desktop";

type PersonalClient = ReturnType<typeof createWorkspaceProjectPersonalClient>;

export const requireDirectProjectCandidatePreviewGrant = async (input: {
  revalidate(): Promise<void>;
  request(): Promise<CollaborationActionGrantStatus>;
  read(id: string): Promise<CollaborationActionGrantStatus>;
  isCurrent(): boolean;
}): Promise<string> => {
  if (!input.isCurrent())
    throw new Error("Conversation summary window changed");
  await input.revalidate();
  const first = await input.request();
  if (
    first.approvalTier !== "direct" ||
    first.state !== "approved" ||
    first.review !== null
  )
    throw new Error("Conversation candidate preview approval changed");
  await input.revalidate();
  const current = await input.read(first.actionGrant.id);
  if (
    !input.isCurrent() ||
    current.actionGrant.id !== first.actionGrant.id ||
    current.approvalTier !== "direct" ||
    current.state !== "approved" ||
    current.review !== null
  )
    throw new Error("Conversation candidate preview grant changed");
  return first.actionGrant.id;
};

/** Fence every linked chat before the existing HQ107 move coordinator runs. */
export const createProjectSharePolicyMovePreflight = (input: {
  identity: AsyncLocalStorage<string>;
  personal: Pick<
    PersonalClient,
    | "linkedProject"
    | "reconcileProjectSharePolicyIssues"
    | "fenceUnpublishedProjectSharePolicyIssue"
  >;
}) => {
  const { identity, personal } = input;
  const beforeMove = async (
    request: PersonalDesktopSessionProjectInput,
    bound: ProjectsAuthority
  ) => {
    const personalProjectId = request.expectedProjectId;
    if (!personalProjectId || !z.uuid().safeParse(personalProjectId).success)
      return;
    await identity.run(bound.key, async () => {
      let link: Awaited<ReturnType<typeof personal.linkedProject>>;
      try {
        link = await personal.linkedProject(personalProjectId);
      } catch (error) {
        if ((error as { statusCode?: unknown }).statusCode === 404) return;
        throw error;
      }
      if (link.ownerUserId !== bound.ownerId)
        throw new Error("Conversation move owner Project changed");
      for (let race = 0; race < 3; race++) {
        let cursor: string | undefined;
        let activationRaced = false;
        for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
          const page = await personal.reconcileProjectSharePolicyIssues(
            personalProjectId,
            link.teamBackendId,
            link.workspaceProjectId,
            cursor,
            request.sessionId
          );
          if (page.pending > 0 || !page.hasMore) {
            const fence =
              await personal.fenceUnpublishedProjectSharePolicyIssue(
                personalProjectId,
                link.teamBackendId,
                link.workspaceProjectId,
                request.sessionId
              );
            if (fence.state === "settled" || fence.state === "frozen") return;
            activationRaced = true;
            break;
          }
          if (!page.nextCursor || page.nextCursor === cursor)
            throw new Error("Conversation summary issue cursor changed");
          cursor = page.nextCursor;
        }
        if (!activationRaced)
          throw new Error(
            "Conversation summary issues need another reconciliation pass"
          );
      }
      throw new Error("Conversation summary activation raced with move; retry");
    });
  };
  return beforeMove;
};

/** Release only an exact, acknowledged fence after HQ107 proves cancellation. */
export const createProjectSharePolicyMoveFenceRelease =
  (input: {
    identity: AsyncLocalStorage<string>;
    authority: () => Promise<ProjectsAuthority>;
    currentForWrite: (projectId: string) => Promise<{
      link: {
        ownerUserId: string;
        teamBackendId: string;
        workspaceProjectId: string;
      };
      context: { principalId: string | null };
    }>;
    personal: Pick<
      PersonalClient,
      | "currentUnpublishedProjectSharePolicyFence"
      | "releaseUnpublishedProjectSharePolicyFence"
    >;
  }) =>
  async (request: {
    sessionId: string;
    oldProjectId: string;
    mappingVersion: number;
  }): Promise<void> => {
    const bound = await input.authority();
    if (!bound.canWrite)
      throw new Error("Conversation move write authority is unavailable");
    await input.identity.run(bound.key, async () => {
      let before: Awaited<ReturnType<typeof input.currentForWrite>>;
      try {
        before = await input.currentForWrite(request.oldProjectId);
      } catch (error) {
        if ((error as { statusCode?: unknown }).statusCode === 404) return;
        throw error;
      }
      if (before.link.ownerUserId !== bound.ownerId)
        throw new Error("Conversation move owner Project changed");
      const fence =
        await input.personal.currentUnpublishedProjectSharePolicyFence(
          request.oldProjectId,
          before.link.teamBackendId,
          before.link.workspaceProjectId,
          request.sessionId
        );
      if (fence.state === "none") return;
      if (
        fence.state !== "acknowledged" ||
        fence.mappingRevision !== request.mappingVersion
      )
        throw new Error("Conversation move summary fence changed");
      const current = await input.currentForWrite(request.oldProjectId);
      if (
        current.link.ownerUserId !== before.link.ownerUserId ||
        current.link.teamBackendId !== before.link.teamBackendId ||
        current.link.workspaceProjectId !== before.link.workspaceProjectId ||
        current.context.principalId !== before.context.principalId ||
        (await input.authority()).key !== bound.key
      )
        throw new Error("Conversation move summary authority changed");
      await input.personal.releaseUnpublishedProjectSharePolicyFence(
        request.oldProjectId,
        before.link.teamBackendId,
        before.link.workspaceProjectId,
        request.sessionId,
        fence.fenceId
      );
    });
  };

export const knownCanceledProjectMove = (input: {
  confirmedCancel: boolean;
  reservation: {
    sessionId: string;
    batchId: string;
    oldProjectId: string;
  } | null;
  status: {
    sessionId: string;
    batchId: string;
    complete: boolean;
    pending: boolean;
    pendingReviews: unknown[];
    projectId: string | null;
  };
}): boolean =>
  input.confirmedCancel &&
  input.reservation !== null &&
  input.status.sessionId === input.reservation.sessionId &&
  input.status.batchId === input.reservation.batchId &&
  input.status.complete &&
  !input.status.pending &&
  input.status.pendingReviews.length === 0 &&
  input.status.projectId === input.reservation.oldProjectId;

/** Owns Project policy effects inside the trusted Desktop/main boundary. */
export const createProjectSharePolicyService = (input: {
  identity: AsyncLocalStorage<string>;
  authority: () => Promise<ProjectsAuthority>;
  futureEligible?: () => boolean;
  personal: PersonalClient;
  loadContext: () => Promise<WorkspaceProjectShareContext>;
  sendPolicy: (
    teamBackendId: string,
    path: string,
    init?: RequestInit
  ) => Promise<unknown>;
  sendCollaboration: (
    command: CollaborationRendererCommand,
    context: DesktopCommandContext
  ) => Promise<unknown>;
  confirmNative: KoedServerManagerOptions["confirmProjectSharePolicy"];
}) => {
  const {
    identity,
    authority,
    personal,
    loadContext,
    sendPolicy,
    sendCollaboration,
    confirmNative
  } = input;
  const projectPolicySender = new AsyncLocalStorage<DesktopCommandContext>();
  const projectSharePolicy = createProjectSharePolicyClient({
    loadContext: loadContext,
    loadLink: personal.linkedProject,
    loadManifest: personal.projectSharePolicyManifest,
    loadLocalState: personal.projectSharePolicyLocalState,
    startAttempt: personal.startProjectSharePolicyAttempt,
    pendingAttempts: personal.pendingProjectSharePolicyAttempts,
    finalizeAttempt: personal.finalizeProjectSharePolicyAttempt,
    sendPolicy: sendPolicy,
    consumeLocal: personal.consumeProjectSharePolicy,
    prepareInitialSource: async (ownerUserId, teamBackendId, sessionId) => {
      const context = projectPolicySender.getStore();
      if (!context || context.signal.aborted || context.ownerId !== ownerUserId)
        throw new Error("Project summary sharing window changed");
      const before = await loadContext();
      if (
        before.state !== "ready" ||
        before.backendId !== teamBackendId ||
        !before.principalId
      )
        throw new Error("Project summary sharing Team authority changed");
      const command = collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.prepare_shared_memory_source",
        input: { sessionId, consentedAt: new Date().toISOString() }
      });
      const result = collaborationCommandResultSchema.parse(
        await sendCollaboration(command, context)
      );
      if (
        context.signal.aborted ||
        !result.ok ||
        result.requestId !== command.requestId ||
        result.command !== "collaboration.prepare_shared_memory_source" ||
        result.data.entry.id !== sessionId
      )
        throw new Error("Project summary sharing source preparation failed");
      const after = await loadContext();
      if (
        after.state !== "ready" ||
        after.backendId !== teamBackendId ||
        after.principalId !== before.principalId
      )
        throw new Error("Project summary sharing Team authority changed");
    },
    stageLocal: personal.stageInitialProjectSharePolicy
  });
  const futurePolicySweep = createProjectSharePolicyFutureSweep({
    list: (cursor, signal) =>
      personal.activeProjectSharePolicies(cursor, signal),
    reconcileIssues: async (selected, cursor, signal) => {
      if (signal.aborted)
        throw new Error("Project policy reconciliation stopped");
      const before = await projectSharePolicy.currentForIssue(
        selected.projectId
      );
      const same = (current: typeof before) =>
        current.link.ownerUserId === before.link.ownerUserId &&
        current.link.teamBackendId === selected.teamBackendId &&
        current.link.workspaceProjectId === selected.workspaceProjectId &&
        current.context.principalId === before.context.principalId &&
        current.policy.projectId === selected.workspaceProjectId &&
        current.policy.status === "active" &&
        current.policy.policyVersion === selected.policyVersion &&
        current.policy.policyId === before.policy.policyId;
      if (!same(before))
        throw new Error("Project policy reconciliation authority changed");
      const page = await personal.reconcileProjectSharePolicyIssues(
        selected.projectId,
        selected.teamBackendId,
        selected.workspaceProjectId,
        cursor,
        undefined,
        signal
      );
      if (
        signal.aborted ||
        !same(await projectSharePolicy.currentForIssue(selected.projectId))
      )
        throw new Error("Project policy reconciliation authority changed");
      return page;
    },
    stage: async (selected, cursor, signal) => {
      if (signal.aborted)
        throw new Error("Project policy reconciliation stopped");
      const before = await projectSharePolicy.currentForIssue(
        selected.projectId
      );
      const matches = (current: typeof before) =>
        current.link.ownerUserId === before.link.ownerUserId &&
        current.link.teamBackendId === selected.teamBackendId &&
        current.link.workspaceProjectId === selected.workspaceProjectId &&
        current.policy.projectId === selected.workspaceProjectId &&
        current.policy.status === "active" &&
        current.policy.policyId !== null &&
        current.policy.policyVersion === selected.policyVersion &&
        current.context.principalId === before.context.principalId &&
        current.policy.policyId === before.policy.policyId &&
        current.policy.ownerTeamMemberId === before.policy.ownerTeamMemberId &&
        current.policy.teamId === before.policy.teamId &&
        current.policy.workspaceId === before.policy.workspaceId;
      if (!matches(before) || signal.aborted)
        throw new Error("Project policy reconciliation authority changed");
      const candidates = await personal.futureProjectShareSourceCandidates(
        selected.projectId,
        selected.teamBackendId,
        selected.workspaceProjectId,
        selected.policyVersion,
        cursor,
        signal
      );
      if (
        signal.aborted ||
        !matches(await projectSharePolicy.currentForIssue(selected.projectId))
      )
        throw new Error("Project policy reconciliation authority changed");
      for (const source of candidates.entries) {
        if (
          signal.aborted ||
          !matches(await projectSharePolicy.currentForIssue(selected.projectId))
        )
          throw new Error("Project policy reconciliation authority changed");
        const command = collaborationRendererCommandSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: randomUUID(),
          command: "collaboration.prepare_shared_memory_source",
          input: {
            sessionId: source.sessionId,
            consentedAt: new Date().toISOString()
          }
        });
        const result = collaborationCommandResultSchema.parse(
          await sendCollaboration(command, {
            ownerId: before.link.ownerUserId,
            signal,
            emitCollaborationEvent: () => undefined
          })
        );
        if (
          signal.aborted ||
          !result.ok ||
          result.requestId !== command.requestId ||
          result.command !== "collaboration.prepare_shared_memory_source" ||
          result.data.entry.id !== source.sessionId ||
          !matches(await projectSharePolicy.currentForIssue(selected.projectId))
        )
          throw new Error("Project policy future source preparation changed");
      }
      const page = await personal.reconcileFutureProjectSharePolicy(
        selected.projectId,
        selected.teamBackendId,
        selected.workspaceProjectId,
        selected.policyVersion,
        candidates.entries,
        cursor,
        signal
      );
      if (
        signal.aborted ||
        !matches(await projectSharePolicy.currentForIssue(selected.projectId))
      )
        throw new Error("Project policy reconciliation authority changed");
      return page;
    }
  });
  const futurePolicyLoop = createProjectSharePolicyFutureLoop({
    eligible: input.futureEligible,
    authority: async () => {
      const bound = await authority();
      return bound.canWrite ? bound.key : null;
    },
    reconcile: (key, signal) =>
      identity.run(key, () => futurePolicySweep.reconcile(key, signal))
  });
  const projectPolicyGrantCommand = async (
    commandName:
      | "collaboration.request_action_grant"
      | "collaboration.await_action_grant"
      | "collaboration.confirm_action_grant",
    input: Record<string, unknown>
  ) => {
    const context = projectPolicySender.getStore();
    if (!context || context.signal.aborted)
      throw new Error("Project summary sharing window changed");
    const command = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: commandName,
      input
    });
    const result = collaborationCommandResultSchema.parse(
      await sendCollaboration(command, context)
    );
    if (
      context.signal.aborted ||
      !result.ok ||
      result.command !== commandName ||
      !("status" in result.data)
    )
      throw new Error(
        "Project summary sharing requires current Team device authority"
      );
    return result.data.status;
  };
  const reviewProjectPolicyGrant = async (
    intent: CollaborationActionGrantIntent,
    revalidate: () => Promise<void>,
    expectedSources?: ProjectPolicyPrepared["review"]["reviewSources"]
  ): Promise<string> => {
    const context = projectPolicySender.getStore();
    if (!context || context.signal.aborted || !confirmNative)
      throw new Error("Project summary sharing Native review is unavailable");
    const first = await projectPolicyGrantCommand(
      "collaboration.request_action_grant",
      { intent }
    );
    if (
      first.approvalTier !== "native_review" ||
      first.state !== "review_required" ||
      !first.review
    )
      throw new Error("Project summary sharing Native review is unavailable");
    const review = collaborationApprovalReviewSchema.parse(first.review);
    if (
      expectedSources &&
      JSON.stringify(review.reviewSources ?? []) !==
        JSON.stringify(expectedSources)
    )
      throw new Error("Project summary sharing Native review sources changed");
    await revalidate();
    const accepted = await confirmNative(review, context);
    if (context.signal.aborted)
      throw new Error("Project summary sharing window changed");
    const current = await projectPolicyGrantCommand(
      "collaboration.await_action_grant",
      { actionGrant: first.actionGrant }
    );
    if (
      current.actionGrant.id !== first.actionGrant.id ||
      current.state !== "review_required" ||
      current.approvalTier !== "native_review" ||
      JSON.stringify(current.review) !== JSON.stringify(review)
    )
      throw new Error("Project summary sharing review changed");
    await revalidate();
    const confirmed = await projectPolicyGrantCommand(
      "collaboration.confirm_action_grant",
      {
        actionGrant: first.actionGrant,
        decision: accepted ? "approve" : "cancel"
      }
    );
    if (
      confirmed.actionGrant.id !== first.actionGrant.id ||
      confirmed.state !== (accepted ? "approved" : "canceled")
    )
      throw new Error("Project summary sharing decision was not acknowledged");
    if (!accepted) throw new Error("Project summary sharing was canceled.");
    return first.actionGrant.id;
  };
  const directProjectCandidatePreviewGrant = async (
    intent: Extract<
      CollaborationActionGrantIntent,
      { intent: "collaboration.preview_shared_memory" }
    >,
    revalidate: () => Promise<void>
  ): Promise<string> => {
    const context = projectPolicySender.getStore();
    if (!context || context.signal.aborted)
      throw new Error("Conversation summary window changed");
    return requireDirectProjectCandidatePreviewGrant({
      revalidate,
      request: () =>
        projectPolicyGrantCommand("collaboration.request_action_grant", {
          intent
        }),
      read: (id) =>
        projectPolicyGrantCommand("collaboration.await_action_grant", {
          actionGrant: { id }
        }),
      isCurrent: () => !context.signal.aborted
    });
  };
  const assertPreparedPolicy = async (
    personalProjectId: string,
    prepared: Awaited<ReturnType<typeof projectSharePolicy.prepareEnable>>
  ) => {
    const current = await projectSharePolicy.currentManifest(
      personalProjectId,
      prepared.link
    );
    if (
      current.context.principalId !== prepared.context.principalId ||
      current.policy.teamId !== prepared.policy.teamId ||
      current.policy.workspaceId !== prepared.policy.workspaceId ||
      current.policy.ownerTeamMemberId !== prepared.policy.ownerTeamMemberId ||
      current.policy.policyId !== prepared.policy.policyId ||
      current.policy.policyVersion !== prepared.policy.policyVersion ||
      current.policy.status !== prepared.policy.status ||
      current.manifest.personalProjectBindingHash !==
        prepared.manifest.personalProjectBindingHash ||
      current.manifest.deviceCredentialId !==
        prepared.manifest.deviceCredentialId ||
      current.manifest.signingPublicKey !==
        prepared.manifest.signingPublicKey ||
      JSON.stringify(current.manifest.entries) !==
        JSON.stringify(prepared.manifest.entries) ||
      Date.parse(prepared.receipt.expiresAt) <= Date.now()
    )
      throw new Error("Project summary sharing review expired or changed");
    const currentReview = await projectSharePolicy.reviewedManifest(
      prepared.link,
      current.policy,
      current.manifest,
      prepared.receipt
    );
    if (JSON.stringify(currentReview) !== JSON.stringify(prepared.review))
      throw new Error("Project summary sharing Native review changed");
  };
  const enableProjectPolicy = async (personalProjectId: string) => {
    const prepared = await projectSharePolicy.prepareEnable(personalProjectId);
    const intent = {
      intent: "collaboration.project_share_policy_enable" as const,
      commandRequestId: randomUUID(),
      teamId: prepared.policy.teamId,
      projectId: prepared.link.workspaceProjectId,
      expectedPolicyVersion: prepared.policy.policyVersion,
      manifestId: prepared.receipt.manifestId,
      manifestHash: prepared.receipt.manifestHash
    };
    const grantId = await reviewProjectPolicyGrant(
      intent,
      () => assertPreparedPolicy(personalProjectId, prepared),
      prepared.review.reviewSources
    );
    return projectSharePolicy.enable(
      personalProjectId,
      prepared,
      intent,
      grantId
    );
  };
  const revokeProjectPolicy = async (personalProjectId: string) => {
    const prepared = await projectSharePolicy.prepareRevoke(personalProjectId);
    const intent = {
      intent: "collaboration.project_share_policy_revoke" as const,
      commandRequestId: randomUUID(),
      teamId: prepared.policy.teamId,
      projectId: prepared.link.workspaceProjectId,
      expectedPolicyVersion: prepared.policy.policyVersion
    };
    const grantId = await reviewProjectPolicyGrant(intent, async () => {
      const current = await projectSharePolicy.prepareRevoke(personalProjectId);
      if (
        current.link.ownerUserId !== prepared.link.ownerUserId ||
        current.link.teamBackendId !== prepared.link.teamBackendId ||
        current.link.workspaceProjectId !== prepared.link.workspaceProjectId ||
        current.principalId !== prepared.principalId ||
        current.policy.teamId !== prepared.policy.teamId ||
        current.policy.workspaceId !== prepared.policy.workspaceId ||
        current.policy.policyVersion !== prepared.policy.policyVersion
      )
        throw new Error("Project summary sharing review changed");
    });
    return projectSharePolicy.revoke(
      personalProjectId,
      prepared,
      intent,
      grantId
    );
  };
  const makeProjectPolicySessionPrivate = async (
    personalProjectId: string,
    sessionId: string
  ) => {
    const initial = await projectSharePolicy.currentForWrite(personalProjectId);
    const invoke = () =>
      personal.makeProjectSharePolicySessionPrivate(
        personalProjectId,
        initial.link.teamBackendId,
        initial.link.workspaceProjectId,
        sessionId
      );
    const first = await invoke();
    if (first.state === "private") return { state: "private" as const };
    const target = first.withdrawalTarget;
    const revalidate = async () => {
      const current =
        await projectSharePolicy.currentForWrite(personalProjectId);
      if (
        current.link.ownerUserId !== initial.link.ownerUserId ||
        current.link.teamBackendId !== initial.link.teamBackendId ||
        current.link.workspaceProjectId !== initial.link.workspaceProjectId ||
        current.context.principalId !== initial.context.principalId ||
        current.policy.teamId !== initial.policy.teamId ||
        current.policy.workspaceId !== initial.policy.workspaceId
      )
        throw new Error("Project summary sharing freeze authority changed");
      const fresh = await invoke();
      if (
        fresh.state !== "freeze_required" ||
        fresh.withdrawalTarget.shareGrantId !== target.shareGrantId ||
        fresh.withdrawalTarget.grantVersion !== target.grantVersion
      )
        throw new Error("Project summary sharing freeze target changed");
    };
    const mutationId = randomUUID();
    const intent = {
      intent: "collaboration.freeze_shared_memory_grant" as const,
      commandRequestId: randomUUID(),
      mutationId,
      teamId: initial.policy.teamId,
      workspaceId: initial.policy.workspaceId,
      shareGrantId: target.shareGrantId,
      expectedGrantVersion: target.grantVersion
    };
    const grantId = await reviewProjectPolicyGrant(intent, revalidate);
    await revalidate();
    const context = projectPolicySender.getStore();
    if (!context || context.signal.aborted)
      throw new Error("Project summary sharing window changed");
    const command = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: intent.commandRequestId,
      command: "collaboration.freeze_shared_memory_grant",
      input: {
        mutationId,
        teamId: intent.teamId,
        workspaceId: intent.workspaceId,
        shareGrantId: target.shareGrantId,
        expectedGrantVersion: target.grantVersion,
        actionGrant: { id: grantId }
      }
    });
    const result = collaborationCommandResultSchema.parse(
      await sendCollaboration(command, context)
    );
    if (
      context.signal.aborted ||
      !result.ok ||
      result.command !== "collaboration.freeze_shared_memory_grant" ||
      result.data.grant.id !== target.shareGrantId ||
      result.data.grant.lifecycle !== "active" ||
      !result.data.grant.frozenAt ||
      result.data.grant.grantVersion <= target.grantVersion
    )
      throw new Error("Project summary sharing freeze was not acknowledged");
    const completed = await invoke();
    if (completed.state !== "private")
      throw new Error(
        "Project summary sharing freeze still requires attention"
      );
    return completed;
  };
  const projectPolicySessionStatus = async (
    personalProjectId: string,
    sessionId: string
  ) => {
    const before = await projectSharePolicy.currentForRead(personalProjectId);
    const result = await personal.projectSharePolicySessionStatus(
      personalProjectId,
      before.link.teamBackendId,
      before.link.workspaceProjectId,
      sessionId
    );
    const after = await projectSharePolicy.currentForRead(personalProjectId);
    if (
      after.link.ownerUserId !== before.link.ownerUserId ||
      after.link.teamBackendId !== before.link.teamBackendId ||
      after.link.workspaceProjectId !== before.link.workspaceProjectId ||
      after.context.principalId !== before.context.principalId ||
      after.policy.policyId !== before.policy.policyId ||
      after.policy.policyVersion !== before.policy.policyVersion
    )
      throw new Error("Project chat sharing status authority changed");
    return result.state;
  };
  const offerProjectChat = async (
    personalProjectId: string,
    sessionId: string,
    reason: "moved_in" | "share_again"
  ): Promise<{ state: "pending" | "activated" | "canceled" }> => {
    const initial = await projectSharePolicy.currentForWrite(personalProjectId);
    const offer = await personal.createExplicitProjectShareOffer(
      personalProjectId,
      initial.link.teamBackendId,
      initial.link.workspaceProjectId,
      sessionId,
      reason
    );
    const exactOffer = async () => {
      const current =
        await projectSharePolicy.currentForWrite(personalProjectId);
      if (
        current.link.ownerUserId !== initial.link.ownerUserId ||
        current.link.teamBackendId !== initial.link.teamBackendId ||
        current.link.workspaceProjectId !== initial.link.workspaceProjectId ||
        current.context.principalId !== initial.context.principalId ||
        current.policy.teamId !== initial.policy.teamId ||
        current.policy.workspaceId !== initial.policy.workspaceId ||
        current.policy.ownerTeamMemberId !== initial.policy.ownerTeamMemberId
      )
        throw new Error("Conversation summary offer authority changed");
      const fresh = await personal.readExplicitProjectShareOffer(
        personalProjectId,
        offerIdBackend,
        offer.offerId
      );
      if (
        fresh.offerId !== offer.offerId ||
        fresh.mutationId !== offer.mutationId ||
        fresh.sessionId !== sessionId ||
        fresh.workspaceProjectId !== initial.link.workspaceProjectId ||
        fresh.reason !== reason ||
        fresh.mappingRevision !== offer.mappingRevision ||
        fresh.sourceRevision !== offer.sourceRevision ||
        fresh.logicalMemoryId !== offer.logicalMemoryId ||
        fresh.candidateHash !== offer.candidateHash ||
        fresh.itemCount !== offer.itemCount ||
        fresh.excludedItemCount !== offer.excludedItemCount ||
        fresh.byteCount !== offer.byteCount ||
        fresh.candidateExpiresAt !== offer.candidateExpiresAt ||
        JSON.stringify(fresh.manifest) !== JSON.stringify(offer.manifest) ||
        JSON.stringify(fresh.sourceCapabilities) !==
          JSON.stringify(offer.sourceCapabilities) ||
        fresh.teamPrincipalUserId !== initial.context.principalId ||
        JSON.stringify(fresh.source) !== JSON.stringify(offer.source)
      )
        throw new Error(
          "Conversation summary offer changed before Native review"
        );
      return fresh;
    };
    const offerIdBackend = initial.link.teamBackendId;
    const send = async (
      commandName: CollaborationRendererCommand["command"],
      requestId: string,
      commandInput: unknown
    ) => {
      const context = projectPolicySender.getStore();
      if (!context || context.signal.aborted)
        throw new Error("Conversation summary window changed");
      const command = collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId,
        command: commandName,
        input: commandInput
      });
      const result = collaborationCommandResultSchema.parse(
        await sendCollaboration(command, context)
      );
      if (
        context.signal.aborted ||
        !result.ok ||
        result.command !== commandName
      )
        throw new Error("Conversation summary Team result is unavailable");
      return result;
    };
    let shareDispatched = false;
    try {
      await exactOffer();
      const candidateResult = await send(
        "collaboration.preview_shared_memory_candidate",
        randomUUID(),
        {
          source: offer.source,
          activationRepresentation: "lcm_leaves",
          mode: "continuous"
        }
      );
      if (
        candidateResult.command !==
        "collaboration.preview_shared_memory_candidate"
      )
        throw new Error("Conversation summary candidate is unavailable");
      const candidate = candidateResult.data.candidate;
      if (
        JSON.stringify(candidate.source) !== JSON.stringify(offer.source) ||
        candidate.logicalMemoryId !== offer.logicalMemoryId ||
        candidate.sourceRevision !== offer.sourceRevision ||
        candidate.candidateHash !== offer.candidateHash ||
        candidate.activationRepresentation !== "lcm_leaves" ||
        candidate.mode !== "continuous" ||
        JSON.stringify(candidate.sourceCapabilities) !==
          JSON.stringify(offer.sourceCapabilities) ||
        candidate.itemCount !== offer.itemCount ||
        candidate.excludedItemCount !== offer.excludedItemCount ||
        candidate.byteCount !== offer.byteCount ||
        candidate.expiresAt !== offer.candidateExpiresAt ||
        JSON.stringify(candidate.manifest) !== JSON.stringify(offer.manifest) ||
        candidate.itemCount < 1
      )
        throw new Error("Conversation summary candidate changed");
      const candidateBinding = {
        source: candidate.source,
        sourceCapabilities: offer.sourceCapabilities,
        activationRepresentation: offer.activationRepresentation,
        candidateHash: offer.candidateHash,
        sourceRevision: offer.sourceRevision,
        itemCount: offer.itemCount,
        excludedItemCount: offer.excludedItemCount,
        manifest: offer.manifest,
        byteCount: offer.byteCount,
        mode: offer.mode,
        expiresAt: offer.candidateExpiresAt
      };
      const previewInput = {
        source: offer.source,
        logicalMemoryId: offer.logicalMemoryId,
        teamId: initial.policy.teamId,
        workspaceId: initial.policy.workspaceId,
        sourceCapabilities: offer.sourceCapabilities,
        activationRepresentation: offer.activationRepresentation,
        maximumFidelity: offer.maximumFidelity,
        includeCuratedMemory: false as const,
        mode: "continuous" as const,
        candidate: candidateBinding
      };
      const previewRequestId = randomUUID();
      const previewGrantId = await directProjectCandidatePreviewGrant(
        {
          intent: "collaboration.preview_shared_memory",
          commandRequestId: previewRequestId,
          ...previewInput
        },
        async () => {
          await exactOffer();
        }
      );
      await exactOffer();
      const previewResult = await send(
        "collaboration.preview_shared_memory",
        previewRequestId,
        { ...previewInput, actionGrant: { id: previewGrantId } }
      );
      if (previewResult.command !== "collaboration.preview_shared_memory")
        throw new Error("Conversation summary preview is unavailable");
      const preview = previewResult.data.preview;
      if (
        JSON.stringify(preview.source) !== JSON.stringify(offer.source) ||
        preview.logicalMemoryId !== offer.logicalMemoryId ||
        preview.teamId !== initial.policy.teamId ||
        preview.workspaceId !== initial.policy.workspaceId ||
        preview.sourceRevision !== offer.sourceRevision ||
        preview.mode !== "continuous" ||
        preview.activationRepresentation !== "lcm_leaves" ||
        preview.maximumFidelity !== "lcm_leaves" ||
        preview.includeCuratedMemory !== false ||
        JSON.stringify(preview.sourceCapabilities) !==
          JSON.stringify(offer.sourceCapabilities)
      )
        throw new Error("Conversation summary preview changed");
      const shareRequestId = randomUUID();
      const shareInput = {
        source: offer.source,
        sourceCapabilities: offer.sourceCapabilities,
        activationRepresentation: offer.activationRepresentation,
        mutationId: offer.mutationId,
        logicalGrantId: randomUUID(),
        consentId: randomUUID(),
        logicalMemoryId: offer.logicalMemoryId,
        teamId: initial.policy.teamId,
        workspaceId: initial.policy.workspaceId,
        workspaceProjectId: initial.link.workspaceProjectId,
        mode: "continuous" as const,
        maximumFidelity: "lcm_leaves" as const,
        includeCuratedMemory: false as const,
        previewRevision: preview.previewRevision,
        previewHash: preview.previewHash,
        expiresAt: null
      };
      const shareGrantId = await reviewProjectPolicyGrant(
        {
          intent: "collaboration.share_memory",
          commandRequestId: shareRequestId,
          ...shareInput
        },
        async () => {
          await exactOffer();
        }
      );
      await exactOffer();
      shareDispatched = true;
      const shareResult = await send(
        "collaboration.share_memory",
        shareRequestId,
        {
          ...shareInput,
          actionGrant: { id: shareGrantId }
        }
      );
      if (shareResult.command !== "collaboration.share_memory")
        throw new Error("Conversation summary Pending Share is unavailable");
      const pending =
        "pendingShare" in shareResult.data
          ? shareResult.data.pendingShare
          : null;
      if (
        !pending ||
        pending.mutationId !== offer.mutationId ||
        pending.logicalMemoryId !== offer.logicalMemoryId ||
        pending.teamId !== initial.policy.teamId ||
        pending.workspaceId !== initial.policy.workspaceId
      )
        throw new Error("Conversation summary Pending Share receipt changed");
      const settled = await personal.settleExplicitProjectShareOffer(
        personalProjectId,
        offerIdBackend,
        offer.offerId
      );
      return {
        state: settled.state === "activated" ? "activated" : "pending"
      };
    } catch (error) {
      if (shareDispatched) {
        try {
          const status = await personal.explicitProjectShareOfferStatus(
            personalProjectId,
            offerIdBackend,
            offer.offerId
          );
          if (
            status.offerId !== offer.offerId ||
            status.mutationId !== offer.mutationId
          )
            throw new Error("Conversation summary attempt changed", {
              cause: error
            });
          if (status.state === "pending" || status.state === "activated") {
            const settled = await personal.settleExplicitProjectShareOffer(
              personalProjectId,
              offerIdBackend,
              offer.offerId
            );
            return {
              state: settled.state === "activated" ? "activated" : "pending"
            };
          }
        } catch {
          return { state: "pending" };
        }
      }
      const fenced = await personal.fenceExplicitProjectShareOffer(
        personalProjectId,
        offerIdBackend,
        offer.offerId
      );
      if (fenced.state === "activation_race") return { state: "pending" };
      if (
        error instanceof Error &&
        error.message === "Project summary sharing was canceled."
      )
        return { state: "canceled" };
      throw error;
    }
  };
  const beforeMove = createProjectSharePolicyMovePreflight({
    identity,
    personal
  });
  const releaseCanceledMoveFence = createProjectSharePolicyMoveFenceRelease({
    identity,
    authority,
    currentForWrite: projectSharePolicy.currentForWrite,
    personal
  });
  return {
    policy: projectSharePolicy,
    futureLoop: futurePolicyLoop,
    futureSweep: futurePolicySweep,
    runWithContext: <T>(context: DesktopCommandContext, fn: () => T) =>
      projectPolicySender.run(context, fn),
    enable: enableProjectPolicy,
    revoke: revokeProjectPolicy,
    makePrivate: makeProjectPolicySessionPrivate,
    sessionStatus: projectPolicySessionStatus,
    offerChat: offerProjectChat,
    beforeMove,
    releaseCanceledMoveFence
  };
};
