import assert from "node:assert/strict";
import test from "node:test";
// Node 24's native TypeScript runner requires the source extension here.
// prettier-ignore
// @ts-expect-error -- Node's native test runner needs the source extension.
import { canRetryPublication, canTransitionFindingStatus, canTransitionPublication, canTransitionReviewDraft, classifyPullRequestForViewer, filterPullRequestsForTab, isPublicationEligible, isReviewRunReady, isReviewScopeStale, publicationEligibility, projectGitHubConnection, type GitHubIdentity, type GitHubRepositoryIdentity, type PullRequestProjection, type ReviewDraft, type ReviewRun, type ReviewScope } from "./studio-review.ts";

const viewer: GitHubIdentity = { id: "user-1", login: "Reviewer" };
const repository: GitHubRepositoryIdentity = {
  id: "repo-1",
  owner: "koed",
  name: "studio",
  fullName: "koed/studio"
};
const scope: ReviewScope = {
  repository,
  pullRequest: { repository, number: 42, nodeId: "pr-42" },
  baseSha: "base-1",
  headSha: "head-1",
  patchDigest: "patch-1"
};

const run = (overrides: Partial<ReviewRun> = {}): ReviewRun => ({
  id: "run-1",
  scope,
  state: "completed",
  requiredStagesComplete: true,
  verdict: "findings",
  verdictSupported: true,
  publicationSeedIntegrity: "verified",
  evidence: [{ id: "evidence-1", integrity: "verified" }],
  ...overrides
});

const draft = (overrides: Partial<ReviewDraft> = {}): ReviewDraft => ({
  id: "draft-1",
  runId: "run-1",
  scope,
  revision: 3,
  state: "confirmed",
  summary: "The review is ready.",
  findings: [],
  action: "comment",
  payloadDigest: "payload-3",
  ...overrides
});

const pullRequest = (
  overrides: Partial<PullRequestProjection> = {}
): PullRequestProjection => ({
  identity: { repository, number: 42 },
  title: "Improve review flow",
  state: "closed",
  isDraft: false,
  author: { id: "author-1", login: "author" },
  requestedReviewers: [{ id: viewer.id, login: viewer.login }],
  baseSha: scope.baseSha,
  headSha: scope.headSha,
  ...overrides
});

test("projects GitHub connection state without retaining credentials", () => {
  const projection = projectGitHubConnection({
    connectionId: "connection-1",
    account: { ...viewer, secret: "do-not-project" } as GitHubIdentity,
    repositoryScope: [
      { ...repository, secret: "do-not-project" } as GitHubRepositoryIdentity
    ],
    selectedRepositoryIds: [repository.id],
    health: "healthy",
    observedAt: "2026-09-22T10:00:00.000Z",
    lastSuccessfulSyncAt: "2026-09-22T09:59:00.000Z",
    observationRevision: "observation-1"
  });

  assert.equal(projection.provider, "github");
  assert.equal("token" in projection, false);
  assert.equal("accessToken" in projection, false);
  assert.deepEqual(projection.account, viewer);
  assert.notEqual(projection.repositoryScope, [repository]);
  assert.equal("secret" in projection.account, false);
  assert.equal("secret" in projection.repositoryScope[0]!, false);
});

test("classifies authored and requested-review PRs from identity, not open status", () => {
  const closed = pullRequest({
    author: viewer,
    requestedReviewers: []
  });
  assert.deepEqual(classifyPullRequestForViewer(closed, viewer), {
    authored: true,
    reviewRequested: false
  });

  const requested = pullRequest({
    state: "open",
    author: { id: "someone-else", login: "other" }
  });
  assert.deepEqual(classifyPullRequestForViewer(requested, viewer), {
    authored: false,
    reviewRequested: true
  });
});

test("does not classify blank-login identities as the same account", () => {
  assert.deepEqual(
    classifyPullRequestForViewer(
      pullRequest({ author: { id: "", login: "" }, requestedReviewers: [] }),
      { id: "", login: "" }
    ),
    { authored: false, reviewRequested: false }
  );
});

test("tabs use actual author and reviewer identities, including closed PRs", () => {
  const authored = pullRequest({ author: viewer, requestedReviewers: [] });
  const requested = pullRequest({
    identity: { repository, number: 43 },
    state: "closed",
    author: { id: "other", login: "other" }
  });
  const unrelated = pullRequest({
    identity: { repository, number: 44 },
    state: "open",
    author: { id: "other", login: "other" },
    requestedReviewers: []
  });

  assert.deepEqual(
    filterPullRequestsForTab(
      [authored, requested, unrelated],
      "authored",
      viewer
    ).map((item) => item.identity.number),
    [42]
  );
  assert.deepEqual(
    filterPullRequestsForTab(
      [authored, requested, unrelated],
      "reviewing",
      viewer
    ).map((item) => item.identity.number),
    [43]
  );
});

test("a changed head or patch makes the immutable run scope stale", () => {
  const changedHead = { ...scope, headSha: "head-2" };
  assert.equal(isReviewScopeStale(scope, changedHead), true);
  assert.equal(isReviewRunReady(run(), changedHead), false);
  assert.equal(
    run().state === "completed" && isReviewRunReady(run(), scope),
    true
  );
});

