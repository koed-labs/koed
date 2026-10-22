import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbPool } from "./connection.js";
import { createRemoteMcpOAuthRepository } from "./remote-mcp-oauth-repository.js";

const databaseUrl = process.env.KOED_OAUTH_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("remote MCP OAuth retention", () => {
  const schema = `oauth_retention_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(databaseUrl ?? "postgresql://localhost/postgres");
  const admin = createDbPool({ connectionString: url.toString() });
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const pool = createDbPool({ connectionString: url.toString() });
  const store = createRemoteMcpOAuthRepository(pool);
  const now = new Date("2030-01-01T00:00:00Z");
  const future = new Date(now.getTime() + 60_000);
  const old = new Date(now.getTime() - 31 * 24 * 60 * 60_000);
  const owner = randomUUID();
  const otherOwner = randomUUID();

  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    await pool.query(
      "create table users (id uuid primary key, disabled_at timestamptz, deleted_at timestamptz); create table audit_events (actor_user_id uuid, owner_user_id uuid, visibility text, action text, target_table text, target_id uuid, metadata jsonb)"
    );
    await pool.query("insert into users (id) values ($1),($2)", [
      owner,
      otherOwner
    ]);
    const migration = await readFile(
      new URL("../drizzle/0043_remote_mcp_oauth.sql", import.meta.url),
      "utf8"
    );
    await pool.query(migration.replaceAll('"public".', `"${schema}".`));
    await pool.query(
      await readFile(
        new URL("../drizzle/0046_external_agent_grants.sql", import.meta.url),
        "utf8"
      )
    );
  });
  beforeEach(async () => {
    await pool.query(
      "truncate remote_mcp_oauth_grants, remote_mcp_oauth_clients cascade"
    );
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  });

  const client = async (createdAt = old) => {
    const id = randomUUID();
    await pool.query(
      "insert into remote_mcp_oauth_clients (id,metadata,created_at) values ($1,'{}',$2)",
      [id, createdAt]
    );
    return id;
  };
  const grant = async (clientId: string, expiresAt = future) => {
    const id = randomUUID();
    await pool.query(
      "insert into remote_mcp_oauth_grants (id,user_id,client_id,resource,scopes,expires_at) values ($1,$2,$3,'https://koed.test/mcp',array['koed:memory:read'],$4)",
      [id, owner, clientId, expiresAt]
    );
    return id;
  };
  const credential = async (
    grantId: string,
    kind: string,
    expiresAt = future,
    consumedAt: Date | null = null
  ) => {
    const hash = randomUUID();
    await pool.query(
      "insert into remote_mcp_oauth_credentials (secret_hash,grant_id,kind,expires_at,consumed_at,data) values ($1,$2,$3,$4,$5,'{}')",
      [hash, grantId, kind, expiresAt, consumedAt]
    );
    return hash;
  };
  const request = async (
    clientId: string,
    expiresAt = future,
    consumedAt: Date | null = null
  ) => {
    const hash = randomUUID();
    await pool.query(
      "insert into remote_mcp_oauth_requests (secret_hash,client_id,data,expires_at,consumed_at) values ($1,$2,'{}',$3,$4)",
      [hash, clientId, expiresAt, consumedAt]
    );
    return hash;
  };

  it("preserves live flows, grants and refresh replay sentinels while pruning ended state", async () => {
    const liveClient = await client();
    const pendingClient = await client();
    const endedClient = await client();
    const unusedClient = await client();
    const recentClient = await client(now);
    const liveGrant = await grant(liveClient);
    const endedGrant = await grant(endedClient, now);
    const revokedGrant = await grant(endedClient);
    await pool.query(
      "update remote_mcp_oauth_grants set revoked_at = $2 where id = $1",
      [revokedGrant, now]
    );
    const liveAccess = await credential(liveGrant, "access");
    const liveCode = await credential(liveGrant, "code");
    const refresh = await credential(liveGrant, "refresh");
    const replaySentinel = await credential(liveGrant, "refresh", old, old);
    await credential(liveGrant, "access", now);
    await credential(liveGrant, "code", future, now);
    await credential(endedGrant, "refresh");
    await credential(revokedGrant, "refresh");
    const pending = await request(pendingClient);
    await request(endedClient, now);
    await request(endedClient, future, now);

    await store.pruneExpired(now);
    expect(
      (
        await pool.query<{ secret_hash: string }>(
          "select secret_hash from remote_mcp_oauth_credentials"
        )
      ).rows
        .map((row) => row.secret_hash)
        .sort()
    ).toEqual([liveAccess, liveCode, refresh, replaySentinel].sort());
    expect(
      (await pool.query("select id from remote_mcp_oauth_grants")).rows
    ).toEqual([{ id: liveGrant }]);
    expect(
      (await pool.query("select secret_hash from remote_mcp_oauth_requests"))
        .rows
    ).toEqual([{ secret_hash: pending }]);
    expect(
      (
        await pool.query<{ id: string }>(
          "select id from remote_mcp_oauth_clients"
        )
      ).rows
        .map((row) => row.id)
        .sort()
    ).toEqual([liveClient, pendingClient, recentClient].sort());
    expect(await store.getClient(unusedClient)).toBeUndefined();
    expect(
      await store.exchange({
        kind: "refresh",
        hash: replaySentinel,
        clientId: liveClient,
        resource: "https://koed.test/mcp",
        credentials: [],
        now
      })
    ).toBeNull();
    expect(
      (
        await pool.query<{ revoked_at: Date }>(
          "select revoked_at from remote_mcp_oauth_grants where id = $1",
          [liveGrant]
        )
      ).rows[0]?.revoked_at
    ).toEqual(now);
  });

  it("bounds each table's deletion per pass, including large ended families", async () => {
    const clientId = await client();
    const endedGrant = await grant(clientId, now);
    await credential(endedGrant, "refresh");
    await credential(endedGrant, "access");
    await credential(endedGrant, "code");
    await request(clientId, now);
    await request(clientId, now);
    await request(clientId, now);
    await store.pruneExpired(now, 1);
    expect(
      (
        await pool.query<{ count: number }>(
          "select count(*)::int as count from remote_mcp_oauth_credentials"
        )
      ).rows[0]?.count
    ).toBe(2);
    expect(
      (
        await pool.query<{ count: number }>(
          "select count(*)::int as count from remote_mcp_oauth_requests"
        )
      ).rows[0]?.count
    ).toBe(2);
    expect(await store.getClient(clientId)).toBeDefined();
    await store.pruneExpired(now, 1);
    await store.pruneExpired(now, 1);
    expect(await store.getClient(clientId)).toBeUndefined();
    await expect(store.pruneExpired(now, 501)).rejects.toThrow(RangeError);
  });

  const binding = () => ({
    issuer: "https://auth.example.test",
    providerEnvironment: "staging",
    registrationId: "agent_reg_test",
    providerUserId: "user_provider",
    providerOrganizationId: "org_test",
    userId: owner,
    resource: "https://koed.test/mcp",
    teamBoundaryId: randomUUID(),
    scopes: ["koed:memory:read", "koed:team:read"],
    now,
    expiresAt: future
  });
  it("retains a disconnected registration through cleanup and repository recreation", async () => {
    const input = binding();
    const issued = (await store.resolveExternalGrant(input))!;
    expect(issued.scopes).toEqual(input.scopes);
    expect(
      await store.updateConnection({
        userId: owner,
        resource: input.resource,
        id: issued.id,
        version: 1,
        action: "disconnect",
        now,
        expiresAt: future
      })
    ).toBe(true);
    await store.pruneExpired(now);
    const restarted = createRemoteMcpOAuthRepository(pool);
    expect(
      await restarted.resolveExternalGrant({
        ...input,
        expiresAt: new Date(future.getTime() + 60_000)
      })
    ).toBeNull();
    expect(
      await restarted.listConnections(owner, input.resource)
    ).toMatchObject([
      { id: issued.id, revokedAt: now, authorizationVersion: 2 }
    ]);
  });
  it("requires owner approval after absolute expiry and rejects stale approval versions", async () => {
    const input = binding();
    const issued = (await store.resolveExternalGrant(input))!;
    expect(
      await store.resolveExternalGrant({
        ...input,
        now: future,
        expiresAt: new Date(future.getTime() + 60_000)
      })
    ).toBeNull();
    expect(
      await store.updateConnection({
        userId: otherOwner,
        resource: input.resource,
        id: issued.id,
        version: 1,
        action: "approve",
        now: future,
        expiresAt: new Date(future.getTime() + 60_000)
      })
    ).toBe(false);
    expect(
      await store.updateConnection({
        userId: owner,
        resource: input.resource,
        id: issued.id,
        version: 1,
        action: "approve",
        now: future,
        expiresAt: new Date(future.getTime() + 60_000)
      })
    ).toBe(true);
    expect(
      await store.resolveExternalGrant({ ...input, now: future })
    ).toMatchObject({ id: issued.id });
    expect(
      await store.updateConnection({
        userId: owner,
        resource: input.resource,
        id: issued.id,
        version: 1,
        action: "disconnect",
        now: future,
        expiresAt: future
      })
    ).toBe(false);
  });
  it("binds consent to the exact User, provider identity, organisation and Team mapping", async () => {
    const input = binding();
    await store.resolveExternalGrant(input);
    for (const change of [
      { userId: otherOwner },
      { providerUserId: "user_other" },
      { providerOrganizationId: "org_other" },
      { teamBoundaryId: randomUUID() }
    ])
      expect(
        await store.resolveExternalGrant({ ...input, ...change })
      ).toBeNull();
    expect(await store.listConnections(otherOwner, input.resource)).toEqual([]);
    expect(
      await store.listConnections(owner, "https://other.test/mcp")
    ).toEqual([]);
  });
  it("never widens scopes or extends the consent deadline on replacement tokens", async () => {
    const input = { ...binding(), scopes: ["koed:memory:read"] };
    const first = (await store.resolveExternalGrant(input))!;
    const replacement = await store.resolveExternalGrant({
      ...input,
      scopes: ["koed:memory:read", "koed:team:read", "koed:capture"],
      expiresAt: new Date(future.getTime() + 60_000)
    });
    expect(replacement).toEqual({
      id: first.id,
      scopes: ["koed:memory:read"],
      expiresAt: future
    });
  });
  it("allows narrower Personal-only tokens without granting or changing Team consent", async () => {
    const input = binding();
    const first = (await store.resolveExternalGrant(input))!;
    expect(
      await store.resolveExternalGrant({
        ...input,
        scopes: ["koed:memory:read"],
        teamBoundaryId: null
      })
    ).toEqual({
      id: first.id,
      scopes: ["koed:memory:read"],
      expiresAt: future
    });
    expect(await store.resolveExternalGrant(input)).toMatchObject({
      scopes: input.scopes
    });
  });
  it("disconnects native OAuth credentials through the shared owner control", async () => {
    const clientId = await client();
    const id = await grant(clientId);
    const hash = await credential(id, "access");
    await pool.query(
      "update remote_mcp_oauth_credentials set data=$2 where secret_hash=$1",
      [hash, { scopes: ["koed:memory:read"] }]
    );
    expect(await store.getAccess(hash, now)).not.toBeNull();
    expect(
      await store.updateConnection({
        userId: owner,
        resource: "https://koed.test/mcp",
        id,
        version: 1,
        action: "disconnect",
        now,
        expiresAt: future
      })
    ).toBe(true);
    expect(await store.getAccess(hash, now)).toBeNull();
    expect(
      await store.updateConnection({
        userId: owner,
        resource: "https://koed.test/mcp",
        id,
        version: 2,
        action: "approve",
        now,
        expiresAt: future
      })
    ).toBe(false);
  });
});
