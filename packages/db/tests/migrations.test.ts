import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const drizzleDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle"
);

const readDrizzleFile = (path: string) =>
  readFile(resolve(drizzleDir, path), "utf8");

describe("historical priority migration chain", () => {
  it("keeps the Project migration before priority migrations", async () => {
    const [journalText, initialPrioritySql, upgradeSql] = await Promise.all([
      readDrizzleFile("meta/_journal.json"),
      readDrizzleFile("0013_brave_black_widow.sql"),
      readDrizzleFile("0014_warm_doorman.sql")
    ]);
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries.slice(12, 15)).toEqual([
      expect.objectContaining({ idx: 12, tag: "0012_cuddly_luke_cage" }),
      expect.objectContaining({ idx: 13, tag: "0013_brave_black_widow" }),
      expect.objectContaining({ idx: 14, tag: "0014_warm_doorman" })
    ]);
    expect(initialPrioritySql).toContain(
      'ADD COLUMN "priority" integer DEFAULT 0 NOT NULL'
    );
    expect(upgradeSql).toContain('ALTER COLUMN "priority" SET DEFAULT 10');
    expect(upgradeSql).toContain(
      `SET "priority" = 10 WHERE "priority" = 0 AND "status" IN ('pending', 'active')`
    );
  });

  it("adds durable historical import state after priority migrations", async () => {
    const [journalText, migrationSql] = await Promise.all([
      readDrizzleFile("meta/_journal.json"),
      readDrizzleFile("0015_curly_the_order.sql")
    ]);
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries[15]).toEqual(
      expect.objectContaining({ idx: 15, tag: "0015_curly_the_order" })
    );
    expect(migrationSql).toContain('CREATE TABLE "historical_import_runs"');
    expect(migrationSql).toContain('CREATE TABLE "historical_import_sources"');
    expect(migrationSql).toContain('"local_source_path" text NOT NULL');
    expect(migrationSql).toContain(
      'ADD COLUMN "import_observed_at" timestamp with time zone'
    );
  });

  it("adds checkpoint integrity before owner-consistent source foreign key", async () => {
    const migrationSql = await readDrizzleFile("0016_wandering_gauntlet.sql");
    const uniqueConstraint = migrationSql.indexOf(
      "historical_import_runs_id_owner_unique"
    );
    const foreignKey = migrationSql.indexOf(
      "historical_import_sources_run_owner_fk"
    );

    expect(uniqueConstraint).toBeGreaterThan(-1);
    expect(foreignKey).toBeGreaterThan(uniqueConstraint);
    expect(migrationSql).toContain('ADD COLUMN "checkpoint_hash" text');
  });

  it("persists and backfills explicit LCM node work-class lineage", async () => {
    const migrationSql = await readDrizzleFile("0018_rainy_santa_claus.sql");

    expect(migrationSql).toContain(
      "ADD COLUMN \"work_class\" text DEFAULT 'normal_embedding_lcm' NOT NULL"
    );
    expect(migrationSql).toContain(
      'JOIN "conversation_projection_processing_outbox" processing'
    );
    expect(migrationSql).toContain(
      "HAVING min(processing.work_class) = max(processing.work_class)"
    );
    expect(migrationSql).toContain("memory_nodes_work_class_check");
  });
});