test("failed, cancelled, and unverified runs cannot become ready", () => {
  assert.equal(isReviewRunReady(run({ state: "failed" }), scope), false);
  assert.equal(isReviewRunReady(run({ state: "cancelled" }), scope), false);
  assert.equal(
    isReviewRunReady(
      run({ evidence: [{ id: "evidence-1", integrity: "unverified" }] }),
      scope
    ),
    false
  );
  assert.equal(isReviewRunReady(run({ evidence: [] }), scope), false);
  assert.equal(
    isReviewRunReady(run({ requiredStagesComplete: false }), scope),
    false
  );
  assert.equal(
    isReviewRunReady(run({ verdictSupported: false }), scope),
    false
  );
  assert.equal(
    isReviewRunReady(run({ publicationSeedIntegrity: "invalid" }), scope),
    false
  );
});

test("finding transitions are explicit and do not mutate canonical findings", () => {
  assert.equal(canTransitionFindingStatus("outstanding", "resolved"), true);
  assert.equal(canTransitionFindingStatus("outstanding", "disputed"), true);
  assert.equal(canTransitionFindingStatus("stale", "outstanding"), true);
  assert.equal(canTransitionFindingStatus("resolved", "outstanding"), true);
  assert.equal(canTransitionFindingStatus("resolved", "disputed"), false);
  assert.equal(canTransitionFindingStatus("disputed", "resolved"), false);
});

test("draft transitions keep published and abandoned drafts terminal", () => {
  assert.equal(canTransitionReviewDraft("editing", "confirmed"), true);
  assert.equal(canTransitionReviewDraft("confirmed", "editing"), true);
  assert.equal(canTransitionReviewDraft("published", "editing"), false);
  assert.equal(canTransitionReviewDraft("abandoned", "confirmed"), false);
});

test("publication requires confirmation for the exact draft revision and scope", () => {
  const valid = {
    run: run(),
    observedScope: scope,
    draft: draft(),
    confirmation: {
      draftId: "draft-1",
      revision: 3,
      scope,
      action: "comment" as const,
      payloadDigest: "payload-3"
    },
    previousAttempt: "not-attempted" as const
  };
  assert.equal(isPublicationEligible(valid), true);

  const stale = publicationEligibility({
    ...valid,
    observedScope: { ...scope, headSha: "head-2" }
  });
  assert.equal(stale.eligible, false);
  assert.ok(stale.reasons.includes("scope-stale"));
  assert.ok(stale.reasons.includes("confirmation-scope-mismatch"));

  const mismatchedRevision = publicationEligibility({
    ...valid,
    confirmation: { ...valid.confirmation, revision: 2 }
  });
  assert.equal(mismatchedRevision.eligible, false);
  assert.ok(
    mismatchedRevision.reasons.includes("confirmation-revision-mismatch")
  );

  const mismatchedPayload = publicationEligibility({
    ...valid,
    confirmation: { ...valid.confirmation, payloadDigest: "payload-2" }
  });
  assert.equal(mismatchedPayload.eligible, false);
  assert.ok(
    mismatchedPayload.reasons.includes("confirmation-payload-mismatch")
  );

  const mismatchedAction = publicationEligibility({
    ...valid,
    confirmation: { ...valid.confirmation, action: "approve" }
  });
  assert.equal(mismatchedAction.eligible, false);
  assert.ok(mismatchedAction.reasons.includes("confirmation-action-mismatch"));

  const mismatchedDraftScope = publicationEligibility({
    ...valid,
    draft: draft({ scope: { ...scope, patchDigest: "patch-2" } })
  });
  assert.equal(mismatchedDraftScope.eligible, false);
  assert.ok(mismatchedDraftScope.reasons.includes("draft-scope-mismatch"));
});

test("ambiguous publication refuses blind retry and requires reconciliation", () => {
  const input = {
    run: run(),
    observedScope: scope,
    draft: draft(),
    confirmation: {
      draftId: "draft-1",
      revision: 3,
      scope,
      action: "comment" as const,
      payloadDigest: "payload-3"
    },
    previousAttempt: "ambiguous" as const
  };
  const eligibility = publicationEligibility(input);
  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.reasons.includes("publication-ambiguous"));
  assert.equal(canRetryPublication("ambiguous"), false);
  assert.equal(canRetryPublication("rejected"), false);
  assert.equal(canTransitionPublication("ambiguous", "reconciled"), true);
  assert.equal(canTransitionPublication("ambiguous", "succeeded"), false);
  assert.equal(canTransitionPublication("rejected", "succeeded"), false);

  for (const previousAttempt of [
    "succeeded",
    "rejected",
    "ambiguous",
    "reconciled"
  ] as const) {
    assert.equal(
      publicationEligibility({ ...input, previousAttempt }).eligible,
      false
    );
  }
});

test("editing or missing confirmation keeps publication blocked", () => {
  const base = {
    run: run(),
    observedScope: scope,
    draft: draft({ state: "editing" }),
    confirmation: null,
    previousAttempt: "not-attempted" as const
  };
  const eligibility = publicationEligibility(base);
  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.reasons.includes("draft-not-confirmed"));
  assert.ok(eligibility.reasons.includes("confirmation-missing"));
});
