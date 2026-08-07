// Internal domain implementation retained behind focused public custody modules.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  collaborationApprovalReviewSchema,
  collaborationApprovalTierSchema,
  collaborationSafeErrorSchema,
  type CollaborationApprovalReview,
  type CollaborationApprovalTier,
  type CollaborationSafeError
} from "./collaboration-contract.js";
import { highRiskActionGrantCommitmentHash } from "./high-risk-action-grant-commitment.js";
import { assertSecureHttpTransport } from "./http-transport-security.js";
import {
  createEncryptedStateTransactionCore,
  decryptEncryptedStateValue,
  encryptEncryptedStateValue,
  isEncryptedStateEnvelope,
  resolveEncryptedStateTransactionDeps,
  type EncryptedStateDomain,
  type EncryptedStateEnvelope,
  type ResolvedEncryptedStateTransactionDeps
} from "./encrypted-state-transaction-core.js";

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
  lockNowMs?: () => number;
  sleepSync?: (milliseconds: number) => void;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  beforeStoreCommit?: () => void;
}

type ResolvedStoreDeps = ResolvedEncryptedStateTransactionDeps;

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

export interface EnrollmentCredentialCustodyInput {
  upstream: UpstreamCredentialSecretInput;
  localEdgeClient: LocalEdgeClientCredentialInput;
}

export interface EnrollmentCredentialCustodyResult {
  upstreamReference: string;
  localEdgeClientReference: string;
  localEdgeClientCredentialKeyId: string;
}

export const DESKTOP_LOCAL_CREDENTIAL_OPERATION_FAMILIES = [
  "personal_collaboration_read",
  "personal_collaboration_write"
] as const;

export type DesktopLocalCredentialOperationFamily =
  (typeof DESKTOP_LOCAL_CREDENTIAL_OPERATION_FAMILIES)[number];

export interface DesktopLocalCredentialInput {
  ownerUserId: string;
  operationFamilies: string[];
}

export interface DesktopLocalCredentialAuthorization {
  version: 1;
  authorization: string;
  reference: string;
  credentialKeyId: string;
  ownerUserId: string;
  operationFamilies: DesktopLocalCredentialOperationFamily[];
  createdAt: string;
  updatedAt: string;
}

export type CollaborationActionGrantOperationFamily =
  | "admin"
  | "share_grant_management"
  | "source_download"
  | "managed_execution";
export type CollaborationActionGrantMethod =
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";
export type CollaborationActionGrantState =
  | "pending"
  | "review_required"
  | "approved"
  | "consumed"
  | "denied"
  | "revoked"
  | "expired"
  | "canceled";

export interface CollaborationActionGrantCustodyInput {
  referenceId: string;
  backendId: string;
  deploymentBaseUrl: string;
  deviceCredentialId: string;
  localOwnerUserId?: string;
  principalUserId: string;
  operationFamily: CollaborationActionGrantOperationFamily;
  action: string;
  teamId: string | null;
  targetId: string | null;
  method: CollaborationActionGrantMethod;
  path: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
  expiresAt: string;
}

export interface CollaborationActionGrantAccessInput {
  referenceId: string;
  backendId: string;
  deploymentBaseUrl: string;
  deviceCredentialId: string;
  localOwnerUserId?: string;
  principalUserId: string;
}

export interface CollaborationActionGrantResolveInput extends CollaborationActionGrantAccessInput {
  operationFamily: CollaborationActionGrantOperationFamily;
  action: string;
  teamId: string | null;
  targetId: string | null;
  method: CollaborationActionGrantMethod;
  path: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
}

export interface CollaborationActionGrantStatusRecord {
  version: 1;
  actionGrant: { id: string };
  approvalTier: CollaborationApprovalTier;
  review: CollaborationApprovalReview | null;
  state: CollaborationActionGrantState;
  activationUrl: string | null;
  expiresAt: string;
}

interface DesktopLocalCredentialPayload {
  version: 1;
  credentialKeyId: string;
  secret: string;
  ownerUserId: string;
  operationFamilies: DesktopLocalCredentialOperationFamily[];
  createdAt: string;
  updatedAt: string;
}

type StoredSecretEnvelope = EncryptedStateEnvelope;

interface StoredActionGrantMetadata {
  schemaVersion: 1;
  backendId: string;
  deploymentBaseUrl: string;
  deploymentOrigin: string;
  deviceCredentialId: string;
  localOwnerUserId: string | null;
  principalUserId: string;
  operationFamily: CollaborationActionGrantOperationFamily;
  action: string;
  teamId: string | null;
  targetId: string | null;
  method: CollaborationActionGrantMethod;
  path: string;
  bodyHash: string;
  requestHash: string;
  expiresAt: string;
}

interface StoredActionGrantRecordBase {
  schemaVersion: 1;
  referenceId: string;
  commitmentHash: string;
  createdAt: string;
  updatedAt: string;
  metadata: StoredActionGrantMetadata;
  envelope: StoredSecretEnvelope;
}

type StoredLegacyActionGrantState = Exclude<
  CollaborationActionGrantState,
  "review_required"
>;

type StoredActionGrantRecord = StoredActionGrantRecordBase &
  (
    | {
        lifecycle: "unclassified";
        approvalTier: null;
        review: null;
        state: "pending";
        approvalState: null;
        activationUrl: null;
        ambiguousUntil: null;
      }
    | {
        lifecycle: "classified";
        approvalTier: CollaborationApprovalTier;
        review: CollaborationApprovalReview | null;
        state: StoredLegacyActionGrantState;
        approvalState: CollaborationActionGrantState;
        activationUrl: string | null;
        ambiguousUntil: null;
      }
    | {
        lifecycle: "ambiguous";
        approvalTier: CollaborationApprovalTier | null;
        review: CollaborationApprovalReview | null;
        state: StoredLegacyActionGrantState;
        approvalState: CollaborationActionGrantState | null;
        activationUrl: string | null;
        ambiguousUntil: string;
      }
  );

export interface CollaborationPendingSendInput {
  ownerId: string;
  backendId: string | null;
  remotePrincipalId: string | null;
  deviceCredentialId: string | null;
  thread:
    | { scope: "personal"; threadId: string }
    | { scope: "team"; threadId: string; teamId: string };
  clientMessageId: string;
  body: string;
}

