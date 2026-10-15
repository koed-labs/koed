import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { z } from "zod";
import { fetchBoundedJsonObject } from "@koed/shared";
import type { MemorySourceRepository, RemoteMcpOAuthStore } from "@koed/db";
import type { RateLimitStore } from "../infra/rate-limit.js";
import {
  DelegatedAuthenticationError,
  remoteMcpGrantTtlMs,
  type RemoteMcpDelegatedPrincipal
} from "./remote-mcp-oauth.js";
import type { WorkosAgentRegistrationConfig } from "./workos-agent-config.js";

const claimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string()).min(1)]),
  sub: z.string().regex(/^agent_reg_[A-Za-z0-9_]{1,120}$/),
  act: z.object({ sub: z.string().regex(/^user_[A-Za-z0-9_]{1,120}$/) }),
  org_id: z.string(),
  scope: z.string().max(4096),
  exp: z.number().int().positive(),
  nbf: z.number().int().optional()
});
const validationSchema = z.object({
  valid: z.literal(true),
  registration_id: z.string(),
  expires_at: z.string().datetime().optional()
});
const registrationSchema = z.object({
  id: z.string(),
  status: z.literal("verified"),
  kind: z.enum(["service_auth", "identity_assertion"]),
  organization_id: z.string()
});

/** Select the external verifier once; invalid JWTs must not become API Tokens. */
export const isWorkosAgentCredential = (token: string): boolean =>
  token.split(".").length === 3;

