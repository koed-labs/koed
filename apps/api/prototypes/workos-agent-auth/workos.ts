import { z } from "zod";
import type { RemoteMcpDelegatedPrincipal } from "../../src/auth/remote-mcp-oauth.js";
import { remoteMcpScopes } from "../../src/auth/remote-mcp-oauth.js";

export interface RegistrationConfig {
  issuer: string;
  resource: string;
  organizationId: string;
  workosUserId: string;
  koedUserId: string;
  apiKey: string;
  maxRequests?: number;
}

const claimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1),
  org_id: z.string(),
  act: z.object({ sub: z.string() }),
  exp: z.number().int().positive(),
  scope: z.string()
});

const validationSchema = z.object({
  valid: z.literal(true),
  registration_id: z.string().min(1),
  expires_at: z.string().datetime().optional()
});

const registrationSchema = z.object({
  id: z.string(),
  status: z.literal("verified"),
  kind: z.enum(["service_auth", "identity_assertion"]),
  organization_id: z.string()
});

const denied = (): never => {
  throw new Error("Agent registration is unavailable or not authorised");
};

/** An experiment-only verifier plugged into Koed's existing principal resolver. */
export const createRegistrationResolver = (
  config: RegistrationConfig,
  requestFetch: typeof fetch = globalThis.fetch.bind(globalThis)
) => {
  let requests = 0;
  const maxRequests = config.maxRequests ?? 40;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 100)
    throw new Error("Prototype request budget must be between 1 and 100");
  const issuer = new URL(config.issuer);
  if (
    issuer.protocol !== "https:" ||
    !issuer.hostname.endsWith(".authkit.app") ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    issuer.pathname !== "/" ||
    issuer.port
  )
    throw new Error(
      "Use the default HTTPS AuthKit domain, not a custom domain"
    );
  if (
    !config.apiKey ||
    !config.organizationId ||
    !config.workosUserId ||
    !config.koedUserId
  )
    throw new Error(
      "Explicit staging identity and organisation bindings are required"
    );

  const json = async (path: string, body?: unknown): Promise<unknown> => {
    if (requests >= maxRequests) denied();
    requests++;
    const response = await requestFetch(`https://api.workos.com${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) denied();
    return response.json();
  };

  return {
    requestCount: () => requests,
    async authDocument(): Promise<string> {
      if (requests >= maxRequests) denied();
      requests++;
      const response = await requestFetch(new URL("/agent/auth.md", issuer), {
        redirect: "error",
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) denied();
      const text = await response.text();
      if (Buffer.byteLength(text) > 64_000) denied();
      return text;
    },
    async resolve(token: string): Promise<RemoteMcpDelegatedPrincipal> {
      try {
        if (token.length > 16_000 || token.split(".").length !== 3) denied();
        // The WorkOS API verifies the credential and its audience before any
        // decoded claims are trusted. Online validation also sees revocation.
        const validation = validationSchema.parse(
          await json("/agents/credentials/validate", {
            type: "access_token",
            credential: token,
            audience: config.resource
          })
        );
        const claims = claimsSchema.parse(
          JSON.parse(
            Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")
          )
        );
        if (
          claims.iss !== issuer.origin ||
          !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(
            config.resource
          ) ||
          claims.sub !== validation.registration_id ||
          claims.org_id !== config.organizationId ||
          claims.act.sub !== config.workosUserId ||
          claims.exp <= Date.now() / 1000
        )
          denied();
        const registration = registrationSchema.parse(
          await json(
            `/agents/registrations/${encodeURIComponent(validation.registration_id)}`
          )
        );
        if (
          registration.id !== claims.sub ||
          registration.organization_id !== config.organizationId
        )
          denied();
        const expiresAt = Math.min(
          claims.exp,
          validation.expires_at
            ? Date.parse(validation.expires_at) / 1000
            : claims.exp
        );
        if (expiresAt <= Date.now() / 1000) denied();
        const scopes = [...new Set(claims.scope.split(/\s+/))].filter((scope) =>
          (remoteMcpScopes as readonly string[]).includes(scope)
        );
        if (!scopes.includes("koed:memory:read")) denied();
        return Object.freeze({
          userId: config.koedUserId,
          grantId: claims.sub,
          clientId: "workos-agent-registration-prototype",
          resource: config.resource,
          scopes: Object.freeze(scopes),
          expiresAt
        });
      } catch {
        return denied();
      }
    }
  };
};
