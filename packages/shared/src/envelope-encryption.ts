import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPair,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  type KeyObject
} from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";

export type EnvelopeEncryptionRootProviderMode =
  | "local_test_key"
  | "managed_kms"
  | "operator_kms"
  | "byok"
  | "cmek";

export type EnvelopeEncryptionProviderMode =
  | EnvelopeEncryptionRootProviderMode
  | typeof RECIPIENT_PUBLIC_KEY_PROVIDER_MODE;

export const RECIPIENT_PUBLIC_KEY_PROVIDER_MODE = "recipient_public_key";

export const envelopeEncryptionProviderModes = [
  "local_test_key",
  "managed_kms",
  "operator_kms",
  "byok",
  "cmek"
] as const satisfies readonly EnvelopeEncryptionRootProviderMode[];

export const ENCRYPTED_PAYLOAD_ENVELOPE_VERSION = 1;
export const ENCRYPTED_PAYLOAD_ALGORITHM = "aes-256-gcm";
export const ENCRYPTED_PAYLOAD_KEY_WRAP_ALGORITHM = "aes-256-gcm";
export const ENCRYPTED_PAYLOAD_KMS_KEY_WRAP_ALGORITHM = "kms-wrapped-dek-v1";
export const ENCRYPTED_PAYLOAD_MANAGED_KMS_KEY_WRAP_ALGORITHM =
  ENCRYPTED_PAYLOAD_KMS_KEY_WRAP_ALGORITHM;
export const ENCRYPTED_PAYLOAD_RSA_KEY_WRAP_ALGORITHM = "RSA-OAEP-SHA256";
export const RECIPIENT_RSA_KEY_BITS = 3072;
export const RECIPIENT_RSA_JWK_ALGORITHM = "RSA-OAEP-256";
const LOCAL_TEST_KEY_VERSION = 1;
const LOCAL_TEST_KEY_ID_PREFIX = "local_test_key";
const AES_256_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
export const API_DATA_ENCRYPTION_KEY_ENV = "API_DATA_ENCRYPTION_KEY";
export const DATA_ENCRYPTION_KEY_ENV_ALIAS = "DATA_ENCRYPTION_KEY";
export const OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY_ENV =
  "OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY";
export const OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER_ENV =
  "OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER";
export const OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_ID_ENV =
  "OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_ID";
export const OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_VERSION_ENV =
  "OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_VERSION";
export const OWNER_PRIVATE_REPLICA_MANAGED_KMS_ENDPOINT_URL_ENV =
  "OWNER_PRIVATE_REPLICA_MANAGED_KMS_ENDPOINT_URL";
export const OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN_ENV =
  "OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN";

type Awaitable<T> = T | Promise<T>;

export interface EncryptedPayloadScope {
  deploymentId?: string | null;
  tenantId?: string | null;
  teamId?: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
  objectClass?: string | null;
}

export interface EncryptedPayloadProvenance {
  rowFamily: string;
  sourceTable?: string | null;
  sourceColumn?: string | null;
  sourceId?: string | null;
}

export interface WrappedDataEncryptionKey {
  id: string;
  version: number;
  algorithm:
    | typeof ENCRYPTED_PAYLOAD_KEY_WRAP_ALGORITHM
    | typeof ENCRYPTED_PAYLOAD_MANAGED_KMS_KEY_WRAP_ALGORITHM
    | typeof ENCRYPTED_PAYLOAD_RSA_KEY_WRAP_ALGORITHM;
  ciphertext: string;
  nonce: string;
  tag: string;
}

export interface EncryptedPayloadEnvelope {
  version: typeof ENCRYPTED_PAYLOAD_ENVELOPE_VERSION;
  providerMode: EnvelopeEncryptionProviderMode;
  keyId: string;
  keyVersion: number;
  scope: EncryptedPayloadScope;
  provenance: EncryptedPayloadProvenance;
  algorithm: typeof ENCRYPTED_PAYLOAD_ALGORITHM;
  ciphertext: string;
  nonce: string;
  tag: string;
  wrappedDek: WrappedDataEncryptionKey;
  ciphertextLocation: string;
  aad: Record<string, string>;
  createdAt: string;
  reencryptedAt: string | null;
}

export interface EncryptPayloadInput {
  plaintext: string | Uint8Array;
  scope: EncryptedPayloadScope;
  provenance: EncryptedPayloadProvenance;
  ciphertextLocation: string;
  aad?: Record<string, string | number | boolean | null | undefined>;
  now?: Date;
}

export interface RecipientPublicKeyMaterial {
  algorithm: typeof ENCRYPTED_PAYLOAD_RSA_KEY_WRAP_ALGORITHM;
  keyId: string;
  keyVersion: number;
  publicJwk: RecipientPublicJwk;
}

export interface RecipientPublicJwk extends JsonWebKey {
  alg: typeof RECIPIENT_RSA_JWK_ALGORITHM;
  ext: true;
  key_ops: ["encrypt"];
  kid: string;
  kty: "RSA";
  use: "enc";
  e: string;
  n: string;
}

interface RecipientPrivateJwk extends JsonWebKey {
  alg: typeof RECIPIENT_RSA_JWK_ALGORITHM;
  ext: true;
  key_ops: ["decrypt"];
  kid: string;
  kty: "RSA";
  use: "enc";
  d: string;
  e: string;
  n: string;
}

export interface RecipientKeyMaterial extends RecipientPublicKeyMaterial {
  encryptedPrivateKey: EncryptedPayloadEnvelope;
}

export interface GenerateRecipientKeyMaterialInput {
  keyId: string;
  keyVersion: number;
  scope?: EncryptedPayloadScope;
  provenance?: EncryptedPayloadProvenance;
  ciphertextLocation?: string;
  now?: Date;
}

export interface EnvelopeEncryptionProvider {
  readonly mode: EnvelopeEncryptionProviderMode;
  readonly keyId: string;
  readonly keyVersion: number;
  encrypt(input: EncryptPayloadInput): Awaitable<EncryptedPayloadEnvelope>;
  decrypt(envelope: EncryptedPayloadEnvelope): Awaitable<Uint8Array>;
  rewrap?(
    envelope: EncryptedPayloadEnvelope,
    input?: { now?: Date }
  ): Awaitable<EncryptedPayloadEnvelope>;
  status?(): Awaitable<EnvelopeEncryptionProviderStatus>;
}

export interface EnvelopeEncryptionProviderStatus {
  mode: EnvelopeEncryptionProviderMode;
  keyId: string;
  keyVersion: number;
  status: "configured" | "available" | "degraded" | "unavailable";
  details?: Record<string, string | number | boolean | null>;
}

export interface ManagedKmsWrapDekInput {
  keyId: string;
  keyVersion: number;
  wrappedDekId: string;
  wrappedDekVersion: number;
  dek: Uint8Array;
  aad: Uint8Array;
}

export interface ManagedKmsUnwrapDekInput {
  keyId: string;
  keyVersion: number;
  wrappedDek: WrappedDataEncryptionKey;
  aad: Uint8Array;
}

export interface ManagedKmsWrappedDek {
  ciphertext: string;
  nonce?: string;
  tag?: string;
  algorithm?: typeof ENCRYPTED_PAYLOAD_KMS_KEY_WRAP_ALGORITHM;
}

