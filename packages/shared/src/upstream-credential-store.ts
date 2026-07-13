import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

export interface UpstreamCredentialSecretInput {
  backendId: string;
  credentialKeyId: string;
  secret: string;
}

export interface UpstreamCredentialSecretStoreDeps {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
  randomBytes?: typeof randomBytes;
  now?: () => Date;
}

export interface LocalEdgeClientCredentialInput {
  backendId: string;
  secret: string;
  operationFamilies: string[];
}

export interface LocalEdgeClientCredentialAuthorization {
  authorization: string;
  backendId: string;
  credentialKeyId: string;
  operationFamilies: string[];
}

interface StoredSecretEnvelope {
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: string;
  updatedAt: string;
}

interface SecretStoreFile {
  schemaVersion: 1;
  updatedAt: string;
  secrets: Record<string, StoredSecretEnvelope>;
}

const referencePrefix = "keychain://koed-upstream/";
const localEdgeClientReferencePrefix = "keychain://koed-local-edge-client/";
const storeKeySalt = "koed-upstream-credential-store-v1";

const depsWithDefaults = (
  deps: UpstreamCredentialSecretStoreDeps = {}
): Required<UpstreamCredentialSecretStoreDeps> => ({
  existsSync: deps.existsSync ?? existsSync,
  readFileSync: deps.readFileSync ?? readFileSync,
  writeFileSync: deps.writeFileSync ?? writeFileSync,
  renameSync: deps.renameSync ?? renameSync,
  randomBytes: deps.randomBytes ?? randomBytes,
  now: deps.now ?? (() => new Date())
});

const validateReferencePart = (
  value: string,
  label: string,
  options: { allowColon?: boolean } = {}
): string => {
  const trimmed = value.trim();
  const pattern = options.allowColon
    ? /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{1,159}$/
    : /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,159}$/;
  if (!pattern.test(trimmed)) {
    throw new Error(`${label} is not valid for upstream credential storage.`);
  }
  return trimmed;
};

export const upstreamCredentialReferenceFor = (input: {
  backendId: string;
  credentialKeyId: string;
}): string => {
  const backendId = validateReferencePart(input.backendId, "backendId", {
    allowColon: true
  });
  const credentialKeyId = validateReferencePart(
    input.credentialKeyId,
    "credentialKeyId"
  );
  return `${referencePrefix}${encodeURIComponent(
    backendId
  )}/${encodeURIComponent(credentialKeyId)}`;
};

export const parseUpstreamCredentialReference = (
  reference: string | undefined | null
): {
  backendId: string;
  credentialKeyId: string;
} | null => {
  const trimmed = reference?.trim();
  if (!trimmed?.startsWith(referencePrefix)) {
    return null;
  }
  const parts = trimmed.slice(referencePrefix.length).split("/");
  if (parts.length !== 2) {
    return null;
  }
  try {
    return {
      backendId: validateReferencePart(
        decodeURIComponent(parts[0] ?? ""),
        "backendId",
        { allowColon: true }
      ),
      credentialKeyId: validateReferencePart(
        decodeURIComponent(parts[1] ?? ""),
        "credentialKeyId"
      )
    };
  } catch {
    return null;
  }
};

const localEdgeClientCredentialKeyIdFor = (backendId: string): string =>
  `koed_local_${createHash("sha256")
    .update(validateReferencePart(backendId, "backendId", { allowColon: true }))
    .digest("hex")
    .slice(0, 40)}`;

export const localEdgeClientCredentialReferenceFor = (
  backendIdInput: string
): string => {
  const backendId = validateReferencePart(backendIdInput, "backendId", {
    allowColon: true
  });
  return `${localEdgeClientReferencePrefix}${encodeURIComponent(
    backendId
  )}/${localEdgeClientCredentialKeyIdFor(backendId)}`;
};

