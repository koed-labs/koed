import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationCommandResultSchema,
  collaborationInvitationSchema,
  collaborationMembershipSchema,
  collaborationSafeErrorMessages,
  collaborationSnapshotSchema,
  collaborationWorkspaceAccessSchema,
  collaborationWorkspaceSchema,
  fetchBoundedJsonObject,
  RemoteRequestTimeoutError,
  RemoteResponseLimitError,
  type CollaborationActionGrantReference,
  type CollaborationCommandResult,
  type CollaborationRendererCommand,
  type CollaborationSafeError,
  type CollaborationSnapshot
} from "@koed/shared";
import { z } from "zod";
import { openOpaqueCursor, sealOpaqueCursor } from "./opaque-cursor.js";

import { teamAdminRequestHash, teamAdminScopeHash } from "../team/routes.js";
import {
  safeUpstreamProxyUrl,
  type LocalEdgeUpstreamBackend
} from "./upstream-routing.js";

const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const CURSOR_PREFIX = "ctic1";

export const collaborationTeamControlCommandNames = [
  "collaboration.create_team",
  "collaboration.join_team",
  "collaboration.create_workspace",
  "collaboration.create_invitation",
  "collaboration.list_invitations",
  "collaboration.revoke_invitation",
  "collaboration.update_member_role",
  "collaboration.disable_member",
  "collaboration.leave_team",
  "collaboration.archive_workspace",
  "collaboration.restore_workspace",
  "collaboration.set_workspace_access"
] as const;

export type CollaborationTeamControlCommandName =
  (typeof collaborationTeamControlCommandNames)[number];

export type CollaborationTeamControlCommand = Extract<
  CollaborationRendererCommand,
  { command: CollaborationTeamControlCommandName }
>;

export type CollaborationTeamControlOperationFamily =
  | "team_workspace_read"
  | "admin"
  | "action_grant";

export interface CollaborationTeamControlActionBinding {
  reference: CollaborationActionGrantReference;
  backendId: string;
  deviceCredentialId: string;
  principalUserId: string;
  operationFamily: "admin";
  action: string;
  teamId: string | null;
  targetId: string | null;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body: Record<string, unknown>;
  scopeHash: string;
  requestHash: string;
}

export interface CollaborationInvitationCursorPayload {
  version: 1;
  kind: "team_invitation_page";
  backendId: string;
  principalUserId: string;
  teamId: string;
  includeRevoked: boolean;
  upstreamCursor: string;
}

export interface CollaborationTeamControlCursorCodec {
  encode(
    payload: CollaborationInvitationCursorPayload
  ): string | Promise<string>;
  decode(
    cursor: string
  ):
    | CollaborationInvitationCursorPayload
    | null
    | Promise<CollaborationInvitationCursorPayload | null>;
}

export interface CollaborationTeamControlContext {
  backend: LocalEdgeUpstreamBackend;
  principalUserId: string;
  upstreamDeviceCredentialId: string | null;
  upstreamDeviceAuthorization: string | null;
  operationFamilies: ReadonlySet<CollaborationTeamControlOperationFamily>;
  fetch: typeof fetch;
  teamCreationRequestIdempotency: boolean;
  loadSnapshot(): Promise<CollaborationSnapshot>;
  cursorCodec?: CollaborationTeamControlCursorCodec;
  resolveActionGrantSecret?(
    binding: CollaborationTeamControlActionBinding
  ): Promise<string | null>;
}

export type CollaborationTeamControlIntegrationRequirementCode =
  | "action_grant_secret_custody"
  | "invitation_cursor_codec"
  | "team_creation_request_idempotency"
  | "upstream_device_credential_identity";

export interface CollaborationTeamControlIntegrationRequirement {
  code: CollaborationTeamControlIntegrationRequirementCode;
  command: CollaborationTeamControlCommandName;
  message: string;
}

export type CollaborationTeamControlDispatchResult =
  | { status: "not_handled" }
  | { status: "handled"; result: CollaborationCommandResult }
  | {
      status: "integration_required";
      requirement: CollaborationTeamControlIntegrationRequirement;
    };

const cursorPayloadSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("team_invitation_page"),
    backendId: z.string().min(2).max(64),
    principalUserId: z.uuid(),
    teamId: z.uuid(),
    includeRevoked: z.boolean(),
    upstreamCursor: z.string().min(1).max(4096)
  })
  .strict();

const timestampSchema = z.string().datetime({ offset: true });