export interface ManagedKmsKeyring {
  readonly keyId: string;
  readonly keyVersion: number;
  wrapDek(input: ManagedKmsWrapDekInput): Awaitable<ManagedKmsWrappedDek>;
  unwrapDek(input: ManagedKmsUnwrapDekInput): Awaitable<Uint8Array>;
  status?(): Awaitable<EnvelopeEncryptionProviderStatus>;
}

export interface HttpManagedKmsKeyringConfig {
  keyId: string;
  keyVersion: number;
  endpointUrl: string;
  authToken: string;
  fetch?: typeof fetch;
  endpointEnvironmentName?: string;
  authTokenEnvironmentName?: string;
}

export interface EnvelopeEncryptionProviderEnvironmentOptions {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  required?: boolean;
}

export interface EnvelopeEncryptionEnvironmentValidationOptions {
  environment?: NodeJS.ProcessEnv;
}

export class EnvelopeEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeEncryptionError";
  }
}

export class UnsupportedEnvelopeEncryptionProviderError extends EnvelopeEncryptionError {
  constructor(mode: EnvelopeEncryptionProviderMode | string) {
    super(`Envelope encryption provider is not implemented: ${mode}`);
    this.name = "UnsupportedEnvelopeEncryptionProviderError";
  }
}

export class InvalidEncryptedPayloadEnvelopeError extends EnvelopeEncryptionError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEncryptedPayloadEnvelopeError";
  }
}

export class ManagedKmsProviderError extends EnvelopeEncryptionError {
  constructor(message: string) {
    super(message);
    this.name = "ManagedKmsProviderError";
  }
}

export class RecipientKeyTransportError extends EnvelopeEncryptionError {
  constructor(message: string) {
    super(message);
    this.name = "RecipientKeyTransportError";
  }
}

const optionalEnvValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const resolveApiDataEncryptionKeyFromEnv = (
  environment: NodeJS.ProcessEnv = process.env
): string | undefined =>
  optionalEnvValue(environment[API_DATA_ENCRYPTION_KEY_ENV]) ??
  optionalEnvValue(environment[DATA_ENCRYPTION_KEY_ENV_ALIAS]);

export const requireApiDataEncryptionKey = (
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const key = resolveApiDataEncryptionKeyFromEnv(environment);
  if (!key) {
    throw new Error(
      `Missing required environment variable: ${API_DATA_ENCRYPTION_KEY_ENV} (or ${DATA_ENCRYPTION_KEY_ENV_ALIAS})`
    );
  }
  return key;
};

export const createUnsupportedEnvelopeEncryptionProvider = (
  mode: Exclude<EnvelopeEncryptionRootProviderMode, "local_test_key">
): EnvelopeEncryptionProvider => ({
  mode,
  keyId: `${mode}:unconfigured`,
  keyVersion: 0,
  encrypt(): EncryptedPayloadEnvelope {
    throw new UnsupportedEnvelopeEncryptionProviderError(mode);
  },
  decrypt(): Uint8Array {
    throw new UnsupportedEnvelopeEncryptionProviderError(mode);
  }
});

const providerModeFromString = (
  value: string | undefined,
  environmentName = "API_ENVELOPE_ENCRYPTION_PROVIDER"
): EnvelopeEncryptionRootProviderMode | undefined => {
  const normalized = optionalEnvValue(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (
    envelopeEncryptionProviderModes.includes(
      normalized as EnvelopeEncryptionRootProviderMode
    )
  ) {
    return normalized as EnvelopeEncryptionRootProviderMode;
  }
  throw new EnvelopeEncryptionError(`Unsupported ${environmentName}: ${value}`);
};

const positiveInt = (value: string | undefined, name: string): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new EnvelopeEncryptionError(`${name} must be a positive integer`);
  }
  return parsed;
};

const normalizedEnv = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback = ""
): string => (environment[name]?.trim() || fallback).toLowerCase();

const kmsBackedProviderModes = new Set<EnvelopeEncryptionRootProviderMode>([
  "managed_kms",
  "byok",
  "cmek"
]);

const base64Encode = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64");

const base64Decode = (value: string, fieldName: string): Buffer => {
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 0 && value.trim() !== "") {
      throw new Error("empty decode");
    }
    return decoded;
  } catch {
    throw new InvalidEncryptedPayloadEnvelopeError(
      `${fieldName} must be base64 encoded`
    );
  }
};

const assertSafeManagedKmsEndpoint = (
  url: URL,
  environmentName = "MANAGED_KMS_ENDPOINT_URL"
): void => {
  if (url.protocol === "https:") {
    return;
  }
  if (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  ) {
    return;
  }
  throw new ManagedKmsProviderError(
    `${environmentName} must use HTTPS unless it targets localhost`
  );
};

const rootKeyFromBase64 = (
  value: string,
  environmentName = API_DATA_ENCRYPTION_KEY_ENV
): Buffer => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("replace_with_generated")) {
    throw new EnvelopeEncryptionError(
      `${environmentName} must be a generated base64 32-byte key`
    );
  }
  const key = base64Decode(trimmed, environmentName);
  if (key.length !== AES_256_KEY_BYTES) {
    throw new EnvelopeEncryptionError(
      `${environmentName} must decode to exactly 32 bytes`
    );
  }
  return key;
};

const localTestKeyId = (rootKey: Uint8Array): string => {
  const fingerprint = createHash("sha256")
    .update(rootKey)
    .digest("base64url")
    .slice(0, 22);
  return `${LOCAL_TEST_KEY_ID_PREFIX}:${fingerprint}`;
};

const normalizeAad = (
  aad: EncryptPayloadInput["aad"] | Record<string, string>
): Record<string, string> => {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(aad ?? {})) {
    if (value !== undefined && value !== null) {
      normalized[key] = String(value);
    }
  }
  return Object.fromEntries(
    Object.entries(normalized).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
};

const payloadAad = (envelope: {
  version: number;
  scope: EncryptedPayloadScope;
  provenance: EncryptedPayloadProvenance;
  algorithm: string;
  ciphertextLocation: string;
  aad: Record<string, string>;
  createdAt: string;
}): Buffer =>
  Buffer.from(
    canonicalJsonStringify({
      version: envelope.version,
      scope: envelope.scope,
      provenance: envelope.provenance,
      algorithm: envelope.algorithm,
      ciphertextLocation: envelope.ciphertextLocation,
      aad: envelope.aad,
      createdAt: envelope.createdAt
    }),
    "utf8"
  );

const wrappedDekAad = (input: {
  providerMode: EnvelopeEncryptionProviderMode;
  keyId: string;
  keyVersion: number;
  wrappedDekId: string;
  wrappedDekVersion: number;
}): Buffer => Buffer.from(canonicalJsonStringify(input), "utf8");

const encryptAesGcm = (
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array
): { ciphertext: Buffer; nonce: Buffer; tag: Buffer } => {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv(ENCRYPTED_PAYLOAD_ALGORITHM, key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, nonce, tag };
};

