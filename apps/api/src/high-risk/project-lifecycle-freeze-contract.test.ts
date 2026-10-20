import { describe, expect, it } from "vitest";
import {
  admitPolicySessionStage,
  admitProjectLifecycleAction,
  admitProjectSharePolicyNativeReview,
  type AuthoritativeProjectState,
  type TrustedInitialSession
} from "./project-lifecycle-freeze-contract.js";

const project: AuthoritativeProjectState = {
  projectId: "project",
  teamId: "team",
  version: 3,
  lifecycle: "active",
  ownerUserId: "owner",
  actorUserId: "owner",
  actorMembership: "owner",
  targetUserId: "member",
  targetMembership: "member",
  sourceId: "source",
  sourceOwnerUserId: "member",
  sourceVersion: 5,
  sourceTeamId: "team",
  sourceProjectId: "project"
};
const base = {
  actorUserId: "owner",
  teamId: "team",
  projectId: "project",
  expectedProjectVersion: 3
};

describe("future Project lifecycle admission contract", () => {
  it("assigns Step-up only to exact current Project authority", () => {
    expect(
      admitProjectLifecycleAction(
        { ...base, action: "workspace_project.delete" },
        project
      )
    ).toBe("step_up");
    expect(
      admitProjectLifecycleAction(
        {
          ...base,
          action: "workspace_project.member_remove",
          targetUserId: "member"
        },
        project
      )
    ).toBe("step_up");
    expect(
      admitProjectLifecycleAction(
        {
          ...base,
          actorUserId: "member",
          action: "project_source.team_metadata.delete",
          sourceId: "source",
          expectedSourceVersion: 5
        },
        { ...project, actorUserId: "member", actorMembership: "member" }
      )
    ).toBe("step_up");
    expect(
      admitProjectLifecycleAction(
        {
          ...base,
          action: "project_source.team_metadata.delete",
          sourceId: "source",
          expectedSourceVersion: 5
        },
        project
      )
    ).toBe("step_up");
    expect(
      admitProjectLifecycleAction(
        { ...base, actorUserId: "member", action: "workspace_project.leave" },
        {
          ...project,
          actorUserId: "member",
          actorMembership: "member"
        }
      )
    ).toBe("step_up");
  });

  it("rejects missing state, stale versions, owner leave and owner/self removal", () => {
    const remove = {
      ...base,
      action: "workspace_project.member_remove" as const,
      targetUserId: "member"
    };
    expect(() => admitProjectLifecycleAction(remove, null)).toThrow();
    expect(() =>
      admitProjectLifecycleAction(remove, { ...project, version: 4 })
    ).toThrow();
    expect(() =>
      admitProjectLifecycleAction({ ...remove, targetUserId: "owner" }, project)
    ).toThrow();
    expect(() =>
      admitProjectLifecycleAction({ ...remove, targetUserId: "other" }, project)
    ).toThrow();
    expect(() =>
      admitProjectLifecycleAction(
        { ...base, action: "workspace_project.leave" },
        project
      )
    ).toThrow();
    expect(() =>
      admitProjectLifecycleAction(
        {
          ...base,
          action: "project_source.team_metadata.delete",
          sourceId: "source",
          expectedSourceVersion: 4
        },
        project
      )
    ).toThrow();
    expect(() =>
      admitProjectLifecycleAction(
        {
          ...base,
          actorUserId: "other",
          action: "project_source.team_metadata.delete",
          sourceId: "source",
          expectedSourceVersion: 5
        },
        { ...project, actorUserId: "other", actorMembership: "member" }
      )
    ).toThrow();
    expect(() =>
      admitProjectLifecycleAction(
        {
          ...base,
          action: "project_source.team_metadata.delete",
          sourceId: "source",
          expectedSourceVersion: 0
        },
        { ...project, sourceVersion: 0 }
      )
    ).toThrow();
    expect(() =>
      admitProjectLifecycleAction(
        { ...base, action: "workspace_project.delete" },
        { ...project, ownerUserId: "other" }
      )
    ).toThrow();
    expect(() =>
      admitProjectLifecycleAction(
        { ...base, action: "workspace_project.restore" as never },
        project
      )
    ).toThrow();
  });
});

