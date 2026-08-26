import { describe, expect, it } from "vitest";
import {
  applyRemoteSyncRevocationSchema,
  createTargetSyncRelationshipSchema,
  createUploadSessionSchema,
  targetSyncRelationshipResponseSchema,
  uploadChunkParamsSchema
} from "./schemas.js";

const responseFixture = () => ({
  relationship: {
    id: "11111111-1111-4111-8111-111111111111",
    state: "ready"
  },
  target_deployment_id: "22222222-2222-4222-8222-222222222222",
  target_deployment_profile: "team_self_hosted",
  target_user_id: "33333333-3333-4333-8333-333333333333",
  target_replica_id: "44444444-4444-4444-8444-444444444444",
  recipient_key: {
    algorithm: "RSA-OAEP-SHA256",
    keyId: "sync-recipient:test",
    keyVersion: 1,
    publicJwk: {
      kty: "RSA",
      n: "public-modulus",
      e: "AQAB",
      alg: "RSA-OAEP-256",
      key_ops: ["encrypt"],
      ext: true,
      kid: "sync-recipient:test",
      use: "enc"
    }
  }
});

const uploadManifestFixture = () => ({
  objectClass: "sync_package",
  format: "koed.captured-session-sync/v1",
  formatVersion: 1,
  packageDigest: "c".repeat(64),
  summaryRevisionHash: null,
  recipientKeyId: "sync-recipient:test",
  recipientKeyVersion: 1,
  recordCount: 1
});

describe("Cross-Identity Sync response schemas", () => {
  it("accepts only the exact target enrollment response contract", () => {
    expect(
      targetSyncRelationshipResponseSchema.safeParse(responseFixture()).success
    ).toBe(true);
    expect(
      targetSyncRelationshipResponseSchema.safeParse({
        ...responseFixture(),
        target_deployment_profile: "developer"
      }).success
    ).toBe(true);
    expect(
      targetSyncRelationshipResponseSchema.safeParse({
        ...responseFixture(),
        target_deployment_profile: "local_personal"
      }).success
    ).toBe(false);
    expect(
      targetSyncRelationshipResponseSchema.safeParse({
        ...responseFixture(),
        recipient_key: {
          ...responseFixture().recipient_key,
          privateJwk: { d: "must-never-cross-the-boundary" }
        }
      }).success
    ).toBe(false);
  });

  it("rejects protocol counters outside JavaScript's safe integer range", () => {
    expect(
      applyRemoteSyncRevocationSchema.safeParse({
        revocation_id: "11111111-1111-4111-8111-111111111111",
        revocation_sequence: Number.MAX_SAFE_INTEGER + 1
      }).success
    ).toBe(false);
    expect(
      createUploadSessionSchema.safeParse({
        protocol_package_id: "11111111-1111-4111-8111-111111111111",
        idempotency_key: "safe-integer-test",
        request_hash: "a".repeat(64),
        package_manifest: uploadManifestFixture(),
        package_checksum: "b".repeat(64),
        total_bytes: 1,
        expected_chunk_count: 1,
        source_sequence: Number.MAX_SAFE_INTEGER + 1,
        from_cursor: 0,
        to_cursor: 1
      }).success
    ).toBe(false);
    expect(
      uploadChunkParamsSchema.safeParse({
        uploadSessionId: "11111111-1111-4111-8111-111111111111",
        chunkIndex: "128"
      }).success
    ).toBe(false);
  });

  it("requires the complete bounded upload manifest contract", () => {
    const upload = {
      protocol_package_id: "11111111-1111-4111-8111-111111111111",
      idempotency_key: "upload-manifest-test",
      request_hash: "a".repeat(64),
      package_manifest: uploadManifestFixture(),
      package_checksum: "b".repeat(64),
      total_bytes: 1,
      expected_chunk_count: 1,
      source_sequence: 1,
      from_cursor: 0,
      to_cursor: 1
    };

    expect(createUploadSessionSchema.safeParse(upload).success).toBe(true);
    expect(
      createUploadSessionSchema.safeParse({
        ...upload,
        package_manifest: {
          ...uploadManifestFixture(),
          summaryRevisionHash: "d".repeat(64)
        }
      }).success
    ).toBe(true);
    const missingRevision = { ...uploadManifestFixture() };
    Reflect.deleteProperty(missingRevision, "summaryRevisionHash");
    expect(
      createUploadSessionSchema.safeParse({
        ...upload,
        package_manifest: missingRevision
      }).success
    ).toBe(false);
    expect(
      createUploadSessionSchema.safeParse({
        ...upload,
        package_manifest: { recordCount: 1 }
      }).success
    ).toBe(false);
    expect(
      createUploadSessionSchema.safeParse({
        ...upload,
        package_manifest: {
          ...uploadManifestFixture(),
          source_text: "must not enter upload metadata"
        }
      }).success
    ).toBe(false);
  });

  it("accepts only the exact captured-session policy and consent manifests", () => {
    const relationship = {
      relationship_id: "11111111-1111-4111-8111-111111111111",
      logical_memory_id: "22222222-2222-4222-8222-222222222222",
      source_replica_id: "33333333-3333-4333-8333-333333333333",
      source_deployment_id: "44444444-4444-4444-8444-444444444444",
      source_user_id: "66666666-6666-4666-8666-666666666666",
      origin_session_id: "55555555-5555-4555-8555-555555555555",
      idempotency_key: "target-relationship-test",
      creation_request_hash: "a".repeat(64),
      policy_manifest: {
        version: 1,
        sourceBoundary: "captured_session",
        transcriptIncluded: false,
        sourceVectorsAccepted: false
      },
      consent_manifest: {
        consented_at: "2026-07-13T00:00:00.000Z",
        policy_version: 1,
        source_boundary: "captured_session",
        selectedSessionId: "55555555-5555-4555-8555-555555555555"
      },
      session: {
        originSessionId: "55555555-5555-4555-8555-555555555555",
        externalSessionId: null,
        sourceRuntime: "codex",
        captureMethod: "transcript",
        capturedAt: "2026-07-13T00:00:00.000Z",
        title: null,
        sourceAdapterVersion: null
      }
    };

    expect(
      createTargetSyncRelationshipSchema.safeParse(relationship).success
    ).toBe(true);
    expect(
      createTargetSyncRelationshipSchema.safeParse({
        ...relationship,
        source_user_id: "external-subject-label"
      }).success
    ).toBe(false);
    expect(
      createTargetSyncRelationshipSchema.safeParse({
        ...relationship,
        session: {
          ...relationship.session,
          sourceRuntime: "claude-code",
          sourceAdapterVersion: "claude-code-transcript-v1"
        }
      }).success
    ).toBe(true);
    expect(
      createTargetSyncRelationshipSchema.safeParse({
        ...relationship,
        policy_manifest: {
          ...relationship.policy_manifest,
          note: "raw memory disguised as harmless metadata"
        }
      }).success
    ).toBe(false);
    expect(
      createTargetSyncRelationshipSchema.safeParse({
        ...relationship,
        consent_manifest: {
          ...relationship.consent_manifest,
          policy_version: 2
        }
      }).success
    ).toBe(false);
  });
});