export interface CollaborationPendingSendRecord extends CollaborationPendingSendInput {
  schemaVersion: 1;
  key: string;
  localCreationOrder: number;
  attemptCount: number;
  state: "pending" | "manual_retry" | "failed";
  failure: CollaborationSafeError | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const legacyPendingSendFailure: CollaborationSafeError = {
  code: "temporarily_unavailable",
  userMessage: "Collaboration is temporarily unavailable.",
  retryable: true,
  retryAfterMs: null
};

interface StoredCollaborationPendingSendRecord {
  schemaVersion: 1;
  key: string;
  ownerId: string;
  backendId: string | null;
  remotePrincipalId: string | null;
  deviceCredentialId: string | null;
  scope: "personal" | "team";
  threadId: string;
  teamId: string | null;
  clientMessageId: string;
  localCreationOrder?: number;
  attemptCount: number;
  state: "pending" | "manual_retry" | "failed";
  failure?: CollaborationSafeError | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  envelope: StoredSecretEnvelope;
}

interface SecretStoreFile {
  schemaVersion: 1;
  updatedAt: string;
  secrets: Record<string, StoredSecretEnvelope>;
  actionGrants: Record<string, StoredActionGrantRecord>;
  pendingCollaborationSends: Record<
    string,
    StoredCollaborationPendingSendRecord
  >;
}

const referencePrefix = "keychain://koed-upstream/";
const localEdgeClientReferencePrefix = "keychain://koed-local-edge-client/";
const desktopLocalCredentialReference = "keychain://koed-desktop-local/install";
const storeKeySalt = "koed-upstream-credential-store-v1";
const depsWithDefaults = (
  deps: UpstreamCredentialSecretStoreDeps = {}
): ResolvedStoreDeps => resolveEncryptedStateTransactionDeps(deps);

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

export const desktopLocalCredentialReferenceFor = (): string =>
  desktopLocalCredentialReference;

const isDesktopLocalCredentialReference = (reference: string): boolean =>
  reference === desktopLocalCredentialReference;

const storePathFor = (koedHome: string): string =>
  resolve(koedHome, "secrets", "upstream-credentials.json");

const keyPathFor = (koedHome: string): string =>
  resolve(koedHome, "config", "local-secret-store.key");

function isStoredSecretEnvelope(
  candidate: unknown
): candidate is StoredSecretEnvelope {
  return isEncryptedStateEnvelope(candidate, isCanonicalTimestamp);
}

function isStoredPendingSendRecord(
  key: string,
  candidate: unknown
): candidate is StoredCollaborationPendingSendRecord {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  try {
    const thread =
      record.scope === "team"
        ? {
            scope: "team" as const,
            threadId: String(record.threadId),
            teamId: String(record.teamId)
          }
        : {
            scope: "personal" as const,
            threadId: String(record.threadId)
          };
    const validatedInput = validatePendingSendInput({
      ownerId: String(record.ownerId),
      backendId:
        record.backendId === null
          ? null
          : storedString(record.backendId, "backendId"),
      remotePrincipalId:
        record.remotePrincipalId === null
          ? null
          : storedString(record.remotePrincipalId, "remotePrincipalId"),
      deviceCredentialId:
        record.deviceCredentialId === null
          ? null
          : storedString(record.deviceCredentialId, "deviceCredentialId"),
      thread,
      clientMessageId: String(record.clientMessageId),
      body: "placeholder"
    });
    const derivedKey = pendingSendKey(validatedInput);
    return (
      (Object.keys(record).length === 16 ||
        Object.keys(record).length === 18) &&
      record.schemaVersion === 1 &&
      record.key === key &&
      derivedKey === key &&
      (record.scope === "personal" || record.scope === "team") &&
      (record.scope === "team"
        ? typeof record.teamId === "string"
        : record.teamId === null) &&
      Number.isInteger(record.attemptCount) &&
      (record.attemptCount as number) >= 0 &&
      (record.attemptCount as number) <= 5 &&
      (record.localCreationOrder === undefined ||
        (Number.isSafeInteger(record.localCreationOrder) &&
          (record.localCreationOrder as number) > 0)) &&
      (record.state === "pending" ||
        record.state === "manual_retry" ||
        record.state === "failed") &&
      (record.failure === undefined ||
        record.failure === null ||
        collaborationSafeErrorSchema.safeParse(record.failure).success) &&
      (record.state === "pending"
        ? (record.failure ?? null) === null
        : record.failure === undefined || record.failure !== null) &&
      (record.nextAttemptAt === null ||
        isCanonicalTimestamp(record.nextAttemptAt)) &&
      isCanonicalTimestamp(record.createdAt) &&
      isCanonicalTimestamp(record.updatedAt) &&
      record.updatedAt >= record.createdAt &&
      isStoredSecretEnvelope(record.envelope)
    );
  } catch {
    return false;
  }
}

const parseStore = (
  parsed: unknown,
  options: { preserveMalformedActionGrants?: boolean } = {}
): SecretStoreFile => {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 5 ||
    parsed.schemaVersion !== 1 ||
    !isCanonicalTimestamp(parsed.updatedAt) ||
    !isRecord(parsed.secrets) ||
    !isRecord(parsed.actionGrants) ||
    !isRecord(parsed.pendingCollaborationSends)
  ) {
    throw new Error("Local secret store is malformed.");
  }
  const secrets = parsed.secrets as Record<string, StoredSecretEnvelope>;
  const actionGrants = parsed.actionGrants as Record<
    string,
    StoredActionGrantRecord
  >;
  const pendingCollaborationSends = parsed.pendingCollaborationSends as Record<
    string,
    StoredCollaborationPendingSendRecord
  >;
  if (
    Object.entries(secrets).some(
      ([reference, envelope]) =>
        !(
          parseUpstreamCredentialReference(reference) ||
          parseLocalEdgeClientCredentialReference(reference) ||
          isDesktopLocalCredentialReference(reference)
        ) || !isStoredSecretEnvelope(envelope)
    ) ||
    (!options.preserveMalformedActionGrants &&
      Object.entries(actionGrants).some(
        ([referenceId, record]) =>
          parseStoredActionGrantRecord(referenceId, record) === null
      )) ||
    Object.entries(pendingCollaborationSends).some(
      ([key, record]) => !isStoredPendingSendRecord(key, record)
    )
  ) {
    throw new Error("Local secret store is malformed.");
  }
  return {
    schemaVersion: 1,
    updatedAt: parsed.updatedAt,
    secrets,
    actionGrants,
    pendingCollaborationSends
  };
};

const encryptedStateCore = (koedHome: string, deps: ResolvedStoreDeps) =>
  createEncryptedStateTransactionCore<
    SecretStoreFile,
    { preserveMalformedActionGrants?: boolean }
  >({
    storePath: storePathFor(koedHome),
    keyPath: keyPathFor(koedHome),
    keySalt: storeKeySalt,
    createEmpty: (now) => ({
      schemaVersion: 1,
      updatedAt: now,
      secrets: {},
      actionGrants: {},
      pendingCollaborationSends: {}
    }),
    parse: parseStore,
    deps
  });

const readStoreForRead = (
  koedHome: string,
  deps: ResolvedStoreDeps
): SecretStoreFile | null =>
  encryptedStateCore(koedHome, deps).readFailClosed({});

interface StoreMutationResult<Result> {
  result: Result;
  changed: boolean;
}

const mutateStore = <Result>(
  koedHome: string,
  deps: ResolvedStoreDeps,
  domains: readonly [EncryptedStateDomain, ...EncryptedStateDomain[]],
  mutation: (store: SecretStoreFile) => StoreMutationResult<Result>
): Result =>
  encryptedStateCore(koedHome, deps).mutate({ domains, apply: mutation });

const readOrCreateStoreKey = (
  koedHome: string,
  deps: ResolvedStoreDeps
): Buffer => encryptedStateCore(koedHome, deps).readOrCreateKey();

const readStoreKey = (
  koedHome: string,
  deps: ResolvedStoreDeps
): Buffer | null => encryptedStateCore(koedHome, deps).readKey();

const encryptSecret = (
  key: Buffer,
  secret: string,
  now: string,
  deps: ResolvedStoreDeps,
  previous?: StoredSecretEnvelope,
  aad?: string
): StoredSecretEnvelope => {
  return encryptEncryptedStateValue(key, secret, now, deps, previous, aad);
};

const decryptSecret = (
  key: Buffer,
  envelope: StoredSecretEnvelope,
  aad?: string
): string => decryptEncryptedStateValue(key, envelope, aad);

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
  return mutateStore(
    koedHome,
    resolvedDeps,
    ["upstream_credential"],
    (store) => {
      const key = readOrCreateStoreKey(koedHome, resolvedDeps);
      const now = resolvedDeps.now().toISOString();
      store.secrets[reference] = encryptSecret(
        key,
        input.secret,
        now,
        resolvedDeps,
        store.secrets[reference]
      );
      store.updatedAt = now;
      return { result: { reference }, changed: true };
    }
  );
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

const desktopCredentialKeyIdPattern = /^koed_desktop_[a-f0-9]{40}$/;
const desktopCredentialSecretPattern = /^[A-Za-z0-9_-]{43}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const validateDesktopOwnerUserId = (ownerUserIdInput: string): string => {
  if (
    ownerUserIdInput !== ownerUserIdInput.trim() ||
    !uuidPattern.test(ownerUserIdInput)
  ) {
    throw new Error(
      "ownerUserId is not a valid UUID for a desktop credential."
    );
  }
  return ownerUserIdInput.toLowerCase();
};

const normalizeDesktopOperationFamilies = (
  families: string[]
): DesktopLocalCredentialOperationFamily[] => {
  const normalized = Array.from(new Set(families));
  if (
    normalized.length === 0 ||
    normalized.some(
      (family): boolean =>
        !DESKTOP_LOCAL_CREDENTIAL_OPERATION_FAMILIES.includes(
          family as DesktopLocalCredentialOperationFamily
        )
    )
  ) {
    throw new Error(
      "operationFamilies are not valid for a desktop local credential."
    );
  }
  return normalized as DesktopLocalCredentialOperationFamily[];
};

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

const pendingSendAad = (key: string): string =>
  `koed:collaboration-pending-send:v1\n${key}`;

const pendingSendKey = (input: CollaborationPendingSendInput): string =>
  `collaboration-send:${createHash("sha256")
    .update(
      canonicalJsonStringify({
        backendId: input.backendId,
        remotePrincipalId: input.remotePrincipalId,
        deviceCredentialId: input.deviceCredentialId,
        scope: input.thread.scope,
        teamId: "teamId" in input.thread ? input.thread.teamId : null,
        threadId: input.thread.threadId,
        clientMessageId: input.clientMessageId
      }),
      "utf8"
    )
    .digest("hex")}`;

const pendingThreadFromStored = (
  stored: StoredCollaborationPendingSendRecord
): CollaborationPendingSendInput["thread"] =>
  stored.scope === "team"
    ? { scope: "team", threadId: stored.threadId, teamId: stored.teamId! }
    : { scope: "personal", threadId: stored.threadId };

