import { existsSync, readFileSync, statSync } from "node:fs";
import type { DeviceCredentialRecord } from "@koed/db";
import { assertSecureHttpTransport } from "@koed/shared";
import type { CapturePolicy } from "../server/context.js";

export type LocalEdgeOperationFamily =
  | "personal_memory_read"
  | "team_workspace_read"
  | "share_grant_management"
  | "capture_writes"
  | "sync"
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

export interface LocalEdgeUpstreamBackend {
  id: string;
  baseUrl: string;
  routePolicy: Partial<Record<RoutePolicyKey, "enabled" | "disabled">>;
  credential?: { status?: string };
  capabilities?: {
    state?: "validated" | "stale" | "failed" | "not_checked";
    expiresAt?: string | null;
  };
}

export interface LocalEdgeUpstreamRegistry {
  backends: LocalEdgeUpstreamBackend[];
}

interface RegistryCacheEntry {
  mtimeMs: number;
  refreshAfterMs: number;
  registry: LocalEdgeUpstreamRegistry;
}

type RoutePolicyKey =
  | "personalMemoryRead"
  | "teamWorkspaceRead"
  | "shareGrantManagement"
  | "captureWrites"
  | "sync"
  | "admin";

const operationRoutePolicyKey: Record<
  LocalEdgeOperationFamily,
  RoutePolicyKey
> = {
  personal_memory_read: "personalMemoryRead",
  team_workspace_read: "teamWorkspaceRead",
  share_grant_management: "shareGrantManagement",
  capture_writes: "captureWrites",
  sync: "sync",
  admin: "admin"
};

const defaultRouteMode: Record<LocalEdgeOperationFamily, LocalEdgeRouteMode> = {
  personal_memory_read: "local_only",
  team_workspace_read: "live_upstream_proxy",
  share_grant_management: "live_upstream_proxy",
  capture_writes: "queued_sync_handoff",
  sync: "queued_sync_handoff",
  admin: "live_upstream_proxy"
};

const registryCache = new Map<string, RegistryCacheEntry>();
const registryRefreshIntervalMs = 1000;

export const readLocalEdgeUpstreamRegistry = (
  path: string,
  deps: {
    existsSync?: typeof existsSync;
    readFileSync?: typeof readFileSync;
    statSync?: typeof statSync;
  } = {}
): LocalEdgeUpstreamRegistry => {
  const resolvedExistsSync = deps.existsSync ?? existsSync;
  const resolvedReadFileSync = deps.readFileSync ?? readFileSync;
  const resolvedStatSync = deps.statSync ?? statSync;
  const now = Date.now();
  const cached = registryCache.get(path);
  if (cached && cached.refreshAfterMs > now) {
    return cached.registry;
  }
  if (!resolvedExistsSync(path)) {
    const registry = { backends: [] };
    registryCache.set(path, {
      mtimeMs: -1,
      refreshAfterMs: now + registryRefreshIntervalMs,
      registry
    });
    return registry;
  }
  const mtimeMs = resolvedStatSync(path).mtimeMs;
  if (cached?.mtimeMs === mtimeMs) {
    cached.refreshAfterMs = now + registryRefreshIntervalMs;
    return cached.registry;
  }
  const parsed = JSON.parse(
    resolvedReadFileSync(path, "utf8") as string
  ) as Partial<LocalEdgeUpstreamRegistry>;
  const registry = {
    backends: Array.isArray(parsed.backends)
      ? parsed.backends.filter(isUpstreamBackend)
      : []
  };
  registryCache.set(path, {
    mtimeMs,
    refreshAfterMs: now + registryRefreshIntervalMs,
    registry
  });
  return registry;
};

export const upstreamBackendById = (
  registry: LocalEdgeUpstreamRegistry,
  upstreamBackendId: string
): LocalEdgeUpstreamBackend | null =>
  registry.backends.find((backend) => backend.id === upstreamBackendId) ?? null;

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

  if (
    operationFamily === "personal_memory_read" ||
    operationFamily === "team_workspace_read"
  ) {
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

  if (operationFamily === "share_grant_management") {
    if (method !== "GET" && method !== "POST" && method !== "DELETE") {
      deny();
    }
    if (
      /^\/v1\/team-workspaces\/[^/]+\/session-share-grants(?:\/[^/]+)?$/.test(
        pathname
      )
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

  if (operationFamily === "admin") {
    if (pathname === "/v1/teams" || pathname.startsWith("/v1/teams/")) {
      return;
    }
    deny();
  }

  deny();
};

const hasSecureUpstreamBaseUrl = (value: string): boolean => {
  try {
    assertSecureHttpTransport(new URL(value), "Upstream URL");
    return true;
  } catch {
    return false;
  }
};

const isUpstreamBackend = (
  value: unknown
): value is LocalEdgeUpstreamBackend => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { baseUrl?: unknown }).baseUrl !== "string"
  ) {
    return false;
  }
  return hasSecureUpstreamBaseUrl((value as { baseUrl: string }).baseUrl);
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
}): LocalEdgeRouteDecision["credentialState"] => {
  const credential = input.deviceCredential;
  if (!credential) {
    return "missing";
  }
  if (credential.upstreamBackendId !== input.upstreamBackendId) {
    return "wrong_upstream";
  }
  return credential.operationFamilies.includes(input.operationFamily) ||
    credential.operationFamilies.includes("*")
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