export const createWorkosAgentRegistration = (options: {
  config: WorkosAgentRegistrationConfig;
  resourceUrl: string;
  apiKey: string;
  clientId: string;
  providerEnvironment: string;
  grantStore: Pick<RemoteMcpOAuthStore, "resolveExternalGrant">;
  requireRepository: () => Pick<
    MemorySourceRepository,
    "getExternalAuthIdentity" | "getExternalAuthOrganization" | "getUser"
  >;
  rateLimitStore: RateLimitStore;
  requestFetch?: typeof fetch;
}) => {
  const requestFetch =
    options.requestFetch ?? globalThis.fetch.bind(globalThis);
  const { config } = options;
  const budgetKey = `workos-agent:${createHash("sha256").update(config.issuer).digest("hex")}`;
  let active = 0;
  const denied = (): never => {
    throw new DelegatedAuthenticationError(401);
  };
  const json = async (
    path: string,
    body?: unknown
  ): Promise<Record<string, unknown>> => {
    const budget = await options.rateLimitStore.increment(budgetKey, 60_000);
    if (budget.count > config.requestsPerMinute)
      throw new DelegatedAuthenticationError(
        429,
        Math.max(1000, budget.resetAt - Date.now())
      );
    const { response, payload } = await fetchBoundedJsonObject(
      requestFetch,
      `https://api.workos.com${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      },
      { timeoutMs: 5000, maxBytes: 32_768 }
    );
    if (response.status === 429) {
      const delay = Number(response.headers.get("retry-after"));
      throw new DelegatedAuthenticationError(
        429,
        Number.isFinite(delay) && delay > 0
          ? Math.min(60_000, Math.ceil(delay * 1000))
          : 5000
      );
    }
    if (response.status >= 500) throw new DelegatedAuthenticationError(503);
    if (!response.ok) denied();
    return payload;
  };

  return {
    async admitCaller(callerKey: string): Promise<void> {
      // Limit the transport peer before any authentication can spend provider calls.
      const limit = Math.max(1, Math.floor(config.requestsPerMinute / 4));
      const bucket = await options.rateLimitStore.increment(
        `${budgetKey}:caller:${callerKey}`,
        60_000
      );
      if (bucket.count > limit)
        throw new DelegatedAuthenticationError(
          429,
          Math.max(1000, bucket.resetAt - Date.now())
        );
    },
    async resolvePrincipal(
      token: string
    ): Promise<RemoteMcpDelegatedPrincipal> {
      if (token.length > 16_384 || !isWorkosAgentCredential(token)) denied();
      // Decode only for early rejection; no claim grants authority until the
      // WorkOS API validates this exact credential against the resource.
      let claims: z.infer<typeof claimsSchema>;
      try {
        claims = claimsSchema.parse(decodeJwt(token));
      } catch {
        return denied();
      }
      const now = Math.floor(Date.now() / 1000);
      if (
        claims.iss !== config.issuer ||
        !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(
          options.resourceUrl
        ) ||
        claims.exp <= now ||
        (claims.nbf !== undefined && claims.nbf > now) ||
        !config.allowedOrganizationIds.includes(claims.org_id)
      )
        denied();
      if (active >= 8) throw new DelegatedAuthenticationError(503);
      active++;
      try {
        const validationResult = await json("/agents/credentials/validate", {
          type: "access_token",
          credential: token,
          audience: options.resourceUrl
        });
        if (validationResult.valid === false) denied();
        const validation = validationSchema.parse(validationResult);
        if (validation.registration_id !== claims.sub) denied();
        const registrationResult = await json(
          `/agents/registrations/${encodeURIComponent(claims.sub)}`
        );
        if (
          ["unverified", "expired", "revoked"].includes(
            String(registrationResult.status)
          ) ||
          registrationResult.kind === "anonymous"
        )
          denied();
        const registration = registrationSchema.parse(registrationResult);
        if (
          registration.id !== claims.sub ||
          registration.organization_id !== claims.org_id
        )
          denied();
        const expiresAt = Math.min(
          claims.exp,
          validation.expires_at
            ? Date.parse(validation.expires_at) / 1000
            : claims.exp
        );
        if (expiresAt <= Date.now() / 1000) denied();
        const repository = options.requireRepository();
        const identity = await repository.getExternalAuthIdentity({
          provider: "workos_authkit",
          providerEnvironment: options.providerEnvironment,
          providerUserId: claims.act.sub
        });
        if (
          !identity ||
          identity.status !== "linked" ||
          !identity.emailVerified
        )
          return denied();
        if (!(await repository.getUser(identity.userId))) denied();
        const scopes = [...new Set(claims.scope.split(/\s+/))].filter((scope) =>
          (config.allowedScopes as readonly string[]).includes(scope)
        );
        if (!scopes.includes("koed:memory:read")) denied();
        const organization = scopes.includes("koed:team:read")
          ? await repository.getExternalAuthOrganization({
              provider: "workos_authkit",
              providerEnvironment: options.providerEnvironment,
              providerOrganizationId: claims.org_id
            })
          : null;
        if (
          scopes.includes("koed:team:read") &&
          (!organization || organization.status !== "linked")
        )
          denied();
        const grant = await options.grantStore.resolveExternalGrant({
          issuer: config.issuer,
          providerEnvironment: options.providerEnvironment,
          registrationId: registration.id,
          providerUserId: claims.act.sub,
          providerOrganizationId: claims.org_id,
          userId: identity.userId,
          resource: options.resourceUrl,
          teamBoundaryId: organization?.teamId ?? null,
          scopes,
          now: new Date(),
          expiresAt: new Date(Date.now() + remoteMcpGrantTtlMs)
        });
        if (!grant || !grant.scopes.includes("koed:memory:read")) denied();
        return Object.freeze({
          userId: identity.userId,
          grantId: grant!.id,
          clientId: options.clientId,
          resource: options.resourceUrl,
          scopes: Object.freeze(grant!.scopes),
          expiresAt: Math.min(
            expiresAt,
            Math.floor(grant!.expiresAt.getTime() / 1000)
          ),
          teamBoundaryId: grant!.scopes.includes("koed:team:read")
            ? (organization?.teamId ?? null)
            : null
        });
      } catch (error) {
        if (error instanceof DelegatedAuthenticationError) throw error;
        if (error instanceof z.ZodError)
          throw new DelegatedAuthenticationError(503);
        throw new DelegatedAuthenticationError(503);
      } finally {
        active--;
      }
    }
  };
};
