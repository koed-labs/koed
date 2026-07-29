import { createHash, randomUUID } from "node:crypto";

import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_SOURCE_PAGE_MAX_ITEMS,
  collaborationCommandResultSchema,
  collaborationRendererCommandSchema,
  collaborationSafeErrorMessages,
  crossIdentitySyncDeterministicUuid,
  fetchBoundedJsonObject,
  readLocalEdgeClientCredentialAuthorization,
  RemoteRequestTimeoutError,
  RemoteResponseLimitError,
  resolveCollaborationActionGrantSecret,
  sharedMemoryConsentActionGrantBinding,
  sharedMemoryConsentSchema,
  sharedMemoryGrantSchema,
  sharedMemoryPreviewActionGrantBinding,
  sharedMemoryPreviewSchema,
  sharedMemoryRepresentationActionGrantBinding,
  sharedMemoryRevokeActionGrantBinding,
  sharedMemoryShareActionGrantBinding,
  sharedMemorySourceItemSchema,
  type CollaborationCommandResult,
  type CollaborationRendererCommand,
  type LocalEdgeClientCredentialAuthorization,
  type SharedMemoryActionGrantBinding
} from "@koed/shared";
import * as shared from "@koed/shared";
import { z } from "zod";

import {
  readLocalEdgeUpstreamRegistry,
  resolveLocalEdgeRouteDecision,
  safeUpstreamProxyUrl,
  upstreamBackendById,
  type LocalEdgeOperationFamily,
  type LocalEdgeUpstreamBackend,
  type LocalEdgeUpstreamRegistry
} from "./upstream-routing.js";
import { openOpaqueCursor, sealOpaqueCursor } from "./opaque-cursor.js";

const RESPONSE_LIMIT_BYTES = 2 * 1_024 * 1_024;
const REQUEST_TIMEOUT_MS = 30_000;
const CAPABILITY_SCHEMA_VERSION = 6;
const SOURCE_CURSOR_PREFIX = "csmc1";
const PREVIEW_CURSOR_PREFIX = "csmp1";

const sharedMemoryControlCommandNames = [
  "collaboration.load_shared_source_page",
  "collaboration.list_owned_shared_memory_grants",
  "collaboration.preview_shared_memory",
  "collaboration.load_shared_memory_preview_page",
  "collaboration.consent_shared_memory",
  "collaboration.share_memory",
  "collaboration.revoke_shared_memory",
  "collaboration.change_shared_memory_representation"
] as const;

type SharedMemoryControlCommandName =
  (typeof sharedMemoryControlCommandNames)[number];

export type CollaborationSharedMemoryControlCommand = Extract<
  CollaborationRendererCommand,
  { command: SharedMemoryControlCommandName }
>;

type Representation = "memory_events" | "lcm_leaves" | "lcm_rollups";

interface DesktopLocalCredentialAuthorization {
  version: 1;
  authorization: string;
  credentialKeyId: string;
  ownerUserId: string;
  operationFamilies: Array<
    "personal_collaboration_read" | "personal_collaboration_write"
  >;
}

const commandNameSchema = z.enum(sharedMemoryControlCommandNames);
const backendIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/);
const uuidSchema = z.uuid();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const representationSchema = z.enum([
  "memory_events",
  "lcm_leaves",
  "lcm_rollups"
]);
const representationsSchema = z
  .array(representationSchema)
  .min(1)
  .max(3)
  .refine((values) => new Set(values).size === values.length);

const dispatchContextSchema = z
  .object({
    upstreamBackendId: backendIdSchema,
    localOwnerUserId: uuidSchema,
    desktopCredentialKeyId: z.string().min(1).max(160)
  })
  .strict();

export interface CollaborationSharedMemoryControlDispatchContext {
  upstreamBackendId: string;
  localOwnerUserId: string;
  desktopCredentialKeyId: string;
}

const sourceBindingSchema = z
  .object({
    sourceRevision: z.number().int().safe().min(0),
    sourceHash: hashSchema,
    representationPolicyRevision: z.number().int().safe().positive(),
    representationPolicyHash: hashSchema,
    contentPolicyVersion: z.number().int().safe().positive(),
    contentPolicyHash: hashSchema,
    classifierVersion: z.number().int().safe().positive(),
    classifierHash: hashSchema
  })
  .strict();

const redactedSourceItemSchema = z
  .object({
    itemType: z.enum([
      "user_message",
      "assistant_message",
      "thought",
      "tool_call",
      "tool_result",
      "lcm_leaf",
      "lcm_rollup"
    ]),
    schemaVersion: z.literal(1),
    sourceId: uuidSchema,
    sourceLogicalMemoryId: uuidSchema,
    sourceRevision: z.number().int().safe().min(0),
    occurredAt: timestampSchema.nullable(),
    content: z.record(z.string(), z.unknown())
  })
  .strict();

const remotePreviewSchema = z
  .object({
    previewId: uuidSchema,
    previewHash: hashSchema,
    previewRevision: z.number().int().safe().positive(),
    logicalMemoryId: uuidSchema,
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    representation: representationSchema,
    binding: sourceBindingSchema,
    items: z.array(redactedSourceItemSchema).min(1).max(2_048),
    redactedContentHash: hashSchema,
    sourceRevision: z.number().int().safe().min(0),
    sourceHash: hashSchema,
    createdAt: timestampSchema
  })
  .strict();

const persistedPreviewSchema = remotePreviewSchema
  .extend({
    backendId: backendIdSchema,
    localOwnerUserId: uuidSchema,
    upstreamUserId: uuidSchema,
    previewRevision: z.number().int().safe().positive(),
    allowedRepresentations: representationsSchema
  })
  .strict();

export type CollaborationPersistedSharedMemoryPreview = z.infer<
  typeof persistedPreviewSchema
>;

const remoteConsentSchema = z
  .object({
    id: uuidSchema,
    logicalMemoryId: uuidSchema,
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    mode: z.enum(["snapshot", "continuous"]),
    state: z.enum(["pending", "active", "paused", "revoked", "expired"]),
    consentVersion: z.number().int().safe().positive(),
    allowedRepresentations: representationsSchema,
    selectedRepresentation: representationSchema,
    previewRevision: z.number().int().safe().positive(),
    previewHash: hashSchema,
    sourceRevision: z.number().int().safe().min(0),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    activatedAt: timestampSchema.nullable(),
    revokedAt: timestampSchema.nullable()
  })
  .passthrough();

const persistedConsentSchema = z
  .object({
    backendId: backendIdSchema,
    localOwnerUserId: uuidSchema,
    upstreamUserId: uuidSchema,
    previewId: uuidSchema,
    consent: sharedMemoryConsentSchema
  })
  .strict();

export type CollaborationPersistedSharedMemoryConsent = z.infer<
  typeof persistedConsentSchema
>;

const companionScopeSchema = z
  .object({
    scope: z.literal("team"),
    kind: z.literal("shared_session_discussion"),
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    logicalMemoryId: uuidSchema,
    shareGrantId: uuidSchema
  })
  .passthrough();

const remoteGrantSchema = z
  .object({
    id: uuidSchema,
    logicalGrantId: uuidSchema,
    logicalMemoryId: uuidSchema,
    ownerUserId: uuidSchema.nullable(),
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    consentId: uuidSchema,
    ownerAllowedRepresentations: representationsSchema,
    activeRepresentation: representationSchema.nullable(),
    representationPolicyRevision: z.number().int().safe().positive(),
    sourceRevision: z.number().int().safe().min(0),
    grantVersion: z.number().int().safe().positive(),
    lifecycle: z.enum([
      "active",
      "unavailable",
      "revoked",
      "tombstoned",
      "purge_pending",
      "purged"
    ]),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    revokedAt: timestampSchema.nullable(),
    companionScope: companionScopeSchema
  })
  .passthrough();

const remoteOwnerGrantPageSchema = z
  .object({
    shareGrants: z.array(remoteGrantSchema).max(100),
    pagination: z
      .object({
        limit: z.number().int().safe().min(1).max(100),
        offset: z.number().int().safe().min(0).max(10_000),
        hasMore: z.boolean(),
        nextOffset: z.number().int().safe().min(1).max(10_000).nullable()
      })
      .strict()
  })
  .strict();

const remoteMaterializedRepresentationSchema = z
  .object({
    shareGrantId: uuidSchema,
    consentId: uuidSchema,
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    logicalMemoryId: uuidSchema,
    representation: representationSchema,
    sourceRevision: z.number().int().safe().min(0),
    state: z.enum(["available", "stale"])
  })
  .passthrough();

const persistedGrantSchema = z
  .object({
    backendId: backendIdSchema,
    localOwnerUserId: uuidSchema,
    upstreamUserId: uuidSchema,
    grant: sharedMemoryGrantSchema
  })
  .strict();

export type CollaborationPersistedSharedMemoryGrant = z.infer<
  typeof persistedGrantSchema
>;

const previewTargetSchema = z
  .object({
    remoteReplicaId: uuidSchema,
    syncRelationshipId: uuidSchema,
    localSessionId: uuidSchema
  })
  .strict();

interface AuthorityIdentity {
  backendId: string;
  localOwnerUserId: string;
  upstreamUserId: string;
}

export interface CollaborationSharedMemoryAuthorityStore {
  isEnrollmentBound(input: AuthorityIdentity): Promise<boolean>;
  /** Resolves the exact persisted sync replica for the requested source. */
  resolvePreviewTarget(
    input: AuthorityIdentity & {
      logicalMemoryId: string;
      teamId: string;
      workspaceId: string;
      representation: Representation;
    }
  ): Promise<{
    remoteReplicaId: string;
    syncRelationshipId: string;
    localSessionId: string;
  } | null>;
  /** Durably records the response with its authoritative remote revision. */
  persistAuthoritativePreview(input: {
    identity: AuthorityIdentity;
    allowedRepresentations: Representation[];
    preview: z.infer<typeof remotePreviewSchema>;
  }): Promise<CollaborationPersistedSharedMemoryPreview | null>;
  readAuthoritativePreview(
    input: AuthorityIdentity & {
      previewHash: string;
    }
  ): Promise<CollaborationPersistedSharedMemoryPreview | null>;
  persistAuthoritativeConsent(input: {
    identity: AuthorityIdentity;
    previewId: string;
    consent: z.infer<typeof remoteConsentSchema>;
  }): Promise<CollaborationPersistedSharedMemoryConsent | null>;
  readAuthoritativeConsent(
    input: AuthorityIdentity & {
      consentId: string;
    }
  ): Promise<CollaborationPersistedSharedMemoryConsent | null>;
  /** Durably resolves companionThreadId before returning the grant binding. */
  persistAuthoritativeGrant(input: {
    identity: AuthorityIdentity;
    grant: z.infer<typeof remoteGrantSchema>;
    prior: CollaborationPersistedSharedMemoryGrant | null;
    mode?: "mutation" | "revocation" | "authoritative_snapshot";
    companion: {
      companionThreadId: string;
      sharedSessionId: string;
    };
  }): Promise<CollaborationPersistedSharedMemoryGrant | null>;
  readAuthoritativeGrant(
    input: AuthorityIdentity & {
      shareGrantId: string;
    }
  ): Promise<CollaborationPersistedSharedMemoryGrant | null>;
  listAuthoritativeGrants(
    input: AuthorityIdentity & { logicalMemoryId: string }
  ): Promise<CollaborationPersistedSharedMemoryGrant[] | null>;
}

