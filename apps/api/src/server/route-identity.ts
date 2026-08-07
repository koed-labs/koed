import { deploymentProfiles, type DeploymentProfile } from "./capabilities.js";

export type RouteIdentity =
  | "public"
  | "optional_session"
  | "session"
  | "api_token"
  | "session_or_api_token"
  | "session_or_device_credential"
  | "api_token_or_device_credential"
  | "internal_service_token"
  | "device_credential"
  | "local_edge_client_credential"
  | "pds_relay_proof"
  | "upstream_credential";

export type RouteIdentityStatus = "implemented" | "not_implemented";
export type RouteDeploymentMode = DeploymentProfile;

const allDeploymentModes = deploymentProfiles;

const teamDeploymentModes = [
  "private_vps",
  "team_self_hosted",
  "koed_managed_cloud"
] as const satisfies readonly RouteDeploymentMode[];

const remoteEnrollmentDeploymentModes =
  allDeploymentModes satisfies readonly RouteDeploymentMode[];

const workosDeploymentModes = [
  "team_self_hosted",
  "koed_managed_cloud"
] as const satisfies readonly RouteDeploymentMode[];

export const localEdgeDeploymentModes = [
  "developer",
  "local_personal"
] as const satisfies readonly RouteDeploymentMode[];

export interface RouteIdentityContract {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  path: string;
  identity: RouteIdentity;
  status: RouteIdentityStatus;
  domain:
    | "operations"
    | "analytics"
    | "auth"
    | "api_tokens"
    | "capture"
    | "personal_memory"
    | "team_memory"
    | "collaboration"
    | "shared_memory"
    | "high_risk"
    | "retention"
    | "local_synthesis"
    | "future_remote";
  description: string;
  deploymentModes: readonly RouteDeploymentMode[];
  teamAuthority:
    | "none"
    | "request_time_team_membership"
    | "request_time_team_workspace"
    | "request_time_team_admin"
    | "request_time_shared_memory_owner"
    | "request_time_action_grant"
    | "future_request_time";
}

const route = (
  method: RouteIdentityContract["method"],
  path: string,
  identity: RouteIdentity,
  domain: RouteIdentityContract["domain"],
  description: string,
  teamAuthority: RouteIdentityContract["teamAuthority"] = "none",
  status: RouteIdentityStatus = "implemented",
  deploymentModes: readonly RouteDeploymentMode[] = allDeploymentModes
): RouteIdentityContract => ({
  method,
  path,
  identity,
  status,
  domain,
  description,
  deploymentModes,
  teamAuthority
});

const managedConversationRunnerRoutes = [
  [
    "GET",
    "/v1/managed-conversation-runner/executions",
    "List active managed Conversation executions assigned to this runner."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/commands/claim",
    "Claim durable managed Conversation commands assigned to this runner."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/commands/reconcile-abandoned",
    "Reconcile expired non-replayable provider commands assigned to this runner."
  ],
  [
    "GET",
    "/v1/managed-conversation-runner/handoffs/active/{executionId}",
    "Read the active handoff assigned to this runner."
  ],
  [
    "GET",
    "/v1/managed-conversation-runner/handoffs/latest/{executionId}",
    "Read the latest handoff assigned to this runner for crash recovery."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/handoffs/{handoffId}/workspace-snapshots",
    "Begin an encrypted handoff workspace snapshot upload."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/handoffs/{handoffId}/workspace-snapshots/{snapshotId}/chunks/{chunkIndex}",
    "Upload one bounded handoff workspace snapshot chunk."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/handoffs/{handoffId}/workspace-snapshots/{snapshotId}/finalize",
    "Finalize a complete handoff workspace snapshot."
  ],
  [
    "GET",
    "/v1/managed-conversation-runner/handoffs/{handoffId}/workspace-snapshots/{snapshotId}",
    "Read handoff workspace snapshot metadata assigned to this runner."
  ],
  [
    "GET",
    "/v1/managed-conversation-runner/handoffs/{handoffId}/workspace-snapshots/{snapshotId}/chunks/{chunkIndex}",
    "Download one verified handoff workspace snapshot chunk."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/handoffs/{handoffId}/prepare",
    "Prepare an immutable handoff source and workspace boundary."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/handoffs/{handoffId}/attest",
    "Attest the handoff source boundary from its assigned source device."
  ],
  [
    "GET",
    "/v1/managed-conversation-runner/handoffs/{handoffId}/target-material",
    "Read handoff target material assigned to this runner."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/handoffs/{handoffId}/source-download-authorization",
    "Create a scoped source download authorization for a handoff target."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/handoffs/{handoffId}/verify",
    "Record target verification for a handoff."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/handoffs/{handoffId}/commit",
    "Commit a verified exclusive handoff."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/handoffs/{handoffId}/restore",
    "Acquire a bounded handoff restoration attempt."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/handoffs/{handoffId}/restore-lease",
    "Renew the assigned handoff restoration lease."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/handoffs/{handoffId}/complete",
    "Complete a verified handoff restoration."
  ],
  [
    "GET",
    "/v1/managed-conversation-runner/forks/active/{executionId}",
    "Read the active fork assigned to this runner."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/forks/{forkId}/workspace-snapshots",
    "Begin an encrypted fork workspace snapshot upload."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/forks/{forkId}/workspace-snapshots/{snapshotId}/chunks/{chunkIndex}",
    "Upload one bounded fork workspace snapshot chunk."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/forks/{forkId}/workspace-snapshots/{snapshotId}/finalize",
    "Finalize a complete fork workspace snapshot."
  ],
  [
    "GET",
    "/v1/managed-conversation-runner/forks/{forkId}/workspace-snapshots/{snapshotId}",
    "Read fork workspace snapshot metadata assigned to this runner."
  ],
  [
    "GET",
    "/v1/managed-conversation-runner/forks/{forkId}/workspace-snapshots/{snapshotId}/chunks/{chunkIndex}",
    "Download one verified fork workspace snapshot chunk."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/forks/{forkId}/prepare-source",
    "Prepare an immutable fork source and workspace boundary."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/forks/{forkId}/attest",
    "Attest the fork source boundary from its assigned source device."
  ],
  [
    "GET",
    "/v1/managed-conversation-runner/forks/{forkId}/target-material",
    "Read fork target material assigned to this runner."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/forks/{forkId}/source-download-authorization",
    "Create a scoped source download authorization for a fork target."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/forks/{forkId}/prepare-child",
    "Prepare an explicit fork child execution."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/forks/{forkId}/complete",
    "Complete an explicit fork after provider identity binding."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/forks/{forkId}/fail",
    "Fail or quarantine an explicit fork attempt."
  ],
  [
    "GET",
    "/v1/managed-conversation-runner/executions/{executionId}",
    "Read an execution assigned to this runner."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/commands/{commandId}/lease",
    "Renew an assigned managed command lease."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/executions/{executionId}/lease",
    "Renew an assigned execution lease."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/executions/{executionId}/release",
    "Release an assigned execution runner lease."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/commands/{commandId}/complete",
    "Complete an assigned managed command."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/commands/{commandId}/fail",
    "Fail or reconcile an assigned managed command."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/commands/{commandId}/block-on-source",
    "Block an assigned command on an exact source generation."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/source-replicas/release",
    "Release commands blocked on an exact replicated source generation."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/executions/{executionId}/runtime-binding-ready",
    "Release a deferred start after its assigned Personal Device persists the local runtime binding."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/executions/{executionId}/runtime",
    "Bind provider runtime identity to an assigned execution."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/executions/{executionId}/source-generation",
    "Bind the exact origin source generation to a running execution."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/executions/{executionId}/state",
    "Advance an assigned execution lifecycle state."
  ],
  [
    "GET",
    "/v1/managed-conversation-runner/wake",
    "Wait for a durable managed runner wake signal."
  ]
] as const;

