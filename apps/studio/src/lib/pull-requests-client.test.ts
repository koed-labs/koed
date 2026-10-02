import assert from "node:assert/strict";
import test from "node:test";
import {
  createPullRequestsClient,
  pullRequestOperationData
  // @ts-expect-error -- Node's native TypeScript runner needs the source extension.
} from "./pull-requests-client.ts";

const ids = {
  owner: "11111111-1111-4111-8111-111111111111",
  operation: "22222222-2222-4222-8222-222222222222"
};
const digest = "a".repeat(64);
const timestamp = "2026-10-02T10:00:00.000Z";

function operation(state: "pending" | "completed" | "uncertain") {
  return {
    id: ids.operation,
    ownerUserId: ids.owner,
    reviewId: null,
    targetDeviceId: "device-a",
    targetDeploymentId: "deployment-a",
    requestId: "request-a",
    requestDigest: digest,
    payload: { kind: "accounts" as const },
    state,
    result: state === "completed" ? { accounts: [{ login: "octocat" }] } : null,
    errorCode: null,
    revision: state === "pending" ? 1 : 2,
    attempt: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: state === "pending" ? null : timestamp
  };
}

test("operation polling returns only the server-confirmed result", async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  let loads = 0;
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === "string" ? init.body : undefined
    });
    if (url.endsWith("/operations")) {
      return Response.json({ operation: operation("pending") });
    }
    loads += 1;
    return Response.json({ operation: operation("completed") });
  };
  const client = createPullRequestsClient({
    hosted: true,
    fetcher,
    pollIntervalMs: 1
  });
  const completed = await client.runOperation({ kind: "accounts" });
  assert.equal(completed.state, "completed");
  assert.deepEqual(pullRequestOperationData(completed), {
    accounts: [{ login: "octocat" }]
  });
  assert.equal(loads, 1);
  assert.equal(calls[0]?.url, "/v1/pull-requests/operations");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    requestId: JSON.parse(calls[0]?.body ?? "{}").requestId,
    payload: { kind: "accounts" }
  });
});

test("uncertain publication outcomes fail closed for reconciliation", async () => {
  const fetcher = async () =>
    Response.json({ operation: operation("uncertain") });
  const client = createPullRequestsClient({ hosted: true, fetcher });
  await assert.rejects(
    client.waitForOperation(operation("uncertain")),
    /may have received this operation/
  );
});

test("review recovery can query the selected repository and PR instead of the latest global page", async () => {
  const calls: string[] = [];
  const client = createPullRequestsClient({
    hosted: true,
    fetcher: async (input) => {
      calls.push(String(input));
      return Response.json({ reviews: [], nextCursor: null });
    }
  });
  await client.listReviews({ repository: "repo-id", number: 10 });
  assert.match(calls[0] ?? "", /repository=repo-id/);
  assert.match(calls[0] ?? "", /number=10/);
});

test("a missing frozen review restores as null", async () => {
  const client = createPullRequestsClient({
    hosted: true,
    fetcher: async () => Response.json({ frozenReview: null })
  });
  assert.equal(await client.getFrozenReview("review-id"), null);
});
