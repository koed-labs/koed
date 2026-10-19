import { ActionApprovalPolicyError } from "./approval-policy.js";

// Admission for actions whose authoritative Team-side Project/policy records
// are supplied by later tickets. No current route may infer these from a
// renderer payload or treat an unavailable resolver as an empty Project.
export type ProjectLifecycleAction =
  | "workspace_project.delete"
  | "workspace_project.member_remove"
  | "workspace_project.leave"
  | "project_source.team_metadata.delete";
export type ProjectSharePolicyAction =
  | "shared_memory.project_share_policy.enable"
  | "shared_memory.project_share_policy.revoke";

export interface AuthoritativeProjectState {
  projectId: string;
  teamId: string;
  version: number;
  lifecycle: "active" | "deleted";
  ownerUserId: string;
  actorUserId: string;
  actorMembership: "owner" | "member" | "absent";
  targetUserId?: string;
  targetMembership?: "owner" | "member" | "absent";
  sourceId?: string;
  sourceOwnerUserId?: string;
  sourceVersion?: number;
  sourceTeamId?: string;
  sourceProjectId?: string;
}

export interface ProjectLifecycleIntent {
  action: ProjectLifecycleAction;
  actorUserId: string;
  teamId: string;
  projectId: string;
  expectedProjectVersion: number;
  targetUserId?: string;
  sourceId?: string;
  expectedSourceVersion?: number;
}

const denied = (reason: string): never => {
  throw new ActionApprovalPolicyError(reason);
};

export const admitProjectLifecycleAction = (
  intent: ProjectLifecycleIntent,
  state: AuthoritativeProjectState | null
): "step_up" => {
  if (
    !state ||
    state.lifecycle !== "active" ||
    state.projectId !== intent.projectId ||
    state.teamId !== intent.teamId ||
    state.actorUserId !== intent.actorUserId ||
    state.version !== intent.expectedProjectVersion ||
    !Number.isSafeInteger(state.version) ||
    state.version < 1
  ) {
    return denied(
      "Current Workspace Project authority is unavailable or stale"
    );
  }
  switch (intent.action) {
    case "workspace_project.leave":
      if (
        state.actorMembership !== "member" ||
        state.ownerUserId === intent.actorUserId ||
        intent.targetUserId !== undefined ||
        intent.sourceId !== undefined
      ) {
        return denied(
          "Workspace Project leave is self-only for a non-owner member"
        );
      }
      return "step_up";
    case "workspace_project.member_remove":
      if (
        state.actorMembership !== "owner" ||
        state.ownerUserId !== intent.actorUserId ||
        !intent.targetUserId ||
        intent.targetUserId === intent.actorUserId ||
        intent.targetUserId === state.ownerUserId ||
        state.targetUserId !== intent.targetUserId ||
        state.targetMembership !== "member" ||
        intent.sourceId !== undefined
      ) {
        return denied(
          "Workspace Project removal requires another named non-owner member"
        );
      }
      return "step_up";
    case "workspace_project.delete":
      if (
        state.actorMembership !== "owner" ||
        state.ownerUserId !== intent.actorUserId ||
        intent.targetUserId !== undefined ||
        intent.sourceId !== undefined
      ) {
        return denied(
          "Workspace Project deletion requires the current Project owner"
        );
      }
      return "step_up";
    case "project_source.team_metadata.delete":
      if (
        (state.actorMembership !== "owner" &&
          state.actorMembership !== "member") ||
        (state.ownerUserId !== intent.actorUserId &&
          state.sourceOwnerUserId !== intent.actorUserId) ||
        !intent.sourceId ||
        state.sourceId !== intent.sourceId ||
        state.sourceTeamId !== intent.teamId ||
        state.sourceProjectId !== intent.projectId ||
        state.sourceVersion !== intent.expectedSourceVersion ||
        !Number.isSafeInteger(state.sourceVersion) ||
        (state.sourceVersion ?? 0) < 1 ||
        intent.targetUserId !== undefined
      ) {
        return denied(
          "Current Team Project Source authority is unavailable or stale"
        );
      }
      return "step_up";
    default:
      return denied("Unknown Workspace Project lifecycle action");
  }
};

export interface ProjectSharePolicyState {
  projectId: string;
  teamId: string;
  policyVersion: number;
  status: "active" | "revoked" | "absent";
  actorUserId: string;
  actorIsCurrentProjectMember: boolean;
  authenticatedDeviceId: string;
}

export interface TrustedInitialSession {
  sessionId: string;
  ownerUserId: string;
  sourceRevision: number;
  mappingRevision: number;
  mappingProjectId: string;
  mappingUnambiguous: boolean;
  destinationShareGrantExists: boolean;
  destinationPendingShareExists: boolean;
}

export interface PolicyNativeReviewIntent {
  action: ProjectSharePolicyAction;
  actorUserId: string;
  teamId: string;
  projectId: string;
  expectedPolicyVersion: number;
  authenticatedDeviceId: string;
  // The future trusted local edge supplies this bounded set; the renderer has
  // no field through which to select or enlarge it.
  trustedManifest?: readonly TrustedInitialSession[];
}

