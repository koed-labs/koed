import { z } from "zod";
import {
  CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES,
  CAPTURED_SESSION_SYNC_MAX_CHUNKS,
  CAPTURED_SESSION_SYNC_MAX_PACKAGE_BYTES,
  capturedSessionSyncUploadPackageManifestSchema
} from "@koed/shared";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const uuidSchema = z.uuid();
const safeIntegerSchema = z.number().int().safe();
const decimalSafeIntegerSchema = z.string().max(16).regex(/^\d+$/);
const capturedSessionPolicyManifestSchema = z
  .object({
    version: z.literal(1),
    sourceBoundary: z.literal("captured_session"),
    transcriptIncluded: z.literal(false),
    sourceVectorsAccepted: z.literal(false)
  })
  .strict();
const capturedSessionConsentManifestSchema = z
  .object({
    consented_at: z.iso.datetime(),
    policy_version: z.literal(1),
    source_boundary: z.literal("captured_session"),
    selectedSessionId: uuidSchema
  })
  .strict();
const boundedBase64Schema = z
  .string()
  .min(1)
  .max(CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES * 2)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
const syncPackageManifestSchema = z
  .object({
    version: z.literal(1),
    packageId: uuidSchema,
    objectClass: z.literal("sync_package"),
    payloadFormat: z.literal("json"),
    createdAt: z.iso.datetime(),
    expiresAt: z.null(),
    scope: z
      .object({
        deploymentId: uuidSchema,
        tenantId: z.string().trim().min(1).max(240),
        objectClass: z.literal("sync_package")
      })
      .strict(),
    provenance: z
      .object({
        rowFamily: z.literal("sync_package"),
        sourceId: uuidSchema
      })
      .strict(),
    payload: z
      .object({
        byteCount: z
          .number()
          .int()
          .nonnegative()
          .max(CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES),
        checksumSha256: sha256Schema,
        envelopeVersion: z.literal(1),
        providerMode: z.literal("recipient_public_key"),
        keyId: z.string().trim().min(1).max(240),
        keyVersion: safeIntegerSchema.positive(),
        algorithm: z.literal("aes-256-gcm"),
        ciphertextLocation: z.literal("sync_package.payload"),
        encryptedAt: z.iso.datetime(),
        reencryptedAt: z.null()
      })
      .strict(),
    metadata: z
      .object({
        formatVersion: z.literal(1),
        chunkIndex: safeIntegerSchema.nonnegative(),
        chunkCount: safeIntegerSchema
          .positive()
          .max(CAPTURED_SESSION_SYNC_MAX_CHUNKS)
      })
      .strict()
  })
  .strict();
const syncPackageEnvelopeSchema = z
  .object({
    version: z.literal(1),
    providerMode: z.literal("recipient_public_key"),
    keyId: z.string().trim().min(1).max(240),
    keyVersion: safeIntegerSchema.positive(),
    scope: z
      .object({
        deploymentId: uuidSchema,
        tenantId: z.string().trim().min(1).max(240),
        objectClass: z.literal("sync_package")
      })
      .strict(),
    provenance: z
      .object({
        rowFamily: z.literal("sync_package"),
        sourceId: uuidSchema
      })
      .strict(),
    algorithm: z.literal("aes-256-gcm"),
    ciphertext: boundedBase64Schema,
    nonce: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    tag: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    wrappedDek: z
      .object({
        id: uuidSchema,
        version: z.literal(1),
        algorithm: z.literal("RSA-OAEP-SHA256"),
        ciphertext: z
          .string()
          .min(1)
          .max(2_048)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        nonce: z.literal(""),
        tag: z.literal("")
      })
      .strict(),
    ciphertextLocation: z.literal("sync_package.payload"),
    aad: z
      .object({
        chunkCount: decimalSafeIntegerSchema,
        chunkIndex: decimalSafeIntegerSchema,
        objectClass: z.literal("sync_package"),
        packageId: uuidSchema,
        packageSequence: decimalSafeIntegerSchema,
        payloadFormat: z.literal("json"),
        relationshipId: uuidSchema,
        sourceDeploymentId: uuidSchema,
        targetDeploymentId: uuidSchema
      })
      .strict(),
    createdAt: z.iso.datetime(),
    reencryptedAt: z.null()
  })
  .strict();

export const createSourceSyncRelationshipSchema = z
  .object({
    session_id: uuidSchema,
    upstream_backend_id: z.string().trim().min(2).max(64),
    idempotency_key: z.string().trim().min(8).max(240),
    consent: z
      .object({
        consented_at: z.iso.datetime(),
        policy_version: z.literal(1),
        source_boundary: z.literal("captured_session")
      })
      .strict()
  })
  .strict();

export const relationshipParamsSchema = z.object({
  relationshipId: uuidSchema
});

export const revokeSyncRelationshipSchema = z
  .object({
    reason: z.string().trim().min(1).max(280).optional()
  })
  .strict();