const parseLocalEdgeClientCredentialReference = (
  reference: string | undefined | null
): { backendId: string; credentialKeyId: string } | null => {
  const trimmed = reference?.trim();
  if (!trimmed?.startsWith(localEdgeClientReferencePrefix)) {
    return null;
  }
  const parts = trimmed.slice(localEdgeClientReferencePrefix.length).split("/");
  if (parts.length !== 2) {
    return null;
  }
  try {
    const backendId = validateReferencePart(
      decodeURIComponent(parts[0] ?? ""),
      "backendId",
      { allowColon: true }
    );
    const credentialKeyId = validateReferencePart(
      decodeURIComponent(parts[1] ?? ""),
      "credentialKeyId"
    );
    return credentialKeyId === localEdgeClientCredentialKeyIdFor(backendId)
      ? { backendId, credentialKeyId }
      : null;
  } catch {
    return null;
  }
};

const storePathFor = (koedHome: string): string =>
  resolve(koedHome, "secrets", "upstream-credentials.json");

const keyPathFor = (koedHome: string): string =>
  resolve(koedHome, "config", "local-secret-store.key");

const readOrCreateStoreKey = (
  koedHome: string,
  deps: Required<UpstreamCredentialSecretStoreDeps>
): Buffer => {
  const keyPath = keyPathFor(koedHome);
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  if (!deps.existsSync(keyPath)) {
    if (deps.existsSync(storePathFor(koedHome))) {
      throw new Error("Local secret store key is missing or invalid.");
    }
    deps.writeFileSync(
      keyPath,
      `${deps.randomBytes(32).toString("base64")}\n`,
      {
        mode: 0o600
      }
    );
  }
  const key = readStoreKey(koedHome, deps);
  if (!key) {
    throw new Error("Local secret store key is missing or invalid.");
  }
  return key;
};

const readStoreKey = (
  koedHome: string,
  deps: Required<UpstreamCredentialSecretStoreDeps>
): Buffer | null => {
  const keyPath = keyPathFor(koedHome);
  if (!deps.existsSync(keyPath)) {
    return null;
  }
  try {
    const keyMaterial = String(deps.readFileSync(keyPath, "utf8")).trim();
    if (!/^[A-Za-z0-9+/]{43}=$/.test(keyMaterial)) {
      return null;
    }
    const decoded = Buffer.from(keyMaterial, "base64");
    if (decoded.length !== 32 || decoded.toString("base64") !== keyMaterial) {
      return null;
    }
    return scryptSync(keyMaterial, storeKeySalt, 32);
  } catch {
    return null;
  }
};

const readStore = (
  koedHome: string,
  deps: Required<UpstreamCredentialSecretStoreDeps>
): SecretStoreFile => {
  const now = deps.now().toISOString();
  const storePath = storePathFor(koedHome);
  if (!deps.existsSync(storePath)) {
    return { schemaVersion: 1, updatedAt: now, secrets: {} };
  }
  const parsed = JSON.parse(
    String(deps.readFileSync(storePath, "utf8"))
  ) as Partial<SecretStoreFile>;
  return {
    schemaVersion: 1,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now,
    secrets:
      parsed.secrets && typeof parsed.secrets === "object"
        ? Object.fromEntries(
            Object.entries(parsed.secrets).filter(
              ([reference, envelope]) =>
                (parseUpstreamCredentialReference(reference) ||
                  parseLocalEdgeClientCredentialReference(reference)) &&
                envelope?.algorithm === "aes-256-gcm" &&
                typeof envelope.iv === "string" &&
                typeof envelope.tag === "string" &&
                typeof envelope.ciphertext === "string"
            )
          )
        : {}
  };
};

const readStoreForRead = (
  koedHome: string,
  deps: Required<UpstreamCredentialSecretStoreDeps>
): SecretStoreFile | null => {
  try {
    return readStore(koedHome, deps);
  } catch {
    return null;
  }
};

const writeStore = (
  koedHome: string,
  store: SecretStoreFile,
  deps: Required<UpstreamCredentialSecretStoreDeps>
): void => {
  const storePath = storePathFor(koedHome);
  mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
  const tempPath = `${storePath}.tmp`;
  deps.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600
  });
  deps.renameSync(tempPath, storePath);
};

const encryptSecret = (
  key: Buffer,
  secret: string,
  now: string,
  deps: Required<UpstreamCredentialSecretStoreDeps>,
  previous?: StoredSecretEnvelope
): StoredSecretEnvelope => {
  const iv = deps.randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final()
  ]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };
};