const session: TrustedInitialSession = {
  sessionId: "session",
  ownerUserId: "owner",
  sourceRevision: 2,
  mappingRevision: 4,
  mappingProjectId: "project",
  mappingUnambiguous: true,
  destinationShareGrantExists: false,
  destinationPendingShareExists: false
};
const policy = {
  projectId: "project",
  teamId: "team",
  policyVersion: 4,
  status: "revoked" as const,
  actorUserId: "owner",
  actorIsCurrentProjectMember: true,
  authenticatedDeviceId: "device"
};
const policyIntent = {
  action: "shared_memory.project_share_policy.enable" as const,
  actorUserId: "owner",
  teamId: "team",
  projectId: "project",
  expectedPolicyVersion: 4,
  authenticatedDeviceId: "device",
  trustedManifest: [session]
};

describe("future Project share policy admission contract", () => {
  it("binds Native review to a bounded exact owner manifest", () => {
    expect(
      admitProjectSharePolicyNativeReview(policyIntent, policy, [session])
    ).toEqual({
      tier: "native_review",
      projectId: "project",
      policyVersion: 4,
      eligibleSessions: [session]
    });
    for (const key of [
      "destinationShareGrantExists",
      "destinationPendingShareExists"
    ] as const) {
      const occupied = { ...session, [key]: true };
      expect(
        admitProjectSharePolicyNativeReview(
          { ...policyIntent, trustedManifest: [occupied] },
          policy,
          [occupied]
        ).eligibleSessions
      ).toEqual([]);
    }
  });

  it("rejects stale, renderer-altered, ambiguous and unavailable manifests", () => {
    expect(() =>
      admitProjectSharePolicyNativeReview(policyIntent, null, [session])
    ).toThrow();
    expect(() =>
      admitProjectSharePolicyNativeReview(
        policyIntent,
        { ...policy, policyVersion: 5 },
        [session]
      )
    ).toThrow();
    expect(() =>
      admitProjectSharePolicyNativeReview(policyIntent, policy, [
        { ...session, sourceRevision: 3 }
      ])
    ).toThrow();
    expect(() =>
      admitProjectSharePolicyNativeReview(policyIntent, policy, [
        { ...session, mappingUnambiguous: false }
      ])
    ).toThrow();
    expect(() =>
      admitProjectSharePolicyNativeReview(policyIntent, policy, null)
    ).toThrow();
    expect(() =>
      admitProjectSharePolicyNativeReview(
        {
          ...policyIntent,
          trustedManifest: Array.from({ length: 101 }, (_, index) => ({
            ...session,
            sessionId: String(index)
          }))
        },
        policy,
        Array.from({ length: 101 }, (_, index) => ({
          ...session,
          sessionId: String(index)
        }))
      )
    ).toThrow();
  });

  it("requires exact active-policy revoke and one-use future Session admission", () => {
    expect(
      admitProjectSharePolicyNativeReview(
        {
          ...policyIntent,
          action: "shared_memory.project_share_policy.revoke",
          trustedManifest: undefined
        },
        { ...policy, status: "active" },
        null
      )
    ).toEqual({
      tier: "native_review",
      projectId: "project",
      policyVersion: 4,
      eligibleSessions: []
    });
    const stage = {
      parentAction:
        "shared_memory.project_share_policy.apply_session_grant" as const,
      ownerUserId: "owner",
      sessionId: "session",
      currentSessionId: "session",
      projectId: "project",
      policyVersion: 4,
      currentOwnerUserId: "owner",
      currentProjectId: "project",
      currentPolicyVersion: 4,
      expectedSourceRevision: 2,
      currentSourceRevision: 2,
      expectedMappingRevision: 3,
      currentMappingRevision: 3,
      currentPolicyActive: true,
      associatedAtCapture: true,
      capturePolicyVersion: 4,
      mappingUnambiguous: true,
      destinationShareGrantExists: false,
      destinationPendingShareExists: false,
      stageUseCount: 0
    };
    expect(admitPolicySessionStage(stage)).toBe("bundled_stage");
    for (const invalid of [
      { stageUseCount: 1 },
      { destinationShareGrantExists: true },
      { destinationPendingShareExists: true },
      { capturePolicyVersion: 3 },
      { associatedAtCapture: false },
      { currentPolicyActive: false },
      { currentOwnerUserId: "other" },
      { currentSessionId: "different-session" },
      { currentProjectId: "other" },
      { currentSourceRevision: 3 },
      { currentMappingRevision: 4 },
      { mappingUnambiguous: false },
      { parentAction: "shared_memory.pending_share" as never }
    ]) {
      expect(() => admitPolicySessionStage({ ...stage, ...invalid })).toThrow();
    }
  });
});
