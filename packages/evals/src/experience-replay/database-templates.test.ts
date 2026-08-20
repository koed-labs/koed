import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertEvalDatabaseName,
  ExperienceReplayDatabaseTemplates
} from "./database-templates.js";

const within = async <T>(
  label: string,
  promise: Promise<T>,
  timeoutMs = 5_000
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out while ${label}`)),
          timeoutMs
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
      if (statement === `DROP DATABASE IF EXISTS "${clone}" WITH (FORCE)`) {
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

    expect(statements).toContain(
      `DROP DATABASE IF EXISTS "${clone}" WITH (FORCE)`
    );
    expect(statements).toContain(
      `DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`
    );
    expect(statements).not.toContain(
      `DROP DATABASE IF EXISTS "${source}" WITH (FORCE)`
    );
  });

  it("owns a database only after its explicit create succeeds", async () => {
    const database = "koed_eval_create_failure";
    vi.spyOn(pg.Pool.prototype, "query").mockRejectedValueOnce(
      new Error("forced create failure")
    );
    const end = vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    const manager = new ExperienceReplayDatabaseTemplates({
      adminDatabaseUrl: "postgresql://127.0.0.1:5432/postgres",
      user: "benchmark",
      password: "benchmark"
    });
    await expect(manager.createRunDatabase(database)).rejects.toThrow(
      "forced create failure"
    );
    await expect(manager.drop(database)).rejects.toThrow("not owned");
    await manager.close();
    expect(end).toHaveBeenCalledOnce();
  });

  it("re-adopts only a run-marked frozen template after process restart", async () => {
    const template = "koed_eval_restart_template";
    const marker = JSON.stringify({
      schema: "koed-experience-replay-database-owner-v1",
      ownerId: "run-owner",
      kind: "template"
    });
    const statements: string[] = [];
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation((async (
      statement: string
    ) => {
      statements.push(statement);
      if (statement.startsWith("SELECT shobj_description")) {
        return { rows: [{ marker }], rowCount: 1 } as never;
      }
      if (statement.startsWith("SELECT datallowconn")) {
        return {
          rows: [{ datallowconn: false, datistemplate: true }],
          rowCount: 1
        } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    }) as never);
    vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    const wrongRun = new ExperienceReplayDatabaseTemplates({
      adminDatabaseUrl: "postgresql://127.0.0.1:5432/postgres",
      user: "benchmark",
      password: "benchmark",
      ownerId: "different-owner"
    });
    await expect(wrongRun.adoptFrozenTemplate(template)).rejects.toThrow(
      "not owned by this run"
    );
    await wrongRun.close();

    const manager = new ExperienceReplayDatabaseTemplates({
      adminDatabaseUrl: "postgresql://127.0.0.1:5432/postgres",
      user: "benchmark",
      password: "benchmark",
      ownerId: "run-owner"
    });

    await expect(manager.adoptFrozenTemplate(template)).resolves.toEqual({
      name: template,
      allowConnections: false,
      isTemplate: true
    });
    await manager.close();

    expect(statements).toContain(
      `DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`
    );
  });

  it("separates ephemeral cleanup from preserved frozen templates", async () => {
    const stage = "koed_eval_preserve_stage";
    const template = "koed_eval_preserve_template";
    const statements: string[] = [];
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation((async (
      statement: string
    ) => {
      statements.push(statement);
      return { rows: [], rowCount: 0 } as never;
    }) as never);
    vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    const manager = new ExperienceReplayDatabaseTemplates({
      adminDatabaseUrl: "postgresql://127.0.0.1:5432/postgres",
      user: "benchmark",
      password: "benchmark",
      ownerId: "run-owner"
    });

    await manager.createRunDatabase(stage);
    await manager.createTemplate({
      templateName: template,
      sourceDatabaseName: stage
    });
    await manager.close({ preserveTemplates: true });

    expect(statements).toContain(
      `DROP DATABASE IF EXISTS "${stage}" WITH (FORCE)`
    );
    expect(statements).not.toContain(
      `DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`
    );
    expect(
      statements.find((statement) =>
        statement.startsWith(`COMMENT ON DATABASE "${template}"`)
      )
    ).toContain('"kind":"template"');
  });

  it("adopts cached templates only by exact identity and preserves them on close", async () => {
    const template = "koed_eval_cached_template";
    const identity = `sha256:${"a".repeat(64)}`;
    const marker = JSON.stringify({
      schema: "koed-experience-replay-database-owner-v1",
      ownerId: "publisher-run",
      kind: "cached-template",
      contentIdentity: identity
    });
    const statements: string[] = [];
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation((async (
      statement: string
    ) => {
      statements.push(statement);
      if (statement.startsWith("SELECT shobj_description")) {
        return { rows: [{ marker }], rowCount: 1 } as never;
      }
      if (statement.startsWith("SELECT datallowconn")) {
        return {
          rows: [{ datallowconn: false, datistemplate: true }],
          rowCount: 1
        } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    }) as never);
    vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    const manager = new ExperienceReplayDatabaseTemplates({
      adminDatabaseUrl: "postgresql://127.0.0.1:5432/postgres",
      user: "benchmark",
      password: "benchmark",
      ownerId: "consumer-run"
    });

    await expect(
      manager.adoptCachedTemplate({
        templateName: template,
        contentIdentity: identity
      })
    ).resolves.toEqual({
      name: template,
      allowConnections: false,
      isTemplate: true
    });
    await expect(
      manager.adoptCachedTemplate({
        templateName: template,
        contentIdentity: `sha256:${"b".repeat(64)}`
      })
    ).rejects.toThrow("content identity mismatch");
    await expect(manager.drop(template)).rejects.toThrow("not owned");
    await manager.close();

    expect(
      statements.some((statement) =>
        statement.includes(`DROP DATABASE IF EXISTS "${template}"`)
      )
    ).toBe(false);
  });

  it("fails closed when a cached template is no longer frozen", async () => {
    const template = "koed_eval_cached_unfrozen";
    const identity = `sha256:${"c".repeat(64)}`;
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation((async (
      statement: string
    ) => {
      if (statement.startsWith("SELECT shobj_description")) {
        return {
          rows: [
            {
              marker: JSON.stringify({
                schema: "koed-experience-replay-database-owner-v1",
                ownerId: "publisher",
                kind: "cached-template",
                contentIdentity: identity
              })
            }
          ],
          rowCount: 1
        } as never;
      }
      if (statement.startsWith("SELECT datallowconn")) {
        return {
          rows: [{ datallowconn: true, datistemplate: true }],
          rowCount: 1
        } as never;
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
      manager.cloneCachedTemplate({
        templateName: template,
        cloneName: "koed_eval_cached_clone",
        contentIdentity: identity
      })
    ).rejects.toThrow("not immutably frozen");
    await manager.close();
  });

  it("removes only an orphaned cached template with the exact content identity", async () => {
    const template = "koed_eval_campaign_orphan";
    const identity = `sha256:${"e".repeat(64)}`;
    const statements: string[] = [];
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation((async (
      statement: string
    ) => {
      statements.push(statement);
      if (statement.startsWith("SELECT EXISTS(")) {
        return { rows: [{ exists: true }], rowCount: 1 } as never;
      }
      if (statement.startsWith("SELECT shobj_description")) {
        return {
          rows: [
            {
              marker: JSON.stringify({
                schema: "koed-experience-replay-database-owner-v1",
                ownerId: "interrupted-builder",
                kind: "cached-template",
                contentIdentity: identity
              })
            }
          ],
          rowCount: 1
        } as never;
      }
      if (statement.startsWith("SELECT datallowconn")) {
        return {
          rows: [{ datallowconn: false, datistemplate: true }],
          rowCount: 1
        } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    }) as never);
    vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn()
    } as never);
    vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    const manager = new ExperienceReplayDatabaseTemplates({
      adminDatabaseUrl: "postgresql://127.0.0.1:5432/postgres",
      user: "benchmark",
      password: "benchmark"
    });

    await expect(
      manager.evictCachedTemplateIfExists({
        templateName: template,
        contentIdentity: identity
      })
    ).resolves.toBe(true);
    await manager.close();

    expect(statements).toContain(
      `DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`
    );
  });

  it("refuses to remove an orphan carrying another cache identity", async () => {
    const template = "koed_eval_campaign_foreign";
    const requestedIdentity = `sha256:${"f".repeat(64)}`;
    const foreignIdentity = `sha256:${"0".repeat(64)}`;
    const statements: string[] = [];
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation((async (
      statement: string
    ) => {
      statements.push(statement);
      if (statement.startsWith("SELECT EXISTS(")) {
        return { rows: [{ exists: true }], rowCount: 1 } as never;
      }
      if (statement.startsWith("SELECT shobj_description")) {
        return {
          rows: [
            {
              marker: JSON.stringify({
                schema: "koed-experience-replay-database-owner-v1",
                ownerId: "another-builder",
                kind: "cached-template",
                contentIdentity: foreignIdentity
              })
            }
          ],
          rowCount: 1
        } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    }) as never);
    vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn()
    } as never);
    vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    const manager = new ExperienceReplayDatabaseTemplates({
      adminDatabaseUrl: "postgresql://127.0.0.1:5432/postgres",
      user: "benchmark",
      password: "benchmark"
    });

    await expect(
      manager.evictCachedTemplateIfExists({
        templateName: template,
        contentIdentity: requestedIdentity
      })
    ).rejects.toThrow("content identity mismatch");
    await manager.close();

    expect(
      statements.some((statement) => statement.startsWith("DROP DATABASE"))
    ).toBe(false);
  });

  it("uses a reentrant session advisory lock keyed by the full content identity", async () => {
    const identity = `sha256:${"d".repeat(64)}`;
    const lockQueries: Array<{ statement: string; values?: unknown[] }> = [];
    const release = vi.fn();
    vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({
      query: vi.fn(async (statement: string, values?: unknown[]) => {
        lockQueries.push({ statement, values });
        return { rows: [], rowCount: 0 };
      }),
      release
    } as never);
    vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    const manager = new ExperienceReplayDatabaseTemplates({
      adminDatabaseUrl: "postgresql://127.0.0.1:5432/postgres",
      user: "benchmark",
      password: "benchmark"
    });

    await manager.withContentIdentityLock(identity, async () => {
      await manager.withContentIdentityLock(identity, async () => undefined);
    });
    await manager.close();

    expect(lockQueries).toEqual([
      {
        statement: "SELECT pg_advisory_lock(hashtextextended($1, 0))",
        values: [identity]
      },
      {
        statement: "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        values: [identity]
      }
    ]);
    expect(release).toHaveBeenCalledOnce();
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
          await within("closing template manager", manager.close(), 15_000);
        } finally {
          await within(
            "dropping caller-owned source database",
            admin.query(`DROP DATABASE IF EXISTS "${source}"`)
          );
          await within("closing admin pool", admin.end());
        }
      }
    },
    45_000
  );
});
