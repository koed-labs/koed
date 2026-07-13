import { z } from "zod";
import {
  CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES,
  CAPTURED_SESSION_SYNC_MAX_PACKAGE_BYTES
} from "@koed/shared";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const uuidSchema = z.uuid();
const forbiddenMetadataKey =
  /(?:secret|token|password|cookie|authorization|credential|plaintext|ciphertext|wrapped.?dek|raw.?memory|source.?text)/i;
const containsForbiddenMetadata = (value: unknown): boolean => {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 }
  ];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > 1_000 || current.depth > 16) return true;
    if (!current.value || typeof current.value !== "object") continue;
    for (const [key, nested] of Object.entries(current.value)) {
      if (forbiddenMetadataKey.test(key)) return true;
      pending.push({ value: nested, depth: current.depth + 1 });
    }
  }
  return false;
};
const safeManifestSchema = z
  .record(z.string().max(120), z.unknown())
  .superRefine((value, context) => {
    if (containsForbiddenMetadata(value)) {
      context.addIssue({ code: "custom", message: "Unsafe sync metadata" });
    }
  });
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
        keyVersion: z.number().int().positive(),
        algorithm: z.literal("aes-256-gcm"),
        ciphertextLocation: z.literal("sync_package.payload"),
        encryptedAt: z.iso.datetime(),
        reencryptedAt: z.null()
      })
      .strict(),
    metadata: z
      .object({
        formatVersion: z.literal(1),
        chunkIndex: z.number().int().nonnegative(),
        chunkCount: z.number().int().positive().max(10_000)
      })
      .strict()
  })
  .strict();
const syncPackageEnvelopeSchema = z
  .object({
    version: z.literal(1),
    providerMode: z.literal("recipient_public_key"),
    keyId: z.string().trim().min(1).max(240),
    keyVersion: z.number().int().positive(),
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
        chunkCount: z.string().regex(/^\d+$/),
        chunkIndex: z.string().regex(/^\d+$/),
        objectClass: z.literal("sync_package"),
        packageId: uuidSchema,
        packageSequence: z.string().regex(/^\d+$/),
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

export const createSourceSyncRelationshipSchema = z.object({
  session_id: uuidSchema,
  upstream_backend_id: z.string().trim().min(2).max(64),
  idempotency_key: z.string().trim().min(8).max(240),
  consent: z.object({
    consented_at: z.iso.datetime(),
    policy_version: z.number().int().positive(),
    source_boundary: z.literal("captured_session")
  })
});

export const relationshipParamsSchema = z.object({
  relationshipId: uuidSchema
});

export const revokeSyncRelationshipSchema = z.object({
  reason: z.string().trim().min(1).max(280).optional()
});

export const applyRemoteSyncRevocationSchema = z.object({
  revocation_id: uuidSchema,
  revocation_sequence: z.number().int().positive()
});

export const createTargetSyncRelationshipSchema = z.object({
  relationship_id: uuidSchema,
  logical_memory_id: uuidSchema,
  source_replica_id: uuidSchema,
  source_deployment_id: uuidSchema,
  source_user_id: z.string().trim().min(1).max(240),
  origin_session_id: uuidSchema,
  idempotency_key: z.string().trim().min(8).max(240),
  creation_request_hash: sha256Schema,
  policy_manifest: safeManifestSchema,
  consent_manifest: safeManifestSchema,
  session: z.object({
    originSessionId: uuidSchema,
    externalSessionId: z.string().max(500).nullable(),
    sourceRuntime: z.enum(["codex", "codex-cli"]),
    captureMethod: z.enum(["hook", "mcp", "web", "api"]),
    capturedAt: z.iso.datetime(),
    title: z.string().max(500).nullable(),
    sourceAdapterVersion: z.string().max(120).nullable()
  })
});

export const createUploadSessionSchema = z.object({
  protocol_package_id: uuidSchema,
  idempotency_key: z.string().trim().min(8).max(240),
  request_hash: sha256Schema,
  package_manifest: safeManifestSchema,
  package_checksum: sha256Schema,
  total_bytes: z
    .number()
    .int()
    .nonnegative()
    .max(CAPTURED_SESSION_SYNC_MAX_PACKAGE_BYTES),
  expected_chunk_count: z.number().int().positive().max(10_000),
  source_sequence: z.number().int().positive(),
  from_cursor: z.number().int().nonnegative(),
  to_cursor: z.number().int().nonnegative()
});

export const uploadSessionParamsSchema = z.object({
  uploadSessionId: uuidSchema
});

export const uploadChunkParamsSchema = uploadSessionParamsSchema.extend({
  chunkIndex: z.coerce.number().int().nonnegative()
});

export const uploadChunkSchema = z.object({
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
});
