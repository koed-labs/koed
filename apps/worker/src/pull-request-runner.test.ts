import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createPullRequestRunner,
  type PullRequestRunnerAuthority
} from "./pull-request-runner.js";
import type {
  PullRequestOperationRecord,
  PullRequestReviewRecord,
  PullRequestFrozenReview
} from "@koed/shared/pull-requests";
import { createGithubDelegatedCli } from "@koed/shared/github-delegated";
import { createPullRequestConnectionStore } from "./pull-request-connection.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "koed-pr-runner-"));
  roots.push(home);
  await mkdir(join(home, "config"));
  const github = {
    discoverAccounts: vi.fn(async () => [{ login: "alice" }]),
    readIdentity: vi.fn(async () => ({ id: "42", login: "alice" })),
    selectAccount: vi.fn(async () => ({ id: "42", login: "alice" })),
    readRepositories: vi.fn(async () => ({
      repositories: [],
      hasMore: false,
      page: 1
    }))
  };
  const authority = {
    claim: vi.fn(async () => []),
    heartbeat: vi.fn(async () => true),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    getReview: vi.fn(),
    getReviewForExecution: vi.fn(async () => null),
    getFrozenReview: vi.fn(),
    getOperation: vi.fn(),
    markReviewed: vi.fn(async () => {})
  } as unknown as PullRequestRunnerAuthority;
  const pushDispatches: string[] = [];
  const push = vi.fn(
    async (
      _review,
      _proposal,
      _checkout,
      _executionGeneration,
      assertDispatchAllowed: () => Promise<void>
    ) => {
      await assertDispatchAllowed();
      pushDispatches.push("dispatched");
      return { pushed: true } as never;
    }
  );
  const resolveCheckout = vi.fn(async () => ({
    path: "/checkout",
    executionGeneration: 9
  }));
  const runner = createPullRequestRunner({
    authority,
    authorityId: "local",
    koedHome: home,
    deviceId: "device",
    deploymentId: "deployment",
    github: github as unknown as ReturnType<typeof createGithubDelegatedCli>,
    resolveCheckout,
    preparePush: vi.fn(),
    push,
    reconcilePush: vi.fn()
  });
  const operation = (
    payload: PullRequestOperationRecord["payload"]
  ): PullRequestOperationRecord =>
    ({
      id: "operation",
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      targetDeviceId: "device",
      targetDeploymentId: "deployment",
      leaseToken: "lease",
      payload
    }) as PullRequestOperationRecord;
  const connectionStore = createPullRequestConnectionStore(home, "local");
  return {
    runner,
    github,
    authority,
    operation,
    home,
    connectionStore,
    push,
    pushDispatches,
    resolveCheckout
  };
};
it("does not silently adopt an installed GitHub account; connection requires explicit selection", async () => {
  const { runner, github, operation } = await fixture();
  expect(
    await runner.execute(operation({ kind: "connection_status" }))
  ).toMatchObject({ state: "disconnected", account: null });
  expect(github.readIdentity).not.toHaveBeenCalled();
  await expect(
    runner.execute(
      operation({
        kind: "repositories",
        account: { id: "42", login: "alice" },
        connectionGeneration: 1,
        cursor: null
      })
    )
  ).rejects.toThrow("PullRequestConnectionRequired");
  await runner.execute(operation({ kind: "connect", login: "alice" }));
  await runner.execute(
    operation({
      kind: "repositories",
      account: { id: "42", login: "alice" },
      connectionGeneration: 2,
      cursor: null
    })
  );
  expect(github.readIdentity).toHaveBeenCalledWith("alice");
  expect(github.readRepositories).toHaveBeenCalledOnce();
});
it("rejects stale grants, other computer scopes and revoked connections before any read", async () => {
  const { runner, github, operation } = await fixture();
  await runner.execute(operation({ kind: "connect", login: "alice" }));
  const read = operation({
    kind: "repositories",
    account: { id: "42", login: "alice" },
    connectionGeneration: 2,
    cursor: null
  });
  await expect(
    runner.execute({ ...read, targetDeviceId: "other" })
  ).rejects.toThrow("PullRequestRunnerScopeChanged");
  await expect(
    runner.execute({
      ...read,
      payload: {
        ...read.payload,
        connectionGeneration: 3
      } as typeof read.payload
    })
  ).rejects.toThrow("PullRequestConnectionChanged");
  await runner.execute(
    operation({
      kind: "disconnect",
      account: { id: "42", login: "alice" },
      connectionGeneration: 2
    })
  );
  await expect(runner.execute(read)).rejects.toThrow(
    "PullRequestConnectionRequired"
  );
  expect(github.readRepositories).not.toHaveBeenCalled();
});
it("lease loss before work is a definite failure and cannot dispatch a publication", async () => {
  const { runner, authority, operation } = await fixture();
  vi.mocked(authority.claim).mockResolvedValue([
    operation({
      kind: "publish_review",
      reviewId: "review",
      frozenReviewId: "frozen",
      confirmationDigest: "d".repeat(64),
      expectedReviewRevision: 1
    })
  ]);
  vi.mocked(authority.heartbeat).mockResolvedValue(false);
  await runner.runOnce();
  expect(authority.getReview).not.toHaveBeenCalled();
  expect(authority.fail).toHaveBeenCalledWith(
    expect.anything(),
    "PullRequestOperationLeaseLost",
    false
  );
});

