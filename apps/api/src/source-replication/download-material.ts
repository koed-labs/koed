import type { MemorySourceRepository } from "@koed/db";
import {
  CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  calculateConversationSourceClosureDigest,
  parseConversationSourceOriginKeyRegistration,
  parseSignedConversationSourceClosureManifest,
  parseConversationSourceReplicationSourceDescriptor
} from "@koed/shared";

const portableProjectIdPattern = /^lp_[0-9a-f]{32}$/;

const unavailable = (): Error & { statusCode: number } =>
  Object.assign(new Error("Source download is unavailable"), {
    statusCode: 403
  });

export const resolveConversationSourceDownloadMaterial = async (input: {
  repository: MemorySourceRepository;
  ownerUserId: string;
  sourceGenerationId: string;
  allowedReplicaRoles: ReadonlySet<string>;
}) => {
  const actor = { userId: input.ownerUserId };
  const artifact =
    await input.repository.getConversationSourceArtifactByGeneration(
      actor,
      input.sourceGenerationId
    );
  if (
    !artifact ||
    !input.allowedReplicaRoles.has(artifact.replicaRole) ||
    !["active", "finalized"].includes(artifact.lifecycle)
  ) {
    throw unavailable();
  }
  const sourceSession = await input.repository.getCapturedSession(
    actor,
    artifact.sessionId
  );
  if (!sourceSession) throw unavailable();
  const registration = parseConversationSourceOriginKeyRegistration({
    protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
    logicalSourceId: artifact.logicalSourceId,
    sourceGenerationId: artifact.sourceGenerationId,
    originKeyId: artifact.originKeyId,
    publicKey: artifact.originPublicKey,
    lifecycle: artifact.originKeyStatus,
    sourceCreatedAt: artifact.sourceCreatedAt,
    priorGenerationClosure: artifact.priorGenerationClosure
  });
  const source = parseConversationSourceReplicationSourceDescriptor({
    sourceKind: "codex",
    logicalSessionId: sourceSession.logicalSessionId,
    externalSessionId: artifact.externalSessionId,
    forkedFromExternalThreadId:
      sourceSession.forkedFromExternalThreadId ?? null,
    sourceFingerprint: artifact.sourceFingerprint,
    artifactFormat: "codex_rollout_jsonl",
    artifactFormatVersion: 1,
    sourceAdapterVersion: "codex-transcript-v1",
    sourceRuntime: artifact.sourceRuntime,
    redactedSourceLabel: artifact.redactedSourceLabel,
    originDeploymentId: artifact.originDeploymentId,
    originDeviceId: artifact.originDeviceId,
    journalStartOffset: artifact.journalStartOffset,
    journalStartLine: artifact.journalStartLine,
    liveStartOffset: artifact.liveStartOffset,
    liveStartLine: artifact.liveStartLine,
    project:
      sourceSession.project &&
      portableProjectIdPattern.test(sourceSession.project.id)
        ? {
            id: sourceSession.project.id,
            name: sourceSession.project.name
          }
        : null
  });
  const sourceClosure =
    artifact.lifecycle === "finalized"
      ? parseSignedConversationSourceClosureManifest({
          manifest: artifact.closureManifest,
          signature: artifact.closureSignature
        })
      : null;
  if (
    sourceClosure &&
    calculateConversationSourceClosureDigest(sourceClosure) !==
      artifact.closureHash
  ) {
    throw Object.assign(new Error("Source closure identity is invalid"), {
      statusCode: 409
    });
  }
  return { artifact, registration, source, sourceClosure };
};
