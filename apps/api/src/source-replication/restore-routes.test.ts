import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  generateConversationSourceReplicationOriginKeyPair,
  readCollaborationActionGrantCustodyCommitmentHash,
  type LocalEdgeUpstreamBackend
} from "@koed/shared";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ApiRouteContext } from "../server/context.js";
import { resolveSyncRecipientContext } from "../sync/recipient-context.js";
import { createCollaborationActionGrantLifecycle } from "../local-edge/collaboration-action-grant-lifecycle.js";
import { registerConversationSourceRestoreRoutes } from "./restore-routes.js";

vi.mock("../sync/recipient-context.js", () => ({
  resolveSyncRecipientContext: vi.fn()
}));

const homes: string[] = [];
const localOwnerUserId = "11111111-1111-4111-8111-111111111111";
const remotePrincipalUserId = "22222222-2222-4222-8222-222222222222";
const remoteDeviceCredentialId = "33333333-3333-4333-8333-333333333333";
const backendId = "team-backend";
const upstreamAuthorization =
  "Koed-Device koed_0123456789abcdef0123456789abcdef01234567:opaque-secret";

const reviewedGrantEnvelope = (
  requestId: string,
  state:
    | "pending"
    | "approved"
    | "consumed"
    | "denied"
    | "revoked"
    | "expired"
    | "canceled"
) => {
  const selector = randomUUID();
  return {
    status: {
      version: 1,
      actionGrant: { id: requestId },
      selector,
      approvalTier: "step_up",
      review: {
        version: 1,
        title: "Download source?",
        description: "Review the exact source download.",
        consequence: "The selected source may be downloaded.",
        confirmLabel: "Continue",
        details: []
      },
      state,
      activationPath:
        state === "pending"
          ? `/high-risk/browser-activations/${selector}`
          : null,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }
  };
};

