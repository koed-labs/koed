import { createHash, verify, type KeyObject } from "node:crypto";
import { canonicalize } from "json-canonicalize";

import { pdsEd25519PublicKey } from "./personal-device-sync.js";

export const MANAGED_CONVERSATION_FORK_PROTOCOL =
  "koed.managed-conversation-fork/v1" as const;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface ManagedConversationForkManifest {
  protocol: typeof MANAGED_CONVERSATION_FORK_PROTOCOL;
  operationId: string;
  requestDigest: string;
  ownerUserId: string;
  parentExecutionId: string;
  parentExecutionGeneration: number;
  parentLogicalSessionId: string;
  logicalSourceId: string;
  sourceGenerationId: string;
  parentNextSourceGenerationId: string;
  parentNextOriginKeyId: string;
  sourceClosureHash: string;
  sourceEndByteCursor: number;
  sourceEndItemCursor: number;
  provider: "codex";
  providerThreadId: string;
  providerArtifactRelativePath: string;
  providerCliVersion: string;
  workspaceSnapshotId: string;
  workspaceManifestDigest: string;
  sourceDeploymentId: string;
  sourceDeviceId: string;
  targetDeploymentId: string;
  targetDeviceId: string;
  nonce: string;
  createdAt: string;
  expiresAt: string;
}

export interface SignedManagedConversationForkManifest {
  manifest: ManagedConversationForkManifest;
  source: { keyId: string; signature: string };
}

const plainRecord = (
  value: unknown,
  label: string
): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
};

const uuid = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return value;
};

const digest = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 digest`);
  }
  return value;
};

const positiveInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
};

const nonnegativeInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
};

const timestamp = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be an RFC3339 UTC timestamp`);
  }
  return value;
};

const base64url = (
  value: unknown,
  label: string,
  byteLength: number
): string => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    Buffer.from(value, "base64url").byteLength !== byteLength ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  ) {
    throw new TypeError(`${label} must be canonical base64url`);
  }
  return value;
};

const relativeProviderPath = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError("providerArtifactRelativePath is invalid");
  }
  return value;
};

export const parseManagedConversationForkManifest = (
  value: unknown
): ManagedConversationForkManifest => {
  const input = plainRecord(value, "Managed Conversation fork manifest");
  exactKeys(
    input,
    [
      "protocol",
      "operationId",
      "requestDigest",
      "ownerUserId",
      "parentExecutionId",
      "parentExecutionGeneration",
      "parentLogicalSessionId",
      "logicalSourceId",
      "sourceGenerationId",
      "parentNextSourceGenerationId",
      "parentNextOriginKeyId",
      "sourceClosureHash",
      "sourceEndByteCursor",
      "sourceEndItemCursor",
      "provider",
      "providerThreadId",
      "providerArtifactRelativePath",
      "providerCliVersion",
      "workspaceSnapshotId",
      "workspaceManifestDigest",
      "sourceDeploymentId",
      "sourceDeviceId",
      "targetDeploymentId",
      "targetDeviceId",
      "nonce",
      "createdAt",
      "expiresAt"
    ],
    "Managed Conversation fork manifest"
  );
  if (
    input.protocol !== MANAGED_CONVERSATION_FORK_PROTOCOL ||
    input.provider !== "codex"
  ) {
    throw new TypeError("Managed Conversation fork protocol is invalid");
  }
  if (
    typeof input.providerCliVersion !== "string" ||
    !input.providerCliVersion.trim() ||
    input.providerCliVersion.length > 120
  ) {
    throw new TypeError("providerCliVersion is invalid");
  }
  const parsed: ManagedConversationForkManifest = {
    protocol: input.protocol,
    operationId: uuid(input.operationId, "operationId"),
    requestDigest: digest(input.requestDigest, "requestDigest"),
    ownerUserId: uuid(input.ownerUserId, "ownerUserId"),
    parentExecutionId: uuid(input.parentExecutionId, "parentExecutionId"),
    parentExecutionGeneration: positiveInteger(
      input.parentExecutionGeneration,
      "parentExecutionGeneration"
    ),
    parentLogicalSessionId: uuid(
      input.parentLogicalSessionId,
      "parentLogicalSessionId"
    ),
    logicalSourceId: uuid(input.logicalSourceId, "logicalSourceId"),
    sourceGenerationId: uuid(input.sourceGenerationId, "sourceGenerationId"),
    parentNextSourceGenerationId: uuid(
      input.parentNextSourceGenerationId,
      "parentNextSourceGenerationId"
    ),
    parentNextOriginKeyId: uuid(
      input.parentNextOriginKeyId,
      "parentNextOriginKeyId"
    ),
    sourceClosureHash: digest(input.sourceClosureHash, "sourceClosureHash"),
    sourceEndByteCursor: nonnegativeInteger(
      input.sourceEndByteCursor,
      "sourceEndByteCursor"
    ),
    sourceEndItemCursor: nonnegativeInteger(
      input.sourceEndItemCursor,
      "sourceEndItemCursor"
    ),
    provider: input.provider,
    providerThreadId: uuid(input.providerThreadId, "providerThreadId"),
    providerArtifactRelativePath: relativeProviderPath(
      input.providerArtifactRelativePath
    ),
    providerCliVersion: input.providerCliVersion,
    workspaceSnapshotId: uuid(input.workspaceSnapshotId, "workspaceSnapshotId"),
    workspaceManifestDigest: digest(
      input.workspaceManifestDigest,
      "workspaceManifestDigest"
    ),
    sourceDeploymentId: uuid(input.sourceDeploymentId, "sourceDeploymentId"),
    sourceDeviceId: uuid(input.sourceDeviceId, "sourceDeviceId"),
    targetDeploymentId: uuid(input.targetDeploymentId, "targetDeploymentId"),
    targetDeviceId: uuid(input.targetDeviceId, "targetDeviceId"),
    nonce: base64url(input.nonce, "nonce", 32),
    createdAt: timestamp(input.createdAt, "createdAt"),
    expiresAt: timestamp(input.expiresAt, "expiresAt")
  };
  if (Date.parse(parsed.expiresAt) <= Date.parse(parsed.createdAt)) {
    throw new TypeError("Fork manifest expiry is invalid");
  }
  return parsed;
};

