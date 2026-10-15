import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RegistrationConfig } from "./workos.js";

export const fixtureIdentity = {
  organizationId: "org_local_fixture",
  workosUserId: "user_local_fixture",
  koedUserId: "7c07a3cc-5679-4df2-bb67-c86571df93c2"
};

/** A contract fixture, not an implementation of WorkOS or a real sign-in. */
export const registerFixture = (app: FastifyInstance, origin: string) => {
  const claims = new Map<
    string,
    { code: string; expires: number; confirmed: boolean; used: boolean }
  >();
  const tokens = new Map<
    string,
    { id: string; expires: number; revoked: boolean }
  >();
  const config: RegistrationConfig = {
    ...fixtureIdentity,
    issuer: "https://local-fixture.authkit.app",
    resource: `${origin}/mcp`,
    apiKey: "local-fixture-only-not-a-workos-key",
    maxRequests: 100
  };
  const document = `# Koed local registration fixture

This is a synthetic local fixture, not WorkOS. No real account or memory is used.

1. POST ${origin}/fixture/register with JSON {"type":"service_auth"}.
2. Give the returned verification_uri to the User. Wait for their confirmation code. Do not approve on their behalf.
3. POST ${origin}/fixture/complete with JSON {"claim_token":"...","user_code":"..."}.
4. Keep access_token private. Never print it, commit it, or put it in AGENTS.md. Use it as a Bearer credential for ${origin}/mcp.
5. Only diagnostic access is available. Memory Answer execution and capture are not part of this fixture.
`;
  app.post("/fixture/register", async (request, reply) => {
    const input = z
      .object({ type: z.literal("service_auth") })
      .strict()
      .safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({ error: "service_auth required" });
    if (claims.size >= 20)
      return reply.code(429).send({
        error: "Restart the fixture to clear its registration budget"
      });
    const token = randomBytes(24).toString("base64url");
    claims.set(token, {
      code: String(randomInt(100000, 1000000)),
      expires: Date.now() + 300_000,
      confirmed: false,
      used: false
    });
    return {
      claim_token: token,
      verification_uri: `${origin}/fixture/claim/${token}`,
      expires_in: 300
    };
  });
  app.get<{ Params: { token: string } }>(
    "/fixture/claim/:token",
    async (request, reply) => {
      const claim = claims.get(request.params.token);
      if (!claim || claim.expires <= Date.now() || claim.used)
        return reply.code(410).send({ error: "Claim unavailable" });
      reply.header("cache-control", "no-store");
      reply.header("referrer-policy", "strict-origin");
      reply.header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"
      );
      return reply
        .type("text/html")
        .send(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Koed Local Fixture</title><style>body{font:16px system-ui;max-width:540px;margin:64px auto;padding:24px;color:#17221d;background:#f5f7f6}h1{font-size:26px}button{padding:12px 18px;background:#176b4a;color:white;border:0;border-radius:4px;font:inherit}code{font-size:26px}</style><h1>Koed Local Fixture</h1><p>Synthetic user · Local organisation</p><p>Allow this connection to check diagnostic access?</p>${claim.confirmed ? `<p>Confirmation code: <code>${claim.code}</code></p>` : `<form method="post" action="${origin}/fixture/claim/${request.params.token}/approve"><button type="submit">Approve Local Connection</button></form>`}</html>`
        );
    }
  );
  app.post<{ Params: { token: string } }>(
    "/fixture/claim/:token/approve",
    async (request, reply) => {
      if (request.headers.origin !== origin)
        return reply.code(403).send({ error: "Origin denied" });
      const claim = claims.get(request.params.token);
      if (!claim || claim.used || claim.expires <= Date.now())
        return reply.code(410).send({ error: "Claim unavailable" });
      claim.confirmed = true;
      return reply.redirect(`/fixture/claim/${request.params.token}`);
    }
  );
  // Native browser forms use urlencoded bodies; no values are needed here.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, _body, done) => done(null, {})
  );
  app.post("/fixture/complete", async (request, reply) => {
    const input = z
      .object({ claim_token: z.string(), user_code: z.string() })
      .strict()
      .parse(request.body);
    const claim = claims.get(input.claim_token);
    if (
      !claim ||
      claim.used ||
      claim.expires <= Date.now() ||
      !claim.confirmed ||
      claim.code !== input.user_code
    )
      return reply.code(403).send({ error: "Claim not confirmed" });
    claim.used = true;
    const id = `agent_reg_${randomUUID()}`;
    const expires = Math.floor(Date.now() / 1000) + 900;
    const payload = {
      iss: config.issuer,
      aud: config.resource,
      sub: id,
      org_id: config.organizationId,
      act: { sub: config.workosUserId },
      exp: expires,
      scope: "koed:memory:read"
    };
    const token = `${Buffer.from('{"alg":"fixture"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${randomBytes(24).toString("base64url")}`;
    tokens.set(token, { id, expires, revoked: false });
    return { access_token: token, token_type: "Bearer", expires_in: 900 };
  });
  app.post("/fixture/revoke", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    const record = token ? tokens.get(token) : undefined;
    if (!record)
      return reply.code(401).send({ error: "Unknown fixture credential" });
    record.revoked = true;
    return { revoked: true };
  });
  const requestFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.href === `${config.issuer}/agent/auth.md`)
      return new Response(document);
    if (
      url.origin !== "https://api.workos.com" ||
      new Headers(init?.headers).get("authorization") !==
        `Bearer ${config.apiKey}`
    )
      return new Response(null, { status: 401 });
    if (url.pathname === "/agents/credentials/validate") {
      const body = JSON.parse(String(init?.body)) as {
        credential: string;
        audience: string;
      };
      const token = tokens.get(body.credential);
      return Response.json({
        valid: Boolean(
          token &&
          !token.revoked &&
          token.expires > Date.now() / 1000 &&
          body.audience === config.resource
        ),
        registration_id: token?.id,
        expires_at: token
          ? new Date(token.expires * 1000).toISOString()
          : undefined
      });
    }
    const token = [...tokens.values()].find(
      (entry) => url.pathname === `/agents/registrations/${entry.id}`
    );
    return token
      ? Response.json({
          id: token.id,
          status: token.revoked ? "revoked" : "verified",
          kind: "service_auth",
          organization_id: config.organizationId
        })
      : new Response(null, { status: 404 });
  };
  return { config, requestFetch };
};
