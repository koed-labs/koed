import type { DeviceCredentialRecord } from "@koed/db";
import {
  assertSecureHttpTransport,
  readLocalEdgeUpstreamRegistry,
  upstreamAdvertisesCapability,
  upstreamBackendById,
  type LocalEdgeUpstreamBackend,
  type LocalEdgeUpstreamRegistry,
  type LocalEdgeUpstreamRoutePolicyKey
} from "@koed/shared";
import type { CapturePolicy } from "../server/context.js";

export {
  readLocalEdgeUpstreamRegistry,
  upstreamAdvertisesCapability,
  upstreamBackendById
};
export type { LocalEdgeUpstreamBackend, LocalEdgeUpstreamRegistry };

export type LocalEdgeOperationFamily =
  | "personal_memory_read"
  | "personal_collaboration_read"
  | "personal_collaboration_write"
  | "team_workspace_read"
  | "team_chat_read"
  | "team_chat_write"
  | "share_grant_management"
  | "action_grant"
  | "capture_writes"
  | "sync"
  | "managed_execution"
  | "admin";

export type LocalEdgeRouteMode =
  | "local_only"
  | "live_upstream_proxy"
  | "queued_sync_handoff";

export type LocalEdgeRouteDecisionAction =
  | "local_only"
  | "live_upstream_proxy"
  | "queued_sync_handoff"
  | "deny_fail_closed";

export interface LocalEdgeRouteDecision {
  action: LocalEdgeRouteDecisionAction;
  operationFamily: LocalEdgeOperationFamily;
  upstreamBackendId: string | null;
  reason: string;
  retryAfterCapabilityRefresh: boolean;
  routePolicy: "enabled" | "disabled" | "not_applicable";
  capabilityState: "validated" | "stale" | "failed" | "not_checked" | "missing";
  credentialState:
    | "configured"
    | "missing"
    | "wrong_upstream"
    | "operation_not_allowed"
    | "not_required";
  relayCredentialState: "configured" | "missing" | "not_required";
}

type RoutePolicyKey = LocalEdgeUpstreamRoutePolicyKey;

const operationRoutePolicyKey: Record<
  LocalEdgeOperationFamily,
  RoutePolicyKey
> = {
  personal_memory_read: "personalMemoryRead",
  personal_collaboration_read: "personalCollaboration",
  personal_collaboration_write: "personalCollaboration",
  team_workspace_read: "teamWorkspaceRead",
  team_chat_read: "teamWorkspaceRead",
  team_chat_write: "teamWorkspaceRead",
  share_grant_management: "shareGrantManagement",
  action_grant: "admin",
  capture_writes: "captureWrites",
  sync: "sync",
  managed_execution: "managedExecution",
  admin: "admin"
};

const defaultRouteMode: Record<LocalEdgeOperationFamily, LocalEdgeRouteMode> = {
  personal_memory_read: "local_only",
  personal_collaboration_read: "live_upstream_proxy",
  personal_collaboration_write: "live_upstream_proxy",
  team_workspace_read: "live_upstream_proxy",
  team_chat_read: "live_upstream_proxy",
  team_chat_write: "live_upstream_proxy",
  share_grant_management: "live_upstream_proxy",
  action_grant: "live_upstream_proxy",
  capture_writes: "queued_sync_handoff",
  sync: "queued_sync_handoff",
  managed_execution: "live_upstream_proxy",
  admin: "live_upstream_proxy"
};

export const activeUpstreamBackend = (
  registry: LocalEdgeUpstreamRegistry
): LocalEdgeUpstreamBackend | null =>
  registry.activeBackendId
    ? upstreamBackendById(registry, registry.activeBackendId)
    : null;

export const upstreamSupportsCollaborationRealtime = (
  backend: LocalEdgeUpstreamBackend
): boolean => {
  const availability =
    backend.capabilities?.payload?.capabilities?.["memory.collaboration"]
      ?.availability;
  return (
    backend.capabilities?.schemaVersion === 6 &&
    backend.capabilities.payload?.capabilitySchemaVersion === 6 &&
    (availability === "available" || availability === "partial") &&
    backend.capabilities.payload?.protocols?.collaborationRealtime?.version ===
      1
  );
};