type DesktopCredentialReader = (
  koedHome: string
) => DesktopLocalCredentialAuthorization | null;
type LocalEdgeCredentialReader = (
  koedHome: string,
  backendId: string
) => LocalEdgeClientCredentialAuthorization | null;

export interface CollaborationSharedMemoryControlOptions {
  koedHome: string;
  upstreamBackendsPath: string;
  fetch: typeof fetch;
  resolveUpstreamAuthorization(
    backend: LocalEdgeUpstreamBackend
  ): string | null;
  authorityStore: CollaborationSharedMemoryAuthorityStore;
  ensureEnrollmentBinding?(
    input: AuthorityIdentity & {
      remoteDeviceId: string;
    }
  ): Promise<boolean>;
  prepareLocalLcmRepresentation?(input: {
    localOwnerUserId: string;
    localSessionId: string;
    syncRelationshipId: string;
    representation: "lcm_leaves" | "lcm_rollups";
  }): Promise<"pending" | "ready">;
  readDesktopCredential?: DesktopCredentialReader;
  readLocalEdgeClientCredential?: LocalEdgeCredentialReader;
  readUpstreamRegistry?: (path: string) => LocalEdgeUpstreamRegistry;
  resolveActionGrantSecret?: typeof resolveCollaborationActionGrantSecret;
}

type SharedDesktopCredentialApi = {
  readDesktopLocalCredentialAuthorization?: DesktopCredentialReader;
};

const readStoredDesktopCredential: DesktopCredentialReader = (koedHome) => {
  const api = shared as unknown as SharedDesktopCredentialApi;
  return api.readDesktopLocalCredentialAuthorization?.(koedHome) ?? null;
};

export interface CollaborationSharedMemoryControl {
  resolvePreviewTarget(
    input: {
      logicalMemoryId: string;
      teamId: string;
      workspaceId: string;
      representation: Representation;
      allowedRepresentations: Representation[];
    },
    context: CollaborationSharedMemoryControlDispatchContext
  ): Promise<{ remoteReplicaId: string } | null>;
  resolveConsentPreview(
    input: {
      logicalMemoryId: string;
      teamId: string;
      workspaceId: string;
      selectedRepresentation: Representation;
      allowedRepresentations: Representation[];
      previewRevision: number;
      previewHash: string;
    },
    context: CollaborationSharedMemoryControlDispatchContext
  ): Promise<{ previewId: string } | null>;
  dispatch(
    command: unknown,
    context: CollaborationSharedMemoryControlDispatchContext
  ): Promise<CollaborationCommandResult | null>;
  loadInitialSharedSession(
    input: {
      requestId: string;
      teamId: string;
      workspaceId: string;
      sharedSessionId: string;
      representation: Representation;
      limit: number;
    },
    context: CollaborationSharedMemoryControlDispatchContext
  ): Promise<{
    sourceResult: CollaborationCommandResult;
    companion: Record<string, unknown>;
  } | null>;
}

const safeError = (
  code:
    | "invalid_input"
    | "not_available"
    | "permission_denied"
    | "access_revoked"
    | "conflict"
    | "rate_limited"
    | "offline"
    | "temporarily_unavailable"
    | "representation_pending"
    | "history_expired"
    | "internal_error",
  retryAfterMs: number | null = null
) => ({
  code,
  userMessage: collaborationSafeErrorMessages[code],
  retryable:
    code === "conflict" ||
    code === "rate_limited" ||
    code === "offline" ||
    code === "temporarily_unavailable" ||
    code === "representation_pending",
  retryAfterMs
});

const failure = (
  command: CollaborationSharedMemoryControlCommand,
  code: Parameters<typeof safeError>[0]
): CollaborationCommandResult =>
  collaborationCommandResultSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: command.requestId,
    command: command.command,
    ok: false,
    error: safeError(code)
  });

const success = (
  command: CollaborationSharedMemoryControlCommand,
  data: Record<string, unknown>
): CollaborationCommandResult | null => {
  const parsed = collaborationCommandResultSchema.safeParse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: command.requestId,
    command: command.command,
    ok: true,
    data
  });
  return parsed.success ? parsed.data : null;
};

const isControlCommandName = (
  value: unknown
): value is SharedMemoryControlCommandName =>
  commandNameSchema.safeParse(value).success;

export const isCollaborationSharedMemoryControlCommand = (
  value: unknown
): value is CollaborationSharedMemoryControlCommand => {
  const parsed = collaborationRendererCommandSchema.safeParse(value);
  return parsed.success && isControlCommandName(parsed.data.command);
};

const commandNameFrom = (
  value: unknown
): SharedMemoryControlCommandName | null =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  isControlCommandName((value as { command?: unknown }).command)
    ? ((value as { command: SharedMemoryControlCommandName }).command ?? null)
    : null;

const sameRepresentations = (
  left: readonly Representation[],
  right: readonly Representation[]
): boolean =>
  left.length === right.length &&
  left.every((representation) => right.includes(representation));

const sameIdentity = (
  value: AuthorityIdentity,
  expected: AuthorityIdentity
): boolean =>
  value.backendId === expected.backendId &&
  value.localOwnerUserId === expected.localOwnerUserId &&
  value.upstreamUserId === expected.upstreamUserId;

const authorityIdentity = (
  authority: Pick<
    ResolvedAuthority,
    "backendId" | "localOwnerUserId" | "upstreamUserId"
  >
): AuthorityIdentity => ({
  backendId: authority.backendId,
  localOwnerUserId: authority.localOwnerUserId,
  upstreamUserId: authority.upstreamUserId
});

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalValue(item)])
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalValue(value));

const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

const signCursor = (
  credential: DesktopLocalCredentialAuthorization,
  prefix: string,
  payload: Record<string, unknown>
): string => {
  return sealOpaqueCursor({
    secret: credential.authorization,
    prefix,
    domain: "collaboration-shared-memory",
    payload
  });
};

const readSignedCursor = (
  credential: DesktopLocalCredentialAuthorization,
  prefix: string,
  cursor: string
): unknown | null => {
  return openOpaqueCursor({
    secret: credential.authorization,
    prefix,
    domain: "collaboration-shared-memory",
    cursor
  });
};

const sourceCursorSchema = z
  .object({
    version: z.literal(1),
    backendId: backendIdSchema,
    localOwnerUserId: uuidSchema,
    upstreamUserId: uuidSchema,
    teamId: uuidSchema,
    workspaceId: uuidSchema,
    sharedSessionId: uuidSchema,
    shareGrantId: uuidSchema,
    representation: representationSchema,
    direction: z.enum(["older", "newer"]),
    boundary: z.number().int().safe().min(0),
    snapshotKey: hashSchema
  })
  .strict();

const previewCursorSchema = z
  .object({
    version: z.literal(1),
    backendId: backendIdSchema,
    localOwnerUserId: uuidSchema,
    upstreamUserId: uuidSchema,
    previewId: uuidSchema,
    previewHash: hashSchema,
    offset: z.number().int().safe().min(1),
    snapshotKey: hashSchema
  })
  .strict();

const statusSchema = z
  .object({
    ok: z.literal(true),
    auth: z.literal("device_credential"),
    user: z.object({ id: uuidSchema }).passthrough(),
    credential: z
      .object({
        id: uuidSchema,
        ownerUserId: uuidSchema,
        operationFamilies: z.array(z.string().min(1).max(80)).max(32)
      })
      .passthrough()
  })
  .passthrough()
  .superRefine((status, context) => {
    if (status.credential.ownerUserId !== status.user.id) {
      context.addIssue({
        code: "custom",
        message: "Remote device credential owner does not match principal"
      });
    }
  });

const remoteReadSchema = z
  .object({
    grant: remoteGrantSchema,
    representation: z
      .object({
        shareGrantId: uuidSchema,
        consentId: uuidSchema,
        teamId: uuidSchema,
        teamWorkspaceId: uuidSchema,
        logicalMemoryId: uuidSchema,
        representation: representationSchema,
        sourceRevision: z.number().int().safe().min(0),
        sourceRevisionHash: hashSchema,
        recordVersion: z.number().int().safe().positive(),
        state: z.enum(["available", "stale"])
      })
      .passthrough(),
    items: z
      .array(redactedSourceItemSchema)
      .max(COLLABORATION_SOURCE_PAGE_MAX_ITEMS),
    sourcePage: z
      .object({
        itemOffset: z.number().int().safe().min(0),
        itemCount: z.number().int().safe().min(0)
      })
      .strict(),
    freshness: z.enum(["fresh", "stale"]),
    companionScope: companionScopeSchema
  })
  .strict();

const remoteCompanionThreadSchema = z
  .object({
    id: uuidSchema,
    kind: z.literal("shared_session_discussion"),
    teamId: uuidSchema,
    teamWorkspaceId: uuidSchema,
    sharedLogicalMemoryId: uuidSchema,
    shareGrantId: uuidSchema
  })
  .passthrough();

const retryAfterMs = (response: Response): number | null => {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(300_000, Math.round(seconds * 1_000))
    : null;
};

class ControlFailure extends Error {
  constructor(
    readonly code: Parameters<typeof safeError>[0],
    readonly retryAfter: number | null = null
  ) {
    super("Collaboration Shared Memory control failed");
  }
}

const statusFailure = (response: Response): ControlFailure => {
  if (response.status === 400 || response.status === 422) {
    return new ControlFailure("invalid_input");
  }
  if (response.status === 401 || response.status === 403) {
    return new ControlFailure("permission_denied");
  }
  if (response.status === 404) return new ControlFailure("not_available");
  if (response.status === 409) return new ControlFailure("conflict");
  if (response.status === 410) return new ControlFailure("access_revoked");
  if (response.status === 429) {
    return new ControlFailure("rate_limited", retryAfterMs(response));
  }
  if ([424, 502, 503, 504].includes(response.status)) {
    return new ControlFailure(
      "temporarily_unavailable",
      retryAfterMs(response)
    );
  }
  return new ControlFailure("internal_error");
};

