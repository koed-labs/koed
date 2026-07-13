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
    expect(openApiSecuritySchemes.deviceCredential).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "Authorization",
      description: expect.stringContaining("Koed-Device")
    });
    expect(
      openApiPaths["/v1/local-edge/upstream-operations"]?.post
    ).toMatchObject({
      security: [{ bearerApiToken: [] }, { deviceCredential: [] }],
      "x-koed-identity": "api_token_or_device_credential"
    });
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
    expect(openApiPaths["/v1/memory/answer"]?.post).toMatchObject({
      security: [
        { sessionCookie: [] },
        { bearerApiToken: [] },
        { deviceCredential: [] }
      ],
      "x-koed-identity": "conditional_team_session_or_device"
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

  it("documents Team authority as request-time session-bound checks", () => {
    expect(
      routeIdentityFor("POST", "/v1/teams/{teamId}/invites")
    ).toMatchObject({
      identity: "session",
      teamAuthority: "request_time_team_admin"
    });
    expect(
      routeIdentityFor("PUT", "/v1/teams/{teamId}/entitlement")
    ).toMatchObject({
      identity: "session",
      teamAuthority: "request_time_team_admin"
    });
    expect(
      routeIdentityFor("GET", "/v1/teams/{teamId}/billing-seats")
    ).toMatchObject({
      identity: "session",
      teamAuthority: "request_time_team_admin"
    });
    expect(
      routeIdentityFor("GET", "/v1/teams/{teamId}/support/overview")
    ).toMatchObject({
      identity: "session",
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
      identity: "session",
      teamAuthority: "request_time_team_admin"
    });
    expect(
      routeIdentityFor("PUT", "/v1/team-workspaces/{teamWorkspaceId}/access")
    ).toMatchObject({
      identity: "session",
      teamAuthority: "request_time_team_workspace"
    });
    expect(
      routeIdentityFor(
        "POST",
        "/v1/team-workspaces/{teamWorkspaceId}/session-share-grants"
      )
    ).toMatchObject({
      identity: "session",
      teamAuthority: "request_time_team_workspace"
    });
    expect(routeIdentityFor("POST", "/v1/memory/search")).toMatchObject({
      identity: "conditional_team_session_or_device",
      description:
        "Personal recall search uses API Token; Team Workspace recall requires session or scoped device credential."
    });
    expect(routeIdentityFor("POST", "/v1/memory/answer")).toMatchObject({
      identity: "conditional_team_session_or_device",
      teamAuthority: "request_time_team_workspace"
    });
    expect(
      routeIdentityFor("GET", "/v1/memory/nodes/{nodeId}/expand")
    ).toMatchObject({
      identity: "conditional_team_session_or_device",
      teamAuthority: "request_time_team_workspace"
    });
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
        ?.post
    ).toMatchObject({
      "x-koed-deployment-modes": [
        "private_vps",
        "team_self_hosted",
        "koed_managed_cloud"
      ]
    });
    expect(
      openApiPaths["/v1/local-edge/upstream-operations"]?.post
    ).toMatchObject({
      "x-koed-deployment-modes": ["developer", "local_personal"]
    });
  });
});