const remoteInvitationSchema = z
  .object({
    id: z.uuid(),
    teamId: z.uuid(),
    defaultTeamWorkspaceId: z.uuid(),
    defaultWorkspaceAccess: z.enum(["read", "write"]),
    email: z.email().max(320),
    role: z.enum(["owner", "admin", "member"]),
    lifecycle: z.enum(["pending", "accepted", "revoked", "expired"]),
    version: z.number().int().safe().positive(),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    acceptedAt: timestampSchema.nullable(),
    revokedAt: timestampSchema.nullable()
  })
  .passthrough()
  .superRefine((invitation, refinement) => {
    if (
      (invitation.lifecycle === "accepted") !==
        (invitation.acceptedAt !== null) ||
      (invitation.lifecycle === "revoked") !== (invitation.revokedAt !== null)
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Invitation lifecycle timestamps are inconsistent"
      });
    }
  });

const remoteMembershipSchema = z
  .object({
    id: z.uuid(),
    teamId: z.uuid(),
    userId: z.uuid(),
    role: z.enum(["owner", "admin", "member"]),
    status: z.enum(["invited", "enabled", "disabled"]),
    version: z.number().int().safe().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    acceptedAt: timestampSchema.nullable(),
    disabledAt: timestampSchema.nullable()
  })
  .passthrough()
  .superRefine((membership, refinement) => {
    if (
      (membership.status === "disabled") !==
      (membership.disabledAt !== null)
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Membership disablement timestamp is inconsistent"
      });
    }
  });

const remoteWorkspaceSchema = z
  .object({
    id: z.uuid(),
    teamId: z.uuid(),
    name: z.string().min(1),
    description: z.string().nullable(),
    lifecycle: z.enum(["active", "archived", "purge_pending", "purged"]),
    version: z.number().int().safe().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    archivedAt: timestampSchema.nullable()
  })
  .passthrough()
  .superRefine((workspace, refinement) => {
    if (
      (workspace.lifecycle === "archived") !==
      (workspace.archivedAt !== null)
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Workspace archive timestamp is inconsistent"
      });
    }
  });

const remoteWorkspaceAccessSchema = z
  .object({
    teamWorkspaceId: z.uuid(),
    teamId: z.uuid(),
    userId: z.uuid(),
    access: z.enum(["disabled", "read", "write"]),
    version: z.number().int().safe().positive().nullable()
  })
  .passthrough();

const remoteTeamSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1),
    lifecycle: z.enum([
      "active",
      "suspended",
      "deletion_requested",
      "purge_pending",
      "purged"
    ])
  })
  .passthrough();

const remoteTeamCreationSchema = z
  .object({
    team: remoteTeamSchema,
    defaultWorkspace: remoteWorkspaceSchema
  })
  .strict();

const remoteInvitationCreationSchema = z
  .object({
    invite: remoteInvitationSchema,
    inviteToken: z
      .string()
      .min(24)
      .max(512)
      .regex(/^kti_[A-Za-z0-9_-]+$/)
  })
  .strict();

const remoteInvitationAcceptanceSchema = z
  .object({
    invite: remoteInvitationSchema,
    membership: remoteMembershipSchema,
    user: z.object({ id: z.uuid() }).passthrough(),
    createdUser: z.boolean()
  })
  .strict();

const safeError = (
  code: CollaborationSafeError["code"],
  retryAfterMs: number | null = null
): CollaborationSafeError => ({
  code,
  userMessage: collaborationSafeErrorMessages[code],
  retryable:
    code === "offline" ||
    code === "temporarily_unavailable" ||
    code === "rate_limited" ||
    code === "conflict",
  retryAfterMs
});

const failure = (
  command: CollaborationTeamControlCommand,
  error: CollaborationSafeError
): CollaborationTeamControlDispatchResult => ({
  status: "handled",
  result: collaborationCommandResultSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: command.requestId,
    command: command.command,
    ok: false,
    error
  })
});

const success = (
  command: CollaborationTeamControlCommand,
  data: Record<string, unknown>
): CollaborationTeamControlDispatchResult => {
  const parsed = collaborationCommandResultSchema.safeParse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: command.requestId,
    command: command.command,
    ok: true,
    data
  });
  return parsed.success
    ? { status: "handled", result: parsed.data }
    : failure(command, safeError("internal_error"));
};

const integrationRequired = (
  command: CollaborationTeamControlCommand,
  code: CollaborationTeamControlIntegrationRequirementCode,
  message: string
): CollaborationTeamControlDispatchResult => ({
  status: "integration_required",
  requirement: { code, command: command.command, message }
});

