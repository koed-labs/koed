import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { aiClientIdentifierPattern } from "./ai-client-contract.js";

import {
  pdsEd25519PrivateKey,
  pdsEd25519PublicKey
} from "./personal-device-sync.js";

export const MANAGED_CONVERSATION_TRANSFER_PROTOCOL =
  "koed.managed-conversation-transfer/v1" as const;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const managedConversationHandoffStates = [
  "quiesce_requested",
  "provider_stopped",
  "source_sealed",
  "workspace_prepared",
  "target_verified",
  "lease_transferred",
  "restoring",
  "identity_verified",
  "running",
  "failed",
  "quarantined"
] as const;

export type ManagedConversationHandoffState =
  (typeof managedConversationHandoffStates)[number];

export interface ManagedConversationHandoffManifest {
  protocol: typeof MANAGED_CONVERSATION_TRANSFER_PROTOCOL;
  operationId: string;
  ownerUserId: string;
  executionId: string;
  sourceExecutionGeneration: number;
  nextExecutionGeneration: number;
  logicalSourceId: string;
  sourceGenerationId: string;
  nextSourceGenerationId: string;
  targetOriginKeyId: string;
  sourceClosureHash: string;
  sourceEndByteCursor: number;
  sourceEndItemCursor: number;
  provider: string;
  providerThreadId: string;
  providerArtifactRelativePath: string;
  providerCliVersion: string;
  workspaceSnapshotId: string;
  workspaceManifestDigest: string;
  sourceDeploymentId: string;
  sourceDeviceId: string;
  targetDeploymentId: string;
  targetDeviceId: string;
  authoritySequence: number;
  priorAuthorityLogHead: string | null;
  nonce: string;
  createdAt: string;
  expiresAt: string;
}

export interface ManagedConversationHandoffCertificate {
  manifest: ManagedConversationHandoffManifest;
  source: { keyId: string; signature: string };
  authority: { keyId: string; signature: string };
}

export const MANAGED_CONVERSATION_TARGET_READINESS_PROTOCOL =
  "koed.managed-conversation-target-readiness/v1" as const;

export const managedConversationTargetReadinessDimensions = [
  "snapshotIntegrity",
  "objectClosure",
  "filesystemFidelity",
  "environmentAvailability",
  "providerCompatibility",
  "executionBoundary"
] as const;

export type ManagedConversationTargetReadinessDimension =
  (typeof managedConversationTargetReadinessDimensions)[number];

export interface ManagedConversationReadinessProof {
  status: "verified";
  evidenceDigest: string;
  checkedAt: string;
  expiresAt: string;
}

export interface ManagedConversationTargetReadinessEvidence {
  protocol: typeof MANAGED_CONVERSATION_TARGET_READINESS_PROTOCOL;
  operationId: string;
  executionId: string;
  snapshotId: string;
  sourceGenerationId: string;
  targetDeploymentId: string;
  targetDeviceId: string;
  dimensions: Record<
    ManagedConversationTargetReadinessDimension,
    ManagedConversationReadinessProof
  >;
}

type RecordValue = Record<string, unknown>;

const record = (value: unknown, label: string): RecordValue => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as RecordValue;
};

const exactKeys = (
  value: RecordValue,
  keys: readonly string[],
  label: string
): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
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