const statusUrl = (backend: LocalEdgeUpstreamBackend): URL => {
  const base = new URL(backend.baseUrl.replace(/\/+$/, "/"));
  if (base.username || base.password || base.search || base.hash) {
    throw new ControlFailure("temporarily_unavailable");
  }
  return new URL("v1/local-edge/device-credentials/status", base);
};

const remoteRequest = async (
  options: CollaborationSharedMemoryControlOptions,
  authority: Pick<ResolvedAuthority, "backend" | "upstreamAuthorization">,
  input: {
    method: "GET" | "POST" | "PUT";
    path: string;
    body?: Record<string, unknown>;
    idempotencyKey?: string;
    actionGrant?: string;
    statusEndpoint?: boolean;
  }
): Promise<Record<string, unknown>> => {
  let remote: Awaited<ReturnType<typeof fetchBoundedJsonObject>>;
  try {
    remote = await fetchBoundedJsonObject(
      options.fetch,
      input.statusEndpoint
        ? statusUrl(authority.backend)
        : safeUpstreamProxyUrl(authority.backend, input.path),
      {
        method: input.method,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: authority.upstreamAuthorization,
          ...(input.method === "GET"
            ? {}
            : { "content-type": "application/json" }),
          ...(input.idempotencyKey
            ? { "idempotency-key": input.idempotencyKey }
            : {}),
          ...(input.actionGrant
            ? { "x-koed-action-grant": input.actionGrant }
            : {})
        },
        ...(input.method === "GET"
          ? {}
          : { body: JSON.stringify(input.body ?? {}) })
      },
      { timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: RESPONSE_LIMIT_BYTES }
    );
  } catch (error) {
    if (error instanceof ControlFailure) throw error;
    throw new ControlFailure(
      error instanceof RemoteRequestTimeoutError
        ? "temporarily_unavailable"
        : error instanceof RemoteResponseLimitError ||
            error instanceof SyntaxError
          ? "internal_error"
          : "offline"
    );
  }
  const { response, payload } = remote;
  if (!response.ok) {
    throw statusFailure(response);
  }
  return payload;
};

interface ResolvedAuthority extends AuthorityIdentity {
  backend: LocalEdgeUpstreamBackend;
  desktopCredential: DesktopLocalCredentialAuthorization;
  upstreamAuthorization: string;
  upstreamDeviceCredentialId: string;
}

const operationFamilyFor = (
  command: CollaborationSharedMemoryControlCommand
): LocalEdgeOperationFamily =>
  command.command === "collaboration.load_shared_source_page" ||
  command.command === "collaboration.load_shared_memory_preview_page"
    ? "team_workspace_read"
    : "share_grant_management";

const desktopFamilyFor = (
  command: CollaborationSharedMemoryControlCommand
): "personal_collaboration_read" | "personal_collaboration_write" =>
  command.command === "collaboration.load_shared_source_page" ||
  command.command === "collaboration.load_shared_memory_preview_page"
    ? "personal_collaboration_read"
    : "personal_collaboration_write";

const supportsSharedMemoryControl = (
  backend: LocalEdgeUpstreamBackend
): boolean => {
  const availability =
    backend.capabilities?.payload?.capabilities?.["memory.collaboration"]
      ?.availability;
  return (
    backend.capabilities?.schemaVersion === CAPABILITY_SCHEMA_VERSION &&
    backend.capabilities.payload?.capabilitySchemaVersion ===
      CAPABILITY_SCHEMA_VERSION &&
    (availability === "available" || availability === "partial")
  );
};

const resolveAuthority = async (
  options: CollaborationSharedMemoryControlOptions,
  command: CollaborationSharedMemoryControlCommand,
  context: z.infer<typeof dispatchContextSchema>
): Promise<ResolvedAuthority> => {
  const readDesktop =
    options.readDesktopCredential ?? readStoredDesktopCredential;
  const desktop = readDesktop(options.koedHome);
  if (
    !desktop ||
    desktop.ownerUserId !== context.localOwnerUserId ||
    desktop.credentialKeyId !== context.desktopCredentialKeyId ||
    !desktop.operationFamilies.includes(desktopFamilyFor(command))
  ) {
    throw new ControlFailure("access_revoked");
  }
  const readRegistry =
    options.readUpstreamRegistry ?? readLocalEdgeUpstreamRegistry;
  const backend = upstreamBackendById(
    readRegistry(options.upstreamBackendsPath),
    context.upstreamBackendId
  );
  if (!backend || !supportsSharedMemoryControl(backend)) {
    throw new ControlFailure("temporarily_unavailable");
  }
  const readLec =
    options.readLocalEdgeClientCredential ??
    readLocalEdgeClientCredentialAuthorization;
  const lec = readLec(options.koedHome, context.upstreamBackendId);
  const operationFamily = operationFamilyFor(command);
  const upstreamAuthorization = options.resolveUpstreamAuthorization(backend);
  if (
    !lec ||
    lec.backendId !== context.upstreamBackendId ||
    !/^Koed-Device\s+[^\s:]+:[^\s]+$/.test(lec.authorization) ||
    /[\r\n]/.test(lec.authorization) ||
    !lec.operationFamilies.includes(operationFamily)
  ) {
    throw new ControlFailure("permission_denied");
  }
  if (
    !upstreamAuthorization ||
    !/^Koed-Device\s+[^\s:]+:[^\s]+$/.test(upstreamAuthorization) ||
    /[\r\n]/.test(upstreamAuthorization)
  ) {
    throw new ControlFailure("temporarily_unavailable");
  }
  const decision = resolveLocalEdgeRouteDecision({
    operationFamily,
    requestedMode: "live_upstream_proxy",
    upstreamBackend: backend,
    upstreamBackendId: context.upstreamBackendId,
    deviceCredential: {
      upstreamBackendId: lec.backendId,
      operationFamilies: lec.operationFamilies
    },
    upstreamCredentialAvailable: true
  });
  if (decision.action !== "live_upstream_proxy") {
    throw new ControlFailure("temporarily_unavailable");
  }
  const provisional: Omit<ResolvedAuthority, "upstreamDeviceCredentialId"> = {
    backend,
    backendId: context.upstreamBackendId,
    localOwnerUserId: context.localOwnerUserId,
    upstreamUserId: context.localOwnerUserId,
    desktopCredential: desktop,
    upstreamAuthorization
  };
  const status = statusSchema.parse(
    await remoteRequest(options, provisional, {
      method: "GET",
      path: "/v1/local-edge/device-credentials/status",
      statusEndpoint: true
    })
  );
  const identity = {
    backendId: context.upstreamBackendId,
    localOwnerUserId: context.localOwnerUserId,
    upstreamUserId: status.user.id
  };
  if (!status.credential.operationFamilies.includes(operationFamily)) {
    throw new ControlFailure("permission_denied");
  }
  const bound = await options.authorityStore.isEnrollmentBound(identity);
  if (
    !bound &&
    !(await options.ensureEnrollmentBinding?.({
      ...identity,
      remoteDeviceId: status.credential.id
    }))
  ) {
    throw new ControlFailure("access_revoked");
  }
  return {
    ...provisional,
    ...identity,
    upstreamDeviceCredentialId: status.credential.id
  };
};

const resolveProtectedActionGrant = (
  options: CollaborationSharedMemoryControlOptions,
  authority: ResolvedAuthority,
  command: CollaborationSharedMemoryControlCommand,
  binding: SharedMemoryActionGrantBinding
): string => {
  if (!("actionGrant" in command.input)) {
    throw new ControlFailure("permission_denied");
  }
  const resolveSecret =
    options.resolveActionGrantSecret ?? resolveCollaborationActionGrantSecret;
  const secret = resolveSecret(options.koedHome, {
    referenceId: command.input.actionGrant.id,
    backendId: authority.backendId,
    deploymentBaseUrl: authority.backend.baseUrl,
    deviceCredentialId: authority.upstreamDeviceCredentialId,
    localOwnerUserId: authority.localOwnerUserId,
    principalUserId: authority.upstreamUserId,
    operationFamily: binding.operationFamily,
    action: binding.action,
    teamId: binding.teamId,
    targetId: binding.targetId,
    method: binding.method,
    path: binding.path,
    body: binding.body,
    idempotencyKey: command.requestId
  });
  if (!secret || !/^hrg_[A-Za-z0-9_-]{20,124}$/.test(secret)) {
    throw new ControlFailure("permission_denied");
  }
  return secret;
};

const textFromContent = (
  item: z.infer<typeof redactedSourceItemSchema>
): {
  body: string;
  toolName: string | null;
  toolCallId: string | null;
} | null => {
  if (
    item.itemType === "user_message" ||
    item.itemType === "assistant_message" ||
    item.itemType === "thought"
  ) {
    return typeof item.content.text === "string" && item.content.text.length > 0
      ? { body: item.content.text, toolName: null, toolCallId: null }
      : null;
  }
  if (item.itemType === "tool_call" || item.itemType === "tool_result") {
    if (
      typeof item.content.toolName !== "string" ||
      item.content.toolName.length === 0 ||
      (item.content.toolCallId !== null &&
        typeof item.content.toolCallId !== "string") ||
      !("payload" in item.content)
    ) {
      return null;
    }
    return {
      body: canonicalJson(item.content.payload),
      toolName: item.content.toolName,
      toolCallId:
        typeof item.content.toolCallId === "string"
          ? item.content.toolCallId
          : null
    };
  }
  return null;
};

