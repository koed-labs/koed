import type { MemorySourceRepository } from "@koed/db";
import { fetchBoundedJsonObject, upstreamApiUrl } from "@koed/shared";
import {
  pullRequestFrozenReviewSchema,
  pullRequestOperationSchema,
  pullRequestReviewDraftSchema,
  pullRequestReviewSchema,
  type PullRequestOperationRecord,
  type PullRequestOperationResult,
  type PullRequestFinding,
  type PullRequestReviewRecord
} from "@koed/shared/pull-requests";
import type { PullRequestRunnerAuthority } from "./pull-request-runner.js";

const timeoutMs = 30_000;
const ordinaryBytes = 2 * 1024 * 1024;

/**
 * Bind the runner to the same authority that owns its managed execution.
 * Remote mode always forwards to the active upstream; it never falls back to
 * this process's local database after an upstream error.
 */
export const createPullRequestRunnerAuthority = (options: {
  repository: MemorySourceRepository;
  ownerUserId: string;
  deviceId: string;
  deploymentId: string;
  remote?: { baseUrl: string; authorization: string; fetch?: typeof fetch };
}): PullRequestRunnerAuthority => {
  const actor = { userId: options.ownerUserId };
  const fetchFn = options.remote?.fetch ?? globalThis.fetch.bind(globalThis);
  const request = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<Record<string, unknown>> => {
    if (!options.remote) throw new Error("PullRequestRemoteAuthorityRequired");
    const { response, payload } = await fetchBoundedJsonObject(
      fetchFn,
      upstreamApiUrl(options.remote.baseUrl, path),
      {
        method,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: options.remote.authorization,
          ...(method === "POST" ? { "content-type": "application/json" } : {})
        },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {})
      },
      { timeoutMs, maxBytes: ordinaryBytes, readErrorBody: true }
    );
    if (!response.ok) {
      throw Object.assign(
        new Error(
          typeof payload.error === "string"
            ? payload.error
            : `Pull request authority returned HTTP ${response.status}`
        ),
        { statusCode: response.status }
      );
    }
    return payload;
  };
  const parse = <T>(schema: { parse(value: unknown): T }, value: unknown) =>
    schema.parse(value);
  const operationPath = (id: string) =>
    `/v1/pull-requests/runner/operations/${encodeURIComponent(id)}`;
  const runnerForOperation = new Map<string, string>();

  return {
    async claim(input) {
      if (options.remote) {
        const payload = await request(
          "POST",
          "/v1/pull-requests/runner/operations/claim",
          input
        );
        if (!Array.isArray(payload.operations)) return [];
        return payload.operations.map((value) => {
          const operation = parse(pullRequestOperationSchema, value);
          runnerForOperation.set(operation.id, input.runnerId);
          return operation;
        });
      }
      const claims = await options.repository.claimPullRequestOperations({
        ownerUserId: options.ownerUserId,
        runnerDeploymentId: options.deploymentId,
        runnerDeviceId: options.deviceId,
        ...input
      });
      return claims.map((claim) => {
        runnerForOperation.set(claim.operation.id, input.runnerId);
        return claim.operation;
      });
    },
    async heartbeat(operation) {
      if (!operation.leaseToken) return false;
      if (options.remote) {
        const payload = await request(
          "POST",
          `${operationPath(operation.id)}/heartbeat`,
          {
            leaseToken: operation.leaseToken,
            runnerId: runnerForOperation.get(operation.id) ?? ""
          }
        );
        return payload.operation !== null;
      }
      return Boolean(
        await options.repository.heartbeatPullRequestOperation({
          operationId: operation.id,
          ownerUserId: options.ownerUserId,
          runnerDeploymentId: options.deploymentId,
          runnerDeviceId: options.deviceId,
          runnerId: runnerForOperation.get(operation.id) ?? "",
          leaseToken: operation.leaseToken,
          leaseMs: 300_000
        })
      );
    },
    async complete(operation, result: PullRequestOperationResult) {
      if (!operation.leaseToken) throw new Error("PullRequestLeaseMissing");
      if (options.remote) {
        await request("POST", `${operationPath(operation.id)}/complete`, {
          leaseToken: operation.leaseToken,
          runnerId: runnerForOperation.get(operation.id) ?? "",
          result
        });
        return;
      }
      await options.repository.completePullRequestOperation({
        operationId: operation.id,
        ownerUserId: options.ownerUserId,
        runnerDeploymentId: options.deploymentId,
        runnerDeviceId: options.deviceId,
        runnerId: runnerForOperation.get(operation.id) ?? "",
        leaseToken: operation.leaseToken,
        result
      });
    },
    async fail(operation, errorCode, uncertain) {
      if (!operation.leaseToken) return;
      if (options.remote) {
        await request("POST", `${operationPath(operation.id)}/fail`, {
          leaseToken: operation.leaseToken,
          runnerId: runnerForOperation.get(operation.id) ?? "",
          state: uncertain ? "uncertain" : "failed",
          errorCode
        });
        return;
      }
      await options.repository.failPullRequestOperation({
        operationId: operation.id,
        ownerUserId: options.ownerUserId,
        runnerDeploymentId: options.deploymentId,
        runnerDeviceId: options.deviceId,
        runnerId: runnerForOperation.get(operation.id) ?? "",
        leaseToken: operation.leaseToken,
        state: uncertain ? "uncertain" : "failed",
        errorCode
      });
    },
    async getReview(id) {
      if (options.remote) {
        const payload = await request(
          "GET",
          `/v1/pull-requests/runner/reviews/${encodeURIComponent(id)}`
        );
        return parse(pullRequestReviewSchema, payload.review);
      }
      const review = await options.repository.getPullRequestReview(actor, {
        reviewId: id
      });
      if (!review) throw new Error("PullRequestReviewUnavailable");
      return review;
    },
    async getReviewForExecution(executionId, ownerUserId) {
      if (ownerUserId !== options.ownerUserId) return null;
      if (options.remote) {
        const payload = await request(
          "GET",
          `/v1/pull-requests/runner/executions/${encodeURIComponent(executionId)}/review`
        );
        return payload.review === null
          ? null
          : parse(pullRequestReviewSchema, payload.review);
      }
      return options.repository.getPullRequestReviewForExecution(actor, {
        executionId,
        ownerUserId,
        runnerDeploymentId: options.deploymentId,
        runnerDeviceId: options.deviceId
      });
    },
    async getFrozenReview(reviewId, frozenReviewId) {
      if (options.remote) {
        const payload = await request(
          "GET",
          `/v1/pull-requests/runner/reviews/${encodeURIComponent(reviewId)}/freezes/${encodeURIComponent(frozenReviewId)}`
        );
        return parse(pullRequestFrozenReviewSchema, payload.frozenReview);
      }
      const value = await options.repository.getFrozenPullRequestReview(actor, {
        reviewId,
        frozenReviewId
      });
      if (!value) throw new Error("PullRequestFrozenReviewUnavailable");
      return value;
    },
    async getOperation(id) {
      if (options.remote) {
        const payload = await request("GET", operationPath(id));
        return parse(pullRequestOperationSchema, payload.operation);
      }
      const value = await options.repository.getPullRequestOperation(actor, {
        operationId: id
      });
      if (!value) throw new Error("PullRequestOperationUnavailable");
      return value;
    },
    async markReviewed(input) {
      const result: {
        event: "COMMENT";
        body: string;
        findings: PullRequestFinding[];
      } = {
        event: "COMMENT",
        body: input.body ?? "",
        findings: input.findings ?? []
      };
      if (options.remote) {
        await request(
          "POST",
          `/v1/pull-requests/runner/reviews/${encodeURIComponent(input.reviewId)}/complete`,
          input
        );
        return;
      }
      const draft = await options.repository.markPullRequestReviewCompleted({
        ...input,
        runnerDeploymentId: options.deploymentId,
        runnerDeviceId: options.deviceId,
        result
      });
      if (!draft) throw new Error("PullRequestReviewCompletionRejected");
      pullRequestReviewDraftSchema.parse(draft);
    }
  };
};