export const resolveLocalEdgeRouteDecision = (input: {
  operationFamily: LocalEdgeOperationFamily;
  requestedMode?: LocalEdgeRouteMode;
  upstreamBackend?: LocalEdgeUpstreamBackend | null;
  upstreamBackendId?: string | null;
  deviceCredential?: Pick<
    DeviceCredentialRecord,
    "upstreamBackendId" | "operationFamilies"
  > | null;
  upstreamCredentialAvailable?: boolean;
  identityRemoteOperationsAllowed?: boolean;
  capturePolicy?: CapturePolicy | null;
  now?: Date;
}): LocalEdgeRouteDecision => {
  const mode = input.requestedMode ?? defaultRouteMode[input.operationFamily];
  const upstreamBackendId = input.upstreamBackendId ?? null;
  const captureDenied =
    input.operationFamily === "capture_writes"
      ? capturePolicyDenial(input.capturePolicy)
      : null;

  if (captureDenied) {
    return decision({
      action: "deny_fail_closed",
      operationFamily: input.operationFamily,
      upstreamBackendId,
      reason: captureDenied,
      routePolicy: "not_applicable",
      capabilityState: "missing",
      credentialState: "not_required",
      relayCredentialState: "not_required"
    });
  }

  if (!upstreamBackendId) {
    if (
      input.operationFamily === "personal_memory_read" ||
      input.operationFamily === "capture_writes"
    ) {
      return decision({
        action: "local_only",
        operationFamily: input.operationFamily,
        upstreamBackendId: null,
        reason: "local_personal_default",
        routePolicy: "not_applicable",
        capabilityState: "missing",
        credentialState: "not_required",
        relayCredentialState: "not_required"
      });
    }
    return decision({
      action: "deny_fail_closed",
      operationFamily: input.operationFamily,
      upstreamBackendId: null,
      reason: "upstream_required",
      routePolicy: "not_applicable",
      capabilityState: "missing",
      credentialState: "missing",
      relayCredentialState: "missing"
    });
  }

  const upstreamBackend = input.upstreamBackend;
  if (!upstreamBackend) {
    return decision({
      action: "deny_fail_closed",
      operationFamily: input.operationFamily,
      upstreamBackendId,
      reason: "upstream_not_registered",
      routePolicy: "not_applicable",
      capabilityState: "missing",
      credentialState: "missing",
      relayCredentialState: "missing"
    });
  }

  if (input.identityRemoteOperationsAllowed === false) {
    return decision({
      action: "deny_fail_closed",
      operationFamily: input.operationFamily,
      upstreamBackendId,
      reason: "device_identity_unhealthy",
      routePolicy: "not_applicable",
      capabilityState: "missing",
      credentialState: "missing",
      relayCredentialState: "missing"
    });
  }

  const routePolicyKey = operationRoutePolicyKey[input.operationFamily];
  const routePolicy = upstreamBackend.routePolicy[routePolicyKey] ?? "disabled";
  if (routePolicy !== "enabled") {
    return decision({
      action: "deny_fail_closed",
      operationFamily: input.operationFamily,
      upstreamBackendId,
      reason: "route_policy_disabled",
      routePolicy,
      capabilityState: capabilityState(upstreamBackend, input.now),
      credentialState: credentialState(input),
      relayCredentialState: relayCredentialState(input, mode)
    });
  }

  const capabilities = capabilityState(upstreamBackend, input.now);
  if (capabilities !== "validated") {
    return decision({
      action: "deny_fail_closed",
      operationFamily: input.operationFamily,
      upstreamBackendId,
      reason: "capabilities_not_validated",
      routePolicy,
      capabilityState: capabilities,
      credentialState: credentialState(input),
      relayCredentialState: relayCredentialState(input, mode),
      retryAfterCapabilityRefresh: true
    });
  }

  const credentials = credentialState(input);
  if (credentials !== "configured") {
    return decision({
      action: "deny_fail_closed",
      operationFamily: input.operationFamily,
      upstreamBackendId,
      reason: credentials,
      routePolicy,
      capabilityState: capabilities,
      credentialState: credentials,
      relayCredentialState: relayCredentialState(input, mode)
    });
  }

  const relayCredentials = relayCredentialState(input, mode);
  if (relayCredentials === "missing") {
    return decision({
      action: "deny_fail_closed",
      operationFamily: input.operationFamily,
      upstreamBackendId,
      reason: "upstream_credential_missing",
      routePolicy,
      capabilityState: capabilities,
      credentialState: credentials,
      relayCredentialState: relayCredentials
    });
  }

  return decision({
    action:
      mode === "queued_sync_handoff"
        ? "queued_sync_handoff"
        : mode === "live_upstream_proxy"
          ? "live_upstream_proxy"
          : "local_only",
    operationFamily: input.operationFamily,
    upstreamBackendId,
    reason: mode,
    routePolicy,
    capabilityState: capabilities,
    credentialState: credentials,
    relayCredentialState: relayCredentials
  });
};