export const isCollaborationTeamControlCommand = (
  command: CollaborationRendererCommand
): command is CollaborationTeamControlCommand =>
  collaborationTeamControlCommandNames.some((name) => name === command.command);

export const createCollaborationTeamControlCursorCodec = (
  key: Uint8Array
): CollaborationTeamControlCursorCodec => {
  const secret = Buffer.from(key);
  if (secret.length < 32) {
    throw new Error("Team-control cursor keys must contain at least 32 bytes");
  }
  return {
    encode(payload) {
      const parsed = cursorPayloadSchema.parse(payload);
      return sealOpaqueCursor({
        secret,
        prefix: CURSOR_PREFIX,
        domain: "team-control",
        payload: parsed
      });
    },
    decode(cursor) {
      const parsed = cursorPayloadSchema.safeParse(
        openOpaqueCursor({
          secret,
          prefix: CURSOR_PREFIX,
          domain: "team-control",
          cursor
        })
      );
      return parsed.success ? parsed.data : null;
    }
  };
};

const retryAfterFrom = (response: Response): number | null => {
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(300_000, Math.round(seconds * 1_000))
    : null;
};

const errorForStatus = (response: Response): CollaborationSafeError => {
  if (response.status === 400 || response.status === 422) {
    return safeError("invalid_input");
  }
  if (response.status === 401 || response.status === 403) {
    return safeError("permission_denied");
  }
  if (response.status === 404) return safeError("not_available");
  if (response.status === 409) return safeError("conflict");
  if (response.status === 410) return safeError("access_revoked");
  if (response.status === 429) {
    return safeError("rate_limited", retryAfterFrom(response));
  }
  if ([424, 502, 503, 504].includes(response.status)) {
    return safeError("temporarily_unavailable", retryAfterFrom(response));
  }
  return safeError("internal_error");
};

const safeHeaderValue = (value: string, maxBytes: number): boolean =>
  Buffer.byteLength(value, "utf8") <= maxBytes && /^[\x20-\x7e]+$/.test(value);

interface RemoteRequest {
  operationFamily: CollaborationTeamControlOperationFamily;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  authentication: { kind: "device"; actionGrant?: string };
}

class RemoteCommandError extends Error {
  constructor(readonly safe: CollaborationSafeError) {
    super("Remote Team-control request failed");
  }
}

const remoteRequest = async (
  context: CollaborationTeamControlContext,
  operation: RemoteRequest
): Promise<Record<string, unknown>> => {
  const requiredCredentialFamily =
    operation.operationFamily === "admin" &&
    operation.authentication.actionGrant
      ? "action_grant"
      : operation.operationFamily;
  if (!context.operationFamilies.has(requiredCredentialFamily)) {
    throw new RemoteCommandError(safeError("permission_denied"));
  }
  const headers: Record<string, string> = { accept: "application/json" };
  const authorization = context.upstreamDeviceAuthorization;
  if (!authorization || !safeHeaderValue(authorization, 1_024)) {
    throw new RemoteCommandError(safeError("permission_denied"));
  }
  headers.authorization = authorization;
  if (operation.authentication.actionGrant) {
    headers["x-koed-action-grant"] = operation.authentication.actionGrant;
  }
  if (operation.method !== "GET") headers["content-type"] = "application/json";
  if (operation.idempotencyKey) {
    headers["idempotency-key"] = operation.idempotencyKey;
  }

  let remote: Awaited<ReturnType<typeof fetchBoundedJsonObject>>;
  try {
    remote = await fetchBoundedJsonObject(
      context.fetch,
      safeUpstreamProxyUrl(context.backend, operation.path),
      {
        method: operation.method,
        redirect: "error",
        headers,
        ...(operation.method === "GET"
          ? {}
          : { body: JSON.stringify(operation.body ?? {}) })
      },
      { timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: RESPONSE_LIMIT_BYTES }
    );
  } catch (error) {
    throw new RemoteCommandError(
      safeError(
        error instanceof RemoteRequestTimeoutError
          ? "temporarily_unavailable"
          : error instanceof RemoteResponseLimitError ||
              error instanceof SyntaxError
            ? "internal_error"
            : "offline"
      )
    );
  }
  const { response, payload } = remote;
  if (!response.ok) {
    throw new RemoteCommandError(errorForStatus(response));
  }
  return payload;
};

const queryPath = (
  path: string,
  query: Record<string, string | number | boolean>
): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, String(value));
  }
  return `${path}?${params.toString()}`;
};

