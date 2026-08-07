import type { MemorySourceRepository, TeamRecord } from "@koed/db";
import {
  retentionAdminRequestHash,
  retentionAdminScopeHash
} from "../retention/routes.js";
import type { ActionApprovalPolicy } from "./approval-policy.js";
import {
  bindTeamAdminOperation,
  reviewedAction,
  unavailableAction
} from "./action-definition-support.js";
import type {
  HighRiskActionGrantIntent,
  HighRiskResolvedActionGrantOperation
} from "./action-grant-protocol.js";

type GovernanceAction =
  | "team.entitlement.update"
  | "team.billing_seats.update"
  | "team.retention.delete_request"
  | "team.legal_hold.place"
  | "team.legal_hold.release_request"
  | "team.legal_hold.release_confirm";

type GovernanceIntent = Extract<
  HighRiskActionGrantIntent,
  { action: GovernanceAction }
>;

type GovernanceRepository = Pick<
  MemorySourceRepository,
  | "getTeamEntitlementGate"
  | "getTeamBillingSeatState"
  | "getTeamMembership"
  | "listTeams"
  | "getLegalHoldApprovalReview"
>;

interface GovernanceAdmissionInput {
  repository: GovernanceRepository;
  userId: string;
  intent: HighRiskActionGrantIntent;
}

const unavailable = (context: string): never =>
  unavailableAction(
    `${context} requires complete current Team, version, and governance context`
  );

const reviewed = (
  review: Parameters<typeof reviewedAction>[1]
): ActionApprovalPolicy => reviewedAction("step_up", review);

const bindRetentionOperation = (
  operation: Omit<
    HighRiskResolvedActionGrantOperation,
    "scopeHash" | "requestHash"
  >
): HighRiskResolvedActionGrantOperation => ({
  ...operation,
  scopeHash: retentionAdminScopeHash({
    action: operation.action,
    teamId: operation.teamId,
    targetId: operation.targetId
  }),
  requestHash: retentionAdminRequestHash({
    method: operation.method,
    path: operation.path,
    body: operation.body
  })
});

export const bindEntitlementOperation = (
  intent: Extract<GovernanceIntent, { action: "team.entitlement.update" }>
): HighRiskResolvedActionGrantOperation =>
  bindTeamAdminOperation({
    operationFamily: "admin",
    action: intent.action,
    teamId: intent.teamId,
    targetId: intent.teamId,
    method: "PUT",
    path: `/v1/teams/${intent.teamId}/entitlement`,
    body: intent.body
  });

export const bindBillingSeatsOperation = (
  intent: Extract<GovernanceIntent, { action: "team.billing_seats.update" }>
): HighRiskResolvedActionGrantOperation =>
  bindTeamAdminOperation({
    operationFamily: "admin",
    action: intent.action,
    teamId: intent.teamId,
    targetId: intent.teamId,
    method: "PUT",
    path: `/v1/teams/${intent.teamId}/billing-seats/policy`,
    body: intent.body
  });

export const bindTeamDeletionRequestOperation = (
  intent: Extract<GovernanceIntent, { action: "team.retention.delete_request" }>
): HighRiskResolvedActionGrantOperation =>
  bindRetentionOperation({
    operationFamily: "admin",
    action: intent.action,
    teamId: intent.teamId,
    targetId: intent.teamId,
    method: "POST",
    path: `/v1/retention/teams/${intent.teamId}/deletion-request`,
    body: intent.body
  });

export const bindLegalHoldPlacementOperation = (
  intent: Extract<GovernanceIntent, { action: "team.legal_hold.place" }>
): HighRiskResolvedActionGrantOperation =>
  bindRetentionOperation({
    operationFamily: "admin",
    action: intent.action,
    teamId: intent.body.target.teamId,
    targetId: intent.body.target.teamId,
    method: "POST",
    path: "/v1/retention/legal-holds",
    body: intent.body
  });

export const bindLegalHoldReleaseOperation = (
  intent: Extract<
    GovernanceIntent,
    {
      action:
        | "team.legal_hold.release_request"
        | "team.legal_hold.release_confirm";
    }
  >,
  teamId: string
): HighRiskResolvedActionGrantOperation =>
  bindRetentionOperation({
    operationFamily: "admin",
    action: intent.action,
    teamId,
    targetId: intent.holdId,
    method: "POST",
    path:
      intent.action === "team.legal_hold.release_request"
        ? `/v1/retention/legal-holds/${intent.holdId}/release-request`
        : `/v1/retention/legal-holds/${intent.holdId}/release-confirmation`,
    body: intent.body
  });

const loadManagedTeam = async (
  input: GovernanceAdmissionInput,
  teamId: string
): Promise<{
  team: TeamRecord;
  gate: NonNullable<
    Awaited<ReturnType<GovernanceRepository["getTeamEntitlementGate"]>>
  >;
}> => {
  const actor = { userId: input.userId };
  const [gate, teams] = await Promise.all([
    input.repository.getTeamEntitlementGate(actor, teamId),
    input.repository.listTeams(actor)
  ]);
  const team = teams.find((candidate) => candidate.id === teamId);
  if (!gate || !team || team.lifecycle !== "active" || gate.teamId !== teamId) {
    return unavailable("Governance action");
  }
  return { team, gate };
};

const loadOwnerManagedTeam = async (
  input: GovernanceAdmissionInput,
  teamId: string
) => {
  const [managed, membership] = await Promise.all([
    loadManagedTeam(input, teamId),
    input.repository.getTeamMembership({ userId: input.userId }, teamId)
  ]);
  if (!membership || membership.role !== "owner") {
    return unavailable("Team commercial governance action");
  }
  return managed;
};