const integer = (value: unknown, label: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${label} must be a safe integer`);
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
    !BASE64URL.test(value) ||
    Buffer.from(value, "base64url").byteLength !== byteLength ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  ) {
    throw new TypeError(`${label} must be canonical base64url`);
  }
  return value;
};

const parseReadinessProof = (
  value: unknown,
  label: string
): ManagedConversationReadinessProof => {
  const input = record(value, label);
  exactKeys(
    input,
    ["status", "evidenceDigest", "checkedAt", "expiresAt"],
    label
  );
  if (input.status !== "verified") {
    throw new TypeError(`${label} status must be verified`);
  }
  const checkedAt = timestamp(input.checkedAt, `${label} checkedAt`);
  const expiresAt = timestamp(input.expiresAt, `${label} expiresAt`);
  if (Date.parse(expiresAt) <= Date.parse(checkedAt)) {
    throw new TypeError(`${label} expiry is invalid`);
  }
  return {
    status: input.status,
    evidenceDigest: digest(input.evidenceDigest, `${label} evidenceDigest`),
    checkedAt,
    expiresAt
  };
};

export const parseManagedConversationTargetReadinessEvidence = (
  value: unknown
): ManagedConversationTargetReadinessEvidence => {
  const input = record(value, "Managed Conversation target readiness");
  exactKeys(
    input,
    [
      "protocol",
      "operationId",
      "executionId",
      "snapshotId",
      "sourceGenerationId",
      "targetDeploymentId",
      "targetDeviceId",
      "dimensions"
    ],
    "Managed Conversation target readiness"
  );
  if (input.protocol !== MANAGED_CONVERSATION_TARGET_READINESS_PROTOCOL) {
    throw new TypeError("Managed Conversation readiness protocol is invalid");
  }
  const dimensions = record(
    input.dimensions,
    "Managed Conversation readiness dimensions"
  );
  exactKeys(
    dimensions,
    managedConversationTargetReadinessDimensions,
    "Managed Conversation readiness dimensions"
  );
  return {
    protocol: input.protocol,
    operationId: uuid(input.operationId, "operationId"),
    executionId: uuid(input.executionId, "executionId"),
    snapshotId: uuid(input.snapshotId, "snapshotId"),
    sourceGenerationId: uuid(input.sourceGenerationId, "sourceGenerationId"),
    targetDeploymentId: uuid(input.targetDeploymentId, "targetDeploymentId"),
    targetDeviceId: uuid(input.targetDeviceId, "targetDeviceId"),
    dimensions: Object.fromEntries(
      managedConversationTargetReadinessDimensions.map((dimension) => [
        dimension,
        parseReadinessProof(
          dimensions[dimension],
          `Managed Conversation readiness ${dimension}`
        )
      ])
    ) as ManagedConversationTargetReadinessEvidence["dimensions"]
  };
};

export const canonicalManagedConversationTargetReadinessEvidence = (
  evidence: ManagedConversationTargetReadinessEvidence
): string =>
  canonicalize(parseManagedConversationTargetReadinessEvidence(evidence));

export const managedConversationTargetReadinessEvidenceDigest = (
  evidence: ManagedConversationTargetReadinessEvidence
): string =>
  createHash("sha256")
    .update(canonicalManagedConversationTargetReadinessEvidence(evidence))
    .digest("hex");

export const managedConversationTargetReadinessIsFresh = (
  evidence: ManagedConversationTargetReadinessEvidence,
  now = new Date()
): boolean => {
  const parsed = parseManagedConversationTargetReadinessEvidence(evidence);
  const current = now.getTime();
  return managedConversationTargetReadinessDimensions.every(
    (dimension) =>
      Date.parse(parsed.dimensions[dimension].checkedAt) <= current &&
      Date.parse(parsed.dimensions[dimension].expiresAt) > current
  );
};

export const parseManagedConversationHandoffManifest = (
  value: unknown
): ManagedConversationHandoffManifest => {
  const input = record(value, "Managed Conversation handoff manifest");
  exactKeys(
    input,
    [
      "protocol",
      "operationId",
      "ownerUserId",
      "executionId",
      "sourceExecutionGeneration",
      "nextExecutionGeneration",
      "logicalSourceId",
      "sourceGenerationId",
      "nextSourceGenerationId",
      "targetOriginKeyId",
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
      "authoritySequence",
      "priorAuthorityLogHead",
      "nonce",
      "createdAt",
      "expiresAt"
    ],
    "Managed Conversation handoff manifest"
  );
  if (input.protocol !== MANAGED_CONVERSATION_TRANSFER_PROTOCOL) {
    throw new TypeError("Managed Conversation transfer protocol is invalid");
  }
  if (
    typeof input.provider !== "string" ||
    input.provider.length > 96 ||
    !aiClientIdentifierPattern.test(input.provider)
  ) {
    throw new TypeError("Managed Conversation provider is invalid");
  }
  const providerArtifactRelativePath =
    typeof input.providerArtifactRelativePath === "string"
      ? input.providerArtifactRelativePath
      : "";
  if (
    !providerArtifactRelativePath ||
    providerArtifactRelativePath.length > 1_024 ||
    providerArtifactRelativePath.startsWith("/") ||
    providerArtifactRelativePath.includes("\\") ||
    providerArtifactRelativePath.includes("\0") ||
    providerArtifactRelativePath
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError("providerArtifactRelativePath is invalid");
  }
  if (
    typeof input.providerCliVersion !== "string" ||
    !input.providerCliVersion.trim() ||
    input.providerCliVersion.length > 120
  ) {
    throw new TypeError("providerCliVersion is invalid");
  }
  const parsed: ManagedConversationHandoffManifest = {
    protocol: input.protocol,
    operationId: uuid(input.operationId, "operationId"),
    ownerUserId: uuid(input.ownerUserId, "ownerUserId"),
    executionId: uuid(input.executionId, "executionId"),
    sourceExecutionGeneration: integer(
      input.sourceExecutionGeneration,
      "sourceExecutionGeneration",
      1
    ),
    nextExecutionGeneration: integer(
      input.nextExecutionGeneration,
      "nextExecutionGeneration",
      2
    ),
    logicalSourceId: uuid(input.logicalSourceId, "logicalSourceId"),
    sourceGenerationId: uuid(input.sourceGenerationId, "sourceGenerationId"),
    nextSourceGenerationId: uuid(
      input.nextSourceGenerationId,
      "nextSourceGenerationId"
    ),
    targetOriginKeyId: uuid(input.targetOriginKeyId, "targetOriginKeyId"),
    sourceClosureHash: digest(input.sourceClosureHash, "sourceClosureHash"),
    sourceEndByteCursor: integer(
      input.sourceEndByteCursor,
      "sourceEndByteCursor"
    ),
    sourceEndItemCursor: integer(
      input.sourceEndItemCursor,
      "sourceEndItemCursor"
    ),
    provider: input.provider,
    providerThreadId: uuid(input.providerThreadId, "providerThreadId"),
    providerArtifactRelativePath,
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
    authoritySequence: integer(input.authoritySequence, "authoritySequence", 1),
    priorAuthorityLogHead:
      input.priorAuthorityLogHead === null
        ? null
        : digest(input.priorAuthorityLogHead, "priorAuthorityLogHead"),
    nonce: base64url(input.nonce, "nonce", 32),
    createdAt: timestamp(input.createdAt, "createdAt"),
    expiresAt: timestamp(input.expiresAt, "expiresAt")
  };
  if (parsed.nextExecutionGeneration !== parsed.sourceExecutionGeneration + 1) {
    throw new TypeError("Handoff execution generations are not contiguous");
  }
  if (parsed.nextSourceGenerationId === parsed.sourceGenerationId) {
    throw new TypeError("Handoff source generations must differ");
  }
  if (Date.parse(parsed.expiresAt) <= Date.parse(parsed.createdAt)) {
    throw new TypeError("Handoff certificate expiry is invalid");
  }
  if (parsed.sourceDeviceId === parsed.targetDeviceId) {
    throw new TypeError("Handoff target must be a different device");
  }
  return parsed;
};

export const canonicalManagedConversationHandoffManifest = (
  manifest: ManagedConversationHandoffManifest
): string => canonicalize(parseManagedConversationHandoffManifest(manifest));

const sourceAttestation = (
  manifest: ManagedConversationHandoffManifest,
  source: { keyId: string; signature: string }
): string =>
  canonicalize({
    manifest: parseManagedConversationHandoffManifest(manifest),
    source
  });

export const verifyManagedConversationHandoffSourceAttestation = (input: {
  manifest: ManagedConversationHandoffManifest;
  source: { keyId: string; signature: string };
  sourcePublicKey: string | KeyObject;
}): boolean => {
  const manifest = parseManagedConversationHandoffManifest(input.manifest);
  try {
    uuid(input.source.keyId, "source keyId");
    base64url(input.source.signature, "source signature", 64);
  } catch {
    return false;
  }
  const sourceKey =
    typeof input.sourcePublicKey === "string"
      ? pdsEd25519PublicKey(input.sourcePublicKey)
      : input.sourcePublicKey;
  return verify(
    null,
    Buffer.from(canonicalize(manifest), "utf8"),
    sourceKey,
    Buffer.from(input.source.signature, "base64url")
  );
};

export const signManagedConversationHandoffCertificate = (input: {
  manifest: ManagedConversationHandoffManifest;
  sourceSigner: { keyId: string; sign(payload: Uint8Array): string };
  authorityKeyId: string;
  authorityPrivateKey: KeyObject;
}): ManagedConversationHandoffCertificate => {
  const manifest = parseManagedConversationHandoffManifest(input.manifest);
  const source = {
    keyId: uuid(input.sourceSigner.keyId, "source keyId"),
    signature: input.sourceSigner.sign(
      Buffer.from(canonicalize(manifest), "utf8")
    )
  };
  base64url(source.signature, "source signature", 64);
  const authority = {
    keyId: uuid(input.authorityKeyId, "authority keyId"),
    signature: sign(
      null,
      Buffer.from(sourceAttestation(manifest, source), "utf8"),
      input.authorityPrivateKey
    ).toString("base64url")
  };
  return parseManagedConversationHandoffCertificate({
    manifest,
    source,
    authority
  });
};

export const countersignManagedConversationHandoffCertificate = (input: {
  manifest: ManagedConversationHandoffManifest;
  source: { keyId: string; signature: string };
  authorityKeyId: string;
  authorityPrivateKey: KeyObject;
}): ManagedConversationHandoffCertificate => {
  const manifest = parseManagedConversationHandoffManifest(input.manifest);
  const source = {
    keyId: uuid(input.source.keyId, "source keyId"),
    signature: base64url(input.source.signature, "source signature", 64)
  };
  return parseManagedConversationHandoffCertificate({
    manifest,
    source,
    authority: {
      keyId: uuid(input.authorityKeyId, "authority keyId"),
      signature: sign(
        null,
        Buffer.from(sourceAttestation(manifest, source), "utf8"),
        input.authorityPrivateKey
      ).toString("base64url")
    }
  });
};

export const parseManagedConversationHandoffCertificate = (
  value: unknown
): ManagedConversationHandoffCertificate => {
  const input = record(value, "Managed Conversation handoff certificate");
  exactKeys(
    input,
    ["manifest", "source", "authority"],
    "Managed Conversation handoff certificate"
  );
  const source = record(input.source, "Handoff source signature");
  const authority = record(input.authority, "Handoff authority signature");
  exactKeys(source, ["keyId", "signature"], "Handoff source signature");
  exactKeys(authority, ["keyId", "signature"], "Handoff authority signature");
  return {
    manifest: parseManagedConversationHandoffManifest(input.manifest),
    source: {
      keyId: uuid(source.keyId, "source keyId"),
      signature: base64url(source.signature, "source signature", 64)
    },
    authority: {
      keyId: uuid(authority.keyId, "authority keyId"),
      signature: base64url(authority.signature, "authority signature", 64)
    }
  };
};

export const verifyManagedConversationHandoffCertificate = (input: {
  certificate: ManagedConversationHandoffCertificate;
  sourcePublicKey: string | KeyObject;
  authorityPublicKey: string | KeyObject;
  now?: Date;
  expectedTargetDeviceId?: string;
  minimumAuthoritySequence?: number;
  expectedPriorAuthorityLogHead?: string | null;
  enforceExpiry?: boolean;
}): boolean => {
  const certificate = parseManagedConversationHandoffCertificate(
    input.certificate
  );
  if (
    ((input.enforceExpiry ?? true) &&
      Date.parse(certificate.manifest.expiresAt) <=
        (input.now ?? new Date()).getTime()) ||
    (input.expectedTargetDeviceId !== undefined &&
      certificate.manifest.targetDeviceId !== input.expectedTargetDeviceId) ||
    (input.minimumAuthoritySequence !== undefined &&
      certificate.manifest.authoritySequence <
        input.minimumAuthoritySequence) ||
    (input.expectedPriorAuthorityLogHead !== undefined &&
      certificate.manifest.priorAuthorityLogHead !==
        input.expectedPriorAuthorityLogHead)
  ) {
    return false;
  }
  const sourceKey =
    typeof input.sourcePublicKey === "string"
      ? pdsEd25519PublicKey(input.sourcePublicKey)
      : input.sourcePublicKey;
  const authorityKey =
    typeof input.authorityPublicKey === "string"
      ? pdsEd25519PublicKey(input.authorityPublicKey)
      : input.authorityPublicKey;
  return (
    verifyManagedConversationHandoffSourceAttestation({
      manifest: certificate.manifest,
      source: certificate.source,
      sourcePublicKey: sourceKey
    }) &&
    verify(
      null,
      Buffer.from(
        sourceAttestation(certificate.manifest, certificate.source),
        "utf8"
      ),
      authorityKey,
      Buffer.from(certificate.authority.signature, "base64url")
    )
  );
};

export const managedConversationHandoffCertificateDigest = (
  certificate: ManagedConversationHandoffCertificate
): string =>
  createHash("sha256")
    .update(
      canonicalize(parseManagedConversationHandoffCertificate(certificate)),
      "utf8"
    )
    .digest("hex");

export const managedConversationAuthorityLogHead = (input: {
  priorHead: string | null;
  sequence: number;
  certificateDigest: string;
}): string =>
  createHash("sha256")
    .update(
      canonicalize({
        priorHead:
          input.priorHead === null
            ? null
            : digest(input.priorHead, "priorHead"),
        sequence: integer(input.sequence, "sequence", 1),
        certificateDigest: digest(input.certificateDigest, "certificateDigest")
      }),
      "utf8"
    )
    .digest("hex");

const transitionMap: Readonly<
  Record<
    ManagedConversationHandoffState,
    readonly ManagedConversationHandoffState[]
  >
> = {
  quiesce_requested: ["provider_stopped", "failed"],
  provider_stopped: ["source_sealed", "failed"],
  source_sealed: ["workspace_prepared", "failed"],
  workspace_prepared: ["target_verified", "failed"],
  target_verified: ["target_verified", "lease_transferred", "failed"],
  lease_transferred: ["restoring", "failed", "quarantined"],
  restoring: ["identity_verified", "failed", "quarantined"],
  identity_verified: ["running", "quarantined"],
  running: [],
  failed: [],
  quarantined: []
};

export const assertManagedConversationHandoffTransition = (
  from: ManagedConversationHandoffState,
  to: ManagedConversationHandoffState
): void => {
  if (!transitionMap[from]?.includes(to)) {
    throw new Error(
      `Invalid Managed Conversation handoff transition: ${from} -> ${to}`
    );
  }
};

export const createManagedConversationAuthorityPrivateKey = (
  privateSeed: string | Buffer,
  publicKey: string | Buffer
): KeyObject => pdsEd25519PrivateKey(privateSeed, publicKey);
