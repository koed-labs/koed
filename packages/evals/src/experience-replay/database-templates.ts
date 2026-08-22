import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { assertLoopbackUrl } from "./isolation.js";
import type { MemoryReplayCondition } from "./core/schedule.js";

const DATABASE_NAME = /^koed_eval_[a-z0-9_]{1,52}$/;
const OWNERSHIP_SCHEMA = "koed-experience-replay-database-owner-v1";

export type OwnedDatabaseKind = "ephemeral" | "template" | "cached-template";

export interface DatabaseOwnershipMarker {
  schema: typeof OWNERSHIP_SCHEMA;
  ownerId: string;
  kind: OwnedDatabaseKind;
  contentIdentity?: string;
}

const CONTENT_IDENTITY = /^sha256:[a-f0-9]{64}$/u;

export const assertDatabaseTemplateContentIdentity = (
  identity: string
): void => {
  if (!CONTENT_IDENTITY.test(identity)) {
    throw new Error(`Invalid database template content identity: ${identity}`);
  }
};

export const assertEvalDatabaseName = (name: string): void => {
  if (!DATABASE_NAME.test(name)) {
    throw new Error(`Unsafe benchmark database name: ${name}`);
  }
};

const quoted = (name: string): string => {
  assertEvalDatabaseName(name);
  return `"${name}"`;
};

const quotedLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

export interface DatabaseTemplateAttestation {
  name: string;
  state: MemoryReplayCondition;
  taskDigest: string;
  sourceStateHash: string;
  frozenAt: string;
}

export interface FrozenDatabaseAttestation {
  name: string;
  allowConnections: false;
  isTemplate: true;
}

export class ExperienceReplayDatabaseTemplates {
  private readonly admin: pg.Pool;
  private readonly ephemeral = new Set<string>();
  private readonly templates = new Set<string>();
  private readonly cachedTemplates = new Map<string, string>();
  private readonly heldContentLocks = new AsyncLocalStorage<
    ReadonlySet<string>
  >();
  private closed = false;

  constructor({
    adminDatabaseUrl,
    user,
    password,
    ownerId = "legacy-process-owner"
  }: {
    adminDatabaseUrl: string;
    user: string;
    password: string;
    /** Stable, credential-free run identity used to re-adopt databases. */
    ownerId?: string;
  }) {
    assertLoopbackUrl(adminDatabaseUrl, "Benchmark PostgreSQL admin");
    if (!user || !password) {
      throw new Error("Benchmark PostgreSQL credentials are required");
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(ownerId)) {
      throw new Error("Benchmark database owner ID is invalid");
    }
    this.ownerId = ownerId;
    const parsed = new URL(adminDatabaseUrl);
    this.admin = new pg.Pool({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 5432,
      database: parsed.pathname.slice(1),
      user,
      password,
      max: 4,
      allowExitOnIdle: true,
      statement_timeout: 30_000,
      query_timeout: 30_000
    });
  }

  private readonly ownerId: string;

  private assertOpen(): void {
    if (this.closed) throw new Error("Database template manager is closed");
  }

  async createRunDatabase(name: string): Promise<void> {
    this.assertOpen();
    assertEvalDatabaseName(name);
    await this.admin.query(`CREATE DATABASE ${quoted(name)}`);
    this.ephemeral.add(name);
    try {
      await this.markOwned(name, "ephemeral");
    } catch (error) {
      await this.dropRunOwned(name).catch(() => undefined);
      throw error;
    }
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
    if (templateName === sourceDatabaseName) {
      throw new Error("Benchmark template and source databases must differ");
    }
    await this.terminateConnections(sourceDatabaseName);
    await this.admin.query(
      `CREATE DATABASE ${quoted(templateName)} WITH TEMPLATE ${quoted(sourceDatabaseName)}`
    );
    // Ownership begins only after our CREATE succeeds. In particular, the
    // caller-owned source database must never enter the cleanup set.
    this.templates.add(templateName);
    try {
      await this.markOwned(templateName, "template");
    } catch (error) {
      await this.dropRunOwned(templateName).catch(() => undefined);
      throw error;
    }
    await this.terminateConnections(templateName);
    await this.admin.query(
      `ALTER DATABASE ${quoted(templateName)} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`
    );
  }

