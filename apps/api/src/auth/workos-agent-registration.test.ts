import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { SignJWT, jwtVerify, type JWTHeaderParameters } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemorySourceRepository } from "@koed/db";
import {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  resetMemoryRateLimitStore
} from "../infra/rate-limit.js";
import { createAuthHelpers } from "./session.js";
import {
  createWorkosAgentRegistration,
  isWorkosAgentCredential
} from "./workos-agent-registration.js";
import { resolveApiServerConfig } from "../server/config.js";
import { workosAgentTestEnvironment } from "../../test-fixtures/workos-agent-auth.js";
import type { FastifyRequest } from "fastify";

afterEach(() => {
  resetMemoryRateLimitStore();
  vi.useRealTimers();
});

const fixture = () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048
  });
  const publicJwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "key-one",
    alg: "RS256",
    use: "sig"
  };
  const config = resolveApiServerConfig(workosAgentTestEnvironment);
  const user = {
    id: "local-owner",
    email: "owner@example.test",
    displayName: null
  };
  const identity = { userId: user.id, status: "linked", emailVerified: true };
  const repository = {
    getExternalAuthOrganization: vi.fn().mockResolvedValue({
      status: "linked",
      teamId: "aaaabbbb-1111-4111-8111-111111111111"
    }),
    getExternalAuthIdentity: vi.fn().mockResolvedValue(identity),
    getUser: vi.fn().mockResolvedValue(user),
    getApiTokenUser: vi.fn().mockResolvedValue(null),
    getSessionUser: vi.fn().mockResolvedValue(user)
  };
  const state = {
    signingKey: publicKey,
    revoked: false,
    valid: true,
    status: "verified",
    kind: "service_auth",
    organization: "org_test",
    validationRegistration: "agent_reg_test",
    validationExpiry: undefined as string | undefined
  };
  const requestFetch = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/validate")) {
      const input = JSON.parse(String(init?.body)) as {
        credential: string;
        audience: string;
      };
      let valid = state.valid && !state.revoked;
      try {
        await jwtVerify(input.credential, state.signingKey, {
          issuer: config.workos.agentRegistration!.issuer,
          audience: input.audience
        });
      } catch {
        valid = false;
      }
      return Response.json({
        valid,
        registration_id: state.validationRegistration,
        ...(state.validationExpiry
          ? { expires_at: state.validationExpiry }
          : {})
      });
    }
    return Response.json({
      id: String(url).split("/").at(-1),
      status: state.status,
      kind: state.kind,
      organization_id: state.organization
    });
  });
  const jwksFetch = vi.fn<typeof fetch>(async () =>
    Response.json({ keys: [publicJwk] })
  );
  const transportFetch: typeof fetch = (url, init) =>
    String(url) === `${config.workos.agentRegistration!.issuer}/oauth2/jwks`
      ? jwksFetch(url, init)
      : requestFetch(url, init);
  const resolverOptions = {
    grantStore: {
      resolveExternalGrant: vi
        .fn()
        .mockImplementation(
          async (input: { scopes: string[]; expiresAt: Date }) => ({
            id: "workos:agent_reg_test",
            scopes: input.scopes,
            expiresAt: input.expiresAt
          })
        )
    },
    config: config.workos.agentRegistration!,
    resourceUrl: config.remoteMcp.resourceUrl!,
    apiKey: config.workos.clientSecret!,
    clientId: config.workos.clientId!,
    providerEnvironment: config.workos.providerEnvironment,
    requireRepository: () => repository as unknown as MemorySourceRepository,
    rateLimitStore: new MemoryRateLimitStore(),
    requestFetch: transportFetch
  };
  const resolver = createWorkosAgentRegistration(resolverOptions);
  const token = async (
    overrides: Record<string, unknown> = {},
    header: JWTHeaderParameters = { alg: "RS256", kid: "key-one" },
    signingKey: Parameters<SignJWT["sign"]>[0] = privateKey
  ) =>
    new SignJWT({
      iss: config.workos.agentRegistration!.issuer,
      aud: config.remoteMcp.resourceUrl!,
      sub: "agent_reg_test",
      act: { sub: "user_test" },
      org_id: "org_test",
      scope: "koed:memory:read",
      exp: Math.floor(Date.now() / 1000) + 600,
      ...overrides
    })
      .setProtectedHeader(header)
      .sign(signingKey);
  return {
    resolver,
    resolverOptions,
    token,
    repository,
    requestFetch,
    jwksFetch,
    publicJwk,
    privateKey,
    state,
    user
  };
};

