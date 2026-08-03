import { CONVERSATION_SOURCE_REPLICATION_PROTOCOL } from "@koed/shared";
import { z } from "zod";

const uuid = z.uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const boundedBase64 = z
  .string()
  .min(1)
  .max(24 * 1024 * 1024)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
const encryptedPackageObjectClass = z.literal("sync_package");

export const sourceReplicationRecipientKeySchema = z
  .object({
    algorithm: z.literal("RSA-OAEP-SHA256"),
    keyId: z.string().trim().min(1).max(255),
    keyVersion: z.number().int().safe().positive(),
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
  .strict();

const encryptedPayloadEnvelopeSchema = z
  .object({
    version: z.literal(1),
    providerMode: z.literal("recipient_public_key"),
    keyId: z.string().trim().min(1).max(240),
    keyVersion: z.number().int().safe().positive(),
    scope: z
      .object({
        deploymentId: uuid,
        tenantId: uuid,
        objectClass: encryptedPackageObjectClass
      })
      .strict(),
    provenance: z
      .object({
        rowFamily: z.literal("conversation_source_replication"),
        sourceId: uuid
      })
      .strict(),
    algorithm: z.literal("aes-256-gcm"),
    ciphertext: boundedBase64,
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
        id: uuid,
        version: z.number().int().safe().positive(),
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
    ciphertextLocation: z.literal("conversation_source_replication.payload"),
    aad: z
      .object({
        objectClass: encryptedPackageObjectClass,
        operationId: uuid,
        operationKind: z.enum([
          "register_generation",
          "append_segment",
          "close_generation"
        ]),
        packageId: uuid,
        payloadFormat: z.literal("json"),
        protocol: z.literal(CONVERSATION_SOURCE_REPLICATION_PROTOCOL),
        targetDeploymentId: uuid
      })
      .strict(),
    createdAt: z.iso.datetime({ offset: true }),
    reencryptedAt: z.null()
  })
  .strict();

export const sourceReplicationEncryptedPackageSchema = z
  .object({
    manifest: z
      .object({
        version: z.literal(1),
        packageId: uuid,
        objectClass: encryptedPackageObjectClass,
        payloadFormat: z.literal("json"),
        createdAt: z.iso.datetime({ offset: true }),
        expiresAt: z.null(),
        scope: z
          .object({
            deploymentId: uuid,
            tenantId: uuid,
            objectClass: encryptedPackageObjectClass
          })
          .strict(),
        provenance: z
          .object({
            rowFamily: z.literal("conversation_source_replication"),
            sourceId: uuid
          })
          .strict(),
        payload: z
          .object({
            byteCount: z
              .number()
              .int()
              .positive()
              .max(20 * 1024 * 1024),
            checksumSha256: digest,
            envelopeVersion: z.literal(1),
            providerMode: z.literal("recipient_public_key"),
            keyId: z.string().trim().min(1).max(240),
            keyVersion: z.number().int().safe().positive(),
            algorithm: z.literal("aes-256-gcm"),
            ciphertextLocation: z.literal(
              "conversation_source_replication.payload"
            ),
            encryptedAt: z.iso.datetime({ offset: true }),
            reencryptedAt: z.null()
          })
          .strict(),
        metadata: z
          .object({
            operationKind: z.enum([
              "register_generation",
              "append_segment",
              "close_generation"
            ]),
            protocol: z.literal(CONVERSATION_SOURCE_REPLICATION_PROTOCOL)
          })
          .strict()
      })
      .strict(),
    envelope: encryptedPayloadEnvelopeSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.manifest.packageId !== value.envelope.aad.packageId ||
      value.manifest.objectClass !== value.envelope.scope.objectClass ||
      value.manifest.objectClass !== value.envelope.aad.objectClass ||
      value.manifest.scope.deploymentId !== value.envelope.scope.deploymentId ||
      value.manifest.scope.tenantId !== value.envelope.scope.tenantId ||
      value.manifest.payload.keyId !== value.envelope.keyId ||
      value.manifest.payload.keyVersion !== value.envelope.keyVersion ||
      value.manifest.metadata.operationKind !== value.envelope.aad.operationKind
    ) {
      context.addIssue({
        code: "custom",
        message: "Source replication package bindings do not match"
      });
    }
  });

export const sourceReplicationUploadSchema = z
  .object({
    operationId: uuid,
    requestDigest: digest,
    encryptedPackage: sourceReplicationEncryptedPackageSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operationId !== value.encryptedPackage.envelope.aad.operationId) {
      context.addIssue({
        code: "custom",
        path: ["operationId"],
        message: "Source replication operation identity does not match"
      });
    }
  });

