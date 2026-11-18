const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const sha1 = (value) =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const sha256 = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const teamId = (value) =>
  typeof value === "string" && /^[A-Z0-9]{10}$/.test(value);
const version = (value) =>
  typeof value === "string" &&
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    value
  ) &&
  value.length <= 128;

export const validateDispatchContext = (context) => {
  if (
    !context ||
    context.repository !== "koed-labs/koed" ||
    context.ref !== "refs/heads/main" ||
    context.workflowRef !==
      "koed-labs/koed/.github/workflows/macos-candidate-artifact.yml@refs/heads/main" ||
    !sha1(context.sha) ||
    !sha1(context.candidateSha) ||
    !positiveInteger(context.pr) ||
    !positiveInteger(context.runId) ||
    !positiveInteger(context.runAttempt)
  )
    throw new Error("Invalid candidate workflow dispatch");
};

export const validateTupleFormat = (tuple) => {
  if (
    !tuple ||
    tuple.repository !== "koed-labs/koed" ||
    !positiveInteger(tuple.pr) ||
    !positiveInteger(tuple.runId) ||
    !positiveInteger(tuple.runAttempt) ||
    !positiveInteger(tuple.artifactId) ||
    !sha1(tuple.candidateSha) ||
    !sha1(tuple.workflowSha) ||
    !sha256(tuple.artifactSha256) ||
    !teamId(tuple.expectedTeamId) ||
    !version(tuple.version)
  )
    throw new Error("Invalid candidate tuple");
};

export const validateSigningEnvironment = async (api) => {
  const base = "/repos/koed-labs/koed/environments/desktop-candidate-signing";
  const [environment, policies, main] = await Promise.all([
    api(base),
    api(`${base}/deployment-branch-policies`),
    api("/repos/koed-labs/koed/branches/main")
  ]);
  const reviewers =
    environment.protection_rules?.filter(
      (rule) => rule.type === "required_reviewers"
    ) ?? [];
  if (
    main.name !== "main" ||
    main.protected !== true ||
    environment.name !== "desktop-candidate-signing" ||
    environment.can_admins_bypass !== false ||
    environment.deployment_branch_policy?.custom_branch_policies !== true ||
    environment.deployment_branch_policy?.protected_branches !== false ||
    reviewers.length !== 1 ||
    reviewers[0].prevent_self_review !== true ||
    !Array.isArray(reviewers[0].reviewers) ||
    reviewers[0].reviewers.length === 0 ||
    policies.total_count !== 1 ||
    policies.branch_policies?.length !== 1 ||
    policies.branch_policies[0].name !== "main" ||
    policies.branch_policies[0].type !== "branch"
  )
    throw new Error(
      "Candidate signing environment is not protected as required"
    );
};

export const findRunArtifact = async (api, runId, runAttempt) => {
  if (!positiveInteger(runId) || !positiveInteger(runAttempt))
    throw new Error("Invalid run identity");
  const name = `koed-candidate-unsigned-${runId}-${runAttempt}`;
  const artifacts = [];
  for (let page = 1; page <= 10; page++) {
    const response = await api(
      `/repos/koed-labs/koed/actions/runs/${runId}/artifacts?per_page=100&page=${page}`
    );
    if (
      !Array.isArray(response.artifacts) ||
      !Number.isSafeInteger(response.total_count) ||
      response.total_count > 1000
    )
      throw new Error("Invalid artifact listing");
    artifacts.push(...response.artifacts.filter((item) => item.name === name));
    if (page * 100 >= response.total_count) return artifacts;
  }
  throw new Error("Artifact listing exceeds limit");
};

export const gatherCandidateObservation = async (
  tuple,
  { api, workflowRef, workflowSha, artifactSha256, expectedTeamId, version }
) => {
  validateTupleFormat(tuple);
  const [main, pr, run, artifacts] = await Promise.all([
    api("/repos/koed-labs/koed/git/ref/heads/main"),
    api(`/repos/koed-labs/koed/pulls/${tuple.pr}`),
    api(`/repos/koed-labs/koed/actions/runs/${tuple.runId}`),
    findRunArtifact(api, tuple.runId, tuple.runAttempt)
  ]);
  if (
    run.head_branch !== "main" ||
    run.event !== "workflow_dispatch" ||
    run.head_sha !== workflowSha
  )
    throw new Error("Untrusted source run");
  const artifact = artifacts.find((item) => item.id === tuple.artifactId);
  return {
    repository: tuple.repository,
    workflowRef,
    workflowSha,
    mainSha: main.object?.sha,
    pr: pr.number,
    prState: pr.state,
    prBase: pr.base?.ref,
    prHeadRepository: pr.head?.repo?.full_name,
    prHeadSha: pr.head?.sha,
    runId: run.id,
    runAttempt: run.run_attempt,
    artifactId: artifact?.id,
    artifactRunId: artifact?.workflow_run?.id,
    artifactName: artifact?.name,
    artifactExpired: artifact?.expired,
    matchingArtifactCount: artifacts.length,
    artifactSha256,
    expectedTeamId,
    version
  };
};

export const validateCandidateTuple = (tuple, observed) => {
  validateTupleFormat(tuple);
  if (!observed) throw new Error("Candidate provenance missing");
  if (
    observed.repository !== tuple.repository ||
    observed.workflowRef !== "refs/heads/main" ||
    observed.workflowSha !== tuple.workflowSha ||
    observed.mainSha !== tuple.workflowSha ||
    observed.pr !== tuple.pr ||
    observed.prState !== "open" ||
    observed.prBase !== "main" ||
    observed.prHeadRepository !== tuple.repository ||
    observed.prHeadSha !== tuple.candidateSha ||
    observed.runId !== tuple.runId ||
    observed.runAttempt !== tuple.runAttempt ||
    observed.artifactId !== tuple.artifactId ||
    observed.artifactRunId !== tuple.runId ||
    observed.artifactName !==
      `koed-candidate-unsigned-${tuple.runId}-${tuple.runAttempt}` ||
    observed.artifactExpired !== false ||
    observed.matchingArtifactCount !== 1 ||
    observed.artifactSha256 !== tuple.artifactSha256 ||
    observed.expectedTeamId !== tuple.expectedTeamId ||
    observed.version !== tuple.version
  )
    throw new Error("Candidate provenance mismatch");
  return Object.freeze({
    repository: tuple.repository,
    pr: tuple.pr,
    candidateSha: tuple.candidateSha,
    workflowSha: tuple.workflowSha,
    runId: tuple.runId,
    runAttempt: tuple.runAttempt,
    artifactId: tuple.artifactId,
    artifactSha256: tuple.artifactSha256,
    expectedTeamId: tuple.expectedTeamId,
    version: tuple.version
  });
};
