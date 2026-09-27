/**
 * Pure contracts for the first Studio review slice.
 *
 * These are renderer-safe projections. Credentials, access tokens, and
 * publication side effects belong to a trusted connector/service boundary.
 */

export type GitHubIdentity = Readonly<{
  id: string;
  login: string;
}>;

export type GitHubRepositoryIdentity = Readonly<{
  id: string;
  owner: string;
  name: string;
  fullName: string;
}>;

export type GitHubConnectionHealth =
  | "healthy"
  | "degraded"
  | "reauthorization-required"
  | "disconnected";

export type GitHubConnectionProjectionInput = Readonly<{
  connectionId: string;
  account: GitHubIdentity;
  repositoryScope: ReadonlyArray<GitHubRepositoryIdentity>;
  selectedRepositoryIds: ReadonlyArray<string>;
  health: GitHubConnectionHealth;
  observedAt: string;
  lastSuccessfulSyncAt: string | null;
  observationRevision: string;
}>;

/** Safe to retain in renderer state or UI indexes: it has no credential field. */
export type GitHubConnectionProjection = Readonly<{
  provider: "github";
  connectionId: string;
  account: GitHubIdentity;
  repositoryScope: ReadonlyArray<GitHubRepositoryIdentity>;
  selectedRepositoryIds: ReadonlyArray<string>;
  health: GitHubConnectionHealth;
  observedAt: string;
  lastSuccessfulSyncAt: string | null;
  observationRevision: string;
}>;

export function projectGitHubConnection(
  input: GitHubConnectionProjectionInput
): GitHubConnectionProjection {
  return {
    provider: "github",
    connectionId: input.connectionId,
    account: { id: input.account.id, login: input.account.login },
    repositoryScope: input.repositoryScope.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      fullName: repository.fullName
    })),
    selectedRepositoryIds: [...input.selectedRepositoryIds],
    health: input.health,
    observedAt: input.observedAt,
    lastSuccessfulSyncAt: input.lastSuccessfulSyncAt,
    observationRevision: input.observationRevision
  };
}

export type PullRequestIdentity = Readonly<{
  repository: GitHubRepositoryIdentity;
  number: number;
  nodeId?: string;
}>;

export type PullRequestProjection = Readonly<{
  identity: PullRequestIdentity;
  title: string;
  state: "open" | "closed";
  isDraft: boolean;
  author: GitHubIdentity | null;
  requestedReviewers: ReadonlyArray<GitHubIdentity>;
  baseSha: string;
  headSha: string;
}>;

export type PullRequestViewerClassification = Readonly<{
  authored: boolean;
  reviewRequested: boolean;
}>;

function normalizedLogin(login: string) {
  return login.trim().toLocaleLowerCase("en-US");
}

export function sameGitHubIdentity(
  left: GitHubIdentity | null,
  right: GitHubIdentity | null
) {
  if (!left || !right) return false;
  if (left.id && right.id) return left.id === right.id;
  const leftLogin = normalizedLogin(left.login);
  const rightLogin = normalizedLogin(right.login);
  return leftLogin.length > 0 && leftLogin === rightLogin;
}

export function classifyPullRequestForViewer(
  pullRequest: PullRequestProjection,
  viewer: GitHubIdentity
): PullRequestViewerClassification {
  return {
    authored: sameGitHubIdentity(pullRequest.author, viewer),
    reviewRequested: pullRequest.requestedReviewers.some((reviewer) =>
      sameGitHubIdentity(reviewer, viewer)
    )
  };
}

export type PullRequestTab = "all" | "authored" | "reviewing";

export function pullRequestMatchesTab(
  pullRequest: PullRequestProjection,
  tab: PullRequestTab,
  viewer: GitHubIdentity
) {
  if (tab === "all") return true;
  const classification = classifyPullRequestForViewer(pullRequest, viewer);
  return tab === "authored"
    ? classification.authored
    : classification.reviewRequested;
}

export function filterPullRequestsForTab(
  pullRequests: ReadonlyArray<PullRequestProjection>,
  tab: PullRequestTab,
  viewer: GitHubIdentity
) {
  return pullRequests.filter((pullRequest) =>
    pullRequestMatchesTab(pullRequest, tab, viewer)
  );
}

export type ReviewScope = Readonly<{
  repository: GitHubRepositoryIdentity;
  pullRequest: PullRequestIdentity;
  baseSha: string;
  headSha: string;
  patchDigest: string;
}>;

