import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { app } from "electron";
import { handleHqSourceControlMerge } from "../dist-electron/koed-server/hq-source-control-merge-client.js";
import { sourceControlMergeReviewOptions } from "../dist-electron/koed-server/source-control-merge-native-review.js";
import { createReviewRequestMergeProposalObserver } from "../../../apps/worker/dist/review-request-merge-proposal.js";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ901_WORK_NATIVE_USER_DATA_DIR;
assert.ok(profile, "Supply an isolated HQ-901 work Native profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const selector = {
  executionId: "11111111-1111-4111-8111-111111111111",
  executionGeneration: 2,
  remoteIdentityHash: "a".repeat(64),
  reviewRequestNumber: 212,
  mergeMethod: "squash"
};
const operationId = "22222222-2222-4222-8222-222222222222";
let currentHead = "c".repeat(40);
let currentCheckId = "2";
const readiness = {
  provider: "github",
  accountLabel: "Personal GitHub",
  host: "github.com",
  apiOrigin: "https://api.github.com",
  repository: "koed-labs/koed",
  remoteIdentityHash: selector.remoteIdentityHash,
  connectionId: "33333333-3333-4333-8333-333333333333",
  executionId: selector.executionId,
  executionGeneration: selector.executionGeneration,
  runnerDeploymentId: "44444444-4444-4444-8444-444444444444",
  runnerDeviceId: "55555555-5555-4555-8555-555555555555",
  credentialGeneration: 4,
  policyVersion: 1,
  policyDigest: "e".repeat(64),
  reviewRequestNumber: selector.reviewRequestNumber,
  title: "KOE-4 mobile spacing",
  targetBranch: "main",
  expectedHeadObjectId: "c".repeat(40),
  mergeability: "mergeable",
  reviewDecision: "approved",
  requiredReviewCount: 1,
  approvedReviewCount: 1,
  reviews: [
    {
      id: "1",
      user: "reviewer",
      commitObjectId: "c".repeat(40),
      state: "APPROVED",
      submittedAt: "2026-10-20T00:00:00.000Z"
    }
  ],
  checks: [
    {
      id: "2",
      name: "ci",
      source: "check_run",
      state: "success",
      required: true,
      appId: 7,
      objectId: "c".repeat(40)
    }
  ],
  allowedMergeMethods: ["squash"],
  mergeMethod: "squash",
  protectionDigest: "d".repeat(64)
};
const prepared = (digest = "b".repeat(64), generation = 1) => ({
  kind: "review_request_merge_prepared",
  operationId,
  operationGeneration: generation,
  idempotencyKey: `merge:${operationId}`,
  readinessSnapshotDigest: digest,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  readiness: {
    ...readiness,
    expectedHeadObjectId: currentHead,
    reviews: [{ ...readiness.reviews[0], commitObjectId: currentHead }],
    checks: [
      { ...readiness.checks[0], id: currentCheckId, objectId: currentHead }
    ]
  }
});
const request = {
  requestId: "typed-merge-212",
  operation: "source_control_merge",
  ...selector,
  proposalItemId: "proposal-212"
};
const access = async () => ({
  authorization: "Koed-Desktop native-fixture:private-secret"
});
const verifyCard = (value, digest) => {
  const card = sourceControlMergeReviewOptions(value);
  assert.equal(card.message, "Merge koed-labs/koed #212?");
  assert.equal(card.title, "Review pull request merge");
  for (const fact of [
    "Personal GitHub",
    "KOE-4 mobile spacing",
    "Target: main",
    `Head: ${currentHead}`,
    "Method: squash",
    `Required: ci · success · check_run #${currentCheckId}`,
    "reviewer: APPROVED",
    `Readiness: ${digest}`
  ])
    assert.ok(card.detail.includes(fact), fact);
  assert.deepEqual(card.buttons, ["Cancel", "Merge"]);
  assert.equal(card.defaultId, 0);
  assert.equal(card.cancelId, 0);
};