const validatePendingSendInput = (
  input: CollaborationPendingSendInput
): CollaborationPendingSendInput => {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(input.ownerId)) {
    throw new Error("Collaboration pending send owner is invalid.");
  }
  if (
    input.backendId !== null &&
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,159}$/.test(input.backendId)
  ) {
    throw new Error("Collaboration pending send backend is invalid.");
  }
  const hasNoRemoteBinding =
    input.backendId === null &&
    input.remotePrincipalId === null &&
    input.deviceCredentialId === null;
  const hasCompleteRemoteBinding =
    input.backendId !== null &&
    input.remotePrincipalId !== null &&
    input.deviceCredentialId !== null &&
    uuidPattern.test(input.remotePrincipalId) &&
    uuidPattern.test(input.deviceCredentialId);
  if (
    !uuidPattern.test(input.thread.threadId) ||
    !uuidPattern.test(input.clientMessageId) ||
    ("teamId" in input.thread && !uuidPattern.test(input.thread.teamId)) ||
    (!hasNoRemoteBinding && !hasCompleteRemoteBinding) ||
    (input.thread.scope === "team" && !hasCompleteRemoteBinding)
  ) {
    throw new Error("Collaboration pending send binding is invalid.");
  }
  if (
    input.body !== input.body.trim() ||
    input.body.length === 0 ||
    Buffer.byteLength(input.body, "utf8") > 32_768
  ) {
    throw new Error("Collaboration pending send body is invalid.");
  }
  return input;
};

const readPendingSendRecord = (
  key: Buffer,
  stored: StoredCollaborationPendingSendRecord
): CollaborationPendingSendRecord | null => {
  try {
    if (
      stored.schemaVersion !== 1 ||
      stored.key !==
        pendingSendKey({
          ownerId: stored.ownerId,
          backendId: stored.backendId,
          remotePrincipalId: stored.remotePrincipalId,
          deviceCredentialId: stored.deviceCredentialId,
          thread: pendingThreadFromStored(stored),
          clientMessageId: stored.clientMessageId,
          body: "placeholder"
        }) ||
      !Number.isInteger(stored.attemptCount) ||
      stored.attemptCount < 0 ||
      stored.attemptCount > 5 ||
      !["pending", "manual_retry", "failed"].includes(stored.state) ||
      (stored.failure !== undefined &&
        stored.failure !== null &&
        !collaborationSafeErrorSchema.safeParse(stored.failure).success) ||
      (stored.state === "pending" && (stored.failure ?? null) !== null) ||
      (stored.state !== "pending" &&
        stored.failure !== undefined &&
        stored.failure === null) ||
      (stored.nextAttemptAt !== null &&
        !isCanonicalTimestamp(stored.nextAttemptAt)) ||
      !isCanonicalTimestamp(stored.createdAt) ||
      !isCanonicalTimestamp(stored.updatedAt) ||
      stored.updatedAt < stored.createdAt
    ) {
      return null;
    }
    const input = validatePendingSendInput({
      ownerId: stored.ownerId,
      backendId: stored.backendId,
      remotePrincipalId: stored.remotePrincipalId,
      deviceCredentialId: stored.deviceCredentialId,
      thread: pendingThreadFromStored(stored),
      clientMessageId: stored.clientMessageId,
      body: decryptSecret(key, stored.envelope, pendingSendAad(stored.key))
    });
    return {
      schemaVersion: 1,
      key: stored.key,
      ...input,
      localCreationOrder:
        stored.localCreationOrder ?? Math.max(1, Date.parse(stored.createdAt)),
      attemptCount: stored.attemptCount,
      state: stored.state,
      failure:
        stored.state === "pending"
          ? null
          : (stored.failure ?? legacyPendingSendFailure),
      nextAttemptAt: stored.nextAttemptAt,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt
    };
  } catch {
    return null;
  }
};

export const storeCollaborationPendingSend = (
  koedHome: string,
  inputValue: CollaborationPendingSendInput,
  options: { resetAttempts?: boolean } = {},
  deps: UpstreamCredentialSecretStoreDeps = {}
): CollaborationPendingSendRecord => {
  const input = validatePendingSendInput(inputValue);
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(koedHome, resolvedDeps, ["pending_team_send"], (store) => {
    const encryptionKey = readOrCreateStoreKey(koedHome, resolvedDeps);
    const key = pendingSendKey(input);
    const previous = store.pendingCollaborationSends[key];
    const previousRecord = previous
      ? readPendingSendRecord(encryptionKey, previous)
      : null;
    if (
      previous &&
      (!previousRecord ||
        previousRecord.ownerId !== input.ownerId ||
        previousRecord.body !== input.body)
    ) {
      throw new Error("Collaboration pending send identity was reused.");
    }
    const now = resolvedDeps.now().toISOString();
    const nextLocalCreationOrder =
      Math.max(
        0,
        ...Object.values(store.pendingCollaborationSends).map(
          (record) =>
            record.localCreationOrder ??
            Math.max(1, Date.parse(record.createdAt))
        )
      ) + 1;
    const stored: StoredCollaborationPendingSendRecord = {
      schemaVersion: 1,
      key,
      ownerId: input.ownerId,
      backendId: input.backendId,
      remotePrincipalId: input.remotePrincipalId,
      deviceCredentialId: input.deviceCredentialId,
      scope: input.thread.scope,
      threadId: input.thread.threadId,
      teamId: "teamId" in input.thread ? input.thread.teamId : null,
      clientMessageId: input.clientMessageId,
      localCreationOrder:
        previous?.localCreationOrder ?? nextLocalCreationOrder,
      attemptCount: options.resetAttempts ? 0 : (previous?.attemptCount ?? 0),
      state: "pending",
      failure: null,
      nextAttemptAt: null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      envelope: encryptSecret(
        encryptionKey,
        input.body,
        now,
        resolvedDeps,
        previous?.envelope,
        pendingSendAad(key)
      )
    };
    store.pendingCollaborationSends[key] = stored;
    store.updatedAt = now;
    return {
      result: readPendingSendRecord(encryptionKey, stored)!,
      changed: true
    };
  });
};

export const listCollaborationPendingSends = (
  koedHome: string,
  deps: UpstreamCredentialSecretStoreDeps = {}
): CollaborationPendingSendRecord[] => {
  const resolvedDeps = depsWithDefaults(deps);
  const store = readStoreForRead(koedHome, resolvedDeps);
  const encryptionKey = readStoreKey(koedHome, resolvedDeps);
  if (!store || !encryptionKey) return [];
  return Object.values(store.pendingCollaborationSends)
    .map((record) => readPendingSendRecord(encryptionKey, record))
    .filter((record): record is CollaborationPendingSendRecord =>
      Boolean(record)
    )
    .sort(
      (left, right) =>
        left.localCreationOrder - right.localCreationOrder ||
        left.createdAt.localeCompare(right.createdAt)
    );
};

export const updateCollaborationPendingSendState = (
  koedHome: string,
  input: {
    key: string;
    attemptCount: number;
    state: "pending" | "manual_retry" | "failed";
    failure?: CollaborationSafeError | null;
    nextAttemptAt: string | null;
  },
  deps: UpstreamCredentialSecretStoreDeps = {}
): CollaborationPendingSendRecord | null => {
  if (
    !/^collaboration-send:[a-f0-9]{64}$/.test(input.key) ||
    !Number.isInteger(input.attemptCount) ||
    input.attemptCount < 0 ||
    input.attemptCount > 5 ||
    (input.state === "pending" && (input.failure ?? null) !== null) ||
    (input.state !== "pending" &&
      input.failure !== undefined &&
      !collaborationSafeErrorSchema.safeParse(input.failure).success) ||
    (input.nextAttemptAt !== null && !isCanonicalTimestamp(input.nextAttemptAt))
  ) {
    throw new Error("Collaboration pending send state is invalid.");
  }
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(koedHome, resolvedDeps, ["pending_team_send"], (store) => {
    const stored = store.pendingCollaborationSends[input.key];
    if (!stored) return { result: null, changed: false };
    const encryptionKey = readStoreKey(koedHome, resolvedDeps);
    if (!encryptionKey || !readPendingSendRecord(encryptionKey, stored)) {
      return { result: null, changed: false };
    }
    const now = resolvedDeps.now().toISOString();
    const updated: StoredCollaborationPendingSendRecord = {
      ...stored,
      localCreationOrder:
        stored.localCreationOrder ?? Math.max(1, Date.parse(stored.createdAt)),
      attemptCount: input.attemptCount,
      state: input.state,
      failure:
        input.state === "pending"
          ? null
          : (input.failure ?? stored.failure ?? legacyPendingSendFailure),
      nextAttemptAt: input.nextAttemptAt,
      updatedAt: now
    };
    store.pendingCollaborationSends[input.key] = updated;
    store.updatedAt = now;
    return {
      result: readPendingSendRecord(encryptionKey, updated),
      changed: true
    };
  });
};