const sourceDescriptorSchema = z
  .object({
    sourceKind: z.literal("codex"),
    logicalSessionId: uuid,
    externalSessionId: z.string().min(1).max(1_024),
    forkedFromExternalThreadId: z.string().min(1).max(1_024).nullable(),
    sourceFingerprint: digest,
    artifactFormat: z.literal("codex_rollout_jsonl"),
    artifactFormatVersion: z.literal(1),
    sourceAdapterVersion: z.literal("codex-transcript-v1"),
    sourceRuntime: z.enum(["codex", "codex-cli"]),
    redactedSourceLabel: z.string().trim().min(1).max(255),
    originDeploymentId: uuid,
    originDeviceId: uuid,
    journalStartOffset: z.number().int().safe().nonnegative(),
    journalStartLine: z.number().int().safe().nonnegative(),
    liveStartOffset: z.number().int().safe().nonnegative(),
    liveStartLine: z.number().int().safe().nonnegative(),
    project: z
      .object({
        id: z
          .string()
          .trim()
          .regex(/^lp_[0-9a-f]{32}$/),
        name: z.string().trim().min(1).max(160)
      })
      .strict()
      .nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.liveStartOffset < value.journalStartOffset ||
      value.liveStartLine < value.journalStartLine
    ) {
      context.addIssue({
        code: "custom",
        message: "Source live boundary precedes its journal boundary"
      });
    }
  });

export const sourceGenerationRegistrationPayloadSchema = z
  .object({
    protocol: z.literal(CONVERSATION_SOURCE_REPLICATION_PROTOCOL),
    operation: z.literal("register_generation"),
    registration: z.record(z.string(), z.unknown()),
    source: sourceDescriptorSchema
  })
  .strict();

export const sourceSegmentPayloadSchema = z
  .object({
    protocol: z.literal(CONVERSATION_SOURCE_REPLICATION_PROTOCOL),
    operation: z.literal("append_segment"),
    segment: z.record(z.string(), z.unknown())
  })
  .strict();

export const sourceClosurePayloadSchema = z
  .object({
    protocol: z.literal(CONVERSATION_SOURCE_REPLICATION_PROTOCOL),
    operation: z.literal("close_generation"),
    closure: z.record(z.string(), z.unknown())
  })
  .strict();

export const personalSourceReplicationPolicySchema = z.discriminatedUnion(
  "enabled",
  [
    z
      .object({
        enabled: z.literal(true),
        targetUpstreamId: z.string().trim().min(1).max(160)
      })
      .strict(),
    z
      .object({
        enabled: z.literal(false)
      })
      .strict()
  ]
);

export const sourceReplicationIntakeContextSchema = z.object({}).strict();

export const sourceDownloadAuthorizationSchema = z
  .object({
    sourceGenerationId: uuid,
    targetDeploymentId: uuid,
    firstSegmentIndex: z.number().int().safe().nonnegative(),
    recipientKey: sourceReplicationRecipientKeySchema
  })
  .strict();

export const sourceDownloadAuthorizationParamsSchema = z
  .object({ authorizationId: uuid })
  .strict();

export const sourceDownloadSegmentsQuerySchema = z
  .object({
    afterSegmentIndex: z.coerce.number().int().safe().min(-1).default(-1),
    limit: z.coerce.number().int().safe().min(1).max(16).default(8)
  })
  .strict();

export const sourceDiscoverySchema = z
  .object({
    cursor: z
      .object({
        updatedAt: z.string().datetime({ offset: true }),
        id: uuid
      })
      .strict()
      .nullable()
      .default(null),
    limit: z.number().int().safe().min(1).max(100).default(50)
  })
  .strict();

export const sourceDiscoveryResultItemSchema = z
  .object({
    sourceGenerationId: uuid,
    redactedSourceLabel: z.string().trim().min(1).max(255),
    sourceRuntime: z.enum(["codex", "codex-cli"]),
    sourceCreatedAt: z.iso.datetime({ offset: true }),
    sourceModifiedAt: z.iso.datetime({ offset: true }).nullable(),
    currentSourceLength: z.number().int().safe().nonnegative(),
    segmentCount: z.number().int().safe().positive()
  })
  .strict();

export const sourceGenerationParamsSchema = z
  .object({ sourceGenerationId: uuid })
  .strict();

export type SourceReplicationEncryptedPackage = z.infer<
  typeof sourceReplicationEncryptedPackageSchema
>;
