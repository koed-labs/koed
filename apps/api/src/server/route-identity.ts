import { deploymentProfiles, type DeploymentProfile } from "./capabilities.js";

export type RouteIdentity =
  | "public"
  | "optional_session"
  | "session"
  | "api_token"
  | "session_or_api_token"
  | "session_or_api_token_or_device_credential"
  | "session_or_device_credential"
  | "api_token_or_device_credential"
  | "internal_service_token"
  | "device_credential"
  | "local_edge_client_credential"
  | "pds_relay_proof"
  | "upstream_credential"
  | "desktop_local_credential";

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
    | "projects"
    | "scheduled_jobs"
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
    "/v1/managed-conversation-runner/commands/claim-controls",
    "Claim interrupt and stop commands concurrently with an active provider turn."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/commands/claim-files",
    "Claim rooted checkpoint file operations assigned to this runner."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/runtime-items",
    "Publish encrypted provider interaction or transient runtime state."
  ],
  [
    "GET",
    "/v1/managed-conversation-runner/runtime-items/{itemId}",
    "Read an encrypted provider interaction assigned to this runner."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/runtime-items/{itemId}/resolve",
    "Resolve or cancel an assigned provider interaction."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/executions/{executionId}/runtime-items/cancel",
    "Cancel active provider interactions for an execution generation."
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
    "GET",
    "/v1/managed-conversation-runner/executions/{executionId}/checkpoints",
    "List exact execution checkpoints assigned to this runner."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/executions/{executionId}/checkpoints",
    "Record an exact execution checkpoint assigned to this runner."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/commands/{commandId}/lease",
    "Renew an assigned managed command lease."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/turn-citations",
    "Record citation aliases from a trusted completed memory tool call under the active command lease."
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
    "/v1/managed-conversation-runner/commands/{commandId}/checkpoint-pending",
    "Record checkpoint-only recovery for an accepted managed prompt."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/commands/{commandId}/file-complete",
    "Complete an assigned rooted checkpoint file operation."
  ],
  [
    "POST",
    "/v1/managed-conversation-runner/commands/{commandId}/file-fail",
    "Retry or fail an assigned rooted checkpoint file operation."
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
    "/v1/managed-conversation-runner/executions/{executionId}/runtime-binding-failed",
    "Fail a deferred start after its assigned Personal Device rejects the execution checkout."
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

const workspaceProjectRouteIdentityContracts: RouteIdentityContract[] = [
  route(
    "GET",
    "/v1/teams/{teamId}/workspaces/{workspaceId}/share-target",
    "session_or_device_credential",
    "projects",
    "Current enrolled Team member and Workspace authority are rechecked for the exact sharing target.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/teams/{teamId}/workspaces/{workspaceId}/share-attempt-cancellations",
    "session_or_device_credential",
    "projects",
    "Current enrolled Team member and Workspace write authority bind an immutable first-share cancellation receipt.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/workspace-projects",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/workspace-projects",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/teams/{teamId}/workspace-project-leave-review",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/members",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked before listing enabled members.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/link-proof",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/tombstone-proof",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/lifecycle",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/workspace-projects/{projectId}/dispatch-check",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/workspace-projects/{projectId}/join",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/workspace-projects/{projectId}/first-share-copy",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/work-items",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/activity/summary",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/activity/seen",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project activity read.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/activity",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this public Project activity page.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/workspace-projects/{projectId}/activity/seen",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked before advancing this member's cursor.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/work-items/{itemId}/dispatch-proof",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/work-items/{itemId}/dispatch-authority",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/work-items/{itemId}/dispatch-status",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/workspace-projects/{projectId}/work-items",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/work-items/text-action-effects/{actionId}",
    "session_or_device_credential",
    "projects",
    "Current Team write access and the exact originating member/action receipt are rechecked.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/work-items/by-idempotency/{key}",
    "session_or_device_credential",
    "projects",
    "Current Team write access and the exact originating Team member are rechecked before returning this Work Item receipt.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/work-items/{itemId}/proposal-proof",
    "session_or_device_credential",
    "projects",
    "Current Team write access and exact Project, member, and Work Item versions are checked for this proposal.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PATCH",
    "/v1/workspace-projects/{projectId}/work-items/{itemId}",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/workspace-projects/{projectId}/work-items/{itemId}/dispatch-receipt",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PATCH",
    "/v1/workspace-projects/{projectId}/work-items/{itemId}/dispatch-progress",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/sources",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/workspace-projects/{projectId}/share-grant-bindings",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  ...(
    [
      [
        "GET",
        "/v1/workspace-projects/{projectId}/share-policy/status",
        "Read this member's current Project share policy."
      ],
      [
        "GET",
        "/v1/workspace-projects/{projectId}/share-policy/issues/{sessionId}/status",
        "Read exact policy-version issue activation for owner-local move reconciliation."
      ],
      [
        "GET",
        "/v1/workspace-projects/{projectId}/share-policy/manifests/{manifestId}/review",
        "Read the exact stored owner manifest and key for Native review."
      ],
      [
        "POST",
        "/v1/workspace-projects/{projectId}/share-policy/manifests",
        "Stage a bounded owner Captured Session manifest for exact Native review."
      ],
      [
        "POST",
        "/v1/workspace-projects/{projectId}/share-policy/initial-bundles",
        "Stage one exact policy-authorized Bundled Pending Share using existing source preparation."
      ],
      [
        "POST",
        "/v1/workspace-projects/{projectId}/share-policy/future-bundles",
        "Verify a signed capture-time future policy proof and stage one Bundled Pending Share."
      ],
      [
        "POST",
        "/v1/workspace-projects/{projectId}/share-policy/exclusions",
        "Fence new policy issues for one owner Conversation before private withdrawal."
      ],
      [
        "POST",
        "/v1/workspace-projects/{projectId}/share-policy/execution-receipts/read",
        "Read only an exact owner and device bound consumed policy action receipt."
      ],
      [
        "POST",
        "/v1/workspace-projects/{projectId}/share-policy/enable",
        "Consume exact Native approval to enable a member Project share policy."
      ],
      [
        "POST",
        "/v1/workspace-projects/{projectId}/share-policy/revoke",
        "Consume exact Native approval to stop new member Project policy issues."
      ]
    ] as const
  ).map(([method, path, description]) =>
    route(
      method,
      path,
      "device_credential",
      "shared_memory",
      description,
      "request_time_shared_memory_owner",
      "implemented",
      teamDeploymentModes
    )
  ),
  route(
    "POST",
    "/v1/workspace-projects/{projectId}/sources",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PATCH",
    "/v1/workspace-projects/{projectId}/sources/{sourceId}",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/workspace-projects/{projectId}/sources/{sourceId}/delete",
    "device_credential",
    "projects",
    "Exact current Project action with single-use Step-up authority.",
    "request_time_action_grant",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/sources/{sourceId}/uploader-proof",
    "session_or_device_credential",
    "projects",
    "Current Team membership, Workspace access and Project association are rechecked for this shared Project operation.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/workspace-projects/{projectId}/leave",
    "device_credential",
    "projects",
    "Exact current Project action with single-use Step-up authority.",
    "request_time_action_grant",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/workspace-projects/{projectId}/members/{targetUserId}/remove",
    "device_credential",
    "projects",
    "Exact current Project action with single-use Step-up authority.",
    "request_time_action_grant",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/workspace-projects/{projectId}/delete",
    "device_credential",
    "projects",
    "Exact current Project action with single-use Step-up authority.",
    "request_time_action_grant",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects/{projectId}/workspace-project-share-snapshot",
    "session_or_device_credential",
    "projects",
    "Owner-scoped Personal Project metadata; API Tokens are not accepted.",
    "none",
    "implemented",
    allDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects/{projectId}/workspace-project-link",
    "session_or_device_credential",
    "projects",
    "Owner-scoped Personal Project metadata; API Tokens are not accepted.",
    "none",
    "implemented",
    allDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects/{projectId}/workspace-project-source-metadata/{sourceId}",
    "session_or_device_credential",
    "projects",
    "Owner-scoped Personal Project metadata; API Tokens are not accepted.",
    "none",
    "implemented",
    allDeploymentModes
  ),
  route(
    "GET",
    "/v1/local-edge/workspace-projects/{workspaceProjectId}/source-metadata/{sourceId}",
    "session_or_device_credential",
    "projects",
    "Owner-scoped Personal Project metadata; API Tokens are not accepted.",
    "none",
    "implemented",
    allDeploymentModes
  ),
  route(
    "GET",
    "/v1/local-edge/workspace-projects/{workspaceProjectId}/source-metadata",
    "session_or_device_credential",
    "projects",
    "Owner-scoped Personal Project metadata; API Tokens are not accepted.",
    "none",
    "implemented",
    allDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/projects/{projectId}/workspace-project-sources/upload",
    "desktop_local_credential",
    "projects",
    "Loopback owner Desktop credential plus independently enrolled Team client credential; current Team proof and Personal link are rechecked.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/:projectId/decks/:deckId/cards/:cardId/learning",
    "desktop_local_credential",
    "personal_memory",
    "Propose an owner-backed Deck learning from a current Personal Note after Again.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/projects/:projectId/decks/:deckId/cards/:cardId/learning",
    "desktop_local_credential",
    "personal_memory",
    "Propose owner-backed learning after a live Team Deck read and Personal progress check.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/local-edge/projects/{projectId}/workspace-project-sources/{teamSourceId}/content",
    "desktop_local_credential",
    "projects",
    "Loopback owner Desktop credential plus independently enrolled Team client credential; current Team proof and Personal link are rechecked.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/projects/{projectId}/workspace-project-prepare",
    "desktop_local_credential",
    "projects",
    "Loopback owner Desktop credential plus independently enrolled Team client credential; current Team proof and Personal link are rechecked.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/projects/{projectId}/project-share-policy/manifest",
    "desktop_local_credential",
    "shared_memory",
    "Loopback owner Desktop credential and enrolled Team client credential derive the exact local Captured Session manifest.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  ...(
    [
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/attempts/start",
        "Durably bind the exact approved Project policy action before dispatch."
      ],
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/local-state",
        "Read current owner-local policy version and per-link public key for Team match."
      ],
      [
        "GET",
        "/v1/local-edge/projects/{projectId}/project-share-policy/attempts/pending",
        "Read unresolved exact owner Project policy attempts."
      ],
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/attempts/finalize",
        "Apply local Project policy only from an exact consumed Team execution receipt."
      ],
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/consume",
        "Resolve an approved owner-bound Native Action Grant in local custody and consume it for the exact Team Project policy effect."
      ],
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/stage-initial",
        "Stage an exact owner-local sanitized Captured Session candidate through Team Pending Share."
      ],
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/reconcile-future",
        "Page owner-local future captures, sign exact proof, and stage eligible Bundled Pending Shares."
      ],
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/make-private",
        "Fence Team policy issuance before recording owner-local Conversation privacy."
      ],
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/session-status",
        "Read exact owner Conversation policy status in its linked Personal Project."
      ],
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/reconcile-issues",
        "Reconcile exact Team issue activation into owner-local grant freeze provenance."
      ],
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/fence-unpublished",
        "Fence a staged owner-local policy issue on Team before HQ107 moves the source."
      ],
      [
        "GET",
        "/v1/local-edge/projects/{projectId}/project-share-policy/fence-unpublished/current",
        "Read the exact current owner-local move fence for known-cancel recovery."
      ],
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/fence-unpublished/release",
        "Release an acknowledged move fence after a known no-effect cancellation."
      ],
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/explicit-offers",
        "Prepare a trusted exact Conversation offer for fresh Native review."
      ],
      [
        "GET",
        "/v1/local-edge/projects/{projectId}/project-share-policy/explicit-offers/{offerId}",
        "Revalidate an exact Conversation offer before Native review."
      ],
      [
        "GET",
        "/v1/local-edge/projects/{projectId}/project-share-policy/explicit-offers/{offerId}/status",
        "Read the exact Team Pending Share for one Conversation offer."
      ],
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/explicit-offers/{offerId}/settle",
        "Settle an exact Project-bound Pending Share from Team readback."
      ],
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/explicit-offers/{offerId}/fence",
        "Fence an unpublished exact Conversation offer before privacy or move."
      ],
      [
        "POST",
        "/v1/local-edge/projects/{projectId}/project-share-policy/execution-receipts/read",
        "Read an exact Project policy Action Grant receipt through owner-local custody."
      ]
    ] as const
  ).map(([method, path, description]) =>
    route(
      method,
      path,
      "desktop_local_credential",
      "shared_memory",
      description,
      "none",
      "implemented",
      localEdgeDeploymentModes
    )
  ),
  route(
    "GET",
    "/v1/local-edge/project-share-policy/active-projects",
    "desktop_local_credential",
    "shared_memory",
    "Page the owner local edge's active linked Project policies for main-process reconciliation.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/local-edge/projects/{projectId}/workspace-project-share-attempt",
    "desktop_local_credential",
    "projects",
    "Loopback owner Desktop credential plus independently enrolled Team client credential; exact pending target and current Team authority are rechecked.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/projects/{projectId}/workspace-project-share-cancel",
    "desktop_local_credential",
    "projects",
    "Loopback owner Desktop credential plus independently enrolled Team write credential; Personal fence clears only after the exact Team cancellation receipt.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/projects/{projectId}/workspace-project-confirm",
    "desktop_local_credential",
    "projects",
    "Loopback owner Desktop credential plus independently enrolled Team client credential; current Team proof and Personal link are rechecked.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/projects/{projectId}/workspace-project-reconcile",
    "desktop_local_credential",
    "projects",
    "Loopback owner Desktop credential plus independently enrolled Team client credential; current Team proof and Personal link are rechecked.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/workspace-projects/{projectId}/reconcile",
    "desktop_local_credential",
    "projects",
    "Loopback owner Desktop credential plus independently enrolled Team client credential; current Team proof and Personal link are rechecked.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/workspace-project-team-leave-stage",
    "desktop_local_credential",
    "projects",
    "Loopback owner Desktop credential plus independently enrolled Team client credential; current Team proof and Personal link are rechecked.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/workspace-project-team-leave-finish",
    "desktop_local_credential",
    "projects",
    "Loopback owner Desktop credential plus independently enrolled Team client credential; current Team proof and Personal link are rechecked.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{id}/shared-work-items/{itemId}/reconcile-pr",
    "desktop_local_credential",
    "projects",
    "Reconcile only provider-verified PR metadata using exact Personal and Team authority.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{id}/shared-work-items/{itemId}/dispatch",
    "desktop_local_credential",
    "projects",
    "Dispatch the exact Team Work Item through the current owner local runtime using dual credentials.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects/{projectId}/shared-work-items/dispatches",
    "desktop_local_credential",
    "projects",
    "List only this Personal owner private execution bindings for the current Team Project link.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/shared-dispatch-authority",
    "desktop_local_credential",
    "projects",
    "Revalidate current Team dispatch before a local runner claims or launches work.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/shared-progress",
    "desktop_local_credential",
    "projects",
    "Publish fixed safe progress for a current leased private command; independently enrolled Team credentials are required.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  )
];