export const applyRemoteSyncRevocationSchema = z
  .object({
    revocation_id: uuidSchema,
    revocation_sequence: safeIntegerSchema.positive()
  })
  .strict();

export const syncHeartbeatSchema = z
  .object({
    source_cursor: safeIntegerSchema.nonnegative(),
    target_processing_cursor: safeIntegerSchema.nonnegative(),
    package_sequence: safeIntegerSchema.nonnegative()
  })
  .strict()
  .refine((input) => input.source_cursor === input.target_processing_cursor, {
    message: "heartbeat cursors must match",
    path: ["target_processing_cursor"]
  });

export const createTargetSyncRelationshipSchema = z
  .object({
    relationship_id: uuidSchema,
    logical_memory_id: uuidSchema,
    source_replica_id: uuidSchema,
    source_deployment_id: uuidSchema,
    source_user_id: z.string().trim().min(1).max(240),
    origin_session_id: uuidSchema,
    idempotency_key: z.string().trim().min(8).max(240),
    creation_request_hash: sha256Schema,
    policy_manifest: capturedSessionPolicyManifestSchema,
    consent_manifest: capturedSessionConsentManifestSchema,
    session: z
      .object({
        originSessionId: uuidSchema,
        externalSessionId: z.string().max(500).nullable(),
        sourceRuntime: z.enum(["codex", "codex-cli", "claude-code", "pi"]),
        captureMethod: z.enum(["transcript", "mcp", "web", "api"]),
        capturedAt: z.iso.datetime(),
        title: z.string().max(500).nullable(),
        sourceAdapterVersion: z.string().max(120).nullable()
      })
      .strict()
  })
  .strict();

export const createUploadSessionSchema = z
  .object({
    protocol_package_id: uuidSchema,
    idempotency_key: z.string().trim().min(8).max(240),
    request_hash: sha256Schema,
    package_manifest: capturedSessionSyncUploadPackageManifestSchema,
    package_checksum: sha256Schema,
    total_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(CAPTURED_SESSION_SYNC_MAX_PACKAGE_BYTES),
    expected_chunk_count: z
      .number()
      .int()
      .positive()
      .max(CAPTURED_SESSION_SYNC_MAX_CHUNKS),
    source_sequence: safeIntegerSchema.positive(),
    from_cursor: safeIntegerSchema.nonnegative(),
    to_cursor: safeIntegerSchema.nonnegative()
  })
  .strict()
  .refine((input) => input.to_cursor >= input.from_cursor, {
    message: "to_cursor must not precede from_cursor",
    path: ["to_cursor"]
  });

export const uploadSessionParamsSchema = z.object({
  uploadSessionId: uuidSchema
});

export const uploadChunkParamsSchema = uploadSessionParamsSchema.extend({
  chunkIndex: z.coerce
    .number()
    .int()
    .safe()
    .nonnegative()
    .max(CAPTURED_SESSION_SYNC_MAX_CHUNKS - 1)
});

export const uploadChunkSchema = z
  .object({
    checksum_sha256: sha256Schema,
    byte_count: z
      .number()
      .int()
      .positive()
      .max(CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES * 2),
    encrypted_package: z
      .object({
        manifest: syncPackageManifestSchema,
        envelope: syncPackageEnvelopeSchema
      })
      .strict()
  })
  .strict();

export const targetSyncContextRequestSchema = z.object({}).strict();

export const targetSyncContextResponseSchema = z
  .object({
    target_deployment_id: uuidSchema,
    target_deployment_profile: z.enum([
      "developer",
      "private_vps",
      "team_self_hosted",
      "koed_managed_cloud"
    ]),
    target_user_id: z.string().trim().min(1).max(240),
    recipient_key: z
      .object({
        algorithm: z.literal("RSA-OAEP-SHA256"),
        keyId: z.string().trim().min(1).max(255),
        keyVersion: safeIntegerSchema.positive(),
        publicJwk: z
          .object({
            kty: z.literal("RSA"),
            n: z.string().trim().min(1).max(2_048),
            e: z.string().trim().min(1).max(32),
            alg: z.literal("RSA-OAEP-256"),
            key_ops: z.tuple([z.literal("encrypt")]),
            ext: z.literal(true),
            kid: z.string().trim().min(1).max(255),
            use: z.literal("enc")
          })
          .strict()
      })
      .strict()
  })
  .strict();

export const targetSyncRelationshipResponseSchema =
  targetSyncContextResponseSchema.extend({
    relationship: z
      .object({
        id: uuidSchema,
        state: z.enum([
          "pending",
          "uploading",
          "uploaded",
          "verified",
          "processing",
          "partially_available",
          "ready",
          "stale",
          "paused",
          "failed",
          "revoked",
          "purge_pending"
        ])
      })
      .passthrough(),
    target_replica_id: uuidSchema
  });

export const retrySyncRelationshipResponseSchema = z
  .object({
    relationship: targetSyncRelationshipResponseSchema.shape.relationship
  })
  .strict();
