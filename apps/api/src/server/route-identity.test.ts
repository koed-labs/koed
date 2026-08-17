import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi.js";
import {
  implementedRouteIdentityContracts,
  routeIdentityContracts,
  routeIdentityFor
} from "./route-identity.js";

const openApiPaths = openApiDocument.paths as Record<
  string,
  Record<
    string,
    {
      requestBody?: unknown;
      responses?: unknown;
      security?: unknown;
      "x-koed-identity"?: string;
      "x-koed-deployment-modes"?: readonly string[];
    }
  >
>;
const openApiSecuritySchemes = openApiDocument.components
  .securitySchemes as Record<string, Record<string, unknown>>;

describe("route identity contract", () => {
  it("has one implemented contract per method/path and exports all implemented routes through OpenAPI", () => {
    const keys = routeIdentityContracts.map(
      (contract) => `${contract.method} ${contract.path}`
    );

    expect(new Set(keys).size).toBe(keys.length);
    for (const contract of implementedRouteIdentityContracts) {
      expect(
        openApiPaths[contract.path]?.[contract.method.toLowerCase()]
      ).toBeDefined();
    }
  });

  it("identifies local AI Client reset as a session-or-token DELETE", () => {
    expect(
      routeIdentityFor("DELETE", "/v1/memory/local-agent-settings/{flowKey}")
    ).toMatchObject({
      identity: "session_or_api_token",
      domain: "local_synthesis",
      status: "implemented"
    });
  });

  it("does not advertise the retired Memory Question update route", () => {
    expect(
      routeIdentityFor("PATCH", "/v1/memory/questions/{questionId}")
    ).toBeUndefined();
    expect(
      openApiPaths["/v1/memory/questions/{questionId}"]?.patch
    ).toBeUndefined();
  });

  it("inventories raw-conversation mutation identities and request schemas", () => {
    expect(
      implementedRouteIdentityContracts
        .filter((contract) =>
          contract.path.startsWith("/v1/memory/conversation-items")
        )
        .map(({ method, path, identity }) => ({ method, path, identity }))
    ).toEqual([
      {
        method: "POST",
        path: "/v1/memory/conversation-items",
        identity: "api_token"
      },
      {
        method: "POST",
        path: "/v1/memory/conversation-items/release",
        identity: "api_token"
      },
      {
        method: "POST",
        path: "/v1/memory/conversation-items/rebuild",
        identity: "session"
      },
      {
        method: "POST",
        path: "/v1/memory/conversation-items/project",
        identity: "api_token"
      }
    ]);
    expect(
      openApiPaths["/v1/memory/conversation-items/release"]?.post
    ).toMatchObject({
      security: [{ bearerApiToken: [] }],
      "x-koed-identity": "api_token",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["sessionId", "externalTurnId"],
              properties: {
                sessionId: { type: "string", format: "uuid" },
                externalTurnId: { type: "string", maxLength: 512 }
              }
            }
          }
        }
      }
    });
    expect(
      openApiPaths["/v1/memory/conversation-items/rebuild"]?.post
    ).toMatchObject({
      security: [{ sessionCookie: [] }],
      "x-koed-identity": "session",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["sessionId"],
              properties: {
                sessionId: { type: "string", format: "uuid" }
              }
            }
          }
        }
      }
    });
  });

  it("keeps local-edge route identities explicit and future-only credential classes unimplemented", () => {
    expect(
      openApiPaths["/v1/local-edge/device-enrollments/challenges"]?.post
    ).toMatchObject({
      security: [],
      "x-koed-identity": "public"
    });
    expect(
      openApiPaths["/v1/local-edge/device-enrollments/challenges/{challengeId}"]
        ?.get
    ).toMatchObject({
      security: [],
      "x-koed-identity": "public"
    });
    expect(
      routeIdentityFor("GET", "/v1/local-edge/device-credentials/status")
    ).toMatchObject({
      identity: "device_credential",
      status: "implemented"
    });
    expect(
      openApiPaths["/v1/local-edge/device-credentials/status"]?.get
    ).toMatchObject({
      security: [{ deviceCredential: [] }],
      "x-koed-identity": "device_credential"
    });
    expect(
      openApiPaths["/v1/local-edge/device-credentials/current"]?.delete
    ).toMatchObject({
      security: [{ deviceCredential: [] }],
      "x-koed-identity": "device_credential"
    });
    expect(openApiSecuritySchemes.deviceCredential).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "Authorization",
      description: expect.stringContaining("Koed-Device")
    });
    for (const path of [
      "/v1/local-edge/team-memory/search",
      "/v1/local-edge/team-memory/answer",
      "/v1/local-edge/team-memory/expand",
      "/v1/local-edge/team-memory/questions/final"
    ]) {
      expect(openApiPaths[path]).toBeUndefined();
      expect(routeIdentityFor("POST", path)).toMatchObject({
        identity: "local_edge_client_credential",
        status: "not_implemented"
      });
    }
    expect(
      routeIdentityContracts.filter(
        (contract) => contract.identity === "upstream_credential"
      )
    ).toEqual([
      expect.objectContaining({
        path: "/v1/local-edge/upstream-credential-operations",
        status: "not_implemented"
      })
    ]);
    expect(
      routeIdentityContracts.filter(
        (contract) => contract.identity === "internal_service_token"
      )
    ).toEqual([
      expect.objectContaining({
        path: "/v1/internal/jobs",
        status: "not_implemented"
      })
    ]);
    expect(
      openApiPaths["/v1/local-edge/upstream-credential-operations"]
    ).toBeUndefined();
    expect(openApiPaths["/v1/internal/jobs"]).toBeUndefined();
  });

  it("keeps every managed runner route behind a device credential", () => {
    const runnerRoutes = implementedRouteIdentityContracts.filter((contract) =>
      contract.path.startsWith("/v1/managed-conversation-runner/")
    );

    expect(runnerRoutes).toHaveLength(45);
    for (const contract of runnerRoutes) {
      expect(contract).toMatchObject({
        identity: "device_credential",
        teamAuthority: "none"
      });
      expect(
        openApiPaths[contract.path]?.[contract.method.toLowerCase()]
      ).toMatchObject({
        security: [{ deviceCredential: [] }],
        "x-koed-identity": "device_credential",
        "x-koed-team-authority": "none"
      });
    }
  });

  it("pins public, session, API-token, and mixed route security in OpenAPI", () => {
    expect(openApiPaths["/v1/capabilities"]?.get).toMatchObject({
      security: [],
      "x-koed-identity": "public",
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                required: expect.arrayContaining([
                  "apiVersion",
                  "capabilitySchemaVersion",
                  "deployment",
                  "capabilities"
                ])
              }
            }
          }
        }
      }
    });
    expect(openApiPaths["/auth/workos/login"]?.get).toMatchObject({
      security: [],
      "x-koed-identity": "public"
    });
    expect(openApiPaths["/auth/workos/callback"]?.get).toMatchObject({
      security: [],
      "x-koed-identity": "public"
    });
    expect(openApiPaths["/v1/capabilities/authenticated"]?.get).toMatchObject({
      security: [{ sessionCookie: [] }],
      "x-koed-identity": "session",
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                properties: {
                  capabilities: {
                    additionalProperties: {
                      required: ["availability", "audience", "description"]
                    }
                  }
                }
              }
            }
          }
        }
      }
    });
    expect(openApiPaths["/v1/access/check"]?.get).toMatchObject({
      security: [{ bearerApiToken: [] }],
      "x-koed-identity": "api_token"
    });
    expect(openApiPaths["/v1/historical-imports"]?.post).toMatchObject({
      security: [{ sessionCookie: [] }, { bearerApiToken: [] }],
      "x-koed-identity": "session_or_api_token",
      "x-koed-team-authority": "none",
      "x-koed-deployment-modes": ["developer", "local_personal"]
    });
    expect(openApiPaths["/v1/historical-import-admission"]?.get).toMatchObject({
      security: [{ sessionCookie: [] }, { bearerApiToken: [] }],
      "x-koed-identity": "session_or_api_token",
      "x-koed-team-authority": "none",
      "x-koed-deployment-modes": ["developer", "local_personal"]
    });
    expect(
      openApiPaths["/v1/historical-import-sources/lookup"]?.get
    ).toMatchObject({
      security: [{ sessionCookie: [] }, { bearerApiToken: [] }],
      "x-koed-identity": "session_or_api_token",
      "x-koed-team-authority": "none",
      "x-koed-deployment-modes": ["developer", "local_personal"]
    });
    expect(
      openApiPaths["/v1/historical-import-sources/{sourceId}/batches"]?.post
    ).toMatchObject({
      security: [{ sessionCookie: [] }, { bearerApiToken: [] }],
      "x-koed-team-authority": "none"
    });
    expect(
      openApiPaths["/v1/conversation-source-artifacts"]?.post
    ).toMatchObject({
      security: [{ sessionCookie: [] }, { bearerApiToken: [] }],
      "x-koed-identity": "session_or_api_token",
      "x-koed-team-authority": "none",
      "x-koed-deployment-modes": ["developer", "local_personal"]
    });
    expect(
      openApiPaths[
        "/v1/conversation-source-artifacts/{artifactId}/segments/{segmentId}/content"
      ]?.get
    ).toMatchObject({
      security: [{ sessionCookie: [] }, { bearerApiToken: [] }],
      "x-koed-identity": "session_or_api_token",
      "x-koed-team-authority": "none",
      "x-koed-deployment-modes": ["developer", "local_personal"]
    });
    expect(
      openApiPaths["/v1/historical-import-sources/{sourceId}/live-cursor"]
    ).toBeUndefined();
    expect(openApiPaths["/v1/memory/answer"]?.post).toMatchObject({
      security: [{ sessionCookie: [] }, { bearerApiToken: [] }],
      "x-koed-identity": "session_or_api_token",
      "x-koed-team-authority": "none"
    });
    expect(openApiPaths["/self-host/status"]?.get).toMatchObject({
      security: [{}, { sessionCookie: [] }],
      "x-koed-identity": "optional_session"
    });
    expect(openApiPaths["/ops/status"]?.get).toMatchObject({
      security: [{ sessionCookie: [] }],
      "x-koed-identity": "session"
    });
    expect(openApiPaths["/ops/test-alert"]?.post).toMatchObject({
      security: [{ sessionCookie: [] }],
      "x-koed-identity": "session",
      "x-koed-domain": "operations"
    });
    expect(openApiPaths["/v1/memory/curated/proposals"]?.post).toMatchObject({
      security: [{ bearerApiToken: [] }],
      "x-koed-identity": "api_token",
      "x-koed-domain": "personal_memory"
    });
    expect(
      openApiPaths["/v1/memory/curated/assertions/{assertionId}"]?.get
    ).toMatchObject({
      security: [{ bearerApiToken: [] }],
      "x-koed-identity": "api_token",
      "x-koed-domain": "personal_memory"
    });
    expect(
      openApiPaths["/v1/memory/curated/assertions/{assertionId}/suppress"]?.post
    ).toMatchObject({
      security: [{ bearerApiToken: [] }],
      "x-koed-identity": "api_token",
      "x-koed-domain": "personal_memory"
    });
    expect(openApiPaths["/v1/analytics/activation-funnel"]?.get).toMatchObject({
      security: [{ sessionCookie: [] }],
      "x-koed-identity": "session",
      "x-koed-domain": "analytics"
    });
    expect(openApiPaths["/v1/analytics/activation-events"]?.post).toMatchObject(
      {
        security: [{ sessionCookie: [] }],
        "x-koed-identity": "session",
        "x-koed-domain": "analytics"
      }
    );
  });

  it("documents PDS relay proof-only routes", () => {
    expect(
      routeIdentityFor("POST", "/v1/personal-device-sync/relay/transports")
    ).toMatchObject({ identity: "pds_relay_proof", status: "implemented" });
    expect(
      openApiPaths["/v1/personal-device-sync/relay/transports"]?.post
    ).toMatchObject({
      security: [{ pdsRelayProof: [] }],
      "x-koed-identity": "pds_relay_proof"
    });
    expect(openApiSecuritySchemes.pdsRelayProof).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "X-PDS-Relay-Proof"
    });
  });

  it("documents Team authority and scoped device credential access", () => {
    expect(
      routeIdentityFor("POST", "/v1/teams/{teamId}/invites")
    ).toMatchObject({
      identity: "session_or_device_credential",
      teamAuthority: "request_time_team_admin"
    });
    expect(
      routeIdentityFor("PUT", "/v1/teams/{teamId}/entitlement")
    ).toMatchObject({
      identity: "session_or_device_credential",
      teamAuthority: "request_time_team_admin"
    });
    expect(
      routeIdentityFor("GET", "/v1/teams/{teamId}/billing-seats")
    ).toMatchObject({
      identity: "session_or_device_credential",
      teamAuthority: "request_time_team_admin"
    });
    expect(
      routeIdentityFor("GET", "/v1/teams/{teamId}/support/overview")
    ).toMatchObject({
      identity: "session_or_device_credential",
      domain: "operations",
      teamAuthority: "request_time_team_admin"
    });
    expect(
      routeIdentityFor("GET", "/ops/support/teams/{teamId}/overview")
    ).toMatchObject({
      identity: "session",
      domain: "operations",
      teamAuthority: "none"
    });
    expect(
      routeIdentityFor("POST", "/ops/support/teams/{teamId}/bundle")
    ).toMatchObject({
      identity: "session",
      domain: "operations",
      teamAuthority: "none"
    });
    expect(
      routeIdentityFor("PUT", "/v1/teams/{teamId}/billing-seats/policy")
    ).toMatchObject({
      identity: "session_or_device_credential",
      teamAuthority: "request_time_team_admin"
    });
    expect(
      routeIdentityFor("PUT", "/v1/team-workspaces/{teamWorkspaceId}/access")
    ).toMatchObject({
      identity: "session_or_device_credential",
      teamAuthority: "request_time_team_workspace"
    });
    expect(routeIdentityFor("GET", "/v1/team-context")).toMatchObject({
      identity: "session_or_device_credential",
      teamAuthority: "request_time_team_workspace"
    });
    expect(
      routeIdentityFor(
        "GET",
        "/v1/team-workspaces/{teamWorkspaceId}/session-share-grants"
      )
    ).toBeUndefined();
    expect(
      routeIdentityFor(
        "POST",
        "/v1/team-workspaces/{teamWorkspaceId}/session-share-grants"
      )
    ).toBeUndefined();
    expect(
      routeIdentityFor(
        "DELETE",
        "/v1/team-workspaces/{teamWorkspaceId}/session-share-grants/{shareGrantId}"
      )
    ).toBeUndefined();
    expect(routeIdentityFor("POST", "/v1/memory/search")).toMatchObject({
      identity: "api_token",
      domain: "personal_memory",
      teamAuthority: "none"
    });
    expect(routeIdentityFor("POST", "/v1/memory/answer")).toMatchObject({
      identity: "session_or_api_token",
      domain: "personal_memory",
      teamAuthority: "none"
    });
    expect(
      routeIdentityFor("GET", "/v1/memory/nodes/{nodeId}/expand")
    ).toMatchObject({
      identity: "api_token",
      domain: "personal_memory",
      teamAuthority: "none"
    });
    for (const path of [
      "/v1/memory/graph/nodes",
      "/v1/memory/graph/nodes/{nodeId}",
      "/v1/memory/graph/events",
      "/v1/memory/graph/threads",
      "/v1/memory/graph/events/{eventId}",
      "/v1/memory/graph/stream"
    ]) {
      expect(routeIdentityFor("GET", path)).toMatchObject({
        identity: "session_or_api_token",
        domain: "personal_memory",
        teamAuthority: "none"
      });
    }
  });

  it("exports the full current Team collaboration and administration route inventory", () => {
    const routeFamilies = {
      collaboration: [
        "GET /v1/teams/navigation",
        "GET /v1/collaboration/teams/{teamId}/participants",
        "GET /v1/collaboration/teams/{teamId}/threads",
        "GET /v1/collaboration/teams/{teamId}/workspaces/{teamWorkspaceId}/channels",
        "POST /v1/collaboration/teams/{teamId}/workspaces/{teamWorkspaceId}/channels",
        "GET /v1/collaboration/teams/{teamId}/direct-messages",
        "POST /v1/collaboration/teams/{teamId}/direct-messages",
        "POST /v1/collaboration/teams/{teamId}/group-direct-messages",
        "POST /v1/collaboration/teams/{teamId}/workspaces/{teamWorkspaceId}/shared-sessions/{sharedLogicalMemoryId}/discussion",
        "GET /v1/collaboration/teams/{teamId}/threads/{threadId}",
        "PATCH /v1/collaboration/teams/{teamId}/threads/{threadId}/name",
        "PATCH /v1/collaboration/teams/{teamId}/threads/{threadId}/topic",
        "POST /v1/collaboration/teams/{teamId}/threads/{threadId}/archive",
        "POST /v1/collaboration/teams/{teamId}/threads/{threadId}/restore",
        "GET /v1/collaboration/teams/{teamId}/threads/{threadId}/messages",
        "POST /v1/collaboration/teams/{teamId}/threads/{threadId}/messages",
        "PUT /v1/collaboration/teams/{teamId}/threads/{threadId}/delivery-state",
        "PUT /v1/collaboration/teams/{teamId}/threads/{threadId}/read-state",
        "POST /v1/collaboration/realtime/snapshot",
        "POST /v1/collaboration/realtime/ack",
        "GET /v1/collaboration/realtime/stream",
        "POST /v1/local-edge/collaboration/command",
        "POST /v1/local-edge/collaboration/realtime/subscriptions",
        "POST /v1/local-edge/collaboration/realtime/subscriptions/{subscriptionId}/ack",
        "GET /v1/local-edge/collaboration/realtime/subscriptions/{subscriptionId}/stream",
        "DELETE /v1/local-edge/collaboration/realtime/backends/{backendId}/subscriptions",
        "DELETE /v1/local-edge/collaboration/realtime/subscriptions/{subscriptionId}"
      ],
      shared_memory: [
        "PUT /v1/shared-memory/source-owner-policies/{logicalMemoryId}",
        "PUT /v1/shared-memory/teams/{teamId}/policy",
        "PUT /v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/policy",
        "POST /v1/shared-memory/previews",
        "POST /v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/consents",
        "POST /v1/shared-memory/share-grants",
        "PUT /v1/shared-memory/share-grants/{shareGrantId}/representation",
        "PUT /v1/shared-memory/share-grants/{shareGrantId}/representations/{representation}",
        "POST /v1/shared-memory/share-grants/{shareGrantId}/revoke",
        "PUT /v1/shared-memory/share-grants/{shareGrantId}/transcript-access",
        "POST /v1/shared-memory/share-grants/{shareGrantId}/transcript-access/revoke",
        "GET /v1/shared-memory/share-grants/{shareGrantId}/transcript/manifest",
        "GET /v1/shared-memory/share-grants/{shareGrantId}/transcript/segments/{segmentId}",
        "GET /v1/shared-memory/share-grants/{shareGrantId}/transcript/stream",
        "POST /v1/shared-memory/share-grants/{shareGrantId}/transcript/fork-snapshot",
        "GET /v1/shared-memory/logical-memories/{logicalMemoryId}/share-grants",
        "GET /v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/share-grants",
        "GET /v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/share-grants/{shareGrantId}",
        "GET /v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/share-grants/{shareGrantId}/initial-view",
        "GET /v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/share-grants/{shareGrantId}/page",
        "GET /v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/share-grants/{shareGrantId}/items",
        "GET /v1/shared-memory/teams/{teamId}/workspaces/{teamWorkspaceId}/share-grants/{shareGrantId}/items/{sourceId}"
      ],
      team_memory: [
        "GET /v1/teams",
        "POST /v1/teams",
        "GET /v1/team-context",
        "GET /v1/teams/{teamId}/membership",
        "GET /v1/teams/{teamId}/members",
        "GET /v1/teams/{teamId}/members/manage",
        "PATCH /v1/teams/{teamId}/members/{userId}/role",
        "POST /v1/teams/{teamId}/members/{userId}/disable",
        "POST /v1/teams/{teamId}/leave",
        "GET /v1/teams/{teamId}/invites",
        "POST /v1/teams/{teamId}/invites",
        "DELETE /v1/teams/{teamId}/invites/{inviteId}",
        "POST /v1/team-invites/accept",
        "GET /v1/teams/{teamId}/audit-events",
        "GET /v1/teams/{teamId}/entitlement",
        "PUT /v1/teams/{teamId}/entitlement",
        "GET /v1/teams/{teamId}/billing-seats",
        "GET /v1/teams/{teamId}/support/overview",
        "PUT /v1/teams/{teamId}/billing-seats/policy",
        "GET /v1/teams/{teamId}/workspaces",
        "POST /v1/teams/{teamId}/workspaces",
        "POST /v1/team-workspaces",
        "GET /v1/team-workspaces/{teamWorkspaceId}/context",
        "GET /v1/team-workspaces/{teamWorkspaceId}/access",
        "POST /v1/team-workspaces/{teamWorkspaceId}/archive",
        "POST /v1/team-workspaces/{teamWorkspaceId}/restore",
        "PUT /v1/team-workspaces/{teamWorkspaceId}/access"
      ],
      high_risk: [
        "POST /v1/high-risk/action-grants",
        "GET /v1/high-risk/action-grants/{clientRequestId}",
        "GET /v1/high-risk/action-grants/{clientRequestId}/await",
        "DELETE /v1/high-risk/action-grants/{clientRequestId}",
        "GET /v1/high-risk/browser-activations/{selector}",
        "POST /v1/high-risk/browser-activations/{selector}/decision"
      ],
      retention: [
        "POST /v1/retention/teams/{teamId}/deletion-request",
        "POST /v1/retention/owner-private-replicas/{ownerPrivateReplicaId}/purge-request",
        "POST /v1/retention/users/me/erasure-request",
        "POST /v1/retention/legal-holds",
        "POST /v1/retention/legal-holds/{holdId}/release-request",
        "POST /v1/retention/legal-holds/{holdId}/release-confirmation"
      ]
    } as const;

    for (const [domain, expectedRoutes] of Object.entries(routeFamilies)) {
      const contracts = implementedRouteIdentityContracts.filter(
        (contract) =>
          contract.domain === domain ||
          (domain === "team_memory" &&
            contract.path === "/v1/teams/{teamId}/support/overview")
      );
      expect(
        contracts.map(({ method, path }) => `${method} ${path}`).sort()
      ).toEqual([...expectedRoutes].sort());
      for (const contract of contracts) {
        const operation =
          openApiPaths[contract.path]?.[contract.method.toLowerCase()];
        expect(operation).toMatchObject({
          "x-koed-identity": contract.identity,
          "x-koed-domain": contract.domain,
          "x-koed-deployment-modes": contract.deploymentModes
        });
      }
    }

    const localCollaboration = implementedRouteIdentityContracts.filter(
      (contract) => contract.path.startsWith("/v1/local-edge/collaboration/")
    );
    expect(localCollaboration).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: "local_edge_client_credential",
          teamAuthority: "future_request_time",
          deploymentModes: ["developer", "local_personal"]
        })
      ])
    );
    expect(
      localCollaboration.every(
        (contract) => contract.identity === "local_edge_client_credential"
      )
    ).toBe(true);

    for (const path of [
      "/v1/teams/{teamId}/entitlement",
      "/v1/shared-memory/previews",
      "/v1/retention/legal-holds"
    ]) {
      expect(
        implementedRouteIdentityContracts.find(
          (contract) => contract.path === path
        )?.identity
      ).toBe("session_or_device_credential");
    }
  });

  it("keeps removed Team compatibility routes out of contracts and OpenAPI", () => {
    const legacyRoutes = [
      "GET /v1/team-chat/threads",
      "GET /v1/team-chat/members",
      "POST /v1/team-chat/threads",
      "GET /v1/team-chat/threads/{threadId}/messages",
      "POST /v1/team-chat/threads/{threadId}/messages",
      "PUT /v1/team-chat/threads/{threadId}/read",
      "GET /v1/team-chat/events",
      "GET /v1/team-chat/stream",
      "POST /v1/teams/{teamId}/members",
      "GET /v1/team-workspaces/{teamWorkspaceId}/session-share-grants",
      "POST /v1/team-workspaces/{teamWorkspaceId}/session-share-grants",
      "DELETE /v1/team-workspaces/{teamWorkspaceId}/session-share-grants/{shareGrantId}",
      "POST /v1/local-edge/upstream-operations"
    ] as const;

    for (const key of legacyRoutes) {
      const [method, path] = key.split(" ") as [
        Parameters<typeof routeIdentityFor>[0],
        string
      ];
      expect(routeIdentityFor(method, path)).toBeUndefined();
      expect(openApiPaths[path]?.[method.toLowerCase()]).toBeUndefined();
    }
  });

  it("exports deployment-mode applicability through OpenAPI", () => {
    expect(openApiPaths["/v1/capabilities"]?.get).toMatchObject({
      "x-koed-deployment-modes": [
        "developer",
        "local_personal",
        "private_vps",
        "team_self_hosted",
        "koed_managed_cloud"
      ]
    });
    expect(openApiPaths["/auth/workos/login"]?.get).toMatchObject({
      "x-koed-deployment-modes": ["team_self_hosted", "koed_managed_cloud"]
    });
    expect(openApiPaths["/v1/teams/{teamId}/entitlement"]?.put).toMatchObject({
      "x-koed-deployment-modes": [
        "private_vps",
        "team_self_hosted",
        "koed_managed_cloud"
      ]
    });
    expect(
      openApiPaths["/v1/teams/{teamId}/billing-seats/policy"]?.put
    ).toMatchObject({
      "x-koed-deployment-modes": [
        "private_vps",
        "team_self_hosted",
        "koed_managed_cloud"
      ]
    });
    expect(
      openApiPaths["/v1/teams/{teamId}/support/overview"]?.get
    ).toMatchObject({
      "x-koed-deployment-modes": [
        "private_vps",
        "team_self_hosted",
        "koed_managed_cloud"
      ]
    });
    expect(
      openApiPaths["/ops/support/teams/{teamId}/overview"]?.get
    ).toMatchObject({
      "x-koed-deployment-modes": [
        "private_vps",
        "team_self_hosted",
        "koed_managed_cloud"
      ]
    });
    expect(
      openApiPaths["/ops/support/teams/{teamId}/bundle"]?.post
    ).toMatchObject({
      "x-koed-deployment-modes": [
        "private_vps",
        "team_self_hosted",
        "koed_managed_cloud"
      ]
    });
    expect(
      openApiPaths["/v1/team-workspaces/{teamWorkspaceId}/session-share-grants"]
    ).toBeUndefined();
    expect(
      openApiPaths[
        "/v1/team-workspaces/{teamWorkspaceId}/session-share-grants/{shareGrantId}"
      ]
    ).toBeUndefined();
    for (const path of [
      "/v1/local-edge/team-memory/search",
      "/v1/local-edge/team-memory/answer",
      "/v1/local-edge/team-memory/expand"
    ]) {
      expect(openApiPaths[path]).toBeUndefined();
    }
  });
});
