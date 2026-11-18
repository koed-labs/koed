import assert from "node:assert/strict";
import { test } from "node:test";
import {
  gatherCandidateObservation,
  validateCandidateTuple,
  validateDispatchContext,
  validateSigningEnvironment
} from "./candidate-artifact-provenance.mjs";

const makeEvidence = () => ({
  tuple: {
    repository: "koed-labs/koed",
    pr: 537,
    candidateSha: "a".repeat(40),
    workflowSha: "b".repeat(40),
    runId: 123,
    runAttempt: 2,
    artifactId: 456,
    artifactSha256: "c".repeat(64),
    expectedTeamId: "ABCDEFGHIJ",
    version: "1.0.0"
  },
  observed: {
    repository: "koed-labs/koed",
    workflowRef: "refs/heads/main",
    workflowSha: "b".repeat(40),
    mainSha: "b".repeat(40),
    pr: 537,
    prState: "open",
    prBase: "main",
    prHeadRepository: "koed-labs/koed",
    prHeadSha: "a".repeat(40),
    runId: 123,
    runAttempt: 2,
    artifactId: 456,
    artifactRunId: 123,
    artifactName: "koed-candidate-unsigned-123-2",
    artifactExpired: false,
    matchingArtifactCount: 1,
    artifactSha256: "c".repeat(64),
    expectedTeamId: "ABCDEFGHIJ",
    version: "1.0.0"
  }
});

test("requires independent reviewer and exactly the main branch for candidate signing", async () => {
  const environment = {
    name: "desktop-candidate-signing",
    can_admins_bypass: false,
    deployment_branch_policy: {
      custom_branch_policies: true,
      protected_branches: false
    },
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "Team", reviewer: { id: 1 } }]
      }
    ]
  };
  const policies = {
    total_count: 1,
    branch_policies: [{ name: "main", type: "branch" }]
  };
  const api = async (path) =>
    path.endsWith("/branches/main")
      ? { name: "main", protected: true }
      : path.endsWith("deployment-branch-policies")
        ? policies
        : environment;
  await assert.doesNotReject(validateSigningEnvironment(api));
  environment.protection_rules[0].prevent_self_review = false;
  await assert.rejects(validateSigningEnvironment(api));
  environment.protection_rules[0].prevent_self_review = true;
  policies.branch_policies[0].name = "*";
  await assert.rejects(validateSigningEnvironment(api));
});

test("requires the protected-main workflow and a full same-repository PR SHA before build", () => {
  const context = {
    repository: "koed-labs/koed",
    ref: "refs/heads/main",
    workflowRef:
      "koed-labs/koed/.github/workflows/macos-candidate-artifact.yml@refs/heads/main",
    sha: "b".repeat(40),
    runId: 123,
    runAttempt: 2,
    pr: 537,
    candidateSha: "a".repeat(40)
  };
  assert.doesNotThrow(() => validateDispatchContext(context));
  for (const invalid of [
    { ref: "refs/heads/topic" },
    { workflowRef: "other" },
    { candidateSha: "short" },
    { pr: 0 },
    { repository: "fork/repo" }
  ]) {
    assert.throws(() => validateDispatchContext({ ...context, ...invalid }));
  }
});

