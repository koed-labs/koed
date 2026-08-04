import {
  collaborationApprovalReviewSchema,
  type CollaborationApprovalReview,
  type CollaborationApprovalTier
} from "@koed/shared";

import type { HighRiskActionGrantIntent } from "./action-grant-protocol.js";

export type ActionApprovalDisposition =
  | CollaborationApprovalTier
  | "bundled_stage";

export interface ActionApprovalPolicyContext {
  currentMemberRole?: "owner" | "admin" | "member" | null;
  currentWorkspaceAccess?: "disabled" | "read" | "write" | null;
  currentRepresentation?: "memory_events" | "lcm_leaves" | "lcm_rollups" | null;
  selectedRepresentation?:
    | "memory_events"
    | "lcm_leaves"
    | "lcm_rollups"
    | null;
  targetDeviceTrusted?: boolean;
  bundledSourceTransfer?: boolean;
  enrolledSyncRelationship?: boolean;
  currentEntitlement?: string | null;
  currentSeatLimit?: number | null;
  currentBillableSeats?: number | null;
  currentTeamLifecycle?: string | null;
  exactLogicalMemoryId?: string | null;
  display?: Partial<{
    team: string;
    workspace: string;
    member: string;
    invitation: string;
    source: string;
    currentDevice: string;
    targetDevice: string;
  }>;
}

export interface ActionApprovalPolicy {
  disposition: ActionApprovalDisposition;
  review: CollaborationApprovalReview | null;
}

export class ActionApprovalPolicyError extends Error {
  readonly statusCode = 403;

  constructor(message: string) {
    super(message);
    this.name = "ActionApprovalPolicyError";
  }
}

const roleRank = { member: 0, admin: 1, owner: 2 } as const;
const representationRank = {
  lcm_rollups: 0,
  lcm_leaves: 1,
  memory_events: 2
} as const;

const detail = (label: string, value: string | null | undefined) =>
  value ? [{ label, value }] : [];

const reviewed = (
  disposition: "native_review" | "step_up",
  input: Omit<CollaborationApprovalReview, "version">
): ActionApprovalPolicy => ({
  disposition,
  review: collaborationApprovalReviewSchema.parse({ version: 1, ...input })
});

const direct = (): ActionApprovalPolicy => ({
  disposition: "direct",
  review: null
});

const bundled = (): ActionApprovalPolicy => ({
  disposition: "bundled_stage",
  review: null
});

const named = (value: string | undefined, fallback: string): string =>
  value?.trim() || fallback;

