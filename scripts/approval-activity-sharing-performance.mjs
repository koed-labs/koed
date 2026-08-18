#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  CAPTURED_SESSION_SYNC_FORMAT,
  CAPTURED_SESSION_SYNC_FORMAT_VERSION,
  CAPTURED_SESSION_SYNC_POLICY_VERSION,
  createEncryptedJsonPackage,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createRecipientPublicKeyEnvelopeEncryptionProvider,
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest,
  crossIdentitySyncSummaryNodeRevisionHash,
  generateRecipientKeyMaterial,
  isCapturedSessionSyncPackageV1
} from "../packages/shared/dist/index.js";

const capturedAt = "2026-08-12T00:00:00.000Z";
const approvalDisplayBytes = 412 * 1024;
const approvalDisplay = "a".repeat(approvalDisplayBytes);

const uuid = (kind, index) =>
  crossIdentitySyncDeterministicUuid({
    fixture: "approval-activity-reported-shape-v1",
    kind,
    index
  });

const contributor = (index, content, approvalActivity) => ({
  originItemId: uuid("item", index),
  revisionHash: crossIdentitySyncDigest({ index, content, approvalActivity }),
  actor: index % 2 === 0 ? "user" : "assistant",
  kind: "message",
  content,
  toolName: null,
  toolCallId: null,
  sourceEventTime: capturedAt,
  sourceSequence: index,
  sourceKind: "captured_session",
  sourceAdapterVersion: "reported-shape-v1",
  sourceTransport: "synthetic_fixture",
  sourceRecordType: approvalActivity ? "approval_review" : "message",
  sourceEventType: approvalActivity ? "approval_request" : "message",
  rawJson: approvalActivity
    ? { transcript: approvalDisplay }
    : { text: content },
  rawText: approvalActivity ? approvalDisplay : content,
  metadata: approvalActivity
    ? {
        approvalActivity: {
          classifierVersion: 1,
          kind: "approval_request",
          exclusionReason: "approval_activity:request"
        },
        approvalReviewTranscriptDisplay: approvalDisplay,
        providerEnvelope: approvalDisplay
      }
    : {},
  logicalSourceId: null,
  transportChunkIndex: 0,
  transportChunkCount: 1,
  transportChunkText: approvalActivity ? approvalDisplay : null,
  transportChunkEncoding: null,
  projectionStatus: "projected",
  projectionVersion: "reported-shape-v1",
  projectionPolicyRevision: 1,
  memoryExcludedAt: null,
  memoryExclusionReason: null
});

const change = (index, approvalActivity = false) => {
  const content = approvalActivity
    ? approvalDisplay
    : `Ordinary captured conversation event ${index}.`;
  const originEventId = uuid("event", index);
  const event = {
    originEventId,
    revisionHash: crossIdentitySyncDigest({ index, content, approvalActivity }),
    eventType: "message",
    actor: index % 2 === 0 ? "user" : "assistant",
    content,
    metadata: approvalActivity
      ? { approvalReviewTranscriptDisplay: approvalDisplay }
      : {},
    includeInEmbedding: true,
    includeInLcm: true,
    projectionPolicyKey: "conversation_message",
    projectionPolicyRevision: 1,
    tokenCount: approvalActivity ? 100_000 : 8,
    sealReason: null,
    capturedAt,
    sourceEventTime: capturedAt,
    sourceSequence: index,
    contributors: [contributor(index, content, approvalActivity)]
  };
  return {
    cursor: index,
    operation: "upsert",
    originEventId,
    revisionHash: event.revisionHash,
    event
  };
};

const summary = (changes, label) => {
  const sourceOriginEventIds = changes.map((item) => item.originEventId);
  const summaryText = `${label}: ${changes.length} eligible Memory Events.`;
  const node = {
    originNodeId: uuid("summary", label),
    kind: "leaf",
    depth: 0,
    lcmAlgorithmVersion: "lcm-v1",
    summaryText,
    summaryModel: "synthetic-local-summary",
    summaryPromptVersion: "reported-shape-v1",
    summaryStructuredJson: {
      schema_version: "lcm-structured-summary-v1",
      summary_text: summaryText
    },
    summaryStructuredSchemaVersion: "lcm-structured-summary-v1",
    sourceOriginEventIds,
    childOriginNodeIds: [],
    sourceHash: crossIdentitySyncDigest(sourceOriginEventIds),
    sourceEventCount: changes.length,
    sourceTokenEstimate: changes.length * 8,
    summaryTokenEstimate: 12,
    createdAt: capturedAt,
    updatedAt: capturedAt
  };
  return {
    ...node,
    revisionHash: crossIdentitySyncSummaryNodeRevisionHash(node)
  };
};