const mapInvitation = (value: z.infer<typeof remoteInvitationSchema>) =>
  collaborationInvitationSchema.parse({
    id: value.id,
    teamId: value.teamId,
    defaultWorkspaceId: value.defaultTeamWorkspaceId,
    defaultWorkspaceAccess: value.defaultWorkspaceAccess,
    email: value.email,
    role: value.role,
    lifecycle: value.lifecycle,
    version: value.version,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    acceptedAt: value.acceptedAt,
    revokedAt: value.revokedAt
  });

const mapMembership = (value: z.infer<typeof remoteMembershipSchema>) =>
  collaborationMembershipSchema.parse({
    id: value.id,
    teamId: value.teamId,
    userId: value.userId,
    displayName: null,
    email: null,
    role: value.role,
    status: value.status,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    acceptedAt: value.acceptedAt,
    disabledAt: value.disabledAt
  });

const mapWorkspace = (value: z.infer<typeof remoteWorkspaceSchema>) =>
  collaborationWorkspaceSchema.parse({
    id: value.id,
    teamId: value.teamId,
    name: value.name,
    description: value.description,
    lifecycle: value.lifecycle,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archivedAt: value.archivedAt
  });

const generalChannelCount = (
  snapshot: CollaborationSnapshot,
  teamId: string,
  workspaceId: string
): number => {
  const workspace = snapshot.navigation.teams
    .find((team) => team.id === teamId)
    ?.workspaces.find((item) => item.id === workspaceId);
  return (
    workspace?.channels.filter(
      (channel) => channel.name.replace(/^#/, "").toLowerCase() === "general"
    ).length ?? 0
  );
};

const loadVerifiedSnapshot = async (
  context: CollaborationTeamControlContext,
  input: {
    teamId: string;
    workspaceId?: string;
  }
): Promise<CollaborationSnapshot | null> => {
  let loaded: CollaborationSnapshot;
  try {
    loaded = await context.loadSnapshot();
  } catch {
    return null;
  }
  const parsed = collaborationSnapshotSchema.safeParse(loaded);
  if (!parsed.success) return null;
  const team = parsed.data.navigation.teams.find(
    (item) => item.id === input.teamId
  );
  if (!team) return null;
  if (input.workspaceId) {
    const workspace = team.workspaces.find(
      (item) => item.id === input.workspaceId
    );
    if (!workspace) return null;
    if (
      generalChannelCount(parsed.data, input.teamId, input.workspaceId) !== 1
    ) {
      return null;
    }
  }
  return parsed.data;
};

const selectWorkspaceSharedMemory = (
  snapshot: CollaborationSnapshot,
  teamId: string,
  workspaceId: string
): CollaborationSnapshot | null => {
  const workspace = snapshot.navigation.teams
    .find((team) => team.id === teamId)
    ?.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return null;
  const selected = collaborationSnapshotSchema.safeParse({
    ...snapshot,
    selection: {
      kind: "workspace_shared_memory",
      teamId,
      workspaceId
    },
    view: {
      kind: "shared_memory_index",
      teamId,
      workspaceId,
      sessions: workspace.sharedMemory
    }
  });
  return selected.success ? selected.data : null;
};

const invitationUrlPath = (context: CollaborationTeamControlContext): string =>
  `${new URL(context.backend.baseUrl).pathname.replace(/\/+$/, "")}/invitations/accept`.replace(
    /\/{2,}/g,
    "/"
  );

const invitationUrl = (
  context: CollaborationTeamControlContext,
  token: string
): string => {
  const backend = new URL(context.backend.baseUrl);
  const result = new URL(invitationUrlPath(context), backend.origin);
  result.searchParams.set("token", token);
  return result.toString();
};

const tokenFromInvitationUrl = (
  context: CollaborationTeamControlContext,
  value: string
): string | null => {
  let parsed: URL;
  let backend: URL;
  try {
    parsed = new URL(value);
    backend = new URL(context.backend.baseUrl);
  } catch {
    return null;
  }
  const keys = [...parsed.searchParams.keys()];
  const token = parsed.searchParams.get("token");
  if (
    parsed.origin !== backend.origin ||
    parsed.pathname !== invitationUrlPath(context) ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    keys.length !== 1 ||
    keys[0] !== "token" ||
    !token ||
    !/^kti_[A-Za-z0-9_-]{20,508}$/.test(token)
  ) {
    return null;
  }
  return token;
};

const actionGrantSecret = async (
  command: CollaborationTeamControlCommand,
  context: CollaborationTeamControlContext,
  input: {
    reference: CollaborationActionGrantReference;
    action: string;
    teamId: string | null;
    targetId: string | null;
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    body: Record<string, unknown>;
  }
): Promise<string | null | CollaborationTeamControlDispatchResult> => {
  if (!context.resolveActionGrantSecret) {
    return integrationRequired(
      command,
      "action_grant_secret_custody",
      "Local koed-server must provide a secure Action Grant ID-to-secret resolver bound to the enrolled backend, device, principal, Team, action, target, and exact request."
    );
  }
  const deviceCredentialId = context.upstreamDeviceCredentialId;
  if (!deviceCredentialId || !z.uuid().safeParse(deviceCredentialId).success) {
    return integrationRequired(
      command,
      "upstream_device_credential_identity",
      "Local koed-server must retain the remote device credential UUID so an Action Grant reference can be checked against the exact enrolled device."
    );
  }
  const scopeHash = teamAdminScopeHash(input);
  const requestHash = teamAdminRequestHash({
    method: input.method,
    path: input.path,
    body: input.body
  });
  const secret = await context.resolveActionGrantSecret({
    reference: input.reference,
    backendId: context.backend.id,
    deviceCredentialId,
    principalUserId: context.principalUserId,
    operationFamily: "admin",
    action: input.action,
    teamId: input.teamId,
    targetId: input.targetId,
    method: input.method,
    path: input.path,
    body: input.body,
    scopeHash,
    requestHash
  });
  return secret && /^hrg_[A-Za-z0-9_-]{20,124}$/.test(secret) ? secret : null;
};

const isDispatchResult = (
  value: unknown
): value is CollaborationTeamControlDispatchResult =>
  Boolean(
    value &&
    typeof value === "object" &&
    "status" in value &&
    (value as { status?: unknown }).status === "integration_required"
  );

const dispatch = async (
  command: CollaborationTeamControlCommand,
  context: CollaborationTeamControlContext
): Promise<CollaborationTeamControlDispatchResult> => {
  switch (command.command) {
    case "collaboration.create_team": {
      if (!context.teamCreationRequestIdempotency) {
        return integrationRequired(
          command,
          "team_creation_request_idempotency",
          "The upstream backend must advertise and enforce request-idempotent atomic Team creation before this command can be enabled."
        );
      }
      const body = { name: command.input.name };
      const grant = await actionGrantSecret(command, context, {
        reference: command.input.actionGrant,
        action: "team.create",
        teamId: null,
        targetId: null,
        method: "POST",
        path: "/v1/teams",
        body
      });
      if (isDispatchResult(grant)) return grant;
      if (!grant) return failure(command, safeError("permission_denied"));
      const payload = remoteTeamCreationSchema.parse(
        await remoteRequest(context, {
          operationFamily: "admin",
          method: "POST",
          path: "/v1/teams",
          body,
          idempotencyKey: command.requestId,
          authentication: { kind: "device", actionGrant: grant }
        })
      );
      if (
        payload.team.lifecycle !== "active" ||
        payload.team.name !== command.input.name ||
        payload.defaultWorkspace.teamId !== payload.team.id ||
        payload.defaultWorkspace.lifecycle !== "active"
      ) {
        return failure(command, safeError("internal_error"));
      }
      const snapshot = await loadVerifiedSnapshot(context, {
        teamId: payload.team.id,
        workspaceId: payload.defaultWorkspace.id
      });
      const selected = snapshot
        ? selectWorkspaceSharedMemory(
            snapshot,
            payload.team.id,
            payload.defaultWorkspace.id
          )
        : null;
      return selected
        ? success(command, { snapshot: selected })
        : failure(command, safeError("temporarily_unavailable"));
    }

    case "collaboration.join_team": {
      const token = tokenFromInvitationUrl(context, command.input.invitation);
      if (!token) return failure(command, safeError("invalid_input"));
      const body = { inviteToken: token };
      const grant = await actionGrantSecret(command, context, {
        reference: command.input.actionGrant,
        action: "team.invite.accept",
        teamId: null,
        targetId: null,
        method: "POST",
        path: "/v1/team-invites/accept",
        body
      });
      if (isDispatchResult(grant)) return grant;
      if (!grant) return failure(command, safeError("permission_denied"));
      const payload = remoteInvitationAcceptanceSchema.parse(
        await remoteRequest(context, {
          operationFamily: "admin",
          method: "POST",
          path: "/v1/team-invites/accept",
          body,
          idempotencyKey: command.requestId,
          authentication: { kind: "device", actionGrant: grant }
        })
      );
      if (
        payload.invite.lifecycle !== "accepted" ||
        payload.membership.teamId !== payload.invite.teamId ||
        payload.membership.userId !== context.principalUserId ||
        payload.membership.status !== "enabled" ||
        payload.user.id !== context.principalUserId
      ) {
        return failure(command, safeError("internal_error"));
      }
      const snapshot = await loadVerifiedSnapshot(context, {
        teamId: payload.invite.teamId,
        workspaceId: payload.invite.defaultTeamWorkspaceId
      });
      const selected = snapshot
        ? selectWorkspaceSharedMemory(
            snapshot,
            payload.invite.teamId,
            payload.invite.defaultTeamWorkspaceId
          )
        : null;
      return selected
        ? success(command, { snapshot: selected })
        : failure(command, safeError("temporarily_unavailable"));
    }

    case "collaboration.create_workspace": {
      const path = `/v1/teams/${encodeURIComponent(command.input.teamId)}/workspaces`;
      const body = {
        name: command.input.name,
        description: command.input.description
      };
      const grant = await actionGrantSecret(command, context, {
        reference: command.input.actionGrant,
        action: "team.workspace.create",
        teamId: command.input.teamId,
        targetId: null,
        method: "POST",
        path,
        body
      });
      if (isDispatchResult(grant)) return grant;
      if (!grant) return failure(command, safeError("permission_denied"));
      const payload = z
        .object({ teamWorkspace: remoteWorkspaceSchema })
        .strict()
        .parse(
          await remoteRequest(context, {
            operationFamily: "admin",
            method: "POST",
            path,
            body,
            idempotencyKey: command.requestId,
            authentication: { kind: "device", actionGrant: grant }
          })
        );
      if (
        payload.teamWorkspace.teamId !== command.input.teamId ||
        payload.teamWorkspace.name !== command.input.name ||
        payload.teamWorkspace.description !== command.input.description ||
        payload.teamWorkspace.lifecycle !== "active"
      ) {
        return failure(command, safeError("internal_error"));
      }
      const snapshot = await loadVerifiedSnapshot(context, {
        teamId: command.input.teamId,
        workspaceId: payload.teamWorkspace.id
      });
      return snapshot
        ? success(command, { snapshot })
        : failure(command, safeError("temporarily_unavailable"));
    }

    case "collaboration.create_invitation": {
      const path = `/v1/teams/${encodeURIComponent(command.input.teamId)}/invites`;
      const body = {
        email: command.input.email,
        role: command.input.role,
        defaultTeamWorkspaceId: command.input.defaultWorkspaceId,
        defaultWorkspaceAccess: command.input.defaultWorkspaceAccess,
        ttlHours: command.input.ttlHours
      };
      const grant = await actionGrantSecret(command, context, {
        reference: command.input.actionGrant,
        action: "team.invite.create",
        teamId: command.input.teamId,
        targetId: command.input.defaultWorkspaceId,
        method: "POST",
        path,
        body
      });
      if (isDispatchResult(grant)) return grant;
      if (!grant) return failure(command, safeError("permission_denied"));
      const payload = remoteInvitationCreationSchema.parse(
        await remoteRequest(context, {
          operationFamily: "admin",
          method: "POST",
          path,
          body,
          idempotencyKey: command.requestId,
          authentication: { kind: "device", actionGrant: grant }
        })
      );
      const invitation = mapInvitation(payload.invite);
      if (
        invitation.teamId !== command.input.teamId ||
        invitation.defaultWorkspaceId !== command.input.defaultWorkspaceId ||
        invitation.email !== command.input.email ||
        invitation.role !== command.input.role ||
        invitation.defaultWorkspaceAccess !==
          command.input.defaultWorkspaceAccess ||
        invitation.lifecycle !== "pending"
      ) {
        return failure(command, safeError("internal_error"));
      }
      return success(command, {
        invitation,
        invitationUrl: invitationUrl(context, payload.inviteToken)
      });
    }

    case "collaboration.list_invitations": {
      const codec = context.cursorCodec;
      if (!codec) {
        return integrationRequired(
          command,
          "invitation_cursor_codec",
          "Local koed-server must provide an authenticated opaque cursor codec whose key remains outside renderer custody."
        );
      }
      const decoded = command.input.cursor
        ? await codec.decode(command.input.cursor)
        : null;
      if (command.input.cursor && !decoded) {
        return failure(command, safeError("permission_denied"));
      }
      if (
        decoded &&
        (decoded.backendId !== context.backend.id ||
          decoded.principalUserId !== context.principalUserId ||
          decoded.teamId !== command.input.teamId ||
          decoded.includeRevoked !== command.input.includeRevoked)
      ) {
        return failure(command, safeError("permission_denied"));
      }
      const path = queryPath(
        `/v1/teams/${encodeURIComponent(command.input.teamId)}/invites`,
        {
          includeRevoked: command.input.includeRevoked,
          limit: command.input.limit,
          ...(decoded ? { cursor: decoded.upstreamCursor } : {})
        }
      );
      const payload = z
        .object({
          invites: z.array(remoteInvitationSchema).max(command.input.limit),
          nextCursor: z.string().min(1).max(4096).nullable()
        })
        .strict()
        .parse(
          await remoteRequest(context, {
            operationFamily: "team_workspace_read",
            method: "GET",
            path,
            authentication: { kind: "device" }
          })
        );
      const invitations = payload.invites.map(mapInvitation);
      if (
        invitations.some(
          (invitation) =>
            invitation.teamId !== command.input.teamId ||
            (!command.input.includeRevoked &&
              invitation.lifecycle === "revoked")
        )
      ) {
        return failure(command, safeError("internal_error"));
      }
      const nextCursor = payload.nextCursor
        ? await codec.encode({
            version: 1,
            kind: "team_invitation_page",
            backendId: context.backend.id,
            principalUserId: context.principalUserId,
            teamId: command.input.teamId,
            includeRevoked: command.input.includeRevoked,
            upstreamCursor: payload.nextCursor
          })
        : null;
      return success(command, {
        page: {
          teamId: command.input.teamId,
          items: invitations,
          nextCursor
        }
      });
    }

    case "collaboration.revoke_invitation": {
      const path = `/v1/teams/${encodeURIComponent(command.input.teamId)}/invites/${encodeURIComponent(command.input.invitationId)}`;
      const body = { expectedVersion: command.input.expectedVersion };
      const grant = await actionGrantSecret(command, context, {
        reference: command.input.actionGrant,
        action: "team.invite.revoke",
        teamId: command.input.teamId,
        targetId: command.input.invitationId,
        method: "DELETE",
        path,
        body
      });
      if (isDispatchResult(grant)) return grant;
      if (!grant) return failure(command, safeError("permission_denied"));
      const payload = z
        .object({ invite: remoteInvitationSchema })
        .strict()
        .parse(
          await remoteRequest(context, {
            operationFamily: "admin",
            method: "DELETE",
            path,
            body,
            idempotencyKey: command.requestId,
            authentication: { kind: "device", actionGrant: grant }
          })
        );
      const invitation = mapInvitation(payload.invite);
      return invitation.id === command.input.invitationId &&
        invitation.teamId === command.input.teamId &&
        invitation.lifecycle === "revoked" &&
        invitation.version > command.input.expectedVersion
        ? success(command, { invitation })
        : failure(command, safeError("internal_error"));
    }

    case "collaboration.update_member_role":
    case "collaboration.disable_member": {
      const roleUpdate = command.command === "collaboration.update_member_role";
      const path = `/v1/teams/${encodeURIComponent(command.input.teamId)}/members/${encodeURIComponent(command.input.userId)}/${roleUpdate ? "role" : "disable"}`;
      const body = roleUpdate
        ? {
            role: command.input.role,
            expectedVersion: command.input.expectedVersion
          }
        : { expectedVersion: command.input.expectedVersion };
      const grant = await actionGrantSecret(command, context, {
        reference: command.input.actionGrant,
        action: roleUpdate ? "team.member.role_update" : "team.member.disable",
        teamId: command.input.teamId,
        targetId: command.input.userId,
        method: roleUpdate ? "PATCH" : "POST",
        path,
        body
      });
      if (isDispatchResult(grant)) return grant;
      if (!grant) return failure(command, safeError("permission_denied"));
      const payload = z
        .object({ membership: remoteMembershipSchema })
        .strict()
        .parse(
          await remoteRequest(context, {
            operationFamily: "admin",
            method: roleUpdate ? "PATCH" : "POST",
            path,
            body,
            idempotencyKey: command.requestId,
            authentication: { kind: "device", actionGrant: grant }
          })
        );
      const membership = mapMembership(payload.membership);
      const matches =
        membership.teamId === command.input.teamId &&
        membership.userId === command.input.userId &&
        membership.version > command.input.expectedVersion &&
        (roleUpdate
          ? membership.role === command.input.role
          : membership.status === "disabled" && membership.disabledAt !== null);
      return matches
        ? success(command, { membership })
        : failure(command, safeError("internal_error"));
    }

    case "collaboration.leave_team": {
      const path = `/v1/teams/${encodeURIComponent(command.input.teamId)}/leave`;
      const body = { expectedVersion: command.input.expectedVersion };
      const grant = await actionGrantSecret(command, context, {
        reference: command.input.actionGrant,
        action: "team.leave",
        teamId: command.input.teamId,
        targetId: command.input.teamId,
        method: "POST",
        path,
        body
      });
      if (isDispatchResult(grant)) return grant;
      if (!grant) return failure(command, safeError("permission_denied"));
      const payload = z
        .object({ membership: remoteMembershipSchema })
        .strict()
        .parse(
          await remoteRequest(context, {
            operationFamily: "admin",
            method: "POST",
            path,
            body,
            idempotencyKey: command.requestId,
            authentication: { kind: "device", actionGrant: grant }
          })
        );
      const membership = mapMembership(payload.membership);
      return membership.teamId === command.input.teamId &&
        membership.userId === context.principalUserId &&
        membership.status === "disabled" &&
        membership.disabledAt !== null &&
        membership.version > command.input.expectedVersion
        ? success(command, { membership })
        : failure(command, safeError("internal_error"));
    }

    case "collaboration.archive_workspace":
    case "collaboration.restore_workspace": {
      const archive = command.command === "collaboration.archive_workspace";
      const action = archive
        ? "team.workspace.archive"
        : "team.workspace.restore";
      const path = `/v1/team-workspaces/${encodeURIComponent(command.input.workspaceId)}/${archive ? "archive" : "restore"}`;
      const body = { expectedVersion: command.input.expectedVersion };
      const grant = await actionGrantSecret(command, context, {
        reference: command.input.actionGrant,
        action,
        teamId: command.input.teamId,
        targetId: command.input.workspaceId,
        method: "POST",
        path,
        body
      });
      if (isDispatchResult(grant)) return grant;
      if (!grant) return failure(command, safeError("permission_denied"));
      const payload = z
        .object({ teamWorkspace: remoteWorkspaceSchema })
        .strict()
        .parse(
          await remoteRequest(context, {
            operationFamily: "admin",
            method: "POST",
            path,
            body,
            idempotencyKey: command.requestId,
            authentication: { kind: "device", actionGrant: grant }
          })
        );
      const workspace = mapWorkspace(payload.teamWorkspace);
      const expectedLifecycle = archive ? "archived" : "active";
      return workspace.id === command.input.workspaceId &&
        workspace.teamId === command.input.teamId &&
        workspace.lifecycle === expectedLifecycle &&
        workspace.version > command.input.expectedVersion
        ? success(command, { workspace })
        : failure(command, safeError("internal_error"));
    }

    case "collaboration.set_workspace_access": {
      const path = `/v1/team-workspaces/${encodeURIComponent(command.input.workspaceId)}/access`;
      const body = {
        userId: command.input.userId,
        access: command.input.access,
        expectedVersion: command.input.expectedVersion
      };
      const grant = await actionGrantSecret(command, context, {
        reference: command.input.actionGrant,
        action: "team.workspace.access_update",
        teamId: command.input.teamId,
        targetId: command.input.workspaceId,
        method: "PUT",
        path,
        body
      });
      if (isDispatchResult(grant)) return grant;
      if (!grant) return failure(command, safeError("permission_denied"));
      const payload = z
        .object({ access: remoteWorkspaceAccessSchema })
        .strict()
        .parse(
          await remoteRequest(context, {
            operationFamily: "admin",
            method: "PUT",
            path,
            body,
            idempotencyKey: command.requestId,
            authentication: { kind: "device", actionGrant: grant }
          })
        );
      const access = collaborationWorkspaceAccessSchema.parse({
        workspaceId: payload.access.teamWorkspaceId,
        userId: payload.access.userId,
        access: payload.access.access,
        version: payload.access.version
      });
      const matches =
        payload.access.teamId === command.input.teamId &&
        access.workspaceId === command.input.workspaceId &&
        access.userId === command.input.userId &&
        access.access === command.input.access &&
        access.version !== null &&
        (command.input.expectedVersion === null ||
          access.version > command.input.expectedVersion);
      return matches
        ? success(command, { access })
        : failure(command, safeError("internal_error"));
    }
  }
};

export const dispatchCollaborationTeamControlCommand = async (
  command: CollaborationRendererCommand,
  context: CollaborationTeamControlContext
): Promise<CollaborationTeamControlDispatchResult> => {
  if (!isCollaborationTeamControlCommand(command)) {
    return { status: "not_handled" };
  }
  try {
    return await dispatch(command, context);
  } catch (error) {
    return failure(
      command,
      error instanceof RemoteCommandError
        ? error.safe
        : safeError("internal_error")
    );
  }
};
