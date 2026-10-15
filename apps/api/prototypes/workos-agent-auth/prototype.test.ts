import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY
} from "@modelcontextprotocol/server";
import { createPrototype } from "./server.js";
import {
  createRegistrationResolver,
  type RegistrationConfig
} from "./workos.js";

const origin = "http://127.0.0.1:43555";
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const setup = () => {
  const result = createPrototype({ origin });
  apps.push(result.app);
  return result;
};
const register = async (app: FastifyInstance) => {
  const response = await app.inject({
    method: "POST",
    url: "/fixture/register",
    payload: { type: "service_auth" }
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ claim_token: string; verification_uri: string }>();
};
const complete = async (app: FastifyInstance) => {
  const claim = await register(app);
  const path = new URL(claim.verification_uri).pathname;
  const approval = await app.inject({
    method: "POST",
    url: `${path}/approve`,
    headers: { origin }
  });
  expect(approval.statusCode).toBe(302);
  const page = await app.inject({ method: "GET", url: path });
  const code = page.body.match(/<code>(\d{6})<\/code>/)?.[1];
  expect(code).toBeDefined();
  const exchange = await app.inject({
    method: "POST",
    url: "/fixture/complete",
    payload: { claim_token: claim.claim_token, user_code: code }
  });
  expect(exchange.statusCode, exchange.body).toBe(200);
  return {
    claim,
    code,
    token: exchange.json<{ access_token: string }>().access_token
  };
};
const mcp = (app: FastifyInstance, token: string) =>
  app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      host: new URL(origin).host,
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "memory_access_check"
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "memory_access_check",
        arguments: {},
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          [CLIENT_INFO_META_KEY]: { name: "prototype-test", version: "1" },
          [CLIENT_CAPABILITIES_META_KEY]: {}
        }
      }
    }
  });

describe("local onboarding through the existing Koed auth and MCP routes", () => {
  it("serves discoverable instructions and protected-resource metadata", async () => {
    const { app } = setup();
    const document = await app.inject("/auth.md");
    expect(document.statusCode).toBe(200);
    expect(document.body).toContain(`${origin}/fixture/register`);
    expect(document.headers["cache-control"]).toBe("no-store");
    const metadata = await app.inject(
      "/.well-known/oauth-protected-resource/mcp"
    );
    expect(metadata.json()).toMatchObject({
      resource: `${origin}/mcp`,
      scopes_supported: ["koed:memory:read"]
    });
  });

  it("requires user confirmation and a matching code before granting access", async () => {
    const { app } = setup();
    const claim = await register(app);
    const path = new URL(claim.verification_uri).pathname;
    const page = await app.inject(path);
    expect(page.body).toContain("Approve Local Connection");
    const premature = await app.inject({
      method: "POST",
      url: "/fixture/complete",
      payload: { claim_token: claim.claim_token, user_code: "123456" }
    });
    expect(premature.statusCode).toBe(403);
    const foreignOrigin = await app.inject({
      method: "POST",
      url: `${path}/approve`,
      headers: { origin: "https://other.example" }
    });
    expect(foreignOrigin.statusCode).toBe(403);
    const anonymous = await app.inject({
      method: "POST",
      url: "/fixture/register",
      payload: { type: "anonymous" }
    });
    expect(anonymous.statusCode).toBe(400);
  });

  it("uses the existing remote MCP route after confirmation and rejects replay", async () => {
    const { app } = setup();
    const { token, claim, code } = await complete(app);
    const access = await mcp(app, token);
    expect(access.statusCode, access.body).toBe(200);
    expect(access.body).toContain("synthetic-only");
    expect(access.body).toContain("remote_http");
    const replay = await app.inject({
      method: "POST",
      url: "/fixture/complete",
      payload: { claim_token: claim.claim_token, user_code: code }
    });
    expect(replay.statusCode).toBe(403);
  });

  it("keeps capture, helper execution and administration behind existing scope checks", async () => {
    const { app } = setup();
    const { token } = await complete(app);
    for (const path of [
      "/v1/sessions",
      "/v1/memory/answer-tasks/claim",
      "/v1/team-workspaces/prototype/members"
    ]) {
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: { authorization: `Bearer ${token}` },
        payload: {}
      });
      expect(response.statusCode, `${path}: ${response.body}`).toBe(403);
    }
  });

  it("rejects the same credential on the next API and MCP request after revocation", async () => {
    const { app } = setup();
    const { token } = await complete(app);
    const headers = { authorization: `Bearer ${token}` };
    expect(
      (await app.inject({ url: "/v1/access/check", headers })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: "/fixture/revoke", headers }))
        .statusCode
    ).toBe(200);
    expect(
      (await app.inject({ url: "/v1/access/check", headers })).statusCode
    ).toBe(401);
    expect((await mcp(app, token)).statusCode).toBe(401);
  });

  it("binds only to a loopback origin", () => {
    expect(() => createPrototype({ origin: "http://0.0.0.0:43555" })).toThrow(
      "loopback"
    );
  });
});

