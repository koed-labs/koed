import { createHash } from "node:crypto";

import {
  sourceControlMergeReadinessSchema,
  type SourceControlMergeReadiness
} from "@koed/shared/source-control-v2";
import type { SourceControlConnection } from "@koed/shared";

import type {
  SourceControlCredential,
  SourceControlProviderRepository
} from "./provider-drivers.js";

type Method = "merge" | "squash" | "rebase";
type Input = {
  connection: SourceControlConnection;
  credential: SourceControlCredential;
  repository: SourceControlProviderRepository;
  fetch: typeof fetch;
};
type Context = Input & {
  accountLabel: string;
  remoteIdentityHash: string;
  executionId: string;
  executionGeneration: number;
  runnerDeploymentId: string;
  runnerDeviceId: string;
  credentialGeneration: number;
  policyVersion: number;
  policyDigest: string;
};
const unavailable = () =>
  Object.assign(new Error("Merge is unavailable for this repository"), {
    statusCode: 409,
    code: "source_control_capability_unavailable"
  });
const stale = () =>
  Object.assign(new Error("Merge readiness changed"), {
    statusCode: 409,
    code: "source_control_stale"
  });
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unavailable();
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  if (typeof value !== "string") throw unavailable();
  return value;
};
const number = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw unavailable();
  return value;
};
const auth = (credential: SourceControlCredential): string =>
  credential.scheme === "bearer"
    ? `Bearer ${credential.token}`
    : `Basic ${Buffer.from(`${credential.username}:${credential.token}`).toString("base64")}`;