const decryptSecret = (key: Buffer, envelope: StoredSecretEnvelope): string => {
  const decodeBase64 = (value: string): Buffer => {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value
      )
    ) {
      throw new Error("Encrypted local credential is malformed.");
    }
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value) {
      throw new Error("Encrypted local credential is malformed.");
    }
    return decoded;
  };
  const iv = decodeBase64(envelope.iv);
  const tag = decodeBase64(envelope.tag);
  const ciphertext = decodeBase64(envelope.ciphertext);
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("Encrypted local credential is malformed.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString("utf8");
};

export const storeUpstreamCredentialSecret = (
  koedHome: string,
  input: UpstreamCredentialSecretInput,
  deps: UpstreamCredentialSecretStoreDeps = {}
): { reference: string } => {
  if (!isSafeAuthorizationValue(input.secret)) {
    throw new Error("Upstream credential secret is not valid.");
  }
  const resolvedDeps = depsWithDefaults(deps);
  const reference = upstreamCredentialReferenceFor(input);
  const key = readOrCreateStoreKey(koedHome, resolvedDeps);
  const store = readStore(koedHome, resolvedDeps);
  const now = resolvedDeps.now().toISOString();
  store.secrets[reference] = encryptSecret(
    key,
    input.secret,
    now,
    resolvedDeps,
    store.secrets[reference]
  );
  store.updatedAt = now;
  writeStore(koedHome, store, resolvedDeps);
  return { reference };
};

export const readUpstreamCredentialAuthorization = (
  koedHome: string,
  reference: string | undefined | null,
  deps: UpstreamCredentialSecretStoreDeps = {}
): string | null => {
  const parsed = parseUpstreamCredentialReference(reference);
  if (!parsed) {
    return null;
  }
  const resolvedDeps = depsWithDefaults(deps);
  const store = readStoreForRead(koedHome, resolvedDeps);
  if (!store) {
    return null;
  }
  const envelope = store.secrets[upstreamCredentialReferenceFor(parsed)];
  if (!envelope) {
    return null;
  }
  const key = readStoreKey(koedHome, resolvedDeps);
  if (!key) {
    return null;
  }
  let secret: string;
  try {
    secret = decryptSecret(key, envelope);
  } catch {
    return null;
  }
  if (!isSafeAuthorizationValue(secret)) {
    return null;
  }
  return `Koed-Device ${parsed.credentialKeyId}:${secret}`;
};

const isSafeAuthorizationValue = (value: string): boolean =>
  value.length > 0 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);

const normalizeOperationFamilies = (families: string[]): string[] => {
  const normalized = Array.from(
    new Set(families.map((family) => family.trim()))
  );
  if (
    normalized.length === 0 ||
    normalized.some(
      (family) => !/^[a-z0-9_.:-]{1,80}$/i.test(family) || /[\r\n]/.test(family)
    )
  ) {
    throw new Error(
      "operationFamilies are not valid for local-edge credentials."
    );
  }
  return normalized;
};

export const storeLocalEdgeClientCredential = (
  koedHome: string,
  input: LocalEdgeClientCredentialInput,
  deps: UpstreamCredentialSecretStoreDeps = {}
): { reference: string; credentialKeyId: string } => {
  if (!isSafeAuthorizationValue(input.secret)) {
    throw new Error("Local-edge client credential secret is not valid.");
  }
  const resolvedDeps = depsWithDefaults(deps);
  const backendId = validateReferencePart(input.backendId, "backendId", {
    allowColon: true
  });
  const credentialKeyId = localEdgeClientCredentialKeyIdFor(backendId);
  const reference = localEdgeClientCredentialReferenceFor(backendId);
  const key = readOrCreateStoreKey(koedHome, resolvedDeps);
  const store = readStore(koedHome, resolvedDeps);
  const now = resolvedDeps.now().toISOString();
  store.secrets[reference] = encryptSecret(
    key,
    JSON.stringify({
      schemaVersion: 1,
      backendId,
      credentialKeyId,
      secret: input.secret,
      operationFamilies: normalizeOperationFamilies(input.operationFamilies)
    }),
    now,
    resolvedDeps,
    store.secrets[reference]
  );
  store.updatedAt = now;
  writeStore(koedHome, store, resolvedDeps);
  return { reference, credentialKeyId };
};

