import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node's native TypeScript runner needs the source extension.
import * as pushPanelHelpers from "./PullRequestPushPanel.helpers.ts";

const { canConfirmPullRequestPush, pullRequestPushConfirmationKey } =
  pushPanelHelpers;

const proposal = { id: "proposal-1", diffDigest: "digest-1" };

test("push confirmation is bound to the displayed proposal identity and diff", () => {
  assert.equal(pullRequestPushConfirmationKey(proposal), "proposal-1:digest-1");
  assert.notEqual(
    pullRequestPushConfirmationKey(proposal),
    pullRequestPushConfirmationKey({ ...proposal, diffDigest: "digest-2" })
  );
  assert.equal(pullRequestPushConfirmationKey(null), null);
});

test("push requires confirmation and no in-flight or uncertain operation", () => {
  const valid = {
    proposal,
    confirmed: true,
    busy: false,
    pendingOperationId: null,
    uncertainOperationId: null
  };
  assert.equal(canConfirmPullRequestPush(valid), true);
  assert.equal(
    canConfirmPullRequestPush({ ...valid, confirmed: false }),
    false
  );
  assert.equal(canConfirmPullRequestPush({ ...valid, busy: true }), false);
  assert.equal(
    canConfirmPullRequestPush({ ...valid, pendingOperationId: "op-1" }),
    false
  );
  assert.equal(
    canConfirmPullRequestPush({ ...valid, uncertainOperationId: "op-2" }),
    false
  );
  assert.equal(canConfirmPullRequestPush({ ...valid, proposal: null }), false);
});
