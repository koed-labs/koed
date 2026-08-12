import pg from "pg";
import { assertLoopbackUrl } from "./isolation.js";

const DATABASE_NAME = /^koed_eval_[a-z0-9_]{1,52}$/;

export const assertEvalDatabaseName = (name: string): void => {
  if (!DATABASE_NAME.test(name)) {
    throw new Error(`Unsafe benchmark database name: ${name}`);
  }
};

const quoted = (name: string): string => {
  assertEvalDatabaseName(name);
  return `"${name}"`;
};

export interface DatabaseTemplateAttestation {
  name: string;
  state: "empty" | "placebo" | "relevant";
  taskDigest: string;
  sourceStateHash: string;
  frozenAt: string;
}

export class ExperienceReplayDatabaseTemplates {
  private readonly admin: pg.Pool;
  private readonly created = new Set<string>();
  private closed = false;

  constructor({
    adminDatabaseUrl,
    user,
    password
  }: {
    adminDatabaseUrl: string;
    user: string;
    password: string;
  }) {
    assertLoopbackUrl(adminDatabaseUrl, "Benchmark PostgreSQL admin");
    if (!user || !password) {
      throw new Error("Benchmark PostgreSQL credentials are required");
    }
    const parsed = new URL(adminDatabaseUrl);
    this.admin = new pg.Pool({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 5432,
      database: parsed.pathname.slice(1),
      user,
      password,
      max: 1,
      allowExitOnIdle: true,
      statement_timeout: 30_000,
      query_timeout: 30_000
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Database template manager is closed");
  }

  async createTemplate({
    templateName,
    sourceDatabaseName
  }: {
    templateName: string;
    sourceDatabaseName: string;
  }): Promise<void> {
    this.assertOpen();
    assertEvalDatabaseName(templateName);
    assertEvalDatabaseName(sourceDatabaseName);
    this.created.add(sourceDatabaseName);
    await this.terminateConnections(sourceDatabaseName);
    await this.admin.query(
      `CREATE DATABASE ${quoted(templateName)} WITH TEMPLATE ${quoted(sourceDatabaseName)}`
    );
    this.created.add(templateName);
    await this.terminateConnections(templateName);
    await this.admin.query(
      `ALTER DATABASE ${quoted(templateName)} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`
    );
  }

  async cloneTemplate({
    templateName,
    cloneName
  }: {
    templateName: string;
    cloneName: string;
  }): Promise<void> {
    this.assertOpen();
    assertEvalDatabaseName(templateName);
    assertEvalDatabaseName(cloneName);
    if (!this.created.has(templateName)) {
      throw new Error(`Unknown benchmark template ${templateName}`);
    }
    await this.admin.query(
      `CREATE DATABASE ${quoted(cloneName)} WITH TEMPLATE ${quoted(templateName)}`
    );
    this.created.add(cloneName);
  }

  async drop(name: string): Promise<void> {
    assertEvalDatabaseName(name);
    await this.admin
      .query(
        `ALTER DATABASE ${quoted(name)} WITH ALLOW_CONNECTIONS true IS_TEMPLATE false`
      )
      .catch(() => undefined);
    await this.terminateConnections(name);
    await this.admin.query(`DROP DATABASE IF EXISTS ${quoted(name)}`);
    this.created.delete(name);
  }

  private async terminateConnections(name: string): Promise<void> {
    assertEvalDatabaseName(name);
    await this.admin.query(
      "SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name]
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const failures: Error[] = [];
    for (const name of [...this.created].reverse()) {
      try {
        await this.drop(name);
      } catch (error) {
        failures.push(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
    this.closed = true;
    await this.admin.end();
    if (failures.length) {
      throw new AggregateError(
        failures,
        "Failed to remove benchmark databases"
      );
    }
  }
}
