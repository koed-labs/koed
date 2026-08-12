import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertEvalDatabaseName,
  ExperienceReplayDatabaseTemplates
} from "./database-templates.js";

const within = async <T>(label: string, promise: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out while ${label}`)),
          5_000
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("experience replay database template guards", () => {
  it("accepts only disposable eval-prefixed database names", () => {
    expect(() =>
      assertEvalDatabaseName("koed_eval_run1_relevant")
    ).not.toThrow();
    for (const unsafe of [
      "postgres",
      "koed",
      "koed_eval_x; DROP DATABASE postgres",
      "koed_eval_UPPER",
      `koed_eval_${"x".repeat(60)}`
    ]) {
      expect(() => assertEvalDatabaseName(unsafe)).toThrow("Unsafe");
    }
  });

  it("never owns or drops a caller-owned source when template freezing fails", async () => {
    const source = "koed_eval_forced_source";
    const template = "koed_eval_forced_template";
    const statements: string[] = [];
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation((async (
      statement: string
    ) => {
      statements.push(statement);
      if (statement.startsWith(`ALTER DATABASE "${template}" WITH`)) {
        throw new Error("forced freeze failure");
      }
      return { rows: [], rowCount: 0 } as never;
    }) as never);
    vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    const manager = new ExperienceReplayDatabaseTemplates({
      adminDatabaseUrl: "postgresql://127.0.0.1:5432/postgres",
      user: "benchmark",
      password: "benchmark"
    });

    await expect(
      manager.createTemplate({
        templateName: template,
        sourceDatabaseName: source
      })
    ).rejects.toThrow("forced freeze failure");
    await expect(manager.drop(source)).rejects.toThrow("not owned");
    await manager.close();

    expect(
      statements.some((statement) =>
        statement.startsWith(`DROP DATABASE IF EXISTS "${template}"`)
      )
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.startsWith(`DROP DATABASE IF EXISTS "${source}"`)
      )
    ).toBe(false);
  });

  it("cleans every run-owned template and clone despite a forced drop failure", async () => {
    const source = "koed_eval_cleanup_source";
    const template = "koed_eval_cleanup_template";
    const clone = "koed_eval_cleanup_clone";
    const statements: string[] = [];
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation((async (
      statement: string
    ) => {
      statements.push(statement);
      if (statement === `DROP DATABASE IF EXISTS "${clone}"`) {
        throw new Error("forced clone cleanup failure");
      }
      return { rows: [], rowCount: 0 } as never;
    }) as never);
    vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    const manager = new ExperienceReplayDatabaseTemplates({
      adminDatabaseUrl: "postgresql://127.0.0.1:5432/postgres",
      user: "benchmark",
      password: "benchmark"
    });

    await manager.createTemplate({
      templateName: template,
      sourceDatabaseName: source
    });
    await manager.cloneTemplate({ templateName: template, cloneName: clone });
    await expect(manager.close()).rejects.toThrow(
      "Failed to remove benchmark databases"
    );

    expect(statements).toContain(`DROP DATABASE IF EXISTS "${clone}"`);
    expect(statements).toContain(`DROP DATABASE IF EXISTS "${template}"`);
    expect(statements).not.toContain(`DROP DATABASE IF EXISTS "${source}"`);
  });

  const databaseUrl = process.env.DATABASE_URL;
  (databaseUrl ? it : it.skip)(
    "freezes and clones an isolated populated PostgreSQL template",
    async () => {
      const parsed = new URL(databaseUrl!);
      const user = decodeURIComponent(parsed.username);
      const password = decodeURIComponent(parsed.password);
      parsed.username = "";
      parsed.password = "";
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const source = `koed_eval_${suffix}_source`;
      const template = `koed_eval_${suffix}_template`;
      const clone = `koed_eval_${suffix}_clone`;
      const admin = new pg.Pool({ connectionString: databaseUrl });
      const manager = new ExperienceReplayDatabaseTemplates({
        adminDatabaseUrl: parsed.toString(),
        user,
        password
      });
      try {
        await within(
          "creating source database",
          admin.query(`CREATE DATABASE "${source}"`)
        );
        const sourceUrl = new URL(databaseUrl!);
        sourceUrl.pathname = `/${source}`;
        const sourceClient = new pg.Client({
          connectionString: sourceUrl.toString()
        });
        await within("connecting source client", sourceClient.connect());
        await within(
          "creating source data",
          sourceClient.query("CREATE TABLE replay_probe (value text NOT NULL)")
        );
        await within(
          "inserting source data",
          sourceClient.query(
            "INSERT INTO replay_probe (value) VALUES ('frozen')"
          )
        );
        await within("closing source client", sourceClient.end());

        await within(
          "creating frozen template",
          manager.createTemplate({
            templateName: template,
            sourceDatabaseName: source
          })
        );
        await within(
          "cloning frozen template",
          manager.cloneTemplate({ templateName: template, cloneName: clone })
        );
        const cloneUrl = new URL(databaseUrl!);
        cloneUrl.pathname = `/${clone}`;
        const cloneClient = new pg.Client({
          connectionString: cloneUrl.toString()
        });
        await within("connecting clone client", cloneClient.connect());
        await expect(
          cloneClient.query<{ value: string }>("SELECT value FROM replay_probe")
        ).resolves.toMatchObject({ rows: [{ value: "frozen" }] });
        await within("closing clone client", cloneClient.end());
      } finally {
        try {
          await within("closing template manager", manager.close());
        } finally {
          await within(
            "dropping caller-owned source database",
            admin.query(`DROP DATABASE IF EXISTS "${source}"`)
          );
          await within("closing admin pool", admin.end());
        }
      }
    },
    30_000
  );
});