export const deleteCollaborationPendingSend = (
  koedHome: string,
  key: string,
  deps: UpstreamCredentialSecretStoreDeps = {}
): boolean => {
  if (!/^collaboration-send:[a-f0-9]{64}$/.test(key)) return false;
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(koedHome, resolvedDeps, ["pending_team_send"], (store) => {
    if (!store.pendingCollaborationSends[key]) {
      return { result: false, changed: false };
    }
    delete store.pendingCollaborationSends[key];
    store.updatedAt = resolvedDeps.now().toISOString();
    return { result: true, changed: true };
  });
};

export const clearCollaborationPendingTeamSends = (
  koedHome: string,
  backendId: string | null,
  deps: UpstreamCredentialSecretStoreDeps = {}
): number => {
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(koedHome, resolvedDeps, ["pending_team_send"], (store) => {
    const keys = Object.entries(store.pendingCollaborationSends)
      .filter(
        ([, record]) =>
          record.scope === "team" &&
          (backendId === null || record.backendId === backendId)
      )
      .map(([key]) => key);
    if (keys.length === 0) return { result: 0, changed: false };
    for (const key of keys) delete store.pendingCollaborationSends[key];
    store.updatedAt = resolvedDeps.now().toISOString();
    return { result: keys.length, changed: true };
  });
};

const parseDesktopLocalCredentialPayload = (
  plaintext: string
): DesktopLocalCredentialPayload | null => {
  try {
    const payload = JSON.parse(plaintext) as Record<string, unknown>;
    const expectedKeys = [
      "version",
      "credentialKeyId",
      "secret",
      "ownerUserId",
      "operationFamilies",
      "createdAt",
      "updatedAt"
    ];
    if (
      !payload ||
      Array.isArray(payload) ||
      Object.keys(payload).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(payload, key)) ||
      payload.version !== 1 ||
      typeof payload.credentialKeyId !== "string" ||
      !desktopCredentialKeyIdPattern.test(payload.credentialKeyId) ||
      typeof payload.secret !== "string" ||
      !desktopCredentialSecretPattern.test(payload.secret) ||
      typeof payload.ownerUserId !== "string" ||
      validateDesktopOwnerUserId(payload.ownerUserId) !== payload.ownerUserId ||
      !Array.isArray(payload.operationFamilies) ||
      !isCanonicalTimestamp(payload.createdAt) ||
      !isCanonicalTimestamp(payload.updatedAt) ||
      payload.updatedAt < payload.createdAt
    ) {
      return null;
    }
    const storedOperationFamilies = payload.operationFamilies;
    const operationFamilies = normalizeDesktopOperationFamilies(
      storedOperationFamilies.filter(
        (family): family is string => typeof family === "string"
      )
    );
    if (
      operationFamilies.length !== storedOperationFamilies.length ||
      operationFamilies.some(
        (family, index) => family !== storedOperationFamilies[index]
      )
    ) {
      return null;
    }
    return {
      version: 1,
      credentialKeyId: payload.credentialKeyId,
      secret: payload.secret,
      ownerUserId: payload.ownerUserId,
      operationFamilies,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt
    };
  } catch {
    return null;
  }
};

const generateDesktopCredentialMaterial = (
  deps: ResolvedStoreDeps
): { credentialKeyId: string; secret: string } => {
  const credentialKeyId = `koed_desktop_${deps
    .randomBytes(20)
    .toString("hex")}`;
  const secret = deps.randomBytes(32).toString("base64url");
  if (
    !desktopCredentialKeyIdPattern.test(credentialKeyId) ||
    !desktopCredentialSecretPattern.test(secret) ||
    !isSafeAuthorizationValue(secret)
  ) {
    throw new Error("Generated desktop local credential is not valid.");
  }
  return { credentialKeyId, secret };
};

const desktopLocalCredentialAuthorization = (
  payload: DesktopLocalCredentialPayload
): DesktopLocalCredentialAuthorization => ({
  version: payload.version,
  authorization: `Koed-Desktop ${payload.credentialKeyId}:${payload.secret}`,
  reference: desktopLocalCredentialReference,
  credentialKeyId: payload.credentialKeyId,
  ownerUserId: payload.ownerUserId,
  operationFamilies: payload.operationFamilies,
  createdAt: payload.createdAt,
  updatedAt: payload.updatedAt
});

const constantTimeStringEqual = (received: string, expected: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(received, "utf8").digest(),
    createHash("sha256").update(expected, "utf8").digest()
  );

export const storeDesktopLocalCredential = (
  koedHome: string,
  input: DesktopLocalCredentialInput,
  deps: UpstreamCredentialSecretStoreDeps = {}
): DesktopLocalCredentialAuthorization => {
  const ownerUserId = validateDesktopOwnerUserId(input.ownerUserId);
  const operationFamilies = normalizeDesktopOperationFamilies(
    input.operationFamilies
  );
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(
    koedHome,
    resolvedDeps,
    ["desktop_credential"],
    (store) => {
      const key = readOrCreateStoreKey(koedHome, resolvedDeps);
      if (store.secrets[desktopLocalCredentialReference]) {
        throw new Error("A desktop local credential is already stored.");
      }
      const now = resolvedDeps.now().toISOString();
      const payload: DesktopLocalCredentialPayload = {
        version: 1,
        ...generateDesktopCredentialMaterial(resolvedDeps),
        ownerUserId,
        operationFamilies,
        createdAt: now,
        updatedAt: now
      };
      store.secrets[desktopLocalCredentialReference] = encryptSecret(
        key,
        JSON.stringify(payload),
        now,
        resolvedDeps
      );
      store.updatedAt = now;
      return {
        result: desktopLocalCredentialAuthorization(payload),
        changed: true
      };
    }
  );
};

export const readDesktopLocalCredentialAuthorization = (
  koedHome: string,
  deps: UpstreamCredentialSecretStoreDeps = {}
): DesktopLocalCredentialAuthorization | null => {
  const resolvedDeps = depsWithDefaults(deps);
  const store = readStoreForRead(koedHome, resolvedDeps);
  const key = readStoreKey(koedHome, resolvedDeps);
  const envelope = store?.secrets[desktopLocalCredentialReference];
  if (!key || !envelope) {
    return null;
  }
  try {
    const payload = parseDesktopLocalCredentialPayload(
      decryptSecret(key, envelope)
    );
    return payload ? desktopLocalCredentialAuthorization(payload) : null;
  } catch {
    return null;
  }
};

export const verifyDesktopLocalCredentialAuthorization = (
  koedHome: string,
  authorization: string | undefined,
  input: { ownerUserId: string; operationFamily: string },
  deps: UpstreamCredentialSecretStoreDeps = {}
): DesktopLocalCredentialAuthorization | null => {
  const match =
    /^Koed-Desktop koed_desktop_[a-f0-9]{40}:[A-Za-z0-9_-]{43}$/.exec(
      authorization ?? ""
    );
  const stored = readDesktopLocalCredentialAuthorization(koedHome, deps);
  if (!match || !stored) {
    return null;
  }
  const credentialMatches = constantTimeStringEqual(
    match[0],
    stored.authorization
  );
  let ownerUserId: string;
  try {
    ownerUserId = validateDesktopOwnerUserId(input.ownerUserId);
  } catch {
    return null;
  }
  return credentialMatches &&
    ownerUserId === stored.ownerUserId &&
    stored.operationFamilies.includes(
      input.operationFamily as DesktopLocalCredentialOperationFamily
    )
    ? stored
    : null;
};

export const rotateDesktopLocalCredential = (
  koedHome: string,
  deps: UpstreamCredentialSecretStoreDeps = {}
): DesktopLocalCredentialAuthorization | null => {
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(
    koedHome,
    resolvedDeps,
    ["desktop_credential"],
    (store) => {
      const key = readStoreKey(koedHome, resolvedDeps);
      const previous = store.secrets[desktopLocalCredentialReference];
      if (!key || !previous) return { result: null, changed: false };
      let current: DesktopLocalCredentialPayload | null;
      try {
        current = parseDesktopLocalCredentialPayload(
          decryptSecret(key, previous)
        );
      } catch {
        return { result: null, changed: false };
      }
      if (!current) return { result: null, changed: false };
      const now = resolvedDeps.now().toISOString();
      const payload: DesktopLocalCredentialPayload = {
        version: 1,
        ...generateDesktopCredentialMaterial(resolvedDeps),
        ownerUserId: current.ownerUserId,
        operationFamilies: current.operationFamilies,
        createdAt: current.createdAt,
        updatedAt: now
      };
      store.secrets[desktopLocalCredentialReference] = encryptSecret(
        key,
        JSON.stringify(payload),
        now,
        resolvedDeps,
        previous
      );
      store.updatedAt = now;
      return {
        result: desktopLocalCredentialAuthorization(payload),
        changed: true
      };
    }
  );
};