export const safeUpstreamProxyUrl = (
  upstreamBackend: LocalEdgeUpstreamBackend,
  path: string
): URL => {
  if (!path.startsWith("/v1/") || path.startsWith("/v1/local-edge/")) {
    throw Object.assign(new Error("Unsupported upstream proxy path"), {
      statusCode: 400
    });
  }
  const parsedBaseUrl = new URL(upstreamBackend.baseUrl);
  assertSecureHttpTransport(parsedBaseUrl, "Upstream URL");
  const basePath = parsedBaseUrl.pathname.replace(/\/+$/, "");
  const parsed = new URL(`${basePath}${path}`, parsedBaseUrl.origin);
  if (parsed.origin !== parsedBaseUrl.origin) {
    throw Object.assign(new Error("Unsupported upstream proxy path"), {
      statusCode: 400
    });
  }
  const v1Prefix = `${basePath}/v1/`.replace(/\/{2,}/g, "/");
  const localEdgePrefix = `${basePath}/v1/local-edge/`.replace(/\/{2,}/g, "/");
  if (
    !parsed.pathname.startsWith(v1Prefix) ||
    parsed.pathname.startsWith(localEdgePrefix)
  ) {
    throw Object.assign(new Error("Unsupported upstream proxy path"), {
      statusCode: 400
    });
  }
  return parsed;
};

export const assertUpstreamOperationPathAllowed = (
  operationFamily: LocalEdgeOperationFamily,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string
): void => {
  const parsed = new URL(path, "http://koed.local");
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  const deny = () => {
    throw Object.assign(
      new Error("Upstream path is not allowed for operation family"),
      { statusCode: 400 }
    );
  };

  if (operationFamily === "personal_memory_read") {
    if (method !== "GET" && method !== "POST") {
      deny();
    }
    if (
      pathname === "/v1/memory/search" ||
      pathname === "/v1/memory/answer" ||
      pathname.startsWith("/v1/memory/nodes/") ||
      pathname.startsWith("/v1/memory/graph/") ||
      pathname === "/v1/memory/clusters" ||
      pathname.startsWith("/v1/memory/clusters/") ||
      pathname === "/v1/memory/items"
    ) {
      return;
    }
    deny();
  }

  if (operationFamily === "personal_collaboration_read") {
    if (
      (method === "POST" &&
        (pathname === "/v1/collaboration/realtime/snapshot" ||
          pathname === "/v1/collaboration/realtime/ack")) ||
      (method === "GET" && pathname === "/v1/collaboration/realtime/stream")
    ) {
      return;
    }
    deny();
  }

  if (operationFamily === "personal_collaboration_write") {
    deny();
  }

  if (operationFamily === "team_workspace_read") {
    if (
      (method === "GET" && pathname === "/v1/team-context") ||
      (method === "POST" &&
        pathname === "/v1/collaboration/realtime/snapshot") ||
      (method === "GET" && pathname === "/v1/collaboration/realtime/stream") ||
      (method === "POST" && pathname === "/v1/collaboration/realtime/ack")
    ) {
      return;
    }
    deny();
  }

  if (operationFamily === "capture_writes") {
    if (method !== "POST") {
      deny();
    }
    if (
      pathname === "/v1/sessions" ||
      /^\/v1\/sessions\/[^/]+\/events$/.test(pathname) ||
      pathname === "/v1/memory/capture-personal-event" ||
      pathname === "/v1/memory/conversation-items" ||
      pathname === "/v1/memory/token-usage" ||
      pathname === "/v1/memory/token-usage/rollups" ||
      pathname === "/v1/memory/conversation-items/project"
    ) {
      return;
    }
    deny();
  }

  if (operationFamily === "managed_execution") {
    if (
      pathname === "/v1/managed-conversation-runner/commands/claim" ||
      pathname === "/v1/managed-conversation-runner/wake" ||
      pathname === "/v1/managed-conversations" ||
      pathname === "/v1/managed-conversations/target-devices" ||
      /^\/v1\/managed-conversations\/[^/]+$/.test(pathname) ||
      /^\/v1\/managed-conversations\/[^/]+\/(?:prompts|handoffs|forks)$/.test(
        pathname
      ) ||
      /^\/v1\/managed-conversations\/[^/]+\/(?:handoffs|forks)\/active$/.test(
        pathname
      ) ||
      /^\/v1\/managed-conversation-runner\/executions\/[^/]+$/.test(pathname) ||
      /^\/v1\/managed-conversation-runner\/commands\/[^/]+\/(?:lease|complete|fail)$/.test(
        pathname
      ) ||
      /^\/v1\/managed-conversation-runner\/executions\/[^/]+\/(?:lease|release|state|runtime|runtime-binding-ready)$/.test(
        pathname
      ) ||
      /^\/v1\/managed-conversation-runner\/handoffs\/[^/]+\/(?:prepare|attest|verify|commit|restore|restore-lease|complete)$/.test(
        pathname
      ) ||
      /^\/v1\/managed-conversation-runner\/forks\/[^/]+\/(?:prepare-source|attest|target-material|prepare-child|complete|fail)$/.test(
        pathname
      ) ||
      /^\/v1\/managed-conversation-runner\/(?:handoffs|forks)\/active\/[^/]+$/.test(
        pathname
      )
    ) {
      return;
    }
    deny();
  }

  if (operationFamily === "action_grant") {
    if (
      pathname === "/v1/high-risk/action-grants" ||
      /^\/v1\/high-risk\/action-grants\/[^/]+$/.test(pathname) ||
      /^\/v1\/high-risk\/action-grants\/[^/]+\/await$/.test(pathname) ||
      pathname === "/v1/teams" ||
      pathname === "/v1/team-invites/accept" ||
      pathname.startsWith("/v1/teams/") ||
      pathname.startsWith("/v1/team-workspaces/") ||
      pathname.startsWith("/v1/retention/")
    ) {
      return;
    }
    deny();
  }

  if (operationFamily === "admin") {
    if (pathname === "/v1/teams" || pathname.startsWith("/v1/teams/")) {
      return;
    }
    deny();
  }

  deny();
};