export const readLocalEdgeClientCredentialAuthorization = (
  koedHome: string,
  backendIdInput: string,
  deps: UpstreamCredentialSecretStoreDeps = {}
): LocalEdgeClientCredentialAuthorization | null => {
  let backendId: string;
  try {
    backendId = validateReferencePart(backendIdInput, "backendId", {
      allowColon: true
    });
  } catch {
    return null;
  }
  const parsed = parseLocalEdgeClientCredentialReference(
    localEdgeClientCredentialReferenceFor(backendId)
  );
  if (!parsed) {
    return null;
  }
  const resolvedDeps = depsWithDefaults(deps);
  const store = readStoreForRead(koedHome, resolvedDeps);
  const key = readStoreKey(koedHome, resolvedDeps);
  const envelope =
    store?.secrets[localEdgeClientCredentialReferenceFor(backendId)];
  if (!key || !envelope) {
    return null;
  }
  try {
    const payload = JSON.parse(decryptSecret(key, envelope)) as Record<
      string,
      unknown
    >;
    if (
      payload.schemaVersion !== 1 ||
      payload.backendId !== backendId ||
      payload.credentialKeyId !== parsed.credentialKeyId ||
      typeof payload.secret !== "string" ||
      !isSafeAuthorizationValue(payload.secret) ||
      !Array.isArray(payload.operationFamilies)
    ) {
      return null;
    }
    const operationFamilies = normalizeOperationFamilies(
      payload.operationFamilies.filter(
        (family): family is string => typeof family === "string"
      )
    );
    if (operationFamilies.length !== payload.operationFamilies.length) {
      return null;
    }
    return {
      authorization: `Koed-Device ${parsed.credentialKeyId}:${payload.secret}`,
      backendId,
      credentialKeyId: parsed.credentialKeyId,
      operationFamilies
    };
  } catch {
    return null;
  }
};

export const verifyLocalEdgeClientCredentialAuthorization = (
  koedHome: string,
  authorization: string | undefined,
  input: { backendId: string; operationFamily: string },
  deps: UpstreamCredentialSecretStoreDeps = {}
): LocalEdgeClientCredentialAuthorization | null => {
  const match = /^Koed-Device\s+([^:\s]+):([^\s]+)$/i.exec(
    authorization?.trim() ?? ""
  );
  const stored = readLocalEdgeClientCredentialAuthorization(
    koedHome,
    input.backendId,
    deps
  );
  if (
    !match ||
    !stored ||
    !stored.operationFamilies.includes(input.operationFamily)
  ) {
    return null;
  }
  const received = Buffer.from(`${match[1]}:${match[2]}`, "utf8");
  const expected = Buffer.from(
    stored.authorization.slice("Koed-Device ".length),
    "utf8"
  );
  return received.length === expected.length &&
    timingSafeEqual(received, expected)
    ? stored
    : null;
};

export const deleteLocalEdgeClientCredential = (
  koedHome: string,
  backendId: string,
  deps: UpstreamCredentialSecretStoreDeps = {}
): boolean =>
  deleteCredentialSecretByReference(
    koedHome,
    localEdgeClientCredentialReferenceFor(backendId),
    deps
  );

export const deleteUpstreamCredentialSecret = (
  koedHome: string,
  reference: string | undefined | null,
  deps: UpstreamCredentialSecretStoreDeps = {}
): boolean => {
  const parsed = parseUpstreamCredentialReference(reference);
  if (!parsed) {
    return false;
  }
  return deleteCredentialSecretByReference(
    koedHome,
    upstreamCredentialReferenceFor(parsed),
    deps
  );
};

const deleteCredentialSecretByReference = (
  koedHome: string,
  normalizedReference: string,
  deps: UpstreamCredentialSecretStoreDeps
): boolean => {
  const resolvedDeps = depsWithDefaults(deps);
  const store = readStoreForRead(koedHome, resolvedDeps);
  if (!store) {
    return false;
  }
  if (!store.secrets[normalizedReference]) {
    return false;
  }
  delete store.secrets[normalizedReference];
  store.updatedAt = resolvedDeps.now().toISOString();
  writeStore(koedHome, store, resolvedDeps);
  return true;
};
