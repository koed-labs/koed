import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PDS_PERSONAL_REPLICATION_REGISTRY,
  createPdsArtifactRecord,
  pdsArtifactCompatibilityHash,
  pdsArtifactPayloadHash,
  pdsPortableEmbeddingSourceHash,
  pdsPortableEmbeddingVectorHash,
  pdsPortableLcmNodeContentHash,
  pdsPortableLcmNodeId,
  pdsPortableMemoryEmbeddingId,
  pdsPortableMemoryEventContentHash,
  pdsPortableMemoryEventId,
  validatePdsArtifactRecord,
  verifyPdsArtifactRecord,
  type PdsMemoryEventContractV1,
  type PdsEmbeddingContractV1,
  type PdsLcmNodeContractV1,
  type PdsArtifactPayload
} from "./personal-device-artifact.js";

const hash = (byte: number) => Buffer.alloc(32, byte).toString("base64url");

const fixture = () => {
  const keys = generateKeyPairSync("ed25519");
  const contract: PdsMemoryEventContractV1 = {
    artifactClass: "memory_event/v1",
    projectionPolicyKey: "transcript-default",
    projectionPolicyRevision: "1",
    projectionAlgorithmVersion: "agent-turn-bundle-v1",
    tokenCounter: "koed-token-counter-v1:js-tiktoken:o200k_base"
  };
  const eventContent = {
    sourceOrdinals: ["0", "1"],
    eventType: "captured" as const,
    actor: "assistant",
    rawEventType: "agent_turn",
    content: "Portable event.",
    metadata: { semanticUnitType: "agent_turn" },
    includeInEmbedding: true,
    includeInLcm: true,
    tokenCount: "3",
    sealReason: "agent_turn_end",
    sourceEventTime: "2026-07-29T00:00:00.000Z",
    sourceSequence: "1"
  };
  const contentHash = pdsPortableMemoryEventContentHash(eventContent);
  const logicalEventId = pdsPortableMemoryEventId({
    sourceFingerprint: hash(1),
    sourceClosureHash: hash(2),
    sourceOrdinals: ["0", "1"],
    projectionPolicyKey: contract.projectionPolicyKey,
    projectionPolicyRevision: contract.projectionPolicyRevision,
    contentHash
  });
  const payload: PdsArtifactPayload = {
    artifactClass: "memory_event/v1",
    items: [
      {
        logicalEventId,
        ...eventContent,
        contentHash
      }
    ]
  };
  const record = createPdsArtifactRecord({
    groupId: "group-1",
    workIdentity: logicalEventId,
    sourcePackageId: hash(4),
    sourceManifestHash: hash(5),
    sourceFingerprint: hash(1),
    sourceClosureHash: hash(2),
    producerDeviceId: "device-1",
    producerSigningKeyId: "signing-key-1",
    claimGeneration: "1",
    compatibilityContract: contract,
    payload,
    createdAt: "2026-07-29T00:00:00.000Z",
    producerSigningPrivateKey: keys.privateKey
  });
  return { contract, keys, payload, record };
};

