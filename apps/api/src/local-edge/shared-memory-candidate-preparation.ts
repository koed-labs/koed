import type { MemorySourceRepository } from "@koed/db";
import { structuredLcmSummarySchema } from "@koed/core";
import {
  classifyApprovalActivity,
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest,
  personalNoteSourceRevisionHash,
  type SharedMemoryCandidatePreview,
  type SharedMemoryRepresentation,
  type SharedMemorySourceItem
} from "@koed/shared";

type LocalLcmRepresentation = Extract<
  SharedMemoryRepresentation,
  "lcm_leaves" | "lcm_rollups"
>;

export const prepareLocalLcmCandidateRepresentation = async (input: {
  repository: Pick<MemorySourceRepository, "createLcmNodes">;
  ownerUserId: string;
  sessionId: string;
  representation: LocalLcmRepresentation;
}): Promise<void> => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const compaction = await input.repository.createLcmNodes(
      { userId: input.ownerUserId },
      {
        visibility: "personal",
        sessionId: input.sessionId,
        force: true,
        requestedRepresentation: input.representation
      }
    );
    if (
      compaction.leafNodeIds.length === 0 &&
      compaction.rollupNodeId === null
    ) {
      return;
    }
  }
  throw new Error("Share-bound LCM compaction exceeded its bounded work limit");
};

type CandidateRepository = Pick<
  MemorySourceRepository,
  | "createLcmNodes"
  | "getSharedMemoryLcmSyncState"
  | "getLocalSyncDeployment"
  | "getPersonalNoteRevisionMemoryEvent"
  | "listCuratedMemoryAssertions"
  | "listLcmGraphEvents"
  | "listLcmGraphNodes"
  | "listLcmGraphThreads"
  | "listCapturedSessionSyncEligibleLcmNodeIds"
  | "prepareCapturedSessionSyncCandidateRevision"
>;

export type PersonalNoteCandidatePreparationStage =
  | "memory_event"
  | "deployment_identity"
  | "source_validation"
  | "source_identity"
  | "revision_hash"
  | "item_serialization"
  | "candidate_hash";

export class PersonalNoteCandidatePreparationError extends Error {
  readonly candidateStage: PersonalNoteCandidatePreparationStage;

  constructor(
    candidateStage: PersonalNoteCandidatePreparationStage,
    cause: unknown
  ) {
    super("Personal Note candidate preparation failed", { cause });
    this.name = "PersonalNoteCandidatePreparationError";
    this.candidateStage = candidateStage;
  }
}

