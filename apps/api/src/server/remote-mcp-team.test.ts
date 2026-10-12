import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDbPool,
  createMemorySourceRepository,
  createRemoteMcpOAuthRepository,
  runDbMigrations
} from "@koed/db";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY
} from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRemoteMcpOAuthProvider } from "../auth/remote-mcp-oauth.js";
import { embedTeamSemanticQuery } from "../memory/team-semantic-embedding.js";
import { buildServer } from "./build-server.js";

const databaseUrl = process.env.KOED_OAUTH_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("remote MCP Team fixture authority", () => {
  const database = `mcp_team_${randomUUID().replaceAll("-", "")}`;
  const admin = createDbPool({
    connectionString: databaseUrl ?? "postgresql://localhost/postgres"
  });
  const isolatedUrl = new URL(databaseUrl ?? "postgresql://localhost/postgres");
  isolatedUrl.pathname = `/${database}`;
  const pool = createDbPool({ connectionString: isolatedUrl.toString() });
  const resource = new URL("https://memory.test/mcp");
  const store = createRemoteMcpOAuthRepository(pool);
  const oauth = createRemoteMcpOAuthProvider({ store, resourceUrl: resource });
  let home: string;
  const embeddingFetch = vi.fn(async () =>
    Response.json({
      model: "qwen3-0.6b",
      dimensions: 1024,
      vectors: [
        Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0))
      ]
    })
  );
  let app: Awaited<ReturnType<typeof buildServer>>;
  let fixture: {
    fixtureUsers: Record<string, { id: string }>;
    fixtureWorkspaces: Record<string, { id: string }>;
  };
  let decrypt: ReturnType<typeof vi.spyOn>;
  let repository: ReturnType<typeof createMemorySourceRepository>;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "koed-mcp-team-"));
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("KOED_HOME", home);
    vi.stubEnv("API_TOKEN_PEPPER", randomUUID());
    vi.stubEnv("KOED_REMOTE_MCP_ENABLED", "true");
    vi.stubEnv("KOED_REMOTE_MCP_PUBLIC_URL", resource.href);
    vi.stubEnv("KOED_TEAM_COLLABORATION_ENABLED", "true");
    vi.stubEnv("KOED_DEVELOPER_TEAM_BACKEND_ENABLED", "true");
    vi.stubEnv("KOED_DEPLOYMENT_PROFILE", "developer");
    vi.stubEnv("EMBEDDING_MODEL", "qwen3-0.6b");
    vi.stubEnv("WORK_QUEUE_BACKEND", "memory");
    await admin.query(`create database ${database}`);
    await runDbMigrations(pool);
    const fixtureModule = await import(
      new URL("../../../../scripts/team-saas-fixture-lib.mjs", import.meta.url)
        .href
    );
    fixture = fixtureModule;
    const runtime = await fixtureModule.createFixtureRuntime(pool, {
      environment: { NODE_ENV: "test" }
    });
    await fixtureModule.seedFixture(pool, runtime);
    await fixtureModule.validateFixture(pool, runtime);
    const embedding = await embedTeamSemanticQuery("fixture", embeddingFetch);
    // Deterministic vectors exercise production retrieval, not semantic quality.
    const pending =
      await runtime.sharedMemoryRepository.listPendingSharedMemorySemanticItems(
        {
          limit: 200,
          model: embedding.model,
          dimensions: embedding.dimensions,
          version: embedding.version
        }
      );
    expect(pending.length).toBeGreaterThan(0);
    for (const item of pending) {
      expect(
        await runtime.sharedMemoryRepository.storeSharedMemorySemanticEmbedding(
          {
            semanticItemId: item.semanticItemId,
            contentHash: item.contentHash,
            ...embedding
          }
        )
      ).toBe(true);
    }
    repository = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: runtime.personalProvider,
      teamEnvelopeEncryptionProvider: runtime.teamProvider,
      ownerPrivateReplicaEnvelopeEncryptionProvider: runtime.ownerProvider
    });
    decrypt = vi.spyOn(runtime.teamProvider, "decrypt");
    app = await buildServer({
      repository,
      remoteMcpOAuthStore: store,
      envelopeEncryptionProvider: runtime.personalProvider,
      teamEnvelopeEncryptionProvider: runtime.teamProvider,
      ownerPrivateReplicaEnvelopeEncryptionProvider: runtime.ownerProvider,
      internalServiceFetch: embeddingFetch,
      inspectDeploymentIdentity: () => ({
        health: "healthy",
        deploymentId: randomUUID(),
        deviceInstanceId: randomUUID(),
        remoteOperationsAllowed: true,
        message: "Synthetic test deployment",
        platformProtection: "verified"
      })
    });
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    await pool.end();
    await admin.query(`drop database if exists ${database}`);
    await admin.end();
    vi.unstubAllEnvs();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const issue = async (actor: string, teamRead = true) => {
    const client = await oauth.provider.clientsStore.registerClient!({
      redirect_uris: ["http://127.0.0.1:5555/callback"],
      token_endpoint_auth_method: "none"
    });
    const verifier = "z".repeat(43);
    let consentUrl = "";
    await oauth.provider.authorize(
      client,
      {
        redirectUri: client.redirect_uris[0]!,
        resource,
        scopes: ["koed:memory:read", ...(teamRead ? ["koed:team:read"] : [])],
        codeChallenge: createHash("sha256").update(verifier).digest("base64url")
      },
      {
        redirect: (_status: number, url: string) => {
          consentUrl = url;
        }
      } as never
    );
    const requestSecret = new URL(consentUrl).searchParams.get("request")!;
    expect(
      (await oauth.getAuthorizationRequest(requestSecret))?.scopes
    ).toEqual(["koed:memory:read", ...(teamRead ? ["koed:team:read"] : [])]);
    const approved = await oauth.completeAuthorization({
      requestSecret,
      userId: fixture.fixtureUsers[actor]!.id,
      approved: true
    });
    const code = new URL(approved.redirectUrl).searchParams.get("code")!;
    return (
      await oauth.provider.exchangeAuthorizationCode(
        client,
        code,
        verifier,
        client.redirect_uris[0],
        resource
      )
    ).access_token;
  };

  const rpc = (
    token: string,
    name: string,
    args: Record<string, unknown> = {}
  ) =>
    app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: resource.host,
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": name
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "fixture-team", version: "1" },
            [CLIENT_CAPABILITIES_META_KEY]: {}
          }
        }
      }
    });
  const answer = (token: string, workspace: string) =>
    rpc(token, "memory_answer", {
      query: "Team decisions",
      search_domain: "global",
      team_backend_id: "remote",
      team_workspace_id: fixture.fixtureWorkspaces[workspace]!.id,
      limit: 20
    });

  it("requires explicit Team consent and never grants Personal API Tokens Team rights", async () => {
    const token = await issue("carol", false);
    decrypt.mockClear();
    const denied = await answer(token, "electron");
    expect(denied.json().result.isError).toBe(true);
    expect(decrypt).not.toHaveBeenCalled();
    const user = fixture.fixtureUsers.carol!.id;
    const secret = `personal-${randomUUID()}`;
    await repository.createApiToken({
      ownerUserId: user,
      name: "Synthetic Personal token",
      tokenPrefix: secret.slice(0, 12),
      tokenHash: createHash("sha256")
        .update(`${process.env.API_TOKEN_PEPPER}${secret}`)
        .digest("hex")
    });
    const personal = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers: { authorization: `Bearer ${secret}` },
      payload: {
        query: "Team decisions",
        team_workspace_id: fixture.fixtureWorkspaces.electron!.id
      }
    });
    expect(personal.statusCode).toBe(403);
    expect(decrypt).not.toHaveBeenCalled();
    expect((await rpc(secret, "memory_workspaces")).statusCode).toBe(401);
  });

  it("discovers current Workspaces and returns only active shared fixture evidence", async () => {
    const token = await issue("carol");
    const discovery = await rpc(token, "memory_workspaces");
    expect(discovery.statusCode).toBe(200);
    expect(JSON.stringify(discovery.json())).toContain("Electron Team App");
    decrypt.mockClear();
    const direct = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        query: "Team decisions",
        search_domain: "global",
        team_workspace_id: fixture.fixtureWorkspaces.electron!.id,
        limit: 20
      }
    });
    expect(direct.statusCode, direct.body).toBe(200);
    const result = await answer(token, "electron");
    expect(result.statusCode).toBe(200);
    expect(result.json().result.isError, result.body).not.toBe(true);
    expect(JSON.stringify(result.json())).toContain(
      "Workspace Memory Timeline"
    );
    expect(JSON.stringify(result.json())).not.toContain(
      "Private DevOps Scratchpad"
    );
    expect(JSON.stringify(result.json())).not.toContain(
      "Revoked Electron Experiment"
    );
    expect(decrypt).toHaveBeenCalled();
  });

  it("denies disabled and removed members and Workspace access loss before decrypt", async () => {
    decrypt.mockClear();
    await expect(issue("dana")).rejects.toThrow();
    expect(decrypt).not.toHaveBeenCalled();
    for (const actor of ["frank", "bob"]) {
      const token = await issue(actor);
      decrypt.mockClear();
      embeddingFetch.mockClear();
      const result = await answer(
        token,
        actor === "bob" ? "cloud" : "electron"
      );
      expect(result.json().result.isError, actor).toBe(true);
      expect(decrypt, actor).not.toHaveBeenCalled();
      expect(embeddingFetch, actor).not.toHaveBeenCalled();
    }
    const token = await issue("carol");
    await pool.query(
      "update team_workspace_access_grants set access='disabled', version=version+1 where user_id=$1 and team_workspace_id=$2",
      [fixture.fixtureUsers.carol!.id, fixture.fixtureWorkspaces.electron!.id]
    );
    decrypt.mockClear();
    embeddingFetch.mockClear();
    expect((await answer(token, "electron")).json().result.isError).toBe(true);
    expect(decrypt).not.toHaveBeenCalled();
    expect(embeddingFetch).not.toHaveBeenCalled();
    expect(
      JSON.stringify((await rpc(token, "memory_workspaces")).json())
    ).not.toContain("Electron Team App");
    const bob = await issue("bob");
    expect((await answer(bob, "ingestion")).json().result.isError).not.toBe(
      true
    );
    await pool.query(
      "update team_memberships set status='disabled', version=version+1 where user_id=$1",
      [fixture.fixtureUsers.bob!.id]
    );
    decrypt.mockClear();
    embeddingFetch.mockClear();
    expect((await answer(bob, "ingestion")).json().result.isError).toBe(true);
    expect(decrypt).not.toHaveBeenCalled();
    expect(embeddingFetch).not.toHaveBeenCalled();
    expect(
      JSON.stringify((await rpc(bob, "memory_workspaces")).json())
    ).not.toContain("Managed Knowledge Ingestion");
  });
});
