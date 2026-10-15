import Fastify from "fastify";
import type { MemorySourceRepository } from "@koed/db";
import { createAuthHelpers } from "../../src/auth/session.js";
import { registerRemoteMcpRoutes } from "../../src/server/remote-mcp.js";
import {
  createRegistrationResolver,
  type RegistrationConfig
} from "./workos.js";
import { registerFixture } from "./fixture.js";

export const createPrototype = (options: {
  origin: string;
  staging?: RegistrationConfig;
}) => {
  const url = new URL(options.origin);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(
      "The prototype must bind to a literal IPv4 loopback origin"
    );
  const origin = url.origin;
  const app = Fastify({ logger: false, bodyLimit: 16_384 });
  const fixture = options.staging ? null : registerFixture(app, origin);
  const config = options.staging ?? fixture!.config;
  if (config.resource !== `${origin}/mcp`)
    throw new Error(
      "The configured resource must match this prototype's MCP endpoint"
    );
  const resolver = createRegistrationResolver(config, fixture?.requestFetch);
  const user = {
    id: config.koedUserId,
    email: "synthetic@example.test",
    displayName: "Synthetic Prototype User"
  };
  const repository = {
    getUser: async (id: string) => (id === user.id ? user : null),
    getApiTokenUser: async () => null
  } as unknown as MemorySourceRepository;
  const auth = createAuthHelpers(() => repository, {
    hashSecret: () => "unused-no-personal-api-tokens-in-this-prototype",
    cookieSecure: false,
    resolveDelegatedPrincipal: resolver.resolve
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    void reply
      .code(status >= 400 && status <= 599 ? status : 500)
      .send({ error: "Prototype request unavailable or not authorised" });
  });
  app.get("/", async () => ({
    mode: options.staging ? "workos-staging" : "local-fixture",
    data: "synthetic-only",
    authInstructions: `${origin}/auth.md`,
    mcp: `${origin}/mcp`,
    workosRequestsUsed: resolver.requestCount(),
    maxWorkosRequests: config.maxRequests ?? 40
  }));
  app.get("/auth.md", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return reply
      .type("text/markdown; charset=utf-8")
      .send(
        `${await resolver.authDocument()}\n\n## Koed prototype resource\n\nUse resource=${config.resource} for the token exchange. Only use scopes the User approved. Keep credentials in the AI Client or helper's protected credential storage, never in conversation text or AGENTS.md. This prototype contains synthetic data only.\n`
      );
  });
  app.get("/.well-known/oauth-protected-resource/mcp", async () => ({
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: ["koed:memory:read"],
    bearer_methods_supported: ["header"]
  }));
  app.get("/v1/capabilities", async (request) => {
    await auth.authenticateApiToken(request);
    return { capabilitySchemaVersion: 4, capabilities: {} };
  });
  app.get("/v1/access/check", async (request) => {
    const owner = await auth.authenticateApiToken(request);
    return { userId: owner.id, memory: "synthetic-only", authenticated: true };
  });
  // These exercise the existing scope gates, not alternate capture/admin APIs.
  app.post("/v1/sessions", async (request, reply) => {
    await auth.authenticateApiToken(request);
    return reply
      .code(503)
      .send({ error: "Capture is not implemented in this auth prototype" });
  });
  app.post("/v1/memory/answer-tasks/claim", async (request, reply) => {
    await auth.authenticateApiToken(request);
    return reply.code(503).send({ error: "No Local AI Runtime is connected" });
  });
  app.post("/v1/team-workspaces/prototype/members", async (request, reply) => {
    await auth.authenticateSessionOrDeviceCredential(request, "admin");
    return reply
      .code(503)
      .send({ error: "No Team data exists in this prototype" });
  });
  registerRemoteMcpRoutes(app, {
    resourceUrl: new URL(config.resource),
    auth,
    allowedOrigins: [origin],
    teamCollaborationEnabled: false,
    environment: {
      NODE_ENV: "test",
      MEMORY_EXPOSE_DIAGNOSTIC_MEMORY_TOOLS: "true"
    }
  });
  return { app, resolver };
};
