import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  readCollaborationActionGrantCustodyCommitmentHash,
  type LocalEdgeUpstreamBackend
} from "@koed/shared";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ApiRouteContext } from "../server/context.js";
import { registerConversationSourceRestoreRoutes } from "./restore-routes.js";

const homes: string[] = [];
const localOwnerUserId = "11111111-1111-4111-8111-111111111111";
const remotePrincipalUserId = "22222222-2222-4222-8222-222222222222";
const remoteDeviceCredentialId = "33333333-3333-4333-8333-333333333333";
const backendId = "team-backend";
const upstreamAuthorization =
  "Koed-Device koed_0123456789abcdef0123456789abcdef01234567:opaque-secret";

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

const buildFixture = async (options?: { enrollmentAvailable?: boolean }) => {
  const koedHome = mkdtempSync(resolve(tmpdir(), "koed-source-restore-"));
  homes.push(koedHome);
  const registryPath = resolve(koedHome, "upstream-backends.json");
  const backend: LocalEdgeUpstreamBackend = {
    id: backendId,
    baseUrl: "https://team.example.test",
    profile: "team_self_hosted",
    routePolicy: { sync: "enabled" },
    credential: { status: "configured", reference: "keychain://fixture" },
    capabilities: {
      state: "validated",
      payload: {
        capabilitySchemaVersion: 1,
        capabilities: {
          "memory.conversationSourceReplication": {
            availability: "available"
          }
        }
      }
    }
  };
  writeFileSync(
    registryPath,
    JSON.stringify({
      schemaVersion: 2,
      activeBackendId: backendId,
      backends: [backend]
    })
  );
  const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
    const url = String(_url);
    const response = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    if (url.endsWith("/v1/high-risk/action-grants")) {
      const request = JSON.parse(String(init?.body)) as {
        clientRequestId: string;
      };
      const selector = randomUUID();
      return response({
        status: {
          version: 1,
          actionGrant: { id: request.clientRequestId },
          selector,
          state: "pending",
          activationPath: `/v1/high-risk/browser-activations/${selector}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }
      });
    }
    if (url.includes("/v1/high-risk/action-grants/")) {
      const requestId = url.split("/").at(-1);
      return response({
        status: {
          version: 1,
          actionGrant: { id: requestId },
          selector: randomUUID(),
          state: "approved",
          activationPath: null,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }
      });
    }
    if (url.endsWith("/v1/conversation-source-replication/sources/discover")) {
      return response({
        sources: [
          {
            sourceGenerationId: "55555555-5555-4555-8555-555555555555",
            redactedSourceLabel: "Captured conversation",
            sourceRuntime: "codex",
            sourceCreatedAt: "2026-01-01T00:00:00.000Z",
            sourceModifiedAt: null,
            currentSourceLength: 2048,
            segmentCount: 1
          }
        ],
        nextCursor: null
      });
    }
    return response({ error: "Unexpected test request" });
  });
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error instanceof z.ZodError
        ? 400
        : typeof (error as { statusCode?: unknown }).statusCode === "number"
          ? (error as { statusCode: number }).statusCode
          : 500;
    reply.status(statusCode).send({
      error: error instanceof Error ? error.message : String(error)
    });
  });
  registerConversationSourceRestoreRoutes(app, {
    config: { deploymentProfile: "local_personal", koedHome },
    auth: {
      authenticate: async () => ({
        id: localOwnerUserId,
        email: "local@example.test",
        displayName: "Local User",
        passwordHash: null
      })
    },
    rateLimit: {
      memoryRead: async () => undefined,
      memoryWrite: async () => undefined
    },
    localEdge: {
      upstreamBackendsPath: registryPath,
      fetch,
      resolveUpstreamAuthorization: () => upstreamAuthorization,
      resolveUpstreamEnrollmentBinding: () =>
        options?.enrollmentAvailable === false
          ? null
          : {
              backendId,
              enrollmentId: "current-enrollment",
              deviceCredentialId: remoteDeviceCredentialId,
              principalUserId: remotePrincipalUserId
            }
    }
  } as unknown as ApiRouteContext);
  await app.ready();
  return { app, fetch, koedHome };
};

describe("Personal source restore controls", () => {
  it("uses opaque authorization keys while binding custody to local and remote identities", async () => {
    const fixture = await buildFixture();
    const requestId = randomUUID();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-source-replication/discovery",
      payload: {
        upstreamBackendId: backendId,
        requestId,
        cursor: null,
        limit: 10
      }
    });

    expect(response.statusCode).toBe(202);
    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(
      new Headers(fixture.fetch.mock.calls[0]?.[1]?.headers).get(
        "authorization"
      )
    ).toBe(upstreamAuthorization);
    expect(
      readCollaborationActionGrantCustodyCommitmentHash(fixture.koedHome, {
        referenceId: requestId,
        backendId,
        deploymentBaseUrl: "https://team.example.test",
        deviceCredentialId: remoteDeviceCredentialId,
        localOwnerUserId,
        principalUserId: remotePrincipalUserId
      })
    ).toMatch(/^[0-9a-f]{64}$/);
    const completed = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-source-replication/discovery/complete",
      payload: {
        upstreamBackendId: backendId,
        requestId,
        cursor: null,
        limit: 10
      }
    });
    expect(completed.statusCode).toBe(200);
    expect(JSON.parse(completed.body)).toMatchObject({
      approvalState: "consumed",
      sources: [
        {
          sourceGenerationId: "55555555-5555-4555-8555-555555555555",
          segmentCount: 1
        }
      ]
    });
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
    expect(
      readCollaborationActionGrantCustodyCommitmentHash(fixture.koedHome, {
        referenceId: requestId,
        backendId,
        deploymentBaseUrl: "https://team.example.test",
        deviceCredentialId: remoteDeviceCredentialId,
        localOwnerUserId,
        principalUserId: remotePrincipalUserId
      })
    ).toBeNull();
    await fixture.app.close();
  });

  it("rejects custody access under a different remote principal", async () => {
    const fixture = await buildFixture();
    const requestId = randomUUID();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-source-replication/discovery",
      payload: {
        upstreamBackendId: backendId,
        requestId,
        cursor: null,
        limit: 10
      }
    });

    expect(response.statusCode).toBe(202);
    expect(
      readCollaborationActionGrantCustodyCommitmentHash(fixture.koedHome, {
        referenceId: requestId,
        backendId,
        deploymentBaseUrl: "https://team.example.test",
        deviceCredentialId: remoteDeviceCredentialId,
        localOwnerUserId,
        principalUserId: localOwnerUserId
      })
    ).toBeNull();
    await fixture.app.close();
  });

  it("fails closed before remote access when the enrollment binding is absent", async () => {
    const fixture = await buildFixture({ enrollmentAvailable: false });
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-source-replication/discovery",
      payload: {
        upstreamBackendId: backendId,
        requestId: randomUUID(),
        cursor: null,
        limit: 10
      }
    });

    expect(response.statusCode).toBe(409);
    expect(fixture.fetch).not.toHaveBeenCalled();
    await fixture.app.close();
  });
});