  /**
   * Publishes a persistent frozen template. The content lock serializes the
   * database existence check and publication across benchmark processes.
   */
  async createCachedTemplate({
    templateName,
    sourceDatabaseName,
    contentIdentity
  }: {
    templateName: string;
    sourceDatabaseName: string;
    contentIdentity: string;
  }): Promise<FrozenDatabaseAttestation> {
    this.assertOpen();
    assertEvalDatabaseName(templateName);
    assertEvalDatabaseName(sourceDatabaseName);
    assertDatabaseTemplateContentIdentity(contentIdentity);
    if (templateName === sourceDatabaseName) {
      throw new Error("Benchmark template and source databases must differ");
    }
    return this.withContentIdentityLock(contentIdentity, async () => {
      const existing = await this.databaseExists(templateName);
      if (existing) {
        return this.adoptCachedTemplate({ templateName, contentIdentity });
      }
      await this.terminateConnections(sourceDatabaseName);
      await this.admin.query(
        `CREATE DATABASE ${quoted(templateName)} WITH TEMPLATE ${quoted(sourceDatabaseName)}`
      );
      this.cachedTemplates.set(templateName, contentIdentity);
      try {
        await this.markOwned(templateName, "cached-template", contentIdentity);
        await this.terminateConnections(templateName);
        await this.admin.query(
          `ALTER DATABASE ${quoted(templateName)} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`
        );
        return await this.attestCachedTemplate(templateName, contentIdentity);
      } catch (error) {
        await this.dropCachedOwned(templateName, contentIdentity).catch(
          () => undefined
        );
        throw error;
      }
    });
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
    if (!this.templates.has(templateName)) {
      throw new Error(`Unknown benchmark template ${templateName}`);
    }
    if (templateName === cloneName) {
      throw new Error("Benchmark template and clone databases must differ");
    }
    await this.admin.query(
      `CREATE DATABASE ${quoted(cloneName)} WITH TEMPLATE ${quoted(templateName)}`
    );
    this.ephemeral.add(cloneName);
    try {
      await this.markOwned(cloneName, "ephemeral");
    } catch (error) {
      await this.dropRunOwned(cloneName).catch(() => undefined);
      throw error;
    }
  }

  async cloneCachedTemplate({
    templateName,
    cloneName,
    contentIdentity
  }: {
    templateName: string;
    cloneName: string;
    contentIdentity: string;
  }): Promise<void> {
    this.assertOpen();
    assertEvalDatabaseName(templateName);
    assertEvalDatabaseName(cloneName);
    assertDatabaseTemplateContentIdentity(contentIdentity);
    if (templateName === cloneName) {
      throw new Error("Benchmark template and clone databases must differ");
    }
    await this.adoptCachedTemplate({ templateName, contentIdentity });
    await this.admin.query(
      `CREATE DATABASE ${quoted(cloneName)} WITH TEMPLATE ${quoted(templateName)}`
    );
    this.ephemeral.add(cloneName);
    try {
      await this.markOwned(cloneName, "ephemeral");
    } catch (error) {
      await this.dropRunOwned(cloneName).catch(() => undefined);
      throw error;
    }
  }

  /** Re-adopts only a still-frozen template carrying this run's durable marker. */
  async adoptFrozenTemplate(name: string): Promise<FrozenDatabaseAttestation> {
    this.assertOpen();
    assertEvalDatabaseName(name);
    const marker = await this.readOwnership(name);
    if (
      !marker ||
      marker.schema !== OWNERSHIP_SCHEMA ||
      marker.ownerId !== this.ownerId ||
      marker.kind !== "template"
    ) {
      throw new Error(`Benchmark template ${name} is not owned by this run`);
    }
    this.templates.add(name);
    try {
      return await this.attestFrozen(name);
    } catch (error) {
      this.templates.delete(name);
      throw error;
    }
  }

