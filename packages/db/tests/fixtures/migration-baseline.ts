import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { expect } from "vitest";
import { runDbMigrations } from "../../src/migrate.js";

/** Last migration already on main before this branch's Project cutover. */
export const MAIN_MIGRATION_BASELINE = "0046_external_agent_grants";

export const createMigrationBaseline = async (
  through = MAIN_MIGRATION_BASELINE
) => {
  const source = fileURLToPath(new URL("../../drizzle/", import.meta.url));
  const journal = JSON.parse(
    await readFile(join(source, "meta/_journal.json"), "utf8")
  ) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const last = journal.entries.findIndex((entry) => entry.tag === through);
  if (last < 0) throw new Error(`Migration baseline is missing: ${through}`);
  const entries = journal.entries.slice(0, last + 1);
  const scratch = fileURLToPath(
    new URL("../../../../scratch/", import.meta.url)
  );
  await mkdir(scratch, { recursive: true });
  const folder = await mkdtemp(join(scratch, "migration-baseline-"));
  const dispose = () => rm(folder, { recursive: true, force: true });
  try {
    await mkdir(join(folder, "meta"));
    for (const entry of entries)
      await copyFile(
        join(source, `${entry.tag}.sql`),
        join(folder, `${entry.tag}.sql`)
      );
    await writeFile(
      join(folder, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries })
    );
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    folder,
    source,
    journal,
    entries,
    dispose,
    apply: async (pool: pg.Pool) => {
      expect(
        (
          await pool.query<{ existing: string | null }>(
            "select to_regclass('public.sessions') as existing"
          )
        ).rows[0]!.existing
      ).toBeNull();
      await runDbMigrations(pool, { migrationsFolder: folder });
    }
  };
};
