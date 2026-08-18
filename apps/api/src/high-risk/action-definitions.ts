import type { MemorySourceRepository } from "@koed/db";

import type { ActionApprovalPolicy } from "./approval-policy.js";
import {
  type HighRiskActionGrantIntent,
  type HighRiskActionName,
  type HighRiskResolvedActionGrantOperation
} from "./action-grant-protocol.js";
import { teamInviteCreateActionDefinition } from "./team-invite-create-action-definition.js";
import { teamAndMembershipActionDefinitions } from "./team-and-membership-action-definitions.js";
import { workspaceActionDefinitions } from "./workspace-action-definitions.js";
import { sharedMemoryActionDefinitions } from "./shared-memory-action-definitions.js";
import { managedSourceActionDefinitions } from "./managed-source-action-definitions.js";
import { governanceActionDefinitions } from "./governance-action-definitions.js";

type OperationFamily =
  | "admin"
  | "share_grant_management"
  | "source_download"
  | "managed_execution";

export type HighRiskActionDefinitionRepository = Pick<
  MemorySourceRepository,
  | "getTeamInviteCreationReview"
  | "getTeamInviteAcceptanceReview"
  | "getTeamInviteRevocationReview"
  | "getTeamMembershipActionReview"
  | "getTeamLeaveReview"
  | "getTeamWorkspaceCreationReview"
  | "getTeamWorkspaceLifecycleReview"
  | "getTeamWorkspaceAccessUpdateReview"
  | "getSharedMemoryPreviewAdmission"
  | "getSharedMemoryCandidatePreviewAdmission"
  | "getSharedMemoryPendingShareReview"
  | "getSharedMemoryShareReview"
  | "getSharedMemoryRevokeReview"
  | "getSharedMemoryRepresentationChangeReview"
  | "getTeamConversationSourceGrantReview"
  | "getConversationSourceArtifactByGeneration"
  | "getManagedConversationExecution"
  | "listDeviceCredentials"
  | "getTeamEntitlementGate"
  | "getTeamBillingSeatState"
  | "getTeamMembership"
  | "listTeams"
  | "getLegalHoldApprovalReview"
>;

interface HighRiskActionAdmission {
  operation: HighRiskResolvedActionGrantOperation;
  policy: ActionApprovalPolicy;
}

interface HighRiskActionDefinitionAdmissionInput {
  repository: HighRiskActionDefinitionRepository;
  userId: string;
  upstreamBackendId?: string;
  currentDeviceInstanceId?: string;
  clientRequestId: string;
  hashSecret(secret: string): string;
  intent: HighRiskActionGrantIntent;
}

interface HighRiskActionDefinition {
  operationFamily: OperationFamily;
  admit(
    input: HighRiskActionDefinitionAdmissionInput
  ): Promise<HighRiskActionAdmission | null>;
}

export const highRiskActionDefinitions: Record<
  HighRiskActionName,
  HighRiskActionDefinition
> = {
  ...teamAndMembershipActionDefinitions,
  ...workspaceActionDefinitions,
  ...sharedMemoryActionDefinitions,
  ...managedSourceActionDefinitions,
  ...governanceActionDefinitions,
  "team.invite.create": teamInviteCreateActionDefinition
};

export const highRiskActionGrantOperationFamilyForIntent = (
  intent: HighRiskActionGrantIntent
): OperationFamily => highRiskActionDefinitions[intent.action].operationFamily;

export const admitHighRiskActionGrant = (
  input: HighRiskActionDefinitionAdmissionInput
): Promise<HighRiskActionAdmission | null> =>
  highRiskActionDefinitions[input.intent.action].admit(input);