const mapSourceItems = (
  representation: Representation,
  items: z.infer<typeof redactedSourceItemSchema>[],
  sequenceOffset: number,
  sourceRevisionHash: string
): z.infer<typeof sharedMemorySourceItemSchema>[] | null => {
  const mapped: z.infer<typeof sharedMemorySourceItemSchema>[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (!item.occurredAt) return null;
    const sequence = sequenceOffset + index + 1;
    if (representation === "memory_events") {
      const text = textFromContent(item);
      const sourceKind =
        item.itemType === "assistant_message" ? "agent_message" : item.itemType;
      if (
        !text ||
        ![
          "user_message",
          "agent_message",
          "thought",
          "tool_call",
          "tool_result"
        ].includes(sourceKind)
      ) {
        return null;
      }
      mapped.push({
        id: item.sourceId,
        representation,
        sequence,
        occurredAt: item.occurredAt,
        sourceItems: [
          {
            id: item.sourceId,
            sourceKind: sourceKind as
              | "user_message"
              | "agent_message"
              | "thought"
              | "tool_call"
              | "tool_result",
            occurredAt: item.occurredAt,
            body: text.body,
            actorName: null,
            toolName: text.toolName,
            toolCallId: text.toolCallId
          }
        ]
      });
      continue;
    }
    const expectedType =
      representation === "lcm_leaves" ? "lcm_leaf" : "lcm_rollup";
    if (
      item.itemType !== expectedType ||
      typeof item.content.summaryText !== "string" ||
      item.content.summaryText.length === 0 ||
      !Array.isArray(item.content.sourceIds) ||
      item.content.sourceIds.length === 0
    ) {
      return null;
    }
    mapped.push({
      id: item.sourceId,
      representation,
      sequence,
      occurredAt: item.occurredAt,
      summaryText: item.content.summaryText,
      sourceCount: item.content.sourceIds.length,
      sourceRevision: `ssr1.${sourceRevisionHash}`
    });
  }
  return mapped;
};

const previewSnapshotKey = (
  preview: CollaborationPersistedSharedMemoryPreview
): string =>
  digest({
    previewId: preview.previewId,
    previewHash: preview.previewHash,
    previewRevision: preview.previewRevision,
    sourceRevision: preview.sourceRevision,
    redactedContentHash: preview.redactedContentHash,
    itemIds: preview.items.map((item) => item.sourceId)
  });

const previewDto = (
  authority: ResolvedAuthority,
  preview: CollaborationPersistedSharedMemoryPreview,
  offset: number,
  limit: number
): z.infer<typeof sharedMemoryPreviewSchema> | null => {
  const slice = preview.items.slice(offset, offset + limit);
  const items = mapSourceItems(
    preview.representation,
    slice,
    offset,
    preview.sourceHash
  );
  if (!items) return null;
  const nextOffset = offset + slice.length;
  return {
    logicalMemoryId: preview.logicalMemoryId,
    teamId: preview.teamId,
    workspaceId: preview.teamWorkspaceId,
    representation: preview.representation,
    allowedRepresentations: preview.allowedRepresentations,
    previewRevision: preview.previewRevision,
    sourceRevision: preview.sourceRevision,
    policyRevision: preview.binding.representationPolicyRevision,
    contentPolicyVersion: preview.binding.contentPolicyVersion,
    classifierVersion: preview.binding.classifierVersion,
    redactedContentHash: preview.redactedContentHash,
    previewHash: preview.previewHash,
    itemCount: preview.items.length,
    items,
    nextCursor:
      nextOffset < preview.items.length
        ? signCursor(authority.desktopCredential, PREVIEW_CURSOR_PREFIX, {
            version: 1,
            backendId: authority.backendId,
            localOwnerUserId: authority.localOwnerUserId,
            upstreamUserId: authority.upstreamUserId,
            previewId: preview.previewId,
            previewHash: preview.previewHash,
            offset: nextOffset,
            snapshotKey: previewSnapshotKey(preview)
          })
        : null
  };
};

const persistedPreviewMatches = (
  preview: CollaborationPersistedSharedMemoryPreview,
  identity: AuthorityIdentity,
  remote: z.infer<typeof remotePreviewSchema>,
  allowedRepresentations: Representation[]
): boolean =>
  sameIdentity(preview, identity) &&
  preview.previewId === remote.previewId &&
  preview.previewHash === remote.previewHash &&
  preview.logicalMemoryId === remote.logicalMemoryId &&
  preview.teamId === remote.teamId &&
  preview.teamWorkspaceId === remote.teamWorkspaceId &&
  preview.representation === remote.representation &&
  preview.sourceRevision === remote.sourceRevision &&
  preview.sourceHash === remote.sourceHash &&
  preview.redactedContentHash === remote.redactedContentHash &&
  canonicalJson(preview.binding) === canonicalJson(remote.binding) &&
  canonicalJson(preview.items) === canonicalJson(remote.items) &&
  sameRepresentations(preview.allowedRepresentations, allowedRepresentations);

const mapConsent = (
  consent: z.infer<typeof remoteConsentSchema>
): z.infer<typeof sharedMemoryConsentSchema> => ({
  id: consent.id,
  logicalMemoryId: consent.logicalMemoryId,
  teamId: consent.teamId,
  workspaceId: consent.teamWorkspaceId,
  mode: consent.mode,
  state: consent.state,
  version: consent.consentVersion,
  allowedRepresentations: consent.allowedRepresentations,
  selectedRepresentation: consent.selectedRepresentation,
  previewRevision: consent.previewRevision,
  previewHash: consent.previewHash,
  sourceRevision: consent.sourceRevision,
  createdAt: consent.createdAt,
  updatedAt: consent.updatedAt,
  activatedAt: consent.activatedAt,
  revokedAt: consent.revokedAt
});

const remoteGrantMatchesPersisted = (
  remote: z.infer<typeof remoteGrantSchema>,
  persisted: CollaborationPersistedSharedMemoryGrant,
  identity: AuthorityIdentity
): boolean => {
  const grant = persisted.grant;
  return (
    sameIdentity(persisted, identity) &&
    grant.id === remote.id &&
    grant.logicalGrantId === remote.logicalGrantId &&
    grant.logicalMemoryId === remote.logicalMemoryId &&
    grant.ownerUserId === remote.ownerUserId &&
    grant.teamId === remote.teamId &&
    grant.workspaceId === remote.teamWorkspaceId &&
    grant.consentId === remote.consentId &&
    sameRepresentations(
      grant.ownerAllowedRepresentations,
      remote.ownerAllowedRepresentations
    ) &&
    grant.activeRepresentation === remote.activeRepresentation &&
    grant.representationPolicyRevision ===
      remote.representationPolicyRevision &&
    grant.sourceRevision === remote.sourceRevision &&
    grant.grantVersion === remote.grantVersion &&
    grant.lifecycle === remote.lifecycle &&
    grant.createdAt === remote.createdAt &&
    grant.updatedAt === remote.updatedAt &&
    grant.revokedAt === remote.revokedAt &&
    remote.companionScope.teamId === grant.teamId &&
    remote.companionScope.teamWorkspaceId === grant.workspaceId &&
    remote.companionScope.logicalMemoryId === grant.logicalMemoryId &&
    remote.companionScope.shareGrantId === grant.id
  );
};

const remoteGrantCanRefreshPersisted = (
  remote: z.infer<typeof remoteGrantSchema>,
  persisted: CollaborationPersistedSharedMemoryGrant,
  identity: AuthorityIdentity
): boolean => {
  const grant = persisted.grant;
  return (
    sameIdentity(persisted, identity) &&
    grant.lifecycle === "active" &&
    remote.lifecycle === "active" &&
    grant.revokedAt === null &&
    remote.revokedAt === null &&
    grant.id === remote.id &&
    grant.logicalGrantId === remote.logicalGrantId &&
    grant.logicalMemoryId === remote.logicalMemoryId &&
    grant.ownerUserId === remote.ownerUserId &&
    grant.teamId === remote.teamId &&
    grant.workspaceId === remote.teamWorkspaceId &&
    grant.consentId === remote.consentId &&
    sameRepresentations(
      grant.ownerAllowedRepresentations,
      remote.ownerAllowedRepresentations
    ) &&
    grant.activeRepresentation === remote.activeRepresentation &&
    grant.representationPolicyRevision ===
      remote.representationPolicyRevision &&
    grant.grantVersion === remote.grantVersion &&
    grant.createdAt === remote.createdAt &&
    remote.sourceRevision > grant.sourceRevision &&
    Date.parse(remote.updatedAt) > Date.parse(grant.updatedAt) &&
    remote.companionScope.teamId === grant.teamId &&
    remote.companionScope.teamWorkspaceId === grant.workspaceId &&
    remote.companionScope.logicalMemoryId === grant.logicalMemoryId &&
    remote.companionScope.shareGrantId === grant.id
  );
};

const requirePersistedGrant = async (
  store: CollaborationSharedMemoryAuthorityStore,
  identity: AuthorityIdentity,
  shareGrantId: string,
  teamId: string,
  workspaceId: string
): Promise<CollaborationPersistedSharedMemoryGrant> => {
  const parsed = persistedGrantSchema.safeParse(
    await store.readAuthoritativeGrant({ ...identity, shareGrantId })
  );
  if (
    !parsed.success ||
    !sameIdentity(parsed.data, identity) ||
    parsed.data.grant.id !== shareGrantId ||
    parsed.data.grant.teamId !== teamId ||
    parsed.data.grant.workspaceId !== workspaceId
  ) {
    throw new ControlFailure("not_available");
  }
  return parsed.data;
};

const persistGrant = async (
  store: CollaborationSharedMemoryAuthorityStore,
  identity: AuthorityIdentity,
  remote: z.infer<typeof remoteGrantSchema>,
  prior: CollaborationPersistedSharedMemoryGrant | null,
  companion: { companionThreadId: string; sharedSessionId: string },
  mode: "mutation" | "revocation" | "authoritative_snapshot" = "mutation"
): Promise<CollaborationPersistedSharedMemoryGrant> => {
  const parsed = persistedGrantSchema.safeParse(
    await store.persistAuthoritativeGrant({
      identity,
      grant: remote,
      prior,
      mode,
      companion
    })
  );
  if (
    !parsed.success ||
    !remoteGrantMatchesPersisted(remote, parsed.data, identity)
  ) {
    throw new ControlFailure("not_available");
  }
  return parsed.data;
};

const createOrResolveCompanion = async (
  options: CollaborationSharedMemoryControlOptions,
  authority: ResolvedAuthority,
  grant: z.infer<typeof remoteGrantSchema>,
  idempotencyKey: string
): Promise<{ companionThreadId: string; sharedSessionId: string }> => {
  const payload = await remoteRequest(options, authority, {
    method: "POST",
    path: `/v1/collaboration/teams/${encodeURIComponent(grant.teamId)}/workspaces/${encodeURIComponent(grant.teamWorkspaceId)}/shared-sessions/${encodeURIComponent(grant.logicalMemoryId)}/discussion`,
    body: { shareGrantId: grant.id },
    idempotencyKey
  });
  const thread = remoteCompanionThreadSchema.safeParse(payload.thread);
  if (
    !thread.success ||
    thread.data.teamId !== grant.teamId ||
    thread.data.teamWorkspaceId !== grant.teamWorkspaceId ||
    thread.data.sharedLogicalMemoryId !== grant.logicalMemoryId ||
    thread.data.shareGrantId !== grant.id
  ) {
    throw new ControlFailure("permission_denied");
  }
  return {
    companionThreadId: thread.data.id,
    sharedSessionId: grant.id
  };
};

