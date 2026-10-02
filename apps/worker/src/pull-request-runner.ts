import { randomUUID, createHash } from "node:crypto";
import type {
  PullRequestFinding,
  PullRequestOperationRecord,
  PullRequestOperationResult,
  PullRequestReviewRecord,
  PullRequestFrozenReview
} from "@koed/shared/pull-requests";
import { createGithubDelegatedCli } from "@koed/shared/github-delegated";
import { createPullRequestConnectionStore } from "./pull-request-connection.js";
import { preparePullRequestCheckout } from "./pull-request-checkout.js";
import { listMatchingPullRequestProjects } from "./pull-request-projects.js";
import {
  assertPullRequestPublicationScope,
  validatePullRequestInlineFindings
} from "./pull-request-publication.js";
export interface PullRequestRunnerAuthority {
  claim(input: {
    runnerId: string;
    limit: number;
    leaseMs: number;
  }): Promise<PullRequestOperationRecord[]>;
  heartbeat(operation: PullRequestOperationRecord): Promise<boolean>;
  complete(
    operation: PullRequestOperationRecord,
    result: PullRequestOperationResult
  ): Promise<void>;
  fail(
    operation: PullRequestOperationRecord,
    errorCode: string,
    uncertain: boolean
  ): Promise<void>;
  getReview(id: string): Promise<PullRequestReviewRecord>;
  getReviewForExecution(
    executionId: string,
    ownerUserId: string
  ): Promise<PullRequestReviewRecord | null>;
  getFrozenReview(
    reviewId: string,
    id: string
  ): Promise<PullRequestFrozenReview>;
  getOperation(id: string): Promise<PullRequestOperationRecord>;
  markReviewed(input: {
    ownerUserId: string;
    agentJobId: string;
    reviewId: string;
    executionId: string;
    executionGeneration: number;
    commandId: string;
    leaseToken: string;
    baseSha: string;
    headSha: string;
    body?: string;
    findings?: PullRequestFinding[];
  }): Promise<void>;
}
const observedPullRequest = (value: Record<string, unknown>) => {
  const { baseSha, headSha, state, author, merged } = value;
  if (
    typeof baseSha !== "string" ||
    !/^[a-f0-9]{40,64}$/i.test(baseSha) ||
    typeof headSha !== "string" ||
    !/^[a-f0-9]{40,64}$/i.test(headSha) ||
    typeof state !== "string" ||
    typeof author !== "string" ||
    typeof merged !== "boolean"
  )
    throw new Error("PullRequestObservationInvalid");
  return { baseSha, headSha, state, author, merged };
};
export const createPullRequestRunner = (options: {
  authority: PullRequestRunnerAuthority;
  authorityId: string;
  koedHome: string;
  deviceId: string;
  deploymentId: string;
  resolveCheckout: (review: PullRequestReviewRecord) => Promise<{
    path: string;
    executionGeneration: number;
  } | null>;
  preparePush: (
    review: PullRequestReviewRecord,
    checkout: string,
    executionGeneration: number
  ) => Promise<PullRequestOperationResult>;
  push: (
    review: PullRequestReviewRecord,
    proposal: PullRequestOperationResult,
    checkout: string,
    executionGeneration: number,
    assertDispatchAllowed: () => Promise<void>
  ) => Promise<PullRequestOperationResult>;
  reconcilePush: (
    review: PullRequestReviewRecord,
    proposal: PullRequestOperationResult,
    checkout: string
  ) => Promise<PullRequestOperationResult>;
  github?: ReturnType<typeof createGithubDelegatedCli>;
  onError?: (code: string) => void;
}) => {
  const driver = options.github ?? createGithubDelegatedCli();
  const connections = createPullRequestConnectionStore(
    options.koedHome,
    options.authorityId
  );
  let accountMutationTail: Promise<void> = Promise.resolve();
  const runnerId = `pr:${options.deviceId}:${randomUUID()}`;
  const dispatchedWrites = new Set<string>();
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | null = null,
    inFlight: Promise<void> | null = null;
  const selected = async (
    operation: PullRequestOperationRecord,
    expected?: {
      account: { id: string; login: string };
      connectionGeneration: number;
    }
  ) => {
    const connection = await connections.read(operation.ownerUserId);
    if (!connection.account) throw new Error("PullRequestConnectionRequired");
    if (
      expected &&
      (expected.account.id !== connection.account.id ||
        expected.account.login.toLowerCase() !==
          connection.account.login.toLowerCase() ||
        expected.connectionGeneration !== connection.generation)
    )
      throw new Error("PullRequestConnectionChanged");
    const identity = await driver.readIdentity(connection.account.login);
    if (String(identity.id) !== connection.account.id)
      throw new Error("PullRequestConnectionChanged");
    return connection;
  };
  const verifyReview = async (
    operation: PullRequestOperationRecord,
    id: string,
    readOnlyReconciliation = false
  ) => {
    const review = await options.authority.getReview(id);
    if (
      review.ownerUserId !== operation.ownerUserId ||
      review.targetDeviceId !== options.deviceId ||
      review.targetDeploymentId !== options.deploymentId
    )
      throw new Error("PullRequestRunnerScopeChanged");
    const connection = readOnlyReconciliation
      ? await selected(operation)
      : await selected(operation, {
          account: review.account,
          connectionGeneration: review.connectionGeneration
        });
    if (
      connection.account?.id !== review.account.id ||
      connection.account.login.toLowerCase() !==
        review.account.login.toLowerCase()
    )
      throw new Error("PullRequestConnectionChanged");
    return { review, connection };
  };
  const withAccountMutationLock = async <T>(action: () => Promise<T>) => {
    const prior = accountMutationTail;
    let release!: () => void;
    accountMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  };
  const assertCurrentConnection = async (
    operation: PullRequestOperationRecord,
    review: PullRequestReviewRecord
  ) => {
    const expected = {
      account: review.account,
      connectionGeneration: review.connectionGeneration
    };
    await selected(operation, expected);
    const latest = await connections.read(review.ownerUserId);
    if (
      latest.generation !== review.connectionGeneration ||
      !latest.account ||
      latest.account.id !== review.account.id ||
      latest.account.login.toLowerCase() !== review.account.login.toLowerCase()
    )
      throw new Error("PullRequestConnectionChanged");
  };
  const assertCurrentPushScope = async (
    operation: PullRequestOperationRecord,
    review: PullRequestReviewRecord,
    checkoutPath: string,
    executionGeneration: number
  ) => {
    const current = await options.resolveCheckout(review);
    if (
      !current ||
      current.path !== checkoutPath ||
      current.executionGeneration !== executionGeneration
    )
      throw new Error("PullRequestExecutionChanged");
    await assertCurrentConnection(operation, review);
    if (!(await options.authority.heartbeat(operation)))
      throw new Error("PullRequestOperationLeaseLost");
  };
  const executeOperation = async (
    operation: PullRequestOperationRecord
  ): Promise<PullRequestOperationResult> => {
    if (
      operation.targetDeviceId !== options.deviceId ||
      operation.targetDeploymentId !== options.deploymentId ||
      !operation.leaseToken
    )
      throw new Error("PullRequestRunnerScopeChanged");
    const payload = operation.payload;
    if (payload.kind === "accounts")
      return { accounts: await driver.discoverAccounts() };
    if (payload.kind === "connection_status") {
      const connection = await connections.read(operation.ownerUserId);
      if (!connection.account)
        return {
          state: "disconnected",
          account: null,
          connectionGeneration: connection.generation
        };
      try {
        await selected(operation);
        return {
          state: "connected",
          account: connection.account,
          connectionGeneration: connection.generation
        };
      } catch {
        return {
          state: "reauthorization_required",
          account: connection.account,
          connectionGeneration: connection.generation
        };
      }
    }
    if (payload.kind === "browser_sign_in") {
      await driver.beginBrowserSignIn();
      return { accounts: await driver.discoverAccounts() };
    }
    if (payload.kind === "connect") {
      await driver.selectAccount({ login: payload.login });
      const identity = await driver.readIdentity(payload.login);
      const connection = await connections.select(operation.ownerUserId, {
        id: String(identity.id),
        login: identity.login
      });
      return {
        state: "connected",
        account: connection.account,
        connectionGeneration: connection.generation
      };
    }
    if (payload.kind === "disconnect") {
      await selected(operation, payload);
      const connection = await connections.select(operation.ownerUserId, null);
      return {
        state: "disconnected",
        account: null,
        connectionGeneration: connection.generation
      };
    }
    if (
      payload.kind === "repositories" ||
      payload.kind === "inbox" ||
      payload.kind === "pull_request_details"
    ) {
      const connection = await selected(operation, payload),
        login = connection.account!.login;
      const page = Number(
        payload.kind === "pull_request_details" ? 1 : (payload.cursor ?? 1)
      );
      if (payload.kind === "repositories")
        return await driver.readRepositories({
          expectedAccountLogin: login,
          page
        });
      if (payload.kind === "inbox") {
        if (payload.repository) {
          const verified = await driver.readRepository({
            expectedAccountLogin: login,
            repo: payload.repository.fullName
          });
          if (verified.id !== payload.repository.id)
            throw new Error("PullRequestRepositoryChanged");
          const result = await driver.readPullRequests({
            expectedAccountLogin: login,
            repo: payload.repository.fullName,
            page
          });
          return {
            items: result.pullRequests.map((item) => ({
              ...item,
              repository: payload.repository,
              origin:
                typeof item.author === "string" &&
                item.author.toLowerCase() === login.toLowerCase()
                  ? "authored"
                  : Array.isArray(item.requestedReviewers) &&
                      item.requestedReviewers.some(
                        (name) =>
                          typeof name === "string" &&
                          name.toLowerCase() === login.toLowerCase()
                      )
                    ? "requested_review"
                    : null
            })),
            hasMore: result.hasMore,
            nextCursor: result.hasMore ? String(page + 1) : null
          };
        }
        const result = await driver.readInbox({
          expectedAccountLogin: login,
          page
        });
        const repositories: Awaited<
          ReturnType<typeof driver.readRepository>
        >[] = [];
        const names = [...new Set(result.items.map((item) => item.repository))];
        for (let offset = 0; offset < names.length; offset += 4)
          repositories.push(
            ...(await Promise.all(
              names
                .slice(offset, offset + 4)
                .map((repo) =>
                  driver.readRepository({ expectedAccountLogin: login, repo })
                )
            ))
          );
        return {
          ...result,
          repositories,
          nextCursor: result.hasMore ? String(page + 1) : null
        };
      }
      const repository = await driver.readRepository({
        repo: payload.repository.fullName,
        expectedAccountLogin: login
      });
      if (String(repository.id) !== payload.repository.id)
        throw new Error("PullRequestRepositoryChanged");
      const detail = await driver.readPullRequest({
        expectedAccountLogin: login,
        repo: payload.repository.fullName,
        number: payload.pullRequestNumber
      });
      const context = await driver.readPullRequestContext({
        expectedAccountLogin: login,
        repo: payload.repository.fullName,
        number: payload.pullRequestNumber
      });
      const matching = await listMatchingPullRequestProjects({
        repository: repository.fullName,
        koedHome: options.koedHome
      });
      return {
        ...detail,
        repository: {
          id: repository.id,
          owner: repository.fullName.split("/")[0],
          name: repository.fullName.split("/")[1],
          fullName: repository.fullName
        },
        baseSha: detail.pullRequest.baseSha,
        headSha: detail.pullRequest.headSha,
        pullRequestNumber: detail.pullRequest.number,
        files: context.files,
        filesTruncated: context.filesTruncated,
        matchingProjects: matching.projects.map((project) => ({
          id: project.id,
          name: project.displayName
        })),
        matchingProjectsTruncated: matching.truncated,
        account: connection.account,
        connectionGeneration: connection.generation
      };
    }
    const { review, connection } = await verifyReview(
      operation,
      payload.reviewId,
      payload.kind === "reconcile_review" || payload.kind === "reconcile_push"
    );
    if (
      (payload.kind === "publish_review" || payload.kind === "push") &&
      payload.expectedReviewRevision !== review.revision
    )
      throw new Error("PullRequestReviewChanged");
    const login = connection.account!.login,
      repo = review.repository.fullName,
      number = review.pullRequestNumber;
    if (payload.kind === "prepare_checkout") {
      if (payload.expectedRevision !== review.revision)
        throw new Error("PullRequestReviewChanged");
      await checkoutFor(review);
      return {
        reviewId: review.id,
        baseSha: review.expectedBaseSha,
        headSha: review.expectedHeadSha,
        ready: true
      };
    }
    if (payload.kind === "publish_review") {
      const frozen = await options.authority.getFrozenReview(
        review.id,
        payload.frozenReviewId
      );
      if (frozen.digest !== payload.confirmationDigest)
        throw new Error("PullRequestFrozenConfirmationChanged");
      const repository = await driver.readRepository({
        repo,
        expectedAccountLogin: login
      });
      const detail = await driver.readPullRequest({
        expectedAccountLogin: login,
        repo,
        number
      });
      const pr = observedPullRequest(detail.pullRequest);
      assertPullRequestPublicationScope(
        review,
        frozen,
        {
          accountId: connection.account!.id,
          accountLogin: login,
          repositoryId: String(repository.id),
          baseSha: pr.baseSha,
          headSha: pr.headSha,
          state: pr.state,
          author: pr.author,
          merged: pr.merged
        },
        connection.generation
      );
      // Never retry a write whose outcome may be uncertain. The frozen marker
      // permits a later read-only reconciliation without posting another review.
      const context = await driver.readPullRequestContext({
        expectedAccountLogin: login,
        repo,
        number
      });
      const comments = validatePullRequestInlineFindings(
        frozen.findings,
        context.files
      );
      await assertCurrentConnection(operation, review);
      if (!(await options.authority.heartbeat(operation)))
        throw new Error("PullRequestOperationLeaseLost");
      const published = await driver.publishReview({
        expectedAccountLogin: login,
        repo,
        number,
        commitId: frozen.headSha,
        expectedHeadSha: frozen.headSha,
        event: frozen.event,
        body: frozen.body,
        comments
      });
      dispatchedWrites.add(operation.id);
      return published;
    }
    if (payload.kind === "reconcile_review") {
      const original = await options.authority.getOperation(
        payload.uncertainOperationId
      );
      if (
        original.ownerUserId !== operation.ownerUserId ||
        original.targetDeviceId !== operation.targetDeviceId ||
        original.targetDeploymentId !== operation.targetDeploymentId ||
        original.state !== "uncertain" ||
        original.payload.kind !== "publish_review" ||
        original.payload.reviewId !== review.id ||
        original.payload.frozenReviewId !== payload.frozenReviewId
      )
        throw new Error("PullRequestReconciliationScopeChanged");
      const frozen = await options.authority.getFrozenReview(
        review.id,
        payload.frozenReviewId
      );
      for (let page = 1; page <= 10; page++) {
        const result = await driver.readPublishedReview({
          expectedAccountLogin: login,
          repo,
          number,
          page
        });
        const match = result.reviews?.find(
          (item) =>
            item.body === frozen.body &&
            !item.bodyTruncated &&
            item.commitId === frozen.headSha &&
            item.author.toLowerCase() === login.toLowerCase() &&
            item.state ===
              {
                COMMENT: "COMMENTED",
                APPROVE: "APPROVED",
                REQUEST_CHANGES: "CHANGES_REQUESTED"
              }[frozen.event]
        );
        if (match) {
          const comments: {
            path: string;
            line: number;
            side: string;
            body: string;
          }[] = [];
          for (let commentPage = 1; commentPage <= 4; commentPage++) {
            const result = await driver.readPublishedReviewComments({
              expectedAccountLogin: login,
              repo,
              number,
              reviewId: match.id,
              page: commentPage
            });
            if (result.bodyTruncated)
              throw new Error("PullRequestReconciliationIncomplete");
            comments.push(
              ...result.comments.map(({ path, line, side, body }) => ({
                path,
                line,
                side,
                body
              }))
            );
            if (!result.hasMore) break;
            if (commentPage === 4)
              throw new Error("PullRequestReconciliationIncomplete");
          }
          const canonical = (
            items: readonly {
              path: string;
              line: number;
              side: string;
              body: string;
            }[]
          ) =>
            JSON.stringify(
              [...items].sort((a, b) =>
                JSON.stringify(a).localeCompare(JSON.stringify(b))
              )
            );
          const expected = frozen.findings.map((item) => ({
            path: item.path,
            line: item.line!,
            side: item.side!,
            body: item.body
          }));
          if (canonical(comments) !== canonical(expected))
            throw new Error("PullRequestReconciliationMismatch");
          return {
            confirmed: true,
            uncertainOperationId: original.id,
            frozenReviewId: frozen.id,
            reviewId: review.id,
            frozenDigest: frozen.digest,
            body: frozen.body,
            headSha: frozen.headSha,
            event: frozen.event,
            commentsDigest: createHash("sha256")
              .update(JSON.stringify(frozen.findings))
              .digest("hex"),
            githubReviewId: match.id
          };
        }
        if (!result.hasMore) break;
      }
      return { confirmed: false, uncertainOperationId: original.id };
    }
    const checkoutScope = await options.resolveCheckout(review);
    if (
      !checkoutScope ||
      !checkoutScope.path ||
      !Number.isSafeInteger(checkoutScope.executionGeneration) ||
      checkoutScope.executionGeneration < 1
    )
      throw new Error("PullRequestCheckoutUnavailable");
    const checkout = checkoutScope.path;
    if (payload.kind === "prepare_push") {
      if (payload.expectedRevision !== review.revision)
        throw new Error("PullRequestReviewChanged");
      const proposal = await options.preparePush(
        review,
        checkout,
        checkoutScope.executionGeneration
      );
      if (
        proposal.executionId !== review.executionId ||
        proposal.executionGeneration !== checkoutScope.executionGeneration
      )
        throw new Error("PullRequestExecutionChanged");
      return proposal;
    }
    if (payload.kind === "push" || payload.kind === "reconcile_push") {
      const proposal = await options.authority.getOperation(
        payload.pushProposalId
      );
      if (
        proposal.ownerUserId !== operation.ownerUserId ||
        proposal.targetDeviceId !== options.deviceId ||
        proposal.payload.kind !== "prepare_push" ||
        proposal.payload.reviewId !== review.id ||
        proposal.state !== "completed" ||
        !proposal.result ||
        (payload.kind === "push" &&
          proposal.result.diffDigest !== payload.confirmationDigest)
      )
        throw new Error("PullRequestPushConfirmationChanged");
      if (payload.kind === "reconcile_push") {
        const original = await options.authority.getOperation(
          payload.uncertainOperationId
        );
        if (
          original.ownerUserId !== operation.ownerUserId ||
          original.targetDeviceId !== operation.targetDeviceId ||
          original.targetDeploymentId !== operation.targetDeploymentId ||
          original.state !== "uncertain" ||
          original.payload.kind !== "push" ||
          original.payload.reviewId !== review.id ||
          original.payload.pushProposalId !== payload.pushProposalId
        )
          throw new Error("PullRequestReconciliationScopeChanged");
        return {
          ...(await options.reconcilePush(review, proposal.result, checkout)),
          uncertainOperationId: original.id,
          pushProposalId: proposal.id,
          reviewId: review.id
        };
      }
      if (
        proposal.result.executionId !== review.executionId ||
        proposal.result.executionGeneration !==
          checkoutScope.executionGeneration
      )
        throw new Error("PullRequestExecutionChanged");
      if (!(await options.authority.heartbeat(operation)))
        throw new Error("PullRequestOperationLeaseLost");
      const pushed = await options.push(
        review,
        proposal.result,
        checkout,
        checkoutScope.executionGeneration,
        () =>
          assertCurrentPushScope(
            operation,
            review,
            checkout,
            checkoutScope.executionGeneration
          )
      );
      dispatchedWrites.add(operation.id);
      return pushed;
    }
    throw new Error("PullRequestOperationUnsupported");
  };
  const execute = async (
    operation: PullRequestOperationRecord
  ): Promise<PullRequestOperationResult> => {
    const kind = operation.payload.kind;
    if (
      kind === "connect" ||
      kind === "disconnect" ||
      kind === "browser_sign_in" ||
      kind === "publish_review" ||
      kind === "push"
    )
      return withAccountMutationLock(() => executeOperation(operation));
    return executeOperation(operation);
  };
  const checkoutFor = async (review: PullRequestReviewRecord) => {
    const connection = await connections.read(review.ownerUserId);
    if (
      !connection.account ||
      connection.account.id !== review.account.id ||
      connection.generation !== review.connectionGeneration
    )
      throw new Error("PullRequestConnectionChanged");
    return preparePullRequestCheckout({
      koedHome: options.koedHome,
      scope: {
        reviewId: review.id,
        repository: review.repository.fullName,
        number: review.pullRequestNumber,
        accountLogin: review.account.login,
        baseSha: review.expectedBaseSha,
        headSha: review.expectedHeadSha
      },
      observe: async () => {
        const identity = await driver.readIdentity(review.account.login);
        const repository = await driver.readRepository({
          expectedAccountLogin: review.account.login,
          repo: review.repository.fullName
        });
        if (
          String(identity.id) !== review.account.id ||
          String(repository.id) !== review.repository.id
        )
          throw new Error("PullRequestRepositoryChanged");
        const { pullRequest } = await driver.readPullRequest({
          expectedAccountLogin: review.account.login,
          repo: review.repository.fullName,
          number: review.pullRequestNumber
        });
        return {
          accountLogin: identity.login,
          repository: repository.fullName,
          baseSha: observedPullRequest(pullRequest).baseSha,
          headSha: observedPullRequest(pullRequest).headSha
        };
      }
    });
  };
  const runOnce = async () => {
    const operations = await options.authority.claim({
      runnerId,
      limit: 1,
      leaseMs: 300000
    });
    for (const operation of operations) {
      let lost = false;
      const heartbeat = setInterval(() => {
        void options.authority
          .heartbeat(operation)
          .then((ok) => {
            if (!ok) lost = true;
          })
          .catch(() => {
            lost = true;
          });
      }, 15000);
      heartbeat.unref?.();
      try {
        if (!(await options.authority.heartbeat(operation)))
          throw new Error("PullRequestOperationLeaseLost");
        const result = await execute(operation);
        if (lost) throw new Error("PullRequestOperationLeaseLost");
        await options.authority.complete(operation, result);
      } catch (error) {
        const code =
          error instanceof Error &&
          /^[A-Za-z][A-Za-z0-9_]{0,119}$/.test(error.message)
            ? error.message
            : "PullRequestOperationFailed";
        const uncertain =
          dispatchedWrites.has(operation.id) ||
          code === "github_publication_uncertain" ||
          code === "PullRequestPushUncertain";
        await options.authority
          .fail(operation, code, uncertain)
          .catch(() => undefined);
      } finally {
        clearInterval(heartbeat);
        dispatchedWrites.delete(operation.id);
      }
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = runOnce()
        .catch((error) =>
          options.onError?.(
            error instanceof Error ? error.name : "PullRequestRunnerError"
          )
        )
        .finally(() => {
          inFlight = null;
          schedule();
        });
    }, 1000);
    timer.unref?.();
  };
  return {
    runOnce,
    execute,
    checkoutFor,
    getReviewForExecution: options.authority.getReviewForExecution,
    markReviewed: options.authority.markReviewed,
    start() {
      if (!timer && !inFlight) schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await inFlight;
    }
  };
};