const entitlementDefinition = {
  operationFamily: "admin" as const,
  async admit(input: GovernanceAdmissionInput) {
    if (input.intent.action !== "team.entitlement.update") return null;
    const { team, gate } = await loadOwnerManagedTeam(
      input,
      input.intent.teamId
    );
    if (gate.version !== input.intent.body.expectedVersion) {
      unavailable("Team entitlement change");
    }
    return {
      operation: bindEntitlementOperation(input.intent),
      policy: reviewed({
        title: `Change ${team.name}'s entitlement?`,
        description: "Review the current and proposed commercial access state.",
        consequence: `The Team entitlement will become ${input.intent.body.status}.`,
        confirmLabel: "Change entitlement",
        details: [
          { label: "Team", value: team.name },
          { label: "Current entitlement", value: gate.status },
          { label: "Proposed entitlement", value: input.intent.body.status }
        ]
      })
    };
  }
};

const billingDefinition = {
  operationFamily: "admin" as const,
  async admit(input: GovernanceAdmissionInput) {
    if (input.intent.action !== "team.billing_seats.update") return null;
    const [{ team }, seats] = await Promise.all([
      loadOwnerManagedTeam(input, input.intent.teamId),
      input.repository.getTeamBillingSeatState(
        { userId: input.userId },
        input.intent.teamId
      )
    ]);
    if (!seats || seats.version !== input.intent.body.expectedVersion) {
      return unavailable("Team billing-seat change");
    }
    return {
      operation: bindBillingSeatsOperation(input.intent),
      policy: reviewed({
        title: `Change ${team.name}'s seat policy?`,
        description:
          "Review the proposed billing-seat policy and access impact.",
        consequence: "The Team's commercial seat enforcement will change.",
        confirmLabel: "Change seat policy",
        details: [
          { label: "Team", value: team.name },
          {
            label: "Current seat limit",
            value:
              seats.seatLimit === null ? "No limit" : String(seats.seatLimit)
          },
          {
            label: "Current billable seats",
            value: String(seats.billableSeatCount)
          },
          {
            label: "Seat limit",
            value:
              input.intent.body.seatLimit === null
                ? "No limit"
                : String(input.intent.body.seatLimit)
          }
        ]
      })
    };
  }
};

const deletionDefinition = {
  operationFamily: "admin" as const,
  async admit(input: GovernanceAdmissionInput) {
    if (input.intent.action !== "team.retention.delete_request") return null;
    const { team } = await loadManagedTeam(input, input.intent.teamId);
    if (team.version !== input.intent.body.expectedVersion) {
      unavailable("Team deletion request");
    }
    return {
      operation: bindTeamDeletionRequestOperation(input.intent),
      policy: reviewed({
        title: `Request deletion of ${team.name}?`,
        description: "Start the governed Team deletion stage.",
        consequence:
          "Retention, delay, dual-control, and purge requirements remain authoritative and may make this irreversible.",
        confirmLabel: "Request deletion",
        details: [
          { label: "Team", value: team.name },
          { label: "Current stage", value: team.lifecycle }
        ]
      })
    };
  }
};

const legalHoldPlacementDefinition = {
  operationFamily: "admin" as const,
  async admit(input: GovernanceAdmissionInput) {
    if (input.intent.action !== "team.legal_hold.place") return null;
    const { team } = await loadManagedTeam(
      input,
      input.intent.body.target.teamId
    );
    return {
      operation: bindLegalHoldPlacementOperation(input.intent),
      policy: reviewed({
        title: "Place Team data under legal hold?",
        description: "Review the exact governed data scope.",
        consequence:
          "The selected data cannot follow ordinary deletion or retention shortening while the hold is active.",
        confirmLabel: "Place legal hold",
        details: [
          { label: "Team", value: team.name },
          { label: "Scope", value: input.intent.body.target.scope }
        ]
      })
    };
  }
};

const legalHoldReleaseDefinition = {
  operationFamily: "admin" as const,
  async admit(input: GovernanceAdmissionInput) {
    if (
      input.intent.action !== "team.legal_hold.release_request" &&
      input.intent.action !== "team.legal_hold.release_confirm"
    ) {
      return null;
    }
    const hold = await input.repository.getLegalHoldApprovalReview(
      input.intent.holdId
    );
    if (!hold) return unavailable("Legal-hold release");
    await loadManagedTeam(input, hold.teamId);
    const requests = input.intent.action === "team.legal_hold.release_request";
    if (
      (requests && hold.state !== "active") ||
      (!requests && hold.state !== "release_pending")
    ) {
      unavailable("Legal-hold release stage");
    }
    return {
      operation: bindLegalHoldReleaseOperation(input.intent, hold.teamId),
      policy: reviewed({
        title: requests
          ? "Request legal-hold release?"
          : "Confirm legal-hold release?",
        description: requests
          ? "Start the governed release process for this legal hold."
          : "Complete the separately requested legal-hold release.",
        consequence: requests
          ? "This is the first of two separate decisions and does not itself release retained data."
          : "The held data may resume ordinary retention and deletion behavior.",
        confirmLabel: requests ? "Request release" : "Release legal hold",
        details: [
          { label: "Team", value: hold.teamName },
          { label: "Legal hold", value: hold.id },
          { label: "Scope", value: hold.scope },
          { label: "Current stage", value: hold.state }
        ]
      })
    };
  }
};

export const governanceActionDefinitions = {
  "team.entitlement.update": entitlementDefinition,
  "team.billing_seats.update": billingDefinition,
  "team.retention.delete_request": deletionDefinition,
  "team.legal_hold.place": legalHoldPlacementDefinition,
  "team.legal_hold.release_request": legalHoldReleaseDefinition,
  "team.legal_hold.release_confirm": legalHoldReleaseDefinition
};