export const createLocalSharedMemoryCandidatePreparation = (options: {
  repository: CandidateRepository;
  resolveDeploymentId: () => string | null;
  requestLcmSummaryWork: () => Promise<void>;
}) => {
  const resolveCandidateSourceIdentity = (
    localOwnerUserId: string
  ): {
    sourceDeploymentProtocolId: string;
    sourceOwnerPrincipalId: string;
  } | null => {
    const sourceDeploymentProtocolId = options.resolveDeploymentId();
    return sourceDeploymentProtocolId
      ? {
          sourceDeploymentProtocolId,
          sourceOwnerPrincipalId: localOwnerUserId
        }
      : null;
  };

  const loadCandidatePreview = async (input: {
    localOwnerUserId: string;
    sessionId: string;
    representation: SharedMemoryRepresentation;
    mode: "snapshot" | "continuous";
  }): Promise<SharedMemoryCandidatePreview | null> => {
    const projects = await options.repository.listLcmGraphThreads(
      { userId: input.localOwnerUserId },
      { limit: 500, includeInvalidated: false }
    );
    const thread = projects
      .flatMap((project) => project.threads)
      .find((candidate) => candidate.sessionId === input.sessionId);
    if (!thread) return null;

    const deploymentId = options.resolveDeploymentId();
    if (!deploymentId) return null;
    const logicalMemoryId = crossIdentitySyncDeterministicUuid({
      protocol: "koed.captured-session-sync/v1",
      sourceDeploymentId: deploymentId,
      sourceUserId: input.localOwnerUserId,
      originSessionId: input.sessionId,
      identity: "logical-memory"
    });
    const maximumItems = 100;
    const maximumBytes = 256 * 1_024;
    const items: SharedMemorySourceItem[] = [];
    let excludedItemCount = 0;
    let byteCount = 0;
    let consentBoundaryExceeded = false;
    const sourceRevision =
      await options.repository.prepareCapturedSessionSyncCandidateRevision(
        { userId: input.localOwnerUserId },
        input.sessionId
      );
    if (sourceRevision === null) return null;

    const append = (item: SharedMemorySourceItem) => {
      if (consentBoundaryExceeded) return;
      const bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (items.length >= maximumItems || byteCount + bytes > maximumBytes) {
        consentBoundaryExceeded = true;
        return;
      }
      items.push(item);
      byteCount += bytes;
    };

    if (input.representation === "memory_events") {
      const events = await options.repository.listLcmGraphEvents(
        { userId: input.localOwnerUserId },
        {
          projectId: thread.projectId,
          threadId: thread.id,
          includeContent: true,
          includeInvalidated: false,
          canonicalCapturedSessionEventsOnly: true,
          limit: 500
        }
      );
      for (const [index, event] of [...events].reverse().entries()) {
        if (
          event.eventType === "approval_activity" ||
          classifyApprovalActivity({
            metadata: event.metadata,
            actor: event.actor,
            content: event.content
          })
        ) {
          excludedItemCount += 1;
          continue;
        }
        const sourceKind =
          event.actor === "user"
            ? "user_message"
            : event.actor === "tool"
              ? event.eventType === "tool_call"
                ? "tool_call"
                : "tool_result"
              : ["agent", "assistant", "subagent"].includes(event.actor ?? "")
                ? "agent_message"
                : null;
        const body = event.content?.trim() ?? "";
        if (!sourceKind || !body) {
          excludedItemCount += 1;
          continue;
        }
        append({
          id: event.id,
          representation: input.representation,
          sequence: index + 1,
          occurredAt: event.timestamp,
          sourceItems: [
            {
              id: event.id,
              sourceKind,
              occurredAt: event.timestamp,
              body,
              actorName: null,
              toolName:
                sourceKind === "tool_call" || sourceKind === "tool_result"
                  ? typeof event.metadata.toolName === "string"
                    ? event.metadata.toolName
                    : "tool"
                  : null,
              toolCallId: null
            }
          ]
        });
      }
    } else if (input.representation === "curated_assertions") {
      const assertions = await options.repository.listCuratedMemoryAssertions(
        { userId: input.localOwnerUserId },
        {
          status: "current",
          sessionId: input.sessionId,
          includeSources: true,
          limit: 101
        }
      );
      for (const [index, assertion] of assertions.entries()) {
        const sourceCount = assertion.sources.filter((source) =>
          [
            "primary_evidence",
            "supporting_evidence",
            "superseding_evidence",
            "conflicting_evidence"
          ].includes(source.sourceRole)
        ).length;
        if (sourceCount === 0) {
          excludedItemCount += 1;
          continue;
        }
        append({
          id: assertion.id,
          representation: input.representation,
          sequence: index + 1,
          occurredAt: assertion.observedAt,
          assertionText: assertion.assertionText,
          topicTitle: assertion.topicTitle,
          tags: assertion.tags,
          sourceCount,
          sourceRevision: `candidate.${assertion.id}`
        });
      }
    } else {
      await prepareLocalLcmCandidateRepresentation({
        repository: options.repository,
        ownerUserId: input.localOwnerUserId,
        sessionId: input.sessionId,
        representation: input.representation
      });
      const kind = input.representation === "lcm_leaves" ? "leaf" : "rollup";
      const syncEligibleNodeIds = new Set(
        await options.repository.listCapturedSessionSyncEligibleLcmNodeIds(
          { userId: input.localOwnerUserId },
          input.sessionId
        )
      );
      const nodes = await options.repository.listLcmGraphNodes(
        { userId: input.localOwnerUserId },
        { threadId: thread.id, includeInvalidated: false, limit: 500 }
      );
      for (const [index, node] of nodes
        .filter(
          (candidate) =>
            candidate.kind === kind && syncEligibleNodeIds.has(candidate.id)
        )
        .reverse()
        .entries()) {
        append({
          id: node.id,
          representation: input.representation,
          sequence: index + 1,
          occurredAt: node.updatedAt,
          summaryText: node.summaryText,
          lexicalAnchors:
            structuredLcmSummarySchema.safeParse(node.summaryStructuredJson)
              .data?.lexical_anchors ?? [],
          sourceCount: Math.max(node.sourceEventCount, 1),
          sourceRevision: `candidate.${node.id}`
        });
      }
    }

    if (consentBoundaryExceeded) return null;

    const manifest = items.map((item) => ({
      sourceId: item.id,
      revisionHash: crossIdentitySyncDigest({
        version: 1,
        sourceId: item.id,
        representation: input.representation,
        sourceRevision
      })
    }));
    const source = {
      kind: "captured_session" as const,
      sessionId: input.sessionId,
      logicalMemoryId
    };
    const sourceCapabilities = [
      "lcm_rollups" as const,
      "lcm_leaves" as const,
      "memory_events" as const,
      "curated_assertions" as const
    ];
    const candidateHash = crossIdentitySyncDigest({
      version: 2,
      source,
      sourceOwnerPrincipalId: input.localOwnerUserId,
      sourceCapabilities,
      activationRepresentation: input.representation,
      mode: input.mode,
      sourceRevision,
      itemCount: items.length,
      byteCount,
      excludedItemCount,
      manifest,
      items
    });
    return {
      source,
      logicalMemoryId,
      sourceCapabilities,
      activationRepresentation: input.representation,
      mode: input.mode,
      expiresAt: null,
      sourceRevision,
      candidateHash,
      itemCount: items.length,
      excludedItemCount,
      manifest,
      byteCount,
      items
    };
  };

  const loadPersonalNoteCandidatePreview = async (input: {
    localOwnerUserId: string;
    noteId: string;
    noteRevision: number;
    mode: "snapshot" | "continuous";
  }): Promise<SharedMemoryCandidatePreview | null> => {
    let candidateStage: PersonalNoteCandidatePreparationStage = "memory_event";
    try {
      const actor = { userId: input.localOwnerUserId };
      const event = await options.repository.getPersonalNoteRevisionMemoryEvent(
        actor,
        {
          noteId: input.noteId,
          revision: input.noteRevision
        }
      );
      candidateStage = "deployment_identity";
      const deployment = await options.repository.getLocalSyncDeployment();
      candidateStage = "source_validation";
      if (
        !event ||
        !deployment ||
        typeof event.content !== "string" ||
        event.content.length === 0 ||
        event.sourceSequence === null
      ) {
        return null;
      }
      candidateStage = "source_identity";
      const logicalMemoryId = crossIdentitySyncDeterministicUuid({
        protocol: "koed.personal-note-share/v1",
        sourceDeploymentId: deployment.protocolDeploymentId,
        sourceOwnerPrincipalId: input.localOwnerUserId,
        noteId: input.noteId,
        identity: "logical-memory"
      });
      const source = {
        kind: "personal_note" as const,
        noteId: input.noteId,
        noteRevision: input.noteRevision,
        memoryEventId: event.id,
        logicalMemoryId
      };
      candidateStage = "revision_hash";
      const revisionHash = personalNoteSourceRevisionHash({
        source,
        sourceOwnerPrincipalId: input.localOwnerUserId,
        content: event.content,
        occurredAt: event.timestamp,
        sourceSequence: event.sourceSequence
      });
      const items: SharedMemorySourceItem[] = [
        {
          id: event.id,
          representation: "memory_events",
          sequence: 1,
          occurredAt: event.timestamp,
          sourceItems: [
            {
              id: event.id,
              sourceKind: "user_message",
              occurredAt: event.timestamp,
              body: event.content,
              actorName: null,
              toolName: null,
              toolCallId: null
            }
          ]
        }
      ];
      candidateStage = "item_serialization";
      const byteCount = Buffer.byteLength(JSON.stringify(items[0]), "utf8");
      if (byteCount > 256 * 1_024) return null;
      const manifest = [{ sourceId: event.id, revisionHash }];
      const sourceCapabilities = ["memory_events" as const];
      candidateStage = "candidate_hash";
      const candidateHash = crossIdentitySyncDigest({
        version: 2,
        source,
        sourceOwnerPrincipalId: input.localOwnerUserId,
        sourceCapabilities,
        activationRepresentation: "memory_events",
        mode: input.mode,
        sourceRevision: input.noteRevision,
        itemCount: 1,
        byteCount,
        excludedItemCount: 0,
        manifest,
        items
      });
      return {
        source,
        logicalMemoryId,
        sourceCapabilities,
        activationRepresentation: "memory_events",
        mode: input.mode,
        expiresAt: null,
        sourceRevision: input.noteRevision,
        candidateHash,
        itemCount: 1,
        excludedItemCount: 0,
        manifest,
        byteCount,
        items
      };
    } catch (error) {
      if (error instanceof PersonalNoteCandidatePreparationError) throw error;
      throw new PersonalNoteCandidatePreparationError(candidateStage, error);
    }
  };

  const prepareLcmRepresentation = async (input: {
    localOwnerUserId: string;
    localSessionId: string;
    representation: LocalLcmRepresentation;
    syncRelationshipId: string;
  }) => {
    await prepareLocalLcmCandidateRepresentation({
      repository: options.repository,
      ownerUserId: input.localOwnerUserId,
      sessionId: input.localSessionId,
      representation: input.representation
    });
    const state = await options.repository.getSharedMemoryLcmSyncState({
      relationshipId: input.syncRelationshipId,
      ownerUserId: input.localOwnerUserId,
      sessionId: input.localSessionId,
      representation: input.representation
    });
    if (state === "pending") await options.requestLcmSummaryWork();
    return state;
  };

  return {
    loadCandidatePreview,
    loadPersonalNoteCandidatePreview,
    resolveCandidateSourceIdentity,
    prepareLcmRepresentation
  };
};