export const admitProjectSharePolicyNativeReview = (
  intent: PolicyNativeReviewIntent,
  state: ProjectSharePolicyState | null,
  trustedCurrentSet: readonly TrustedInitialSession[] | null
): {
  tier: "native_review";
  projectId: string;
  policyVersion: number;
  eligibleSessions: TrustedInitialSession[];
} => {
  if (
    !state ||
    !state.actorIsCurrentProjectMember ||
    state.actorUserId !== intent.actorUserId ||
    state.teamId !== intent.teamId ||
    state.projectId !== intent.projectId ||
    state.authenticatedDeviceId !== intent.authenticatedDeviceId ||
    state.policyVersion !== intent.expectedPolicyVersion
  ) {
    return denied(
      "Current Project share policy authority is unavailable or stale"
    );
  }
  if (intent.action === "shared_memory.project_share_policy.revoke") {
    if (state.status !== "active" || intent.trustedManifest !== undefined) {
      return denied(
        "Only the exact active Project share policy can be revoked"
      );
    }
    return {
      tier: "native_review",
      projectId: intent.projectId,
      policyVersion: intent.expectedPolicyVersion,
      eligibleSessions: []
    };
  }
  if (
    intent.action !== "shared_memory.project_share_policy.enable" ||
    state.status === "active" ||
    !intent.trustedManifest ||
    !trustedCurrentSet ||
    trustedCurrentSet.length > 100 ||
    intent.trustedManifest.length !== trustedCurrentSet.length
  ) {
    return denied("A bounded authoritative initial manifest is required");
  }
  const byId = new Map(
    trustedCurrentSet.map((session) => [session.sessionId, session])
  );
  if (byId.size !== trustedCurrentSet.length) {
    return denied("Ambiguous initial Project session manifest");
  }
  const eligibleSessions: TrustedInitialSession[] = [];
  for (const session of intent.trustedManifest) {
    const current = byId.get(session.sessionId);
    if (
      !current ||
      JSON.stringify(current) !== JSON.stringify(session) ||
      current.ownerUserId !== intent.actorUserId ||
      current.mappingProjectId !== intent.projectId ||
      !current.mappingUnambiguous ||
      !Number.isSafeInteger(current.sourceRevision) ||
      !Number.isSafeInteger(current.mappingRevision)
    ) {
      return denied("Initial Project session manifest is stale or ambiguous");
    }
    byId.delete(session.sessionId);
    if (
      !current.destinationShareGrantExists &&
      !current.destinationPendingShareExists
    ) {
      eligibleSessions.push(current);
    }
  }
  if (byId.size !== 0)
    return denied("Initial Project session manifest changed");
  return {
    tier: "native_review",
    projectId: intent.projectId,
    policyVersion: intent.expectedPolicyVersion,
    eligibleSessions
  };
};

export const admitPolicySessionStage = (input: {
  parentAction: "shared_memory.project_share_policy.apply_session_grant";
  ownerUserId: string;
  sessionId: string;
  currentSessionId: string;
  projectId: string;
  policyVersion: number;
  currentOwnerUserId: string;
  currentProjectId: string;
  currentPolicyVersion: number;
  expectedSourceRevision: number;
  currentSourceRevision: number;
  expectedMappingRevision: number;
  currentMappingRevision: number;
  currentPolicyActive: boolean;
  associatedAtCapture: boolean;
  capturePolicyVersion: number;
  mappingUnambiguous: boolean;
  destinationShareGrantExists: boolean;
  destinationPendingShareExists: boolean;
  stageUseCount: number;
}): "bundled_stage" => {
  if (
    input.parentAction !==
      "shared_memory.project_share_policy.apply_session_grant" ||
    !input.currentPolicyActive ||
    input.ownerUserId !== input.currentOwnerUserId ||
    !input.currentOwnerUserId ||
    input.sessionId !== input.currentSessionId ||
    !input.currentSessionId ||
    input.projectId !== input.currentProjectId ||
    !input.currentProjectId ||
    input.policyVersion !== input.currentPolicyVersion ||
    input.expectedSourceRevision !== input.currentSourceRevision ||
    input.expectedMappingRevision !== input.currentMappingRevision ||
    !Number.isSafeInteger(input.expectedSourceRevision) ||
    !Number.isSafeInteger(input.expectedMappingRevision) ||
    input.expectedSourceRevision < 1 ||
    input.expectedMappingRevision < 1 ||
    !input.sessionId ||
    !input.associatedAtCapture ||
    !input.mappingUnambiguous ||
    input.capturePolicyVersion !== input.policyVersion ||
    input.destinationShareGrantExists ||
    input.destinationPendingShareExists ||
    input.stageUseCount !== 0
  ) {
    return denied("One-session policy stage authority is unavailable");
  }
  // The future authoritative parent must atomically consume this bound stage
  // with Pending Share preparation. This pure admission never issues a grant.
  return "bundled_stage";
};
