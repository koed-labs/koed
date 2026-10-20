import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";
import {
  createAgentsRepository,
  AgentInstanceUnavailableError,
  AgentNotFoundError
} from "../src/agents-repository.js";
import { agentLookSchema } from "@koed/shared/agent-contract";

const databaseUrl =
  process.env.KOED_AGENT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("Agents owner and Chief constraints", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  const owner = async () => {
    const id = randomUUID();
    await pool.query("insert into users (id, email) values ($1, $2)", [
      id,
      `${id}@example.test`
    ]);
    return id;
  };
  const instance = async (
    userId: string,
    instanceId: string,
    enabled = true
  ) => {
    await pool.query(
      `insert into ai_client_instances (owner_user_id, instance_id, driver_id, display_name, enabled)
       values ($1, $2, 'codex', $2, $3)`,
      [userId, instanceId, enabled]
    );
  };
  it("creates exactly one Chief under concurrent first-use and keeps customization", async () => {
    const userId = await owner();
    await instance(userId, "codex.default");
    const repo = createAgentsRepository(pool);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        repo.ensureChief(userId, "codex.default")
      )
    );
    expect(new Set(results.map((agent) => agent.id)).size).toBe(1);
    expect(results[0]?.defaultPermissionMode).toBe("supervised");
    await repo.patch(userId, results[0]!.id, { name: "My Chief" });
    await pool.query(
      "update ai_client_instances set enabled = false where owner_user_id = $1",
      [userId]
    );
    const same = await repo.ensureChief(userId, "not.real");
    expect(same.id).toBe(results[0]!.id);
    expect(same.name).toBe("My Chief");
  });
  it("seeds Nova, Quinn and Sage once from a valid owned Chief binding", async () => {
    const userId = await owner();
    await instance(userId, "codex.helpers");
    const repo = createAgentsRepository(pool);
    const chief = await repo.ensureChief(userId, "codex.helpers");
    await repo.patch(userId, chief.id, {
      defaultModel: "gpt-test",
      defaultPermissionMode: "supervised"
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => repo.ensureHelpers(userId))
    );
    const ids = results.map((agents) =>
      agents
        .map((agent) => agent.id)
        .sort()
        .join(",")
    );
    expect(new Set(ids).size).toBe(1);
    const helpers = results[0]!.filter((agent) => !agent.isChiefOfStaff);
    expect(helpers.map((agent) => agent.name).sort()).toEqual([
      "Nova",
      "Quinn",
      "Sage"
    ]);
    expect(
      helpers.every(
        (agent) =>
          agent.aiClientInstanceId === "codex.helpers" &&
          agent.defaultModel === "gpt-test" &&
          agent.defaultPermissionMode === "supervised"
      )
    ).toBe(true);
    await repo.patch(
      userId,
      helpers.find((agent) => agent.name === "Quinn")!.id,
      { role: "My builder" }
    );
    expect(
      (await repo.ensureHelpers(userId)).find((agent) => agent.name === "Quinn")
        ?.role
    ).toBe("My builder");
    await pool.query(
      "update ai_client_instances set enabled=false where owner_user_id=$1",
      [userId]
    );
    await expect(repo.ensureHelpers(userId)).rejects.toBeInstanceOf(
      AgentInstanceUnavailableError
    );
    expect(await repo.list(userId)).toHaveLength(4);
  });
  it("rejects foreign, missing and disabled bindings; keeps owner reads private", async () => {
    const a = await owner(),
      b = await owner();
    await instance(a, "codex.private");
    await instance(b, "codex.disabled", false);
    const repo = createAgentsRepository(pool);
    await expect(repo.ensureChief(b, "codex.private")).rejects.toBeInstanceOf(
      AgentInstanceUnavailableError
    );
    await expect(repo.ensureChief(b, "codex.disabled")).rejects.toBeInstanceOf(
      AgentInstanceUnavailableError
    );
    const chief = await repo.ensureChief(a, "codex.private");
    expect(await repo.list(b)).toEqual([]);
    await expect(
      repo.patch(b, chief.id, { name: "Stolen" })
    ).rejects.toBeInstanceOf(AgentNotFoundError);
    await expect(
      pool.query("delete from ai_client_instances where owner_user_id = $1", [
        a
      ])
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("reads each owner's conversations setting and enabled instances independently", async () => {
    const a = await owner(),
      b = await owner();
    await instance(a, "codex.default");
    await instance(b, "codex.default");
    await instance(b, "codex.disabled", false);
    await pool.query(
      `insert into local_memory_agent_settings
       (owner_user_id, flow_key, provider, ai_client_instance_id,
        model, reasoning_effort, timeout_ms, max_attempts)
       values ($1, 'conversations', 'codex', 'codex.default',
         'gpt', 'low', 120000, 2)`,
      [a]
    );
    const repo = createAgentsRepository(pool);
    expect(await repo.bootstrapContext(a)).toEqual({
      ownerUserId: a,
      savedConversations: {
        provider: "codex",
        aiClientInstanceId: "codex.default"
      },
      enabledInstances: [{ instanceId: "codex.default", driverId: "codex" }]
    });
    expect(await repo.bootstrapContext(b)).toEqual({
      ownerUserId: b,
      savedConversations: null,
      enabledInstances: [{ instanceId: "codex.default", driverId: "codex" }]
    });
  });
  it("allows User deletion to cascade the Chief and instance together", async () => {
    const userId = await owner();
    await instance(userId, "codex.delete");
    await createAgentsRepository(pool).ensureChief(userId, "codex.delete");
    await pool.query("delete from users where id = $1", [userId]);
    const result = await pool.query(
      "select (select count(*) from agents where owner_user_id=$1)::integer as agents, (select count(*) from ai_client_instances where owner_user_id=$1)::integer as instances",
      [userId]
    );
    expect(result.rows[0]).toEqual({ agents: 0, instances: 0 });
  });
  it("round-trips API-valid Unicode and numeric look metadata within the JSONB cap", async () => {
    const userId = await owner();
    await instance(userId, "codex.look");
    const look = agentLookSchema.parse({
      color: '🟦 blue "quoted"',
      angle: 0.000001,
      size: 1_000_000_000,
      parts: Array.from({ length: 12 }, (_, index) => index / 10)
    });
    const agent = await createAgentsRepository(pool).create(userId, {
      name: "Look",
      role: null,
      look,
      aiClientInstanceId: "codex.look",
      defaultPermissionMode: "supervised",
      defaultModel: null
    });
    expect(agent.look).toEqual(look);
    const result = await pool.query<{ bytes: number }>(
      "select octet_length(look::text) as bytes from agents where id=$1",
      [agent.id]
    );
    expect(result.rows[0]?.bytes).toBeLessThanOrEqual(4096);
  });
});
