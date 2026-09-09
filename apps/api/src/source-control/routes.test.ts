import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiRouteContext } from "../server/context.js";
import { registerSourceControlRoutes } from "./routes.js";

const executionId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";
const objectId = "a".repeat(40);
const remoteIdentityHash = "b".repeat(64);

describe("source-control routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  const fixture = (createdAt = new Date()) => {
    const execute = vi.fn(async (_ownerUserId: string, operation: any) =>
      operation.kind === "remotes"
        ? { kind: "remotes", remotes: [], headObjectId: objectId }
        : {
            kind: operation.kind,
            operationId: "33333333-3333-4333-8333-333333333333",
            status: "completed",
            headObjectId: objectId,
            comment:
              operation.kind === "comment_create"
                ? {
                    id: "comment-1",
                    author: "reviewer",
                    body: operation.body,
                    createdAt: "2026-08-19T00:00:00.000Z",
                    webUrl: null
                  }
                : undefined
          }
    );
    const authenticateSessionOrDeviceCredential = vi.fn(async () => ({
      id: userId
    }));
    const authenticateSessionContext = vi.fn(async () => ({
      user: { id: userId },
      createdAt
    }));
    const app = Fastify();
    apps.push(app);
    registerSourceControlRoutes(app, {
      config: {
        deploymentProfile: "team_self_hosted",
        koedHome: "/tmp/koed-source-control-route-test"
      },
      auth: {
        authenticateSessionContext,
        authenticateSessionOrDeviceCredential
      },
      rateLimit: { memoryWrite: async () => undefined },
      sourceControl: { runtime: { execute } }
    } as unknown as ApiRouteContext);
    return {
      app,
      authenticateSessionContext,
      authenticateSessionOrDeviceCredential,
      execute
    };
  };

  const commentOperation = () => ({
    contractVersion: 1,
    executionId,
    executionGeneration: 1,
    remoteIdentityHash,
    kind: "comment_create",
    number: 7,
    body: "Ship it",
    expectedHeadObjectId: objectId,
    credentialGeneration: 1,
    idempotencyKey: "source-control:route-comment-0001"
  });

  it("allows a scoped device credential to perform read-only operations", async () => {
    const { app, authenticateSessionOrDeviceCredential, execute } = fixture();
    const response = await app.inject({
      method: "POST",
      url: `/v1/managed-conversations/${executionId}/source-control`,
      headers: { authorization: "Koed-Device fixture:secret" },
      payload: {
        contractVersion: 1,
        executionId,
        executionGeneration: 1,
        kind: "remotes"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(authenticateSessionOrDeviceCredential).toHaveBeenCalledWith(
      expect.anything(),
      "managed_source_control",
      expect.anything()
    );
    expect(execute).toHaveBeenCalledWith(userId, expect.anything());
  });

  it("requires a fresh browser session for a non-Desktop mutation", async () => {
    const { app, authenticateSessionContext, execute } = fixture();
    const response = await app.inject({
      method: "POST",
      url: `/v1/managed-conversations/${executionId}/source-control`,
      payload: commentOperation()
    });
    expect(response.statusCode).toBe(200);
    expect(authenticateSessionContext).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(userId, expect.anything());
  });

  it("rejects API tokens and stale sessions for mutations", async () => {
    const first = fixture();
    const bearer = await first.app.inject({
      method: "POST",
      url: `/v1/managed-conversations/${executionId}/source-control`,
      headers: { authorization: "Bearer personal-token" },
      payload: commentOperation()
    });
    expect(bearer.statusCode).toBe(403);
    expect(first.execute).not.toHaveBeenCalled();

    const second = fixture(new Date(Date.now() - 60 * 60 * 1_000));
    const stale = await second.app.inject({
      method: "POST",
      url: `/v1/managed-conversations/${executionId}/source-control`,
      payload: commentOperation()
    });
    expect(stale.statusCode).toBe(403);
    expect(second.execute).not.toHaveBeenCalled();
  });

  it("rejects conflicting path and body execution identities", async () => {
    const { app, execute } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/v1/managed-conversations/44444444-4444-4444-8444-444444444444/source-control",
      payload: {
        contractVersion: 1,
        executionId,
        executionGeneration: 1,
        kind: "remotes"
      }
    });
    expect(response.statusCode).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });
});