export const resolveActionApprovalPolicy = (
  intent: HighRiskActionGrantIntent,
  context: ActionApprovalPolicyContext = {}
): ActionApprovalPolicy => {
  const display = context.display ?? {};
  switch (intent.action) {
    case "team.create":
    case "team.workspace.create":
    case "team.workspace.restore":
    case "shared_memory.preview":
      return direct();
    case "conversation_source.discover":
      if (!context.enrolledSyncRelationship) {
        throw new ActionApprovalPolicyError(
          "Conversation source discovery requires an enrolled sync relationship"
        );
      }
      return direct();
    case "conversation_source.download":
      if (context.bundledSourceTransfer) return bundled();
      return reviewed("step_up", {
        title: "Download a conversation source?",
        description:
          "This standalone source download is not attached to a reviewed handoff, fork, restore, or sync decision.",
        consequence:
          "Approving authorizes only the exact source generation, target deployment, segment boundary, and recipient key.",
        confirmLabel: "Authorize download",
        details: [
          ...detail("Source generation", intent.sourceGenerationId),
          ...detail("Target deployment", intent.targetDeploymentId),
          ...detail("First segment", String(intent.firstSegmentIndex))
        ]
      });
    case "team.invite.accept":
      return reviewed("native_review", {
        title: `Join ${named(display.team, "this Team")}?`,
        description:
          "Review the membership and initial Workspace Access granted by this invitation.",
        consequence:
          "Joining adds your User to the Team with the invitation's exact role and Workspace Access.",
        confirmLabel: "Join Team",
        details: [
          ...detail("Team", display.team),
          ...detail("Membership", display.invitation),
          ...detail("Initial Workspace", display.workspace)
        ]
      });
    case "team.invite.create":
      return reviewed("native_review", {
        title: `Invite ${intent.body.email}?`,
        description: "Review the exact invitation before it is issued.",
        consequence:
          "The recipient can join with the listed role and initial Workspace Access until the invitation expires.",
        confirmLabel: "Create invitation",
        details: [
          ...detail("Team", display.team),
          { label: "Recipient", value: intent.body.email },
          { label: "Role", value: intent.body.role },
          ...detail("Default Workspace", display.workspace),
          {
            label: "Workspace Access",
            value: intent.body.defaultWorkspaceAccess
          },
          { label: "Expires after", value: `${intent.body.ttlHours} hours` }
        ]
      });
    case "team.invite.revoke":
      return reviewed("native_review", {
        title: "Revoke this invitation?",
        description:
          "Revocation prevents future acceptance and does not disable an existing Team member.",
        consequence:
          "The selected pending invitation will no longer be usable.",
        confirmLabel: "Revoke invitation",
        details: [
          ...detail("Team", display.team),
          ...detail("Recipient", display.invitation),
          ...detail("Invitation", intent.inviteId)
        ]
      });
    case "team.leave":
      return reviewed("native_review", {
        title: `Leave ${named(display.team, "this Team")}?`,
        description: "You will lose Team and Workspace Access.",
        consequence:
          "Your membership is removed. Last-owner protection is checked again before execution.",
        confirmLabel: "Leave Team",
        details: detail("Team", display.team ?? intent.teamId)
      });
    case "team.workspace.archive":
      return reviewed("native_review", {
        title: `Archive ${named(display.workspace, "this Workspace")}?`,
        description:
          "Archiving changes normal availability without deleting retained Team-shared Memory.",
        consequence: "The Workspace can be restored later.",
        confirmLabel: "Archive Workspace",
        details: [
          ...detail("Team", display.team),
          ...detail("Workspace", display.workspace ?? intent.teamWorkspaceId)
        ]
      });
    case "shared_memory.revoke":
      return reviewed("native_review", {
        title: "Revoke Shared Memory access?",
        description:
          "Remove ordinary Team recall through this Share Grant without deleting the source from Personal Memory.",
        consequence:
          "Independent sync and retention policy remain separate lifecycle boundaries.",
        confirmLabel: "Revoke access",
        details: [
          ...detail("Personal Memory", display.source),
          ...detail("Logical Memory", context.exactLogicalMemoryId),
          ...detail("Team", display.team),
          ...detail("Workspace", display.workspace),
          ...detail("Representation", context.currentRepresentation),
          { label: "Share Grant", value: intent.shareGrantId }
        ]
      });
    case "team.member.disable":
      return reviewed("step_up", {
        title: `Disable ${named(display.member, "this Team member")}?`,
        description:
          "This immediately removes the member's current Team access.",
        consequence:
          "Active work may be interrupted. Owner and last-owner safeguards are rechecked before execution.",
        confirmLabel: "Disable member",
        details: [
          ...detail("Team", display.team),
          ...detail("Member", display.member ?? intent.userId)
        ]
      });
    case "team.member.role_update": {
      const current = context.currentMemberRole;
      const promotes =
        current === null || current === undefined
          ? true
          : roleRank[intent.body.role] > roleRank[current];
      const disposition = promotes ? "step_up" : "native_review";
      return reviewed(disposition, {
        title: `Change ${named(display.member, "this member")}'s role?`,
        description: "Review the current and resulting Team authority.",
        consequence: promotes
          ? "This grants additional Team administration authority."
          : "This removes Team administration authority.",
        confirmLabel: "Change role",
        details: [
          ...detail("Team", display.team),
          ...detail("Member", display.member ?? intent.userId),
          {
            label: "Current role",
            value: current ?? "Unknown — Step-up required"
          },
          { label: "New role", value: intent.body.role }
        ]
      });
    }
    case "team.workspace.access_update": {
      const current = context.currentWorkspaceAccess;
      const next = intent.body.access;
      const nativeDecrease = current === "write" && next === "read";
      return reviewed(nativeDecrease ? "native_review" : "step_up", {
        title: `Change Workspace Access for ${named(display.member, "this member")}?`,
        description: "Review the exact before-and-after access value.",
        consequence:
          next === "disabled"
            ? "This removes the member's current Workspace Access."
            : nativeDecrease
              ? "This reduces Workspace Access from write to read."
              : "This grants or expands Workspace Access.",
        confirmLabel: "Apply access change",
        details: [
          ...detail("Team", display.team),
          ...detail("Workspace", display.workspace ?? intent.teamWorkspaceId),
          ...detail("Member", display.member ?? intent.body.userId),
          {
            label: "Current access",
            value: current ?? "Unknown — Step-up required"
          },
          { label: "New access", value: next }
        ]
      });
    }
    case "shared_memory.share": {
      const representation = intent.selectedRepresentation;
      return reviewed(
        representation === "memory_events" || !representation
          ? "step_up"
          : "native_review",
        {
          title: "Share Personal Memory with this Workspace?",
          description:
            "One decision records the exact source-owner consent and creates the corresponding Share Grant.",
          consequence:
            "Authorized Workspace members can recall the selected representation under the exact mode and expiry.",
          confirmLabel: "Share Memory",
          details: [
            ...detail(
              "Personal Memory",
              display.source ?? intent.logicalMemoryId
            ),
            { label: "Logical Memory", value: intent.logicalMemoryId },
            ...detail("Team", display.team ?? intent.teamId),
            ...detail("Workspace", display.workspace ?? intent.teamWorkspaceId),
            {
              label: "Representation",
              value: representation ?? "Unknown — Step-up required"
            },
            { label: "Mode", value: intent.mode },
            {
              label: "Expiry",
              value: intent.expiresAt ?? "No expiry"
            }
          ]
        }
      );
    }
    case "shared_memory.change_representation": {
      const current = context.currentRepresentation;
      const next = intent.representation;
      const increases =
        current === null || current === undefined
          ? true
          : representationRank[next] > representationRank[current];
      return reviewed(increases ? "step_up" : "native_review", {
        title: "Change the Shared Memory representation?",
        description: "Compare the current and proposed level of Memory detail.",
        consequence: increases
          ? "This makes more detailed Memory available to the Workspace."
          : "This reduces the detail available and purges unauthorized higher-fidelity cached content.",
        confirmLabel: "Change representation",
        details: [
          ...detail("Personal Memory", display.source),
          { label: "Logical Memory", value: intent.logicalMemoryId },
          ...detail("Team", display.team),
          ...detail("Workspace", display.workspace),
          {
            label: "Current representation",
            value: current ?? "Unknown — Step-up required"
          },
          { label: "New representation", value: next },
          { label: "Mode", value: intent.mode },
          {
            label: "Expiry",
            value: intent.expiresAt ?? "No expiry"
          }
        ]
      });
    }
    case "managed_conversation.handoff":
    case "managed_conversation.fork": {
      const handoff = intent.action === "managed_conversation.handoff";
      return reviewed(
        context.targetDeviceTrusted ? "native_review" : "step_up",
        {
          title: handoff
            ? "Move this Conversation to another Personal Device?"
            : "Fork this Conversation on another Personal Device?",
          description: handoff
            ? "Review the current and target devices and the verified handoff boundary."
            : "Review both devices and the new independent Conversation lineage.",
          consequence: handoff
            ? "The current device stops writing after the verified handoff boundary."
            : "The original Conversation continues independently on the current device.",
          confirmLabel: handoff ? "Move Conversation" : "Fork Conversation",
          details: [
            ...detail("Current device", display.currentDevice),
            ...detail(
              "Target device",
              display.targetDevice ?? intent.body.targetDeviceId
            ),
            {
              label: "Target trust",
              value: context.targetDeviceTrusted
                ? "Enrolled and established"
                : "New or unverified — Step-up required"
            }
          ]
        }
      );
    }
    case "team.entitlement.update":
      return reviewed("step_up", {
        title: `Change ${named(display.team, "this Team")}'s entitlement?`,
        description: "Review the current and proposed commercial access state.",
        consequence: `The Team entitlement will become ${intent.body.status}.`,
        confirmLabel: "Change entitlement",
        details: [
          ...detail("Team", display.team ?? intent.teamId),
          {
            label: "Current entitlement",
            value: context.currentEntitlement ?? "Unavailable"
          },
          { label: "Proposed entitlement", value: intent.body.status }
        ]
      });
    case "team.billing_seats.update":
      return reviewed("step_up", {
        title: `Change ${named(display.team, "this Team")}'s seat policy?`,
        description:
          "Review the proposed billing-seat policy and access impact.",
        consequence: "The Team's commercial seat enforcement will change.",
        confirmLabel: "Change seat policy",
        details: [
          ...detail("Team", display.team ?? intent.teamId),
          {
            label: "Current seat limit",
            value:
              context.currentSeatLimit === null
                ? "No limit"
                : context.currentSeatLimit === undefined
                  ? "Unavailable"
                  : String(context.currentSeatLimit)
          },
          ...(context.currentBillableSeats === null ||
          context.currentBillableSeats === undefined
            ? []
            : [
                {
                  label: "Current billable seats",
                  value: String(context.currentBillableSeats)
                }
              ]),
          {
            label: "Seat limit",
            value:
              intent.body.seatLimit === null
                ? "No limit"
                : String(intent.body.seatLimit)
          }
        ]
      });
    case "team.retention.delete_request":
      return reviewed("step_up", {
        title: `Request deletion of ${named(display.team, "this Team")}?`,
        description: "Start the governed Team deletion stage.",
        consequence:
          "Retention, delay, dual-control, and purge requirements remain authoritative and may make this irreversible.",
        confirmLabel: "Request deletion",
        details: [
          ...detail("Team", display.team ?? intent.teamId),
          ...detail("Current stage", context.currentTeamLifecycle)
        ]
      });
    case "team.legal_hold.place":
      return reviewed("step_up", {
        title: "Place Team data under legal hold?",
        description: "Review the exact governed data scope.",
        consequence:
          "The selected data cannot follow ordinary deletion or retention shortening while the hold is active.",
        confirmLabel: "Place legal hold",
        details: [
          ...detail("Team", display.team),
          {
            label: "Scope",
            value:
              intent.body.target.scope === "team"
                ? "Entire Team"
                : "Selected Team data"
          }
        ]
      });
    case "team.legal_hold.release_request":
      return reviewed("step_up", {
        title: "Request legal-hold release?",
        description: "Start the governed release process for this legal hold.",
        consequence:
          "This is the first of two separate decisions and does not itself release retained data.",
        confirmLabel: "Request release",
        details: [
          ...detail("Team", display.team),
          { label: "Legal hold", value: intent.holdId }
        ]
      });
    case "team.legal_hold.release_confirm":
      return reviewed("step_up", {
        title: "Confirm legal-hold release?",
        description: "Complete the separately requested legal-hold release.",
        consequence:
          "The held data may resume ordinary retention and deletion behavior.",
        confirmLabel: "Release legal hold",
        details: [
          ...detail("Team", display.team),
          { label: "Legal hold", value: intent.holdId }
        ]
      });
  }
};
