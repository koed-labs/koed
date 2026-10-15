import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import express from "express";
import { createDbPool, createRemoteMcpOAuthRepository } from "@koed/db";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { verifyBearerToken } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRemoteMcpOAuthProvider } from "./remote-mcp-oauth.js";

const databaseUrl = process.env.KOED_OAUTH_TEST_DATABASE_URL;
const userId = randomUUID();
const otherUserId = randomUUID();
const issuer = new URL("https://koed.example");
const resource = new URL("/mcp", issuer);
const verifier = "z".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe.skipIf(!databaseUrl)(
  "durable remote MCP OAuth with SDK handlers",
  () => {
    const admin = createDbPool({
      connectionString: databaseUrl ?? "postgresql://localhost/postgres"
    });
    const schema = `oauth_test_${randomUUID().replaceAll("-", "")}`;
    const scopedUrl = new URL(databaseUrl ?? "postgresql://localhost/postgres");
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    const pool = createDbPool({ connectionString: scopedUrl.toString() });
    const store = createRemoteMcpOAuthRepository(pool);
    let time = new Date();
    let oauth = createRemoteMcpOAuthProvider({
      store,
      resourceUrl: resource,
      now: () => time
    });
    let server: Server;
    let base: string;

    beforeAll(async () => {
      await admin.query(`create schema ${schema}`);
      await pool.query(
        `create table users (id uuid primary key, disabled_at timestamptz, deleted_at timestamptz); create table audit_events (actor_user_id uuid,owner_user_id uuid,visibility text,action text,target_table text,target_id uuid,metadata jsonb)`
      );
      await pool.query(`insert into users (id) values ($1),($2)`, [
        userId,
        otherUserId
      ]);
      const migration = await readFile(
        new URL(
          "../../../../packages/db/drizzle/0043_remote_mcp_oauth.sql",
          import.meta.url
        ),
        "utf8"
      );
      await pool.query(migration.replaceAll('"public".', `"${schema}".`));
      await pool.query(
        await readFile(
          new URL(
            "../../../../packages/db/drizzle/0045_external_agent_grants.sql",
            import.meta.url
          ),
          "utf8"
        )
      );
      const app = express();
      app.use(
        mcpAuthRouter({
          provider: oauth.provider,
          issuerUrl: issuer,
          resourceServerUrl: resource,
          scopesSupported: [
            "koed:memory:read",
            "koed:team:read",
            "koed:capture",
            "koed:local-execution"
          ]
        })
      );
      server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No test listener");
      base = `http://127.0.0.1:${address.port}`;
    });
    afterAll(async () => {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      await pool.end();
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }, 30_000);

    const post = async (path: string, data: Record<string, string>) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(data)
      });
    const register = async () => {
      const response = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Test AI Client",
          redirect_uris: ["http://127.0.0.1:5555/callback"],
          token_endpoint_auth_method: "none"
        })
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { client_id: string };
    };
    const authorize = async (
      clientId: string,
      scopes = "koed:memory:read",
      owner = userId,
      approve = true
    ) => {
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:5555/callback",
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: challenge,
        resource: resource.toString(),
        scope: scopes,
        state: "client-state"
      });
      const response = await fetch(`${base}/authorize?${query}`, {
        redirect: "manual"
      });
      expect(response.status).toBe(302);
      const requestSecret = new URL(
        response.headers.get("location")!
      ).searchParams.get("request")!;
      const consent = await oauth.getAuthorizationRequest(requestSecret);
      expect(consent?.scopes).toEqual(scopes.split(" "));
      const completed = await oauth.completeAuthorization({
        requestSecret,
        userId: owner,
        approved: approve
      });
      const redirect = new URL(completed.redirectUrl);
      expect(redirect.searchParams.get("state")).toBe("client-state");
      return {
        code: redirect.searchParams.get("code")!,
        redirect,
        requestSecret
      };
    };
    const exchange = async (
      clientId: string,
      code: string,
      codeVerifier = verifier,
      audience = resource.toString()
    ) =>
      post("/token", {
        client_id: clientId,
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: "http://127.0.0.1:5555/callback",
        resource: audience
      });
    const issued = async (scope = "koed:memory:read") => {
      const client = await register();
      const { code } = await authorize(client.client_id, scope);
      const response = await exchange(client.client_id, code);
      expect(response.status).toBe(200);
      return {
        clientId: client.client_id,
        code,
        tokens: (await response.json()) as {
          access_token: string;
          refresh_token: string;
          scope: string;
          expires_in: number;
        }
      };
    };

    it("SDK enforces PKCE, resource and redirect binding, code replay, client isolation", async () => {
      const client = await register();
      const other = await register();
      const { code } = await authorize(client.client_id);
      expect((await exchange(client.client_id, code, "wrong")).status).toBe(
        400
      );
      expect((await exchange(other.client_id, code)).status).toBe(400);
      expect(
        (
          await exchange(
            client.client_id,
            code,
            verifier,
            "https://elsewhere.example/mcp"
          )
        ).status
      ).toBe(400);
      const wrongRedirect = await post("/token", {
        client_id: client.client_id,
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:5555/other",
        resource: resource.toString()
      });
      expect(wrongRedirect.status).toBe(400);
      const result = await exchange(client.client_id, code);
      expect(result.status).toBe(200);
      expect((await exchange(client.client_id, code)).status).toBe(400);
    });

    it("survives provider restart and returns immutable Koed principal without broader scopes", async () => {
      const { tokens, clientId } = await issued(
        "koed:memory:read koed:team:read"
      );
      expect(tokens.access_token).toMatch(
        /^koed_mcp_access_[A-Za-z0-9_-]{43}$/
      );
      oauth = createRemoteMcpOAuthProvider({
        store: createRemoteMcpOAuthRepository(pool),
        resourceUrl: resource,
        now: () => time
      });
      const principal = await oauth.resolvePrincipal(tokens.access_token);
      expect(principal).toMatchObject({
        userId,
        clientId,
        resource: resource.toString(),
        scopes: ["koed:memory:read", "koed:team:read"]
      });
      expect(Object.isFrozen(principal)).toBe(true);
      expect(Object.isFrozen(principal.scopes)).toBe(true);
      await expect(
        verifyBearerToken(`Bearer ${tokens.access_token}`, {
          verifier: oauth.verifier,
          requiredScopes: ["koed:capture"]
        })
      ).rejects.toThrow();
      const anotherResource = createRemoteMcpOAuthProvider({
        store,
        resourceUrl: new URL("https://different.example/mcp")
      });
      await expect(
        anotherResource.resolvePrincipal(tokens.access_token)
      ).rejects.toThrow();
      const rows = await pool.query(
        "select secret_hash from remote_mcp_oauth_credentials"
      );
      expect(
        rows.rows.every((row) => /^[a-f0-9]{64}$/.test(row.secret_hash))
      ).toBe(true);
    });

    it("rotates refresh tokens with scope narrowing and revokes the family on replay", async () => {
      const { tokens, clientId } = await issued(
        "koed:memory:read koed:team:read"
      );
      const widened = await post("/token", {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource: resource.toString(),
        scope: "koed:capture"
      });
      expect(widened.status).toBe(400);
      const refreshed = await post("/token", {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource: resource.toString(),
        scope: "koed:memory:read"
      });
      expect(refreshed.status).toBe(200);
      const next = (await refreshed.json()) as {
        access_token: string;
        refresh_token: string;
        scope: string;
      };
      expect(next.access_token).toMatch(/^koed_mcp_access_[A-Za-z0-9_-]{43}$/);
      expect(next.scope).toBe("koed:memory:read");
      const replay = await post("/token", {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource: resource.toString()
      });
      expect(replay.status).toBe(400);
      await expect(oauth.resolvePrincipal(next.access_token)).rejects.toThrow();
      await expect(
        oauth.resolvePrincipal(tokens.access_token)
      ).rejects.toThrow();
    });

    it("allows exactly one concurrent refresh then revokes the raced family", async () => {
      const { tokens, clientId } = await issued();
      const refresh = () =>
        post("/token", {
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          resource: resource.toString()
        });
      const responses = await Promise.all([refresh(), refresh()]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 400
      ]);
      const winning = (await responses
        .find((response) => response.status === 200)!
        .json()) as { access_token: string };
      await expect(
        oauth.resolvePrincipal(winning.access_token)
      ).rejects.toThrow();
    });

    it("atomically consumes an authorization code once across concurrent exchanges", async () => {
      const client = await register();
      const { code } = await authorize(client.client_id);
      const responses = await Promise.all([
        exchange(client.client_id, code),
        exchange(client.client_id, code)
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 400
      ]);
      const credentials = await pool.query(
        "select count(*)::int as count from remote_mcp_oauth_credentials c join remote_mcp_oauth_grants g on g.id = c.grant_id where g.client_id = $1 and c.kind = 'access'",
        [client.client_id]
      );
      expect(credentials.rows[0]?.count).toBe(1);
    });

    it("revocation is client bound, user disablement and expiry take effect immediately", async () => {
      const { tokens, clientId } = await issued();
      const other = await register();
      await post("/revoke", {
        client_id: other.client_id,
        token: tokens.access_token
      });
      await expect(
        oauth.resolvePrincipal(tokens.access_token)
      ).resolves.toMatchObject({ userId });
      await pool.query("update users set disabled_at = now() where id = $1", [
        userId
      ]);
      await expect(
        oauth.resolvePrincipal(tokens.access_token)
      ).rejects.toThrow();
      expect(
        (
          await post("/token", {
            client_id: clientId,
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
            resource: resource.toString()
          })
        ).status
      ).toBe(400);
      await pool.query("update users set disabled_at = null where id = $1", [
        userId
      ]);
      time = new Date(time.getTime() + 16 * 60_000);
      await expect(
        oauth.resolvePrincipal(tokens.access_token)
      ).rejects.toThrow();
      const refreshed = await post("/token", {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource: resource.toString()
      });
      expect(refreshed.status).toBe(200);
      const next = (await refreshed.json()) as { access_token: string };
      expect(
        (
          await post("/revoke", {
            client_id: clientId,
            token: next.access_token
          })
        ).status
      ).toBe(200);
      await expect(oauth.resolvePrincipal(next.access_token)).rejects.toThrow();
    });

    it("denial and consent replay issue no code; grants belong to the authenticated Koed User", async () => {
      const client = await register();
      const denied = await authorize(
        client.client_id,
        "koed:memory:read",
        userId,
        false
      );
      expect(denied.redirect.searchParams.get("error")).toBe("access_denied");
      expect(denied.redirect.searchParams.has("code")).toBe(false);
      await expect(
        oauth.completeAuthorization({
          requestSecret: denied.requestSecret,
          userId,
          approved: true
        })
      ).rejects.toThrow();
      const { code } = await authorize(
        client.client_id,
        "koed:memory:read",
        otherUserId
      );
      const response = await exchange(client.client_id, code);
      const token = (await response.json()) as { access_token: string };
      await expect(
        oauth.resolvePrincipal(token.access_token)
      ).resolves.toMatchObject({ userId: otherUserId });
    });
  }
);
