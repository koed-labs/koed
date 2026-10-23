import { createSavepointPool } from "../src/savepoint-pool.js";
import { createMemorySourceRepository } from "../src/repository.js";
import { personalSourceDeviceFixture } from "./fixtures/personal-source-device.js";
import { preparePersonalSourceContextSnapshot } from "../src/personal-source-context-export.js";
import { createPersonalConfigurationRecordRepository } from "../src/personal-configuration-record-repository.js";
import {
  PERSONAL_CONFIGURATION_PROTOCOL,
  personalSourceContextSnapshotSchema,
  encodePdsPersonalSourceContextSnapshot,
  encodePdsPersonalMembershipEntitySnapshot,
  evaluatePersonalMembershipRevisions,
  signPersonalConfigurationRecord,
  canonicalizePdsJson
} from "@koed/shared";
import { createPersonalSourceCorrectionRepository } from "../src/personal-source-correction-repository.js";
import { unresolvedTeamRepositorySnapshot } from "@koed/shared";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { createHighRiskActionRepository } from "../src/high-risk-action-repository.js";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  CAPTURED_SESSION_SYNC_FORMAT,
  CAPTURED_SESSION_SYNC_FORMAT_VERSION,
  CAPTURED_SESSION_SYNC_POLICY_VERSION,
  PRIVACY_REPLACEMENT_CONTRACT_VERSION,
  teamSemanticEmbeddingGeneration,
  createLocalTestKeyEnvelopeEncryptionProvider,
  crossIdentitySyncDigest,
  sharingRuleSourceIdentityHash,
  highRiskActionGrantCommitment,
  sharedMemoryCandidatePreviewActionGrantBinding,
  sharedMemoryConversationRuleCreationActionGrantBinding,
  sharedMemoryPendingShareActionGrantBinding,
  sharedMemoryWorkspaceRestorationActionGrantBinding,
  sharedMemoryRuleControlActionGrantBinding,
  sharedMemoryRuleDetailActionGrantBinding,
  sharedMemoryPublisherTakeoverActionGrantBinding,
  sharedMemoryRuleContentPolicyActionGrantBinding,
  sharedMemoryRepositoryRuleCreationActionGrantBinding,
  sharedMemoryRepositoryRuleControlActionGrantBinding,
  type SharedMemoryActionGrantBinding,
  noPrivacyLabelsPolicy,
  privacyContentPolicyHash,
  privacyClassificationExpectedManifestHash,
  privacyClassificationOrderedInputHash,
  privacyClassificationResultManifestHash,
  sharedMemoryCeilingAuthorizes,
  crossIdentitySyncDeterministicUuid,
  personalNoteSourceRevisionHash,
  sharedMemoryGrantScopedSourceId,
  sharedMemoryRepresentationsForCeiling,
  extractSharedMemorySemanticClassificationFields,
  reconstructSharedMemorySemanticSanitizedItems,
  SharedMemoryConflictError,
  SharedMemorySourceItemRejectedError,
  validateSharedMemoryCanonicalSourceItem,
  validateSharedMemorySemanticSanitizedReconstruction,
  type CapturedSessionSyncPackageV2,
  type EnvelopeEncryptionProvider,
  type PrivacyClassificationResponse,
  type SharedMemoryCanonicalSourceItemDto,
  type SharedMemoryFidelityCeiling,
  type SharedMemoryRepresentation,
  type SharedMemorySemanticMaskedField,
  type SharedMemorySourceRef,
  type SharedMemorySourceItemInput
} from "@koed/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock
} from "vitest";
import type pg from "pg";
import { createCollaborationRepository } from "../src/collaboration-repository.js";
import {
  correctApprovalActivity,
  inventoryApprovalActivity
} from "../src/approval-activity-remediation.js";
import { createDb, createDbPool } from "../src/connection.js";
import { upsertEncryptedFieldPayloadWithClient } from "../src/encrypted-payload-repository.js";
import {
  createCrossIdentitySyncRepository,
  SyncStateConflictError
} from "../src/cross-identity-sync-repository.js";
import {
  buildCapturedSessionSyncContributor,
  buildCapturedSessionSyncEvent
} from "../src/cross-identity-sync-canonical.js";
import { runDbMigrations } from "../src/migrate.js";
import {
  createPrivacyClassificationRepository,
  type PrivacyClassificationRepository,
  type PrivacyClassifierGenerationRecord
} from "../src/privacy-classification-repository.js";
import {
  createRetentionLifecycleRepository,
  type RetentionLifecycleRepository
} from "../src/retention-lifecycle-repository.js";
import {
  createSharedMemoryRepository,
  composeSharedMemorySemanticText,
  requireReadySharedMemorySemanticDerivative,
  sharedMemoryDeviceProvenanceHash,
  sharedMemorySanitizedSemanticSourceRevisionHash,
  sharedMemorySemanticPrivacyWorkIdentity,
  SHARED_MEMORY_AUTHORITY,
  SharedMemoryAuthorizationError,
  SharedMemorySemanticDerivativePendingError,
  type SharedMemoryAuthorityContext,
  type SharedMemoryConsentMode,
  type SharedMemoryGrantRecord,
  type SharedMemoryPersistedPreviewRecord,
  type SharedMemoryReadySemanticDerivative,
  type SharedMemoryRepository
} from "../src/shared-memory-repository.js";
import type { ActorContext } from "../src/types.js";
import { writeOwnerPrivateRepositorySnapshot } from "../src/owner-private-repository-snapshot.js";

const databaseUrl = process.env.SHARED_MEMORY_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
const allRepresentations: SharedMemoryRepresentation[] = [
  "memory_events",
  "lcm_leaves",
  "lcm_rollups"
];

const fidelityConsent = (
  representations: readonly SharedMemoryRepresentation[]
) => ({
  maximumFidelity: representations.includes("memory_events")
    ? ("memory_events" as const)
    : representations.includes("lcm_leaves")
      ? ("lcm_leaves" as const)
      : ("lcm_rollups" as const),
  includeCuratedMemory: representations.includes("curated_assertions")
});

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const actor = (userId: string) => ({ userId });

const occurredAtFor = (cursor: number): string =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, cursor)).toISOString();

const LCM_SUMMARY_SCHEMA_VERSION = "lcm-semantic-summary-v1";

const deterministicUuid = (...parts: string[]): string => {
  const hex = hash(parts.join(":"));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(
    13,
    16
  )}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

interface SeededMemoryEvent {
  eventId: string;
  originEventId: string;
  sourceCursor: number;
  contributorIds: string[];
  occurredAt: string;
  content: string;
}

interface SeededNodeItem {
  nodeId: string;
  originNodeId: string;
  summaryText: string;
  sourceEventIds: string[];
}

interface WorkspaceFixture {
  ownerUserId: string;
  readerUserId: string;
  managerUserId: string;
  outsiderUserId: string;
  ownerSessionId: string;
  managerSessionId: string;
  teamId: string;
  teamWorkspaceId: string;
  sourceDeploymentId: string;
  sourceProtocolDeploymentId: string;
  targetDeploymentId: string;
  targetProtocolDeploymentId: string;
  remoteUserIdentityId: string;
  remoteExternalSubjectId: string;
  sourceOwnerPrincipalId: string;
  deviceCredentialId: string;
}

interface SourceFixture {
  logicalMemoryId: string;
  ownerPrincipalId: string;
  sourceDeploymentProtocolId: string;
  deviceCredentialId: string;
  remoteReplicaId: string;
  sourceReplicaId: string;
  syncRelationshipId: string;
  sessionId: string;
  localSessionId: string;
  currentRevision: number;
  currentLabel: string;
  packageSequence: number;
  originEventId: string;
  seededEvents: SeededMemoryEvent[];
  leaf: SeededNodeItem;
  rollup: SeededNodeItem;
  lastSyncPackage: CapturedSessionSyncPackageV2 | null;
  lastUploadSessionId: string | null;
}

interface GrantFixture extends SourceFixture {
  consentId: string;
  shareGrantId: string;
  grantVersion: number;
  representation: SharedMemoryRepresentation;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  preview: SharedMemoryPersistedPreviewRecord;
}

interface SourceRevisionOptions {
  repositorySnapshot?: CapturedSessionSyncPackageV2["session"]["repositorySnapshot"];
  distinctTargetSession?: boolean;
  groupedAssistantSources?: boolean;
  assistantActor?: string;
  assistantKind?: string;
  assistantText?: string;
  assistantToolName?: string | null;
  assistantSourceKind?: string;
  assistantRawJson?: unknown;
  assistantRawText?: string;
  assistantMemoryExcludedAt?: string | null;
  assistantMemoryExclusionReason?: string | null;
  includeSummarySnapshot?: boolean;
  summaryOnly?: boolean;
}

describe("Shared Memory source-content policy", () => {
  it("preserves exact owner-private content and rejects prohibited, forged, and cross-source items", () => {
    const logicalMemoryId = randomUUID();
    const sourceRevision = 4;
    const tool = validateSharedMemoryCanonicalSourceItem({
      representation: "memory_events",
      logicalMemoryId,
      sourceRevision,
      item: {
        itemType: "tool_result",
        schemaVersion: 1,
        sourceId: randomUUID(),
        sourceLogicalMemoryId: logicalMemoryId,
        sourceRevision,
        content: {
          toolName: "deploy",
          toolCallId: "call-redaction-proof",
          payload: {
            password: "plaintext-password",
            nested: {
              authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
              output: "Bearer abcdefghijklmnopqrstuvwxyz"
            }
          }
        }
      }
    });
    expect(tool.content).toEqual({
      toolName: "deploy",
      toolCallId: "call-redaction-proof",
      payload: {
        password: "plaintext-password",
        nested: {
          authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
          output: "Bearer abcdefghijklmnopqrstuvwxyz"
        }
      }
    });
    expect(() =>
      validateSharedMemoryCanonicalSourceItem({
        representation: "memory_events",
        logicalMemoryId,
        sourceRevision,
        item: {
          itemType: "assistant_message",
          schemaVersion: 1,
          sourceId: randomUUID(),
          sourceLogicalMemoryId: logicalMemoryId,
          sourceRevision,
          content: { text: "decision", approvalReview: true }
        }
      })
    ).toThrowError(
      expect.objectContaining({ reasonCode: "approval_activity_excluded" })
    );

    const lcmSourceId = randomUUID();
    expect(
      validateSharedMemoryCanonicalSourceItem({
        representation: "lcm_leaves",
        logicalMemoryId,
        sourceRevision,
        item: {
          itemType: "lcm_leaf",
          schemaVersion: 1,
          sourceId: lcmSourceId,
          sourceLogicalMemoryId: logicalMemoryId,
          sourceRevision,
          content: {
            title: "Bounded anchors",
            summaryText: "The validated anchor is materialized.",
            lexicalAnchors: ['flag "quoted"', "C:\\repo\\koed"],
            sourceIds: [randomUUID()]
          }
        }
      }).content
    ).toMatchObject({
      lexicalAnchors: ['flag "quoted"', "C:\\repo\\koed"]
    });
    expect(() =>
      validateSharedMemoryCanonicalSourceItem({
        representation: "lcm_leaves",
        logicalMemoryId,
        sourceRevision,
        item: {
          itemType: "lcm_leaf",
          schemaVersion: 1,
          sourceId: lcmSourceId,
          sourceLogicalMemoryId: logicalMemoryId,
          sourceRevision,
          content: {
            summaryText: "Invalid duplicate anchors.",
            lexicalAnchors: ["duplicate", "duplicate"],
            sourceIds: [randomUUID()]
          }
        }
      })
    ).toThrow(SharedMemorySourceItemRejectedError);

    const base: SharedMemorySourceItemInput = {
      itemType: "user_message",
      schemaVersion: 1,
      sourceId: randomUUID(),
      sourceLogicalMemoryId: logicalMemoryId,
      sourceRevision,
      content: { text: "eligible" }
    };
    const rejected: Array<{
      item: SharedMemorySourceItemInput;
      reasonCode: string;
    }> = [
      {
        item: { ...base, itemType: "future_protocol_item" },
        reasonCode: "unknown_item_type"
      },
      {
        item: { ...base, schemaVersion: 2 },
        reasonCode: "unknown_schema_version"
      },
      {
        item: { ...base, classification: { hiddenReasoning: true } },
        reasonCode: "hidden_reasoning"
      },
      {
        item: { ...base, classification: { systemInstruction: true } },
        reasonCode: "system_instruction"
      },
      {
        item: {
          ...base,
          classification: { unsupportedProtocolItem: true }
        },
        reasonCode: "unsupported_protocol_item"
      },
      {
        item: { ...base, sourceLogicalMemoryId: randomUUID() },
        reasonCode: "cross_memory_provenance"
      },
      {
        item: { ...base, itemType: "lcm_leaf" },
        reasonCode: "wrong_representation"
      },
      {
        item: {
          ...base,
          classification: { shareEligible: true }
        } as unknown as SharedMemorySourceItemInput,
        reasonCode: "invalid_item_schema"
      }
    ];
    expect(
      validateSharedMemoryCanonicalSourceItem({
        representation: "memory_events",
        logicalMemoryId,
        sourceRevision,
        item: { ...base, classification: { containsCredentials: true } }
      }).content
    ).toEqual({ text: "eligible" });
    for (const testCase of rejected) {
      try {
        validateSharedMemoryCanonicalSourceItem({
          representation: "memory_events",
          logicalMemoryId,
          sourceRevision,
          item: testCase.item
        });
        throw new Error("expected source item rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(SharedMemorySourceItemRejectedError);
        expect(error).toMatchObject({ reasonCode: testCase.reasonCode });
      }
    }
  });
});

describe("Shared Memory semantic classification contract", () => {
  const semanticFixture = (): SharedMemoryCanonicalSourceItemDto[] => {
    const logicalMemoryId = randomUUID();
    const sourceRevision = 7;
    const toolItem: SharedMemoryCanonicalSourceItemDto = {
      itemType: "tool_result",
      schemaVersion: 1,
      sourceId: randomUUID(),
      sourceLogicalMemoryId: logicalMemoryId,
      sourceRevision,
      occurredAt: null,
      content: {
        toolName: "customer_lookup",
        toolCallId: "call-immutable",
        payload: {
          count: 2,
          evidence: ["Alice", { quote: "Lives in Bangkok" }],
          "customer.name": "Alice Example"
        }
      }
    };
    return [
      {
        itemType: "lcm_leaf",
        schemaVersion: 1,
        sourceId: randomUUID(),
        sourceLogicalMemoryId: logicalMemoryId,
        sourceRevision,
        occurredAt: null,
        content: {
          title: "Customer context",
          summaryText: "Alice prefers morning calls.",
          lexicalAnchors: ["Alice", "morning calls"],
          sourceIds: [randomUUID()],
          expansionItems: [toolItem]
        }
      },
      {
        itemType: "curated_assertion",
        schemaVersion: 1,
        sourceId: randomUUID(),
        sourceLogicalMemoryId: logicalMemoryId,
        sourceRevision,
        occurredAt: null,
        content: {
          assertionText: "Alice is the billing contact.",
          topicTitle: "Customer contacts",
          tags: ["billing", "Alice"],
          sourceCount: 1
        }
      }
    ];
  };

  it("extracts every content-bearing string as an exact stable field path", () => {
    const fields =
      extractSharedMemorySemanticClassificationFields(semanticFixture());
    expect(fields.map((field) => field.path)).toEqual([
      "items.0.content.title",
      "items.0.content.summaryText",
      "items.0.content.lexicalAnchors.0",
      "items.0.content.lexicalAnchors.1",
      "items.0.content.expansionItems.0.content.toolName",
      "items.0.content.expansionItems.0.content.payload.$key.0",
      "items.0.content.expansionItems.0.content.payload.$key.1",
      'items.0.content.expansionItems.0.content.payload["customer.name"]',
      "items.0.content.expansionItems.0.content.payload.$key.2",
      "items.0.content.expansionItems.0.content.payload.evidence.0",
      "items.0.content.expansionItems.0.content.payload.evidence.1.$key.0",
      "items.0.content.expansionItems.0.content.payload.evidence.1.quote",
      "items.1.content.assertionText",
      "items.1.content.topicTitle",
      "items.1.content.tags.0",
      "items.1.content.tags.1"
    ]);
    for (const field of fields) {
      expect(field.inputSha256).toBe(hash(field.text));
      expect(field.inputByteLength).toBe(Buffer.byteLength(field.text, "utf8"));
    }
    expect(fields.some((field) => field.path.includes("sourceIds"))).toBe(
      false
    );
    expect(fields.some((field) => field.path.includes("toolCallId"))).toBe(
      false
    );
    expect(
      fields
        .filter((field) => field.path.includes(".$key."))
        .every((field) => field.replacementMode === "reject_if_changed")
    ).toBe(true);
  });

  it("allows only classified string replacements in reconstructed DTOs", () => {
    const authoritative = semanticFixture();
    const sanitized = structuredClone(authoritative);
    sanitized[0]!.content.summaryText = "[PERSON_1] prefers morning calls.";
    const payload = (
      sanitized[0]!.content
        .expansionItems as SharedMemoryCanonicalSourceItemDto[]
    )[0]!.content.payload as Record<string, unknown>;
    payload["customer.name"] = "[PERSON_1]";
    validateSharedMemorySemanticSanitizedReconstruction(
      authoritative,
      sanitized
    );

    const identityChanged = structuredClone(sanitized);
    identityChanged[0]!.sourceId = randomUUID();
    expect(() =>
      validateSharedMemorySemanticSanitizedReconstruction(
        authoritative,
        identityChanged
      )
    ).toThrow(SharedMemoryConflictError);

    const nonStringChanged = structuredClone(sanitized);
    const changedPayload = (
      nonStringChanged[0]!.content
        .expansionItems as SharedMemoryCanonicalSourceItemDto[]
    )[0]!.content.payload as Record<string, unknown>;
    changedPayload.count = 3;
    expect(() =>
      validateSharedMemorySemanticSanitizedReconstruction(
        authoritative,
        nonStringChanged
      )
    ).toThrow(SharedMemoryConflictError);
  });

  it("reconstructs from an exact ordered masked-field contract and rejects drift", () => {
    const authoritative = semanticFixture();
    const maskedFields: SharedMemorySemanticMaskedField[] =
      extractSharedMemorySemanticClassificationFields(authoritative).map(
        (field) => ({
          path: field.path,
          inputSha256: field.inputSha256,
          inputByteLength: field.inputByteLength,
          sanitizedText: field.text.replaceAll("Alice", "[PERSON_1]")
        })
      );
    const reconstructed = reconstructSharedMemorySemanticSanitizedItems(
      authoritative,
      maskedFields
    );
    const protectedKey = maskedFields.findIndex((field) =>
      field.path.includes(".$key.")
    );
    const changedKey = structuredClone(maskedFields);
    changedKey[protectedKey]!.sanitizedText = "[PRIVATE_DATA]";
    expect(() =>
      reconstructSharedMemorySemanticSanitizedItems(authoritative, changedKey)
    ).toThrow(SharedMemoryConflictError);
    expect(reconstructed).not.toBe(authoritative);
    expect(reconstructed[0]!.content.summaryText).toBe(
      "[PERSON_1] prefers morning calls."
    );
    expect(authoritative[0]!.content.summaryText).toBe(
      "Alice prefers morning calls."
    );

    expect(() =>
      reconstructSharedMemorySemanticSanitizedItems(
        authoritative,
        maskedFields.slice(0, -1)
      )
    ).toThrow(SharedMemoryConflictError);
    expect(() =>
      reconstructSharedMemorySemanticSanitizedItems(authoritative, [
        ...maskedFields,
        maskedFields[0]!
      ])
    ).toThrow(SharedMemoryConflictError);

    const reordered = [...maskedFields];
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    expect(() =>
      reconstructSharedMemorySemanticSanitizedItems(authoritative, reordered)
    ).toThrow(SharedMemoryConflictError);
    expect(() =>
      reconstructSharedMemorySemanticSanitizedItems(authoritative, [
        { ...maskedFields[0]!, inputSha256: hash("wrong-input") },
        ...maskedFields.slice(1)
      ])
    ).toThrow(SharedMemoryConflictError);
  });

  it("accepts semantic credential placeholders without changing source identity", () => {
    const logicalMemoryId = randomUUID();
    const sourceId = randomUUID();
    const authoritative: SharedMemoryCanonicalSourceItemDto[] = [
      {
        itemType: "assistant_message",
        schemaVersion: 1,
        sourceId,
        sourceLogicalMemoryId: logicalMemoryId,
        sourceRevision: 9,
        occurredAt: null,
        content: {
          text: "Use Bearer abcdefghijklmnopqrstuvwxyz for the request"
        }
      }
    ];
    const sanitized = structuredClone(authoritative);
    sanitized[0]!.content.text = "Use [SECRET_1] for the request";

    expect(
      extractSharedMemorySemanticClassificationFields(authoritative)
    ).toMatchObject([
      {
        path: "items.0.content.text",
        text: "Use Bearer abcdefghijklmnopqrstuvwxyz for the request"
      }
    ]);
    expect(() =>
      validateSharedMemorySemanticSanitizedReconstruction(
        authoritative,
        sanitized
      )
    ).not.toThrow();
    expect(sanitized[0]).toMatchObject({
      sourceId,
      sourceLogicalMemoryId: logicalMemoryId,
      sourceRevision: 9,
      content: { text: "Use [SECRET_1] for the request" }
    });
  });

  it("requires a ready sanitized derivative and never falls back to original staging", () => {
    const ready = {
      record: {
        status: "ready",
        expectedManifestHash: hash("expected-manifest"),
        expectedChunkCount: 1,
        completedChunkCount: 1,
        resultManifestHash: hash("result-manifest"),
        sourceItemIdentityHash: hash("source-identities"),
        sourceItemCount: 1,
        sanitizedContentHash: hash("sanitized-content"),
        payloadBindingHash: hash("payload-binding")
      },
      payload: { items: [{ content: { text: "[PERSON_1]" } }] }
    } as unknown as SharedMemoryReadySemanticDerivative;

    expect(requireReadySharedMemorySemanticDerivative(ready)).toBe(ready);
    expect(() => requireReadySharedMemorySemanticDerivative(null)).toThrow(
      SharedMemorySemanticDerivativePendingError
    );
    expect(() =>
      requireReadySharedMemorySemanticDerivative({
        ...ready,
        record: { ...ready.record, status: "pending" }
      })
    ).toThrow(SharedMemorySemanticDerivativePendingError);
    for (const status of ["failed", "stale", "invalidated"] as const) {
      expect(() =>
        requireReadySharedMemorySemanticDerivative({
          ...ready,
          record: { ...ready.record, status }
        })
      ).toThrow(SharedMemoryConflictError);
    }
  });

  it("binds Shared Memory source provenance to the complete device credential", () => {
    const binding = {
      syncRelationshipId: randomUUID(),
      deviceCredentialId: randomUUID(),
      credentialKeyId: "fixture-device-key",
      upstreamBackendId: "fixture-backend",
      deviceInstanceId: randomUUID(),
      lineageId: randomUUID(),
      credentialVersion: 1,
      verifierKind: "secret_hash",
      verifierHash: hash("fixture-verifier"),
      publicKeyJwk: null
    };
    const provenanceHash = sharedMemoryDeviceProvenanceHash(binding);

    expect(provenanceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sharedMemoryDeviceProvenanceHash(binding)).toBe(provenanceHash);
    expect(
      sharedMemoryDeviceProvenanceHash({
        ...binding,
        credentialVersion: binding.credentialVersion + 1
      })
    ).not.toBe(provenanceHash);
  });

  it("derives the Team source revision hash from sanitized semantic content", () => {
    const binding = {
      sourcePreviewId: randomUUID(),
      sourcePreviewHash: hash("source-preview"),
      sourceArtifactId: randomUUID(),
      sourceArtifactHash: hash("source-artifact"),
      sourceManifestHash: hash("source-manifest"),
      sourceRevision: 12,
      representation: "memory_events" as const,
      sanitizedSourcePreviewId: randomUUID(),
      sourceItemIdentityHash: hash("source-item-identities"),
      sourceItemCount: 1,
      privacyClassifierGenerationId: randomUUID(),
      privacyClassifierHash: hash("privacy-classifier"),
      effectivePrivacyPolicyHash: hash("effective-privacy-policy")
    };
    const first = sharedMemorySanitizedSemanticSourceRevisionHash({
      ...binding,
      sanitizedContentHash: hash("sanitized-one")
    });
    const second = sharedMemorySanitizedSemanticSourceRevisionHash({
      ...binding,
      sanitizedContentHash: hash("sanitized-two")
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(
      sharedMemorySanitizedSemanticSourceRevisionHash({
        ...binding,
        sanitizedContentHash: hash("sanitized-one")
      })
    ).toBe(first);
  });
});

class SemanticLifecyclePool {
  readonly candidate: Record<string, unknown>;
  transition: { status: string; reasonCode: string } | null = null;
  encryptedPayloadInvalidated = false;
  representationInvalidated = false;
  semanticItemsDeleted = false;

  constructor(
    status: "pending" | "ready" | "failed",
    readonly current: {
      sourceCurrent: boolean;
      classifierCurrent: boolean;
      authorizationCurrent: boolean;
    },
    readonly privacyPolicyAvailable = false
  ) {
    this.candidate = {
      id: randomUUID(),
      source_preview_id: randomUUID(),
      source_preview_revision: 1,
      source_preview_hash: hash("preview"),
      source_artifact_id: randomUUID(),
      source_artifact_hash: hash("artifact"),
      source_manifest_hash: hash("manifest"),
      source_revision: 3,
      source_hash: hash("source"),
      classifier_generation_id: randomUUID(),
      classifier_version: 2,
      classifier_hash: hash("classifier"),
      effective_privacy_policy_hash: hash("effective-policy"),
      owner_user_id: randomUUID(),
      team_id: randomUUID(),
      team_workspace_id: randomUUID(),
      status,
      updated_at: new Date("2026-08-13T00:00:00.000Z")
    };
  }

  async connect(): Promise<pg.PoolClient> {
    return {
      query: this.query.bind(this),
      release: () => undefined
    } as unknown as pg.PoolClient;
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<pg.QueryResult<T>> {
    const sql = text.replace(/\s+/g, " ").trim();
    let rows: Record<string, unknown>[] = [];
    let rowCount: number | null = 0;
    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      rowCount = null;
    } else if (
      sql.startsWith("select * from shared_source_semantic_previews")
    ) {
      rows = [this.candidate];
      rowCount = 1;
    } else if (sql.startsWith("select exists (")) {
      rows = [
        {
          source_current: this.current.sourceCurrent,
          classifier_current: this.current.classifierCurrent,
          authorized_rule_ids: this.current.authorizationCurrent ? [null] : []
        }
      ];
      rowCount = 1;
    } else if (sql.includes("from privacy_content_policies policy")) {
      if (this.privacyPolicyAvailable) {
        const labels = noPrivacyLabelsPolicy();
        rows = [
          {
            id: randomUUID(),
            policy_id: randomUUID(),
            version: 1,
            scope: "deployment",
            deployment_identity_id: randomUUID(),
            source_owner_user_id: null,
            team_id: null,
            team_workspace_id: null,
            labels,
            replacement_contract_version: PRIVACY_REPLACEMENT_CONTRACT_VERSION,
            policy_hash: privacyContentPolicyHash({
              labels,
              replacementContractVersion: PRIVACY_REPLACEMENT_CONTRACT_VERSION
            }),
            status: "active",
            effective_at: new Date("2026-08-12T00:00:00.000Z"),
            created_at: new Date("2026-08-12T00:00:00.000Z"),
            superseded_at: null,
            revoked_at: null,
            revocation_reason_code: null
          }
        ];
        rowCount = 1;
      }
    } else if (
      sql.startsWith("update shared_source_semantic_previews") &&
      sql.includes("set status=$2")
    ) {
      this.transition = {
        status: String(values[1]),
        reasonCode: String(values[2])
      };
      rows = [{ ...this.candidate, status: values[1] }];
      rowCount = 1;
    } else if (sql.startsWith("update encrypted_field_payloads")) {
      this.encryptedPayloadInvalidated = true;
      rowCount = 1;
    } else if (sql.startsWith("update team_memory_representations")) {
      this.representationInvalidated = true;
      rows = [{ id: randomUUID() }];
      rowCount = 1;
    } else if (sql.startsWith("delete from team_memory_semantic_items")) {
      this.semanticItemsDeleted = true;
      rowCount = 1;
    } else {
      throw new Error(`Unexpected lifecycle SQL: ${sql}`);
    }
    return { rows, rowCount } as unknown as pg.QueryResult<T>;
  }
}

const semanticLifecycleRepository = (pool: SemanticLifecyclePool) => {
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 91).toString("base64")
  );
  return createSharedMemoryRepository(pool as unknown as pg.Pool, {
    resolvePersonalEncryptionProvider: () => provider,
    resolveTeamEncryptionProvider: () => provider,
    resolveOwnerPrivateReplicaEncryptionProvider: () => provider
  });
};

describe("Shared Memory semantic derivative lifecycle", () => {
  it("stales ready material when its classifier generation is no longer active", async () => {
    const pool = new SemanticLifecyclePool("ready", {
      sourceCurrent: true,
      classifierCurrent: false,
      authorizationCurrent: true
    });

    await expect(
      semanticLifecycleRepository(pool).invalidateStaleSemanticPreviews()
    ).resolves.toEqual({ invalidated: 1 });
    expect(pool.transition).toEqual({
      status: "stale",
      reasonCode: "privacy_classifier_superseded"
    });
    expect(pool.encryptedPayloadInvalidated).toBe(true);
    expect(pool.representationInvalidated).toBe(true);
    expect(pool.semanticItemsDeleted).toBe(true);
  });

  it("stales ready material when its effective privacy policy hash changed", async () => {
    const pool = new SemanticLifecyclePool(
      "ready",
      {
        sourceCurrent: true,
        classifierCurrent: true,
        authorizationCurrent: true
      },
      true
    );

    await expect(
      semanticLifecycleRepository(pool).invalidateStaleSemanticPreviews()
    ).resolves.toEqual({ invalidated: 1 });
    expect(pool.transition).toEqual({
      status: "stale",
      reasonCode: "privacy_policy_superseded"
    });
  });

  it("invalidates non-ready lifecycle rows when their source binding is stale", async () => {
    const pool = new SemanticLifecyclePool("failed", {
      sourceCurrent: false,
      classifierCurrent: true,
      authorizationCurrent: true
    });

    await expect(
      semanticLifecycleRepository(pool).invalidateStaleSemanticPreviews()
    ).resolves.toEqual({ invalidated: 1 });
    expect(pool.transition).toEqual({
      status: "invalidated",
      reasonCode: "source_binding_stale"
    });
  });
});

describe("Shared Memory cumulative fidelity materialization", () => {
  it("keeps hierarchical layers cumulative and Curated Memory independent", () => {
    expect(sharedMemoryRepresentationsForCeiling("memory_events")).toEqual([
      "lcm_rollups",
      "lcm_leaves",
      "memory_events"
    ]);
    expect(sharedMemoryRepresentationsForCeiling("lcm_leaves")).toEqual([
      "lcm_rollups",
      "lcm_leaves"
    ]);
    expect(sharedMemoryRepresentationsForCeiling("lcm_rollups")).toEqual([
      "lcm_rollups"
    ]);
    for (const ceiling of [
      "memory_events",
      "lcm_leaves",
      "lcm_rollups"
    ] as const) {
      expect(
        sharedMemoryCeilingAuthorizes(ceiling, "curated_assertions", false)
      ).toBe(false);
      expect(
        sharedMemoryCeilingAuthorizes(ceiling, "curated_assertions", true)
      ).toBe(true);
    }
  });
});

describeDb("Shared Memory repository", () => {
  let pool: pg.Pool;
  let provider: EnvelopeEncryptionProvider;
  let ownerProvider: EnvelopeEncryptionProvider;
  let privacyProvider: EnvelopeEncryptionProvider;
  let privacyRepository: PrivacyClassificationRepository;
  let privacyClassifier: PrivacyClassifierGenerationRecord;
  let encryptSpy: Mock<EnvelopeEncryptionProvider["encrypt"]>;
  let decryptSpy: Mock<EnvelopeEncryptionProvider["decrypt"]>;
  let ownerEncryptSpy: Mock<EnvelopeEncryptionProvider["encrypt"]>;
  let ownerDecryptSpy: Mock<EnvelopeEncryptionProvider["decrypt"]>;
  let repository: SharedMemoryRepository;
  let collaboration: ReturnType<typeof createCollaborationRepository>;
  let syncRepository: ReturnType<typeof createCrossIdentitySyncRepository>;
  let retentionRepository: RetentionLifecycleRepository;
  const decryptCount = (): number =>
    decryptSpy.mock.calls.length + ownerDecryptSpy.mock.calls.length;

  const authority = (
    fixture: WorkspaceFixture,
    source: "owner" | "manager" = "owner"
  ): SharedMemoryAuthorityContext => ({
    action: SHARED_MEMORY_AUTHORITY,
    source: "browser_session",
    referenceId:
      source === "owner" ? fixture.ownerSessionId : fixture.managerSessionId
  });

  const createUser = async (label: string): Promise<string> => {
    const result = await pool.query<{ id: string }>(
      `insert into users (email, display_name)
       values ($1, $2) returning id`,
      [`shared-${label}-${randomUUID()}@example.com`, label]
    );
    return result.rows[0]!.id;
  };

  const createWorkspaceFixture = async (options?: {
    teamAllowed?: SharedMemoryRepresentation[];
    workspaceAllowed?: SharedMemoryRepresentation[];
    retentionSeconds?: number;
    deletionGraceSeconds?: number;
    backupRetentionSeconds?: number;
  }): Promise<WorkspaceFixture> => {
    const ownerUserId = await createUser("Owner");
    const readerUserId = await createUser("Reader");
    const managerUserId = await createUser("Manager");
    const outsiderUserId = await createUser("Outsider");
    const team = await pool.query<{ id: string }>(
      "insert into teams (name) values ($1) returning id",
      [`Shared Memory Team ${randomUUID()}`]
    );
    const teamId = team.rows[0]!.id;
    const workspace = await pool.query<{ id: string }>(
      `insert into team_workspaces (team_id, name)
       values ($1, $2) returning id`,
      [teamId, `Shared Memory Workspace ${randomUUID()}`]
    );
    const teamWorkspaceId = workspace.rows[0]!.id;
    const retentionPolicyId = randomUUID();
    const retentionEffectiveAt = new Date("2020-01-01T00:00:00.000Z");
    const retentionSeconds = options?.retentionSeconds ?? 2_592_000;
    const deletionGraceSeconds = options?.deletionGraceSeconds ?? 0;
    const backupRetentionSeconds = options?.backupRetentionSeconds ?? 2_592_000;
    await pool.query(
      `insert into retention_policies (
         policy_id, version, scope, team_id, retention_seconds,
         deletion_grace_seconds, backup_retention_seconds, policy_hash,
         created_by_user_id, effective_at
       ) values ($1,1,'team',$2,$3,$4,$5,$6,$7,$8)`,
      [
        retentionPolicyId,
        teamId,
        retentionSeconds,
        deletionGraceSeconds,
        backupRetentionSeconds,
        crossIdentitySyncDigest({
          policyId: retentionPolicyId,
          version: 1,
          target: { scope: "team", teamId },
          retentionSeconds,
          deletionGraceSeconds,
          backupRetentionSeconds,
          effectiveAt: retentionEffectiveAt.toISOString()
        }),
        ownerUserId,
        retentionEffectiveAt
      ]
    );
    await pool.query(
      `insert into team_memberships (
         team_id, user_id, role, status, accepted_at
       ) values
         ($1, $2, 'owner', 'enabled', now()),
         ($1, $3, 'member', 'enabled', now()),
         ($1, $4, 'admin', 'enabled', now())`,
      [teamId, ownerUserId, readerUserId, managerUserId]
    );
    await pool.query(
      `insert into team_workspace_access_grants (
         team_workspace_id, team_id, user_id, access,
         can_share_owned_memory, granted_by_user_id
       ) values
         ($1, $2, $3, 'write', true, $3),
         ($1, $2, $4, 'read', false, $3),
         ($1, $2, $5, 'write', true, $3)`,
      [teamWorkspaceId, teamId, ownerUserId, readerUserId, managerUserId]
    );
    const ownerSession = await pool.query<{ id: string }>(
      `insert into user_sessions (user_id, session_hash, expires_at)
       values ($1, $2, now() + interval '1 hour') returning id`,
      [ownerUserId, hash(`owner-session:${randomUUID()}`)]
    );
    const managerSession = await pool.query<{ id: string }>(
      `insert into user_sessions (user_id, session_hash, expires_at)
       values ($1, $2, now() + interval '1 hour') returning id`,
      [managerUserId, hash(`manager-session:${randomUUID()}`)]
    );
    const sourceDeployment = await pool.query<{
      id: string;
      protocol_deployment_id: string;
    }>(
      `insert into deployment_identities (
         protocol_deployment_id, locality, profile, display_name
       ) values ($1, 'remote', 'team_self_hosted', $2)
       returning id, protocol_deployment_id`,
      [randomUUID(), `Source ${randomUUID()}`]
    );
    const targetDeployment = await pool.query<{
      id: string;
      protocol_deployment_id: string;
    }>(
      `insert into deployment_identities (
         protocol_deployment_id, locality, profile, display_name
       ) values ($1, 'remote', 'team_self_hosted', $2)
       returning id, protocol_deployment_id`,
      [randomUUID(), `Target ${randomUUID()}`]
    );
    const sourceOwnerPrincipalId = randomUUID();
    const remoteExternalSubjectId = sourceOwnerPrincipalId;
    const remoteIdentity = await pool.query<{ id: string }>(
      `insert into sync_external_user_identities (
         deployment_identity_id, external_subject_id
       ) values ($1, $2) returning id`,
      [sourceDeployment.rows[0]!.id, remoteExternalSubjectId]
    );
    await pool.query(
      `insert into sync_principal_links (
         local_user_id, external_user_identity_id, proof_kind, proof_reference
       ) values ($1, $2, 'test_fixture', $3)`,
      [
        ownerUserId,
        remoteIdentity.rows[0]!.id,
        `shared-memory-principal-${randomUUID()}`
      ]
    );
    const credential = await pool.query<{ id: string }>(
      `insert into device_credentials (
         owner_user_id, credential_key_id, upstream_backend_id,
         device_instance_id, verifier_kind, verifier_hash, operation_families,
         metadata
       ) values ($1, $2, $3, $4, 'secret_hash', $5, $6::text[], $7::jsonb)
       returning id`,
      [
        ownerUserId,
        `shared-memory-key-${randomUUID()}`,
        `backend-${randomUUID()}`,
        `device-${randomUUID()}`,
        hash(`credential:${randomUUID()}`),
        ["share_grant_management", "team_workspace_read", "sync"],
        JSON.stringify({
          protocolDeploymentId:
            sourceDeployment.rows[0]!.protocol_deployment_id,
          sourceOwnerPrincipalId
        })
      ]
    );
    const fixture: WorkspaceFixture = {
      ownerUserId,
      readerUserId,
      managerUserId,
      outsiderUserId,
      ownerSessionId: ownerSession.rows[0]!.id,
      managerSessionId: managerSession.rows[0]!.id,
      teamId,
      teamWorkspaceId,
      sourceDeploymentId: sourceDeployment.rows[0]!.id,
      sourceProtocolDeploymentId: String(
        sourceDeployment.rows[0]!.protocol_deployment_id
      ),
      targetDeploymentId: targetDeployment.rows[0]!.id,
      targetProtocolDeploymentId: String(
        targetDeployment.rows[0]!.protocol_deployment_id
      ),
      remoteUserIdentityId: remoteIdentity.rows[0]!.id,
      remoteExternalSubjectId,
      sourceOwnerPrincipalId,
      deviceCredentialId: credential.rows[0]!.id
    };
    await repository.putTeamPolicy(actor(ownerUserId), {
      mutationId: randomUUID(),
      teamId,
      expectedCurrentVersion: 0,
      ...fidelityConsent(options?.teamAllowed ?? allRepresentations)
    });
    await repository.putWorkspacePolicy(actor(ownerUserId), {
      mutationId: randomUUID(),
      teamId,
      teamWorkspaceId,
      expectedCurrentVersion: 0,
      ...fidelityConsent(options?.workspaceAllowed ?? allRepresentations)
    });
    return fixture;
  };

  const createSource = async (
    fixture: WorkspaceFixture,
    sourceRevision = 1,
    label = `source-${sourceRevision}`,
    options?: SourceRevisionOptions
  ): Promise<SourceFixture> => {
    const session = await pool.query<{ id: string }>(
      `insert into sessions (
         owner_user_id, visibility, source_runtime, capture_method
       ) values ($1, 'personal', 'codex', 'transcript') returning id`,
      [fixture.ownerUserId]
    );
    const sourceSessionId = options?.distinctTargetSession
      ? randomUUID()
      : session.rows[0]!.id;
    if (options?.repositorySnapshot) {
      // Real target registration marks receiving Sessions before sync applies
      // the signed repository snapshot. Keep explicit-context fixtures faithful.
      await pool.query(
        "update sessions set metadata=metadata || '{\"syncReplica\":true}'::jsonb where id=$1",
        [session.rows[0]!.id]
      );
    }
    const ownerPrincipalId = fixture.sourceOwnerPrincipalId;
    const logicalMemoryId = crossIdentitySyncDeterministicUuid({
      protocol: "koed.captured-session-sync/v2",
      sourceDeploymentId: fixture.sourceProtocolDeploymentId,
      sourceUserId: ownerPrincipalId,
      originSessionId: sourceSessionId,
      identity: "logical-memory"
    });
    const logicalMemory = await pool.query<{ id: string }>(
      `with logical_memory as (
         insert into logical_memories (
           id, owner_user_id, owner_principal_id, origin_deployment_identity_id,
           source_kind, logical_key, latest_source_revision
         ) values ($1, $2, $3, $4, 'captured_session', $5, $6)
         returning id
       ), protocol_binding as (
         insert into captured_session_logical_memories (
           logical_memory_id,source_session_id,owner_principal_id
         ) select id,$7,$3 from logical_memory
       ), local_binding as (
         insert into local_captured_session_logical_memories (
           logical_memory_id,local_session_id,owner_user_id
         ) select id,$8,$2 from logical_memory
       )
       select id from logical_memory`,
      [
        logicalMemoryId,
        fixture.ownerUserId,
        ownerPrincipalId,
        fixture.sourceDeploymentId,
        `logical-${randomUUID()}`,
        0,
        sourceSessionId,
        session.rows[0]!.id
      ]
    );
    expect(logicalMemory.rows[0]!.id).toBe(logicalMemoryId);
    const replica = await pool.query<{ id: string }>(
      `insert into memory_replicas (
         logical_memory_id, deployment_identity_id, owner_user_id,
         owner_principal_id, replica_role, source_boundary,
         latest_revision, lifecycle, encryption_scope, freshness_status,
         representation_policy_revision, content_policy_version
       ) values (
         $1, $2, $3, $4, 'target', 'captured_session',
         $5, 'active', 'owner_private_replica', 'fresh', 1, 1
       ) returning id`,
      [
        logicalMemoryId,
        fixture.targetDeploymentId,
        fixture.ownerUserId,
        ownerPrincipalId,
        0
      ]
    );
    const remoteReplicaId = replica.rows[0]!.id;
    const sourceReplicaId = randomUUID();
    const relationship = await pool.query<{ id: string }>(
      `insert into cross_identity_sync_relationships (
         id,
         logical_memory_id, side, local_replica_id, local_user_id,
         device_credential_id, remote_deployment_identity_id,
         remote_user_identity_id, remote_replica_id, source_boundary,
         sync_mode, state, idempotency_key, creation_request_hash,
         source_cursor, target_processing_cursor, package_sequence, last_synced_at
       ) values (
         $1, $2, 'target', $3, $4, $5, $6, $7, $8::uuid, 'captured_session',
         'live', 'ready', $9::text, $10::text, $11::bigint, $11::bigint,
         $11::bigint, now()
       ) returning id`,
      [
        randomUUID(),
        logicalMemoryId,
        remoteReplicaId,
        fixture.ownerUserId,
        fixture.deviceCredentialId,
        fixture.sourceDeploymentId,
        fixture.remoteUserIdentityId,
        sourceReplicaId,
        `sync-${randomUUID()}`,
        hash(`sync-request:${randomUUID()}`),
        0
      ]
    );
    const source: SourceFixture = {
      logicalMemoryId,
      ownerPrincipalId,
      sourceDeploymentProtocolId: fixture.sourceProtocolDeploymentId,
      deviceCredentialId: fixture.deviceCredentialId,
      remoteReplicaId,
      sourceReplicaId,
      syncRelationshipId: relationship.rows[0]!.id,
      sessionId: sourceSessionId,
      localSessionId: session.rows[0]!.id,
      currentRevision: 0,
      currentLabel: "",
      packageSequence: 0,
      originEventId: deterministicUuid(logicalMemoryId, "origin-event"),
      seededEvents: [],
      leaf: {
        nodeId: "",
        originNodeId: "",
        summaryText: "",
        sourceEventIds: []
      },
      rollup: {
        nodeId: "",
        originNodeId: "",
        summaryText: "",
        sourceEventIds: []
      },
      lastSyncPackage: null,
      lastUploadSessionId: null
    };
    await seedAuthoritativeSourceRevision(
      fixture,
      source,
      sourceRevision,
      label,
      options
    );
    return source;
  };

  const applySyncPackage = async (
    source: SourceFixture,
    syncPackage: CapturedSessionSyncPackageV2,
    summarySnapshotIncluded = true
  ) => {
    const uploadSessionId = randomUUID();
    await pool.query(
      `insert into sync_package_upload_sessions (
         id, sync_relationship_id, protocol_package_id, request_hash,
         package_manifest, package_checksum, source_sequence, from_cursor,
         to_cursor, total_bytes, expected_chunk_count, idempotency_key
       ) values (
         $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12
       )`,
      [
        uploadSessionId,
        source.syncRelationshipId,
        syncPackage.packageId,
        hash(`upload-request:${syncPackage.packageId}`),
        JSON.stringify({
          objectClass: "sync_package",
          format: syncPackage.format,
          formatVersion: syncPackage.formatVersion,
          packageDigest: crossIdentitySyncDigest(syncPackage),
          repositorySnapshotHash: crossIdentitySyncDigest(
            syncPackage.session.repositorySnapshot
          ),
          recipientKeyId: "fixture-recipient",
          recipientKeyVersion: 1,
          recordCount:
            syncPackage.changes.length + syncPackage.summaryNodes.length,
          summaryRevisionHash: summarySnapshotIncluded
            ? syncPackage.summaryRevisionHash
            : null
        }),
        hash(`upload-checksum:${syncPackage.packageId}`),
        syncPackage.packageSequence,
        syncPackage.fromCursor,
        syncPackage.toCursor,
        Buffer.byteLength(JSON.stringify(syncPackage), "utf8"),
        1,
        `upload-${syncPackage.packageId}`
      ]
    );
    const result = await syncRepository.applyCapturedSessionSyncPackage({
      relationshipId: source.syncRelationshipId,
      uploadSessionId,
      package: syncPackage
    });
    return { ...result, uploadSessionId };
  };

  const seedAuthoritativeSourceRevision = async (
    fixture: WorkspaceFixture,
    source: SourceFixture,
    revision: number,
    label: string,
    options?: SourceRevisionOptions
  ): Promise<void> => {
    if (revision < source.currentRevision) {
      throw new Error("seedAuthoritativeSourceRevision cannot move backwards");
    }
    if (revision === source.currentRevision && !options?.summaryOnly) {
      return;
    }
    if (options?.summaryOnly && revision !== source.currentRevision)
      throw new Error("A summary-only package must retain the event cursor");
    const userText = `${label} user source`;
    const assistantText = options?.assistantText ?? `${label} assistant source`;
    const assistantPrimaryText = options?.groupedAssistantSources
      ? `${label} assistant`
      : assistantText;
    const userOccurredAt = occurredAtFor(revision * 10);
    const assistantOccurredAt = occurredAtFor(revision * 10 + 1);
    const capturedAt = occurredAtFor(revision * 10 + 2);
    const transportChunkGroupId = deterministicUuid(
      source.logicalMemoryId,
      String(revision),
      "transport-group"
    );
    const userContributor = buildCapturedSessionSyncContributor({
      originItemId: deterministicUuid(
        source.logicalMemoryId,
        String(revision),
        "user"
      ),
      actor: "user",
      kind: "user_message",
      content: userText,
      toolName: null,
      toolCallId: null,
      sourceEventTime: userOccurredAt,
      sourceSequence: revision * 10,
      sourceKind: "codex",
      sourceAdapterVersion: "1",
      sourceTransport: "test",
      sourceRecordType: "message",
      sourceEventType: "user_message",
      rawJson: { text: userText },
      rawText: userText,
      metadata: {
        actor: "user",
        seedLabel: label,
        role: "user",
        transportChunkGroupId
      },
      logicalSourceId: `logical-${label}-user`,
      transportChunkIndex: 0,
      transportChunkCount: 1,
      transportChunkText: userText,
      transportChunkEncoding: "utf8",
      projectionStatus: "projected",
      projectionVersion: "shared-memory-test-v1",
      projectionPolicyRevision: 1,
      memoryExcludedAt: null,
      memoryExclusionReason: null
    });
    const assistantContributor = buildCapturedSessionSyncContributor({
      originItemId: deterministicUuid(
        source.logicalMemoryId,
        String(revision),
        "assistant"
      ),
      actor: options?.assistantActor ?? "assistant",
      kind: options?.assistantKind ?? "assistant_message",
      content: assistantPrimaryText,
      toolName: options?.assistantToolName ?? null,
      toolCallId: null,
      sourceEventTime: assistantOccurredAt,
      sourceSequence: revision * 10 + 1,
      sourceKind: options?.assistantSourceKind ?? "codex",
      sourceAdapterVersion: "1",
      sourceTransport: "test",
      sourceRecordType: "message",
      sourceEventType: options?.assistantKind ?? "assistant_message",
      rawJson: options?.assistantRawJson ?? { text: assistantPrimaryText },
      rawText: options?.assistantRawText ?? assistantPrimaryText,
      metadata: {
        actor: options?.assistantActor ?? "assistant",
        seedLabel: label,
        role: options?.assistantActor ?? "assistant",
        ...(options?.assistantToolName
          ? { toolName: options.assistantToolName }
          : {}),
        transportChunkGroupId
      },
      logicalSourceId: `logical-${label}-assistant`,
      transportChunkIndex: 0,
      transportChunkCount: options?.groupedAssistantSources ? 2 : 1,
      transportChunkText: assistantPrimaryText,
      transportChunkEncoding: "utf8",
      projectionStatus: "projected",
      projectionVersion: "shared-memory-test-v1",
      projectionPolicyRevision: 1,
      memoryExcludedAt: options?.assistantMemoryExcludedAt ?? null,
      memoryExclusionReason: options?.assistantMemoryExclusionReason ?? null
    });
    const assistantContinuationContributor = options?.groupedAssistantSources
      ? buildCapturedSessionSyncContributor({
          originItemId: deterministicUuid(
            source.logicalMemoryId,
            String(revision),
            "assistant-continuation"
          ),
          actor: "assistant",
          kind: "assistant_message",
          content: "source",
          toolName: null,
          toolCallId: null,
          sourceEventTime: assistantOccurredAt,
          sourceSequence: revision * 10 + 2,
          sourceKind: "codex",
          sourceAdapterVersion: "1",
          sourceTransport: "test",
          sourceRecordType: "message",
          sourceEventType: "assistant_message",
          rawJson: { text: "source" },
          rawText: "source",
          metadata: {
            actor: "assistant",
            seedLabel: label,
            role: "assistant",
            transportChunkGroupId
          },
          logicalSourceId: `logical-${label}-assistant`,
          transportChunkIndex: 1,
          transportChunkCount: 2,
          transportChunkText: "source",
          transportChunkEncoding: "utf8",
          projectionStatus: "projected",
          projectionVersion: "shared-memory-test-v1",
          projectionPolicyRevision: 1,
          memoryExcludedAt: null,
          memoryExclusionReason: null
        })
      : null;
    const content = `${userText}\n${assistantText}`;
    const manifest = [
      {
        sourceIds: [userContributor.originItemId],
        actor: userContributor.actor,
        kind: userContributor.kind,
        toolName: userContributor.toolName ?? null,
        toolCallId: userContributor.toolCallId ?? null,
        sourceSequence: userContributor.sourceSequence,
        sourceEventTime: userContributor.sourceEventTime,
        offsetStart: 0,
        offsetEnd: userText.length
      },
      {
        sourceIds: [
          assistantContributor.originItemId,
          ...(assistantContinuationContributor
            ? [assistantContinuationContributor.originItemId]
            : [])
        ],
        actor: assistantContributor.actor,
        kind: assistantContributor.kind,
        toolName: assistantContributor.toolName ?? null,
        toolCallId: assistantContributor.toolCallId ?? null,
        sourceSequence: assistantContributor.sourceSequence,
        sourceEventTime: assistantContributor.sourceEventTime,
        offsetStart: userText.length + 1,
        offsetEnd: content.length
      }
    ];
    const event = buildCapturedSessionSyncEvent({
      originEventId: source.originEventId,
      eventType: "captured",
      actor: "assistant",
      content,
      metadata: { semanticItemManifest: manifest, seedLabel: label },
      includeInEmbedding: true,
      includeInLcm: true,
      projectionPolicyKey: "shared-memory-test",
      projectionPolicyRevision: 1,
      tokenCount: content.split(/\s+/).length,
      sealReason: "user_turn",
      capturedAt,
      sourceEventTime: capturedAt,
      sourceSequence: revision,
      contributors: [
        userContributor,
        assistantContributor,
        ...(assistantContinuationContributor
          ? [assistantContinuationContributor]
          : [])
      ]
    });
    const leafOriginNodeId = deterministicUuid(
      source.logicalMemoryId,
      "lcm-leaf"
    );
    const rollupOriginNodeId = deterministicUuid(
      source.logicalMemoryId,
      "lcm-rollup"
    );
    const leafSummaryText = `${label} synthesized source summary`;
    const leafBase = {
      originNodeId: leafOriginNodeId,
      kind: "leaf" as const,
      depth: 0,
      lcmAlgorithmVersion: "depth0-source-items-v1",
      summaryText: leafSummaryText,
      summaryModel: "test-lcm-model",
      summaryPromptVersion: "shared-memory-test-v1",
      summaryStructuredJson: {
        schema_version: LCM_SUMMARY_SCHEMA_VERSION,
        title: `${label} leaf`,
        summary_text: leafSummaryText,
        lexical_anchors: [label]
      },
      summaryStructuredSchemaVersion: LCM_SUMMARY_SCHEMA_VERSION,
      sourceOriginEventIds: [source.originEventId],
      childOriginNodeIds: [],
      sourceHash: hash(`leaf:${source.logicalMemoryId}:${revision}:${label}`),
      sourceEventCount: 1,
      sourceTokenEstimate: content.split(/\s+/).length,
      summaryTokenEstimate: leafSummaryText.split(/\s+/).length,
      createdAt: capturedAt,
      updatedAt: occurredAtFor(revision * 10 + 3)
    };
    const leaf = {
      ...leafBase,
      revisionHash: crossIdentitySyncDigest(leafBase)
    };
    const rollupSummaryText = `${label} synthesized rollup summary`;
    const rollupBase = {
      originNodeId: rollupOriginNodeId,
      kind: "rollup" as const,
      depth: 1,
      lcmAlgorithmVersion: "depth1-child-rollup-v1",
      summaryText: rollupSummaryText,
      summaryModel: "test-lcm-model",
      summaryPromptVersion: "shared-memory-test-v1",
      summaryStructuredJson: {
        schema_version: LCM_SUMMARY_SCHEMA_VERSION,
        title: `${label} rollup`,
        summary_text: rollupSummaryText,
        lexical_anchors: [label]
      },
      summaryStructuredSchemaVersion: LCM_SUMMARY_SCHEMA_VERSION,
      sourceOriginEventIds: [source.originEventId],
      childOriginNodeIds: [leafOriginNodeId],
      sourceHash: hash(`rollup:${source.logicalMemoryId}:${revision}:${label}`),
      sourceEventCount: 1,
      sourceTokenEstimate: content.split(/\s+/).length,
      summaryTokenEstimate: rollupSummaryText.split(/\s+/).length,
      createdAt: capturedAt,
      updatedAt: occurredAtFor(revision * 10 + 3)
    };
    const rollup = {
      ...rollupBase,
      revisionHash: crossIdentitySyncDigest(rollupBase)
    };
    const summaryNodes =
      options?.includeSummarySnapshot === false ? [] : [leaf, rollup];
    const syncPackage: CapturedSessionSyncPackageV2 = {
      format: CAPTURED_SESSION_SYNC_FORMAT,
      formatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
      policyVersion: CAPTURED_SESSION_SYNC_POLICY_VERSION,
      packageId: randomUUID(),
      relationshipId: source.syncRelationshipId,
      logicalMemoryId: source.logicalMemoryId,
      sourceDeploymentId: fixture.sourceProtocolDeploymentId,
      sourceUserId: fixture.remoteExternalSubjectId,
      sourceReplicaId: source.sourceReplicaId,
      targetDeploymentId: fixture.targetProtocolDeploymentId,
      targetUserId: fixture.ownerUserId,
      targetReplicaId: source.remoteReplicaId,
      packageSequence: source.packageSequence + 1,
      fromCursor: source.currentRevision,
      toCursor: revision,
      createdAt: occurredAtFor(revision * 10 + 3),
      consentDigest: hash(`consent:${source.logicalMemoryId}`),
      policyDigest: hash(`policy:${source.logicalMemoryId}`),
      summaryRevisionHash: crossIdentitySyncDigest(summaryNodes),
      session: {
        repositorySnapshot:
          options?.repositorySnapshot ?? unresolvedTeamRepositorySnapshot(),
        originSessionId: source.sessionId,
        externalSessionId: `external-${source.sessionId}`,
        sourceRuntime: "codex",
        captureMethod: "transcript",
        capturedAt,
        title: `${label} session`,
        sourceAdapterVersion: "1"
      },
      changes: options?.summaryOnly
        ? []
        : [
            {
              cursor: revision,
              operation: "upsert",
              originEventId: source.originEventId,
              revisionHash: event.revisionHash,
              event
            }
          ],
      summaryNodes
    };
    const applied = await applySyncPackage(
      source,
      syncPackage,
      options?.includeSummarySnapshot !== false
    );
    const eventId = options?.summaryOnly
      ? source.seededEvents[0]?.eventId
      : applied.eventIds[0];
    if (!eventId) {
      throw new Error("expected synchronized event to materialize");
    }
    const persistedContributors = await pool.query<{ id: string }>(
      `select ci.id
         from memory_event_sources mes
         join conversation_items ci on ci.id = mes.conversation_item_id
        where mes.memory_event_id = $1
        order by mes.source_order, ci.id`,
      [eventId]
    );
    source.currentRevision = revision;
    source.currentLabel = label;
    source.packageSequence = syncPackage.packageSequence;
    source.seededEvents = [
      {
        eventId,
        originEventId: source.originEventId,
        sourceCursor: revision,
        contributorIds: persistedContributors.rows.map((row) => row.id),
        occurredAt: capturedAt,
        content
      }
    ];
    if (options?.includeSummarySnapshot !== false) {
      source.leaf = {
        nodeId: applied.summaryNodeIds[0]!,
        originNodeId: leafOriginNodeId,
        summaryText: leafSummaryText,
        sourceEventIds: [eventId]
      };
      source.rollup = {
        nodeId: applied.summaryNodeIds[1]!,
        originNodeId: rollupOriginNodeId,
        summaryText: rollupSummaryText,
        sourceEventIds: [eventId]
      };
    }
    source.lastSyncPackage = syncPackage;
    source.lastUploadSessionId = applied.uploadSessionId;
  };

  const ensureSourceRevision = async (
    fixture: WorkspaceFixture,
    source: SourceFixture,
    sourceRevision: number,
    label: string
  ): Promise<void> => {
    if (sourceRevision > source.currentRevision) {
      await seedAuthoritativeSourceRevision(
        fixture,
        source,
        sourceRevision,
        label
      );
    }
  };

  const prepareSanitizedSemanticPreview = async (
    ownerUserId: string,
    preview: Pick<SharedMemoryPersistedPreviewRecord, "previewId">,
    targetRepository: SharedMemoryRepository = repository,
    sanitizeText: (text: string) => string = (text) => text
  ): Promise<void> => {
    const targets = await targetRepository.listPendingSemanticPrivacyTargets({
      sourcePreviewId: preview.previewId,
      limit: 10
    });
    for (const target of targets) {
      expect(target.sourcePreviewId).toBe(preview.previewId);
      const loaded = await targetRepository.readPendingSemanticPrivacyTarget(
        actor(ownerUserId),
        {
          semanticPreviewId: target.id,
          expectedSourcePreviewHash: target.sourcePreviewHash,
          expectedSourceArtifactHash: target.sourceArtifactHash,
          expectedSourceManifestHash: target.sourceManifestHash,
          expectedClassifierHash: target.classifierHash,
          expectedEffectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash
        }
      );
      if (!loaded) {
        throw new Error("Pending semantic privacy target was not readable");
      }
      const fields = loaded.classificationFields.map(({ path, text }) => ({
        path,
        text
      }));
      const maskedFields = loaded.classificationFields.map((field) => ({
        path: field.path,
        inputSha256: field.inputSha256,
        inputByteLength: field.inputByteLength,
        sanitizedText: sanitizeText(field.text)
      }));
      const claim = await targetRepository.claimSemanticPrivacyTarget(
        actor(ownerUserId),
        {
          semanticPreviewId: target.id,
          claimantId: "shared-memory-repository-test",
          leaseMs: 120_000,
          expectedWorkIdentity: sharedMemorySemanticPrivacyWorkIdentity(target)
        }
      );
      if (!claim) throw new Error("Semantic privacy target was not claimable");
      const fieldChunks = Array.from(
        { length: Math.ceil(fields.length / 16) },
        (_, chunkIndex) => fields.slice(chunkIndex * 16, chunkIndex * 16 + 16)
      );
      const chunkBindings = fieldChunks.map((chunk, chunkIndex) => ({
        chunkIndex,
        firstFieldIndex: chunkIndex * 16,
        fieldCount: chunk.length,
        inputIdentityHash: privacyRepository.classificationInputIdentity({
          actor: actor(ownerUserId),
          fields: chunk
        }),
        orderedInputHash: privacyClassificationOrderedInputHash(chunk)
      }));
      const expectedManifestHash = privacyClassificationExpectedManifestHash({
        semanticPreviewId: target.id,
        sourcePreviewHash: target.sourcePreviewHash,
        sourceArtifactHash: target.sourceArtifactHash,
        sourceManifestHash: target.sourceManifestHash,
        sourceRevision: target.sourceRevision,
        classifierGenerationId: target.classifierGenerationId,
        classifierHash: target.classifierHash,
        effectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash,
        fieldCount: fields.length,
        chunks: chunkBindings
      });
      await targetRepository.initializeSemanticPrivacyManifest(
        actor(ownerUserId),
        {
          claim,
          expectedManifestHash,
          fieldCount: fields.length,
          fieldByteCount: fields.reduce(
            (total, field) => total + Buffer.byteLength(field.text, "utf8"),
            0
          ),
          chunks: chunkBindings
        }
      );
      for (const [chunkIndex, chunk] of fieldChunks.entries()) {
        const response: PrivacyClassificationResponse = {
          schemaVersion: 1,
          inputContractVersion: "koed-privacy-classification-v1",
          classifier: {
            classifierHash: privacyClassifier.classifierHash,
            modelKey: privacyClassifier.modelKey,
            modelRevision: privacyClassifier.modelRevision
          },
          fields: maskedFields
            .slice(chunkIndex * 16, chunkIndex * 16 + chunk.length)
            .map((field) => ({
              path: field.path,
              inputSha256: field.inputSha256,
              inputByteLength: field.inputByteLength,
              maskedText: field.sanitizedText,
              decodedTextMatchesInput: true,
              spans: []
            }))
        };
        const classification =
          await privacyRepository.storeClassificationResult({
            actor: actor(ownerUserId),
            provider: privacyProvider,
            fields: chunk,
            response
          });
        await targetRepository.attachSemanticPrivacyChunkResult(
          actor(ownerUserId),
          {
            claim,
            chunkIndex,
            inputIdentityHash: chunkBindings[chunkIndex]!.inputIdentityHash,
            orderedInputHash: chunkBindings[chunkIndex]!.orderedInputHash,
            classificationResultId: classification.id,
            classificationPayloadBindingHash: classification.payloadBindingHash!
          }
        );
      }
      const manifest = await targetRepository.listSemanticPrivacyManifest(
        actor(ownerUserId),
        { claim }
      );
      const resultManifestHash = privacyClassificationResultManifestHash({
        expectedManifestHash,
        chunks: manifest.map((entry) => ({
          chunkIndex: entry.chunkIndex,
          firstFieldIndex: entry.firstFieldIndex,
          fieldCount: entry.fieldCount,
          inputIdentityHash: entry.inputIdentityHash,
          orderedInputHash: entry.orderedInputHash,
          classificationResultId: entry.classificationResultId!,
          classificationPayloadBindingHash:
            entry.classificationPayloadBindingHash!
        }))
      });
      const sanitizedItems = reconstructSharedMemorySemanticSanitizedItems(
        loaded.preview.items,
        maskedFields
      );
      await targetRepository.storeSanitizedSemanticPreview(actor(ownerUserId), {
        semanticPreviewId: target.id,
        expectedSourcePreviewHash: target.sourcePreviewHash,
        expectedSourceArtifactHash: target.sourceArtifactHash,
        expectedSourceManifestHash: target.sourceManifestHash,
        expectedSourceRevision: target.sourceRevision,
        expectedSourceItemIdentityHash: loaded.sourceItemIdentityHash,
        expectedClassifierHash: target.classifierHash,
        expectedEffectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash,
        claim,
        expectedManifestHash,
        expectedResultManifestHash: resultManifestHash,
        items: sanitizedItems,
        sanitizedContentHash: crossIdentitySyncDigest(sanitizedItems)
      });
    }
  };

  const flushSanitizedSemanticPublication = async (): Promise<void> => {
    for (;;) {
      const targets = await repository.listPendingSemanticPrivacyTargets({
        limit: 100
      });
      for (const target of targets) {
        await prepareSanitizedSemanticPreview(target.ownerUserId, {
          previewId: target.sourcePreviewId
        });
      }
      const publication =
        await repository.reconcileReadySemanticRepresentations({ limit: 100 });
      if (targets.length < 100 && publication.materialized < 100) return;
    }
  };

  const processPendingSharesAfterPrivacy = async (
    pendingShareId: string,
    input: Parameters<SharedMemoryRepository["processPendingShares"]>[0] = {},
    sanitizeText: (text: string) => string = (text) => text,
    concurrentActivation = false
  ) => {
    await expect(repository.processPendingShares(input)).resolves.toMatchObject(
      {
        claimed: 1,
        activated: 0,
        waiting: 1,
        failed: 0
      }
    );
    const pending = await pool.query<{ grant_id: string }>(
      `select grant_id
         from pending_share_operations
        where id=$1 and state='preparing' and stage='privacy_filtering'`,
      [pendingShareId]
    );
    const grantId = pending.rows[0]?.grant_id;
    if (!grantId) {
      throw new Error("Pending Share did not retain its unavailable grant");
    }
    const targets = await repository.listPendingSemanticPrivacyTargets({
      shareGrantId: grantId,
      limit: 100
    });
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      await prepareSanitizedSemanticPreview(
        target.ownerUserId,
        {
          previewId: target.sourcePreviewId
        },
        repository,
        sanitizeText
      );
    }
    await pool.query(
      `update pending_share_outbox outbox
          set available_at=now()
         from pending_share_operations pending
        where pending.id=outbox.pending_share_id
          and pending.id=$1
          and pending.state='preparing'
          and pending.stage='privacy_filtering'`,
      [pendingShareId]
    );
    if (!concurrentActivation) return repository.processPendingShares(input);
    const concurrentRepository = createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: () => provider,
      resolvePersonalEncryptionProvider: () => privacyProvider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider
    });
    const runs = await Promise.all([
      repository.processPendingShares(input),
      concurrentRepository.processPendingShares(input)
    ]);
    return runs.reduce(
      (total, run) => ({
        claimed: total.claimed + run.claimed,
        activated: total.activated + run.activated,
        waiting: total.waiting + run.waiting,
        failed: total.failed + run.failed
      }),
      { claimed: 0, activated: 0, waiting: 0, failed: 0 }
    );
  };

  const capturedSourceBinding = (
    source: SourceFixture,
    activationRepresentation: SharedMemoryRepresentation,
    sourceCapabilities: SharedMemoryRepresentation[] = allRepresentations
  ) => ({
    source: {
      kind: "captured_session" as const,
      logicalMemoryId: source.logicalMemoryId,
      sessionId: source.sessionId
    },
    sourceDeploymentProtocolId: source.sourceDeploymentProtocolId,
    sourceOwnerPrincipalId: source.ownerPrincipalId,
    deviceCredentialId: source.deviceCredentialId,
    sourceCapabilities,
    activationRepresentation
  });

  const reviewedSourceBinding = (
    preview: SharedMemoryPersistedPreviewRecord
  ) => ({
    source: preview.source!,
    sourceCapabilities: preview.sourceCapabilities,
    activationRepresentation: preview.activationRepresentation
  });

  const createPersistedPreview = async (
    fixture: WorkspaceFixture,
    source: SourceFixture,
    representation: SharedMemoryRepresentation,
    sourceRevision = source.currentRevision,
    label = source.currentLabel,
    representations: SharedMemoryRepresentation[] = allRepresentations,
    mode: SharedMemoryConsentMode = "continuous"
  ) => {
    await ensureSourceRevision(fixture, source, sourceRevision, label);
    const preview = await repository.createAuthoritativeSourcePreview(
      actor(fixture.ownerUserId),
      {
        ...capturedSourceBinding(source, representation, representations),
        logicalMemoryId: source.logicalMemoryId,
        remoteReplicaId: source.remoteReplicaId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        mode,
        ...fidelityConsent(representations),
        authority: authority(fixture)
      }
    );
    await prepareSanitizedSemanticPreview(fixture.ownerUserId, preview);
    return preview;
  };

  const putOwnerPolicy = async (
    fixture: WorkspaceFixture,
    source: SourceFixture,
    representations: SharedMemoryRepresentation[] = allRepresentations
  ) =>
    repository.putSourceOwnerPolicy(actor(fixture.ownerUserId), {
      mutationId: randomUUID(),
      logicalMemoryId: source.logicalMemoryId,
      expectedCurrentVersion: 0,
      ...fidelityConsent(representations)
    });

  const createConsent = async (
    fixture: WorkspaceFixture,
    source: SourceFixture,
    input: {
      representation: SharedMemoryRepresentation;
      mode: SharedMemoryConsentMode;
      representations?: SharedMemoryRepresentation[];
      sourceRevision?: number;
      label: string;
      consentId?: string;
    }
  ) => {
    const preview = await createPersistedPreview(
      fixture,
      source,
      input.representation,
      input.sourceRevision ?? source.currentRevision,
      input.label,
      input.representations ?? allRepresentations,
      input.mode
    );
    const consentId = input.consentId ?? randomUUID();
    const consent = await repository.createSourceOwnerConsent(
      actor(fixture.ownerUserId),
      {
        source: preview.source!,
        sourceCapabilities: preview.sourceCapabilities,
        activationRepresentation: preview.activationRepresentation,
        consentId,
        mode: input.mode,
        ...fidelityConsent(input.representations ?? allRepresentations),
        authority: authority(fixture),
        preview
      }
    );
    return { consent, consentId, preview };
  };

  const createGrant = async (
    fixture: WorkspaceFixture,
    options: {
      representation?: SharedMemoryRepresentation;
      mode?: SharedMemoryConsentMode;
      ownerAllowed?: SharedMemoryRepresentation[];
      sourceRevision?: number;
      label?: string;
      assistantText?: string;
      sanitizeText?: (text: string) => string;
    } = {}
  ): Promise<GrantFixture> => {
    const representation = options.representation ?? "memory_events";
    const source = await createSource(
      fixture,
      options.sourceRevision ?? 1,
      options.label ?? representation,
      options.assistantText === undefined
        ? undefined
        : { assistantText: options.assistantText }
    );
    await putOwnerPolicy(
      fixture,
      source,
      options.ownerAllowed ?? allRepresentations
    );
    const created = await createConsent(fixture, source, {
      representation,
      mode: options.mode ?? "continuous",
      representations: options.ownerAllowed ?? allRepresentations,
      label: options.label ?? representation
    });
    const grant = await repository.createShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: created.consentId,
        authority: authority(fixture)
      }
    );
    await prepareSanitizedSemanticPreview(
      fixture.ownerUserId,
      created.preview,
      repository,
      options.sanitizeText
    );
    return {
      ...source,
      consentId: created.consentId,
      shareGrantId: grant.id,
      grantVersion: grant.grantVersion,
      representation,
      maximumFidelity: grant.maximumFidelity,
      includeCuratedMemory: grant.includeCuratedMemory,
      preview: created.preview
    };
  };

  const ensurePendingShareCompanion = async ({
    actor: owner,
    grant
  }: {
    actor: ActorContext;
    grant: SharedMemoryGrantRecord;
  }) =>
    (await collaboration.createThread(owner, {
      kind: "shared_session_discussion",
      idempotencyKey: `pending-share-${grant.id}`,
      teamId: grant.teamId,
      teamWorkspaceId: grant.teamWorkspaceId,
      sharedLogicalMemoryId: grant.logicalMemoryId,
      shareGrantId: grant.id,
      pendingShareActivation: true
    })) !== null;

  const candidateManifest = (
    source: SourceFixture,
    representation: SharedMemoryRepresentation
  ) => {
    const sourceId =
      representation === "memory_events"
        ? source.seededEvents[0]!.originEventId
        : representation === "lcm_leaves"
          ? source.leaf.originNodeId
          : source.rollup.originNodeId;
    return [
      {
        sourceId,
        revisionHash: crossIdentitySyncDigest({
          version: 1,
          sourceId,
          representation,
          sourceRevision: source.currentRevision
        })
      }
    ];
  };

  const materialize = async (
    fixture: WorkspaceFixture,
    grant: GrantFixture,
    options?: {
      sourceRevision?: number;
      label?: string;
      mutationId?: string;
      expectedRepresentationVersion?: number;
    }
  ) => {
    const sourceRevision = options?.sourceRevision ?? grant.currentRevision;
    const label = options?.label ?? grant.currentLabel;
    const preview = await createPersistedPreview(
      fixture,
      grant,
      grant.representation,
      sourceRevision,
      label,
      grant.preview.sourceCapabilities,
      grant.preview.mode
    );
    return repository.materializeGrantRepresentation(
      actor(fixture.ownerUserId),
      {
        mutationId: options?.mutationId ?? randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId: grant.consentId,
        expectedGrantVersion: grant.grantVersion,
        expectedRepresentationVersion: options?.expectedRepresentationVersion,
        preview
      }
    );
  };

  const materializeWithPreview = async (
    fixture: WorkspaceFixture,
    grant: GrantFixture,
    options?: {
      sourceRevision?: number;
      label?: string;
      mutationId?: string;
      expectedRepresentationVersion?: number;
    }
  ) => {
    const sourceRevision = options?.sourceRevision ?? grant.currentRevision;
    const label = options?.label ?? grant.currentLabel;
    const preview = await createPersistedPreview(
      fixture,
      grant,
      grant.representation,
      sourceRevision,
      label,
      grant.preview.sourceCapabilities,
      grant.preview.mode
    );
    const representation = await repository.materializeGrantRepresentation(
      actor(fixture.ownerUserId),
      {
        mutationId: options?.mutationId ?? randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId: grant.consentId,
        expectedGrantVersion: grant.grantVersion,
        expectedRepresentationVersion: options?.expectedRepresentationVersion,
        preview
      }
    );
    return { preview, representation };
  };

  const readMemoryPipelineCounts = async (): Promise<
    Record<string, string>
  > => {
    const result = await pool.query<Record<string, string>>(
      `select
         (select count(*) from conversation_items)::text as conversation_items,
         (select count(*) from memory_events)::text as memory_events,
         (select count(*) from memory_event_sources)::text as memory_event_sources,
         (select count(*) from memory_nodes)::text as memory_nodes,
         (select count(*) from memory_node_sources)::text as memory_node_sources,
         (select count(*) from memory_embeddings)::text as memory_embeddings,
         (select count(*) from memory_embeddings_384)::text as memory_embeddings_384,
         (select count(*) from memory_embeddings_1024)::text as memory_embeddings_1024,
         (select count(*) from memory_embeddings_1536)::text as memory_embeddings_1536,
         (select count(*) from memory_embeddings_3072)::text as memory_embeddings_3072,
         (select count(*) from memory_questions)::text as memory_questions,
         (select count(*) from workflow_token_usage_source_references)::text as ai_sources,
         (select count(*) from local_work_queue)::text as queued_projection_work`
    );
    return result.rows[0]!;
  };

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
    const deployment = await pool.query<{ id: string }>(
      `insert into deployment_identities (
         protocol_deployment_id, locality, profile, display_name
       ) values ($1, 'local', 'local_personal', 'Shared Memory test')
       returning id`,
      [randomUUID()]
    );
    privacyRepository = createPrivacyClassificationRepository(pool, {
      fingerprintKey: "shared-memory-privacy-test-fingerprint-key-v1"
    });
    const registered = await privacyRepository.registerClassifierGeneration({
      version: 1,
      modelKey: "openai-privacy-filter",
      modelRevision: "shared-memory-test-v1",
      artifactSha256: hash("privacy-artifact"),
      tokenizerSha256: hash("privacy-tokenizer"),
      decoderSha256: hash("privacy-decoder"),
      calibrationSha256: hash("privacy-calibration"),
      deterministicDetectorVersion: "structured-secrets-v1"
    });
    privacyClassifier = await privacyRepository.activateClassifierGeneration(
      registered.id
    );
    await privacyRepository.createContentPolicyVersion({
      scope: "deployment",
      subject: { deploymentIdentityId: deployment.rows[0]!.id },
      labels: noPrivacyLabelsPolicy(),
      expectedPreviousVersion: 0
    });
  });

  beforeEach(() => {
    const base = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 41).toString("base64")
    );
    const ownerBase = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 42).toString("base64")
    );
    privacyProvider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 43).toString("base64")
    );
    encryptSpy = vi.fn(base.encrypt.bind(base));
    decryptSpy = vi.fn(base.decrypt.bind(base));
    ownerEncryptSpy = vi.fn(ownerBase.encrypt.bind(ownerBase));
    ownerDecryptSpy = vi.fn(ownerBase.decrypt.bind(ownerBase));
    provider = {
      ...base,
      encrypt: encryptSpy,
      decrypt: decryptSpy,
      rewrap: base.rewrap?.bind(base)
    } satisfies EnvelopeEncryptionProvider;
    ownerProvider = {
      ...ownerBase,
      encrypt: ownerEncryptSpy,
      decrypt: ownerDecryptSpy,
      rewrap: ownerBase.rewrap?.bind(ownerBase)
    } satisfies EnvelopeEncryptionProvider;
    repository = createSharedMemoryRepository(pool, {
      resolvePersonalEncryptionProvider: () => privacyProvider,
      resolveTeamEncryptionProvider: () => provider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider,
      resolveSharingRuleEncryptionProvider: () => ownerProvider
    });
    collaboration = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    syncRepository = createCrossIdentitySyncRepository(pool, {
      ownerPrivateReplicaEnvelopeEncryptionProvider: ownerProvider
    });
    retentionRepository = createRetentionLifecycleRepository(pool, {
      authorizeHoldActor: async () => true
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
  });

  it.each(["published", "lost_access"])(
    "excludes an owned Conversation from a Workspace: %s",
    async (scenario) => {
      const fixture = await createWorkspaceFixture();
      const grant = await createGrant(fixture, {
        label: `workspace-exclusion-${scenario}`,
        mode: "snapshot"
      });
      await materialize(fixture, grant);
      const owner = actor(fixture.ownerUserId);
      const scope = {
        logicalMemoryId: grant.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId
      };
      const review = await repository.getWorkspaceConversationExclusionReview(
        owner,
        scope
      );
      expect(review).not.toBeNull();
      expect(review!.exclusion).toBeNull();
      await expect(
        repository.getWorkspaceConversationExclusionReview(
          actor(fixture.outsiderUserId),
          scope
        )
      ).resolves.toBeNull();
      if (scenario === "lost_access")
        await pool.query(
          "update team_workspace_access_grants set disabled_at=now() where user_id=$1 and team_workspace_id=$2",
          [fixture.ownerUserId, fixture.teamWorkspaceId]
        );
      const personalBefore = (
        await pool.query(
          "select id,payload from memory_events where session_id=$1 order by id",
          [grant.localSessionId]
        )
      ).rows;
      const input = {
        mutationId: randomUUID(),
        scope: review!.scope,
        authority: authority(fixture)
      };
      const excluded = await repository.excludeWorkspaceConversation(
        owner,
        input
      );
      expect(excluded).toMatchObject({
        ...scope,
        ownerUserId: fixture.ownerUserId,
        state: "excluded",
        version: 1
      });
      expect(
        await repository.excludeWorkspaceConversation(owner, input)
      ).toEqual(excluded);
      await expect(
        repository.excludeWorkspaceConversation(owner, {
          ...input,
          mutationId: randomUUID()
        })
      ).rejects.toThrow();
      await expect(
        repository.excludeWorkspaceConversation(
          actor(fixture.outsiderUserId),
          input
        )
      ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
      await expect(
        repository.readGrantRepresentation(actor(fixture.readerUserId), {
          shareGrantId: grant.shareGrantId,
          representation: "memory_events"
        })
      ).resolves.toBeNull();
      expect(
        await repository.getOwnerShare(owner, {
          kind: "grant",
          id: grant.shareGrantId
        })
      ).toMatchObject({ summary: { workspaceExclusion: excluded } });
      expect(
        (
          await pool.query(
            "select id,payload from memory_events where session_id=$1 order by id",
            [grant.localSessionId]
          )
        ).rows
      ).toEqual(personalBefore);
      expect(
        (
          await pool.query<{ state: string }>(
            "select state from source_owner_representation_consents where id=$1",
            [grant.consentId]
          )
        ).rows[0]!.state
      ).toBe("revoked");
      expect(
        (
          await pool.query<{ count: string }>(
            "select count(*)::text as count from team_memory_workspace_exclusion_mutations where exclusion_id=$1",
            [excluded.id]
          )
        ).rows[0]!.count
      ).toBe("1");
      await expect(
        repository.materializeGrantRepresentation(owner, {
          mutationId: randomUUID(),
          shareGrantId: grant.shareGrantId,
          consentId: grant.consentId,
          expectedGrantVersion: grant.grantVersion,
          preview: grant.preview
        })
      ).rejects.toThrow();
      if (scenario === "published") {
        const restoration =
          await repository.getWorkspaceConversationRestorationReview(
            owner,
            scope
          );
        expect(restoration).toMatchObject({ rules: [], exclusion: excluded });
        const restoreIntent = {
          mutationId: randomUUID(),
          scope: restoration!.scope,
          restoration: restoration!,
          authority: authority(fixture)
        };
        await expect(
          repository.restoreWorkspaceConversation(owner, restoreIntent)
        ).rejects.toThrow("native approval");
        const restored = await executeWorkspaceRestoration(
          fixture,
          restoreIntent
        );
        expect(restored).toMatchObject({
          id: excluded.id,
          state: "restored",
          version: 2
        });
        expect(
          await executeWorkspaceRestoration(fixture, restoreIntent)
        ).toEqual(restored);
        await expect(
          executeWorkspaceRestoration(fixture, {
            ...restoreIntent,
            mutationId: randomUUID()
          })
        ).rejects.toThrow();
        expect(
          await repository.readGrantRepresentation(
            actor(fixture.readerUserId),
            {
              shareGrantId: grant.shareGrantId,
              representation: "memory_events"
            }
          )
        ).toBeNull();
        expect(
          (
            await pool.query<{ state: string }>(
              "select state from source_owner_representation_consents where id=$1",
              [grant.consentId]
            )
          ).rows[0]!.state
        ).toBe("revoked");
        expect(
          await repository.reconcileSharingRuleMembers({ limit: 10 })
        ).toMatchObject({ processed: 0, failed: 0 });
        await expect(
          repository.excludeWorkspaceConversation(owner, {
            ...input,
            mutationId: randomUUID()
          })
        ).rejects.toThrow();
      }
    }
  );

  it.each(["active", "paused", "stopped"] as const)(
    "restores exclusion through current %s Conversation rule authority",
    async (scenario) => {
      const fixture = await createWorkspaceFixture();
      const owner = actor(fixture.ownerUserId);
      const source = await createSource(fixture, 1, `restoration-${scenario}`);
      await putOwnerPolicy(fixture, source);
      const consent = await createConsent(fixture, source, {
        representation: "memory_events",
        mode: "continuous",
        label: `restoration-${scenario}`
      });
      const deploymentIdentityId = (
        await pool.query<{ id: string }>(
          "select id from deployment_identities where locality='local' and disabled_at is null"
        )
      ).rows[0]!.id;
      const policy = await privacyRepository.resolveEffectiveContentPolicy({
        deploymentIdentityId,
        sourceOwnerUserId: fixture.ownerUserId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId
      });
      const rule = await repository.createConversationSharingRule(owner, {
        ruleId: randomUUID(),
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: consent.consentId,
        expectedConsentVersion: consent.consent.consentVersion,
        expectedGrantVersion: null,
        publisherCredentialId: fixture.deviceCredentialId,
        effectivePrivacyPolicyHash: policy.effectivePolicyHash,
        authority: authority(fixture)
      });
      const current = async () =>
        (
          await pool.query<{
            grant_version: number;
            authority_version: number;
            state: string;
          }>(
            "select g.grant_version,rule.authority_version,rule.state from team_memory_share_grants g join team_memory_sharing_rules rule on rule.id=$2 where g.id=$1",
            [rule.shareGrantId, rule.ruleId]
          )
        ).rows[0]!;
      await repository.prepareSharingRuleMember(owner, {
        shareGrantId: rule.shareGrantId,
        expectedGrantVersion: (await current()).grant_version,
        ruleAuthority: {
          ruleId: rule.ruleId,
          reasonId: rule.reasonId,
          authorityVersion: rule.authorityVersion,
          consentVersion: consent.consent.consentVersion,
          publisherCredentialId: fixture.deviceCredentialId,
          publisherFence: rule.publisherFence,
          effectivePrivacyPolicyHash: policy.effectivePolicyHash
        }
      });
      await flushSanitizedSemanticPublication();
      const read = () =>
        repository.readGrantRepresentation(actor(fixture.readerUserId), {
          shareGrantId: rule.shareGrantId,
          representation: "memory_events"
        });
      expect(await read()).toMatchObject({
        representation: { sourceRevision: 1 }
      });
      const scope = {
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId
      };
      const exclusionReview =
        await repository.getWorkspaceConversationExclusionReview(owner, scope);
      await repository.excludeWorkspaceConversation(owner, {
        mutationId: randomUUID(),
        scope: exclusionReview!.scope,
        authority: authority(fixture)
      });
      const stale = await repository.getWorkspaceConversationRestorationReview(
        owner,
        scope
      );
      if (scenario !== "active") {
        const before = await current();
        await repository.controlConversationSharingRule(owner, {
          mutationId: randomUUID(),
          ruleId: rule.ruleId,
          reasonId: rule.reasonId,
          shareGrantId: rule.shareGrantId,
          expectedAuthorityVersion: before.authority_version,
          expectedGrantVersion: before.grant_version,
          action: scenario === "paused" ? "pause" : "stop",
          authority: authority(fixture),
          destination: {
            teamId: fixture.teamId,
            teamWorkspaceId: fixture.teamWorkspaceId
          }
        });
        await expect(
          executeWorkspaceRestoration(fixture, {
            mutationId: randomUUID(),
            scope: stale!.scope,
            restoration: stale!,
            authority: authority(fixture)
          })
        ).rejects.toThrow("stale");
      }
      if (scenario !== "paused")
        await ensureSourceRevision(
          fixture,
          source,
          2,
          `restoration-later-${scenario}`
        );
      const restoration =
        await repository.getWorkspaceConversationRestorationReview(
          owner,
          scope
        );
      expect(restoration!.rules).toEqual([
        expect.objectContaining({
          ruleId: rule.ruleId,
          state: scenario,
          eligible: scenario === "active"
        })
      ]);
      const intent = {
        mutationId: randomUUID(),
        scope: restoration!.scope,
        restoration: restoration!,
        authority: authority(fixture)
      };
      const restored = await executeWorkspaceRestoration(fixture, intent);
      expect(restored).toMatchObject({ state: "restored", version: 2 });
      expect(await executeWorkspaceRestoration(fixture, intent)).toEqual(
        restored
      );
      expect(await read()).toBeNull();
      expect(
        (await repository.reconcileSharingRuleMembers({ limit: 100 })).failed
      ).toBe(0);
      await flushSanitizedSemanticPublication();
      expect((await current()).state).toBe(scenario);
      if (scenario === "active")
        expect(await read()).toMatchObject({
          representation: { sourceRevision: 2 }
        });
      else expect(await read()).toBeNull();
      if (scenario === "paused") {
        const before = await current();
        await repository.controlConversationSharingRule(owner, {
          mutationId: randomUUID(),
          ruleId: rule.ruleId,
          reasonId: rule.reasonId,
          shareGrantId: rule.shareGrantId,
          expectedAuthorityVersion: before.authority_version,
          expectedGrantVersion: before.grant_version,
          action: "resume",
          authority: authority(fixture),
          destination: {
            teamId: fixture.teamId,
            teamWorkspaceId: fixture.teamWorkspaceId
          }
        });
        expect(
          (await repository.reconcileSharingRuleMembers({ limit: 100 })).failed
        ).toBe(0);
        await flushSanitizedSemanticPublication();
        expect(await read()).toMatchObject({
          representation: { sourceRevision: 1 }
        });
      }
    }
  );

  it.each([
    "publish",
    "stop_snapshot",
    "expand_owner_policy",
    "stale"
  ] as const)(
    "adds an independently reviewed direct snapshot after a rule: %s",
    async (scenario) => {
      const fixture = await createWorkspaceFixture();
      const owner = actor(fixture.ownerUserId),
        reader = actor(fixture.readerUserId);
      const source = await createSource(
        fixture,
        1,
        "rule-first-direct-snapshot"
      );
      await putOwnerPolicy(
        fixture,
        source,
        scenario === "expand_owner_policy"
          ? ["lcm_rollups"]
          : allRepresentations
      );
      const ruleConsent = await createConsent(fixture, source, {
        representation: "lcm_rollups",
        representations: ["lcm_rollups"],
        mode: "continuous",
        label: "rule-first-direct-snapshot"
      });
      const deploymentIdentityId = (
        await pool.query<{ id: string }>(
          "select id from deployment_identities where locality='local' and disabled_at is null"
        )
      ).rows[0]!.id;
      const privacy = await privacyRepository.resolveEffectiveContentPolicy({
        deploymentIdentityId,
        sourceOwnerUserId: fixture.ownerUserId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId
      });
      const rule = await repository.createConversationSharingRule(owner, {
        ruleId: randomUUID(),
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: ruleConsent.consentId,
        expectedConsentVersion: ruleConsent.consent.consentVersion,
        expectedGrantVersion: null,
        publisherCredentialId: fixture.deviceCredentialId,
        effectivePrivacyPolicyHash: privacy.effectivePolicyHash,
        authority: authority(fixture)
      });
      const root = async () =>
        (
          await pool.query<{
            id: string;
            logical_grant_id: string;
            grant_version: number;
            mode: string;
          }>(
            "select id,logical_grant_id,grant_version,mode from team_memory_share_grants where id=$1",
            [rule.shareGrantId]
          )
        ).rows[0]!;
      const initial = await root();
      await repository.prepareSharingRuleMember(owner, {
        shareGrantId: rule.shareGrantId,
        expectedGrantVersion: initial.grant_version,
        ruleAuthority: {
          ruleId: rule.ruleId,
          reasonId: rule.reasonId,
          authorityVersion: rule.authorityVersion,
          consentVersion: ruleConsent.consent.consentVersion,
          publisherCredentialId: fixture.deviceCredentialId,
          publisherFence: rule.publisherFence,
          effectivePrivacyPolicyHash: privacy.effectivePolicyHash
        }
      });
      await flushSanitizedSemanticPublication();
      const ruleBefore = (
        await pool.query<Record<string, unknown>>(
          "select * from team_memory_sharing_rules where id=$1",
          [rule.ruleId]
        )
      ).rows[0];
      const candidateInput = {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        candidateHash: hash("rule-first-direct-candidate"),
        sourceRevision: source.currentRevision,
        itemCount: candidateManifest(source, "memory_events").length,
        excludedItemCount: 0,
        manifest: candidateManifest(source, "memory_events"),
        byteCount: 128,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        ...fidelityConsent(allRepresentations),
        mode: "snapshot" as const
      };
      const candidate = await executeNativeRuleOperation(
        fixture,
        (referenceId) =>
          sharedMemoryCandidatePreviewActionGrantBinding({
            ...candidateInput,
            referenceId
          }),
        (scoped, approved) =>
          scoped.createSharedMemoryCandidatePreview(owner, {
            ...candidateInput,
            authority: approved
          })
      );
      const input = {
        mutationId: randomUUID(),
        logicalGrantId: initial.logical_grant_id,
        expectedGrantVersion: initial.grant_version,
        consentId: randomUUID(),
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        preview: candidate!,
        previewRevision: candidate!.previewRevision,
        mode: "snapshot" as const,
        ...fidelityConsent(allRepresentations)
      };
      const accept = () =>
        executeNativeRuleOperation(
          fixture,
          (referenceId) =>
            sharedMemoryPendingShareActionGrantBinding({
              ...input,
              referenceId,
              previewId: candidate!.previewId,
              previewHash: candidate!.previewHash
            }),
          async (scoped, approved) => {
            const pending = await scoped.createPendingShare(owner, {
              ...input,
              authority: approved
            });
            expect(
              await scoped.createPendingShare(owner, {
                ...input,
                authority: approved
              })
            ).toEqual(pending);
            return pending;
          }
        );
      if (scenario === "stale") {
        await repository.controlConversationSharingRule(owner, {
          mutationId: randomUUID(),
          ruleId: rule.ruleId,
          reasonId: rule.reasonId,
          shareGrantId: rule.shareGrantId,
          expectedAuthorityVersion: rule.authorityVersion,
          expectedGrantVersion: initial.grant_version,
          action: "pause",
          authority: authority(fixture),
          destination: {
            teamId: fixture.teamId,
            teamWorkspaceId: fixture.teamWorkspaceId
          }
        });
        await expect(accept()).rejects.toThrow("destination changed");
        expect(
          (
            await pool.query(
              "select id from pending_share_operations where mutation_id=$1",
              [input.mutationId]
            )
          ).rowCount
        ).toBe(0);
        return;
      }
      const pending = await accept();
      await expect(
        processPendingSharesAfterPrivacy(pending.id, {
          ensureCompanion: ensurePendingShareCompanion
        })
      ).resolves.toMatchObject({ activated: 1 });
      expect((await root()).id).toBe(initial.id);
      expect((await root()).mode).toBe("snapshot");
      expect(
        (
          await pool.query(
            "select * from team_memory_sharing_rules where id=$1",
            [rule.ruleId]
          )
        ).rows[0]
      ).toEqual(ruleBefore);
      expect(
        (
          await pool.query(
            "select id from team_memory_share_grants where logical_memory_id=$1 and team_workspace_id=$2",
            [source.logicalMemoryId, fixture.teamWorkspaceId]
          )
        ).rowCount
      ).toBe(1);
      expect(
        (
          await pool.query<{ kind: string }>(
            "select kind from team_memory_share_reasons where share_grant_id=$1",
            [rule.shareGrantId]
          )
        ).rows
          .map((row) => row.kind)
          .sort()
      ).toEqual(["direct", "rule"]);
      const read = (representation: SharedMemoryRepresentation) =>
        repository.readGrantRepresentation(reader, {
          shareGrantId: rule.shareGrantId,
          representation
        });
      expect(await read("memory_events")).toMatchObject({
        representation: { sourceRevision: 1 }
      });
      await ensureSourceRevision(fixture, source, 2, "rule-first-later-turn");
      await repository.prepareSharingRuleMember(owner, {
        shareGrantId: rule.shareGrantId,
        expectedGrantVersion: (await root()).grant_version,
        ruleAuthority: {
          ruleId: rule.ruleId,
          reasonId: rule.reasonId,
          authorityVersion: rule.authorityVersion,
          consentVersion: ruleConsent.consent.consentVersion,
          publisherCredentialId: fixture.deviceCredentialId,
          publisherFence: rule.publisherFence,
          effectivePrivacyPolicyHash: privacy.effectivePolicyHash
        }
      });
      await flushSanitizedSemanticPublication();
      expect(await read("memory_events")).toMatchObject({
        representation: { sourceRevision: 1 }
      });
      expect(await read("lcm_rollups")).toMatchObject({
        representation: { sourceRevision: 2 }
      });
      if (scenario === "stop_snapshot") {
        const detail = await repository.getOwnerShare(owner, {
          kind: "pending",
          id: pending.id
        });
        if (detail?.kind !== "pending")
          throw new Error("Direct snapshot is missing");
        const stop = {
          pendingShareId: pending.id,
          mutationId: randomUUID(),
          expectedOperationVersion: detail.pendingShare.operationVersion,
          action: "stop_direct" as const
        };
        await expect(
          repository.controlPendingShare(reader, stop)
        ).rejects.toThrow("Only the source owner");
        const stopped = await repository.controlPendingShare(owner, stop);
        expect(stopped.state).toBe("revoked");
        expect(await repository.controlPendingShare(owner, stop)).toEqual(
          stopped
        );
        expect(await read("memory_events")).toBeNull();
        expect(await read("lcm_rollups")).toMatchObject({
          representation: { sourceRevision: 2 }
        });
        expect(
          (
            await pool.query(
              "select * from team_memory_sharing_rules where id=$1",
              [rule.ruleId]
            )
          ).rows[0]
        ).toEqual(ruleBefore);
        return;
      }
      await repository.controlConversationSharingRule(owner, {
        mutationId: randomUUID(),
        ruleId: rule.ruleId,
        reasonId: rule.reasonId,
        shareGrantId: rule.shareGrantId,
        expectedAuthorityVersion: rule.authorityVersion,
        expectedGrantVersion: (await root()).grant_version,
        action: "stop",
        authority: authority(fixture),
        destination: {
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId
        }
      });
      expect(await read("memory_events")).toMatchObject({
        representation: { sourceRevision: 1 }
      });
      expect(await read("lcm_rollups")).toBeNull();
    }
  );

  it("explains durable direct reasons without restoring removed owner content access", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      mode: "snapshot",
      label: "reason-snapshot"
    });
    await materialize(fixture, grant);
    await pool.query(
      "update sessions set metadata=metadata || $2::jsonb where id=$1 and owner_user_id=$3",
      [
        grant.localSessionId,
        JSON.stringify({
          threadName: "Owner's private source title",
          projectName: "PRIVATE_PROJECT_ONLY",
          projectPath: "/private/owner/folder"
        }),
        fixture.ownerUserId
      ]
    );
    const target = { kind: "grant" as const, id: grant.shareGrantId };
    const initial = await repository.getOwnerShare(
      actor(fixture.ownerUserId),
      target
    );
    expect(initial?.summary.sourceTitle).toBe("Owner's private source title");
    const teamRead = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      {
        shareGrantId: grant.shareGrantId,
        representation: "memory_events"
      }
    );
    expect(JSON.stringify(teamRead)).not.toContain(
      "Owner's private source title"
    );
    expect(JSON.stringify(teamRead)).not.toContain("PRIVATE_PROJECT_ONLY");
    expect(JSON.stringify(teamRead)).not.toContain("/private/owner/folder");
    expect(initial?.sourceAccess).toBeNull();
    expect(initial?.summary.sharingReasons).toEqual([
      expect.objectContaining({
        kind: "direct",
        consentId: grant.consentId,
        mode: "snapshot",
        updateState: "fixed_snapshot",
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        maximumAuthorizedSourceRevision: 1,
        repositorySnapshotSourceRevision: 1
      })
    ]);
    expect(
      initial!.summary.sharingReasons[0]!.permittedRepresentations
    ).toEqual(expect.arrayContaining(allRepresentations));
    expect(
      initial!.summary.sharingReasons[0]!.publishedRepresentations
    ).toContainEqual(
      expect.objectContaining({
        representation: "memory_events",
        sourceRevision: 1,
        state: "available"
      })
    );
    const reasonId = initial!.summary.sharingReasons[0]!.id;
    await expect(
      repository.getOwnerShare(actor(fixture.readerUserId), target)
    ).resolves.toBeNull();
    await expect(
      repository.getOwnerShare(actor(fixture.outsiderUserId), target)
    ).resolves.toBeNull();
    await pool.query(
      `update team_workspace_access_grants set disabled_at=now()
        where user_id=$1 and team_workspace_id=$2`,
      [fixture.ownerUserId, fixture.teamWorkspaceId]
    );
    const removed = await repository.getOwnerShare(
      actor(fixture.ownerUserId),
      target
    );
    expect(removed?.summary).toMatchObject({
      workspaceContentAccess: "unavailable",
      authorizedPreview: null,
      sharingReasons: [
        expect.objectContaining({ id: reasonId, updateState: "fixed_snapshot" })
      ]
    });
    await expect(
      repository.readOwnerSharePreview(actor(fixture.ownerUserId), target)
    ).resolves.toBeNull();
    await expect(
      repository.readGrantRepresentation(actor(fixture.ownerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: "memory_events"
      })
    ).resolves.toBeNull();
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: "memory_events"
      })
    ).resolves.not.toBeNull();
    const durable = await pool.query(
      `select id from team_memory_share_reasons where share_grant_id=$1`,
      [grant.shareGrantId]
    );
    expect(durable.rows).toEqual([{ id: reasonId }]);
  });

  it("keeps the owner preview at approved activation detail when a lower cumulative layer publishes later", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      representation: "memory_events",
      label: "owner-preview-cumulative"
    });
    const rich = await materializeWithPreview(fixture, grant);
    const lower = await repository.createAuthoritativeSourcePreview(
      actor(fixture.ownerUserId),
      {
        ...capturedSourceBinding(grant, "memory_events", allRepresentations),
        logicalMemoryId: grant.logicalMemoryId,
        remoteReplicaId: grant.remoteReplicaId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        representation: "lcm_leaves",
        authority: authority(fixture)
      }
    );
    await prepareSanitizedSemanticPreview(fixture.ownerUserId, lower);
    await repository.materializeGrantRepresentation(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId: grant.consentId,
        expectedGrantVersion: grant.grantVersion,
        preview: lower
      }
    );
    const target = { kind: "grant" as const, id: grant.shareGrantId };
    expect(
      (await repository.getOwnerShare(actor(fixture.ownerUserId), target))
        ?.summary.authorizedPreview
    ).toMatchObject({ previewId: rich.preview.previewId });
    expect(
      await repository.readOwnerSharePreview(actor(fixture.ownerUserId), target)
    ).toMatchObject({
      representation: "memory_events",
      activationRepresentation: "memory_events",
      previewId: rich.preview.previewId
    });
    expect(
      await repository.readOwnerSharePreview(
        actor(fixture.readerUserId),
        target
      )
    ).toBeNull();
  });

  it("materializes and reads every cumulative layer authorized by a memory-events ceiling", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      representation: "memory_events",
      ownerAllowed: allRepresentations,
      label: "cumulative-memory-events"
    });

    for (const representation of allRepresentations) {
      const preview = await createPersistedPreview(
        fixture,
        grant,
        representation,
        grant.currentRevision,
        "cumulative-memory-events",
        allRepresentations
      );
      const materialized = await repository.materializeGrantRepresentation(
        actor(fixture.ownerUserId),
        {
          mutationId: randomUUID(),
          shareGrantId: grant.shareGrantId,
          consentId: grant.consentId,
          expectedGrantVersion: grant.grantVersion,
          preview
        }
      );
      expect(materialized.representation).toBe(representation);
      const read = await repository.readGrantRepresentation(
        actor(fixture.readerUserId),
        { shareGrantId: grant.shareGrantId, representation }
      );
      expect(read?.representation.id).toBe(materialized.id);
      expect(read?.representation.representation).toBe(representation);
    }

    const rows = await pool.query<{ representation: string }>(
      `select representation
         from team_memory_representations
        where share_grant_id=$1 and state in ('available','stale')
        order by representation`,
      [grant.shareGrantId]
    );
    expect(new Set(rows.rows.map((row) => row.representation))).toEqual(
      new Set(allRepresentations)
    );
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: "curated_assertions"
      })
    ).resolves.toBeNull();
  });

  it("uses indexed exact-revision lookups across the generic sharing workflow", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      representation: "memory_events",
      label: "revision-index-plan"
    });
    await materialize(fixture, grant);
    const sourceRevision = await pool.query<{ source_revision_id: string }>(
      `select source_revision_id
         from team_memory_share_grants
        where id=$1`,
      [grant.shareGrantId]
    );
    const sourceRevisionId = sourceRevision.rows[0]!.source_revision_id;
    const lookups = [
      [
        "shared_memory_candidate_previews",
        "shared_memory_candidate_previews_source_revision_idx"
      ],
      [
        "shared_source_artifacts",
        "shared_source_artifacts_source_revision_idx"
      ],
      ["shared_source_previews", "shared_source_previews_source_revision_idx"],
      [
        "source_owner_representation_consents",
        "source_owner_consents_source_revision_idx"
      ],
      [
        "team_memory_share_grants",
        "team_memory_share_grants_source_revision_idx"
      ],
      [
        "team_memory_representations",
        "team_memory_representations_source_revision_idx"
      ]
    ] as const;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local enable_seqscan=off");
      for (const [table, indexName] of lookups) {
        const plan = await client.query(
          `explain (format json, costs off)
           select id from ${table} where source_revision_id=$1`,
          [sourceRevisionId]
        );
        expect(JSON.stringify(plan.rows[0])).toContain(indexName);
      }
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("commits cursor zero as generic revision one only with its typed binding", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 0);
    const sourceRevisionId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into logical_memory_source_revisions
           (id,logical_memory_id,owner_principal_id,source_kind,revision,binding_hash)
         values ($1,$2,$3,'captured_session',1,$4)`,
        [
          sourceRevisionId,
          source.logicalMemoryId,
          source.ownerPrincipalId,
          hash("cursor-zero-binding")
        ]
      );
      await client.query(
        `insert into captured_session_source_revisions
           (source_revision_id,logical_memory_id,owner_principal_id,source_kind,
            revision,source_session_id,source_cursor)
         values ($1,$2,$3,'captured_session',1,$4,0)`,
        [
          sourceRevisionId,
          source.logicalMemoryId,
          source.ownerPrincipalId,
          source.sessionId
        ]
      );
      await client.query("commit");
    } finally {
      client.release();
    }
    await expect(
      pool.query(
        `select generic_revision,source_revision,source_kind
           from logical_memory_source_revision_bindings
          where logical_memory_id=$1 and source_revision=0`,
        [source.logicalMemoryId]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          generic_revision: "1",
          source_revision: "0",
          source_kind: "captured_session"
        }
      ]
    });

    const unbound = await pool.connect();
    try {
      await unbound.query("begin");
      await unbound.query(
        `insert into logical_memory_source_revisions
           (id,logical_memory_id,owner_principal_id,source_kind,revision,binding_hash)
         values ($1,$2,$3,'captured_session',2,$4)`,
        [
          randomUUID(),
          source.logicalMemoryId,
          source.ownerPrincipalId,
          hash("unbound-revision")
        ]
      );
      let commitError: unknown;
      try {
        await unbound.query("commit");
      } catch (error) {
        commitError = error;
      }
      expect(commitError).toMatchObject({
        code: "23514",
        constraint: "logical_memory_revision_binding_check"
      });
    } finally {
      await unbound.query("rollback").catch(() => undefined);
      unbound.release();
    }

    await expect(
      pool.query(
        `update captured_session_source_revisions
            set source_cursor=1
          where source_revision_id=$1`,
        [sourceRevisionId]
      )
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "captured_session_source_revision_immutable_check"
    });
  });

  it("rejects a workflow row whose numeric revision disagrees with its immutable binding", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      representation: "memory_events",
      label: "revision-binding"
    });
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update team_memory_share_grants
            set source_revision=source_revision+1
          where id=$1`,
        [grant.shareGrantId]
      );
      let commitError: unknown;
      try {
        await client.query("commit");
      } catch (error) {
        commitError = error;
      }
      expect(commitError).toMatchObject({
        code: "23514",
        constraint: "workflow_source_revision_binding_check"
      });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("keeps credentials in the owner preview but excludes them from Team reads", async () => {
    const fixture = await createWorkspaceFixture();
    const username = "preview-owner";
    const password = "correct-horse-battery-staple";
    const grant = await createGrant(fixture, {
      representation: "memory_events",
      label: "credential-boundary",
      assistantText: `username: ${username} password: ${password}`,
      sanitizeText: (text) =>
        text.replaceAll(username, "[USERNAME]").replaceAll(password, "[SECRET]")
    });

    expect(JSON.stringify(grant.preview.items)).toContain(username);
    expect(JSON.stringify(grant.preview.items)).toContain(password);

    await materialize(fixture, grant);
    const teamRead = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      {
        shareGrantId: grant.shareGrantId,
        representation: "memory_events"
      }
    );
    const teamPayload = JSON.stringify(teamRead?.items);
    expect(teamPayload).toContain("[USERNAME]");
    expect(teamPayload).toContain("[SECRET]");
    expect(teamPayload).not.toContain(username);
    expect(teamPayload).not.toContain(password);
  });

  it("authorizes complete leaves and rollups, but not events, at a leaves ceiling", async () => {
    const fixture = await createWorkspaceFixture();
    const allowed: SharedMemoryRepresentation[] = ["lcm_leaves", "lcm_rollups"];
    const grant = await createGrant(fixture, {
      representation: "lcm_leaves",
      ownerAllowed: allowed,
      label: "cumulative-leaves"
    });

    for (const representation of allowed) {
      const preview = await createPersistedPreview(
        fixture,
        grant,
        representation,
        grant.currentRevision,
        "cumulative-leaves",
        allowed
      );
      await expect(
        repository.materializeGrantRepresentation(actor(fixture.ownerUserId), {
          mutationId: randomUUID(),
          shareGrantId: grant.shareGrantId,
          consentId: grant.consentId,
          expectedGrantVersion: grant.grantVersion,
          preview
        })
      ).resolves.toMatchObject({ representation });
    }

    await expect(
      createPersistedPreview(
        fixture,
        grant,
        "memory_events",
        grant.currentRevision,
        "cumulative-leaves",
        allowed
      )
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
  });

  it("authorizes only rollups at a rollup ceiling", async () => {
    const fixture = await createWorkspaceFixture();
    const allowed: SharedMemoryRepresentation[] = ["lcm_rollups"];
    const grant = await createGrant(fixture, {
      representation: "lcm_rollups",
      ownerAllowed: allowed,
      label: "cumulative-rollups"
    });
    const materialized = await repository.materializeGrantRepresentation(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId: grant.consentId,
        expectedGrantVersion: grant.grantVersion,
        preview: grant.preview
      }
    );
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: "lcm_rollups"
      })
    ).resolves.toMatchObject({ representation: materialized });
    await expect(
      createPersistedPreview(
        fixture,
        grant,
        "lcm_leaves",
        grant.currentRevision,
        "cumulative-rollups",
        allowed
      )
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
  });

  it("uses the semantic sync cursor for a local sharing candidate revision", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "candidate-sync-cursor");
    await pool.query(
      `update memory_events
          set source_sequence=1224712
        where session_id=$1`,
      [source.sessionId]
    );

    const candidateRevision =
      await syncRepository.prepareCapturedSessionSyncCandidateRevision(
        actor(fixture.ownerUserId),
        source.sessionId
      );
    const cursor = await pool.query<{ cursor: string }>(
      `select max(cursor)::text as cursor
         from sync_semantic_changes
        where session_id=$1`,
      [source.sessionId]
    );

    expect(candidateRevision).toBe(Number(cursor.rows[0]!.cursor));
    expect(candidateRevision).not.toBe(1224712);
    await expect(
      syncRepository.prepareCapturedSessionSyncCandidateRevision(
        actor(fixture.managerUserId),
        source.sessionId
      )
    ).resolves.toBeNull();
  });
  it("resolves exact read-only Shared Memory approval context and fails closed on ownership", async () => {
    const fixture = await createWorkspaceFixture();
    const sourceFixture = await createSource(fixture, 1, "approval-context");
    const admission = await repository.getSharedMemoryPreviewAdmission(
      actor(fixture.ownerUserId),
      {
        logicalMemoryId: sourceFixture.logicalMemoryId,
        remoteReplicaId: sourceFixture.remoteReplicaId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        representation: "lcm_rollups",
        ...fidelityConsent(allRepresentations)
      }
    );
    expect(admission).toMatchObject({
      source: { logicalMemoryId: sourceFixture.logicalMemoryId },
      team: { id: fixture.teamId },
      workspace: { id: fixture.teamWorkspaceId },
      remoteReplicaId: sourceFixture.remoteReplicaId,
      representation: "lcm_rollups",
      sourceOwnerPolicyWillChange: true
    });
    await expect(
      repository.getSharedMemoryPreviewAdmission(actor(fixture.managerUserId), {
        logicalMemoryId: sourceFixture.logicalMemoryId,
        remoteReplicaId: sourceFixture.remoteReplicaId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        representation: "lcm_rollups",
        ...fidelityConsent(allRepresentations)
      })
    ).resolves.toBeNull();

    const preview = await createPersistedPreview(
      fixture,
      sourceFixture,
      "lcm_rollups"
    );
    const shareReview = await repository.getSharedMemoryShareReview(
      actor(fixture.ownerUserId),
      {
        logicalMemoryId: sourceFixture.logicalMemoryId,
        logicalGrantId: randomUUID(),
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        consentId: randomUUID(),
        preview,
        previewRevision: preview.previewRevision,
        ...fidelityConsent(allRepresentations),
        expiresAt: null
      }
    );
    expect(shareReview).toMatchObject({
      source: { logicalMemoryId: sourceFixture.logicalMemoryId },
      preview: {
        previewId: preview.previewId,
        previewHash: preview.previewHash,
        previewRevision: preview.previewRevision,
        representation: "lcm_rollups"
      }
    });

    const grant = await createGrant(fixture, { label: "approval-grant" });
    const revokeReview = await repository.getSharedMemoryRevokeReview(
      actor(fixture.ownerUserId),
      {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion
      }
    );
    expect(revokeReview).toMatchObject({
      source: { logicalMemoryId: grant.logicalMemoryId },
      grant: {
        id: grant.shareGrantId,
        grantVersion: grant.grantVersion,
        lifecycle: "active"
      }
    });
    await expect(
      repository.getSharedMemoryRevokeReview(actor(fixture.managerUserId), {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion
      })
    ).resolves.toBeNull();

    const replacementPreview = await createPersistedPreview(
      fixture,
      grant,
      "lcm_leaves",
      grant.currentRevision,
      grant.currentLabel,
      ["lcm_leaves", "lcm_rollups"]
    );
    const fidelityReview = await repository.getSharedMemoryFidelityChangeReview(
      actor(fixture.ownerUserId),
      {
        logicalMemoryId: grant.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion,
        preview: replacementPreview,
        previewRevision: replacementPreview.previewRevision,
        maximumFidelity: "lcm_leaves",
        includeCuratedMemory: false,
        expiresAt: null
      }
    );
    expect(fidelityReview).toMatchObject({
      grant: {
        id: grant.shareGrantId,
        maximumFidelity: "memory_events",
        includeCuratedMemory: false
      },
      willReactivate: false
    });
  });

  it("inventories and idempotently corrects legacy Approval Activity derivatives", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      mode: "snapshot",
      label: "legacy-approval-remediation"
    });
    await materialize(fixture, grant);
    const contributorId = grant.seededEvents[0]!.contributorIds[0]!;
    await pool.query(
      `update conversation_items
          set metadata=metadata || '{"providerApprovalKind":"approval_request"}'::jsonb
        where id=$1`,
      [contributorId]
    );

    const before = await inventoryApprovalActivity(pool, {
      sessionId: grant.sessionId
    });
    expect(before).toMatchObject({
      bounded: { truncated: false },
      canonical: { approvalActivityRecords: 1, ambiguousRecords: 0 },
      affected: {
        memoryEvents: 1,
        lcmNodes: 2,
        semanticOwnerPrivateReplicas: 1,
        continuousShares: 0,
        snapshotShares: 1,
        ambiguousSnapshotShares: 0
      }
    });
    expect(before.canonical.recordBytes).toBeGreaterThan(0);
    await expect(
      inventoryApprovalActivity(pool, { sessionId: grant.sessionId })
    ).resolves.toEqual(before);

    const corrected = await correctApprovalActivity(pool, {
      sessionId: grant.sessionId
    });
    expect(corrected).toMatchObject({
      status: "corrected",
      conversationItemsExcluded: 1,
      memoryEventsInvalidated: 1,
      snapshotShareGrantsRevoked: 1
    });
    const state = await pool.query<{
      event_invalidated: boolean;
      leaf_invalidated: boolean;
      rollup_invalidated: boolean;
      grant_lifecycle: string;
      grant_reason: string;
      delete_changes: string;
      audit_events: string;
      revocation_events: string;
    }>(
      `select
         (select invalidated_at is not null from memory_events where id=$1)
           as event_invalidated,
         (select invalidated_at is not null from memory_nodes where id=$2)
           as leaf_invalidated,
         (select invalidated_at is not null from memory_nodes where id=$3)
           as rollup_invalidated,
         (select lifecycle from team_memory_share_grants where id=$4)
           as grant_lifecycle,
         (select revocation_reason from team_memory_share_grants where id=$4)
           as grant_reason,
         (select count(*)::text from sync_semantic_changes
           where memory_event_id=$1 and operation='delete') as delete_changes,
         (select count(*)::text from audit_events
           where action='shared_memory.snapshot.remediated' and target_id=$4)
           as audit_events,
         (select count(*)::text from collaboration_outbox
           where family='access_revoked' and share_grant_id=$4)
           as revocation_events`,
      [
        grant.seededEvents[0]!.eventId,
        grant.leaf.nodeId,
        grant.rollup.nodeId,
        grant.shareGrantId
      ]
    );
    expect(state.rows[0]).toEqual({
      event_invalidated: true,
      leaf_invalidated: true,
      rollup_invalidated: true,
      grant_lifecycle: "revoked",
      grant_reason: "approval_content_remediation",
      delete_changes: "1",
      audit_events: "1",
      revocation_events: "1"
    });
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: "memory_events"
      })
    ).resolves.toBeNull();
    await expect(
      correctApprovalActivity(pool, { sessionId: grant.sessionId })
    ).resolves.toMatchObject({
      status: "unchanged",
      conversationItemsExcluded: 0,
      memoryEventsInvalidated: 0,
      queuedProjectionWorkRemoved: 0,
      snapshotShareGrantsRevoked: 0
    });
  });

  it("reports ambiguous legacy Approval Activity without partially correcting it", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "ambiguous-approval");
    const contributorId = source.seededEvents[0]!.contributorIds[0]!;
    await pool.query(
      `update conversation_items
          set metadata=metadata || '{"providerApprovalKind":"approval_future_kind"}'::jsonb
        where id=$1`,
      [contributorId]
    );
    const report = await inventoryApprovalActivity(pool, {
      sessionId: source.sessionId
    });
    expect(report.canonical).toMatchObject({
      approvalActivityRecords: 0,
      ambiguousRecords: 1,
      ambiguousRecordIds: [contributorId]
    });
    await expect(
      correctApprovalActivity(pool, { sessionId: source.sessionId })
    ).rejects.toMatchObject({
      code: "approval_activity_remediation_ambiguous",
      ambiguousRecordIds: [contributorId]
    });
    const unchanged = await pool.query<{
      memory_excluded_at: Date | null;
      invalidated_at: Date | null;
    }>(
      `select item.memory_excluded_at,event.invalidated_at
         from conversation_items item
         join memory_event_sources source on source.conversation_item_id=item.id
         join memory_events event on event.id=source.memory_event_id
        where item.id=$1`,
      [contributorId]
    );
    expect(unchanged.rows[0]).toEqual({
      memory_excluded_at: null,
      invalidated_at: null
    });
  });

  it("quarantines a paused continuous representation immediately and queues one clean rebuild", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(
      fixture,
      1,
      "continuous-approval-remediation"
    );
    await putOwnerPolicy(fixture, source);
    const shareAuthority = authority(fixture);
    const candidate = await repository.createSharedMemoryCandidatePreview(
      actor(fixture.ownerUserId),
      {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        candidateHash: hash("continuous-approval-remediation"),
        sourceRevision: source.currentRevision,
        itemCount: 1,
        excludedItemCount: 0,
        manifest: candidateManifest(source, "memory_events"),
        byteCount: 128,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        ...fidelityConsent(allRepresentations),
        mode: "continuous",
        authority: shareAuthority
      }
    );
    const pending = await repository.createPendingShare(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: randomUUID(),
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        preview: candidate!,
        previewRevision: candidate!.previewRevision,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: shareAuthority
      }
    );
    await processPendingSharesAfterPrivacy(pending.id, {
      ensureCompanion: ensurePendingShareCompanion
    });
    const activated = await repository.getOwnerShare(
      actor(fixture.ownerUserId),
      { kind: "pending", id: pending.id }
    );
    if (!activated || activated.kind !== "pending") {
      throw new Error("expected activated continuous Pending Share");
    }
    const grantId = activated.pendingShare.grantId!;
    await pool.query(
      `update source_owner_representation_consents
          set state='paused',paused_at=now()
        where id=$1`,
      [activated.pendingShare.consentId]
    );
    await pool.query(
      `update conversation_items
          set metadata=metadata || '{"providerApprovalKind":"approval_request"}'::jsonb
        where id=$1`,
      [source.seededEvents[0]!.contributorIds[0]!]
    );

    await expect(
      correctApprovalActivity(pool, { sessionId: source.sessionId })
    ).resolves.toMatchObject({
      status: "corrected",
      continuousShareGrantsQuarantined: 1,
      continuousRepresentationsQuarantined: 1,
      continuousRepresentationRebuildsQueued: 1
    });
    const quarantined = await pool.query<{
      lifecycle: string;
      representation_state: string;
      semantic_count: string;
      pending_state: string;
      failure_code: string;
    }>(
      `select g.lifecycle,r.state as representation_state,
              (select count(*)::text from team_memory_semantic_items semantic
                where semantic.share_grant_id=g.id) as semantic_count,
              p.state as pending_state,
              p.redacted_failure_code as failure_code
         from team_memory_share_grants g
         join team_memory_representations r on r.share_grant_id=g.id
         join pending_share_operations p on p.grant_id=g.id
        where g.id=$1
        order by r.created_at desc limit 1`,
      [grantId]
    );
    expect(quarantined.rows[0]).toEqual({
      lifecycle: "unavailable",
      representation_state: "invalidated",
      semantic_count: "0",
      pending_state: "needs_attention",
      failure_code: "approval_content_remediation"
    });
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grantId,
        representation: "memory_events"
      })
    ).resolves.toBeNull();
    await expect(
      repository.listWorkspaceGrants(actor(fixture.readerUserId), {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        limit: 10,
        offset: 0
      })
    ).resolves.toMatchObject({ entries: [] });
    await expect(
      correctApprovalActivity(pool, { sessionId: source.sessionId })
    ).resolves.toEqual({
      status: "unchanged",
      conversationItemsExcluded: 0,
      memoryEventsInvalidated: 0,
      queuedProjectionWorkRemoved: 0,
      snapshotShareGrantsRevoked: 0,
      continuousShareGrantsQuarantined: 0,
      continuousRepresentationsQuarantined: 0,
      continuousRepresentationRebuildsQueued: 0
    });
  });

  it("preserves the source Session identity when a target replica uses a different local Session", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "distinct-target-session", {
      distinctTargetSession: true
    });
    expect(source.localSessionId).not.toBe(source.sessionId);
    await putOwnerPolicy(fixture, source);
    const shareAuthority = authority(fixture);
    const candidate = await repository.createSharedMemoryCandidatePreview(
      actor(fixture.ownerUserId),
      {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        candidateHash: hash("distinct-target-session-candidate"),
        sourceRevision: source.currentRevision,
        itemCount: 1,
        excludedItemCount: 0,
        manifest: candidateManifest(source, "memory_events"),
        byteCount: 128,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        ...fidelityConsent(allRepresentations),
        mode: "snapshot",
        authority: shareAuthority
      }
    );
    expect(candidate).not.toBeNull();
    const pending = await repository.createPendingShare(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: randomUUID(),
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        preview: candidate!,
        previewRevision: candidate!.previewRevision,
        mode: "snapshot",
        ...fidelityConsent(allRepresentations),
        authority: shareAuthority
      }
    );

    await expect(
      processPendingSharesAfterPrivacy(pending.id, {
        ensureCompanion: ensurePendingShareCompanion
      })
    ).resolves.toMatchObject({
      claimed: 1,
      activated: 1,
      failed: 0
    });
    await expect(
      pool.query<{ source_session_id: string }>(
        `select share_grant.source_session_id
           from team_memory_share_grant_records share_grant
          where share_grant.logical_memory_id=$1`,
        [source.logicalMemoryId]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          source_session_id: source.sessionId
        }
      ]
    });
  });

  it("measures candidate, authoritative preview, pending acceptance, and activation", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "sharing-performance");
    await putOwnerPolicy(fixture, source);
    const browserAuthority = authority(fixture);
    const measure = async <T>(operation: () => Promise<T>) => {
      const startedAt = performance.now();
      const result = await operation();
      return {
        result,
        durationMs: Number((performance.now() - startedAt).toFixed(3))
      };
    };

    const candidate = await measure(() =>
      repository.createSharedMemoryCandidatePreview(
        actor(fixture.ownerUserId),
        {
          ...capturedSourceBinding(source, "memory_events"),
          logicalMemoryId: source.logicalMemoryId,
          candidateHash: hash("sharing-performance-candidate"),
          sourceRevision: source.currentRevision,
          itemCount: 1,
          excludedItemCount: 0,
          manifest: candidateManifest(source, "memory_events"),
          byteCount: 128,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          ...fidelityConsent(allRepresentations),
          mode: "continuous",
          authority: browserAuthority
        }
      )
    );
    expect(candidate.result).not.toBeNull();

    const authoritative = await measure(() =>
      createPersistedPreview(fixture, source, "memory_events")
    );
    expect(authoritative.result.logicalMemoryId).toBe(source.logicalMemoryId);

    const pending = await measure(() =>
      repository.createPendingShare(actor(fixture.ownerUserId), {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: randomUUID(),
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        preview: candidate.result!,
        previewRevision: candidate.result!.previewRevision,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: browserAuthority
      })
    );
    expect(pending.result.state).toBe("preparing");

    const activation = await measure(() =>
      processPendingSharesAfterPrivacy(pending.result.id, {
        ensureCompanion: ensurePendingShareCompanion
      })
    );
    expect(activation.result).toMatchObject({
      claimed: 1,
      activated: 1,
      failed: 0
    });

    const metrics = {
      fixture: "shared-memory-workflow-performance-v1",
      candidatePreviewDurationMs: candidate.durationMs,
      authoritativePreviewDurationMs: authoritative.durationMs,
      pendingAcceptanceDurationMs: pending.durationMs,
      activationDurationMs: activation.durationMs,
      contentSafe: true
    };
    expect(
      Object.values(metrics)
        .filter((value): value is number => typeof value === "number")
        .every(
          (duration) =>
            Number.isFinite(duration) && duration >= 0 && duration < 30_000
        )
    ).toBe(true);
    console.info(JSON.stringify(metrics));
  });

  it("uses pre-bound device source identities for Personal Note and captured Conversation previews", async () => {
    const fixture = await createWorkspaceFixture();
    const sourceDeploymentProtocolId = fixture.sourceProtocolDeploymentId;
    const sourceOwnerPrincipalId = fixture.sourceOwnerPrincipalId;
    const capturedSessionId = randomUUID();
    const noteId = randomUUID();
    const sources: SharedMemorySourceRef[] = [
      {
        kind: "captured_session",
        sessionId: capturedSessionId,
        logicalMemoryId: crossIdentitySyncDeterministicUuid({
          protocol: "koed.captured-session-sync/v2",
          sourceDeploymentId: sourceDeploymentProtocolId,
          sourceUserId: sourceOwnerPrincipalId,
          originSessionId: capturedSessionId,
          identity: "logical-memory"
        })
      },
      {
        kind: "personal_note",
        noteId,
        noteRevision: 1,
        memoryEventId: randomUUID(),
        logicalMemoryId: crossIdentitySyncDeterministicUuid({
          protocol: "koed.personal-note-share/v1",
          sourceDeploymentId: sourceDeploymentProtocolId,
          sourceOwnerPrincipalId,
          noteId,
          identity: "logical-memory"
        })
      }
    ];

    for (const source of sources) {
      const candidate = await repository.createSharedMemoryCandidatePreview(
        actor(fixture.ownerUserId),
        {
          source,
          sourceDeploymentProtocolId,
          sourceOwnerPrincipalId,
          deviceCredentialId: fixture.deviceCredentialId,
          sourceCapabilities: ["memory_events"],
          activationRepresentation: "memory_events",
          logicalMemoryId: source.logicalMemoryId,
          candidateHash: hash(`admitted-candidate:${source.kind}`),
          sourceRevision: 1,
          itemCount: 1,
          excludedItemCount: 0,
          manifest: [
            {
              sourceId:
                source.kind === "captured_session"
                  ? source.sessionId
                  : source.memoryEventId,
              revisionHash: hash(`admitted-revision:${source.kind}`)
            }
          ],
          byteCount: 128,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          maximumFidelity: "memory_events",
          includeCuratedMemory: false,
          mode: "continuous",
          authority: {
            action: SHARED_MEMORY_AUTHORITY,
            source: "device_action_grant",
            referenceId: randomUUID()
          }
        }
      );
      expect(candidate).toMatchObject({
        source,
        logicalMemoryId: source.logicalMemoryId,
        sourceRevision: 1
      });
    }

    const admitted = await pool.query<{
      id: string;
      owner_user_id: string;
      owner_principal_id: string;
      source_kind: string;
    }>(
      `select id,owner_user_id,owner_principal_id,source_kind
         from logical_memories
        where id=any($1::uuid[])
        order by source_kind`,
      [sources.map((source) => source.logicalMemoryId)]
    );
    expect(admitted.rows).toHaveLength(2);
    expect(admitted.rows.map((row) => row.source_kind)).toEqual([
      "captured_session",
      "personal_note"
    ]);
    expect(
      new Set(admitted.rows.map((row) => row.owner_principal_id)).size
    ).toBe(1);
    expect(
      admitted.rows.every((row) => row.owner_user_id === fixture.ownerUserId)
    ).toBe(true);
    await expect(
      pool.query<{ count: string }>(
        `select count(*)::text as count
           from sync_principal_links link
           join sync_external_user_identities identity
             on identity.id=link.external_user_identity_id
          where link.local_user_id=$1
            and identity.external_subject_id=$2
            and link.revoked_at is null`,
        [fixture.ownerUserId, sourceOwnerPrincipalId]
      )
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });

    const mismatchedSessionId = randomUUID();
    const mismatchedDeploymentId = randomUUID();
    await expect(
      repository.createSharedMemoryCandidatePreview(
        actor(fixture.ownerUserId),
        {
          source: {
            kind: "captured_session",
            sessionId: mismatchedSessionId,
            logicalMemoryId: crossIdentitySyncDeterministicUuid({
              protocol: "koed.captured-session-sync/v2",
              sourceDeploymentId: mismatchedDeploymentId,
              sourceUserId: sourceOwnerPrincipalId,
              originSessionId: mismatchedSessionId,
              identity: "logical-memory"
            })
          },
          sourceDeploymentProtocolId: mismatchedDeploymentId,
          sourceOwnerPrincipalId,
          deviceCredentialId: fixture.deviceCredentialId,
          sourceCapabilities: ["memory_events"],
          activationRepresentation: "memory_events",
          logicalMemoryId: crossIdentitySyncDeterministicUuid({
            protocol: "koed.captured-session-sync/v2",
            sourceDeploymentId: mismatchedDeploymentId,
            sourceUserId: sourceOwnerPrincipalId,
            originSessionId: mismatchedSessionId,
            identity: "logical-memory"
          }),
          candidateHash: hash("mismatched-device-deployment"),
          sourceRevision: 1,
          itemCount: 1,
          excludedItemCount: 0,
          manifest: [
            {
              sourceId: mismatchedSessionId,
              revisionHash: hash("mismatched-device-revision")
            }
          ],
          byteCount: 128,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          maximumFidelity: "memory_events",
          includeCuratedMemory: false,
          mode: "continuous",
          authority: {
            action: SHARED_MEMORY_AUTHORITY,
            source: "device_action_grant",
            referenceId: randomUUID()
          }
        }
      )
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);

    const unboundPrincipalId = randomUUID();
    const unboundSessionId = randomUUID();
    const unboundLogicalMemoryId = crossIdentitySyncDeterministicUuid({
      protocol: "koed.captured-session-sync/v2",
      sourceDeploymentId: sourceDeploymentProtocolId,
      sourceUserId: unboundPrincipalId,
      originSessionId: unboundSessionId,
      identity: "logical-memory"
    });
    await expect(
      repository.createSharedMemoryCandidatePreview(
        actor(fixture.ownerUserId),
        {
          source: {
            kind: "captured_session",
            sessionId: unboundSessionId,
            logicalMemoryId: unboundLogicalMemoryId
          },
          sourceDeploymentProtocolId,
          sourceOwnerPrincipalId: unboundPrincipalId,
          deviceCredentialId: fixture.deviceCredentialId,
          sourceCapabilities: ["memory_events"],
          activationRepresentation: "memory_events",
          logicalMemoryId: unboundLogicalMemoryId,
          candidateHash: hash("unbound-device-principal"),
          sourceRevision: 1,
          itemCount: 1,
          excludedItemCount: 0,
          manifest: [
            {
              sourceId: unboundSessionId,
              revisionHash: hash("unbound-device-principal-revision")
            }
          ],
          byteCount: 128,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          maximumFidelity: "memory_events",
          includeCuratedMemory: false,
          mode: "continuous",
          authority: {
            action: SHARED_MEMORY_AUTHORITY,
            source: "device_action_grant",
            referenceId: randomUUID()
          }
        }
      )
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);

    await pool.query(
      `update sync_principal_links
          set revoked_at=now()
        where local_user_id=$1 and external_user_identity_id=$2`,
      [fixture.ownerUserId, fixture.remoteUserIdentityId]
    );
    const revokedSource = sources[0]!;
    if (revokedSource.kind !== "captured_session") {
      throw new Error("Expected captured session source");
    }
    await expect(
      repository.createSharedMemoryCandidatePreview(
        actor(fixture.ownerUserId),
        {
          source: revokedSource,
          sourceDeploymentProtocolId,
          sourceOwnerPrincipalId,
          deviceCredentialId: fixture.deviceCredentialId,
          sourceCapabilities: ["memory_events"],
          activationRepresentation: "memory_events",
          logicalMemoryId: revokedSource.logicalMemoryId,
          candidateHash: hash("revoked-existing-principal-binding"),
          sourceRevision: 2,
          itemCount: 1,
          excludedItemCount: 0,
          manifest: [
            {
              sourceId: revokedSource.sessionId,
              revisionHash: hash("revoked-existing-principal-revision")
            }
          ],
          byteCount: 128,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          maximumFidelity: "memory_events",
          includeCuratedMemory: false,
          mode: "continuous",
          authority: {
            action: SHARED_MEMORY_AUTHORITY,
            source: "device_action_grant",
            referenceId: randomUUID()
          }
        }
      )
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
  });

  it("creates and repairs the companion before exposing an async share", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "pending-companion");
    await putOwnerPolicy(fixture, source);
    const shareAuthority = authority(fixture);
    const candidate = await repository.createSharedMemoryCandidatePreview(
      actor(fixture.ownerUserId),
      {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        candidateHash: hash("pending-companion-memory-events"),
        sourceRevision: source.currentRevision,
        itemCount: 1,
        excludedItemCount: 0,
        manifest: candidateManifest(source, "memory_events"),
        byteCount: 128,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        ...fidelityConsent(allRepresentations),
        mode: "continuous",
        authority: shareAuthority
      }
    );
    expect(candidate).not.toBeNull();
    const pending = await repository.createPendingShare(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: randomUUID(),
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        preview: candidate!,
        previewRevision: candidate!.previewRevision,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: shareAuthority
      }
    );
    const representationCountsAtCompanion: string[] = [];
    const companionResults: boolean[] = [];
    const companionGrantIds: string[] = [];
    const companionGrants = new Map<string, SharedMemoryGrantRecord>();
    const ensureCompanion = vi.fn(
      async ({
        actor: owner,
        grant
      }: {
        actor: ActorContext;
        grant: SharedMemoryGrantRecord;
      }) => {
        companionGrantIds.push(grant.id);
        companionGrants.set(grant.id, grant);
        const representations = await pool.query<{ count: string }>(
          `select count(*)::text as count from team_memory_representations
          where share_grant_id=$1`,
          [grant.id]
        );
        representationCountsAtCompanion.push(
          representations.rows[0]?.count ?? "missing"
        );
        const thread = await collaboration.createThread(owner, {
          kind: "shared_session_discussion",
          idempotencyKey: `pending-companion-${grant.id}`,
          teamId: grant.teamId,
          teamWorkspaceId: grant.teamWorkspaceId,
          sharedLogicalMemoryId: grant.logicalMemoryId,
          shareGrantId: grant.id,
          pendingShareActivation: true
        });
        companionResults.push(thread !== null);
        return thread !== null;
      }
    );

    const activation = await processPendingSharesAfterPrivacy(pending.id, {
      limit: 100,
      ensureCompanion
    });
    expect(activation).toMatchObject({ claimed: 1, activated: 1, failed: 0 });
    expect(
      representationCountsAtCompanion.every((count) => count === "1")
    ).toBe(true);
    expect(companionResults.every(Boolean)).toBe(true);
    const activated = await repository.getOwnerShare(
      actor(fixture.ownerUserId),
      { kind: "pending", id: pending.id }
    );
    expect(activated).toMatchObject({
      kind: "pending",
      pendingShare: { state: "activated" }
    });
    const grantId =
      activated?.kind === "pending" ? activated.pendingShare.grantId : null;
    expect(grantId).not.toBeNull();
    expect(companionGrantIds.filter((id) => id === grantId)).toHaveLength(1);
    const activatedGrant = grantId ? companionGrants.get(grantId) : undefined;
    expect(activatedGrant).toBeDefined();
    await pool.query(
      `update team_workspace_access_grants
          set access='read',can_share_owned_memory=false,updated_at=now()
        where team_workspace_id=$1 and user_id=$2`,
      [fixture.teamWorkspaceId, fixture.ownerUserId]
    );
    await expect(
      ensureCompanion({
        actor: actor(fixture.ownerUserId),
        grant: activatedGrant!
      })
    ).resolves.toBe(true);
    const preview = await repository.readOwnerSharePreview(
      actor(fixture.ownerUserId),
      { kind: "pending", id: pending.id }
    );
    expect(preview).toMatchObject({
      logicalMemoryId: source.logicalMemoryId,
      representation: "memory_events",
      sourceRevision: source.currentRevision
    });
    expect(preview?.items.length).toBeGreaterThan(0);

    await pool.query(
      `update team_workspace_access_grants
          set access='disabled',disabled_at=now(),updated_at=now()
        where team_workspace_id=$1 and user_id=$2`,
      [fixture.teamWorkspaceId, fixture.ownerUserId]
    );
    await expect(
      repository.listOwnerShares(actor(fixture.ownerUserId), { limit: 10 })
    ).resolves.toMatchObject({
      entries: [
        {
          summary: {
            workspaceContentAccess: "unavailable",
            companionThreadId: null,
            authorizedPreview: null
          }
        }
      ]
    });
    await expect(
      repository.readOwnerSharePreview(actor(fixture.ownerUserId), {
        kind: "pending",
        id: pending.id
      })
    ).resolves.toBeNull();
    await expect(
      repository.readGrantRepresentation(actor(fixture.ownerUserId), {
        shareGrantId: grantId!,
        representation: "memory_events"
      })
    ).resolves.toBeNull();
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grantId!,
        representation: "memory_events"
      })
    ).resolves.toMatchObject({
      representation: {
        shareGrantId: grantId,
        representation: "memory_events"
      }
    });
    const companion = await pool.query<{ id: string }>(
      `select id from collaboration_threads where share_grant_id=$1`,
      [grantId]
    );
    expect(companion.rows).toHaveLength(1);
    await expect(
      collaboration.getThread(actor(fixture.ownerUserId), {
        threadId: companion.rows[0]!.id
      })
    ).resolves.toBeNull();
    await expect(
      collaboration.getThread(actor(fixture.readerUserId), {
        threadId: companion.rows[0]!.id
      })
    ).resolves.toMatchObject({ id: companion.rows[0]!.id });

    await pool.query(
      `delete from collaboration_threads where share_grant_id=$1`,
      [grantId]
    );
    const repairedGrantIds: string[] = [];
    const repairCompanion = vi.fn(
      async ({
        actor: owner,
        grant
      }: {
        actor: ActorContext;
        grant: SharedMemoryGrantRecord;
      }) => {
        repairedGrantIds.push(grant.id);
        const thread = await collaboration.createThread(owner, {
          kind: "shared_session_discussion",
          idempotencyKey: `pending-companion-repair-${grant.id}`,
          teamId: grant.teamId,
          teamWorkspaceId: grant.teamWorkspaceId,
          sharedLogicalMemoryId: grant.logicalMemoryId,
          shareGrantId: grant.id,
          pendingShareActivation: true
        });
        return thread !== null;
      }
    );
    await expect(
      repository.processPendingShares({
        limit: 100,
        ensureCompanion: repairCompanion
      })
    ).resolves.toMatchObject({ claimed: 0, activated: 0, failed: 0 });
    expect(repairedGrantIds.filter((id) => id === grantId)).toHaveLength(0);
  });

  it("advances a continuous Personal Note atomically without exposing an unfiltered revision", async () => {
    const fixture = await createWorkspaceFixture();
    const personalNote = await collaboration.createPersonalNote(
      actor(fixture.ownerUserId),
      {
        body: "The launch password is alpha-secret.",
        idempotencyKey: `personal-note:${randomUUID()}`
      }
    );
    const noteId = personalNote.noteId;
    const memoryEventId = randomUUID();
    const noteSource = await pool.query<{
      logical_memory_id: string;
      owner_principal_id: string;
      protocol_deployment_id: string;
    }>(
      `select local_memory.logical_memory_id,logical.owner_principal_id,
              deployment.protocol_deployment_id
         from local_personal_note_logical_memories local_memory
         join logical_memories logical
           on logical.id=local_memory.logical_memory_id
         join deployment_identities deployment
           on deployment.id=logical.origin_deployment_identity_id
        where local_memory.local_note_id=$1
          and local_memory.owner_user_id=$2`,
      [noteId, fixture.ownerUserId]
    );
    const logicalMemoryId = noteSource.rows[0]!.logical_memory_id;
    const sourceOwnerPrincipalId = noteSource.rows[0]!.owner_principal_id;
    const sourceDeploymentProtocolId =
      noteSource.rows[0]!.protocol_deployment_id;
    const noteExternalIdentity = await pool.query<{ id: string }>(
      `insert into sync_external_user_identities
         (deployment_identity_id,external_subject_id)
       select deployment.id,$2
         from deployment_identities deployment
        where deployment.protocol_deployment_id=$1
       returning id`,
      [sourceDeploymentProtocolId, sourceOwnerPrincipalId]
    );
    await pool.query(
      `insert into sync_principal_links
         (local_user_id,external_user_identity_id,proof_kind,proof_reference)
       values ($1,$2,'test_fixture',$3)`,
      [
        fixture.ownerUserId,
        noteExternalIdentity.rows[0]!.id,
        `personal-note-source-${randomUUID()}`
      ]
    );
    await pool.query(
      `update device_credentials
          set metadata=jsonb_build_object(
            'protocolDeploymentId',$2::text,
            'sourceOwnerPrincipalId',$3::text
          )
        where id=$1`,
      [
        fixture.deviceCredentialId,
        sourceDeploymentProtocolId,
        sourceOwnerPrincipalId
      ]
    );
    const occurredAt = "2026-01-02T03:04:05.000Z";
    const body = personalNote.body;
    const source = {
      kind: "personal_note" as const,
      noteId,
      noteRevision: 1,
      memoryEventId,
      logicalMemoryId
    };
    const items = [
      {
        id: memoryEventId,
        representation: "memory_events" as const,
        sequence: 1,
        occurredAt,
        sourceItems: [
          {
            id: memoryEventId,
            sourceKind: "user_message" as const,
            occurredAt,
            body,
            actorName: null,
            toolName: null,
            toolCallId: null
          }
        ]
      }
    ];
    const manifest = [
      {
        sourceId: memoryEventId,
        revisionHash: personalNoteSourceRevisionHash({
          source,
          sourceOwnerPrincipalId,
          content: body,
          occurredAt,
          sourceSequence: 1
        })
      }
    ];
    const byteCount = Buffer.byteLength(JSON.stringify(items[0]), "utf8");
    const candidateHash = crossIdentitySyncDigest({
      version: 2,
      source,
      sourceOwnerPrincipalId,
      sourceCapabilities: ["memory_events"],
      activationRepresentation: "memory_events",
      mode: "continuous",
      sourceRevision: 1,
      itemCount: 1,
      byteCount,
      excludedItemCount: 0,
      manifest,
      items
    });
    const candidate = {
      source,
      logicalMemoryId,
      sourceCapabilities: ["memory_events" as const],
      activationRepresentation: "memory_events" as const,
      mode: "continuous" as const,
      expiresAt: null,
      sourceRevision: 1 as const,
      candidateHash,
      itemCount: 1,
      excludedItemCount: 0,
      manifest,
      byteCount,
      items
    };
    const shareAuthority = authority(fixture);
    const reviewed = await repository.createSharedMemoryCandidatePreview(
      actor(fixture.ownerUserId),
      {
        source,
        sourceDeploymentProtocolId,
        sourceOwnerPrincipalId,
        deviceCredentialId: fixture.deviceCredentialId,
        sourceCapabilities: ["memory_events"],
        activationRepresentation: "memory_events",
        logicalMemoryId,
        candidateHash,
        sourceRevision: 1,
        itemCount: 1,
        excludedItemCount: 0,
        manifest,
        byteCount,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        mode: "continuous",
        authority: shareAuthority
      }
    );
    expect(reviewed).not.toBeNull();
    const pending = await repository.createPendingShare(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: randomUUID(),
        logicalMemoryId,
        source,
        sourceCapabilities: ["memory_events"],
        activationRepresentation: "memory_events",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        preview: reviewed!,
        previewRevision: reviewed!.previewRevision,
        mode: "continuous",
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        authority: shareAuthority
      }
    );

    await expect(
      repository.listOwnerShares(actor(fixture.ownerUserId), { limit: 10 })
    ).resolves.toMatchObject({
      entries: [
        {
          kind: "pending",
          pendingShare: { id: pending.id, state: "preparing" },
          summary: { sourceTitle: "Untitled conversation" }
        }
      ]
    });

    const persisted = await repository.persistPersonalNoteSourceArtifact(
      actor(fixture.ownerUserId),
      {
        pendingShareId: pending.id,
        sourceDeploymentProtocolId,
        sourceOwnerPrincipalId,
        deviceCredentialId: fixture.deviceCredentialId,
        candidate
      }
    );
    expect(persisted).toMatchObject({
      source,
      logicalMemoryId,
      remoteReplicaId: null,
      representation: "memory_events",
      sourceRevision: 1
    });
    await pool.query(
      `update sync_principal_links
          set revoked_at=now()
        where local_user_id=$1 and external_user_identity_id=$2`,
      [fixture.ownerUserId, noteExternalIdentity.rows[0]!.id]
    );
    await expect(
      repository.persistPersonalNoteSourceArtifact(actor(fixture.ownerUserId), {
        pendingShareId: pending.id,
        sourceDeploymentProtocolId,
        sourceOwnerPrincipalId,
        deviceCredentialId: fixture.deviceCredentialId,
        candidate
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
    await pool.query(
      `update sync_principal_links
          set revoked_at=null
        where local_user_id=$1 and external_user_identity_id=$2`,
      [fixture.ownerUserId, noteExternalIdentity.rows[0]!.id]
    );
    await expect(
      repository.persistPersonalNoteSourceArtifact(actor(fixture.ownerUserId), {
        pendingShareId: pending.id,
        sourceDeploymentProtocolId,
        sourceOwnerPrincipalId,
        deviceCredentialId: fixture.deviceCredentialId,
        candidate
      })
    ).resolves.toEqual(persisted);
    await expect(
      pool.query<{
        protocol_deployment_id: string;
        external_subject_id: string;
        local_user_id: string;
      }>(
        `select deployment.protocol_deployment_id,
                external_user.external_subject_id,link.local_user_id
           from deployment_identities deployment
           join sync_external_user_identities external_user
             on external_user.deployment_identity_id=deployment.id
           join sync_principal_links link
             on link.external_user_identity_id=external_user.id
          where deployment.protocol_deployment_id=$1
            and external_user.external_subject_id=$2`,
        [sourceDeploymentProtocolId, sourceOwnerPrincipalId]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          protocol_deployment_id: sourceDeploymentProtocolId,
          external_subject_id: sourceOwnerPrincipalId,
          local_user_id: fixture.ownerUserId
        }
      ]
    });
    await expect(
      repository.processPendingShares({
        limit: 100,
        ensureCompanion: ensurePendingShareCompanion
      })
    ).resolves.toMatchObject({
      claimed: 1,
      activated: 0,
      waiting: 1,
      failed: 0
    });
    await expect(
      repository.persistPersonalNoteSourceArtifact(actor(fixture.ownerUserId), {
        pendingShareId: pending.id,
        sourceDeploymentProtocolId,
        sourceOwnerPrincipalId,
        deviceCredentialId: fixture.deviceCredentialId,
        candidate
      })
    ).resolves.toEqual(persisted);
    const privacyTargets = await repository.listPendingSemanticPrivacyTargets({
      limit: 100
    });
    expect(privacyTargets).toHaveLength(1);
    await prepareSanitizedSemanticPreview(
      privacyTargets[0]!.ownerUserId,
      { previewId: privacyTargets[0]!.sourcePreviewId },
      repository,
      (text) => text.replace("alpha-secret", "[SECRET_1]")
    );
    await pool.query(
      `update pending_share_outbox
          set available_at=now()
        where pending_share_id=$1`,
      [pending.id]
    );
    await expect(
      repository.processPendingShares({
        limit: 100,
        ensureCompanion: ensurePendingShareCompanion
      })
    ).resolves.toMatchObject({ claimed: 1, activated: 1, failed: 0 });

    const ownerView = await repository.getOwnerShare(
      actor(fixture.ownerUserId),
      { kind: "pending", id: pending.id }
    );
    if (!ownerView || ownerView.kind !== "pending") {
      throw new Error("expected activated Personal Note Pending Share");
    }
    expect(ownerView.pendingShare).toMatchObject({
      source,
      state: "activated",
      stage: "complete",
      grantVersion: 2
    });
    expect(ownerView.summary.sourceTitle).toBe(
      "The launch password is [SECRET_1]."
    );
    const shareGrantId = ownerView.pendingShare.grantId!;
    const storage = await pool.query<{
      source_kind: string;
      source_note_id: string;
      source_memory_event_id: string;
      remote_replica_id: string | null;
      session_id: string | null;
      representation_source_kind: string;
      replica_count: string;
      sync_count: string;
      companion_count: string;
    }>(
      `select share.source_kind,share.source_note_id,share.source_memory_event_id,
              share.remote_replica_id,share.source_session_id as session_id,
              representation.source_kind as representation_source_kind,
              (select count(*)::text from memory_replicas replica
                where replica.logical_memory_id=share.logical_memory_id) as replica_count,
              (select count(*)::text from cross_identity_sync_relationships sync
                where sync.logical_memory_id=share.logical_memory_id) as sync_count,
              (select count(*)::text from collaboration_threads thread
                where thread.share_grant_id=share.id
                  and thread.kind='shared_session_discussion') as companion_count
         from team_memory_share_grant_records share
         join team_memory_representation_records representation
           on representation.share_grant_id=share.id and representation.state='available'
        where share.id=$1`,
      [shareGrantId]
    );
    expect(storage.rows).toEqual([
      {
        source_kind: "personal_note",
        source_note_id: noteId,
        source_memory_event_id: memoryEventId,
        remote_replica_id: null,
        session_id: null,
        representation_source_kind: "personal_note",
        replica_count: "0",
        sync_count: "0",
        companion_count: "1"
      }
    ]);
    await expect(
      collaboration.getAuthorizedSnapshot(actor(fixture.readerUserId), {
        scope: "team",
        teamId: fixture.teamId
      })
    ).resolves.toMatchObject({
      threads: [
        expect.objectContaining({
          kind: "shared_session_discussion",
          shareGrantId,
          sharedLogicalMemoryId: logicalMemoryId,
          teamWorkspaceId: fixture.teamWorkspaceId
        })
      ]
    });
    const readerReplay = await collaboration.replayEvents(
      actor(fixture.readerUserId),
      { scope: "team", teamId: fixture.teamId, afterCursor: 0, limit: 100 }
    );
    expect(
      readerReplay?.events.some(
        (event) =>
          event.shareGrantId === shareGrantId &&
          ["share_grant_lifecycle", "memory_event_available"].includes(
            event.family
          )
      )
    ).toBe(true);

    const recalled = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      { shareGrantId, representation: "memory_events" }
    );
    expect(recalled?.grant).toMatchObject({
      source,
      displayTitle: "The launch password is [SECRET_1].",
      lifecycle: "active"
    });
    expect(recalled?.items).toMatchObject([
      {
        itemType: "user_message",
        sourceLogicalMemoryId: logicalMemoryId,
        sourceRevision: 1,
        occurredAt,
        content: { text: "The launch password is [SECRET_1]." }
      }
    ]);
    expect(JSON.stringify(recalled?.items)).not.toContain("alpha-secret");

    const unavailableWorkspace = await pool.query<{ id: string }>(
      `insert into team_workspaces (team_id,name)
       values ($1,$2) returning id`,
      [fixture.teamId, `Unavailable destination ${randomUUID()}`]
    );
    const unavailableWorkspaceId = unavailableWorkspace.rows[0]!.id;
    await pool.query(
      `insert into team_workspace_access_grants (
         team_workspace_id,team_id,user_id,access,can_share_owned_memory,
         granted_by_user_id
       ) values
         ($1,$2,$3,'write',true,$3),
         ($1,$2,$4,'read',false,$3)`,
      [
        unavailableWorkspaceId,
        fixture.teamId,
        fixture.ownerUserId,
        fixture.readerUserId
      ]
    );
    await repository.putWorkspacePolicy(actor(fixture.ownerUserId), {
      mutationId: randomUUID(),
      teamId: fixture.teamId,
      teamWorkspaceId: unavailableWorkspaceId,
      expectedCurrentVersion: 0,
      ...fidelityConsent(allRepresentations)
    });
    const unavailableConsentId = randomUUID();
    const unavailableGrantId = randomUUID();
    await pool.query(
      `insert into source_owner_representation_consents
       select (jsonb_populate_record(
         null::source_owner_representation_consents,
         to_jsonb(consent) || jsonb_build_object(
           'id',$2::text,
           'team_workspace_id',$3::text,
           'workspace_policy_id',workspace_policy.policy_id::text,
           'workspace_policy_version',workspace_policy.version
         )
       )).*
       from source_owner_representation_consents consent
       cross join lateral (
         select policy_id,version
           from workspace_representation_policies
          where team_id=$4 and team_workspace_id=$3
          order by version desc
          limit 1
       ) workspace_policy
       where consent.id=$1`,
      [
        ownerView.pendingShare.consentId,
        unavailableConsentId,
        unavailableWorkspaceId,
        fixture.teamId
      ]
    );
    await pool.query(
      `insert into team_memory_share_grants
       select (jsonb_populate_record(
         null::team_memory_share_grants,
         to_jsonb(grant_row) || jsonb_build_object(
           'id',$2::text,
           'logical_grant_id',$3::text,
           'team_workspace_id',$4::text,
           'consent_id',$5::text,
           'workspace_policy_id',workspace_policy.policy_id::text,
           'workspace_policy_version',workspace_policy.version
         )
       )).*
       from team_memory_share_grants grant_row
       cross join lateral (
         select policy_id,version
           from workspace_representation_policies
          where team_id=$6 and team_workspace_id=$4
          order by version desc
          limit 1
       ) workspace_policy
       where grant_row.id=$1`,
      [
        shareGrantId,
        unavailableGrantId,
        randomUUID(),
        unavailableWorkspaceId,
        unavailableConsentId,
        fixture.teamId
      ]
    );
    await pool.query(
      `delete from team_workspace_access_grants
        where team_workspace_id=$1 and user_id=$2`,
      [unavailableWorkspaceId, fixture.ownerUserId]
    );

    const revisedNote = await collaboration.updatePersonalNoteBody(
      actor(fixture.ownerUserId),
      {
        noteId,
        expectedRevision: 1,
        body: "The revised launch password is beta-secret.",
        idempotencyKey: `personal-note-revision:${randomUUID()}`
      }
    );
    if (!revisedNote) throw new Error("expected revised Personal Note");
    const revisedMemoryEventId = randomUUID();
    const revisedSource = {
      kind: "personal_note" as const,
      noteId,
      noteRevision: revisedNote.revision,
      memoryEventId: revisedMemoryEventId,
      logicalMemoryId
    };
    const revisedItems = [
      {
        id: revisedMemoryEventId,
        representation: "memory_events" as const,
        sequence: 1,
        occurredAt,
        sourceItems: [
          {
            id: revisedMemoryEventId,
            sourceKind: "user_message" as const,
            occurredAt,
            body: revisedNote.body,
            actorName: null,
            toolName: null,
            toolCallId: null
          }
        ]
      }
    ];
    const revisedManifest = [
      {
        sourceId: revisedMemoryEventId,
        revisionHash: personalNoteSourceRevisionHash({
          source: revisedSource,
          sourceOwnerPrincipalId,
          content: revisedNote.body,
          occurredAt,
          sourceSequence: 1
        })
      }
    ];
    const revisedByteCount = Buffer.byteLength(
      JSON.stringify(revisedItems[0]),
      "utf8"
    );
    const revisedCandidateHash = crossIdentitySyncDigest({
      version: 2,
      source: revisedSource,
      sourceOwnerPrincipalId,
      sourceCapabilities: ["memory_events"],
      activationRepresentation: "memory_events",
      mode: "continuous",
      sourceRevision: revisedNote.revision,
      itemCount: 1,
      byteCount: revisedByteCount,
      excludedItemCount: 0,
      manifest: revisedManifest,
      items: revisedItems
    });
    const revisedCandidate = {
      source: revisedSource,
      logicalMemoryId,
      sourceCapabilities: ["memory_events" as const],
      activationRepresentation: "memory_events" as const,
      mode: "continuous" as const,
      expiresAt: null,
      sourceRevision: revisedNote.revision,
      candidateHash: revisedCandidateHash,
      itemCount: 1,
      excludedItemCount: 0,
      manifest: revisedManifest,
      byteCount: revisedByteCount,
      items: revisedItems
    };
    const paused = await repository.controlPendingShare(
      actor(fixture.ownerUserId),
      {
        pendingShareId: pending.id,
        mutationId: randomUUID(),
        expectedOperationVersion: ownerView.pendingShare.operationVersion,
        action: "pause"
      }
    );
    expect(paused.sourceUpdateState).toBe("paused");
    await expect(
      repository.advanceContinuousPersonalNoteRevision(
        actor(fixture.ownerUserId),
        {
          mutationId: randomUUID(),
          deviceCredentialId: fixture.deviceCredentialId,
          sourceDeploymentProtocolId,
          sourceOwnerPrincipalId,
          candidate: revisedCandidate
        }
      )
    ).resolves.toEqual({
      pendingShares: [],
      outcomes: [
        {
          shareGrantId: unavailableGrantId,
          status: "rejected",
          reasonCode: "destination_unavailable"
        }
      ],
      nextShareGrantId: null
    });
    const resumed = await repository.controlPendingShare(
      actor(fixture.ownerUserId),
      {
        pendingShareId: pending.id,
        mutationId: randomUUID(),
        expectedOperationVersion: paused.operationVersion,
        action: "resume"
      }
    );
    expect(resumed.sourceUpdateState).toBe("active");
    const advanced = await repository.advanceContinuousPersonalNoteRevision(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        deviceCredentialId: fixture.deviceCredentialId,
        sourceDeploymentProtocolId,
        sourceOwnerPrincipalId,
        candidate: revisedCandidate
      }
    );
    expect(advanced.pendingShares).toHaveLength(1);
    expect(advanced.outcomes).toEqual(
      expect.arrayContaining([
        {
          shareGrantId,
          status: "accepted",
          pendingShareId: advanced.pendingShares[0]!.id
        },
        {
          shareGrantId: unavailableGrantId,
          status: "rejected",
          reasonCode: "destination_unavailable"
        }
      ])
    );
    const revisedPending = advanced.pendingShares[0]!;
    expect(revisedPending).toMatchObject({
      id: pending.id,
      grantId: shareGrantId,
      consentId: ownerView.pendingShare.consentId,
      source: revisedSource,
      mode: "continuous",
      state: "preparing"
    });
    await expect(
      repository.persistPersonalNoteSourceArtifact(actor(fixture.ownerUserId), {
        pendingShareId: revisedPending.id,
        sourceDeploymentProtocolId,
        sourceOwnerPrincipalId,
        deviceCredentialId: fixture.deviceCredentialId,
        candidate: revisedCandidate
      })
    ).resolves.toMatchObject({ sourceRevision: 2, source: revisedSource });
    await expect(
      pool.query<{ latest_source_revision: string }>(
        `select latest_source_revision::text from logical_memories where id=$1`,
        [logicalMemoryId]
      )
    ).resolves.toMatchObject({
      rows: [{ latest_source_revision: "2" }]
    });
    const retainedSource = await pool.query<{ count: string }>(
      `select count(*)::text as count from shared_source_artifact_records
        where logical_memory_id=$1 and source_kind='personal_note'`,
      [logicalMemoryId]
    );
    expect(retainedSource.rows[0]?.count).toBe("2");
    await expect(
      collaboration.getPersonalNote(actor(fixture.ownerUserId), { noteId })
    ).resolves.toEqual(revisedNote);
    await expect(
      repository.processPendingShares({
        limit: 100,
        ensureCompanion: ensurePendingShareCompanion
      })
    ).resolves.toMatchObject({ claimed: 1, activated: 0, waiting: 1 });
    const recallWhileFiltering = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      { shareGrantId, representation: "memory_events" }
    );
    expect(recallWhileFiltering).toMatchObject({
      grant: { source, sourceRevision: 1 },
      items: [
        {
          sourceRevision: 1,
          content: { text: "The launch password is [SECRET_1]." }
        }
      ]
    });
    expect(JSON.stringify(recallWhileFiltering)).not.toContain("beta-secret");
    const revisedPrivacyTargets =
      await repository.listPendingSemanticPrivacyTargets({ limit: 100 });
    expect(revisedPrivacyTargets).toHaveLength(1);
    await prepareSanitizedSemanticPreview(
      revisedPrivacyTargets[0]!.ownerUserId,
      { previewId: revisedPrivacyTargets[0]!.sourcePreviewId },
      repository,
      (text) => text.replace("beta-secret", "[SECRET_2]")
    );
    await repository.reconcileReadySemanticRepresentations({ limit: 100 });
    await expect(
      pool.query<{
        source_revision: string;
        premature_representations: string;
      }>(
        `select g.source_revision::text,
                count(representation.id)::text as premature_representations
           from team_memory_share_grants g
           left join team_memory_representations representation
             on representation.share_grant_id=g.id
            and representation.source_revision=$2
            and representation.state in ('pending','available','stale')
          where g.id=$1
          group by g.source_revision`,
        [shareGrantId, revisedNote.revision]
      )
    ).resolves.toMatchObject({
      rows: [{ source_revision: "1", premature_representations: "0" }]
    });
    await pool.query(
      `update pending_share_outbox set available_at=now()
        where pending_share_id=$1`,
      [revisedPending.id]
    );
    await expect(
      repository.processPendingShares({
        limit: 100,
        ensureCompanion: ensurePendingShareCompanion
      })
    ).resolves.toMatchObject({ claimed: 1, activated: 1, failed: 0 });
    const revisedRecall = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      { shareGrantId, representation: "memory_events" }
    );
    expect(revisedRecall).toMatchObject({
      grant: {
        id: shareGrantId,
        source: revisedSource,
        sourceRevision: 2,
        displayTitle: "The revised launch password is [SECRET_2]."
      },
      items: [
        {
          sourceRevision: 2,
          content: { text: "The revised launch password is [SECRET_2]." }
        }
      ]
    });
    expect(JSON.stringify(revisedRecall)).not.toContain("beta-secret");
    await expect(
      pool.query<{ family: string }>(
        `select family from collaboration_outbox
          where share_grant_id=$1 and family='source_revision_changed'`,
        [shareGrantId]
      )
    ).resolves.toMatchObject({
      rows: [{ family: "source_revision_changed" }]
    });
    await expect(
      pool.query<{ count: string }>(
        `select count(*)::text as count from team_memory_share_grants
          where logical_memory_id=$1 and team_workspace_id=$2`,
        [logicalMemoryId, fixture.teamWorkspaceId]
      )
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
    const revoked = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId,
        expectedGrantVersion: revisedRecall!.grant.grantVersion,
        reasonCode: "owner_withdrawal",
        authority: shareAuthority
      }
    );
    expect(revoked.lifecycle).toBe("revoked");
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId,
        representation: "memory_events"
      })
    ).resolves.toBeNull();
  });

  it("fails a Pending Share closed when its reviewed candidate manifest cannot be reproduced", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "candidate-manifest-change");
    await putOwnerPolicy(fixture, source);
    const shareAuthority = authority(fixture);
    const candidate = await repository.createSharedMemoryCandidatePreview(
      actor(fixture.ownerUserId),
      {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        candidateHash: hash("candidate-manifest-change"),
        sourceRevision: source.currentRevision,
        itemCount: 1,
        excludedItemCount: 0,
        manifest: candidateManifest(source, "memory_events"),
        byteCount: 128,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        ...fidelityConsent(allRepresentations),
        mode: "continuous",
        authority: shareAuthority
      }
    );
    const pending = await repository.createPendingShare(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: randomUUID(),
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        preview: candidate!,
        previewRevision: candidate!.previewRevision,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: shareAuthority
      }
    );
    const changedManifest = [
      {
        sourceId: randomUUID(),
        revisionHash: hash("changed-reviewed-source")
      }
    ];
    await pool.query(
      `update shared_memory_candidate_previews
          set candidate_manifest=$2::jsonb,candidate_manifest_hash=$3
        where id=$1`,
      [
        candidate!.previewId,
        JSON.stringify(changedManifest),
        crossIdentitySyncDigest(changedManifest)
      ]
    );

    await expect(repository.processPendingShares()).resolves.toMatchObject({
      claimed: 1,
      activated: 0,
      failed: 1
    });
    await expect(
      repository.getOwnerShare(actor(fixture.ownerUserId), {
        kind: "pending",
        id: pending.id
      })
    ).resolves.toMatchObject({
      kind: "pending",
      pendingShare: {
        state: "failed",
        workspaceAccessState: "none",
        redactedFailureCode: "candidate_manifest_changed"
      }
    });
    await expect(
      repository.listWorkspaceGrants(actor(fixture.readerUserId), {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        limit: 10,
        offset: 0
      })
    ).resolves.toMatchObject({ entries: [] });
  });

  it("pages equal-time owned shares by immutable identity despite mutable updates", async () => {
    const fixture = await createWorkspaceFixture();
    const shareAuthority = authority(fixture);
    const pendingShares = [];
    for (const label of ["equal-time-a", "equal-time-b"]) {
      const source = await createSource(fixture, 1, label);
      await putOwnerPolicy(fixture, source);
      const candidate = await repository.createSharedMemoryCandidatePreview(
        actor(fixture.ownerUserId),
        {
          ...capturedSourceBinding(source, "memory_events"),
          logicalMemoryId: source.logicalMemoryId,
          candidateHash: hash(label),
          sourceRevision: source.currentRevision,
          itemCount: 1,
          excludedItemCount: 0,
          manifest: candidateManifest(source, "memory_events"),
          byteCount: 128,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          ...fidelityConsent(allRepresentations),
          mode: "continuous",
          authority: shareAuthority
        }
      );
      pendingShares.push(
        await repository.createPendingShare(actor(fixture.ownerUserId), {
          mutationId: randomUUID(),
          logicalGrantId: randomUUID(),
          consentId: randomUUID(),
          ...capturedSourceBinding(source, "memory_events"),
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          preview: candidate!,
          previewRevision: candidate!.previewRevision,
          mode: "continuous",
          ...fidelityConsent(allRepresentations),
          authority: shareAuthority
        })
      );
    }
    await pool.query(
      `update pending_share_operations
          set created_at='2026-08-16T12:00:00.000Z'
        where id=any($1::uuid[])`,
      [pendingShares.map((pending) => pending.id)]
    );

    const first = await repository.listOwnerShares(actor(fixture.ownerUserId), {
      limit: 1
    });
    expect(first.entries).toHaveLength(1);
    expect(first.next).not.toBeNull();
    const firstEntry = first.entries[0]!;
    await pool.query(
      `update pending_share_operations set updated_at=now()
        where id=$1 and owner_user_id=$2`,
      [
        firstEntry.kind === "pending" ? firstEntry.pendingShare.id : "",
        fixture.ownerUserId
      ]
    );
    const second = await repository.listOwnerShares(
      actor(fixture.ownerUserId),
      {
        limit: 1,
        snapshotAt: first.snapshotAt,
        after: first.next!
      }
    );
    expect(second.entries).toHaveLength(1);
    const resultIds = [...first.entries, ...second.entries].map((entry) =>
      entry.kind === "pending" ? entry.pendingShare.id : entry.grant.id
    );
    expect(new Set(resultIds)).toEqual(
      new Set(pendingShares.map((pending) => pending.id))
    );
    for (const pending of pendingShares) {
      const current = await repository.getOwnerShare(
        actor(fixture.ownerUserId),
        { kind: "pending", id: pending.id }
      );
      if (!current || current.kind !== "pending") {
        throw new Error("expected Pending Share cleanup state");
      }
      await repository.controlPendingShare(actor(fixture.ownerUserId), {
        pendingShareId: pending.id,
        mutationId: randomUUID(),
        expectedOperationVersion: current.pendingShare.operationVersion,
        action: "revoke"
      });
    }
  });

  it("excludes Approval Activity instead of failing Pending Share activation", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "pending-approval");
    const originalEvent = source.lastSyncPackage!.changes[0]!.event;
    if (!originalEvent) throw new Error("Expected a source Memory Event");
    const originalApprovalContributor = originalEvent.contributors[1]!;
    const {
      revisionHash: _originalContributorRevisionHash,
      ...originalApprovalContributorInput
    } = originalApprovalContributor;
    void _originalContributorRevisionHash;
    const approvalMetadata = {
      ...originalApprovalContributor.metadata,
      providerApprovalKind: "approval_request"
    };
    const approvalContributor = buildCapturedSessionSyncContributor({
      ...originalApprovalContributorInput,
      metadata: approvalMetadata
    });
    const { revisionHash: _originalEventRevisionHash, ...originalEventInput } =
      originalEvent;
    void _originalEventRevisionHash;
    const legacyApprovalEvent = buildCapturedSessionSyncEvent({
      ...originalEventInput,
      contributors: [originalEvent.contributors[0]!, approvalContributor]
    });
    await upsertEncryptedFieldPayloadWithClient(
      pool,
      actor(fixture.ownerUserId),
      ownerProvider,
      {
        sourceTable: "conversation_items",
        sourceId: source.seededEvents[0]!.contributorIds[1]!,
        sourceColumn: "metadata",
        plaintext: approvalMetadata,
        visibility: "owner_private_replica",
        ownerPrincipalId: source.ownerPrincipalId,
        rowFamily: "conversation_item",
        scope: {
          tenantId: fixture.ownerUserId,
          objectClass: "conversation_item"
        }
      }
    );
    await pool.query(
      `update sync_event_mappings
          set revision_hash=$2
        where sync_relationship_id=$1 and active=true`,
      [source.syncRelationshipId, legacyApprovalEvent.revisionHash]
    );
    await putOwnerPolicy(fixture, source);
    const shareAuthority = authority(fixture);
    const approvalFilteredPreview =
      await repository.createAuthoritativeSourcePreview(
        actor(fixture.ownerUserId),
        {
          ...capturedSourceBinding(source, "memory_events"),
          logicalMemoryId: source.logicalMemoryId,
          remoteReplicaId: source.remoteReplicaId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          mode: "continuous",
          ...fidelityConsent(allRepresentations),
          authority: shareAuthority
        }
      );
    expect(approvalFilteredPreview.items).toHaveLength(1);
    expect(approvalFilteredPreview.items[0]?.itemType).toBe("user_message");
    const candidate = await repository.createSharedMemoryCandidatePreview(
      actor(fixture.ownerUserId),
      {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        candidateHash: hash("pending-approval-memory-events"),
        sourceRevision: source.currentRevision,
        itemCount: 1,
        excludedItemCount: 0,
        manifest: candidateManifest(source, "memory_events"),
        byteCount: 128,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        ...fidelityConsent(allRepresentations),
        mode: "continuous",
        authority: shareAuthority
      }
    );
    expect(candidate).not.toBeNull();
    const pending = await repository.createPendingShare(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: randomUUID(),
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        preview: candidate!,
        previewRevision: candidate!.previewRevision,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: shareAuthority
      }
    );

    await expect(
      processPendingSharesAfterPrivacy(pending.id, {
        ensureCompanion: ensurePendingShareCompanion
      })
    ).resolves.toMatchObject({
      claimed: 1,
      activated: 1,
      failed: 0
    });
    const activated = await repository.getOwnerShare(
      actor(fixture.ownerUserId),
      { kind: "pending", id: pending.id }
    );
    expect(activated).toMatchObject({
      kind: "pending",
      pendingShare: {
        state: "activated",
        redactedFailureCode: null
      }
    });
    if (!activated || activated.kind !== "pending") {
      throw new Error("expected activated Pending Share");
    }
    const activatedGrantId = activated.pendingShare.grantId!;
    await expect(
      repository.getOwnerShare(actor(fixture.ownerUserId), {
        kind: "grant",
        id: activatedGrantId
      })
    ).resolves.toMatchObject({
      kind: "grant",
      grant: { id: activatedGrantId, ownerUserId: fixture.ownerUserId },
      summary: activated.summary
    });
    await expect(
      repository.getOwnerShare(actor(fixture.outsiderUserId), {
        kind: "grant",
        id: activatedGrantId
      })
    ).resolves.toBeNull();
    const read = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      {
        shareGrantId: activated.pendingShare.grantId!,
        representation: "memory_events"
      }
    );
    expect(read?.items).toHaveLength(1);
    expect(read?.items[0]?.itemType).toBe("user_message");
  });

  it.each(["40001", "40P01", "persistent", "denied", "revoked", "excluded"])(
    "recovers direct activation with bounded current authority: %s",
    async (scenario) => {
      const fixture = await createWorkspaceFixture();
      const source = await createSource(fixture, 1, `direct-retry-${scenario}`);
      await putOwnerPolicy(fixture, source);
      const owner = actor(fixture.ownerUserId);
      const shareAuthority = authority(fixture);
      const candidate = await repository.createSharedMemoryCandidatePreview(
        owner,
        {
          ...capturedSourceBinding(source, "memory_events"),
          logicalMemoryId: source.logicalMemoryId,
          candidateHash: hash(`direct-retry-${scenario}`),
          sourceRevision: source.currentRevision,
          itemCount: candidateManifest(source, "memory_events").length,
          excludedItemCount: 0,
          manifest: candidateManifest(source, "memory_events"),
          byteCount: 128,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          ...fidelityConsent(allRepresentations),
          mode: "continuous",
          authority: shareAuthority
        }
      );
      const pending = await repository.createPendingShare(owner, {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: randomUUID(),
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        preview: candidate!,
        previewRevision: candidate!.previewRevision,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: shareAuthority
      });
      let attempts = 0;
      const ensureCompanion: typeof ensurePendingShareCompanion = async (
        input
      ) => {
        if (input.grant.logicalMemoryId !== source.logicalMemoryId)
          return ensurePendingShareCompanion(input);
        attempts++;
        if (scenario === "denied")
          throw new SharedMemoryAuthorizationError("Access ended");
        if (scenario === "excluded") {
          const review =
            await repository.getWorkspaceConversationExclusionReview(owner, {
              logicalMemoryId: source.logicalMemoryId,
              teamId: fixture.teamId,
              teamWorkspaceId: fixture.teamWorkspaceId
            });
          await repository.excludeWorkspaceConversation(owner, {
            mutationId: randomUUID(),
            scope: review!.scope,
            authority: shareAuthority
          });
          return ensurePendingShareCompanion(input);
        }
        if (scenario === "revoked") {
          await pool.query(
            "update device_credentials set revoked_at=now() where id=$1",
            [fixture.deviceCredentialId]
          );
        }
        if (attempts === 1 || scenario === "persistent")
          throw Object.assign(new Error("Concurrent activation"), {
            code: scenario === "40P01" ? "40P01" : "40001"
          });
        return ensurePendingShareCompanion(input);
      };
      const result = await processPendingSharesAfterPrivacy(pending.id, {
        ensureCompanion
      });
      const success = scenario === "40001" || scenario === "40P01";
      expect(result).toMatchObject({
        activated: success ? 1 : 0,
        failed: success ? 0 : 1
      });
      expect(attempts).toBe(success ? 2 : scenario === "persistent" ? 3 : 1);
      const state = await repository.getOwnerShare(owner, {
        kind: "pending",
        id: pending.id
      });
      expect(state).toMatchObject({
        kind: "pending",
        pendingShare: {
          id: pending.id,
          state: success
            ? "activated"
            : scenario === "excluded"
              ? "revoked"
              : "needs_attention"
        }
      });
      const grants = await pool.query<{ id: string; lifecycle: string }>(
        "select id,lifecycle from team_memory_share_grants where logical_memory_id=$1 and team_workspace_id=$2",
        [source.logicalMemoryId, fixture.teamWorkspaceId]
      );
      expect(grants.rows).toHaveLength(1);
      const reasons = await pool.query(
        "select id from team_memory_share_reasons where share_grant_id=$1",
        [grants.rows[0]!.id]
      );
      expect(reasons.rows).toHaveLength(1);
      if (scenario === "revoked" || scenario === "excluded") {
        expect(grants.rows[0]!.lifecycle).not.toBe("active");
        await expect(
          repository.readGrantRepresentation(actor(fixture.readerUserId), {
            shareGrantId: grants.rows[0]!.id,
            representation: "memory_events"
          })
        ).resolves.toBeNull();
      }
    }
  );

  it("waits for an explicit retry after Pending Share activation fails", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "pending-invalid-item", {
      assistantActor: "observer",
      assistantKind: "future_protocol_item"
    });
    await putOwnerPolicy(fixture, source);
    const shareAuthority = authority(fixture);
    const candidate = await repository.createSharedMemoryCandidatePreview(
      actor(fixture.ownerUserId),
      {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        candidateHash: hash("pending-invalid-item-memory-events"),
        sourceRevision: source.currentRevision,
        itemCount: 1,
        excludedItemCount: 0,
        manifest: candidateManifest(source, "memory_events"),
        byteCount: 128,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        ...fidelityConsent(allRepresentations),
        mode: "continuous",
        authority: shareAuthority
      }
    );
    expect(candidate).not.toBeNull();
    const pending = await repository.createPendingShare(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: randomUUID(),
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        preview: candidate!,
        previewRevision: candidate!.previewRevision,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: shareAuthority
      }
    );

    const reportActivationFailure = vi.fn();
    await expect(
      repository.processPendingShares({
        ensureCompanion: ensurePendingShareCompanion,
        reportActivationFailure
      })
    ).resolves.toMatchObject({
      claimed: 1,
      activated: 0,
      failed: 1
    });
    expect(reportActivationFailure).toHaveBeenCalledWith({
      pendingShareId: pending.id,
      failureStage: "authoritative_preview",
      errorClass: "SharedMemorySourceItemRejectedError",
      errorCode: null
    });
    const failed = await repository.getOwnerShare(actor(fixture.ownerUserId), {
      kind: "pending",
      id: pending.id
    });
    expect(failed).toMatchObject({
      kind: "pending",
      pendingShare: {
        state: "needs_attention",
        redactedFailureCode: "activation_failed"
      }
    });
    await expect(
      repository.processPendingShares({
        ensureCompanion: ensurePendingShareCompanion
      })
    ).resolves.toMatchObject({
      claimed: 0,
      activated: 0,
      failed: 0
    });
  });

  it("activates, controls, replaces, and revokes a browser-authorized Pending Share durably", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "pending-browser");
    await putOwnerPolicy(fixture, source);
    const browserAuthority = authority(fixture);
    const shareAuthority = {
      ...browserAuthority,
      referenceId: randomUUID()
    };
    const createCandidate = (
      representation: SharedMemoryRepresentation,
      candidateHash: string
    ) =>
      repository.createSharedMemoryCandidatePreview(
        actor(fixture.ownerUserId),
        {
          ...capturedSourceBinding(source, representation),
          logicalMemoryId: source.logicalMemoryId,
          candidateHash,
          sourceRevision: source.currentRevision,
          itemCount: 1,
          excludedItemCount: 0,
          manifest: candidateManifest(source, representation),
          byteCount: 128,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          ...fidelityConsent(allRepresentations),
          mode: "continuous",
          authority: browserAuthority
        }
      );
    const initialCandidate = await createCandidate(
      "memory_events",
      hash("pending-browser-memory-events")
    );
    const replacementCandidate = await createCandidate(
      "lcm_leaves",
      hash("pending-browser-lcm-leaves")
    );
    expect(initialCandidate).not.toBeNull();
    expect(replacementCandidate).not.toBeNull();
    expect(replacementCandidate?.previewId).not.toBe(
      initialCandidate?.previewId
    );

    const mutationId = randomUUID();
    const pendingInput = {
      mutationId,
      logicalGrantId: randomUUID(),
      consentId: randomUUID(),
      ...capturedSourceBinding(source, "memory_events"),
      logicalMemoryId: source.logicalMemoryId,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.teamWorkspaceId,
      preview: initialCandidate!,
      previewRevision: initialCandidate!.previewRevision,
      mode: "continuous" as const,
      ...fidelityConsent(allRepresentations),
      title: "Launch review",
      authority: shareAuthority
    };
    const pending = await repository.createPendingShare(
      actor(fixture.ownerUserId),
      pendingInput
    );
    await expect(
      repository.createPendingShare(actor(fixture.ownerUserId), pendingInput)
    ).resolves.toMatchObject({ id: pending.id, operationVersion: 1 });
    await expect(
      repository.createPendingShare(actor(fixture.ownerUserId), {
        ...pendingInput,
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: randomUUID()
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    await expect(
      repository.createPendingShare(actor(fixture.ownerUserId), {
        ...pendingInput,
        authority: authority(fixture, "manager")
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);

    const preparing = await repository.listOwnerShares(
      actor(fixture.ownerUserId),
      { limit: 10 }
    );
    expect(preparing.entries).toHaveLength(1);
    expect(preparing.entries[0]).toMatchObject({
      kind: "pending",
      summary: { sourceTitle: "Untitled conversation" },
      pendingShare: {
        id: pending.id,
        state: "preparing",
        workspaceAccessState: "none"
      }
    });
    await expect(
      repository.listOwnerShares(actor(fixture.outsiderUserId), {
        limit: 10
      })
    ).resolves.toMatchObject({ entries: [] });
    await expect(
      repository.listWorkspaceGrants(actor(fixture.readerUserId), {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        limit: 10,
        offset: 0
      })
    ).resolves.toMatchObject({ entries: [] });

    repository = createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: () => provider,
      resolvePersonalEncryptionProvider: () => privacyProvider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider
    });
    const activationRun = await processPendingSharesAfterPrivacy(
      pending.id,
      { ensureCompanion: ensurePendingShareCompanion },
      (text) => text,
      true
    );
    expect(activationRun.claimed).toBeGreaterThan(0);
    expect(activationRun.activated).toBe(1);
    expect(activationRun.failed).toBe(0);
    const activated = await repository.getOwnerShare(
      actor(fixture.ownerUserId),
      { kind: "pending", id: pending.id }
    );
    expect(activated).toMatchObject({
      kind: "pending",
      pendingShare: {
        state: "activated",
        workspaceAccessState: "active",
        sourceUpdateState: "active"
      }
    });
    if (!activated || activated.kind !== "pending") {
      throw new Error("expected activated Pending Share");
    }
    const activatedOperationVersion = activated.pendingShare.operationVersion;
    const shareGrantId = activated.pendingShare.grantId!;
    const activatedGrantVersion = activated.pendingShare.grantVersion!;
    const directReason = activated.summary.sharingReasons[0]!;
    expect(directReason).toMatchObject({
      kind: "direct",
      updateState: "active",
      mode: "continuous"
    });
    const publicationCounts = await pool.query<{
      grants: string;
      representations: string;
    }>(
      `select
         (select count(*)::text from team_memory_share_grants where id=$1) as grants,
         (select count(*)::text from team_memory_representations
           where share_grant_id=$1 and state='available') as representations`,
      [shareGrantId]
    );
    expect(publicationCounts.rows[0]).toEqual({
      grants: "1",
      representations: "1"
    });
    const workspacePage = await repository.listWorkspaceGrants(
      actor(fixture.readerUserId),
      {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        limit: 10,
        offset: 0
      }
    );
    expect(workspacePage.entries).toHaveLength(1);
    expect(workspacePage.entries[0]).toMatchObject({
      shareGrantId,
      activeRepresentation: "memory_events",
      lifecycle: "active"
    });

    const pauseMutationId = randomUUID();
    const paused = await repository.controlPendingShare(
      actor(fixture.ownerUserId),
      {
        pendingShareId: pending.id,
        mutationId: pauseMutationId,
        expectedOperationVersion: activatedOperationVersion,
        action: "pause"
      }
    );
    expect(paused).toMatchObject({
      grantId: shareGrantId,
      grantVersion: activatedGrantVersion,
      workspaceAccessState: "active",
      sourceUpdateState: "paused"
    });
    const pausedExplanation = await repository.getOwnerShare(
      actor(fixture.ownerUserId),
      { kind: "pending", id: pending.id }
    );
    expect(pausedExplanation?.summary.sharingReasons).toEqual([
      expect.objectContaining({
        id: directReason.id,
        updateState: "paused",
        consentId: directReason.consentId
      })
    ]);
    await expect(
      repository.controlPendingShare(actor(fixture.ownerUserId), {
        pendingShareId: pending.id,
        mutationId: pauseMutationId,
        expectedOperationVersion: activatedOperationVersion,
        action: "pause"
      })
    ).resolves.toMatchObject({ operationVersion: paused.operationVersion });
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId,
        representation: "memory_events"
      })
    ).resolves.not.toBeNull();
    const resumeMutationId = randomUUID();
    const resumed = await repository.controlPendingShare(
      actor(fixture.ownerUserId),
      {
        pendingShareId: pending.id,
        mutationId: resumeMutationId,
        expectedOperationVersion: paused.operationVersion,
        action: "resume"
      }
    );
    expect(resumed).toMatchObject({
      grantId: shareGrantId,
      grantVersion: activatedGrantVersion,
      sourceUpdateState: "active"
    });
    const controlEventIds = [
      crossIdentitySyncDeterministicUuid({
        kind: "pending_share_lifecycle",
        pendingShareId: pending.id,
        parentMutationId: pauseMutationId,
        action: "pause",
        state: paused.state,
        operationVersion: paused.operationVersion
      }),
      crossIdentitySyncDeterministicUuid({
        kind: "pending_share_lifecycle",
        pendingShareId: pending.id,
        parentMutationId: resumeMutationId,
        action: "resume",
        state: resumed.state,
        operationVersion: resumed.operationVersion
      })
    ];
    const controlEvents = await pool.query<{ mutation_id: string }>(
      `select mutation_id
         from collaboration_outbox
        where family='pending_share_lifecycle'
          and mutation_id=any($1::uuid[])
        order by mutation_id`,
      [controlEventIds]
    );
    expect(controlEvents.rows.map((row) => row.mutation_id).sort()).toEqual(
      controlEventIds.sort()
    );

    const ownerGrantPage = await repository.listOwnerGrants(
      actor(fixture.ownerUserId),
      { logicalMemoryId: source.logicalMemoryId, limit: 10, offset: 0 }
    );
    const currentGrant = ownerGrantPage.entries[0]!;
    const replacementSession = await pool.query<{ id: string }>(
      `insert into user_sessions (user_id, session_hash, expires_at)
       values ($1, $2, now() + interval '1 hour') returning id`,
      [fixture.ownerUserId, hash(`replacement-owner-session:${randomUUID()}`)]
    );
    const replacementAuthority = {
      ...browserAuthority,
      referenceId: replacementSession.rows[0]!.id
    };
    const replacement = await repository.createPendingFidelityChange(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        consentId: randomUUID(),
        ...capturedSourceBinding(source, "lcm_leaves"),
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        shareGrantId,
        expectedGrantVersion: currentGrant.grantVersion,
        preview: replacementCandidate!,
        previewRevision: replacementCandidate!.previewRevision,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: replacementAuthority
      }
    );
    expect(replacement).toMatchObject({
      grantId: shareGrantId,
      grantVersion: currentGrant.grantVersion,
      state: "preparing",
      workspaceAccessState: "active",
      sourceUpdateState: "preparing"
    });
    const replacementAuthorityProvenance = await pool.query<{
      preview_authority_reference_id: string;
      command_authority_reference_id: string;
    }>(
      `select candidate.authority_reference_id as preview_authority_reference_id,
              pending.replacement_authority_reference_id as command_authority_reference_id
         from pending_share_operations pending
         join shared_memory_candidate_previews candidate
           on candidate.id=pending.replacement_preview_id
        where pending.id=$1`,
      [pending.id]
    );
    expect(replacementAuthorityProvenance.rows[0]).toEqual({
      preview_authority_reference_id: browserAuthority.referenceId,
      command_authority_reference_id: replacementAuthority.referenceId
    });
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId,
        representation: "memory_events"
      })
    ).resolves.toMatchObject({
      representation: { representation: "memory_events" }
    });
    const replacementRun = await processPendingSharesAfterPrivacy(pending.id, {
      ensureCompanion: ensurePendingShareCompanion
    });
    expect(replacementRun).toMatchObject({
      claimed: 1,
      activated: 1,
      waiting: 0,
      failed: 0
    });
    const replacedPage = await repository.listWorkspaceGrants(
      actor(fixture.readerUserId),
      {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        limit: 10,
        offset: 0
      }
    );
    expect(replacedPage.entries[0]).toMatchObject({
      shareGrantId,
      activeRepresentation: "lcm_leaves"
    });
    const replacedOwnerGrant = (
      await repository.listOwnerGrants(actor(fixture.ownerUserId), {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        limit: 10,
        offset: 0
      })
    ).entries[0]!;
    expect(replacedOwnerGrant.grantVersion).toBe(currentGrant.grantVersion + 1);

    const revocationMutationId = randomUUID();
    await repository.revokeShareGrant(actor(fixture.ownerUserId), {
      mutationId: revocationMutationId,
      shareGrantId,
      expectedGrantVersion: replacedOwnerGrant.grantVersion,
      reasonCode: "owner_revoked",
      authority: browserAuthority
    });
    await expect(
      repository.revokeShareGrant(actor(fixture.ownerUserId), {
        mutationId: revocationMutationId,
        shareGrantId,
        expectedGrantVersion: replacedOwnerGrant.grantVersion,
        reasonCode: "owner_revoked",
        authority: browserAuthority
      })
    ).resolves.toMatchObject({ lifecycle: "revoked" });
    await expect(
      repository.listOwnerShares(actor(fixture.ownerUserId), {
        limit: 10
      })
    ).resolves.toMatchObject({ entries: [] });
    const history = await repository.listOwnerShares(
      actor(fixture.ownerUserId),
      { limit: 10, history: true }
    );
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      kind: "pending",
      pendingShare: {
        id: pending.id,
        state: "revoked",
        workspaceAccessState: "revoked",
        sourceUpdateState: "stopped"
      },
      summary: {
        sharingReasons: [
          expect.objectContaining({
            id: directReason.id,
            updateState: "stopped"
          })
        ]
      }
    });
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId,
        representation: "memory_events"
      })
    ).resolves.toBeNull();
  });

  it("fences concurrent privacy Workers and rejects stale completion after revocation", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "privacy-worker-fencing");
    await putOwnerPolicy(fixture, source);
    const browserAuthority = authority(fixture);
    const candidate = await repository.createSharedMemoryCandidatePreview(
      actor(fixture.ownerUserId),
      {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        candidateHash: hash("privacy-worker-fencing"),
        sourceRevision: source.currentRevision,
        itemCount: 1,
        excludedItemCount: 0,
        manifest: candidateManifest(source, "memory_events"),
        byteCount: 128,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        ...fidelityConsent(allRepresentations),
        mode: "continuous",
        authority: browserAuthority
      }
    );
    if (!candidate) throw new Error("candidate was not admitted");
    const pending = await repository.createPendingShare(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: randomUUID(),
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        preview: candidate,
        previewRevision: candidate.previewRevision,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: { ...browserAuthority, referenceId: randomUUID() }
      }
    );
    await expect(repository.processPendingShares()).resolves.toMatchObject({
      waiting: 1,
      failed: 0
    });
    const staleOutbox = await pool.query<{ reclaim_at: Date }>(
      `update pending_share_outbox
          set state='processing',locked_at=now(),updated_at=now()
        where pending_share_id=$1
      returning locked_at+interval '5 minutes' as reclaim_at`,
      [pending.id]
    );
    await expect(repository.getNextPendingShareWorkAt()).resolves.toBe(
      staleOutbox.rows[0]?.reclaim_at.toISOString()
    );
    const pendingRow = await pool.query<{ grant_id: string }>(
      "select grant_id from pending_share_operations where id=$1",
      [pending.id]
    );
    const shareGrantId = pendingRow.rows[0]?.grant_id;
    if (!shareGrantId) throw new Error("unavailable grant was not retained");
    const [target] = await repository.listPendingSemanticPrivacyTargets({
      shareGrantId,
      limit: 10
    });
    if (!target) throw new Error("privacy target was not created");
    const secondRepository = createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: () => provider,
      resolvePersonalEncryptionProvider: () => privacyProvider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider
    });
    const finalizationLease =
      await repository.tryAcquireSemanticPrivacyFinalizationLease();
    expect(finalizationLease).not.toBeNull();
    await expect(
      secondRepository.tryAcquireSemanticPrivacyFinalizationLease()
    ).resolves.toBeNull();
    await finalizationLease!.release();
    const replacementFinalizationLease =
      await secondRepository.tryAcquireSemanticPrivacyFinalizationLease();
    expect(replacementFinalizationLease).not.toBeNull();
    await replacementFinalizationLease!.release();
    const claimInput = {
      semanticPreviewId: target.id,
      leaseMs: 120_000,
      expectedWorkIdentity: sharedMemorySemanticPrivacyWorkIdentity(target)
    };
    const claims = await Promise.all([
      repository.claimSemanticPrivacyTarget(actor(fixture.ownerUserId), {
        ...claimInput,
        claimantId: "privacy-worker-a"
      }),
      secondRepository.claimSemanticPrivacyTarget(actor(fixture.ownerUserId), {
        ...claimInput,
        claimantId: "privacy-worker-b"
      })
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const firstClaim = claims.find(Boolean)!;
    await expect(repository.getNextSemanticPrivacyWorkAt()).resolves.toBe(
      firstClaim.expiresAt
    );
    const workerClock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2100-01-01T00:00:00.000Z"));
    try {
      await expect(
        secondRepository.claimSemanticPrivacyTarget(
          actor(fixture.ownerUserId),
          { ...claimInput, claimantId: "privacy-worker-clock-skewed" }
        )
      ).resolves.toBeNull();
    } finally {
      workerClock.mockRestore();
    }
    const backlog = await repository.getSemanticPrivacyBacklogDiagnostics();
    expect(backlog).toMatchObject({
      counts: { pending: 0, leased: 1, deferred: 0 },
      bySchedulingClass: { foreground: 1, background: 0 },
      byWorkReason: { share_activation: 1 },
      completionEstimate: {
        status: "unavailable",
        reason: "insufficient_measured_throughput"
      }
    });
    expect(JSON.stringify(backlog)).not.toContain(fixture.ownerUserId);
    const loaded = await repository.readPendingSemanticPrivacyTarget(
      actor(fixture.ownerUserId),
      {
        semanticPreviewId: target.id,
        expectedSourcePreviewHash: target.sourcePreviewHash,
        expectedSourceArtifactHash: target.sourceArtifactHash,
        expectedSourceManifestHash: target.sourceManifestHash,
        expectedClassifierHash: target.classifierHash,
        expectedEffectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash
      }
    );
    if (!loaded) throw new Error("privacy target was not readable");
    const fields = loaded.classificationFields.map(({ path, text }) => ({
      path,
      text
    }));
    const chunks = Array.from(
      { length: Math.ceil(fields.length / 16) },
      (_, chunkIndex) => {
        const chunk = fields.slice(chunkIndex * 16, chunkIndex * 16 + 16);
        return {
          chunkIndex,
          firstFieldIndex: chunkIndex * 16,
          fieldCount: chunk.length,
          inputIdentityHash: privacyRepository.classificationInputIdentity({
            actor: actor(fixture.ownerUserId),
            fields: chunk
          }),
          orderedInputHash: privacyClassificationOrderedInputHash(chunk)
        };
      }
    );
    const expectedManifestHash = privacyClassificationExpectedManifestHash({
      semanticPreviewId: target.id,
      sourcePreviewHash: target.sourcePreviewHash,
      sourceArtifactHash: target.sourceArtifactHash,
      sourceManifestHash: target.sourceManifestHash,
      sourceRevision: target.sourceRevision,
      classifierGenerationId: target.classifierGenerationId,
      classifierHash: target.classifierHash,
      effectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash,
      fieldCount: fields.length,
      chunks
    });
    await expect(
      repository.initializeSemanticPrivacyManifest(actor(fixture.ownerUserId), {
        claim: firstClaim,
        expectedManifestHash,
        fieldCount: fields.length,
        fieldByteCount: 1,
        chunks: chunks.map((chunk, index) =>
          index === 0 ? { ...chunk, firstFieldIndex: 1 } : chunk
        )
      })
    ).rejects.toThrow("manifest field ranges are invalid");
    await repository.initializeSemanticPrivacyManifest(
      actor(fixture.ownerUserId),
      {
        claim: firstClaim,
        expectedManifestHash,
        fieldCount: fields.length,
        fieldByteCount: fields.reduce(
          (total, field) => total + Buffer.byteLength(field.text),
          0
        ),
        chunks
      }
    );
    await pool.query(
      "update shared_source_semantic_privacy_work_claims set expires_at=now()-interval '1 second' where semantic_preview_id=$1",
      [target.id]
    );
    const replacementClaim = await repository.claimSemanticPrivacyTarget(
      actor(fixture.ownerUserId),
      { ...claimInput, claimantId: "privacy-worker-replacement" }
    );
    expect(replacementClaim?.claimGeneration).toBe(
      firstClaim.claimGeneration + 1
    );
    const firstChunkFields = fields.slice(0, chunks[0]!.fieldCount);
    const classification = await privacyRepository.storeClassificationResult({
      actor: actor(fixture.ownerUserId),
      provider: privacyProvider,
      fields: firstChunkFields,
      response: {
        schemaVersion: 1,
        inputContractVersion: "koed-privacy-classification-v1",
        classifier: {
          classifierHash: privacyClassifier.classifierHash,
          modelKey: privacyClassifier.modelKey,
          modelRevision: privacyClassifier.modelRevision
        },
        fields: firstChunkFields.map((field) => ({
          path: field.path,
          inputSha256: hash(field.text),
          inputByteLength: Buffer.byteLength(field.text),
          maskedText: field.text,
          decodedTextMatchesInput: true,
          spans: []
        }))
      }
    });
    await expect(
      repository.attachSemanticPrivacyChunkResult(actor(fixture.ownerUserId), {
        claim: firstClaim,
        chunkIndex: 0,
        inputIdentityHash: chunks[0]!.inputIdentityHash,
        orderedInputHash: chunks[0]!.orderedInputHash,
        classificationResultId: classification.id,
        classificationPayloadBindingHash: classification.payloadBindingHash!
      })
    ).rejects.toThrow("chunk result binding was rejected");
    await expect(
      repository.listSemanticPrivacyManifest(actor(fixture.ownerUserId), {
        claim: firstClaim
      })
    ).resolves.toEqual([]);
    await pool.query(
      `update team_workspace_access_grants
          set disabled_at=now(),disabled_reason='membership_disabled',
              version=version+1,updated_at=now()
        where team_id=$1 and team_workspace_id=$2 and user_id=$3`,
      [fixture.teamId, fixture.teamWorkspaceId, fixture.ownerUserId]
    );
    await expect(
      repository.readPendingSemanticPrivacyTarget(actor(fixture.ownerUserId), {
        semanticPreviewId: target.id,
        expectedSourcePreviewHash: target.sourcePreviewHash,
        expectedSourceArtifactHash: target.sourceArtifactHash,
        expectedSourceManifestHash: target.sourceManifestHash,
        expectedClassifierHash: target.classifierHash,
        expectedEffectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash
      })
    ).resolves.toBeNull();
    await pool.query(
      `update team_workspace_access_grants
          set disabled_at=null,disabled_reason=null,
              version=version+1,updated_at=now()
        where team_id=$1 and team_workspace_id=$2 and user_id=$3`,
      [fixture.teamId, fixture.teamWorkspaceId, fixture.ownerUserId]
    );
    await repository.revokeShareGrant(actor(fixture.ownerUserId), {
      mutationId: randomUUID(),
      shareGrantId,
      expectedGrantVersion: target.grantVersion,
      reasonCode: "privacy_fencing_test",
      authority: browserAuthority
    });
    await expect(
      repository.readPendingSemanticPrivacyTarget(actor(fixture.ownerUserId), {
        semanticPreviewId: target.id,
        expectedSourcePreviewHash: target.sourcePreviewHash,
        expectedSourceArtifactHash: target.sourceArtifactHash,
        expectedSourceManifestHash: target.sourceManifestHash,
        expectedClassifierHash: target.classifierHash,
        expectedEffectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash
      })
    ).resolves.toBeNull();
    const visibility = await pool.query<{ status: string }>(
      "select status from shared_source_semantic_previews where id=$1",
      [target.id]
    );
    expect(visibility.rows[0]?.status).not.toBe("ready");
  });

  it("prioritizes foreground privacy work and promotes an old background target", async () => {
    const fixture = await createWorkspaceFixture();
    const pendingIds: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const source = await createSource(
        fixture,
        index,
        `privacy-scheduling-${index}`
      );
      await putOwnerPolicy(fixture, source);
      const candidate = await repository.createSharedMemoryCandidatePreview(
        actor(fixture.ownerUserId),
        {
          ...capturedSourceBinding(source, "memory_events"),
          logicalMemoryId: source.logicalMemoryId,
          candidateHash: hash(`privacy-scheduling-${index}`),
          sourceRevision: source.currentRevision,
          itemCount: 1,
          excludedItemCount: 0,
          manifest: candidateManifest(source, "memory_events"),
          byteCount: 128,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          ...fidelityConsent(allRepresentations),
          mode: "continuous",
          authority: authority(fixture)
        }
      );
      if (!candidate) throw new Error("privacy scheduler candidate missing");
      const pending = await repository.createPendingShare(
        actor(fixture.ownerUserId),
        {
          mutationId: randomUUID(),
          logicalGrantId: randomUUID(),
          consentId: randomUUID(),
          ...capturedSourceBinding(source, "memory_events"),
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          preview: candidate,
          previewRevision: candidate.previewRevision,
          mode: "continuous",
          ...fidelityConsent(allRepresentations),
          authority: { ...authority(fixture), referenceId: randomUUID() }
        }
      );
      pendingIds.push(pending.id);
    }
    await expect(
      repository.processPendingShares({ limit: 10 })
    ).resolves.toMatchObject({ claimed: 3, waiting: 3, failed: 0 });
    const initialTargets = await repository.listPendingSemanticPrivacyTargets({
      limit: 10
    });
    expect(initialTargets).toHaveLength(3);
    const [foreground, ordinaryBackground, promotedBackground] = initialTargets;
    await pool.query(
      `update shared_source_semantic_previews
          set scheduling_class='background',work_reason='background_repair'
        where id=any($1::uuid[])`,
      [[ordinaryBackground!.id, promotedBackground!.id]]
    );
    const foregroundFirst = await repository.listPendingSemanticPrivacyTargets({
      limit: 10
    });
    expect(foregroundFirst.map((target) => target.id)).toEqual([
      foreground!.id,
      ordinaryBackground!.id,
      promotedBackground!.id
    ]);

    await pool.query(
      `update shared_source_semantic_previews
          set enqueued_at=now()-interval '121 seconds'
        where id=$1`,
      [promotedBackground!.id]
    );
    const promotedFirst = await repository.listPendingSemanticPrivacyTargets({
      limit: 10
    });
    expect(promotedFirst.map((target) => target.id)).toEqual([
      promotedBackground!.id,
      foreground!.id,
      ordinaryBackground!.id
    ]);
    expect(pendingIds).toHaveLength(3);
  });

  it("surfaces a stalled Pending Share and resumes it idempotently after worker restart", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "pending-retry");
    await putOwnerPolicy(fixture, source);
    const candidate = await repository.createSharedMemoryCandidatePreview(
      actor(fixture.ownerUserId),
      {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        candidateHash: hash("pending-retry-candidate"),
        sourceRevision: source.currentRevision,
        itemCount: 1,
        excludedItemCount: 0,
        manifest: candidateManifest(source, "memory_events"),
        byteCount: 128,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        ...fidelityConsent(allRepresentations),
        mode: "continuous",
        authority: authority(fixture)
      }
    );
    expect(candidate).not.toBeNull();
    const pending = await repository.createPendingShare(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: randomUUID(),
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        preview: candidate!,
        previewRevision: candidate!.previewRevision,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: authority(fixture)
      }
    );
    await pool.query(
      "update memory_replicas set latest_revision=0 where id=$1",
      [source.remoteReplicaId]
    );
    await pool.query(
      `update cross_identity_sync_relationships
          set target_processing_cursor=0 where id=$1`,
      [source.syncRelationshipId]
    );
    await pool.query(
      `update pending_share_operations
          set last_progress_at=now()-interval '2 minutes' where id=$1`,
      [pending.id]
    );

    repository = createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: () => provider,
      resolvePersonalEncryptionProvider: () => privacyProvider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider
    });
    const stalledRun = await repository.processPendingShares({
      stallThresholdMs: 60_000
    });
    expect(stalledRun.claimed).toBeGreaterThan(0);
    const stalled = await repository.getOwnerShare(actor(fixture.ownerUserId), {
      kind: "pending",
      id: pending.id
    });
    expect(stalled).toMatchObject({
      kind: "pending",
      pendingShare: {
        state: "needs_attention",
        workspaceAccessState: "none",
        sourceUpdateState: "preparing",
        redactedFailureCode: "source_preparation_stalled"
      }
    });
    if (!stalled || stalled.kind !== "pending") {
      throw new Error("expected stalled Pending Share");
    }
    const retryMutationId = randomUUID();
    const retried = await repository.controlPendingShare(
      actor(fixture.ownerUserId),
      {
        pendingShareId: pending.id,
        mutationId: retryMutationId,
        expectedOperationVersion: stalled.pendingShare.operationVersion,
        action: "retry"
      }
    );
    await expect(
      repository.controlPendingShare(actor(fixture.ownerUserId), {
        pendingShareId: pending.id,
        mutationId: retryMutationId,
        expectedOperationVersion: stalled.pendingShare.operationVersion,
        action: "retry"
      })
    ).resolves.toMatchObject({ operationVersion: retried.operationVersion });
    const retryEvents = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from collaboration_outbox
        where family='pending_share_lifecycle' and mutation_id=$1`,
      [
        crossIdentitySyncDeterministicUuid({
          kind: "pending_share_lifecycle",
          pendingShareId: pending.id,
          parentMutationId: retryMutationId,
          action: "retry",
          state: retried.state,
          operationVersion: retried.operationVersion
        })
      ]
    );
    expect(retryEvents.rows[0]?.count).toBe("1");
    await pool.query(
      "update memory_replicas set latest_revision=$2 where id=$1",
      [source.remoteReplicaId, source.currentRevision]
    );
    await pool.query(
      `update cross_identity_sync_relationships
          set target_processing_cursor=$2 where id=$1`,
      [source.syncRelationshipId, source.currentRevision]
    );
    repository = createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: () => provider,
      resolvePersonalEncryptionProvider: () => privacyProvider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider
    });
    const resumedRun = await processPendingSharesAfterPrivacy(pending.id, {
      ensureCompanion: ensurePendingShareCompanion
    });
    expect(resumedRun.activated).toBeGreaterThan(0);
    await expect(
      repository.getOwnerShare(actor(fixture.ownerUserId), {
        kind: "pending",
        id: pending.id
      })
    ).resolves.toMatchObject({
      kind: "pending",
      pendingShare: {
        state: "activated",
        workspaceAccessState: "active",
        redactedFailureCode: null
      }
    });
  });

  it("stops a Pending Share before activation and moves it to history", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "pending-revoke");
    await putOwnerPolicy(fixture, source);
    const candidate = await repository.createSharedMemoryCandidatePreview(
      actor(fixture.ownerUserId),
      {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        candidateHash: hash("pending-revoke-candidate"),
        sourceRevision: source.currentRevision,
        itemCount: 1,
        excludedItemCount: 0,
        manifest: candidateManifest(source, "memory_events"),
        byteCount: 128,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        ...fidelityConsent(allRepresentations),
        mode: "continuous",
        authority: authority(fixture)
      }
    );
    const pending = await repository.createPendingShare(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: randomUUID(),
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        preview: candidate!,
        previewRevision: candidate!.previewRevision,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: authority(fixture)
      }
    );
    const mutationId = randomUUID();
    const revoked = await repository.controlPendingShare(
      actor(fixture.ownerUserId),
      {
        pendingShareId: pending.id,
        mutationId,
        expectedOperationVersion: pending.operationVersion,
        action: "revoke"
      }
    );
    expect(revoked).toMatchObject({
      state: "revoked",
      stage: "complete",
      workspaceAccessState: "revoked",
      sourceUpdateState: "stopped",
      redactedFailureCode: null
    });
    await expect(
      repository.controlPendingShare(actor(fixture.ownerUserId), {
        pendingShareId: pending.id,
        mutationId,
        expectedOperationVersion: pending.operationVersion,
        action: "revoke"
      })
    ).resolves.toMatchObject({ operationVersion: revoked.operationVersion });
    await expect(
      repository.listOwnerShares(actor(fixture.ownerUserId), {
        limit: 10
      })
    ).resolves.toMatchObject({ entries: [] });
    await expect(
      repository.listOwnerShares(actor(fixture.ownerUserId), {
        limit: 10,
        history: true
      })
    ).resolves.toMatchObject({
      entries: [
        {
          kind: "pending",
          pendingShare: { id: pending.id, state: "revoked" }
        }
      ]
    });
  });

  it("encrypts synchronized conversation item metadata and transport payloads", async () => {
    const fixture = await createWorkspaceFixture();
    const secret = `cross-sync-secret-${randomUUID()}`;
    const source = await createSource(fixture, 1, secret);
    const contributorIds = source.seededEvents[0]!.contributorIds;

    const stored = await pool.query<{
      raw_json: unknown;
      raw_text: string | null;
      transport_chunk_text: string | null;
      metadata: Record<string, unknown>;
    }>(
      `select raw_json,raw_text,transport_chunk_text,metadata
         from conversation_items
        where id=any($1::uuid[])
        order by id`,
      [contributorIds]
    );
    expect(stored.rows).toHaveLength(2);
    for (const row of stored.rows) {
      expect(row.raw_json).toMatchObject({ contentEncrypted: true });
      expect(row.raw_text).toBe("[koed encrypted conversation item]");
      expect(row.transport_chunk_text).toBe(
        "[koed encrypted conversation item]"
      );
      expect(row.metadata.encryptedConversationItemColumns).toEqual([
        "raw_json",
        "raw_text",
        "transport_chunk_text",
        "metadata"
      ]);
      expect(JSON.stringify(row)).not.toContain(secret);
      expect(JSON.stringify(row.metadata)).not.toContain("seedLabel");
    }

    const encrypted = await pool.query<{
      source_id: string;
      source_column: string;
    }>(
      `select source_id,source_column
         from encrypted_field_payloads
        where source_table='conversation_items'
          and source_id=any($1::uuid[])
          and invalidated_at is null
        order by source_id,source_column`,
      [contributorIds]
    );
    expect(encrypted.rows).toHaveLength(8);
    for (const contributorId of contributorIds) {
      expect(
        encrypted.rows
          .filter((row) => row.source_id === contributorId)
          .map((row) => row.source_column)
      ).toEqual(["metadata", "raw_json", "raw_text", "transport_chunk_text"]);
    }
  });

  it("recovers legacy empty raw text markers without weakening encrypted-field checks", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "empty-raw-text", {
      assistantRawText: ""
    });
    const assistantId = source.seededEvents[0]!.contributorIds[1]!;
    const stored = await pool.query<{
      raw_text: string | null;
      encrypted_columns: string[];
      encrypted_raw_text_rows: string;
    }>(
      `select ci.raw_text,
              array(select jsonb_array_elements_text(
                ci.metadata->'encryptedConversationItemColumns'))
                as encrypted_columns,
              (select count(*)::text
                 from encrypted_field_payloads payload
                where payload.source_table='conversation_items'
                  and payload.source_id=ci.id
                  and payload.source_column='raw_text'
                  and payload.invalidated_at is null)
                as encrypted_raw_text_rows
         from conversation_items ci
        where ci.id=$1`,
      [assistantId]
    );
    expect(stored.rows[0]).toEqual({
      raw_text: "",
      encrypted_columns: ["raw_json", "transport_chunk_text", "metadata"],
      encrypted_raw_text_rows: "0"
    });

    await pool.query(
      `update conversation_items
          set raw_text='[koed encrypted conversation item]'
        where id=$1`,
      [assistantId]
    );
    const preview = await createPersistedPreview(
      fixture,
      source,
      "memory_events"
    );
    expect(preview.items).toHaveLength(2);
    expect(preview.items.map((item) => item.itemType)).toEqual([
      "user_message",
      "assistant_message"
    ]);
  });

  it("rolls back browser consent when bundled Share Grant creation fails", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1);
    await putOwnerPolicy(fixture, source);
    const preview = await createPersistedPreview(
      fixture,
      source,
      "memory_events",
      1,
      "atomic-share-bundle"
    );
    const consentId = randomUUID();

    await expect(
      repository.createShareBundle(actor(fixture.ownerUserId), {
        consent: {
          ...reviewedSourceBinding(preview),
          consentId,
          preview,
          mode: "continuous",
          ...fidelityConsent(allRepresentations),
          authority: authority(fixture)
        },
        grant: {
          mutationId: randomUUID(),
          logicalGrantId: "not-a-uuid",
          consentId,
          authority: authority(fixture)
        },
        expected: {
          consentId,
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          previewId: preview.previewId,
          previewRevision: preview.previewRevision,
          previewHash: preview.previewHash,
          ...fidelityConsent(allRepresentations)
        }
      })
    ).rejects.toThrow("logicalGrantId must be a UUID");

    const persisted = await pool.query(
      "select 1 from source_owner_representation_consents where id=$1",
      [consentId]
    );
    expect(persisted.rowCount).toBe(0);
  });

  it("keeps preview policy proposals inactive until the final share bundle", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "deferred-owner-policy");
    const preview = await createPersistedPreview(
      fixture,
      source,
      "memory_events",
      1,
      "deferred-owner-policy",
      ["memory_events"]
    );
    const beforeShare = await pool.query(
      `select 1 from source_owner_representation_policies
        where logical_memory_id=$1 and source_owner_principal_id=$2
          and effective_at<=now() and superseded_at is null`,
      [source.logicalMemoryId, source.ownerPrincipalId]
    );
    expect(beforeShare.rowCount).toBe(0);

    const consentId = randomUUID();
    const bundled = await repository.createShareBundle(
      actor(fixture.ownerUserId),
      {
        consent: {
          ...reviewedSourceBinding(preview),
          consentId,
          preview,
          mode: "continuous",
          ...fidelityConsent(["memory_events"]),
          authority: authority(fixture)
        },
        grant: {
          mutationId: randomUUID(),
          logicalGrantId: randomUUID(),
          consentId,
          authority: authority(fixture)
        },
        expected: {
          consentId,
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          previewId: preview.previewId,
          previewRevision: preview.previewRevision,
          previewHash: preview.previewHash,
          ...fidelityConsent(["memory_events"])
        }
      }
    );

    expect(bundled).not.toBeNull();
    const afterShare = await pool.query<{
      maximum_fidelity: string;
      include_curated_memory: boolean;
      version: number;
    }>(
      `select maximum_fidelity,include_curated_memory,version
         from source_owner_representation_policies
        where logical_memory_id=$1 and source_owner_principal_id=$2
          and effective_at<=now() and superseded_at is null`,
      [source.logicalMemoryId, source.ownerPrincipalId]
    );
    expect(afterShare.rows).toEqual([
      {
        maximum_fidelity: "memory_events",
        include_curated_memory: false,
        version: 1
      }
    ]);
  });

  it("rolls back replacement consent when bundled fidelity change conflicts", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture);
    const preview = await createPersistedPreview(
      fixture,
      grant,
      "lcm_leaves",
      grant.currentRevision,
      "atomic-representation-bundle",
      ["lcm_leaves", "lcm_rollups"]
    );
    const consentId = randomUUID();

    await expect(
      repository.changeFidelityBundle(actor(fixture.ownerUserId), {
        consent: {
          ...reviewedSourceBinding(preview),
          consentId,
          preview,
          mode: "continuous",
          maximumFidelity: "lcm_leaves",
          includeCuratedMemory: false,
          authority: authority(fixture)
        },
        fidelity: {
          mutationId: randomUUID(),
          shareGrantId: grant.shareGrantId,
          consentId,
          maximumFidelity: "lcm_leaves",
          includeCuratedMemory: false,
          expectedGrantVersion: grant.grantVersion + 100,
          authority: authority(fixture)
        },
        expected: {
          consentId,
          logicalMemoryId: grant.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          previewId: preview.previewId,
          previewRevision: preview.previewRevision,
          previewHash: preview.previewHash,
          maximumFidelity: "lcm_leaves",
          includeCuratedMemory: false
        }
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);

    const consent = await pool.query(
      "select 1 from source_owner_representation_consents where id=$1",
      [consentId]
    );
    const persistedGrant = await pool.query<{
      maximum_fidelity: string;
      include_curated_memory: boolean;
      grant_version: number;
    }>(
      `select maximum_fidelity,include_curated_memory,grant_version
         from team_memory_share_grants where id=$1`,
      [grant.shareGrantId]
    );
    expect(consent.rowCount).toBe(0);
    expect(persistedGrant.rows[0]).toMatchObject({
      maximum_fidelity: "memory_events",
      include_curated_memory: false,
      grant_version: grant.grantVersion
    });
  });

  it("binds explicit consent to the exact redacted preview and source owner", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 3);
    await putOwnerPolicy(fixture, source);
    const preview = await createPersistedPreview(
      fixture,
      source,
      "memory_events",
      3,
      "exact-preview"
    );
    const contributorIdentities = await pool.query<{
      id: string;
      external_item_id: string | null;
    }>(
      `select ci.id, ci.external_item_id
         from memory_event_sources mes
         join conversation_items ci on ci.id = mes.conversation_item_id
        where mes.memory_event_id = $1
        order by mes.source_order, ci.id`,
      [source.seededEvents[0]!.eventId]
    );
    expect(contributorIdentities.rows).not.toHaveLength(0);
    expect(
      contributorIdentities.rows.every(
        (row) => row.external_item_id && row.id !== row.external_item_id
      )
    ).toBe(true);
    const consentId = randomUUID();
    const input = {
      source: preview.source!,
      sourceCapabilities: preview.sourceCapabilities,
      activationRepresentation: preview.activationRepresentation,
      consentId,
      mode: "snapshot" as const,
      ...fidelityConsent(allRepresentations),
      authority: authority(fixture),
      preview
    };
    const first = await repository.createSourceOwnerConsent(
      actor(fixture.ownerUserId),
      input
    );
    const replay = await repository.createSourceOwnerConsent(
      actor(fixture.ownerUserId),
      input
    );
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      id: consentId,
      mode: "snapshot",
      state: "active",
      maximumAuthorizedSourceRevision: 3,
      previewHash: preview.previewHash,
      sourceContentHash: preview.sourceContentHash
    });

    await expect(
      repository.createSourceOwnerConsent(actor(fixture.ownerUserId), {
        ...input,
        consentId: randomUUID(),
        preview: {
          previewId: preview.previewId,
          previewHash: hash(`tampered-preview:${preview.previewId}`)
        }
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    await expect(
      repository.createSourceOwnerConsent(actor(fixture.managerUserId), {
        ...input,
        consentId: randomUUID(),
        authority: authority(fixture, "manager")
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
    await expect(
      repository.createShareGrant(actor(fixture.managerUserId), {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId,
        authority: authority(fixture, "manager")
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
  });

  it.each([
    { code: "40001", alwaysFail: false, expectedCalls: 2 },
    { code: "40P01", alwaysFail: false, expectedCalls: 2 },
    { code: "42501", alwaysFail: false, expectedCalls: 1 },
    { code: "40001", alwaysFail: true, expectedCalls: 3 }
  ])(
    "bounds authoritative preview retries for $code (alwaysFail=$alwaysFail)",
    async ({ code, alwaysFail, expectedCalls }) => {
      const fixture = await createWorkspaceFixture();
      const source = await createSource(fixture, 1, "preview-retry");
      await putOwnerPolicy(fixture, source);
      let decryptCalls = 0;
      const injectedError = Object.assign(
        new Error("injected preview failure"),
        { code }
      );
      const retryRepository = createSharedMemoryRepository(pool, {
        resolvePersonalEncryptionProvider: () => privacyProvider,
        resolveTeamEncryptionProvider: () => provider,
        resolveOwnerPrivateReplicaEncryptionProvider: (input) => {
          if (input.purpose === "decrypt") {
            decryptCalls += 1;
            if (alwaysFail || decryptCalls === 1) throw injectedError;
          }
          return ownerProvider;
        }
      });
      const result = retryRepository.createAuthoritativeSourcePreview(
        actor(fixture.ownerUserId),
        {
          ...capturedSourceBinding(source, "memory_events"),
          logicalMemoryId: source.logicalMemoryId,
          remoteReplicaId: source.remoteReplicaId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          mode: "continuous",
          ...fidelityConsent(allRepresentations),
          authority: authority(fixture)
        }
      );
      if (alwaysFail || code === "42501") {
        await expect(result).rejects.toBe(injectedError);
      } else {
        await expect(result).resolves.toMatchObject({ sourceRevision: 1 });
      }
      expect(decryptCalls).toBe(expectedCalls);
    }
  );

  it("holds one repeatable-read snapshot while authoritative previews load sync context and source rows", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "repeatable-read");
    await putOwnerPolicy(fixture, source);
    const tamperedContributorId = source.seededEvents[0]?.contributorIds[0];
    if (!tamperedContributorId) {
      throw new Error("expected seeded contributor for repeatable-read test");
    }

    let releaseProviderGate!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProviderGate = resolve;
    });
    let signalProviderRequested!: () => void;
    const providerRequested = new Promise<void>((resolve) => {
      signalProviderRequested = resolve;
    });
    let gateUsed = false;
    const snapshotRepository = createSharedMemoryRepository(pool, {
      resolvePersonalEncryptionProvider: () => privacyProvider,
      resolveTeamEncryptionProvider: () => provider,
      resolveOwnerPrivateReplicaEncryptionProvider: async (input) => {
        if (input.purpose === "decrypt" && !gateUsed) {
          gateUsed = true;
          signalProviderRequested();
          await providerGate;
        }
        return ownerProvider;
      }
    });
    const previewInput = {
      ...capturedSourceBinding(source, "memory_events"),
      logicalMemoryId: source.logicalMemoryId,
      remoteReplicaId: source.remoteReplicaId,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.teamWorkspaceId,
      representation: "memory_events" as const,
      mode: "continuous" as const,
      ...fidelityConsent(allRepresentations),
      authority: authority(fixture)
    };

    const previewPromise = snapshotRepository.createAuthoritativeSourcePreview(
      actor(fixture.ownerUserId),
      previewInput
    );
    await providerRequested;
    const writer = await pool.connect();
    try {
      await writer.query("begin");
      await writer.query("set local lock_timeout='2s'");
      await writer.query(
        "update logical_memories set updated_at=now() where id=$1",
        [source.logicalMemoryId]
      );
      await writer.query(
        "update memory_replicas set updated_at=now() where id=$1",
        [source.remoteReplicaId]
      );
      await writer.query(
        "update cross_identity_sync_relationships set updated_at=now() where id=$1",
        [source.syncRelationshipId]
      );
      await writer.query("commit");
    } catch (error) {
      await writer.query("rollback");
      throw error;
    } finally {
      writer.release();
      // Never leave the preview waiting if a lock regression fails this check.
      releaseProviderGate();
    }
    await pool.query(
      `update conversation_items
          set source_event_type = $2
        where id = $1`,
      [tamperedContributorId, "tampered_user_message"]
    );
    releaseProviderGate();

    const preview = await previewPromise;
    expect(preview.sourceRevision).toBe(1);
    expect(preview.items.map((item) => item.itemType)).toEqual([
      "user_message",
      "assistant_message"
    ]);
    await expect(
      repository.createAuthoritativeSourcePreview(
        actor(fixture.ownerUserId),
        previewInput
      )
    ).rejects.toThrow(
      "Memory Event sync revision hash does not match active mapping"
    );
  });

  it("verifies every canonical contributor while rendering grouped semantic source items", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "grouped-source", {
      groupedAssistantSources: true
    });
    await putOwnerPolicy(fixture, source);

    const preview = await repository.createAuthoritativeSourcePreview(
      actor(fixture.ownerUserId),
      {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        remoteReplicaId: source.remoteReplicaId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: authority(fixture)
      }
    );

    expect(source.seededEvents[0]?.contributorIds).toHaveLength(3);
    expect(preview.items).toMatchObject([
      { itemType: "user_message" },
      {
        itemType: "assistant_message",
        content: { text: "grouped-source assistant source" }
      }
    ]);
  });

  it("recovers native Pi tool provenance after canonical integrity verification", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "pi-provenance", {
      assistantSourceKind: "pi",
      assistantActor: "tool",
      assistantKind: "tool_result",
      assistantRawJson: {
        type: "pi_session_record",
        sourceRecord: {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "read",
            toolCallId: "call-1",
            content: [{ type: "text", text: "synthetic result" }]
          }
        }
      }
    });
    await putOwnerPolicy(fixture, source);
    const preview = await createPersistedPreview(
      fixture,
      source,
      "memory_events"
    );
    expect(preview.items).toMatchObject([
      { itemType: "user_message" },
      {
        itemType: "tool_result",
        content: { toolName: "read", toolCallId: "call-1" }
      }
    ]);
    await pool.query(
      `update conversation_items set source_event_type = 'tampered_tool_result' where id = $1`,
      [source.seededEvents[0]!.contributorIds[1]]
    );
    await expect(
      createPersistedPreview(fixture, source, "memory_events")
    ).rejects.toThrow(
      "Memory Event sync revision hash does not match active mapping"
    );
  });

  it("limits Pi tool publication to the verified semantic block and excludes retained sibling reasoning", async () => {
    const fixture = await createWorkspaceFixture();
    const block = {
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: { path: "synthetic" }
    };
    const source = await createSource(fixture, 1, "pi-block-boundary", {
      assistantSourceKind: "pi",
      assistantActor: "tool",
      assistantKind: "tool_call",
      assistantText: 'Tool call: read\n\nInput: {"path":"synthetic"}',
      assistantRawJson: {
        type: "pi_session_record",
        contentBlock: block,
        sourceRecord: {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "HIDDEN_SIBLING_REASONING" },
              { type: "text", text: "UNSELECTED_SIBLING_TEXT" },
              block
            ]
          }
        }
      }
    });
    await putOwnerPolicy(fixture, source);
    const preview = await createPersistedPreview(
      fixture,
      source,
      "memory_events"
    );
    expect(preview.items[1]).toMatchObject({
      itemType: "tool_call",
      content: {
        toolName: "read",
        toolCallId: "call-1",
        payload: { arguments: { path: "synthetic" } }
      }
    });
    expect(JSON.stringify(preview.items)).not.toContain(
      "HIDDEN_SIBLING_REASONING"
    );
    expect(JSON.stringify(preview.items)).not.toContain(
      "UNSELECTED_SIBLING_TEXT"
    );
  });

  it("excludes independently classified source items after verifying the canonical revision", async () => {
    const cases: Array<{
      label: string;
      options: SourceRevisionOptions;
    }> = [
      {
        label: "hidden-reasoning",
        options: {
          assistantKind: "reasoning_raw",
          assistantText: "hidden chain of thought"
        }
      },
      {
        label: "system-instruction",
        options: {
          assistantActor: "system",
          assistantKind: "system_message",
          assistantText: "hidden system instruction"
        }
      },
      {
        label: "unsupported-tool",
        options: {
          assistantActor: "tool",
          assistantKind: "tool_result",
          assistantText: "unclassified tool output"
        }
      },
      {
        label: "pi-instruction-argument",
        options: {
          assistantSourceKind: "pi",
          assistantActor: "tool",
          assistantKind: "tool_call",
          assistantRawJson: {
            type: "pi_session_record",
            sourceRecord: { type: "message", message: { role: "assistant" } },
            contentBlock: {
              type: "toolCall",
              name: "read",
              id: "call-1",
              arguments: { system_instruction: "prohibited instruction" }
            }
          }
        }
      },
      {
        label: "memory-excluded",
        options: {
          assistantMemoryExcludedAt: "2026-01-01T00:00:00.000Z",
          assistantMemoryExclusionReason: "source_policy"
        }
      }
    ];

    for (const testCase of cases) {
      const fixture = await createWorkspaceFixture();
      const source = await createSource(
        fixture,
        1,
        testCase.label,
        testCase.options
      );
      await putOwnerPolicy(fixture, source);
      const preview = await createPersistedPreview(
        fixture,
        source,
        "memory_events"
      );
      expect(preview.items).toEqual([
        expect.objectContaining({
          itemType: "user_message",
          content: { text: `${testCase.label} user source` }
        })
      ]);
    }
  });

  it("keeps credential-bearing owner-private source content for asynchronous sanitization", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "credential-staging", {
      assistantText: "Bearer abcdefghijklmnopqrstuvwxyz"
    });
    await putOwnerPolicy(fixture, source);

    const preview = await createPersistedPreview(
      fixture,
      source,
      "memory_events"
    );

    expect(preview.items).toEqual([
      expect.objectContaining({
        itemType: "user_message",
        content: { text: "credential-staging user source" }
      }),
      expect.objectContaining({
        itemType: "assistant_message",
        content: { text: "Bearer abcdefghijklmnopqrstuvwxyz" }
      })
    ]);
  });

  it("rejects unknown authoritative source types instead of filtering them", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "unknown-source-type", {
      assistantActor: "future_actor",
      assistantKind: "future_protocol_item"
    });
    await putOwnerPolicy(fixture, source);
    await expect(
      createPersistedPreview(fixture, source, "memory_events")
    ).rejects.toMatchObject({ reasonCode: "unknown_item_type" });
    const persisted = await pool.query(
      `select 1 from shared_source_artifacts where logical_memory_id=$1`,
      [source.logicalMemoryId]
    );
    expect(persisted.rowCount).toBe(0);
  });

  it("rejects cross-session leaf and rollup provenance without creating a fallback", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "cross-session-primary");
    const foreign = await createSource(fixture, 1, "cross-session-foreign");
    await putOwnerPolicy(fixture, source);
    const foreignEventId = foreign.seededEvents[0]!.eventId;

    await pool.query(
      `insert into memory_node_sources
         (memory_node_id,memory_event_id,source_order)
       values ($1,$2,1)`,
      [source.leaf.nodeId, foreignEventId]
    );
    await expect(
      createPersistedPreview(fixture, source, "lcm_leaves")
    ).rejects.toThrow("LCM leaf mixes shared and unshared source provenance");
    await pool.query(
      `delete from memory_node_sources
        where memory_node_id=$1 and memory_event_id=$2`,
      [source.leaf.nodeId, foreignEventId]
    );

    await pool.query(
      `insert into memory_node_sources
         (memory_node_id,memory_event_id,source_order)
       values ($1,$2,1)`,
      [source.rollup.nodeId, foreignEventId]
    );
    await expect(
      createPersistedPreview(fixture, source, "lcm_rollups")
    ).rejects.toThrow("LCM rollup mixes shared and unshared source provenance");

    const persisted = await pool.query(
      `select representation from shared_source_artifacts
        where logical_memory_id=$1`,
      [source.logicalMemoryId]
    );
    expect(persisted.rows).toEqual([]);
  });

  it("keeps missing, placeholder, and unknown-schema LCM states unavailable without fallback", async () => {
    const cases: Array<{
      representation: "lcm_leaves" | "lcm_rollups";
      mutate: (source: SourceFixture) => Promise<unknown>;
      message: string;
    }> = [
      {
        representation: "lcm_leaves",
        mutate: (source) =>
          pool.query(
            "update memory_nodes set invalidated_at=now() where id=$1",
            [source.leaf.nodeId]
          ),
        message:
          "Authoritative Shared Memory source material is empty or invalid"
      },
      {
        representation: "lcm_leaves",
        mutate: (source) =>
          pool.query("update memory_nodes set summary_model=null where id=$1", [
            source.leaf.nodeId
          ]),
        message: "LCM placeholder leaves cannot be shared authoritatively"
      },
      {
        representation: "lcm_rollups",
        mutate: (source) =>
          pool.query(
            `update memory_nodes
                set summary_structured_schema_version='future-summary-v2'
              where id=$1`,
            [source.rollup.nodeId]
          ),
        message:
          "Legacy or incomplete LCM rollups cannot be shared authoritatively"
      }
    ];

    for (const [index, testCase] of cases.entries()) {
      const fixture = await createWorkspaceFixture();
      const source = await createSource(fixture, 1, `derived-state-${index}`);
      await putOwnerPolicy(fixture, source);
      await testCase.mutate(source);
      await expect(
        createPersistedPreview(fixture, source, testCase.representation)
      ).rejects.toThrow(testCase.message);
      const persisted = await pool.query(
        `select representation from shared_source_artifacts
          where logical_memory_id=$1`,
        [source.logicalMemoryId]
      );
      expect(persisted.rows).toEqual([]);
    }
  });

  it("rejects stale LCM coverage when a newer synced event has no summary snapshot", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "complete-lcm");
    await putOwnerPolicy(fixture, source);
    const previousLeafId = source.leaf.nodeId;
    const previousRollupId = source.rollup.nodeId;

    source.originEventId = deterministicUuid(
      source.logicalMemoryId,
      "new-unsummarized-event"
    );
    await seedAuthoritativeSourceRevision(
      fixture,
      source,
      2,
      "missing-lcm-snapshot",
      { includeSummarySnapshot: false }
    );

    const activeEvents = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from sync_event_mappings
        where sync_relationship_id=$1 and active=true`,
      [source.syncRelationshipId]
    );
    expect(activeEvents.rows[0]?.count).toBe("2");
    expect(source.leaf.nodeId).toBe(previousLeafId);
    expect(source.rollup.nodeId).toBe(previousRollupId);

    await expect(
      createPersistedPreview(fixture, source, "lcm_leaves")
    ).rejects.toThrow(
      "LCM leaves do not cover the authoritative source revision"
    );
    await expect(
      createPersistedPreview(fixture, source, "lcm_rollups")
    ).rejects.toThrow(
      "LCM rollups do not cover the authoritative source revision"
    );
    const fallback = await pool.query(
      `select representation
         from shared_source_artifacts
        where logical_memory_id=$1`,
      [source.logicalMemoryId]
    );
    expect(fallback.rows).toEqual([]);
  });

  it("enforces the source-owner, Team, and Workspace fidelity intersection", async () => {
    const fixture = await createWorkspaceFixture({
      teamAllowed: ["lcm_leaves", "lcm_rollups"],
      workspaceAllowed: ["memory_events", "lcm_leaves"]
    });
    const source = await createSource(fixture);
    await putOwnerPolicy(fixture, source, ["lcm_leaves"]);
    await expect(
      createConsent(fixture, source, {
        representation: "memory_events",
        mode: "snapshot",
        representations: ["memory_events", "lcm_leaves"],
        label: "outside-intersection"
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    const leaves = await createConsent(fixture, source, {
      representation: "lcm_leaves",
      mode: "snapshot",
      representations: ["lcm_leaves"],
      label: "inside-intersection"
    });
    expect(leaves.consent.maximumFidelity).toBe("lcm_leaves");
  });

  it("audits representation policies and publishes committed Shared Memory outbox notifications", async () => {
    const listener = await pool.connect();
    try {
      await listener.query("listen koed_collaboration_realtime");
      const notification = new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Shared Memory notification timed out")),
            2_000
          );
          listener.once(
            "notification",
            (message: { payload?: string | null }) => {
              clearTimeout(timer);
              const parsed: unknown = JSON.parse(message.payload ?? "{}");
              resolve(parsed as Record<string, unknown>);
            }
          );
        }
      );

      const fixture = await createWorkspaceFixture();
      const grant = await createGrant(fixture, {
        representation: "memory_events",
        label: "audited-notification"
      });
      const payload = await notification;
      expect(payload).toMatchObject({
        scope: "team",
        teamId: fixture.teamId,
        family: "share_grant_lifecycle"
      });
      expect(Number(payload.cursor)).toBeGreaterThan(0);

      const audit = await pool.query<{
        action: string;
        actor_user_id: string;
        owner_user_id: string | null;
        target_table: string;
        metadata: Record<string, unknown>;
      }>(
        `select action,actor_user_id,owner_user_id,target_table,metadata
           from audit_events
          where actor_user_id=$1
            and (
              metadata->>'teamId'=$2
              or metadata->>'logicalMemoryId'=$3
            )
          order by action`,
        [fixture.ownerUserId, fixture.teamId, grant.logicalMemoryId]
      );
      expect(audit.rows).toHaveLength(3);
      const byAction = new Map(audit.rows.map((row) => [row.action, row]));
      const ownerAudit = byAction.get(
        "shared_memory.source_owner_policy.updated"
      );
      expect(ownerAudit?.owner_user_id).toBe(fixture.ownerUserId);
      expect(ownerAudit?.target_table).toBe(
        "source_owner_representation_policies"
      );
      expect(ownerAudit?.metadata).toMatchObject({
        scope: "source_owner",
        logicalMemoryId: grant.logicalMemoryId,
        version: 1,
        previousVersion: 0
      });
      expect(ownerAudit?.metadata).toMatchObject(
        fidelityConsent(allRepresentations)
      );

      const teamAudit = byAction.get("team.shared_memory_policy.updated");
      expect(teamAudit?.owner_user_id).toBeNull();
      expect(teamAudit?.target_table).toBe("team_representation_policies");
      expect(teamAudit?.metadata).toMatchObject({
        scope: "team",
        teamId: fixture.teamId,
        version: 1,
        previousVersion: 0
      });
      expect(teamAudit?.metadata).toMatchObject(
        fidelityConsent(allRepresentations)
      );

      const workspaceAudit = byAction.get(
        "team.workspace.shared_memory_policy.updated"
      );
      expect(workspaceAudit?.owner_user_id).toBeNull();
      expect(workspaceAudit?.target_table).toBe(
        "workspace_representation_policies"
      );
      expect(workspaceAudit?.metadata).toMatchObject({
        scope: "workspace",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        version: 1,
        previousVersion: 0
      });
      expect(workspaceAudit?.metadata).toMatchObject(
        fidelityConsent(allRepresentations)
      );
    } finally {
      listener.release();
    }
  });

  it("audits policy reduction, invalidates materialized events, and never falls back", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      representation: "memory_events",
      label: "policy-reduction"
    });
    await materialize(fixture, grant);
    const mutationId = randomUUID();
    const reduced = await repository.putTeamPolicy(
      actor(fixture.managerUserId),
      {
        mutationId,
        teamId: fixture.teamId,
        expectedCurrentVersion: 1,
        ...fidelityConsent(["lcm_leaves"])
      }
    );
    expect(reduced).toMatchObject({
      scope: "team",
      version: 2,
      maximumFidelity: "lcm_leaves",
      includeCuratedMemory: false
    });
    expect(
      await repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: "memory_events"
      })
    ).toBeNull();
    const states = await pool.query<{
      lifecycle: string;
      representation: string;
      state: string;
    }>(
      `select g.lifecycle,r.representation,r.state
         from team_memory_share_grants g
         join team_memory_representations r on r.share_grant_id=g.id
        where g.id=$1`,
      [grant.shareGrantId]
    );
    expect(states.rows).toEqual([
      {
        lifecycle: "unavailable",
        representation: "memory_events",
        state: "invalidated"
      }
    ]);
    const fallback = await pool.query(
      `select 1 from team_memory_representations
        where share_grant_id=$1 and representation='lcm_leaves'`,
      [grant.shareGrantId]
    );
    expect(fallback.rowCount).toBe(0);
    const audit = await pool.query<{
      metadata: Record<string, unknown>;
    }>(
      `select metadata from audit_events
        where action='team.shared_memory_policy.updated'
          and metadata->>'mutationId'=$1`,
      [mutationId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({
      teamId: fixture.teamId,
      version: 2,
      previousVersion: 1,
      ...fidelityConsent(["lcm_leaves"])
    });
    await expect(
      repository.putTeamPolicy(actor(fixture.managerUserId), {
        mutationId: randomUUID(),
        teamId: fixture.teamId,
        expectedCurrentVersion: 2,
        ...fidelityConsent(allRepresentations)
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);

    for (const scope of ["source_owner", "workspace"] as const) {
      const scopedFixture = await createWorkspaceFixture();
      const scopedGrant = await createGrant(scopedFixture, {
        representation: "memory_events",
        label: `${scope}-policy-reduction`
      });
      await materialize(scopedFixture, scopedGrant);
      const scopedMutationId = randomUUID();
      if (scope === "source_owner") {
        await repository.putSourceOwnerPolicy(
          actor(scopedFixture.ownerUserId),
          {
            mutationId: scopedMutationId,
            logicalMemoryId: scopedGrant.logicalMemoryId,
            expectedCurrentVersion: 1,
            ...fidelityConsent(["lcm_leaves"])
          }
        );
      } else {
        await repository.putWorkspacePolicy(
          actor(scopedFixture.managerUserId),
          {
            mutationId: scopedMutationId,
            teamId: scopedFixture.teamId,
            teamWorkspaceId: scopedFixture.teamWorkspaceId,
            expectedCurrentVersion: 1,
            ...fidelityConsent(["lcm_leaves"])
          }
        );
      }
      expect(
        await repository.readGrantRepresentation(
          actor(scopedFixture.readerUserId),
          {
            shareGrantId: scopedGrant.shareGrantId,
            representation: "memory_events"
          }
        )
      ).toBeNull();
      const scopedStates = await pool.query<{
        lifecycle: string;
        representation: string;
        state: string;
      }>(
        `select g.lifecycle,r.representation,r.state
           from team_memory_share_grants g
           join team_memory_representations r on r.share_grant_id=g.id
          where g.id=$1`,
        [scopedGrant.shareGrantId]
      );
      expect(scopedStates.rows).toEqual([
        {
          lifecycle: "unavailable",
          representation: "memory_events",
          state: "invalidated"
        }
      ]);
      const scopedFallback = await pool.query(
        `select 1 from team_memory_representations
          where share_grant_id=$1 and representation='lcm_leaves'`,
        [scopedGrant.shareGrantId]
      );
      expect(scopedFallback.rowCount).toBe(0);
      const scopedAudit = await pool.query<{
        action: string;
        metadata: Record<string, unknown>;
      }>(
        `select action,metadata from audit_events
          where metadata->>'mutationId'=$1`,
        [scopedMutationId]
      );
      expect(scopedAudit.rows).toHaveLength(1);
      expect(scopedAudit.rows[0]).toMatchObject({
        action:
          scope === "source_owner"
            ? "shared_memory.source_owner_policy.updated"
            : "team.workspace.shared_memory_policy.updated",
        metadata: {
          scope,
          version: 2,
          previousVersion: 1,
          ...fidelityConsent(["lcm_leaves"])
        }
      });
    }
  });

  it("allows exactly one concurrent representation-policy mutation from the same revision", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      representation: "memory_events",
      label: "concurrent-policy-mutation"
    });
    await materialize(fixture, grant);
    const mutationIds = [randomUUID(), randomUUID()] as const;
    const allowedSets: SharedMemoryRepresentation[][] = [
      ["memory_events", "lcm_leaves"],
      ["memory_events", "lcm_rollups"]
    ];

    const results = await Promise.allSettled(
      mutationIds.map((mutationId, index) =>
        repository.putTeamPolicy(actor(fixture.managerUserId), {
          mutationId,
          teamId: fixture.teamId,
          expectedCurrentVersion: 1,
          ...fidelityConsent(allowedSets[index]!)
        })
      )
    );
    const fulfilled = results.filter(
      (
        result
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<SharedMemoryRepository["putTeamPolicy"]>>
      > => result.status === "fulfilled"
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value).toMatchObject({ scope: "team", version: 2 });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(SharedMemoryConflictError);

    const policies = await pool.query<{
      version: number;
      policy_hash: string;
      superseded_at: Date | null;
    }>(
      `select version,policy_hash,superseded_at
         from team_representation_policies
        where team_id=$1
        order by version`,
      [fixture.teamId]
    );
    expect(policies.rows).toHaveLength(2);
    expect(policies.rows.filter((policy) => policy.version === 2)).toEqual([
      expect.objectContaining({
        policy_hash: fulfilled[0]!.value.policyHash,
        superseded_at: null
      })
    ]);

    const committedEffects = await pool.query<{
      policy_audits: string;
      representation_events: string;
    }>(
      `select
         (select count(*) from audit_events
           where action='team.shared_memory_policy.updated'
             and metadata->>'mutationId'=any($1::text[]))::text as policy_audits,
         (select count(*) from collaboration_outbox
           where family='fidelity_changed'
             and share_grant_id=$2)::text as representation_events`,
      [mutationIds, grant.shareGrantId]
    );
    expect(committedEffects.rows[0]).toEqual({
      policy_audits: "1",
      representation_events: "1"
    });
  });

  it("changes the cumulative fidelity ceiling only for the source owner", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      representation: "lcm_leaves",
      ownerAllowed: ["lcm_leaves", "lcm_rollups"],
      mode: "continuous",
      label: "initial-leaves"
    });
    await materialize(fixture, grant, { label: "initial-leaves" });
    const preview = await createPersistedPreview(
      fixture,
      grant,
      "lcm_rollups",
      grant.currentRevision,
      "replacement-rollup",
      ["lcm_rollups"]
    );
    const consentId = randomUUID();
    const replacementInput = {
      consent: {
        ...reviewedSourceBinding(preview),
        consentId,
        preview,
        mode: "continuous" as const,
        maximumFidelity: "lcm_rollups" as const,
        includeCuratedMemory: false,
        authority: authority(fixture)
      },
      fidelity: {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId,
        maximumFidelity: "lcm_rollups" as const,
        includeCuratedMemory: false,
        expectedGrantVersion: grant.grantVersion,
        authority: authority(fixture)
      },
      expected: {
        consentId,
        logicalMemoryId: grant.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        previewId: preview.previewId,
        previewRevision: preview.previewRevision,
        previewHash: preview.previewHash,
        maximumFidelity: "lcm_rollups" as const,
        includeCuratedMemory: false
      }
    };
    await expect(
      repository.changeFidelityBundle(actor(fixture.managerUserId), {
        ...replacementInput,
        consent: {
          ...replacementInput.consent,
          authority: authority(fixture, "manager")
        },
        fidelity: {
          ...replacementInput.fidelity,
          authority: authority(fixture, "manager")
        }
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);

    const changed = await repository.changeFidelityBundle(
      actor(fixture.ownerUserId),
      replacementInput
    );
    expect(changed?.grant).toMatchObject({
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false,
      consentId,
      grantVersion: grant.grantVersion + 1
    });
    const states = await pool.query<{
      representation: SharedMemoryRepresentation;
      state: string;
    }>(
      `select representation, state from team_memory_representations
       where share_grant_id = $1
       order by representation`,
      [grant.shareGrantId]
    );
    expect(states.rows).toEqual([
      { representation: "lcm_leaves", state: "invalidated" },
      { representation: "lcm_rollups", state: "available" }
    ]);
    expect(
      await repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: "lcm_leaves"
      })
    ).toBeNull();
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: "lcm_rollups"
      })
    ).resolves.toMatchObject({
      representation: { representation: "lcm_rollups", state: "available" }
    });
  });

  it("pins snapshot consent and advances continuous consent by source revision", async () => {
    const fixture = await createWorkspaceFixture();
    const snapshot = await createGrant(fixture, {
      mode: "snapshot",
      sourceRevision: 2,
      label: "snapshot"
    });
    const snapshotRepresentation = await materialize(fixture, snapshot, {
      label: "snapshot"
    });
    expect(snapshotRepresentation.sourceRevision).toBe(2);
    await expect(
      materialize(fixture, snapshot, {
        sourceRevision: 3,
        label: "snapshot-next"
      })
    ).rejects.toThrow(
      "Snapshot consent requires the exact consented source revision"
    );

    const continuous = await createGrant(fixture, {
      mode: "continuous",
      sourceRevision: 2,
      label: "continuous"
    });
    await materialize(fixture, continuous, { label: "continuous" });
    const future = await materializeWithPreview(fixture, continuous, {
      sourceRevision: 4,
      label: "continuous-next"
    });
    expect(future.representation.sourceRevision).toBe(4);
    const rows = await pool.query<{ source_revision: string; state: string }>(
      `select source_revision::text, state
       from team_memory_representations
       where share_grant_id = $1 order by source_revision`,
      [continuous.shareGrantId]
    );
    expect(rows.rows).toEqual([
      { source_revision: "2", state: "available" },
      { source_revision: "4", state: "available" }
    ]);
    const read = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      {
        shareGrantId: continuous.shareGrantId,
        representation: continuous.representation
      }
    );
    expect(read?.representation.sourceRevision).toBe(4);
    expect(read?.items.map((item) => item.content)).toEqual(
      future.preview.items.map((item) => item.content)
    );
  });

  it("automatically advances only active continuous grants after target sync", async () => {
    const fixture = await createWorkspaceFixture();
    const continuous = await createGrant(fixture, {
      mode: "continuous",
      label: "continuous-initial"
    });
    await materialize(fixture, continuous);
    await seedAuthoritativeSourceRevision(
      fixture,
      continuous,
      2,
      "continuous-refreshed"
    );

    await expect(
      repository.advanceContinuousGrantRepresentations({
        remoteReplicaId: continuous.remoteReplicaId,
        sourceRevision: 2
      })
    ).resolves.toEqual({ advanced: 3 });
    await flushSanitizedSemanticPublication();
    await expect(
      repository.advanceContinuousGrantRepresentations({
        remoteReplicaId: continuous.remoteReplicaId,
        sourceRevision: 2
      })
    ).resolves.toEqual({ advanced: 0 });

    const continuousRead = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      {
        shareGrantId: continuous.shareGrantId,
        representation: continuous.representation
      }
    );
    expect(continuousRead).toMatchObject({
      freshness: "fresh",
      representation: { sourceRevision: 2 }
    });
    expect(JSON.stringify(continuousRead?.items)).toContain(
      "continuous-refreshed"
    );
    for (const representation of allRepresentations) {
      await expect(
        repository.readGrantRepresentation(actor(fixture.readerUserId), {
          shareGrantId: continuous.shareGrantId,
          representation
        })
      ).resolves.toMatchObject({
        freshness: "fresh",
        representation: { representation, sourceRevision: 2 }
      });
    }

    const snapshot = await createGrant(fixture, {
      mode: "snapshot",
      label: "snapshot-initial"
    });
    await materialize(fixture, snapshot);

    await seedAuthoritativeSourceRevision(
      fixture,
      snapshot,
      2,
      "snapshot-not-propagated"
    );
    await expect(
      repository.advanceContinuousGrantRepresentations({
        remoteReplicaId: snapshot.remoteReplicaId,
        sourceRevision: 2
      })
    ).resolves.toEqual({ advanced: 0 });
    const snapshotRead = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      {
        shareGrantId: snapshot.shareGrantId,
        representation: snapshot.representation
      }
    );
    expect(snapshotRead?.representation.sourceRevision).toBe(1);
    expect(JSON.stringify(snapshotRead?.items)).not.toContain(
      "snapshot-not-propagated"
    );
  });

  it("keeps only the last authorized revision stale after sync revocation and blocks future propagation", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      mode: "continuous",
      label: "authorized-revision-one"
    });
    await materialize(fixture, grant);

    await seedAuthoritativeSourceRevision(
      fixture,
      grant,
      2,
      "authorized-revision-two"
    );
    const laggingRead = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      {
        shareGrantId: grant.shareGrantId,
        representation: grant.representation
      }
    );
    expect(laggingRead).toMatchObject({
      freshness: "stale",
      representation: { sourceRevision: 1 }
    });
    expect(JSON.stringify(laggingRead?.items)).toContain(
      "authorized-revision-one"
    );
    expect(JSON.stringify(laggingRead?.items)).not.toContain(
      "authorized-revision-two"
    );
    await expect(
      repository.listWorkspaceGrants(actor(fixture.readerUserId), {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        limit: 10,
        offset: 0
      })
    ).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          maximumFidelity: "memory_events",
          includeCuratedMemory: false,
          lifecycle: "active"
        })
      ]
    });

    const latest = await materializeWithPreview(fixture, grant, {
      sourceRevision: 2,
      label: "authorized-revision-two"
    });
    expect(latest.representation.sourceRevision).toBe(2);
    const revokedSync =
      await syncRepository.revokeCrossIdentitySyncRelationship(
        {
          userId: fixture.ownerUserId,
          deviceCredentialId: fixture.deviceCredentialId
        },
        {
          syncRelationshipId: grant.syncRelationshipId,
          reason: "owner_disconnected_sync"
        }
      );
    expect(revokedSync).toMatchObject({ state: "revoked", sourceCursor: 2 });

    const stale = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      {
        shareGrantId: grant.shareGrantId,
        representation: grant.representation
      }
    );
    expect(stale).toMatchObject({
      freshness: "stale",
      representation: { sourceRevision: 2 }
    });
    expect(JSON.stringify(stale?.items)).toContain("authorized-revision-two");

    const beforeRejectedRevision = await pool.query<{
      event_count: string;
      active_cursor: string;
    }>(
      `select
         (select count(*) from sync_event_mappings
           where sync_relationship_id=$1)::text as event_count,
         (select target_processing_cursor::text
            from cross_identity_sync_relationships where id=$1) as active_cursor`,
      [grant.syncRelationshipId]
    );
    await expect(
      seedAuthoritativeSourceRevision(fixture, grant, 3, "must-never-propagate")
    ).rejects.toBeInstanceOf(SyncStateConflictError);
    const afterRejectedRevision = await pool.query<{
      event_count: string;
      active_cursor: string;
      leaked: string;
    }>(
      `select
         (select count(*) from sync_event_mappings
           where sync_relationship_id=$1)::text as event_count,
         (select target_processing_cursor::text
            from cross_identity_sync_relationships where id=$1) as active_cursor,
         (select count(*) from conversation_items
           where metadata::text like '%must-never-propagate%')::text as leaked`,
      [grant.syncRelationshipId]
    );
    expect(afterRejectedRevision.rows[0]).toMatchObject({
      ...beforeRejectedRevision.rows[0],
      leaked: "0"
    });

    const revokedGrant = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion,
        reasonCode: "owner_revoked_share",
        authority: authority(fixture)
      }
    );
    expect(revokedGrant.lifecycle).toBe("revoked");
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: grant.representation
      })
    ).resolves.toBeNull();
  });

  it("restarts at the persisted cursor without duplicate revisions or skipped source items", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 2, "cursor-before-restart");
    expect(source.lastSyncPackage).not.toBeNull();
    expect(source.lastUploadSessionId).not.toBeNull();
    const beforeRestart = await pool.query<Record<string, string>>(
      `select
         (select count(*) from sync_event_mappings
           where sync_relationship_id=$1)::text as event_mappings,
         (select count(*) from sync_summary_node_mappings
           where sync_relationship_id=$1)::text as summary_mappings,
         (select count(*) from memory_events
           where idempotency_key like $2)::text as memory_events,
         (select count(*) from conversation_items
           where idempotency_key like $3)::text as conversation_items`,
      [
        source.syncRelationshipId,
        `sync:${source.syncRelationshipId}:event:%`,
        `sync:${source.syncRelationshipId}:item:%`
      ]
    );

    syncRepository = createCrossIdentitySyncRepository(pool, {
      ownerPrivateReplicaEnvelopeEncryptionProvider: ownerProvider
    });
    const replay = await syncRepository.applyCapturedSessionSyncPackage({
      relationshipId: source.syncRelationshipId,
      uploadSessionId: source.lastUploadSessionId!,
      package: source.lastSyncPackage!
    });
    expect(replay.eventIds).toEqual([source.seededEvents[0]!.eventId]);
    expect(new Set(replay.summaryNodeIds)).toEqual(
      new Set([source.leaf.nodeId, source.rollup.nodeId])
    );
    const afterRestart = await pool.query<Record<string, string>>(
      `select
         (select count(*) from sync_event_mappings
           where sync_relationship_id=$1)::text as event_mappings,
         (select count(*) from sync_summary_node_mappings
           where sync_relationship_id=$1)::text as summary_mappings,
         (select count(*) from memory_events
           where idempotency_key like $2)::text as memory_events,
         (select count(*) from conversation_items
           where idempotency_key like $3)::text as conversation_items`,
      [
        source.syncRelationshipId,
        `sync:${source.syncRelationshipId}:event:%`,
        `sync:${source.syncRelationshipId}:item:%`
      ]
    );
    expect(afterRestart.rows[0]).toEqual(beforeRestart.rows[0]);

    await seedAuthoritativeSourceRevision(
      fixture,
      source,
      3,
      "cursor-after-restart"
    );
    await putOwnerPolicy(fixture, source);
    const preview = await createPersistedPreview(
      fixture,
      source,
      "memory_events"
    );
    expect(preview.sourceRevision).toBe(3);
    expect(preview.items.map((item) => item.content)).toEqual([
      { text: "cursor-after-restart user source" },
      { text: "cursor-after-restart assistant source" }
    ]);
    const persistedCursor = await pool.query<{
      target_processing_cursor: string;
      package_sequence: string;
      mapping_count: string;
      active_mapping_count: string;
      active_mapping_cursor: string;
    }>(
      `select relationship.target_processing_cursor::text,
              relationship.package_sequence::text,
              (select count(*) from sync_event_mappings
                where sync_relationship_id=relationship.id)::text as mapping_count,
              (select count(*) from sync_event_mappings
                where sync_relationship_id=relationship.id and active=true)::text
                as active_mapping_count,
              (select source_cursor::text from sync_event_mappings
                where sync_relationship_id=relationship.id and active=true)
                as active_mapping_cursor
         from cross_identity_sync_relationships relationship
        where relationship.id=$1`,
      [source.syncRelationshipId]
    );
    expect(persistedCursor.rows[0]).toEqual({
      target_processing_cursor: "3",
      package_sequence: "2",
      mapping_count: "2",
      active_mapping_count: "1",
      active_mapping_cursor: "3"
    });
  });

  it("lists and reads active Memory Event, leaf, and rollup timelines from encrypted storage", async () => {
    const fixture = await createWorkspaceFixture();
    const lexicalAnchorSentinel = "TEAM_PROTECTED_LEXICAL_ANCHOR_7f3c9d21";
    const labelFor = (representation: SharedMemoryRepresentation) =>
      representation === "lcm_rollups"
        ? lexicalAnchorSentinel
        : `timeline-${representation}`;
    const grants = await Promise.all(
      allRepresentations.map((representation) =>
        createGrant(fixture, {
          representation,
          ownerAllowed:
            representation === "memory_events"
              ? allRepresentations
              : representation === "lcm_leaves"
                ? ["lcm_leaves", "lcm_rollups"]
                : ["lcm_rollups"],
          label: labelFor(representation)
        })
      )
    );
    for (const grant of grants) {
      await materialize(fixture, grant, {
        label: labelFor(grant.representation)
      });
    }
    const index = await repository.listWorkspaceGrants(
      actor(fixture.readerUserId),
      {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        limit: 10,
        offset: 0
      }
    );
    expect(index.hasMore).toBe(false);
    expect(index.entries).toHaveLength(3);
    expect(
      new Set(index.entries.map((entry) => entry.maximumFidelity))
    ).toEqual(new Set(allRepresentations));

    const ownerDecryptsBeforeReads = ownerDecryptSpy.mock.calls.length;
    for (const grant of grants) {
      const read = await repository.readGrantRepresentation(
        actor(fixture.readerUserId),
        {
          shareGrantId: grant.shareGrantId,
          representation: grant.representation
        }
      );
      expect(read).toMatchObject({
        freshness: "fresh",
        representation: {
          representation: grant.representation,
          state: "available",
          sourceRevision: grant.currentRevision
        },
        companionScope: {
          kind: "shared_session_discussion",
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          logicalMemoryId: grant.logicalMemoryId,
          shareGrantId: grant.shareGrantId
        }
      });
      expect(read?.items.map((item) => item.itemType)).toEqual(
        grant.preview.items.map((item) => item.itemType)
      );
      expect(read?.items.map((item) => item.occurredAt)).toEqual(
        grant.preview.items.map((item) => item.occurredAt)
      );
      if (grant.representation === "lcm_rollups") {
        expect(read?.items[0]?.content.lexicalAnchors).toEqual([
          lexicalAnchorSentinel
        ]);
      }
      expect(read?.sourcePage).toEqual({
        itemOffset: 0,
        itemCount: grant.preview.items.length
      });
      const newest = await repository.readGrantRepresentation(
        actor(fixture.readerUserId),
        {
          shareGrantId: grant.shareGrantId,
          representation: grant.representation,
          page: { direction: "older", limit: 1 }
        }
      );
      expect(newest?.sourcePage).toEqual({
        itemOffset: grant.preview.items.length - 1,
        itemCount: grant.preview.items.length
      });
      expect(newest?.items.map((item) => item.itemType)).toEqual([
        grant.preview.items.at(-1)!.itemType
      ]);
    }
    expect(ownerDecryptSpy).toHaveBeenCalledTimes(ownerDecryptsBeforeReads);
    const stored = await pool.query<{
      id: string;
      share_grant_id: string;
      stored: string;
      ciphertext: string;
      aad: Record<string, string>;
    }>(
      `select c.id, c.share_grant_id, row_to_json(c)::text as stored,
              c.ciphertext, c.aad
       from team_memory_representation_chunks c
       where c.share_grant_id = any($1::uuid[])`,
      [grants.map((grant) => grant.shareGrantId)]
    );
    expect(stored.rows).toHaveLength(3);
    for (const row of stored.rows) {
      expect(row.stored).not.toContain("timeline-");
      expect(row.stored).not.toContain(lexicalAnchorSentinel);
      expect(row.ciphertext).not.toContain("source summary");
      expect(row.ciphertext).not.toContain("assistant source");
      expect(row.aad.chunkFormatVersion).toBe("1");
    }

    const rollupGrant = grants.find(
      (grant) => grant.representation === "lcm_rollups"
    )!;
    const decryptsBeforePendingClaim = decryptSpy.mock.calls.length;
    const semanticItems = await repository.listPendingSharedMemorySemanticItems(
      {
        limit: 100
      }
    );
    const claimedChunkCount = await pool.query<{ count: number }>(
      `select count(distinct (representation_id,encrypted_chunk_index))::integer as count
         from team_memory_semantic_items
        where id=any($1::uuid[])`,
      [semanticItems.map((item) => item.semanticItemId)]
    );
    expect(decryptSpy.mock.calls.length - decryptsBeforePendingClaim).toBe(
      claimedChunkCount.rows[0]!.count * 2
    );
    expect(
      semanticItems.find(
        (item) => item.shareGrantId === rollupGrant.shareGrantId
      )?.text
    ).toContain(lexicalAnchorSentinel);
    const plaintextRoutingRows = await pool.query<{ payload: string }>(
      `select row_to_json(smi)::text as payload
         from team_memory_semantic_items smi
        where smi.share_grant_id=$1
       union all
       select row_to_json(preview)::text
         from shared_source_previews preview
         join team_memory_representations representation
           on representation.source_preview_id=preview.id
        where representation.share_grant_id=$1
       union all
       select row_to_json(artifact)::text
         from shared_source_artifacts artifact
         join team_memory_representations representation
           on representation.source_artifact_id=artifact.id
        where representation.share_grant_id=$1
       union all
       select row_to_json(node)::text
         from memory_nodes node
        where node.id=$2
       union all
       select row_to_json(encrypted)::text
         from encrypted_field_payloads encrypted
        where encrypted.source_table='memory_nodes'
          and encrypted.source_id=$2`,
      [rollupGrant.shareGrantId, rollupGrant.rollup.nodeId]
    );
    expect(JSON.stringify(plaintextRoutingRows.rows)).not.toContain(
      lexicalAnchorSentinel
    );
    const opaqueSemanticRows = await pool.query<{
      content_hash: string;
      pseudonymous_source_id: string;
    }>(
      `select content_hash,pseudonymous_source_id
         from team_memory_semantic_items
        where share_grant_id=$1
        order by source_item_index`,
      [rollupGrant.shareGrantId]
    );
    expect(opaqueSemanticRows.rows).toHaveLength(
      rollupGrant.preview.items.length
    );
    for (const [index, row] of opaqueSemanticRows.rows.entries()) {
      const canonicalItem = rollupGrant.preview.items[index]!;
      expect(row.content_hash).not.toBe(crossIdentitySyncDigest(canonicalItem));
      expect(row.pseudonymous_source_id).not.toBe(canonicalItem.sourceId);
    }

    const semanticModel = "scope-test-model";
    const semanticVersion = "team-semantic-v1:scope-test";
    const queryVector = [1, ...Array.from({ length: 383 }, () => 0)];
    for (const item of semanticItems) {
      // Keep the rollup in the initial global pool deterministically. Equal
      // scores used random candidate IDs to break ties, making pool overlap
      // (and therefore the exact deduplicated count) depend on UUID ordering.
      const similarity =
        item.shareGrantId === rollupGrant.shareGrantId ? 1 : 0.999;
      await repository.storeSharedMemorySemanticEmbedding({
        semanticItemId: item.semanticItemId,
        contentHash: item.contentHash,
        model: semanticModel,
        dimensions: 384,
        version: semanticVersion,
        vector: [
          similarity,
          Math.sqrt(1 - similarity * similarity),
          ...Array.from({ length: 382 }, () => 0)
        ]
      });
    }
    const decryptsBeforeScoreScan = decryptSpy.mock.calls.length;
    const scoreScan = await repository.scanAuthorizedSharedMemorySemanticItems(
      actor(fixture.readerUserId),
      {
        teamWorkspaceId: fixture.teamWorkspaceId,
        queryVector,
        model: semanticModel,
        dimensions: 384,
        version: semanticVersion,
        limit: 1,
        searchDomain: "global"
      }
    );
    expect(decryptSpy.mock.calls.length).toBe(decryptsBeforeScoreScan);
    expect(scoreScan.map((scan) => scan.representation).sort()).toEqual([
      "lcm_leaves",
      "lcm_rollups",
      "memory_events"
    ]);
    expect(scoreScan.every((scan) => scan.candidateCount === 1)).toBe(true);
    const baselineCandidates =
      await repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          queryVector,
          model: semanticModel,
          dimensions: 384,
          version: semanticVersion,
          limit: 50,
          searchDomain: "global"
        }
      );
    const independentlyHinted =
      await repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          queryVector,
          model: semanticModel,
          dimensions: 384,
          version: semanticVersion,
          limit: 50,
          searchDomain: "global",
          exactHints: [
            lexicalAnchorSentinel,
            "timeline-lcm_leaves synthesized source summary"
          ]
        }
      );
    expect(
      independentlyHinted.map((candidate) => candidate.candidateId).sort()
    ).toEqual(
      baselineCandidates.map((candidate) => candidate.candidateId).sort()
    );
    expect(
      independentlyHinted.find(
        (candidate) => candidate.representation === "lcm_rollups"
      )?.exactAnchorMatches
    ).toEqual([lexicalAnchorSentinel]);
    expect(
      independentlyHinted.find(
        (candidate) => candidate.representation === "lcm_leaves"
      )?.exactAnchorMatches
    ).toEqual(["timeline-lcm_leaves synthesized source summary"]);
    expect(
      independentlyHinted.find(
        (candidate) => candidate.representation === "memory_events"
      )?.exactAnchorMatches
    ).toBeUndefined();
    const rollupCandidate = independentlyHinted.find(
      (candidate) => candidate.representation === "lcm_rollups"
    )!;
    const rollupExpansion =
      await repository.expandAuthorizedSharedMemorySemanticItem(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          candidateId: rollupCandidate.candidateId,
          searchDomain: "global"
        }
      );
    expect(rollupExpansion?.parent.candidateId).toBe(
      rollupCandidate.candidateId
    );
    expect(rollupExpansion?.items.map((item) => item.itemType)).toEqual([
      "lcm_leaf"
    ]);
    expect(
      rollupExpansion?.items.every(
        (item) => item.candidateId !== rollupCandidate.candidateId
      )
    ).toBe(true);

    const leafCandidate = independentlyHinted.find(
      (candidate) => candidate.representation === "lcm_leaves"
    )!;
    const leafExpansion =
      await repository.expandAuthorizedSharedMemorySemanticItem(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          candidateId: leafCandidate.candidateId,
          searchDomain: "global"
        }
      );
    expect(leafExpansion?.items.length).toBeGreaterThan(0);
    expect(
      leafExpansion?.items.every((item) =>
        [
          "user_message",
          "assistant_message",
          "thought",
          "tool_call",
          "tool_result"
        ].includes(item.itemType)
      )
    ).toBe(true);
    const leafGrant = grants.find(
      (grant) => grant.representation === "lcm_leaves"
    )!;
    await pool.query(
      `update sessions
          set personal_deleted_at=now(),
              personal_deleted_by_user_id=$2,
              personal_deletion_reason='retained_team_semantic_test'
        where id=$1`,
      [leafGrant.sessionId, fixture.ownerUserId]
    );
    const retainedLeafCandidates =
      await repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          queryVector,
          model: semanticModel,
          dimensions: 384,
          version: semanticVersion,
          limit: 50,
          searchDomain: "global",
          representations: ["lcm_leaves"]
        }
      );
    expect(
      retainedLeafCandidates.some(
        (candidate) => candidate.shareGrantId === leafGrant.shareGrantId
      )
    ).toBe(true);
    const retainedLeafExpansion =
      await repository.expandAuthorizedSharedMemorySemanticItem(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          candidateId: retainedLeafCandidates[0]!.candidateId,
          searchDomain: "global"
        }
      );
    expect(retainedLeafExpansion?.parent.shareGrantId).toBe(
      leafGrant.shareGrantId
    );
    expect(retainedLeafExpansion?.items.length).toBeGreaterThan(0);
    const sessionScoped =
      await repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          queryVector,
          model: semanticModel,
          dimensions: 384,
          version: semanticVersion,
          limit: 50,
          searchDomain: "session",
          sessionId: rollupGrant.sessionId
        }
      );
    expect(sessionScoped.length).toBeGreaterThan(0);
    expect(new Set(sessionScoped.map((item) => item.shareGrantId))).toEqual(
      new Set([rollupGrant.shareGrantId])
    );

    const fingerprint = `gr_scope_${randomUUID()}`;
    const projectId = `repository:${JSON.stringify({ kind: "portable_repository", key: fingerprint, device: null })}`;
    await pool.query(
      "update team_memory_share_grants set repository_snapshot=$2::jsonb where id=$1",
      [
        rollupGrant.shareGrantId,
        JSON.stringify({
          version: 1,
          classification: "portable_repository",
          fingerprint,
          label: "Scope test project",
          branchObservation: null
        })
      ]
    );
    // A later Personal move cannot retarget an existing Team representation.
    await pool.query(
      "update sessions set automatic_project_id='different-personal-project',automatic_project_name='Different Personal Project',automatic_project_detected_at=now() where id=$1",
      [rollupGrant.sessionId]
    );
    const projectScoped =
      await repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          queryVector,
          model: semanticModel,
          dimensions: 384,
          version: semanticVersion,
          limit: 50,
          searchDomain: "project",
          projectId
        }
      );
    expect(projectScoped.length).toBeGreaterThan(0);
    expect(new Set(projectScoped.map((item) => item.shareGrantId))).toEqual(
      new Set([rollupGrant.shareGrantId])
    );
    const globalContext = {
      kind: "portable_repository" as const,
      key: fingerprint,
      root: "/another-clone",
      branch: "main",
      reason: "origin" as const,
      checkoutId: null,
      originatingDeviceId: "teammate-device",
      selectedRemote: "origin",
      anchorDisplay: null
    };
    const contextualInput = {
      teamWorkspaceId: fixture.teamWorkspaceId,
      queryVector,
      model: semanticModel,
      dimensions: 384 as const,
      version: semanticVersion,
      limit: 4,
      searchDomain: "global" as const,
      strictLimit: true,
      repositoryContext: globalContext,
      maxSearchPasses: 2 as const
    };
    const contextual =
      await repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        contextualInput
      );
    expect(contextual).toHaveLength(3);
    expect(new Set(contextual.map((item) => item.candidateId)).size).toBe(3);
    expect(contextual[0]).toMatchObject({
      shareGrantId: rollupGrant.shareGrantId,
      project: {
        classification: "current",
        label: "Scope test project",
        branch: null
      },
      repositoryPreference: { repository: 0.04, branch: 0 }
    });
    expect(
      contextual
        .filter((item) => item.shareGrantId !== rollupGrant.shareGrantId)
        .every((item) => item.project?.classification === "unknown")
    ).toBe(true);
    const onePass = await repository.searchAuthorizedSharedMemorySemanticItems(
      actor(fixture.readerUserId),
      { ...contextualInput, maxSearchPasses: 1 }
    );
    expect(contextual[0]!.score).toBe(
      onePass.find((item) => item.candidateId === contextual[0]!.candidateId)!
        .score
    );
    const rollupItem = semanticItems.find(
      (item) => item.semanticItemId === contextual[0]!.candidateId
    )!;
    // Change only this disposable test's synthetic semantic vectors; embedding
    // publication is idempotent and intentionally cannot overwrite an embedding.
    const setRollupRelevance = (similarity: number) =>
      pool.query(
        "update team_memory_semantic_vectors_384 set embedding=$2::vector where semantic_item_id=$1",
        [
          rollupItem.semanticItemId,
          JSON.stringify([
            similarity,
            Math.sqrt(1 - similarity * similarity),
            ...Array.from({ length: 382 }, () => 0)
          ])
        ]
      );
    await setRollupRelevance(0.98);
    const recovered =
      await repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        { ...contextualInput, limit: 2 }
      );
    expect(recovered[0]).toMatchObject({
      shareGrantId: rollupGrant.shareGrantId
    });
    const baselineLimited =
      await repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        {
          ...contextualInput,
          limit: 2,
          repositoryContext: null,
          maxSearchPasses: 1
        }
      );
    expect(
      baselineLimited.some(
        (item) => item.shareGrantId === rollupGrant.shareGrantId
      )
    ).toBe(false);
    await setRollupRelevance(0.8);
    const betterOther =
      await repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        { ...contextualInput, limit: 2 }
      );
    expect(betterOther[0]!.shareGrantId).not.toBe(rollupGrant.shareGrantId);
    await setRollupRelevance(1);
    await expect(
      repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        { ...contextualInput, recentDays: 1 }
      )
    ).resolves.toEqual([]);
    await expect(
      repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          queryVector,
          model: semanticModel,
          dimensions: 384,
          version: semanticVersion,
          limit: 50,
          searchDomain: "global",
          recentDays: 1
        }
      )
    ).resolves.toEqual([]);
    await expect(
      repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          queryVector,
          model: semanticModel,
          dimensions: 384,
          version: semanticVersion,
          limit: 50,
          searchDomain: "global",
          sourceAfter: "2026-02-01T00:00:00.000Z"
        }
      )
    ).resolves.toEqual([]);
    await expect(
      repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          queryVector,
          model: semanticModel,
          dimensions: 384,
          version: semanticVersion,
          limit: 50,
          searchDomain: "global",
          sourceBefore: "2025-12-01T00:00:00.000Z"
        }
      )
    ).resolves.toEqual([]);
    const anotherGrantCandidate = semanticItems.find(
      (item) => item.shareGrantId !== rollupGrant.shareGrantId
    )!;
    await expect(
      repository.expandAuthorizedSharedMemorySemanticItem(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          candidateId: anotherGrantCandidate.semanticItemId,
          searchDomain: "session",
          sessionId: rollupGrant.sessionId
        }
      )
    ).resolves.toBeNull();
    const decryptsBeforePrivateCandidate = decryptCount();
    await expect(
      repository.expandAuthorizedSharedMemorySemanticItem(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          candidateId: rollupGrant.rollup.nodeId,
          searchDomain: "global"
        }
      )
    ).resolves.toBeNull();
    expect(decryptCount()).toBe(decryptsBeforePrivateCandidate);

    await pool.query(
      `update team_memory_representation_chunks
          set aad=jsonb_set(aad, '{chunkFormatVersion}', '"2"'::jsonb)
        where id=$1`,
      [stored.rows[0]!.id]
    );
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: stored.rows[0]!.share_grant_id,
        representation: "memory_events"
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
  });

  it.each([
    "workspace_disabled",
    "read_only",
    "sharing_disabled",
    "membership_disabled",
    "owner_disabled"
  ])(
    "embeds retained Team content without Personal reuse after %s",
    async (change) => {
      const fixture = await createWorkspaceFixture();
      const grant = await createGrant(fixture, { label: `retained-${change}` });
      await materialize(fixture, grant);
      const model = "retained-reuse-model";
      const version = teamSemanticEmbeddingGeneration({
        model,
        tokenizer: "test",
        inputTransform: "test",
        pooling: "last",
        normalization: "l2"
      });
      const text = composeSharedMemorySemanticText(grant.preview.items[0]!);
      const personal = await pool.query<{ id: string }>(
        `insert into memory_embeddings (
          memory_event_id,owner_user_id,visibility,embedding_model,embedding_dimensions,
          embedding_version,source_hash,source_text,embedding_source_content_hash,
          embedding_input_hash,tokenizer,input_transform,pooling,normalization
        ) values ($1,$2,'personal',$3,384,$4,$5,$6,$5,$5,'test','test','last','l2') returning id`,
        [
          grant.seededEvents[0]!.eventId,
          fixture.ownerUserId,
          model,
          version,
          hash(text),
          text
        ]
      );
      const vector = [1, ...Array.from({ length: 383 }, () => 0)];
      await pool.query(
        `insert into memory_embeddings_384 (memory_embedding_id,embedding) values ($1,$2::vector)`,
        [personal.rows[0]!.id, JSON.stringify(vector)]
      );
      // Prove this exact Personal artifact was eligible before access changed.
      const active = await repository.listPendingSharedMemorySemanticItems({
        model,
        dimensions: 384,
        version
      });
      expect(
        active.find((item) => item.shareGrantId === grant.shareGrantId)
          ?.personalEmbeddingReuse?.memoryEmbeddingId
      ).toBe(personal.rows[0]!.id);
      if (change === "owner_disabled") {
        await pool.query(`update users set disabled_at=now() where id=$1`, [
          fixture.ownerUserId
        ]);
      } else if (change === "membership_disabled") {
        await pool.query(
          `update team_memberships set status='disabled',disabled_at=now() where team_id=$1 and user_id=$2`,
          [fixture.teamId, fixture.ownerUserId]
        );
      } else {
        const mutation =
          change === "workspace_disabled"
            ? "disabled_at=now()"
            : change === "read_only"
              ? "access='read',can_share_owned_memory=false"
              : "can_share_owned_memory=false";
        await pool.query(
          `update team_workspace_access_grants set ${mutation} where team_workspace_id=$1 and user_id=$2`,
          [fixture.teamWorkspaceId, fixture.ownerUserId]
        );
      }
      const personalKey = vi.fn(() => privacyProvider);
      const retainedRepository = createSharedMemoryRepository(pool, {
        resolvePersonalEncryptionProvider: personalKey,
        resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider,
        resolveTeamEncryptionProvider: () => provider
      });
      const activeItem = active.find(
        (item) => item.shareGrantId === grant.shareGrantId
      )!;
      // A queued reuse hint must also fail after the permission change.
      await expect(
        retainedRepository.reusePersonalSharedMemorySemanticEmbedding({
          semanticItemId: activeItem.semanticItemId,
          contentHash: activeItem.contentHash,
          ...activeItem.personalEmbeddingReuse!
        })
      ).resolves.toBe(false);
      await pool.query(
        `update team_memory_semantic_items set embedding_state='pending' where share_grant_id=$1`,
        [grant.shareGrantId]
      );
      let handedOff = false;
      const pending =
        await retainedRepository.listPendingSharedMemorySemanticItems({
          model,
          dimensions: 384,
          version,
          duringAuthorizedLease: async (items) => {
            const retained = items.find(
              (item) =>
                item.shareGrantId === grant.shareGrantId &&
                item.sourceItemIndex === 0
            );
            if (!retained) return;
            expect(retained.text).toBe(text);
            expect(retained.personalEmbeddingReuse).toBeNull();
            handedOff = true;
          }
        });
      expect(handedOff).toBe(true);
      expect(personalKey).not.toHaveBeenCalled();
      const item = pending.find(
        (item) => item.shareGrantId === grant.shareGrantId
      )!;
      await expect(
        retainedRepository.storeSharedMemorySemanticEmbedding({
          semanticItemId: item.semanticItemId,
          contentHash: item.contentHash,
          model,
          dimensions: 384,
          version,
          vector
        })
      ).resolves.toBe(true);
      await expect(
        retainedRepository.readGrantRepresentation(
          actor(fixture.readerUserId),
          { shareGrantId: grant.shareGrantId, representation: "memory_events" }
        )
      ).resolves.not.toBeNull();
      const ownerRead = await retainedRepository.readGrantRepresentation(
        actor(fixture.ownerUserId),
        {
          shareGrantId: grant.shareGrantId,
          representation: "memory_events"
        }
      );
      if (change === "read_only" || change === "sharing_disabled") {
        expect(ownerRead).not.toBeNull();
      } else {
        expect(ownerRead).toBeNull();
      }
      const untouched = await pool.query(
        `select invalidated_at,personal_deleted_at from memory_embeddings where id=$1`,
        [personal.rows[0]!.id]
      );
      expect(untouched.rows[0]).toEqual({
        invalidated_at: null,
        personal_deleted_at: null
      });
      const personalVector = await pool.query<{ embedding: string }>(
        `select embedding::text from memory_embeddings_384 where memory_embedding_id=$1`,
        [personal.rows[0]!.id]
      );
      expect(JSON.parse(personalVector.rows[0]!.embedding)).toEqual(vector);
    }
  );

  it.each([
    {
      oldMode: "snapshot",
      oldRepresentation: "memory_events",
      newRepresentation: "lcm_rollups"
    },
    {
      oldMode: "snapshot",
      oldRepresentation: "lcm_rollups",
      newRepresentation: "memory_events"
    },
    {
      oldMode: "continuous",
      oldRepresentation: "lcm_rollups",
      newRepresentation: "memory_events"
    }
  ] as const)(
    "preserves independently selected detail through policy expansion and direct replacement %j",
    async (scenario) => {
      const fixture = await createWorkspaceFixture();
      const oldRepresentations =
        scenario.oldRepresentation === "memory_events"
          ? allRepresentations
          : ["lcm_rollups" as const];
      const original = await createGrant(fixture, {
        mode: scenario.oldMode,
        representation: scenario.oldRepresentation,
        ownerAllowed: oldRepresentations,
        label: "independent-selected-detail"
      });
      await materialize(fixture, original);
      const root = (
        await pool.query<{ logical_grant_id: string; grant_version: number }>(
          `select logical_grant_id,grant_version from team_memory_share_grants where id=$1`,
          [original.shareGrantId]
        )
      ).rows[0]!;
      const approvedBefore = (
        await pool.query<{
          consent_version: number;
          state: string;
          maximum_fidelity: string;
          source_owner_policy_version: number;
        }>(
          `select consent_version,state,maximum_fidelity,source_owner_policy_version from source_owner_representation_consents where id=$1`,
          [original.consentId]
        )
      ).rows[0]!;
      const newRepresentations =
        scenario.newRepresentation === "memory_events"
          ? allRepresentations
          : ["lcm_rollups" as const];
      const independent = await createConsent(fixture, original, {
        representation: scenario.newRepresentation,
        representations: newRepresentations,
        mode: "continuous",
        label: "independent-selected-detail"
      });
      expect(
        (
          await pool.query(
            `select consent_version,state,maximum_fidelity,source_owner_policy_version from source_owner_representation_consents where id=$1`,
            [original.consentId]
          )
        ).rows[0]
      ).toEqual(approvedBefore);
      const cap = (
        await pool.query<{ version: number; maximum_fidelity: string }>(
          `select version,maximum_fidelity from source_owner_representation_policies where logical_memory_id=$1 and superseded_at is null`,
          [original.logicalMemoryId]
        )
      ).rows[0]!;
      expect(cap).toEqual({
        version: scenario.oldRepresentation === "lcm_rollups" ? 2 : 1,
        maximum_fidelity: "memory_events"
      });
      await expect(
        repository.readGrantRepresentation(actor(fixture.readerUserId), {
          shareGrantId: original.shareGrantId,
          representation: scenario.oldRepresentation
        })
      ).resolves.toMatchObject({ representation: { sourceRevision: 1 } });
      const effectivePrivacyPolicyHash = (
        await pool.query<{ effective_privacy_policy_hash: string }>(
          `select effective_privacy_policy_hash from team_memory_representations where share_grant_id=$1 limit 1`,
          [original.shareGrantId]
        )
      ).rows[0]!.effective_privacy_policy_hash;
      const rule = await repository.createConversationSharingRule(
        actor(fixture.ownerUserId),
        {
          ruleId: randomUUID(),
          mutationId: randomUUID(),
          logicalGrantId: root.logical_grant_id,
          consentId: independent.consentId,
          expectedConsentVersion: independent.consent.consentVersion,
          expectedGrantVersion: root.grant_version,
          publisherCredentialId: fixture.deviceCredentialId,
          effectivePrivacyPolicyHash,
          authority: authority(fixture)
        }
      );
      const grantVersion = root.grant_version + 1;
      const ruleAuthority = {
        reasonId: rule.reasonId,
        ruleId: rule.ruleId,
        authorityVersion: rule.authorityVersion,
        consentVersion: independent.consent.consentVersion,
        publisherCredentialId: fixture.deviceCredentialId,
        publisherFence: rule.publisherFence,
        effectivePrivacyPolicyHash
      };
      await repository.prepareSharingRuleMember(actor(fixture.ownerUserId), {
        shareGrantId: original.shareGrantId,
        expectedGrantVersion: grantVersion,
        ruleAuthority
      });
      await flushSanitizedSemanticPublication();
      await ensureSourceRevision(
        fixture,
        original,
        2,
        "independent-detail-later"
      );
      const advance = await repository.advanceContinuousGrantRepresentations({
        remoteReplicaId: original.remoteReplicaId,
        sourceRevision: 2
      });
      expect(advance.advanced).toBe(
        newRepresentations.length + (scenario.oldMode === "continuous" ? 1 : 0)
      );
      await flushSanitizedSemanticPublication();
      const retainedOriginal = (
        await pool.query<{ source_revision: string }>(
          `select representation.source_revision::text
      from team_memory_reason_publications publication join team_memory_share_reasons reason on reason.id=publication.reason_id
      join team_memory_representations representation on representation.id=publication.representation_id
      where reason.share_grant_id=$1 and reason.kind='direct' order by representation.source_revision`,
          [original.shareGrantId]
        )
      ).rows.map((row) => row.source_revision);
      expect(retainedOriginal).toEqual(
        scenario.oldMode === "continuous" ? ["1", "2"] : ["1"]
      );
      // Replacing the direct reason must preserve the rule's content and its
      // semantic work, including a broader rule beside a narrower snapshot.
      const ruleRows = await pool.query(
        `select representation.id,representation.record_version,representation.state,item.id as semantic_item_id
      from team_memory_representations representation left join team_memory_semantic_items item on item.representation_id=representation.id
      where representation.share_grant_id=$1 and representation.consent_id=$2 order by representation.id,item.id`,
        [original.shareGrantId, independent.consentId]
      );
      expect(ruleRows.rows.length).toBeGreaterThan(0);
      const replacement = await createConsent(fixture, original, {
        representation: "lcm_rollups",
        representations: ["lcm_rollups"],
        mode: "snapshot",
        label: "independent-detail-later"
      });
      expect(replacement.preview.mode).toBe("snapshot");
      expect(replacement.preview.maximumFidelity).toBe("lcm_rollups");
      expect(replacement.preview.sourceCapabilities).toEqual(["lcm_rollups"]);
      const changed = await repository.selectGrantFidelity(
        actor(fixture.ownerUserId),
        {
          mutationId: randomUUID(),
          shareGrantId: original.shareGrantId,
          consentId: replacement.consentId,
          maximumFidelity: "lcm_rollups",
          includeCuratedMemory: false,
          expectedGrantVersion: grantVersion,
          authority: authority(fixture)
        }
      );
      expect(
        (
          await pool.query(
            `select representation.id,representation.record_version,representation.state,item.id as semantic_item_id
      from team_memory_representations representation left join team_memory_semantic_items item on item.representation_id=representation.id
      where representation.share_grant_id=$1 and representation.consent_id=$2 order by representation.id,item.id`,
            [original.shareGrantId, independent.consentId]
          )
        ).rows
      ).toEqual(ruleRows.rows);
      await prepareSanitizedSemanticPreview(
        fixture.ownerUserId,
        replacement.preview
      );
      await repository.materializeGrantRepresentation(
        actor(fixture.ownerUserId),
        {
          mutationId: randomUUID(),
          shareGrantId: original.shareGrantId,
          consentId: replacement.consentId,
          expectedGrantVersion: changed.grantVersion,
          preview: replacement.preview
        }
      );
      await expect(
        repository.readGrantRepresentation(actor(fixture.readerUserId), {
          shareGrantId: original.shareGrantId,
          representation: scenario.newRepresentation
        })
      ).resolves.toMatchObject({ representation: { sourceRevision: 2 } });
      if (scenario.oldMode === "continuous") {
        // An explicit global restriction still invalidates every affected reason
        // and rejects old queued publication before source decryption.
        await ensureSourceRevision(
          fixture,
          original,
          3,
          "independent-detail-restricted"
        );
        const queued = await repository.prepareSharingRuleMember(
          actor(fixture.ownerUserId),
          {
            shareGrantId: original.shareGrantId,
            expectedGrantVersion: changed.grantVersion,
            ruleAuthority
          }
        );
        await repository.putSourceOwnerPolicy(actor(fixture.ownerUserId), {
          mutationId: randomUUID(),
          logicalMemoryId: original.logicalMemoryId,
          expectedCurrentVersion: cap.version,
          maximumFidelity: "lcm_rollups",
          includeCuratedMemory: false
        });
        const decryptsBeforeRestriction = ownerDecryptSpy.mock.calls.length;
        await expect(
          repository.materializeGrantRepresentation(
            actor(fixture.ownerUserId),
            {
              mutationId: randomUUID(),
              shareGrantId: original.shareGrantId,
              consentId: independent.consentId,
              expectedGrantVersion: changed.grantVersion,
              ruleAuthority,
              preview: queued.previews[0]!
            }
          )
        ).rejects.toBeInstanceOf(SharedMemoryConflictError);
        expect(ownerDecryptSpy.mock.calls.length).toBe(
          decryptsBeforeRestriction
        );
        await expect(
          repository.readGrantRepresentation(actor(fixture.readerUserId), {
            shareGrantId: original.shareGrantId,
            representation: "lcm_rollups"
          })
        ).resolves.toBeNull();
      } else {
        await repository.controlConversationSharingRule(
          actor(fixture.ownerUserId),
          {
            mutationId: randomUUID(),
            ruleId: rule.ruleId,
            reasonId: rule.reasonId,
            shareGrantId: original.shareGrantId,
            expectedAuthorityVersion: rule.authorityVersion,
            expectedGrantVersion: changed.grantVersion,
            action: "stop",
            authority: authority(fixture)
          }
        );
        await expect(
          repository.readGrantRepresentation(actor(fixture.readerUserId), {
            shareGrantId: original.shareGrantId,
            representation: "memory_events"
          })
        ).resolves.toBeNull();
        await expect(
          repository.readGrantRepresentation(actor(fixture.readerUserId), {
            shareGrantId: original.shareGrantId,
            representation: "lcm_rollups"
          })
        ).resolves.toMatchObject({ representation: { sourceRevision: 2 } });
      }
    }
  );

  it("reviews exact rule controls without publication and rejects a mismatched destination before mutation", async () => {
    const fixture = await createWorkspaceFixture();
    const snapshot = await createGrant(fixture, {
      mode: "snapshot",
      representation: "lcm_rollups",
      ownerAllowed: ["lcm_rollups"],
      label: "review-rule-control"
    });
    await materialize(fixture, snapshot);
    const root = (
      await pool.query<{ logical_grant_id: string; grant_version: number }>(
        `select logical_grant_id,grant_version from team_memory_share_grants where id=$1`,
        [snapshot.shareGrantId]
      )
    ).rows[0]!;
    const consent = await createConsent(fixture, snapshot, {
      mode: "continuous",
      representation: "lcm_rollups",
      representations: ["lcm_rollups"],
      label: "review-rule-control"
    });
    const effectivePrivacyPolicyHash = (
      await pool.query<{ effective_privacy_policy_hash: string }>(
        `select effective_privacy_policy_hash from team_memory_representations where share_grant_id=$1 limit 1`,
        [snapshot.shareGrantId]
      )
    ).rows[0]!.effective_privacy_policy_hash;
    const rule = await repository.createConversationSharingRule(
      actor(fixture.ownerUserId),
      {
        ruleId: randomUUID(),
        mutationId: randomUUID(),
        logicalGrantId: root.logical_grant_id,
        consentId: consent.consentId,
        expectedConsentVersion: consent.consent.consentVersion,
        expectedGrantVersion: root.grant_version,
        publisherCredentialId: fixture.deviceCredentialId,
        effectivePrivacyPolicyHash,
        authority: authority(fixture)
      }
    );
    const input = {
      ruleId: rule.ruleId,
      reasonId: rule.reasonId,
      shareGrantId: snapshot.shareGrantId,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.teamWorkspaceId,
      expectedAuthorityVersion: rule.authorityVersion,
      expectedGrantVersion: root.grant_version + 1
    };
    const decryptsBefore = ownerDecryptSpy.mock.calls.length;
    for (const action of ["pause", "stop", "retry"] as const) {
      await expect(
        repository.getConversationSharingRuleControlReview(
          actor(fixture.ownerUserId),
          { ...input, action }
        )
      ).resolves.toMatchObject({
        logicalMemoryId: snapshot.logicalMemoryId,
        ruleId: rule.ruleId,
        reasonId: rule.reasonId,
        state: "active",
        authorityVersion: rule.authorityVersion,
        grantVersion: input.expectedGrantVersion,
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: false
      });
    }
    for (const invalid of [
      { teamWorkspaceId: randomUUID() },
      { teamId: randomUUID() },
      { reasonId: randomUUID() },
      { expectedAuthorityVersion: input.expectedAuthorityVersion + 1 },
      { expectedGrantVersion: input.expectedGrantVersion + 1 }
    ]) {
      await expect(
        repository.getConversationSharingRuleControlReview(
          actor(fixture.ownerUserId),
          { ...input, ...invalid, action: "pause" }
        )
      ).resolves.toBeNull();
    }
    await expect(
      repository.getConversationSharingRuleControlReview(
        actor(fixture.readerUserId),
        { ...input, action: "pause" }
      )
    ).resolves.toBeNull();
    await expect(
      repository.getConversationSharingRuleControlReview(
        actor(fixture.ownerUserId),
        { ...input, action: "resume" }
      )
    ).resolves.toBeNull();
    await expect(
      repository.controlConversationSharingRule(actor(fixture.ownerUserId), {
        ...input,
        mutationId: randomUUID(),
        action: "stop",
        authority: authority(fixture),
        destination: { teamId: fixture.teamId, teamWorkspaceId: randomUUID() }
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
    const paused = await repository.controlConversationSharingRule(
      actor(fixture.ownerUserId),
      {
        ...input,
        mutationId: randomUUID(),
        action: "pause",
        authority: authority(fixture),
        destination: {
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId
        }
      }
    );
    const pausedInput = {
      ...input,
      expectedAuthorityVersion: paused.authorityVersion,
      expectedGrantVersion: paused.grantVersion
    };
    await expect(
      repository.getConversationSharingRuleControlReview(
        actor(fixture.ownerUserId),
        { ...pausedInput, action: "resume" }
      )
    ).resolves.toMatchObject({ state: "paused" });
    await pool.query(
      `update team_workspace_access_grants set access='read',can_share_owned_memory=false where team_workspace_id=$1 and user_id=$2`,
      [fixture.teamWorkspaceId, fixture.ownerUserId]
    );
    await expect(
      repository.getConversationSharingRuleControlReview(
        actor(fixture.ownerUserId),
        { ...pausedInput, action: "stop" }
      )
    ).resolves.toMatchObject({ state: "paused" });
    await expect(
      repository.getConversationSharingRuleControlReview(
        actor(fixture.ownerUserId),
        { ...pausedInput, action: "resume" }
      )
    ).resolves.toBeNull();
    for (const action of ["pause", "retry"] as const) {
      await expect(
        repository.getConversationSharingRuleControlReview(
          actor(fixture.ownerUserId),
          { ...pausedInput, action }
        )
      ).resolves.toBeNull();
    }
    expect(ownerDecryptSpy.mock.calls.length).toBe(decryptsBefore);
    expect(
      (
        await pool.query(
          `select 1 from team_memory_reason_publications where reason_id=$1`,
          [rule.reasonId]
        )
      ).rowCount
    ).toBe(0);
  });

  it.each(["active", "paused"] as const)(
    "keeps a %s rule stopped after whole-grant revocation and direct restoration",
    async (initialState) => {
      const fixture = await createWorkspaceFixture();
      const direct = await createGrant(fixture, {
        mode: "snapshot",
        representation: "lcm_rollups",
        ownerAllowed: ["lcm_rollups"],
        label: "whole-grant-rule-revocation"
      });
      await materialize(fixture, direct);
      const root = (
        await pool.query<{ logical_grant_id: string; grant_version: number }>(
          `select logical_grant_id,grant_version from team_memory_share_grants where id=$1`,
          [direct.shareGrantId]
        )
      ).rows[0]!;
      const independent = await createConsent(fixture, direct, {
        representation: "lcm_rollups",
        representations: ["lcm_rollups"],
        mode: "continuous",
        label: "whole-grant-rule-revocation"
      });
      const effectivePrivacyPolicyHash = (
        await pool.query<{ effective_privacy_policy_hash: string }>(
          `select effective_privacy_policy_hash from team_memory_representations where share_grant_id=$1 limit 1`,
          [direct.shareGrantId]
        )
      ).rows[0]!.effective_privacy_policy_hash;
      const rule = await repository.createConversationSharingRule(
        actor(fixture.ownerUserId),
        {
          ruleId: randomUUID(),
          mutationId: randomUUID(),
          logicalGrantId: root.logical_grant_id,
          consentId: independent.consentId,
          expectedConsentVersion: independent.consent.consentVersion,
          expectedGrantVersion: root.grant_version,
          publisherCredentialId: fixture.deviceCredentialId,
          effectivePrivacyPolicyHash,
          authority: authority(fixture)
        }
      );
      let grantVersion = root.grant_version + 1;
      const ruleAuthority = {
        reasonId: rule.reasonId,
        ruleId: rule.ruleId,
        authorityVersion: rule.authorityVersion,
        consentVersion: independent.consent.consentVersion,
        publisherCredentialId: fixture.deviceCredentialId,
        publisherFence: rule.publisherFence,
        effectivePrivacyPolicyHash
      };
      await repository.prepareSharingRuleMember(actor(fixture.ownerUserId), {
        shareGrantId: direct.shareGrantId,
        expectedGrantVersion: grantVersion,
        ruleAuthority
      });
      await flushSanitizedSemanticPublication();
      await ensureSourceRevision(fixture, direct, 2, "whole-grant-later");
      const queued = await repository.prepareSharingRuleMember(
        actor(fixture.ownerUserId),
        {
          shareGrantId: direct.shareGrantId,
          expectedGrantVersion: grantVersion,
          ruleAuthority
        }
      );
      if (initialState === "paused") {
        const paused = await repository.controlConversationSharingRule(
          actor(fixture.ownerUserId),
          {
            mutationId: randomUUID(),
            ruleId: rule.ruleId,
            reasonId: rule.reasonId,
            shareGrantId: direct.shareGrantId,
            expectedAuthorityVersion: rule.authorityVersion,
            expectedGrantVersion: grantVersion,
            action: "pause",
            authority: authority(fixture)
          }
        );
        grantVersion = paused.grantVersion;
      }
      const revocation = {
        mutationId: randomUUID(),
        shareGrantId: direct.shareGrantId,
        expectedGrantVersion: grantVersion,
        reasonCode: "owner_revoked_all_reasons",
        authority: authority(fixture)
      };
      const revoked = await repository.revokeShareGrant(
        actor(fixture.ownerUserId),
        revocation
      );
      const loadAuthority = () =>
        pool.query<{
          state: string;
          authority_version: number;
          publisher_fence: string;
          reconciliation_requested_at: Date | null;
          next_reconciliation_at: Date | null;
          consent_state: string;
          consent_version: number;
        }>(
          `select rule.state,rule.authority_version,rule.publisher_fence,
                member.reconciliation_requested_at,member.next_reconciliation_at,
                consent.state as consent_state,consent.consent_version
           from team_memory_sharing_rules rule
           join team_memory_share_reasons reason on reason.rule_id=rule.id
           join team_memory_sharing_rule_members member on member.id=reason.membership_id
           join source_owner_representation_consents consent on consent.id=reason.consent_id
          where rule.id=$1`,
          [rule.ruleId]
        );
      const stopped = (await loadAuthority()).rows[0]!;
      expect(stopped).toMatchObject({
        state: "stopped",
        consent_state: "revoked",
        authority_version:
          rule.authorityVersion + (initialState === "paused" ? 2 : 1),
        publisher_fence: String(rule.publisherFence + 1),
        reconciliation_requested_at: null,
        next_reconciliation_at: null
      });
      await expect(
        repository.revokeShareGrant(actor(fixture.ownerUserId), revocation)
      ).resolves.toEqual(revoked);
      expect((await loadAuthority()).rows[0]).toEqual(stopped);
      await expect(
        repository.selectGrantFidelity(actor(fixture.ownerUserId), {
          mutationId: randomUUID(),
          shareGrantId: direct.shareGrantId,
          consentId: independent.consentId,
          maximumFidelity: "lcm_rollups",
          includeCuratedMemory: false,
          expectedGrantVersion: revoked.grantVersion,
          authority: authority(fixture)
        })
      ).rejects.toThrow("Replacement consent is not active");
      const replacement = await createConsent(fixture, direct, {
        representation: "lcm_rollups",
        representations: ["lcm_rollups"],
        mode: "snapshot",
        label: "whole-grant-later"
      });
      const restored = await repository.selectGrantFidelity(
        actor(fixture.ownerUserId),
        {
          mutationId: randomUUID(),
          shareGrantId: direct.shareGrantId,
          consentId: replacement.consentId,
          maximumFidelity: "lcm_rollups",
          includeCuratedMemory: false,
          expectedGrantVersion: revoked.grantVersion,
          authority: authority(fixture)
        }
      );
      await prepareSanitizedSemanticPreview(
        fixture.ownerUserId,
        replacement.preview
      );
      await repository.materializeGrantRepresentation(
        actor(fixture.ownerUserId),
        {
          mutationId: randomUUID(),
          shareGrantId: direct.shareGrantId,
          consentId: replacement.consentId,
          expectedGrantVersion: restored.grantVersion,
          preview: replacement.preview
        }
      );
      await expect(
        repository.readGrantRepresentation(actor(fixture.readerUserId), {
          shareGrantId: direct.shareGrantId,
          representation: "lcm_rollups"
        })
      ).resolves.toMatchObject({ representation: { sourceRevision: 2 } });
      const decryptsBefore = ownerDecryptSpy.mock.calls.length;
      // Even a caller supplying the new root and rule versions cannot reuse
      // a stopped rule or its revoked consent to publish old queued work.
      const stoppedAuthority = {
        ...ruleAuthority,
        authorityVersion: stopped.authority_version,
        publisherFence: Number(stopped.publisher_fence),
        consentVersion: stopped.consent_version
      };
      await expect(
        repository.materializeGrantRepresentation(actor(fixture.ownerUserId), {
          mutationId: randomUUID(),
          shareGrantId: direct.shareGrantId,
          consentId: independent.consentId,
          expectedGrantVersion: restored.grantVersion,
          ruleAuthority: stoppedAuthority,
          preview: queued.previews[0]!
        })
      ).rejects.toBeInstanceOf(SharedMemoryConflictError);
      await expect(
        repository.controlConversationSharingRule(actor(fixture.ownerUserId), {
          mutationId: randomUUID(),
          ruleId: rule.ruleId,
          reasonId: rule.reasonId,
          shareGrantId: direct.shareGrantId,
          expectedAuthorityVersion: stopped.authority_version,
          expectedGrantVersion: restored.grantVersion,
          action: "resume",
          authority: authority(fixture)
        })
      ).rejects.toBeInstanceOf(SharedMemoryConflictError);
      expect(ownerDecryptSpy.mock.calls.length).toBe(decryptsBefore);
      expect((await loadAuthority()).rows[0]).toEqual(stopped);
      expect(
        (
          await pool.query(
            `select 1 from team_memory_representations where share_grant_id=$1 and consent_id=$2 and invalidated_at is null`,
            [direct.shareGrantId, independent.consentId]
          )
        ).rowCount
      ).toBe(0);
      expect(
        (
          await pool.query(
            `select 1 from audit_events where target_table='team_memory_sharing_rules' and target_id=$1 and action='shared_memory.rule.parent_share_revoked'`,
            [rule.ruleId]
          )
        ).rowCount
      ).toBe(1);
    }
  );

  it("creates independent continuous rule authority beside a snapshot with one grant", async () => {
    const fixture = await createWorkspaceFixture();
    const snapshot = await createGrant(fixture, {
      mode: "snapshot",
      label: "rule-and-snapshot"
    });
    await materialize(fixture, snapshot);
    const discussion = await collaboration.createThread(
      actor(fixture.ownerUserId),
      {
        kind: "shared_session_discussion",
        idempotencyKey: "rule-snapshot-discussion",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        sharedLogicalMemoryId: snapshot.logicalMemoryId,
        shareGrantId: snapshot.shareGrantId
      }
    );
    if (!discussion) throw new Error("Expected published snapshot companion");
    const historicalMessage = await collaboration.sendMessage(
      actor(fixture.ownerUserId),
      {
        threadId: discussion.id,
        idempotencyKey: "rule-snapshot-history",
        bodyText: "Retained discussion history"
      }
    );
    expect(historicalMessage).not.toBeNull();
    const checkCompanion = async () => {
      await expect(
        collaboration.getThread(actor(fixture.readerUserId), {
          threadId: discussion.id
        })
      ).resolves.toMatchObject({ id: discussion.id });
      const history = await collaboration.listMessages(
        actor(fixture.readerUserId),
        { threadId: discussion.id }
      );
      expect(history?.messages[0]?.bodyText).toBe(
        "Retained discussion history"
      );
      const threads = await collaboration.listThreads(
        actor(fixture.readerUserId),
        {
          scope: "team",
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          kinds: ["shared_session_discussion"],
          limit: 1
        }
      );
      expect(threads?.map((thread) => thread.id)).toEqual([discussion.id]);
    };
    const publicationEvent = async (
      consentId: string,
      sourceRevision: number
    ) => {
      const event = (
        await pool.query<{ id: string; cursor: string }>(
          `select event.id,event.cursor::text
        from collaboration_outbox event join team_memory_representations representation
          on representation.id=event.resource_id and event.resource_type='team_memory_representation'
        where representation.share_grant_id=$1 and representation.consent_id=$2
          and representation.source_revision=$3 and representation.representation='memory_events'
          and event.family='memory_event_available' order by event.cursor desc limit 1`,
          [snapshot.shareGrantId, consentId, sourceRevision]
        )
      ).rows[0];
      if (!event) throw new Error("Expected exact representation event");
      return event;
    };
    const eventAuthorized = (event: { id: string; cursor: string }) =>
      collaboration.isEventAuthorized(actor(fixture.readerUserId), {
        eventId: event.id,
        cursor: Number(event.cursor),
        scope: "team",
        teamId: fixture.teamId
      });
    const snapshotEvent = await publicationEvent(snapshot.consentId, 1);
    const retainedTitle = (await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      { shareGrantId: snapshot.shareGrantId, representation: "memory_events" }
    ))!.grant.displayTitle;
    const root = (
      await pool.query<{ logical_grant_id: string }>(
        `select logical_grant_id from team_memory_share_grants where id=$1`,
        [snapshot.shareGrantId]
      )
    ).rows[0]!;
    const privacy = (
      await pool.query<{ effective_privacy_policy_hash: string }>(
        `select effective_privacy_policy_hash from team_memory_representations where share_grant_id=$1`,
        [snapshot.shareGrantId]
      )
    ).rows[0]!;
    const continuous = await createConsent(fixture, snapshot, {
      representation: "memory_events",
      mode: "continuous",
      label: "rule-and-snapshot"
    });
    const input = {
      ruleId: randomUUID(),
      mutationId: randomUUID(),
      logicalGrantId: root.logical_grant_id,
      consentId: continuous.consentId,
      expectedConsentVersion: continuous.consent.consentVersion,
      expectedGrantVersion: snapshot.grantVersion,
      publisherCredentialId: fixture.deviceCredentialId,
      effectivePrivacyPolicyHash: privacy.effective_privacy_policy_hash,
      authority: authority(fixture)
    };
    const rule = await repository.createConversationSharingRule(
      actor(fixture.ownerUserId),
      input
    );
    expect(rule).toMatchObject({
      shareGrantId: snapshot.shareGrantId,
      ruleId: input.ruleId,
      authorityVersion: 1,
      publisherFence: 1
    });
    await expect(
      repository.createConversationSharingRule(
        actor(fixture.ownerUserId),
        input
      )
    ).resolves.toEqual(rule);
    await expect(
      repository.createConversationSharingRule(actor(fixture.ownerUserId), {
        ...input,
        publisherCredentialId: randomUUID()
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    const grants = await pool.query<{ consent_id: string }>(
      `select consent_id from team_memory_share_grants where logical_memory_id=$1 and team_workspace_id=$2`,
      [snapshot.logicalMemoryId, fixture.teamWorkspaceId]
    );
    expect(grants.rows).toEqual([{ consent_id: snapshot.consentId }]);
    const reasons = await pool.query(
      `select kind,consent_id from team_memory_share_reasons where share_grant_id=$1 order by kind`,
      [snapshot.shareGrantId]
    );
    expect(reasons.rows).toEqual([
      { kind: "direct", consent_id: snapshot.consentId },
      { kind: "rule", consent_id: continuous.consentId }
    ]);
    const ownerView = await repository.getOwnerShare(
      actor(fixture.ownerUserId),
      { kind: "grant", id: snapshot.shareGrantId }
    );
    expect(ownerView?.summary.sharingReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "direct",
          rule: null,
          consentId: snapshot.consentId,
          mode: "snapshot",
          updateState: "fixed_snapshot"
        }),
        expect.objectContaining({
          kind: "rule",
          rule: {
            id: input.ruleId,
            selectorKind: "captured_session",
            authorityVersion: 1,
            publisherFence: 1,
            state: "active",
            catchUpState: "queued",
            failureCode: null
          },
          consentId: continuous.consentId,
          mode: "continuous",
          updateState: "pending",
          publishedRepresentations: []
        })
      ])
    );
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: snapshot.shareGrantId,
        representation: "memory_events"
      })
    ).resolves.not.toBeNull();
    const grantVersion = (
      await pool.query<{ grant_version: number }>(
        `select grant_version from team_memory_share_grants where id=$1`,
        [snapshot.shareGrantId]
      )
    ).rows[0]!.grant_version;
    const ruleAuthority = {
      reasonId: rule.reasonId,
      ruleId: rule.ruleId,
      authorityVersion: rule.authorityVersion,
      consentVersion: continuous.consent.consentVersion,
      publisherCredentialId: fixture.deviceCredentialId,
      publisherFence: rule.publisherFence,
      effectivePrivacyPolicyHash: privacy.effective_privacy_policy_hash
    };
    const preparation = {
      shareGrantId: snapshot.shareGrantId,
      expectedGrantVersion: grantVersion,
      ruleAuthority
    };
    const ownerDecrypts = ownerDecryptSpy.mock.calls.length;
    await expect(
      repository.prepareSharingRuleMember(actor(fixture.ownerUserId), {
        ...preparation,
        ruleAuthority: { ...ruleAuthority, publisherFence: 2 }
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    expect(ownerDecryptSpy.mock.calls.length).toBe(ownerDecrypts);
    const initial = await repository.prepareSharingRuleMember(
      actor(fixture.ownerUserId),
      preparation
    );
    expect(initial.previews).toHaveLength(3);
    expect(initial.unresolvedRepresentations).toEqual([]);
    await flushSanitizedSemanticPublication();
    await checkCompanion();
    const index = await repository.listWorkspaceGrants(
      actor(fixture.readerUserId),
      {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        limit: 50,
        offset: 0
      }
    );
    expect(
      index.entries.filter(
        (entry) => entry.shareGrantId === snapshot.shareGrantId
      )
    ).toHaveLength(1);
    expect(
      index.entries.find(
        (entry) => entry.shareGrantId === snapshot.shareGrantId
      )?.title
    ).toBe(retainedTitle);
    const titleRouting = await pool.query<{ raw: string }>(
      `select string_agg(row_to_json(r)::text,E'\n') as raw from team_memory_representations r where share_grant_id=$1`,
      [snapshot.shareGrantId]
    );
    expect(titleRouting.rows[0]!.raw).not.toContain(
      "rule-and-snapshot user source"
    );
    expect(titleRouting.rows[0]!.raw).toContain(
      "[koed encrypted Shared Memory title]"
    );
    await ensureSourceRevision(
      fixture,
      snapshot,
      2,
      "rule-later-turn-and-summary"
    );
    await expect(
      repository.advanceContinuousGrantRepresentations({
        remoteReplicaId: snapshot.remoteReplicaId,
        sourceRevision: 2
      })
    ).resolves.toMatchObject({ advanced: 3 });
    await flushSanitizedSemanticPublication();
    for (const representation of allRepresentations) {
      await expect(
        repository.readGrantRepresentation(actor(fixture.readerUserId), {
          shareGrantId: snapshot.shareGrantId,
          representation
        })
      ).resolves.toMatchObject({ representation: { sourceRevision: 2 } });
    }
    const snapshotPublications = await pool.query<{ source_revision: string }>(
      `select representation.source_revision::text from team_memory_reason_publications publication join team_memory_share_reasons reason on reason.id=publication.reason_id join team_memory_representations representation on representation.id=publication.representation_id where reason.share_grant_id=$1 and reason.kind='direct'`,
      [snapshot.shareGrantId]
    );
    expect(snapshotPublications.rows).toEqual([{ source_revision: "1" }]);
    await ensureSourceRevision(
      fixture,
      snapshot,
      3,
      "rule-obsolete-preparation"
    );
    const queued = await repository.prepareSharingRuleMember(
      actor(fixture.ownerUserId),
      preparation
    );
    for (const preview of queued.previews)
      await prepareSanitizedSemanticPreview(fixture.ownerUserId, preview);
    const pauseIntent = {
      ruleId: rule.ruleId,
      reasonId: rule.reasonId,
      shareGrantId: snapshot.shareGrantId,
      mutationId: randomUUID(),
      expectedAuthorityVersion: rule.authorityVersion,
      expectedGrantVersion: grantVersion,
      action: "pause" as const,
      authority: authority(fixture)
    };
    await pool.query(
      `update team_workspace_access_grants set disabled_at=now() where team_workspace_id=$1 and user_id=$2`,
      [fixture.teamWorkspaceId, fixture.ownerUserId]
    );
    const decryptsBeforeDeniedControl = ownerDecryptSpy.mock.calls.length;
    await expect(
      repository.controlConversationSharingRule(
        actor(fixture.readerUserId),
        pauseIntent
      )
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
    await expect(
      repository.controlConversationSharingRule(actor(fixture.ownerUserId), {
        ...pauseIntent,
        action: "unexpected" as never
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    await expect(
      repository.controlConversationSharingRule(actor(fixture.ownerUserId), {
        ...pauseIntent,
        expectedAuthorityVersion: 99
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    expect(ownerDecryptSpy.mock.calls.length).toBe(decryptsBeforeDeniedControl);
    const paused = await repository.controlConversationSharingRule(
      actor(fixture.ownerUserId),
      pauseIntent
    );
    expect(paused).toMatchObject({
      state: "paused",
      authorityVersion: 2,
      catchUpState: "idle"
    });
    await expect(
      repository.controlConversationSharingRule(
        actor(fixture.ownerUserId),
        pauseIntent
      )
    ).resolves.toEqual(paused);
    await expect(
      repository.controlConversationSharingRule(actor(fixture.ownerUserId), {
        ...pauseIntent,
        action: "stop"
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    const stalePublication = {
      mutationId: randomUUID(),
      shareGrantId: snapshot.shareGrantId,
      consentId: continuous.consentId,
      expectedGrantVersion: grantVersion,
      ruleAuthority,
      preview: queued.previews[0]!
    };
    await expect(
      repository.materializeGrantRepresentation(
        actor(fixture.ownerUserId),
        stalePublication
      )
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    await repository.reconcileReadySemanticRepresentations({ limit: 100 });
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: snapshot.shareGrantId,
        representation: "memory_events"
      })
    ).resolves.toMatchObject({ representation: { sourceRevision: 2 } });
    // Temporarily remove the snapshot's authority in this fixture to prove that
    // the paused rule independently preserves the discussion and exact events.
    await pool.query(
      `update source_owner_representation_consents set state='revoked',revoked_at=now() where id=$1`,
      [snapshot.consentId]
    );
    await checkCompanion();
    const retainedRuleEvent = await publicationEvent(continuous.consentId, 2);
    await expect(eventAuthorized(retainedRuleEvent)).resolves.toBe(true);
    await expect(eventAuthorized(snapshotEvent)).resolves.toBe(false);
    const pausedLifecycle = (
      await pool.query<{ id: string; cursor: string }>(
        `select id,cursor::text from collaboration_outbox where mutation_id=$1 and family='share_grant_lifecycle'`,
        [pauseIntent.mutationId]
      )
    ).rows[0]!;
    await expect(eventAuthorized(pausedLifecycle)).resolves.toBe(true);
    const resumeIntent = {
      ...pauseIntent,
      mutationId: randomUUID(),
      action: "resume" as const,
      expectedAuthorityVersion: paused.authorityVersion,
      expectedGrantVersion: paused.grantVersion
    };
    const decryptsBeforeDeniedResume = ownerDecryptSpy.mock.calls.length;
    await expect(
      repository.controlConversationSharingRule(
        actor(fixture.ownerUserId),
        resumeIntent
      )
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
    expect(ownerDecryptSpy.mock.calls.length).toBe(decryptsBeforeDeniedResume);
    await pool.query(
      `update team_workspace_access_grants set disabled_at=null where team_workspace_id=$1 and user_id=$2`,
      [fixture.teamWorkspaceId, fixture.ownerUserId]
    );
    // Publisher expiry also rolls back the tentative versions and active state.
    await pool.query(
      `update device_credentials set expires_at=now()-interval '1 second' where id=$1`,
      [fixture.deviceCredentialId]
    );
    await expect(
      repository.controlConversationSharingRule(
        actor(fixture.ownerUserId),
        resumeIntent
      )
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    await pool.query(
      `update device_credentials set expires_at=null where id=$1`,
      [fixture.deviceCredentialId]
    );
    // Resume has to catch up durable work even if no further source-sync arrives.
    const resumed = await repository.controlConversationSharingRule(
      actor(fixture.ownerUserId),
      {
        ...pauseIntent,
        mutationId: randomUUID(),
        action: "resume",
        expectedAuthorityVersion: paused.authorityVersion,
        expectedGrantVersion: paused.grantVersion
      }
    );
    expect(resumed).toMatchObject({
      state: "active",
      authorityVersion: 3,
      catchUpState: "queued"
    });
    // A delayed replay reports current state; it cannot put the rule back on pause.
    await expect(
      repository.controlConversationSharingRule(
        actor(fixture.ownerUserId),
        pauseIntent
      )
    ).resolves.toEqual(resumed);
    const restartedRepository = createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: () => provider,
      resolvePersonalEncryptionProvider: () => privacyProvider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider
    });
    expect(
      await restartedRepository.getNextSemanticPrivacyWorkAt()
    ).not.toBeNull();
    await pool.query(
      `update device_credentials set expires_at=now()-interval '1 second' where id=$1`,
      [fixture.deviceCredentialId]
    );
    await pool.query(
      `update team_memory_sharing_rule_members set reconciliation_attempt_count=4 where rule_id=$1`,
      [rule.ruleId]
    );
    const decryptsBeforeFailedCatchUp = ownerDecryptSpy.mock.calls.length;
    await expect(
      restartedRepository.reconcileSharingRuleMembers({ limit: 100 })
    ).resolves.toMatchObject({ processed: 1, prepared: 0, failed: 1 });
    expect(ownerDecryptSpy.mock.calls.length).toBe(decryptsBeforeFailedCatchUp);
    const failedCatchUp = await repository.getOwnerShare(
      actor(fixture.ownerUserId),
      { kind: "grant", id: snapshot.shareGrantId }
    );
    expect(
      failedCatchUp?.summary.sharingReasons.find(
        (reason) => reason.id === rule.reasonId
      )?.rule
    ).toMatchObject({
      catchUpState: "needs_attention",
      failureCode: "authority_unavailable"
    });
    const retryTime = (
      await pool.query<{ due: boolean }>(
        `select next_reconciliation_at>now() as due from team_memory_sharing_rule_members where rule_id=$1`,
        [rule.ruleId]
      )
    ).rows[0]!;
    expect(retryTime.due).toBe(true);
    await pool.query(
      `update device_credentials set expires_at=null where id=$1`,
      [fixture.deviceCredentialId]
    );
    // Advance the durable deadline without waiting in real time.
    await pool.query(
      `update team_memory_sharing_rule_members set next_reconciliation_at=now() where rule_id=$1`,
      [rule.ruleId]
    );
    await expect(
      restartedRepository.reconcileSharingRuleMembers({ limit: 100 })
    ).resolves.toMatchObject({ processed: 1, prepared: 3, failed: 0 });
    await flushSanitizedSemanticPublication();
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: snapshot.shareGrantId,
        representation: "memory_events"
      })
    ).resolves.toMatchObject({ representation: { sourceRevision: 3 } });
    const retryIntent = {
      ...pauseIntent,
      mutationId: randomUUID(),
      action: "retry" as const,
      expectedAuthorityVersion: resumed.authorityVersion,
      expectedGrantVersion: resumed.grantVersion
    };
    const retryQueued = await repository.controlConversationSharingRule(
      actor(fixture.ownerUserId),
      retryIntent
    );
    expect(retryQueued).toMatchObject({
      state: "active",
      authorityVersion: 4,
      catchUpState: "queued"
    });
    const stopMutationId = randomUUID();
    const stopped = await repository.controlConversationSharingRule(
      actor(fixture.ownerUserId),
      {
        ...pauseIntent,
        mutationId: stopMutationId,
        action: "stop",
        expectedAuthorityVersion: retryQueued.authorityVersion,
        expectedGrantVersion: retryQueued.grantVersion
      }
    );
    await expect(
      repository.controlConversationSharingRule(
        actor(fixture.ownerUserId),
        retryIntent
      )
    ).resolves.toEqual(stopped);
    expect(stopped).toMatchObject({ state: "stopped", catchUpState: "idle" });
    const decryptsBeforeDeniedCompanion = decryptSpy.mock.calls.length;
    await expect(
      collaboration.getThread(actor(fixture.readerUserId), {
        threadId: discussion.id
      })
    ).resolves.toBeNull();
    await expect(
      collaboration.listMessages(actor(fixture.readerUserId), {
        threadId: discussion.id
      })
    ).resolves.toBeNull();
    await expect(
      collaboration.sendMessage(actor(fixture.ownerUserId), {
        threadId: discussion.id,
        idempotencyKey: "stopped-rule-denial",
        bodyText: "must not be stored"
      })
    ).resolves.toBeNull();
    await expect(eventAuthorized(retainedRuleEvent)).resolves.toBe(false);
    expect(decryptSpy.mock.calls.length).toBe(decryptsBeforeDeniedCompanion);
    const lastReasonStop = (
      await pool.query<{ id: string; cursor: string; family: string }>(
        `select id,cursor::text,family from collaboration_outbox where mutation_id=$1`,
        [stopMutationId]
      )
    ).rows;
    expect(lastReasonStop).toHaveLength(1);
    expect(lastReasonStop[0]?.family).toBe("access_revoked");
    await expect(eventAuthorized(lastReasonStop[0]!)).resolves.toBe(true);
    // Restore the fixture's independent snapshot to verify that stopping the
    // rule never destroys the snapshot or its existing discussion history.
    await pool.query(
      `update source_owner_representation_consents set state='active',revoked_at=null where id=$1`,
      [snapshot.consentId]
    );
    await checkCompanion();
    await expect(eventAuthorized(snapshotEvent)).resolves.toBe(true);
    await expect(eventAuthorized(retainedRuleEvent)).resolves.toBe(false);
    const replay = await collaboration.replayEvents(
      actor(fixture.readerUserId),
      { scope: "team", teamId: fixture.teamId, afterCursor: 0 }
    );
    expect(
      replay?.events.some((event) => event.id === retainedRuleEvent.id)
    ).toBe(false);
    expect(replay?.events.some((event) => event.id === snapshotEvent.id)).toBe(
      true
    );

    await expect(
      repository.controlConversationSharingRule(actor(fixture.ownerUserId), {
        ...pauseIntent,
        mutationId: randomUUID(),
        action: "resume",
        expectedAuthorityVersion: stopped.authorityVersion,
        expectedGrantVersion: stopped.grantVersion
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    await expect(
      repository.reconcileSharingRuleMembers({ limit: 100 })
    ).resolves.toMatchObject({ processed: 0, prepared: 0 });
    await expect(
      repository.materializeGrantRepresentation(actor(fixture.ownerUserId), {
        ...stalePublication,
        mutationId: randomUUID()
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: snapshot.shareGrantId,
        representation: "memory_events"
      })
    ).resolves.toMatchObject({ representation: { sourceRevision: 1 } });
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: snapshot.shareGrantId,
        representation: "lcm_leaves"
      })
    ).resolves.toBeNull();
    const obsolete = await pool.query(
      `select id from team_memory_representations where share_grant_id=$1 and consent_id=$2 and source_revision=3`,
      [snapshot.shareGrantId, continuous.consentId]
    );
    expect(obsolete.rows).toHaveLength(3);
    const retainedRead = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      { shareGrantId: snapshot.shareGrantId, representation: "memory_events" }
    );
    expect(retainedRead?.grant.displayTitle).toBe(retainedTitle);
  });

  it("retains paused semantic access only through exact reason publications on every read", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      label: "reason-publication-boundary"
    });
    await materialize(fixture, grant);
    const model = "reason-boundary-model";
    const version = "reason-boundary-v1";
    const vector = [1, ...Array.from({ length: 383 }, () => 0)];
    const pending = await repository.listPendingSharedMemorySemanticItems();
    for (const item of pending.filter(
      (item) => item.shareGrantId === grant.shareGrantId
    )) {
      await repository.storeSharedMemorySemanticEmbedding({
        semanticItemId: item.semanticItemId,
        contentHash: item.contentHash,
        model,
        dimensions: 384,
        version,
        vector
      });
    }
    await pool.query(
      `update source_owner_representation_consents set state='paused',paused_at=now() where id=$1`,
      [grant.consentId]
    );
    const search = {
      teamWorkspaceId: fixture.teamWorkspaceId,
      queryVector: vector,
      model,
      dimensions: 384 as const,
      version,
      limit: 50,
      searchDomain: "global" as const
    };
    const boundary = await repository.freezeSharedMemorySemanticRecallBoundary(
      actor(fixture.readerUserId),
      { teamWorkspaceId: fixture.teamWorkspaceId, maximumGrantCount: 1024 }
    );
    expect(boundary.shareGrantIds).toContain(grant.shareGrantId);
    const hits = await repository.searchAuthorizedSharedMemorySemanticItems(
      actor(fixture.readerUserId),
      search
    );
    const hit = hits.find((item) => item.shareGrantId === grant.shareGrantId)!;
    expect(hit).toBeDefined();
    await expect(
      repository.expandAuthorizedSharedMemorySemanticItem(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          candidateId: hit.candidateId,
          searchDomain: "global"
        }
      )
    ).resolves.not.toBeNull();
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: "memory_events"
      })
    ).resolves.not.toBeNull();
    await pool.query(
      `delete from team_memory_reason_publications where share_grant_id=$1`,
      [grant.shareGrantId]
    );
    const decrypts = decryptSpy.mock.calls.length;
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: "memory_events"
      })
    ).resolves.toBeNull();
    await expect(
      repository.listWorkspaceGrants(actor(fixture.readerUserId), {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        limit: 50,
        offset: 0
      })
    ).resolves.toMatchObject({ entries: [] });
    await expect(
      repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        { ...search, authorizationBoundary: boundary }
      )
    ).resolves.toEqual([]);
    await expect(
      repository.scanAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        { ...search, authorizationBoundary: boundary }
      )
    ).resolves.toEqual([]);
    await expect(
      repository.expandAuthorizedSharedMemorySemanticItem(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          candidateId: hit.candidateId,
          searchDomain: "global",
          authorizationBoundary: boundary
        }
      )
    ).resolves.toBeNull();
    expect(decryptSpy.mock.calls.length).toBe(decrypts);
    const currentBoundary =
      await repository.freezeSharedMemorySemanticRecallBoundary(
        actor(fixture.readerUserId),
        { teamWorkspaceId: fixture.teamWorkspaceId, maximumGrantCount: 1024 }
      );
    expect(currentBoundary.shareGrantIds).not.toContain(grant.shareGrantId);
  });

  it("reauthorizes an exact claimed semantic row after revocation and before Team key resolution", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "semantic-claim-race" });
    await materialize(fixture, grant, { label: "semantic-claim-race" });
    let boundaryCalls = 0;
    let keyResolutionCalls = 0;
    let embeddingHandoffCalls = 0;
    const raceRepository = createSharedMemoryRepository(pool, {
      resolvePersonalEncryptionProvider: () => privacyProvider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider,
      resolveTeamEncryptionProvider: (input) => {
        if (input.purpose === "decrypt") keyResolutionCalls += 1;
        return provider;
      },
      afterSharedMemorySemanticClaimForTest: async () => {
        boundaryCalls += 1;
        await pool.query(
          `update team_memory_share_grants
              set lifecycle='revoked',revoked_at=now(),
                  revoked_by_user_id=$2,revocation_reason='semantic_claim_race'
            where id=$1`,
          [grant.shareGrantId, fixture.ownerUserId]
        );
      }
    });
    const decrypts = decryptSpy.mock.calls.length;

    await expect(
      raceRepository.listPendingSharedMemorySemanticItems({
        limit: 100,
        duringAuthorizedLease: async () => {
          embeddingHandoffCalls += 1;
        }
      })
    ).resolves.toEqual([]);

    expect(boundaryCalls).toBe(1);
    expect(keyResolutionCalls).toBe(0);
    expect(embeddingHandoffCalls).toBe(0);
    expect(decryptSpy.mock.calls.length).toBe(decrypts);
  });

  it("holds exact authorization through embedding handoff while revocation waits without deadlock", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "semantic-lease-race" });
    await materialize(fixture, grant, { label: "semantic-lease-race" });
    const revocationClient = await pool.connect();
    const backend = await revocationClient.query<{ pid: number }>(
      "select pg_backend_pid()::integer pid"
    );
    let revocationUpdate: Promise<pg.QueryResult> | null = null;
    let handoffCalls = 0;
    const raceRepository = createSharedMemoryRepository(pool, {
      resolvePersonalEncryptionProvider: () => privacyProvider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider,
      resolveTeamEncryptionProvider: () => provider,
      afterSharedMemorySemanticDecryptForTest: async () => {
        await revocationClient.query("begin");
        revocationUpdate = revocationClient.query(
          `update team_memory_share_grants
              set lifecycle='revoked',revoked_at=now(),
                  revoked_by_user_id=$2,revocation_reason='semantic_lease_race'
            where id=$1`,
          [grant.shareGrantId, fixture.ownerUserId]
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waiting = await pool.query<{ waiting: boolean }>(
            `select coalesce(bool_or(wait_event_type='Lock'),false) waiting
               from pg_stat_activity where pid=$1`,
            [backend.rows[0]!.pid]
          );
          if (waiting.rows[0]?.waiting) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("revocation did not wait on the semantic lease");
      }
    });

    try {
      const leased = await raceRepository.listPendingSharedMemorySemanticItems({
        limit: 100,
        duringAuthorizedLease: async () => {
          handoffCalls += 1;
        }
      });
      const pendingRevocation =
        revocationUpdate as Promise<pg.QueryResult> | null;
      if (!pendingRevocation) {
        throw new Error("revocation did not start during the semantic lease");
      }
      await pendingRevocation;
      await revocationClient.query("commit");
      expect(leased.length).toBeGreaterThan(0);
      expect(handoffCalls).toBeGreaterThan(0);
    } finally {
      await revocationClient.query("rollback").catch(() => undefined);
      revocationClient.release();
    }
  });

  it("freezes a Memory Answer grant set while revocation and regrant fail closed", async () => {
    const fixture = await createWorkspaceFixture();
    const initialGrant = await createGrant(fixture, {
      label: "answer-boundary-initial"
    });
    await materialize(fixture, initialGrant, {
      label: "answer-boundary-initial"
    });
    const model = "answer-boundary-model";
    const version = "answer-boundary-v1";
    const vector = [1, ...Array.from({ length: 383 }, () => 0)];
    const embedGrant = async (shareGrantId: string) => {
      const items = (
        await repository.listPendingSharedMemorySemanticItems({ limit: 100 })
      ).filter((item) => item.shareGrantId === shareGrantId);
      for (const item of items) {
        await repository.storeSharedMemorySemanticEmbedding({
          semanticItemId: item.semanticItemId,
          contentHash: item.contentHash,
          model,
          dimensions: 384,
          version,
          vector
        });
      }
    };
    await embedGrant(initialGrant.shareGrantId);
    await pool.query(
      `update users
          set updated_at='2026-08-11 01:02:03.123456+00'::timestamptz
        where id=$1`,
      [fixture.readerUserId]
    );
    const preciseUserTimestamp = await pool.query<{ updated_at: string }>(
      `select updated_at::text as updated_at from users where id=$1`,
      [fixture.readerUserId]
    );
    expect(preciseUserTimestamp.rows[0]?.updated_at).toContain(".123456");
    const boundary = await repository.freezeSharedMemorySemanticRecallBoundary(
      actor(fixture.readerUserId),
      { teamWorkspaceId: fixture.teamWorkspaceId, maximumGrantCount: 128 }
    );
    expect(boundary.shareGrantIds).toContain(initialGrant.shareGrantId);
    await expect(
      repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          queryVector: vector,
          model,
          dimensions: 384,
          version,
          limit: 50,
          searchDomain: "global",
          authorizationBoundary: boundary
        }
      )
    ).resolves.not.toEqual([]);

    const laterGrant = await createGrant(fixture, {
      label: "answer-boundary-later"
    });
    await materialize(fixture, laterGrant, { label: "answer-boundary-later" });
    await embedGrant(laterGrant.shareGrantId);
    const search = (authorizationBoundary = boundary) =>
      repository.searchAuthorizedSharedMemorySemanticItems(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          queryVector: vector,
          model,
          dimensions: 384,
          version,
          limit: 50,
          searchDomain: "global",
          authorizationBoundary
        }
      );
    const frozen = await search();
    expect(new Set(frozen.map((item) => item.shareGrantId))).toEqual(
      new Set([initialGrant.shareGrantId])
    );
    const current = await repository.searchAuthorizedSharedMemorySemanticItems(
      actor(fixture.readerUserId),
      {
        teamWorkspaceId: fixture.teamWorkspaceId,
        queryVector: vector,
        model,
        dimensions: 384,
        version,
        limit: 50,
        searchDomain: "global"
      }
    );
    const laterCandidate = current.find(
      (item) => item.shareGrantId === laterGrant.shareGrantId
    );
    expect(laterCandidate).toBeDefined();
    await expect(
      repository.expandAuthorizedSharedMemorySemanticItem(
        actor(fixture.readerUserId),
        {
          teamWorkspaceId: fixture.teamWorkspaceId,
          candidateId: laterCandidate!.candidateId,
          searchDomain: "global",
          authorizationBoundary: boundary
        }
      )
    ).resolves.toBeNull();

    await pool.query(
      `update team_workspace_access_grants
          set access='disabled',disabled_at=now(),version=version+1,updated_at=now()
        where team_workspace_id=$1 and user_id=$2`,
      [fixture.teamWorkspaceId, fixture.readerUserId]
    );
    await expect(search()).resolves.toEqual([]);
    await pool.query(
      `update team_workspace_access_grants
          set access='read',disabled_at=null,version=version+1,updated_at=now()
        where team_workspace_id=$1 and user_id=$2`,
      [fixture.teamWorkspaceId, fixture.readerUserId]
    );
    await expect(search()).resolves.toEqual([]);
  });

  it("preserves exact rollup fidelity and policy provenance through owner-private sync and Team materialization", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      representation: "lcm_rollups",
      label: "rollup-fidelity"
    });
    expect(grant.preview.items).toMatchObject([
      {
        itemType: "lcm_rollup",
        schemaVersion: 1,
        sourceId: grant.rollup.nodeId,
        sourceLogicalMemoryId: grant.logicalMemoryId,
        sourceRevision: 1,
        occurredAt: occurredAtFor(13),
        content: {
          title: "rollup-fidelity rollup",
          summaryText: "rollup-fidelity synthesized rollup summary",
          lexicalAnchors: ["rollup-fidelity"],
          sourceIds: grant.rollup.sourceEventIds,
          expansionItems: [
            {
              itemType: "lcm_leaf",
              schemaVersion: 1,
              sourceId: grant.leaf.nodeId,
              sourceLogicalMemoryId: grant.logicalMemoryId,
              sourceRevision: 1,
              occurredAt: occurredAtFor(13),
              content: {
                title: "rollup-fidelity leaf",
                summaryText: "rollup-fidelity synthesized source summary",
                lexicalAnchors: ["rollup-fidelity"],
                sourceIds: grant.leaf.sourceEventIds,
                expansionItems: [
                  {
                    itemType: "user_message",
                    schemaVersion: 1,
                    sourceId: deterministicUuid(
                      grant.logicalMemoryId,
                      "1",
                      "user"
                    ),
                    sourceLogicalMemoryId: grant.logicalMemoryId,
                    sourceRevision: 1,
                    occurredAt: occurredAtFor(10),
                    content: { text: "rollup-fidelity user source" }
                  },
                  {
                    itemType: "assistant_message",
                    schemaVersion: 1,
                    sourceId: deterministicUuid(
                      grant.logicalMemoryId,
                      "1",
                      "assistant"
                    ),
                    sourceLogicalMemoryId: grant.logicalMemoryId,
                    sourceRevision: 1,
                    occurredAt: occurredAtFor(11),
                    content: { text: "rollup-fidelity assistant source" }
                  }
                ]
              }
            }
          ]
        }
      }
    ]);
    const representation = await materialize(fixture, grant);
    const read = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      { shareGrantId: grant.shareGrantId, representation: "lcm_rollups" }
    );
    const previewContent = { ...grant.preview.items[0]!.content };
    delete previewContent.expansionItems;
    expect(read?.items).toEqual([
      {
        itemType: "lcm_rollup",
        schemaVersion: 1,
        sourceId: sharedMemoryGrantScopedSourceId(
          grant.shareGrantId,
          grant.rollup.nodeId
        ),
        sourceLogicalMemoryId: grant.logicalMemoryId,
        sourceRevision: 1,
        occurredAt: occurredAtFor(13),
        content: {
          ...previewContent,
          sourceIds: grant.rollup.sourceEventIds.map((sourceId) =>
            sharedMemoryGrantScopedSourceId(grant.shareGrantId, sourceId)
          )
        }
      }
    ]);
    expect(representation.provenanceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(representation.provenanceHash).not.toBe(
      crossIdentitySyncDigest(grant.preview.items)
    );

    const synchronizedNode = await pool.query<{
      summary_model: string;
      summary_prompt_version: string;
      lcm_algorithm_version: string;
      summary_structured_schema_version: string;
      source_event_count: number;
    }>(
      `select summary_model,summary_prompt_version,lcm_algorithm_version,
              summary_structured_schema_version,source_event_count
         from memory_nodes where id=$1`,
      [grant.rollup.nodeId]
    );
    expect(synchronizedNode.rows[0]).toEqual({
      summary_model: "test-lcm-model",
      summary_prompt_version: "shared-memory-test-v1",
      lcm_algorithm_version: "depth1-child-rollup-v1",
      summary_structured_schema_version: LCM_SUMMARY_SCHEMA_VERSION,
      source_event_count: 1
    });
    const artifact = await pool.query<{
      source_cursor: string;
      package_sequence: string;
      representation_policy_revision: number;
      representation_policy_hash: string;
      content_policy_version: number;
      content_policy_hash: string;
      classifier_version: number;
      classifier_hash: string;
      structural: string;
    }>(
      `select source_cursor::text,package_sequence::text,
              representation_policy_revision,representation_policy_hash,
              content_policy_version,content_policy_hash,
              classifier_version,classifier_hash,
              row_to_json(shared_source_artifacts)::text as structural
         from shared_source_artifacts where id=$1`,
      [grant.preview.artifactId]
    );
    expect(artifact.rows[0]).toMatchObject({
      source_cursor: "1",
      package_sequence: "1",
      representation_policy_revision:
        grant.preview.binding.fidelityPolicyRevision,
      representation_policy_hash: grant.preview.binding.fidelityPolicyHash,
      content_policy_version: grant.preview.binding.contentPolicyVersion,
      content_policy_hash: grant.preview.binding.contentPolicyHash,
      classifier_version: grant.preview.binding.classifierVersion,
      classifier_hash: grant.preview.binding.classifierHash
    });
    expect(artifact.rows[0]?.structural).not.toContain(
      "rollup-fidelity synthesized"
    );
    const ownerEncryptedArtifact = await pool.query<{
      visibility: string;
      encryption_scope: string;
      owner_principal_id: string;
      ciphertext: string;
    }>(
      `select visibility,encryption_scope,owner_principal_id,ciphertext
         from encrypted_field_payloads
        where source_table='shared_source_artifacts'
          and source_id=$1 and invalidated_at is null`,
      [grant.preview.artifactId]
    );
    expect(ownerEncryptedArtifact.rows).toHaveLength(1);
    expect(ownerEncryptedArtifact.rows[0]).toMatchObject({
      visibility: "personal",
      encryption_scope: "owner_private_replica",
      owner_principal_id: grant.ownerPrincipalId
    });
    expect(ownerEncryptedArtifact.rows[0]?.ciphertext).not.toContain(
      "rollup-fidelity"
    );
    const teamChunk = await pool.query<{
      key_id: string;
      aad: Record<string, string | number>;
    }>(
      `select key_id,aad from team_memory_representation_chunks
        where representation_id=$1 and chunk_index=0`,
      [representation.id]
    );
    expect(teamChunk.rows[0]?.key_id).toBe(provider.keyId);
    expect(teamChunk.rows[0]?.key_id).not.toBe(ownerProvider.keyId);
    expect(teamChunk.rows[0]?.aad).toMatchObject({
      representationId: representation.id,
      shareGrantId: grant.shareGrantId,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.teamWorkspaceId,
      logicalMemoryId: grant.logicalMemoryId,
      consentId: grant.consentId,
      representation: "lcm_rollups",
      sourceRevision: String(representation.sourceRevision),
      sourceHash: representation.sourceRevisionHash,
      fidelityPolicyRevision: String(representation.fidelityPolicyRevision),
      fidelityPolicyHash: grant.preview.binding.fidelityPolicyHash,
      contentPolicyVersion: String(representation.contentPolicyVersion),
      contentPolicyHash: representation.effectivePrivacyPolicyHash,
      classifierVersion: String(representation.classifierVersion),
      classifierHash: representation.privacyClassifierHash,
      sourceContentHash: representation.sanitizedContentHash,
      provenanceHash: representation.provenanceHash
    });
    expect(representation.sourceRevisionHash).not.toBe(
      grant.preview.binding.sourceHash
    );
    expect(representation.sanitizedContentHash).toBe(
      grant.preview.sourceContentHash
    );
  });

  it("shares one canonical owner-private replica independently into two Teams without cross-grant correlation", async () => {
    const first = await createWorkspaceFixture();
    const secondReaderUserId = await createUser("Second Team Reader");
    const secondTeam = await pool.query<{ id: string }>(
      "insert into teams (name) values ($1) returning id",
      [`Second Shared Memory Team ${randomUUID()}`]
    );
    const secondTeamId = secondTeam.rows[0]!.id;
    const secondWorkspace = await pool.query<{ id: string }>(
      `insert into team_workspaces (team_id,name)
       values ($1,$2) returning id`,
      [secondTeamId, `Second Shared Memory Workspace ${randomUUID()}`]
    );
    const secondTeamWorkspaceId = secondWorkspace.rows[0]!.id;
    const secondRetentionPolicyId = randomUUID();
    const secondRetentionEffectiveAt = new Date("2020-01-01T00:00:00.000Z");
    await pool.query(
      `insert into retention_policies (
         policy_id, version, scope, team_id, retention_seconds,
         deletion_grace_seconds, backup_retention_seconds, policy_hash,
         created_by_user_id, effective_at
       ) values ($1,1,'team',$2,2592000,0,2592000,$3,$4,$5)`,
      [
        secondRetentionPolicyId,
        secondTeamId,
        crossIdentitySyncDigest({
          policyId: secondRetentionPolicyId,
          version: 1,
          target: { scope: "team", teamId: secondTeamId },
          retentionSeconds: 2_592_000,
          deletionGraceSeconds: 0,
          backupRetentionSeconds: 2_592_000,
          effectiveAt: secondRetentionEffectiveAt.toISOString()
        }),
        first.ownerUserId,
        secondRetentionEffectiveAt
      ]
    );
    await pool.query(
      `insert into team_memberships
         (team_id,user_id,role,status,accepted_at)
       values ($1,$2,'owner','enabled',now()),
              ($1,$3,'member','enabled',now())`,
      [secondTeamId, first.ownerUserId, secondReaderUserId]
    );
    await pool.query(
      `insert into team_workspace_access_grants
         (team_workspace_id,team_id,user_id,access,
          can_share_owned_memory,granted_by_user_id)
       values ($1,$2,$3,'write',true,$3),
              ($1,$2,$4,'read',false,$3)`,
      [
        secondTeamWorkspaceId,
        secondTeamId,
        first.ownerUserId,
        secondReaderUserId
      ]
    );
    const second: WorkspaceFixture = {
      ...first,
      readerUserId: secondReaderUserId,
      teamId: secondTeamId,
      teamWorkspaceId: secondTeamWorkspaceId
    };
    await repository.putTeamPolicy(actor(first.ownerUserId), {
      mutationId: randomUUID(),
      teamId: secondTeamId,
      expectedCurrentVersion: 0,
      ...fidelityConsent(allRepresentations)
    });
    await repository.putWorkspacePolicy(actor(first.ownerUserId), {
      mutationId: randomUUID(),
      teamId: secondTeamId,
      teamWorkspaceId: secondTeamWorkspaceId,
      expectedCurrentVersion: 0,
      ...fidelityConsent(allRepresentations)
    });

    const source = await createSource(first, 1, "two-team-canonical-source");
    await putOwnerPolicy(first, source);
    const secondTeamProvider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 44).toString("base64")
    );
    repository = createSharedMemoryRepository(pool, {
      resolvePersonalEncryptionProvider: () => privacyProvider,
      resolveTeamEncryptionProvider: ({ teamId }) =>
        teamId === secondTeamId ? secondTeamProvider : provider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider
    });

    const createDestinationGrant = async (
      destination: WorkspaceFixture,
      label: string
    ): Promise<GrantFixture> => {
      const created = await createConsent(destination, source, {
        representation: "memory_events",
        mode: "continuous",
        label
      });
      const grant = await repository.createShareGrant(
        actor(first.ownerUserId),
        {
          mutationId: randomUUID(),
          logicalGrantId: randomUUID(),
          consentId: created.consentId,
          authority: authority(destination)
        }
      );
      return {
        ...source,
        consentId: created.consentId,
        shareGrantId: grant.id,
        grantVersion: grant.grantVersion,
        representation: "memory_events",
        maximumFidelity: grant.maximumFidelity,
        includeCuratedMemory: grant.includeCuratedMemory,
        preview: created.preview
      };
    };
    const [firstGrant, secondGrant] = await Promise.all([
      createDestinationGrant(first, "first-team"),
      createDestinationGrant(second, "second-team")
    ]);
    const firstRepresentation = await materialize(first, firstGrant);
    const secondRepresentation = await materialize(second, secondGrant);
    expect(firstGrant.remoteReplicaId).toBe(secondGrant.remoteReplicaId);
    expect(firstGrant.shareGrantId).not.toBe(secondGrant.shareGrantId);
    expect(firstRepresentation.id).not.toBe(secondRepresentation.id);

    const firstRead = await repository.readGrantRepresentation(
      actor(first.readerUserId),
      {
        shareGrantId: firstGrant.shareGrantId,
        representation: firstGrant.representation
      }
    );
    const secondRead = await repository.readGrantRepresentation(
      actor(second.readerUserId),
      {
        shareGrantId: secondGrant.shareGrantId,
        representation: secondGrant.representation
      }
    );
    expect(firstRead?.items.map((item) => item.content)).toEqual(
      secondRead?.items.map((item) => item.content)
    );
    expect(firstRead?.items.map((item) => item.sourceId)).not.toEqual(
      secondRead?.items.map((item) => item.sourceId)
    );
    await expect(
      repository.readGrantRepresentation(actor(first.readerUserId), {
        shareGrantId: secondGrant.shareGrantId,
        representation: secondGrant.representation
      })
    ).resolves.toBeNull();
    await expect(
      repository.readGrantRepresentation(actor(second.readerUserId), {
        shareGrantId: firstGrant.shareGrantId,
        representation: firstGrant.representation
      })
    ).resolves.toBeNull();

    const decryptsBeforeCanonicalGuesses = decryptCount();
    for (const guessedId of [
      source.remoteReplicaId,
      source.logicalMemoryId,
      source.syncRelationshipId
    ]) {
      await expect(
        repository.readGrantRepresentation(actor(first.readerUserId), {
          shareGrantId: guessedId,
          representation: "memory_events"
        })
      ).resolves.toBeNull();
    }
    await expect(
      repository.createAuthoritativeSourcePreview(actor(first.readerUserId), {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        remoteReplicaId: source.remoteReplicaId,
        teamId: first.teamId,
        teamWorkspaceId: first.teamWorkspaceId,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: authority(first)
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
    expect(decryptCount()).toBe(decryptsBeforeCanonicalGuesses);
    const teamEvents = await pool.query<{ event: string }>(
      `select row_to_json(collaboration_outbox)::text as event
         from collaboration_outbox
        where share_grant_id=any($1::uuid[])`,
      [[firstGrant.shareGrantId, secondGrant.shareGrantId]]
    );
    expect(teamEvents.rows.length).toBeGreaterThan(0);
    for (const row of teamEvents.rows) {
      expect(row.event).not.toContain(source.remoteReplicaId);
      expect(row.event).not.toContain(source.syncRelationshipId);
      expect(row.event).not.toContain(source.ownerPrincipalId);
    }
    const teamKeys = await pool.query<{
      share_grant_id: string;
      key_id: string;
    }>(
      `select share_grant_id,key_id
         from team_memory_representation_chunks
        where share_grant_id=any($1::uuid[])
        order by share_grant_id`,
      [[firstGrant.shareGrantId, secondGrant.shareGrantId]]
    );
    expect(new Set(teamKeys.rows.map((row) => row.key_id))).toEqual(
      new Set([provider.keyId, secondTeamProvider.keyId])
    );

    const exclusionReview =
      await repository.getWorkspaceConversationExclusionReview(
        actor(first.ownerUserId),
        {
          logicalMemoryId: source.logicalMemoryId,
          teamId: first.teamId,
          teamWorkspaceId: first.teamWorkspaceId
        }
      );
    await repository.excludeWorkspaceConversation(actor(first.ownerUserId), {
      mutationId: randomUUID(),
      scope: exclusionReview!.scope,
      authority: authority(first)
    });
    expect(
      await repository.readGrantRepresentation(actor(first.readerUserId), {
        shareGrantId: firstGrant.shareGrantId,
        representation: firstGrant.representation
      })
    ).toBeNull();
    expect(
      await repository.readGrantRepresentation(actor(second.readerUserId), {
        shareGrantId: secondGrant.shareGrantId,
        representation: secondGrant.representation
      })
    ).toMatchObject({ freshness: "fresh" });
    await repository.revokeShareGrant(actor(first.ownerUserId), {
      mutationId: randomUUID(),
      shareGrantId: firstGrant.shareGrantId,
      expectedGrantVersion: firstGrant.grantVersion + 1,
      reasonCode: "first_team_only",
      authority: authority(first)
    });
    await expect(
      repository.readGrantRepresentation(actor(first.readerUserId), {
        shareGrantId: firstGrant.shareGrantId,
        representation: firstGrant.representation
      })
    ).resolves.toBeNull();
    await expect(
      repository.readGrantRepresentation(actor(second.readerUserId), {
        shareGrantId: secondGrant.shareGrantId,
        representation: secondGrant.representation
      })
    ).resolves.toMatchObject({ freshness: "fresh" });
    const canonicalReplica = await pool.query<{
      lifecycle: string;
      disabled_at: Date | null;
      grant_count: string;
    }>(
      `select replica.lifecycle,replica.disabled_at,
              (select count(*) from team_memory_share_grants
                where remote_replica_id=replica.id)::text as grant_count
         from memory_replicas replica where replica.id=$1`,
      [source.remoteReplicaId]
    );
    expect(canonicalReplica.rows[0]).toEqual({
      lifecycle: "active",
      disabled_at: null,
      grant_count: "2"
    });
  });

  it("lists current owner grant state even when Team reading is unavailable", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "owner-state" });
    const active = await repository.listOwnerGrants(
      actor(fixture.ownerUserId),
      { logicalMemoryId: grant.logicalMemoryId, limit: 10, offset: 0 }
    );
    expect(active).toMatchObject({
      hasMore: false,
      entries: [
        {
          id: grant.shareGrantId,
          logicalMemoryId: grant.logicalMemoryId,
          lifecycle: "active",
          grantVersion: grant.grantVersion
        }
      ]
    });

    await pool.query(
      `update team_memory_share_grants
          set lifecycle='unavailable',grant_version=grant_version+1,updated_at=now()
        where id=$1`,
      [grant.shareGrantId]
    );
    const unavailable = await repository.listOwnerGrants(
      actor(fixture.ownerUserId),
      { logicalMemoryId: grant.logicalMemoryId, limit: 1, offset: 0 }
    );
    expect(unavailable.entries).toMatchObject([
      {
        id: grant.shareGrantId,
        lifecycle: "unavailable",
        grantVersion: grant.grantVersion + 1
      }
    ]);
    await expect(
      repository.listOwnerGrants(actor(fixture.readerUserId), {
        logicalMemoryId: grant.logicalMemoryId,
        limit: 10,
        offset: 0
      })
    ).resolves.toMatchObject({ entries: [], hasMore: false });

    await expect(
      repository.listOwnerGrants(actor(fixture.ownerUserId), {
        logicalMemoryId: randomUUID(),
        limit: 10,
        offset: 0
      })
    ).resolves.toMatchObject({ entries: [], hasMore: false });
  });

  it("keeps existing Team snapshots while new shares use current context and captures continue", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "snapshot-stability");
    await putOwnerPolicy(fixture, source);
    const setContext = async (fingerprint: string | null) =>
      pool.query(
        "update sessions set metadata=(metadata-'repositorySnapshotMetadataEnvelope') || $2::jsonb where id=$1",
        [
          source.localSessionId,
          JSON.stringify({
            syncReplica: true,
            repositorySnapshot: {
              version: 1,
              classification: fingerprint
                ? "portable_repository"
                : "unresolved",
              fingerprint,
              label: null,
              branchObservation: null
            }
          })
        ]
      );
    const share = async (destination: WorkspaceFixture) => {
      const consent = await createConsent(destination, source, {
        representation: "memory_events",
        mode: "continuous",
        label: "snapshot-stability"
      });
      const grant = await repository.createShareGrant(
        actor(fixture.ownerUserId),
        {
          mutationId: randomUUID(),
          logicalGrantId: randomUUID(),
          consentId: consent.consentId,
          authority: authority(fixture)
        }
      );
      await prepareSanitizedSemanticPreview(
        fixture.ownerUserId,
        consent.preview
      );
      return grant;
    };
    await setContext("gr_original");
    const first = await share(fixture);
    await setContext("gr_reassigned");
    const workspace = await pool.query<{ id: string }>(
      "insert into team_workspaces(team_id,name) values($1,'Second snapshot Workspace') returning id",
      [fixture.teamId]
    );
    const secondFixture = {
      ...fixture,
      teamWorkspaceId: workspace.rows[0]!.id
    };
    await pool.query(
      "insert into team_workspace_access_grants(team_workspace_id,team_id,user_id,access,can_share_owned_memory,granted_by_user_id) values($1,$2,$3,'write',true,$3)",
      [secondFixture.teamWorkspaceId, fixture.teamId, fixture.ownerUserId]
    );
    await repository.putWorkspacePolicy(actor(fixture.ownerUserId), {
      mutationId: randomUUID(),
      teamId: fixture.teamId,
      teamWorkspaceId: secondFixture.teamWorkspaceId,
      expectedCurrentVersion: 0,
      ...fidelityConsent(allRepresentations)
    });
    const second = await share(secondFixture);
    expect(first.repositorySnapshot?.fingerprint).toBe("gr_original");
    expect(second.repositorySnapshot?.fingerprint).toBe("gr_reassigned");
    const snapshotRows = () =>
      pool.query<{ row: unknown }>(
        "select to_jsonb(g) as row from team_memory_share_grants g where id=any($1::uuid[]) order by id",
        [[first.id, second.id]]
      );
    const snapshotsBeforeCorrection = await snapshotRows();
    const sourceContext = createPersonalSourceCorrectionRepository(pool),
      sourceActor = actor(fixture.ownerUserId);
    for (const axis of ["git", "folder"] as const) {
      const current = (
        await sourceContext.getPersonalSourceContext(
          sourceActor,
          source.localSessionId
        )
      ).context;
      const expectedVersion =
        axis === "git" ? current.git.revision : current.folder.revision;
      const review = await sourceContext.previewPersonalSourceCorrection(
        sourceActor,
        source.localSessionId,
        { axis, action: "unresolved", expectedVersion }
      );
      await sourceContext.applyPersonalSourceCorrection(
        sourceActor,
        source.localSessionId,
        review.preview.reviewId,
        { expectedVersion }
      );
    }
    let correctedContext = (
      await sourceContext.getPersonalSourceContext(
        sourceActor,
        source.localSessionId
      )
    ).context;
    expect(correctedContext.git.correction.state).toBe("corrected");
    expect(correctedContext.folder.correction.state).toBe("corrected");
    expect((await snapshotRows()).rows).toEqual(snapshotsBeforeCorrection.rows);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const grantsBefore = await client.query<{ row: unknown }>(
        "select to_jsonb(g) as row from team_memory_share_grants g where id=any($1::uuid[]) order by id",
        [[first.id, second.id]]
      );
      const sessionBefore = await client.query<{
        row: Record<string, unknown>;
      }>("select to_jsonb(s) as row from sessions s where id=$1", [
        source.localSessionId
      ]);
      const recallMigration = await readFile(
        new URL("../drizzle/0046_project_scoped_recall.sql", import.meta.url),
        "utf8"
      );
      // Exercise the one-time data transition against existing Share Grants.
      // Schema creation already ran before this runtime fixture was populated.
      const cutover = recallMigration.slice(
        recallMigration.indexOf(
          "LOCK TABLE sessions IN SHARE ROW EXCLUSIVE MODE;"
        )
      );
      expect(cutover).toContain("UPDATE sessions");
      await client.query(cutover);
      expect(
        (
          await client.query<{ row: unknown }>(
            "select to_jsonb(g) as row from team_memory_share_grants g where id=any($1::uuid[]) order by id",
            [[first.id, second.id]]
          )
        ).rows
      ).toEqual(grantsBefore.rows);
      expect(
        (
          await client.query<{ row: Record<string, unknown> }>(
            "select to_jsonb(s) as row from sessions s where id=$1",
            [source.localSessionId]
          )
        ).rows[0]!.row
      ).toEqual({
        ...sessionBefore.rows[0]!.row,
        repository_assignment_state: "historical_unresolved",
        repository_automatic_identity: null,
        repository_override_identity: null,
        repository_assignment_version:
          Number(sessionBefore.rows[0]!.row.repository_assignment_version) + 1
      });
    } finally {
      await client.query("rollback");
      client.release();
    }

    const devices = personalSourceDeviceFixture();
    await devices.initialize(pool, devices.origin, fixture.ownerUserId);
    const bindingClient = await pool.connect();
    let verifiedSnapshot;
    try {
      await bindingClient.query("begin");
      verifiedSnapshot = await preparePersonalSourceContextSnapshot(
        bindingClient,
        {
          ownerUserId: fixture.ownerUserId,
          localSessionId: source.localSessionId,
          originatingDeploymentId: devices.origin.deploymentId,
          originatingDeviceId: devices.origin.deviceId
        }
      );
      await bindingClient.query("commit");
    } catch (error) {
      await bindingClient.query("rollback");
      throw error;
    } finally {
      bindingClient.release();
    }
    const correctionId = randomUUID();
    const correctedGit = {
      ...verifiedSnapshot.context.git,
      revision: verifiedSnapshot.context.git.revision + 1,
      correction: { state: "original" as const }
    };
    const correctionSnapshot = personalSourceContextSnapshotSchema.parse({
      ...verifiedSnapshot,
      context: { ...verifiedSnapshot.context, git: correctedGit },
      git: {
        head: correctionId,
        revisions: [
          ...verifiedSnapshot.git.revisions,
          {
            revisionId: correctionId,
            replaces: [verifiedSnapshot.git.head],
            assignment: correctedGit
          }
        ]
      }
    });
    const signedCorrection = signPersonalConfigurationRecord(
      {
        protocol: PERSONAL_CONFIGURATION_PROTOCOL,
        groupId: devices.groupId,
        authorDeviceId: devices.receiver.deviceId,
        authorSigningKeyId: devices.receiver.signingKeyId,
        payload: {
          kind: "source_context",
          snapshot: encodePdsPersonalSourceContextSnapshot(correctionSnapshot)
        }
      },
      devices.receiver.signing.privateKey
    );
    const configurationEncryption =
      createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 115).toString("base64")
      );
    const appliedCorrection = await createPersonalConfigurationRecordRepository(
      pool
    ).retainPersonalConfiguration({
      userId: fixture.ownerUserId,
      groupId: devices.groupId,
      record: signedCorrection,
      direction: "inbound",
      expectedEpoch: devices.epoch,
      expectedAuthorityHead: devices.authorityHead,
      encryptedEnvelope: await configurationEncryption.encrypt({
        plaintext: canonicalizePdsJson(signedCorrection),
        scope: { tenantId: fixture.ownerUserId },
        provenance: { rowFamily: "personal_configuration_records" },
        ciphertextLocation: "fixture"
      })
    });
    expect(appliedCorrection.applied).toBe(true);
    correctedContext = (
      await sourceContext.getPersonalSourceContext(
        sourceActor,
        source.localSessionId
      )
    ).context;
    expect(correctedContext.sync?.git.frontier).toEqual([correctionId]);
    expect(correctedContext.git.correction).toEqual({ state: "original" });
    expect((await snapshotRows()).rows).toEqual(snapshotsBeforeCorrection.rows);

    const personal = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: configurationEncryption
    });
    const grouping = await personal.createNamedPersonalProject(sourceActor, {
      name: "Personal snapshot grouping"
    });
    const membershipScope = {
      userId: fixture.ownerUserId,
      groupId: devices.groupId,
      authorDeviceId: devices.origin.deviceId,
      authorSigningKeyId: devices.origin.signingKeyId,
      originatingDeploymentId: devices.origin.deploymentId,
      expectedEpoch: devices.epoch,
      expectedAuthorityHead: devices.authorityHead
    };
    await personal.personalConfiguration!.listPersonalConfigurationCatalogSnapshots(
      membershipScope
    );
    const included = await personal.addPersonalProjectSession(
      sourceActor,
      grouping.projectId,
      {
        sessionId: source.localSessionId,
        expectedVersion: grouping.version
      }
    );
    const organizationRule = await personal.addPersonalProjectRepositoryRule(
      sourceActor,
      grouping.projectId,
      {
        expectedVersion: included.project.version,
        repository: {
          kind: "portable_repository",
          key: "gr_team_snapshot_rule",
          root: "/fixture/team-rule",
          branch: "main",
          reason: "origin",
          checkoutId: "team-rule-checkout",
          originatingDeviceId: devices.origin.deviceId,
          selectedRemote: "origin",
          anchorDisplay: "example.test/team-rule"
        }
      }
    );
    const excludedFromGrouping = await personal.excludePersonalProjectSession(
      sourceActor,
      grouping.projectId,
      {
        sessionId: source.localSessionId,
        expectedVersion: organizationRule.project.version
      }
    );
    expect(excludedFromGrouping.explanation.included).toBe(false);
    expect((await snapshotRows()).rows).toEqual(snapshotsBeforeCorrection.rows);
    const exclusion = excludedFromGrouping.explanation.exclusion!;
    await personal.restorePersonalProjectSession(
      sourceActor,
      grouping.projectId,
      {
        sessionId: source.localSessionId,
        expectedVersion: excludedFromGrouping.project.version,
        exclusionId: exclusion.exclusionId,
        expectedExclusionRevisionId: exclusion.headRevisionId
      }
    );
    expect((await snapshotRows()).rows).toEqual(snapshotsBeforeCorrection.rows);
    const catalogPage =
      await personal.personalConfiguration!.listPersonalConfigurationCatalogSnapshots(
        membershipScope
      );
    const retainedCatalog = catalogPage.snapshots.find(
      (value) => value.project.projectId === grouping.projectId
    )!;
    const peerRevisionId = randomUUID();
    const renamedCatalog = {
      ...retainedCatalog,
      revisions: [
        ...retainedCatalog.revisions,
        {
          version: 1 as const,
          project: retainedCatalog.project,
          entityId: retainedCatalog.entityId,
          revisionId: peerRevisionId,
          authorDeviceId: devices.receiver.deviceId,
          replaces: evaluatePersonalMembershipRevisions(
            retainedCatalog.revisions
          ).heads,
          operation: {
            kind: "set_project" as const,
            name: "Peer renamed grouping"
          }
        }
      ]
    };
    const signedMembership = signPersonalConfigurationRecord(
      {
        protocol: PERSONAL_CONFIGURATION_PROTOCOL,
        groupId: devices.groupId,
        authorDeviceId: devices.receiver.deviceId,
        authorSigningKeyId: devices.receiver.signingKeyId,
        payload: {
          kind: "project_membership",
          snapshot: encodePdsPersonalMembershipEntitySnapshot(renamedCatalog)
        }
      },
      devices.receiver.signing.privateKey
    );
    expect(
      (
        await personal.personalConfiguration!.retainPersonalConfiguration({
          userId: fixture.ownerUserId,
          groupId: devices.groupId,
          record: signedMembership,
          direction: "inbound",
          localDevice: {
            deviceId: devices.origin.deviceId,
            signingKeyId: devices.origin.signingKeyId,
            originatingDeploymentId: devices.origin.deploymentId
          },
          expectedEpoch: devices.epoch,
          expectedAuthorityHead: devices.authorityHead,
          encryptedEnvelope: await configurationEncryption.encrypt({
            plaintext: canonicalizePdsJson(signedMembership),
            scope: { tenantId: fixture.ownerUserId },
            provenance: { rowFamily: "personal_configuration_records" },
            ciphertextLocation: "fixture"
          })
        })
      ).applied
    ).toBe(true);
    const afterRename = await personal.getPersonalMembershipSyncState(
      sourceActor,
      grouping.projectId
    );
    expect(afterRename.project.name).toBe("Peer renamed grouping");
    const removed = await personal.removePersonalProjectInclusion(
      sourceActor,
      grouping.projectId,
      included.membership.inclusionId,
      { expectedVersion: afterRename.project.version }
    );
    const removedRule = await personal.removePersonalProjectRule(
      sourceActor,
      grouping.projectId,
      organizationRule.rule.inclusionId,
      { expectedVersion: removed.project.version }
    );
    await personal.deleteNamedPersonalProject(sourceActor, grouping.projectId, {
      expectedVersion: removedRule.project.version
    });
    expect((await snapshotRows()).rows).toEqual(snapshotsBeforeCorrection.rows);
    expect(
      (
        await sourceContext.getPersonalSourceContext(
          sourceActor,
          source.localSessionId
        )
      ).context
    ).toEqual(correctedContext);

    await ensureSourceRevision(fixture, source, 2, "continued-capture");
    expect(
      (
        await sourceContext.getPersonalSourceContext(
          sourceActor,
          source.localSessionId
        )
      ).context
    ).toEqual(correctedContext);
    expect((await snapshotRows()).rows).toEqual(snapshotsBeforeCorrection.rows);

    await repository.advanceContinuousGrantRepresentations({
      remoteReplicaId: source.remoteReplicaId,
      sourceRevision: 2
    });
    await flushSanitizedSemanticPublication();
    for (const fingerprint of [null, "gr_anchor_changed", "gr_original"]) {
      await setContext(fingerprint);
      const snapshots = await pool.query<{
        id: string;
        repository_snapshot: { fingerprint: string };
      }>(
        "select id,repository_snapshot from team_memory_share_grants where id=any($1::uuid[])",
        [[first.id, second.id]]
      );
      expect(
        snapshots.rows.find((row) => row.id === first.id)?.repository_snapshot
          .fingerprint
      ).toBe("gr_original");
      expect(
        snapshots.rows.find((row) => row.id === second.id)?.repository_snapshot
          .fingerprint
      ).toBe("gr_reassigned");
    }
  });

  it("queues assignment-only source work and retries context changed during an in-flight acknowledgement", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 0, "assignment-only");
    // This empty owned Session is a source-side fixture; no replicated event
    // payloads are reinterpreted or decrypted by this queue/ack regression.
    await pool.query(
      "update memory_replicas set replica_role='source',encryption_scope='personal' where id=$1",
      [source.remoteReplicaId]
    );
    await pool.query(
      "update cross_identity_sync_relationships set side='source',device_credential_id=null where id=$1",
      [source.syncRelationshipId]
    );
    const identity = {
      kind: "portable_repository",
      key: "gr_after_edit",
      root: "/fixture/source",
      branch: null,
      reason: "origin",
      checkoutId: "fixture_checkout",
      originatingDeviceId: "fixture_device",
      selectedRemote: "origin",
      anchorDisplay: null
    };
    await pool.query(
      "update sessions set repository_override_identity=$2::jsonb,repository_assignment_version=repository_assignment_version+1 where id=$1",
      [source.localSessionId, JSON.stringify(identity)]
    );
    const queued = await pool.query<{ payload_manifest: { kind: string } }>(
      "select payload_manifest from sync_outbox_entries where sync_relationship_id=$1",
      [source.syncRelationshipId]
    );
    expect(
      queued.rows.some(
        (row) => row.payload_manifest.kind === "repository_assignment"
      )
    ).toBe(true);
    const oldHash = crossIdentitySyncDigest({
      version: 1,
      classification: "unresolved",
      fingerprint: null,
      label: null,
      branchObservation: null
    });
    const packageId = randomUUID();
    const acknowledgement = {
      relationshipId: source.syncRelationshipId,
      packageId,
      sourceCursor: 0,
      targetProcessingCursor: 0,
      packageSequence: 1,
      summaryRevisionHash: null,
      repositorySnapshotHash: oldHash,
      staleAfterSeconds: 3600
    };
    await syncRepository.acknowledgeSourceSyncPackage(acknowledgement);
    const after = await pool.query<{
      source_cursor: string;
      source_repository_snapshot_hash: string;
    }>(
      "select source_cursor,source_repository_snapshot_hash from cross_identity_sync_relationships where id=$1",
      [source.syncRelationshipId]
    );
    expect(Number(after.rows[0]!.source_cursor)).toBe(0);
    expect(after.rows[0]!.source_repository_snapshot_hash).toBe(oldHash);
    const followup = await pool.query<{ idempotency_key: string }>(
      "select idempotency_key from sync_outbox_entries where sync_relationship_id=$1 and payload_manifest->>'kind'='repository_snapshot'",
      [source.syncRelationshipId]
    );
    expect(followup.rows).toHaveLength(1);
    await syncRepository.acknowledgeSourceSyncPackage(acknowledgement);
    expect(
      (
        await pool.query(
          "select id from sync_outbox_entries where sync_relationship_id=$1 and payload_manifest->>'kind'='repository_snapshot'",
          [source.syncRelationshipId]
        )
      ).rows
    ).toHaveLength(1);
    const currentHash = crossIdentitySyncDigest({
      version: 1,
      classification: "portable_repository",
      fingerprint: "gr_after_edit",
      label: null,
      branchObservation: null
    });
    await syncRepository.acknowledgeSourceSyncPackage({
      ...acknowledgement,
      packageId: randomUUID(),
      packageSequence: 2,
      repositorySnapshotHash: currentHash
    });
    expect(
      (
        await pool.query<{ source_repository_snapshot_hash: string }>(
          "select source_repository_snapshot_hash from cross_identity_sync_relationships where id=$1",
          [source.syncRelationshipId]
        )
      ).rows[0]!.source_repository_snapshot_hash
    ).toBe(currentHash);
  });

  it("publishes only the sanitized Project label from the original Share Grant source revision", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "project-label");
    const privateSnapshot = {
      version: 1,
      classification: "portable_repository",
      fingerprint: "gr_label_fixture",
      label: "Alice's Project",
      branchObservation: "Alice/release"
    } as const;
    await pool.query(
      "update sessions set metadata=metadata || $2::jsonb where id=$1",
      [
        source.localSessionId,
        JSON.stringify({
          syncReplica: true,
          repositorySnapshot: {
            ...privateSnapshot,
            label: null,
            branchObservation: null
          }
        })
      ]
    );
    const snapshotClient = await pool.connect();
    try {
      await writeOwnerPrivateRepositorySnapshot(
        snapshotClient,
        ownerProvider,
        {
          sessionId: source.localSessionId,
          ownerUserId: fixture.ownerUserId,
          ownerPrincipalId: source.ownerPrincipalId
        },
        privateSnapshot
      );
    } finally {
      snapshotClient.release();
    }
    const metadata = await pool.query<{ metadata: unknown }>(
      "select metadata from sessions where id=$1",
      [source.localSessionId]
    );
    expect(JSON.stringify(metadata.rows[0]!.metadata)).not.toMatch(
      /Alice|release/
    );
    await putOwnerPolicy(fixture, source);
    const preview = await repository.createAuthoritativeSourcePreview(
      actor(fixture.ownerUserId),
      {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        remoteReplicaId: source.remoteReplicaId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: authority(fixture)
      }
    );
    const consentId = randomUUID();
    await repository.createSourceOwnerConsent(actor(fixture.ownerUserId), {
      source: preview.source!,
      sourceCapabilities: preview.sourceCapabilities,
      activationRepresentation: preview.activationRepresentation,
      consentId,
      mode: "continuous",
      ...fidelityConsent(allRepresentations),
      authority: authority(fixture),
      preview
    });
    const grant = await repository.createShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId,
        authority: authority(fixture)
      }
    );
    expect(grant.repositorySnapshot).toEqual({
      ...privateSnapshot,
      label: null,
      branchObservation: null
    });
    await prepareSanitizedSemanticPreview(
      fixture.ownerUserId,
      preview,
      repository,
      (text) => text.replaceAll("Alice", "[PERSON_1]")
    );
    await flushSanitizedSemanticPublication();
    const stored = await pool.query<{
      repository_snapshot: unknown;
      repository_snapshot_source_revision: string;
    }>(
      "select repository_snapshot,repository_snapshot_source_revision from team_memory_share_grants where id=$1",
      [grant.id]
    );
    expect(stored.rows[0]!.repository_snapshot).toEqual({
      ...privateSnapshot,
      label: "[PERSON_1]'s Project",
      branchObservation: "[PERSON_1]/release"
    });
    expect(Number(stored.rows[0]!.repository_snapshot_source_revision)).toBe(1);
    await pool.query(
      "update sessions set metadata=(metadata-'repositorySnapshotMetadataEnvelope') || $2::jsonb where id=$1",
      [
        source.localSessionId,
        JSON.stringify({
          repositorySnapshot: {
            ...privateSnapshot,
            fingerprint: "gr_moved",
            label: null,
            branchObservation: null
          }
        })
      ]
    );
    expect(
      (
        await pool.query<{ repository_snapshot: unknown }>(
          "select repository_snapshot from team_memory_share_grants where id=$1",
          [grant.id]
        )
      ).rows[0]!.repository_snapshot
    ).toEqual(stored.rows[0]!.repository_snapshot);
    const review = await repository.reviewGrantRepositorySnapshot(
      actor(fixture.ownerUserId),
      {
        shareGrantId: grant.id,
        authority: authority(fixture)
      }
    );
    expect(review.currentSnapshot).toMatchObject({
      fingerprint: "gr_moved",
      label: null,
      branchObservation: null
    });
    await pool.query(
      "update sessions set metadata=jsonb_set(metadata,'{repositorySnapshot,fingerprint}',to_jsonb('gr_second_move'::text)),repository_assignment_version=repository_assignment_version+1 where id=$1",
      [source.localSessionId]
    );
    await expect(
      repository.updateGrantRepositorySnapshot(actor(fixture.ownerUserId), {
        mutationId: randomUUID(),
        shareGrantId: grant.id,
        authority: authority(fixture),
        expected: review
      })
    ).rejects.toThrow("review it again");
    const fresh = await repository.reviewGrantRepositorySnapshot(
      actor(fixture.ownerUserId),
      {
        shareGrantId: grant.id,
        authority: authority(fixture)
      }
    );
    const update = {
      mutationId: randomUUID(),
      shareGrantId: grant.id,
      authority: authority(fixture),
      expected: fresh
    };
    const changed = await repository.updateGrantRepositorySnapshot(
      actor(fixture.ownerUserId),
      update
    );
    expect(changed.repositorySnapshot).toMatchObject({
      fingerprint: "gr_second_move",
      label: null,
      branchObservation: null
    });
    expect(changed.grantVersion).toBe(fresh.grantVersion + 1);
    expect(
      (
        await repository.updateGrantRepositorySnapshot(
          actor(fixture.ownerUserId),
          update
        )
      ).grantVersion
    ).toBe(changed.grantVersion);
    await expect(
      repository.updateGrantRepositorySnapshot(actor(fixture.ownerUserId), {
        ...update,
        expected: { ...fresh, assignmentVersion: fresh.assignmentVersion + 1 }
      })
    ).rejects.toThrow("mutation identity was reused");
    await expect(
      repository.reviewGrantRepositorySnapshot(actor(fixture.readerUserId), {
        shareGrantId: grant.id,
        authority: authority(fixture)
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
    const beforeRepresentationChange =
      await repository.reviewGrantRepositorySnapshot(
        actor(fixture.ownerUserId),
        { shareGrantId: grant.id }
      );
    await pool.query(
      "update team_memory_representations set record_version=record_version+1 where id=$1",
      [beforeRepresentationChange.representationId]
    );
    await expect(
      repository.updateGrantRepositorySnapshot(actor(fixture.ownerUserId), {
        mutationId: randomUUID(),
        shareGrantId: grant.id,
        authority: authority(fixture),
        expected: beforeRepresentationChange
      })
    ).rejects.toThrow("review it again");
    await pool.query(
      "update sessions set metadata=(metadata-'repositorySnapshotMetadataEnvelope') || $2::jsonb where id=$1",
      [
        source.localSessionId,
        JSON.stringify({
          repositorySnapshot: {
            version: 1,
            classification: "unresolved",
            fingerprint: null,
            label: null,
            branchObservation: null
          }
        })
      ]
    );
    const unresolvedReview = await repository.reviewGrantRepositorySnapshot(
      actor(fixture.ownerUserId),
      { shareGrantId: grant.id }
    );
    const unresolvedGrant = await repository.updateGrantRepositorySnapshot(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.id,
        authority: authority(fixture),
        expected: unresolvedReview
      }
    );
    expect(unresolvedGrant.repositorySnapshot).toEqual({
      version: 1,
      classification: "unresolved",
      fingerprint: null,
      label: null,
      branchObservation: null
    });
    expect(JSON.stringify(unresolvedGrant.repositorySnapshot)).not.toMatch(
      /gr_label_fixture|gr_second_move|Alice/
    );
    await pool.query(
      "update team_memory_share_grants set lifecycle='revoked',revoked_at=now(),grant_version=grant_version+1 where id=$1",
      [grant.id]
    );
    await expect(
      repository.updateGrantRepositorySnapshot(
        actor(fixture.ownerUserId),
        update
      )
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
  });

  it("rejects sanitized Team material when owner-private and Team encryption keys are not distinct", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "key-boundary");
    await putOwnerPolicy(fixture, source);
    const preview = await repository.createAuthoritativeSourcePreview(
      actor(fixture.ownerUserId),
      {
        ...capturedSourceBinding(source, "memory_events"),
        logicalMemoryId: source.logicalMemoryId,
        remoteReplicaId: source.remoteReplicaId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        mode: "continuous",
        ...fidelityConsent(allRepresentations),
        authority: authority(fixture)
      }
    );
    const consentId = randomUUID();
    await repository.createSourceOwnerConsent(actor(fixture.ownerUserId), {
      source: preview.source!,
      sourceCapabilities: preview.sourceCapabilities,
      activationRepresentation: preview.activationRepresentation,
      consentId,
      mode: "continuous",
      ...fidelityConsent(allRepresentations),
      authority: authority(fixture),
      preview
    });
    const grant = await repository.createShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId,
        authority: authority(fixture)
      }
    );
    repository = createSharedMemoryRepository(pool, {
      resolvePersonalEncryptionProvider: () => privacyProvider,
      resolveTeamEncryptionProvider: () => ownerProvider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider
    });
    await expect(
      prepareSanitizedSemanticPreview(fixture.ownerUserId, preview, repository)
    ).rejects.toThrow(
      "Personal classification, owner-private source, and Team sanitized preview require distinct encryption keys"
    );
    await repository.revokeShareGrant(actor(fixture.ownerUserId), {
      mutationId: randomUUID(),
      shareGrantId: grant.id,
      expectedGrantVersion: grant.grantVersion,
      reasonCode: "invalid_encryption_boundary",
      authority: authority(fixture)
    });
  });

  it.each([false, true])(
    "materializes opted-in Curated assertions independently of rollup-only fidelity and purges them on source invalidation (rule: %s)",
    async (ruleReason) => {
      const personalBase = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 61).toString("base64")
      );
      const ownerBase = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 62).toString("base64")
      );
      const teamBase = createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 63).toString("base64")
      );
      const personalDecrypt = vi.fn(personalBase.decrypt.bind(personalBase));
      const ownerEncrypt = vi.fn(ownerBase.encrypt.bind(ownerBase));
      const teamEncrypt = vi.fn(teamBase.encrypt.bind(teamBase));
      const personal = { ...personalBase, decrypt: personalDecrypt };
      const ownerPrivate = { ...ownerBase, encrypt: ownerEncrypt };
      const team = { ...teamBase, encrypt: teamEncrypt };
      privacyProvider = personal;
      const allowed: SharedMemoryRepresentation[] = [
        "lcm_rollups",
        "curated_assertions"
      ];
      const fixture = await createWorkspaceFixture({
        teamAllowed: allowed,
        workspaceAllowed: allowed
      });
      const curatedRepository = createSharedMemoryRepository(pool, {
        resolvePersonalEncryptionProvider: () => personal,
        resolveOwnerPrivateReplicaEncryptionProvider: ({ teamId }) =>
          teamId === fixture.teamId ? ownerPrivate : ownerProvider,
        resolveTeamEncryptionProvider: ({ teamId }) =>
          teamId === fixture.teamId ? team : provider
      });
      repository = curatedRepository;
      syncRepository = createCrossIdentitySyncRepository(pool, {
        ownerPrivateReplicaEnvelopeEncryptionProvider: ownerPrivate
      });
      const source = await createSource(fixture, 1, "curated-three-key");
      await putOwnerPolicy(fixture, source, allowed);

      const assertionId = randomUUID();
      const sourceId = source.seededEvents[0]!.contributorIds[0]!;
      await upsertEncryptedFieldPayloadWithClient(
        pool,
        actor(fixture.ownerUserId),
        personal,
        {
          sourceTable: "conversation_items",
          sourceId,
          sourceColumn: "raw_text",
          plaintext: "Owner-approved exact-session evidence.",
          visibility: "personal",
          rowFamily: "conversation_item",
          aad: { conversationItemId: sourceId }
        }
      );
      await pool.query(
        `insert into curated_memory_assertions (
         id,owner_user_id,visibility,assertion_text,normalized_assertion,
         sensitivity,confidence,tags,metadata,status,observed_at
       ) values ($1,$2,'personal','[koed encrypted curated memory]',
         $3,'normal',95,'{}','{}','current',now())`,
        [assertionId, fixture.ownerUserId, `encrypted:${randomUUID()}`]
      );
      await upsertEncryptedFieldPayloadWithClient(
        pool,
        actor(fixture.ownerUserId),
        personal,
        {
          sourceTable: "curated_memory_assertions",
          sourceId: assertionId,
          sourceColumn: "payload",
          plaintext: {
            assertionText: "The exact-session deployment decision is durable.",
            normalizedAssertion:
              "the exact-session deployment decision is durable.",
            tags: ["decision"],
            metadata: {},
            suppressionReason: null
          },
          visibility: "personal",
          rowFamily: "curated_memory",
          aad: { curatedMemoryId: assertionId }
        }
      );
      await pool.query(
        `insert into curated_memory_sources (
         assertion_id,source_type,source_role,conversation_item_id,metadata
       ) values ($1,'conversation_item','primary_evidence',$2,'{}')`,
        [assertionId, sourceId]
      );

      const addAssertion = async (
        claim: string,
        role:
          | "supporting_evidence"
          | "superseding_evidence"
          | "conflicting_evidence",
        evidenceId: string,
        expiresAt: string | null = null
      ) => {
        const id = randomUUID();
        await pool.query(
          `insert into curated_memory_assertions (
           id,owner_user_id,visibility,assertion_text,normalized_assertion,
           sensitivity,confidence,tags,metadata,status,observed_at,expires_at
         ) values ($1,$2,'personal','[koed encrypted curated memory]',
           $3,'normal',90,'{}','{}','current',now(),$4)`,
          [id, fixture.ownerUserId, `encrypted:${randomUUID()}`, expiresAt]
        );
        await upsertEncryptedFieldPayloadWithClient(
          pool,
          actor(fixture.ownerUserId),
          personal,
          {
            sourceTable: "curated_memory_assertions",
            sourceId: id,
            sourceColumn: "payload",
            plaintext: {
              assertionText: claim,
              normalizedAssertion: claim.toLowerCase(),
              tags: [role],
              metadata: {},
              suppressionReason: null
            },
            visibility: "personal",
            rowFamily: "curated_memory",
            aad: { curatedMemoryId: id }
          }
        );
        await pool.query(
          `insert into curated_memory_sources (
           assertion_id,source_type,source_role,conversation_item_id,metadata
         ) values ($1,'conversation_item',$2,$3,'{}')`,
          [id, role, evidenceId]
        );
      };
      await addAssertion(
        "Supporting exact-session assertion.",
        "supporting_evidence",
        sourceId,
        "2099-01-02T03:04:05.000Z"
      );
      await addAssertion(
        "Superseding exact-session assertion.",
        "superseding_evidence",
        sourceId
      );
      await addAssertion(
        "Conflicting exact-session assertion.",
        "conflicting_evidence",
        sourceId
      );
      const otherSource = await createSource(
        fixture,
        1,
        "curated-mixed-session"
      );
      await addAssertion(
        "MIXED_SESSION_CURATED_SENTINEL",
        "supporting_evidence",
        otherSource.seededEvents[0]!.contributorIds[0]!
      );

      const created = await createConsent(fixture, source, {
        representation: "curated_assertions",
        mode: ruleReason ? "snapshot" : "continuous",
        representations: allowed,
        label: "curated-three-key"
      });
      const ownerPrivatePayloads = await pool.query<{ key_id: string }>(
        `select key_id from encrypted_field_payloads
        where source_id in ($1,$2)`,
        [created.preview.artifactId, created.preview.previewId]
      );
      expect(ownerPrivatePayloads.rows).toHaveLength(2);
      expect(
        ownerPrivatePayloads.rows.every(
          ({ key_id }) => key_id === ownerPrivate.keyId
        )
      ).toBe(true);
      const grant = await repository.createShareGrant(
        actor(fixture.ownerUserId),
        {
          mutationId: randomUUID(),
          logicalGrantId: randomUUID(),
          consentId: created.consentId,
          authority: authority(fixture)
        }
      );
      expect(grant).toMatchObject({
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: true
      });
      await prepareSanitizedSemanticPreview(
        fixture.ownerUserId,
        created.preview,
        curatedRepository
      );
      const materialized = await repository.materializeGrantRepresentation(
        actor(fixture.ownerUserId),
        {
          mutationId: randomUUID(),
          shareGrantId: grant.id,
          consentId: created.consentId,
          expectedGrantVersion: grant.grantVersion,
          preview: created.preview
        }
      );
      expect(materialized.representation).toBe("curated_assertions");
      const materializedExpiry = await pool.query<{ expires_at: Date | null }>(
        `select curated_expires_at as expires_at
         from team_memory_representations where id=$1`,
        [materialized.id]
      );
      expect(materializedExpiry.rows[0]?.expires_at?.toISOString()).toBe(
        "2099-01-02T03:04:05.000Z"
      );
      expect(personalDecrypt).toHaveBeenCalled();
      expect(ownerEncrypt).toHaveBeenCalled();
      expect(teamEncrypt).toHaveBeenCalled();
      expect(
        new Set([personal.keyId, ownerPrivate.keyId, team.keyId]).size
      ).toBe(3);
      const read = await repository.readGrantRepresentation(
        actor(fixture.readerUserId),
        { shareGrantId: grant.id, representation: "curated_assertions" }
      );
      expect(read?.items).toHaveLength(4);
      expect(
        read?.items.some(
          (item) =>
            item.content.assertionText === "MIXED_SESSION_CURATED_SENTINEL"
        )
      ).toBe(false);
      expect(
        read?.items.every((item) => item.content.expansionItems === undefined)
      ).toBe(true);
      const curatedSemanticItems = (
        await repository.listPendingSharedMemorySemanticItems({ limit: 100 })
      ).filter((item) => item.shareGrantId === grant.id);
      const curatedVector = [1, ...Array.from({ length: 383 }, () => 0)];
      for (const semanticItem of curatedSemanticItems) {
        await repository.storeSharedMemorySemanticEmbedding({
          semanticItemId: semanticItem.semanticItemId,
          contentHash: semanticItem.contentHash,
          model: "curated-expansion-model",
          dimensions: 384,
          version: "curated-expansion-v1",
          vector: curatedVector
        });
      }
      const [curatedCandidate] =
        await repository.searchAuthorizedSharedMemorySemanticItems(
          actor(fixture.readerUserId),
          {
            teamWorkspaceId: fixture.teamWorkspaceId,
            queryVector: curatedVector,
            model: "curated-expansion-model",
            dimensions: 384,
            version: "curated-expansion-v1",
            limit: 1,
            searchDomain: "global",
            representations: ["curated_assertions"]
          }
        );
      const curatedExpansion =
        await repository.expandAuthorizedSharedMemorySemanticItem(
          actor(fixture.readerUserId),
          {
            teamWorkspaceId: fixture.teamWorkspaceId,
            candidateId: curatedCandidate!.candidateId,
            searchDomain: "global"
          }
        );
      expect(curatedExpansion?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            itemType: "user_message",
            text: "Owner-approved exact-session evidence."
          })
        ])
      );
      expect(
        curatedExpansion?.items.every(
          (item) => item.candidateId !== curatedCandidate!.candidateId
        )
      ).toBe(true);
      const storage = await pool.query<{ storage: string }>(
        `select concat_ws('|',
         coalesce((select string_agg(row_to_json(row_data)::text,'|')
           from (select * from curated_memory_assertions where owner_user_id=$1) row_data),''),
         coalesce((select string_agg(row_to_json(row_data)::text,'|')
           from (select * from curated_memory_sources where assertion_id=$2) row_data),''),
         coalesce((select string_agg(row_to_json(row_data)::text,'|')
           from (select * from shared_source_artifacts where logical_memory_id=$3) row_data),''),
         coalesce((select string_agg(row_to_json(row_data)::text,'|')
           from (select * from shared_source_previews where logical_memory_id=$3) row_data),''),
         coalesce((select string_agg(row_to_json(row_data)::text,'|')
           from (select * from team_memory_representation_chunks where representation_id=$4) row_data),''),
         coalesce((select string_agg(row_to_json(row_data)::text,'|')
           from (select * from team_memory_semantic_items where representation_id=$4) row_data),'')) as storage`,
        [
          fixture.ownerUserId,
          assertionId,
          source.logicalMemoryId,
          materialized.id
        ]
      );
      expect(storage.rows[0]!.storage).not.toContain(
        "The exact-session deployment decision is durable."
      );
      expect(storage.rows[0]!.storage).not.toContain(
        "MIXED_SESSION_CURATED_SENTINEL"
      );

      await pool.query(
        `update team_memory_representations
          set curated_expires_at=now()-interval '1 second'
        where id=$1`,
        [materialized.id]
      );
      await expect(
        repository.readGrantRepresentation(actor(fixture.readerUserId), {
          shareGrantId: grant.id,
          representation: "curated_assertions"
        })
      ).resolves.toBeNull();
      await expect(
        repository.expandAuthorizedSharedMemorySemanticItem(
          actor(fixture.readerUserId),
          {
            teamWorkspaceId: fixture.teamWorkspaceId,
            candidateId: curatedCandidate!.candidateId,
            searchDomain: "global"
          }
        )
      ).resolves.toBeNull();
      await pool.query(
        `update team_memory_representations
          set curated_expires_at=$2
        where id=$1`,
        [materialized.id, "2099-01-02T03:04:05.000Z"]
      );

      const failureClient = await pool.connect();
      try {
        await failureClient.query(`
        create or replace function pg_temp.fail_curated_invalidation_test()
        returns trigger language plpgsql as $$
        begin
          raise exception 'injected curated invalidation failure';
        end $$
      `);
        await failureClient.query(`
        create trigger zz_injected_curated_invalidation_failure
        after update of confidence on curated_memory_assertions
        for each row when (new.id = '${assertionId}'::uuid)
        execute function pg_temp.fail_curated_invalidation_test()
      `);
        await expect(
          failureClient.query(
            "update curated_memory_assertions set confidence=94 where id=$1",
            [assertionId]
          )
        ).rejects.toThrow("injected curated invalidation failure");
        const rolledBackAssertion = await failureClient.query<{
          confidence: number;
          state: string;
          semantic_count: string;
        }>(
          `select assertion.confidence,representation.state,
                (select count(*)::text from team_memory_semantic_items item
                  where item.representation_id=representation.id) semantic_count
           from curated_memory_assertions assertion
           join team_memory_representations representation on representation.id=$2
          where assertion.id=$1`,
          [assertionId, materialized.id]
        );
        expect(rolledBackAssertion.rows[0]).toEqual({
          confidence: 95,
          state: "available",
          semantic_count: "4"
        });
        await failureClient.query(
          "drop trigger zz_injected_curated_invalidation_failure on curated_memory_assertions"
        );
      } finally {
        failureClient.release();
      }

      if (ruleReason) {
        const continuous = await createConsent(fixture, source, {
          representation: "curated_assertions",
          mode: "continuous",
          representations: allowed,
          label: "curated-independent-rule"
        });
        const root = (
          await pool.query<{ logical_grant_id: string; grant_version: number }>(
            "select logical_grant_id,grant_version from team_memory_share_grants where id=$1",
            [grant.id]
          )
        ).rows[0]!;
        await repository.createConversationSharingRule(
          actor(fixture.ownerUserId),
          {
            ruleId: randomUUID(),
            mutationId: randomUUID(),
            logicalGrantId: root.logical_grant_id,
            consentId: continuous.consentId,
            expectedConsentVersion: continuous.consent.consentVersion,
            expectedGrantVersion: root.grant_version,
            publisherCredentialId: fixture.deviceCredentialId,
            effectivePrivacyPolicyHash: materialized.effectivePrivacyPolicyHash,
            authority: authority(fixture)
          }
        );
      }
      const invalidKeys = createSharedMemoryRepository(pool, {
        resolvePersonalEncryptionProvider: () => ownerPrivate,
        resolveOwnerPrivateReplicaEncryptionProvider: () => ownerPrivate,
        resolveTeamEncryptionProvider: () => team
      });
      await expect(
        invalidKeys.reconcileCuratedGrantRepresentations(
          actor(fixture.ownerUserId)
        )
      ).resolves.toEqual({ rematerialized: 0, invalidated: 0 });
      expect(
        (
          await pool.query<{ state: string }>(
            "select state from team_memory_representations where id=$1",
            [materialized.id]
          )
        ).rows[0]?.state
      ).toBe("available");

      await pool.query(
        "update curated_memory_assertions set confidence=94 where id=$1",
        [assertionId]
      );
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select 1");
        const transactional = createSharedMemoryRepository(
          createSavepointPool(client, "curated_memory"),
          {
            inheritTransactionIsolation: true,
            resolvePersonalEncryptionProvider: () => personal,
            resolveOwnerPrivateReplicaEncryptionProvider: () => ownerPrivate,
            resolveTeamEncryptionProvider: () => team
          }
        );
        await expect(
          transactional.reconcileCuratedGrantRepresentations(
            actor(fixture.ownerUserId)
          )
        ).resolves.toMatchObject({ rematerialized: 1 });
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      await flushSanitizedSemanticPublication();
      const rematerialized = await pool.query<{ id: string; state: string }>(
        `select id,state from team_memory_representations
        where share_grant_id=$1 and representation='curated_assertions'
        order by created_at desc,id desc limit 1`,
        [grant.id]
      );
      expect(rematerialized.rows[0]?.state).toBe("available");

      const sourceFailureClient = await pool.connect();
      try {
        await sourceFailureClient.query(`
        create or replace function pg_temp.fail_curated_source_invalidation_test()
        returns trigger language plpgsql as $$
        begin
          raise exception 'injected curated source invalidation failure';
        end $$
      `);
        await sourceFailureClient.query(`
        create trigger zz_injected_curated_source_invalidation_failure
        after update of memory_excluded_at on conversation_items
        for each row when (new.id = '${sourceId}'::uuid)
        execute function pg_temp.fail_curated_source_invalidation_test()
      `);
        await expect(
          sourceFailureClient.query(
            "update conversation_items set memory_excluded_at=now() where id=$1",
            [sourceId]
          )
        ).rejects.toThrow("injected curated source invalidation failure");
        const rolledBackSource = await sourceFailureClient.query<{
          memory_excluded_at: Date | null;
          state: string;
        }>(
          `select item.memory_excluded_at,representation.state
           from conversation_items item
           join team_memory_representations representation on representation.id=$2
          where item.id=$1`,
          [sourceId, rematerialized.rows[0]!.id]
        );
        expect(rolledBackSource.rows[0]).toEqual({
          memory_excluded_at: null,
          state: "available"
        });
        await sourceFailureClient.query(
          "drop trigger zz_injected_curated_source_invalidation_failure on conversation_items"
        );
      } finally {
        sourceFailureClient.release();
      }

      await pool.query(
        "update conversation_items set memory_excluded_at=now() where id=$1",
        [sourceId]
      );
      await expect(
        repository.reconcileCuratedGrantRepresentations(
          actor(fixture.ownerUserId)
        )
      ).resolves.toMatchObject({ invalidated: 0 });
      const invalidated = await pool.query<{
        state: string;
        semantic_count: string;
      }>(
        `select r.state,
              (select count(*)::text from team_memory_semantic_items smi
                where smi.representation_id=r.id) as semantic_count
         from team_memory_representations r where r.id=$1`,
        [rematerialized.rows[0]!.id]
      );
      expect(invalidated.rows[0]).toEqual({
        state: "invalidated",
        semantic_count: "0"
      });
    }
  );

  it("rewraps Team representation DEKs without decrypting or changing ciphertext", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      representation: "memory_events",
      label: "representation-rewrap"
    });
    await materialize(fixture, grant, { label: "representation-rewrap" });
    const before = await pool.query<{
      id: string;
      ciphertext: string;
      wrapped_dek: { version: number };
    }>(
      `select id,ciphertext,wrapped_dek
         from team_memory_representation_chunks
        where share_grant_id=$1`,
      [grant.shareGrantId]
    );
    const decrypts = decryptCount();

    const dryRunRewrap = vi.fn(provider.rewrap!.bind(provider));
    const dryRun = await repository.rewrapTeamRepresentationChunkBatch(
      { ...provider, rewrap: dryRunRewrap },
      { teamId: fixture.teamId, force: true, dryRun: true }
    );
    expect(dryRun).toMatchObject({
      processedRows: before.rows.length,
      rewrappedRows: 0,
      wouldRewrapRows: before.rows.length,
      failedRows: 0,
      done: true
    });
    expect(dryRunRewrap).not.toHaveBeenCalled();
    const afterDryRun = await pool.query<{
      ciphertext: string;
      envelope_reencrypted_at: Date | null;
    }>(
      `select ciphertext,envelope_reencrypted_at
         from team_memory_representation_chunks
        where share_grant_id=$1`,
      [grant.shareGrantId]
    );
    expect(afterDryRun.rows.map((row) => row.ciphertext)).toEqual(
      before.rows.map((row) => row.ciphertext)
    );
    expect(
      afterDryRun.rows.every((row) => row.envelope_reencrypted_at === null)
    ).toBe(true);

    const result = await repository.rewrapTeamRepresentationChunkBatch(
      provider,
      { teamId: fixture.teamId, force: true }
    );

    expect(result).toMatchObject({
      processedRows: before.rows.length,
      rewrappedRows: before.rows.length,
      wouldRewrapRows: 0,
      failedRows: 0,
      done: true
    });
    expect(decryptCount()).toBe(decrypts);
    const after = await pool.query<{
      id: string;
      ciphertext: string;
      wrapped_dek: { version: number };
      envelope_reencrypted_at: Date | null;
    }>(
      `select id,ciphertext,wrapped_dek,envelope_reencrypted_at
         from team_memory_representation_chunks
        where share_grant_id=$1`,
      [grant.shareGrantId]
    );
    expect(after.rows.map((row) => row.ciphertext)).toEqual(
      before.rows.map((row) => row.ciphertext)
    );
    expect(
      after.rows.every((row) => row.envelope_reencrypted_at !== null)
    ).toBe(true);
    expect(after.rows.map((row) => row.wrapped_dek.version)).toEqual(
      before.rows.map((row) => row.wrapped_dek.version + 1)
    );
    expect(
      await repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: grant.representation
      })
    ).not.toBeNull();
  });

  it("fails closed on every current access gate before resolving a decrypt key", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "authorization" });
    await materialize(fixture, grant, { label: "authorization" });
    expect(
      await repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: grant.representation
      })
    ).not.toBeNull();
    const [pendingSemanticItem] = (
      await repository.listPendingSharedMemorySemanticItems({ limit: 100 })
    ).filter((item) => item.shareGrantId === grant.shareGrantId);
    const authorizationVector = [1, ...Array.from({ length: 383 }, () => 0)];
    await repository.storeSharedMemorySemanticEmbedding({
      semanticItemId: pendingSemanticItem!.semanticItemId,
      contentHash: pendingSemanticItem!.contentHash,
      model: "authorization-expansion-model",
      dimensions: 384,
      version: "authorization-expansion-v1",
      vector: authorizationVector
    });

    const assertDeniedBeforeDecrypt = async (
      deny: () => Promise<unknown>,
      restore: () => Promise<unknown>,
      listRejects = false
    ): Promise<void> => {
      await deny();
      const decrypts = decryptCount();
      expect(
        await repository.readGrantRepresentation(actor(fixture.readerUserId), {
          shareGrantId: grant.shareGrantId,
          representation: grant.representation
        })
      ).toBeNull();
      await expect(
        repository.expandAuthorizedSharedMemorySemanticItem(
          actor(fixture.readerUserId),
          {
            teamWorkspaceId: fixture.teamWorkspaceId,
            candidateId: pendingSemanticItem!.semanticItemId,
            searchDomain: "global"
          }
        )
      ).resolves.toBeNull();
      if (listRejects) {
        await expect(
          repository.listWorkspaceGrants(actor(fixture.readerUserId), {
            teamId: fixture.teamId,
            teamWorkspaceId: fixture.teamWorkspaceId,
            limit: 10,
            offset: 0
          })
        ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
      } else {
        const page = await repository.listWorkspaceGrants(
          actor(fixture.readerUserId),
          {
            teamId: fixture.teamId,
            teamWorkspaceId: fixture.teamWorkspaceId,
            limit: 10,
            offset: 0
          }
        );
        expect(page.entries).toEqual([]);
      }
      expect(decryptCount()).toBe(decrypts);
      await restore();
    };

    await assertDeniedBeforeDecrypt(
      () =>
        pool.query(
          `update team_memory_share_grants
           set lifecycle = 'revoked', revoked_at = now(),
               revoked_by_user_id = $2, revocation_reason = 'matrix'
           where id = $1`,
          [grant.shareGrantId, fixture.ownerUserId]
        ),
      () =>
        pool.query(
          `update team_memory_share_grants
           set lifecycle = 'active', revoked_at = null,
               revoked_by_user_id = null, revocation_reason = null
           where id = $1`,
          [grant.shareGrantId]
        )
    );
    await assertDeniedBeforeDecrypt(
      () =>
        pool.query(
          `update team_workspaces
           set lifecycle = 'archived', archived_at = now() where id = $1`,
          [fixture.teamWorkspaceId]
        ),
      () =>
        pool.query(
          `update team_workspaces
           set lifecycle = 'active', archived_at = null where id = $1`,
          [fixture.teamWorkspaceId]
        ),
      true
    );
    await assertDeniedBeforeDecrypt(
      () =>
        pool.query(
          `update team_memberships
           set status = 'disabled', disabled_at = now()
           where team_id = $1 and user_id = $2`,
          [fixture.teamId, fixture.readerUserId]
        ),
      () =>
        pool.query(
          `update team_memberships
           set status = 'enabled', disabled_at = null
           where team_id = $1 and user_id = $2`,
          [fixture.teamId, fixture.readerUserId]
        ),
      true
    );
    await assertDeniedBeforeDecrypt(
      () =>
        pool.query(
          `update teams set lifecycle = 'suspended', suspended_at = now()
           where id = $1`,
          [fixture.teamId]
        ),
      () =>
        pool.query(
          `update teams set lifecycle = 'active', suspended_at = null
           where id = $1`,
          [fixture.teamId]
        ),
      true
    );
    await assertDeniedBeforeDecrypt(
      () =>
        pool.query(
          `update source_owner_representation_consents
           set state = 'revoked', revoked_at = now() where id = $1`,
          [grant.consentId]
        ),
      () =>
        pool.query(
          `update source_owner_representation_consents
           set state = 'active', revoked_at = null where id = $1`,
          [grant.consentId]
        )
    );
    await assertDeniedBeforeDecrypt(
      () =>
        pool.query(
          `update memory_replicas set disabled_at = now(),
             disabled_reason = 'matrix' where id = $1`,
          [grant.remoteReplicaId]
        ),
      () =>
        pool.query(
          `update memory_replicas set disabled_at = null,
             disabled_reason = null where id = $1`,
          [grant.remoteReplicaId]
        )
    );
    await pool.query(
      `update cross_identity_sync_relationships
       set state = 'revoked', revoked_at = now(),
           revoked_by_user_id = $2, revocation_reason = 'matrix'
       where local_replica_id = $1`,
      [grant.remoteReplicaId, fixture.ownerUserId]
    );
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: grant.representation
      })
    ).resolves.toMatchObject({ freshness: "stale" });
    await expect(
      repository.listWorkspaceGrants(actor(fixture.readerUserId), {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        limit: 10,
        offset: 0
      })
    ).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          maximumFidelity: "memory_events",
          includeCuratedMemory: false,
          lifecycle: "active"
        })
      ]
    });
    await pool.query(
      `update cross_identity_sync_relationships
       set state = 'ready', revoked_at = null,
           revoked_by_user_id = null, revocation_reason = null
       where local_replica_id = $1`,
      [grant.remoteReplicaId]
    );
    await assertDeniedBeforeDecrypt(
      () =>
        pool.query(
          `update team_workspace_access_grants
           set access = 'disabled', disabled_at = now(),
               disabled_reason = 'withdrawn'
           where team_workspace_id = $1 and user_id = $2`,
          [fixture.teamWorkspaceId, fixture.readerUserId]
        ),
      () =>
        pool.query(
          `update team_workspace_access_grants
           set access = 'read', disabled_at = null, disabled_reason = null
           where team_workspace_id = $1 and user_id = $2`,
          [fixture.teamWorkspaceId, fixture.readerUserId]
        ),
      true
    );
    const decrypts = decryptCount();
    expect(
      await repository.readGrantRepresentation(actor(fixture.outsiderUserId), {
        shareGrantId: grant.shareGrantId,
        representation: grant.representation
      })
    ).toBeNull();
    expect(decryptCount()).toBe(decrypts);
  });

  it("withdraws new share authority without mutating existing grants or blocking owner revocation", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "share-authority" });
    await materialize(fixture, grant, { label: "share-authority" });
    await expect(
      repository.revokeShareGrant(actor(fixture.managerUserId), {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion,
        reasonCode: "manager_must_not_revoke",
        authority: authority(fixture, "manager")
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
    const replacement = await createConsent(fixture, grant, {
      representation: "lcm_leaves",
      mode: "continuous",
      label: "share-authority-replacement"
    });
    const stateBeforeWithdrawal = await pool.query<{
      lifecycle: string;
      sync_state: string;
    }>(
      `select g.lifecycle, s.state as sync_state
         from team_memory_share_grants g
         join cross_identity_sync_relationships s
           on s.local_replica_id = g.remote_replica_id and s.side = 'target'
        where g.id = $1`,
      [grant.shareGrantId]
    );

    await pool.query(
      `update team_workspace_access_grants
          set can_share_owned_memory = false, version = version + 1,
              updated_at = now()
        where team_workspace_id = $1 and user_id = $2`,
      [fixture.teamWorkspaceId, fixture.ownerUserId]
    );

    expect(
      await repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: grant.representation
      })
    ).not.toBeNull();
    const existing = await pool.query<{
      lifecycle: string;
      sync_state: string;
    }>(
      `select g.lifecycle, s.state as sync_state
         from team_memory_share_grants g
         join cross_identity_sync_relationships s
           on s.local_replica_id = g.remote_replica_id and s.side = 'target'
        where g.id = $1`,
      [grant.shareGrantId]
    );
    expect(existing.rows[0]).toEqual(stateBeforeWithdrawal.rows[0]);
    expect(existing.rows[0]?.lifecycle).toBe("active");

    await expect(
      repository.selectGrantFidelity(actor(fixture.ownerUserId), {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId: replacement.consentId,
        maximumFidelity: replacement.consent.maximumFidelity,
        includeCuratedMemory: replacement.consent.includeCuratedMemory,
        expectedGrantVersion: grant.grantVersion,
        authority: authority(fixture)
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);

    const anotherSource = await createSource(fixture, 1, "new-share-denied");
    await putOwnerPolicy(fixture, anotherSource);
    await expect(
      createPersistedPreview(
        fixture,
        anotherSource,
        "memory_events",
        1,
        "new-share-denied"
      )
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);

    const revoked = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion,
        reasonCode: "owner_withdrawal",
        authority: authority(fixture)
      }
    );
    expect(revoked.lifecycle).toBe("revoked");
  });

  it("evaluates every effective Team, Workspace, and Share Grant retention policy and uses the longest deadline", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "retention-precedence" });
    const representation = await materialize(fixture, grant);
    const companion = await collaboration.createThread(
      actor(fixture.ownerUserId),
      {
        kind: "shared_session_discussion",
        idempotencyKey: `retention-precedence:${randomUUID()}`,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        sharedLogicalMemoryId: grant.logicalMemoryId,
        shareGrantId: grant.shareGrantId
      }
    );
    const effectiveAt = new Date("2020-01-02T00:00:00.000Z");
    const teamPolicy = await pool.query<{ policy_id: string }>(
      `select policy_id from retention_policies
        where scope = 'team' and team_id = $1 and superseded_at is null`,
      [fixture.teamId]
    );
    const workspacePolicy = await retentionRepository.createPolicy({
      target: {
        scope: "workspace",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId
      },
      retentionSeconds: 3_000_000,
      deletionGraceSeconds: 200_000,
      backupRetentionSeconds: 0,
      effectiveAt,
      createdByUserId: fixture.ownerUserId
    });
    const grantPolicy = await retentionRepository.createPolicy({
      target: {
        scope: "share_grant",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        shareGrantId: grant.shareGrantId,
        logicalMemoryId: grant.logicalMemoryId
      },
      retentionSeconds: 3_100_000,
      deletionGraceSeconds: 50_000,
      backupRetentionSeconds: 0,
      effectiveAt,
      createdByUserId: fixture.ownerUserId
    });

    await repository.revokeShareGrant(actor(fixture.ownerUserId), {
      mutationId: randomUUID(),
      shareGrantId: grant.shareGrantId,
      expectedGrantVersion: grant.grantVersion,
      reasonCode: "retention_precedence",
      authority: authority(fixture)
    });
    const snapshot = await pool.query<{
      policy_id: string;
      triggered_at: Date;
      retain_until: Date;
      grant_retain_until: Date;
      representation_retain_until: Date;
      companion_retain_until: Date;
      metadata: {
        evaluatedPolicies: Array<{
          policyId: string;
          scope: string;
          retainUntil: string;
        }>;
      };
    }>(
      `select decision.policy_id, decision.triggered_at, decision.retain_until,
              grant_row.retain_until as grant_retain_until,
              representation.retain_until as representation_retain_until,
              companion.retain_until as companion_retain_until,
              audit.metadata
         from team_memory_share_grants grant_row
         join retention_decisions decision
           on decision.id = grant_row.active_retention_decision_id
         join team_memory_representations representation
           on representation.id = $2
         join collaboration_threads companion on companion.id = $3
         join audit_events audit
           on audit.action = 'share_grant.retention_started'
          and audit.target_id = grant_row.id
          and audit.metadata ->> 'retentionDecisionId' = decision.id::text
        where grant_row.id = $1`,
      [grant.shareGrantId, representation.id, companion!.id]
    );
    const row = snapshot.rows[0]!;
    expect(row.policy_id).toBe(workspacePolicy.policyId);
    expect(row.retain_until.getTime() - row.triggered_at.getTime()).toBe(
      3_200_000_000
    );
    expect(row.grant_retain_until).toEqual(row.retain_until);
    expect(row.representation_retain_until).toEqual(row.retain_until);
    expect(row.companion_retain_until).toEqual(row.retain_until);
    expect(row.metadata.evaluatedPolicies).toEqual([
      expect.objectContaining({
        policyId: workspacePolicy.policyId,
        scope: "workspace",
        retainUntil: row.retain_until.toISOString()
      }),
      expect.objectContaining({
        policyId: grantPolicy.policyId,
        scope: "share_grant",
        retainUntil: new Date(
          row.triggered_at.getTime() + 3_150_000_000
        ).toISOString()
      }),
      expect.objectContaining({
        policyId: teamPolicy.rows[0]!.policy_id,
        scope: "team",
        retainUntil: new Date(
          row.triggered_at.getTime() + 2_592_000_000
        ).toISOString()
      })
    ]);
  });

  it("serializes concurrent exact Share Grant revocation retries into one retention epoch", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "concurrent-revoke" });
    await materialize(fixture, grant);
    const input = {
      mutationId: randomUUID(),
      shareGrantId: grant.shareGrantId,
      expectedGrantVersion: grant.grantVersion,
      reasonCode: "concurrent_exact_retry",
      authority: authority(fixture)
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        repository.revokeShareGrant(actor(fixture.ownerUserId), input)
      )
    );
    expect(new Set(results.map((result) => result.grantVersion))).toEqual(
      new Set([grant.grantVersion + 1])
    );
    await expect(
      pool.query(
        `select grant_row.lifecycle, grant_row.revocation_epoch::text,
                (select count(*)::text from retention_decisions decision
                  where decision.share_grant_id = grant_row.id
                    and decision.trigger = 'share_revoked') as decisions,
                (select count(*)::text from purge_jobs job
                  where job.share_grant_id = grant_row.id) as jobs,
                (select count(*)::text from purge_job_evidence evidence
                  join purge_jobs job on job.id = evidence.purge_job_id
                  where job.share_grant_id = grant_row.id) as evidence
           from team_memory_share_grants grant_row where grant_row.id = $1`,
        [grant.shareGrantId]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          lifecycle: "revoked",
          revocation_epoch: "1",
          decisions: "1",
          jobs: "1",
          evidence: "7"
        }
      ]
    });
  });

  it("rolls back Share Grant revocation when retention scheduling cannot resolve a policy", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "revoke-rollback" });
    await materialize(fixture, grant);
    await pool.query("delete from retention_policies where team_id = $1", [
      fixture.teamId
    ]);
    await expect(
      repository.revokeShareGrant(actor(fixture.ownerUserId), {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion,
        reasonCode: "missing_retention_policy",
        authority: authority(fixture)
      })
    ).rejects.toThrow(
      "No retention policy was effective for the Share Grant at revocation time"
    );
    await expect(
      pool.query(
        `select grant_row.lifecycle, grant_row.grant_version,
                grant_row.revocation_epoch::text,
                representation.state,
                (select count(*)::text from retention_decisions decision
                  where decision.share_grant_id = grant_row.id) as decisions,
                (select count(*)::text from purge_jobs job
                  where job.share_grant_id = grant_row.id) as jobs
           from team_memory_share_grants grant_row
           join team_memory_representations representation
             on representation.share_grant_id = grant_row.id
          where grant_row.id = $1`,
        [grant.shareGrantId]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          lifecycle: "active",
          grant_version: grant.grantVersion,
          revocation_epoch: "0",
          state: "available",
          decisions: "0",
          jobs: "0"
        }
      ]
    });
  });

  it("creates one companion discussion concurrently and derives access from the live grant", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "companion" });
    const initialRepresentation = await materialize(fixture, grant);
    const create = (idempotencyKey: string) =>
      collaboration.createThread(actor(fixture.ownerUserId), {
        kind: "shared_session_discussion",
        idempotencyKey,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        sharedLogicalMemoryId: grant.logicalMemoryId,
        shareGrantId: grant.shareGrantId
      });
    const discussions = await Promise.all([
      create("companion-first"),
      create("companion-second"),
      create("companion-first")
    ]);
    expect(new Set(discussions.map((thread) => thread?.id)).size).toBe(1);
    const discussion = discussions[0]!;
    const storedThreads = await pool.query<{ count: string }>(
      `select count(*)::text as count from collaboration_threads
       where kind = 'shared_session_discussion'
         and team_workspace_id = $1 and shared_logical_memory_id = $2`,
      [fixture.teamWorkspaceId, grant.logicalMemoryId]
    );
    expect(storedThreads.rows[0]?.count).toBe("1");

    const discussionText = `companion-only-${randomUUID()}`;
    const pipelineCountsBefore = await readMemoryPipelineCounts();
    await collaboration.sendMessage(actor(fixture.ownerUserId), {
      threadId: discussion.id,
      idempotencyKey: "companion-message",
      bodyText: discussionText,
      metadata: { channel: "discussion" }
    });
    const readerPage = await collaboration.listMessages(
      actor(fixture.readerUserId),
      { threadId: discussion.id, limit: 20 }
    );
    expect(readerPage?.messages[0]?.bodyText).toBe(discussionText);

    expect(await readMemoryPipelineCounts()).toEqual(pipelineCountsBefore);
    const encryptedMessage = await pool.query<{
      structural: string;
      encrypted: string;
    }>(
      `select row_to_json(cm)::text as structural,
              string_agg(efp.ciphertext, '') as encrypted
       from collaboration_messages cm
       join encrypted_field_payloads efp
         on efp.source_table = 'collaboration_messages'
        and efp.source_id = cm.id and efp.invalidated_at is null
       where cm.thread_id = $1
       group by cm.id`,
      [discussion.id]
    );
    expect(encryptedMessage.rows[0]?.structural).not.toContain(discussionText);
    expect(encryptedMessage.rows[0]?.encrypted).not.toContain(discussionText);

    const firstRevocationMutationId = randomUUID();
    const revoked = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: firstRevocationMutationId,
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion,
        reasonCode: "owner_revoked",
        authority: authority(fixture)
      }
    );
    const scheduledRetention = await pool.query<{
      grant_epoch: string;
      active_decision_id: string | null;
      active_job_id: string | null;
      trigger_epoch: string;
      target_epoch: string;
      job_state: string;
      evidence_count: string;
    }>(
      `select g.revocation_epoch::text as grant_epoch,
              g.active_retention_decision_id as active_decision_id,
              g.active_purge_job_id as active_job_id,
              decision.trigger_epoch::text as trigger_epoch,
              job.target_epoch::text as target_epoch,
              job.state as job_state,
              (select count(*)::text from purge_job_evidence evidence
                where evidence.purge_job_id = job.id) as evidence_count
         from team_memory_share_grants g
         join retention_decisions decision
           on decision.id = g.active_retention_decision_id
         join purge_jobs job on job.id = g.active_purge_job_id
        where g.id = $1`,
      [grant.shareGrantId]
    );
    expect(scheduledRetention.rows[0]).toMatchObject({
      grant_epoch: "1",
      trigger_epoch: "1",
      target_epoch: "1",
      job_state: "pending",
      evidence_count: "7"
    });
    expect(scheduledRetention.rows[0]?.active_decision_id).toBeTruthy();
    expect(scheduledRetention.rows[0]?.active_job_id).toBeTruthy();
    const decryptsBeforeDeniedHistory = decryptCount();
    expect(
      await collaboration.listMessages(actor(fixture.readerUserId), {
        threadId: discussion.id,
        limit: 20
      })
    ).toBeNull();
    expect(decryptCount()).toBe(decryptsBeforeDeniedHistory);

    const restoredConsent = await createConsent(fixture, grant, {
      representation: grant.representation,
      mode: "continuous",
      label: "companion-restored"
    });
    const restored = await repository.selectGrantFidelity(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId: restoredConsent.consentId,
        maximumFidelity: restoredConsent.consent.maximumFidelity,
        includeCuratedMemory: restoredConsent.consent.includeCuratedMemory,
        expectedGrantVersion: revoked.grantVersion,
        authority: authority(fixture)
      }
    );
    const canceledRetention = await pool.query<{
      grant_decision_id: string | null;
      grant_job_id: string | null;
      job_state: string;
      canceled_at: Date | null;
      cancellation_reason_code: string | null;
      immutable_decisions: string;
      immutable_evidence: string;
    }>(
      `select g.active_retention_decision_id as grant_decision_id,
              g.active_purge_job_id as grant_job_id,
              job.state as job_state, job.canceled_at,
              job.cancellation_reason_code,
              (select count(*)::text from retention_decisions decision
                where decision.share_grant_id = g.id
                  and decision.trigger = 'share_revoked') as immutable_decisions,
              (select count(*)::text from purge_job_evidence evidence
                where evidence.purge_job_id = job.id) as immutable_evidence
         from team_memory_share_grants g
         join purge_jobs job
           on job.id = $2
        where g.id = $1`,
      [grant.shareGrantId, scheduledRetention.rows[0]!.active_job_id]
    );
    expect(canceledRetention.rows[0]).toMatchObject({
      grant_decision_id: null,
      grant_job_id: null,
      job_state: "canceled",
      cancellation_reason_code: "restored_before_purge",
      immutable_decisions: "1",
      immutable_evidence: "7"
    });
    expect(canceledRetention.rows[0]?.canceled_at).toBeInstanceOf(Date);
    const restoredRepresentation =
      await repository.materializeGrantRepresentation(
        actor(fixture.ownerUserId),
        {
          mutationId: randomUUID(),
          shareGrantId: grant.shareGrantId,
          consentId: restoredConsent.consentId,
          expectedGrantVersion: restored.grantVersion,
          expectedRepresentationVersion: 0,
          preview: restoredConsent.preview
        }
      );
    expect(restoredRepresentation.id).not.toBe(initialRepresentation.id);
    await expect(
      pool.query(
        `select state,record_version from team_memory_representations where id=$1`,
        [initialRepresentation.id]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          state: "invalidated",
          record_version: initialRepresentation.recordVersion + 1
        }
      ]
    });
    expect(restoredRepresentation.state).toBe("available");
    expect(
      await repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: grant.representation
      })
    ).not.toBeNull();
    const restoredPage = await collaboration.listMessages(
      actor(fixture.readerUserId),
      { threadId: discussion.id, limit: 20 }
    );
    expect(restoredPage?.messages[0]?.bodyText).toBe(discussionText);

    await expect(
      repository.revokeShareGrant(actor(fixture.ownerUserId), {
        mutationId: firstRevocationMutationId,
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: restored.grantVersion,
        reasonCode: "owner_revoked_again",
        authority: authority(fixture)
      })
    ).rejects.toThrow("Share Grant revocation mutation was already used");

    const revokedAgain = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: restored.grantVersion,
        reasonCode: "owner_revoked_again",
        authority: authority(fixture)
      }
    );
    expect(revokedAgain.lifecycle).toBe("revoked");
    const retentionHistory = await pool.query<{
      decision_id: string;
      job_id: string;
      trigger_epoch: string;
      target_epoch: string;
      job_state: string;
      evidence_count: string;
      active_decision_id: string;
      active_job_id: string;
      grant_epoch: string;
    }>(
      `select decision.id as decision_id, job.id as job_id,
              decision.trigger_epoch::text, job.target_epoch::text,
              job.state as job_state,
              count(evidence.id)::text as evidence_count,
              grant_row.active_retention_decision_id as active_decision_id,
              grant_row.active_purge_job_id as active_job_id,
              grant_row.revocation_epoch::text as grant_epoch
         from retention_decisions decision
         join purge_jobs job on job.retention_decision_id = decision.id
         join purge_job_evidence evidence on evidence.purge_job_id = job.id
         join team_memory_share_grants grant_row
           on grant_row.id = decision.share_grant_id
        where decision.share_grant_id = $1
          and decision.trigger = 'share_revoked'
        group by decision.id, job.id, grant_row.id
        order by decision.trigger_epoch`,
      [grant.shareGrantId]
    );
    expect(retentionHistory.rows).toHaveLength(2);
    expect(retentionHistory.rows[0]).toMatchObject({
      decision_id: scheduledRetention.rows[0]!.active_decision_id,
      job_id: scheduledRetention.rows[0]!.active_job_id,
      trigger_epoch: "1",
      target_epoch: "1",
      job_state: "canceled",
      evidence_count: "7"
    });
    expect(retentionHistory.rows[1]).toMatchObject({
      trigger_epoch: "2",
      target_epoch: "2",
      job_state: "pending",
      evidence_count: "7",
      grant_epoch: "2"
    });
    expect(retentionHistory.rows[1]!.decision_id).not.toBe(
      retentionHistory.rows[0]!.decision_id
    );
    expect(retentionHistory.rows[1]!.job_id).not.toBe(
      retentionHistory.rows[0]!.job_id
    );
    expect(retentionHistory.rows[1]!.active_decision_id).toBe(
      retentionHistory.rows[1]!.decision_id
    );
    expect(retentionHistory.rows[1]!.active_job_id).toBe(
      retentionHistory.rows[1]!.job_id
    );

    await pool.query(
      `update team_workspace_access_grants
       set access = 'disabled', disabled_at = now(), disabled_reason = 'withdrawn'
       where team_workspace_id = $1 and user_id = $2`,
      [fixture.teamWorkspaceId, fixture.readerUserId]
    );
    const decryptsBeforeWorkspaceWithdrawal = decryptCount();
    expect(
      await collaboration.listMessages(actor(fixture.readerUserId), {
        threadId: discussion.id,
        limit: 20
      })
    ).toBeNull();
    expect(decryptCount()).toBe(decryptsBeforeWorkspaceWithdrawal);
  });

  it("rejects restore after a Share Grant purge job has been claimed", async () => {
    const fixture = await createWorkspaceFixture({
      retentionSeconds: 0,
      backupRetentionSeconds: 0
    });
    const grant = await createGrant(fixture, { label: "claimed-restore" });
    await materialize(fixture, grant);
    const replacement = await createConsent(fixture, grant, {
      representation: grant.representation,
      mode: "continuous",
      label: "claimed-restore-replacement"
    });
    const revoked = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion,
        reasonCode: "claim_before_restore",
        authority: authority(fixture)
      }
    );
    const claimed = await retentionRepository.claimNextPurgeJob();
    expect(claimed?.job.target).toMatchObject({
      kind: "share_grant",
      shareGrantId: grant.shareGrantId
    });
    expect(claimed?.job.state).toBe("running");

    await expect(
      repository.selectGrantFidelity(actor(fixture.ownerUserId), {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId: replacement.consentId,
        maximumFidelity: replacement.consent.maximumFidelity,
        includeCuratedMemory: replacement.consent.includeCuratedMemory,
        expectedGrantVersion: revoked.grantVersion,
        authority: authority(fixture)
      })
    ).rejects.toThrow(
      "Share Grant cannot be changed after retention purge has started"
    );
    const state = await pool.query<{
      grant_lifecycle: string;
      representation_state: string;
      active_job_id: string;
      job_state: string;
      attempt_state: string;
    }>(
      `select grant_row.lifecycle as grant_lifecycle,
              representation.state as representation_state,
              grant_row.active_purge_job_id as active_job_id,
              job.state as job_state, attempt.state as attempt_state
         from team_memory_share_grants grant_row
         join team_memory_representations representation
           on representation.share_grant_id = grant_row.id
         join purge_jobs job on job.id = grant_row.active_purge_job_id
         join purge_job_attempts attempt on attempt.purge_job_id = job.id
        where grant_row.id = $1`,
      [grant.shareGrantId]
    );
    expect(state.rows[0]).toEqual({
      grant_lifecycle: "purge_pending",
      representation_state: "purge_pending",
      active_job_id: claimed!.job.id,
      job_state: "running",
      attempt_state: "running"
    });

    await retentionRepository.processClaimedPurgeJob({
      purgeJobId: claimed!.job.id,
      purgeAttemptId: claimed!.attempt.id
    });
    await expect(
      retentionRepository.completePurgeJob(claimed!.job.id)
    ).resolves.toMatchObject({ completed: true });
  });

  it("purges only one zero-retention Share Grant and its companion artifacts", async () => {
    const fixture = await createWorkspaceFixture({
      retentionSeconds: 0,
      backupRetentionSeconds: 0
    });
    const targetGrant = await createGrant(fixture, {
      label: "target-grant-purge"
    });
    const unrelatedGrant = await createGrant(fixture, {
      label: "unrelated-grant-survives"
    });
    const targetRepresentation = await materialize(fixture, targetGrant);
    const unrelatedRepresentation = await materialize(fixture, unrelatedGrant);
    const createCompanion = (grant: GrantFixture, label: string) =>
      collaboration.createThread(actor(fixture.ownerUserId), {
        kind: "shared_session_discussion",
        idempotencyKey: `${label}:${randomUUID()}`,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        sharedLogicalMemoryId: grant.logicalMemoryId,
        shareGrantId: grant.shareGrantId
      });
    const targetCompanion = await createCompanion(
      targetGrant,
      "target-companion"
    );
    const unrelatedCompanion = await createCompanion(
      unrelatedGrant,
      "unrelated-companion"
    );
    const workspaceChannel = await collaboration.createThread(
      actor(fixture.ownerUserId),
      {
        kind: "workspace_channel",
        idempotencyKey: `purge-scope-channel:${randomUUID()}`,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        name: `Purge scope ${randomUUID()}`
      }
    );
    const targetMessage = await collaboration.sendMessage(
      actor(fixture.ownerUserId),
      {
        threadId: targetCompanion!.id,
        idempotencyKey: `target-message:${randomUUID()}`,
        bodyText: `target-companion-secret-${randomUUID()}`,
        metadata: { scope: "target" }
      }
    );
    const unrelatedMessage = await collaboration.sendMessage(
      actor(fixture.ownerUserId),
      {
        threadId: unrelatedCompanion!.id,
        idempotencyKey: `unrelated-message:${randomUUID()}`,
        bodyText: `unrelated-companion-secret-${randomUUID()}`,
        metadata: { scope: "unrelated" }
      }
    );
    const channelMessage = await collaboration.sendMessage(
      actor(fixture.ownerUserId),
      {
        threadId: workspaceChannel!.id,
        idempotencyKey: `channel-message:${randomUUID()}`,
        bodyText: `workspace-channel-secret-${randomUUID()}`,
        metadata: { scope: "channel" }
      }
    );
    const readOwnerPrivateState = () =>
      pool.query<{
        logical_lifecycle: string;
        replica_lifecycle: string;
        sync_state: string;
        sessions: string;
        events: string;
        nodes: string;
        artifacts: string;
        previews: string;
        encrypted_payloads: string;
      }>(
        `select
           (select lifecycle from logical_memories where id = $1) as logical_lifecycle,
           (select lifecycle from memory_replicas where id = $2) as replica_lifecycle,
           (select state from cross_identity_sync_relationships
             where id = $3) as sync_state,
           (select count(*)::text from sessions where id = $4) as sessions,
           (select count(*)::text from memory_events
             where session_id = $4) as events,
           (select count(*)::text from memory_nodes
             where session_id = $4) as nodes,
           (select count(*)::text from shared_source_artifacts
             where remote_replica_id = $2) as artifacts,
           (select count(*)::text from shared_source_previews
             where remote_replica_id = $2) as previews,
           (select count(*)::text from encrypted_field_payloads
             where encryption_scope = 'owner_private_replica'
               and owner_principal_id = $5) as encrypted_payloads`,
        [
          targetGrant.logicalMemoryId,
          targetGrant.remoteReplicaId,
          targetGrant.syncRelationshipId,
          targetGrant.sessionId,
          targetGrant.ownerPrincipalId
        ]
      );
    const ownerPrivateBefore = (await readOwnerPrivateState()).rows[0]!;
    expect(Number(ownerPrivateBefore.events)).toBeGreaterThan(0);
    expect(Number(ownerPrivateBefore.nodes)).toBeGreaterThan(0);
    expect(Number(ownerPrivateBefore.artifacts)).toBeGreaterThan(0);
    expect(Number(ownerPrivateBefore.encrypted_payloads)).toBeGreaterThan(0);
    const before = await pool.query<{
      target_chunks: string;
      target_payloads: string;
      target_share_payloads: string;
      target_messages: string;
      target_outbox: string;
      unrelated_chunks: string;
      unrelated_payloads: string;
      unrelated_messages: string;
      unrelated_outbox: string;
      channel_payloads: string;
      channel_messages: string;
      channel_outbox: string;
    }>(
      `select
         (select count(*)::text from team_memory_representation_chunks
           where share_grant_id = $1) as target_chunks,
         (select count(*)::text from encrypted_field_payloads
           where source_id = any($6::uuid[])) as target_payloads,
         (select count(*)::text
            from encrypted_field_payloads payload
           where payload.encryption_scope = 'team'
             and payload.team_id = $9 and payload.team_workspace_id = $10
             and (
               payload.source_id = any($6::uuid[])
               or (payload.source_table = 'team_memory_representations' and exists (
                 select 1 from team_memory_representations representation
                  where representation.id = payload.source_id
                    and representation.share_grant_id = $1
               ))
               or (payload.source_table = 'shared_source_semantic_previews' and exists (
                 select 1 from team_memory_representations representation
                  where representation.sanitized_source_preview_id = payload.source_id
                    and representation.share_grant_id = $1
                    and not exists (
                      select 1 from team_memory_representations retained
                       where retained.sanitized_source_preview_id = payload.source_id
                         and retained.share_grant_id <> $1
                         and retained.state <> 'purged'
                    )
               ))
               or (payload.source_table = 'privacy_sanitized_source_artifacts' and exists (
                 select 1 from privacy_sanitized_source_artifacts artifact
                  where artifact.id = payload.source_id
                    and artifact.share_grant_id = $1
               ))
               or (payload.source_table = 'privacy_sanitized_source_chunks' and exists (
                 select 1 from privacy_sanitized_source_chunks chunk
                 join privacy_sanitized_source_artifacts artifact
                   on artifact.id = chunk.artifact_id
                  where chunk.id = payload.source_id
                    and artifact.share_grant_id = $1
               ))
             )) as target_share_payloads,
         (select count(*)::text from collaboration_messages
           where thread_id = $2) as target_messages,
         (select count(*)::text from collaboration_outbox
           where share_grant_id = $1 or thread_id = $2) as target_outbox,
         (select count(*)::text from team_memory_representation_chunks
           where share_grant_id = $3) as unrelated_chunks,
         (select count(*)::text from encrypted_field_payloads
           where source_id = any($7::uuid[])) as unrelated_payloads,
         (select count(*)::text from collaboration_messages
           where thread_id = $4) as unrelated_messages,
         (select count(*)::text from collaboration_outbox
           where share_grant_id = $3 or thread_id = $4) as unrelated_outbox,
         (select count(*)::text from encrypted_field_payloads
           where source_id = any($8::uuid[])) as channel_payloads,
         (select count(*)::text from collaboration_messages
           where thread_id = $5) as channel_messages,
         (select count(*)::text from collaboration_outbox
           where thread_id = $5) as channel_outbox`,
      [
        targetGrant.shareGrantId,
        targetCompanion!.id,
        unrelatedGrant.shareGrantId,
        unrelatedCompanion!.id,
        workspaceChannel!.id,
        [targetCompanion!.id, targetMessage!.id],
        [unrelatedCompanion!.id, unrelatedMessage!.id],
        [workspaceChannel!.id, channelMessage!.id],
        fixture.teamId,
        fixture.teamWorkspaceId
      ]
    );
    for (const count of Object.values(before.rows[0]!)) {
      expect(Number(count)).toBeGreaterThan(0);
    }
    const targetEvent = await pool.query<{ id: string; cursor: string }>(
      `select id, cursor::text from collaboration_outbox
        where share_grant_id = $1 or thread_id = $2
        order by cursor desc limit 1`,
      [targetGrant.shareGrantId, targetCompanion!.id]
    );
    const streamSubscription = await pool.query<{ id: string }>(
      `insert into collaboration_stream_subscriptions (
         backend_identity_hash, principal_id_hash, client_instance_hash,
         subscription_key_hash, protocol_version, scope, team_id,
         snapshot_high_water_cursor, acknowledged_event_id,
         acknowledged_cursor, expires_at
       ) values ($1,$2,$3,$4,1,'team',$5,$6,$7,$6,now() + interval '1 day')
       returning id`,
      [
        hash(`backend:${randomUUID()}`),
        hash(`principal:${randomUUID()}`),
        hash(`client:${randomUUID()}`),
        hash(`subscription:${randomUUID()}`),
        fixture.teamId,
        targetEvent.rows[0]!.cursor,
        targetEvent.rows[0]!.id
      ]
    );

    const grantPolicy = await retentionRepository.createPolicy({
      target: {
        scope: "share_grant",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        shareGrantId: targetGrant.shareGrantId,
        logicalMemoryId: targetGrant.logicalMemoryId
      },
      retentionSeconds: 0,
      deletionGraceSeconds: 0,
      backupRetentionSeconds: 0,
      effectiveAt: new Date("2020-01-02T00:00:00.000Z"),
      createdByUserId: fixture.ownerUserId
    });
    await repository.revokeShareGrant(actor(fixture.ownerUserId), {
      mutationId: randomUUID(),
      shareGrantId: targetGrant.shareGrantId,
      expectedGrantVersion: targetGrant.grantVersion,
      reasonCode: "zero_retention_purge",
      authority: authority(fixture)
    });
    const claimed = await retentionRepository.claimNextPurgeJob();
    expect(claimed?.job.target).toMatchObject({
      kind: "share_grant",
      shareGrantId: targetGrant.shareGrantId
    });
    await retentionRepository.processClaimedPurgeJob({
      purgeJobId: claimed!.job.id,
      purgeAttemptId: claimed!.attempt.id
    });
    await expect(
      retentionRepository.completePurgeJob(claimed!.job.id)
    ).resolves.toMatchObject({ completed: true });

    expect((await readOwnerPrivateState()).rows[0]).toEqual(ownerPrivateBefore);
    const after = await pool.query<{
      target_grant_lifecycle: string;
      target_representation_state: string;
      target_chunks: string;
      target_companion_lifecycle: string;
      target_payloads: string;
      target_messages: string;
      target_outbox: string;
      unrelated_grant_lifecycle: string;
      unrelated_representation_state: string;
      unrelated_chunks: string;
      unrelated_companion_lifecycle: string;
      unrelated_payloads: string;
      unrelated_messages: string;
      unrelated_outbox: string;
      channel_lifecycle: string;
      channel_payloads: string;
      channel_messages: string;
      channel_outbox: string;
      completion_audits: string;
    }>(
      `select
         (select lifecycle from team_memory_share_grants
           where id = $1) as target_grant_lifecycle,
         (select state from team_memory_representations
           where id = $2) as target_representation_state,
         (select count(*)::text from team_memory_representation_chunks
           where share_grant_id = $1) as target_chunks,
         (select lifecycle from collaboration_threads
           where id = $3) as target_companion_lifecycle,
         (select count(*)::text from encrypted_field_payloads
           where source_id = any($8::uuid[])) as target_payloads,
         (select count(*)::text from collaboration_messages
           where thread_id = $3) as target_messages,
         (select count(*)::text from collaboration_outbox
           where share_grant_id = $1 or thread_id = $3) as target_outbox,
         (select lifecycle from team_memory_share_grants
           where id = $4) as unrelated_grant_lifecycle,
         (select state from team_memory_representations
           where id = $5) as unrelated_representation_state,
         (select count(*)::text from team_memory_representation_chunks
           where share_grant_id = $4) as unrelated_chunks,
         (select lifecycle from collaboration_threads
           where id = $6) as unrelated_companion_lifecycle,
         (select count(*)::text from encrypted_field_payloads
           where source_id = any($9::uuid[])) as unrelated_payloads,
         (select count(*)::text from collaboration_messages
           where thread_id = $6) as unrelated_messages,
         (select count(*)::text from collaboration_outbox
           where share_grant_id = $4 or thread_id = $6) as unrelated_outbox,
         (select lifecycle from collaboration_threads
           where id = $7) as channel_lifecycle,
         (select count(*)::text from encrypted_field_payloads
           where source_id = any($10::uuid[])) as channel_payloads,
         (select count(*)::text from collaboration_messages
           where thread_id = $7) as channel_messages,
         (select count(*)::text from collaboration_outbox
           where thread_id = $7) as channel_outbox,
         (select count(*)::text from audit_events
           where action = 'share_grant.purge_completed'
             and target_id = $1
             and metadata ->> 'purgeJobId' = $11::text) as completion_audits`,
      [
        targetGrant.shareGrantId,
        targetRepresentation.id,
        targetCompanion!.id,
        unrelatedGrant.shareGrantId,
        unrelatedRepresentation.id,
        unrelatedCompanion!.id,
        workspaceChannel!.id,
        [targetCompanion!.id, targetMessage!.id],
        [unrelatedCompanion!.id, unrelatedMessage!.id],
        [workspaceChannel!.id, channelMessage!.id],
        claimed!.job.id
      ]
    );
    expect(after.rows[0]).toMatchObject({
      target_grant_lifecycle: "purged",
      target_representation_state: "purged",
      target_chunks: "0",
      target_companion_lifecycle: "purged",
      target_payloads: "0",
      target_messages: "0",
      target_outbox: "0",
      unrelated_grant_lifecycle: "active",
      unrelated_representation_state: "available",
      unrelated_companion_lifecycle: "active",
      unrelated_messages: "1",
      channel_lifecycle: "active",
      channel_messages: "1",
      completion_audits: "1"
    });
    for (const count of [
      after.rows[0]!.unrelated_chunks,
      after.rows[0]!.unrelated_payloads,
      after.rows[0]!.unrelated_outbox,
      after.rows[0]!.channel_payloads,
      after.rows[0]!.channel_outbox
    ]) {
      expect(Number(count)).toBeGreaterThan(0);
    }
    const evidence = await pool.query<{
      artifact_kind: string;
      state: string;
      removed_record_count: string;
    }>(
      `select artifact_kind, state, removed_record_count::text
         from purge_job_evidence
        where purge_job_id = $1
        order by artifact_kind`,
      [claimed!.job.id]
    );
    expect(
      evidence.rows.filter((row) =>
        ["search_index", "vector"].includes(row.artifact_kind)
      )
    ).toEqual([
      {
        artifact_kind: "search_index",
        state: "verified",
        removed_record_count: "0"
      },
      {
        artifact_kind: "vector",
        state: "verified",
        removed_record_count: "0"
      }
    ]);
    expect(
      evidence.rows.find((row) => row.artifact_kind === "encrypted_payload")
        ?.removed_record_count
    ).toBe(
      String(
        Number(before.rows[0]!.target_chunks) +
          Number(before.rows[0]!.target_share_payloads)
      )
    );
    const decision = await pool.query<{ policy_id: string; state: string }>(
      `select decision.policy_id, job.state
         from purge_jobs job
         join retention_decisions decision
           on decision.id = job.retention_decision_id
        where job.id = $1`,
      [claimed!.job.id]
    );
    expect(decision.rows[0]).toEqual({
      policy_id: grantPolicy.policyId,
      state: "verified"
    });
    await expect(
      pool.query(
        `select acknowledged_event_id, acknowledged_cursor::text,
                snapshot_high_water_cursor
           from collaboration_stream_subscriptions where id = $1`,
        [streamSubscription.rows[0]!.id]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          acknowledged_event_id: null,
          acknowledged_cursor: "0",
          snapshot_high_water_cursor: null
        }
      ]
    });
  });

  it("treats companion thread and message-range holds as part of the Share Grant purge scope", async () => {
    const fixture = await createWorkspaceFixture({
      retentionSeconds: 0,
      backupRetentionSeconds: 0
    });
    const grant = await createGrant(fixture, { label: "companion-hold" });
    await materialize(fixture, grant);
    const companion = await collaboration.createThread(
      actor(fixture.ownerUserId),
      {
        kind: "shared_session_discussion",
        idempotencyKey: `companion-hold:${randomUUID()}`,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        sharedLogicalMemoryId: grant.logicalMemoryId,
        shareGrantId: grant.shareGrantId
      }
    );
    await collaboration.sendMessage(actor(fixture.ownerUserId), {
      threadId: companion!.id,
      idempotencyKey: `companion-hold-message:${randomUUID()}`,
      bodyText: `held-companion-${randomUUID()}`,
      metadata: { held: true }
    });
    const freshlyAuthenticatedAt = new Date();
    const threadHold = await retentionRepository.placeLegalHold({
      target: {
        scope: "thread",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        threadId: companion!.id
      },
      actorUserId: fixture.ownerUserId,
      authority: "team.compliance",
      reasonCode: "companion_thread_hold",
      reasonHash: hash("companion thread hold"),
      freshlyAuthenticatedAt
    });
    const rangeHold = await retentionRepository.placeLegalHold({
      target: {
        scope: "team_message_range",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        threadId: companion!.id,
        messageRangeStart: 1,
        messageRangeEnd: 1
      },
      actorUserId: fixture.ownerUserId,
      authority: "team.compliance",
      reasonCode: "companion_message_hold",
      reasonHash: hash("companion message hold"),
      freshlyAuthenticatedAt
    });
    await repository.revokeShareGrant(actor(fixture.ownerUserId), {
      mutationId: randomUUID(),
      shareGrantId: grant.shareGrantId,
      expectedGrantVersion: grant.grantVersion,
      reasonCode: "held_share_revocation",
      authority: authority(fixture)
    });
    const scheduled = await pool.query<{
      job_id: string;
      applicable_legal_hold_ids: string[];
    }>(
      `select job.id as job_id, decision.applicable_legal_hold_ids
         from team_memory_share_grants grant_row
         join retention_decisions decision
           on decision.id = grant_row.active_retention_decision_id
         join purge_jobs job on job.id = grant_row.active_purge_job_id
        where grant_row.id = $1`,
      [grant.shareGrantId]
    );
    expect(scheduled.rows[0]!.applicable_legal_hold_ids.sort()).toEqual(
      [threadHold.id, rangeHold.id].sort()
    );
    await expect(retentionRepository.claimNextPurgeJob()).resolves.toBeNull();
    await expect(
      pool.query(
        `select grant_row.lifecycle, job.state,
                (select count(*)::text from team_memory_representation_chunks
                  where share_grant_id = grant_row.id) as chunks,
                (select count(*)::text from collaboration_messages
                  where thread_id = $2) as messages
           from team_memory_share_grants grant_row
           join purge_jobs job on job.id = grant_row.active_purge_job_id
          where grant_row.id = $1`,
        [grant.shareGrantId, companion!.id]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          lifecycle: "purge_pending",
          state: "blocked",
          chunks: "1",
          messages: "1"
        }
      ]
    });
    for (const hold of [threadHold, rangeHold]) {
      await retentionRepository.requestLegalHoldRelease({
        holdId: hold.id,
        actorUserId: fixture.ownerUserId
      });
      await retentionRepository.confirmLegalHoldRelease({
        holdId: hold.id,
        actorUserId: fixture.managerUserId
      });
    }
    await pool.query(
      "update purge_jobs set next_attempt_at = now() - interval '1 second' where id = $1",
      [scheduled.rows[0]!.job_id]
    );
    const claimed = await retentionRepository.claimNextPurgeJob();
    expect(claimed?.job.id).toBe(scheduled.rows[0]!.job_id);
    await retentionRepository.processClaimedPurgeJob({
      purgeJobId: claimed!.job.id,
      purgeAttemptId: claimed!.attempt.id
    });
    await expect(
      retentionRepository.completePurgeJob(claimed!.job.id)
    ).resolves.toMatchObject({ completed: true });
  });

  it("replays a revoked Share Grant idempotently after its outbox event is pruned", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "pruned-revoke-replay" });
    await materialize(fixture, grant);
    const mutationId = randomUUID();
    const input = {
      mutationId,
      shareGrantId: grant.shareGrantId,
      expectedGrantVersion: grant.grantVersion,
      reasonCode: "pruned_revoke_replay",
      authority: authority(fixture)
    };
    const revoked = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      input
    );
    const revokeEvent = await pool.query<{ id: string }>(
      `update collaboration_outbox
          set occurred_at = now() - interval '2 seconds',
              replay_until = now() - interval '1 second'
        where mutation_id = $1 and family = 'access_revoked'
        returning id`,
      [mutationId]
    );
    expect(revokeEvent.rows).toHaveLength(1);
    const pruned = await collaboration.pruneExpiredReplayHistory({
      limit: 10_000
    });
    expect(pruned.deletedEventCount).toBeGreaterThanOrEqual(1);
    const replayed = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      input
    );
    expect(replayed).toEqual(revoked);
    const durable = await pool.query<{
      decisions: string;
      jobs: string;
      revoke_events: string;
      trigger_epoch: string;
      target_epoch: string;
    }>(
      `select
         (select count(*)::text from retention_decisions
           where share_grant_id = $1 and trigger = 'share_revoked') as decisions,
         (select count(*)::text from purge_jobs
           where share_grant_id = $1) as jobs,
         (select count(*)::text from collaboration_outbox
           where mutation_id = $2 and family = 'access_revoked') as revoke_events,
         decision.trigger_epoch::text,
         job.target_epoch::text
       from team_memory_share_grants grant_row
       join retention_decisions decision
         on decision.id = grant_row.active_retention_decision_id
       join purge_jobs job on job.id = grant_row.active_purge_job_id
       where grant_row.id = $1`,
      [grant.shareGrantId, mutationId]
    );
    expect(durable.rows[0]).toEqual({
      decisions: "1",
      jobs: "1",
      revoke_events: "0",
      trigger_epoch: "1",
      target_epoch: "1"
    });
  });

  it("reveals retained companion history only after a future member receives current Workspace Access", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      label: "future-member-history"
    });
    await materialize(fixture, grant);
    const discussion = await collaboration.createThread(
      actor(fixture.ownerUserId),
      {
        kind: "shared_session_discussion",
        idempotencyKey: "future-member-history",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        sharedLogicalMemoryId: grant.logicalMemoryId,
        shareGrantId: grant.shareGrantId
      }
    );
    if (!discussion) throw new Error("Expected companion thread creation");
    const historicalText = `retained-companion-${randomUUID()}`;
    await collaboration.sendMessage(actor(fixture.ownerUserId), {
      threadId: discussion.id,
      idempotencyKey: "retained-before-member-joins",
      bodyText: historicalText,
      metadata: { channel: "discussion" }
    });

    const unrelatedGrant = await createGrant(fixture, {
      label: "unrelated-companion"
    });
    await materialize(fixture, unrelatedGrant);
    const unrelatedDiscussion = await collaboration.createThread(
      actor(fixture.ownerUserId),
      {
        kind: "shared_session_discussion",
        idempotencyKey: "unrelated-companion",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        sharedLogicalMemoryId: unrelatedGrant.logicalMemoryId,
        shareGrantId: unrelatedGrant.shareGrantId
      }
    );
    if (!unrelatedDiscussion) {
      throw new Error("Expected unrelated companion thread creation");
    }

    const decryptsBeforeMembership = decryptCount();
    await expect(
      collaboration.listMessages(actor(fixture.outsiderUserId), {
        threadId: discussion.id,
        limit: 20
      })
    ).resolves.toBeNull();
    expect(decryptCount()).toBe(decryptsBeforeMembership);

    await pool.query(
      `insert into team_memberships (
         team_id,user_id,role,status,accepted_at
       ) values ($1,$2,'member','enabled',now())`,
      [fixture.teamId, fixture.outsiderUserId]
    );
    const decryptsBeforeWorkspaceAccess = decryptCount();
    await expect(
      collaboration.listMessages(actor(fixture.outsiderUserId), {
        threadId: discussion.id,
        limit: 20
      })
    ).resolves.toBeNull();
    expect(decryptCount()).toBe(decryptsBeforeWorkspaceAccess);

    await pool.query(
      `insert into team_workspace_access_grants (
         team_workspace_id,team_id,user_id,access,
         can_share_owned_memory,granted_by_user_id
       ) values ($1,$2,$3,'read',false,$4)`,
      [
        fixture.teamWorkspaceId,
        fixture.teamId,
        fixture.outsiderUserId,
        fixture.managerUserId
      ]
    );
    const authorizedHistory = await collaboration.listMessages(
      actor(fixture.outsiderUserId),
      { threadId: discussion.id, limit: 20 }
    );
    expect(authorizedHistory?.messages).toHaveLength(1);
    expect(authorizedHistory?.messages[0]?.bodyText).toBe(historicalText);

    const unrelatedHistory = await collaboration.listMessages(
      actor(fixture.outsiderUserId),
      { threadId: unrelatedDiscussion.id, limit: 20 }
    );
    expect(unrelatedHistory?.messages).toEqual([]);
    const storedMessages = await pool.query<{
      thread_id: string;
      count: string;
    }>(
      `select thread_id,count(*)::text as count
         from collaboration_messages
        where thread_id=any($1::uuid[])
        group by thread_id`,
      [[discussion.id, unrelatedDiscussion.id]]
    );
    expect(storedMessages.rows).toEqual([
      { thread_id: discussion.id, count: "1" }
    ]);
  });

  it("is idempotent under concurrent grant and representation retries", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 2);
    await putOwnerPolicy(fixture, source);
    const created = await createConsent(fixture, source, {
      representation: "memory_events",
      mode: "continuous",
      label: "concurrent"
    });
    const logicalGrantId = randomUUID();
    const mutationId = randomUUID();
    const create = () =>
      repository.createShareGrant(actor(fixture.ownerUserId), {
        mutationId,
        logicalGrantId,
        consentId: created.consentId,
        authority: authority(fixture)
      });
    const grants = await Promise.all([create(), create(), create()]);
    expect(new Set(grants.map((grant) => grant.id)).size).toBe(1);
    const shareGrantId = grants[0]!.id;
    const outbox = await pool.query<{ count: string }>(
      `select count(*)::text as count from collaboration_outbox
       where mutation_id = $1 and family = 'share_grant_lifecycle'`,
      [mutationId]
    );
    expect(outbox.rows[0]?.count).toBe("1");

    const materializationMutationId = randomUUID();
    const preview = await createPersistedPreview(
      fixture,
      source,
      "memory_events",
      source.currentRevision,
      "concurrent"
    );
    const encryptionsBeforeMaterialize = encryptSpy.mock.calls.length;
    const materializeRetry = () =>
      repository.materializeGrantRepresentation(actor(fixture.ownerUserId), {
        mutationId: materializationMutationId,
        shareGrantId,
        consentId: created.consentId,
        expectedGrantVersion: grants[0]!.grantVersion,
        preview
      });
    const representations = await Promise.all([
      materializeRetry(),
      materializeRetry(),
      materializeRetry()
    ]);
    expect(new Set(representations.map((item) => item.id)).size).toBe(1);
    expect(encryptSpy.mock.calls.length - encryptionsBeforeMaterialize).toBe(1);
    const rows = await pool.query<{ count: string }>(
      `select count(*)::text as count from team_memory_representations
       where share_grant_id = $1 and state = 'available'`,
      [shareGrantId]
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("preserves one durable Share Grant identity per logical memory and destination", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "durable-grant" });
    const revoked = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion,
        reasonCode: "owner_withdrawal",
        authority: authority(fixture)
      }
    );
    expect(revoked.lifecycle).toBe("revoked");

    const replacement = await createConsent(fixture, grant, {
      representation: "memory_events",
      mode: "continuous",
      label: "replacement-grant"
    });
    await expect(
      repository.createShareGrant(actor(fixture.ownerUserId), {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: replacement.consentId,
        authority: authority(fixture)
      })
    ).rejects.toThrow(
      "This logical memory already has a Share Grant for the destination Workspace"
    );

    const stored = await pool.query<{ count: string }>(
      `select count(*)::text as count from team_memory_share_grants
       where logical_memory_id=$1 and team_workspace_id=$2`,
      [grant.logicalMemoryId, fixture.teamWorkspaceId]
    );
    expect(stored.rows[0]?.count).toBe("1");
  });
  const executeNativeRuleOperation = async <T>(
    fixture: WorkspaceFixture,
    bind: (referenceId: string) => SharedMemoryActionGrantBinding,
    run: (
      scoped: SharedMemoryRepository,
      approved: SharedMemoryAuthorityContext
    ) => Promise<T>,
    approvalTier: "native_review" | "direct" = "native_review"
  ) => {
    const highRisk = createHighRiskActionRepository(createDb(pool), {
      pool,
      envelopeEncryptionProvider: privacyProvider,
      teamEnvelopeEncryptionProvider: provider,
      ownerPrivateReplicaEnvelopeEncryptionProvider: ownerProvider
    });
    const upstreamBackendId = (
      await pool.query<{ upstream_backend_id: string }>(
        "select upstream_backend_id from device_credentials where id=$1",
        [fixture.deviceCredentialId]
      )
    ).rows[0]!.upstream_backend_id;
    const requestId = randomUUID(),
      secret = `hrg_${randomBytes(32).toString("base64url")}`;
    const binding = bind(requestId);
    const context = {
      ownerUserId: fixture.ownerUserId,
      deviceCredentialId: fixture.deviceCredentialId,
      upstreamBackendId
    };
    const operation = {
      ...context,
      operationFamily: binding.operationFamily,
      action: binding.action,
      teamId: binding.teamId,
      targetId: binding.targetId,
      scopeHash: binding.scopeHash,
      requestHash: binding.requestHash
    };
    await highRisk.createActionGrant({
      ...operation,
      clientRequestId: requestId,
      grantCommitment: highRiskActionGrantCommitment(secret),
      credentialOperationFamily: "share_grant_management",
      approvalTier,
      review:
        approvalTier === "native_review"
          ? {
              version: 1,
              title: "Change rule detail",
              description: "Review the exact rule detail.",
              consequence: "Apply this rule's reviewed cap.",
              confirmLabel: "Approve",
              details: []
            }
          : null
    });
    if (approvalTier === "native_review")
      await highRisk.decideNativeActionReview({
        ...context,
        clientRequestId: requestId,
        decision: "approve"
      });
    const result = await highRisk.executeActionGrant({
      ...operation,
      actionGrant: secret,
      execute: async ({ sharedMemory }) => ({
        statusCode: 200,
        body: await run(sharedMemory, {
          action: SHARED_MEMORY_AUTHORITY,
          source: "device_action_grant",
          referenceId: requestId
        })
      })
    });
    expect(result).toMatchObject({ statusCode: 200 });
    return result!.body;
  };

  const executeWorkspaceRestoration = (
    fixture: WorkspaceFixture,
    intent: import("@koed/shared").WorkspaceConversationRestorationIntent & {
      authority?: SharedMemoryAuthorityContext;
    }
  ) =>
    executeNativeRuleOperation(
      fixture,
      (referenceId) =>
        sharedMemoryWorkspaceRestorationActionGrantBinding({
          ...intent,
          referenceId
        }),
      (scoped, approved) =>
        scoped.restoreWorkspaceConversation(actor(fixture.ownerUserId), {
          ...intent,
          authority: approved
        })
    );

  const executeDetailAmendment = (
    fixture: WorkspaceFixture,
    intent: import("@koed/shared").SharingRuleDetailIntent
  ) =>
    executeNativeRuleOperation(
      fixture,
      (referenceId) =>
        sharedMemoryRuleDetailActionGrantBinding({ ...intent, referenceId }),
      (scoped, approved) =>
        scoped.amendSharingRuleDetail(actor(fixture.ownerUserId), {
          ...intent,
          authority: approved
        })
    );

  const verifyRulePolicyHistory = async (
    capScope: "none" | "owner" | "team" | "workspace",
    lifecycle: "active" | "paused" = "paused",
    independentRollup = false,
    excludeDuringReprocessing = false
  ) => {
    const fixture = await createWorkspaceFixture();
    const owner = actor(fixture.ownerUserId),
      reader = actor(fixture.readerUserId);
    const source = await createSource(fixture, 1, "rule-policy-history");
    await putOwnerPolicy(fixture, source);
    const consent = await createConsent(fixture, source, {
      representation: "memory_events",
      mode: "continuous",
      label: "rule-policy-history"
    });
    const deploymentIdentityId = (
      await pool.query<{ id: string }>(
        "select id from deployment_identities where locality='local' and disabled_at is null"
      )
    ).rows[0]!.id;
    const globalPolicy = await privacyRepository.resolveEffectiveContentPolicy({
      deploymentIdentityId,
      sourceOwnerUserId: fixture.ownerUserId,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.teamWorkspaceId
    });
    const rule = await repository.createConversationSharingRule(owner, {
      ruleId: randomUUID(),
      mutationId: randomUUID(),
      logicalGrantId: randomUUID(),
      consentId: consent.consentId,
      expectedConsentVersion: consent.consent.consentVersion,
      expectedGrantVersion: null,
      publisherCredentialId: fixture.deviceCredentialId,
      effectivePrivacyPolicyHash: globalPolicy.effectivePolicyHash,
      authority: authority(fixture)
    });
    const state = async () =>
      (
        await pool.query<{
          authority_version: number;
          publisher_fence: string;
          grant_version: number;
          consent_version: number;
        }>(
          `select rule.authority_version,rule.publisher_fence,g.grant_version,c.consent_version
      from team_memory_sharing_rules rule join team_memory_share_grants g on g.id=$2
      join source_owner_representation_consents c on c.id=$3 where rule.id=$1`,
          [rule.ruleId, rule.shareGrantId, consent.consentId]
        )
      ).rows[0]!;
    const prepareCurrentPolicy = async (effectivePrivacyPolicyHash: string) => {
      const current = await state();
      await repository.prepareSharingRuleMember(owner, {
        shareGrantId: rule.shareGrantId,
        expectedGrantVersion: current.grant_version,
        ruleAuthority: {
          ruleId: rule.ruleId,
          reasonId: rule.reasonId,
          authorityVersion: current.authority_version,
          consentVersion: current.consent_version,
          publisherCredentialId: fixture.deviceCredentialId,
          publisherFence: Number(current.publisher_fence),
          effectivePrivacyPolicyHash
        }
      });
    };
    await prepareCurrentPolicy(globalPolicy.effectivePolicyHash);
    await flushSanitizedSemanticPublication();
    const read = (
      representation: SharedMemoryRepresentation = "memory_events"
    ) =>
      repository.readGrantRepresentation(reader, {
        shareGrantId: rule.shareGrantId,
        representation
      });
    expect(await read()).toMatchObject({
      representation: { sourceRevision: 1 }
    });
    if (independentRollup) {
      const otherConsent = await createConsent(fixture, source, {
        representation: "lcm_rollups",
        representations: ["lcm_rollups"],
        mode: "continuous",
        label: "independent-policy-rollup"
      });
      const root = (
        await pool.query<{ logical_grant_id: string; grant_version: number }>(
          "select logical_grant_id,grant_version from team_memory_share_grants where id=$1",
          [rule.shareGrantId]
        )
      ).rows[0]!;
      const other = await repository.createConversationSharingRule(owner, {
        ruleId: randomUUID(),
        mutationId: randomUUID(),
        logicalGrantId: root.logical_grant_id,
        consentId: otherConsent.consentId,
        expectedConsentVersion: otherConsent.consent.consentVersion,
        expectedGrantVersion: root.grant_version,
        publisherCredentialId: fixture.deviceCredentialId,
        effectivePrivacyPolicyHash: globalPolicy.effectivePolicyHash,
        authority: authority(fixture)
      });
      const current = await state();
      await repository.prepareSharingRuleMember(owner, {
        shareGrantId: rule.shareGrantId,
        expectedGrantVersion: current.grant_version,
        ruleAuthority: {
          ruleId: other.ruleId,
          reasonId: other.reasonId,
          authorityVersion: other.authorityVersion,
          consentVersion: otherConsent.consent.consentVersion,
          publisherCredentialId: fixture.deviceCredentialId,
          publisherFence: other.publisherFence,
          effectivePrivacyPolicyHash: globalPolicy.effectivePolicyHash
        }
      });
      await flushSanitizedSemanticPublication();
      const published = await state();
      await repository.controlConversationSharingRule(owner, {
        ruleId: other.ruleId,
        reasonId: other.reasonId,
        shareGrantId: rule.shareGrantId,
        mutationId: randomUUID(),
        expectedAuthorityVersion: other.authorityVersion,
        expectedGrantVersion: published.grant_version,
        action: "pause",
        authority: authority(fixture),
        destination: {
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId
        }
      });
    }
    const recallQuery = {
      teamWorkspaceId: fixture.teamWorkspaceId,
      queryVector: [1, ...Array.from({ length: 383 }, () => 0)],
      model: "rule-content-policy-test",
      version: "rule-content-policy-test-v1",
      dimensions: 384 as const,
      limit: 20,
      searchDomain: "global" as const,
      representations: ["memory_events" as const]
    };
    for (const item of await repository.listPendingSharedMemorySemanticItems({
      limit: 100
    })) {
      if (item.shareGrantId === rule.shareGrantId)
        await repository.storeSharedMemorySemanticEmbedding({
          semanticItemId: item.semanticItemId,
          contentHash: item.contentHash,
          model: recallQuery.model,
          version: recallQuery.version,
          dimensions: recallQuery.dimensions,
          vector: recallQuery.queryVector
        });
    }
    const cachedCandidates =
      await repository.searchAuthorizedSharedMemorySemanticItems(
        reader,
        recallQuery
      );
    expect(cachedCandidates.length).toBeGreaterThan(0);
    const beforePause = await state();
    if (lifecycle === "paused")
      await repository.controlConversationSharingRule(owner, {
        ruleId: rule.ruleId,
        reasonId: rule.reasonId,
        shareGrantId: rule.shareGrantId,
        mutationId: randomUUID(),
        expectedAuthorityVersion: beforePause.authority_version,
        expectedGrantVersion: beforePause.grant_version,
        action: "pause",
        authority: authority(fixture),
        destination: {
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId
        }
      });
    await ensureSourceRevision(fixture, source, 2, "pending-policy-revision");
    // Leave current-build processing in flight when the reviewed policy changes.
    // A paused rule must continue to use its published revision, while an active
    // rule may catch up only after processing under the amended policy.
    const obsoleteTargets = [];
    if (lifecycle === "active") {
      await prepareCurrentPolicy(globalPolicy.effectivePolicyHash);
      obsoleteTargets.push(
        ...(
          await repository.listPendingSemanticPrivacyTargets({
            shareGrantId: rule.shareGrantId,
            limit: 100
          })
        ).filter(
          (target) =>
            !independentRollup || target.representation === "memory_events"
        )
      );
      expect(obsoleteTargets.length).toBeGreaterThan(0);
      for (const target of obsoleteTargets) {
        expect(
          await repository.claimSemanticPrivacyTarget(owner, {
            semanticPreviewId: target.id,
            claimantId: "policy-amendment-in-flight-worker",
            leaseMs: 120_000,
            expectedWorkIdentity:
              sharedMemorySemanticPrivacyWorkIdentity(target)
          })
        ).not.toBeNull();
      }
    }
    if (capScope !== "none") {
      const table =
        capScope === "owner"
          ? "source_owner_representation_policies"
          : capScope === "team"
            ? "team_representation_policies"
            : "workspace_representation_policies";
      const identity =
        capScope === "owner"
          ? source.logicalMemoryId
          : capScope === "team"
            ? fixture.teamId
            : fixture.teamWorkspaceId;
      const column =
        capScope === "owner"
          ? "logical_memory_id"
          : capScope === "team"
            ? "team_id"
            : "team_workspace_id";
      const current = (
        await pool.query<{ version: number }>(
          `select version from ${table} where ${column}=$1 and superseded_at is null`,
          [identity]
        )
      ).rows[0]!;
      const policy = {
        mutationId: randomUUID(),
        expectedCurrentVersion: current.version,
        maximumFidelity: "lcm_rollups" as const,
        includeCuratedMemory: false
      };
      if (capScope === "owner")
        await repository.putSourceOwnerPolicy(owner, {
          ...policy,
          logicalMemoryId: source.logicalMemoryId
        });
      else if (capScope === "team")
        await repository.putTeamPolicy(owner, {
          ...policy,
          teamId: fixture.teamId
        });
      else
        await repository.putWorkspacePolicy(owner, {
          ...policy,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId
        });
      expect(await read()).toBeNull();
    }
    const retainedKind = capScope === "none" ? "memory_events" : "lcm_rollups";
    const ownerPolicies = async () =>
      (
        await pool.query<Record<string, unknown>>(
          "select policy_id,version,policy_hash,maximum_fidelity,include_curated_memory from source_owner_representation_policies where logical_memory_id=$1 order by version",
          [source.logicalMemoryId]
        )
      ).rows;
    const retainedPolicies = await ownerPolicies();
    const review = async (labels: ReturnType<typeof noPrivacyLabelsPolicy>) => {
      const value = await repository.getSharingRuleContentPolicyReview(owner, {
        ruleId: rule.ruleId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        labels
      });
      expect(value).not.toBeNull();
      return value!;
    };
    const execute = (
      intent: import("@koed/shared").SharingRuleContentPolicyIntent
    ) =>
      executeNativeRuleOperation(
        fixture,
        (referenceId) =>
          sharedMemoryRuleContentPolicyActionGrantBinding({
            ...intent,
            referenceId
          }),
        (scoped, approved) =>
          scoped.amendSharingRuleContentPolicy(owner, {
            ...intent,
            authority: approved
          })
      );
    const restrictive = {
      mutationId: randomUUID(),
      review: await review({ ...noPrivacyLabelsPolicy(), private_email: true })
    };
    expect(restrictive.review.disclosureIncrease).toBe(false);
    const restricted = await execute(restrictive);
    expect(restricted).toMatchObject({
      state: lifecycle,
      contentPolicyVersion: 1
    });
    expect(await read(retainedKind)).toBeNull();
    if (independentRollup) {
      // The independent reason permits the old rollup, never its richer detail.
      // It must not lend its unmasked policy to this rule's Memory Events.
      expect(await read("lcm_rollups")).toMatchObject({
        representation: {
          sourceRevision: 1,
          effectivePrivacyPolicyHash: globalPolicy.effectivePolicyHash
        }
      });
      expect(await read("lcm_leaves")).toBeNull();
    }
    expect(
      await repository.searchAuthorizedSharedMemorySemanticItems(
        reader,
        recallQuery
      )
    ).toEqual([]);
    for (const candidate of cachedCandidates)
      expect(
        await repository.expandAuthorizedSharedMemorySemanticItem(reader, {
          teamWorkspaceId: fixture.teamWorkspaceId,
          candidateId: candidate.candidateId,
          searchDomain: "global"
        })
      ).toBeNull();
    for (const target of obsoleteTargets) {
      expect(
        await repository.readPendingSemanticPrivacyTarget(owner, {
          semanticPreviewId: target.id,
          expectedSourcePreviewHash: target.sourcePreviewHash,
          expectedSourceArtifactHash: target.sourceArtifactHash,
          expectedSourceManifestHash: target.sourceManifestHash,
          expectedClassifierHash: target.classifierHash,
          expectedEffectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash
        })
      ).toBeNull();
      expect(
        await repository.claimSemanticPrivacyTarget(owner, {
          semanticPreviewId: target.id,
          claimantId: "obsolete-policy-worker",
          leaseMs: 120_000,
          expectedWorkIdentity: sharedMemorySemanticPrivacyWorkIdentity(target)
        })
      ).toBeNull();
    }
    expect(await execute(restrictive)).toEqual(restricted);
    await expect(
      execute({ ...restrictive, mutationId: randomUUID() })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    if (excludeDuringReprocessing) {
      await prepareCurrentPolicy(restricted.effectivePrivacyPolicyHash);
      const targets = await repository.listPendingSemanticPrivacyTargets({
        shareGrantId: rule.shareGrantId,
        limit: 100
      });
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets)
        expect(
          await repository.claimSemanticPrivacyTarget(owner, {
            semanticPreviewId: target.id,
            claimantId: "excluded-policy-worker",
            leaseMs: 120_000,
            expectedWorkIdentity:
              sharedMemorySemanticPrivacyWorkIdentity(target)
          })
        ).not.toBeNull();
      const exclusion =
        await repository.getWorkspaceConversationExclusionReview(owner, {
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId
        });
      await repository.excludeWorkspaceConversation(owner, {
        mutationId: randomUUID(),
        scope: exclusion!.scope,
        authority: authority(fixture)
      });
      await expect(
        prepareCurrentPolicy(restricted.effectivePrivacyPolicyHash)
      ).rejects.toBeInstanceOf(SharedMemoryConflictError);
      for (const target of targets)
        expect(
          await repository.readPendingSemanticPrivacyTarget(owner, {
            semanticPreviewId: target.id,
            expectedSourcePreviewHash: target.sourcePreviewHash,
            expectedSourceArtifactHash: target.sourceArtifactHash,
            expectedSourceManifestHash: target.sourceManifestHash,
            expectedClassifierHash: target.classifierHash,
            expectedEffectivePrivacyPolicyHash:
              target.effectivePrivacyPolicyHash
          })
        ).toBeNull();
      await flushSanitizedSemanticPublication();
      expect(await read()).toBeNull();
      expect(
        await repository.searchAuthorizedSharedMemorySemanticItems(
          reader,
          recallQuery
        )
      ).toEqual([]);
      const restoration =
        await repository.getWorkspaceConversationRestorationReview(owner, {
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId
        });
      await executeWorkspaceRestoration(fixture, {
        mutationId: randomUUID(),
        scope: restoration!.scope,
        restoration: restoration!,
        authority: authority(fixture)
      });
    }
    const reprocess = async () => {
      await repository.invalidateStaleSemanticPreviews({ limit: 500 });
      const prepared = await repository.reconcileSharingRuleMembers({
        limit: 100
      });
      expect(prepared.failed).toBe(0);
      expect(prepared.prepared).toBeGreaterThan(0);
      await flushSanitizedSemanticPublication();
    };
    await reprocess();
    expect(await read(retainedKind)).toMatchObject({
      representation: {
        sourceRevision: lifecycle === "active" ? 2 : 1,
        effectivePrivacyPolicyHash: restricted.effectivePrivacyPolicyHash
      }
    });
    const broader = {
      mutationId: randomUUID(),
      review: await review(noPrivacyLabelsPolicy())
    };
    expect(broader.review.disclosureIncrease).toBe(
      !globalPolicy.labels.private_email
    );
    // Merely reviewing a broader policy must not change published authority.
    expect(await read(retainedKind)).toMatchObject({
      representation: {
        effectivePrivacyPolicyHash: restricted.effectivePrivacyPolicyHash
      }
    });
    const restored = await execute(broader);
    expect(restored).toMatchObject({
      state: lifecycle,
      contentPolicyVersion: 2,
      effectivePrivacyPolicyHash: globalPolicy.effectivePolicyHash
    });
    await reprocess();
    expect(await read(retainedKind)).toMatchObject({
      representation: {
        sourceRevision: lifecycle === "active" ? 2 : 1,
        effectivePrivacyPolicyHash: globalPolicy.effectivePolicyHash
      }
    });
    if (lifecycle === "active") {
      await ensureSourceRevision(
        fixture,
        source,
        3,
        "future-approved-policy-revision"
      );
      await prepareCurrentPolicy(restored.effectivePrivacyPolicyHash);
      await flushSanitizedSemanticPublication();
      expect(await read(retainedKind)).toMatchObject({
        representation: {
          sourceRevision: 3,
          effectivePrivacyPolicyHash: restored.effectivePrivacyPolicyHash
        }
      });
    }
    if (capScope !== "none") expect(await read("memory_events")).toBeNull();
    expect(await ownerPolicies()).toEqual(retainedPolicies);
    expect(
      (
        await pool.query(
          "select state from team_memory_sharing_rules where id=$1",
          [rule.ruleId]
        )
      ).rows[0]
    ).toEqual({ state: lifecycle });
    if (lifecycle === "paused")
      expect(
        (
          await pool.query(
            "select count(*)::integer count from team_memory_reason_publications publication join team_memory_representations representation on representation.id=publication.representation_id where publication.reason_id=$1 and representation.source_revision>1",
            [rule.reasonId]
          )
        ).rows[0]
      ).toEqual({ count: 0 });
    if (lifecycle === "active") {
      const current = await state();
      await repository.controlConversationSharingRule(owner, {
        ruleId: rule.ruleId,
        reasonId: rule.reasonId,
        shareGrantId: rule.shareGrantId,
        mutationId: randomUUID(),
        expectedAuthorityVersion: current.authority_version,
        expectedGrantVersion: current.grant_version,
        action: "stop",
        authority: authority(fixture),
        destination: {
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId
        }
      });
      const stopped = await execute({
        mutationId: randomUUID(),
        review: await review({
          ...noPrivacyLabelsPolicy(),
          private_email: true
        })
      });
      expect(stopped).toMatchObject({
        state: "stopped",
        contentPolicyVersion: 3
      });
      expect(await execute(broader)).toEqual(restored);
      expect(
        (
          await pool.query<{ state: string }>(
            "select state from team_memory_sharing_rules where id=$1",
            [rule.ruleId]
          )
        ).rows[0]
      ).toEqual({ state: "stopped" });
      await expect(
        prepareCurrentPolicy(stopped.effectivePrivacyPolicyHash)
      ).rejects.toBeInstanceOf(SharedMemoryConflictError);
      expect(await read("memory_events")).toBeNull();
      if (independentRollup)
        expect(await read("lcm_rollups")).toMatchObject({
          representation: { sourceRevision: 1 }
        });
    }
  };

  it("reprocesses paused rule policy from exact published history and restores its prior policy", async () => {
    await verifyRulePolicyHistory("none");
  }, 90_000);
  it.each(["owner", "team", "workspace"] as const)(
    "reprocesses paused rule policy under a reduced current %s detail limit",
    async (scope) => {
      await verifyRulePolicyHistory(scope);
    },
    90_000
  );

  it("reprocesses active rule policy while rejecting claimed obsolete work and awaiting broader approval", async () => {
    await verifyRulePolicyHistory("none", "active");
  }, 90_000);

  it("keeps an independent paused rollup without lending its content policy to active rule detail", async () => {
    await verifyRulePolicyHistory("none", "active", true);
  }, 90_000);

  it("blocks claimed policy reprocessing while excluded and resumes only after reviewed restoration", async () => {
    await verifyRulePolicyHistory("none", "active", false, true);
  }, 90_000);

  it("amends rule detail with immediate read restrictions, exact retained revisions and unchanged lifecycle", async () => {
    const fixture = await createWorkspaceFixture();
    const owner = actor(fixture.ownerUserId),
      reader = actor(fixture.readerUserId);
    const source = await createSource(fixture, 1, "rule-detail");
    await putOwnerPolicy(fixture, source);
    const consent = await createConsent(fixture, source, {
      representation: "memory_events",
      mode: "continuous",
      label: "rule-detail"
    });
    const deploymentIdentityId = (
      await pool.query<{ id: string }>(
        "select id from deployment_identities where locality='local' and disabled_at is null"
      )
    ).rows[0]!.id;
    const effectivePrivacyPolicyHash = (
      await privacyRepository.resolveEffectiveContentPolicy({
        deploymentIdentityId,
        sourceOwnerUserId: fixture.ownerUserId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId
      })
    ).effectivePolicyHash;
    const rule = await repository.createConversationSharingRule(owner, {
      ruleId: randomUUID(),
      mutationId: randomUUID(),
      logicalGrantId: randomUUID(),
      consentId: consent.consentId,
      expectedConsentVersion: consent.consent.consentVersion,
      expectedGrantVersion: null,
      publisherCredentialId: fixture.deviceCredentialId,
      effectivePrivacyPolicyHash: effectivePrivacyPolicyHash,
      authority: authority(fixture)
    });
    const current = async () =>
      (
        await pool.query<{
          authority_version: number;
          publisher_fence: string;
          grant_version: number;
          consent_version: number;
        }>(
          `select rule.authority_version,rule.publisher_fence,g.grant_version,c.consent_version
      from team_memory_sharing_rules rule join team_memory_share_grants g on g.id=$2
      join source_owner_representation_consents c on c.id=$3 where rule.id=$1`,
          [rule.ruleId, rule.shareGrantId, consent.consentId]
        )
      ).rows[0]!;
    const prepare = async () => {
      const state = await current();
      await repository.prepareSharingRuleMember(owner, {
        shareGrantId: rule.shareGrantId,
        expectedGrantVersion: state.grant_version,
        ruleAuthority: {
          reasonId: rule.reasonId,
          ruleId: rule.ruleId,
          authorityVersion: state.authority_version,
          consentVersion: state.consent_version,
          publisherCredentialId: fixture.deviceCredentialId,
          publisherFence: Number(state.publisher_fence),
          effectivePrivacyPolicyHash: effectivePrivacyPolicyHash
        }
      });
      await flushSanitizedSemanticPublication();
    };
    const read = (representation: SharedMemoryRepresentation) =>
      repository.readGrantRepresentation(reader, {
        shareGrantId: rule.shareGrantId,
        representation
      });
    await prepare();
    expect(await read("memory_events")).toMatchObject({
      representation: { sourceRevision: 1 }
    });
    const execute = (intent: import("@koed/shared").SharingRuleDetailIntent) =>
      executeDetailAmendment(fixture, intent);
    const review = async (maximumFidelity: SharedMemoryFidelityCeiling) => {
      const value = await repository.getSharingRuleDetailReview(owner, {
        ruleId: rule.ruleId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        maximumFidelity,
        includeCuratedMemory: false
      });
      expect(value).not.toBeNull();
      return value!;
    };
    const reducedIntent = {
      mutationId: randomUUID(),
      review: await review("lcm_rollups")
    };
    const reduced = await execute(reducedIntent);
    expect(reduced).toMatchObject({
      state: "active",
      authorityVersion: 2,
      maximumFidelity: "lcm_rollups"
    });
    // No replacement preparation has run: the accepted cap must close reads now.
    expect(await read("memory_events")).toBeNull();
    expect(await read("lcm_rollups")).toMatchObject({
      representation: { sourceRevision: 1 }
    });
    expect(await execute(reducedIntent)).toEqual(reduced);
    await expect(
      execute({ ...reducedIntent, mutationId: randomUUID() })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    await execute({
      mutationId: randomUUID(),
      review: await review("memory_events")
    });
    await ensureSourceRevision(fixture, source, 2, "rule-detail-later");
    await prepare();
    expect(await read("memory_events")).toMatchObject({
      representation: { sourceRevision: 2 }
    });
    const control = async (action: "pause" | "stop") => {
      const state = await current();
      return repository.controlConversationSharingRule(owner, {
        mutationId: randomUUID(),
        ruleId: rule.ruleId,
        reasonId: rule.reasonId,
        shareGrantId: rule.shareGrantId,
        expectedAuthorityVersion: state.authority_version,
        expectedGrantVersion: state.grant_version,
        action,
        authority: authority(fixture),
        destination: {
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId
        }
      });
    };
    await control("pause");
    await ensureSourceRevision(fixture, source, 3, "rule-detail-paused");
    await execute({
      mutationId: randomUUID(),
      review: await review("lcm_rollups")
    });
    expect(await read("memory_events")).toBeNull();
    expect(await read("lcm_rollups")).toMatchObject({
      representation: { sourceRevision: 2 }
    });
    const paused = await execute({
      mutationId: randomUUID(),
      review: await review("memory_events")
    });
    expect(paused).toMatchObject({ state: "paused" });
    expect(await read("memory_events")).toMatchObject({
      representation: { sourceRevision: 2 }
    });
    await control("stop");
    expect(
      await execute({
        mutationId: randomUUID(),
        review: await review("lcm_rollups")
      })
    ).toMatchObject({ state: "stopped" });
    expect(await read("memory_events")).toBeNull();
    expect(await read("lcm_rollups")).toBeNull();
  });

  it("recovers a completed detail receipt after an independent rule expands owner permission", async () => {
    const fixture = await createWorkspaceFixture();
    const owner = actor(fixture.ownerUserId),
      reader = actor(fixture.readerUserId);
    const original = await createGrant(fixture, {
      representation: "lcm_rollups",
      mode: "snapshot",
      ownerAllowed: ["lcm_rollups"],
      label: "detail-receipt"
    });
    await materialize(fixture, original);
    const privacyHash = (
      await pool.query<{ effective_privacy_policy_hash: string }>(
        "select effective_privacy_policy_hash from team_memory_representations where share_grant_id=$1 limit 1",
        [original.shareGrantId]
      )
    ).rows[0]!.effective_privacy_policy_hash;
    const grantState = async () =>
      (
        await pool.query<{ logical_grant_id: string; grant_version: number }>(
          "select logical_grant_id,grant_version from team_memory_share_grants where id=$1",
          [original.shareGrantId]
        )
      ).rows[0]!;
    const startRule = async (
      representation: "lcm_rollups" | "memory_events"
    ) => {
      const selected = await createConsent(fixture, original, {
        representation,
        representations:
          representation === "memory_events"
            ? allRepresentations
            : ["lcm_rollups"],
        mode: "continuous",
        label: "detail-receipt"
      });
      const root = await grantState();
      const rule = await repository.createConversationSharingRule(owner, {
        ruleId: randomUUID(),
        mutationId: randomUUID(),
        logicalGrantId: root.logical_grant_id,
        consentId: selected.consentId,
        expectedConsentVersion: selected.consent.consentVersion,
        expectedGrantVersion: root.grant_version,
        publisherCredentialId: fixture.deviceCredentialId,
        effectivePrivacyPolicyHash: privacyHash,
        authority: authority(fixture)
      });
      return {
        ...rule,
        consentId: selected.consentId,
        consentVersion: selected.consent.consentVersion
      };
    };
    const narrow = await startRule("lcm_rollups");
    const review = async (maximumFidelity: "lcm_leaves" | "lcm_rollups") => {
      const current = await repository.getSharingRuleDetailReview(owner, {
        ruleId: narrow.ruleId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        maximumFidelity,
        includeCuratedMemory: false
      });
      expect(current).not.toBeNull();
      return current!;
    };
    const intent = {
      mutationId: randomUUID(),
      review: await review("lcm_leaves")
    };
    expect(intent.review).toMatchObject({
      disclosureIncrease: true,
      ownerPolicyExpansionCount: 1
    });
    const accepted = await executeDetailAmendment(fixture, intent);
    const staleReduction = {
      mutationId: randomUUID(),
      review: await review("lcm_rollups")
    };
    const broader = await startRule("memory_events");
    const currentOwnerPolicy = async () =>
      (
        await pool.query<{ version: number; maximum_fidelity: string }>(
          "select version,maximum_fidelity from source_owner_representation_policies where logical_memory_id=$1 and superseded_at is null",
          [original.logicalMemoryId]
        )
      ).rows[0]!;
    const expanded = await currentOwnerPolicy();
    expect(expanded).toEqual({ version: 3, maximum_fidelity: "memory_events" });
    await expect(
      executeDetailAmendment(fixture, staleReduction)
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    expect(await executeDetailAmendment(fixture, intent)).toEqual(accepted);
    expect(await currentOwnerPolicy()).toEqual(expanded);
    expect((await review("lcm_rollups")).previousMaximumFidelity).toBe(
      "lcm_leaves"
    );
    const root = await grantState();
    await repository.prepareSharingRuleMember(owner, {
      shareGrantId: original.shareGrantId,
      expectedGrantVersion: root.grant_version,
      ruleAuthority: {
        ruleId: broader.ruleId,
        reasonId: broader.reasonId,
        authorityVersion: broader.authorityVersion,
        consentVersion: broader.consentVersion,
        publisherCredentialId: fixture.deviceCredentialId,
        publisherFence: broader.publisherFence,
        effectivePrivacyPolicyHash: privacyHash
      }
    });
    await flushSanitizedSemanticPublication();
    expect(
      await repository.readGrantRepresentation(reader, {
        shareGrantId: original.shareGrantId,
        representation: "memory_events"
      })
    ).toMatchObject({ representation: { sourceRevision: 1 } });
    const retained = (
      await pool.query<{ maximum_fidelity: string; consent_version: number }>(
        "select maximum_fidelity,consent_version from source_owner_representation_consents where id=$1",
        [original.consentId]
      )
    ).rows[0]!;
    expect(retained).toEqual({
      maximum_fidelity: "lcm_rollups",
      consent_version: 1
    });
    const deploymentIdentityId = (
      await pool.query<{ id: string }>(
        "select id from deployment_identities where locality='local' and disabled_at is null"
      )
    ).rows[0]!.id;
    await privacyRepository.createContentPolicyVersion({
      scope: "workspace",
      subject: {
        deploymentIdentityId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId
      },
      labels: noPrivacyLabelsPolicy(),
      expectedPreviousVersion: 0
    });
    await expect(review("lcm_rollups")).rejects.toThrow(
      "Review its content policy before changing detail"
    );
    expect(
      (
        await pool.query<{
          effective_privacy_policy_hash: string;
          authority_version: number;
        }>(
          "select effective_privacy_policy_hash,authority_version from team_memory_sharing_rules where id=$1",
          [narrow.ruleId]
        )
      ).rows[0]
    ).toEqual({
      effective_privacy_policy_hash: privacyHash,
      authority_version: 2
    });
    // This case deliberately made these rules' policy bindings stale. End their
    // work through owner controls before later cases run the global worker.
    for (const rule of [narrow, broader]) {
      const root = await grantState();
      const currentRule = (
        await pool.query<{ authority_version: number }>(
          "select authority_version from team_memory_sharing_rules where id=$1",
          [rule.ruleId]
        )
      ).rows[0]!;
      expect(
        await repository.controlConversationSharingRule(owner, {
          mutationId: randomUUID(),
          ruleId: rule.ruleId,
          reasonId: rule.reasonId,
          shareGrantId: original.shareGrantId,
          expectedAuthorityVersion: currentRule.authority_version,
          expectedGrantVersion: root.grant_version,
          action: "stop",
          authority: authority(fixture),
          destination: {
            teamId: fixture.teamId,
            teamWorkspaceId: fixture.teamWorkspaceId
          }
        })
      ).toMatchObject({ state: "stopped" });
    }
    // The production Privacy worker invalidates stale derivatives before it
    // reconciles ready representations. Run that phase after the policy edit.
    expect(
      (await repository.invalidateStaleSemanticPreviews({ limit: 100 }))
        .invalidated
    ).toBeGreaterThan(0);
  });

  it.each(["repository", "folder", "project"] as const)(
    "replaces an unresolved %s admission under the amended detail without reviving its old request",
    async (selectorKind) => {
      const fixture = await createWorkspaceFixture();
      const owner = actor(fixture.ownerUserId),
        reader = actor(fixture.readerUserId);
      const selector =
        selectorKind === "repository"
          ? {
              kind: "portable_repository" as const,
              key: "gr_unresolved_detail"
            }
          : { kind: selectorKind, key: hash(`unresolved-${selectorKind}`) };
      const creationReview =
        await repository.getRepositorySharingRuleCreationReview(owner, {
          selector,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          maximumFidelity: "lcm_leaves",
          includeCuratedMemory: false,
          includesFutureConversations: true,
          completedReviewHash: hash("unresolved-review"),
          selectionSnapshotVersion: randomUUID()
        });
      expect(creationReview).not.toBeNull();
      const creation = {
        ...creationReview!.scope,
        mutationId: randomUUID(),
        ruleId: randomUUID()
      };
      await executeNativeRuleOperation(
        fixture,
        (referenceId) =>
          sharedMemoryRepositoryRuleCreationActionGrantBinding({
            ...creation,
            referenceId
          }),
        (scoped, approved) =>
          scoped.createRepositorySharingRule(owner, {
            ...creation,
            publisherCredentialId: fixture.deviceCredentialId,
            authority: approved
          })
      );
      const source = await createSource(
        fixture,
        1,
        `unresolved-${selectorKind}`
      );
      await putOwnerPolicy(fixture, source, ["lcm_leaves", "lcm_rollups"]);
      const inspect = () =>
        repository.inspectRepositorySharingRuleMembers(owner, {
          ruleId: creation.ruleId,
          publisherCredentialId: fixture.deviceCredentialId,
          logicalMemoryIds: [source.logicalMemoryId]
        });
      const admit = async (maximumFidelity: "lcm_leaves" | "lcm_rollups") => {
        const state = await inspect(),
          entry = state.entries[0]!;
        const candidateInput = {
          ...capturedSourceBinding(source, maximumFidelity, [
            "lcm_leaves",
            "lcm_rollups"
          ]),
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          candidateHash: hash(`unresolved:${maximumFidelity}`),
          sourceRevision: 1,
          itemCount: 1,
          excludedItemCount: 0,
          manifest: candidateManifest(source, maximumFidelity),
          byteCount: 128,
          mode: "continuous" as const,
          maximumFidelity,
          includeCuratedMemory: false
        };
        const candidate = await executeNativeRuleOperation(
          fixture,
          (referenceId) =>
            sharedMemoryCandidatePreviewActionGrantBinding({
              ...candidateInput,
              referenceId
            }),
          (scoped, approved) =>
            scoped.createSharedMemoryCandidatePreview(owner, {
              ...candidateInput,
              authority: approved
            }),
          "direct"
        );
        expect(candidate).not.toBeNull();
        const input = {
          mutationId: randomUUID(),
          logicalGrantId: entry.grant?.logicalGrantId ?? randomUUID(),
          consentId: randomUUID(),
          source: {
            kind: "captured_session" as const,
            sessionId: source.sessionId,
            logicalMemoryId: source.logicalMemoryId
          },
          sourceCapabilities: [
            "lcm_leaves",
            "lcm_rollups"
          ] as SharedMemoryRepresentation[],
          activationRepresentation: maximumFidelity,
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          mode: "continuous" as const,
          maximumFidelity,
          includeCuratedMemory: false,
          expiresAt: null,
          preview: {
            previewId: candidate!.previewId,
            previewHash: candidate!.previewHash
          },
          previewRevision: candidate!.previewRevision,
          publisherCredentialId: fixture.deviceCredentialId,
          membership: {
            ruleId: creation.ruleId,
            selectionSnapshotVersion: randomUUID(),
            sourceContextHash: hash("unresolved-context"),
            selectorBindingHash: state.selectorBindingHash,
            gitContextVersion: 1,
            folderContextVersion: 1,
            expectedAuthorityVersion: state.authorityVersion,
            expectedMembershipVersion: entry.member?.version ?? 0,
            expectedGrantVersion: entry.grant?.version ?? null,
            publisherFence: state.publisherFence
          }
        };
        return {
          input,
          accepted: await repository.createPendingRepositoryRuleMember(
            owner,
            input
          )
        };
      };
      const original = await admit("lcm_leaves");
      expect((await inspect()).entries[0]!.member?.state).toBe("unresolved");
      const review = await repository.getSharingRuleDetailReview(owner, {
        ruleId: creation.ruleId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: false
      });
      expect(review).toMatchObject({ memberCount: 0 });
      await executeDetailAmendment(fixture, {
        mutationId: randomUUID(),
        review: review!
      });
      expect(
        await repository.processPendingShares({
          ensureCompanion: ensurePendingShareCompanion
        })
      ).toMatchObject({ failed: 1, activated: 0 });
      expect((await inspect()).entries[0]!.grant).toBeNull();
      expect(
        (
          await pool.query(
            "select id from source_owner_representation_consents where id=$1",
            [original.input.consentId]
          )
        ).rowCount
      ).toBe(0);
      const replacement = await admit("lcm_rollups");
      expect(replacement.accepted.pendingShareId).not.toBe(
        original.accepted.pendingShareId
      );
      expect(
        (
          await pool.query<{ state: string }>(
            "select state from pending_share_operations where id=$1",
            [original.accepted.pendingShareId]
          )
        ).rows[0]!.state
      ).toBe("revoked");
      // Exact old retries recover their immutable receipt without restoring work.
      expect(
        await repository.createPendingRepositoryRuleMember(
          owner,
          original.input
        )
      ).toEqual(original.accepted);
      expect(
        await repository.processPendingShares({
          ensureCompanion: ensurePendingShareCompanion
        })
      ).toMatchObject({ failed: 0 });
      await flushSanitizedSemanticPublication();
      await pool.query(
        "update pending_share_outbox set available_at=now() where pending_share_id=$1 and state='pending'",
        [replacement.accepted.pendingShareId]
      );
      expect(
        await repository.processPendingShares({
          ensureCompanion: ensurePendingShareCompanion
        })
      ).toMatchObject({ failed: 0, activated: 1 });
      const current = await inspect(),
        shareGrantId = current.entries[0]!.grant!.id;
      expect(
        await repository.readGrantRepresentation(reader, {
          shareGrantId,
          representation: "lcm_rollups"
        })
      ).toMatchObject({ representation: { sourceRevision: 1 } });
      expect(
        await repository.readGrantRepresentation(reader, {
          shareGrantId,
          representation: "lcm_leaves"
        })
      ).toBeNull();
      expect(
        (
          await pool.query<{ state: string }>(
            "select state from pending_share_operations where id=$1",
            [original.accepted.pendingShareId]
          )
        ).rows[0]!.state
      ).toBe("revoked");
    }
  );

  it("shares one Conversation independently with Engineering and Design while isolating destination denial", async () => {
    const fixture = await createWorkspaceFixture();
    const owner = actor(fixture.ownerUserId),
      reader = actor(fixture.readerUserId);
    await pool.query(
      "update team_workspaces set name='Engineering' where id=$1",
      [fixture.teamWorkspaceId]
    );
    const designId = (
      await pool.query<{ id: string }>(
        "insert into team_workspaces(team_id,name) values($1,'Design') returning id",
        [fixture.teamId]
      )
    ).rows[0]!.id;
    await pool.query(
      `insert into team_workspace_access_grants(team_workspace_id,team_id,user_id,access,can_share_owned_memory,granted_by_user_id)
      values($1,$2,$3,'write',true,$3),($1,$2,$4,'read',false,$3)`,
      [designId, fixture.teamId, fixture.ownerUserId, fixture.readerUserId]
    );
    await repository.putWorkspacePolicy(owner, {
      mutationId: randomUUID(),
      teamId: fixture.teamId,
      teamWorkspaceId: designId,
      expectedCurrentVersion: 0,
      ...fidelityConsent(allRepresentations)
    });
    const source = await createSource(fixture, 1, "two-destination");
    await putOwnerPolicy(fixture, source);
    const snapshot = await createConsent(fixture, source, {
      representation: "lcm_rollups",
      representations: ["lcm_rollups"],
      mode: "snapshot",
      label: "retained-engineering-snapshot"
    });
    const retainedGrant = await repository.createShareGrant(owner, {
      mutationId: randomUUID(),
      logicalGrantId: randomUUID(),
      consentId: snapshot.consentId,
      authority: authority(fixture)
    });
    await prepareSanitizedSemanticPreview(
      fixture.ownerUserId,
      snapshot.preview
    );
    await repository.materializeGrantRepresentation(owner, {
      mutationId: randomUUID(),
      shareGrantId: retainedGrant.id,
      consentId: snapshot.consentId,
      expectedGrantVersion: retainedGrant.grantVersion,
      preview: snapshot.preview
    });
    const highRisk = createHighRiskActionRepository(createDb(pool), {
      pool,
      envelopeEncryptionProvider: privacyProvider,
      teamEnvelopeEncryptionProvider: provider,
      ownerPrivateReplicaEnvelopeEncryptionProvider: ownerProvider
    });
    const upstreamBackendId = (
      await pool.query<{ upstream_backend_id: string }>(
        "select upstream_backend_id from device_credentials where id=$1",
        [fixture.deviceCredentialId]
      )
    ).rows[0]!.upstream_backend_id;
    const executeNative = async <T>(
      bind: (referenceId: string) => SharedMemoryActionGrantBinding,
      execute: (
        scoped: SharedMemoryRepository,
        approved: SharedMemoryAuthorityContext
      ) => Promise<T>,
      approvalTier: "native_review" | "direct" = "native_review"
    ): Promise<T> => {
      const requestId = randomUUID(),
        secret = `hrg_${randomBytes(32).toString("base64url")}`,
        binding = bind(requestId);
      const context = {
        ownerUserId: fixture.ownerUserId,
        deviceCredentialId: fixture.deviceCredentialId,
        upstreamBackendId
      };
      const operation = {
        ...context,
        operationFamily: binding.operationFamily,
        action: binding.action,
        teamId: binding.teamId,
        targetId: binding.targetId,
        scopeHash: binding.scopeHash,
        requestHash: binding.requestHash
      };
      await highRisk.createActionGrant({
        ...operation,
        clientRequestId: requestId,
        grantCommitment: highRiskActionGrantCommitment(secret),
        credentialOperationFamily: "share_grant_management",
        approvalTier,
        review:
          approvalTier === "native_review"
            ? {
                version: 1,
                title: "Review Workspace sharing",
                description: "Share only with the reviewed destination.",
                consequence: "Apply this destination's rule operation.",
                confirmLabel: "Approve",
                details: []
              }
            : null
      });
      if (approvalTier === "native_review") {
        expect(
          await highRisk.decideNativeActionReview({
            ...context,
            clientRequestId: requestId,
            decision: "approve"
          })
        ).toMatchObject({ state: "approved" });
      }
      const result = await highRisk.executeActionGrant({
        ...operation,
        actionGrant: secret,
        execute: async ({ sharedMemory }) => ({
          statusCode: 200,
          body: await execute(sharedMemory, {
            action: SHARED_MEMORY_AUTHORITY,
            source: "device_action_grant",
            referenceId: requestId
          })
        })
      });
      expect(result).toMatchObject({ statusCode: 200, replayed: false });
      return result!.body;
    };
    const startRule = async (
      workspaceId: string,
      representation: "lcm_rollups" | "memory_events"
    ) => {
      const candidateInput = {
        ...capturedSourceBinding(source, representation),
        logicalMemoryId: source.logicalMemoryId,
        candidateHash: hash(
          `destination:${workspaceId}:${source.currentRevision}`
        ),
        sourceRevision: source.currentRevision,
        itemCount: 1,
        excludedItemCount: 0,
        manifest: candidateManifest(source, representation),
        byteCount: 128,
        teamId: fixture.teamId,
        teamWorkspaceId: workspaceId,
        ...fidelityConsent([representation]),
        mode: "continuous" as const
      };
      const candidate = await executeNative(
        (referenceId) =>
          sharedMemoryCandidatePreviewActionGrantBinding({
            ...candidateInput,
            referenceId
          }),
        (scoped, approved) =>
          scoped.createSharedMemoryCandidatePreview(owner, {
            ...candidateInput,
            authority: approved
          }),
        "direct"
      );
      expect(candidate).not.toBeNull();
      const review = await repository.getConversationSharingRuleCreationReview(
        owner,
        {
          previewId: candidate!.previewId,
          previewHash: candidate!.previewHash,
          previewRevision: candidate!.previewRevision,
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: workspaceId
        }
      );
      expect(review?.teamWorkspaceId).toBe(workspaceId);
      expect(review?.expectedGrantVersion).toBe(
        workspaceId === fixture.teamWorkspaceId
          ? retainedGrant.grantVersion
          : null
      );
      const intent = {
        ...review!,
        mutationId: randomUUID(),
        ruleId: randomUUID(),
        consentId: randomUUID(),
        mode: "continuous" as const
      };
      const pending = await executeNative(
        (referenceId) =>
          sharedMemoryConversationRuleCreationActionGrantBinding({
            ...intent,
            referenceId
          }),
        (scoped, approved) =>
          scoped.createPendingConversationSharingRule(owner, {
            ...intent,
            preview: candidate!,
            authority: approved,
            ruleCreation: {
              ruleId: intent.ruleId,
              publisherCredentialId: fixture.deviceCredentialId,
              expectedGrantVersion: intent.expectedGrantVersion,
              effectivePrivacyPolicyHash: intent.effectivePrivacyPolicyHash
            }
          })
      );
      expect(
        await repository.processPendingShares({
          ensureCompanion: ensurePendingShareCompanion
        })
      ).toMatchObject({ failed: 0 });
      await flushSanitizedSemanticPublication();
      await pool.query(
        "update pending_share_outbox set available_at=now() where pending_share_id=$1 and state='pending'",
        [pending.id]
      );
      expect(
        await repository.processPendingShares({
          ensureCompanion: ensurePendingShareCompanion
        })
      ).toMatchObject({ failed: 0 });
      const bound = (
        await pool.query<{ reason_id: string; share_grant_id: string }>(
          "select id as reason_id,share_grant_id from team_memory_share_reasons where rule_id=$1",
          [intent.ruleId]
        )
      ).rows[0]!;
      expect(
        (
          await repository.getOwnerShare(owner, {
            kind: "pending",
            id: pending.id
          })
        )?.summary.lastReadyRevision
      ).toBe(1);
      return {
        ...bound,
        ruleId: intent.ruleId,
        workspaceId,
        pendingId: pending.id,
        representation
      };
    };
    type Destination = Awaited<ReturnType<typeof startRule>>;
    const control = async (
      destination: Destination,
      controlAction: "pause" | "resume" | "stop" | "retry"
    ) => {
      const state = (
        await pool.query<{ authority_version: number; grant_version: number }>(
          `select rule.authority_version,g.grant_version from team_memory_sharing_rules rule
         join team_memory_share_grants g on g.id=$2 where rule.id=$1`,
          [destination.ruleId, destination.share_grant_id]
        )
      ).rows[0]!;
      const intent = {
        mutationId: randomUUID(),
        ruleId: destination.ruleId,
        reasonId: destination.reason_id,
        shareGrantId: destination.share_grant_id,
        teamId: fixture.teamId,
        teamWorkspaceId: destination.workspaceId,
        expectedAuthorityVersion: state.authority_version,
        expectedGrantVersion: state.grant_version,
        controlAction
      };
      expect(
        await repository.getConversationSharingRuleControlReview(owner, {
          ...intent,
          action: controlAction
        })
      ).not.toBeNull();
      return executeNative(
        (referenceId) =>
          sharedMemoryRuleControlActionGrantBinding({ ...intent, referenceId }),
        (scoped, approved) =>
          scoped.controlConversationSharingRule(owner, {
            ...intent,
            action: controlAction,
            destination: {
              teamId: fixture.teamId,
              teamWorkspaceId: destination.workspaceId
            },
            authority: approved
          })
      );
    };
    const read = (destination: Destination) =>
      repository.readGrantRepresentation(reader, {
        shareGrantId: destination.share_grant_id,
        representation: destination.representation
      });
    const stableState = async (destination: Destination) =>
      (
        await pool.query<{ state: string }>(
          `select rule.state,rule.authority_version,rule.maximum_fidelity,rule.publisher_fence,
       g.grant_version,g.maximum_fidelity as grant_fidelity,c.consent_version,c.state as consent_state,
       c.source_owner_policy_id,c.source_owner_policy_version,c.team_policy_id,c.team_policy_version,c.workspace_policy_id,c.workspace_policy_version,
       (select jsonb_agg(jsonb_build_array(p.representation_id,r.source_revision) order by p.representation_id)
        from team_memory_reason_publications p join team_memory_representations r on r.id=p.representation_id
        where p.reason_id=reason.id) publications
       from team_memory_sharing_rules rule join team_memory_share_reasons reason on reason.rule_id=rule.id
       join team_memory_share_grants g on g.id=reason.share_grant_id join source_owner_representation_consents c on c.id=reason.consent_id
       where rule.id=$1`,
          [destination.ruleId]
        )
      ).rows[0];
    const engineering = await startRule(fixture.teamWorkspaceId, "lcm_rollups");
    expect(await control(engineering, "pause")).toMatchObject({
      state: "paused"
    });
    const engineeringBefore = await stableState(engineering);
    const design = await startRule(designId, "memory_events");
    expect(design.share_grant_id).not.toBe(engineering.share_grant_id);
    expect(await stableState(engineering)).toEqual(engineeringBefore);
    expect(await read(engineering)).toMatchObject({
      representation: { sourceRevision: 1, representation: "lcm_rollups" }
    });
    expect(await read(design)).toMatchObject({
      representation: { sourceRevision: 1, representation: "memory_events" }
    });
    await seedAuthoritativeSourceRevision(
      fixture,
      source,
      2,
      "two-destination-later"
    );
    await repository.advanceContinuousGrantRepresentations({
      remoteReplicaId: source.remoteReplicaId,
      sourceRevision: 2
    });
    await flushSanitizedSemanticPublication();
    expect(await read(engineering)).toMatchObject({
      representation: { sourceRevision: 1 }
    });
    expect(await read(design)).toMatchObject({
      representation: { sourceRevision: 2 }
    });
    expect(await stableState(engineering)).toEqual(engineeringBefore);

    // Withdraw only Design's publication permission. Existing Team reads remain
    // authorized; Engineering must resume and publish despite Design's failure.
    await pool.query(
      "update team_workspace_access_grants set can_share_owned_memory=false where team_workspace_id=$1 and user_id=$2",
      [designId, fixture.ownerUserId]
    );
    expect(await control(engineering, "resume")).toMatchObject({
      state: "active"
    });
    await seedAuthoritativeSourceRevision(
      fixture,
      source,
      3,
      "two-destination-denial"
    );
    await repository.advanceContinuousGrantRepresentations({
      remoteReplicaId: source.remoteReplicaId,
      sourceRevision: 3
    });
    await repository.reconcileSharingRuleMembers({ limit: 100 });
    await flushSanitizedSemanticPublication();
    expect(await read(engineering)).toMatchObject({
      representation: { sourceRevision: 3 }
    });
    expect(await read(design)).toMatchObject({
      representation: { sourceRevision: 2 }
    });
    expect(await control(engineering, "stop")).toMatchObject({
      state: "stopped"
    });
    expect(await read(engineering)).toMatchObject({
      representation: { sourceRevision: 1 }
    });
    expect(await read(design)).toMatchObject({
      representation: { sourceRevision: 2 }
    });

    await pool.query(
      "update team_workspace_access_grants set can_share_owned_memory=true where team_workspace_id=$1 and user_id=$2",
      [designId, fixture.ownerUserId]
    );
    expect(await control(design, "retry")).toMatchObject({ state: "active" });
    await repository.reconcileSharingRuleMembers({ limit: 100 });
    await flushSanitizedSemanticPublication();
    expect(await read(design)).toMatchObject({
      representation: { sourceRevision: 3 }
    });
    expect(await read(engineering)).toMatchObject({
      representation: { sourceRevision: 1 }
    });
    expect((await stableState(engineering))?.state).toBe("stopped");
    const owned = await repository.listOwnerShares(owner, {
      limit: 100,
      history: false
    });
    expect(
      owned.entries
        .filter(
          (item) =>
            item.summary.source.logicalMemoryId === source.logicalMemoryId
        )
        .map((item) => item.summary.workspaceName)
        .sort()
    ).toEqual(["Design", "Engineering"]);
  });

  it("keeps a Privacy failure isolated from another pending sharing reason", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "reason-privacy-isolation");
    await putOwnerPolicy(fixture, source);
    const createRule = async (
      representation: "lcm_rollups" | "memory_events"
    ) => {
      const candidate = await repository.createSharedMemoryCandidatePreview(
        actor(fixture.ownerUserId),
        {
          ...capturedSourceBinding(source, representation),
          logicalMemoryId: source.logicalMemoryId,
          candidateHash: hash(`reason-privacy-${representation}`),
          sourceRevision: source.currentRevision,
          itemCount: 1,
          excludedItemCount: 0,
          manifest: candidateManifest(source, representation),
          byteCount: 128,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          ...fidelityConsent([representation]),
          mode: "continuous",
          authority: authority(fixture)
        }
      );
      expect(candidate).not.toBeNull();
      const review = await repository.getConversationSharingRuleCreationReview(
        actor(fixture.ownerUserId),
        {
          previewId: candidate!.previewId,
          previewHash: candidate!.previewHash,
          previewRevision: candidate!.previewRevision,
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId
        }
      );
      expect(review).not.toBeNull();
      const pending = await repository.createPendingConversationSharingRule(
        actor(fixture.ownerUserId),
        {
          mutationId: randomUUID(),
          logicalGrantId: review!.logicalGrantId,
          consentId: randomUUID(),
          ...capturedSourceBinding(source, representation),
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          preview: candidate!,
          previewRevision: candidate!.previewRevision,
          mode: "continuous",
          ...fidelityConsent([representation]),
          authority: authority(fixture),
          ruleCreation: {
            ruleId: randomUUID(),
            publisherCredentialId: fixture.deviceCredentialId,
            expectedGrantVersion: review!.expectedGrantVersion,
            effectivePrivacyPolicyHash: review!.effectivePrivacyPolicyHash
          }
        }
      );
      expect(await repository.processPendingShares()).toMatchObject({
        failed: 0,
        waiting: 1
      });
      return pending;
    };
    const retained = await createRule("lcm_rollups");
    const failing = await createRule("memory_events");
    await repository.reconcileSharingRuleMembers();
    const targets = await repository.listPendingSemanticPrivacyTargets({
      limit: 100
    });
    const target = targets.find(
      (target) =>
        target.logicalMemoryId === source.logicalMemoryId &&
        target.representation === "memory_events"
    );
    expect(target).toBeDefined();
    const loaded = await repository.readPendingSemanticPrivacyTarget(
      actor(fixture.ownerUserId),
      {
        semanticPreviewId: target!.id,
        expectedSourcePreviewHash: target!.sourcePreviewHash,
        expectedSourceArtifactHash: target!.sourceArtifactHash,
        expectedSourceManifestHash: target!.sourceManifestHash,
        expectedClassifierHash: target!.classifierHash,
        expectedEffectivePrivacyPolicyHash: target!.effectivePrivacyPolicyHash
      }
    );
    expect(loaded).not.toBeNull();
    expect(
      await repository.markSemanticPrivacyTargetFailed(
        actor(fixture.ownerUserId),
        {
          semanticPreviewId: target!.id,
          expectedSourcePreviewHash: target!.sourcePreviewHash,
          expectedSourceArtifactHash: target!.sourceArtifactHash,
          expectedSourceManifestHash: target!.sourceManifestHash,
          expectedClassifierHash: target!.classifierHash,
          expectedEffectivePrivacyPolicyHash:
            target!.effectivePrivacyPolicyHash,
          expectedSourceItemIdentityHash: loaded!.sourceItemIdentityHash,
          failureCode: "classification_failed"
        }
      )
    ).toBe(true);
    const pending = await pool.query<{
      id: string;
      state: string;
      outbox_state: string;
    }>(
      `select pending.id,pending.state,outbox.state as outbox_state
         from pending_share_operations pending join pending_share_outbox outbox on outbox.pending_share_id=pending.id
        where pending.id=any($1::uuid[])`,
      [[retained.id, failing.id]]
    );
    expect(pending.rows.find((row) => row.id === retained.id)).toMatchObject({
      state: "preparing",
      outbox_state: "pending"
    });
    expect(pending.rows.find((row) => row.id === failing.id)).toMatchObject({
      state: "needs_attention",
      outbox_state: "completed"
    });
  });
  it.each([
    ["source_owner", "grant"],
    ["source_owner", "consent"],
    ["team", "grant"],
    ["team", "consent"],
    ["workspace", "grant"],
    ["workspace", "consent"]
  ] as const)(
    "rolls back a busy %s policy edit without waiting on a held %s",
    async (scope, held) => {
      const fixture = await createWorkspaceFixture();
      const grant = await createGrant(fixture, {
        label: "policy-authority-contention"
      });
      const mutationId = randomUUID();
      const edit = (target: SharedMemoryRepository) => {
        const input = {
          mutationId,
          expectedCurrentVersion: 1,
          maximumFidelity: "lcm_rollups" as const,
          includeCuratedMemory: false
        };
        return scope === "source_owner"
          ? target.putSourceOwnerPolicy(actor(fixture.ownerUserId), {
              ...input,
              logicalMemoryId: grant.logicalMemoryId
            })
          : scope === "team"
            ? target.putTeamPolicy(actor(fixture.ownerUserId), {
                ...input,
                teamId: fixture.teamId
              })
            : target.putWorkspacePolicy(actor(fixture.ownerUserId), {
                ...input,
                teamId: fixture.teamId,
                teamWorkspaceId: fixture.teamWorkspaceId
              });
      };
      const holder = await pool.connect();
      const writer = await pool.connect();
      try {
        await holder.query("begin");
        await holder.query(
          held === "grant"
            ? "select id from team_memory_share_grants where id=$1 for update"
            : "select id from source_owner_representation_consents where id=$1 for update",
          [held === "grant" ? grant.shareGrantId : grant.consentId]
        );
        await writer.query("begin");
        // This bounds an accidental regression to waiting on the other session.
        // NOWAIT must produce the repository conflict before that timeout fires.
        await writer.query("set local lock_timeout='1s'");
        const transactional = createSharedMemoryRepository(
          createSavepointPool(writer, "high_risk"),
          {
            inheritTransactionIsolation: true,
            resolvePersonalEncryptionProvider: () => privacyProvider,
            resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider,
            resolveTeamEncryptionProvider: () => provider
          }
        );
        await expect(edit(transactional)).rejects.toThrow(
          "Sharing authority is busy"
        );
        expect(
          (
            await pool.query<{
              lifecycle: string;
              grant_version: number;
              state: string;
            }>(
              `select g.lifecycle,g.grant_version,c.state from team_memory_share_grants g
           join source_owner_representation_consents c on c.id=g.consent_id where g.id=$1`,
              [grant.shareGrantId]
            )
          ).rows[0]
        ).toEqual({ lifecycle: "active", grant_version: 1, state: "active" });
        expect(
          (
            await pool.query(
              "select 1 from audit_events where metadata->>'mutationId'=$1",
              [mutationId]
            )
          ).rowCount
        ).toBe(0);
      } finally {
        await writer.query("rollback");
        writer.release();
        await holder.query("rollback");
        holder.release();
      }
      expect(await edit(repository)).toMatchObject({
        version: 2,
        maximumFidelity: "lcm_rollups"
      });
      expect(
        (
          await pool.query<{ lifecycle: string; state: string }>(
            `select g.lifecycle,c.state from team_memory_share_grants g
         join source_owner_representation_consents c on c.id=g.consent_id where g.id=$1`,
            [grant.shareGrantId]
          )
        ).rows[0]
      ).toEqual({ lifecycle: "unavailable", state: "paused" });
    }
  );

  it.each([
    "owner_rules",
    "repository",
    "portable_source",
    "publisher_transfer",
    "publisher_native_pending",
    "publisher_native_pending_restricted",
    "publisher_native_pending_revoked",
    "paused_publisher_transfer",
    "publisher_readmission",
    "publisher_readmission_admission",
    "publisher_readmission_recovery",
    "publisher_readmission_pending_revoked",
    "publisher_readmission_pending_policy",
    "folder",
    "project",
    "revoked_repository",
    "revoked_during_admission",
    "preview_revision",
    "project_retry",
    "project_retry_exhausted",
    "project_retry_denied",
    "project_concurrent",
    "project_concurrent_fresh",
    "project_concurrent_revoked",
    "project_excluded"
  ] as const)(
    "publishes existing and future %s members with independent pause and stop authority",
    async (scenario) => {
      const selectionKind =
        scenario === "project_retry" ||
        scenario === "project_retry_exhausted" ||
        scenario === "project_retry_denied" ||
        scenario === "project_concurrent" ||
        scenario === "project_concurrent_fresh" ||
        scenario === "project_concurrent_revoked" ||
        scenario === "project_excluded"
          ? "project"
          : scenario === "portable_source" ||
              scenario === "publisher_transfer" ||
              scenario === "publisher_native_pending" ||
              scenario === "publisher_native_pending_restricted" ||
              scenario === "publisher_native_pending_revoked" ||
              scenario === "paused_publisher_transfer" ||
              scenario === "publisher_readmission" ||
              scenario === "publisher_readmission_admission" ||
              scenario === "publisher_readmission_recovery" ||
              scenario === "publisher_readmission_pending_revoked" ||
              scenario === "publisher_readmission_pending_policy" ||
              scenario === "revoked_repository" ||
              scenario === "revoked_during_admission" ||
              scenario === "preview_revision" ||
              scenario === "owner_rules"
            ? "repository"
            : scenario;
      const fixture = await createWorkspaceFixture();
      const owner = actor(fixture.ownerUserId),
        reader = actor(fixture.readerUserId);
      const sharedAnchor = {
        version: 1 as const,
        classification: "portable_repository" as const,
        fingerprint: "gr_dynamic_member_proof",
        label: "Shared anchor",
        branchObservation: null
      };
      const representations = ["lcm_leaves", "lcm_rollups"] as const;
      // Deterministic vectors exercise the real Team retrieval and expansion
      // boundary without loading a model or forging a Team snapshot after sharing.
      const vector = [1, ...Array.from({ length: 383 }, () => 0)],
        model = "git-member-authorization",
        version = "team-semantic-v1:git-member-authorization";
      const query = {
        teamWorkspaceId: fixture.teamWorkspaceId,
        queryVector: vector,
        model,
        dimensions: 384 as const,
        version,
        limit: 50,
        searchDomain:
          selectionKind === "project"
            ? ("global" as const)
            : ("project" as const),
        projectId:
          selectionKind === "project"
            ? undefined
            : `repository:${JSON.stringify({ kind: "portable_repository", key: sharedAnchor.fingerprint, device: null })}`
      };
      const indexAndRecall = async (lowerRankedRepresentationId?: string) => {
        const lowerRankedItems = new Set(
          lowerRankedRepresentationId
            ? (
                await pool.query<{ id: string }>(
                  "select id from team_memory_semantic_items where representation_id=$1",
                  [lowerRankedRepresentationId]
                )
              ).rows.map((row) => row.id)
            : []
        );
        const items = await repository.listPendingSharedMemorySemanticItems({
          limit: 100
        });
        for (const item of items)
          await repository.storeSharedMemorySemanticEmbedding({
            semanticItemId: item.semanticItemId,
            contentHash: item.contentHash,
            model,
            dimensions: 384,
            version,
            vector: lowerRankedItems.has(item.semanticItemId)
              ? [0, 1, ...Array.from({ length: 382 }, () => 0)]
              : vector
          });
        return repository.searchAuthorizedSharedMemorySemanticItems(
          reader,
          query
        );
      };
      const existing = await createSource(fixture, 1, "git-existing", {
        repositorySnapshot:
          selectionKind === "project"
            ? unresolvedTeamRepositorySnapshot()
            : sharedAnchor
      });
      await putOwnerPolicy(fixture, existing, [...representations]);
      const snapshot = await createConsent(fixture, existing, {
        representation: "lcm_rollups",
        representations: ["lcm_rollups"],
        mode: "snapshot",
        label: "git-existing-snapshot"
      });
      const direct = await repository.createShareGrant(owner, {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: snapshot.consentId,
        authority: authority(fixture)
      });
      await prepareSanitizedSemanticPreview(
        fixture.ownerUserId,
        snapshot.preview
      );
      await repository.materializeGrantRepresentation(owner, {
        mutationId: randomUUID(),
        shareGrantId: direct.id,
        consentId: snapshot.consentId,
        expectedGrantVersion: direct.grantVersion,
        preview: snapshot.preview
      });
      expect(direct.repositorySnapshot?.fingerprint).toBe(
        selectionKind === "project" ? null : sharedAnchor.fingerprint
      );

      const highRisk = createHighRiskActionRepository(createDb(pool), {
        pool,
        envelopeEncryptionProvider: privacyProvider,
        teamEnvelopeEncryptionProvider: provider,
        ownerPrivateReplicaEnvelopeEncryptionProvider: ownerProvider
      });
      const executeNative = async <T>(
        build: (referenceId: string) => SharedMemoryActionGrantBinding,
        execute: (
          scoped: SharedMemoryRepository,
          approved: SharedMemoryAuthorityContext
        ) => Promise<T>,
        deviceCredentialId = fixture.deviceCredentialId,
        approvalTier: "native_review" | "direct" = "native_review",
        verifyReplay = false
      ): Promise<T> => {
        const requestId = randomUUID(),
          secret = `hrg_${randomBytes(32).toString("base64url")}`,
          bound = build(requestId);
        const credential = await pool.query<{ upstream_backend_id: string }>(
          "select upstream_backend_id from device_credentials where id=$1 and owner_user_id=$2",
          [deviceCredentialId, fixture.ownerUserId]
        );
        const context = {
          ownerUserId: fixture.ownerUserId,
          deviceCredentialId,
          upstreamBackendId: credential.rows[0]!.upstream_backend_id
        };
        const operation = {
          ...context,
          operationFamily: bound.operationFamily,
          action: bound.action,
          teamId: bound.teamId,
          targetId: bound.targetId,
          scopeHash: bound.scopeHash,
          requestHash: bound.requestHash
        };
        expect(
          await highRisk.createActionGrant({
            ...operation,
            clientRequestId: requestId,
            grantCommitment: highRiskActionGrantCommitment(secret),
            credentialOperationFamily: "share_grant_management",
            approvalTier,
            review:
              approvalTier === "native_review"
                ? {
                    version: 1,
                    title: "Review Git Anchor sharing",
                    description:
                      "Existing and future matching Conversations in this Workspace.",
                    consequence: "Apply only the bound rule operation.",
                    confirmLabel: "Approve",
                    details: []
                  }
                : null
          })
        ).toMatchObject({ approvalTier });
        if (approvalTier === "native_review") {
          expect(
            await highRisk.decideNativeActionReview({
              ...context,
              clientRequestId: requestId,
              decision: "approve"
            })
          ).toMatchObject({ state: "approved" });
        }
        if (verifyReplay) {
          const observe = vi.fn(async () => null);
          expect(
            await highRisk.executeActionGrant({
              ...operation,
              actionGrant: secret,
              execute: observe
            })
          ).toBeNull();
          expect(observe).toHaveBeenCalledTimes(1);
        }
        const result = await highRisk.executeActionGrant({
          ...operation,
          actionGrant: secret,
          execute: async ({ sharedMemory }) => ({
            statusCode: 200,
            body: await execute(sharedMemory, {
              action: SHARED_MEMORY_AUTHORITY,
              source: "device_action_grant",
              referenceId: requestId
            })
          })
        });
        expect(result).toMatchObject({ statusCode: 200, replayed: false });
        if (verifyReplay) {
          const replay = await highRisk.executeActionGrant({
            ...operation,
            actionGrant: secret,
            execute: async () => {
              throw new Error("A receipt replay must not execute again");
            }
          });
          expect(replay).toMatchObject({
            statusCode: 200,
            replayed: true,
            body: result!.body
          });
        }
        return result!.body;
      };
      const ruleReview =
        await repository.getRepositorySharingRuleCreationReview(owner, {
          selector:
            selectionKind === "folder"
              ? { kind: "folder", key: hash("exact-folder-private-identity") }
              : selectionKind === "project"
                ? { kind: "project", key: hash("private-project-identity") }
                : {
                    kind: "portable_repository",
                    key: "github.com/example/dynamic-member-proof"
                  },
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          maximumFidelity: "lcm_leaves",
          includeCuratedMemory: false,
          includesFutureConversations: true,
          selectionSnapshotVersion: randomUUID(),
          completedReviewHash: hash("git-complete-review")
        });
      expect(ruleReview).not.toBeNull();
      const ruleId = randomUUID();
      const createRule = async (
        id: string,
        selector = ruleReview!.scope.selector
      ) => {
        const review = await repository.getRepositorySharingRuleCreationReview(
          owner,
          {
            selector,
            teamId: fixture.teamId,
            teamWorkspaceId: fixture.teamWorkspaceId,
            maximumFidelity: ruleReview!.scope.maximumFidelity,
            includeCuratedMemory: false,
            includesFutureConversations: true,
            completedReviewHash: hash("complete-independent-review"),
            selectionSnapshotVersion: randomUUID()
          }
        );
        const intent = {
          ...review!.scope,
          ruleId: id,
          mutationId: randomUUID()
        };
        return executeNative(
          (referenceId) =>
            sharedMemoryRepositoryRuleCreationActionGrantBinding({
              ...intent,
              referenceId
            }),
          (scoped, approved) =>
            scoped.createRepositorySharingRule(owner, {
              ...intent,
              publisherCredentialId: fixture.deviceCredentialId,
              authority: approved
            })
        );
      };
      expect(await createRule(ruleId)).toMatchObject({
        ruleId,
        state: "active",
        authorityVersion: 1
      });
      if (scenario === "owner_rules") {
        const secondId = randomUUID();
        await createRule(secondId, {
          kind: "project",
          key: hash("owner-wide-other-selection")
        });
        const first = await repository.listOwnedRepositorySharingRules(owner, {
          afterRuleId: null,
          limit: 1
        });
        expect(first.rules).toHaveLength(1);
        expect(first.nextCursor).toBe(first.rules[0]!.ruleId);
        const next = await repository.listOwnedRepositorySharingRules(owner, {
          afterRuleId: first.nextCursor,
          limit: 100
        });
        expect(next.nextCursor).toBeNull();
        expect(
          [...first.rules, ...next.rules].map((rule) => rule.ruleId).sort()
        ).toEqual([ruleId, secondId].sort());
        expect(
          await repository.listOwnedRepositorySharingRules(reader, {
            afterRuleId: null,
            limit: 100
          })
        ).toEqual({ rules: [], nextCursor: null });
        const scoped = await repository.listOwnedRepositorySharingRules(owner, {
          selector: ruleReview!.scope.selector,
          afterRuleId: null,
          limit: 100
        });
        expect(scoped.rules.map((rule) => rule.ruleId)).toEqual([ruleId]);
        expect(
          (
            await pool.query(
              "select 1 from team_memory_sharing_rule_members where rule_id=any($1::uuid[])",
              [[ruleId, secondId]]
            )
          ).rows
        ).toEqual([]);
        return;
      }
      const inspect = (source: SourceFixture, targetRuleId = ruleId) =>
        repository.inspectRepositorySharingRuleMembers(owner, {
          ruleId: targetRuleId,
          publisherCredentialId: fixture.deviceCredentialId,
          logicalMemoryIds: [source.logicalMemoryId]
        });
      const control = async (
        controlAction: "pause" | "resume" | "stop" | "retry",
        id: string = ruleId,
        credentialId = fixture.deviceCredentialId
      ) => {
        const current = (
          await pool.query<{
            authority_version: number;
            publisher_fence: number;
          }>(
            "select authority_version,publisher_fence::integer as publisher_fence from team_memory_sharing_rules where id=$1",
            [id]
          )
        ).rows[0]!;
        const intent = {
          selectorKind: "selection" as const,
          mutationId: randomUUID(),
          ruleId: id,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          expectedAuthorityVersion: current.authority_version,
          publisherFence: current.publisher_fence,
          controlAction
        };
        return executeNative(
          (referenceId) =>
            sharedMemoryRepositoryRuleControlActionGrantBinding({
              ...intent,
              referenceId
            }),
          (scoped, approved) =>
            scoped.controlRepositorySharingRule(owner, {
              ...intent,
              authority: approved
            }),
          credentialId
        );
      };
      const amendDetail = async (
        maximumFidelity: "lcm_leaves" | "lcm_rollups",
        id = ruleId
      ) => {
        const review = await repository.getSharingRuleDetailReview(owner, {
          ruleId: id,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          maximumFidelity,
          includeCuratedMemory: false
        });
        expect(review).not.toBeNull();
        const intent = { mutationId: randomUUID(), review: review! };
        return executeNative(
          (referenceId) =>
            sharedMemoryRuleDetailActionGrantBinding({
              ...intent,
              referenceId
            }),
          (scoped, approved) =>
            scoped.amendSharingRuleDetail(owner, {
              ...intent,
              authority: approved
            })
        );
      };
      const admission = async (
        source: SourceFixture,
        targetRuleId = ruleId
      ) => {
        const current = await inspect(source, targetRuleId),
          entry = current.entries[0]!;
        const candidateInput = {
          ...capturedSourceBinding(source, "lcm_leaves", [...representations]),
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          candidateHash: hash(
            `git-candidate:${source.logicalMemoryId}:${source.currentRevision}`
          ),
          sourceRevision: source.currentRevision,
          itemCount: 1,
          excludedItemCount: 0,
          manifest: candidateManifest(source, "lcm_leaves"),
          byteCount: 128,
          mode: "continuous" as const,
          ...fidelityConsent([...representations])
        };
        const candidate = await executeNative(
          (referenceId) =>
            sharedMemoryCandidatePreviewActionGrantBinding({
              ...candidateInput,
              referenceId
            }),
          (scoped, approved) =>
            scoped.createSharedMemoryCandidatePreview(owner, {
              ...candidateInput,
              authority: approved
            }),
          fixture.deviceCredentialId,
          "direct"
        );
        expect(candidate).not.toBeNull();
        const wire = {
          source: {
            kind: "captured_session" as const,
            sessionId: source.sessionId,
            logicalMemoryId: source.logicalMemoryId
          },
          sourceCapabilities: [...representations],
          activationRepresentation: "lcm_leaves" as const,
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          mutationId: randomUUID(),
          logicalGrantId: entry.grant?.logicalGrantId ?? randomUUID(),
          consentId: randomUUID(),
          mode: "continuous" as const,
          maximumFidelity: "lcm_leaves" as const,
          includeCuratedMemory: false,
          expiresAt: null,
          preview: {
            previewId: candidate!.previewId,
            previewHash: candidate!.previewHash
          },
          previewRevision: candidate!.previewRevision,
          membership: {
            ...([
              "portable_source",
              "publisher_transfer",
              "publisher_native_pending",
              "publisher_native_pending_restricted",
              "publisher_native_pending_revoked",
              "paused_publisher_transfer",
              "publisher_readmission",
              "publisher_readmission_admission",
              "publisher_readmission_recovery",
              "publisher_readmission_pending_revoked",
              "publisher_readmission_pending_policy"
            ].includes(scenario)
              ? {
                  sourceIdentity: {
                    originatingDeploymentId: "private-origin-deployment",
                    originatingDeviceId: "private-origin-device",
                    logicalSessionId: source.sessionId
                  }
                }
              : {}),
            selectionSnapshotVersion: randomUUID(),
            sourceContextHash: hash(`git-member:${source.logicalMemoryId}`),
            selectorBindingHash: current.selectorBindingHash,
            gitContextVersion: 1,
            folderContextVersion: 1,
            expectedAuthorityVersion: current.authorityVersion,
            expectedMembershipVersion: entry.member?.version ?? 0,
            expectedGrantVersion: entry.grant?.version ?? null,
            publisherFence: current.publisherFence
          }
        };
        const membershipId = crossIdentitySyncDeterministicUuid({
          kind: "sharing_rule_member",
          ruleId: targetRuleId,
          logicalMemoryId: source.logicalMemoryId
        });
        return {
          wire,
          membershipId,
          input: {
            ...wire,
            publisherCredentialId: fixture.deviceCredentialId,
            membership: { ...wire.membership, ruleId: targetRuleId }
          },
          cancellation: {
            ruleId: targetRuleId,
            publisherCredentialId: fixture.deviceCredentialId,
            mutationId: wire.mutationId,
            kind: "admit" as const,
            logicalMemoryId: source.logicalMemoryId,
            membershipId,
            requestHash: crossIdentitySyncDigest({
              kind: "admit",
              logicalMemoryId: source.logicalMemoryId,
              membershipId,
              body: wire
            })
          }
        };
      };
      const retryCodes = ["40001", "40P01"];
      let companionAttempts = 0;
      const ensureMemberCompanion: typeof ensurePendingShareCompanion = async (
        input
      ) => {
        companionAttempts += 1;
        if (scenario === "project_retry_denied")
          throw new SharedMemoryAuthorizationError("Owner access ended");
        const code =
          scenario === "project_retry_exhausted"
            ? "40001"
            : scenario === "project_retry"
              ? retryCodes.shift()
              : undefined;
        if (code)
          throw Object.assign(new Error("Concurrent sharing transaction"), {
            code
          });
        return ensurePendingShareCompanion(input);
      };
      const publishMember = async (pendingShareId: string) => {
        const preparing = await repository.processPendingShares({
          ensureCompanion: ensureMemberCompanion
        });
        expect(preparing).toMatchObject({ claimed: 1, failed: 0 });
        if (preparing.activated) return preparing;
        await flushSanitizedSemanticPublication();
        await pool.query(
          "update pending_share_outbox set available_at=now() where pending_share_id=$1 and state='pending'",
          [pendingShareId]
        );
        return repository.processPendingShares({
          ensureCompanion: ensureMemberCompanion
        });
      };
      let targetRuleId = ruleId;
      if (scenario === "revoked_repository") {
        await repository.revokeShareGrant(owner, {
          mutationId: randomUUID(),
          shareGrantId: direct.id,
          expectedGrantVersion: direct.grantVersion,
          reasonCode: "owner_withdrawal",
          authority: authority(fixture)
        });
        // A previously approved rule must not undo a later destination revoke.
        const stale = await admission(existing);
        await expect(
          repository.createPendingRepositoryRuleMember(owner, stale.input)
        ).rejects.toThrow("The rule destination changed after review");
        targetRuleId = randomUUID();
        await createRule(targetRuleId);
      }
      const admissionSource =
        scenario === "project_concurrent_fresh"
          ? await createSource(fixture, 1, "concurrent-fresh", {
              repositorySnapshot: unresolvedTeamRepositorySnapshot()
            })
          : existing;
      if (admissionSource !== existing)
        await putOwnerPolicy(fixture, admissionSource, [...representations]);
      const first = await admission(admissionSource, targetRuleId);
      const accepted = await repository.createPendingRepositoryRuleMember(
        owner,
        first.input
      );
      expect(accepted.membershipId).toBe(first.membershipId);
      if (scenario === "portable_source") {
        const row = (
          await pool.query<{ portable_source_hash: string; record: unknown }>(
            "select portable_source_hash,to_jsonb(member) as record from team_memory_sharing_rule_members member where id=$1",
            [accepted.membershipId]
          )
        ).rows[0]!;
        expect(row.portable_source_hash).toBe(
          sharingRuleSourceIdentityHash(
            fixture.ownerUserId,
            first.input.membership.sourceIdentity!
          )
        );
        expect(JSON.stringify(row.record)).not.toContain("private-origin-");
        const resolution = {
          ruleId: targetRuleId,
          publisherCredentialId: fixture.deviceCredentialId,
          sourceIdentity: first.input.membership.sourceIdentity!
        };
        expect(
          await repository.resolveRepositorySharingRuleSource(owner, resolution)
        ).toEqual({ logicalMemoryId: existing.logicalMemoryId });
        expect(
          await repository.resolveRepositorySharingRuleSource(owner, {
            ...resolution,
            sourceIdentity: {
              ...resolution.sourceIdentity,
              logicalSessionId: randomUUID()
            }
          })
        ).toEqual({ logicalMemoryId: null });
        await expect(
          repository.resolveRepositorySharingRuleSource(reader, resolution)
        ).rejects.toThrow();
        await expect(
          repository.resolveRepositorySharingRuleSource(owner, {
            ...resolution,
            publisherCredentialId: randomUUID()
          })
        ).rejects.toThrow();
        expect(
          await repository.createPendingRepositoryRuleMember(owner, first.input)
        ).toEqual(accepted);
      }
      if (
        scenario === "project_concurrent" ||
        scenario === "project_concurrent_fresh" ||
        scenario === "project_concurrent_revoked"
      ) {
        const otherRuleId = randomUUID();
        await createRule(otherRuleId, {
          kind: "project",
          key: hash("concurrent-private-project")
        });
        const other = await admission(admissionSource, otherRuleId);
        const otherAccepted =
          await repository.createPendingRepositoryRuleMember(
            owner,
            other.input
          );
        if (scenario === "project_concurrent_revoked") {
          expect(
            await repository.processPendingShares({
              limit: 1,
              ensureCompanion: ensurePendingShareCompanion
            })
          ).toMatchObject({ failed: 0, waiting: 1 });
          const current = (await inspect(existing)).entries[0]!.grant!;
          await repository.revokeShareGrant(owner, {
            mutationId: randomUUID(),
            shareGrantId: current.id,
            expectedGrantVersion: current.version,
            reasonCode: "owner_withdrawal",
            authority: authority(fixture)
          });
          expect(
            await repository.processPendingShares({
              limit: 1,
              ensureCompanion: ensurePendingShareCompanion
            })
          ).toMatchObject({ failed: 1, activated: 0 });
          expect(
            await repository.readGrantRepresentation(reader, {
              shareGrantId: current.id,
              representation: "lcm_leaves"
            })
          ).toBeNull();
          return;
        }
        const activationFailures: unknown[] = [];
        const reportActivationFailure = (failure: unknown) => {
          activationFailures.push(failure);
        };
        const reports = await Promise.all([
          repository.processPendingShares({
            limit: 1,
            reportActivationFailure,
            ensureCompanion: ensurePendingShareCompanion
          }),
          repository.processPendingShares({
            limit: 1,
            reportActivationFailure,
            ensureCompanion: ensurePendingShareCompanion
          })
        ]);

        expect(activationFailures).toEqual([]);
        expect(reports.reduce((n, report) => n + report.failed, 0)).toBe(0);
        await flushSanitizedSemanticPublication();
        await pool.query(
          "update pending_share_outbox set available_at=now() where pending_share_id=any($1::uuid[]) and state='pending'",
          [[accepted.pendingShareId, otherAccepted.pendingShareId]]
        );
        const [complete] = await Promise.all([
          Promise.all([
            repository.processPendingShares({
              limit: 1,
              ensureCompanion: ensurePendingShareCompanion
            }),
            repository.processPendingShares({
              limit: 1,
              ensureCompanion: ensurePendingShareCompanion
            })
          ]),
          scenario === "project_concurrent_fresh"
            ? seedAuthoritativeSourceRevision(
                fixture,
                admissionSource,
                2,
                "concurrent-later-turn",
                { repositorySnapshot: unresolvedTeamRepositorySnapshot() }
              )
            : Promise.resolve()
        ]);

        expect(complete.reduce((n, report) => n + report.failed, 0)).toBe(0);
        for (const id of [
          accepted.pendingShareId,
          otherAccepted.pendingShareId
        ])
          expect(
            await repository.getOwnerShare(owner, { kind: "pending", id })
          ).toMatchObject({
            kind: "pending",
            pendingShare: { state: "activated" }
          });
        const reasons = await pool.query<{ count: string }>(
          "select count(*)::text as count from team_memory_share_reasons where share_grant_id=$1 and kind='rule'",
          [
            (
              await pool.query<{ id: string }>(
                "select id from team_memory_share_grants where logical_memory_id=$1 and team_workspace_id=$2",
                [admissionSource.logicalMemoryId, fixture.teamWorkspaceId]
              )
            ).rows[0]!.id
          ]
        );
        expect(reasons.rows[0]!.count).toBe("2");
        if (scenario === "project_concurrent_fresh") {
          await pool.query(
            "update team_memory_sharing_rule_members set next_reconciliation_at=now() where id=any($1::uuid[])",
            [[accepted.membershipId, otherAccepted.membershipId]]
          );
          expect(
            await repository.reconcileSharingRuleMembers({ limit: 100 })
          ).toMatchObject({ failed: 0 });
          await flushSanitizedSemanticPublication();
          const publications = await pool.query<{ count: string }>(
            `select count(distinct publication.reason_id)::text as count from team_memory_reason_publications publication join team_memory_representations representation on representation.id=publication.representation_id join team_memory_share_reasons reason on reason.id=publication.reason_id where reason.membership_id=any($1::uuid[]) and representation.source_revision=2 and representation.state in ('available','stale') and representation.invalidated_at is null`,
            [[accepted.membershipId, otherAccepted.membershipId]]
          );
          expect(publications.rows[0]!.count).toBe("2");
        }

        return;
      }

      if (
        scenario === "project_retry_exhausted" ||
        scenario === "project_retry_denied"
      ) {
        expect(
          await repository.processPendingShares({
            ensureCompanion: ensureMemberCompanion
          })
        ).toMatchObject({ failed: 1, activated: 0 });
        expect(companionAttempts).toBe(
          scenario === "project_retry_exhausted" ? 3 : 1
        );
        expect(
          await repository.getOwnerShare(owner, {
            kind: "pending",
            id: accepted.pendingShareId
          })
        ).toMatchObject({
          kind: "pending",
          pendingShare: { state: "needs_attention" }
        });
        return;
      }
      if (scenario === "revoked_during_admission") {
        await repository.revokeShareGrant(owner, {
          mutationId: randomUUID(),
          shareGrantId: direct.id,
          expectedGrantVersion: direct.grantVersion,
          reasonCode: "owner_withdrawal",
          authority: authority(fixture)
        });
        expect(
          await repository.processPendingShares({
            ensureCompanion: ensurePendingShareCompanion
          })
        ).toMatchObject({ activated: 0, failed: 1 });
        expect((await inspect(existing)).entries[0]!.grant).toMatchObject({
          id: direct.id,
          lifecycle: "revoked"
        });
        expect(
          await repository.readGrantRepresentation(reader, {
            shareGrantId: direct.id,
            representation: "lcm_leaves"
          })
        ).toBeNull();
        return;
      }
      expect(
        await repository.cancelRepositorySharingRuleMutation(
          owner,
          first.cancellation
        )
      ).toMatchObject({ state: "accepted", receipt: accepted });
      expect(await publishMember(accepted.pendingShareId)).toMatchObject({
        activated: 1,
        failed: 0
      });
      if (
        scenario === "publisher_transfer" ||
        scenario === "publisher_native_pending" ||
        scenario === "publisher_native_pending_restricted" ||
        scenario === "publisher_native_pending_revoked" ||
        scenario === "paused_publisher_transfer" ||
        scenario === "publisher_readmission" ||
        scenario === "publisher_readmission_admission" ||
        scenario === "publisher_readmission_recovery" ||
        scenario === "publisher_readmission_pending_revoked" ||
        scenario === "publisher_readmission_pending_policy"
      ) {
        const unpublished =
          scenario === "publisher_native_pending" ||
          scenario === "publisher_native_pending_restricted" ||
          scenario === "publisher_native_pending_revoked"
            ? await (async () => {
                const source = await createSource(
                  fixture,
                  1,
                  "native-pending-at-takeover",
                  { repositorySnapshot: sharedAnchor }
                );
                const native = await admission(source);
                const receipt =
                  await repository.createPendingRepositoryRuleMember(
                    owner,
                    native.input
                  );
                return { source, native, receipt };
              })()
            : null;
        const paused = scenario === "paused_publisher_transfer";
        const before = paused
          ? await control("pause")
          : await inspect(existing);
        const receivingCredentialId = (
          await pool.query<{ id: string }>(
            `insert into device_credentials(owner_user_id,credential_key_id,upstream_backend_id,device_instance_id,verifier_kind,verifier_hash,operation_families,device_label)
           values($1,$2,$3,$4,'secret_hash',$5,ARRAY['sync','share_grant_management','team_workspace_read']::text[],'Receiving publisher') returning id`,
            [
              fixture.ownerUserId,
              randomUUID(),
              `backend-${randomUUID()}`,
              randomUUID(),
              hash("receiving-publisher")
            ]
          )
        ).rows[0]!.id;
        const reviewInput = {
          ruleId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          expectedAuthorityVersion: before.authorityVersion,
          publisherFence: before.publisherFence,
          sourceIdentity: first.input.membership.sourceIdentity!,
          receivingCredentialId
        };
        expect(
          await repository.getSharingRulePublisherTakeoverReview(owner, {
            ...reviewInput,
            receivingCredentialId: fixture.deviceCredentialId
          })
        ).toBeNull();
        expect(
          await repository.getSharingRulePublisherTakeoverReview(
            reader,
            reviewInput
          )
        ).toBeNull();
        expect(
          await repository.getSharingRulePublisherTakeoverReview(owner, {
            ...reviewInput,
            sourceIdentity: {
              ...reviewInput.sourceIdentity,
              logicalSessionId: randomUUID()
            }
          })
        ).toBeNull();
        const review = await repository.getSharingRulePublisherTakeoverReview(
          owner,
          reviewInput
        );
        expect(review).toMatchObject({
          state: paused ? "paused" : "active",
          logicalMemoryId: existing.logicalMemoryId,
          currentPublisher: { credentialId: fixture.deviceCredentialId },
          receivingPublisher: { credentialId: receivingCredentialId },
          maximumFidelity: "lcm_leaves",
          includeCuratedMemory: false
        });
        const intent = { mutationId: randomUUID(), review: review! };
        await expect(
          repository.takeOverSharingRulePublisher(owner, {
            ...intent,
            receivingCredentialId,
            authority: authority(fixture)
          })
        ).rejects.toThrow("exact native approval");
        const rootsBefore = await pool.query(
          "select id,logical_memory_id,consent_id from team_memory_share_grants where logical_memory_id=$1 order by id",
          [existing.logicalMemoryId]
        );
        const transferred = await executeNative(
          (referenceId) =>
            sharedMemoryPublisherTakeoverActionGrantBinding({
              ...intent,
              referenceId
            }),
          (scoped, approved) =>
            scoped.takeOverSharingRulePublisher(owner, {
              ...intent,
              receivingCredentialId,
              authority: approved
            }),
          receivingCredentialId,
          "native_review",
          true
        );
        expect(transferred).toMatchObject({
          state: paused ? "paused" : "active",
          publisherCredentialId: receivingCredentialId,
          previousPublisherCredentialId: fixture.deviceCredentialId,
          authorityVersion: before.authorityVersion + 1,
          publisherFence: before.publisherFence + 1,
          catchUpState: paused ? "idle" : "queued"
        });
        if (unpublished) {
          const inspectPending = () =>
            repository.inspectRepositorySharingRuleMembers(owner, {
              ruleId,
              publisherCredentialId: receivingCredentialId,
              logicalMemoryIds: [unpublished.source.logicalMemoryId]
            });
          const current = await inspectPending(),
            entry = current.entries[0]!;
          expect(entry.grant).toBeNull();
          expect(entry.member).toMatchObject({
            state: "unresolved",
            pendingShare: { requiresReadmission: true }
          });
          const membership = {
            ...unpublished.native.input.membership,
            ruleId: undefined
          };
          delete membership.ruleId;
          const request = {
            mutationId: randomUUID(),
            consentId: randomUUID(),
            logicalMemoryId: unpublished.source.logicalMemoryId,
            ruleId,
            publisherCredentialId: receivingCredentialId,
            membership: {
              ...membership,
              sourceIdentity:
                unpublished.native.input.membership.sourceIdentity!,
              expectedAuthorityVersion: current.authorityVersion,
              publisherFence: current.publisherFence,
              expectedMembershipVersion: entry.member!.version,
              expectedGrantVersion: null
            }
          };
          if (
            scenario === "publisher_native_pending_restricted" ||
            scenario === "publisher_native_pending_revoked"
          ) {
            if (scenario === "publisher_native_pending_restricted")
              await putOwnerPolicy(fixture, unpublished.source, [
                "lcm_rollups"
              ]);
            else {
              const details = await repository.getOwnerShare(owner, {
                kind: "pending",
                id: unpublished.receipt.pendingShareId
              });
              if (details?.kind !== "pending")
                throw new Error("Native pending source missing");
              await repository.controlPendingShare(owner, {
                pendingShareId: unpublished.receipt.pendingShareId,
                mutationId: randomUUID(),
                action: "revoke",
                expectedOperationVersion: details.pendingShare.operationVersion
              });
              const changed = await inspectPending();
              request.membership.expectedAuthorityVersion =
                changed.authorityVersion;
              request.membership.expectedMembershipVersion =
                changed.entries[0]!.member!.version;
            }
            await expect(
              repository.readmitRepositorySharingRuleMember(owner, request)
            ).rejects.toThrow();
            expect(
              (
                await pool.query<{ count: number }>(
                  "select count(*)::int as count from team_memory_share_grants where logical_memory_id=$1",
                  [unpublished.source.logicalMemoryId]
                )
              ).rows[0]!.count
            ).toBe(0);
            expect(
              (
                await pool.query<{ count: number }>(
                  "select count(*)::int as count from source_owner_representation_consents where logical_memory_id=$1",
                  [unpublished.source.logicalMemoryId]
                )
              ).rows[0]!.count
            ).toBe(0);
            if (scenario === "publisher_native_pending_restricted")
              expect(
                (
                  await pool.query<{ maximum_fidelity: string }>(
                    "select maximum_fidelity from source_owner_representation_policies where logical_memory_id=$1 and superseded_at is null",
                    [unpublished.source.logicalMemoryId]
                  )
                ).rows[0]!.maximum_fidelity
              ).toBe("lcm_rollups");
            if (scenario === "publisher_native_pending_restricted") {
              const details = await repository.getOwnerShare(owner, {
                kind: "pending",
                id: unpublished.receipt.pendingShareId
              });
              if (details?.kind !== "pending")
                throw new Error("Native pending source missing");
              await repository.controlPendingShare(owner, {
                pendingShareId: unpublished.receipt.pendingShareId,
                mutationId: randomUUID(),
                action: "revoke",
                expectedOperationVersion: details.pendingShare.operationVersion
              });
            }
            await control("stop", ruleId, receivingCredentialId);
            return;
          }
          const receipt = await repository.readmitRepositorySharingRuleMember(
            owner,
            request
          );
          expect(receipt).toMatchObject({
            membershipId: entry.member!.id,
            membershipVersion: entry.member!.version + 1,
            sourceRevision: 1
          });
          expect(
            await repository.readmitRepositorySharingRuleMember(owner, request)
          ).toEqual(receipt);
          expect(
            (
              await pool.query<{ state: string }>(
                "select state from pending_share_operations where id=$1",
                [unpublished.receipt.pendingShareId]
              )
            ).rows[0]!.state
          ).toBe("revoked");
          const failures: unknown[] = [];
          expect(
            await repository.processPendingShares({
              limit: 10,
              ensureCompanion: ensurePendingShareCompanion,
              reportActivationFailure: (error) => failures.push(error)
            })
          ).toMatchObject({ failed: 0 });
          expect(failures).toEqual([]);
          await flushSanitizedSemanticPublication();
          await pool.query(
            "update pending_share_outbox set available_at=now() where pending_share_id=$1 and state='pending'",
            [receipt.pendingShareId]
          );
          expect(
            await repository.processPendingShares({
              limit: 10,
              ensureCompanion: ensurePendingShareCompanion,
              reportActivationFailure: (error) => failures.push(error)
            })
          ).toMatchObject({ failed: 0 });
          expect(failures).toEqual([]);
          const activated = (await inspectPending()).entries[0]!;
          expect(activated.member).toMatchObject({
            id: receipt.membershipId,
            state: "present"
          });
          expect(activated.grant).not.toBeNull();
          expect(
            await repository.readGrantRepresentation(reader, {
              shareGrantId: activated.grant!.id,
              representation: "lcm_leaves"
            })
          ).toMatchObject({ representation: { sourceRevision: 1 } });
          expect(
            (
              await pool.query<{ count: number }>(
                "select count(*)::int as count from team_memory_share_grants where logical_memory_id=$1",
                [unpublished.source.logicalMemoryId]
              )
            ).rows[0]!.count
          ).toBe(1);
          expect(
            (
              await pool.query<{ count: number }>(
                "select count(*)::int as count from source_owner_representation_consents where id=$1",
                [unpublished.native.input.consentId]
              )
            ).rows[0]!.count
          ).toBe(0);
          expect(
            (
              await pool.query<{ count: number }>(
                "select count(*)::int as count from source_owner_representation_policies where logical_memory_id=$1",
                [unpublished.source.logicalMemoryId]
              )
            ).rows[0]!.count
          ).toBe(1);
          await control("stop", ruleId, receivingCredentialId);
          return;
        }
        if (
          scenario === "publisher_readmission" ||
          scenario === "publisher_readmission_admission" ||
          scenario === "publisher_readmission_recovery" ||
          scenario === "publisher_readmission_pending_revoked" ||
          scenario === "publisher_readmission_pending_policy"
        ) {
          const inspectReceiving = () =>
            repository.inspectRepositorySharingRuleMembers(owner, {
              ruleId,
              publisherCredentialId: receivingCredentialId,
              logicalMemoryIds: [existing.logicalMemoryId]
            });
          let current = await inspectReceiving();
          const inputFor = (
            state: Awaited<ReturnType<typeof inspectReceiving>>
          ) => ({
            ruleId,
            publisherCredentialId: receivingCredentialId,
            expectedAuthorityVersion: state.authorityVersion,
            publisherFence: state.publisherFence,
            expectedMembershipVersion: state.entries[0]!.member!.version,
            expectedGrantVersion: state.entries[0]!.grant!.version,
            sourceIdentity: reviewInput.sourceIdentity
          });
          await expect(
            repository.getRepositorySharingRuleMemberReadmissionAuthority(
              owner,
              inputFor(current)
            )
          ).rejects.toThrow();
          await expect(
            repository.prepareRepositorySharingRuleMemberReadmission(
              owner,
              inputFor(current)
            )
          ).rejects.toThrow();
          await repository.removeSharingRuleMember(owner, {
            ruleId,
            membershipId: current.entries[0]!.member!.id,
            publisherCredentialId: receivingCredentialId,
            mutationId: randomUUID(),
            selectionSnapshotVersion: randomUUID(),
            sourceContextHash: hash("temporarily-not-matching"),
            expectedAuthorityVersion: current.authorityVersion,
            expectedMembershipVersion: current.entries[0]!.member!.version,
            publisherFence: current.publisherFence
          });
          current = await inspectReceiving();
          const input = inputFor(current);
          const unchanged = async () =>
            (
              await pool.query<{
                state: string;
                membership_version: number;
                id: string;
                grant_version: number;
                consent_count: string;
                pending_count: string;
                source_count: string;
              }>(
                `select member.state,member.membership_version,grant_row.id,grant_row.grant_version,
            (select count(*) from source_owner_representation_consents where logical_memory_id=$1) consent_count,
            (select count(*) from pending_share_operations where logical_memory_id=$1) pending_count,
            (select count(*) from captured_session_logical_memories where logical_memory_id=$1) source_count
            from team_memory_sharing_rule_members member join team_memory_share_reasons reason on reason.membership_id=member.id
            join team_memory_share_grants grant_row on grant_row.id=reason.share_grant_id where member.id=$2`,
                [existing.logicalMemoryId, current.entries[0]!.member!.id]
              )
            ).rows;
          const assertReadmissionDenied = async () => {
            await expect(
              repository.getRepositorySharingRuleMemberReadmissionAuthority(
                owner,
                input
              )
            ).rejects.toThrow();
            await expect(
              repository.prepareRepositorySharingRuleMemberReadmission(
                owner,
                input
              )
            ).rejects.toThrow();
          };
          const beforeProof = await unchanged();
          let scope =
            await repository.getRepositorySharingRuleMemberReadmissionAuthority(
              owner,
              input
            );
          expect(scope).toMatchObject({
            ruleId,
            membershipId: current.entries[0]!.member!.id,
            logicalMemoryId: existing.logicalMemoryId,
            shareGrantId: current.entries[0]!.grant!.id,
            remoteReplicaId: existing.remoteReplicaId,
            sourceSessionId: existing.sessionId,
            sourceCredentialId: fixture.deviceCredentialId,
            publisherCredentialId: receivingCredentialId,
            sourceRevision: 1,
            portableSourceHash: sharingRuleSourceIdentityHash(
              owner.userId,
              input.sourceIdentity
            )
          });
          const prepared =
            await repository.prepareRepositorySharingRuleMemberReadmission(
              owner,
              input
            );
          expect(prepared.authority).toEqual(scope);
          expect(prepared.preview).toMatchObject({
            logicalMemoryId: existing.logicalMemoryId,
            remoteReplicaId: existing.remoteReplicaId,
            ownerUserId: owner.userId,
            teamId: fixture.teamId,
            teamWorkspaceId: fixture.teamWorkspaceId,
            representation: "lcm_leaves",
            activationRepresentation: "lcm_leaves",
            sourceRevision: 1,
            mode: "continuous",
            source: { kind: "captured_session", sessionId: existing.sessionId }
          });
          expect(prepared.preview.items.length).toBeGreaterThan(0);
          expect(prepared.preview.syncRelationshipId).toBeTruthy();
          expect(prepared.authority.sourceCapabilities).toEqual([
            ...representations
          ]);
          expect(prepared.manifest).toEqual(
            candidateManifest(existing, "lcm_leaves")
          );
          expect(await unchanged()).toEqual(beforeProof);
          expect(
            await repository.readGrantRepresentation(reader, {
              shareGrantId: scope.shareGrantId!,
              representation: "lcm_leaves"
            })
          ).toBeNull();
          for (const denied of [
            { ...input, publisherCredentialId: fixture.deviceCredentialId },
            {
              ...input,
              expectedMembershipVersion: input.expectedMembershipVersion - 1
            },
            { ...input, expectedGrantVersion: input.expectedGrantVersion + 1 },
            { ...input, publisherFence: input.publisherFence + 1 },
            {
              ...input,
              sourceIdentity: {
                ...input.sourceIdentity,
                logicalSessionId: randomUUID()
              }
            }
          ]) {
            await expect(
              repository.getRepositorySharingRuleMemberReadmissionAuthority(
                owner,
                denied
              )
            ).rejects.toThrow();
            await expect(
              repository.prepareRepositorySharingRuleMemberReadmission(
                owner,
                denied
              )
            ).rejects.toThrow();
          }
          await expect(
            repository.getRepositorySharingRuleMemberReadmissionAuthority(
              reader,
              input
            )
          ).rejects.toThrow();
          await expect(
            repository.prepareRepositorySharingRuleMemberReadmission(
              reader,
              input
            )
          ).rejects.toThrow();
          await pool.query(
            "update sync_summary_node_mappings set active=false where sync_relationship_id=$1 and active=true",
            [prepared.preview.syncRelationshipId]
          );
          await expect(
            repository.prepareRepositorySharingRuleMemberReadmission(
              owner,
              input
            )
          ).rejects.toThrow("origin mappings");
          await pool.query(
            "update sync_summary_node_mappings set active=true where sync_relationship_id=$1",
            [prepared.preview.syncRelationshipId]
          );
          expect(await unchanged()).toEqual(beforeProof);
          await seedAuthoritativeSourceRevision(
            fixture,
            existing,
            2,
            "removed-source-reentry",
            { repositorySnapshot: sharedAnchor }
          );
          const updated =
            await repository.prepareRepositorySharingRuleMemberReadmission(
              owner,
              input
            );
          expect(updated.preview.sourceRevision).toBe(2);
          expect(updated.preview.source).toMatchObject({
            kind: "captured_session",
            sessionId: existing.sessionId
          });
          expect(updated.authority.sourceCredentialId).toBe(
            fixture.deviceCredentialId
          );
          expect(updated.manifest).toEqual(
            candidateManifest(existing, "lcm_leaves")
          );
          expect(updated.manifest).not.toEqual(prepared.manifest);
          scope = updated.authority;
          expect(await unchanged()).toEqual(beforeProof);
          const policy = (
            await pool.query<{ maximum_fidelity: string }>(
              "select maximum_fidelity from source_owner_representation_policies where policy_id=$1 and version=$2",
              [scope.sourceOwnerPolicyId, scope.sourceOwnerPolicyVersion]
            )
          ).rows[0]!;
          await pool.query(
            "update source_owner_representation_policies set maximum_fidelity='lcm_rollups' where policy_id=$1 and version=$2",
            [scope.sourceOwnerPolicyId, scope.sourceOwnerPolicyVersion]
          );
          await assertReadmissionDenied();
          await pool.query(
            "update source_owner_representation_policies set maximum_fidelity=$3 where policy_id=$1 and version=$2",
            [
              scope.sourceOwnerPolicyId,
              scope.sourceOwnerPolicyVersion,
              policy.maximum_fidelity
            ]
          );
          const exclusion = (
            await pool.query<{ id: string }>(
              `insert into team_memory_workspace_exclusions(owner_user_id,logical_memory_id,team_id,team_workspace_id)
            values($1,$2,$3,$4) returning id`,
              [
                owner.userId,
                scope.logicalMemoryId,
                scope.teamId,
                scope.teamWorkspaceId
              ]
            )
          ).rows[0]!.id;
          await assertReadmissionDenied();
          await pool.query(
            "delete from team_memory_workspace_exclusions where id=$1",
            [exclusion]
          );
          expect(
            await repository.getRepositorySharingRuleMemberReadmissionAuthority(
              owner,
              input
            )
          ).toEqual(scope);
          await pool.query(
            "update source_owner_representation_consents set state_reason_code='selection_rule_stopped' where id=$1",
            [first.input.consentId]
          );
          await assertReadmissionDenied();
          await pool.query(
            "update source_owner_representation_consents set state_reason_code='selection_membership_removed' where id=$1",
            [first.input.consentId]
          );
          await pool.query(
            "update team_memory_sharing_rule_members set state='revoked' where id=$1",
            [scope.membershipId]
          );
          await assertReadmissionDenied();
          await pool.query(
            "update team_memory_sharing_rule_members set state='removed' where id=$1",
            [scope.membershipId]
          );
          if (
            scenario === "publisher_readmission_admission" ||
            scenario === "publisher_readmission_recovery" ||
            scenario === "publisher_readmission_pending_revoked" ||
            scenario === "publisher_readmission_pending_policy"
          ) {
            const body = {
              mutationId: randomUUID(),
              consentId: randomUUID(),
              logicalMemoryId: existing.logicalMemoryId,
              membership: {
                ...first.input.membership,
                ruleId: undefined,
                sourceIdentity: input.sourceIdentity,
                selectionSnapshotVersion: randomUUID(),
                sourceContextHash: hash("reentered-current-selection"),
                expectedAuthorityVersion: input.expectedAuthorityVersion,
                expectedMembershipVersion: input.expectedMembershipVersion,
                expectedGrantVersion: input.expectedGrantVersion,
                publisherFence: input.publisherFence
              }
            };
            delete body.membership.ruleId;
            let request = {
              ...body,
              ruleId,
              publisherCredentialId: receivingCredentialId
            };
            let admitted = await repository.readmitRepositorySharingRuleMember(
              owner,
              request
            );
            const persistedProof = (
              await pool.query<{ proof: unknown }>(
                "select existing_source_readmission as proof from pending_sharing_rule_admissions where pending_share_id=$1",
                [admitted.pendingShareId]
              )
            ).rows[0]!.proof;
            expect(persistedProof).toMatchObject({
              input: { portableSourceHash: scope.portableSourceHash }
            });
            expect(persistedProof).not.toHaveProperty("input.sourceIdentity");
            expect(JSON.stringify(persistedProof)).not.toContain(
              input.sourceIdentity.originatingDeploymentId
            );
            expect(JSON.stringify(persistedProof)).not.toContain(
              input.sourceIdentity.originatingDeviceId
            );
            expect(JSON.stringify(persistedProof)).not.toContain(
              input.sourceIdentity.logicalSessionId
            );

            expect(admitted).toMatchObject({
              membershipId: scope.membershipId,
              membershipVersion: scope.membershipVersion + 1,
              sourceRevision: 2
            });
            expect(
              await repository.readmitRepositorySharingRuleMember(
                owner,
                request
              )
            ).toEqual(admitted);
            await expect(
              repository.readmitRepositorySharingRuleMember(owner, {
                ...request,
                consentId: randomUUID()
              })
            ).rejects.toThrow();
            await expect(
              repository.readmitRepositorySharingRuleMember(owner, {
                ...request,
                publisherCredentialId: fixture.deviceCredentialId
              })
            ).rejects.toThrow();
            if (
              scenario === "publisher_readmission_pending_revoked" ||
              scenario === "publisher_readmission_pending_policy"
            ) {
              if (scenario === "publisher_readmission_pending_revoked")
                await pool.query(
                  "update device_credentials set revoked_at=now() where id=$1",
                  [fixture.deviceCredentialId]
                );
              else
                await pool.query(
                  "update source_owner_representation_policies set maximum_fidelity='lcm_rollups' where policy_id=$1 and version=$2",
                  [scope.sourceOwnerPolicyId, scope.sourceOwnerPolicyVersion]
                );
              expect(
                await repository.processPendingShares({
                  limit: 10,
                  ensureCompanion: ensurePendingShareCompanion
                })
              ).toMatchObject({ activated: 0, failed: 1 });
              expect((await inspectReceiving()).entries[0]!.member!.state).toBe(
                "unresolved"
              );
              expect(
                await repository.readGrantRepresentation(reader, {
                  shareGrantId: scope.shareGrantId!,
                  representation: "lcm_leaves"
                })
              ).toBeNull();
              expect(
                (
                  await pool.query<{ count: number }>(
                    "select count(*)::int as count from source_owner_representation_consents where id=$1",
                    [body.consentId]
                  )
                ).rows[0]!.count
              ).toBe(0);
              if (scenario === "publisher_readmission_pending_policy")
                expect(
                  (
                    await pool.query<{ maximum_fidelity: string }>(
                      "select maximum_fidelity from source_owner_representation_policies where policy_id=$1 and version=$2",
                      [
                        scope.sourceOwnerPolicyId,
                        scope.sourceOwnerPolicyVersion
                      ]
                    )
                  ).rows[0]!.maximum_fidelity
                ).toBe("lcm_rollups");
              expect(
                await repository.readmitRepositorySharingRuleMember(
                  owner,
                  request
                )
              ).toEqual(admitted);
              await control("stop", ruleId, receivingCredentialId);
              return;
            }
            let wantedRevision = 2;
            if (scenario === "publisher_readmission_recovery") {
              const originalRequest = request,
                originalReceipt = admitted;
              let pendingState = await inspectReceiving();
              expect(
                pendingState.entries[0]!.member!.pendingShare
              ).toMatchObject({ requiresReadmission: false });
              const nextRequest = {
                ...request,
                mutationId: randomUUID(),
                consentId: randomUUID(),
                membership: {
                  ...request.membership,
                  expectedMembershipVersion:
                    pendingState.entries[0]!.member!.version,
                  expectedGrantVersion: pendingState.entries[0]!.grant!.version
                }
              };
              await expect(
                repository.readmitRepositorySharingRuleMember(
                  owner,
                  nextRequest
                )
              ).rejects.toThrow("current admission work");
              await seedAuthoritativeSourceRevision(
                fixture,
                existing,
                3,
                "pending-source-advanced",
                { repositorySnapshot: sharedAnchor }
              );
              pendingState = await inspectReceiving();
              expect(
                pendingState.entries[0]!.member!.pendingShare
              ).toMatchObject({ requiresReadmission: true });
              request = nextRequest;
              admitted = await repository.readmitRepositorySharingRuleMember(
                owner,
                request
              );
              expect(admitted.sourceRevision).toBe(3);
              expect(admitted.membershipVersion).toBe(
                originalReceipt.membershipVersion + 1
              );
              expect(admitted.pendingShareId).not.toBe(
                originalReceipt.pendingShareId
              );
              expect(
                (
                  await pool.query<{ state: string }>(
                    "select state from pending_share_operations where id=$1",
                    [originalReceipt.pendingShareId]
                  )
                ).rows[0]!.state
              ).toBe("revoked");
              expect(
                await repository.readmitRepositorySharingRuleMember(
                  owner,
                  originalRequest
                )
              ).toEqual(originalReceipt);
              expect(
                (
                  await pool.query<{ count: number }>(
                    "select count(*)::int as count from source_owner_representation_consents where id=$1",
                    [originalRequest.consentId]
                  )
                ).rows[0]!.count
              ).toBe(0);
              wantedRevision = 3;
            }
            const failures: unknown[] = [];
            expect(
              await repository.processPendingShares({
                limit: 10,
                ensureCompanion: ensurePendingShareCompanion,
                reportActivationFailure: (error) => failures.push(error)
              })
            ).toMatchObject({ failed: 0 });
            expect(failures).toEqual([]);
            await flushSanitizedSemanticPublication();
            await pool.query(
              "update pending_share_outbox set available_at=now() where pending_share_id=$1 and state='pending'",
              [admitted.pendingShareId]
            );
            expect(
              await repository.processPendingShares({
                limit: 10,
                ensureCompanion: ensurePendingShareCompanion,
                reportActivationFailure: (error) => failures.push(error)
              })
            ).toMatchObject({ failed: 0 });
            expect(failures).toEqual([]);
            expect((await inspectReceiving()).entries[0]!.member).toMatchObject(
              { id: scope.membershipId, state: "present" }
            );
            expect((await inspectReceiving()).entries[0]!.grant!.id).toBe(
              scope.shareGrantId
            );
            expect(
              await repository.readGrantRepresentation(reader, {
                shareGrantId: scope.shareGrantId!,
                representation: "lcm_leaves"
              })
            ).toMatchObject({
              representation: { sourceRevision: wantedRevision }
            });
            expect(
              (
                await pool.query(
                  "select state,state_reason_code from source_owner_representation_consents where id=$1",
                  [first.input.consentId]
                )
              ).rows[0]
            ).toMatchObject({
              state: "revoked",
              state_reason_code: "selection_membership_removed"
            });
            expect(
              (
                await pool.query<{ count: number }>(
                  "select count(*)::int as count from captured_session_logical_memories where logical_memory_id=$1",
                  [existing.logicalMemoryId]
                )
              ).rows[0]!.count
            ).toBe(1);
            expect(
              await repository.readmitRepositorySharingRuleMember(
                owner,
                request
              )
            ).toEqual(admitted);
            await control("stop", ruleId, receivingCredentialId);
            return;
          }
          await pool.query(
            "update device_credentials set revoked_at=now() where id=$1",
            [fixture.deviceCredentialId]
          );
          await assertReadmissionDenied();
          expect(await unchanged()).toEqual(beforeProof);
          await control("stop", ruleId, receivingCredentialId);
          return;
        }
        expect(
          (
            await pool.query(
              "select id,logical_memory_id,consent_id from team_memory_share_grants where logical_memory_id=$1 order by id",
              [existing.logicalMemoryId]
            )
          ).rows
        ).toEqual(rootsBefore.rows);
        await expect(inspect(existing)).rejects.toThrow();
        const inventoryInput = {
          ruleId,
          publisherCredentialId: receivingCredentialId,
          expectedAuthorityVersion: transferred.authorityVersion,
          publisherFence: transferred.publisherFence
        };
        const inventory =
          await repository.listRepositorySharingRuleMemberInventory(
            owner,
            inventoryInput
          );
        expect(inventory).toMatchObject({
          ruleId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          authorityVersion: transferred.authorityVersion,
          publisherFence: transferred.publisherFence,
          entries: [
            {
              logicalMemoryId: existing.logicalMemoryId,
              portableSourceHash: sharingRuleSourceIdentityHash(
                owner.userId,
                reviewInput.sourceIdentity
              ),
              state: "present"
            }
          ],
          nextAfterMembershipId: null
        });
        expect(inventory.entries).toHaveLength(1);
        const membershipId = inventory.entries[0]!.membershipId;
        expect(
          (
            await repository.listRepositorySharingRuleMemberInventory(owner, {
              ...inventoryInput,
              afterMembershipId: membershipId
            })
          ).entries
        ).toEqual([]);
        for (const denied of [
          {
            ...inventoryInput,
            publisherCredentialId: fixture.deviceCredentialId
          },
          {
            ...inventoryInput,
            expectedAuthorityVersion: before.authorityVersion
          },
          { ...inventoryInput, publisherFence: before.publisherFence }
        ])
          await expect(
            repository.listRepositorySharingRuleMemberInventory(owner, denied)
          ).rejects.toThrow();
        await expect(
          repository.listRepositorySharingRuleMemberInventory(
            reader,
            inventoryInput
          )
        ).rejects.toThrow();
        // Missing portable evidence remains visible as unresolved discovery. The
        // inventory must not hide it or manufacture a binding from Team IDs.
        await pool.query(
          "update team_memory_sharing_rule_members set portable_source_hash=null where id=$1",
          [membershipId]
        );
        expect(
          (
            await repository.listRepositorySharingRuleMemberInventory(
              owner,
              inventoryInput
            )
          ).entries
        ).toEqual([{ ...inventory.entries[0]!, portableSourceHash: null }]);
        await pool.query(
          "update team_memory_sharing_rule_members set portable_source_hash=$2 where id=$1",
          [membershipId, inventory.entries[0]!.portableSourceHash]
        );
        if (!paused) {
          // Bound the actual SQL page with inert members. No new consent,
          // source upload or publication is created by catalog discovery.
          const inert = await pool.query<{
            id: string;
            logical_memory_id: string;
          }>(
            `with memories as (
               insert into logical_memories(owner_user_id,owner_principal_id,origin_deployment_identity_id,source_kind,logical_key)
               select memory.owner_user_id,memory.owner_principal_id,memory.origin_deployment_identity_id,memory.source_kind,
                 'inventory:'||$1::text||':'||n::text from logical_memories memory cross join generate_series(1,100) n
               where memory.id=$2 returning id,owner_user_id,owner_principal_id
             ), bindings as (
               insert into captured_session_logical_memories(logical_memory_id,source_session_id,owner_principal_id)
               select id,gen_random_uuid(),owner_principal_id from memories
             ) insert into team_memory_sharing_rule_members(rule_id,owner_user_id,logical_memory_id,state,last_mutation_id,reconciliation_requested_at,next_reconciliation_at)
               select $1::uuid,owner_user_id,id,'removed',gen_random_uuid(),null,null from memories returning id,logical_memory_id`,
            [ruleId, existing.logicalMemoryId]
          );
          const firstPage =
            await repository.listRepositorySharingRuleMemberInventory(
              owner,
              inventoryInput
            );
          expect(firstPage.entries).toHaveLength(100);
          expect(firstPage.nextAfterMembershipId).toBe(
            firstPage.entries.at(-1)!.membershipId
          );
          const lastPage =
            await repository.listRepositorySharingRuleMemberInventory(owner, {
              ...inventoryInput,
              afterMembershipId: firstPage.nextAfterMembershipId!
            });
          expect(lastPage.entries).toHaveLength(1);
          expect(lastPage.nextAfterMembershipId).toBeNull();
          const combined = [...firstPage.entries, ...lastPage.entries];
          expect(
            new Set(combined.map((entry) => entry.membershipId)).size
          ).toBe(101);
          expect(combined.map((entry) => entry.membershipId)).toEqual(
            combined.map((entry) => entry.membershipId).sort()
          );
          expect(
            combined.filter((entry) => entry.portableSourceHash === null)
          ).toHaveLength(100);
          await pool.query(
            "delete from team_memory_sharing_rule_members where id=any($1::uuid[])",
            [inert.rows.map((row) => row.id)]
          );
          await pool.query(
            "delete from logical_memories where id=any($1::uuid[])",
            [inert.rows.map((row) => row.logical_memory_id)]
          );
        }
        await expect(
          repository.createPendingRepositoryRuleMember(owner, {
            ...first.input,
            mutationId: randomUUID()
          })
        ).rejects.toThrow();
        if (paused) await control("resume", ruleId, receivingCredentialId);
        const member = (
          await repository.inspectRepositorySharingRuleMembers(owner, {
            ruleId,
            publisherCredentialId: receivingCredentialId,
            logicalMemoryIds: [existing.logicalMemoryId]
          })
        ).entries[0]!;
        expect(
          await repository.readGrantRepresentation(reader, {
            shareGrantId: member.grant!.id,
            representation: "lcm_leaves"
          })
        ).toMatchObject({ representation: { sourceRevision: 1 } });
        expect(
          await repository.resolveRepositorySharingRuleSource(owner, {
            ruleId,
            publisherCredentialId: receivingCredentialId,
            sourceIdentity: reviewInput.sourceIdentity
          })
        ).toEqual({ logicalMemoryId: existing.logicalMemoryId });
        // Personal/source sync retains its original origin after the rule's publisher changes.
        await seedAuthoritativeSourceRevision(
          fixture,
          existing,
          2,
          "after-publisher-transfer",
          { repositorySnapshot: sharedAnchor }
        );
        await repository.advanceContinuousGrantRepresentations({
          remoteReplicaId: existing.remoteReplicaId,
          sourceRevision: 2
        });
        const publicationAuthority = (
          await pool.query<
            Parameters<
              SharedMemoryRepository["prepareSharingRuleMember"]
            >[1]["ruleAuthority"] & { grantVersion: number }
          >(
            `select rule.id as "ruleId",reason.id as "reasonId",rule.authority_version as "authorityVersion",consent.consent_version as "consentVersion",rule.publisher_credential_id as "publisherCredentialId",rule.publisher_fence::integer as "publisherFence",rule.effective_privacy_policy_hash as "effectivePrivacyPolicyHash",grant_row.grant_version as "grantVersion" from team_memory_sharing_rules rule join team_memory_share_reasons reason on reason.rule_id=rule.id join source_owner_representation_consents consent on consent.id=reason.consent_id join team_memory_share_grants grant_row on grant_row.id=reason.share_grant_id where rule.id=$1 and reason.membership_id=$2`,
            [ruleId, first.membershipId]
          )
        ).rows[0]!;
        const { grantVersion, ...ruleAuthority } = publicationAuthority;
        await expect(
          repository.prepareSharingRuleMember(owner, {
            shareGrantId: member.grant!.id,
            expectedGrantVersion: grantVersion,
            ruleAuthority: {
              ...ruleAuthority,
              authorityVersion: before.authorityVersion,
              publisherFence: before.publisherFence,
              publisherCredentialId: fixture.deviceCredentialId
            }
          })
        ).rejects.toThrow("publisher changed before publication");
        const originalBinding = (
          await pool.query<{ portable_source_hash: string }>(
            "update team_memory_sharing_rule_members set portable_source_hash=null where id=$1 returning (select portable_source_hash from team_memory_sharing_rule_members where id=$1)",
            [first.membershipId]
          )
        ).rows[0]!.portable_source_hash;
        await expect(
          repository.prepareSharingRuleMember(owner, {
            shareGrantId: member.grant!.id,
            expectedGrantVersion: grantVersion,
            ruleAuthority
          })
        ).rejects.toThrow("authorized publisher");
        await pool.query(
          "update team_memory_sharing_rule_members set portable_source_hash=$2,next_reconciliation_at=now() where id=$1",
          [first.membershipId, originalBinding]
        );
        expect(
          await repository.reconcileSharingRuleMembers({ limit: 100 })
        ).toMatchObject({ failed: 0 });
        await flushSanitizedSemanticPublication();
        expect(
          await repository.readGrantRepresentation(reader, {
            shareGrantId: member.grant!.id,
            representation: "lcm_leaves"
          })
        ).toMatchObject({ representation: { sourceRevision: 2 } });
        expect(
          (
            await pool.query(
              "select id,logical_memory_id,consent_id from team_memory_share_grants where logical_memory_id=$1 order by id",
              [existing.logicalMemoryId]
            )
          ).rows
        ).toEqual(rootsBefore.rows);
        await pool.query(
          "update device_credentials set revoked_at=now() where id=$1",
          [fixture.deviceCredentialId]
        );
        await expect(
          repository.prepareSharingRuleMember(owner, {
            shareGrantId: member.grant!.id,
            expectedGrantVersion: grantVersion,
            ruleAuthority
          })
        ).rejects.toThrow("sync relationship");
        // The global worker also observes earlier fixtures: settle this deliberate
        // unavailable-source case so it cannot contaminate another selector case.
        await control("stop", ruleId, receivingCredentialId);
        return;
      }
      if (scenario === "project_retry") {
        expect(retryCodes).toHaveLength(0);
        expect(companionAttempts).toBeGreaterThanOrEqual(3);
        expect(
          await repository.getOwnerShare(owner, {
            kind: "pending",
            id: accepted.pendingShareId
          })
        ).toMatchObject({
          kind: "pending",
          pendingShare: { state: "activated" }
        });
        expect(
          await repository.readGrantRepresentation(reader, {
            shareGrantId: direct.id,
            representation: "lcm_leaves"
          })
        ).toMatchObject({ representation: { sourceRevision: 1 } });
        return;
      }
      if (scenario === "preview_revision") {
        const target = {
          kind: "pending" as const,
          id: accepted.pendingShareId
        };
        expect(
          await repository.readOwnerSharePreview(owner, target)
        ).toMatchObject({ sourceRevision: 1 });
        await seedAuthoritativeSourceRevision(
          fixture,
          existing,
          2,
          "latest-owner-preview",
          {
            repositorySnapshot: sharedAnchor
          }
        );
        await repository.advanceContinuousGrantRepresentations({
          remoteReplicaId: existing.remoteReplicaId,
          sourceRevision: 2
        });
        await pool.query(
          "update team_memory_sharing_rule_members set next_reconciliation_at=now() where id=$1",
          [first.membershipId]
        );
        expect(
          await repository.reconcileSharingRuleMembers({ limit: 100 })
        ).toMatchObject({ failed: 0 });
        await flushSanitizedSemanticPublication();
        expect(
          await repository.readGrantRepresentation(reader, {
            shareGrantId: direct.id,
            representation: "lcm_leaves"
          })
        ).toMatchObject({ representation: { sourceRevision: 2 } });
        expect(
          (await repository.getOwnerShare(owner, target))?.summary
            .authorizedPreview
        ).toMatchObject({ sourceRevision: 2 });
        expect(
          await repository.readOwnerSharePreview(owner, target)
        ).toMatchObject({ sourceRevision: 2 });
        // A separate fixed snapshot still previews only its approved revision.
        const fixed = await createGrant(fixture, {
          label: "fixed-owner-preview",
          mode: "snapshot"
        });
        await materialize(fixture, fixed);
        await seedAuthoritativeSourceRevision(
          fixture,
          fixed,
          2,
          "unshared-later-source"
        );
        expect(
          await repository.readOwnerSharePreview(owner, {
            kind: "grant",
            id: fixed.shareGrantId
          })
        ).toMatchObject({ sourceRevision: 1 });
        await pool.query(
          "update team_workspace_access_grants set disabled_at=now() where user_id=$1 and team_workspace_id=$2",
          [fixture.ownerUserId, fixture.teamWorkspaceId]
        );
        expect(
          await repository.readOwnerSharePreview(owner, target)
        ).toBeNull();
        return;
      }
      if (scenario === "revoked_repository") {
        expect(
          (await inspect(existing, targetRuleId)).entries[0]
        ).toMatchObject({
          grant: { id: direct.id, lifecycle: "active" },
          member: { state: "present" }
        });
        expect(
          await repository.readGrantRepresentation(reader, {
            shareGrantId: direct.id,
            representation: "lcm_leaves"
          })
        ).toMatchObject({ representation: { sourceRevision: 1 } });
        // The old snapshot and its publication remain stopped after root reuse.
        expect(
          (
            await pool.query(
              "select consent_id from team_memory_share_reasons where share_grant_id=$1 and kind='direct'",
              [direct.id]
            )
          ).rows
        ).toEqual([{ consent_id: snapshot.consentId }]);
        expect(
          (
            await pool.query(
              "select state,revoked_at is not null as revoked from source_owner_representation_consents where id=$1",
              [snapshot.consentId]
            )
          ).rows[0]
        ).toMatchObject({ state: "revoked", revoked: true });
        expect(
          (
            await pool.query(
              "select state,invalidated_at is not null as invalidated from team_memory_representations where share_grant_id=$1 and consent_id=$2",
              [direct.id, snapshot.consentId]
            )
          ).rows
        ).toEqual([
          expect.objectContaining({ state: "invalidated", invalidated: true })
        ]);
        const rollup = await repository.readGrantRepresentation(reader, {
          shareGrantId: direct.id,
          representation: "lcm_rollups"
        });
        expect(rollup?.grant.consentId).toBe(first.input.consentId);
        expect(
          (
            await pool.query(
              "select state from purge_jobs where share_grant_id=$1",
              [direct.id]
            )
          ).rows
        ).toEqual([expect.objectContaining({ state: "canceled" })]);
        return;
      }
      const ownerExplanation = await repository.getOwnerShare(owner, {
        kind: "pending",
        id: accepted.pendingShareId
      });
      expect(
        ownerExplanation?.kind === "pending" &&
          ownerExplanation.pendingShare.grantId
      ).toBe(direct.id);
      expect(
        ownerExplanation?.summary.sharingReasons.find(
          (reason) => reason.kind === "rule"
        )?.rule?.selectorKind
      ).toBe(selectionKind);
      expect((await inspect(existing)).entries[0]!.grant?.id).toBe(direct.id);
      expect(
        await repository.readGrantRepresentation(reader, {
          shareGrantId: direct.id,
          representation: "lcm_leaves"
        })
      ).toMatchObject({ representation: { sourceRevision: 1 } });
      const independentRuleIds: string[] = [];
      if (selectionKind === "project") {
        for (const selector of [
          {
            kind: "portable_repository" as const,
            key: "gr_independent_git_reason"
          },
          { kind: "folder" as const, key: hash("independent-folder-reason") },
          {
            kind: "project" as const,
            key: hash("other-private-project-reason")
          }
        ]) {
          const independentId = randomUUID();
          await createRule(independentId, selector);
          const source = await admission(existing, independentId);
          const accepted = await repository.createPendingRepositoryRuleMember(
            owner,
            source.input
          );
          expect(await publishMember(accepted.pendingShareId)).toMatchObject({
            activated: 1,
            failed: 0
          });
          expect(await control("pause", independentId)).toMatchObject({
            state: "paused"
          });
          independentRuleIds.push(independentId);
        }
      }
      expect(await control("pause")).toMatchObject({ state: "paused" });
      await seedAuthoritativeSourceRevision(
        fixture,
        existing,
        2,
        "git-existing-later-summary",
        {
          repositorySnapshot:
            selectionKind === "project"
              ? unresolvedTeamRepositorySnapshot()
              : sharedAnchor
        }
      );
      expect(
        await repository.advanceContinuousGrantRepresentations({
          remoteReplicaId: existing.remoteReplicaId,
          sourceRevision: 2
        })
      ).toMatchObject({ advanced: 0 });
      const later = await createConsent(fixture, existing, {
        representation: "lcm_rollups",
        representations: ["lcm_rollups"],
        mode: "snapshot",
        sourceRevision: 2,
        label: "git-existing-later-summary"
      });
      const laterGrant = await repository.selectGrantFidelity(owner, {
        mutationId: randomUUID(),
        shareGrantId: direct.id,
        expectedGrantVersion: (await inspect(existing)).entries[0]!.grant!
          .version,
        consentId: later.consentId,
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: false,
        authority: authority(fixture)
      });
      await prepareSanitizedSemanticPreview(fixture.ownerUserId, later.preview);
      await repository.materializeGrantRepresentation(owner, {
        mutationId: randomUUID(),
        shareGrantId: laterGrant.id,
        consentId: later.consentId,
        expectedGrantVersion: laterGrant.grantVersion,
        preview: later.preview
      });
      expect(
        await repository.readGrantRepresentation(reader, {
          shareGrantId: direct.id,
          representation: "lcm_leaves"
        })
      ).toMatchObject({ representation: { sourceRevision: 1 } });
      expect(
        await repository.readGrantRepresentation(reader, {
          shareGrantId: direct.id,
          representation: "lcm_rollups"
        })
      ).toMatchObject({ representation: { sourceRevision: 2 } });

      const selectedDetail = await repository.readGrantRepresentation(reader, {
        shareGrantId: direct.id,
        representation: "lcm_leaves"
      });
      // Competing publications rank higher deliberately. Recall must still
      // retain the exact currently selected record rather than mask it during
      // source deduplication; this must not depend on random candidate UUIDs.
      const pausedCandidates = await indexAndRecall(
        selectionKind === "project"
          ? selectedDetail!.representation.id
          : undefined
      );
      const pausedLeaf = pausedCandidates.find(
        (item) =>
          item.shareGrantId === direct.id &&
          item.representation === "lcm_leaves"
      );
      expect(pausedLeaf).toBeDefined();
      expect(
        (
          await repository.expandAuthorizedSharedMemorySemanticItem(reader, {
            teamWorkspaceId: fixture.teamWorkspaceId,
            candidateId: pausedLeaf!.candidateId,
            searchDomain: query.searchDomain,
            projectId: query.projectId
          })
        )?.items.length
      ).toBeGreaterThan(0);
      const independentState = async () =>
        (
          await pool.query<{
            id: string;
            authority_version: number;
            state: string;
            consent_id: string;
            consent_version: number;
            maximum_fidelity: string;
            consent_state: string;
          }>(
            `select rule.id,rule.authority_version,rule.state,c.id consent_id,c.consent_version,c.maximum_fidelity,c.state consent_state
        from team_memory_sharing_rules rule join team_memory_share_reasons reason on reason.rule_id=rule.id
        join source_owner_representation_consents c on c.id=reason.consent_id
        where rule.id=any($1::uuid[]) order by rule.id,c.id`,
            [independentRuleIds]
          )
        ).rows;
      const retainedIndependent = await independentState();
      expect(await amendDetail("lcm_rollups")).toMatchObject({
        state: "paused",
        maximumFidelity: "lcm_rollups"
      });
      const reducedState = await inspect(existing);
      expect(reducedState.detailAmendment?.result.maximumFidelity).toBe(
        "lcm_rollups"
      );
      expect(await independentState()).toEqual(retainedIndependent);
      const reducedDetail = await repository.readGrantRepresentation(reader, {
        shareGrantId: direct.id,
        representation: "lcm_leaves"
      });
      if (selectionKind === "project") {
        expect(reducedDetail).toMatchObject({
          representation: { sourceRevision: 1 }
        });
      } else {
        expect(reducedDetail).toBeNull();
        expect(
          await repository.expandAuthorizedSharedMemorySemanticItem(reader, {
            teamWorkspaceId: fixture.teamWorkspaceId,
            candidateId: pausedLeaf!.candidateId,
            searchDomain: query.searchDomain,
            projectId: query.projectId
          })
        ).toBeNull();
        expect(
          (await indexAndRecall()).some(
            (item) =>
              item.shareGrantId === direct.id &&
              item.representation === "lcm_leaves"
          )
        ).toBe(false);
      }
      expect(
        await repository.readGrantRepresentation(reader, {
          shareGrantId: direct.id,
          representation: "lcm_rollups"
        })
      ).toMatchObject({ representation: { sourceRevision: 2 } });
      expect(await amendDetail("lcm_leaves")).toMatchObject({
        state: "paused",
        maximumFidelity: "lcm_leaves"
      });
      expect(await independentState()).toEqual(retainedIndependent);
      // An increase restores only the exact older detailed publication. The newer
      // summary cannot lend this paused reason authority for detailed revision 2.
      expect(
        await repository.readGrantRepresentation(reader, {
          shareGrantId: direct.id,
          representation: "lcm_leaves"
        })
      ).toMatchObject({ representation: { sourceRevision: 1 } });
      expect(
        await repository.readGrantRepresentation(reader, {
          shareGrantId: direct.id,
          representation: "lcm_rollups"
        })
      ).toMatchObject({ representation: { sourceRevision: 2 } });

      const known = await inspect(existing);
      expect(
        await repository.removeSharingRuleMember(owner, {
          ruleId,
          membershipId: first.membershipId,
          mutationId: randomUUID(),
          publisherCredentialId: fixture.deviceCredentialId,
          expectedAuthorityVersion: known.authorityVersion,
          expectedMembershipVersion: known.entries[0]!.member!.version,
          publisherFence: known.publisherFence,
          selectionSnapshotVersion: randomUUID(),
          sourceContextHash: hash("git-corrected-no-longer-matching")
        })
      ).toMatchObject({ state: "removed" });
      const remainingDetail = await repository.readGrantRepresentation(reader, {
        shareGrantId: direct.id,
        representation: "lcm_leaves"
      });
      if (selectionKind === "project") {
        expect(remainingDetail).toMatchObject({
          representation: { sourceRevision: 1 }
        });
        expect(
          (
            await repository.expandAuthorizedSharedMemorySemanticItem(reader, {
              teamWorkspaceId: fixture.teamWorkspaceId,
              candidateId: pausedLeaf!.candidateId,
              searchDomain: query.searchDomain,
              projectId: query.projectId
            })
          )?.items.length
        ).toBeGreaterThan(0);
        for (const id of independentRuleIds)
          expect(await control("stop", id)).toMatchObject({ state: "stopped" });
        expect(
          await repository.reconcileSharingRuleMembers({ limit: 100 })
        ).toMatchObject({ failed: 0 });
        expect(
          await repository.readGrantRepresentation(reader, {
            shareGrantId: direct.id,
            representation: "lcm_leaves"
          })
        ).toBeNull();
      } else expect(remainingDetail).toBeNull();
      expect(
        await repository.readGrantRepresentation(reader, {
          shareGrantId: direct.id,
          representation: "lcm_rollups"
        })
      ).toMatchObject({ representation: { sourceRevision: 2 } });
      expect(
        await repository.expandAuthorizedSharedMemorySemanticItem(reader, {
          teamWorkspaceId: fixture.teamWorkspaceId,
          candidateId: pausedLeaf!.candidateId,
          searchDomain: query.searchDomain,
          projectId: query.projectId
        })
      ).toBeNull();
      expect(await control("resume")).toMatchObject({ state: "active" });
      expect(await control("retry")).toMatchObject({ state: "active" });
      const future = await createSource(fixture, 1, "git-future", {
        repositorySnapshot:
          selectionKind === "project"
            ? unresolvedTeamRepositorySnapshot()
            : sharedAnchor
      });
      await putOwnerPolicy(fixture, future, [...representations]);
      const second = await admission(future);
      if (scenario === "portable_source") {
        await expect(
          repository.createPendingRepositoryRuleMember(owner, {
            ...second.input,
            mutationId: randomUUID(),
            membership: {
              ...second.input.membership,
              sourceIdentity: first.input.membership.sourceIdentity
            }
          })
        ).rejects.toThrow("already identifies another rule member");
        expect((await inspect(future)).entries[0]!.member).toBeNull();
      }
      const futurePending = await repository.createPendingRepositoryRuleMember(
        owner,
        second.input
      );
      // Initialize the member and queue its original detail, then amend before
      // Privacy finishes. The pending creation evidence remains immutable.
      expect(
        await repository.processPendingShares({
          ensureCompanion: ensurePendingShareCompanion
        })
      ).toMatchObject({ claimed: 1, failed: 0 });
      const futureState = await inspect(future),
        futureGrantId = futureState.entries[0]!.grant!.id;
      const oldTargets = await repository.listPendingSemanticPrivacyTargets({
        shareGrantId: futureGrantId,
        limit: 100
      });
      expect(
        oldTargets.some((target) => target.representation === "lcm_leaves")
      ).toBe(true);
      expect(await amendDetail("lcm_rollups")).toMatchObject({
        state: "active"
      });
      for (const target of oldTargets.filter(
        (item) => item.representation === "lcm_leaves"
      )) {
        expect(
          await repository.claimSemanticPrivacyTarget(owner, {
            semanticPreviewId: target.id,
            claimantId: "stale-detail-worker",
            leaseMs: 120_000,
            expectedWorkIdentity:
              sharedMemorySemanticPrivacyWorkIdentity(target)
          })
        ).toBeNull();
      }
      expect(
        await repository.reconcileSharingRuleMembers({ limit: 100 })
      ).toMatchObject({ failed: 0 });
      await flushSanitizedSemanticPublication();
      await pool.query(
        "update pending_share_outbox set available_at=now() where pending_share_id=$1 and state='pending'",
        [futurePending.pendingShareId]
      );
      expect(
        await repository.processPendingShares({
          ensureCompanion: ensurePendingShareCompanion
        })
      ).toMatchObject({ activated: 1, failed: 0 });
      expect(
        await repository.readGrantRepresentation(reader, {
          shareGrantId: futureGrantId,
          representation: "lcm_leaves"
        })
      ).toBeNull();
      expect(
        await repository.readGrantRepresentation(reader, {
          shareGrantId: futureGrantId,
          representation: "lcm_rollups"
        })
      ).toMatchObject({ representation: { sourceRevision: 1 } });
      expect(await amendDetail("lcm_leaves")).toMatchObject({
        state: "active"
      });
      expect(
        await repository.reconcileSharingRuleMembers({ limit: 100 })
      ).toMatchObject({ failed: 0 });
      await flushSanitizedSemanticPublication();
      expect(
        await repository.readGrantRepresentation(reader, {
          shareGrantId: futureGrantId,
          representation: "lcm_leaves"
        })
      ).toMatchObject({ representation: { sourceRevision: 1 } });
      const beforeContext = await inspect(future);
      const contextRefresh = {
        ruleId,
        membershipId: second.membershipId,
        publisherCredentialId: fixture.deviceCredentialId,
        mutationId: randomUUID(),
        selectionSnapshotVersion: randomUUID(),
        sourceContextHash: hash(`corrected-${selectionKind}-context`),
        selectorBindingHash: beforeContext.selectorBindingHash,
        gitContextVersion: selectionKind === "repository" ? 2 : 1,
        folderContextVersion: selectionKind === "folder" ? 2 : 1,
        expectedAuthorityVersion: beforeContext.authorityVersion,
        expectedMembershipVersion: beforeContext.entries[0]!.member!.version,
        publisherFence: beforeContext.publisherFence
      };
      const contextReceipt =
        await repository.refreshRepositorySharingRuleMemberContext(
          owner,
          contextRefresh
        );
      expect(contextReceipt.membershipVersion).toBe(
        contextRefresh.expectedMembershipVersion + 1
      );
      expect(
        await repository.refreshRepositorySharingRuleMemberContext(
          owner,
          contextRefresh
        )
      ).toEqual(contextReceipt);
      expect((await inspect(future)).entries[0]!.member).toMatchObject({
        gitContextVersion: contextRefresh.gitContextVersion,
        folderContextVersion: contextRefresh.folderContextVersion
      });
      await expect(
        repository.createPendingRepositoryRuleMember(
          actor(fixture.readerUserId),
          second.input
        )
      ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);

      const recalled = await indexAndRecall();
      expect(new Set(recalled.map((item) => item.shareGrantId))).toEqual(
        new Set([direct.id, futureGrantId])
      );
      const futureLeaf = recalled.find(
        (item) =>
          item.shareGrantId === futureGrantId &&
          item.representation === "lcm_leaves"
      );
      expect(futureLeaf).toBeDefined();
      expect(
        (
          await repository.expandAuthorizedSharedMemorySemanticItem(reader, {
            teamWorkspaceId: fixture.teamWorkspaceId,
            candidateId: futureLeaf!.candidateId,
            searchDomain: query.searchDomain,
            projectId: query.projectId
          })
        )?.items.length
      ).toBeGreaterThan(0);
      expect(
        await repository.searchAuthorizedSharedMemorySemanticItems(
          actor(fixture.outsiderUserId),
          query
        )
      ).toEqual([]);

      if (scenario === "project_excluded") {
        // Overlapping independent selectors must all obey the same source veto.
        for (const selector of [
          { kind: "folder" as const, key: hash("overlapping-folder") },
          {
            kind: "portable_repository" as const,
            key: "github.com/example/overlapping"
          }
        ]) {
          const overlappingRuleId = randomUUID();
          await createRule(overlappingRuleId, selector);
          const overlapping = await admission(existing, overlappingRuleId);
          const acceptedOverlap =
            await repository.createPendingRepositoryRuleMember(
              owner,
              overlapping.input
            );
          expect(
            (await publishMember(acceptedOverlap.pendingShareId)).activated
          ).toBe(1);
        }
        expect(
          (await indexAndRecall()).some(
            (item) => item.shareGrantId === direct.id
          )
        ).toBe(true);
        // Finish sanitizing a later LCM revision, but leave publication queued
        // while the owner excludes this source from the Workspace.
        await seedAuthoritativeSourceRevision(
          fixture,
          future,
          2,
          "project-lcm-queued-before-exclusion",
          { repositorySnapshot: unresolvedTeamRepositorySnapshot() }
        );
        await pool.query(
          "update team_memory_sharing_rule_members set next_reconciliation_at=now() where id=$1",
          [second.membershipId]
        );
        expect(
          await repository.reconcileSharingRuleMembers({ limit: 100 })
        ).toMatchObject({ failed: 0 });
        const queuedLcm = await repository.listPendingSemanticPrivacyTargets({
          shareGrantId: futureGrantId,
          limit: 100
        });
        expect(
          queuedLcm.some(
            (target) =>
              target.sourceRevision === 2 &&
              target.representation === "lcm_leaves"
          )
        ).toBe(true);
        for (const target of queuedLcm)
          await prepareSanitizedSemanticPreview(fixture.ownerUserId, {
            previewId: target.sourcePreviewId
          });
        const exclusionReview =
          await repository.getWorkspaceConversationExclusionReview(owner, {
            logicalMemoryId: future.logicalMemoryId,
            teamId: fixture.teamId,
            teamWorkspaceId: fixture.teamWorkspaceId
          });
        await repository.excludeWorkspaceConversation(owner, {
          mutationId: randomUUID(),
          scope: exclusionReview!.scope,
          authority: authority(fixture)
        });
        expect((await inspect(future)).entries[0]!.workspaceExcluded).toBe(
          true
        );
        await repository.reconcileReadySemanticRepresentations({ limit: 100 });
        expect(
          (
            await pool.query(
              `select 1 from team_memory_reason_publications p
               join team_memory_representations r on r.id=p.representation_id
               where r.share_grant_id=$1 and r.source_revision=2`,
              [futureGrantId]
            )
          ).rowCount
        ).toBe(0);
        expect(
          await repository.readGrantRepresentation(reader, {
            shareGrantId: futureGrantId,
            representation: "lcm_leaves"
          })
        ).toBeNull();
        expect(
          await repository.expandAuthorizedSharedMemorySemanticItem(reader, {
            teamWorkspaceId: fixture.teamWorkspaceId,
            candidateId: futureLeaf!.candidateId,
            searchDomain: query.searchDomain,
            projectId: query.projectId
          })
        ).toBeNull();
        const remaining =
          await repository.searchAuthorizedSharedMemorySemanticItems(
            reader,
            query
          );
        expect(
          remaining.some((item) => item.shareGrantId === futureGrantId)
        ).toBe(false);
        expect(remaining.some((item) => item.shareGrantId === direct.id)).toBe(
          true
        );
        await expect(admission(future)).rejects.toThrow("excluded");
        const directReview =
          await repository.getWorkspaceConversationExclusionReview(owner, {
            logicalMemoryId: existing.logicalMemoryId,
            teamId: fixture.teamId,
            teamWorkspaceId: fixture.teamWorkspaceId
          });
        await repository.excludeWorkspaceConversation(owner, {
          mutationId: randomUUID(),
          scope: directReview!.scope,
          authority: authority(fixture)
        });
        expect(
          await repository.searchAuthorizedSharedMemorySemanticItems(
            reader,
            query
          )
        ).toEqual([]);
        expect(
          await repository.readGrantRepresentation(reader, {
            shareGrantId: direct.id,
            representation: "lcm_rollups"
          })
        ).toBeNull();
        const knownFuture = await inspect(future);
        await repository.removeSharingRuleMember(owner, {
          ruleId,
          membershipId: second.membershipId,
          mutationId: randomUUID(),
          publisherCredentialId: fixture.deviceCredentialId,
          expectedAuthorityVersion: knownFuture.authorityVersion,
          expectedMembershipVersion: knownFuture.entries[0]!.member!.version,
          publisherFence: knownFuture.publisherFence,
          selectionSnapshotVersion: randomUUID(),
          sourceContextHash: hash("removed-while-excluded")
        });
        const futureRestore =
          await repository.getWorkspaceConversationRestorationReview(owner, {
            logicalMemoryId: future.logicalMemoryId,
            teamId: fixture.teamId,
            teamWorkspaceId: fixture.teamWorkspaceId
          });
        expect(futureRestore!.rules.some((rule) => rule.eligible)).toBe(false);
        await executeWorkspaceRestoration(fixture, {
          mutationId: randomUUID(),
          scope: futureRestore!.scope,
          restoration: futureRestore!,
          authority: authority(fixture)
        });
        expect(
          await repository.readGrantRepresentation(reader, {
            shareGrantId: futureGrantId,
            representation: "lcm_leaves"
          })
        ).toBeNull();
        const existingRestore =
          await repository.getWorkspaceConversationRestorationReview(owner, {
            logicalMemoryId: existing.logicalMemoryId,
            teamId: fixture.teamId,
            teamWorkspaceId: fixture.teamWorkspaceId
          });
        expect(
          existingRestore!.rules.filter((rule) => rule.eligible)
        ).toHaveLength(2);
        await executeWorkspaceRestoration(fixture, {
          mutationId: randomUUID(),
          scope: existingRestore!.scope,
          restoration: existingRestore!,
          authority: authority(fixture)
        });
        expect(
          (await repository.reconcileSharingRuleMembers({ limit: 100 })).failed
        ).toBe(0);
        await flushSanitizedSemanticPublication();
        expect(
          await repository.readGrantRepresentation(reader, {
            shareGrantId: futureGrantId,
            representation: "lcm_leaves"
          })
        ).toBeNull();
        expect(
          await repository.readGrantRepresentation(reader, {
            shareGrantId: direct.id,
            representation: "lcm_leaves"
          })
        ).not.toBeNull();
        const restoredPending = await pool.query<{
          state: string;
          redacted_failure_code: string | null;
        }>(
          "select state,redacted_failure_code from pending_share_operations where logical_memory_id=$1 and activated_at is not null and redacted_failure_code='workspace_restoring'",
          [existing.logicalMemoryId]
        );
        expect(restoredPending.rows).toEqual([]);
        return;
      }

      // A retained cancellation prevents an original admission arriving late.
      const notYet = await createSource(fixture, 1, "git-canceled", {
        repositorySnapshot:
          selectionKind === "project"
            ? unresolvedTeamRepositorySnapshot()
            : sharedAnchor
      });
      await putOwnerPolicy(fixture, notYet, [...representations]);
      const canceled = await admission(notYet),
        versionBeforeCancel = (await inspect(notYet)).authorityVersion;
      expect(
        await repository.cancelRepositorySharingRuleMutation(
          owner,
          canceled.cancellation
        )
      ).toMatchObject({ state: "canceled" });
      await expect(
        repository.createPendingRepositoryRuleMember(owner, canceled.input)
      ).rejects.toBeInstanceOf(SharedMemoryConflictError);
      expect((await inspect(notYet)).authorityVersion).toBe(
        versionBeforeCancel
      );
      expect((await inspect(notYet)).entries[0]!.member).toBeNull();

      await seedAuthoritativeSourceRevision(
        fixture,
        future,
        2,
        "git-future-queued-before-stop",
        {
          repositorySnapshot:
            selectionKind === "project"
              ? unresolvedTeamRepositorySnapshot()
              : sharedAnchor
        }
      );
      await pool.query(
        "update team_memory_sharing_rule_members set next_reconciliation_at=now() where id=$1",
        [second.membershipId]
      );
      expect(
        await repository.reconcileSharingRuleMembers({ limit: 100 })
      ).toMatchObject({ failed: 0 });
      const prepared = await repository.listPendingSemanticPrivacyTargets({
        shareGrantId: futureGrantId,
        limit: 100
      });
      expect(prepared.length).toBeGreaterThan(0);
      for (const target of prepared)
        await prepareSanitizedSemanticPreview(fixture.ownerUserId, {
          previewId: target.sourcePreviewId
        });
      const personalBefore = await pool.query(
        "select event.id,row_to_json(event)::text as retained from memory_events event where event.session_id=$1 order by event.id",
        [future.localSessionId]
      );
      expect(await control("stop")).toMatchObject({ state: "stopped" });
      expect(
        await repository.readGrantRepresentation(reader, {
          shareGrantId: futureGrantId,
          representation: "lcm_leaves"
        })
      ).toBeNull();
      expect(
        await repository.expandAuthorizedSharedMemorySemanticItem(reader, {
          teamWorkspaceId: fixture.teamWorkspaceId,
          candidateId: futureLeaf!.candidateId,
          searchDomain: query.searchDomain,
          projectId: query.projectId
        })
      ).toBeNull();
      await repository.reconcileReadySemanticRepresentations({ limit: 100 });
      expect(
        (
          await pool.query(
            "select 1 from team_memory_reason_publications p join team_memory_representations r on r.id=p.representation_id where p.reason_id in (select id from team_memory_share_reasons where membership_id=$1) and r.source_revision=2",
            [second.membershipId]
          )
        ).rowCount
      ).toBe(0);
      expect(
        await repository.reconcileSharingRuleMembers({ limit: 100 })
      ).toMatchObject({ failed: 0 });
      expect(
        (
          await pool.query<{ state: string }>(
            "select state from source_owner_representation_consents where id=$1",
            [second.wire.consentId]
          )
        ).rows[0]!.state
      ).toBe("revoked");
      expect(
        await repository.readGrantRepresentation(reader, {
          shareGrantId: direct.id,
          representation: "lcm_rollups"
        })
      ).toMatchObject({ representation: { sourceRevision: 2 } });
      expect(
        (
          await pool.query(
            "select event.id,row_to_json(event)::text as retained from memory_events event where event.session_id=$1 order by event.id",
            [future.localSessionId]
          )
        ).rows
      ).toEqual(personalBefore.rows);

      // Empty rules still support negative owner controls after publisher expiry.
      const emptyRuleId = randomUUID();
      await createRule(emptyRuleId);
      const originalCredential = (
        await pool.query<{ upstream_backend_id: string }>(
          "select upstream_backend_id from device_credentials where id=$1",
          [fixture.deviceCredentialId]
        )
      ).rows[0]!;
      const controller = (
        await pool.query<{ id: string }>(
          `insert into device_credentials(owner_user_id,credential_key_id,upstream_backend_id,device_instance_id,verifier_kind,verifier_hash,operation_families)
      values($1,$2,$3,$4,'secret_hash',$5,ARRAY['share_grant_management']::text[]) returning id`,
          [
            fixture.ownerUserId,
            randomUUID(),
            originalCredential.upstream_backend_id,
            randomUUID(),
            hash("git-owner-controller")
          ]
        )
      ).rows[0]!.id;
      await pool.query(
        "update device_credentials set expires_at=now()-interval '1 second',device_label='Synthetic original publisher' where id=$1",
        [fixture.deviceCredentialId]
      );
      const owned = await repository.listOwnedRepositorySharingRules(owner, {
        selector: ruleReview!.scope.selector,
        afterRuleId: null,
        limit: 100
      });
      expect(owned.rules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: emptyRuleId,
            publisherAvailable: false,
            state: "active"
          })
        ])
      );
      expect(
        owned.rules.find((rule) => rule.ruleId === emptyRuleId)?.publisher
      ).toMatchObject({
        credentialId: fixture.deviceCredentialId,
        label: "Synthetic original publisher",
        available: false
      });
      expect(
        await repository.listOwnedRepositorySharingRules(reader, {
          selector: ruleReview!.scope.selector,
          afterRuleId: null,
          limit: 100
        })
      ).toEqual({ rules: [], nextCursor: null });
      expect(await control("pause", emptyRuleId, controller)).toMatchObject({
        state: "paused"
      });
      const empty = (
        await pool.query<{
          authority_version: number;
          publisher_fence: number;
        }>(
          "select authority_version,publisher_fence::integer as publisher_fence from team_memory_sharing_rules where id=$1",
          [emptyRuleId]
        )
      ).rows[0]!;
      expect(
        await repository.getRepositorySharingRuleControlReview(owner, {
          ruleId: emptyRuleId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          expectedAuthorityVersion: empty.authority_version,
          publisherFence: empty.publisher_fence,
          controlAction: "resume"
        })
      ).toBeNull();
      expect(await control("stop", emptyRuleId, controller)).toMatchObject({
        state: "stopped"
      });
    }
  );

  it.each([false, true, "conversion", "portable_identity"] as const)(
    "publishes a reviewed pending Conversation rule while preserving or explicitly converting a snapshot: %s",
    async (overlap) => {
      const converting = overlap === "conversion";
      const portable = overlap === "portable_identity";
      const nativeCreation = converting || portable;
      const fixture = await createWorkspaceFixture();
      const direct =
        overlap && !portable
          ? await createGrant(fixture, {
              mode: "snapshot",
              representation: "lcm_rollups",
              ownerAllowed: ["lcm_rollups"],
              label: "pending-rule-overlap"
            })
          : null;
      if (direct) await materialize(fixture, direct);
      const source =
        direct ?? (await createSource(fixture, 1, "pending-rule-new"));
      if (!direct) await putOwnerPolicy(fixture, source, ["lcm_rollups"]);
      const shareAuthority = authority(fixture);
      let independentRuleId: string | null = null;
      let unrelated: { fixture: WorkspaceFixture; grant: GrantFixture } | null =
        null;
      if (converting) {
        const independent = await createConsent(fixture, source, {
          representation: "lcm_rollups",
          representations: ["lcm_rollups"],
          mode: "continuous",
          label: "conversion-independent"
        });
        const root = (
          await pool.query<{ logical_grant_id: string; grant_version: number }>(
            "select logical_grant_id,grant_version from team_memory_share_grants where id=$1",
            [direct!.shareGrantId]
          )
        ).rows[0]!;
        const privacyHash = (
          await pool.query<{ effective_privacy_policy_hash: string }>(
            "select effective_privacy_policy_hash from team_memory_representations where share_grant_id=$1 and consent_id=$2 limit 1",
            [direct!.shareGrantId, direct!.consentId]
          )
        ).rows[0]!.effective_privacy_policy_hash;
        const other = await repository.createConversationSharingRule(
          actor(fixture.ownerUserId),
          {
            ruleId: randomUUID(),
            mutationId: randomUUID(),
            logicalGrantId: root.logical_grant_id,
            consentId: independent.consentId,
            expectedConsentVersion: independent.consent.consentVersion,
            expectedGrantVersion: root.grant_version,
            publisherCredentialId: fixture.deviceCredentialId,
            effectivePrivacyPolicyHash: privacyHash,
            authority: shareAuthority
          }
        );
        independentRuleId = other.ruleId;
        const currentVersion = async () =>
          (
            await pool.query<{ grant_version: number }>(
              "select grant_version from team_memory_share_grants where id=$1",
              [direct!.shareGrantId]
            )
          ).rows[0]!.grant_version;
        await repository.prepareSharingRuleMember(actor(fixture.ownerUserId), {
          shareGrantId: direct!.shareGrantId,
          expectedGrantVersion: await currentVersion(),
          ruleAuthority: {
            ruleId: other.ruleId,
            reasonId: other.reasonId,
            authorityVersion: other.authorityVersion,
            consentVersion: independent.consent.consentVersion,
            publisherCredentialId: fixture.deviceCredentialId,
            publisherFence: other.publisherFence,
            effectivePrivacyPolicyHash: privacyHash
          }
        });
        await flushSanitizedSemanticPublication();
        await repository.controlConversationSharingRule(
          actor(fixture.ownerUserId),
          {
            ruleId: other.ruleId,
            reasonId: other.reasonId,
            shareGrantId: direct!.shareGrantId,
            mutationId: randomUUID(),
            expectedAuthorityVersion: other.authorityVersion,
            expectedGrantVersion: await currentVersion(),
            action: "pause",
            authority: shareAuthority
          }
        );
        const otherFixture = await createWorkspaceFixture();
        const otherGrant = await createGrant(otherFixture, {
          mode: "snapshot",
          representation: "lcm_rollups",
          ownerAllowed: ["lcm_rollups"],
          label: "conversion-unrelated-workspace"
        });
        await materialize(otherFixture, otherGrant);
        unrelated = { fixture: otherFixture, grant: otherGrant };
      }
      const candidateInput = {
        ...capturedSourceBinding(source, "lcm_rollups"),
        logicalMemoryId: source.logicalMemoryId,
        candidateHash: hash("pending-rule-review"),
        sourceRevision: source.currentRevision,
        itemCount: 1,
        excludedItemCount: 0,
        manifest: candidateManifest(source, "lcm_rollups"),
        byteCount: 128,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        ...fidelityConsent(["lcm_rollups"]),
        mode: "continuous" as const
      };
      const candidate = nativeCreation
        ? await executeNativeRuleOperation(
            fixture,
            (referenceId) =>
              sharedMemoryCandidatePreviewActionGrantBinding({
                ...candidateInput,
                referenceId
              }),
            (scoped, approved) =>
              scoped.createSharedMemoryCandidatePreview(
                actor(fixture.ownerUserId),
                { ...candidateInput, authority: approved }
              ),
            "direct"
          )
        : await repository.createSharedMemoryCandidatePreview(
            actor(fixture.ownerUserId),
            { ...candidateInput, authority: shareAuthority }
          );
      expect(candidate).not.toBeNull();
      const snapshotReason = converting
        ? (
            await pool.query<{ id: string }>(
              "select id from team_memory_share_reasons where share_grant_id=$1 and consent_id=$2 and kind='direct'",
              [direct!.shareGrantId, direct!.consentId]
            )
          ).rows[0]!.id
        : null;
      const review = await repository.getConversationSharingRuleCreationReview(
        actor(fixture.ownerUserId),
        {
          ...(snapshotReason ? { snapshotReasonId: snapshotReason } : {}),
          previewId: candidate!.previewId,
          previewHash: candidate!.previewHash,
          previewRevision: candidate!.previewRevision,
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId
        }
      );
      expect(review).not.toBeNull();
      const ruleId = randomUUID();
      const input = {
        mutationId: randomUUID(),
        logicalGrantId: review!.logicalGrantId,
        consentId: randomUUID(),
        ...capturedSourceBinding(source, "lcm_rollups"),
        logicalMemoryId: source.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        preview: candidate!,
        previewRevision: candidate!.previewRevision,
        mode: "continuous" as const,
        ...fidelityConsent(["lcm_rollups"]),
        authority: shareAuthority,
        ruleCreation: {
          ...(portable
            ? {
                sourceIdentity: {
                  originatingDeploymentId: "conversation-private-origin",
                  originatingDeviceId: "conversation-private-device",
                  logicalSessionId: source.sessionId
                }
              }
            : {}),
          ruleId,
          ...(review!.snapshotConversion
            ? { snapshotConversion: review!.snapshotConversion }
            : {}),
          publisherCredentialId: fixture.deviceCredentialId,
          expectedGrantVersion: review!.expectedGrantVersion,
          effectivePrivacyPolicyHash: review!.effectivePrivacyPolicyHash
        }
      };
      if (converting) {
        expect(review!.snapshotConversion).toMatchObject({
          reasonId: snapshotReason,
          consentId: direct!.consentId,
          sourceRevision: 1
        });
        await expect(
          repository.createPendingConversationSharingRule(
            actor(fixture.ownerUserId),
            {
              ...input,
              mutationId: randomUUID(),
              ruleCreation: {
                ...input.ruleCreation,
                snapshotConversion: {
                  ...review!.snapshotConversion!,
                  consentVersion: review!.snapshotConversion!.consentVersion + 1
                }
              }
            }
          )
        ).rejects.toBeInstanceOf(SharedMemoryConflictError);
        expect(
          (
            await pool.query<{ state: string }>(
              "select state from source_owner_representation_consents where id=$1",
              [direct!.consentId]
            )
          ).rows[0]
        ).toEqual({ state: "active" });
        expect(
          (
            await pool.query(
              "select id from team_memory_sharing_rules where id=$1",
              [ruleId]
            )
          ).rowCount
        ).toBe(0);
      }
      const pending = nativeCreation
        ? await executeNativeRuleOperation(
            fixture,
            (referenceId) =>
              sharedMemoryConversationRuleCreationActionGrantBinding({
                ...input,
                sourceIdentity: input.ruleCreation.sourceIdentity,
                snapshotConversion: review!.snapshotConversion,
                ruleId,
                previewId: candidate!.previewId,
                previewHash: candidate!.previewHash,
                expectedGrantVersion: review!.expectedGrantVersion,
                effectivePrivacyPolicyHash: review!.effectivePrivacyPolicyHash,
                referenceId
              }),
            (scoped, approved) => {
              input.authority = approved;
              return scoped.createPendingConversationSharingRule(
                actor(fixture.ownerUserId),
                { ...input, authority: approved }
              );
            }
          )
        : await repository.createPendingConversationSharingRule(
            actor(fixture.ownerUserId),
            input
          );
      expect(
        await repository.createPendingConversationSharingRule(
          actor(fixture.ownerUserId),
          input
        )
      ).toMatchObject({ id: pending.id });
      if (portable) {
        const saved = (
          await pool.query<{ portable_source_hash: string; record: unknown }>(
            "select portable_source_hash,to_jsonb(admission) as record from pending_sharing_rule_admissions admission where pending_share_id=$1",
            [pending.id]
          )
        ).rows[0]!;
        expect(saved.portable_source_hash).toBe(
          sharingRuleSourceIdentityHash(
            fixture.ownerUserId,
            input.ruleCreation.sourceIdentity!
          )
        );
        expect(JSON.stringify(saved.record)).not.toContain(
          "conversation-private-"
        );
        await expect(
          repository.createPendingConversationSharingRule(
            actor(fixture.ownerUserId),
            {
              ...input,
              ruleCreation: {
                ...input.ruleCreation,
                sourceIdentity: {
                  ...input.ruleCreation.sourceIdentity!,
                  logicalSessionId: randomUUID()
                }
              }
            }
          )
        ).rejects.toThrow("different bindings");
      }

      await expect(
        repository.createPendingConversationSharingRule(
          actor(fixture.ownerUserId),
          {
            ...input,
            ruleCreation: { ...input.ruleCreation, ruleId: randomUUID() }
          }
        )
      ).rejects.toThrow();
      expect(
        (
          await pool.query(
            `select id from team_memory_sharing_rules where id=$1`,
            [ruleId]
          )
        ).rowCount
      ).toBe(0);
      const failures: unknown[] = [];
      const initial = await repository.processPendingShares({
        ensureCompanion: ensurePendingShareCompanion,
        reportActivationFailure: (failure) => failures.push(failure)
      });
      if (initial.failed) {
        throw new Error(
          `Pending rule activation failed: ${JSON.stringify(failures)}`
        );
      }
      expect(initial).toMatchObject({
        claimed: 1,
        activated: 0,
        waiting: 1,
        failed: 0
      });
      if (portable) {
        const member = (
          await pool.query<{ portable_source_hash: string }>(
            "select portable_source_hash from team_memory_sharing_rule_members where rule_id=$1 and logical_memory_id=$2",
            [ruleId, source.logicalMemoryId]
          )
        ).rows[0]!;
        expect(member.portable_source_hash).toBe(
          sharingRuleSourceIdentityHash(
            fixture.ownerUserId,
            input.ruleCreation.sourceIdentity!
          )
        );
        const receiverId = (
          await pool.query<{ id: string }>(
            `insert into device_credentials(owner_user_id,credential_key_id,upstream_backend_id,device_instance_id,verifier_kind,verifier_hash,operation_families)
          values($1,$2,$3,$4,'secret_hash',$5,ARRAY['sync','share_grant_management']::text[]) returning id`,
            [
              fixture.ownerUserId,
              randomUUID(),
              randomUUID(),
              randomUUID(),
              hash("conversation-receiver")
            ]
          )
        ).rows[0]!.id;
        expect(
          await repository.getSharingRulePublisherTakeoverReview(
            actor(fixture.ownerUserId),
            {
              ruleId,
              teamId: fixture.teamId,
              teamWorkspaceId: fixture.teamWorkspaceId,
              expectedAuthorityVersion: 1,
              publisherFence: 1,
              sourceIdentity: input.ruleCreation.sourceIdentity!,
              receivingCredentialId: receiverId
            }
          )
        ).toMatchObject({
          selectorKind: "captured_session",
          selectionScope: null,
          logicalMemoryId: source.logicalMemoryId,
          receivingPublisher: { credentialId: receiverId }
        });
      }
      const rule = (
        await pool.query<{ reason_id: string; share_grant_id: string }>(
          `select reason.id as reason_id,reason.share_grant_id from team_memory_share_reasons reason where reason.rule_id=$1`,
          [ruleId]
        )
      ).rows[0]!;
      expect(rule).toBeDefined();
      const discussion = (
        await pool.query<{ id: string }>(
          `select id from collaboration_threads where share_grant_id=$1`,
          [rule.share_grant_id]
        )
      ).rows[0];
      expect(discussion).toBeDefined();
      if (!overlap)
        await expect(
          collaboration.getThread(actor(fixture.readerUserId), {
            threadId: discussion!.id
          })
        ).resolves.toBeNull();
      if (direct) expect(rule.share_grant_id).toBe(direct.shareGrantId);
      if (converting) {
        const snapshotInput = {
          snapshotReasonId: snapshotReason!,
          previewId: candidate!.previewId,
          previewHash: candidate!.previewHash,
          previewRevision: candidate!.previewRevision,
          logicalMemoryId: source.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId
        };
        expect(
          await repository.getConversationSharingRuleCreationReview(
            actor(fixture.ownerUserId),
            snapshotInput
          )
        ).toBeNull();
        const version = (
          await pool.query<{ grant_version: number }>(
            "select grant_version from team_memory_share_grants where id=$1",
            [rule.share_grant_id]
          )
        ).rows[0]!.grant_version;
        const duplicateRuleId = randomUUID();
        await expect(
          repository.createPendingConversationSharingRule(
            actor(fixture.ownerUserId),
            {
              ...input,
              mutationId: randomUUID(),
              consentId: randomUUID(),
              ruleCreation: {
                ...input.ruleCreation,
                ruleId: duplicateRuleId,
                expectedGrantVersion: version
              }
            }
          )
        ).rejects.toThrow("already in progress");
        expect(
          (
            await pool.query(
              "select id from team_memory_sharing_rules where id=$1",
              [duplicateRuleId]
            )
          ).rowCount
        ).toBe(0);
        expect(
          await repository.createPendingConversationSharingRule(
            actor(fixture.ownerUserId),
            input
          )
        ).toMatchObject({ id: pending.id });
      }
      const control = async (action: "pause" | "resume" | "stop") => {
        const state = (
          await pool.query<{
            authority_version: number;
            grant_version: number;
          }>(
            `select rule.authority_version,g.grant_version from team_memory_sharing_rules rule join team_memory_share_grants g on g.id=$2 where rule.id=$1`,
            [ruleId, rule.share_grant_id]
          )
        ).rows[0]!;
        return repository.controlConversationSharingRule(
          actor(fixture.ownerUserId),
          {
            mutationId: randomUUID(),
            ruleId,
            reasonId: rule.reason_id,
            shareGrantId: rule.share_grant_id,
            expectedAuthorityVersion: state.authority_version,
            expectedGrantVersion: state.grant_version,
            action,
            authority: shareAuthority
          }
        );
      };
      if (converting) {
        expect(
          (
            await pool.query<{ state: string }>(
              "select state from source_owner_representation_consents where id=$1",
              [direct!.consentId]
            )
          ).rows[0]
        ).toEqual({ state: "active" });
        expect(
          await repository.readGrantRepresentation(
            actor(fixture.readerUserId),
            {
              shareGrantId: direct!.shareGrantId,
              representation: "lcm_rollups"
            }
          )
        ).toMatchObject({ representation: { sourceRevision: 1 } });
      }
      await control("pause");
      await flushSanitizedSemanticPublication();
      expect(
        (
          await pool.query(
            `select 1 from team_memory_reason_publications where reason_id=$1`,
            [rule.reason_id]
          )
        ).rowCount
      ).toBe(0);
      await control("resume");
      await repository.reconcileSharingRuleMembers();
      await flushSanitizedSemanticPublication();
      await pool.query(
        `update pending_share_outbox set available_at=now() where pending_share_id=$1`,
        [pending.id]
      );
      expect(
        await repository.processPendingShares({
          ensureCompanion: ensurePendingShareCompanion
        })
      ).toMatchObject({ claimed: 1, activated: 1, failed: 0 });
      expect(
        await repository.readGrantRepresentation(actor(fixture.readerUserId), {
          shareGrantId: rule.share_grant_id,
          representation: "lcm_rollups"
        })
      ).toMatchObject({ representation: { sourceRevision: 1 } });
      if (converting)
        expect(
          (
            await pool.query<{ state: string }>(
              "select state from source_owner_representation_consents where id=$1",
              [direct!.consentId]
            )
          ).rows[0]
        ).toEqual({ state: "revoked" });
      if (converting)
        expect(
          (
            await pool.query<{ count: number }>(
              "select count(*)::integer count from collaboration_outbox where mutation_id=$1 and family='share_grant_lifecycle'",
              [
                crossIdentitySyncDeterministicUuid({
                  kind: "snapshot_conversion_completed",
                  pendingShareId: pending.id
                })
              ]
            )
          ).rows[0]
        ).toEqual({ count: 1 });
      const owner = await repository.getOwnerShare(actor(fixture.ownerUserId), {
        kind: "pending",
        id: pending.id
      });
      const reason = owner?.summary.sharingReasons.find(
        (reason) => reason.id === rule.reason_id
      );
      expect(reason).toMatchObject({
        kind: "rule",
        maximumFidelity: "lcm_rollups",
        permittedRepresentations: ["lcm_rollups"]
      });
      await seedAuthoritativeSourceRevision(
        fixture,
        source,
        2,
        "pending-rule-later",
        { includeSummarySnapshot: false }
      );
      await repository.advanceContinuousGrantRepresentations({
        remoteReplicaId: source.remoteReplicaId,
        sourceRevision: 2
      });
      expect(
        (
          await pool.query(
            `select 1 from team_memory_reason_publications publication
           join team_memory_representations representation on representation.id=publication.representation_id
          where publication.reason_id=$1 and representation.source_revision=2
            and representation.state='available' and representation.invalidated_at is null`,
            [rule.reason_id]
          )
        ).rowCount
      ).toBe(0);
      const eventIdBeforeSummary = source.seededEvents[0]!.eventId;
      await seedAuthoritativeSourceRevision(
        fixture,
        source,
        2,
        "pending-rule-later",
        { summaryOnly: true }
      );
      expect(source.lastSyncPackage).toMatchObject({
        fromCursor: 2,
        toCursor: 2,
        changes: []
      });
      expect(source.seededEvents[0]!.eventId).toBe(eventIdBeforeSummary);
      await pool.query(
        "update team_memory_sharing_rule_members set next_reconciliation_at=now() where rule_id=$1",
        [ruleId]
      );
      expect(await repository.reconcileSharingRuleMembers()).toMatchObject({
        processed: 1,
        prepared: 1,
        failed: 0
      });
      await flushSanitizedSemanticPublication();
      expect(
        await repository.readGrantRepresentation(actor(fixture.readerUserId), {
          shareGrantId: rule.share_grant_id,
          representation: "lcm_rollups"
        })
      ).toMatchObject({ representation: { sourceRevision: 2 } });
      await ensureSourceRevision(
        fixture,
        source,
        3,
        "pending-rule-stop-queued"
      );
      await repository.advanceContinuousGrantRepresentations({
        remoteReplicaId: source.remoteReplicaId,
        sourceRevision: 3
      });
      await control("stop");
      await flushSanitizedSemanticPublication();
      const retained = await repository.readGrantRepresentation(
        actor(fixture.readerUserId),
        { shareGrantId: rule.share_grant_id, representation: "lcm_rollups" }
      );
      if (direct && !converting) {
        expect(retained).toMatchObject({
          representation: { sourceRevision: 1 }
        });
        const snapshot = (
          await pool.query<{
            state: string;
            mode: string;
            maximum_authorized_source_revision: string;
          }>(
            `select state,mode,maximum_authorized_source_revision from source_owner_representation_consents where id=$1`,
            [direct.consentId]
          )
        ).rows[0];
        expect(snapshot).toMatchObject({
          state: "active",
          mode: "snapshot",
          maximum_authorized_source_revision: "1"
        });
      } else if (converting) {
        expect(retained).toMatchObject({
          representation: { sourceRevision: 1 }
        });
        expect(
          (
            await pool.query<{ state: string }>(
              "select state from team_memory_sharing_rules where id=$1",
              [independentRuleId]
            )
          ).rows[0]
        ).toEqual({ state: "paused" });
        expect(
          await repository.readGrantRepresentation(
            actor(unrelated!.fixture.readerUserId),
            {
              shareGrantId: unrelated!.grant.shareGrantId,
              representation: "lcm_rollups"
            }
          )
        ).toMatchObject({ representation: { sourceRevision: 1 } });
      } else expect(retained).toBeNull();
      expect(
        (
          await pool.query(
            `select 1 from team_memory_reason_publications publication join team_memory_representations representation on representation.id=publication.representation_id
             where publication.reason_id=$1 and representation.source_revision=3 and representation.state in ('available','stale') and representation.invalidated_at is null`,
            [rule.reason_id]
          )
        ).rowCount
      ).toBe(0);
      expect(
        (
          await pool.query(
            `select personal_deleted_at,invalidated_at from sessions where id=$1`,
            [source.sessionId]
          )
        ).rows[0]
      ).toEqual({ personal_deleted_at: null, invalidated_at: null });
    },
    90_000
  );
});
