import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign
} from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MANAGED_CONVERSATION_TARGET_READINESS_PROTOCOL,
  MANAGED_CONVERSATION_TRANSFER_PROTOCOL,
  MANAGED_CONVERSATION_TRANSFER_PROTOCOL_V2,
  assertManagedConversationHandoffTransition,
  canonicalManagedConversationHandoffManifest,
  managedConversationAiClientInstanceIdAfterVerification,
  managedConversationAuthorityLogHead,
  managedConversationHandoffCertificateDigest,
  managedConversationTargetReadinessEvidenceDigest,
  managedConversationTargetReadinessIsFresh,
  parseManagedConversationHandoffManifest,
  signManagedConversationHandoffCertificate,
  verifyManagedConversationHandoffCertificate,
  type ManagedConversationHandoffManifest
} from "./managed-conversation-transfer.js";

const fixture = () => {
  const source = generateKeyPairSync("ed25519");
  const authority = generateKeyPairSync("ed25519");
  const sourceKeyId = randomUUID();
  const authorityKeyId = randomUUID();
  const sourceDeviceId = randomUUID();
  const targetDeviceId = randomUUID();
  const manifest: ManagedConversationHandoffManifest = {
    protocol: MANAGED_CONVERSATION_TRANSFER_PROTOCOL_V2,
    operationId: randomUUID(),
    ownerUserId: randomUUID(),
    executionId: randomUUID(),
    sourceExecutionGeneration: 3,
    nextExecutionGeneration: 4,
    logicalSourceId: randomUUID(),
    sourceGenerationId: randomUUID(),
    nextSourceGenerationId: randomUUID(),
    targetOriginKeyId: randomUUID(),
    sourceClosureHash: "1".repeat(64),
    sourceEndByteCursor: 421,
    sourceEndItemCursor: 12,
    provider: "codex",
    aiClientInstanceId: "codex.work",
    providerThreadId: randomUUID(),
    providerArtifactRelativePath:
      "sessions/2026/07/27/rollout-2026-07-27-example.jsonl",
    providerCliVersion: "1.2.3",
    workspaceSnapshotId: randomUUID(),
    workspaceManifestDigest: "2".repeat(64),
    sourceDeploymentId: randomUUID(),
    sourceDeviceId,
    targetDeploymentId: randomUUID(),
    targetDeviceId,
    authoritySequence: 8,
    priorAuthorityLogHead: "3".repeat(64),
    nonce: randomBytes(32).toString("base64url"),
    createdAt: "2026-07-27T12:00:00.000Z",
    expiresAt: "2026-07-27T12:05:00.000Z"
  };
  const certificate = signManagedConversationHandoffCertificate({
    manifest,
    sourceSigner: {
      keyId: sourceKeyId,
      sign: (payload) =>
        sign(null, payload, source.privateKey).toString("base64url")
    },
    authorityKeyId,
    authorityPrivateKey: authority.privateKey
  });
  return {
    source,
    authority,
    sourceDeviceId,
    targetDeviceId,
    manifest,
    certificate
  };
};

