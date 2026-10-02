import Fastify from "fastify";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_CONTRACT_VERSION } from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { registerPullRequestRoutes } from "./routes.js";

const owner = randomUUID();
const remoteOwner = randomUUID();
const device = randomUUID();
const deployment = randomUUID();
const backendDeviceCredential = randomUUID();
const reviewId = randomUUID();
const frozenId = randomUUID();
const grantId = randomUUID();
const commandRequestId = randomUUID();
const requestId = randomUUID();
const sha = (n: string) => n.repeat(40);
const now = new Date();
const expiry = new Date(Date.now() + 60_000).toISOString();
const stacks: Array<{ app: ReturnType<typeof Fastify>; dir: string }> = [];

const review = {
  id: reviewId,
  ownerUserId: remoteOwner,
  agentId: randomUUID(),
  agentVersion: 1,
  projectId: null,
  executionId: randomUUID(),
  targetDeviceId: device,
  targetDeploymentId: deployment,
  account: { id: "42", login: "octo" },
  repository: {
    id: "repo-7",
    owner: "octo",
    name: "widget",
    fullName: "octo/widget"
  },
  pullRequestNumber: 8,
  expectedBaseSha: sha("a"),
  expectedHeadSha: sha("b"),
  connectionGeneration: 4,
  status: "reviewed",
  revision: 7,
  workMode: "review",
  reviewedBaseSha: sha("a"),
  reviewedHeadSha: sha("b")
};
const frozen = {
  id: frozenId,
  reviewId,
  accountId: "42",
  connectionGeneration: 4,
  baseSha: sha("a"),
  headSha: sha("b"),
  event: "COMMENT",
  body: "Looks good",
  findings: [],
  digest: "d".repeat(64),
  createdAt: now.toISOString()
};
const deviceCredential = {
  id: backendDeviceCredential,
  ownerUserId: remoteOwner,
  enrollmentChallengeId: null,
  credentialKeyId: "credential",
  upstreamBackendId: "upstream",
  deviceInstanceId: device,
  deviceLabel: "Runner",
  credentialVersion: 1,
  lineageId: randomUUID(),
  verifierKind: "secret_hash",
  operationFamilies: ["managed_execution"],
  metadata: { protocolDeploymentId: deployment },
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  lastUsedAt: null,
  lastValidatedAt: null,
  expiresAt: null,
  revokedAt: null,
  revokedByUserId: null,
  revocationReason: null
};

