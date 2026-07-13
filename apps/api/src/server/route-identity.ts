import { deploymentProfiles, type DeploymentProfile } from "./capabilities.js";

export type RouteIdentity =
  | "public"
  | "optional_session"
  | "session"
  | "api_token"
  | "session_or_api_token"
  | "session_or_device_credential"
  | "conditional_team_session_or_device"
  | "api_token_or_device_credential"
  | "internal_service_token"
  | "device_credential"
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
    | "local_synthesis"
    | "future_remote";
  description: string;
  deploymentModes: readonly RouteDeploymentMode[];
  teamAuthority:
    | "none"
    | "request_time_team_workspace"
    | "request_time_team_admin"
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
    "List capture policies for Explorer or AI-client compatibility."
  ),
  route(
    "PUT",
    "/v1/capture-policies",
    "session_or_api_token",
    "capture",
    "Update capture policies for Explorer or AI-client compatibility."
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
    "/v1/memory/search",
    "conditional_team_session_or_device",
    "personal_memory",
    "Personal recall search uses API Token; Team Workspace recall requires session or scoped device credential.",
    "request_time_team_workspace"
  ),
  route(
    "POST",
    "/v1/memory/answer",
    "conditional_team_session_or_device",
    "personal_memory",
    "Personal recall evidence; Team Workspace recall requires session or scoped device credential.",
    "request_time_team_workspace"
  ),
  route(
    "GET",
    "/v1/memory/nodes/{nodeId}/expand",
    "conditional_team_session_or_device",
    "personal_memory",
    "Personal node expansion uses API Token; Team Workspace expansion requires session or scoped device credential.",
    "request_time_team_workspace"
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
    "conditional_team_session_or_device",
    "personal_memory",
    "Personal graph nodes; Team Workspace graph requires session or scoped device credential.",
    "request_time_team_workspace"
  ),
  route(
    "GET",
    "/v1/memory/graph/nodes/{nodeId}",
    "conditional_team_session_or_device",
    "personal_memory",
    "Personal graph node detail; Team Workspace graph requires session or scoped device credential.",
    "request_time_team_workspace"
  ),
  route(
    "GET",
    "/v1/memory/graph/events",
    "conditional_team_session_or_device",
    "personal_memory",
    "Personal graph events; Team Workspace graph requires session or scoped device credential.",
    "request_time_team_workspace"
  ),
  route(
    "GET",
    "/v1/memory/graph/threads",
    "conditional_team_session_or_device",
    "personal_memory",
    "Personal graph threads; Team Workspace graph requires session or scoped device credential.",
    "request_time_team_workspace"
  ),
  route(
    "GET",
    "/v1/memory/graph/events/{eventId}",
    "conditional_team_session_or_device",
    "personal_memory",
    "Personal graph event detail; Team Workspace graph requires session or scoped device credential.",
    "request_time_team_workspace"
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
    "Graph/event stream for Explorer and local integrations.",
    "request_time_team_workspace"
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
    "POST",
    "/v1/teams",
    "session",
    "team_memory",
    "Create Team.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/membership",
    "session",
    "team_memory",
    "Read Team membership.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/audit-events",
    "session",
    "team_memory",
    "Read Team audit events.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/entitlement",
    "session",
    "team_memory",
    "Read coarse Team entitlement and access-suspension gate state.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/teams/{teamId}/entitlement",
    "session",
    "team_memory",
    "Update coarse Team entitlement and access-suspension gate state.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/billing-seats",
    "session",
    "team_memory",
    "Read Team billing seat state.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/support/overview",
    "session",
    "operations",
    "Read redacted Team support and operations overview.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/teams/{teamId}/billing-seats/policy",
    "session",
    "team_memory",
    "Update Team billing seat policy.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/teams/{teamId}/members",
    "session",
    "team_memory",
    "Upsert Team membership.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/teams/{teamId}/invites",
    "session",
    "team_memory",
    "Create Team invite.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/team-invites/accept",
    "optional_session",
    "team_memory",
    "Accept Team invite and optionally create browser session.",
    "none",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/teams/{teamId}/members/{userId}/disable",
    "session",
    "team_memory",
    "Disable Team member.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/team-workspaces",
    "session",
    "team_memory",
    "Create Team Workspace.",
    "request_time_team_admin",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/team-workspaces/{teamWorkspaceId}/access",
    "session",
    "team_memory",
    "Read Team Workspace access.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/team-workspaces/{teamWorkspaceId}/access",
    "session",
    "team_memory",
    "Set Team Workspace access.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/team-workspaces/{teamWorkspaceId}/session-share-grants",
    "session",
    "team_memory",
    "List Captured Session Share Grants for a Team Workspace.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/team-workspaces/{teamWorkspaceId}/session-share-grants",
    "session",
    "team_memory",
    "Share an owned Captured Session into a Team Workspace.",
    "request_time_team_workspace",
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
    "DELETE",
    "/v1/team-workspaces/{teamWorkspaceId}/session-share-grants/{shareGrantId}",
    "session",
    "team_memory",
    "Revoke a Captured Session Share Grant from a Team Workspace.",
    "request_time_team_workspace",
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
    "/v1/local-edge/upstream-operations",
    "api_token_or_device_credential",
    "future_remote",
    "Relay an allowed upstream operation through local edge after route-policy, capability, and upstream credential checks.",
    "future_request_time",
    "implemented",
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