const readRemoteGrant = (payload: Record<string, unknown>) => {
  const parsed = remoteGrantSchema.safeParse(payload.grant);
  if (!parsed.success) throw new ControlFailure("internal_error");
  return parsed.data;
};

const queryPath = (
  path: string,
  query: Record<string, string | number | null>
): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
};

const scopedGrantPath = (input: {
  teamId: string;
  workspaceId: string;
  shareGrantId: string;
}): string =>
  `/v1/shared-memory/teams/${encodeURIComponent(input.teamId)}/workspaces/${encodeURIComponent(input.workspaceId)}/share-grants/${encodeURIComponent(input.shareGrantId)}`;

const dispatchLoadSource = async (
  options: CollaborationSharedMemoryControlOptions,
  authority: ResolvedAuthority,
  command: Extract<
    CollaborationSharedMemoryControlCommand,
    { command: "collaboration.load_shared_source_page" }
  >,
  prefetchedPayload?: Record<string, unknown>
): Promise<CollaborationCommandResult> => {
  const ref = command.input.sharedSession;
  const preliminaryCursor = command.input.cursor
    ? sourceCursorSchema.safeParse(
        readSignedCursor(
          authority.desktopCredential,
          SOURCE_CURSOR_PREFIX,
          command.input.cursor
        )
      )
    : null;
  if (command.input.cursor) {
    if (
      !preliminaryCursor?.success ||
      preliminaryCursor.data.backendId !== authority.backendId ||
      preliminaryCursor.data.localOwnerUserId !== authority.localOwnerUserId ||
      preliminaryCursor.data.upstreamUserId !== authority.upstreamUserId ||
      preliminaryCursor.data.teamId !== ref.teamId ||
      preliminaryCursor.data.workspaceId !== ref.workspaceId ||
      preliminaryCursor.data.sharedSessionId !== ref.sharedSessionId ||
      preliminaryCursor.data.shareGrantId !== ref.sharedSessionId ||
      preliminaryCursor.data.direction !== command.input.direction
    ) {
      throw new ControlFailure("history_expired");
    }
  }
  const payload =
    prefetchedPayload ??
    (await remoteRequest(options, authority, {
      method: "GET",
      path: queryPath(
        `${scopedGrantPath({
          teamId: ref.teamId,
          workspaceId: ref.workspaceId,
          shareGrantId: ref.sharedSessionId
        })}/page`,
        {
          representation: preliminaryCursor?.success
            ? preliminaryCursor.data.representation
            : null,
          direction: command.input.direction,
          boundary: preliminaryCursor?.success
            ? preliminaryCursor.data.boundary
            : null,
          limit: command.input.limit
        }
      )
    }));
  const parsed = remoteReadSchema.safeParse(payload.sharedMemory);
  if (!parsed.success) throw new ControlFailure("internal_error");
  const remote = parsed.data;
  const binding = {
    shareGrantId: remote.grant.id,
    logicalMemoryId: remote.grant.logicalMemoryId,
    representation: remote.representation.representation
  };
  if (
    remote.grant.id !== ref.sharedSessionId ||
    remote.grant.teamId !== ref.teamId ||
    remote.grant.teamWorkspaceId !== ref.workspaceId ||
    remote.grant.lifecycle !== "active" ||
    remote.grant.activeRepresentation !== binding.representation ||
    remote.representation.shareGrantId !== binding.shareGrantId ||
    remote.representation.logicalMemoryId !== binding.logicalMemoryId ||
    remote.representation.teamId !== ref.teamId ||
    remote.representation.teamWorkspaceId !== ref.workspaceId ||
    remote.companionScope.shareGrantId !== binding.shareGrantId ||
    remote.companionScope.logicalMemoryId !== binding.logicalMemoryId ||
    remote.companionScope.teamId !== ref.teamId ||
    remote.companionScope.teamWorkspaceId !== ref.workspaceId ||
    remote.items.some(
      (item) =>
        item.sourceLogicalMemoryId !== binding.logicalMemoryId ||
        item.sourceRevision !== remote.representation.sourceRevision
    ) ||
    remote.sourcePage.itemOffset + remote.items.length >
      remote.sourcePage.itemCount
  ) {
    throw new ControlFailure("permission_denied");
  }
  if (
    preliminaryCursor?.success &&
    preliminaryCursor.data.representation !== binding.representation
  ) {
    throw new ControlFailure("history_expired");
  }
  const snapshotKey = digest({
    backendId: authority.backendId,
    upstreamUserId: authority.upstreamUserId,
    teamId: ref.teamId,
    workspaceId: ref.workspaceId,
    shareGrantId: binding.shareGrantId,
    representation: binding.representation,
    sourceRevision: remote.representation.sourceRevision,
    sourceRevisionHash: remote.representation.sourceRevisionHash,
    recordVersion: remote.representation.recordVersion,
    itemCount: remote.sourcePage.itemCount
  });
  const cursor = preliminaryCursor;
  if (
    command.input.cursor &&
    (!cursor?.success ||
      cursor.data.backendId !== authority.backendId ||
      cursor.data.localOwnerUserId !== authority.localOwnerUserId ||
      cursor.data.upstreamUserId !== authority.upstreamUserId ||
      cursor.data.teamId !== ref.teamId ||
      cursor.data.workspaceId !== ref.workspaceId ||
      cursor.data.sharedSessionId !== ref.sharedSessionId ||
      cursor.data.shareGrantId !== binding.shareGrantId ||
      cursor.data.representation !== binding.representation ||
      cursor.data.direction !== command.input.direction ||
      cursor.data.snapshotKey !== snapshotKey ||
      cursor.data.boundary > remote.sourcePage.itemCount)
  ) {
    throw new ControlFailure("history_expired");
  }
  const requestedBoundary = cursor?.success
    ? cursor.data.boundary
    : command.input.direction === "older"
      ? remote.sourcePage.itemCount
      : 0;
  const expectedStart =
    command.input.direction === "older"
      ? Math.max(0, requestedBoundary - command.input.limit)
      : requestedBoundary;
  const expectedEnd =
    command.input.direction === "older"
      ? requestedBoundary
      : Math.min(
          remote.sourcePage.itemCount,
          requestedBoundary + command.input.limit
        );
  const start = remote.sourcePage.itemOffset;
  const end = start + remote.items.length;
  if (start !== expectedStart || end !== expectedEnd) {
    throw new ControlFailure("history_expired");
  }
  const items = mapSourceItems(
    binding.representation,
    remote.items,
    start,
    remote.representation.sourceRevisionHash
  );
  if (!items) throw new ControlFailure("internal_error");
  const cursorBase = {
    version: 1 as const,
    backendId: authority.backendId,
    localOwnerUserId: authority.localOwnerUserId,
    upstreamUserId: authority.upstreamUserId,
    teamId: ref.teamId,
    workspaceId: ref.workspaceId,
    sharedSessionId: ref.sharedSessionId,
    shareGrantId: binding.shareGrantId,
    representation: binding.representation,
    snapshotKey
  };
  const result = success(command, {
    page: {
      snapshotRevision: `ssr1.${snapshotKey}`,
      olderCursor:
        start > 0
          ? signCursor(authority.desktopCredential, SOURCE_CURSOR_PREFIX, {
              ...cursorBase,
              direction: "older",
              boundary: start
            })
          : null,
      newerCursor:
        end < remote.sourcePage.itemCount
          ? signCursor(authority.desktopCredential, SOURCE_CURSOR_PREFIX, {
              ...cursorBase,
              direction: "newer",
              boundary: end
            })
          : null,
      hasOlder: start > 0,
      hasNewer: end < remote.sourcePage.itemCount,
      sharedSessionId: ref.sharedSessionId,
      representation: binding.representation,
      items
    }
  });
  if (!result) throw new ControlFailure("internal_error");
  return result;
};

const dispatchPreview = async (
  options: CollaborationSharedMemoryControlOptions,
  authority: ResolvedAuthority,
  command: Extract<
    CollaborationSharedMemoryControlCommand,
    { command: "collaboration.preview_shared_memory" }
  >
): Promise<CollaborationCommandResult> => {
  const identity = authorityIdentity(authority);
  const target = previewTargetSchema.safeParse(
    await options.authorityStore.resolvePreviewTarget({
      ...identity,
      logicalMemoryId: command.input.logicalMemoryId,
      teamId: command.input.teamId,
      workspaceId: command.input.workspaceId,
      representation: command.input.representation
    })
  );
  if (!target.success) throw new ControlFailure("permission_denied");
  if (command.input.representation !== "memory_events") {
    const preparationState = await options.prepareLocalLcmRepresentation?.({
      localOwnerUserId: authority.localOwnerUserId,
      localSessionId: target.data.localSessionId,
      syncRelationshipId: target.data.syncRelationshipId,
      representation: command.input.representation
    });
    if (preparationState !== "ready") {
      throw new ControlFailure("representation_pending");
    }
  }
  const binding = sharedMemoryPreviewActionGrantBinding({
    referenceId: command.input.actionGrant.id,
    logicalMemoryId: command.input.logicalMemoryId,
    remoteReplicaId: target.data.remoteReplicaId,
    teamId: command.input.teamId,
    teamWorkspaceId: command.input.workspaceId,
    representation: command.input.representation,
    allowedRepresentations: command.input.allowedRepresentations
  });
  const payload = await remoteRequest(options, authority, {
    method: binding.method,
    path: binding.path,
    body: binding.body,
    idempotencyKey: command.requestId,
    actionGrant: resolveProtectedActionGrant(
      options,
      authority,
      command,
      binding
    )
  });
  const remote = remotePreviewSchema.safeParse(payload.preview);
  if (
    !remote.success ||
    remote.data.logicalMemoryId !== command.input.logicalMemoryId ||
    remote.data.teamId !== command.input.teamId ||
    remote.data.teamWorkspaceId !== command.input.workspaceId ||
    remote.data.representation !== command.input.representation ||
    remote.data.sourceRevision !== remote.data.binding.sourceRevision ||
    remote.data.sourceHash !== remote.data.binding.sourceHash ||
    remote.data.items.some(
      (item) =>
        item.sourceLogicalMemoryId !== command.input.logicalMemoryId ||
        item.sourceRevision !== remote.data.sourceRevision
    )
  ) {
    throw new ControlFailure("internal_error");
  }
  const persistedValue =
    await options.authorityStore.persistAuthoritativePreview({
      identity,
      allowedRepresentations: command.input.allowedRepresentations,
      preview: remote.data
    });
  if (persistedValue === null) throw new ControlFailure("not_available");
  const persisted = persistedPreviewSchema.safeParse(persistedValue);
  if (!persisted.success) throw new ControlFailure("internal_error");
  if (
    !persistedPreviewMatches(
      persisted.data,
      identity,
      remote.data,
      command.input.allowedRepresentations
    )
  ) {
    throw new ControlFailure("not_available");
  }
  const dto = previewDto(
    authority,
    persisted.data,
    0,
    COLLABORATION_SOURCE_PAGE_MAX_ITEMS
  );
  const result = dto ? success(command, { preview: dto }) : null;
  if (!result) throw new ControlFailure("internal_error");
  return result;
};