const makeApp = (
  profile: "team_self_hosted" | "developer",
  actionGrantControl?: any,
  sessionCreatedAt = new Date()
) => {
  const dir = mkdtempSync(join(tmpdir(), "pr-routes-"));
  const upstreamBackendsPath = join(dir, "upstream-backends.json");
  writeFileSync(
    upstreamBackendsPath,
    JSON.stringify({
      schemaVersion: 2,
      activeBackendId: "upstream",
      backends: [
        {
          id: "upstream",
          baseUrl: "https://koed.example.test",
          routePolicy: { managedExecution: "enabled" },
          credential: { status: "configured" },
          capabilities: {
            state: "validated",
            expiresAt: "2099-01-01T00:00:00.000Z",
            payload: {
              capabilities: {
                "memory.managedConversations": { availability: "available" }
              }
            }
          }
        }
      ]
    })
  );
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(
    async (url: string | URL | Request, init: RequestInit = {}) => {
      const path = String(url);
      calls.push({ url: path, init });
      if (path.endsWith("/v1/local-edge/device-credentials/status"))
        return Response.json({
          ok: true,
          user: { id: remoteOwner },
          credential: {
            id: backendDeviceCredential,
            operationFamilies: ["managed_execution"]
          }
        });
      if (path.endsWith("/v1/pull-requests/runners"))
        return Response.json({
          runners: [
            { deviceId: device, deploymentId: deployment, label: "Runner" }
          ]
        });
      if (path.endsWith(`/v1/pull-requests/${reviewId}/draft/frozen`))
        return Response.json({ frozenReview: frozen });
      if (path.endsWith("/v1/pull-requests/operations"))
        return Response.json(
          { operation: { id: requestId, state: "queued" } },
          { status: 202 }
        );
      return Response.json(
        { error: "unexpected test request" },
        { status: 404 }
      );
    }
  );
  const app = Fastify();
  const enqueued = vi.fn(async (_actor: unknown, input: any) => ({
    id: requestId,
    state: "queued",
    payload: input.payload
  }));
  const executeActionGrant = vi.fn(async (input: any) =>
    input.execute({ managedConversation: {} })
  );
  const repo = {
    getPullRequestReview: vi.fn(async () => review),
    getFrozenPullRequestReview: vi.fn(async () => frozen),
    getLatestFrozenPullRequestReview: vi.fn(async () => frozen),
    getPullRequestOperation: vi.fn(async () => null),
    listDeviceCredentials: vi.fn(async () => [deviceCredential]),
    enqueuePullRequestOperation: enqueued,
    executeActionGrant
  };
  const control = actionGrantControl ?? {
    dispatch: vi.fn(async (command: any) => ({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: command.requestId,
      ok: true,
      command: command.command,
      data: {
        status: {
          version: 1,
          actionGrant: { id: grantId },
          approvalTier: "native_review",
          review: {
            version: 1,
            title: "Publish review?",
            description: "octo/widget #8",
            consequence: "Publishes the frozen review",
            confirmLabel: "Publish",
            details: []
          },
          state: command.command.endsWith("confirm_action_grant")
            ? "approved"
            : "review_required",
          activationUrl: null,
          expiresAt: expiry
        }
      }
    })),
    resolveSecret: vi.fn(async ({ reference, intent }: any) =>
      reference.id === grantId && intent.requestId === requestId
        ? `hrg_${"s".repeat(43)}`
        : null
    )
  };
  const context = {
    config: { deploymentProfile: profile, koedHome: dir },
    requireRepository: () => repo,
    auth: {
      authenticateSessionContext: vi.fn(async () => ({
        user: { id: owner },
        sessionId: randomUUID(),
        createdAt: sessionCreatedAt
      })),
      authenticateSessionOrDeviceCredential: vi.fn(async () => ({
        id: remoteOwner
      })),
      authenticateDeviceCredential: vi.fn(async () => ({
        user: { id: remoteOwner },
        credential: { ...deviceCredential, upstreamBackendId: "upstream" }
      })),
      hashSecret: (value: string) => value
    },
    rateLimit: {
      memoryRead: async () => undefined,
      memoryWrite: async () => undefined
    },
    collaboration: { actionGrantControl: control },
    deploymentIdentity: {
      inspect: () => ({
        health: "healthy",
        deploymentId: deployment,
        deviceInstanceId: device
      })
    },
    localEdge: {
      upstreamBackendsPath,
      remoteOperationsAllowed: () => true,
      fetch,
      resolveUpstreamAuthorization: () => "Koed-Device edge:secret",
      resolveUpstreamEnrollmentBinding: () => ({
        backendId: "upstream",
        enrollmentId: randomUUID(),
        deviceCredentialId: backendDeviceCredential,
        principalUserId: remoteOwner
      })
    },
    sourceControl: { runtime: {} },
    trustedServices: { fetch },
    managedConversations: { terminalRuntime: {}, commandWakePool: null }
  } as unknown as ApiRouteContext;
  registerPullRequestRoutes(app, context);
  stacks.push({ app, dir });
  return { app, calls, repo, control, enqueued, executeActionGrant };
};

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await stack.app.close();
    rmSync(stack.dir, { recursive: true, force: true });
  }
});

