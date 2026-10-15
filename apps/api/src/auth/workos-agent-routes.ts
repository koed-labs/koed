import type { FastifyInstance } from "fastify";
import type { RateLimitHandler } from "../infra/rate-limit.js";
import type { WorkosAgentRegistrationConfig } from "./workos-agent-config.js";

export const registerWorkosAgentRoutes = (
  app: FastifyInstance,
  options: {
    config: WorkosAgentRegistrationConfig;
    resourceUrl: string;
    rateLimit: RateLimitHandler;
  }
) => {
  const resource = new URL(options.resourceUrl);
  app.get("/auth.md", { preHandler: options.rateLimit }, (_request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'"
    );
    return reply.type("text/markdown; charset=utf-8")
      .send(`# Connect an AI Client to Koed

MCP resource: ${resource.href}
Authorisation server: ${options.config.issuer}
Supported scopes: ${options.config.allowedScopes.join(" ")}

1. Ask the User to sign in to Koed at ${resource.origin}/auth/workos/login?return_to=/auth/mcp/connections first. This establishes their verified account link. Do not create or link an account by matching an email address.
2. Read ${options.config.issuer}/agent/auth.md for the WorkOS registration and credential exchange steps. Use service_auth, not anonymous registration. Ask the User to complete the hosted sign-in and confirmation. Never approve on their behalf.
3. Request only the permissions the User agreed to, within the supported scopes above. Set resource=${resource.href} during credential exchange. Use a short-lived access token, not an API key, identity assertion or browser session token.
4. Keep the resulting credential and any refresh material in the AI Client's protected credential storage. Never print them in conversation, write them to AGENTS.md, commit them or put them in a URL. Configure the MCP connection for ${resource.href} using that credential.
5. Follow the WorkOS guide when the credential expires. Koed authorisation lasts at most 30 days. The User can view and disconnect connections at ${resource.origin}/auth/mcp/connections. If Koed authorisation is disconnected or expired, ask the User to sign in there and explicitly authorise the connection again. Do not create another registration to bypass a disconnect. A valid replacement WorkOS token does not restore Koed authorisation. On HTTP 429 respect Retry-After. On HTTP 503 retry later; do not start another registration just because the service is temporarily unavailable.

Personal Memory requires koed:memory:read. Team Memory also requires koed:team:read and is limited to the Koed Team mapped to this WorkOS organisation. The User must already have active Team Membership and Workspace Access; only authorised Shared Memory is available. Registration does not create those permissions. Capture and local execution require their separate scopes when enabled. Koed's existing OAuth authorisation flow remains available.

The existing User-owned Local AI Runtime must be connected and running for Memory Answer synthesis, LCM Summaries and automatic capture. This connection does not install a helper, enable capture or upload past conversations. Koed does not run backend LLM synthesis. Use the existing koed remote setup and login commands for helper setup with the User's permission.
`);
  });
};