describe("Managed Conversation transfer protocol", () => {
  it("verifies legacy v1 without mutating its signed fields", () => {
    const value = fixture();
    const legacyFields = { ...value.manifest };
    delete legacyFields.aiClientInstanceId;
    const legacyManifest: ManagedConversationHandoffManifest = {
      ...legacyFields,
      protocol: MANAGED_CONVERSATION_TRANSFER_PROTOCOL
    };
    const certificate = signManagedConversationHandoffCertificate({
      manifest: legacyManifest,
      sourceSigner: {
        keyId: randomUUID(),
        sign: (payload) =>
          sign(null, payload, value.source.privateKey).toString("base64url")
      },
      authorityKeyId: randomUUID(),
      authorityPrivateKey: value.authority.privateKey
    });
    expect(
      verifyManagedConversationHandoffCertificate({
        certificate,
        sourcePublicKey: value.source.publicKey,
        authorityPublicKey: value.authority.publicKey,
        enforceExpiry: false
      })
    ).toBe(true);
    expect(
      canonicalManagedConversationHandoffManifest(certificate.manifest)
    ).not.toContain("aiClientInstanceId");
    expect(
      managedConversationAiClientInstanceIdAfterVerification({
        manifest: certificate.manifest,
        verified: true
      })
    ).toBe("codex.default");
  });

  it("requires source and authority signatures over one immutable transfer", () => {
    const value = fixture();
    expect(value.manifest.aiClientInstanceId).toBe("codex.work");
    expect(
      verifyManagedConversationHandoffCertificate({
        certificate: value.certificate,
        sourcePublicKey: value.source.publicKey,
        authorityPublicKey: value.authority.publicKey,
        now: new Date("2026-07-27T12:01:00.000Z"),
        expectedTargetDeviceId: value.targetDeviceId,
        minimumAuthoritySequence: 8,
        expectedPriorAuthorityLogHead: "3".repeat(64)
      })
    ).toBe(true);
    const digest = managedConversationHandoffCertificateDigest(
      value.certificate
    );
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      managedConversationAuthorityLogHead({
        priorHead: value.manifest.priorAuthorityLogHead,
        sequence: value.manifest.authoritySequence,
        certificateDigest: digest
      })
    ).toMatch(/^[0-9a-f]{64}$/);

    const tampered = structuredClone(value.certificate);
    tampered.manifest.sourceEndByteCursor += 1;
    expect(
      verifyManagedConversationHandoffCertificate({
        certificate: tampered,
        sourcePublicKey: value.source.publicKey,
        authorityPublicKey: value.authority.publicKey,
        now: new Date("2026-07-27T12:01:00.000Z")
      })
    ).toBe(false);
  });

  it("rejects stale, replayed, wrong-target, and malformed transfer claims", () => {
    const value = fixture();
    expect(
      verifyManagedConversationHandoffCertificate({
        certificate: value.certificate,
        sourcePublicKey: value.source.publicKey,
        authorityPublicKey: value.authority.publicKey,
        now: new Date("2026-07-27T12:05:00.000Z")
      })
    ).toBe(false);
    expect(
      verifyManagedConversationHandoffCertificate({
        certificate: value.certificate,
        sourcePublicKey: value.source.publicKey,
        authorityPublicKey: value.authority.publicKey,
        now: new Date("2026-07-27T12:01:00.000Z"),
        expectedTargetDeviceId: randomUUID()
      })
    ).toBe(false);
    expect(
      verifyManagedConversationHandoffCertificate({
        certificate: value.certificate,
        sourcePublicKey: value.source.publicKey,
        authorityPublicKey: value.authority.publicKey,
        now: new Date("2026-07-27T12:01:00.000Z"),
        minimumAuthoritySequence: 9
      })
    ).toBe(false);
    expect(() =>
      parseManagedConversationHandoffManifest({
        ...value.manifest,
        nextExecutionGeneration: 5
      })
    ).toThrow(/contiguous/);
    expect(() =>
      parseManagedConversationHandoffManifest({
        ...value.manifest,
        targetDeviceId: value.sourceDeviceId
      })
    ).toThrow(/different device/);
  });

  it("keeps a committed certificate verifiable for recovery after its proposal expiry", () => {
    const value = fixture();
    expect(
      verifyManagedConversationHandoffCertificate({
        certificate: value.certificate,
        sourcePublicKey: value.source.publicKey,
        authorityPublicKey: value.authority.publicKey,
        now: new Date("2026-07-27T13:00:00.000Z"),
        expectedTargetDeviceId: value.targetDeviceId,
        minimumAuthoritySequence: value.manifest.authoritySequence,
        expectedPriorAuthorityLogHead: value.manifest.priorAuthorityLogHead,
        enforceExpiry: false
      })
    ).toBe(true);
  });

  it("enforces the irreversible handoff state order", () => {
    expect(() =>
      assertManagedConversationHandoffTransition(
        "quiesce_requested",
        "provider_stopped"
      )
    ).not.toThrow();
    expect(() =>
      assertManagedConversationHandoffTransition(
        "target_verified",
        "target_verified"
      )
    ).not.toThrow();
    expect(() =>
      assertManagedConversationHandoffTransition(
        "lease_transferred",
        "source_sealed"
      )
    ).toThrow(/Invalid/);
    expect(() =>
      assertManagedConversationHandoffTransition("running", "restoring")
    ).toThrow(/Invalid/);
  });

  it("requires every target readiness dimension to be fresh and immutable", () => {
    const value = fixture();
    const proof = {
      status: "verified" as const,
      evidenceDigest: "4".repeat(64),
      checkedAt: "2026-07-27T12:00:00.000Z",
      expiresAt: "2026-07-27T12:05:00.000Z"
    };
    const evidence = {
      protocol: MANAGED_CONVERSATION_TARGET_READINESS_PROTOCOL,
      operationId: value.manifest.operationId,
      executionId: value.manifest.executionId,
      snapshotId: value.manifest.workspaceSnapshotId,
      sourceGenerationId: value.manifest.sourceGenerationId,
      targetDeploymentId: value.manifest.targetDeploymentId,
      targetDeviceId: value.manifest.targetDeviceId,
      dimensions: {
        snapshotIntegrity: proof,
        objectClosure: { ...proof, evidenceDigest: "5".repeat(64) },
        filesystemFidelity: { ...proof, evidenceDigest: "6".repeat(64) },
        environmentAvailability: { ...proof, evidenceDigest: "7".repeat(64) },
        providerCompatibility: { ...proof, evidenceDigest: "8".repeat(64) },
        executionBoundary: { ...proof, evidenceDigest: "9".repeat(64) }
      }
    };

    expect(
      managedConversationTargetReadinessIsFresh(
        evidence,
        new Date("2026-07-27T12:04:59.999Z")
      )
    ).toBe(true);
    expect(
      managedConversationTargetReadinessIsFresh(
        evidence,
        new Date("2026-07-27T12:05:00.000Z")
      )
    ).toBe(false);
    expect(managedConversationTargetReadinessEvidenceDigest(evidence)).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect(() =>
      managedConversationTargetReadinessEvidenceDigest({
        ...evidence,
        dimensions: {
          ...evidence.dimensions,
          providerCompatibility: {
            ...proof,
            status: "unknown" as never
          }
        }
      })
    ).toThrow(/verified/);
  });
});