describe("pull request route authorization", () => {
  it("returns the owner-scoped latest frozen review for reload recovery", async () => {
    const { app, calls } = makeApp("developer");
    const response = await app.inject({
      method: "GET",
      url: `/v1/pull-requests/${reviewId}/draft/frozen`,
      headers: { cookie: "session=test" }
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ frozenReview: frozen });
    expect(
      calls.some((call) =>
        call.url.endsWith(`/v1/pull-requests/${reviewId}/draft/frozen`)
      )
    ).toBe(true);
  });

  it("rejects a hosted Koed-Device write without an exact Action Grant", async () => {
    const { app, enqueued, executeActionGrant } = makeApp("team_self_hosted");
    const response = await app.inject({
      method: "POST",
      url: "/v1/pull-requests/operations",
      headers: { authorization: "Koed-Device test" },
      payload: {
        requestId,
        payload: {
          kind: "publish_review",
          reviewId,
          frozenReviewId: frozenId,
          confirmationDigest: frozen.digest,
          expectedReviewRevision: 7
        },
        target: { deviceId: device, deploymentId: deployment }
      }
    });
    expect(response.statusCode).toBe(403);
    expect(executeActionGrant).not.toHaveBeenCalled();
    expect(enqueued).not.toHaveBeenCalled();
  });

  it("requires fresh browser authentication for hosted review publication", async () => {
    const { app, enqueued } = makeApp(
      "team_self_hosted",
      undefined,
      new Date(Date.now() - 10 * 60_000)
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/pull-requests/operations",
      headers: { cookie: "session=test" },
      payload: {
        requestId,
        target: { deviceId: device, deploymentId: deployment },
        payload: {
          kind: "publish_review",
          reviewId,
          frozenReviewId: frozenId,
          confirmationDigest: frozen.digest,
          expectedReviewRevision: 7
        }
      }
    });
    expect(response.statusCode).toBe(403);
    expect(enqueued).not.toHaveBeenCalled();
  });

  it("resolves the native grant reference and forwards only the bound secret", async () => {
    const { app, calls, control } = makeApp("developer");
    const intent = {
      kind: "publish_review",
      commandRequestId,
      requestId,
      reviewId,
      frozenReviewId: frozenId,
      confirmationDigest: frozen.digest,
      expectedReviewRevision: 7,
      targetDeviceId: device,
      targetDeploymentId: deployment
    };
    const requested = await app.inject({
      method: "POST",
      url: "/v1/pull-requests/action-grants",
      headers: { cookie: "session=test" },
      payload: intent
    });
    expect(requested.statusCode).toBe(200);
    const approved = await app.inject({
      method: "POST",
      url: `/v1/pull-requests/action-grants/${grantId}`,
      headers: { cookie: "session=test" },
      payload: {
        requestId: randomUUID(),
        command: "confirm",
        decision: "approve",
        actionGrantId: grantId
      }
    });
    expect(approved.statusCode).toBe(200);
    const operation = await app.inject({
      method: "POST",
      url: "/v1/pull-requests/operations",
      headers: {
        cookie: "session=test",
        "x-koed-desktop-source-control-approval": "1"
      },
      payload: {
        requestId,
        commandRequestId,
        actionGrantId: grantId,
        target: { deviceId: device, deploymentId: deployment },
        payload: {
          kind: "publish_review",
          reviewId,
          frozenReviewId: frozenId,
          confirmationDigest: frozen.digest,
          expectedReviewRevision: 7
        }
      }
    });
    expect(operation.statusCode, operation.body).toBe(200);
    expect(control.dispatch).toHaveBeenCalledTimes(2);
    expect(control.dispatch.mock.calls[0]![1]).toMatchObject({
      localOwnerUserId: owner,
      principalUserId: remoteOwner
    });
    expect(control.resolveSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: { id: grantId },
        intent: expect.objectContaining({
          intent: "collaboration.publish_pull_request_review",
          commandRequestId,
          requestId,
          reviewId,
          frozenReviewId: frozenId,
          confirmationDigest: frozen.digest,
          expectedReviewRevision: 7,
          targetDeviceId: device,
          targetDeploymentId: deployment
        })
      })
    );
    expect(control.resolveSecret.mock.calls[0]![0].context).toMatchObject({
      localOwnerUserId: owner,
      principalUserId: remoteOwner
    });
    const forwarded = calls.find((call) =>
      call.url.endsWith("/v1/pull-requests/operations")
    );
    expect(forwarded).toBeDefined();
    expect(
      new Headers(forwarded!.init.headers).get("x-koed-action-grant")
    ).toMatch(/^hrg_/);
    expect(JSON.parse(String(forwarded!.init.body))).not.toHaveProperty(
      "actionGrantId"
    );
    expect(JSON.parse(String(forwarded!.init.body))).not.toHaveProperty(
      "commandRequestId"
    );
  });
});