describe("WorkOS Agent Registration verifier", () => {
  it("rejects a forged signature before identity lookup or provider-budget spending", async () => {
    const f = fixture();
    const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = await f.token(
      {},
      { alg: "RS256", kid: "key-one" },
      attacker.privateKey
    );
    await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
      statusCode: 401
    });
    expect(f.repository.getExternalAuthIdentity).not.toHaveBeenCalled();
    expect(f.requestFetch).not.toHaveBeenCalled();
    expect(f.jwksFetch).toHaveBeenCalledOnce();
    const headers = new Headers(f.jwksFetch.mock.calls[0]![1]?.headers);
    expect(headers.has("authorization")).toBe(false);
  });

  it("rejects symmetric algorithms and caller-supplied key sources without any network request", async () => {
    const f = fixture();
    for (const token of [
      await f.token({}, { alg: "HS256", kid: "key-one" }, randomBytes(32)),
      await f.token(
        {},
        { alg: "RS256", kid: "key-one", jku: "https://attacker.example/keys" }
      ),
      await f.token(
        {},
        { alg: "RS256", kid: "key-one", x5u: "https://attacker.example/cert" }
      )
    ])
      await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
        statusCode: 401
      });
    expect(f.jwksFetch).not.toHaveBeenCalled();
    expect(f.requestFetch).not.toHaveBeenCalled();
  });

  it("bounds unknown-key refresh traffic and accepts a provider key rotation after cooldown", async () => {
    const f = fixture();
    await f.resolver.resolvePrincipal(await f.token());
    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = await f.token(
      {},
      { alg: "RS256", kid: "key-two" },
      rotated.privateKey
    );
    for (let attempt = 0; attempt < 10; attempt++)
      await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
        statusCode: 401
      });
    expect(f.jwksFetch).toHaveBeenCalledOnce();
    expect(f.requestFetch).toHaveBeenCalledTimes(2);
    f.jwksFetch.mockResolvedValueOnce(
      Response.json({
        keys: [
          f.publicJwk,
          {
            ...rotated.publicKey.export({ format: "jwk" }),
            alg: "RS256",
            kid: "key-two"
          }
        ]
      })
    );
    f.state.signingKey = rotated.publicKey;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30_001);
    await expect(f.resolver.resolvePrincipal(token)).resolves.toMatchObject({
      userId: f.user.id
    });
    expect(f.jwksFetch).toHaveBeenCalledTimes(2);
    expect(f.requestFetch).toHaveBeenCalledTimes(4);
  });

  it("backs off failed signing-key fetches and recovers without spending provider validation budget", async () => {
    const f = fixture();
    const token = await f.token();
    f.jwksFetch.mockResolvedValueOnce(
      new Response("unavailable", { status: 503 })
    );
    for (let attempt = 0; attempt < 10; attempt++)
      await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
        statusCode: 503,
        retryAfterMs: expect.any(Number)
      });
    expect(f.jwksFetch).toHaveBeenCalledOnce();
    expect(f.requestFetch).not.toHaveBeenCalled();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30_001);
    await expect(f.resolver.resolvePrincipal(token)).resolves.toMatchObject({
      userId: f.user.id
    });
    expect(f.jwksFetch).toHaveBeenCalledTimes(2);
    expect(f.requestFetch).toHaveBeenCalledTimes(2);
  });

  it("does not authorise using expired cached keys when refresh is unavailable", async () => {
    const f = fixture();
    const token = await f.token();
    await f.resolver.resolvePrincipal(token);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 300_001);
    f.jwksFetch.mockResolvedValueOnce(
      new Response("unavailable", { status: 503 })
    );
    await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
      statusCode: 503
    });
    expect(f.requestFetch).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled signing-key fetch and releases verification capacity", async () => {
    const f = fixture();
    const token = await f.token();
    vi.useFakeTimers();
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.jwksFetch.mockImplementationOnce(() => {
      started();
      return new Promise(() => {});
    });
    const result = f.resolver
      .resolvePrincipal(token)
      .catch((error: unknown) => error);
    await fetchStarted;
    await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toMatchObject({ statusCode: 503 });
    expect(f.requestFetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(f.resolver.resolvePrincipal(token)).resolves.toMatchObject({
      userId: f.user.id
    });
    expect(f.jwksFetch).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight key fetch and bounds concurrent verification", async () => {
    const f = fixture();
    const token = await f.token();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const keyFetchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.jwksFetch.mockImplementationOnce(async () => {
      started();
      await gate;
      return Response.json({ keys: [f.publicJwk] });
    });
    const pending = Array.from({ length: 8 }, () =>
      f.resolver.resolvePrincipal(token)
    );
    try {
      await keyFetchStarted;
      expect(f.jwksFetch).toHaveBeenCalledOnce();
      await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
        statusCode: 503
      });
    } finally {
      release();
      await Promise.all(pending);
    }
    expect(f.jwksFetch).toHaveBeenCalledOnce();
    expect(f.requestFetch).toHaveBeenCalledTimes(16);
  });

  it.each(["private-key", "duplicate-key", "empty-set", "oversized"])(
    "fails closed on unsafe JWKS: %s",
    async (kind) => {
      const f = fixture();
      const response =
        kind === "oversized"
          ? new Response("a".repeat(40_000))
          : Response.json({
              keys:
                kind === "empty-set"
                  ? []
                  : kind === "duplicate-key"
                    ? [f.publicJwk, f.publicJwk]
                    : [{ ...f.publicJwk, d: "private" }]
            });
      f.jwksFetch.mockResolvedValueOnce(response);
      await expect(
        f.resolver.resolvePrincipal(await f.token())
      ).rejects.toMatchObject({ statusCode: 503 });
      expect(f.requestFetch).not.toHaveBeenCalled();
    }
  );

  it("enforces a registration quota separately from its User quota", async () => {
    const f = fixture();
    const resolver = createWorkosAgentRegistration({
      ...f.resolverOptions,
      config: { ...f.resolverOptions.config, registrationRequestsPerMinute: 1 }
    });
    const token = await f.token();
    await resolver.resolvePrincipal(token);
    await expect(
      resolver.resolvePrincipal(await f.token({ jti: "rotated-token" }))
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(f.requestFetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed before provider calls when quota storage is unavailable", async () => {
    const f = fixture();
    const resolver = createWorkosAgentRegistration({
      ...f.resolverOptions,
      rateLimitStore: {
        increment: vi.fn().mockRejectedValue(new Error("store unavailable"))
      }
    });
    await expect(
      resolver.resolvePrincipal(await f.token())
    ).rejects.toMatchObject({ statusCode: 503, retryAfterMs: 5000 });
    await expect(resolver.admitCaller("peer")).rejects.toMatchObject({
      statusCode: 503,
      retryAfterMs: 5000
    });
    expect(f.requestFetch).not.toHaveBeenCalled();
    expect(
      f.resolverOptions.grantStore.resolveExternalGrant
    ).not.toHaveBeenCalled();
  });

  it.skipIf(!process.env.KOED_TEST_REDIS_URL)(
    "shares verified User quotas across independent API resolvers with Redis",
    async () => {
      const f = fixture();
      const clients = [
        new Redis(process.env.KOED_TEST_REDIS_URL!),
        new Redis(process.env.KOED_TEST_REDIS_URL!)
      ];
      const namespace = `workos-auth-test:${randomUUID()}:`;
      const keys = new Set<string>();
      const resolvers = clients.map((client) => {
        const store = new RedisRateLimitStore(client);
        return createWorkosAgentRegistration({
          ...f.resolverOptions,
          config: { ...f.resolverOptions.config, userRequestsPerMinute: 3 },
          rateLimitStore: {
            increment: (key, windowMs) => {
              const scoped = namespace + key;
              keys.add(`koed:rate-limit:${scoped}`);
              return store.increment(scoped, windowMs);
            }
          }
        });
      });
      try {
        const token = await f.token();
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, (_, i) =>
            resolvers[i % 2]!.resolvePrincipal(token)
          )
        );
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
        for (const result of results)
          if (result.status === "rejected")
            expect(result.reason).toMatchObject({ statusCode: 429 });
        expect(f.requestFetch).toHaveBeenCalledTimes(6);
      } finally {
        if (keys.size) await clients[0]!.del(...keys);
        for (const client of clients) client.disconnect();
      }
    }
  );

  it("requires current Koed consent even when the provider validates a replacement credential", async () => {
    const f = fixture();
    const credential = await f.token();
    await expect(
      f.resolver.resolvePrincipal(credential)
    ).resolves.toMatchObject({ userId: f.user.id });
    f.resolverOptions.grantStore.resolveExternalGrant.mockResolvedValueOnce(
      null
    );
    await expect(
      f.resolver.resolvePrincipal(await f.token())
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(
      f.resolverOptions.grantStore.resolveExternalGrant
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        issuer: f.resolverOptions.config.issuer,
        providerEnvironment: "staging",
        registrationId: "agent_reg_test",
        providerUserId: "user_test",
        providerOrganizationId: "org_test",
        userId: f.user.id
      })
    );
  });
  it("applies the stored scope ceiling and absolute expiry to the delegated principal", async () => {
    const f = fixture();
    const expiresAt = new Date(Date.now() + 20_000);
    f.resolverOptions.grantStore.resolveExternalGrant.mockResolvedValueOnce({
      id: "consent-id",
      scopes: ["koed:memory:read"],
      expiresAt
    });
    const principal = await f.resolver.resolvePrincipal(
      await f.token({ scope: "koed:memory:read koed:team:read" })
    );
    expect(principal).toMatchObject({
      grantId: "consent-id",
      scopes: ["koed:memory:read"],
      teamBoundaryId: null,
      expiresAt: Math.floor(expiresAt.getTime() / 1000)
    });
  });
  it("binds Team scope to the current organisation mapping without granting membership", async () => {
    const f = fixture();
    const resolver = createWorkosAgentRegistration({
      ...f.resolverOptions,
      config: {
        ...f.resolverOptions.config,
        allowedScopes: ["koed:memory:read", "koed:team:read"]
      }
    });
    const token = await f.token({ scope: "koed:memory:read koed:team:read" });
    expect(await resolver.resolvePrincipal(token)).toMatchObject({
      scopes: ["koed:memory:read", "koed:team:read"],
      teamBoundaryId: "aaaabbbb-1111-4111-8111-111111111111"
    });
    expect(f.repository.getExternalAuthOrganization).toHaveBeenCalledWith({
      provider: "workos_authkit",
      providerEnvironment: "staging",
      providerOrganizationId: "org_test"
    });
    f.repository.getExternalAuthOrganization.mockResolvedValueOnce(null);
    await expect(resolver.resolvePrincipal(token)).rejects.toMatchObject({
      statusCode: 401
    });
    f.repository.getExternalAuthOrganization.mockResolvedValueOnce({
      status: "disabled",
      teamId: "aaaabbbb-1111-4111-8111-111111111111"
    });
    await expect(resolver.resolvePrincipal(token)).rejects.toMatchObject({
      statusCode: 401
    });
  });
  it("validates the exact credential and audience before mapping an existing identity", async () => {
    const f = fixture();
    const token = await f.token();
    expect(await f.resolver.resolvePrincipal(token)).toMatchObject({
      userId: f.user.id,
      grantId: "workos:agent_reg_test",
      resource: "https://memory.example/mcp",
      scopes: ["koed:memory:read"]
    });
    expect(f.repository.getExternalAuthIdentity).toHaveBeenCalledWith({
      provider: "workos_authkit",
      providerEnvironment: "staging",
      providerUserId: "user_test"
    });
    expect(JSON.parse(String(f.requestFetch.mock.calls[0]?.[1]?.body))).toEqual(
      {
        type: "access_token",
        credential: token,
        audience: "https://memory.example/mcp"
      }
    );
    expect(f.requestFetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error"
    });
  });
  it.each([
    { iss: "https://other.authkit.app" },
    { aud: "https://other.example/mcp" },
    { sub: "user_test" },
    { org_id: "org_other" },
    { act: undefined },
    { exp: 1 },
    { nbf: Math.floor(Date.now() / 1000) + 3600 }
  ])(
    "rejects invalid token claims before spending upstream requests: %j",
    async (override) => {
      const f = fixture();
      await expect(
        f.resolver.resolvePrincipal(await f.token(override))
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(f.requestFetch).not.toHaveBeenCalled();
    }
  );
  it("checks the signature through WorkOS and denies tampering", async () => {
    const f = fixture();
    const token = await f.token();
    await expect(
      f.resolver.resolvePrincipal(`${token.slice(0, -8)}AAAAAAAA`)
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(f.repository.getUser).not.toHaveBeenCalled();
  });
  it("requires current credential validity and matching registration identity", async () => {
    const f = fixture();
    const token = await f.token();
    f.state.valid = false;
    await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
      statusCode: 401
    });
    f.state.valid = true;
    f.state.validationRegistration = "agent_reg_other";
    await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
      statusCode: 401
    });
  });
  it.each(["unverified", "revoked", "expired"])(
    "rejects a %s registration",
    async (status) => {
      const f = fixture();
      f.state.status = status;
      await expect(
        f.resolver.resolvePrincipal(await f.token())
      ).rejects.toMatchObject({ statusCode: 401 });
    }
  );
  it("rejects anonymous registrations and organisation mismatches", async () => {
    const f = fixture();
    const token = await f.token();
    f.state.kind = "anonymous";
    await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
      statusCode: 401
    });
    f.state.kind = "service_auth";
    f.state.organization = "org_other";
    await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
      statusCode: 401
    });
  });
  it("rejects expired validation results", async () => {
    const f = fixture();
    f.state.validationExpiry = new Date(0).toISOString();
    await expect(
      f.resolver.resolvePrincipal(await f.token())
    ).rejects.toMatchObject({ statusCode: 401 });
  });
  it("requires an existing active verified identity and active Koed User", async () => {
    const f = fixture();
    const token = await f.token();
    for (const identity of [
      null,
      { userId: f.user.id, status: "disabled", emailVerified: true },
      { userId: f.user.id, status: "linked", emailVerified: false }
    ]) {
      f.repository.getExternalAuthIdentity.mockResolvedValueOnce(identity);
      await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
        statusCode: 401
      });
    }
    f.repository.getUser.mockResolvedValueOnce(null);
    await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
      statusCode: 401
    });
  });
  it("intersects issued scopes with the configured ceiling and never grants Team access", async () => {
    const f = fixture();
    expect(
      (
        await f.resolver.resolvePrincipal(
          await f.token({
            scope:
              "koed:memory:read koed:capture koed:local-execution koed:team:read admin"
          })
        )
      ).scopes
    ).toEqual(["koed:memory:read"]);
    const expanded = createWorkosAgentRegistration({
      ...f.resolverOptions,
      config: {
        ...f.resolverOptions.config,
        allowedScopes: [
          "koed:memory:read",
          "koed:capture",
          "koed:local-execution"
        ]
      }
    });
    expect(
      (
        await expanded.resolvePrincipal(
          await f.token({ scope: "koed:memory:read koed:capture" })
        )
      ).scopes
    ).toEqual(["koed:memory:read", "koed:capture"]);
    await expect(
      expanded.resolvePrincipal(await f.token({ scope: "koed:team:read" }))
    ).rejects.toMatchObject({ statusCode: 401 });
  });
  it("observes revocation on the next request without a positive token cache", async () => {
    const f = fixture();
    const token = await f.token();
    await f.resolver.resolvePrincipal(token);
    f.state.revoked = true;
    await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
      statusCode: 401
    });
  });
  it("bounds simultaneous verifications without queuing excess requests", async () => {
    const f = fixture();
    const token = await f.token();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.requestFetch.getMockImplementation()!;
    f.requestFetch.mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    const pending = Array.from({ length: 8 }, () =>
      f.resolver.resolvePrincipal(token)
    );
    try {
      await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
        statusCode: 503
      });
    } finally {
      release();
      await Promise.all(pending);
    }
    expect(f.requestFetch).toHaveBeenCalledTimes(16);
  });
  it("enforces a shared bounded upstream budget and returns retry guidance", async () => {
    const f = fixture();
    const token = await f.token();
    const limited = createWorkosAgentRegistration({
      ...f.resolverOptions,
      config: { ...f.resolverOptions.config, requestsPerMinute: 2 }
    });
    await limited.resolvePrincipal(token);
    await expect(limited.resolvePrincipal(token)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: expect.any(Number)
    });
    expect(f.requestFetch).toHaveBeenCalledTimes(2);
  });
  it("shares verified User quotas across peers and registrations without penalising another User on the same peer", async () => {
    const f = fixture();
    for (let attempt = 0; attempt < 30; attempt++) {
      await f.resolver.admitCaller("peer-one");
      await f.resolver.resolvePrincipal(
        await f.token({ jti: String(attempt) })
      );
    }
    expect(f.requestFetch).toHaveBeenCalledTimes(60);
    await f.resolver.admitCaller("peer-two");
    await expect(
      f.resolver.resolvePrincipal(await f.token({ sub: "agent_reg_rotated" }))
    ).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: expect.any(Number)
    });
    expect(f.requestFetch).toHaveBeenCalledTimes(60);
    await f.resolver.admitCaller("peer-one");
    f.repository.getExternalAuthIdentity.mockResolvedValueOnce({
      userId: "other-owner",
      status: "linked",
      emailVerified: true
    });
    f.state.validationRegistration = "agent_reg_other";
    await expect(
      f.resolver.resolvePrincipal(
        await f.token({ sub: "agent_reg_other", act: { sub: "user_other" } })
      )
    ).resolves.toMatchObject({
      userId: "other-owner"
    });
    expect(f.requestFetch).toHaveBeenCalledTimes(62);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_001);
    f.state.validationRegistration = "agent_reg_test";
    await f.resolver.admitCaller("peer-one");
    await f.resolver.resolvePrincipal(await f.token());
    expect(f.requestFetch).toHaveBeenCalledTimes(64);
  });
  it.each([429, 503])(
    "preserves HTTP %i as a transient failure without provider details",
    async (status) => {
      const f = fixture();
      f.requestFetch.mockResolvedValue(
        new Response("private provider detail", {
          status,
          headers: { "retry-after": "5" }
        })
      );
      const error = await f.resolver
        .resolvePrincipal(await f.token())
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ statusCode: status });
      expect(String(error)).toBe(
        "DelegatedAuthenticationError: Delegated access is unavailable"
      );
    }
  );
  it("times out a non-cooperative provider without leaking its error", async () => {
    const f = fixture();
    const token = await f.token();
    vi.useFakeTimers();
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.requestFetch.mockImplementation(() => {
      started();
      return new Promise(() => {});
    });
    const result = f.resolver
      .resolvePrincipal(token)
      .catch((error: unknown) => error);
    await providerStarted;
    await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toMatchObject({ statusCode: 503 });
  });
  it("bounds response bodies and treats malformed provider success as unavailable", async () => {
    const f = fixture();
    const token = await f.token();
    f.requestFetch.mockResolvedValueOnce(Response.json({ valid: "yes" }));
    await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
      statusCode: 503
    });
    f.requestFetch.mockResolvedValueOnce(new Response("a".repeat(40_000)));
    await expect(f.resolver.resolvePrincipal(token)).rejects.toMatchObject({
      statusCode: 503
    });
  });
  it("reuses validation only within a request and refuses cookie fallback for rejected agent credentials", async () => {
    const f = fixture();
    const token = await f.token();
    const auth = createAuthHelpers(
      () => f.repository as unknown as MemorySourceRepository,
      {
        hashSecret: (value) => value,
        cookieSecure: false,
        resolveDelegatedPrincipal: f.resolver.resolvePrincipal,
        isDelegatedCredential: isWorkosAgentCredential
      }
    );
    const request = () =>
      ({
        method: "GET",
        url: "/v1/access/check",
        headers: { authorization: `Bearer ${token}` },
        cookies: { cm_session: "valid-cookie" }
      }) as unknown as FastifyRequest;
    const first = request();
    await auth.resolveDelegatedPrincipal(first);
    await auth.authenticate(first);
    expect(f.requestFetch).toHaveBeenCalledTimes(2);
    f.state.revoked = true;
    await expect(auth.authenticate(request())).rejects.toMatchObject({
      statusCode: 401
    });
    expect(f.repository.getSessionUser).not.toHaveBeenCalled();
    expect(f.repository.getApiTokenUser).not.toHaveBeenCalled();
  });
});