  async adoptCachedTemplate({
    templateName,
    contentIdentity
  }: {
    templateName: string;
    contentIdentity: string;
  }): Promise<FrozenDatabaseAttestation> {
    this.assertOpen();
    assertEvalDatabaseName(templateName);
    assertDatabaseTemplateContentIdentity(contentIdentity);
    const marker = await this.readOwnership(templateName);
    if (
      !marker ||
      marker.schema !== OWNERSHIP_SCHEMA ||
      marker.kind !== "cached-template" ||
      marker.contentIdentity !== contentIdentity
    ) {
      throw new Error(
        `Benchmark cached template ${templateName} has a content identity mismatch`
      );
    }
    this.cachedTemplates.set(templateName, contentIdentity);
    try {
      return await this.attestCachedTemplate(templateName, contentIdentity);
    } catch (error) {
      this.cachedTemplates.delete(templateName);
      throw error;
    }
  }

  private async attestCachedTemplate(
    name: string,
    contentIdentity: string
  ): Promise<FrozenDatabaseAttestation> {
    if (this.cachedTemplates.get(name) !== contentIdentity) {
      throw new Error(`Unknown benchmark cached template ${name}`);
    }
    return this.attestFrozenFlags(name);
  }

  async attestFrozen(name: string): Promise<FrozenDatabaseAttestation> {
    this.assertOpen();
    assertEvalDatabaseName(name);
    if (!this.templates.has(name)) {
      throw new Error(`Unknown benchmark template ${name}`);
    }
    return this.attestFrozenFlags(name);
  }

  private async attestFrozenFlags(
    name: string
  ): Promise<FrozenDatabaseAttestation> {
    const result = await this.admin.query<{
      datallowconn: boolean;
      datistemplate: boolean;
    }>(
      "SELECT datallowconn, datistemplate FROM pg_database WHERE datname = $1",
      [name]
    );
    const row = result.rows[0];
    if (!row || row.datallowconn || !row.datistemplate) {
      throw new Error(`Benchmark template ${name} is not immutably frozen`);
    }
    return { name, allowConnections: false, isTemplate: true };
  }

  async drop(name: string): Promise<void> {
    this.assertOpen();
    assertEvalDatabaseName(name);
    if (!this.ephemeral.has(name) && !this.templates.has(name)) {
      throw new Error(`Benchmark database is not owned by this run: ${name}`);
    }
    await this.dropRunOwned(name);
  }

  /** Persistent templates require an identity-checked, explicit eviction. */
  async evictCachedTemplate({
    templateName,
    contentIdentity
  }: {
    templateName: string;
    contentIdentity: string;
  }): Promise<void> {
    this.assertOpen();
    assertEvalDatabaseName(templateName);
    assertDatabaseTemplateContentIdentity(contentIdentity);
    await this.withContentIdentityLock(contentIdentity, async () => {
      await this.adoptCachedTemplate({ templateName, contentIdentity });
      await this.dropCachedOwned(templateName, contentIdentity);
    });
  }

  async evictCachedTemplateIfExists({
    templateName,
    contentIdentity
  }: {
    templateName: string;
    contentIdentity: string;
  }): Promise<boolean> {
    this.assertOpen();
    assertEvalDatabaseName(templateName);
    assertDatabaseTemplateContentIdentity(contentIdentity);
    return this.withContentIdentityLock(contentIdentity, async () => {
      if (!(await this.databaseExists(templateName))) return false;
      await this.adoptCachedTemplate({ templateName, contentIdentity });
      await this.dropCachedOwned(templateName, contentIdentity);
      return true;
    });
  }

  private async dropRunOwned(name: string): Promise<void> {
    await this.admin
      .query(
        `ALTER DATABASE ${quoted(name)} WITH ALLOW_CONNECTIONS true IS_TEMPLATE false`
      )
      .catch(() => undefined);
    await this.admin.query(
      `DROP DATABASE IF EXISTS ${quoted(name)} WITH (FORCE)`
    );
    this.ephemeral.delete(name);
    this.templates.delete(name);
  }

