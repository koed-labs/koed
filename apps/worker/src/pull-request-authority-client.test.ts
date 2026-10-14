import { describe, expect, it, vi } from "vitest";
import { createPullRequestRunnerAuthority } from "./pull-request-authority-client.js";
import type { PullRequestOperationRecord } from "@koed/shared/pull-requests";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const deploymentId = "33333333-3333-4333-8333-333333333333";
const reviewId = "44444444-4444-4444-8444-444444444444";
const executionId = "55555555-5555-4555-8555-555555555555";
const commandId = "66666666-6666-4666-8666-666666666666";
const leaseToken = "77777777-7777-4777-8777-777777777777";
const upstreamOwnerUserId = "99999999-9999-4999-8999-999999999999";
const account = { id: "github-account-42", login: "alice" };
const operation: PullRequestOperationRecord = {
  id: "88888888-8888-4888-8888-888888888888",
  ownerUserId,
  reviewId: null,
  targetDeviceId: deviceId,
  targetDeploymentId: deploymentId,
  requestId: "request-1",
  requestDigest: "a".repeat(64),
  payload: {
    kind: "inbox",
    account,
    connectionGeneration: 3,
    repository: null,
    cursor: null
  },
  state: "pending",
  result: null,
  errorCode: null,
  revision: 1,
  attempt: 0,
  leaseToken: null,
  leaseExpiresAt: null,
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  completedAt: null
};

const reviewProof = {
  reviewId,
  executionId,
  executionGeneration: 5,
  commandId,
  leaseToken,
  expectedReviewRevision: 8,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  result: {
    event: "COMMENT" as const,
    body: "The review summary.",
    findings: [
      {
        path: "src/change.ts",
        line: 12,
        side: "RIGHT" as const,
        body: "This branch misses the new case."
      }
    ]
  }
};

describe("Pull Request runner authority client", () => {
  it("resolves the hosted credential principal and scopes reviews to that upstream owner", async () => {
    const review = {
      id: reviewId,
      ownerUserId: upstreamOwnerUserId,
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agentVersion: 3,
      executionId,
      projectId: null,
      targetDeviceId: deviceId,
      targetDeploymentId: deploymentId,
      account,
      repository: {
        id: "repo-1",
        owner: "acme",
        name: "project",
        fullName: "acme/project"
      },
      pullRequestNumber: 17,
      expectedBaseSha: "a".repeat(40),
      expectedHeadSha: "b".repeat(40),
      connectionGeneration: 2,
      workMode: "review" as const,
      reviewedBaseSha: null,
      reviewedHeadSha: null,
      reviewedExecutionGeneration: null,
      status: "active" as const,
      revision: 4,
      draftRevision: 0,
      createdAt: "2026-10-14T00:00:00.000Z",
      updatedAt: "2026-10-14T00:00:00.000Z"
    };
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      return new Response(
        JSON.stringify(
          path.endsWith("/device-credentials/status")
            ? {
                ok: true,
                auth: "device_credential",
                user: { id: upstreamOwnerUserId },
                credential: {
                  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                  operationFamilies: ["managed_execution"]
                }
              }
            : { review }
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const authority = createPullRequestRunnerAuthority({
      repository: {} as never,
      ownerUserId,
      deviceId,
      deploymentId,
      remote: {
        baseUrl: "https://api.example",
        authorization: "Bearer runner-token",
        fetch
      }
    });

    await expect(authority.getOwnerUserId()).resolves.toBe(upstreamOwnerUserId);
    await expect(
      authority.getReviewForExecution(executionId, ownerUserId)
    ).resolves.toBeNull();
    await expect(
      authority.getReviewForExecution(executionId, upstreamOwnerUserId)
    ).resolves.toEqual(review);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "/v1/local-edge/device-credentials/status"
    );
    expect(String(fetch.mock.calls[1]?.[0])).toContain(
      `/v1/pull-requests/runner/executions/${executionId}/review`
    );
  });

  it("rejects a hosted principal without managed-execution scope", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            auth: "device_credential",
            user: { id: upstreamOwnerUserId },
            credential: {
              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              operationFamilies: ["personal_memory_read"]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const authority = createPullRequestRunnerAuthority({
      repository: {} as never,
      ownerUserId,
      deviceId,
      deploymentId,
      remote: {
        baseUrl: "https://api.example",
        authorization: "Bearer runner-token",
        fetch: fetch as unknown as typeof globalThis.fetch
      }
    });

    await expect(authority.getOwnerUserId()).rejects.toThrow(
      "PullRequestRunnerPrincipalUnavailable"
    );
  });

  it("enqueues the fixed inbox operation under the bound local owner and runner", async () => {
    const enqueuePullRequestOperation = vi.fn(async () => operation);
    const authority = createPullRequestRunnerAuthority({
      repository: { enqueuePullRequestOperation } as never,
      ownerUserId,
      deviceId,
      deploymentId
    });

    await expect(
      authority.requestInboxRefresh({
        requestId: "request-1",
        account,
        connectionGeneration: 3
      })
    ).resolves.toBe(operation);
    expect(enqueuePullRequestOperation).toHaveBeenCalledWith(
      { userId: ownerUserId },
      {
        requestId: "request-1",
        targetDeviceId: deviceId,
        targetDeploymentId: deploymentId,
        payload: {
          kind: "inbox",
          account,
          connectionGeneration: 3,
          repository: null,
          cursor: null
        }
      }
    );
  });

  it("uses the fixed upstream inbox endpoint and forwards only the approved request fields", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ operation }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const authority = createPullRequestRunnerAuthority({
      repository: {} as never,
      ownerUserId,
      deviceId,
      deploymentId,
      remote: {
        baseUrl: "https://api.example",
        authorization: "Bearer runner-token",
        fetch: fetch as unknown as typeof globalThis.fetch
      }
    });

    await expect(
      authority.requestInboxRefresh({
        requestId: "request-1",
        account,
        connectionGeneration: 3
      })
    ).resolves.toEqual(operation);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.example/v1/pull-requests/runner/inbox-refresh"
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      requestId: "request-1",
      account,
      connectionGeneration: 3
    });
  });

  it("forwards native completion as a flattened server-authorized proof", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const authority = createPullRequestRunnerAuthority({
      repository: {} as never,
      ownerUserId,
      deviceId,
      deploymentId,
      remote: {
        baseUrl: "https://api.example",
        authorization: "Bearer runner-token",
        fetch: fetch as unknown as typeof globalThis.fetch
      }
    });

    await authority.markReviewed(reviewProof);

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://api.example/v1/pull-requests/runner/reviews/${reviewId}/complete`
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      executionId,
      executionGeneration: 5,
      commandId,
      leaseToken,
      expectedReviewRevision: 8,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      body: reviewProof.result.body,
      findings: reviewProof.result.findings
    });
    expect(String(init?.body)).not.toContain(ownerUserId);
  });
});
