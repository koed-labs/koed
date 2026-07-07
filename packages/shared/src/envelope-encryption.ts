import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";

export type EnvelopeEncryptionProviderMode =
  | "local_test_key"
  | "managed_kms"
  | "operator_kms"
  | "byok"
  | "cmek";

export const envelopeEncryptionProviderModes = [
  "local_test_key",
  "managed_kms",
  "operator_kms",
  "byok",
  "cmek"
] as const satisfies readonly EnvelopeEncryptionProviderMode[];

export const ENCRYPTED_PAYLOAD_ENVELOPE_VERSION = 1;
export const ENCRYPTED_PAYLOAD_ALGORITHM = "aes-256-gcm";
export const ENCRYPTED_PAYLOAD_KEY_WRAP_ALGORITHM = "aes-256-gcm";
export const ENCRYPTED_PAYLOAD_KMS_KEY_WRAP_ALGORITHM = "kms-wrapped-dek-v1";
export const ENCRYPTED_PAYLOAD_MANAGED_KMS_KEY_WRAP_ALGORITHM =
  ENCRYPTED_PAYLOAD_KMS_KEY_WRAP_ALGORITHM;
const LOCAL_TEST_KEY_VERSION = 1;
const LOCAL_TEST_KEY_ID_PREFIX = "local_test_key";
const AES_256_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
export const API_DATA_ENCRYPTION_KEY_ENV = "API_DATA_ENCRYPTION_KEY";
export const DATA_ENCRYPTION_KEY_ENV_ALIAS = "DATA_ENCRYPTION_KEY";

type Awaitable<T> = T | Promise<T>;

export interface EncryptedPayloadScope {
  deploymentId?: string | null;
  tenantId?: string | null;
  teamId?: string | null;
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
    | typeof ENCRYPTED_PAYLOAD_MANAGED_KMS_KEY_WRAP_ALGORITHM;
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
  mode: Exclude<EnvelopeEncryptionProviderMode, "local_test_key">
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
  value: string | undefined
): EnvelopeEncryptionProviderMode | undefined => {
  const normalized = optionalEnvValue(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (
    envelopeEncryptionProviderModes.includes(
      normalized as EnvelopeEncryptionProviderMode
    )
  ) {
    return normalized as EnvelopeEncryptionProviderMode;
  }
  throw new EnvelopeEncryptionError(
    `Unsupported API_ENVELOPE_ENCRYPTION_PROVIDER: ${value}`
  );
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

const kmsBackedProviderModes = new Set<EnvelopeEncryptionProviderMode>([
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

const assertSafeManagedKmsEndpoint = (url: URL): void => {
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
    "MANAGED_KMS_ENDPOINT_URL must use HTTPS unless it targets localhost"
  );
};

const rootKeyFromBase64 = (value: string): Buffer => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("replace_with_generated")) {
    throw new EnvelopeEncryptionError(
      "API_DATA_ENCRYPTION_KEY must be a generated base64 32-byte key"
    );
  }
  const key = base64Decode(trimmed, "API_DATA_ENCRYPTION_KEY");
  if (key.length !== AES_256_KEY_BYTES) {
    throw new EnvelopeEncryptionError(
      "API_DATA_ENCRYPTION_KEY must decode to exactly 32 bytes"
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

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${canonicalJson(entryValue)}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
    canonicalJson({
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
}): Buffer => Buffer.from(canonicalJson(input), "utf8");

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
  try {
    const decipher = createDecipheriv(ENCRYPTED_PAYLOAD_ALGORITHM, key, nonce);
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
      ENCRYPTED_PAYLOAD_MANAGED_KMS_KEY_WRAP_ALGORITHM
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
  apiDataEncryptionKey: string
): EnvelopeEncryptionProvider => {
  const rootKey = rootKeyFromBase64(apiDataEncryptionKey);
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
  assertSafeManagedKmsEndpoint(endpoint);
  if (!config.authToken.trim()) {
    throw new ManagedKmsProviderError("MANAGED_KMS_AUTH_TOKEN is required");
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

const createKmsKeyringFromEnvironment = (
  environment: NodeJS.ProcessEnv,
  fetchFn: typeof fetch | undefined
): ManagedKmsKeyring => {
  const keyId = optionalEnvValue(environment.MANAGED_KMS_KEY_ID);
  const keyVersion = optionalEnvValue(environment.MANAGED_KMS_KEY_VERSION);
  const endpointUrl = optionalEnvValue(environment.MANAGED_KMS_ENDPOINT_URL);
  const authToken = optionalEnvValue(environment.MANAGED_KMS_AUTH_TOKEN);

  const missing = [
    ["MANAGED_KMS_KEY_ID", keyId],
    ["MANAGED_KMS_KEY_VERSION", keyVersion],
    ["MANAGED_KMS_ENDPOINT_URL", endpointUrl],
    ["MANAGED_KMS_AUTH_TOKEN", authToken]
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
    keyVersion: positiveInt(keyVersion, "MANAGED_KMS_KEY_VERSION"),
    endpointUrl: endpointUrl!,
    authToken: authToken!,
    ...(fetchFn ? { fetch: fetchFn } : {})
  });
};

export const createEnvelopeEncryptionProviderFromEnvironment = (
  options: EnvelopeEncryptionProviderEnvironmentOptions = {}
): EnvelopeEncryptionProvider | undefined => {
  const environment = options.environment ?? process.env;
  const configuredMode = providerModeFromString(
    environment.API_ENVELOPE_ENCRYPTION_PROVIDER
  );
  const key = resolveApiDataEncryptionKeyFromEnv(environment);
  const mode = configuredMode ?? (key ? "local_test_key" : undefined);

  if (!mode) {
    if (options.required) {
      throw new EnvelopeEncryptionError(
        "Envelope encryption provider is required but no provider mode or API_DATA_ENCRYPTION_KEY is configured"
      );
    }
    return undefined;
  }

  switch (mode) {
    case "local_test_key":
      return createLocalTestKeyEnvelopeEncryptionProvider(
        requireApiDataEncryptionKey(environment)
      );
    case "managed_kms":
      return createManagedKmsEnvelopeEncryptionProvider(
        createKmsKeyringFromEnvironment(environment, options.fetch)
      );
    case "byok":
      return createByokEnvelopeEncryptionProvider(
        createKmsKeyringFromEnvironment(environment, options.fetch)
      );
    case "cmek":
      return createCmekEnvelopeEncryptionProvider(
        createKmsKeyringFromEnvironment(environment, options.fetch)
      );
    case "operator_kms":
      throw new UnsupportedEnvelopeEncryptionProviderError(mode);
  }
};

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
    createKmsKeyringFromEnvironment(environment, undefined);
  }

  if (providerMode === "operator_kms") {
    throw new UnsupportedEnvelopeEncryptionProviderError(providerMode);
  }
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