const dispatchPreviewPage = async (
  options: CollaborationSharedMemoryControlOptions,
  authority: ResolvedAuthority,
  command: Extract<
    CollaborationSharedMemoryControlCommand,
    { command: "collaboration.load_shared_memory_preview_page" }
  >
): Promise<CollaborationCommandResult> => {
  const identity = authorityIdentity(authority);
  const cursor = previewCursorSchema.safeParse(
    readSignedCursor(
      authority.desktopCredential,
      PREVIEW_CURSOR_PREFIX,
      command.input.cursor
    )
  );
  if (
    !cursor.success ||
    cursor.data.backendId !== identity.backendId ||
    cursor.data.localOwnerUserId !== identity.localOwnerUserId ||
    cursor.data.upstreamUserId !== identity.upstreamUserId ||
    cursor.data.previewHash !== command.input.previewHash
  ) {
    throw new ControlFailure("history_expired");
  }
  const preview = persistedPreviewSchema.safeParse(
    await options.authorityStore.readAuthoritativePreview({
      ...identity,
      previewHash: command.input.previewHash
    })
  );
  if (
    !preview.success ||
    !sameIdentity(preview.data, identity) ||
    preview.data.previewId !== cursor.data.previewId ||
    preview.data.previewHash !== cursor.data.previewHash ||
    previewSnapshotKey(preview.data) !== cursor.data.snapshotKey ||
    cursor.data.offset >= preview.data.items.length
  ) {
    throw new ControlFailure("history_expired");
  }
  const dto = previewDto(
    authority,
    preview.data,
    cursor.data.offset,
    command.input.limit
  );
  const result = dto ? success(command, { preview: dto }) : null;
  if (!result) throw new ControlFailure("internal_error");
  return result;
};

const requirePreviewForConsent = async (
  options: CollaborationSharedMemoryControlOptions,
  identity: AuthorityIdentity,
  command: Extract<
    CollaborationSharedMemoryControlCommand,
    { command: "collaboration.consent_shared_memory" }
  >
): Promise<CollaborationPersistedSharedMemoryPreview> => {
  const preview = persistedPreviewSchema.safeParse(
    await options.authorityStore.readAuthoritativePreview({
      ...identity,
      previewHash: command.input.previewHash
    })
  );
  if (
    !preview.success ||
    !sameIdentity(preview.data, identity) ||
    preview.data.previewHash !== command.input.previewHash ||
    preview.data.previewRevision !== command.input.previewRevision ||
    preview.data.logicalMemoryId !== command.input.logicalMemoryId ||
    preview.data.teamId !== command.input.teamId ||
    preview.data.teamWorkspaceId !== command.input.workspaceId ||
    preview.data.representation !== command.input.selectedRepresentation ||
    !sameRepresentations(
      preview.data.allowedRepresentations,
      command.input.allowedRepresentations
    )
  ) {
    throw new ControlFailure("conflict");
  }
  return preview.data;
};

const dispatchConsent = async (
  options: CollaborationSharedMemoryControlOptions,
  authority: ResolvedAuthority,
  command: Extract<
    CollaborationSharedMemoryControlCommand,
    { command: "collaboration.consent_shared_memory" }
  >
): Promise<CollaborationCommandResult> => {
  const identity = authorityIdentity(authority);
  const preview = await requirePreviewForConsent(options, identity, command);
  const binding = sharedMemoryConsentActionGrantBinding({
    referenceId: command.input.actionGrant.id,
    consentId: command.input.consentId,
    logicalMemoryId: command.input.logicalMemoryId,
    teamId: command.input.teamId,
    teamWorkspaceId: command.input.workspaceId,
    previewId: preview.previewId,
    mode: command.input.mode,
    allowedRepresentations: command.input.allowedRepresentations,
    selectedRepresentation: command.input.selectedRepresentation,
    previewRevision: command.input.previewRevision,
    previewHash: preview.previewHash,
    expiresAt: command.input.expiresAt
  });
  const payload = await remoteRequest(options, authority, {
    method: binding.method,
    path: binding.path,
    body: binding.body,
    idempotencyKey: command.requestId,
    actionGrant: resolveProtectedActionGrant(
      options,
      authority,
      command,
      binding
    )
  });
  const remote = remoteConsentSchema.safeParse(payload.consent);
  if (!remote.success) throw new ControlFailure("internal_error");
  const dto = mapConsent(remote.data);
  if (
    dto.id !== command.input.consentId ||
    dto.logicalMemoryId !== command.input.logicalMemoryId ||
    dto.teamId !== command.input.teamId ||
    dto.workspaceId !== command.input.workspaceId ||
    dto.mode !== command.input.mode ||
    dto.selectedRepresentation !== command.input.selectedRepresentation ||
    dto.previewRevision !== preview.previewRevision ||
    dto.previewHash !== preview.previewHash ||
    dto.sourceRevision !== preview.sourceRevision ||
    !sameRepresentations(
      dto.allowedRepresentations,
      command.input.allowedRepresentations
    )
  ) {
    throw new ControlFailure("permission_denied");
  }
  const persisted = persistedConsentSchema.safeParse(
    await options.authorityStore.persistAuthoritativeConsent({
      identity,
      previewId: preview.previewId,
      consent: remote.data
    })
  );
  if (
    !persisted.success ||
    !sameIdentity(persisted.data, identity) ||
    persisted.data.previewId !== preview.previewId ||
    canonicalJson(persisted.data.consent) !== canonicalJson(dto)
  ) {
    throw new ControlFailure("not_available");
  }
  const result = success(command, { consent: dto });
  if (!result) throw new ControlFailure("internal_error");
  return result;
};

const materializeSelectedRepresentation = async (input: {
  options: CollaborationSharedMemoryControlOptions;
  authority: ResolvedAuthority;
  operationMutationId: string;
  grant: z.infer<typeof remoteGrantSchema>;
  consent: CollaborationPersistedSharedMemoryConsent;
  preview: CollaborationPersistedSharedMemoryPreview;
}): Promise<void> => {
  const { consent, grant, preview } = input;
  if (
    preview.previewId !== consent.previewId ||
    preview.previewHash !== consent.consent.previewHash ||
    preview.logicalMemoryId !== grant.logicalMemoryId ||
    preview.teamId !== grant.teamId ||
    preview.teamWorkspaceId !== grant.teamWorkspaceId ||
    preview.representation !== consent.consent.selectedRepresentation ||
    preview.sourceRevision !== consent.consent.sourceRevision ||
    grant.consentId !== consent.consent.id ||
    grant.activeRepresentation !== consent.consent.selectedRepresentation ||
    grant.sourceRevision !== consent.consent.sourceRevision
  ) {
    throw new ControlFailure("conflict");
  }
  const materializationMutationId = crossIdentitySyncDeterministicUuid({
    operation: "shared-memory-materialization",
    operationMutationId: input.operationMutationId,
    shareGrantId: grant.id,
    consentId: grant.consentId,
    representation: consent.consent.selectedRepresentation,
    sourceRevision: consent.consent.sourceRevision,
    previewHash: preview.previewHash
  });
  const payload = await remoteRequest(input.options, input.authority, {
    method: "PUT",
    path: `/v1/shared-memory/share-grants/${encodeURIComponent(grant.id)}/representations/${encodeURIComponent(consent.consent.selectedRepresentation)}`,
    body: {
      mutationId: materializationMutationId,
      consentId: grant.consentId,
      expectedGrantVersion: grant.grantVersion,
      preview: {
        previewId: preview.previewId,
        previewHash: preview.previewHash
      }
    },
    idempotencyKey: materializationMutationId
  });
  const materialized = remoteMaterializedRepresentationSchema.safeParse(
    payload.representation
  );
  if (
    !materialized.success ||
    materialized.data.shareGrantId !== grant.id ||
    materialized.data.consentId !== grant.consentId ||
    materialized.data.teamId !== grant.teamId ||
    materialized.data.teamWorkspaceId !== grant.teamWorkspaceId ||
    materialized.data.logicalMemoryId !== grant.logicalMemoryId ||
    materialized.data.representation !==
      consent.consent.selectedRepresentation ||
    materialized.data.sourceRevision !== grant.sourceRevision
  ) {
    throw new ControlFailure("permission_denied");
  }
};