const publicationFixture = async () => {
  const setup = await fixture();
  const { runner, github, authority, operation } = setup;
  await runner.execute(operation({ kind: "connect", login: "alice" }));
  const review = {
    id: "review",
    revision: 1,
    executionId: "44444444-4444-4444-8444-444444444444",
    reviewedExecutionGeneration: null,
    ownerUserId: operation({ kind: "accounts" }).ownerUserId,
    targetDeviceId: "device",
    targetDeploymentId: "deployment",
    account: { id: "42", login: "alice" },
    connectionGeneration: 2,
    repository: { id: "9", fullName: "team/code", owner: "team", name: "code" },
    pullRequestNumber: 7,
    expectedBaseSha: "a".repeat(40),
    expectedHeadSha: "b".repeat(40)
  } as PullRequestReviewRecord;
  const frozen = {
    id: "frozen",
    reviewId: review.id,
    accountId: "42",
    connectionGeneration: 2,
    baseSha: review.expectedBaseSha,
    headSha: review.expectedHeadSha,
    digest: "d".repeat(64),
    event: "COMMENT",
    body: "Reviewed.\n<!-- koed-review:frozen -->",
    findings: []
  } as unknown as PullRequestFrozenReview;
  const delegated = Object.assign(github, {
    readRepository: vi.fn(async () => ({ id: "9", fullName: "team/code" })),
    readPullRequest: vi.fn(async () => ({
      pullRequest: {
        baseSha: review.expectedBaseSha,
        headSha: review.expectedHeadSha,
        state: "open",
        author: "bob",
        merged: false,
        number: 7
      }
    })),
    readPullRequestContext: vi.fn(async () => ({
      files: [],
      filesTruncated: false
    })),
    publishReview: vi.fn(async () => ({ id: 81 }))
  });
  vi.mocked(authority.getReview).mockResolvedValue(review);
  vi.mocked(authority.getFrozenReview).mockResolvedValue(frozen);
  const write = operation({
    kind: "publish_review",
    reviewId: review.id,
    frozenReviewId: frozen.id,
    confirmationDigest: frozen.digest,
    expectedReviewRevision: 1
  });
  vi.mocked(authority.claim).mockResolvedValue([write]);
  return { ...setup, delegated, review, frozen, write };
};
it("publishes the exact frozen body and preserves uncertainty if saving the result fails", async () => {
  const { runner, delegated, authority, frozen, write } =
    await publicationFixture();
  vi.mocked(authority.complete).mockRejectedValue(
    new Error("DatabaseUnavailable")
  );
  await runner.runOnce();
  expect(delegated.publishReview).toHaveBeenCalledExactlyOnceWith({
    expectedAccountLogin: "alice",
    repo: "team/code",
    number: 7,
    commitId: frozen.headSha,
    expectedHeadSha: frozen.headSha,
    event: "COMMENT",
    body: frozen.body,
    comments: []
  });
  expect(authority.fail).toHaveBeenCalledWith(
    write,
    "DatabaseUnavailable",
    true
  );
});
it("rejects a review publication when the selected connection generation changes during preflight", async () => {
  const { runner, delegated, authority, review, write, connectionStore } =
    await publicationFixture();
  vi.mocked(delegated.readPullRequestContext).mockImplementationOnce(
    async () => {
      await connectionStore.select(review.ownerUserId, review.account);
      return { files: [], filesTruncated: false };
    }
  );

  await runner.runOnce();

  expect(delegated.publishReview).not.toHaveBeenCalled();
  expect(authority.fail).toHaveBeenLastCalledWith(
    write,
    "PullRequestConnectionChanged",
    false
  );
});
it("passes a final connection fence to the push driver and rejects generation drift before dispatch", async () => {
  const {
    runner,
    github,
    authority,
    operation,
    connectionStore,
    push,
    pushDispatches
  } = await fixture();
  await runner.execute(operation({ kind: "connect", login: "alice" }));
  const review = {
    id: "review",
    revision: 4,
    executionId: "44444444-4444-4444-8444-444444444444",
    reviewedExecutionGeneration: null,
    ownerUserId: operation({ kind: "accounts" }).ownerUserId,
    targetDeviceId: "device",
    targetDeploymentId: "deployment",
    account: { id: "42", login: "alice" },
    connectionGeneration: 2,
    repository: { id: "9", fullName: "team/code", owner: "team", name: "code" },
    pullRequestNumber: 7,
    expectedBaseSha: "a".repeat(40),
    expectedHeadSha: "b".repeat(40)
  } as PullRequestReviewRecord;
  const proposal = {
    ...operation({
      kind: "prepare_push",
      reviewId: review.id,
      expectedRevision: 4
    }),
    id: "proposal",
    state: "completed",
    result: {
      diffDigest: "d".repeat(64),
      executionId: review.executionId,
      executionGeneration: 9
    }
  } as PullRequestOperationRecord;
  const write = operation({
    kind: "push",
    reviewId: review.id,
    pushProposalId: proposal.id,
    confirmationDigest: "d".repeat(64),
    expectedReviewRevision: review.revision
  });
  vi.mocked(authority.getReview).mockResolvedValue(review);
  vi.mocked(authority.getOperation).mockImplementationOnce(async () => {
    await connectionStore.select(review.ownerUserId, review.account);
    return proposal;
  });
  vi.mocked(authority.claim).mockResolvedValue([write]);

  await runner.runOnce();

  expect(github.readIdentity).toHaveBeenLastCalledWith("alice");
  expect(push).toHaveBeenCalledOnce();
  expect(pushDispatches).toEqual([]);
  expect(authority.fail).toHaveBeenLastCalledWith(
    write,
    "PullRequestConnectionChanged",
    false
  );
});
it("rejects a push when its trusted managed execution generation changes before dispatch", async () => {
  const {
    runner,
    authority,
    operation,
    push,
    pushDispatches,
    resolveCheckout
  } = await fixture();
  await runner.execute(operation({ kind: "connect", login: "alice" }));
  const review = {
    id: "review",
    revision: 4,
    executionId: "44444444-4444-4444-8444-444444444444",
    reviewedExecutionGeneration: null,
    ownerUserId: operation({ kind: "accounts" }).ownerUserId,
    targetDeviceId: "device",
    targetDeploymentId: "deployment",
    account: { id: "42", login: "alice" },
    connectionGeneration: 2,
    repository: { id: "9", fullName: "team/code", owner: "team", name: "code" },
    pullRequestNumber: 7,
    expectedBaseSha: "a".repeat(40),
    expectedHeadSha: "b".repeat(40)
  } as PullRequestReviewRecord;
  const proposal = {
    ...operation({
      kind: "prepare_push",
      reviewId: review.id,
      expectedRevision: 4
    }),
    id: "proposal",
    state: "completed",
    result: {
      diffDigest: "d".repeat(64),
      executionId: review.executionId,
      executionGeneration: 9
    }
  } as PullRequestOperationRecord;
  const write = operation({
    kind: "push",
    reviewId: review.id,
    pushProposalId: proposal.id,
    confirmationDigest: "d".repeat(64),
    expectedReviewRevision: review.revision
  });
  vi.mocked(authority.getReview).mockResolvedValue(review);
  vi.mocked(authority.getOperation).mockResolvedValue(proposal);
  vi.mocked(authority.claim).mockResolvedValue([write]);
  resolveCheckout
    .mockResolvedValueOnce({ path: "/checkout", executionGeneration: 9 })
    .mockResolvedValueOnce({ path: "/checkout", executionGeneration: 10 });

  await runner.runOnce();

  expect(push).toHaveBeenCalledOnce();
  expect(pushDispatches).toEqual([]);
  expect(authority.fail).toHaveBeenLastCalledWith(
    write,
    "PullRequestExecutionChanged",
    false
  );
});
it("refreshes the operation lease at the final push dispatch fence", async () => {
  const { runner, authority, operation, push, pushDispatches } =
    await fixture();
  await runner.execute(operation({ kind: "connect", login: "alice" }));
  const review = {
    id: "review",
    revision: 4,
    executionId: "44444444-4444-4444-8444-444444444444",
    reviewedExecutionGeneration: null,
    ownerUserId: operation({ kind: "accounts" }).ownerUserId,
    targetDeviceId: "device",
    targetDeploymentId: "deployment",
    account: { id: "42", login: "alice" },
    connectionGeneration: 2,
    repository: { id: "9", fullName: "team/code", owner: "team", name: "code" },
    pullRequestNumber: 7,
    expectedBaseSha: "a".repeat(40),
    expectedHeadSha: "b".repeat(40)
  } as PullRequestReviewRecord;
  const proposal = {
    ...operation({
      kind: "prepare_push",
      reviewId: review.id,
      expectedRevision: 4
    }),
    id: "proposal",
    state: "completed",
    result: {
      diffDigest: "d".repeat(64),
      executionId: review.executionId,
      executionGeneration: 9
    }
  } as PullRequestOperationRecord;
  const write = operation({
    kind: "push",
    reviewId: review.id,
    pushProposalId: proposal.id,
    confirmationDigest: "d".repeat(64),
    expectedReviewRevision: review.revision
  });
  vi.mocked(authority.getReview).mockResolvedValue(review);
  vi.mocked(authority.getOperation).mockResolvedValue(proposal);
  vi.mocked(authority.claim).mockResolvedValue([write]);
  vi.mocked(authority.heartbeat)
    .mockResolvedValueOnce(true) // Initial lease check in runOnce.
    .mockResolvedValueOnce(true) // Preflight before the push driver runs.
    .mockResolvedValueOnce(false); // Final fence immediately before git push.

  await runner.runOnce();

  expect(push).toHaveBeenCalledOnce();
  expect(pushDispatches).toEqual([]);
  expect(authority.fail).toHaveBeenLastCalledWith(
    write,
    "PullRequestOperationLeaseLost",
    false
  );
});
it("fails stale publication before dispatch and retains ambiguous delegated writes as uncertain", async () => {
  const { runner, delegated, authority, review, write } =
    await publicationFixture();
  delegated.readPullRequest.mockResolvedValueOnce({
    pullRequest: {
      baseSha: review.expectedBaseSha,
      headSha: "c".repeat(40),
      state: "open",
      author: "bob",
      merged: false,
      number: 7
    }
  });
  await runner.runOnce();
  expect(delegated.publishReview).not.toHaveBeenCalled();
  expect(authority.fail).toHaveBeenLastCalledWith(
    write,
    "PullRequestReviewOutdated",
    false
  );
  delegated.publishReview.mockRejectedValueOnce(
    new Error("github_publication_uncertain")
  );
  await runner.runOnce();
  expect(authority.fail).toHaveBeenLastCalledWith(
    write,
    "github_publication_uncertain",
    true
  );
});
it("returns verified repository identity and actual delegated detail fields to Studio", async () => {
  const { runner, operation, review } = await publicationFixture();
  const result = await runner.execute(
    operation({
      kind: "pull_request_details",
      account: review.account,
      connectionGeneration: 2,
      repository: review.repository,
      pullRequestNumber: 7
    })
  );
  expect(result).toMatchObject({
    repository: review.repository,
    baseSha: review.expectedBaseSha,
    headSha: review.expectedHeadSha,
    pullRequestNumber: 7,
    matchingProjects: [],
    files: []
  });
});
