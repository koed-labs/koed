import {
  implementedRouteIdentityContracts,
  type RouteIdentity,
  type RouteIdentityContract
} from "./route-identity.js";

type OpenApiSecurityRequirement = Record<string, never[]>;

const capabilityDescriptorSchema = {
  type: "object",
  required: ["availability", "audience", "description"],
  properties: {
    availability: {
      type: "string",
      enum: ["available", "partial", "unavailable"]
    },
    audience: { type: "string", enum: ["public", "authenticated"] },
    description: { type: "string" },
    endpoints: { type: "array", items: { type: "string" } }
  },
  additionalProperties: true
};

const capabilitiesResponseSchema = {
  type: "object",
  required: [
    "apiVersion",
    "capabilitySchemaVersion",
    "deployment",
    "runtime",
    "auth",
    "memory",
    "commercial",
    "security",
    "capabilities"
  ],
  properties: {
    apiVersion: { type: "string" },
    capabilitySchemaVersion: { type: "integer" },
    deployment: { type: "object", additionalProperties: true },
    runtime: { type: "object", additionalProperties: true },
    auth: { type: "object", additionalProperties: true },
    memory: { type: "object", additionalProperties: true },
    commercial: { type: "object", additionalProperties: true },
    security: { type: "object", additionalProperties: true },
    capabilities: {
      type: "object",
      additionalProperties: capabilityDescriptorSchema
    }
  },
  additionalProperties: true
};

const responsesForContract = (contract: RouteIdentityContract) => {
  if (
    contract.path === "/v1/capabilities" ||
    contract.path === "/v1/capabilities/authenticated"
  ) {
    return {
      "200": {
        description: "Versioned Koed capability discovery response.",
        content: {
          "application/json": {
            schema: capabilitiesResponseSchema
          }
        }
      }
    };
  }
  return { "200": { description: "OK" } };
};

const securityForIdentity = (
  identity: RouteIdentity
): Array<OpenApiSecurityRequirement | Record<string, never>> => {
  if (identity === "public") {
    return [];
  }
  if (identity === "optional_session") {
    return [{}, { sessionCookie: [] }];
  }
  if (identity === "session") {
    return [{ sessionCookie: [] }];
  }
  if (identity === "api_token") {
    return [{ bearerApiToken: [] }];
  }
  if (identity === "session_or_api_token") {
    return [{ sessionCookie: [] }, { bearerApiToken: [] }];
  }
  if (identity === "session_or_device_credential") {
    return [{ sessionCookie: [] }, { deviceCredential: [] }];
  }
  if (identity === "conditional_team_session_or_device") {
    return [
      { sessionCookie: [] },
      { bearerApiToken: [] },
      { deviceCredential: [] }
    ];
  }
  if (identity === "device_credential") {
    return [{ deviceCredential: [] }];
  }
  return [];
};

const pathItemFor = (contracts: readonly RouteIdentityContract[]) =>
  Object.fromEntries(
    contracts.map((contract) => [
      contract.method.toLowerCase(),
      {
        responses: responsesForContract(contract),
        security: securityForIdentity(contract.identity),
        "x-koed-identity": contract.identity,
        "x-koed-identity-status": contract.status,
        "x-koed-domain": contract.domain,
        "x-koed-team-authority": contract.teamAuthority,
        "x-koed-deployment-modes": contract.deploymentModes
      }
    ])
  );

const contractsByPath = implementedRouteIdentityContracts.reduce<
  Record<string, RouteIdentityContract[]>
>((groups, contract) => {
  groups[contract.path] = [...(groups[contract.path] ?? []), contract];
  return groups;
}, {});

export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "Koed API", version: "0.1.0" },
  components: {
    securitySchemes: {
      bearerApiToken: { type: "http", scheme: "bearer" },
      deviceCredential: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "Koed-Device keyId:secret"
      },
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "cm_session"
      }
    }
  },
  security: [],
  "x-koed-route-identity-contracts": implementedRouteIdentityContracts,
  paths: Object.fromEntries(
    Object.entries(contractsByPath).map(([path, contracts]) => [
      path,
      pathItemFor(contracts)
    ])
  )
};