const dispatchShare = async (
  options: CollaborationSharedMemoryControlOptions,
  authority: ResolvedAuthority,
  command: Extract<
    CollaborationSharedMemoryControlCommand,
    { command: "collaboration.share_memory" }
  >
): Promise<CollaborationCommandResult> => {
  const identity = authorityIdentity(authority);
  const consent = persistedConsentSchema.safeParse(
    await options.authorityStore.readAuthoritativeConsent({
      ...identity,
      consentId: command.input.consentId
    })
  );
  if (
    !consent.success ||
    !sameIdentity(consent.data, identity) ||
    consent.data.consent.id !== command.input.consentId ||
    consent.data.consent.logicalMemoryId !== command.input.logicalMemoryId ||
    consent.data.consent.teamId !== command.input.teamId ||
    consent.data.consent.workspaceId !== command.input.workspaceId ||
    consent.data.consent.state !== "active"
  ) {
    throw new ControlFailure("conflict");
  }
  const preview = persistedPreviewSchema.safeParse(
    await options.authorityStore.readAuthoritativePreview({
      ...identity,
      previewHash: consent.data.consent.previewHash
    })
  );
  if (
    !preview.success ||
    !sameIdentity(preview.data, identity) ||
    preview.data.previewId !== consent.data.previewId ||
    preview.data.previewHash !== consent.data.consent.previewHash ||
    preview.data.logicalMemoryId !== command.input.logicalMemoryId ||
    preview.data.teamId !== command.input.teamId ||
    preview.data.teamWorkspaceId !== command.input.workspaceId ||
    preview.data.representation !==
      consent.data.consent.selectedRepresentation ||
    preview.data.sourceRevision !== consent.data.consent.sourceRevision
  ) {
    throw new ControlFailure("conflict");
  }
  const binding = sharedMemoryShareActionGrantBinding({
    referenceId: command.input.actionGrant.id,
    mutationId: command.input.mutationId,
    logicalGrantId: command.input.logicalGrantId,
    logicalMemoryId: command.input.logicalMemoryId,
    teamId: command.input.teamId,
    teamWorkspaceId: command.input.workspaceId,
    consentId: command.input.consentId
  });
  const payload = await remoteRequest(options, authority, {
    method: binding.method,
    path: binding.path,
    body: binding.body,
    idempotencyKey: command.input.mutationId,
    actionGrant: resolveProtectedActionGrant(
      options,
      authority,
      command,
      binding
    )
  });
  const remote = readRemoteGrant(payload);
  if (
    remote.logicalGrantId !== command.input.logicalGrantId ||
    remote.logicalMemoryId !== command.input.logicalMemoryId ||
    remote.teamId !== command.input.teamId ||
    remote.teamWorkspaceId !== command.input.workspaceId ||
    remote.consentId !== command.input.consentId ||
    remote.activeRepresentation !==
      consent.data.consent.selectedRepresentation ||
    remote.sourceRevision !== consent.data.consent.sourceRevision ||
    remote.lifecycle !== "active"
  ) {
    throw new ControlFailure("permission_denied");
  }
  await materializeSelectedRepresentation({
    options,
    authority,
    operationMutationId: command.input.mutationId,
    grant: remote,
    consent: consent.data,
    preview: preview.data
  });
  const persisted = await persistGrant(
    options.authorityStore,
    identity,
    remote,
    null,
    await createOrResolveCompanion(
      options,
      authority,
      remote,
      command.input.mutationId
    )
  );
  const result = success(command, { grant: persisted.grant });
  if (!result) throw new ControlFailure("internal_error");
  return result;
};

const dispatchRevoke = async (
  options: CollaborationSharedMemoryControlOptions,
  authority: ResolvedAuthority,
  command: Extract<
    CollaborationSharedMemoryControlCommand,
    { command: "collaboration.revoke_shared_memory" }
  >
): Promise<CollaborationCommandResult> => {
  const identity = authorityIdentity(authority);
  const prior = await requirePersistedGrant(
    options.authorityStore,
    identity,
    command.input.shareGrantId,
    command.input.teamId,
    command.input.workspaceId
  );
  if (prior.grant.grantVersion !== command.input.expectedGrantVersion) {
    throw new ControlFailure("conflict");
  }
  const binding = sharedMemoryRevokeActionGrantBinding({
    referenceId: command.input.actionGrant.id,
    mutationId: command.input.mutationId,
    teamId: command.input.teamId,
    teamWorkspaceId: command.input.workspaceId,
    shareGrantId: command.input.shareGrantId,
    expectedGrantVersion: command.input.expectedGrantVersion,
    reasonCode: command.input.reasonCode
  });
  const payload = await remoteRequest(options, authority, {
    method: binding.method,
    path: binding.path,
    body: binding.body,
    idempotencyKey: command.input.mutationId,
    actionGrant: resolveProtectedActionGrant(
      options,
      authority,
      command,
      binding
    )
  });
  const remote = readRemoteGrant(payload);
  if (
    remote.id !== prior.grant.id ||
    remote.logicalMemoryId !== prior.grant.logicalMemoryId ||
    remote.teamId !== command.input.teamId ||
    remote.teamWorkspaceId !== command.input.workspaceId ||
    remote.lifecycle !== "revoked" ||
    (prior.grant.lifecycle !== "revoked" &&
      remote.grantVersion <= command.input.expectedGrantVersion) ||
    remote.grantVersion < prior.grant.grantVersion
  ) {
    throw new ControlFailure("permission_denied");
  }
  const persisted = await persistGrant(
    options.authorityStore,
    identity,
    remote,
    prior,
    {
      companionThreadId: prior.grant.companionThreadId,
      sharedSessionId: remote.id
    },
    "revocation"
  );
  const result = success(command, { grant: persisted.grant });
  if (!result) throw new ControlFailure("internal_error");
  return result;
};

const dispatchListOwnedGrants = async (
  options: CollaborationSharedMemoryControlOptions,
  authority: ResolvedAuthority,
  command: Extract<
    CollaborationSharedMemoryControlCommand,
    { command: "collaboration.list_owned_shared_memory_grants" }
  >
): Promise<CollaborationCommandResult> => {
  const identity = authorityIdentity(authority);
  const local = await options.authorityStore.listAuthoritativeGrants({
    ...identity,
    logicalMemoryId: command.input.logicalMemoryId
  });
  if (!local) throw new ControlFailure("not_available");
  const localById = new Map(local.map((grant) => [grant.grant.id, grant]));
  const reconciled: CollaborationPersistedSharedMemoryGrant[] = [];
  const seen = new Set<string>();
  let offset = 0;

  while (true) {
    const payload = await remoteRequest(options, authority, {
      method: "GET",
      path: queryPath(
        `/v1/shared-memory/logical-memories/${encodeURIComponent(command.input.logicalMemoryId)}/share-grants`,
        { limit: 100, offset }
      )
    });
    const page = remoteOwnerGrantPageSchema.safeParse(payload);
    if (
      !page.success ||
      page.data.pagination.limit !== 100 ||
      page.data.pagination.offset !== offset ||
      page.data.shareGrants.some(
        (grant) =>
          grant.logicalMemoryId !== command.input.logicalMemoryId ||
          grant.ownerUserId !== identity.upstreamUserId ||
          seen.has(grant.id)
      )
    ) {
      throw new ControlFailure("permission_denied");
    }
    for (const grant of page.data.shareGrants) seen.add(grant.id);
    if (seen.size > 250) throw new ControlFailure("not_available");

    for (const remote of page.data.shareGrants) {
      const prior = localById.get(remote.id) ?? null;
      if (prior && remote.grantVersion < prior.grant.grantVersion) {
        throw new ControlFailure("permission_denied");
      }
      if (prior && remote.grantVersion === prior.grant.grantVersion) {
        if (remoteGrantMatchesPersisted(remote, prior, identity)) {
          reconciled.push(prior);
          continue;
        }
        if (!remoteGrantCanRefreshPersisted(remote, prior, identity)) {
          throw new ControlFailure("permission_denied");
        }
        const persisted = await persistGrant(
          options.authorityStore,
          identity,
          remote,
          prior,
          {
            companionThreadId: prior.grant.companionThreadId,
            sharedSessionId: remote.id
          },
          "authoritative_snapshot"
        );
        localById.set(remote.id, persisted);
        reconciled.push(persisted);
        continue;
      }
      const companion = prior
        ? {
            companionThreadId: prior.grant.companionThreadId,
            sharedSessionId: remote.id
          }
        : await createOrResolveCompanion(
            options,
            authority,
            remote,
            crossIdentitySyncDeterministicUuid({
              operation: "owner-grant-reconcile-companion",
              shareGrantId: remote.id,
              logicalMemoryId: remote.logicalMemoryId,
              teamId: remote.teamId,
              workspaceId: remote.teamWorkspaceId
            })
          );
      const persisted = await persistGrant(
        options.authorityStore,
        identity,
        remote,
        prior,
        companion,
        "authoritative_snapshot"
      );
      localById.set(remote.id, persisted);
      reconciled.push(persisted);
    }

    const { hasMore, nextOffset } = page.data.pagination;
    if (!hasMore) {
      if (nextOffset !== null) throw new ControlFailure("internal_error");
      break;
    }
    const expectedNextOffset = offset + page.data.shareGrants.length;
    if (
      page.data.shareGrants.length === 0 ||
      nextOffset !== expectedNextOffset ||
      expectedNextOffset > 10_000
    ) {
      throw new ControlFailure("internal_error");
    }
    offset = expectedNextOffset;
  }

  const result = success(command, {
    grants: reconciled.map((grant) => grant.grant)
  });
  if (!result) throw new ControlFailure("internal_error");
  return result;
};

const dispatchChangeRepresentation = async (
  options: CollaborationSharedMemoryControlOptions,
  authority: ResolvedAuthority,
  command: Extract<
    CollaborationSharedMemoryControlCommand,
    { command: "collaboration.change_shared_memory_representation" }
  >
): Promise<CollaborationCommandResult> => {
  const identity = authorityIdentity(authority);
  const [prior, consent] = await Promise.all([
    requirePersistedGrant(
      options.authorityStore,
      identity,
      command.input.shareGrantId,
      command.input.teamId,
      command.input.workspaceId
    ),
    options.authorityStore.readAuthoritativeConsent({
      ...identity,
      consentId: command.input.consentId
    })
  ]);
  const parsedConsent = persistedConsentSchema.safeParse(consent);
  if (
    prior.grant.grantVersion !== command.input.expectedGrantVersion ||
    !parsedConsent.success ||
    !sameIdentity(parsedConsent.data, identity) ||
    parsedConsent.data.consent.id !== command.input.consentId ||
    parsedConsent.data.consent.logicalMemoryId !==
      prior.grant.logicalMemoryId ||
    parsedConsent.data.consent.teamId !== command.input.teamId ||
    parsedConsent.data.consent.workspaceId !== command.input.workspaceId ||
    parsedConsent.data.consent.selectedRepresentation !==
      command.input.representation ||
    parsedConsent.data.consent.state !== "active"
  ) {
    throw new ControlFailure("conflict");
  }
  const parsedPreview = persistedPreviewSchema.safeParse(
    await options.authorityStore.readAuthoritativePreview({
      ...identity,
      previewHash: parsedConsent.data.consent.previewHash
    })
  );
  if (
    !parsedPreview.success ||
    !sameIdentity(parsedPreview.data, identity) ||
    parsedPreview.data.previewId !== parsedConsent.data.previewId ||
    parsedPreview.data.previewHash !== parsedConsent.data.consent.previewHash ||
    parsedPreview.data.logicalMemoryId !== prior.grant.logicalMemoryId ||
    parsedPreview.data.teamId !== command.input.teamId ||
    parsedPreview.data.teamWorkspaceId !== command.input.workspaceId ||
    parsedPreview.data.representation !== command.input.representation ||
    parsedPreview.data.sourceRevision !==
      parsedConsent.data.consent.sourceRevision
  ) {
    throw new ControlFailure("conflict");
  }
  const binding = sharedMemoryRepresentationActionGrantBinding({
    referenceId: command.input.actionGrant.id,
    mutationId: command.input.mutationId,
    teamId: command.input.teamId,
    teamWorkspaceId: command.input.workspaceId,
    shareGrantId: command.input.shareGrantId,
    consentId: command.input.consentId,
    representation: command.input.representation,
    expectedGrantVersion: command.input.expectedGrantVersion
  });
  const payload = await remoteRequest(options, authority, {
    method: binding.method,
    path: binding.path,
    body: binding.body,
    idempotencyKey: command.input.mutationId,
    actionGrant: resolveProtectedActionGrant(
      options,
      authority,
      command,
      binding
    )
  });
  const remote = readRemoteGrant(payload);
  if (
    remote.id !== prior.grant.id ||
    remote.logicalMemoryId !== prior.grant.logicalMemoryId ||
    remote.teamId !== command.input.teamId ||
    remote.teamWorkspaceId !== command.input.workspaceId ||
    remote.consentId !== command.input.consentId ||
    remote.activeRepresentation !== command.input.representation ||
    remote.sourceRevision !== parsedConsent.data.consent.sourceRevision ||
    remote.lifecycle !== "active" ||
    remote.grantVersion <= command.input.expectedGrantVersion
  ) {
    throw new ControlFailure("permission_denied");
  }
  await materializeSelectedRepresentation({
    options,
    authority,
    operationMutationId: command.input.mutationId,
    grant: remote,
    consent: parsedConsent.data,
    preview: parsedPreview.data
  });
  const persisted = await persistGrant(
    options.authorityStore,
    identity,
    remote,
    prior,
    {
      companionThreadId: prior.grant.companionThreadId,
      sharedSessionId: remote.id
    }
  );
  const result = success(command, { grant: persisted.grant });
  if (!result) throw new ControlFailure("internal_error");
  return result;
};