export const canonicalManagedConversationForkManifest = (
  manifest: ManagedConversationForkManifest
): string => canonicalize(parseManagedConversationForkManifest(manifest));

export const parseSignedManagedConversationForkManifest = (
  value: unknown
): SignedManagedConversationForkManifest => {
  const input = plainRecord(value, "Signed Managed Conversation fork manifest");
  exactKeys(
    input,
    ["manifest", "source"],
    "Signed Managed Conversation fork manifest"
  );
  const source = plainRecord(input.source, "Fork source attestation");
  exactKeys(source, ["keyId", "signature"], "Fork source attestation");
  return {
    manifest: parseManagedConversationForkManifest(input.manifest),
    source: {
      keyId: uuid(source.keyId, "source keyId"),
      signature: base64url(source.signature, "source signature", 64)
    }
  };
};

export const verifyManagedConversationForkManifest = (input: {
  signed: SignedManagedConversationForkManifest;
  sourcePublicKey: string | KeyObject;
  expectedTargetDeviceId?: string;
  enforceExpiry?: boolean;
}): boolean => {
  let signed: SignedManagedConversationForkManifest;
  try {
    signed = parseSignedManagedConversationForkManifest(input.signed);
  } catch {
    return false;
  }
  if (
    input.expectedTargetDeviceId &&
    signed.manifest.targetDeviceId !== input.expectedTargetDeviceId
  ) {
    return false;
  }
  if (
    input.enforceExpiry !== false &&
    Date.parse(signed.manifest.expiresAt) <= Date.now()
  ) {
    return false;
  }
  const key =
    typeof input.sourcePublicKey === "string"
      ? pdsEd25519PublicKey(input.sourcePublicKey)
      : input.sourcePublicKey;
  return verify(
    null,
    Buffer.from(canonicalManagedConversationForkManifest(signed.manifest)),
    key,
    Buffer.from(signed.source.signature, "base64url")
  );
};

export const managedConversationForkManifestDigest = (
  signed: SignedManagedConversationForkManifest
): string =>
  createHash("sha256")
    .update(canonicalize(parseSignedManagedConversationForkManifest(signed)))
    .digest("hex");