const decryptAesGcm = (
  key: Uint8Array,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array
): Buffer => {
  if (key.byteLength !== AES_256_KEY_BYTES) {
    throw new InvalidEncryptedPayloadEnvelopeError(
      "Encrypted payload key must be 32 bytes"
    );
  }
  if (nonce.byteLength !== GCM_NONCE_BYTES) {
    throw new InvalidEncryptedPayloadEnvelopeError(
      "Encrypted payload nonce must be 12 bytes"
    );
  }
  if (tag.byteLength !== GCM_TAG_BYTES) {
    throw new InvalidEncryptedPayloadEnvelopeError(
      "Encrypted payload authentication tag must be 16 bytes"
    );
  }
  try {
    const decipher = createDecipheriv(ENCRYPTED_PAYLOAD_ALGORITHM, key, nonce, {
      authTagLength: GCM_TAG_BYTES
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new InvalidEncryptedPayloadEnvelopeError(
      "Encrypted payload authentication failed"
    );
  }
};

const assertSameProvider = (
  envelope: EncryptedPayloadEnvelope,
  provider: Pick<EnvelopeEncryptionProvider, "mode" | "keyId" | "keyVersion">
): void => {
  if (envelope.providerMode !== provider.mode) {
    throw new InvalidEncryptedPayloadEnvelopeError(
      `Envelope provider mismatch: ${envelope.providerMode}`
    );
  }
  if (envelope.keyVersion !== provider.keyVersion) {
    throw new InvalidEncryptedPayloadEnvelopeError(
      `Envelope key version mismatch: ${envelope.keyVersion}`
    );
  }
  const storedKeyId = Buffer.from(envelope.keyId, "utf8");
  const providerKeyId = Buffer.from(provider.keyId, "utf8");
  if (
    storedKeyId.length !== providerKeyId.length ||
    !timingSafeEqual(storedKeyId, providerKeyId)
  ) {
    throw new InvalidEncryptedPayloadEnvelopeError("Envelope key id mismatch");
  }
};

const validateEnvelope = (envelope: EncryptedPayloadEnvelope): void => {
  if (envelope.version !== ENCRYPTED_PAYLOAD_ENVELOPE_VERSION) {
    throw new InvalidEncryptedPayloadEnvelopeError(
      `Unsupported encrypted payload envelope version: ${envelope.version}`
    );
  }
  if (envelope.algorithm !== ENCRYPTED_PAYLOAD_ALGORITHM) {
    throw new InvalidEncryptedPayloadEnvelopeError(
      `Unsupported encrypted payload algorithm: ${envelope.algorithm}`
    );
  }
  if (
    envelope.wrappedDek.algorithm !== ENCRYPTED_PAYLOAD_KEY_WRAP_ALGORITHM &&
    envelope.wrappedDek.algorithm !==
      ENCRYPTED_PAYLOAD_MANAGED_KMS_KEY_WRAP_ALGORITHM &&
    envelope.wrappedDek.algorithm !== ENCRYPTED_PAYLOAD_RSA_KEY_WRAP_ALGORITHM
  ) {
    throw new InvalidEncryptedPayloadEnvelopeError(
      `Unsupported wrapped DEK algorithm: ${envelope.wrappedDek.algorithm}`
    );
  }
  if (!envelope.provenance.rowFamily.trim()) {
    throw new InvalidEncryptedPayloadEnvelopeError(
      "Encrypted payload provenance rowFamily is required"
    );
  }
  if (!envelope.ciphertextLocation.trim()) {
    throw new InvalidEncryptedPayloadEnvelopeError(
      "Encrypted payload ciphertextLocation is required"
    );
  }
};

export const createLocalTestKeyEnvelopeEncryptionProvider = (
  apiDataEncryptionKey: string,
  environmentName = API_DATA_ENCRYPTION_KEY_ENV
): EnvelopeEncryptionProvider => {
  const rootKey = rootKeyFromBase64(apiDataEncryptionKey, environmentName);
  const provider = {
    mode: "local_test_key" as const,
    keyId: localTestKeyId(rootKey),
    keyVersion: LOCAL_TEST_KEY_VERSION
  };
  const wrapDek = (
    dek: Uint8Array,
    wrappedDekMetadata: Pick<
      WrappedDataEncryptionKey,
      "id" | "version" | "algorithm"
    >
  ): WrappedDataEncryptionKey => {
    const wrappedDek = encryptAesGcm(
      rootKey,
      dek,
      wrappedDekAad({
        providerMode: provider.mode,
        keyId: provider.keyId,
        keyVersion: provider.keyVersion,
        wrappedDekId: wrappedDekMetadata.id,
        wrappedDekVersion: wrappedDekMetadata.version
      })
    );
    return {
      ...wrappedDekMetadata,
      ciphertext: base64Encode(wrappedDek.ciphertext),
      nonce: base64Encode(wrappedDek.nonce),
      tag: base64Encode(wrappedDek.tag)
    };
  };
  const unwrapDek = (envelope: EncryptedPayloadEnvelope): Buffer => {
    const wrappedDekAadBytes = wrappedDekAad({
      providerMode: provider.mode,
      keyId: provider.keyId,
      keyVersion: envelope.keyVersion,
      wrappedDekId: envelope.wrappedDek.id,
      wrappedDekVersion: envelope.wrappedDek.version
    });
    return decryptAesGcm(
      rootKey,
      base64Decode(envelope.wrappedDek.ciphertext, "wrappedDek.ciphertext"),
      base64Decode(envelope.wrappedDek.nonce, "wrappedDek.nonce"),
      base64Decode(envelope.wrappedDek.tag, "wrappedDek.tag"),
      wrappedDekAadBytes
    );
  };

  return {
    ...provider,
    encrypt(input: EncryptPayloadInput): EncryptedPayloadEnvelope {
      const plaintext =
        typeof input.plaintext === "string"
          ? Buffer.from(input.plaintext, "utf8")
          : Buffer.from(input.plaintext);
      const createdAt = (input.now ?? new Date()).toISOString();
      const wrappedDekId = randomUUID();
      const wrappedDekVersion = 1;
      const dek = randomBytes(AES_256_KEY_BYTES);
      const wrappedDekMetadata: Pick<
        WrappedDataEncryptionKey,
        "id" | "version" | "algorithm"
      > = {
        id: wrappedDekId,
        version: wrappedDekVersion,
        algorithm: ENCRYPTED_PAYLOAD_KEY_WRAP_ALGORITHM
      };
      const envelopeMetadata: Omit<
        EncryptedPayloadEnvelope,
        "ciphertext" | "nonce" | "tag" | "wrappedDek"
      > & {
        wrappedDek: Pick<
          WrappedDataEncryptionKey,
          "id" | "version" | "algorithm"
        >;
      } = {
        version: ENCRYPTED_PAYLOAD_ENVELOPE_VERSION,
        providerMode: provider.mode,
        keyId: provider.keyId,
        keyVersion: provider.keyVersion,
        scope: input.scope,
        provenance: input.provenance,
        algorithm: ENCRYPTED_PAYLOAD_ALGORITHM,
        wrappedDek: wrappedDekMetadata,
        ciphertextLocation: input.ciphertextLocation,
        aad: normalizeAad(input.aad),
        createdAt,
        reencryptedAt: null
      };
      const payload = encryptAesGcm(
        dek,
        plaintext,
        payloadAad(envelopeMetadata)
      );

      return {
        ...envelopeMetadata,
        ciphertext: base64Encode(payload.ciphertext),
        nonce: base64Encode(payload.nonce),
        tag: base64Encode(payload.tag),
        wrappedDek: wrapDek(dek, wrappedDekMetadata)
      };
    },
    decrypt(envelope: EncryptedPayloadEnvelope): Uint8Array {
      validateEnvelope(envelope);
      assertSameProvider(envelope, provider);
      const dek = unwrapDek(envelope);
      return decryptAesGcm(
        dek,
        base64Decode(envelope.ciphertext, "ciphertext"),
        base64Decode(envelope.nonce, "nonce"),
        base64Decode(envelope.tag, "tag"),
        payloadAad({
          version: envelope.version,
          scope: envelope.scope,
          provenance: envelope.provenance,
          algorithm: envelope.algorithm,
          ciphertextLocation: envelope.ciphertextLocation,
          aad: envelope.aad,
          createdAt: envelope.createdAt
        })
      );
    },
    rewrap(envelope, input) {
      validateEnvelope(envelope);
      assertSameProvider(envelope, provider);
      const dek = unwrapDek(envelope);
      return {
        ...envelope,
        keyVersion: provider.keyVersion,
        wrappedDek: wrapDek(dek, {
          id: envelope.wrappedDek.id,
          version: envelope.wrappedDek.version + 1,
          algorithm: ENCRYPTED_PAYLOAD_KEY_WRAP_ALGORITHM
        }),
        reencryptedAt: (input?.now ?? new Date()).toISOString()
      };
    },
    status() {
      return {
        mode: provider.mode,
        keyId: provider.keyId,
        keyVersion: provider.keyVersion,
        status: "available" as const
      };
    }
  };
};

const recipientKeyMetadataAad = (material: RecipientPublicKeyMaterial) => ({
  recipientKeyAlgorithm: material.algorithm,
  recipientKeyId: material.keyId,
  recipientKeyVersion: material.keyVersion,
  recipientPublicKeyFingerprint: createHash("sha256")
    .update(
      canonicalJsonStringify({
        kty: material.publicJwk.kty,
        n: material.publicJwk.n,
        e: material.publicJwk.e
      })
    )
    .digest("base64url")
});

const recipientWrappedDekAad = (input: {
  keyId: string;
  keyVersion: number;
  wrappedDekId: string;
  wrappedDekVersion: number;
}): Buffer =>
  Buffer.from(
    canonicalJsonStringify({
      providerMode: RECIPIENT_PUBLIC_KEY_PROVIDER_MODE,
      keyId: input.keyId,
      keyVersion: input.keyVersion,
      wrappedDekId: input.wrappedDekId,
      wrappedDekVersion: input.wrappedDekVersion,
      algorithm: ENCRYPTED_PAYLOAD_RSA_KEY_WRAP_ALGORITHM
    }),
    "utf8"
  );

const assertRecipientKeyMetadata = (
  material: Pick<
    RecipientPublicKeyMaterial,
    "algorithm" | "keyId" | "keyVersion"
  >
): void => {
  if (material.algorithm !== ENCRYPTED_PAYLOAD_RSA_KEY_WRAP_ALGORITHM) {
    throw new RecipientKeyTransportError(
      `Unsupported recipient key algorithm: ${material.algorithm}`
    );
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(material.keyId) ||
    material.keyId.trim() !== material.keyId
  ) {
    throw new RecipientKeyTransportError(
      "Recipient keyId must be 1-255 safe identifier characters"
    );
  }
  if (!Number.isSafeInteger(material.keyVersion) || material.keyVersion <= 0) {
    throw new RecipientKeyTransportError(
      "Recipient keyVersion must be a positive safe integer"
    );
  }
};

const recipientPublicKeyObject = (
  material: RecipientPublicKeyMaterial
): KeyObject => {
  assertRecipientKeyMetadata(material);
  const jwk = material.publicJwk;
  if (
    jwk.kty !== "RSA" ||
    jwk.alg !== RECIPIENT_RSA_JWK_ALGORITHM ||
    jwk.use !== "enc" ||
    jwk.ext !== true ||
    jwk.kid !== material.keyId ||
    !jwk.key_ops?.includes("encrypt") ||
    !jwk.n ||
    !jwk.e ||
    jwk.d !== undefined
  ) {
    throw new RecipientKeyTransportError(
      "Recipient public JWK must be an encrypt-only RSA-OAEP-256 key matching keyId"
    );
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    throw new RecipientKeyTransportError("Recipient public JWK is invalid");
  }
  if (
    publicKey.asymmetricKeyType !== "rsa" ||
    publicKey.asymmetricKeyDetails?.modulusLength !== RECIPIENT_RSA_KEY_BITS
  ) {
    throw new RecipientKeyTransportError(
      `Recipient public JWK must use RSA ${RECIPIENT_RSA_KEY_BITS}`
    );
  }
  return publicKey;
};

const clonePublicJwk = (jwk: RecipientPublicJwk): RecipientPublicJwk => ({
  ...jwk,
  ...(jwk.key_ops ? { key_ops: [...jwk.key_ops] } : {})
});

export const toRecipientPublicKeyMaterial = (
  material: RecipientKeyMaterial
): RecipientPublicKeyMaterial => {
  recipientPublicKeyObject(material);
  return {
    algorithm: material.algorithm,
    keyId: material.keyId,
    keyVersion: material.keyVersion,
    publicJwk: clonePublicJwk(material.publicJwk)
  };
};

const generateRecipientRsaKeyPair = (): Promise<{
  publicKey: KeyObject;
  privateKey: KeyObject;
}> =>
  new Promise((resolve, reject) => {
    generateKeyPair(
      "rsa",
      { modulusLength: RECIPIENT_RSA_KEY_BITS, publicExponent: 0x10001 },
      (error, publicKey, privateKey) => {
        if (error) {
          reject(
            new RecipientKeyTransportError(
              "Recipient RSA key generation failed"
            )
          );
          return;
        }
        resolve({ publicKey, privateKey });
      }
    );
  });

export const generateRecipientKeyMaterial = async (
  rootProvider: EnvelopeEncryptionProvider,
  input: GenerateRecipientKeyMaterialInput
): Promise<RecipientKeyMaterial> => {
  if (
    !envelopeEncryptionProviderModes.includes(
      rootProvider.mode as EnvelopeEncryptionRootProviderMode
    )
  ) {
    throw new RecipientKeyTransportError(
      "Recipient private key material requires a root envelope encryption provider"
    );
  }
  const metadata = {
    algorithm: ENCRYPTED_PAYLOAD_RSA_KEY_WRAP_ALGORITHM,
    keyId: input.keyId,
    keyVersion: input.keyVersion
  } as const;
  assertRecipientKeyMetadata(metadata);

  const { publicKey, privateKey } = await generateRecipientRsaKeyPair();
  const publicJwk = {
    ...publicKey.export({ format: "jwk" }),
    alg: RECIPIENT_RSA_JWK_ALGORITHM,
    ext: true,
    key_ops: ["encrypt"],
    kid: input.keyId,
    use: "enc"
  } as RecipientPublicJwk;
  const privateJwk = {
    ...privateKey.export({ format: "jwk" }),
    alg: RECIPIENT_RSA_JWK_ALGORITHM,
    ext: true,
    key_ops: ["decrypt"],
    kid: input.keyId,
    use: "enc"
  } as RecipientPrivateJwk;
  const publicMaterial: RecipientPublicKeyMaterial = {
    ...metadata,
    publicJwk
  };
  recipientPublicKeyObject(publicMaterial);
  const encryptedPrivateKey = await rootProvider.encrypt({
    plaintext: JSON.stringify(privateJwk),
    scope: {
      ...input.scope,
      objectClass: input.scope?.objectClass ?? "recipient_key_material"
    },
    provenance: input.provenance ?? { rowFamily: "recipient_key_material" },
    ciphertextLocation:
      input.ciphertextLocation ??
      "recipient_key_material.encrypted_private_key",
    aad: recipientKeyMetadataAad(publicMaterial),
    ...(input.now ? { now: input.now } : {})
  });

  return { ...publicMaterial, encryptedPrivateKey };
};

const createRecipientProvider = (
  material: RecipientPublicKeyMaterial,
  privateKey?: KeyObject
): EnvelopeEncryptionProvider => {
  const publicKey = recipientPublicKeyObject(material);
  const provider = {
    mode: RECIPIENT_PUBLIC_KEY_PROVIDER_MODE,
    keyId: material.keyId,
    keyVersion: material.keyVersion
  } as const;

  return {
    ...provider,
    encrypt(input): EncryptedPayloadEnvelope {
      const plaintext =
        typeof input.plaintext === "string"
          ? Buffer.from(input.plaintext, "utf8")
          : Buffer.from(input.plaintext);
      const createdAt = (input.now ?? new Date()).toISOString();
      const wrappedDekId = randomUUID();
      const wrappedDekVersion = 1;
      const dek = randomBytes(AES_256_KEY_BYTES);
      const wrappedDekMetadata = {
        id: wrappedDekId,
        version: wrappedDekVersion,
        algorithm: ENCRYPTED_PAYLOAD_RSA_KEY_WRAP_ALGORITHM
      } as const;
      const envelopeMetadata = {
        version: ENCRYPTED_PAYLOAD_ENVELOPE_VERSION,
        providerMode: provider.mode,
        keyId: provider.keyId,
        keyVersion: provider.keyVersion,
        scope: input.scope,
        provenance: input.provenance,
        algorithm: ENCRYPTED_PAYLOAD_ALGORITHM,
        wrappedDek: wrappedDekMetadata,
        ciphertextLocation: input.ciphertextLocation,
        aad: normalizeAad(input.aad),
        createdAt,
        reencryptedAt: null
      } as const;
      const payload = encryptAesGcm(
        dek,
        plaintext,
        payloadAad(envelopeMetadata)
      );
      const wrappedDek = publicEncrypt(
        {
          key: publicKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
          oaepLabel: recipientWrappedDekAad({
            keyId: provider.keyId,
            keyVersion: provider.keyVersion,
            wrappedDekId,
            wrappedDekVersion
          })
        },
        dek
      );

      return {
        ...envelopeMetadata,
        ciphertext: base64Encode(payload.ciphertext),
        nonce: base64Encode(payload.nonce),
        tag: base64Encode(payload.tag),
        wrappedDek: {
          ...wrappedDekMetadata,
          ciphertext: base64Encode(wrappedDek),
          nonce: "",
          tag: ""
        }
      };
    },
    decrypt(envelope): Uint8Array {
      if (!privateKey) {
        throw new RecipientKeyTransportError(
          "Recipient public-key provider is encrypt-only"
        );
      }
      validateEnvelope(envelope);
      assertSameProvider(envelope, provider);
      if (
        envelope.wrappedDek.algorithm !==
        ENCRYPTED_PAYLOAD_RSA_KEY_WRAP_ALGORITHM
      ) {
        throw new InvalidEncryptedPayloadEnvelopeError(
          `Unsupported recipient wrapped DEK algorithm: ${envelope.wrappedDek.algorithm}`
        );
      }
      let dek: Buffer;
      try {
        dek = privateDecrypt(
          {
            key: privateKey,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
            oaepLabel: recipientWrappedDekAad({
              keyId: provider.keyId,
              keyVersion: envelope.keyVersion,
              wrappedDekId: envelope.wrappedDek.id,
              wrappedDekVersion: envelope.wrappedDek.version
            })
          },
          base64Decode(envelope.wrappedDek.ciphertext, "wrappedDek.ciphertext")
        );
      } catch (error) {
        if (error instanceof EnvelopeEncryptionError) {
          throw error;
        }
        throw new InvalidEncryptedPayloadEnvelopeError(
          "Recipient wrapped DEK authentication failed"
        );
      }
      if (dek.length !== AES_256_KEY_BYTES) {
        throw new InvalidEncryptedPayloadEnvelopeError(
          "Recipient wrapped DEK has an invalid length"
        );
      }
      return decryptAesGcm(
        dek,
        base64Decode(envelope.ciphertext, "ciphertext"),
        base64Decode(envelope.nonce, "nonce"),
        base64Decode(envelope.tag, "tag"),
        payloadAad(envelope)
      );
    },
    status() {
      return {
        ...provider,
        status: "available" as const,
        details: { decryptCapable: privateKey !== undefined }
      };
    }
  };
};

export const createRecipientPublicKeyEnvelopeEncryptionProvider = (
  material: RecipientPublicKeyMaterial
): EnvelopeEncryptionProvider => createRecipientProvider(material);

const recipientPrivateKeyObject = (
  privateJwk: RecipientPrivateJwk,
  publicMaterial: RecipientPublicKeyMaterial
): KeyObject => {
  if (
    privateJwk.kty !== "RSA" ||
    privateJwk.alg !== RECIPIENT_RSA_JWK_ALGORITHM ||
    privateJwk.use !== "enc" ||
    privateJwk.ext !== true ||
    privateJwk.kid !== publicMaterial.keyId ||
    !privateJwk.key_ops?.includes("decrypt") ||
    !privateJwk.n ||
    !privateJwk.e ||
    !privateJwk.d
  ) {
    throw new RecipientKeyTransportError(
      "Decrypted recipient private JWK is invalid or does not match key metadata"
    );
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
  } catch {
    throw new RecipientKeyTransportError(
      "Decrypted recipient private JWK is invalid"
    );
  }
  if (
    privateKey.asymmetricKeyType !== "rsa" ||
    privateKey.asymmetricKeyDetails?.modulusLength !== RECIPIENT_RSA_KEY_BITS
  ) {
    throw new RecipientKeyTransportError(
      `Decrypted recipient private JWK must use RSA ${RECIPIENT_RSA_KEY_BITS}`
    );
  }
  const derivedPublicJwk = createPublicKey(privateKey).export({
    format: "jwk"
  });
  if (
    derivedPublicJwk.n !== publicMaterial.publicJwk.n ||
    derivedPublicJwk.e !== publicMaterial.publicJwk.e
  ) {
    throw new RecipientKeyTransportError(
      "Decrypted recipient private JWK does not match the public JWK"
    );
  }
  return privateKey;
};

export const createRecipientPrivateKeyEnvelopeEncryptionProvider = async (
  rootProvider: EnvelopeEncryptionProvider,
  material: RecipientKeyMaterial
): Promise<EnvelopeEncryptionProvider> => {
  if (
    !envelopeEncryptionProviderModes.includes(
      rootProvider.mode as EnvelopeEncryptionRootProviderMode
    )
  ) {
    throw new RecipientKeyTransportError(
      "Recipient private key material requires a root envelope encryption provider"
    );
  }
  const publicMaterial = toRecipientPublicKeyMaterial(material);
  const expectedAad = normalizeAad(recipientKeyMetadataAad(publicMaterial));
  if (
    canonicalJsonStringify(material.encryptedPrivateKey.aad) !==
    canonicalJsonStringify(expectedAad)
  ) {
    throw new RecipientKeyTransportError(
      "Encrypted recipient private key metadata does not match the public key"
    );
  }
  let parsed: unknown;
  try {
    const plaintext = await rootProvider.decrypt(material.encryptedPrivateKey);
    parsed = JSON.parse(Buffer.from(plaintext).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof EnvelopeEncryptionError) {
      throw error;
    }
    throw new RecipientKeyTransportError(
      "Recipient private key envelope could not be decrypted"
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RecipientKeyTransportError(
      "Decrypted recipient private key material is invalid"
    );
  }
  const privateKey = recipientPrivateKeyObject(
    parsed as RecipientPrivateJwk,
    publicMaterial
  );
  return createRecipientProvider(publicMaterial, privateKey);
};

const assertManagedKmsProviderEnvelope = (
  envelope: EncryptedPayloadEnvelope,
  provider: Pick<EnvelopeEncryptionProvider, "mode" | "keyId">
): void => {
  if (envelope.providerMode !== provider.mode) {
    throw new InvalidEncryptedPayloadEnvelopeError(
      `Envelope provider mismatch: ${envelope.providerMode}`
    );
  }
  const storedKeyId = Buffer.from(envelope.keyId, "utf8");
  const providerKeyId = Buffer.from(provider.keyId, "utf8");
  if (
    storedKeyId.length !== providerKeyId.length ||
    !timingSafeEqual(storedKeyId, providerKeyId)
  ) {
    throw new InvalidEncryptedPayloadEnvelopeError("Envelope key id mismatch");
  }
};

const managedKmsJson = async (
  fetchFn: typeof fetch,
  endpoint: URL,
  authToken: string,
  operation: "wrap" | "unwrap",
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> => {
  const response = await fetchFn(new URL(operation, endpoint), {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new ManagedKmsProviderError(
      `managed_kms ${operation} failed with status ${response.status}`
    );
  }
  const body = (await response.json()) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ManagedKmsProviderError(
      `managed_kms ${operation} returned an invalid response`
    );
  }
  return body as Record<string, unknown>;
};

const requiredString = (
  body: Record<string, unknown>,
  fieldName: string
): string => {
  const value = body[fieldName];
  if (typeof value !== "string" || !value.trim()) {
    throw new ManagedKmsProviderError(
      `managed_kms response is missing ${fieldName}`
    );
  }
  return value;
};

export const createHttpManagedKmsKeyring = (
  config: HttpManagedKmsKeyringConfig
): ManagedKmsKeyring => {
  const endpoint = new URL(config.endpointUrl);
  assertSafeManagedKmsEndpoint(
    endpoint,
    config.endpointEnvironmentName ?? "MANAGED_KMS_ENDPOINT_URL"
  );
  if (!config.authToken.trim()) {
    throw new ManagedKmsProviderError(
      `${config.authTokenEnvironmentName ?? "MANAGED_KMS_AUTH_TOKEN"} is required`
    );
  }
  const fetchFn = config.fetch ?? globalThis.fetch;
  if (!fetchFn) {
    throw new ManagedKmsProviderError("fetch is unavailable for managed_kms");
  }
  return {
    keyId: config.keyId,
    keyVersion: config.keyVersion,
    async wrapDek(input) {
      const body = await managedKmsJson(
        fetchFn,
        endpoint,
        config.authToken,
        "wrap",
        {
          keyId: input.keyId,
          keyVersion: input.keyVersion,
          wrappedDekId: input.wrappedDekId,
          wrappedDekVersion: input.wrappedDekVersion,
          dek: base64Encode(input.dek),
          aad: base64Encode(input.aad)
        }
      );
      return {
        ciphertext: requiredString(body, "ciphertext"),
        nonce: typeof body.nonce === "string" ? body.nonce : undefined,
        tag: typeof body.tag === "string" ? body.tag : undefined
      };
    },
    async unwrapDek(input) {
      const body = await managedKmsJson(
        fetchFn,
        endpoint,
        config.authToken,
        "unwrap",
        {
          keyId: input.keyId,
          keyVersion: input.keyVersion,
          wrappedDek: input.wrappedDek,
          aad: base64Encode(input.aad)
        }
      );
      return base64Decode(requiredString(body, "dek"), "managed_kms.dek");
    },
    status() {
      return {
        mode: "managed_kms",
        keyId: config.keyId,
        keyVersion: config.keyVersion,
        status: "configured" as const,
        details: {
          endpointOrigin: endpoint.origin
        }
      };
    }
  };
};

const createKmsEnvelopeEncryptionProvider = (
  mode: Extract<
    EnvelopeEncryptionProviderMode,
    "managed_kms" | "byok" | "cmek"
  >,
  keyring: ManagedKmsKeyring
): EnvelopeEncryptionProvider => {
  const provider = {
    mode,
    keyId: keyring.keyId,
    keyVersion: keyring.keyVersion
  };
  if (!provider.keyId.trim()) {
    throw new ManagedKmsProviderError(`${mode} keyId is required`);
  }
  if (!Number.isInteger(provider.keyVersion) || provider.keyVersion <= 0) {
    throw new ManagedKmsProviderError(
      `${mode} keyVersion must be a positive integer`
    );
  }

  const wrapDek = async (
    dek: Uint8Array,
    wrappedDekMetadata: Pick<
      WrappedDataEncryptionKey,
      "id" | "version" | "algorithm"
    >,
    keyVersion: number = provider.keyVersion
  ): Promise<WrappedDataEncryptionKey> => {
    try {
      const wrappedDek = await keyring.wrapDek({
        keyId: provider.keyId,
        keyVersion,
        wrappedDekId: wrappedDekMetadata.id,
        wrappedDekVersion: wrappedDekMetadata.version,
        dek,
        aad: wrappedDekAad({
          providerMode: provider.mode,
          keyId: provider.keyId,
          keyVersion,
          wrappedDekId: wrappedDekMetadata.id,
          wrappedDekVersion: wrappedDekMetadata.version
        })
      });
      if (!wrappedDek.ciphertext.trim()) {
        throw new ManagedKmsProviderError(
          `${mode} returned an empty wrapped DEK`
        );
      }
      return {
        ...wrappedDekMetadata,
        algorithm:
          wrappedDek.algorithm ?? ENCRYPTED_PAYLOAD_KMS_KEY_WRAP_ALGORITHM,
        ciphertext: wrappedDek.ciphertext,
        nonce: wrappedDek.nonce ?? "",
        tag: wrappedDek.tag ?? ""
      };
    } catch (error) {
      if (error instanceof EnvelopeEncryptionError) {
        throw error;
      }
      throw new ManagedKmsProviderError(`${mode} failed to wrap DEK`);
    }
  };

  const unwrapDek = async (
    envelope: EncryptedPayloadEnvelope
  ): Promise<Uint8Array> => {
    try {
      return await keyring.unwrapDek({
        keyId: provider.keyId,
        keyVersion: envelope.keyVersion,
        wrappedDek: envelope.wrappedDek,
        aad: wrappedDekAad({
          providerMode: provider.mode,
          keyId: provider.keyId,
          keyVersion: envelope.keyVersion,
          wrappedDekId: envelope.wrappedDek.id,
          wrappedDekVersion: envelope.wrappedDek.version
        })
      });
    } catch (error) {
      if (error instanceof EnvelopeEncryptionError) {
        throw error;
      }
      throw new ManagedKmsProviderError(`${mode} failed to unwrap DEK`);
    }
  };

  return {
    ...provider,
    async encrypt(
      input: EncryptPayloadInput
    ): Promise<EncryptedPayloadEnvelope> {
      const plaintext =
        typeof input.plaintext === "string"
          ? Buffer.from(input.plaintext, "utf8")
          : Buffer.from(input.plaintext);
      const createdAt = (input.now ?? new Date()).toISOString();
      const wrappedDekId = randomUUID();
      const wrappedDekVersion = 1;
      const dek = randomBytes(AES_256_KEY_BYTES);
      const wrappedDekMetadata: Pick<
        WrappedDataEncryptionKey,
        "id" | "version" | "algorithm"
      > = {
        id: wrappedDekId,
        version: wrappedDekVersion,
        algorithm: ENCRYPTED_PAYLOAD_KMS_KEY_WRAP_ALGORITHM
      };
      const envelopeMetadata: Omit<
        EncryptedPayloadEnvelope,
        "ciphertext" | "nonce" | "tag" | "wrappedDek"
      > & {
        wrappedDek: Pick<
          WrappedDataEncryptionKey,
          "id" | "version" | "algorithm"
        >;
      } = {
        version: ENCRYPTED_PAYLOAD_ENVELOPE_VERSION,
        providerMode: provider.mode,
        keyId: provider.keyId,
        keyVersion: provider.keyVersion,
        scope: input.scope,
        provenance: input.provenance,
        algorithm: ENCRYPTED_PAYLOAD_ALGORITHM,
        wrappedDek: wrappedDekMetadata,
        ciphertextLocation: input.ciphertextLocation,
        aad: normalizeAad(input.aad),
        createdAt,
        reencryptedAt: null
      };
      const payload = encryptAesGcm(
        dek,
        plaintext,
        payloadAad(envelopeMetadata)
      );

      return {
        ...envelopeMetadata,
        ciphertext: base64Encode(payload.ciphertext),
        nonce: base64Encode(payload.nonce),
        tag: base64Encode(payload.tag),
        wrappedDek: await wrapDek(dek, wrappedDekMetadata)
      };
    },
    async decrypt(envelope: EncryptedPayloadEnvelope): Promise<Uint8Array> {
      validateEnvelope(envelope);
      assertManagedKmsProviderEnvelope(envelope, provider);
      const dek = await unwrapDek(envelope);
      return decryptAesGcm(
        dek,
        base64Decode(envelope.ciphertext, "ciphertext"),
        base64Decode(envelope.nonce, "nonce"),
        base64Decode(envelope.tag, "tag"),
        payloadAad({
          version: envelope.version,
          scope: envelope.scope,
          provenance: envelope.provenance,
          algorithm: envelope.algorithm,
          ciphertextLocation: envelope.ciphertextLocation,
          aad: envelope.aad,
          createdAt: envelope.createdAt
        })
      );
    },
    async rewrap(envelope, input) {
      validateEnvelope(envelope);
      assertManagedKmsProviderEnvelope(envelope, provider);
      const dek = await unwrapDek(envelope);
      return {
        ...envelope,
        keyVersion: provider.keyVersion,
        wrappedDek: await wrapDek(dek, {
          id: envelope.wrappedDek.id,
          version: envelope.wrappedDek.version + 1,
          algorithm: ENCRYPTED_PAYLOAD_KMS_KEY_WRAP_ALGORITHM
        }),
        reencryptedAt: (input?.now ?? new Date()).toISOString()
      };
    },
    async status() {
      const keyringStatus = await keyring.status?.();
      return {
        ...(keyringStatus ?? { status: "configured" as const }),
        mode: provider.mode,
        keyId: provider.keyId,
        keyVersion: provider.keyVersion
      };
    }
  };
};

export const createManagedKmsEnvelopeEncryptionProvider = (
  keyring: ManagedKmsKeyring
): EnvelopeEncryptionProvider =>
  createKmsEnvelopeEncryptionProvider("managed_kms", keyring);

export const createByokEnvelopeEncryptionProvider = (
  keyring: ManagedKmsKeyring
): EnvelopeEncryptionProvider =>
  createKmsEnvelopeEncryptionProvider("byok", keyring);

export const createCmekEnvelopeEncryptionProvider = (
  keyring: ManagedKmsKeyring
): EnvelopeEncryptionProvider =>
  createKmsEnvelopeEncryptionProvider("cmek", keyring);

interface EnvelopeEncryptionEnvironmentFamily {
  providerMode: string;
  localKey: readonly string[];
  kmsKeyId: string;
  kmsKeyVersion: string;
  kmsEndpointUrl: string;
  kmsAuthToken: string;
}

const apiEnvelopeEncryptionEnvironmentFamily = {
  providerMode: "API_ENVELOPE_ENCRYPTION_PROVIDER",
  localKey: [API_DATA_ENCRYPTION_KEY_ENV, DATA_ENCRYPTION_KEY_ENV_ALIAS],
  kmsKeyId: "MANAGED_KMS_KEY_ID",
  kmsKeyVersion: "MANAGED_KMS_KEY_VERSION",
  kmsEndpointUrl: "MANAGED_KMS_ENDPOINT_URL",
  kmsAuthToken: "MANAGED_KMS_AUTH_TOKEN"
} as const satisfies EnvelopeEncryptionEnvironmentFamily;

const ownerPrivateReplicaEnvelopeEncryptionEnvironmentFamily = {
  providerMode: OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER_ENV,
  localKey: [OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY_ENV],
  kmsKeyId: OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_ID_ENV,
  kmsKeyVersion: OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_VERSION_ENV,
  kmsEndpointUrl: OWNER_PRIVATE_REPLICA_MANAGED_KMS_ENDPOINT_URL_ENV,
  kmsAuthToken: OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN_ENV
} as const satisfies EnvelopeEncryptionEnvironmentFamily;

const firstEnvironmentValue = (
  environment: NodeJS.ProcessEnv,
  names: readonly string[]
): string | undefined => {
  for (const name of names) {
    const value = optionalEnvValue(environment[name]);
    if (value) return value;
  }
  return undefined;
};

const createKmsKeyringFromEnvironment = (
  environment: NodeJS.ProcessEnv,
  fetchFn: typeof fetch | undefined,
  family: EnvelopeEncryptionEnvironmentFamily
): ManagedKmsKeyring => {
  const keyId = optionalEnvValue(environment[family.kmsKeyId]);
  const keyVersion = optionalEnvValue(environment[family.kmsKeyVersion]);
  const endpointUrl = optionalEnvValue(environment[family.kmsEndpointUrl]);
  const authToken = optionalEnvValue(environment[family.kmsAuthToken]);

  const missing = [
    [family.kmsKeyId, keyId],
    [family.kmsKeyVersion, keyVersion],
    [family.kmsEndpointUrl, endpointUrl],
    [family.kmsAuthToken, authToken]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new EnvelopeEncryptionError(
      `Missing required environment variable${
        missing.length === 1 ? "" : "s"
      }: ${missing.join(", ")}`
    );
  }

  return createHttpManagedKmsKeyring({
    keyId: keyId!,
    keyVersion: positiveInt(keyVersion, family.kmsKeyVersion),
    endpointUrl: endpointUrl!,
    authToken: authToken!,
    endpointEnvironmentName: family.kmsEndpointUrl,
    authTokenEnvironmentName: family.kmsAuthToken,
    ...(fetchFn ? { fetch: fetchFn } : {})
  });
};

const createEnvelopeEncryptionProviderFromEnvironmentFamily = (
  options: EnvelopeEncryptionProviderEnvironmentOptions,
  family: EnvelopeEncryptionEnvironmentFamily,
  requiredDescription: string
): EnvelopeEncryptionProvider | undefined => {
  const environment = options.environment ?? process.env;
  const configuredMode = providerModeFromString(
    environment[family.providerMode],
    family.providerMode
  );
  const key = firstEnvironmentValue(environment, family.localKey);
  const mode = configuredMode ?? (key ? "local_test_key" : undefined);

  if (!mode) {
    if (options.required) {
      throw new EnvelopeEncryptionError(
        `${requiredDescription} is required but neither ${family.providerMode} nor ${family.localKey.join(" or ")} is configured`
      );
    }
    return undefined;
  }

  switch (mode) {
    case "local_test_key":
      if (!key) {
        throw new EnvelopeEncryptionError(
          `Missing required environment variable: ${family.localKey.join(" (or ")}${family.localKey.length > 1 ? ")" : ""}`
        );
      }
      return createLocalTestKeyEnvelopeEncryptionProvider(
        key,
        family.localKey[0]
      );
    case "managed_kms":
      return createManagedKmsEnvelopeEncryptionProvider(
        createKmsKeyringFromEnvironment(environment, options.fetch, family)
      );
    case "byok":
      return createByokEnvelopeEncryptionProvider(
        createKmsKeyringFromEnvironment(environment, options.fetch, family)
      );
    case "cmek":
      return createCmekEnvelopeEncryptionProvider(
        createKmsKeyringFromEnvironment(environment, options.fetch, family)
      );
    case "operator_kms":
      throw new UnsupportedEnvelopeEncryptionProviderError(mode);
  }
};

export const createEnvelopeEncryptionProviderFromEnvironment = (
  options: EnvelopeEncryptionProviderEnvironmentOptions = {}
): EnvelopeEncryptionProvider | undefined =>
  createEnvelopeEncryptionProviderFromEnvironmentFamily(
    options,
    apiEnvelopeEncryptionEnvironmentFamily,
    "Envelope encryption provider"
  );

export const createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment =
  (
    options: EnvelopeEncryptionProviderEnvironmentOptions = {}
  ): EnvelopeEncryptionProvider | undefined =>
    createEnvelopeEncryptionProviderFromEnvironmentFamily(
      options,
      ownerPrivateReplicaEnvelopeEncryptionEnvironmentFamily,
      "Owner-private replica envelope encryption provider"
    );

export const validateEnvelopeEncryptionProviderEnvironment = (
  options: EnvelopeEncryptionEnvironmentValidationOptions = {}
): void => {
  const environment = options.environment ?? process.env;
  const deploymentProfile = normalizedEnv(
    environment,
    "KOED_DEPLOYMENT_PROFILE",
    "developer"
  ).replaceAll("-", "_");
  const releaseStage = normalizedEnv(
    environment,
    "KOED_MANAGED_CLOUD_RELEASE_STAGE",
    "alpha"
  );
  const providerMode =
    providerModeFromString(environment.API_ENVELOPE_ENCRYPTION_PROVIDER) ??
    "local_test_key";

  if (
    deploymentProfile === "koed_managed_cloud" &&
    ["paid", "production"].includes(releaseStage) &&
    !kmsBackedProviderModes.has(providerMode)
  ) {
    throw new EnvelopeEncryptionError(
      "A KMS-backed API_ENVELOPE_ENCRYPTION_PROVIDER is required for paid Koed-managed cloud"
    );
  }

  if (providerMode === "local_test_key") {
    requireApiDataEncryptionKey(environment);
  }

  if (kmsBackedProviderModes.has(providerMode)) {
    createKmsKeyringFromEnvironment(
      environment,
      undefined,
      apiEnvelopeEncryptionEnvironmentFamily
    );
  }

  if (providerMode === "operator_kms") {
    throw new UnsupportedEnvelopeEncryptionProviderError(providerMode);
  }

  const ownerPrivateReplicaConfigured = [
    ownerPrivateReplicaEnvelopeEncryptionEnvironmentFamily.providerMode,
    ...ownerPrivateReplicaEnvelopeEncryptionEnvironmentFamily.localKey,
    ownerPrivateReplicaEnvelopeEncryptionEnvironmentFamily.kmsKeyId,
    ownerPrivateReplicaEnvelopeEncryptionEnvironmentFamily.kmsKeyVersion,
    ownerPrivateReplicaEnvelopeEncryptionEnvironmentFamily.kmsEndpointUrl,
    ownerPrivateReplicaEnvelopeEncryptionEnvironmentFamily.kmsAuthToken
  ].some((name) => optionalEnvValue(environment[name]));
  const ownerPrivateReplicaRequired =
    deploymentProfile === "koed_managed_cloud" &&
    ["paid", "production"].includes(releaseStage);
  if (!ownerPrivateReplicaConfigured) {
    if (ownerPrivateReplicaRequired) {
      createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment({
        environment,
        required: true
      });
    }
    return;
  }

  const ownerPrivateReplicaProviderMode =
    providerModeFromString(
      environment[OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER_ENV],
      OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER_ENV
    ) ??
    (firstEnvironmentValue(
      environment,
      ownerPrivateReplicaEnvelopeEncryptionEnvironmentFamily.localKey
    )
      ? "local_test_key"
      : undefined);
  if (
    ownerPrivateReplicaRequired &&
    ownerPrivateReplicaProviderMode !== undefined &&
    !kmsBackedProviderModes.has(ownerPrivateReplicaProviderMode)
  ) {
    throw new EnvelopeEncryptionError(
      `A KMS-backed ${OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER_ENV} is required for paid Koed-managed cloud`
    );
  }
  createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment({
    environment,
    required: true
  });
};

export const redactEnvelopeEncryptionProviderStatus = (
  status: EnvelopeEncryptionProviderStatus
): EnvelopeEncryptionProviderStatus => ({
  mode: status.mode,
  keyId: status.keyId,
  keyVersion: status.keyVersion,
  status: status.status,
  details: Object.fromEntries(
    Object.entries(status.details ?? {}).filter(([key]) => {
      const normalized = key.toLowerCase();
      return (
        !normalized.includes("secret") &&
        !normalized.includes("token") &&
        !normalized.includes("credential") &&
        !normalized.includes("password") &&
        !normalized.includes("keymaterial")
      );
    })
  )
});

export const decryptEnvelopeToUtf8 = async (
  provider: EnvelopeEncryptionProvider,
  envelope: EncryptedPayloadEnvelope
): Promise<string> =>
  Buffer.from(await provider.decrypt(envelope)).toString("utf8");