test("reads workflow, main, PR and artifacts independently from the API", async () => {
  const { tuple, observed } = makeEvidence();
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path === "/repos/koed-labs/koed/git/ref/heads/main")
      return { object: { sha: tuple.workflowSha } };
    if (path === "/repos/koed-labs/koed/pulls/537")
      return {
        number: 537,
        state: "open",
        base: { ref: "main" },
        head: { sha: tuple.candidateSha, repo: { full_name: tuple.repository } }
      };
    if (path === "/repos/koed-labs/koed/actions/runs/123")
      return {
        id: 123,
        run_attempt: 2,
        head_sha: tuple.workflowSha,
        head_branch: "main",
        event: "workflow_dispatch"
      };
    if (
      path ===
      "/repos/koed-labs/koed/actions/runs/123/artifacts?per_page=100&page=1"
    )
      return {
        total_count: 1,
        artifacts: [
          {
            id: 456,
            name: observed.artifactName,
            expired: false,
            workflow_run: { id: 123 }
          }
        ]
      };
    throw new Error(`Unexpected API call: ${path}`);
  };
  const result = await gatherCandidateObservation(tuple, {
    api,
    workflowRef: "refs/heads/main",
    workflowSha: tuple.workflowSha,
    artifactSha256: tuple.artifactSha256,
    expectedTeamId: tuple.expectedTeamId,
    version: tuple.version
  });
  assert.deepEqual(validateCandidateTuple(tuple, result), tuple);
  assert.equal(calls.length, 4);
});

test("accepts only a complete exact tuple bound to independently observed evidence", () => {
  const { tuple, observed } = makeEvidence();
  assert.deepEqual(validateCandidateTuple(tuple, observed), tuple);
});

for (const [label, mutate] of [
  [
    "wrong repository",
    (x) => {
      x.observed.repository = "other/repo";
    }
  ],
  [
    "non-main workflow",
    (x) => {
      x.observed.workflowRef = "refs/heads/branch";
    }
  ],
  [
    "workflow SHA",
    (x) => {
      x.observed.workflowSha = "d".repeat(40);
    }
  ],
  [
    "moved main",
    (x) => {
      x.observed.mainSha = "d".repeat(40);
    }
  ],
  [
    "closed PR",
    (x) => {
      x.observed.prState = "closed";
    }
  ],
  [
    "different PR",
    (x) => {
      x.observed.pr = 538;
    }
  ],
  [
    "different base",
    (x) => {
      x.observed.prBase = "next";
    }
  ],
  [
    "fork head",
    (x) => {
      x.observed.prHeadRepository = "fork/koed";
    }
  ],
  [
    "moved PR head",
    (x) => {
      x.observed.prHeadSha = "d".repeat(40);
    }
  ],
  [
    "wrong run",
    (x) => {
      x.observed.runId = 999;
    }
  ],
  [
    "wrong attempt",
    (x) => {
      x.observed.runAttempt = 1;
    }
  ],
  [
    "wrong artifact ID",
    (x) => {
      x.observed.artifactId = 999;
    }
  ],
  [
    "wrong artifact run",
    (x) => {
      x.observed.artifactRunId = 999;
    }
  ],
  [
    "wrong artifact name",
    (x) => {
      x.observed.artifactName = "other";
    }
  ],
  [
    "expired artifact",
    (x) => {
      x.observed.artifactExpired = true;
    }
  ],
  [
    "ambiguous artifact",
    (x) => {
      x.observed.matchingArtifactCount = 2;
    }
  ],
  [
    "wrong digest",
    (x) => {
      x.observed.artifactSha256 = "d".repeat(64);
    }
  ],
  [
    "changed team",
    (x) => {
      x.observed.expectedTeamId = "ZZZZZZZZZZ";
    }
  ],
  [
    "changed version",
    (x) => {
      x.observed.version = "1.0.1";
    }
  ],
  [
    "invalid PR number",
    (x) => {
      x.tuple.pr = -1;
      x.observed.pr = -1;
    }
  ],
  [
    "invalid SHA",
    (x) => {
      x.tuple.candidateSha = "a";
      x.observed.prHeadSha = "a";
    }
  ],
  [
    "invalid version",
    (x) => {
      x.tuple.version = "../../bad";
      x.observed.version = "../../bad";
    }
  ],
  [
    "invalid digest",
    (x) => {
      x.tuple.artifactSha256 = "oops";
      x.observed.artifactSha256 = "oops";
    }
  ]
]) {
  test(`rejects ${label}`, () => {
    const evidence = makeEvidence();
    mutate(evidence);
    assert.throws(() =>
      validateCandidateTuple(evidence.tuple, evidence.observed)
    );
  });
}
