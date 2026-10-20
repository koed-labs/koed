import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeDesktopLocalCredential } from "@koed/shared";

import type { ApiRouteContext } from "../server/context.js";
import { registerSourceControlRoutes } from "./routes.js";

const executionId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";
const objectId = "a".repeat(40);
const remoteIdentityHash = "b".repeat(64);

describe("source-control routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const home of homes.splice(0))
      rmSync(home, { recursive: true, force: true });
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

  it("requires the native Desktop credential for v2 even with a fresh session or boolean approval header", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-merge-route-"));
    homes.push(koedHome);
    const desktop = storeDesktopLocalCredential(koedHome, {
      ownerUserId: userId,
      operationFamilies: ["managed_source_control"]
    });
    const executeV2 = vi.fn(async () => ({
      kind: "review_request_merge_result",
      operationId: "33333333-3333-4333-8333-333333333333",
      outcome: "unknown",
      providerOperationId: null,
      mergeCommitObjectId: null
    }));
    const app = Fastify();
    apps.push(app);
    registerSourceControlRoutes(app, {
      config: { deploymentProfile: "developer", koedHome },
      auth: {
        authenticateSessionContext: vi.fn(async () => ({
          user: { id: userId },
          createdAt: new Date()
        }))
      },
      rateLimit: { memoryWrite: async () => undefined },
      sourceControl: { runtime: { executeV2 } }
    } as unknown as ApiRouteContext);
    const payload = {
      contractVersion: 2,
      executionId,
      executionGeneration: 1,
      remoteIdentityHash,
      kind: "review_request_merge_status",
      operationId: "33333333-3333-4333-8333-333333333333"
    };
    for (const headers of [
      {},
      { "x-koed-desktop-source-control-approval": "1" },
      { authorization: "Bearer model-token" },
      { authorization: "Koed-Device fixture:secret" }
    ]) {
      const denied = await app.inject({
        method: "POST",
        url: `/v2/managed-conversations/${executionId}/source-control`,
        headers,
        payload
      });
      expect(denied.statusCode).toBe(403);
    }
    expect(executeV2).not.toHaveBeenCalled();
    const approved = await app.inject({
      method: "POST",
      url: `/v2/managed-conversations/${executionId}/source-control`,
      headers: { authorization: desktop.authorization },
      payload
    });
    expect(approved.statusCode).toBe(200);
    expect(executeV2).toHaveBeenCalledWith(
      userId,
      payload,
      desktop.authorization
    );
  });
});