export const routeIdentityContracts = [
  ...(["GET", "PUT"] as const).map((method) =>
    route(
      method,
      method === "GET"
        ? "/v1/local-edge/projects/{projectId}/decks/{deckId}/progress"
        : "/v1/local-edge/projects/{projectId}/decks/{deckId}/cards/{cardId}/progress",
      "desktop_local_credential",
      "projects",
      "Owner-local study progress after live Team Project and Deck authority checks.",
      "none",
      "implemented",
      localEdgeDeploymentModes
    )
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/deck-copy-map",
    "session_or_device_credential",
    "projects",
    "Owner-only first-share Deck identity map for private progress continuity.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/workspace-projects/{projectId}/copy-back-decks",
    "session_or_device_credential",
    "projects",
    "Owner-only bounded Deck snapshot for reviewed Team leave copy-back.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  ...(
    [
      ["GET", "/v1/projects/{projectId}/decks"],
      ["POST", "/v1/projects/{projectId}/decks"],
      ["GET", "/v1/projects/{projectId}/decks/{deckId}"],
      ["PATCH", "/v1/projects/{projectId}/decks/{deckId}"],
      ["DELETE", "/v1/projects/{projectId}/decks/{deckId}"],
      ["POST", "/v1/projects/{projectId}/decks/{deckId}/cards"],
      ["PATCH", "/v1/projects/{projectId}/decks/{deckId}/cards/{cardId}"],
      ["GET", "/v1/projects/{projectId}/deck-progress"],
      ["PUT", "/v1/projects/{projectId}/decks/{deckId}/cards/{cardId}/progress"]
    ] as const
  ).map(([method, path]) =>
    route(
      method,
      path,
      "session_or_device_credential",
      "projects",
      "Owner-scoped Personal Deck content or study progress.",
      "none",
      "implemented",
      localEdgeDeploymentModes
    )
  ),
  ...(
    [
      ["GET", "/v1/workspace-projects/{projectId}/decks"],
      ["POST", "/v1/workspace-projects/{projectId}/decks"],
      ["POST", "/v1/workspace-projects/{projectId}/decks/from-text-action"],
      ["GET", "/v1/workspace-projects/{projectId}/decks/{deckId}"],
      ["GET", "/v1/workspace-projects/{projectId}/decks/by-creation-key/{key}"],
      [
        "GET",
        "/v1/workspace-projects/{projectId}/decks/by-source-deck/{sourceDeckId}"
      ],
      ["PATCH", "/v1/workspace-projects/{projectId}/decks/{deckId}"],
      ["DELETE", "/v1/workspace-projects/{projectId}/decks/{deckId}"],
      ["POST", "/v1/workspace-projects/{projectId}/decks/{deckId}/cards"],
      [
        "PATCH",
        "/v1/workspace-projects/{projectId}/decks/{deckId}/cards/{cardId}"
      ]
    ] as const
  ).map(([method, path]) =>
    route(
      method,
      path,
      "session_or_device_credential",
      "projects",
      "Current Workspace Project membership and access authorize shared Deck content.",
      "request_time_team_workspace",
      "implemented",
      teamDeploymentModes
    )
  ),
  ...workspaceProjectRouteIdentityContracts,
  route(
    "POST",
    "/v1/projects/{id}/sources/upload",
    "session_or_device_credential",
    "projects",
    "Upload an original Project Source through the owner-bound Desktop flow.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects/{id}/sources/{sourceId}/content",
    "session_or_device_credential",
    "projects",
    "Read the current extracted Project Source Note revision as its owner.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects/{id}/sources",
    "session_or_device_credential",
    "projects",
    "List owner-scoped Project Source metadata.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{id}/sources",
    "session_or_device_credential",
    "projects",
    "Add an owner-scoped Project Source reference.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "DELETE",
    "/v1/projects/{id}/sources/{sourceId}",
    "session_or_device_credential",
    "projects",
    "Trash an unbacked Project Source reference.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{id}/sources/{sourceId}/retry",
    "session_or_device_credential",
    "projects",
    "Retry a failed Project Source when ingestion is available.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{id}/sources/{sourceId}/removal",
    "session_or_device_credential",
    "projects",
    "Advance a source-scoped durable Share Grant freeze before trash.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects/{id}/sources/{sourceId}/removal/reviews/{actionGrantId}",
    "session_or_device_credential",
    "projects",
    "Read an exact reserved Source removal review identity before Native device review.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  ...(
    [
      ["GET", "/v1/scheduled-jobs", "Read owned Scheduled Jobs."],
      [
        "POST",
        "/v1/scheduled-jobs",
        "Create a Job bound to the authenticated device."
      ],
      ["GET", "/v1/scheduled-jobs/{id}", "Read an owned Scheduled Job."],
      [
        "PATCH",
        "/v1/scheduled-jobs/{id}",
        "Edit an owned Scheduled Job by version."
      ],
      [
        "POST",
        "/v1/scheduled-jobs/{id}/pause",
        "Pause or unpause an owned Job."
      ],
      [
        "POST",
        "/v1/scheduled-jobs/{id}/reassign",
        "Assign an enrolled owner device by version."
      ],
      ["GET", "/v1/scheduled-jobs/{id}/runs", "Read stable run occurrences."],
      ["POST", "/v1/scheduled-jobs/{id}/run-now", "Queue a manual occurrence."],
      [
        "POST",
        "/v1/scheduled-jobs/{id}/runs/{runId}/retry",
        "Queue another attempt on the same occurrence."
      ],
      [
        "POST",
        "/v1/scheduled-jobs/{id}/runs/{runId}/skip",
        "Skip an occurrence."
      ],
      [
        "GET",
        "/v1/scheduled-jobs/{id}/runs/{runId}/attempts",
        "Read immutable attempt history."
      ]
    ] as const
  ).map(([method, path, description]) =>
    route(
      method,
      path,
      "session_or_device_credential",
      "scheduled_jobs",
      description,
      "none",
      "implemented",
      localEdgeDeploymentModes
    )
  ),
  route(
    "POST",
    "/v1/scheduled-jobs/runtime/tick",
    "desktop_local_credential",
    "scheduled_jobs",
    "Materialize and dispatch due Jobs on the verified assigned Local AI Runtime device.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/scheduled-jobs/runtime/commands/{commandId}/authority",
    "desktop_local_credential",
    "scheduled_jobs",
    "Check the current bound Scheduled Job command before runner use.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/scheduled-jobs/runtime/executions/{executionId}/authority",
    "desktop_local_credential",
    "scheduled_jobs",
    "Check current Scheduled Job authority before private execution use.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/scheduled-jobs/runtime/commands/{commandId}/lease",
    "desktop_local_credential",
    "scheduled_jobs",
    "Record an exact current Managed command lease on a Scheduled Job attempt.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects",
    "session_or_device_credential",
    "projects",
    "List owned Personal Projects; local Desktop read credentials are also accepted on loopback.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects",
    "session_or_device_credential",
    "projects",
    "Create an owned Personal Project.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "PATCH",
    "/v1/projects/{id}",
    "session_or_device_credential",
    "projects",
    "Rename or change the folder of an owned Personal Project.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "DELETE",
    "/v1/projects/{id}",
    "session_or_device_credential",
    "projects",
    "Begin owner-confirmed Personal Project deletion.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects/{id}/delete-preview",
    "session_or_device_credential",
    "projects",
    "Read the current exact active execution set before Project deletion.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{id}/delete-progress",
    "session_or_device_credential",
    "projects",
    "Advance a confirmed Personal Project deletion and stop its exact execution set.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{id}/delete-cancel",
    "session_or_device_credential",
    "projects",
    "Cancel a pending owner Project deletion and reconcile source holds.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects/{id}/delete-status",
    "session_or_device_credential",
    "projects",
    "Read the exact Project deletion phase and outstanding work.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{id}/restore",
    "session_or_device_credential",
    "projects",
    "Restore an exact Personal Project delete batch.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{id}/restore-reconcile",
    "session_or_device_credential",
    "projects",
    "Retry release of source admission holds after a local Project restore.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects/{id}/hq",
    "session_or_device_credential",
    "projects",
    "Read authoritative Personal Project HQ counts; local Desktop read credentials are also accepted on loopback.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{id}/hq/conversation",
    "session_or_device_credential",
    "projects",
    "Reserve the owner's private HQ Conversation on first explicit open.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects/{id}/hq/conversation",
    "session_or_device_credential",
    "projects",
    "Read an existing private HQ binding and captured runtime identity without creating it.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{id}/hq/catch-up",
    "desktop_local_credential",
    "projects",
    "Queue server-derived Personal activity and current linked Team public activity in the owner's existing HQ with exact local Desktop Managed authority and sealed Team read authority.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{id}/hq/catch-up/retry",
    "desktop_local_credential",
    "projects",
    "Explicitly retry a proven pre-send HQ catch-up on the same Conversation with a fresh generation, stable request ID and current linked Team read authority.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{id}/hq/conversation:start",
    "session_or_device_credential",
    "projects",
    "Start the reserved HQ through the Chief's validated Managed Conversation selection.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects/{id}/work-items",
    "session_or_device_credential",
    "projects",
    "List Work Items in an owned active Personal Project."
  ),
  route(
    "POST",
    "/v1/projects/{id}/work-items/{itemId}/dispatch",
    "session_or_device_credential",
    "projects",
    "Dispatch an owned Work Item to a managed Project execution.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/merge-proposals/{itemId}/decline",
    "session_or_device_credential",
    "projects",
    "Record a Native decline for an exact owned merge proposal; grants no provider mutation authority.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/work-items-from-doc/list",
    "desktop_local_credential",
    "projects",
    "Discover bounded metadata for current owner Project documents under a leased managed AI Client command.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/work-items-from-doc/read",
    "desktop_local_credential",
    "projects",
    "Read bounded lines from one current owner Project Source Note for a leased managed AI Client.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/work-items-from-doc/preview",
    "session_or_device_credential",
    "projects",
    "Read-only exact-line duplicate preview for an active owner-bound document command.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/work-items-from-doc/apply",
    "desktop_local_credential",
    "projects",
    "Create idempotent Work Items from exact current Source lines under a trusted managed command lease.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{projectId}/work-items/{itemId}/reconcile-pr",
    "session_or_device_credential",
    "projects",
    "Reconcile an owned Work Item from runner-verified PR state; requires collaboration write and source-control authority.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/agents/bootstrap-context",
    "session_or_device_credential",
    "projects",
    "Read the authenticated User's conversations setting and enabled AI Client instances for Chief bootstrap.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/agents",
    "session_or_device_credential",
    "projects",
    "List owner-owned Agents.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/agents/chief:ensure",
    "session_or_device_credential",
    "projects",
    "Create the owner's default Chief of Staff from a configured AI Client instance.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/agents/helpers:ensure",
    "session_or_device_credential",
    "projects",
    "Ensure Nova, Quinn and Sage from the owner's valid Chief AI Client binding.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/agents",
    "session_or_device_credential",
    "projects",
    "Create an owner-owned Agent.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "PATCH",
    "/v1/agents/{id}",
    "session_or_device_credential",
    "projects",
    "Update an owner-owned Agent.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects/{id}/activity",
    "session_or_device_credential",
    "projects",
    "Page deterministic Personal Project activity after an owner-bound cursor.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/projects/{id}/activity/seen",
    "session_or_device_credential",
    "projects",
    "Read the owner's Personal Project last-seen cursor.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "PUT",
    "/v1/projects/{id}/activity/seen",
    "session_or_device_credential",
    "projects",
    "Advance the owner's Personal Project last-seen cursor to a committed activity row.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{id}/work-items",
    "session_or_device_credential",
    "projects",
    "Create an owned Personal Project Work Item."
  ),
  route(
    "PATCH",
    "/v1/work-items/{id}",
    "session_or_device_credential",
    "projects",
    "Edit or manually transition an owned Work Item."
  ),
  route(
    "DELETE",
    "/v1/work-items/{id}",
    "session_or_device_credential",
    "projects",
    "Delete an owned Personal Project to-do."
  ),
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
    "/v2/capabilities",
    "public",
    "operations",
    "Explicit Team message contract v2 capability discovery."
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
    "GET",
    "/v1/managed-conversations/launch-options",
    "session_or_api_token",
    "personal_memory",
    "Read current local runner, AI Client, model, and permission choices for a new managed Conversation.",
    "none",
    "implemented",
    localEdgeDeploymentModes
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
    "/v1/managed-conversations/access",
    "api_token",
    "capture",
    "Authorize local Conversation draft and recovery access."
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
    "/v1/historical-import-admission",
    "session_or_api_token",
    "capture",
    "Read the content-free local admission decision for one raw historical batch.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/embedding-state",
    "session_or_api_token",
    "operations",
    "Read content-free local Embedding Service and Projection backlog Diagnostic Status.",
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
    "Move a personal Captured Session or reset placement; scoped local Desktop write credentials are also accepted on loopback."
  ),
  route(
    "GET",
    "/v1/memory/graph/sessions/{sessionId}/move-reviews/{actionGrantId}",
    "session_or_api_token",
    "personal_memory",
    "Read an exact owner-only Native Project-policy grant freeze review reservation; scoped local Desktop read credentials are also accepted on loopback."
  ),
  route(
    "POST",
    "/v1/memory/graph/sessions/{sessionId}/move-progress",
    "session_or_api_token",
    "personal_memory",
    "Advance or inspect an exact owner-only Conversation move batch; scoped local Desktop write credentials are also accepted on loopback."
  ),
  route(
    "GET",
    "/v1/memory/graph/sessions/{sessionId}/text-action-move/{actionId}",
    "desktop_local_credential",
    "personal_memory",
    "Read only the existing owner-bound text-action move batch for uncertain response recovery; never prepares or advances a move.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "PATCH",
    "/v1/memory/graph/sessions/{sessionId}/presentation",
    "session_or_api_token",
    "personal_memory",
    "Update owner-only Conversation navigation presentation state."
  ),
  route(
    "GET",
    "/v1/memory/graph/sessions/deleted",
    "session_or_api_token",
    "personal_memory",
    "List owner-only Conversations available for restoration."
  ),
  route(
    "GET",
    "/v1/memory/graph/sessions/delete-pending",
    "session_or_api_token",
    "personal_memory",
    "List durable owner-only Conversation deletion batches awaiting completion."
  ),
  route(
    "DELETE",
    "/v1/memory/graph/sessions/{sessionId}",
    "session_or_api_token",
    "personal_memory",
    "Move an owner-only Conversation to Deleted while retaining its Personal Memory."
  ),
  route(
    "POST",
    "/v1/memory/graph/sessions/{sessionId}/delete-progress",
    "session_or_api_token",
    "personal_memory",
    "Advance or inspect the exact owner-only Conversation deletion batch."
  ),
  route(
    "GET",
    "/v1/memory/graph/sessions/{sessionId}/delete-reviews/{actionGrantId}",
    "session_or_api_token",
    "personal_memory",
    "Read an exact owner-only Native Share Grant freeze review reservation."
  ),
  route(
    "POST",
    "/v1/memory/graph/sessions/{sessionId}/restore",
    "session_or_api_token",
    "personal_memory",
    "Restore an owner-only deleted Conversation within 30 days."
  ),
  route(
    "POST",
    "/v1/memory/graph/sessions/{sessionId}/forget",
    "session_or_api_token",
    "personal_memory",
    "Forget an owned Conversation from Personal recall with a seven-day Undo window."
  ),
  route(
    "POST",
    "/v1/memory/graph/sessions/{sessionId}/forget-progress",
    "session_or_api_token",
    "personal_memory",
    "Advance an exact owner-only pending Conversation Forget batch after stopping work."
  ),
  route(
    "GET",
    "/v1/memory/graph/sessions/forget-pending",
    "session_or_api_token",
    "personal_memory",
    "List owner-only pending Conversation Forget batches."
  ),
  route(
    "POST",
    "/v1/memory/graph/sessions/{sessionId}/forget-undo",
    "session_or_api_token",
    "personal_memory",
    "Undo an exact owner-only Conversation Forget operation within seven days."
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
    "POST",
    "/v1/memory/curated/onboarding-preference",
    "desktop_local_credential",
    "personal_memory",
    "Propose an explicitly consented Personal Note preference for AI Client review.",
    "none",
    "implemented",
    localEdgeDeploymentModes
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
    "session_or_api_token",
    "personal_memory",
    "List the owner's Curated Memory assertions with classification filters."
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
    "session_or_api_token",
    "personal_memory",
    "Read an owned Curated Memory assertion and its replacement chain."
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/memory-actions",
    "session",
    "personal_memory",
    "Read owner-only durable memory action results; local Desktop read credentials are also accepted."
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/text-actions",
    "desktop_local_credential",
    "personal_memory",
    "Record a leased AI Client text-action proposal for its current owner.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/text-actions",
    "desktop_local_credential",
    "personal_memory",
    "List only the owner's durable text-action review records.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/text-actions/{actionId}",
    "desktop_local_credential",
    "personal_memory",
    "Reconcile one exact owner text-action record without replaying its effect.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/text-actions/{actionId}/review",
    "desktop_local_credential",
    "personal_memory",
    "Record one owner decision on an exact Ask first text action.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/text-actions/{actionId}/claim",
    "desktop_local_credential",
    "personal_memory",
    "Claim one current approved text action before its owned effect.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/text-actions/{actionId}/complete",
    "desktop_local_credential",
    "personal_memory",
    "Record a verified exact owned effect after the claimed text action.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/text-actions/{actionId}/apply-team-todo-add",
    "desktop_local_credential",
    "personal_memory",
    "Apply a claimed owner action through the bound Team principal and exact shared Project versions.",
    "request_time_team_workspace",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/text-actions/{actionId}/apply-deck-make",
    "desktop_local_credential",
    "personal_memory",
    "Create one exact reviewed Deck with its journal ID as the creation key.",
    "request_time_team_workspace",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/text-actions/{actionId}/deck-result",
    "desktop_local_credential",
    "personal_memory",
    "Resolve an exact generated Deck after current Project authority and verified action receipt.",
    "request_time_team_workspace",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/memory-actions/{actionId}/undo",
    "session",
    "personal_memory",
    "Undo one exact owner memory action through the existing session or local Desktop Curated boundary."
  ),
  route(
    "POST",
    "/v1/memory/curated/assertions/{assertionId}/unsuppress",
    "session",
    "personal_memory",
    "Undo the owner's recent Curated Memory suppression."
  ),
  route(
    "PATCH",
    "/v1/memory/curated/assertions/{assertionId}",
    "session",
    "personal_memory",
    "Classify an unscoped assertion after acknowledged Team withdrawal."
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
    "GET",
    "/v1/memory/ai-client-instances",
    "session_or_api_token",
    "local_synthesis",
    "Read local AI Client instances and capability snapshots."
  ),
  route(
    "PUT",
    "/v1/memory/ai-client-instances/{instanceId}",
    "session_or_api_token",
    "local_synthesis",
    "Register or update a local AI Client instance."
  ),
  route(
    "POST",
    "/v1/memory/ai-client-instances/{instanceId}/capability-snapshots",
    "session_or_api_token",
    "local_synthesis",
    "Record a local AI Client capability snapshot."
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
    "DELETE",
    "/v1/memory/local-agent-settings/{flowKey}",
    "session_or_api_token",
    "local_synthesis",
    "Reset one local AI-client synthesis setting."
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
    "POST",
    "/v1/memory/lcm/summary-claims",
    "api_token",
    "local_synthesis",
    "Claim fenced local LCM Summary work."
  ),
  route(
    "PUT",
    "/v1/memory/lcm/summary-claims/{claimId}/renew",
    "api_token",
    "local_synthesis",
    "Renew a fenced local LCM Summary work claim."
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
    "/v1/collaboration/personal/notes",
    "session_or_api_token_or_device_credential",
    "collaboration",
    "List owner-authorized Personal Notes."
  ),
  route(
    "POST",
    "/v1/collaboration/personal/notes",
    "session_or_api_token_or_device_credential",
    "collaboration",
    "Create one owner-authorized Personal Note."
  ),
  route(
    "GET",
    "/v1/collaboration/personal/notes/{noteId}",
    "session_or_api_token_or_device_credential",
    "collaboration",
    "Read one owner-authorized Personal Note and its bound Memory Event."
  ),
  route(
    "PATCH",
    "/v1/collaboration/personal/notes/{noteId}/title",
    "session_or_api_token_or_device_credential",
    "collaboration",
    "Rename one owner-authorized Personal Note."
  ),
  route(
    "PATCH",
    "/v1/collaboration/personal/notes/{noteId}/body",
    "session_or_api_token_or_device_credential",
    "collaboration",
    "Create a new revision of one owner-authorized Personal Note."
  ),
  route(
    "GET",
    "/v1/memory/ask/threads",
    "api_token",
    "local_synthesis",
    "List Personal Ask threads."
  ),
  route(
    "GET",
    "/v1/memory/ask/threads/{askThreadId}",
    "api_token",
    "local_synthesis",
    "Read one Personal Ask thread."
  ),
  route(
    "POST",
    "/v1/memory/ask/questions",
    "api_token",
    "local_synthesis",
    "Create a pending Personal Ask question."
  ),
  route(
    "PATCH",
    "/v1/memory/ask/questions/{questionId}",
    "api_token",
    "local_synthesis",
    "Complete a pending Personal Ask question."
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
    "GET",
    "/v2/collaboration/teams/{teamId}/threads/{threadId}/messages",
    "session_or_device_credential",
    "collaboration",
    "List authorized Team collaboration messages using the Team v2 message contract.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v2/collaboration/teams/{teamId}/projects/{workspaceProjectId}/thread",
    "session_or_device_credential",
    "collaboration",
    "Read the exact Project Thread under current Project membership.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v2/collaboration/teams/{teamId}/projects/{workspaceProjectId}/thread/open",
    "session_or_device_credential",
    "collaboration",
    "Open the exact Project Thread under current Project membership.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v2/collaboration/teams/{teamId}/threads/{threadId}/messages",
    "session_or_device_credential",
    "collaboration",
    "Post an authorized Team collaboration message using the Team v2 message contract.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v2/collaboration/teams/{teamId}/projects/{workspaceProjectId}/threads/{threadId}/read",
    "session_or_device_credential",
    "collaboration",
    "Advance a Project Thread receipt without exposing Team messages to agents.",
    "request_time_team_workspace",
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
    "POST",
    "/v2/collaboration/realtime/snapshot",
    "session_or_device_credential",
    "collaboration",
    "Read an authorized Team collaboration realtime v2 snapshot.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v2/collaboration/realtime/ack",
    "session_or_device_credential",
    "collaboration",
    "Acknowledge authorized Team collaboration realtime v2 delivery.",
    "request_time_team_membership",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v2/collaboration/realtime/stream",
    "session_or_device_credential",
    "collaboration",
    "Subscribe to authorized Team collaboration realtime v2 updates.",
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
    "/v1/shared-memory/candidate-previews",
    "device_credential",
    "shared_memory",
    "Create a reviewed Shared Memory candidate preview.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/shared-memory/pending-shares",
    "session_or_device_credential",
    "shared_memory",
    "Accept a reviewed source into the durable Pending Share workflow.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/shared-memory/pending-shares/{pendingShareId}/personal-note-source",
    "device_credential",
    "shared_memory",
    "Upload the exact owner-private source for a pending Personal Note share.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/shared-memory/personal-note-revisions/advance",
    "device_credential",
    "shared_memory",
    "Advance active Continuous Personal Note shares to an exact new revision.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/shared-memory/share-grants/{shareGrantId}/fidelity-bundle",
    "session_or_device_credential",
    "shared_memory",
    "Queue a reviewed fidelity replacement through the durable Pending Share workflow.",
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
    "POST",
    "/v1/shared-memory/share-grants/{shareGrantId}/freeze",
    "device_credential",
    "shared_memory",
    "Freeze one exact owner Share Grant after independent Native review.",
    "request_time_action_grant",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/shared-memory/sources/{logicalMemoryId}/admission",
    "session_or_device_credential",
    "shared_memory",
    "Read owner-bound source admission generation and opaque hold status.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/shared-memory/sources/{logicalMemoryId}/admission",
    "device_credential",
    "shared_memory",
    "Prepare, seal, or cancel an exact owner source admission hold.",
    "request_time_action_grant",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/shared-memory/curated-withdrawals",
    "device_credential",
    "shared_memory",
    "Withdraw exact owner Curated copies before a Personal classification mutation.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/shared-memory/sources/{logicalMemoryId}/admission/grants",
    "session_or_device_credential",
    "shared_memory",
    "List exact active unfrozen owner Share Grants for source deletion.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "PUT",
    "/v1/shared-memory/share-grants/{shareGrantId}/transcript-access",
    "session_or_device_credential",
    "shared_memory",
    "Grant independent read-only access to a captured Conversation Source.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/shared-memory/share-grants/{shareGrantId}/transcript-access/revoke",
    "session_or_device_credential",
    "shared_memory",
    "Revoke independent Conversation Source access.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/shared-memory/owned-shares",
    "session_or_device_credential",
    "shared_memory",
    "List the source owner's active and pending shares.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/shared-memory/owned-shares/{kind}/{id}",
    "session_or_device_credential",
    "shared_memory",
    "Read one source-owned active or pending share.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/shared-memory/pending-shares/{pendingShareId}/control",
    "session_or_device_credential",
    "shared_memory",
    "Retry, pause, resume, or revoke a durable Pending Share.",
    "request_time_shared_memory_owner",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/shared-memory/share-grants/{shareGrantId}/transcript/manifest",
    "session_or_device_credential",
    "shared_memory",
    "Read an authorized Conversation Source manifest.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/shared-memory/share-grants/{shareGrantId}/transcript/segments/{segmentId}",
    "session_or_device_credential",
    "shared_memory",
    "Read one authorized Conversation Source segment.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "GET",
    "/v1/shared-memory/share-grants/{shareGrantId}/transcript/stream",
    "session_or_device_credential",
    "shared_memory",
    "Stream durable Conversation Source segment availability.",
    "request_time_team_workspace",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/shared-memory/share-grants/{shareGrantId}/transcript/fork-snapshot",
    "session",
    "shared_memory",
    "Export a completed-turn Conversation Source snapshot for local forking.",
    "request_time_team_workspace",
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
    "POST",
    "/v1/personal-semantic-artifacts/resolve",
    "device_credential",
    "personal_memory",
    "Return a recipient-encrypted compatible Personal embedding artifact to its enrolled source replica.",
    "none",
    "implemented",
    teamDeploymentModes
  ),
  route(
    "POST",
    "/v1/personal-semantic-artifacts/import",
    "api_token",
    "personal_memory",
    "Resolve and import the hosted Personal embedding artifact selected by explicit source-replication policy.",
    "none",
    "implemented",
    localEdgeDeploymentModes
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
    "GET",
    "/v1/managed-conversations/agent-delegations",
    "session_or_device_credential",
    "personal_memory",
    "List owner-only private child Agent Conversation bindings for one Project.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/delegate",
    "session_or_device_credential",
    "personal_memory",
    "Start an idempotent child Managed Conversation bound to an owned Helper Agent.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/projects/{projectId}/hq/delegate",
    "session_or_device_credential",
    "personal_memory",
    "Start a Helper child from an existing unstarted owner-qualified Project HQ handle.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/turn-citations",
    "session_or_api_token",
    "personal_memory",
    "List encrypted durable citation aliases for one managed provider turn.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/turn-citations/{alias}",
    "session_or_api_token",
    "personal_memory",
    "Resolve a citation locator for a fresh authorized source detail read.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/usage",
    "session_or_api_token",
    "personal_memory",
    "Read the latest provider-attributed context usage for one managed Conversation.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/diff",
    "session_or_api_token",
    "personal_memory",
    "Read a revision-bound encrypted turn or full-Conversation checkout diff.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "DELETE",
    "/v1/managed-conversations/{executionId}/execution-checkout",
    "session_or_device_credential",
    "personal_memory",
    "Request cleanup of the exact terminal Koed-managed execution checkout.",
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
    "/v1/managed-conversations/{executionId}/files",
    "session_or_device_credential",
    "personal_memory",
    "Queue an encrypted rooted checkpoint file operation for the assigned runner."
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/source-control",
    "session_or_device_credential",
    "personal_memory",
    "Run a provider-neutral, revision-bound source-control operation in the exact managed execution checkout.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v2/managed-conversations/{executionId}/source-control",
    "desktop_local_credential",
    "personal_memory",
    "Prepare, natively review, dispatch, or reconcile an exact pull-request merge.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/files/{commandId}",
    "session_or_device_credential",
    "personal_memory",
    "Read one encrypted rooted checkpoint file operation result."
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/terminals/profiles",
    "session_or_device_credential",
    "personal_memory",
    "List bounded shell profiles available on the assigned runner."
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/terminals",
    "session_or_device_credential",
    "personal_memory",
    "Create an idempotent terminal in the exact execution checkout."
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/terminals",
    "session_or_device_credential",
    "personal_memory",
    "List terminal lifecycle metadata without terminal content."
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/terminals/{terminalId}",
    "session_or_device_credential",
    "personal_memory",
    "Read one terminal lifecycle record without terminal content."
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/terminals/{terminalId}/stop",
    "session_or_device_credential",
    "personal_memory",
    "Stop an owned terminal using its runner-fenced lifecycle."
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/terminals/{terminalId}/attach",
    "session_or_device_credential",
    "personal_memory",
    "Attach a bounded bidirectional WebSocket terminal stream."
  ),
  route(
    "GET",
    "/v1/managed-conversations/{executionId}/runtime",
    "session_or_api_token",
    "personal_memory",
    "Read active provider interactions and transient output for a managed Conversation.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/runtime-items/{itemId}/respond",
    "session_or_api_token",
    "personal_memory",
    "Answer one generation-fenced provider approval or user-input request.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/interrupt",
    "session_or_api_token",
    "personal_memory",
    "Interrupt the active provider turn without stopping its managed Conversation.",
    "none",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/managed-conversations/{executionId}/stop",
    "session_or_api_token",
    "personal_memory",
    "Stop a managed Conversation runtime.",
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
    "/v2/local-edge/collaboration/realtime/subscriptions",
    "local_edge_client_credential",
    "collaboration",
    "Create a locally authenticated Team collaboration realtime v2 subscription.",
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
    "POST",
    "/v2/local-edge/collaboration/realtime/subscriptions/{subscriptionId}/ack",
    "local_edge_client_credential",
    "collaboration",
    "Acknowledge a local-edge Team collaboration realtime v2 delivery.",
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
    "GET",
    "/v2/local-edge/collaboration/realtime/subscriptions/{subscriptionId}/stream",
    "local_edge_client_credential",
    "collaboration",
    "Subscribe to local-edge Team collaboration realtime v2 delivery.",
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
    "DELETE",
    "/v2/local-edge/collaboration/realtime/subscriptions/{subscriptionId}",
    "local_edge_client_credential",
    "collaboration",
    "End a local-edge Team collaboration realtime v2 subscription.",
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
    "GET",
    "/v1/memory/questions/{questionId}/managed-citations/{ordinal}",
    "session_or_api_token",
    "local_synthesis",
    "Read one currently available Personal question citation.",
    "none",
    "implemented",
    allDeploymentModes
  ),
  route(
    "GET",
    "/v1/memory/questions/{questionId}/citations/{ordinal}",
    "session_or_device_credential",
    "local_synthesis",
    "Read one currently authorized Team question citation.",
    "request_time_team_workspace",
    "implemented",
    allDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/team-memory/citations/detail",
    "local_edge_client_credential",
    "future_remote",
    "Read one currently authorized Team citation through a fixed upstream path.",
    "future_request_time",
    "implemented",
    localEdgeDeploymentModes
  ),
  route(
    "POST",
    "/v1/local-edge/team-memory/questions/final",
    "local_edge_client_credential",
    "future_remote",
    "Persist a Team Memory Question on its authoritative upstream backend.",
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
    "/v1/personal-device-sync/relay/peer-routes",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed short-lived peer receive-route advertisement."
  ),
  route(
    "GET",
    "/v1/personal-device-sync/relay/peer-routes",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed same-group peer receive-route discovery."
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
    "/v1/personal-device-sync/relay/transports/{transportId}/peer-receipts/{recipientDeviceId}",
    "pds_relay_proof",
    "personal_memory",
    "Device-signed exact recipient materialization receipt read for peer delivery."
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