afterEach(() => {
  vi.mocked(resolveSyncRecipientContext).mockReset();
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

type ActionGrantPhase = "request" | "poll";

const buildFixture = async (options?: {
  enrollmentAvailable?: boolean;
  actionGrantEnvelope?: (input: {
    phase: ActionGrantPhase;
    requestId: string;
  }) => unknown;
  failActionGrantRequest?: boolean;
  downloadAuthorizationResponse?: unknown;
  repository?: unknown;
}) => {
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
  const lifecycle = createCollaborationActionGrantLifecycle({ koedHome });
  const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
    const url = String(_url);
    const response = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    if (url.endsWith("/v1/high-risk/action-grants")) {
      if (options?.failActionGrantRequest) {
        throw new Error("simulated lost response");
      }
      const request = JSON.parse(String(init?.body)) as {
        clientRequestId: string;
      };
      const overridden = options?.actionGrantEnvelope?.({
        phase: "request",
        requestId: request.clientRequestId
      });
      if (overridden !== undefined) return response(overridden);
      const selector = randomUUID();
      return response({
        status: {
          version: 1,
          actionGrant: { id: request.clientRequestId },
          selector,
          approvalTier: "direct",
          review: null,
          state: "approved",
          activationPath: null,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }
      });
    }
    if (url.includes("/v1/high-risk/action-grants/")) {
      const requestId = url.split("/").at(-1);
      if (!requestId) throw new Error("Expected Action Grant request id");
      const overridden = options?.actionGrantEnvelope?.({
        phase: "poll",
        requestId
      });
      if (overridden !== undefined) return response(overridden);
      return response({
        status: {
          version: 1,
          actionGrant: { id: requestId },
          selector: randomUUID(),
          approvalTier: "direct",
          review: null,
          state: "approved",
          activationPath: null,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }
      });
    }
    if (
      url.endsWith(
        "/v1/conversation-source-replication/download-authorizations"
      )
    ) {
      return response(
        options?.downloadAuthorizationResponse ?? {
          error: "Unexpected source download request"
        }
      );
    }
    if (url.endsWith("/v1/conversation-source-replication/sources/discover")) {
      return response({
        sources: [
          {
            sourceGenerationId: "55555555-5555-4555-8555-555555555555",
            sourceComponentId: "main",
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
    },
    collaboration: { actionGrantLifecycle: lifecycle },
    requireRepository: () => options?.repository
  } as unknown as ApiRouteContext);
  await app.ready();
  return { app, backend, fetch, koedHome, lifecycle };
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

  it("reconciles an initially malformed response without inventing a classification", async () => {
    const fixture = await buildFixture({
      actionGrantEnvelope: ({ phase }) =>
        phase === "request" ? { status: {} } : undefined
    });
    const requestId = randomUUID();
    const requested = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-source-replication/discovery",
      payload: {
        upstreamBackendId: backendId,
        requestId,
        cursor: null,
        limit: 10
      }
    });

    expect(requested.statusCode).toBe(503);
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

    const reconciled = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-source-replication/discovery/complete",
      payload: {
        upstreamBackendId: backendId,
        requestId,
        cursor: null,
        limit: 10
      }
    });
    expect(reconciled.statusCode).toBe(200);
    expect(JSON.parse(reconciled.body)).toMatchObject({
      approvalState: "consumed"
    });
    await fixture.app.close();
  });

  it("retains ambiguous custody after a lost grant response", async () => {
    const fixture = await buildFixture({ failActionGrantRequest: true });
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

    expect(response.statusCode).toBe(500);
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
    await fixture.app.close();
  });

  it.each(["consumed", "denied", "revoked", "expired", "canceled"] as const)(
    "applies authoritative %s cleanup without executing discovery",
    async (state) => {
      const fixture = await buildFixture({
        actionGrantEnvelope: ({ phase, requestId }) =>
          reviewedGrantEnvelope(
            requestId,
            phase === "request" ? "pending" : state
          )
      });
      const requestId = randomUUID();
      const requested = await fixture.app.inject({
        method: "POST",
        url: "/v1/personal-source-replication/discovery",
        payload: {
          upstreamBackendId: backendId,
          requestId,
          cursor: null,
          limit: 10
        }
      });
      expect(requested.statusCode).toBe(202);
      expect(JSON.parse(requested.body)).toMatchObject({
        approvalState: "pending"
      });

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
        approvalState: state
      });
      expect(fixture.fetch).toHaveBeenCalledTimes(2);
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
    }
  );

  it("does not resolve a grant for a changed discovery operation", async () => {
    const fixture = await buildFixture();
    const requestId = randomUUID();
    await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-source-replication/discovery",
      payload: {
        upstreamBackendId: backendId,
        requestId,
        cursor: null,
        limit: 10
      }
    });

    const completed = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-source-replication/discovery/complete",
      payload: {
        upstreamBackendId: backendId,
        requestId,
        cursor: null,
        limit: 11
      }
    });
    expect(completed.statusCode).toBe(409);
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    await fixture.app.close();
  });

  it("replays a consumed source-download receipt until local restore activation commits", async () => {
    const restoreJobId = "44444444-4444-4444-8444-444444444444";
    const sourceGenerationId = "55555555-5555-4555-8555-555555555555";
    const actionGrantId = "66666666-6666-4666-8666-666666666666";
    const targetDeploymentId = "77777777-7777-4777-8777-777777777777";
    const deploymentIdentityId = "88888888-8888-4888-8888-888888888888";
    const recipientKey = {
      algorithm: "x25519-hkdf-sha256-aes-256-gcm",
      keyId: "sync-recipient:test",
      keyVersion: 1,
      publicJwk: { kty: "OKP", crv: "X25519", x: "A".repeat(43) }
    };
    const origin = generateConversationSourceReplicationOriginKeyPair();
    const download = {
      authorizationId: "99999999-9999-4999-8999-999999999999",
      capability: `csd_${"A".repeat(43)}`,
      firstSegmentIndex: 0,
      lastSegmentIndex: 0,
      registration: {
        protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
        logicalSourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceGenerationId,
        originKeyId: origin.originKeyId,
        publicKey: origin.publicKeyBase64url,
        lifecycle: "active",
        sourceCreatedAt: "2026-01-01T00:00:00.000Z",
        priorGenerationClosure: null
      },
      source: {
        sourceComponentSchemaVersion: 1,
        sourceComponentId: "agent.researcher",
        sourceComponentRole: "auxiliary",
        parentSourceComponentId: "main",
        contentFraming: "jsonl",
        sourceKind: "codex",
        logicalSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        externalSessionId: "session-restore",
        forkedFromExternalThreadId: null,
        sourceFingerprint: "1".repeat(64),
        artifactFormat: "codex_rollout_jsonl",
        artifactFormatVersion: 1,
        sourceAdapterVersion: "codex-transcript-v1",
        sourceRuntime: "codex",
        redactedSourceLabel: "Restored conversation",
        originDeploymentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        originDeviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        journalStartOffset: 0,
        journalStartLine: 0,
        liveStartOffset: 0,
        liveStartLine: 0,
        project: null
      },
      sourceClosure: null
    };
    let job = {
      id: restoreJobId,
      ownerUserId: localOwnerUserId,
      upstreamBackendId: backendId,
      sourceGenerationId,
      targetDeploymentId,
      recipientKeyId: recipientKey.keyId,
      recipientKeyVersion: recipientKey.keyVersion,
      actionGrantId,
      state: "awaiting_approval",
      nextSegmentIndex: 0,
      lastSegmentIndex: null as number | null,
      lastErrorCode: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null
    };
    let activationAttempts = 0;
    const repository = {
      getConversationSourceRestoreJob: vi.fn(async () => job),
      getSyncRecipientKey: vi.fn(async () => recipientKey),
      activateConversationSourceRestoreJob: vi.fn(async () => {
        activationAttempts += 1;
        if (activationAttempts === 1) {
          throw new Error("simulated local activation failure");
        }
        job = {
          ...job,
          state: "ready",
          lastSegmentIndex: 0,
          updatedAt: "2026-01-01T00:01:00.000Z"
        };
        return job;
      })
    };
    vi.mocked(resolveSyncRecipientContext).mockResolvedValue({
      localDeployment: {
        id: deploymentIdentityId,
        protocolDeploymentId: targetDeploymentId
      }
    } as never);
    const fixture = await buildFixture({
      downloadAuthorizationResponse: download,
      repository
    });
    const body = {
      sourceGenerationId,
      sourceComponentId: "agent.researcher",
      targetDeploymentId,
      firstSegmentIndex: 0,
      recipientKey
    };
    fixture.lifecycle.prepare({
      referenceId: actionGrantId,
      backendId,
      deploymentBaseUrl: fixture.backend.baseUrl,
      deviceCredentialId: remoteDeviceCredentialId,
      localOwnerUserId,
      principalUserId: remotePrincipalUserId,
      operationFamily: "source_download",
      action: "conversation_source.download",
      teamId: null,
      targetId: sourceGenerationId,
      method: "POST",
      path: "/v1/conversation-source-replication/download-authorizations",
      body,
      idempotencyKey: actionGrantId,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    fixture.lifecycle.acceptRemote(
      {
        backend: fixture.backend,
        localOwnerUserId,
        principalUserId: remotePrincipalUserId,
        upstreamDeviceCredentialId: remoteDeviceCredentialId
      },
      { id: actionGrantId },
      reviewedGrantEnvelope(actionGrantId, "approved")
    );

    const first = await fixture.app.inject({
      method: "POST",
      url: `/v1/personal-source-replication/restores/${restoreJobId}/complete-approval`,
      payload: { sourceComponentId: "agent.researcher" }
    });
    expect(first.statusCode, first.body).toBe(500);
    expect(
      readCollaborationActionGrantCustodyCommitmentHash(fixture.koedHome, {
        referenceId: actionGrantId,
        backendId,
        deploymentBaseUrl: fixture.backend.baseUrl,
        deviceCredentialId: remoteDeviceCredentialId,
        localOwnerUserId,
        principalUserId: remotePrincipalUserId
      })
    ).toMatch(/^[0-9a-f]{64}$/);

    const retried = await fixture.app.inject({
      method: "POST",
      url: `/v1/personal-source-replication/restores/${restoreJobId}/complete-approval`,
      payload: { sourceComponentId: "agent.researcher" }
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(JSON.parse(retried.body)).toMatchObject({
      approvalState: "consumed",
      restore: { id: restoreJobId, state: "ready" }
    });
    expect(
      repository.activateConversationSourceRestoreJob
    ).toHaveBeenCalledTimes(2);
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    const firstGrant = new Headers(
      fixture.fetch.mock.calls[0]?.[1]?.headers
    ).get("x-koed-action-grant");
    const replayedGrant = new Headers(
      fixture.fetch.mock.calls[1]?.[1]?.headers
    ).get("x-koed-action-grant");
    expect(firstGrant).toMatch(/^hrg_/);
    expect(replayedGrant).toBe(firstGrant);
    expect(
      readCollaborationActionGrantCustodyCommitmentHash(fixture.koedHome, {
        referenceId: actionGrantId,
        backendId,
        deploymentBaseUrl: fixture.backend.baseUrl,
        deviceCredentialId: remoteDeviceCredentialId,
        localOwnerUserId,
        principalUserId: remotePrincipalUserId
      })
    ).toBeNull();
    await fixture.app.close();
  });
});
