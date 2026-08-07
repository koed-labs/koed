import { createCipheriv, createHash } from "node:crypto";
import { COLLABORATION_CONTRACT_VERSION } from "@koed/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildCapabilitiesResponse } from "./capabilities.js";
import {
  registerTeamCollaborationFeatureGate,
  resolveTeamCollaborationEnabled
} from "./team-collaboration-feature.js";

describe("Team collaboration feature switch", () => {
  const cursor = (secret: string, scope: "personal" | "team") => {
    const prefix = "crt1.";
    const key = createHash("sha256")
      .update("koed:collaboration:realtime-cursor:v1\n", "utf8")
      .update(secret, "utf8")
      .digest();
    const iv = Buffer.alloc(12, 7);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(prefix, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(
        JSON.stringify({
          kind: "koed_collaboration_realtime_cursor",
          version: 1,
          protocolVersion: COLLABORATION_CONTRACT_VERSION,
          scope,
          teamId:
            scope === "team" ? "22222222-2222-4222-8222-222222222222" : null,
          cursor: 1
        }),
        "utf8"
      ),
      cipher.final()
    ]);
    return `${prefix}${Buffer.concat([
      iv,
      cipher.getAuthTag(),
      ciphertext
    ]).toString("base64url")}`;
  };

  it("defaults off and rejects ambiguous values", () => {
    expect(resolveTeamCollaborationEnabled({})).toBe(false);
    expect(
      resolveTeamCollaborationEnabled({
        KOED_TEAM_COLLABORATION_ENABLED: "true"
      })
    ).toBe(true);
    expect(
      resolveTeamCollaborationEnabled({
        KOED_TEAM_COLLABORATION_ENABLED: "false"
      })
    ).toBe(false);
    expect(() =>
      resolveTeamCollaborationEnabled({ KOED_TEAM_COLLABORATION_ENABLED: "1" })
    ).toThrow(/must be exactly/);
  });

  it("returns content-free 404s for Team-only route families before handlers run", async () => {
    const app = Fastify();
    let handlerCalls = 0;
    registerTeamCollaborationFeatureGate(app, { enabled: false });
    const disabledPaths = [
      "/ops/support/teams/sensitive-team-id/overview",
      "/v1/collaboration/teams/sensitive-team-id/threads",
      "/v1/cross-identity-sync/relationships/sensitive-id/retry",
      "/v1/high-risk/action-grants",
      "/v1/local-edge/device-enrollments/challenges",
      "/v1/local-edge/team-memory/answer",
      "/v1/retention/teams/sensitive-team-id/deletion-request",
      "/v1/shared-memory/share-grants",
      "/v1/team-context",
      "/v1/team-invites/accept",
      "/v1/team-workspaces/sensitive-workspace-id/context",
      "/v1/teams/sensitive-team-id"
    ];
    for (const path of disabledPaths) {
      app.all(path, async () => {
        handlerCalls += 1;
        return { secret: "must-not-leak" };
      });
    }
    app.post("/v1/memory/answer", async () => {
      handlerCalls += 1;
      return { secret: "must-not-leak" };
    });

    const disabledResponses = await Promise.all(
      disabledPaths.map((url) => app.inject({ method: "GET", url }))
    );
    const teamMemory = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      payload: {
        team_workspace_id: "sensitive-workspace-id",
        query: "sensitive query"
      }
    });
    const malformedTeamWrite = await app.inject({
      method: "POST",
      url: "/v1/teams/sensitive-team-id",
      headers: { "content-type": "application/json" },
      payload: "{sensitive malformed payload"
    });

    for (const response of disabledResponses) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe("");
    }
    expect(teamMemory.statusCode).toBe(404);
    expect(teamMemory.body).toBe("");
    expect(malformedTeamWrite.statusCode).toBe(404);
    expect(malformedTeamWrite.body).toBe("");
    expect(handlerCalls).toBe(0);
    await app.close();
  });

  it("does not block Personal Memory requests", async () => {
    const app = Fastify();
    registerTeamCollaborationFeatureGate(app, { enabled: false });
    app.post("/v1/memory/answer", async () => ({ personal: true }));

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      payload: { query: "personal query" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ personal: true });
    await app.close();
  });

  it("preserves Personal collaboration and rejects typed Team local-edge ingress", async () => {
    const app = Fastify();
    let personalHandlerCalls = 0;
    let teamHandlerCalls = 0;
    registerTeamCollaborationFeatureGate(app, { enabled: false });
    app.get("/v1/collaboration/personal/threads", async () => {
      personalHandlerCalls += 1;
      return { scope: "personal" };
    });
    app.post("/v1/local-edge/collaboration/command", async (request) => {
      if (
        request.body &&
        typeof request.body === "object" &&
        "upstream_backend_id" in request.body
      ) {
        teamHandlerCalls += 1;
      } else {
        personalHandlerCalls += 1;
      }
      return { routed: true };
    });
    app.post(
      "/v1/local-edge/collaboration/realtime/subscriptions",
      async (request) => {
        if (
          request.body &&
          typeof request.body === "object" &&
          "scope" in request.body &&
          request.body.scope === "team"
        ) {
          teamHandlerCalls += 1;
        } else {
          personalHandlerCalls += 1;
        }
        return { routed: true };
      }
    );
    app.post("/v1/local-edge/route-decisions", async () => {
      personalHandlerCalls += 1;
      return { routed: true };
    });

    const personalThreads = await app.inject({
      method: "GET",
      url: "/v1/collaboration/personal/threads"
    });
    const personalCommand = await app.inject({
      method: "POST",
      url: "/v1/local-edge/collaboration/command",
      payload: {
        command: {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: "11111111-1111-4111-8111-111111111111",
          command: "collaboration.load",
          input: {}
        }
      }
    });
    const teamCommand = await app.inject({
      method: "POST",
      url: "/v1/local-edge/collaboration/command",
      payload: {
        upstream_backend_id: "backend-a",
        command: {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: "22222222-2222-4222-8222-222222222222",
          command: "collaboration.subscribe",
          input: {
            scope: {
              scope: "team",
              teamId: "33333333-3333-4333-8333-333333333333"
            }
          }
        }
      }
    });
    const personalSubscription = await app.inject({
      method: "POST",
      url: "/v1/local-edge/collaboration/realtime/subscriptions",
      payload: { scope: "personal" }
    });
    const teamSubscription = await app.inject({
      method: "POST",
      url: "/v1/local-edge/collaboration/realtime/subscriptions",
      payload: {
        scope: "team",
        upstream_backend_id: "backend-a",
        team_id: "33333333-3333-4333-8333-333333333333"
      }
    });
    const personalRouteDecision = await app.inject({
      method: "POST",
      url: "/v1/local-edge/route-decisions",
      payload: {
        operation_family: "personal_memory_read",
        requested_mode: "local_only"
      }
    });
    const teamRouteDecision = await app.inject({
      method: "POST",
      url: "/v1/local-edge/route-decisions",
      payload: {
        operation_family: "team_chat_read",
        upstream_backend_id: "backend-a",
        requested_mode: "live_upstream_proxy"
      }
    });

    expect(personalThreads.statusCode).toBe(200);
    expect(personalCommand.statusCode).toBe(200);
    expect(personalSubscription.statusCode).toBe(200);
    expect(personalRouteDecision.statusCode).toBe(200);
    for (const response of [teamCommand, teamSubscription, teamRouteDecision]) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe("");
    }
    expect(personalHandlerCalls).toBe(4);
    expect(teamHandlerCalls).toBe(0);
    await app.close();
  });

  it("preserves Personal realtime while rejecting Team snapshot, stream, and ack", async () => {
    const app = Fastify();
    const secret = "deterministic-realtime-secret";
    let handlerCalls = 0;
    registerTeamCollaborationFeatureGate(app, {
      enabled: false,
      realtimeCursorSecret: secret
    });
    app.post("/v1/collaboration/realtime/snapshot", async () => {
      handlerCalls += 1;
      return { routed: true };
    });
    app.get("/v1/collaboration/realtime/stream", async () => {
      handlerCalls += 1;
      return { routed: true };
    });
    app.post("/v1/collaboration/realtime/ack", async () => {
      handlerCalls += 1;
      return { routed: true };
    });
    const binding = {
      clientInstanceId: "client-instance-1234",
      subscriptionKey: "subscription-key-1234"
    };
    const personalSnapshot = await app.inject({
      method: "POST",
      url: "/v1/collaboration/realtime/snapshot",
      payload: { scope: "personal", ...binding }
    });
    const teamRequests = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/collaboration/realtime/snapshot",
        payload: {
          scope: "team",
          teamId: "22222222-2222-4222-8222-222222222222",
          ...binding
        }
      }),
      app.inject({
        method: "GET",
        url: "/v1/collaboration/realtime/stream?scope=team&teamId=22222222-2222-4222-8222-222222222222&clientInstanceId=client-instance-1234&subscriptionKey=subscription-key-1234"
      }),
      app.inject({
        method: "POST",
        url: "/v1/collaboration/realtime/ack",
        payload: {
          subscriptionId: "33333333-3333-4333-8333-333333333333",
          eventId: "44444444-4444-4444-8444-444444444444",
          cursor: cursor(secret, "team"),
          ...binding
        }
      })
    ]);

    expect(personalSnapshot.statusCode).toBe(200);
    for (const response of teamRequests) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe("");
    }
    expect(handlerCalls).toBe(1);
    await app.close();
  });

  it("reports Team capabilities unavailable while preserving Personal Memory", () => {
    const capabilities = buildCapabilitiesResponse({
      deploymentProfile: "team_self_hosted",
      runtimeMode: "external",
      dependencyMode: "external",
      teamCollaborationEnabled: false,
      applicationLayerEncryption: "available",
      crossIdentitySync: "available"
    });

    expect(capabilities.memory).toMatchObject({
      personal: "available",
      teamWorkspaces: "unavailable",
      collaboration: "unavailable",
      shareGrants: "unavailable",
      crossIdentitySync: "unavailable"
    });
    expect(capabilities.auth.apiTokens).toBe("available");
    expect(capabilities.auth.deviceEnrollment).toBe("unavailable");
    expect(
      capabilities.capabilities["memory.collaboration"]?.endpoints
    ).toBeUndefined();
    expect(
      capabilities.capabilities["memory.personalCollaboration"]
    ).toMatchObject({
      availability: "available",
      endpoints: expect.arrayContaining([
        "/v1/collaboration/personal/threads",
        "/v1/collaboration/realtime/snapshot"
      ])
    });
  });

  it("advertises Team capabilities for an explicitly isolated developer Team backend", () => {
    const disabled = buildCapabilitiesResponse({
      deploymentProfile: "developer",
      runtimeMode: "developer",
      dependencyMode: "external",
      teamCollaborationEnabled: true
    });
    const enabled = buildCapabilitiesResponse({
      deploymentProfile: "developer",
      runtimeMode: "developer",
      dependencyMode: "external",
      teamCollaborationEnabled: true,
      developerTeamBackendEnabled: true
    });

    expect(disabled.memory).toMatchObject({
      teamWorkspaces: "unavailable",
      collaboration: "unavailable",
      shareGrants: "unavailable"
    });
    expect(enabled.memory).toMatchObject({
      teamWorkspaces: "partial",
      collaboration: "partial",
      shareGrants: "partial"
    });
    expect(enabled.capabilities["memory.collaboration"]).toMatchObject({
      availability: "partial",
      endpoints: expect.arrayContaining([
        "/v1/collaboration/teams/{teamId}/threads",
        "/v1/collaboration/realtime/snapshot"
      ])
    });
  });
});