const packageFor = (changes, label) => {
  const summaryNodes = [summary(changes, label)];
  return {
    format: CAPTURED_SESSION_SYNC_FORMAT,
    formatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
    policyVersion: CAPTURED_SESSION_SYNC_POLICY_VERSION,
    packageId: uuid("package", label),
    relationshipId: uuid("relationship", 1),
    logicalMemoryId: uuid("logical-memory", 1),
    sourceDeploymentId: uuid("source-deployment", 1),
    sourceUserId: uuid("source-user", 1),
    sourceReplicaId: uuid("source-replica", 1),
    targetDeploymentId: uuid("target-deployment", 1),
    targetUserId: uuid("target-user", 1),
    targetReplicaId: uuid("target-replica", 1),
    packageSequence: 1,
    fromCursor: 0,
    toCursor: changes.at(-1)?.cursor ?? 0,
    createdAt: capturedAt,
    consentDigest: crossIdentitySyncDigest({ fixtureConsent: true }),
    policyDigest: crossIdentitySyncDigest({ representation: "memory_events" }),
    summaryRevisionHash: crossIdentitySyncDigest(summaryNodes),
    session: {
      originSessionId: uuid("session", 1),
      externalSessionId: "reported-shape-v1",
      sourceRuntime: "codex",
      captureMethod: "transcript",
      capturedAt,
      title: "Approval Activity reported-shape fixture",
      sourceAdapterVersion: "reported-shape-v1"
    },
    changes,
    summaryNodes
  };
};

const encryptAndMeasure = async (provider, syncPackage, label) => {
  if (!isCapturedSessionSyncPackageV1(syncPackage)) {
    throw new Error(`Invalid ${label} Cross-Identity Sync package.`);
  }
  const startedAt = performance.now();
  const encrypted = await createEncryptedJsonPackage(provider, {
    objectClass: "sync_package",
    payload: syncPackage,
    scope: {
      deploymentId: syncPackage.targetDeploymentId,
      tenantId: syncPackage.targetUserId
    },
    provenance: { rowFamily: "sync_package", sourceId: syncPackage.packageId },
    aad: {
      relationshipId: syncPackage.relationshipId,
      packageId: syncPackage.packageId,
      packageSequence: syncPackage.packageSequence
    },
    metadata: { fixture: "approval-activity-reported-shape-v1", label }
  });
  return {
    encryptedBytes: Buffer.byteLength(JSON.stringify(encrypted), "utf8"),
    plaintextBytes: Buffer.byteLength(JSON.stringify(syncPackage), "utf8"),
    recordCount: syncPackage.changes.length + syncPackage.summaryNodes.length,
    encryptionDurationMs: Number((performance.now() - startedAt).toFixed(3))
  };
};

const root = createLocalTestKeyEnvelopeEncryptionProvider(
  randomBytes(32).toString("base64")
);
const recipient = await generateRecipientKeyMaterial(root, {
  keyId: "sync-recipient:approval-activity-reported-shape-v1",
  keyVersion: 1
});
const provider = createRecipientPublicKeyEnvelopeEncryptionProvider(recipient);

const ordinaryChanges = Array.from({ length: 37 }, (_, index) =>
  change(index + 1)
);
const approvalChange = change(38, true);
const beforePackage = packageFor(
  [...ordinaryChanges, approvalChange],
  "before-correction"
);
const afterPackage = packageFor(ordinaryChanges, "after-correction");
const ordinaryControlA = packageFor(ordinaryChanges, "ordinary-control");
const ordinaryControlB = packageFor(ordinaryChanges, "ordinary-control");

const before = await encryptAndMeasure(provider, beforePackage, "before");
const after = await encryptAndMeasure(provider, afterPackage, "after");
const ordinaryA = await encryptAndMeasure(
  provider,
  ordinaryControlA,
  "ordinary-control-a"
);
const ordinaryB = await encryptAndMeasure(
  provider,
  ordinaryControlB,
  "ordinary-control-b"
);

if (
  before.recordCount !== 39 ||
  after.recordCount !== 38 ||
  after.encryptedBytes >= before.encryptedBytes ||
  crossIdentitySyncDigest(ordinaryControlA) !==
    crossIdentitySyncDigest(ordinaryControlB) ||
  ordinaryA.plaintextBytes !== ordinaryB.plaintextBytes ||
  ordinaryA.encryptedBytes !== ordinaryB.encryptedBytes
) {
  throw new Error("Approval Activity sharing performance invariants failed.");
}

process.stdout.write(
  `${JSON.stringify(
    {
      fixture: "approval-activity-reported-shape-v1",
      fixtureKind: "deterministic_synthetic_reported_shape",
      approvalDisplayProjectionBytes: approvalDisplayBytes,
      before,
      after,
      delta: {
        encryptedBytes: after.encryptedBytes - before.encryptedBytes,
        plaintextBytes: after.plaintextBytes - before.plaintextBytes,
        recordCount: after.recordCount - before.recordCount
      },
      ordinaryCapturedSessionRegression: {
        canonicalDigestStable: true,
        plaintextBytesStable: true,
        encryptedBytesStable: true,
        firstEncryptionDurationMs: ordinaryA.encryptionDurationMs,
        secondEncryptionDurationMs: ordinaryB.encryptionDurationMs
      },
      contentSafe: true
    },
    null,
    2
  )}\n`
);