export const deleteDesktopLocalCredential = (
  koedHome: string,
  deps: UpstreamCredentialSecretStoreDeps = {}
): boolean =>
  deleteCredentialSecretByReference(
    koedHome,
    desktopLocalCredentialReference,
    "desktop_credential",
    deps
  );

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
  const operationFamilies = normalizeOperationFamilies(input.operationFamilies);
  return mutateStore(
    koedHome,
    resolvedDeps,
    ["local_edge_client_credential"],
    (store) => {
      const key = readOrCreateStoreKey(koedHome, resolvedDeps);
      const now = resolvedDeps.now().toISOString();
      store.secrets[reference] = encryptSecret(
        key,
        JSON.stringify({
          schemaVersion: 1,
          backendId,
          credentialKeyId,
          secret: input.secret,
          operationFamilies
        }),
        now,
        resolvedDeps,
        store.secrets[reference]
      );
      store.updatedAt = now;
      return { result: { reference, credentialKeyId }, changed: true };
    }
  );
};

/**
 * Enrollment-only custody edge: both credentials become durable in the same
 * encrypted-state replacement or neither does.
 */
export const storeEnrollmentCredentialCustody = (
  koedHome: string,
  input: EnrollmentCredentialCustodyInput,
  deps: UpstreamCredentialSecretStoreDeps = {}
): EnrollmentCredentialCustodyResult => {
  if (input.upstream.backendId !== input.localEdgeClient.backendId) {
    throw new Error("Enrollment credential backends do not match.");
  }
  if (!isSafeAuthorizationValue(input.upstream.secret)) {
    throw new Error("Upstream credential secret is not valid.");
  }
  const backendId = validateReferencePart(
    input.upstream.backendId,
    "backendId",
    {
      allowColon: true
    }
  );
  if (!isSafeAuthorizationValue(input.localEdgeClient.secret)) {
    throw new Error("Local-Edge Client Credential secret is not valid.");
  }
  const operationFamilies = normalizeOperationFamilies(
    input.localEdgeClient.operationFamilies
  );
  const upstreamReference = upstreamCredentialReferenceFor(input.upstream);
  const localReference = localEdgeClientCredentialReferenceFor(backendId);
  const credentialKeyId = localEdgeClientCredentialKeyIdFor(backendId);
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(
    koedHome,
    resolvedDeps,
    ["upstream_credential", "local_edge_client_credential"],
    (store) => {
      const key = readOrCreateStoreKey(koedHome, resolvedDeps);
      const now = resolvedDeps.now().toISOString();
      store.secrets[upstreamReference] = encryptSecret(
        key,
        input.upstream.secret,
        now,
        resolvedDeps,
        store.secrets[upstreamReference]
      );
      const payload = JSON.stringify({
        schemaVersion: 1,
        backendId,
        credentialKeyId,
        secret: input.localEdgeClient.secret,
        operationFamilies
      });
      store.secrets[localReference] = encryptSecret(
        key,
        payload,
        now,
        resolvedDeps,
        store.secrets[localReference]
      );
      store.updatedAt = now;
      return {
        result: {
          upstreamReference,
          localEdgeClientReference: localReference,
          localEdgeClientCredentialKeyId: credentialKeyId
        },
        changed: true
      };
    }
  );
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
    "local_edge_client_credential",
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
    "upstream_credential",
    deps
  );
};

const deleteCredentialSecretByReference = (
  koedHome: string,
  normalizedReference: string,
  domain: EncryptedStateDomain,
  deps: UpstreamCredentialSecretStoreDeps
): boolean => {
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(koedHome, resolvedDeps, [domain], (store) => {
    if (!store.secrets[normalizedReference]) {
      return { result: false, changed: false };
    }
    delete store.secrets[normalizedReference];
    store.updatedAt = resolvedDeps.now().toISOString();
    return { result: true, changed: true };
  });
};

const actionGrantSecretPattern = /^hrg_[A-Za-z0-9_-]{43}$/;
const sha256HexPattern = /^[a-f0-9]{64}$/;
const actionGrantStateSet = new Set<CollaborationActionGrantState>([
  "pending",
  "review_required",
  "approved",
  "consumed",
  "denied",
  "revoked",
  "expired",
  "canceled"
]);
const legacyActionGrantStateSet = new Set<StoredLegacyActionGrantState>([
  "pending",
  "approved",
  "consumed",
  "denied",
  "revoked",
  "expired",
  "canceled"
]);

const legacyCompatibleActionGrantState = (
  state: CollaborationActionGrantState | null
): StoredLegacyActionGrantState =>
  state === null || state === "review_required" ? "pending" : state;
const actionGrantOperationFamilySet =
  new Set<CollaborationActionGrantOperationFamily>([
    "admin",
    "share_grant_management",
    "source_download",
    "managed_execution"
  ]);
const actionGrantMethodSet = new Set<CollaborationActionGrantMethod>([
  "POST",
  "PUT",
  "PATCH",
  "DELETE"
]);

const hashCanonicalValue = (domain: string, value: unknown): string =>
  createHash("sha256")
    .update(`${domain}\n${canonicalJsonStringify(value)}`, "utf8")
    .digest("hex");

const validateUuid = (value: string, label: string): string => {
  if (value !== value.trim() || !uuidPattern.test(value)) {
    throw new Error(`${label} must be a valid UUID.`);
  }
  return value.toLowerCase();
};

const normalizeNullableUuid = (
  value: string | null,
  label: string
): string | null => {
  if (value === null) return null;
  return validateUuid(value, label);
};

const validateActionGrantReferenceId = (value: string): string =>
  validateUuid(value, "Action Grant referenceId");

const validateActionGrantAction = (value: string): string => {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(trimmed)) {
    throw new Error("Action Grant action is not valid.");
  }
  return trimmed;
};

const validateActionGrantPath = (value: string): string => {
  const trimmed = value.trim();
  if (
    !trimmed.startsWith("/") ||
    /[\r\n?#]/.test(trimmed) ||
    /(?:^|\/)(?:\.{1,2})(?:\/|$)/.test(trimmed)
  ) {
    throw new Error("Action Grant path is not valid.");
  }
  return trimmed;
};

const validateDeploymentBaseUrl = (
  value: string
): {
  baseUrl: string;
  origin: string;
} => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Action Grant deploymentBaseUrl is invalid.");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
  ) {
    throw new Error("Action Grant deploymentBaseUrl is invalid.");
  }
  assertSecureHttpTransport(parsed, "Action Grant deploymentBaseUrl");
  return {
    baseUrl: parsed.toString().replace(/\/+$/, ""),
    origin: parsed.origin
  };
};

const validateActionGrantActivationUrl = (
  value: string | null,
  deploymentOrigin: string
): string | null => {
  if (value === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Action Grant activationUrl is invalid.");
  }
  if (
    parsed.origin !== deploymentOrigin ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.toString().includes("hrg_") ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
  ) {
    throw new Error("Action Grant activationUrl is invalid.");
  }
  assertSecureHttpTransport(parsed, "Action Grant activationUrl");
  return parsed.toString();
};

const validateCanonicalTimestamp = (value: string, label: string): string => {
  if (!isCanonicalTimestamp(value)) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return value;
};

const actionGrantBodyHash = (body: Record<string, unknown>): string =>
  hashCanonicalValue("koed:collaboration-action-grant-body:v1", body);

const actionGrantRequestHash = (input: {
  method: CollaborationActionGrantMethod;
  path: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
}): string =>
  hashCanonicalValue("koed:collaboration-action-grant-request:v1", input);

const actionGrantAad = (input: {
  referenceId: string;
  commitmentHash: string;
  metadata: StoredActionGrantMetadata;
}): string =>
  canonicalJsonStringify({
    schemaVersion: 1,
    referenceId: input.referenceId,
    commitmentHash: input.commitmentHash,
    metadata: input.metadata
  });

const createActionGrantSecret = (deps: ResolvedStoreDeps): string => {
  const secret = `hrg_${deps.randomBytes(32).toString("base64url")}`;
  if (!actionGrantSecretPattern.test(secret)) {
    throw new Error("Generated Action Grant secret is not valid.");
  }
  return secret;
};

const actionGrantStatusRecord = (
  record: StoredActionGrantRecord
): CollaborationActionGrantStatusRecord | null =>
  record.approvalTier === null || record.approvalState === null
    ? null
    : {
        version: 1,
        actionGrant: { id: record.referenceId },
        approvalTier: record.approvalTier,
        review: record.review,
        state: record.approvalState,
        activationUrl: record.activationUrl,
        expiresAt: record.metadata.expiresAt
      };

