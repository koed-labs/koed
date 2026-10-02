import type { MemorySourceRepository } from "@koed/db";
import type { CollaborationApprovalReview } from "@koed/shared";
import type { ActionApprovalPolicy } from "./approval-policy.js";
import {
  reviewedAction,
  unavailableAction
} from "./action-definition-support.js";
import {
  bindPullRequestSourceControlOperation,
  type HighRiskActionGrantIntent,
  type HighRiskResolvedActionGrantOperation
} from "./action-grant-protocol.js";

type PRIntent = Extract<
  HighRiskActionGrantIntent,
  { action: `source_control.${string}` }
>;
type PRRepository = Pick<
  MemorySourceRepository,
  | "getPullRequestReview"
  | "getFrozenPullRequestReview"
  | "getPullRequestOperation"
  | "listDeviceCredentials"
>;
type Input = {
  repository: PRRepository;
  userId: string;
  currentDeviceInstanceId?: string;
  intent: HighRiskActionGrantIntent;
};
type Definition = {
  operationFamily: "managed_execution";
  admit(input: Input): Promise<{
    operation: HighRiskResolvedActionGrantOperation;
    policy: ActionApprovalPolicy;
  } | null>;
};

const unavailable = (): never =>
  unavailableAction(
    "Pull request write requires a current owner-approved review or push proposal"
  );
const displayReview = (review: {
  repository: { fullName: string };
  pullRequestNumber: number;
}) => `${review.repository.fullName} #${review.pullRequestNumber}`;

const definition = (action: PRIntent["action"]): Definition => ({
  operationFamily: "managed_execution",
  async admit(input) {
    if (input.intent.action !== action) return null;
    const intent = input.intent as PRIntent;
    const review = await input.repository.getPullRequestReview(
      { userId: input.userId },
      { reviewId: intent.reviewId }
    );
    if (
      !review ||
      review.revision !== intent.expectedReviewRevision ||
      review.targetDeviceId !== intent.targetDeviceId ||
      review.targetDeploymentId !== intent.targetDeploymentId
    )
      return unavailable();
    const authorizedTarget = (
      await input.repository.listDeviceCredentials({ userId: input.userId })
    ).some(
      (credential) =>
        credential.deviceInstanceId === intent.targetDeviceId &&
        credential.metadata.protocolDeploymentId ===
          intent.targetDeploymentId &&
        credential.operationFamilies.includes("managed_execution") &&
        (credential.expiresAt === null ||
          Date.parse(credential.expiresAt) > Date.now())
    );
    if (!authorizedTarget) return unavailable();
    let summary: string;
    if (intent.action === "source_control.pull_request_publish") {
      const frozen = await input.repository.getFrozenPullRequestReview(
        { userId: input.userId },
        { reviewId: review.id, frozenReviewId: intent.frozenReviewId }
      );
      if (
        !frozen ||
        frozen.digest !== intent.confirmationDigest ||
        frozen.accountId !== review.account.id ||
        frozen.connectionGeneration !== review.connectionGeneration ||
        frozen.headSha !== review.expectedHeadSha ||
        frozen.baseSha !== review.expectedBaseSha
      )
        return unavailable();
      summary = `${frozen.event} review · ${frozen.digest.slice(0, 16)} · ${frozen.findings.length} inline findings`;
    } else {
      const proposal = await input.repository.getPullRequestOperation(
        { userId: input.userId },
        { operationId: intent.proposalId }
      );
      const result = proposal?.result;
      if (
        !proposal ||
        proposal.state !== "completed" ||
        proposal.payload.kind !== "prepare_push" ||
        proposal.payload.reviewId !== review.id ||
        proposal.payload.expectedRevision !== intent.expectedReviewRevision ||
        result?.diffDigest !== intent.confirmationDigest
      )
        return unavailable();
      summary = `Push diff · ${intent.confirmationDigest.slice(0, 16)} · ${String(result.diff ?? "").length} characters`;
    }
    const operation = bindPullRequestSourceControlOperation(intent);
    const detail: Omit<CollaborationApprovalReview, "version"> = {
      title:
        intent.action === "source_control.pull_request_publish"
          ? "Publish this pull request review?"
          : "Push these confirmed changes?",
      description: `${displayReview(review)} · account @${review.account.login}`,
      consequence:
        intent.action === "source_control.pull_request_publish"
          ? "This publishes the frozen review body and inline findings to GitHub."
          : "This pushes the exact reviewed proposal as a normal fast-forward update.",
      confirmLabel:
        intent.action === "source_control.pull_request_publish"
          ? "Publish review"
          : "Push changes",
      details: [
        { label: "Confirmed content", value: summary },
        { label: "Agent", value: review.agentId }
      ]
    };
    return { operation, policy: reviewedAction("native_review", detail) };
  }
});

export const pullRequestSourceControlActionDefinitions: Record<
  PRIntent["action"],
  Definition
> = {
  "source_control.pull_request_publish": definition(
    "source_control.pull_request_publish"
  ),
  "source_control.pull_request_push": definition(
    "source_control.pull_request_push"
  )
};