const capabilityState = (
  backend: LocalEdgeUpstreamBackend,
  now: Date = new Date()
): LocalEdgeRouteDecision["capabilityState"] => {
  const state = backend.capabilities?.state ?? "not_checked";
  if (state !== "validated") {
    return state;
  }
  const expiresAt = backend.capabilities?.expiresAt;
  return expiresAt && Date.parse(expiresAt) <= now.getTime()
    ? "stale"
    : "validated";
};

const credentialState = (input: {
  upstreamBackendId?: string | null;
  operationFamily: LocalEdgeOperationFamily;
  deviceCredential?: Pick<
    DeviceCredentialRecord,
    "upstreamBackendId" | "operationFamilies"
  > | null;
  upstreamCredentialAvailable?: boolean;
  requestedMode?: LocalEdgeRouteMode;
}): LocalEdgeRouteDecision["credentialState"] => {
  const mode = input.requestedMode ?? defaultRouteMode[input.operationFamily];
  if (mode === "queued_sync_handoff" && input.operationFamily === "sync") {
    return input.upstreamCredentialAvailable ? "configured" : "missing";
  }
  const credential = input.deviceCredential;
  if (!credential) {
    return "missing";
  }
  if (credential.upstreamBackendId !== input.upstreamBackendId) {
    return "wrong_upstream";
  }
  return credential.operationFamilies.includes(input.operationFamily)
    ? "configured"
    : "operation_not_allowed";
};

const relayCredentialState = (
  input: { upstreamCredentialAvailable?: boolean },
  mode: LocalEdgeRouteMode
): LocalEdgeRouteDecision["relayCredentialState"] => {
  if (mode !== "live_upstream_proxy") {
    return "not_required";
  }
  return input.upstreamCredentialAvailable ? "configured" : "missing";
};

const capturePolicyDenial = (policy: CapturePolicy | null | undefined) => {
  if (!policy) {
    return null;
  }
  if (policy.captureState !== "enabled") {
    return "capture_disabled";
  }
  if (policy.visibility !== "personal") {
    return "unsupported_capture_visibility";
  }
  return null;
};

const decision = (
  input: Omit<LocalEdgeRouteDecision, "retryAfterCapabilityRefresh"> & {
    retryAfterCapabilityRefresh?: boolean;
  }
): LocalEdgeRouteDecision => ({
  retryAfterCapabilityRefresh: false,
  ...input
});
