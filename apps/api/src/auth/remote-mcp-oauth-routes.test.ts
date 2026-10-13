import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import {
  createDbPool,
  createRemoteMcpOAuthRepository,
  type MemorySourceRepository
} from "@koed/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthHelpers, createHashSecret } from "./session.js";
import { createRemoteMcpOAuthProvider } from "./remote-mcp-oauth.js";
import { registerRemoteMcpOAuthRoutes } from "./remote-mcp-oauth-routes.js";
import { registerBrowserWriteCsrfProtection } from "../server/browser-write-csrf.js";

const databaseUrl = process.env.KOED_OAUTH_TEST_DATABASE_URL;
const origin = "https://koed.example";
const issuer = new URL(origin);
const resource = new URL("/mcp", issuer);
const userId = randomUUID();
const hashSecret = createHashSecret("route-test-pepper");
const codeVerifier = "a".repeat(43);
const codeChallenge = createHash("sha256")
  .update(codeVerifier)
  .digest("base64url");

describe.skipIf(!databaseUrl)("Fastify remote MCP OAuth routes", () => {
  const admin = createDbPool({
    connectionString: databaseUrl ?? "postgresql://localhost/postgres"
  });
  const schema = `oauth_routes_${randomUUID().replaceAll("-", "")}`;
  const scopedUrl = new URL(databaseUrl ?? "postgresql://localhost/postgres");
  scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
  const pool = createDbPool({ connectionString: scopedUrl.toString() });
  const oauth = createRemoteMcpOAuthProvider({
    store: createRemoteMcpOAuthRepository(pool),
    resourceUrl: resource
  });
  const auth = createAuthHelpers(
    () =>
      ({
        async getSessionUser(hash: string) {
          const result = await pool.query<{
            id: string;
            email: string;
            display_name: string | null;
          }>(
            "select u.id,u.email,u.display_name from user_sessions s join users u on u.id = s.user_id where s.secret_hash = $1 and s.expires_at > now() and s.revoked_at is null and u.disabled_at is null and u.deleted_at is null",
            [hash]
          );
          const row = result.rows[0];
          return row
            ? { id: row.id, email: row.email, displayName: row.display_name }
            : null;
        }
      }) as unknown as MemorySourceRepository,
    { hashSecret, cookieSecure: true }
  );
  const app = Fastify();
  let base: string;
  let clientId: string;
  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    await pool.query(
      "create table users (id uuid primary key,email text,display_name text,disabled_at timestamptz,deleted_at timestamptz); create table user_sessions(secret_hash text,user_id uuid,expires_at timestamptz,revoked_at timestamptz); create table audit_events(actor_user_id uuid,owner_user_id uuid,visibility text,action text,target_table text,target_id uuid,metadata jsonb)"
    );
    await pool.query(
      "insert into users(id,email) values($1,'user@koed.example')",
      [userId]
    );
    await pool.query(
      "insert into user_sessions(secret_hash,user_id,expires_at) values($1,$2,now()+interval '1 day'),($3,$2,now()+interval '1 day')",
      [hashSecret("session-one"), userId, hashSecret("session-two")]
    );
    const migration = await readFile(
      new URL(
        "../../../../packages/db/drizzle/0043_remote_mcp_oauth.sql",
        import.meta.url
      ),
      "utf8"
    );
    await pool.query(migration.replaceAll('"public".', `"${schema}".`));
    await app.register(cookie);
    registerBrowserWriteCsrfProtection(
      app,
      new Set([origin, "https://other-allowed.example"])
    );
    registerRemoteMcpOAuthRoutes(app, {
      oauth,
      issuerUrl: issuer,
      auth,
      workosAvailable: false,
      publicOrigin: origin
    });
    base = await app.listen({ host: "127.0.0.1", port: 0 });
    const registered = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: '<img src=x onerror="alert(1)">',
        token_endpoint_auth_method: "none",
        redirect_uris: ["http://127.0.0.1:5555/callback"]
      })
    });
    expect(registered.status).toBe(201);
    expect(registered.headers.get("ratelimit-limit")).toBe("20");
    clientId = ((await registered.json()) as { client_id: string }).client_id;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }, 30_000);

  const pending = async (scope = "koed:memory:read") => {
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:5555/callback",
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      resource: resource.toString(),
      scope,
      state: "test-state"
    });
    const response = await fetch(`${base}/authorize?${query}`, {
      redirect: "manual"
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("ratelimit-limit")).toBe("100");
    return new URL(response.headers.get("location")!).searchParams.get(
      "request"
    )!;
  };
  it("runs bounded cleanup without overlap and stops its timer on close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let finish!: () => void;
    const active = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const prune = vi
      .spyOn(oauth, "pruneExpired")
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(active)
      .mockResolvedValue(undefined);
    const lifecycle = Fastify();
    try {
      registerRemoteMcpOAuthRoutes(lifecycle, {
        oauth,
        issuerUrl: issuer,
        auth,
        workosAvailable: false,
        publicOrigin: origin
      });
      await lifecycle.ready();
      expect(prune).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(prune).toHaveBeenCalledTimes(2);
      finish();
      await lifecycle.close();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(prune).toHaveBeenCalledTimes(2);
    } finally {
      finish();
      await lifecycle.close();
      prune.mockRestore();
      vi.useRealTimers();
    }
  });
  const consent = async (requestSecret: string) => {
    const response = await fetch(
      `${base}/auth/mcp/authorize?request=${requestSecret}`,
      { headers: { cookie: "cm_session=session-one" } }
    );
    const html = await response.text();
    const csrfToken = html.match(
      /name="csrfToken" value="([A-Za-z0-9_-]+)"/
    )?.[1];
    const csrfCookie = response.headers.get("set-cookie")?.split(";")[0];
    expect(csrfToken).toBeTruthy();
    expect(csrfCookie).toBeTruthy();
    return {
      response,
      html,
      csrfToken: csrfToken!,
      cookie: `cm_session=session-one; ${csrfCookie}`
    };
  };
  const approve = (
    requestSecret: string,
    csrfToken: string,
    cookieValue: string,
    extra: Record<string, string> = {}
  ) =>
    fetch(`${base}/auth/mcp/authorize?request=${requestSecret}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
        cookie: cookieValue,
        ...extra
      },
      body: new URLSearchParams({
        csrfToken,
        decision: "allow",
        userId: randomUUID(),
        redirectUri: "https://evil.example"
      })
    });

  it("serves SDK discovery and public client form exchange through Fastify", async () => {
    const metadata = await fetch(
      `${base}/.well-known/oauth-authorization-server`
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      issuer: issuer.toString(),
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      code_challenge_methods_supported: ["S256"]
    });
    const protectedResource = await fetch(
      `${base}/.well-known/oauth-protected-resource/mcp`
    );
    expect(await protectedResource.json()).toMatchObject({
      resource: resource.toString(),
      authorization_servers: [issuer.toString()]
    });
    const request = await pending("koed:memory:read koed:team:read");
    const view = await consent(request);
    expect(view.response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'"
    );
    expect(view.response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(view.response.headers.get("cache-control")).toBe("no-store");
    expect(view.html).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"
    );
    expect(view.html).toContain("Read Team Workspace memory");
    const approved = await approve(request, view.csrfToken, view.cookie);
    expect(approved.status).toBe(302);
    const redirect = new URL(approved.headers.get("location")!);
    expect(redirect.origin).toBe("http://127.0.0.1:5555");
    expect(redirect.searchParams.get("state")).toBe("test-state");
    const exchanged = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        code: redirect.searchParams.get("code")!,
        code_verifier: codeVerifier,
        redirect_uri: "http://127.0.0.1:5555/callback",
        resource: resource.toString()
      })
    });
    expect(exchanged.status).toBe(200);
    const tokens = (await exchanged.json()) as { access_token: string };
    await expect(
      oauth.resolvePrincipal(tokens.access_token)
    ).resolves.toMatchObject({
      userId,
      scopes: ["koed:memory:read", "koed:team:read"]
    });
    const revoked = await fetch(`${base}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        token: tokens.access_token
      })
    });
    expect(revoked.status).toBe(200);
    await expect(oauth.resolvePrincipal(tokens.access_token)).rejects.toThrow();
  });

  it("requires session-bound, request-bound CSRF and exact public origin", async () => {
    const request = await pending();
    const view = await consent(request);
    const another = await pending();
    expect((await approve(another, view.csrfToken, view.cookie)).status).toBe(
      403
    );
    expect((await approve(request, "b".repeat(43), view.cookie)).status).toBe(
      403
    );
    expect(
      (
        await approve(
          request,
          view.csrfToken,
          view.cookie.replace("session-one", "session-two")
        )
      ).status
    ).toBe(403);
    expect(
      (
        await approve(request, view.csrfToken, view.cookie, {
          origin: "https://evil.example"
        })
      ).status
    ).toBe(403);
    expect(
      (
        await approve(request, view.csrfToken, view.cookie, {
          origin: "https://other-allowed.example"
        })
      ).status
    ).toBe(403);
    expect(
      (
        await approve(request, view.csrfToken, view.cookie, {
          "sec-fetch-site": "cross-site"
        })
      ).status
    ).toBe(403);
    expect((await approve(request, view.csrfToken, view.cookie)).status).toBe(
      302
    );
    expect((await approve(request, view.csrfToken, view.cookie)).status).toBe(
      400
    );
  });

  it("local unauthenticated flow uses existing login and WorkOS resumes a safe local consent path", async () => {
    const request = await pending();
    const login = await fetch(`${base}/auth/mcp/authorize?request=${request}`);
    expect(login.status).toBe(200);
    const html = await login.text();
    expect(html).toContain("Sign in to Koed");
    expect(html).toContain("fetch('/auth/login'");
    const workos = Fastify();
    await workos.register(cookie);
    registerRemoteMcpOAuthRoutes(workos, {
      oauth,
      issuerUrl: issuer,
      auth,
      workosAvailable: true,
      publicOrigin: origin
    });
    await workos.ready();
    try {
      const response = await workos.inject({
        method: "GET",
        url: `/auth/mcp/authorize?request=${request}`
      });
      expect(response.statusCode).toBe(302);
      const redirect = new URL(response.headers.location!, issuer);
      expect(redirect.pathname).toBe("/auth/workos/login");
      expect(redirect.searchParams.get("return_to")).toBe(
        `/auth/mcp/authorize?request=${request}`
      );
    } finally {
      await workos.close();
    }
  });
});
