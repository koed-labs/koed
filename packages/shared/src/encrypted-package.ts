import { createHash, randomUUID } from "node:crypto";
import {
  decryptEnvelopeToUtf8,
  type EncryptedPayloadEnvelope,
  type EncryptedPayloadScope,
  type EnvelopeEncryptionProvider
} from "./envelope-encryption.js";

export const ENCRYPTED_PACKAGE_MANIFEST_VERSION = 1;

export const encryptedPackageObjectClasses = [
  "support_bundle",
  "memory_export",
  "sync_package",
  "offload_package",
  "object_payload",
  "hosted_backup_archive"
] as const;

export type EncryptedPackageObjectClass =
  (typeof encryptedPackageObjectClasses)[number];

export interface EncryptedPackageManifest {
  version: typeof ENCRYPTED_PACKAGE_MANIFEST_VERSION;
  packageId: string;
  objectClass: EncryptedPackageObjectClass;
  payloadFormat: "json";
  createdAt: string;
  expiresAt: string | null;
  scope: EncryptedPayloadScope;
  provenance: {
    rowFamily: string;
    sourceId?: string | null;
  };
  payload: {
    byteCount: number;
    checksumSha256: string;
    envelopeVersion: EncryptedPayloadEnvelope["version"];
    providerMode: EncryptedPayloadEnvelope["providerMode"];
    keyId: string;
    keyVersion: number;
    algorithm: EncryptedPayloadEnvelope["algorithm"];
    ciphertextLocation: string;
    encryptedAt: string;
    reencryptedAt: string | null;
  };
  metadata: Record<string, string | number | boolean | null>;
}

export interface EncryptedJsonPackage {
  manifest: EncryptedPackageManifest;
  envelope: EncryptedPayloadEnvelope;
}

export interface CreateEncryptedJsonPackageInput {
  objectClass: EncryptedPackageObjectClass;
  payload: unknown;
  scope?: Omit<EncryptedPayloadScope, "objectClass">;
  provenance?: {
    rowFamily?: string;
    sourceId?: string | null;
  };
  ciphertextLocation?: string;
  aad?: Record<string, string | number | boolean | null | undefined>;
  metadata?: Record<string, string | number | boolean | null | undefined>;
  expiresAt?: Date | string | null;
  now?: Date;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const compactMetadata = (
  metadata: Record<string, string | number | boolean | null | undefined>
): Record<string, string | number | boolean | null> =>
  Object.fromEntries(
    Object.entries(metadata).filter(
      (entry): entry is [string, string | number | boolean | null] =>
        entry[1] !== undefined
    )
  );

const unsafeMetadataKeyPattern =
  /(?:^|_)(?:raw|plaintext|ciphertext|secret|token|credential|password|cookie|memory|payload|source_text)(?:_|$)|(?:raw|plain|secret|token|credential|password|cookie).*?(?:text|payload|memory|value)|(?:text|payload|memory|value).*?(?:secret|token|credential|password|cookie)/i;

const assertSafePackageMetadata = (
  metadata: Record<string, string | number | boolean | null | undefined>
): void => {
  for (const [key, value] of Object.entries(metadata)) {
    if (unsafeMetadataKeyPattern.test(key)) {
      throw new Error(`Unsafe encrypted package metadata key: ${key}`);
    }
    if (
      typeof value === "string" &&
      /(?:-----BEGIN |sk-[A-Za-z0-9]|Bearer\s+|Koed-Device\s+)/.test(value)
    ) {
      throw new Error(`Unsafe encrypted package metadata value: ${key}`);
    }
  }
};

export const createEncryptedJsonPackage = async (
  provider: EnvelopeEncryptionProvider,
  input: CreateEncryptedJsonPackageInput
): Promise<EncryptedJsonPackage> => {
  const now = input.now ?? new Date();
  const packageId = randomUUID();
  const plaintext = JSON.stringify(input.payload);
  assertSafePackageMetadata(input.metadata ?? {});
  const ciphertextLocation =
    input.ciphertextLocation ?? `${input.objectClass}.payload`;
  const scope = {
    ...(input.scope ?? {}),
    objectClass: input.objectClass
  } satisfies EncryptedPayloadScope;
  const rowFamily = input.provenance?.rowFamily ?? input.objectClass;
  const envelope = await provider.encrypt({
    plaintext,
    scope,
    provenance: {
      rowFamily,
      sourceId: input.provenance?.sourceId ?? packageId
    },
    ciphertextLocation,
    aad: {
      packageId,
      objectClass: input.objectClass,
      payloadFormat: "json",
      ...(input.aad ?? {})
    },
    now
  });

  return {
    manifest: {
      version: ENCRYPTED_PACKAGE_MANIFEST_VERSION,
      packageId,
      objectClass: input.objectClass,
      payloadFormat: "json",
      createdAt: now.toISOString(),
      expiresAt:
        input.expiresAt instanceof Date
          ? input.expiresAt.toISOString()
          : (input.expiresAt ?? null),
      scope,
      provenance: {
        rowFamily,
        sourceId: input.provenance?.sourceId ?? null
      },
      payload: {
        byteCount: Buffer.byteLength(plaintext, "utf8"),
        checksumSha256: sha256(plaintext),
        envelopeVersion: envelope.version,
        providerMode: envelope.providerMode,
        keyId: envelope.keyId,
        keyVersion: envelope.keyVersion,
        algorithm: envelope.algorithm,
        ciphertextLocation: envelope.ciphertextLocation,
        encryptedAt: envelope.createdAt,
        reencryptedAt: envelope.reencryptedAt
      },
      metadata: compactMetadata(input.metadata ?? {})
    },
    envelope
  };
};

export const decryptEncryptedJsonPackage = async <T = unknown>(
  provider: EnvelopeEncryptionProvider,
  encryptedPackage: EncryptedJsonPackage
): Promise<T> => {
  const plaintext = await decryptEnvelopeToUtf8(
    provider,
    encryptedPackage.envelope
  );
  if (sha256(plaintext) !== encryptedPackage.manifest.payload.checksumSha256) {
    throw new Error("Encrypted package checksum verification failed");
  }
  return JSON.parse(plaintext) as T;
};
