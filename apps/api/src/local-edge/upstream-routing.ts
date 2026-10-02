import type { DeviceCredentialRecord } from "@koed/db";
import {
  COLLABORATION_CONTRACT_VERSION,
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
  | "managed_file_read"
  | "managed_terminal"
  | "ai_client_capability_publish"
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
  managed_file_read: "managedExecution",
  managed_terminal: "managedExecution",
  ai_client_capability_publish: "managedExecution",
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
  managed_file_read: "live_upstream_proxy",
  managed_terminal: "live_upstream_proxy",
  ai_client_capability_publish: "live_upstream_proxy",
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
    backend.capabilities?.schemaVersion === 9 &&
    backend.capabilities.payload?.capabilitySchemaVersion === 9 &&
    (availability === "available" || availability === "partial") &&
    backend.capabilities.payload?.protocols?.collaborationRealtime?.version ===
      COLLABORATION_CONTRACT_VERSION
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
      (method === "GET" &&
        /^\/v1\/teams\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/memory-retention(?:\/members)?$/i.test(
          pathname
        )) ||
      (method === "POST" &&
        pathname === "/v1/collaboration/realtime/snapshot") ||
      (method === "GET" && pathname === "/v1/collaboration/realtime/stream") ||
      (method === "POST" && pathname === "/v1/collaboration/realtime/ack")
    ) {
      return;
    }
    deny();
  }

  const agentRequestId =
    "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const agentTeam = `/v1/collaboration/teams/${agentRequestId}`;
  const chatTeam = `/v1/collaboration/teams/${agentRequestId}`;
  const chatThread = `${chatTeam}/threads/${agentRequestId}`;
  const chatMessages = `${chatThread}/messages`;
  const chatMessage = `${chatMessages}/${agentRequestId}`;
  const offerPath = new RegExp(`^${agentTeam}/agent-offers$`, "i");
  const requestPath = new RegExp(`^${agentTeam}/agent-requests$`, "i");
  const inboxPath = new RegExp(`^${agentTeam}/agent-requests/inbox$`, "i");
  const reviewPath = new RegExp(
    `^${agentTeam}/agent-requests/${agentRequestId}/review$`,
    "i"
  );
  if (
    operationFamily === "team_chat_read" &&
    method === "PUT" &&
    parsed.search === "" &&
    new RegExp(`^${chatThread}/(?:read-state|delivery-state)$`, "i").test(
      pathname
    )
  ) {
    return;
  }
  if (operationFamily === "team_chat_read" && method === "GET") {
    if (new RegExp(`^${chatMessages}$`, "i").test(pathname)) {
      const keys = [...parsed.searchParams.keys()];
      if (
        new Set(keys).size !== keys.length ||
        keys.some(
          (key) =>
            ![
              "beforeSequence",
              "afterSequence",
              "limit",
              "rootMessageId"
            ].includes(key)
        )
      )
        deny();
      for (const key of ["beforeSequence", "afterSequence", "limit"]) {
        const value = parsed.searchParams.get(key);
        if (value === null) continue;
        const validShape =
          key === "afterSequence"
            ? /^(0|[1-9][0-9]*)$/.test(value)
            : /^[1-9][0-9]*$/.test(value);
        const number = Number(value);
        if (
          !validShape ||
          !Number.isSafeInteger(number) ||
          (key === "limit" && number > 100)
        )
          deny();
      }
      const rootMessageId = parsed.searchParams.get("rootMessageId");
      if (
        rootMessageId !== null &&
        !new RegExp(`^${agentRequestId}$`, "i").test(rootMessageId)
      )
        deny();
      return;
    }
    if (offerPath.test(pathname) || reviewPath.test(pathname)) {
      if (parsed.search !== "") deny();
      return;
    }
    if (requestPath.test(pathname) || inboxPath.test(pathname)) {
      const keys = [...parsed.searchParams.keys()];
      if (
        inboxPath.test(pathname) &&
        keys.some((key) => !["limit", "cursor"].includes(key))
      )
        deny();
      if (
        new Set(keys).size !== keys.length ||
        keys.some(
          (key) =>
            ![
              "channelId",
              "teamProjectId",
              "status",
              "limit",
              "cursor"
            ].includes(key)
        )
      )
        deny();
      for (const key of ["channelId", "teamProjectId"]) {
        const value = parsed.searchParams.get(key);
        if (
          value !== null &&
          !new RegExp(`^${agentRequestId}$`, "i").test(value)
        )
          deny();
      }
      const status = parsed.searchParams.get("status");
      if (
        status !== null &&
        ![
          "awaiting_owner",
          "accepted",
          "declined",
          "withdrawn",
          "unavailable"
        ].includes(status)
      )
        deny();
      const limit = parsed.searchParams.get("limit");
      if (
        limit !== null &&
        (!/^[1-9][0-9]*$/.test(limit) || Number(limit) > 100)
      )
        deny();
      const cursor = parsed.searchParams.get("cursor");
      if (
        cursor !== null &&
        (cursor.length === 0 ||
          cursor.length > 512 ||
          Array.from(cursor).some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127;
          }))
      )
        deny();
      return;
    }
  }
  if (operationFamily === "team_chat_write" && parsed.search === "") {
    if (
      (method === "POST" && requestPath.test(pathname)) ||
      (method === "POST" &&
        new RegExp(`^${chatMessages}$`, "i").test(pathname)) ||
      (method === "PATCH" &&
        new RegExp(`^${chatMessage}$`, "i").test(pathname)) ||
      (method === "PUT" &&
        new RegExp(`^${chatMessage}/reactions$`, "i").test(pathname)) ||
      (method === "PUT" &&
        (new RegExp(`^${agentTeam}/agent-offers/${agentRequestId}$`, "i").test(
          pathname
        ) ||
          reviewPath.test(pathname) ||
          new RegExp(
            `^${agentTeam}/agent-requests/${agentRequestId}/decision$`,
            "i"
          ).test(pathname))) ||
      (method === "DELETE" &&
        new RegExp(`^${agentTeam}/agent-requests/${agentRequestId}$`, "i").test(
          pathname
        )) ||
      (method === "POST" &&
        new RegExp(
          `^${agentTeam}/agent-requests/${agentRequestId}/outcome$`,
          "i"
        ).test(pathname))
    )
      return;
  }

  const publicSquareTeam =
    "/v1/collaboration/teams/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/public-square";
  if (operationFamily === "team_chat_read") {
    if (
      method === "GET" &&
      new RegExp(`^${publicSquareTeam}$`, "i").test(pathname)
    ) {
      const keys = [...parsed.searchParams.keys()];
      if (
        keys.some((key) => key !== "limit" && key !== "cursor") ||
        new Set(keys).size !== keys.length
      )
        deny();
      return;
    }
    if (
      method === "GET" &&
      new RegExp(
        `^${publicSquareTeam}/projects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/connection$`,
        "i"
      ).test(pathname)
    )
      return;
    if (
      method === "GET" &&
      new RegExp(
        `^${publicSquareTeam}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/brief-draft$`,
        "i"
      ).test(pathname)
    )
      return;
    deny();
  }
  if (operationFamily === "team_chat_write") {
    if (
      method === "PUT" &&
      new RegExp(
        `^${publicSquareTeam}/projects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/connection$`,
        "i"
      ).test(pathname)
    )
      return;
    if (
      method === "POST" &&
      new RegExp(
        `^${publicSquareTeam}/projects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/unshare$`,
        "i"
      ).test(pathname)
    )
      return;
    if (
      method === "PUT" &&
      new RegExp(
        `^${publicSquareTeam}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/brief$`,
        "i"
      ).test(pathname)
    )
      return;
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

  if (operationFamily === "ai_client_capability_publish") {
    if (
      parsed.search === "" &&
      ((method === "PUT" &&
        /^\/v1\/memory\/ai-client-instances\/[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/.test(
          pathname
        )) ||
        (method === "POST" &&
          /^\/v1\/memory\/ai-client-instances\/[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}\/capability-snapshots$/.test(
            pathname
          )))
    ) {
      return;
    }
    deny();
  }

  if (operationFamily === "managed_execution") {
    if (
      ((pathname === "/v1/home" || pathname === "/v1/home/access") &&
        method === "GET") ||
      (/^\/v1\/home\/reminders\/[^/]+\/(?:clear|restore)$/u.test(pathname) &&
        method === "POST")
    ) {
      if (pathname === "/v1/home" && method === "GET") {
        if (
          [...parsed.searchParams.keys()].some(
            (key) => !["source", "cursor", "limit"].includes(key)
          ) ||
          (parsed.searchParams.has("source") &&
            ![
              "managed_runtime_item",
              "managed_execution",
              "personal_agent_job",
              "pull_request_review"
            ].includes(parsed.searchParams.get("source") ?? "")) ||
          (parsed.searchParams.has("cursor") &&
            !/^[A-Za-z0-9_-]{1,512}$/u.test(
              parsed.searchParams.get("cursor") ?? ""
            )) ||
          (parsed.searchParams.has("limit") &&
            !/^(?:[1-9]|[1-9][0-9]|100)$/u.test(
              parsed.searchParams.get("limit") ?? ""
            ))
        )
          deny();
      } else if (parsed.searchParams.size !== 0) {
        deny();
      }
      if (pathname.startsWith("/v1/home/reminders/")) {
        const encodedId =
          pathname.slice("/v1/home/reminders/".length).split("/")[0] ?? "";
        let decodedId = "";
        try {
          decodedId = decodeURIComponent(encodedId);
        } catch {
          deny();
        }
        if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(decodedId)) deny();
      }
      return;
    }
    if (
      pathname === "/v1/pull-requests" ||
      pathname.startsWith("/v1/pull-requests/")
    ) {
      const id =
        "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
      const matches = (pattern: string) =>
        new RegExp(pattern, "i").test(pathname);
      if (
        pathname === "/v1/pull-requests/runners" &&
        method === "GET" &&
        parsed.searchParams.size === 0
      )
        return;
      const list =
        pathname === "/v1/pull-requests" ||
        pathname === "/v1/pull-requests/operations";
      if (list && (method === "GET" || method === "POST")) {
        if (
          (method === "POST" && parsed.searchParams.size !== 0) ||
          [...parsed.searchParams.keys()].some(
            (key) =>
              ![
                "limit",
                "before",
                "agentId",
                "executionId",
                "repository",
                "number"
              ].includes(key)
          )
        )
          deny();
        return;
      }
      if (parsed.searchParams.size !== 0) deny();
      if (
        method === "GET" &&
        (matches(
          `^/v1/pull-requests/${id}(?:/draft(?:/frozen)?|/freezes/${id})?$`
        ) ||
          matches(`^/v1/pull-requests/operations/${id}$`) ||
          matches(`^/v1/pull-requests/runner/operations/${id}$`) ||
          matches(
            `^/v1/pull-requests/runner/reviews/${id}(?:/freezes/${id})?$`
          ) ||
          matches(`^/v1/pull-requests/runner/executions/${id}/review$`))
      )
        return;
      if (method === "PUT" && matches(`^/v1/pull-requests/${id}/draft$`))
        return;
      if (
        method === "POST" &&
        (matches(
          `^/v1/pull-requests/${id}/(?:draft/freeze|enable-fixes|refresh)$`
        ) ||
          matches(`^/v1/pull-requests/operations/${id}/cancel$`) ||
          pathname === "/v1/pull-requests/runner/operations/claim" ||
          matches(
            `^/v1/pull-requests/runner/operations/${id}/(?:heartbeat|complete|fail)$`
          ) ||
          matches(`^/v1/pull-requests/runner/reviews/${id}/complete$`))
      )
        return;
      deny();
    }
    if (
      /^\/v1\/managed-conversation-runner\/commands\/[^/]+\/personal-agent-(?:intent|turn-status)$/.test(
        pathname
      )
    ) {
      if (
        method === "POST" &&
        parsed.searchParams.size === 0 &&
        /^\/v1\/managed-conversation-runner\/commands\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/personal-agent-(?:intent|turn-status)$/i.test(
          pathname
        )
      )
        return;
      deny();
    }
    if (
      method === "GET" &&
      pathname === "/v1/personal-agents/activity" &&
      parsed.searchParams.size >= 1 &&
      [...parsed.searchParams.keys()].every((key) => key === "agentId") &&
      parsed.searchParams.getAll("agentId").length <= 100 &&
      parsed.searchParams.getAll("agentId").length > 0 &&
      new Set(parsed.searchParams.getAll("agentId")).size ===
        parsed.searchParams.getAll("agentId").length &&
      parsed.searchParams
        .getAll("agentId")
        .every((id) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            id
          )
        )
    ) {
      return;
    }
    if (
      method === "GET" &&
      /^\/v1\/personal-agents\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/jobs$/i.test(
        pathname
      ) &&
      [...parsed.searchParams.keys()].every(
        (key) => key === "limit" || key === "before"
      ) &&
      parsed.searchParams.getAll("limit").length <= 1 &&
      parsed.searchParams.getAll("before").length <= 1 &&
      (parsed.searchParams.get("limit") === null ||
        /^(?:[1-9]|1[0-9]|20)$/.test(parsed.searchParams.get("limit")!)) &&
      (parsed.searchParams.get("before") === null ||
        /^[A-Za-z0-9_-]{1,256}$/.test(parsed.searchParams.get("before")!))
    ) {
      return;
    }
    if (
      (method === "GET" &&
        (pathname === "/v1/personal-agent-role-templates" ||
          pathname === "/v1/personal-agents" ||
          pathname === "/v1/personal-agents/capabilities" ||
          /^\/v1\/personal-agents\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            pathname
          ))) ||
      (method === "POST" &&
        (pathname === "/v1/personal-agents" ||
          /^\/v1\/personal-agents\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:retire|restore)$/i.test(
            pathname
          ))) ||
      (method === "PATCH" &&
        /^\/v1\/personal-agents\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          pathname
        ))
    ) {
      return;
    }
    if (
      method === "GET" &&
      /^\/v1\/managed-conversations\/[^/]+\/agent-state$/.test(pathname)
    )
      return;
    if (
      (method === "GET" || method === "PUT") &&
      parsed.search === "" &&
      /^\/v1\/managed-conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/recall-feedback\/(?:provider|agent)(?::|%3[Aa])[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        pathname
      )
    )
      return;
    if (
      (method === "POST" &&
        /^\/v1\/managed-conversations\/[^/]+\/project-moves$/.test(pathname)) ||
      (method === "GET" &&
        /^\/v1\/managed-conversations\/[^/]+\/project-moves\/[^/]+$/.test(
          pathname
        )) ||
      (method === "POST" &&
        /^\/v1\/managed-conversations\/[^/]+\/project-moves\/[^/]+\/cancel$/.test(
          pathname
        )) ||
      (method === "POST" &&
        (pathname === "/v1/managed-conversation-runner/project-moves/claim" ||
          /^\/v1\/managed-conversation-runner\/project-moves\/[^/]+\/(?:lease|complete|fail)$/.test(
            pathname
          )))
    )
      return;
    if (
      method === "POST" &&
      /^\/v1\/managed-conversations\/[^/]+\/start\/cancel$/.test(pathname)
    )
      return;
    if (
      method === "POST" &&
      /^\/v1\/managed-conversations\/[^/]+\/prompts\/[^/]+\/cancel$/.test(
        pathname
      )
    )
      return;
    if (
      method === "POST" &&
      /^\/v1\/managed-conversations\/[^/]+\/checkpoints\/[^/]+\/restore$/.test(
        pathname
      )
    )
      return;
    if (
      pathname === "/v1/managed-conversation-runner/commands/claim" ||
      pathname === "/v1/managed-conversation-runner/commands/claim-controls" ||
      pathname === "/v1/managed-conversation-runner/runtime-items" ||
      pathname === "/v1/managed-conversation-runner/wake" ||
      (method === "GET" &&
        /^\/v1\/managed-conversation-runner\/personal-agent\/jobs(?:\/[^/]+(?:\/attempts)?)?$/.test(
          pathname
        )) ||
      (method === "POST" &&
        /^\/v1\/managed-conversation-runner\/personal-agent\/jobs\/[^/]+\/attempts(?:\/[^/]+\/(?:output|complete))?$/.test(
          pathname
        )) ||
      pathname === "/v1/managed-conversations" ||
      (method === "GET" &&
        pathname === "/v1/managed-conversations/recovery/lookup") ||
      pathname === "/v1/managed-conversations/target-devices" ||
      /^\/v1\/managed-conversations\/[^/]+$/.test(pathname) ||
      /^\/v1\/managed-conversations\/[^/]+\/(?:prompts|handoffs|forks|runtime|interrupt|stop)$/.test(
        pathname
      ) ||
      /^\/v1\/managed-conversations\/[^/]+\/runtime-items\/[^/]+\/respond$/.test(
        pathname
      ) ||
      /^\/v1\/managed-conversations\/[^/]+\/(?:handoffs|forks)\/active$/.test(
        pathname
      ) ||
      /^\/v1\/managed-conversation-runner\/executions\/[^/]+$/.test(pathname) ||
      /^\/v1\/managed-conversation-runner\/commands\/[^/]+\/(?:lease|complete|fail)$/.test(
        pathname
      ) ||
      /^\/v1\/managed-conversation-runner\/executions\/[^/]+\/(?:lease|release|state|runtime|runtime-binding-(?:ready|failed))$/.test(
        pathname
      ) ||
      /^\/v1\/managed-conversation-runner\/runtime-items\/[^/]+(?:\/resolve)?$/.test(
        pathname
      ) ||
      /^\/v1\/managed-conversation-runner\/executions\/[^/]+\/runtime-items\/cancel$/.test(
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

  if (operationFamily === "managed_file_read") {
    if (
      method === "GET" &&
      /^\/v1\/managed-conversations\/[^/]+\/diff$/.test(pathname)
    )
      return;
    if (
      /^\/v1\/managed-conversations\/[^/]+\/files(?:\/[^/]+)?$/.test(
        pathname
      ) ||
      pathname === "/v1/managed-conversation-runner/commands/claim-files" ||
      /^\/v1\/managed-conversation-runner\/commands\/[^/]+\/(?:file-complete|file-fail)$/.test(
        pathname
      )
    ) {
      return;
    }
    deny();
  }

  if (operationFamily === "managed_terminal") {
    if (
      /^\/v1\/managed-conversations\/[^/]+\/terminals(?:\/[^/]+)?$/.test(
        pathname
      ) ||
      /^\/v1\/managed-conversations\/[^/]+\/terminals\/[^/]+\/(?:stop|context)$/.test(
        pathname
      ) ||
      /^\/v1\/managed-conversations\/[^/]+\/terminals\/[^/]+\/attach$/.test(
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