const run = async () => {
  await app.whenReady();
  const proofIds = [];
  const observed = [];
  let prepareCount = 0;
  let providerMutations = 0;
  let merged = false;
  let staleOnce = false;
  let uncertainty = false;
  let currentDigest = "b".repeat(64);
  let proposal = null;
  const observeProposal = createReviewRequestMergeProposalObserver({
    getManagedConversationCommand: async () => ({
      executionId: selector.executionId,
      commandKind: "prompt",
      executionGeneration: selector.executionGeneration,
      leaseToken: "leased-human-prompt",
      state: "dispatching"
    }),
    putManagedConversationRuntimeItem: async (_actor, item) => {
      proposal = { ...item, id: "proposal-212" };
    }
  });
  assert.equal(
    await observeProposal({
      execution: {
        id: selector.executionId,
        ownerUserId: "owner",
        executionGeneration: selector.executionGeneration
      },
      command: {
        id: "66666666-6666-4666-8666-666666666666",
        leaseToken: "leased-human-prompt"
      },
      providerTurnId: "turn-212",
      toolCallId: "tool-212",
      toolName: "review_request_merge_propose",
      arguments: { number: 212 },
      result: { structuredContent: { number: 212, status: "requested" } }
    }),
    true
  );
  assert.equal(proposal?.payload.mergeProposal.reviewRequestNumber, 212);
  const requestJson = async (path, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    observed.push({ path, method: init.method, kind: body?.kind ?? "runtime" });
    if (path.endsWith("/runtime")) return { items: [proposal] };
    if (path.endsWith("/merge-proposals/proposal-212/decline"))
      return { declined: true };
    if (body?.kind === "review_request_merge_prepare") {
      prepareCount++;
      // The service only offers the repository's squash method. A request
      // for another method cannot produce matching prepared authority.
      return prepared(currentDigest, prepareCount);
    }
    if (body?.kind === "review_request_merge") {
      assert.equal(body.operationId, operationId);
      assert.match(body.approvalProof, /^[a-f0-9]{64}$/);
      if (staleOnce) {
        staleOnce = false;
        throw Object.assign(new Error("readiness changed"), {
          retryable: false
        });
      }
      if (!merged) {
        providerMutations++;
        merged = true;
      }
      if (uncertainty) throw new Error("response lost after provider mutation");
      return {
        kind: "review_request_merge_result",
        operationId,
        outcome: "merged",
        providerOperationId: "77777777-7777-4777-8777-777777777777",
        mergeCommitObjectId: "f".repeat(40)
      };
    }
    if (body?.kind === "review_request_merge_status") {
      assert.equal(body.operationId, operationId);
      return {
        kind: "review_request_merge_result",
        operationId,
        outcome: merged ? "merged" : "pending",
        providerOperationId: merged
          ? "77777777-7777-4777-8777-777777777777"
          : null,
        mergeCommitObjectId: merged ? "f".repeat(40) : null
      };
    }
    throw new Error("Unexpected Native fixture request");
  };
  const confirm = async (value) => {
    verifyCard(value, currentDigest);
    return true;
  };
  const decline = await handleHqSourceControlMerge({
    request,
    requestJson,
    access,
    confirm: async (value) => {
      verifyCard(value, currentDigest);
      return false;
    }
  });
  assert.equal(decline.result.kind, "declined");
  assert.equal(providerMutations, 0);
  assert.ok(
    observed.some((row) =>
      row.path.endsWith("/merge-proposals/proposal-212/decline")
    )
  );
  proofIds.push("S05.2.tool-receipt-native-decline");

  let unsupportedCardShown = false;
  await assert.rejects(
    handleHqSourceControlMerge({
      request: { ...request, mergeMethod: "rebase" },
      requestJson,
      access,
      confirm: async () => {
        unsupportedCardShown = true;
        return true;
      }
    }),
    /does not match the requested review/
  );
  assert.equal(unsupportedCardShown, false);
  assert.equal(providerMutations, 0);
  proofIds.push("N3.S.native-method-selector-rejected");

  // A changed check digest after a Native decision must refuse that dispatch.
  staleOnce = true;
  await assert.rejects(
    handleHqSourceControlMerge({ request, requestJson, access, confirm }),
    /readiness changed/
  );
  assert.equal(providerMutations, 0);
  currentDigest = "d".repeat(64);
  currentCheckId = "3";
  currentHead = "e".repeat(40);
  proofIds.push("N3.S.native-stale-result-requires-new-card");

  // Full access never skips the callback; the callback alone can authorize
  // the exact immutable operation chosen by the service.
  uncertainty = true;
  const pending = await handleHqSourceControlMerge({
    request,
    requestJson,
    access,
    confirm
  });
  assert.equal(pending.result.outcome, "unknown");
  assert.equal(providerMutations, 1);
  proofIds.push("S04.2.native-exact-review-card");
  proofIds.push("N3.S.native-uncertain-result");

  const beforeStatus = observed.length;
  const status = await handleHqSourceControlMerge({
    request: {
      requestId: "status-212",
      operation: "source_control_merge_status",
      executionId: selector.executionId,
      executionGeneration: selector.executionGeneration,
      remoteIdentityHash: selector.remoteIdentityHash,
      operationId
    },
    requestJson,
    access
  });
  assert.equal(status.result.outcome, "merged");
  assert.deepEqual(
    observed.slice(beforeStatus).map((row) => row.kind),
    ["review_request_merge_status"]
  );
  assert.equal(providerMutations, 1);
  proofIds.push("S05.2.tool-receipt-native-merged");
  proofIds.push("N3.S.native-readonly-recovery");

  uncertainty = false;
  const replay = await handleHqSourceControlMerge({
    request,
    requestJson,
    access,
    confirm
  });
  assert.equal(replay.result.outcome, "merged");
  assert.equal(providerMutations, 1);
  proofIds.push("N3.S.native-repeat-still-reviews");
  assert.ok(prepareCount >= 4);

  const output = resolve(scratch, "hq-901-work-native");
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        id: "HQ901.work-native",
        status: "pass",
        proofIds,
        scope:
          "Electron Native client and production orchestration with simulated provider receipts"
      },
      null,
      2
    ) + "\n"
  );
};

void run().then(
  () => app.quit(),
  (error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
    app.exit(1);
  }
);