const dispatchResolved = async (
  options: CollaborationSharedMemoryControlOptions,
  authority: ResolvedAuthority,
  command: CollaborationSharedMemoryControlCommand
): Promise<CollaborationCommandResult> => {
  switch (command.command) {
    case "collaboration.load_shared_source_page":
      return dispatchLoadSource(options, authority, command);
    case "collaboration.list_owned_shared_memory_grants":
      return dispatchListOwnedGrants(options, authority, command);
    case "collaboration.preview_shared_memory":
      return dispatchPreview(options, authority, command);
    case "collaboration.load_shared_memory_preview_page":
      return dispatchPreviewPage(options, authority, command);
    case "collaboration.consent_shared_memory":
      return dispatchConsent(options, authority, command);
    case "collaboration.share_memory":
      return dispatchShare(options, authority, command);
    case "collaboration.revoke_shared_memory":
      return dispatchRevoke(options, authority, command);
    case "collaboration.change_shared_memory_representation":
      return dispatchChangeRepresentation(options, authority, command);
  }
};

export const createCollaborationSharedMemoryControl = (
  options: CollaborationSharedMemoryControlOptions
): CollaborationSharedMemoryControl => ({
  async resolvePreviewTarget(input, contextInput) {
    const context = dispatchContextSchema.safeParse(contextInput);
    const parsedInput = z
      .object({
        logicalMemoryId: uuidSchema,
        teamId: uuidSchema,
        workspaceId: uuidSchema,
        representation: representationSchema,
        allowedRepresentations: representationsSchema
      })
      .strict()
      .safeParse(input);
    if (!context.success || !parsedInput.success) return null;
    try {
      const command = collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.preview_shared_memory",
        input: {
          logicalMemoryId: parsedInput.data.logicalMemoryId,
          teamId: parsedInput.data.teamId,
          workspaceId: parsedInput.data.workspaceId,
          representation: parsedInput.data.representation,
          allowedRepresentations: parsedInput.data.allowedRepresentations,
          actionGrant: { id: randomUUID() }
        }
      });
      if (command.command !== "collaboration.preview_shared_memory") {
        return null;
      }
      const authority = await resolveAuthority(options, command, context.data);
      const target = previewTargetSchema.safeParse(
        await options.authorityStore.resolvePreviewTarget({
          ...authorityIdentity(authority),
          logicalMemoryId: parsedInput.data.logicalMemoryId,
          teamId: parsedInput.data.teamId,
          workspaceId: parsedInput.data.workspaceId,
          representation: parsedInput.data.representation
        })
      );
      return target.success ? target.data : null;
    } catch {
      return null;
    }
  },
  async resolveConsentPreview(input, contextInput) {
    const context = dispatchContextSchema.safeParse(contextInput);
    const parsedInput = z
      .object({
        logicalMemoryId: uuidSchema,
        teamId: uuidSchema,
        workspaceId: uuidSchema,
        selectedRepresentation: representationSchema,
        allowedRepresentations: representationsSchema,
        previewRevision: z.number().int().safe().positive(),
        previewHash: hashSchema
      })
      .strict()
      .safeParse(input);
    if (!context.success || !parsedInput.success) return null;
    try {
      const command = collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.consent_shared_memory",
        input: {
          consentId: randomUUID(),
          logicalMemoryId: parsedInput.data.logicalMemoryId,
          teamId: parsedInput.data.teamId,
          workspaceId: parsedInput.data.workspaceId,
          mode: "snapshot",
          allowedRepresentations: parsedInput.data.allowedRepresentations,
          selectedRepresentation: parsedInput.data.selectedRepresentation,
          previewRevision: parsedInput.data.previewRevision,
          previewHash: parsedInput.data.previewHash,
          expiresAt: null,
          actionGrant: { id: randomUUID() }
        }
      });
      if (command.command !== "collaboration.consent_shared_memory") {
        return null;
      }
      const authority = await resolveAuthority(options, command, context.data);
      const identity = authorityIdentity(authority);
      const preview = persistedPreviewSchema.safeParse(
        await options.authorityStore.readAuthoritativePreview({
          ...identity,
          previewHash: parsedInput.data.previewHash
        })
      );
      if (
        !preview.success ||
        !sameIdentity(preview.data, identity) ||
        preview.data.previewHash !== parsedInput.data.previewHash ||
        preview.data.previewRevision !== parsedInput.data.previewRevision ||
        preview.data.logicalMemoryId !== parsedInput.data.logicalMemoryId ||
        preview.data.teamId !== parsedInput.data.teamId ||
        preview.data.teamWorkspaceId !== parsedInput.data.workspaceId ||
        preview.data.representation !==
          parsedInput.data.selectedRepresentation ||
        !sameRepresentations(
          preview.data.allowedRepresentations,
          parsedInput.data.allowedRepresentations
        )
      ) {
        return null;
      }
      return { previewId: preview.data.previewId };
    } catch {
      return null;
    }
  },
  async loadInitialSharedSession(input, contextInput) {
    let command: Extract<
      CollaborationSharedMemoryControlCommand,
      { command: "collaboration.load_shared_source_page" }
    > | null = null;
    const context = dispatchContextSchema.safeParse(contextInput);
    const parsedInput = z
      .object({
        requestId: uuidSchema,
        teamId: uuidSchema,
        workspaceId: uuidSchema,
        sharedSessionId: uuidSchema,
        representation: representationSchema,
        limit: z
          .number()
          .int()
          .safe()
          .min(1)
          .max(COLLABORATION_SOURCE_PAGE_MAX_ITEMS)
      })
      .strict()
      .safeParse(input);
    if (!context.success || !parsedInput.success) return null;
    try {
      const candidate = collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: parsedInput.data.requestId,
        command: "collaboration.load_shared_source_page",
        input: {
          sharedSession: {
            teamId: parsedInput.data.teamId,
            workspaceId: parsedInput.data.workspaceId,
            sharedSessionId: parsedInput.data.sharedSessionId
          },
          direction: "older",
          cursor: null,
          limit: parsedInput.data.limit
        }
      });
      if (candidate.command !== "collaboration.load_shared_source_page") {
        return null;
      }
      command = candidate;
      const authority = await resolveAuthority(options, command, context.data);
      const payload = await remoteRequest(options, authority, {
        method: "GET",
        path: queryPath(
          `${scopedGrantPath({
            teamId: parsedInput.data.teamId,
            workspaceId: parsedInput.data.workspaceId,
            shareGrantId: parsedInput.data.sharedSessionId
          })}/initial-view`,
          {
            representation: parsedInput.data.representation,
            direction: "older",
            boundary: null,
            limit: parsedInput.data.limit
          }
        )
      });
      const companion =
        payload.companion &&
        typeof payload.companion === "object" &&
        !Array.isArray(payload.companion)
          ? (payload.companion as Record<string, unknown>)
          : null;
      if (!companion) throw new ControlFailure("internal_error");
      const sourceResult = await dispatchLoadSource(
        options,
        authority,
        command,
        payload
      );
      return { sourceResult, companion };
    } catch (error) {
      if (!command) return null;
      const code =
        error instanceof ControlFailure ? error.code : "internal_error";
      const sourceResult =
        error instanceof ControlFailure &&
        code === "rate_limited" &&
        error.retryAfter !== null
          ? collaborationCommandResultSchema.parse({
              ...failure(command, code),
              error: safeError(code, error.retryAfter)
            })
          : failure(command, code);
      return {
        sourceResult,
        companion: {}
      };
    }
  },
  async dispatch(commandInput, contextInput) {
    const candidateName = commandNameFrom(commandInput);
    if (!candidateName) return null;
    const parsedCommand =
      collaborationRendererCommandSchema.safeParse(commandInput);
    if (
      !parsedCommand.success ||
      !isControlCommandName(parsedCommand.data.command)
    ) {
      const requestId =
        commandInput !== null &&
        typeof commandInput === "object" &&
        !Array.isArray(commandInput) &&
        uuidSchema.safeParse(
          (commandInput as { requestId?: unknown }).requestId
        ).success
          ? ((commandInput as { requestId: string }).requestId ?? null)
          : null;
      if (!requestId) return null;
      return collaborationCommandResultSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId,
        command: candidateName,
        ok: false,
        error: safeError("invalid_input")
      });
    }
    const command =
      parsedCommand.data as CollaborationSharedMemoryControlCommand;
    const parsedContext = dispatchContextSchema.safeParse(contextInput);
    if (!parsedContext.success) return failure(command, "invalid_input");
    try {
      const authority = await resolveAuthority(
        options,
        command,
        parsedContext.data
      );
      return await dispatchResolved(options, authority, command);
    } catch (error) {
      if (error instanceof ControlFailure) {
        const result = failure(command, error.code);
        if (
          result.ok === false &&
          error.code === "rate_limited" &&
          error.retryAfter !== null
        ) {
          return collaborationCommandResultSchema.parse({
            ...result,
            error: safeError(error.code, error.retryAfter)
          });
        }
        return result;
      }
      return failure(command, "internal_error");
    }
  }
});