const storedString = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
};

const parseStoredActionGrantRecord = (
  referenceId: string,
  candidate: unknown
): StoredActionGrantRecord | null => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  const metadata =
    record.metadata &&
    typeof record.metadata === "object" &&
    !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : null;
  const envelope =
    record.envelope &&
    typeof record.envelope === "object" &&
    !Array.isArray(record.envelope)
      ? (record.envelope as Record<string, unknown>)
      : null;
  if (!metadata || !envelope) {
    return null;
  }
  try {
    const deployment = validateDeploymentBaseUrl(
      storedString(metadata.deploymentBaseUrl, "deploymentBaseUrl")
    );
    const parsedReferenceId = validateActionGrantReferenceId(referenceId);
    const storedStateRaw = record.state;
    const storedState =
      storedStateRaw === null
        ? "pending"
        : legacyActionGrantStateSet.has(
              storedStateRaw as StoredLegacyActionGrantState
            )
          ? (storedStateRaw as StoredLegacyActionGrantState)
          : storedStateRaw === "review_required"
            ? "pending"
            : null;
    if (storedState === null) return null;
    const approvalStateRaw =
      "approvalState" in record ? record.approvalState : storedStateRaw;
    const approvalState =
      approvalStateRaw === null
        ? null
        : actionGrantStateSet.has(
              approvalStateRaw as CollaborationActionGrantState
            )
          ? (approvalStateRaw as CollaborationActionGrantState)
          : null;
    if (approvalStateRaw !== null && approvalState === null) return null;
    const commitmentHash = storedString(
      record.commitmentHash,
      "commitmentHash"
    );
    if (!sha256HexPattern.test(commitmentHash)) {
      return null;
    }
    const ambiguousUntilRaw = record.ambiguousUntil;
    const lifecycle =
      record.lifecycle === "unclassified" ||
      record.lifecycle === "classified" ||
      record.lifecycle === "ambiguous"
        ? record.lifecycle
        : ambiguousUntilRaw !== null
          ? "ambiguous"
          : record.review !== null ||
              (approvalState !== null && approvalState !== "pending")
            ? "classified"
            : "unclassified";
    const activationUrl = validateActionGrantActivationUrl(
      record.activationUrl === null
        ? null
        : storedString(record.activationUrl, "activationUrl"),
      deployment.origin
    );
    const classification =
      lifecycle === "unclassified"
        ? {
            lifecycle,
            approvalTier: null,
            review: null,
            state: "pending" as const,
            approvalState: null,
            activationUrl: null,
            ambiguousUntil: null
          }
        : {
            lifecycle,
            approvalTier:
              record.approvalTier === null
                ? null
                : collaborationApprovalTierSchema.parse(record.approvalTier),
            review:
              record.review === null
                ? null
                : collaborationApprovalReviewSchema.parse(record.review),
            state: legacyCompatibleActionGrantState(approvalState),
            approvalState,
            activationUrl,
            ambiguousUntil:
              ambiguousUntilRaw === null
                ? null
                : validateCanonicalTimestamp(
                    storedString(ambiguousUntilRaw, "ambiguousUntil"),
                    "ambiguousUntil"
                  )
          };
    if (
      lifecycle === "classified" &&
      (classification.approvalTier === null ||
        classification.approvalState === null ||
        classification.ambiguousUntil !== null)
    ) {
      return null;
    }
    if (
      lifecycle === "ambiguous" &&
      (classification.ambiguousUntil === null ||
        (classification.approvalTier === null) !==
          (classification.approvalState === null))
    ) {
      return null;
    }
    const base = {
      schemaVersion: 1,
      referenceId: parsedReferenceId,
      commitmentHash,
      createdAt: validateCanonicalTimestamp(
        storedString(record.createdAt, "createdAt"),
        "createdAt"
      ),
      updatedAt: validateCanonicalTimestamp(
        storedString(record.updatedAt, "updatedAt"),
        "updatedAt"
      ),
      metadata: {
        schemaVersion: 1,
        backendId: validateReferencePart(
          storedString(metadata.backendId, "backendId"),
          "backendId",
          { allowColon: true }
        ),
        deploymentBaseUrl: deployment.baseUrl,
        deploymentOrigin: deployment.origin,
        deviceCredentialId: validateUuid(
          storedString(metadata.deviceCredentialId, "deviceCredentialId"),
          "deviceCredentialId"
        ),
        localOwnerUserId:
          metadata.localOwnerUserId === null
            ? null
            : validateUuid(
                storedString(metadata.localOwnerUserId, "localOwnerUserId"),
                "localOwnerUserId"
              ),
        principalUserId: validateUuid(
          storedString(metadata.principalUserId, "principalUserId"),
          "principalUserId"
        ),
        operationFamily: actionGrantOperationFamilySet.has(
          metadata.operationFamily as CollaborationActionGrantOperationFamily
        )
          ? (metadata.operationFamily as CollaborationActionGrantOperationFamily)
          : (() => {
              throw new Error("invalid operationFamily");
            })(),
        action: validateActionGrantAction(
          storedString(metadata.action, "action")
        ),
        teamId: normalizeNullableUuid(
          metadata.teamId === null
            ? null
            : storedString(metadata.teamId, "teamId"),
          "teamId"
        ),
        targetId: normalizeNullableUuid(
          metadata.targetId === null
            ? null
            : storedString(metadata.targetId, "targetId"),
          "targetId"
        ),
        method: actionGrantMethodSet.has(
          metadata.method as CollaborationActionGrantMethod
        )
          ? (metadata.method as CollaborationActionGrantMethod)
          : (() => {
              throw new Error("invalid method");
            })(),
        path: validateActionGrantPath(storedString(metadata.path, "path")),
        bodyHash: storedString(metadata.bodyHash, "bodyHash"),
        requestHash: storedString(metadata.requestHash, "requestHash"),
        expiresAt: validateCanonicalTimestamp(
          storedString(metadata.expiresAt, "expiresAt"),
          "expiresAt"
        )
      },
      envelope: {
        algorithm:
          envelope.algorithm === "aes-256-gcm"
            ? "aes-256-gcm"
            : (() => {
                throw new Error("invalid envelope");
              })(),
        iv: storedString(envelope.iv, "envelope.iv"),
        tag: storedString(envelope.tag, "envelope.tag"),
        ciphertext: storedString(envelope.ciphertext, "envelope.ciphertext"),
        createdAt: validateCanonicalTimestamp(
          storedString(envelope.createdAt, "envelope.createdAt"),
          "envelope.createdAt"
        ),
        updatedAt: validateCanonicalTimestamp(
          storedString(envelope.updatedAt, "envelope.updatedAt"),
          "envelope.updatedAt"
        )
      }
    };
    const parsed = {
      ...base,
      ...classification
    } as StoredActionGrantRecord;
    if (
      !sha256HexPattern.test(parsed.metadata.bodyHash) ||
      !sha256HexPattern.test(parsed.metadata.requestHash) ||
      parsed.updatedAt < parsed.createdAt ||
      parsed.envelope.updatedAt < parsed.envelope.createdAt ||
      parsed.metadata.expiresAt < parsed.createdAt
    ) {
      return null;
    }
    if (parsed.approvalState !== "pending" && activationUrl !== null) {
      return null;
    }
    if (
      parsed.ambiguousUntil !== null &&
      parsed.ambiguousUntil < parsed.updatedAt
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const deleteActionGrantRecord = (
  store: SecretStoreFile,
  referenceId: string
): boolean => {
  if (!store.actionGrants[referenceId]) return false;
  delete store.actionGrants[referenceId];
  return true;
};

const readParsedActionGrantRecord = (
  store: SecretStoreFile,
  referenceId: string
): StoredActionGrantRecord | null => {
  const parsedReferenceId = validateActionGrantReferenceId(referenceId);
  return parseStoredActionGrantRecord(
    parsedReferenceId,
    store.actionGrants[parsedReferenceId]
  );
};

const validateActionGrantAccess = (
  record: StoredActionGrantRecord,
  input: CollaborationActionGrantAccessInput
): boolean => {
  const deployment = validateDeploymentBaseUrl(input.deploymentBaseUrl);
  return (
    record.referenceId === validateActionGrantReferenceId(input.referenceId) &&
    record.metadata.backendId ===
      validateReferencePart(input.backendId, "backendId", {
        allowColon: true
      }) &&
    record.metadata.deploymentBaseUrl === deployment.baseUrl &&
    record.metadata.deviceCredentialId ===
      validateUuid(input.deviceCredentialId, "deviceCredentialId") &&
    (record.metadata.localOwnerUserId === null ||
      (input.localOwnerUserId !== undefined &&
        record.metadata.localOwnerUserId ===
          validateUuid(input.localOwnerUserId, "localOwnerUserId"))) &&
    record.metadata.principalUserId ===
      validateUuid(input.principalUserId, "principalUserId")
  );
};

const recordIsExpired = (record: StoredActionGrantRecord, now: Date): boolean =>
  Date.parse(record.metadata.expiresAt) <= now.getTime();

const pruneTerminalActionGrantRecords = (
  store: SecretStoreFile,
  now: Date
): boolean => {
  let changed = false;
  for (const [referenceId, value] of Object.entries(store.actionGrants)) {
    const record = parseStoredActionGrantRecord(referenceId, value);
    if (
      !record ||
      recordIsExpired(record, now) ||
      record.approvalState === "consumed" ||
      record.approvalState === "denied" ||
      record.approvalState === "revoked" ||
      record.approvalState === "expired" ||
      record.approvalState === "canceled" ||
      (record.ambiguousUntil !== null &&
        Date.parse(record.ambiguousUntil) <= now.getTime())
    ) {
      delete store.actionGrants[referenceId];
      changed = true;
    }
  }
  return changed;
};

export const storeCollaborationActionGrantCustody = (
  koedHome: string,
  input: CollaborationActionGrantCustodyInput,
  deps: UpstreamCredentialSecretStoreDeps = {}
): {
  referenceId: string;
  secret: string;
  commitmentHash: string;
} => {
  const resolvedDeps = depsWithDefaults(deps);
  const referenceId = validateActionGrantReferenceId(input.referenceId);
  const backendId = validateReferencePart(input.backendId, "backendId", {
    allowColon: true
  });
  const deployment = validateDeploymentBaseUrl(input.deploymentBaseUrl);
  const deviceCredentialId = validateUuid(
    input.deviceCredentialId,
    "deviceCredentialId"
  );
  const localOwnerUserId =
    input.localOwnerUserId === undefined
      ? null
      : validateUuid(input.localOwnerUserId, "localOwnerUserId");
  const principalUserId = validateUuid(
    input.principalUserId,
    "principalUserId"
  );
  if (!actionGrantOperationFamilySet.has(input.operationFamily)) {
    throw new Error("Action Grant operationFamily is not valid.");
  }
  if (!actionGrantMethodSet.has(input.method)) {
    throw new Error("Action Grant method is not valid.");
  }
  const action = validateActionGrantAction(input.action);
  const path = validateActionGrantPath(input.path);
  const teamId = normalizeNullableUuid(input.teamId, "teamId");
  const targetId = normalizeNullableUuid(input.targetId, "targetId");
  const expiresAt = validateCanonicalTimestamp(input.expiresAt, "expiresAt");
  if (!uuidPattern.test(input.idempotencyKey)) {
    throw new Error("Action Grant idempotencyKey must be a UUID.");
  }
  const bodyHash = actionGrantBodyHash(input.body);
  const requestHash = actionGrantRequestHash({
    method: input.method,
    path,
    body: input.body,
    idempotencyKey: input.idempotencyKey.toLowerCase()
  });
  return mutateStore(koedHome, resolvedDeps, ["action_grant"], (store) => {
    const secret = createActionGrantSecret(resolvedDeps);
    const commitmentHash = highRiskActionGrantCommitmentHash(secret);
    const nowDate = resolvedDeps.now();
    const now = nowDate.toISOString();
    const metadata: StoredActionGrantMetadata = {
      schemaVersion: 1,
      backendId,
      deploymentBaseUrl: deployment.baseUrl,
      deploymentOrigin: deployment.origin,
      deviceCredentialId,
      localOwnerUserId,
      principalUserId,
      operationFamily: input.operationFamily,
      action,
      teamId,
      targetId,
      method: input.method,
      path,
      bodyHash,
      requestHash,
      expiresAt
    };
    const key = readOrCreateStoreKey(koedHome, resolvedDeps);
    pruneTerminalActionGrantRecords(store, nowDate);
    if (store.actionGrants[referenceId]) {
      throw new Error("An Action Grant custody record already exists.");
    }
    const record: StoredActionGrantRecord = {
      schemaVersion: 1,
      referenceId,
      commitmentHash,
      lifecycle: "unclassified",
      approvalTier: null,
      review: null,
      state: "pending",
      approvalState: null,
      activationUrl: null,
      ambiguousUntil: null,
      createdAt: now,
      updatedAt: now,
      metadata,
      envelope: encryptSecret(
        key,
        secret,
        now,
        resolvedDeps,
        undefined,
        actionGrantAad({ referenceId, commitmentHash, metadata })
      )
    };
    store.actionGrants[referenceId] = record;
    store.updatedAt = now;
    return {
      result: {
        referenceId,
        secret,
        commitmentHash
      },
      changed: true
    };
  });
};

export const readCollaborationActionGrantCustodyStatus = (
  koedHome: string,
  input: CollaborationActionGrantAccessInput,
  deps: UpstreamCredentialSecretStoreDeps = {}
): CollaborationActionGrantStatusRecord | null => {
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(koedHome, resolvedDeps, ["action_grant"], (store) => {
    const record = readParsedActionGrantRecord(store, input.referenceId);
    if (!record) return { result: null, changed: false };
    const now = resolvedDeps.now();
    if (
      !validateActionGrantAccess(record, input) ||
      recordIsExpired(record, now) ||
      record.approvalState === "consumed" ||
      record.approvalState === "denied" ||
      record.approvalState === "revoked" ||
      record.approvalState === "expired" ||
      record.approvalState === "canceled" ||
      (record.ambiguousUntil !== null &&
        Date.parse(record.ambiguousUntil) <= now.getTime())
    ) {
      deleteActionGrantRecord(store, record.referenceId);
      store.updatedAt = now.toISOString();
      return { result: null, changed: true };
    }
    return { result: actionGrantStatusRecord(record), changed: false };
  });
};

export const readCollaborationActionGrantCustodyCommitmentHash = (
  koedHome: string,
  input: CollaborationActionGrantAccessInput,
  deps: UpstreamCredentialSecretStoreDeps = {}
): string | null => {
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(koedHome, resolvedDeps, ["action_grant"], (store) => {
    const record = readParsedActionGrantRecord(store, input.referenceId);
    if (!record) return { result: null, changed: false };
    const now = resolvedDeps.now();
    if (
      !validateActionGrantAccess(record, input) ||
      recordIsExpired(record, now) ||
      record.approvalState === "consumed" ||
      record.approvalState === "denied" ||
      record.approvalState === "revoked" ||
      record.approvalState === "expired" ||
      record.approvalState === "canceled"
    ) {
      deleteActionGrantRecord(store, record.referenceId);
      store.updatedAt = now.toISOString();
      return { result: null, changed: true };
    }
    return { result: record.commitmentHash, changed: false };
  });
};

export const markCollaborationActionGrantCustodyAmbiguous = (
  koedHome: string,
  input: CollaborationActionGrantAccessInput & { ambiguousUntil: string },
  deps: UpstreamCredentialSecretStoreDeps = {}
): boolean => {
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(koedHome, resolvedDeps, ["action_grant"], (store) => {
    const record = readParsedActionGrantRecord(store, input.referenceId);
    if (!record) return { result: false, changed: false };
    if (!validateActionGrantAccess(record, input)) {
      deleteActionGrantRecord(store, record.referenceId);
      store.updatedAt = resolvedDeps.now().toISOString();
      return { result: false, changed: true };
    }
    const nowIso = resolvedDeps.now().toISOString();
    const ambiguousUntil = validateCanonicalTimestamp(
      input.ambiguousUntil,
      "ambiguousUntil"
    );
    if (ambiguousUntil <= nowIso) return { result: false, changed: false };
    const ambiguous: StoredActionGrantRecord = {
      ...record,
      lifecycle: "ambiguous",
      approvalTier: record.approvalTier,
      review: record.review,
      state: record.state,
      approvalState: record.approvalState,
      activationUrl: record.activationUrl,
      ambiguousUntil,
      updatedAt: nowIso
    };
    store.actionGrants[record.referenceId] = ambiguous;
    store.updatedAt = nowIso;
    return { result: true, changed: true };
  });
};

export const updateCollaborationActionGrantCustodyStatus = (
  koedHome: string,
  input: {
    approvalTier?: CollaborationApprovalTier;
    review?: CollaborationApprovalReview | null;
  } & (
    | (CollaborationActionGrantAccessInput & {
        state: "pending" | "review_required";
        activationUrl: string | null;
        ambiguousUntil?: string | null;
        expiresAt?: string;
      })
    | (CollaborationActionGrantAccessInput & {
        state: "approved";
        activationUrl?: null;
        ambiguousUntil?: string | null;
        expiresAt?: string;
      })
    | (CollaborationActionGrantAccessInput & {
        state: Exclude<
          CollaborationActionGrantState,
          "pending" | "review_required" | "approved"
        >;
        expiresAt?: string;
      })
  ),
  deps: UpstreamCredentialSecretStoreDeps = {}
): CollaborationActionGrantStatusRecord | null => {
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(koedHome, resolvedDeps, ["action_grant"], (store) => {
    const record = readParsedActionGrantRecord(store, input.referenceId);
    if (!record) return { result: null, changed: false };
    if (!validateActionGrantAccess(record, input)) {
      deleteActionGrantRecord(store, record.referenceId);
      store.updatedAt = resolvedDeps.now().toISOString();
      return { result: null, changed: true };
    }
    const nowIso = resolvedDeps.now().toISOString();
    const approvalTier = input.approvalTier ?? record.approvalTier;
    const review =
      input.review === undefined
        ? record.review
        : input.review
          ? collaborationApprovalReviewSchema.parse(input.review)
          : null;
    if (
      approvalTier === null ||
      (approvalTier === "direct") !== (review === null)
    ) {
      return { result: null, changed: false };
    }
    if (
      input.state === "consumed" ||
      input.state === "denied" ||
      input.state === "revoked" ||
      input.state === "expired" ||
      input.state === "canceled"
    ) {
      const expiresAt =
        input.expiresAt === undefined
          ? record.metadata.expiresAt
          : validateCanonicalTimestamp(input.expiresAt, "expiresAt");
      const status: CollaborationActionGrantStatusRecord = {
        version: 1,
        actionGrant: { id: record.referenceId },
        approvalTier,
        review,
        state: input.state,
        activationUrl: null,
        expiresAt
      };
      deleteActionGrantRecord(store, record.referenceId);
      store.updatedAt = nowIso;
      return { result: status, changed: true };
    }
    const ambiguousUntil =
      "ambiguousUntil" in input
        ? input.ambiguousUntil === undefined || input.ambiguousUntil === null
          ? null
          : validateCanonicalTimestamp(input.ambiguousUntil, "ambiguousUntil")
        : null;
    const expiresAt =
      "expiresAt" in input && input.expiresAt !== undefined
        ? validateCanonicalTimestamp(input.expiresAt, "expiresAt")
        : record.metadata.expiresAt;
    const previousMetadata = {
      ...record.metadata
    } satisfies StoredActionGrantMetadata;
    record.state = legacyCompatibleActionGrantState(input.state);
    record.approvalState = input.state;
    record.approvalTier = approvalTier;
    record.review = review;
    record.activationUrl =
      input.state === "pending"
        ? input.activationUrl === null
          ? null
          : validateActionGrantActivationUrl(
              input.activationUrl,
              record.metadata.deploymentOrigin
            )
        : null;
    record.metadata.expiresAt = expiresAt;
    if (record.metadata.expiresAt !== previousMetadata.expiresAt) {
      const key = readStoreKey(koedHome, resolvedDeps);
      if (!key) {
        deleteActionGrantRecord(store, record.referenceId);
        store.updatedAt = nowIso;
        return { result: null, changed: true };
      }
      try {
        const secret = decryptSecret(
          key,
          record.envelope,
          actionGrantAad({
            referenceId: record.referenceId,
            commitmentHash: record.commitmentHash,
            metadata: previousMetadata
          })
        );
        record.envelope = encryptSecret(
          key,
          secret,
          nowIso,
          resolvedDeps,
          undefined,
          actionGrantAad({
            referenceId: record.referenceId,
            commitmentHash: record.commitmentHash,
            metadata: record.metadata
          })
        );
      } catch {
        deleteActionGrantRecord(store, record.referenceId);
        store.updatedAt = nowIso;
        return { result: null, changed: true };
      }
    }
    record.ambiguousUntil = ambiguousUntil;
    record.lifecycle = ambiguousUntil ? "ambiguous" : "classified";
    record.updatedAt = nowIso;
    store.actionGrants[record.referenceId] = record;
    store.updatedAt = nowIso;
    return { result: actionGrantStatusRecord(record), changed: true };
  });
};

export const deleteCollaborationActionGrantCustody = (
  koedHome: string,
  referenceId: string,
  deps: UpstreamCredentialSecretStoreDeps = {}
): boolean => {
  const parsedReferenceId = validateActionGrantReferenceId(referenceId);
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(koedHome, resolvedDeps, ["action_grant"], (store) => {
    if (!deleteActionGrantRecord(store, parsedReferenceId)) {
      return { result: false, changed: false };
    }
    store.updatedAt = resolvedDeps.now().toISOString();
    return { result: true, changed: true };
  });
};

export const clearCollaborationActionGrantCustodyForBackend = (
  koedHome: string,
  backendIdInput: string,
  deps: UpstreamCredentialSecretStoreDeps = {}
): number => {
  const backendId = validateReferencePart(backendIdInput, "backendId", {
    allowColon: true
  });
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(koedHome, resolvedDeps, ["action_grant"], (store) => {
    const keysToDelete = Object.entries(store.actionGrants)
      .filter(([, record]) => record.metadata.backendId === backendId)
      .map(([referenceId]) => referenceId);
    if (keysToDelete.length === 0) {
      return { result: 0, changed: false };
    }
    for (const referenceId of keysToDelete) {
      delete store.actionGrants[referenceId];
    }
    store.updatedAt = resolvedDeps.now().toISOString();
    return { result: keysToDelete.length, changed: true };
  });
};

export const resolveCollaborationActionGrantSecret = (
  koedHome: string,
  input: CollaborationActionGrantResolveInput,
  deps: UpstreamCredentialSecretStoreDeps = {}
): string | null => {
  const resolvedDeps = depsWithDefaults(deps);
  return mutateStore(koedHome, resolvedDeps, ["action_grant"], (store) => {
    const record = readParsedActionGrantRecord(store, input.referenceId);
    if (!record) return { result: null, changed: false };
    const now = resolvedDeps.now();
    const accessMatches = validateActionGrantAccess(record, input);
    const expired = recordIsExpired(record, now);
    const terminal =
      record.approvalState === "consumed" ||
      record.approvalState === "denied" ||
      record.approvalState === "revoked" ||
      record.approvalState === "expired" ||
      record.approvalState === "canceled";
    if (!accessMatches || expired || terminal) {
      deleteActionGrantRecord(store, record.referenceId);
      store.updatedAt = now.toISOString();
      return { result: null, changed: true };
    }
    if (record.approvalState !== "approved") {
      return { result: null, changed: false };
    }
    if (
      record.ambiguousUntil !== null &&
      Date.parse(record.ambiguousUntil) <= now.getTime()
    ) {
      deleteActionGrantRecord(store, record.referenceId);
      store.updatedAt = now.toISOString();
      return { result: null, changed: true };
    }
    if (record.ambiguousUntil !== null) {
      return { result: null, changed: false };
    }
    const validatedPath = validateActionGrantPath(input.path);
    const requestHash = actionGrantRequestHash({
      method: input.method,
      path: validatedPath,
      body: input.body,
      idempotencyKey: validateUuid(input.idempotencyKey, "idempotencyKey")
    });
    const bodyHash = actionGrantBodyHash(input.body);
    if (
      !actionGrantOperationFamilySet.has(input.operationFamily) ||
      record.metadata.operationFamily !== input.operationFamily ||
      record.metadata.action !== validateActionGrantAction(input.action) ||
      record.metadata.teamId !==
        normalizeNullableUuid(input.teamId, "teamId") ||
      record.metadata.targetId !==
        normalizeNullableUuid(input.targetId, "targetId") ||
      record.metadata.method !== input.method ||
      record.metadata.path !== validatedPath ||
      record.metadata.bodyHash !== bodyHash ||
      record.metadata.requestHash !== requestHash
    ) {
      deleteActionGrantRecord(store, record.referenceId);
      store.updatedAt = now.toISOString();
      return { result: null, changed: true };
    }
    const key = readStoreKey(koedHome, resolvedDeps);
    if (!key) return { result: null, changed: false };
    try {
      const secret = decryptSecret(
        key,
        record.envelope,
        actionGrantAad({
          referenceId: record.referenceId,
          commitmentHash: record.commitmentHash,
          metadata: record.metadata
        })
      );
      return {
        result: actionGrantSecretPattern.test(secret) ? secret : null,
        changed: false
      };
    } catch {
      deleteActionGrantRecord(store, record.referenceId);
      store.updatedAt = now.toISOString();
      return { result: null, changed: true };
    }
  });
};
