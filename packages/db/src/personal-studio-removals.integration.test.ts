import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createMemorySourceRepository } from "./repository.js";
import { runDbMigrations } from "./migrate.js";

const baseUrl = process.env.STUDIO_REMOVALS_TEST_DATABASE_URL;
const databaseName = `koed_studio_removals_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!baseUrl)("Personal Studio removals (PostgreSQL)", () => {
  const configured = baseUrl ? new URL(baseUrl) : null;
  const adminUrl = configured ? new URL(configured) : null;
  if (adminUrl) adminUrl.pathname = "/postgres";
  const testUrl = configured ? new URL(configured) : null;
  if (testUrl) testUrl.pathname = `/${databaseName}`;
  const admin = adminUrl
    ? new pg.Client({ connectionString: adminUrl.toString() })
    : null;
  const pool = testUrl
    ? new pg.Pool({ connectionString: testUrl.toString() })
    : null;
  let connected = false;

  afterAll(async () => {
    await pool?.end();
    if (!admin || !connected) return;
    try {
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",
        [databaseName]
      );
      await admin.query(`drop database if exists "${databaseName}"`);
    } finally {
      await admin.end();
    }
  });

  it("survives repository recreation and remains isolated by owner", async () => {
    if (!admin || !pool)
      throw new Error("Disposable test database URL unavailable");
    await admin.connect();
    connected = true;
    await admin.query(`create database "${databaseName}"`);
    await runDbMigrations(pool);
    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    await pool.query(
      "insert into users(id,email,display_name) values($1,$2,'Owner A'),($3,$4,'Owner B')",
      [
        ownerId,
        `${ownerId}@studio.invalid`,
        otherOwnerId,
        `${otherOwnerId}@studio.invalid`
      ]
    );

    const target = {
      kind: "conversation" as const,
      id: `managed:${randomUUID()}`,
      aliases: [`codex:${randomUUID()}`]
    };
    const first = createMemorySourceRepository(pool);
    await first.setPersonalStudioRemoval(
      { userId: ownerId },
      { ...target, removed: true }
    );

    const restarted = createMemorySourceRepository(pool);
    expect(
      await restarted.listPersonalStudioRemovals({ userId: ownerId })
    ).toEqual([target]);
    expect(
      await restarted.listPersonalStudioRemovals({ userId: otherOwnerId })
    ).toEqual([]);

    await restarted.setPersonalStudioRemoval(
      { userId: ownerId },
      { ...target, removed: false }
    );
    expect(await first.listPersonalStudioRemovals({ userId: ownerId })).toEqual(
      []
    );
  });
});