export const routeIdentityContracts = [
  route("GET", "/", "public", "operations", "Coarse service orientation."),
  route("GET", "/health", "public", "operations", "Coarse health probe."),
  route("GET", "/ready", "public", "operations", "Coarse readiness probe."),
  route(
    "GET",
    "/openapi.json",
    "public",
    "operations",
    "OpenAPI and route identity discovery."
  ),
  route(
    "GET",
    "/v1/capabilities",
    "public",
    "operations",
    "Safe public capability discovery."
  ),
  route(
    "GET",
    "/v1/capabilities/authenticated",
    "session",
    "operations",
    "Authenticated capability discovery extension point."
  ),
  route(
    "GET",
    "/health/details",
    "session",
    "operations",
    "Detailed diagnostics for a browser-authenticated Operator."
  ),
  route(
    "GET",
    "/self-host/status",
    "optional_session",
    "operations",
    "Public status is redacted; session-authenticated callers receive details."
  ),
  route(
    "GET",
    "/self-host/diagnostics",
    "session",
    "operations",
    "Detailed local diagnostics."
  ),
  route(
    "GET",
    "/ops/status",
    "session",
    "operations",
    "Redacted hosted/self-hosted operations status for authenticated operators."
  ),
  route(
    "POST",
    "/v1/cross-identity-sync/relationships/{relationshipId}/retry",
    "session_or_device_credential",
    "future_remote",
    "Retry a failed durable Cross-Identity Sync queue entry without changing its cursor or identity."
  ),
  route(
    "POST",
    "/ops/test-alert",
    "session",
    "operations",
    "Synthetic redacted operations alert payload for alert-routing tests."
  ),
  route(
    "GET",
    "/ops/support/teams/{teamId}/overview",
    "session",
    "operations",
    "Hosted-operator redacted Team support overview.",
    "none",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/ops/support/teams/{teamId}/bundle",
    "session",
    "operations",
    "Create an encrypted hosted-operator redacted Team support bundle.",
    "none",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/self-host/smoke-test",
    "api_token",
    "operations",
    "AI-client compatibility smoke test."
  ),

  route("GET", "/auth/setup-status", "public", "auth", "Setup state."),
  route("POST", "/auth/setup", "public", "auth", "Initial local setup."),
  route("POST", "/auth/register", "public", "auth", "Local user registration."),
  route("POST", "/auth/login", "public", "auth", "Local user login."),
  route(
    "GET",
    "/auth/workos/login",
    "public",
    "auth",
    "WorkOS/AuthKit browser authorization redirect.",
    "none",
    "implemented",
    workosDeploymentModes
  ),
  route(
    "GET",
    "/auth/workos/callback",
    "public",
    "auth",
    "WorkOS/AuthKit callback that creates a Koed browser session after state and provider verification.",
    "none",
    "implemented",
    workosDeploymentModes
  ),
  route("POST", "/auth/logout", "optional_session", "auth", "Session logout."),
  route("GET", "/me", "session", "auth", "Browser session identity."),
  route(
    "GET",
    "/v1/analytics/activation-funnel",
    "session",
    "analytics",
    "View a privacy-safe hosted activation funnel summary."
  ),
  route(
    "POST",
    "/v1/analytics/activation-events",
    "session",
    "analytics",
    "Record a privacy-safe hosted activation funnel event."
  ),
  route("POST", "/api-tokens", "session", "api_tokens", "Create API Token."),
  route("GET", "/api-tokens", "session", "api_tokens", "List API Tokens."),
  route(
    "DELETE",
    "/api-tokens/{id}",
    "session",
    "api_tokens",
    "Revoke API Token."
  ),

  route(
    "GET",
    "/v1/access/check",
    "api_token",
    "capture",
    "MCP Server and Supported Capture Hook access check."
  ),
  route(
    "GET",
    "/v1/capture-policy/effective",
    "api_token",
    "capture",
    "Capture Hook effective policy lookup."
  ),
  route(
    "GET",
    "/v1/capture-policies",
    "session_or_api_token",
    "capture",
    "List capture policies for Desktop or AI-client use."
  ),
  route(
    "PUT",
    "/v1/capture-policies",
    "session_or_api_token",
    "capture",
    "Update capture policies for Desktop or AI-client use."
  ),
  route(
    "POST",
    "/v1/sessions",
    "api_token",
    "capture",
    "Create captured session from AI-client integration."
  ),
  route(
    "GET",
    "/v1/sessions/latest",
    "api_token",
    "capture",
    "Find latest Personal Captured Session for a Project."
  ),
  route(
    "GET",
    "/v1/sessions/{sessionId}",
    "api_token",
    "capture",
    "Read Personal Captured Session metadata for Project verification."
  ),
  route(
    "POST",
    "/v1/sessions/{sessionId}/events",
    "session_or_api_token",
    "capture",
    "Legacy/session event capture path."
  ),
  route(
    "POST",
    "/v1/memory/capture-personal-event",
    "api_token",
    "capture",
    "Capture personal Memory Event from AI-client integration."
  ),
  route(
    "POST",
    "/v1/memory/conversation-items",
    "api_token",
    "capture",
    "Raw transcript-source ingestion."
  ),
  route(
    "POST",
    "/v1/memory/token-usage",
    "api_token",
    "capture",
    "Record AI-client token usage."
  ),
  route(
    "GET",
    "/v1/memory/token-usage/rollups",
    "api_token",
    "capture",
    "Read AI-client token usage rollups."
  ),
  route(
    "POST",
    "/v1/memory/conversation-items/release",
    "api_token",
    "capture",
    "Release a reconciled managed-conversation Projection hold."
  ),
  route(
    "POST",
    "/v1/memory/conversation-items/rebuild",
    "session",
    "capture",
    "Reset and rebuild a browser-authenticated Personal Conversation Projection."
  ),
  route(
    "POST",
    "/v1/memory/conversation-items/project",
    "api_token",
    "capture",
    "Project pending raw transcript rows."
  ),
  route(
    "POST",
    "/v1/conversation-source-artifacts",
    "session_or_api_token",
    "capture",
    "Register an owner-scoped Conversation Source Artifact.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/conversation-source-artifacts/lookup",
    "session_or_api_token",
    "capture",
    "Resolve an owner-scoped Conversation Source Artifact identity.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/conversation-source-artifacts/generations/{sourceGenerationId}",
    "api_token",
    "capture",
    "Resolve one exact owner-scoped Conversation Source generation.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/conversation-source-artifacts/{artifactId}/segments",
    "session_or_api_token",
    "capture",
    "Durably append one verified immutable source segment.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/conversation-source-artifacts/{artifactId}/segments",
    "session_or_api_token",
    "capture",
    "List owner-scoped source segment metadata.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/conversation-source-artifacts/{artifactId}/segments/{segmentId}/content",
    "session_or_api_token",
    "capture",
    "Read one verified owner-scoped source segment.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/conversation-source-artifacts/{artifactId}/successor",
    "api_token",
    "capture",
    "Create the next device-bound generation after a finalized source.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/conversation-source-artifacts/{artifactId}/cursor",
    "session_or_api_token",
    "capture",
    "Read one owner-scoped source consumer cursor.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/conversation-source-artifacts/{artifactId}/cursor",
    "session_or_api_token",
    "capture",
    "Advance one owner-scoped source consumer cursor.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/historical-imports",
    "session_or_api_token",
    "capture",
    "Create local Personal Memory historical import run.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/historical-imports",
    "session_or_api_token",
    "capture",
    "List owner-scoped redacted historical import status.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/historical-imports/{runId}",
    "session_or_api_token",
    "capture",
    "Read owner-scoped redacted historical import status.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "PATCH",
    "/v1/historical-imports/{runId}",
    "session_or_api_token",
    "capture",
    "Transition owner-scoped historical import run state.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/historical-import-sources",
    "session_or_api_token",
    "capture",
    "Register local-only historical source state.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/historical-import-sources/lookup",
    "session_or_api_token",
    "capture",
    "Look up owner-scoped redacted historical source state by canonical identity.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "PATCH",
    "/v1/historical-import-sources/{sourceId}",
    "session_or_api_token",
    "capture",
    "Transition owner-scoped historical source state.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/historical-import-sources/{sourceId}/batches",
    "session_or_api_token",
    "capture",
    "Idempotently ingest policy-eligible Personal Memory transcript batch.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),

  route(
    "POST",
    "/v1/memory/search",
    "api_token",
    "personal_memory",
    "Search Personal Memory for the authenticated API Token owner."
  ),
  route(
    "POST",
    "/v1/memory/answer",
    "session_or_api_token",
    "personal_memory",
    "Retrieve Personal Memory evidence."
  ),
  route(
    "GET",
    "/v1/memory/nodes/{nodeId}/expand",
    "api_token",
    "personal_memory",
    "Expand a Personal Memory node for the authenticated API Token owner."
  ),
  route(
    "GET",
    "/v1/memory/clusters",
    "session_or_api_token",
    "personal_memory",
    "Deprecated personal graph cluster list."
  ),
  route(
    "GET",
    "/v1/memory/clusters/{clusterId}/memories",
    "session_or_api_token",
    "personal_memory",
    "Deprecated personal graph cluster memories."
  ),
  route(
    "GET",
    "/v1/memory/items",
    "session_or_api_token",
    "personal_memory",
    "Deprecated personal memory browser items."
  ),
  route(
    "GET",
    "/v1/memory/graph/overview",
    "session_or_api_token",
    "personal_memory",
    "Personal graph overview."
  ),
  route(
    "GET",
    "/v1/memory/graph/nodes",
    "session_or_api_token",
    "personal_memory",
    "List Personal Memory graph nodes."
  ),
  route(
    "GET",
    "/v1/memory/graph/nodes/{nodeId}",
    "session_or_api_token",
    "personal_memory",
    "Read Personal Memory graph node detail."
  ),
  route(
    "GET",
    "/v1/memory/graph/events",
    "session_or_api_token",
    "personal_memory",
    "List Personal Memory graph events."
  ),
  route(
    "GET",
    "/v1/memory/graph/threads",
    "session_or_api_token",
    "personal_memory",
    "List Personal Memory graph threads."
  ),
  route(
    "GET",
    "/v1/memory/graph/events/{eventId}",
    "session_or_api_token",
    "personal_memory",
    "Read Personal Memory graph event detail."
  ),
  route(
    "PATCH",
    "/v1/memory/graph/events/{eventId}",
    "session_or_api_token",
    "personal_memory",
    "Update personal memory event presentation/deletion state."
  ),
  route(
    "PATCH",
    "/v1/memory/graph/sessions/{sessionId}/title",
    "session_or_api_token",
    "personal_memory",
    "Rename a personal captured session."
  ),
  route(
    "PATCH",
    "/v1/memory/graph/sessions/{sessionId}/project",
    "session_or_api_token",
    "personal_memory",
    "Move a personal Captured Session to a Personal Project or reset automatic placement."
  ),
  route(
    "DELETE",
    "/v1/memory/graph/events/{eventId}",
    "session_or_api_token",
    "personal_memory",
    "Invalidate a personal memory event."
  ),
  route(
    "GET",
    "/v1/memory/export",
    "session_or_api_token",
    "personal_memory",
    "Export visible personal memory records."
  ),
  route(
    "POST",
    "/v1/memory/curated/proposals",
    "api_token",
    "personal_memory",
    "Create a source-linked Curated Memory proposal from an AI-client integration."
  ),
  route(
    "GET",
    "/v1/memory/curated/proposals",
    "api_token",
    "personal_memory",
    "List Curated Memory proposals for the authenticated API Token owner."
  ),
  route(
    "GET",
    "/v1/memory/curated/assertions",
    "api_token",
    "personal_memory",
    "List Curated Memory assertions for the authenticated API Token owner."
  ),
  route(
    "POST",
    "/v1/memory/curated/search",
    "api_token",
    "personal_memory",
    "Search Curated Memory assertions for the authenticated API Token owner."
  ),
  route(
    "GET",
    "/v1/memory/curated/assertions/{assertionId}",
    "api_token",
    "personal_memory",
    "Read a Curated Memory assertion for the authenticated API Token owner."
  ),
  route(
    "POST",
    "/v1/memory/curated/assertions/{assertionId}/suppress",
    "api_token",
    "personal_memory",
    "Suppress or expire a Curated Memory assertion."
  ),
  route(
    "POST",
    "/v1/memory/curated/reconcile",
    "api_token",
    "personal_memory",
    "Reconcile Curated Memory sources with derived Memory Events and LCM summaries."
  ),
  route(
    "GET",
    "/v1/memory/nodes/{nodeId}",
    "api_token",
    "personal_memory",
    "AI-client memory node detail."
  ),
  route(
    "PATCH",
    "/v1/memory/nodes/{nodeId}",
    "session_or_api_token",
    "personal_memory",
    "Update personal memory node presentation/deletion state."
  ),
  route(
    "DELETE",
    "/v1/memory/nodes/{nodeId}",
    "session_or_api_token",
    "personal_memory",
    "Invalidate a personal memory node."
  ),
  route(
    "GET",
    "/v1/memory/graph/stream",
    "session_or_api_token",
    "personal_memory",
    "Personal Memory graph/event stream for Desktop and local integrations."
  ),
  route(
    "OPTIONS",
    "/v1/memory/graph/stream",
    "public",
    "personal_memory",
    "CORS preflight for graph stream."
  ),

  route(
    "GET",
    "/v1/memory/questions",
    "session_or_api_token",
    "local_synthesis",
    "List local Memory Questions."
  ),
  route(
    "POST",
    "/v1/memory/questions",
    "session_or_api_token",
    "local_synthesis",
    "Create local Memory Question."
  ),
  route(
    "POST",
    "/v1/memory/questions/claim-pending",
    "session_or_api_token",
    "local_synthesis",
    "Claim pending local Memory Questions."
  ),
  route(
    "POST",
    "/v1/memory/questions/final",
    "session_or_api_token",
    "local_synthesis",
    "Create finalized local Memory Question."
  ),
  route(
    "GET",
    "/v1/memory/questions/{questionId}",
    "session_or_api_token",
    "local_synthesis",
    "Read local Memory Question."
  ),
  route(
    "PATCH",
    "/v1/memory/questions/{questionId}",
    "session_or_api_token",
    "local_synthesis",
    "Update local Memory Question."
  ),
  route(
    "GET",
    "/v1/memory/local-agent-settings",
    "session_or_api_token",
    "local_synthesis",
    "Read local AI-client synthesis settings."
  ),
  route(
    "PUT",
    "/v1/memory/local-agent-settings/{flowKey}",
    "session_or_api_token",
    "local_synthesis",
    "Update local AI-client synthesis settings."
  ),
  route(
    "GET",
    "/v1/memory/session-titles/pending",
    "api_token",
    "local_synthesis",
    "Local captured-session title work queue."
  ),
  route(
    "POST",
    "/v1/memory/session-titles/{sessionId}",
    "api_token",
    "local_synthesis",
    "Submit local captured-session title."
  ),
  route(
    "GET",
    "/v1/memory/lcm/summaries/pending",
    "api_token",
    "local_synthesis",
    "Local LCM Summary work queue."
  ),
  route(
    "POST",
    "/v1/memory/lcm/summaries/{nodeId}",
    "api_token",
    "local_synthesis",
    "Submit local LCM Summary."
  ),

  route(
    "GET",
    "/v1/collaboration/teams/{teamId}/participants",
    "session_or_device_credential",
    "collaboration",
    "List enabled Team collaboration participants.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/collaboration/teams/{teamId}/threads",
    "session_or_device_credential",
    "collaboration",
    "List authorized Team collaboration threads.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/collaboration/teams/{teamId}/workspaces/{teamWorkspaceId}/channels",
    "session_or_device_credential",
    "collaboration",
    "List authorized Team Workspace channels.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/collaboration/teams/{teamId}/workspaces/{teamWorkspaceId}/channels",
    "session_or_device_credential",
    "collaboration",
    "Create a Team Workspace channel.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/collaboration/teams/{teamId}/direct-messages",
    "session_or_device_credential",
    "collaboration",
    "List authorized Team direct-message threads.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/collaboration/teams/{teamId}/direct-messages",
    "session_or_device_credential",
    "collaboration",
    "Create or return a Team direct-message thread.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/collaboration/teams/{teamId}/group-direct-messages",
    "session_or_device_credential",
    "collaboration",
    "Create a Team group direct-message thread.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/collaboration/teams/{teamId}/workspaces/{teamWorkspaceId}/shared-sessions/{sharedLogicalMemoryId}/discussion",
    "session_or_device_credential",
    "collaboration",
    "Create or return a Shared Memory discussion thread.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/collaboration/teams/{teamId}/threads/{threadId}",
    "session_or_device_credential",
    "collaboration",
    "Read an authorized Team collaboration thread.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PATCH",
    "/v1/collaboration/teams/{teamId}/threads/{threadId}/name",
    "session_or_device_credential",
    "collaboration",
    "Rename an authorized Team collaboration thread.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PATCH",
    "/v1/collaboration/teams/{teamId}/threads/{threadId}/topic",
    "session_or_device_credential",
    "collaboration",
    "Update an authorized Team collaboration thread topic.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/collaboration/teams/{teamId}/threads/{threadId}/archive",
    "session_or_device_credential",
    "collaboration",
    "Archive an authorized Team collaboration thread.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/collaboration/teams/{teamId}/threads/{threadId}/restore",
    "session_or_device_credential",
    "collaboration",
    "Restore an authorized Team collaboration thread.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/collaboration/teams/{teamId}/threads/{threadId}/messages",
    "session_or_device_credential",
    "collaboration",
    "List authorized Team collaboration messages.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/collaboration/teams/{teamId}/threads/{threadId}/messages",
    "session_or_device_credential",
    "collaboration",
    "Post an authorized Team collaboration message.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/collaboration/teams/{teamId}/threads/{threadId}/delivery-state",
    "session_or_device_credential",
    "collaboration",
    "Advance the authenticated User's Team collaboration delivery state.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/collaboration/teams/{teamId}/threads/{threadId}/read-state",
    "session_or_device_credential",
    "collaboration",
    "Advance the authenticated User's Team collaboration read state.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/collaboration/realtime/snapshot",
    "session_or_device_credential",
    "collaboration",
    "Read an authorized Team collaboration realtime snapshot.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/collaboration/realtime/ack",
    "session_or_device_credential",
    "collaboration",
    "Acknowledge authorized Team collaboration realtime delivery.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/collaboration/realtime/stream",
    "session_or_device_credential",
    "collaboration",
    "Subscribe to authorized Team collaboration realtime updates.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),

  route(
    "GET",
    "/v1/teams",
    "session_or_device_credential",
    "team_memory",
    "List Teams visible to the authenticated User.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/navigation",
    "session_or_device_credential",
    "collaboration",
    "Read an authorized Team navigation snapshot.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/teams",
    "session_or_device_credential",
    "team_memory",
    "Create Team.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/membership",
    "session_or_device_credential",
    "team_memory",
    "Read Team membership.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/members",
    "session_or_device_credential",
    "team_memory",
    "List the Team roster.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/members/manage",
    "session_or_device_credential",
    "team_memory",
    "List Team member administration details.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PATCH",
    "/v1/teams/{teamId}/members/{userId}/role",
    "session_or_device_credential",
    "team_memory",
    "Update a Team member role.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/audit-events",
    "session_or_device_credential",
    "team_memory",
    "Read Team audit events.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/entitlement",
    "session_or_device_credential",
    "team_memory",
    "Read coarse Team entitlement and access-suspension gate state.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/teams/{teamId}/entitlement",
    "session_or_device_credential",
    "team_memory",
    "Update coarse Team entitlement and access-suspension gate state.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/billing-seats",
    "session_or_device_credential",
    "team_memory",
    "Read Team billing seat state.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/support/overview",
    "session_or_device_credential",
    "operations",
    "Read redacted Team support and operations overview.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/teams/{teamId}/billing-seats/policy",
    "session_or_device_credential",
    "team_memory",
    "Update Team billing seat policy.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/teams/{teamId}/invites",
    "session_or_device_credential",
    "team_memory",
    "Create Team invite.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/team-invites/accept",
    "session_or_device_credential",
    "team_memory",
    "Accept a Team invite for the authenticated User.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/team-context",
    "session_or_device_credential",
    "team_memory",
    "List the authenticated User's readable Team Workspace contexts.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/teams/{teamId}/members/{userId}/disable",
    "session_or_device_credential",
    "team_memory",
    "Disable Team member.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/teams/{teamId}/leave",
    "session",
    "team_memory",
    "Leave a Team using a fresh browser session.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/invites",
    "session_or_device_credential",
    "team_memory",
    "List Team invites.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "DELETE",
    "/v1/teams/{teamId}/invites/{inviteId}",
    "session_or_device_credential",
    "team_memory",
    "Revoke a Team invite.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/workspaces",
    "session_or_device_credential",
    "team_memory",
    "List Team Workspaces.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/teams/{teamId}/workspaces",
    "session_or_device_credential",
    "team_memory",
    "Create a Team Workspace.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/team-workspaces",
    "session_or_device_credential",
    "team_memory",
    "Create Team Workspace.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/team-workspaces/{teamWorkspaceId}/context",
    "session_or_device_credential",
    "team_memory",
    "Read Team Workspace context.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/team-workspaces/{teamWorkspaceId}/access",
    "session_or_device_credential",
    "team_memory",
    "Read Team Workspace access.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/team-workspaces/{teamWorkspaceId}/archive",
    "session_or_device_credential",
    "team_memory",
    "Archive a Team Workspace.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/team-workspaces/{teamWorkspaceId}/restore",
    "session_or_device_credential",
    "team_memory",
    "Restore a Team Workspace.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/team-workspaces/{teamWorkspaceId}/access",
    "session_or_device_credential",
    "team_memory",
    "Set Team Workspace access.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/shared-memory/source-owner-policies/{logicalMemoryId}",
    "session_or_device_credential",
    "shared_memory",
    "Set the source owner's Shared Memory policy.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/shared-memory/teams/{teamId}/policy",
    "session",
    "shared_memory",
    "Set Team Shared Memory policy.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/policy",
    "session",
    "shared_memory",
    "Set Team Workspace Shared Memory policy.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/shared-memory/previews",
    "session_or_device_credential",
    "shared_memory",
    "Create an authoritative Shared Memory source preview.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/consents",
    "session_or_device_credential",
    "shared_memory",
    "Create source-owner consent for Team Workspace sharing.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/shared-memory/share-grants",
    "session_or_device_credential",
    "shared_memory",
    "Create a Shared Memory Share Grant.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/shared-memory/share-grants/{shareGrantId}/representation",
    "session_or_device_credential",
    "shared_memory",
    "Select a Share Grant representation.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/shared-memory/share-grants/{shareGrantId}/representations/{representation}",
    "session_or_device_credential",
    "shared_memory",
    "Materialize a Share Grant representation.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/shared-memory/share-grants/{shareGrantId}/revoke",
    "session_or_device_credential",
    "shared_memory",
    "Revoke a Shared Memory Share Grant.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/shared-memory/logical-memories/{logicalMemoryId}/share-grants",
    "session_or_device_credential",
    "shared_memory",
    "List the source owner's current Share Grant states for a logical memory.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/share-grants",
    "session_or_device_credential",
    "shared_memory",
    "List authorized Team Workspace Share Grants.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/share-grants/{shareGrantId}",
    "session_or_device_credential",
    "shared_memory",
    "Read an authorized Team Workspace Share Grant.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/share-grants/{shareGrantId}/initial-view",
    "session_or_device_credential",
    "shared_memory",
    "Read an authorized Shared Memory source with its companion discussion.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/share-grants/{shareGrantId}/page",
    "session_or_device_credential",
    "shared_memory",
    "Read a bounded page of an authorized Shared Memory source.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/share-grants/{shareGrantId}/items",
    "session_or_device_credential",
    "shared_memory",
    "List authorized Shared Memory representation items.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/share-grants/{shareGrantId}/items/{sourceId}",
    "session_or_device_credential",
    "shared_memory",
    "Read an authorized Shared Memory representation item.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/high-risk/action-grants",
    "device_credential",
    "high_risk",
    "Create a device-bound one-time action grant request.",
    "request_time_action_grant",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/high-risk/action-grants/{clientRequestId}",
    "device_credential",
    "high_risk",
    "Read a device-bound action grant request.",
    "request_time_action_grant",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/high-risk/action-grants/{clientRequestId}/await",
    "device_credential",
    "high_risk",
    "Wait for a device-bound Action Grant decision using database notifications.",
    "request_time_action_grant",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "DELETE",
    "/v1/high-risk/action-grants/{clientRequestId}",
    "device_credential",
    "high_risk",
    "Cancel a device-bound action grant request.",
    "request_time_action_grant",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/high-risk/browser-activations/{selector}",
    "session",
    "high_risk",
    "Read a browser-authenticated high-risk activation.",
    "request_time_action_grant",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/high-risk/browser-activations/{selector}/decision",
    "session",
    "high_risk",
    "Approve or deny a high-risk activation using a fresh browser session.",
    "request_time_action_grant",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/retention/teams/{teamId}/deletion-request",
    "session_or_device_credential",
    "retention",
    "Request root Team deletion.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/retention/owner-private-replicas/{ownerPrivateReplicaId}/purge-request",
    "session_or_device_credential",
    "retention",
    "Request hard purge of an owner-private source replica.",
    "request_time_action_grant",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/retention/users/me/erasure-request",
    "session",
    "retention",
    "Request User erasure and identity tombstoning.",
    "request_time_action_grant",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/retention/legal-holds",
    "session_or_device_credential",
    "retention",
    "Place a legal hold.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/retention/legal-holds/{holdId}/release-request",
    "session_or_device_credential",
    "retention",
    "Request legal hold release.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/retention/legal-holds/{holdId}/release-confirmation",
    "session_or_device_credential",
    "retention",
    "Confirm legal hold release.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/cross-identity-sync/relationships",
    "session",
    "future_remote",
    "Create an explicit Captured Session Cross-Identity Sync relationship.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/cross-identity-sync/intake/relationships",
    "device_credential",
    "future_remote",
    "Create the target side of a device-authorized sync relationship.",
    "future_request_time",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/cross-identity-sync/relationships/{relationshipId}",
    "session_or_device_credential",
    "future_remote",
    "Read redacted Cross-Identity Sync state."
  ),
  route(
    "POST",
    "/v1/cross-identity-sync/relationships/{relationshipId}/revoke",
    "session_or_device_credential",
    "future_remote",
    "Revoke future Cross-Identity Sync transfer without deleting retained memory."
  ),
  route(
    "POST",
    "/v1/cross-identity-sync/intake/relationships/{relationshipId}/revoke",
    "device_credential",
    "future_remote",
    "Apply an authenticated remote sync revocation without creating a revocation loop.",
    "future_request_time",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/cross-identity-sync/relationships/{relationshipId}/upload-sessions",
    "device_credential",
    "future_remote",
    "Create an encrypted resumable sync upload session.",
    "future_request_time",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/cross-identity-sync/upload-sessions/{uploadSessionId}/chunks/{chunkIndex}",
    "device_credential",
    "future_remote",
    "Upload one recipient-encrypted sync chunk.",
    "future_request_time",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/cross-identity-sync/upload-sessions/{uploadSessionId}",
    "device_credential",
    "future_remote",
    "Resume an authorized encrypted sync upload.",
    "future_request_time",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/cross-identity-sync/upload-sessions/{uploadSessionId}/complete",
    "device_credential",
    "future_remote",
    "Verify and commit an encrypted sync upload.",
    "future_request_time",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/device-enrollments/challenges",
    "public",
    "future_remote",
    "Create safe browser-mediated local edge device enrollment challenge context.",
    "none",
    "implemented",
    remoteEnrollmentDeploymentModes
  ),
  route(
    "GET",
    "/v1/local-edge/device-enrollments/challenges/{challengeId}",
    "public",
    "future_remote",
    "Read safe local edge device enrollment challenge approval context.",
    "none",
    "implemented",
    remoteEnrollmentDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/device-enrollments/challenges/{challengeId}/approval",
    "session",
    "future_remote",
    "Approve or deny a local edge device enrollment challenge.",
    "none",
    "implemented",
    remoteEnrollmentDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/device-enrollments/credentials",
    "session",
    "future_remote",
    "Redeem a device enrollment challenge into a revocable device credential.",
    "none",
    "implemented",
    remoteEnrollmentDeploymentModes
  ),
  route(
    "GET",
    "/v1/local-edge/device-credentials",
    "session",
    "future_remote",
    "List enrolled local edge device credentials.",
    "none",
    "implemented",
    remoteEnrollmentDeploymentModes
  ),
  route(
    "DELETE",
    "/v1/local-edge/device-credentials/current",
    "device_credential",
    "future_remote",
    "Revoke the currently authenticated local edge device credential.",
    "future_request_time",
    "implemented",
    remoteEnrollmentDeploymentModes
  ),
  route(
    "DELETE",
    "/v1/local-edge/device-credentials/{credentialId}",
    "session",
    "future_remote",
    "Revoke an enrolled local edge device credential.",
    "none",
    "implemented",
    remoteEnrollmentDeploymentModes
  ),
  route(
    "GET",
    "/v1/local-edge/device-credentials/status",
    "device_credential",
    "future_remote",
    "Validate an enrolled local edge device credential without granting Team authority.",
    "future_request_time",
    "implemented",
    remoteEnrollmentDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations",
    "session_or_api_token",
    "personal_memory",
    "Start a Koed-managed Codex conversation for a verified local Project.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations",
    "session_or_api_token",
    "personal_memory",
    "List Koed-managed conversations.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}",
    "session_or_api_token",
    "personal_memory",
    "Read one Koed-managed conversation execution.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/prompts",
    "session_or_api_token",
    "personal_memory",
    "Queue an idempotent prompt for a Koed-managed conversation.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/handoffs",
    "session",
    "personal_memory",
    "Request signed exclusive execution handoff to another Personal Device.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/handoffs/active",
    "session",
    "personal_memory",
    "Read the active signed execution handoff.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/forks",
    "session",
    "personal_memory",
    "Request an explicit signed conversation fork on another Personal Device.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/forks/active",
    "session",
    "personal_memory",
    "Read the active explicit conversation fork.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/transfers/latest",
    "session",
    "personal_memory",
    "Read the latest handoff and fork lifecycle for a managed Conversation.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  ...managedConversationRunnerRoutes.map(([method, path, description]) =>
    route(
      method,
      path,
      "device_credential",
      "personal_memory",
      description,
      "none",
      "implemented",
      remoteEnrollmentDeploymentModes
    )
  ),
  route(
    "POST",
    "/v1/local-edge/route-decisions",
    "session",
    "future_remote",
    "Resolve explicit local-edge route policy before proxy, queue, or local handling.",
    "future_request_time",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/collaboration/command",
    "local_edge_client_credential",
    "collaboration",
    "Execute a locally authenticated Personal or Team collaboration command.",
    "future_request_time",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/collaboration/realtime/subscriptions",
    "local_edge_client_credential",
    "collaboration",
    "Create a locally authenticated collaboration realtime subscription.",
    "future_request_time",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/collaboration/realtime/subscriptions/{subscriptionId}/ack",
    "local_edge_client_credential",
    "collaboration",
    "Acknowledge a local-edge collaboration realtime delivery.",
    "future_request_time",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/local-edge/collaboration/realtime/subscriptions/{subscriptionId}/stream",
    "local_edge_client_credential",
    "collaboration",
    "Subscribe to local-edge collaboration realtime delivery.",
    "future_request_time",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "DELETE",
    "/v1/local-edge/collaboration/realtime/backends/{backendId}/subscriptions",
    "local_edge_client_credential",
    "collaboration",
    "Revoke all local collaboration realtime subscriptions for a disconnected upstream backend.",
    "future_request_time",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "DELETE",
    "/v1/local-edge/collaboration/realtime/subscriptions/{subscriptionId}",
    "local_edge_client_credential",
    "collaboration",
    "End a local-edge collaboration realtime subscription.",
    "future_request_time",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/team-memory/search",
    "local_edge_client_credential",
    "future_remote",
    "Search an enrolled Team Workspace through the typed local-edge Team Memory boundary.",
    "future_request_time",
    "not_implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/team-memory/answer",
    "local_edge_client_credential",
    "future_remote",
    "Retrieve Team Workspace evidence through the typed local-edge Team Memory boundary.",
    "future_request_time",
    "not_implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/team-memory/expand",
    "local_edge_client_credential",
    "future_remote",
    "Expand one Team Workspace Memory node through the typed local-edge Team Memory boundary.",
    "future_request_time",
    "not_implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/upstream-credential-operations",
    "upstream_credential",
    "future_remote",
    "Future local edge relay for a separate upstream credential class.",
    "future_request_time",
    "not_implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/personal-device-sync/relay/transports",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed PDS relay transport initialization; browser sessions, API Tokens, and legacy credentials are rejected."
  ),
  route(
    "PUT",
    "/v1/personal-device-sync/relay/transports/{transportId}/chunks/{chunkIndex}",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed exact bounded PDS relay chunk upload."
  ),
  route(
    "POST",
    "/v1/personal-device-sync/relay/transports/{transportId}/commit",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed PDS relay transport commit."
  ),
  route(
    "GET",
    "/v1/personal-device-sync/relay/mailbox",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed PDS relay mailbox metadata."
  ),
  route(
    "GET",
    "/v1/personal-device-sync/relay/wake",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed durable PDS relay wake request."
  ),
  route(
    "GET",
    "/v1/personal-device-sync/relay/transports/{transportId}",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed PDS relay transport metadata."
  ),
  route(
    "GET",
    "/v1/personal-device-sync/relay/transports/{transportId}/chunks/{chunkIndex}",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed exact bounded PDS relay chunk read."
  ),
  route(
    "POST",
    "/v1/personal-device-sync/relay/acks",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed PDS relay package acknowledgement."
  ),
  route(
    "GET",
    "/v1/personal-device-sync/relay/certificate",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed current-head membership certificate refresh; active prior-head certificate allowed only here."
  ),
  route(
    "GET",
    "/v1/personal-device-sync/relay/lifecycle",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed paginated Authority-proven lifecycle controls and opaque deletion floors."
  ),
  route(
    "POST",
    "/v1/personal-device-sync/relay/tombstone-acks",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed tombstone acknowledgement after durable lifecycle application."
  ),
  route(
    "GET",
    "/v1/personal-device-sync/relay/cursors",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed PDS relay cursor read."
  ),
  route(
    "PUT",
    "/v1/personal-device-sync/relay/cursors/{originDeviceId}",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed PDS relay cursor mutation."
  ),
  route(
    "POST",
    "/v1/personal-device-sync/local-runtime-wake",
    "local_edge_client_credential",
    "personal_memory",
    "Loopback-only wake after Desktop updates the protected Personal Device Sync runtime.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/personal-device-sync/challenges",
    "session",
    "personal_memory",
    "Create browser-bound Personal Device Group enrollment challenge."
  ),
  route(
    "POST",
    "/v1/personal-device-sync/groups/genesis",
    "session",
    "personal_memory",
    "Create Personal Device Group genesis."
  ),
  route(
    "POST",
    "/v1/personal-device-sync/groups/{groupId}/transitions",
    "session",
    "personal_memory",
    "Submit signed Personal Device Group membership transition."
  ),
  route(
    "POST",
    "/v1/personal-device-sync/groups/{groupId}/tombstones",
    "session",
    "personal_memory",
    "Submit authenticated Personal Device Group tombstone governance record."
  ),
  route(
    "POST",
    "/v1/personal-device-sync/groups/{groupId}/conflict-resolutions",
    "session",
    "personal_memory",
    "Submit authenticated Personal Device Group conflict-resolution governance record."
  ),
  route(
    "POST",
    "/v1/personal-device-sync/groups/{groupId}/epoch-acks",
    "session",
    "personal_memory",
    "Acknowledge pending Personal Device Group epoch."
  ),
  route(
    "GET",
    "/v1/personal-device-sync/groups/{groupId}",
    "session",
    "personal_memory",
    "Retrieve scoped Personal Device Group status."
  ),
  route(
    "GET",
    "/v1/personal-device-sync/groups/{groupId}/key-bundles/{epoch}",
    "session",
    "personal_memory",
    "Retrieve scoped pending or active Personal Device Group key bundle."
  ),
  route(
    "POST",
    "/v1/personal-device-sync/groups/{groupId}/certificates/refresh",
    "session",
    "personal_memory",
    "Reissue current-epoch Authority-signed certificates bound to current group head."
  ),
  route(
    "GET",
    "/v1/personal-device-sync/groups/{groupId}/certificates/{deviceId}",
    "session",
    "personal_memory",
    "Retrieve active scoped Personal Device Group membership certificate."
  ),
  route(
    "GET",
    "/v1/personal-device-sync/groups/{groupId}/status",
    "session",
    "personal_memory",
    "Retrieve scoped Personal Device Group activation status."
  ),
  route(
    "GET",
    "/v1/personal-device-sync/groups/{groupId}/log",
    "session",
    "personal_memory",
    "Retrieve scoped Personal Device Group statement log."
  ),
  route(
    "PUT",
    "/v1/personal-device-sync/groups/{groupId}/policy",
    "session",
    "personal_memory",
    "Update Personal Device Group sync policy."
  ),
  route(
    "POST",
    "/v1/personal-device-sync/groups/{groupId}/remote-account-links",
    "session",
    "personal_memory",
    "Link Remote Account with opaque verified proof."
  ),
  route(
    "POST",
    "/v1/internal/jobs",
    "internal_service_token",
    "future_remote",
    "Future hosted internal service-token boundary.",
    "future_request_time",
    "not_implemented",
    ["koed_managed_cloud"]
  )
] as const satisfies readonly RouteIdentityContract[];

export const implementedRouteIdentityContracts = routeIdentityContracts.filter(
  (contract) => contract.status === "implemented"
);

export const routeIdentityFor = (
  method: RouteIdentityContract["method"],
  path: string
): RouteIdentityContract | undefined =>
  routeIdentityContracts.find(
    (contract) => contract.method === method && contract.path === path
  );

export const publicRouteIdentities = new Set<RouteIdentity>([
  "public",
  "optional_session"
]);