export function reviewScopeFingerprint(scope: ReviewScope) {
  return JSON.stringify({
    repository: {
      id: scope.repository.id,
      owner: scope.repository.owner,
      name: scope.repository.name,
      fullName: scope.repository.fullName.toLocaleLowerCase("en-US")
    },
    pullRequest: {
      repositoryId: scope.pullRequest.repository.id,
      number: scope.pullRequest.number,
      nodeId: scope.pullRequest.nodeId ?? null
    },
    baseSha: scope.baseSha,
    headSha: scope.headSha,
    patchDigest: scope.patchDigest
  });
}

export function reviewScopesMatch(left: ReviewScope, right: ReviewScope) {
  return reviewScopeFingerprint(left) === reviewScopeFingerprint(right);
}

export function isReviewScopeStale(
  frozenScope: ReviewScope,
  observedScope: ReviewScope
) {
  return !reviewScopesMatch(frozenScope, observedScope);
}

export type ReviewRunState =
  | "queued"
  | "running"
  | "needs-attention"
  | "completed"
  | "failed"
  | "cancelled";

export type ReviewEvidence = Readonly<{
  id: string;
  integrity: "verified" | "unverified" | "invalid";
}>;

export type ReviewRun = Readonly<{
  id: string;
  scope: ReviewScope;
  state: ReviewRunState;
  requiredStagesComplete: boolean;
  verdict: "pass" | "findings" | null;
  verdictSupported: boolean;
  publicationSeedIntegrity: "verified" | "invalid" | "missing";
  evidence: ReadonlyArray<ReviewEvidence>;
}>;

export type ReviewRunReadinessReason =
  | "run-not-completed"
  | "required-stages-incomplete"
  | "scope-stale"
  | "evidence-not-verified"
  | "verdict-unavailable"
  | "publication-seed-not-verified";

export type ReviewRunReadiness = Readonly<{
  ready: boolean;
  scopeCurrent: boolean;
  reasons: ReadonlyArray<ReviewRunReadinessReason>;
}>;

export function reviewRunReadiness(
  run: ReviewRun,
  observedScope: ReviewScope
): ReviewRunReadiness {
  const scopeCurrent = reviewScopesMatch(run.scope, observedScope);
  const reasons: ReviewRunReadinessReason[] = [];
  if (run.state !== "completed") reasons.push("run-not-completed");
  if (!run.requiredStagesComplete) reasons.push("required-stages-incomplete");
  if (!scopeCurrent) reasons.push("scope-stale");
  if (
    run.evidence.length === 0 ||
    run.evidence.some((evidence) => evidence.integrity !== "verified")
  ) {
    reasons.push("evidence-not-verified");
  }
  if (!run.verdictSupported || run.verdict === null) {
    reasons.push("verdict-unavailable");
  }
  if (run.publicationSeedIntegrity !== "verified") {
    reasons.push("publication-seed-not-verified");
  }
  return { ready: reasons.length === 0, scopeCurrent, reasons };
}

export function isReviewRunReady(run: ReviewRun, observedScope: ReviewScope) {
  return reviewRunReadiness(run, observedScope).ready;
}

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type FindingStatus = "outstanding" | "resolved" | "stale" | "disputed";

export type ReviewFindingEvidence = Readonly<{
  sourceId: string;
  detail: string;
}>;

export type ReviewFinding = Readonly<{
  id: string;
  runId: string;
  scope: ReviewScope;
  severity: FindingSeverity;
  status: FindingStatus;
  title: string;
  body: string;
  evidence: ReadonlyArray<ReviewFindingEvidence>;
  cause: string;
  impact: string;
  requestedChange: string;
  completionCriteria: string;
  path?: string;
  line?: number;
}>;

export function canTransitionFindingStatus(
  from: FindingStatus,
  to: FindingStatus
) {
  if (from === to) return true;
  if (from === "outstanding") {
    return to === "resolved" || to === "stale" || to === "disputed";
  }
  return to === "outstanding";
}

export type ReviewDraftState =
  | "editing"
  | "confirmed"
  | "published"
  | "abandoned";

export type ReviewDraftFinding = Readonly<{
  findingId: string;
  included: boolean;
  body: string;
}>;