  private async dropCachedOwned(
    name: string,
    contentIdentity: string
  ): Promise<void> {
    if (this.cachedTemplates.get(name) !== contentIdentity) {
      throw new Error(
        `Cached template ${name} is not adopted with this identity`
      );
    }
    const marker = await this.readOwnership(name);
    if (
      marker?.kind !== "cached-template" ||
      marker.contentIdentity !== contentIdentity
    ) {
      throw new Error(`Cached template ${name} changed before eviction`);
    }
    await this.admin
      .query(
        `ALTER DATABASE ${quoted(name)} WITH ALLOW_CONNECTIONS true IS_TEMPLATE false`
      )
      .catch(() => undefined);
    await this.admin.query(
      `DROP DATABASE IF EXISTS ${quoted(name)} WITH (FORCE)`
    );
    this.cachedTemplates.delete(name);
  }

  private async markOwned(
    name: string,
    kind: OwnedDatabaseKind,
    contentIdentity?: string
  ): Promise<void> {
    if (kind === "cached-template") {
      if (!contentIdentity)
        throw new Error("Cached template identity is required");
      assertDatabaseTemplateContentIdentity(contentIdentity);
    } else if (contentIdentity !== undefined) {
      throw new Error("Only cached templates may carry a content identity");
    }
    const marker: DatabaseOwnershipMarker = {
      schema: OWNERSHIP_SCHEMA,
      ownerId: this.ownerId,
      kind,
      ...(contentIdentity ? { contentIdentity } : {})
    };
    await this.admin.query(
      `COMMENT ON DATABASE ${quoted(name)} IS ${quotedLiteral(JSON.stringify(marker))}`
    );
  }

  private async readOwnership(
    name: string
  ): Promise<DatabaseOwnershipMarker | null> {
    const result = await this.admin.query<{ marker: string | null }>(
      "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1",
      [name]
    );
    const raw = result.rows[0]?.marker;
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<DatabaseOwnershipMarker>;
      const validKind =
        value.kind === "ephemeral" ||
        value.kind === "template" ||
        value.kind === "cached-template";
      const validIdentity =
        value.kind === "cached-template"
          ? typeof value.contentIdentity === "string" &&
            CONTENT_IDENTITY.test(value.contentIdentity)
          : value.contentIdentity === undefined;
      return value.schema === OWNERSHIP_SCHEMA &&
        typeof value.ownerId === "string" &&
        validKind &&
        validIdentity
        ? (value as DatabaseOwnershipMarker)
        : null;
    } catch {
      return null;
    }
  }

  private async databaseExists(name: string): Promise<boolean> {
    const result = await this.admin.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [name]
    );
    return result.rows[0]?.exists === true;
  }

  /** Holds a PostgreSQL session advisory lock derived from the full identity. */
  async withContentIdentityLock<T>(
    contentIdentity: string,
    operation: () => Promise<T>
  ): Promise<T> {
    this.assertOpen();
    assertDatabaseTemplateContentIdentity(contentIdentity);
    const inherited = this.heldContentLocks.getStore();
    if (inherited?.has(contentIdentity)) return operation();
    const client = await this.admin.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        contentIdentity
      ]);
      try {
        return await this.heldContentLocks.run(
          new Set([...(inherited ?? []), contentIdentity]),
          operation
        );
      } finally {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [contentIdentity]
        );
      }
    } finally {
      client.release();
    }
  }

  private async terminateConnections(name: string): Promise<void> {
    assertEvalDatabaseName(name);
    await this.admin.query(
      "SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name]
    );
  }

  async close({
    preserveTemplates = false
  }: { preserveTemplates?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    const failures: Error[] = [];
    const cleanupNames = [
      ...this.ephemeral,
      ...(preserveTemplates ? [] : [...this.templates])
    ];
    const cleanupGroups = [
      [...this.ephemeral],
      preserveTemplates ? [] : [...this.templates]
    ];
    for (const group of cleanupGroups) {
      for (const name of group) {
        try {
          await this.dropRunOwned(name);
        } catch (error) {
          failures.push(
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
    }
    if (cleanupNames.length > 0) {
      try {
        const remaining = await this.admin.query<{ datname: string }>(
          "SELECT datname FROM pg_database WHERE datname = ANY($1::text[]) ORDER BY datname",
          [cleanupNames]
        );
        if (remaining.rows.length > 0) {
          failures.push(
            new Error(
              `Run-owned benchmark databases remain: ${remaining.rows
                .map((row) => row.datname)
                .join(", ")}`
            )
          );
        }
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
