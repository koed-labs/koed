import {
  WorkItemConflictError,
  WorkItemTransitionError,
  WorkItemUnavailableError,
  type ManagedConversationExecutionRecord,
  type MemorySourceRepository,
  type VerifyTrustedWorkItemTransition,
  type WorkItemRepository
} from "@koed/db";
import {
  sourceControlResultSchema,
  type SourceControlRemote,
  type SourceControlReviewRequest,
  type WorkItem
} from "@koed/shared";
import type { SourceControlRuntime } from "../source-control/runtime.js";

const conflict = (message: string) =>
  Object.assign(new Error(message), { statusCode: 409 });

const sameRunner = (
  first: ManagedConversationExecutionRecord,
  current: ManagedConversationExecutionRecord | null
) =>
  current?.id === first.id &&
  current.ownerUserId === first.ownerUserId &&
  current.projectId === first.projectId &&
  current.executionGeneration === first.executionGeneration &&
  current.runnerDeploymentId === first.runnerDeploymentId &&
  current.runnerDeviceId === first.runnerDeviceId &&
  current.runnerId === first.runnerId &&
  current.logicalSessionId === first.logicalSessionId;

/** Match the canonical provider path, not just a host or a PR number. */
export const workItemReviewRemoteMatches = (
  remote: SourceControlRemote,
  item: Pick<WorkItem, "prProvider" | "prNumber" | "prUrl">
): boolean => {
  if (!item.prUrl || !item.prNumber) return false;
  try {
    const url = new URL(item.prUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.hostname !== remote.host ||
      item.prProvider !== url.hostname ||
      remote.connectionState !== "connected" ||
      !remote.connectionId ||
      !remote.capabilities.includes("review_request_read") ||
      !remote.capabilities.includes("checks_read")
    )
      return false;
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const namespace = remote.locator.namespace.split("/");
    const repo = [...namespace, remote.locator.repository];
    const number = String(item.prNumber);
    const expected =
      remote.provider === "github"
        ? [...repo, "pull", number]
        : remote.provider === "gitlab"
          ? [...repo, "-", "merge_requests", number]
          : remote.provider === "bitbucket"
            ? [...repo, "pull-requests", number]
            : remote.locator.project
              ? [
                  ...namespace,
                  remote.locator.project,
                  "_git",
                  remote.locator.repository,
                  "pullrequest",
                  number
                ]
              : [];
    return (
      expected.length > 0 && JSON.stringify(parts) === JSON.stringify(expected)
    );
  } catch {
    return false;
  }
};

const sameReview = (
  first: SourceControlReviewRequest,
  next: SourceControlReviewRequest
) =>
  first.number === next.number &&
  first.id === next.id &&
  first.webUrl === next.webUrl &&
  first.headObjectId === next.headObjectId &&
  first.state === next.state &&
  first.targetBranch === next.targetBranch &&
  first.sourceBranch === next.sourceBranch;