export type ReviewDraft = Readonly<{
  id: string;
  runId: string;
  scope: ReviewScope;
  revision: number;
  state: ReviewDraftState;
  summary: string;
  findings: ReadonlyArray<ReviewDraftFinding>;
  action: PublicationAction;
  payloadDigest: string;
}>;

export function canTransitionReviewDraft(
  from: ReviewDraftState,
  to: ReviewDraftState
) {
  if (from === to) return true;
  if (from === "editing") return to === "confirmed" || to === "abandoned";
  if (from === "confirmed") return to === "editing" || to === "abandoned";
  return false;
}

export type ReviewConfirmation = Readonly<{
  draftId: string;
  revision: number;
  scope: ReviewScope;
  action: PublicationAction;
  /** Explicit confirmation is not authority; this digest comes from the trusted host. */
  payloadDigest: string;
}>;

export type PublicationAction = "comment" | "approve" | "request-changes";

export type PublicationAttemptState =
  | "not-attempted"
  | "succeeded"
  | "rejected"
  | "ambiguous"
  | "reconciled";

export function canTransitionPublication(
  from: PublicationAttemptState,
  to: PublicationAttemptState
) {
  if (from === to) return true;
  if (from === "not-attempted")
    return to === "succeeded" || to === "rejected" || to === "ambiguous";
  if (from === "ambiguous") return to === "reconciled";
  return false;
}

export function canRetryPublication(state: PublicationAttemptState) {
  // A publication identity is single-use. Retrying requires a fresh draft and
  // envelope, even when the provider reported a known rejection.
  switch (state) {
    case "not-attempted":
    case "succeeded":
    case "rejected":
    case "ambiguous":
    case "reconciled":
      return false;
  }
}

export type PublicationEligibilityReason =
  | "review-not-ready"
  | "scope-stale"
  | "draft-not-confirmed"
  | "draft-run-mismatch"
  | "draft-scope-mismatch"
  | "confirmation-missing"
  | "confirmation-draft-mismatch"
  | "confirmation-revision-mismatch"
  | "confirmation-scope-mismatch"
  | "confirmation-action-mismatch"
  | "confirmation-payload-mismatch"
  | "publication-already-succeeded"
  | "publication-already-attempted"
  | "publication-ambiguous";

export type PublicationEligibility = Readonly<{
  eligible: boolean;
  reasons: ReadonlyArray<PublicationEligibilityReason>;
}>;

export type PublicationEligibilityInput = Readonly<{
  run: ReviewRun;
  observedScope: ReviewScope;
  draft: ReviewDraft;
  confirmation: ReviewConfirmation | null;
  previousAttempt: PublicationAttemptState;
}>;

export function publicationEligibility(
  input: PublicationEligibilityInput
): PublicationEligibility {
  const readiness = reviewRunReadiness(input.run, input.observedScope);
  const reasons: PublicationEligibilityReason[] = [];
  if (!readiness.ready) reasons.push("review-not-ready");
  if (!readiness.scopeCurrent) reasons.push("scope-stale");
  if (input.draft.state !== "confirmed") reasons.push("draft-not-confirmed");
  if (input.draft.runId !== input.run.id) reasons.push("draft-run-mismatch");
  if (!reviewScopesMatch(input.draft.scope, input.observedScope)) {
    reasons.push("draft-scope-mismatch");
  }

  const confirmation = input.confirmation;
  if (!confirmation) {
    reasons.push("confirmation-missing");
  } else {
    if (confirmation.draftId !== input.draft.id)
      reasons.push("confirmation-draft-mismatch");
    if (confirmation.revision !== input.draft.revision) {
      reasons.push("confirmation-revision-mismatch");
    }
    if (!reviewScopesMatch(confirmation.scope, input.observedScope)) {
      reasons.push("confirmation-scope-mismatch");
    }
    if (confirmation.action !== input.draft.action) {
      reasons.push("confirmation-action-mismatch");
    }
    if (confirmation.payloadDigest !== input.draft.payloadDigest) {
      reasons.push("confirmation-payload-mismatch");
    }
  }

  if (input.previousAttempt !== "not-attempted") {
    if (input.previousAttempt === "succeeded") {
      reasons.push("publication-already-succeeded");
    } else {
      reasons.push("publication-already-attempted");
      if (input.previousAttempt === "ambiguous") {
        reasons.push("publication-ambiguous");
      }
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

export function isPublicationEligible(input: PublicationEligibilityInput) {
  return publicationEligibility(input).eligible;
}