describe("portable Personal artifacts", () => {
  it("classifies every registered durable Personal class explicitly", () => {
    expect(Object.values(PDS_PERSONAL_REPLICATION_REGISTRY)).not.toContain(
      undefined
    );
    expect(PDS_PERSONAL_REPLICATION_REGISTRY.memory_events).toBe("replicate");
    expect(PDS_PERSONAL_REPLICATION_REGISTRY.local_vector_indexes).toBe(
      "device_local"
    );
    expect(PDS_PERSONAL_REPLICATION_REGISTRY.team_collaboration_data).toBe(
      "external_authority"
    );
  });

  it("creates and verifies a source-bound signed Memory Event artifact", () => {
    const { contract, keys, payload, record } = fixture();
    expect(record.manifest.compatibilityContractHash).toBe(
      pdsArtifactCompatibilityHash(contract)
    );
    expect(record.manifest.payloadHash).toBe(pdsArtifactPayloadHash(payload));
    expect(verifyPdsArtifactRecord(record, keys.publicKey)).toEqual(record);
  });

  it("rejects payload mutation, signature mutation, unknown fields, and class mismatch", () => {
    const { keys, record } = fixture();
    const payloadMutation = structuredClone(record);
    if (payloadMutation.payload.artifactClass !== "memory_event/v1") {
      throw new Error("Expected Memory Event fixture");
    }
    payloadMutation.payload.items[0]!.content = "Changed";
    expect(() => validatePdsArtifactRecord(payloadMutation)).toThrow(
      "content hash"
    );

    const signatureMutation = structuredClone(record);
    signatureMutation.manifest.producerSignature = Buffer.alloc(64, 8).toString(
      "base64url"
    );
    expect(() =>
      verifyPdsArtifactRecord(signatureMutation, keys.publicKey)
    ).toThrow("signature");

    const unknownField = {
      ...structuredClone(record),
      leakedPath: "/home/user/source"
    };
    expect(() => validatePdsArtifactRecord(unknownField)).toThrow("fields");

    const classMismatch = structuredClone(record);
    classMismatch.payload.artifactClass = "lcm_node/v1";
    expect(() => validatePdsArtifactRecord(classMismatch)).toThrow("class");
  });

  it.each(["memory_event", "lcm_node"] as const)(
    "binds a portable embedding to its logical %s source and exact model contract",
    (logicalSourceType) => {
      const keys = generateKeyPairSync("ed25519");
      const contract: PdsEmbeddingContractV1 = {
        artifactClass: "memory_embedding/v1",
        modelKey: "qwen3-0.6b",
        modelArtifactHash: createHash("sha256")
          .update("model-artifact")
          .digest("hex"),
        dimensions: "3",
        tokenizer: "qwen3",
        inputTransform: "document-v1",
        pooling: "last-token",
        normalization: "l2",
        embeddingVersion: "qwen3-0.6b"
      };
      const vector = ["0.1", "0.2", "0.3"];
      const vectorHash = pdsPortableEmbeddingVectorHash(vector);
      const logicalSourceId = hash(
        logicalSourceType === "memory_event" ? 11 : 12
      );
      const sourceContentHash = hash(13);
      const canonicalSourceTextHash = createHash("sha256")
        .update("Portable embedding source.")
        .digest("base64url");
      const logicalEmbeddingId = pdsPortableMemoryEmbeddingId({
        logicalSourceType,
        logicalSourceId,
        sourceContentHash,
        sourceChunkIndex: "0",
        sourceChunkCount: "1",
        canonicalSourceTextHash,
        compatibilityContractHash: pdsArtifactCompatibilityHash(contract),
        vectorHash
      });
      const payload: PdsArtifactPayload = {
        artifactClass: "memory_embedding/v1",
        items: [
          {
            logicalEmbeddingId,
            logicalSourceType,
            logicalSourceId,
            sourceContentHash,
            sourceChunkIndex: "0",
            sourceChunkCount: "1",
            sourceHash: pdsPortableEmbeddingSourceHash({
              logicalSourceType,
              logicalSourceId,
              sourceContentHash,
              canonicalSourceTextHash
            }),
            canonicalSourceTextHash,
            sourceText: "Portable embedding source.",
            sourceTextHash: hash(15),
            vector,
            vectorHash
          }
        ]
      };
      payload.items[0]!.sourceTextHash = createHash("sha256")
        .update(payload.items[0]!.sourceText)
        .digest("base64url");
      const record = createPdsArtifactRecord({
        groupId: "group-1",
        workIdentity: logicalEmbeddingId,
        sourcePackageId: hash(4),
        sourceManifestHash: hash(5),
        sourceFingerprint: hash(1),
        sourceClosureHash: hash(2),
        producerDeviceId: "device-1",
        producerSigningKeyId: "signing-key-1",
        claimGeneration: "1",
        compatibilityContract: contract,
        payload,
        createdAt: "2026-07-29T00:00:00.000Z",
        producerSigningPrivateKey: keys.privateKey
      });
      expect(verifyPdsArtifactRecord(record, keys.publicKey)).toEqual(record);
    }
  );

  it("binds a completed LCM node to ordered logical sources and summary contract", () => {
    const keys = generateKeyPairSync("ed25519");
    const contract: PdsLcmNodeContractV1 = {
      artifactClass: "lcm_node/v1",
      nodeKind: "leaf",
      lcmAlgorithmVersion: "depth0-source-items-v1",
      summaryPromptVersion: "lcm-summary-leaf-v1",
      summaryModel: "gpt-5.4-mini",
      structuredOutputSchema: "lcm-semantic-summary-v1",
      sourceSelectionPolicy: "depth0-source-items-v1"
    };
    const content = {
      nodeKind: "leaf" as const,
      orderedSourceIds: [hash(20), hash(21)],
      summaryText: "A concise semantic summary.",
      summaryTokenCount: "6",
      structuredSummary: {
        schema_version: "lcm-semantic-summary-v1",
        title: "Summary",
        summary_text: "A concise semantic summary.",
        lexical_anchors: ["semantic summary"]
      },
      correctedRevision: "0",
      sourceSpanStart: "2026-07-29T00:00:00.000Z",
      sourceSpanEnd: "2026-07-29T00:01:00.000Z"
    };
    const contentHash = pdsPortableLcmNodeContentHash(content);
    const logicalNodeId = pdsPortableLcmNodeId({
      nodeKind: "leaf",
      orderedSourceIds: content.orderedSourceIds,
      compatibilityContractHash: pdsArtifactCompatibilityHash(contract),
      correctedRevision: "0",
      contentHash
    });
    const record = createPdsArtifactRecord({
      groupId: "group-1",
      workIdentity: hash(22),
      sourcePackageId: hash(4),
      sourceManifestHash: hash(5),
      sourceFingerprint: hash(1),
      sourceClosureHash: hash(2),
      producerDeviceId: "device-1",
      producerSigningKeyId: "signing-key-1",
      claimGeneration: "1",
      compatibilityContract: contract,
      payload: {
        artifactClass: "lcm_node/v1",
        items: [{ logicalNodeId, ...content, contentHash }]
      },
      createdAt: "2026-07-29T00:00:00.000Z",
      producerSigningPrivateKey: keys.privateKey
    });
    expect(verifyPdsArtifactRecord(record, keys.publicKey)).toEqual(record);
  });
});