export const createWorkItemPrReconciler =
  (options: {
    workItems: Pick<WorkItemRepository, "getForRealtime">;
    requireRepository(): Pick<
      MemorySourceRepository,
      "getManagedConversationExecution"
    >;
    sourceControl: Pick<SourceControlRuntime, "execute">;
    trustedRepository(
      verify: VerifyTrustedWorkItemTransition
    ): Pick<WorkItemRepository, "transitionTrusted">;
  }) =>
  async (
    ownerUserId: string,
    projectId: string,
    itemId: string
  ): Promise<WorkItem> => {
    const item = await options.workItems.getForRealtime(ownerUserId, itemId);
    if (!item || item.projectId !== projectId)
      throw new WorkItemUnavailableError("Work Item is unavailable");
    if (item.status !== "review") return item;
    if (!item.executionId || !item.prNumber || !item.prUrl || !item.prProvider)
      throw conflict("The Work Item has no verified PR binding");
    const repository = options.requireRepository();
    const execution = await repository.getManagedConversationExecution(
      { userId: ownerUserId },
      item.executionId
    );
    if (
      !execution ||
      execution.ownerUserId !== ownerUserId ||
      execution.projectId !== projectId ||
      !sameRunner(execution, execution)
    )
      throw conflict("The PR runner is unavailable");
    const base = {
      contractVersion: 1 as const,
      executionId: execution.id,
      executionGeneration: execution.executionGeneration
    };
    const remotes = sourceControlResultSchema.parse(
      await options.sourceControl.execute(ownerUserId, {
        ...base,
        kind: "remotes"
      })
    );
    if (remotes.kind !== "remotes")
      throw conflict("Source-control result identity changed");
    const candidates = remotes.remotes.filter((remote) =>
      workItemReviewRemoteMatches(remote, item)
    );
    // Different credentials for the same repository require an explicit selection.
    const bindings = new Map(
      candidates.map((remote) => [
        JSON.stringify([
          remote.connectionId,
          remote.credentialGeneration,
          remote.locator
        ]),
        remote
      ])
    );
    if (bindings.size !== 1)
      throw conflict("The PR remote is unavailable or ambiguous");
    const remote = [...bindings.values()][0]!;
    const request = { ...base, remoteIdentityHash: remote.remoteIdentityHash };
    const read = async () => {
      const result = sourceControlResultSchema.parse(
        await options.sourceControl.execute(ownerUserId, {
          ...request,
          kind: "review_request",
          number: item.prNumber
        })
      );
      if (
        result.kind !== "review_request" ||
        result.reviewRequest.number !== item.prNumber ||
        result.reviewRequest.webUrl !== item.prUrl
      )
        throw conflict("The provider PR binding changed");
      return result.reviewRequest;
    };
    const first = await read();
    const checks = sourceControlResultSchema.parse(
      await options.sourceControl.execute(ownerUserId, {
        ...request,
        kind: "checks",
        objectId: first.headObjectId
      })
    );
    if (checks.kind !== "checks")
      throw conflict("The provider check binding changed");
    const review = await read();
    if (!sameReview(first, review))
      throw conflict("The PR changed during reconciliation");
    const latestRemotes = sourceControlResultSchema.parse(
      await options.sourceControl.execute(ownerUserId, {
        ...base,
        kind: "remotes"
      })
    );
    if (
      latestRemotes.kind !== "remotes" ||
      !latestRemotes.remotes.some(
        (current) => JSON.stringify(current) === JSON.stringify(remote)
      )
    )
      throw conflict("The source-control connection changed");
    const latestExecution = await repository.getManagedConversationExecution(
      { userId: ownerUserId },
      execution.id
    );
    if (!sameRunner(execution, latestExecution))
      throw conflict("The PR runner authority changed");
    const current = await options.workItems.getForRealtime(
      ownerUserId,
      item.id
    );
    if (!current || current.projectId !== projectId)
      throw new WorkItemUnavailableError("Work Item is unavailable");
    if (current.version !== item.version)
      throw new WorkItemConflictError(
        "Work Item changed during reconciliation",
        current
      );
    if (review.state === "open") return current;
    const event =
      review.state === "merged" ? "pr_merged" : "pr_closed_unmerged";
    const trusted = options.trustedRepository(
      async ({
        client,
        current: locked,
        ownerUserId: lockedOwner,
        event: lockedEvent
      }) => {
        if (
          lockedOwner !== ownerUserId ||
          lockedEvent !== event ||
          locked.id !== item.id ||
          locked.projectId !== projectId ||
          locked.version !== item.version ||
          locked.executionId !== execution.id ||
          locked.prNumber !== item.prNumber ||
          locked.prUrl !== item.prUrl ||
          locked.prProvider !== item.prProvider
        )
          throw new WorkItemTransitionError("The observed PR binding changed");
        const authority = await client.query<{ valid: boolean }>(
          `select true as valid from managed_conversation_executions execution
       join managed_conversation_runtime_bindings binding
         on binding.execution_id=execution.id and binding.owner_user_id=execution.owner_user_id
          and binding.execution_generation=execution.execution_generation
       join sessions session on session.id=binding.local_session_id
         and session.owner_user_id=execution.owner_user_id and session.logical_session_id=execution.logical_session_id
       where execution.id=$1 and execution.owner_user_id=$2 and execution.project_id=$3
         and execution.execution_generation=$4 and execution.runner_device_id=$5
         and execution.runner_deployment_id=$6 and execution.runner_id is not distinct from $7
         and execution.logical_session_id=$8
         and session.personal_deleted_at is null and session.trashed_at is null
       for update of execution,session`,
          [
            execution.id,
            ownerUserId,
            projectId,
            execution.executionGeneration,
            execution.runnerDeviceId,
            execution.runnerDeploymentId,
            execution.runnerId,
            execution.logicalSessionId
          ]
        );
        if (authority.rows.length !== 1)
          throw new WorkItemTransitionError(
            "The PR runner or Conversation changed"
          );
        return {
          event,
          executionId: execution.id,
          prProvider: item.prProvider!,
          prNumber: review.number,
          prUrl: review.webUrl
        };
      }
    );
    return trusted.transitionTrusted(ownerUserId, item.id, item.version, event);
  };

export type WorkItemPrReconciler = ReturnType<
  typeof createWorkItemPrReconciler
>;