const config: RegistrationConfig = {
  issuer: "https://staging-fixture.authkit.app",
  resource: `${origin}/mcp`,
  organizationId: "org_fixture",
  workosUserId: "user_fixture",
  koedUserId: "koed_fixture",
  apiKey: "fixture-api-key"
};
const resolverFixture = (
  overrides: Record<string, unknown> = {},
  valid = true,
  registrationStatus = "verified",
  maxRequests = 40
) => {
  const claims = {
    iss: config.issuer,
    aud: config.resource,
    sub: "agent_reg_fixture",
    org_id: config.organizationId,
    act: { sub: config.workosUserId },
    exp: Math.floor(Date.now() / 1000) + 600,
    scope: "koed:memory:read other:permission",
    ...overrides
  };
  const token = `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.opaque-fixture`;
  const requestFetch = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/validate")
      ? Response.json({ valid, registration_id: "agent_reg_fixture" })
      : Response.json({
          id: "agent_reg_fixture",
          status: registrationStatus,
          kind: "service_auth",
          organization_id: config.organizationId
        })
  );
  return {
    token,
    requestFetch,
    resolver: createRegistrationResolver(
      { ...config, maxRequests },
      requestFetch
    )
  };
};

describe("WorkOS credential mapping contract", () => {
  it("maps validated registration delegation to the existing Koed principal", async () => {
    const f = resolverFixture();
    const principal = await f.resolver.resolve(f.token);
    expect(principal).toMatchObject({
      userId: config.koedUserId,
      grantId: "agent_reg_fixture",
      resource: config.resource,
      scopes: ["koed:memory:read"]
    });
    expect(f.requestFetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      method: "POST"
    });
    expect(JSON.parse(String(f.requestFetch.mock.calls[0]?.[1]?.body))).toEqual(
      { type: "access_token", credential: f.token, audience: config.resource }
    );
  });

  it.each([
    { iss: "https://other.authkit.app" },
    { aud: "https://other.example/mcp" },
    { sub: "agent_reg_other" },
    { org_id: "org_other" },
    { act: { sub: "user_other" } },
    { act: undefined },
    { exp: 1 },
    { scope: "koed:team:read" }
  ])("rejects an invalid delegation binding: %j", async (overrides) => {
    const f = resolverFixture(overrides);
    await expect(f.resolver.resolve(f.token)).rejects.toThrow("not authorised");
  });

  it("rejects an invalid credential before relying on its decoded claims", async () => {
    const f = resolverFixture({}, false);
    await expect(f.resolver.resolve(f.token)).rejects.toThrow("not authorised");
    expect(f.requestFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["revoked", "unverified", "expired"])(
    "rejects a %s registration",
    async (status) => {
      const f = resolverFixture({}, true, status);
      await expect(f.resolver.resolve(f.token)).rejects.toThrow(
        "not authorised"
      );
    }
  );

  it("fails closed when the bounded request budget is exhausted", async () => {
    const f = resolverFixture({}, true, "verified", 2);
    await f.resolver.resolve(f.token);
    await expect(f.resolver.resolve(f.token)).rejects.toThrow("not authorised");
    expect(f.requestFetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed on WorkOS failure without disclosing upstream text", async () => {
    const f = resolverFixture();
    f.requestFetch.mockResolvedValue(
      new Response("private upstream detail", { status: 503 })
    );
    await expect(f.resolver.resolve(f.token)).rejects.toThrow(
      "Agent registration is unavailable or not authorised"
    );
  });
});