const repoPath = (input: Input) => {
  if (
    input.connection.provider !== "github" ||
    input.repository.project !== null
  )
    throw unavailable();
  return `/repos/${encodeURIComponent(input.repository.namespace)}/${encodeURIComponent(input.repository.repository)}`;
};
const call = async (
  input: Input,
  method: "GET" | "PUT",
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; value: unknown; next: boolean }> => {
  const origin = new URL(input.connection.apiOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw unavailable();
  const url = new URL(origin.href);
  const requested = new URL(path, "https://koed.invalid");
  url.pathname = `${origin.pathname.replace(/\/$/, "")}${requested.pathname}`;
  url.search = requested.search;
  const response = await input.fetch(url, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: {
      authorization: auth(input.credential),
      accept: "application/vnd.github+json",
      "x-github-api-version": "2026-03-10",
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (response.status >= 300 && response.status < 400) throw unavailable();
  const raw = await response.text();
  if (raw.length > 2_000_000) throw unavailable();
  let value: unknown = null;
  if (raw) {
    try {
      value = JSON.parse(raw);
    } catch {
      throw unavailable();
    }
  }
  if (response.status >= 500 || response.status === 429) throw unavailable();
  return {
    status: response.status,
    value,
    next: /<[^>]+>;\s*rel="next"/.test(response.headers.get("link") ?? "")
  };
};
const get = async (input: Input, path: string) => {
  const result = await call(input, "GET", path);
  if (result.status !== 200) throw unavailable();
  return result;
};
const all = async (
  input: Input,
  path: string,
  field?: string
): Promise<unknown[]> => {
  const values: unknown[] = [];
  let expectedTotal: number | null = null;
  for (let page = 1; page <= 4; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const result = await get(
      input,
      `${path}${separator}per_page=100&page=${page}`
    );
    if (field) {
      const total = record(result.value).total_count;
      if (
        typeof total !== "number" ||
        !Number.isSafeInteger(total) ||
        total < 0 ||
        total > 400
      )
        throw unavailable();
      if (expectedTotal !== null && total !== expectedTotal) throw stale();
      expectedTotal = total;
    }
    const payload = field ? record(result.value)[field] : result.value;
    if (!Array.isArray(payload)) throw unavailable();
    values.push(...(payload as unknown[]));
    if (values.length > 400) throw unavailable();
    if (!result.next && payload.length < 100) {
      if (expectedTotal !== null && expectedTotal !== values.length)
        throw unavailable();
      return values;
    }
  }
  throw unavailable();
};

export const readGithubMergeReadiness = async (
  input: Context,
  reviewRequestNumber: number,
  mergeMethod: Method
): Promise<SourceControlMergeReadiness> => {
  const repo = repoPath(input);
  const [repositoryResult, requestResult] = await Promise.all([
    get(input, repo),
    get(input, `${repo}/pulls/${reviewRequestNumber}`)
  ]);
  const repository = record(repositoryResult.value);
  const request = record(requestResult.value);
  const head = record(request.head);
  const base = record(request.base);
  const targetBranch = string(base.ref);
  const expectedHeadObjectId = string(head.sha);
  if (
    !/^[a-f0-9]{40,64}$/i.test(expectedHeadObjectId) ||
    request.state !== "open" ||
    request.draft !== false ||
    request.mergeable !== true ||
    request.mergeable_state !== "clean" ||
    (request.maintainer_can_modify === false &&
      record(head.repo).full_name !== repository.full_name)
  ) {
    throw stale();
  }
  const allowedMergeMethods: Method[] = [];
  if (repository.allow_merge_commit === true) allowedMergeMethods.push("merge");
  if (repository.allow_squash_merge === true)
    allowedMergeMethods.push("squash");
  if (repository.allow_rebase_merge === true)
    allowedMergeMethods.push("rebase");
  if (!allowedMergeMethods.includes(mergeMethod)) throw unavailable();
  // Rulesets and merge queues need their own complete/bypass-aware adapter.
  const rules = await get(
    input,
    `${repo}/rules/branches/${encodeURIComponent(targetBranch)}`
  );
  if (!Array.isArray(rules.value) || rules.value.length !== 0 || rules.next)
    throw unavailable();
  const protection = record(
    (
      await get(
        input,
        `${repo}/branches/${encodeURIComponent(targetBranch)}/protection`
      )
    ).value
  );
  if (
    record(protection.enforce_admins).enabled !== true ||
    (record(protection.required_pull_request_reviews)
      .require_last_push_approval === true &&
      request.mergeable_state !== "clean")
  )
    throw unavailable();
  const reviewRule = record(protection.required_pull_request_reviews);
  const requiredReviewCount = number(
    reviewRule.required_approving_review_count
  );
  if (requiredReviewCount < 1) throw unavailable();
  const statusRule = record(protection.required_status_checks);
  const requiredChecks = statusRule.checks;
  if (
    !Array.isArray(requiredChecks) ||
    !requiredChecks.every((item) => {
      const check = record(item);
      return (
        typeof check.context === "string" &&
        typeof check.app_id === "number" &&
        Number.isSafeInteger(check.app_id)
      );
    })
  )
    throw unavailable();
  const requiredContexts = new Map<string, number>(
    requiredChecks.map((item) => {
      const check = record(item);
      return [string(check.context), number(check.app_id)];
    })
  );
  if (requiredContexts.size !== requiredChecks.length) throw unavailable();
  const [reviews, checkRuns, statuses] = await Promise.all([
    all(input, `${repo}/pulls/${reviewRequestNumber}/reviews`),
    all(
      input,
      `${repo}/commits/${expectedHeadObjectId}/check-runs`,
      "check_runs"
    ),
    all(input, `${repo}/commits/${expectedHeadObjectId}/statuses`)
  ]);
  const canonicalReviews: SourceControlMergeReadiness["reviews"] = [];
  const reviewByUser = new Map<
    string,
    { state: string; submittedAt: string }
  >();
  for (const value of reviews) {
    const review = record(value);
    const commitObjectId = string(review.commit_id);
    if (!/^[a-f0-9]{40,64}$/i.test(commitObjectId)) throw unavailable();
    const user = string(record(review.user).login);
    const state = string(review.state);
    if (
      !["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(
        state
      )
    )
      throw unavailable();
    const submittedAt = string(review.submitted_at);
    if (Number.isNaN(Date.parse(submittedAt))) throw unavailable();
    canonicalReviews.push({
      id: String(number(review.id)),
      user,
      commitObjectId,
      state: state as
        | "APPROVED"
        | "CHANGES_REQUESTED"
        | "COMMENTED"
        | "DISMISSED",
      submittedAt
    });
    if (commitObjectId !== expectedHeadObjectId) continue;
    const previous = reviewByUser.get(user);
    if (!previous || submittedAt > previous.submittedAt)
      reviewByUser.set(user, { state, submittedAt });
  }
  canonicalReviews.sort((left, right) => left.id.localeCompare(right.id));
  if (canonicalReviews.length > 40) throw unavailable();
  const latestReviews = [...reviewByUser.values()];
  const approvedReviewCount = latestReviews.filter(
    (review) => review.state === "APPROVED"
  ).length;
  if (
    approvedReviewCount < requiredReviewCount ||
    latestReviews.some((review) => review.state === "CHANGES_REQUESTED")
  )
    throw stale();
  const checks: SourceControlMergeReadiness["checks"] = [];
  for (const value of checkRuns) {
    const check = record(value);
    const name = string(check.name);
    if (check.head_sha !== undefined && check.head_sha !== expectedHeadObjectId)
      throw stale();
    const state =
      check.status === "completed" && check.conclusion === "success"
        ? "success"
        : check.status === "completed"
          ? "failure"
          : "pending";
    const appId = number(record(check.app).id);
    checks.push({
      id: String(number(check.id)),
      name,
      source: "check_run",
      state,
      required:
        requiredContexts.has(name) &&
        (requiredContexts.get(name) === -1 ||
          requiredContexts.get(name) === appId),
      appId,
      objectId: expectedHeadObjectId
    });
  }
  for (const value of statuses) {
    const status = record(value);
    const name = string(status.context);
    const state =
      status.state === "success"
        ? "success"
        : status.state === "pending"
          ? "pending"
          : "failure";
    checks.push({
      id: String(number(status.id)),
      name,
      source: "commit_status",
      state,
      required: requiredContexts.get(name) === -1,
      appId: null,
      objectId: expectedHeadObjectId
    });
  }
  if (
    [...requiredContexts].some(
      ([context, appId]) =>
        !checks.some(
          (check) =>
            check.name === context &&
            check.required &&
            (appId === -1 || check.appId === appId)
        )
    ) ||
    checks.some((check) => check.required && check.state !== "success")
  )
    throw stale();
  checks.sort((left, right) =>
    `${left.name}:${left.source}:${left.appId ?? ""}:${left.id}`.localeCompare(
      `${right.name}:${right.source}:${right.appId ?? ""}:${right.id}`
    )
  );
  if (checks.length > 40) throw unavailable();
  return sourceControlMergeReadinessSchema.parse({
    provider: "github",
    accountLabel: input.accountLabel,
    host: input.connection.host,
    apiOrigin: input.connection.apiOrigin,
    repository: `${input.repository.namespace}/${input.repository.repository}`,
    remoteIdentityHash: input.remoteIdentityHash,
    connectionId: input.connection.id,
    executionId: input.executionId,
    executionGeneration: input.executionGeneration,
    runnerDeploymentId: input.runnerDeploymentId,
    runnerDeviceId: input.runnerDeviceId,
    credentialGeneration: input.credentialGeneration,
    policyVersion: input.policyVersion,
    policyDigest: input.policyDigest,
    reviewRequestNumber,
    title: string(request.title),
    targetBranch,
    expectedHeadObjectId,
    mergeability: "mergeable",
    reviewDecision: "approved",
    requiredReviewCount,
    approvedReviewCount,
    checks,
    reviews: canonicalReviews,
    allowedMergeMethods,
    mergeMethod,
    protectionDigest: hash(protection)
  });
};

export const dispatchGithubMerge = async (
  input: Input,
  readiness: SourceControlMergeReadiness
) => {
  const response = await call(
    input,
    "PUT",
    `${repoPath(input)}/pulls/${readiness.reviewRequestNumber}/merge-async`,
    {
      sha: readiness.expectedHeadObjectId,
      merge_method: readiness.mergeMethod,
      merge_action: "direct_merge",
      bypass_rules: false
    }
  );
  if (response.status === 400 || response.status === 403)
    return {
      outcome: "rejected" as const,
      providerOperationId: null,
      mergeCommitObjectId: null
    };
  if (response.status === 202) {
    const value = record(response.value);
    const operationId = string(record(value.details).uuid);
    if (!/^[a-f0-9-]{36}$/i.test(operationId)) throw unavailable();
    return {
      outcome: "pending" as const,
      providerOperationId: operationId,
      mergeCommitObjectId: null
    };
  }
  return {
    outcome: "unknown" as const,
    providerOperationId: null,
    mergeCommitObjectId: null
  };
};

export const reconcileGithubMerge = async (
  input: Input,
  readiness: SourceControlMergeReadiness,
  providerOperationId: string | null
) => {
  if (providerOperationId) {
    const response = await get(
      input,
      `${repoPath(input)}/pulls/${readiness.reviewRequestNumber}/merge-async/${providerOperationId}`
    );
    const value = record(response.value);
    if (value.status === "pending" || value.status === "enqueued") {
      const details = record(value.details);
      if (
        details.uuid !== providerOperationId ||
        details.expected_head_sha !== readiness.expectedHeadObjectId ||
        details.merge_method !== readiness.mergeMethod ||
        details.merge_action !== "direct_merge" ||
        details.bypass_rules !== false
      )
        return { outcome: "unknown" as const, mergeCommitObjectId: null };
      return { outcome: "pending" as const, mergeCommitObjectId: null };
    }
    if (value.status === "merged") {
      const mergedObjectId = string(record(value.details).sha);
      const request = record(
        (
          await get(
            input,
            `${repoPath(input)}/pulls/${readiness.reviewRequestNumber}`
          )
        ).value
      );
      if (
        request.merged === true &&
        record(request.head).sha === readiness.expectedHeadObjectId &&
        record(request.base).ref === readiness.targetBranch &&
        request.merge_commit_sha === mergedObjectId &&
        /^[a-f0-9]{40,64}$/i.test(mergedObjectId)
      )
        return {
          outcome: "merged" as const,
          mergeCommitObjectId: mergedObjectId
        };
      return { outcome: "unknown" as const, mergeCommitObjectId: null };
    }
    if (value.status === "failed")
      return { outcome: "rejected" as const, mergeCommitObjectId: null };
  }
  return { outcome: "unknown" as const, mergeCommitObjectId: null };
};
