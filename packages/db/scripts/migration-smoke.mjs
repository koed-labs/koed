#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadRootEnv } from "../../../scripts/api-token-bootstrap-lib.mjs";
import { runDbMigrations } from "../dist/migrate.js";

const { Client, Pool } = pg;

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = resolve(packageDir, "../..");

loadRootEnv(rootDir, process.env);

const databaseUrl =
  process.env.KOED_MIGRATION_SMOKE_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    "DATABASE_URL is required for the migration smoke test. Point it at a Postgres server whose user can create and drop databases."
  );
  process.exit(2);
}

const targetDatabase =
  process.env.KOED_MIGRATION_SMOKE_DATABASE ??
  `koed_migration_smoke_${process.pid}_${Date.now().toString(36)}`;

if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(targetDatabase)) {
  console.error(
    `Unsafe migration smoke database name: ${JSON.stringify(targetDatabase)}`
  );
  process.exit(2);
}

const adminDatabase =
  process.env.KOED_MIGRATION_SMOKE_ADMIN_DATABASE ?? "postgres";

const withDatabase = (connectionString, database) => {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
};

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

const migrationsFolder = resolve(packageDir, "drizzle");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const loadMigrationJournal = async (folder = migrationsFolder) => {
  const journal = JSON.parse(
    await readFile(resolve(folder, "meta", "_journal.json"), "utf8")
  );
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("Drizzle migration journal has no entries");
  }
  for (const [index, entry] of journal.entries.entries()) {
    if (
      entry.idx !== index ||
      typeof entry.tag !== "string" ||
      typeof entry.when !== "number" ||
      (index > 0 && entry.when <= journal.entries[index - 1].when)
    ) {
      throw new Error(
        `Drizzle migration journal is not sequential at entry ${index}`
      );
    }
  }
  return journal;
};

const migrationRecords = async (folder, entries) =>
  Promise.all(
    entries.map(async (entry) => {
      const sql = await readFile(resolve(folder, `${entry.tag}.sql`), "utf8");
      return { ...entry, hash: sha256(sql), sql };
    })
  );

const isPostgresAdminTermination = (error) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "57P01";

const assertMigrationLedger = async (pool, expectedRecords) => {
  const result = await pool.query(
    "select hash, created_at::text from drizzle.__drizzle_migrations order by id"
  );
  const expected = expectedRecords.map(({ hash, when }) => ({
    hash,
    created_at: String(when)
  }));
  if (!isDeepStrictEqual(result.rows, expected)) {
    throw new Error(
      `Migration ledger mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(result.rows)}`
    );
  }
};

const assertSchemaContracts = async (pool) => {
  const columnsByTable = {
    pending_sharing_rule_admissions: [
      ["existing_source_readmission", "jsonb", "YES"]
    ],
    collaboration_sharing_rule_deliveries: [
      ["rule_id", "uuid", "YES"],
      ["operation_kind", "text", "NO"]
    ],
    team_memory_workspace_exclusions: [["version", "integer", "NO"]],
    personal_model_activations: [
      ["owner_user_id", "uuid", "NO"],
      ["upgrade_id", "uuid", "NO"],
      ["contract_version", "integer", "NO"]
    ],
    personal_capture_target_routes: [
      ["owner_user_id", "uuid", "NO"],
      ["source_scope", "text", "NO"],
      ["target_id", "text", "NO"],
      ["evidence", "jsonb", "NO"]
    ],
    personal_legacy_source_assignments: [
      ["owner_user_id", "uuid", "NO"],
      ["session_id", "uuid", "NO"],
      ["evidence", "jsonb", "NO"]
    ],
    personal_capture_target_bindings: [
      ["origin", "text", "NO"],
      ["route_source_scope", "text", "YES"]
    ],
    remote_mcp_oauth_clients: [
      ["id", "uuid", "NO"],
      ["metadata", "jsonb", "NO"],
      ["created_at", "timestamp with time zone", "NO"]
    ],
    remote_mcp_oauth_grants: [
      ["id", "uuid", "NO"],
      ["user_id", "uuid", "NO"],
      ["client_id", "uuid", "NO"],
      ["resource", "text", "NO"],
      ["scopes", "ARRAY", "NO"],
      ["expires_at", "timestamp with time zone", "NO"],
      ["revoked_at", "timestamp with time zone", "YES"],
      ["created_at", "timestamp with time zone", "NO"]
    ],
    remote_mcp_oauth_credentials: [
      ["secret_hash", "text", "NO"],
      ["grant_id", "uuid", "NO"],
      ["kind", "text", "NO"],
      ["data", "jsonb", "NO"],
      ["expires_at", "timestamp with time zone", "NO"],
      ["consumed_at", "timestamp with time zone", "YES"],
      ["created_at", "timestamp with time zone", "NO"]
    ],
    remote_mcp_oauth_requests: [
      ["secret_hash", "text", "NO"],
      ["client_id", "uuid", "NO"],
      ["data", "jsonb", "NO"],
      ["expires_at", "timestamp with time zone", "NO"],
      ["consumed_at", "timestamp with time zone", "YES"],
      ["created_at", "timestamp with time zone", "NO"]
    ],
    memory_answer_tasks: [
      ["team_workspace_id", "uuid", "YES"],
      ["team_authorization", "jsonb", "YES"]
    ],
    memory_questions: [["team_authorization", "jsonb", "YES"]],
    conversation_items: [
      ["agent_seal_waiting_at", "timestamp with time zone", "YES"]
    ]
  };
  const expectedColumns = Object.entries(columnsByTable)
    .flatMap(([table_name, columns]) =>
      columns.map(([column_name, data_type, is_nullable]) => ({
        table_name,
        column_name,
        data_type,
        is_nullable
      }))
    )
    .sort(
      (a, b) =>
        a.table_name.localeCompare(b.table_name) ||
        a.column_name.localeCompare(b.column_name)
    );
  const columns = await pool.query(
    `
    select required.table_name, required.column_name, actual.data_type, actual.is_nullable
    from jsonb_to_recordset($1::jsonb) as required(table_name text, column_name text)
    left join information_schema.columns actual on actual.table_schema = 'public'
      and actual.table_name = required.table_name and actual.column_name = required.column_name
    order by required.table_name, required.column_name`,
    [JSON.stringify(expectedColumns)]
  );
  if (!isDeepStrictEqual(columns.rows, expectedColumns)) {
    throw new Error(
      `Latest migration columns differ: ${JSON.stringify(columns.rows)}`
    );
  }
  const expectedConstraints = [
    [
      "team_memory_sharing_rules",
      "team_memory_sharing_rules_authority_check",
      "c"
    ],
    [
      "collaboration_sharing_rule_deliveries",
      "csm_rule_delivery_destination_check",
      "c"
    ],
    [
      "collaboration_sharing_rule_deliveries",
      "csm_owner_delivery_target_check",
      "c"
    ],
    [
      "pending_sharing_rule_admissions",
      "pending_existing_source_readmission_check",
      "c"
    ],
    [
      "team_memory_workspace_exclusions",
      "team_memory_workspace_exclusion_state_check",
      "c"
    ],
    ["remote_mcp_oauth_clients", "remote_mcp_oauth_clients_pkey", "p"],
    ["remote_mcp_oauth_credentials", "remote_mcp_oauth_credentials_pkey", "p"],
    ["remote_mcp_oauth_grants", "remote_mcp_oauth_grants_pkey", "p"],
    ["remote_mcp_oauth_requests", "remote_mcp_oauth_requests_pkey", "p"],
    [
      "remote_mcp_oauth_credentials",
      "remote_mcp_oauth_credentials_kind_check",
      "c"
    ],
    ["memory_answer_tasks", "memory_answer_tasks_team_authority_check", "c"],
    [
      "remote_mcp_oauth_credentials",
      "remote_mcp_oauth_credentials_grant_id_remote_mcp_oauth_grants_id_fk",
      "f",
      "remote_mcp_oauth_grants",
      "c"
    ],
    [
      "remote_mcp_oauth_grants",
      "remote_mcp_oauth_grants_user_id_users_id_fk",
      "f",
      "users",
      "c"
    ],
    [
      "remote_mcp_oauth_grants",
      "remote_mcp_oauth_grants_client_id_remote_mcp_oauth_clients_id_fk",
      "f",
      "remote_mcp_oauth_clients",
      "c"
    ],
    [
      "remote_mcp_oauth_requests",
      "remote_mcp_oauth_requests_client_id_remote_mcp_oauth_clients_id_fk",
      "f",
      "remote_mcp_oauth_clients",
      "c"
    ],
    [
      "memory_answer_tasks",
      "memory_answer_tasks_team_workspace_id_team_workspaces_id_fk",
      "f",
      "team_workspaces",
      "a"
    ]
  ].map(([table, name, ...contract]) => [
    table,
    name.slice(0, 63),
    ...contract
  ]);
  const constraints = await pool.query(
    `
    select relation.relname as table_name, constraint_row.conname, constraint_row.contype,
      constraint_row.convalidated, referenced.relname as referenced_table, constraint_row.confdeltype
    from pg_constraint constraint_row join pg_class relation on relation.oid = constraint_row.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    left join pg_class referenced on referenced.oid = constraint_row.confrelid
    where namespace.nspname = 'public' and constraint_row.conname = any($1::text[])`,
    [expectedConstraints.map(([, name]) => name)]
  );
  for (const [
    table,
    name,
    type,
    referencedTable,
    deleteAction
  ] of expectedConstraints) {
    const row = constraints.rows.find(
      (constraint) => constraint.conname === name
    );
    if (
      !row ||
      row.table_name !== table ||
      row.contype !== type ||
      !row.convalidated ||
      (type === "f" &&
        (row.referenced_table !== referencedTable ||
          row.confdeltype !== deleteAction))
    ) {
      throw new Error(
        `Latest migration constraint ${name} is missing or incorrect: ${JSON.stringify(row)}`
      );
    }
  }
  const indexes =
    await pool.query(`select indexname from pg_indexes where schemaname = 'public'
    and indexname in ('remote_mcp_oauth_credentials_grant_idx', 'remote_mcp_oauth_grants_user_idx')`);
  if (indexes.rows.length !== 2)
    throw new Error("Latest OAuth lookup indexes are missing");
};

const assertCurrentSchema = async (pool) => {
  await assertSchemaContracts(pool);
  const result = await pool.query(
    `
      select
        to_regclass('public.users')::text as users_table,
        to_regclass('public.collaboration_threads')::text as collaboration_threads_table,
        to_regclass('public.collaboration_messages')::text as collaboration_messages_table,
        to_regclass('public.conversation_source_artifacts')::text as source_artifacts_table,
        to_regclass('public.conversation_source_segments')::text as source_segments_table,
        to_regclass('public.conversation_source_consumer_cursors')::text as source_cursors_table,
        to_regclass('public.workspaces')::text as removed_personal_workspaces_table,
        to_regclass('drizzle.__drizzle_migrations')::text as migrations_table,
        to_regclass('public.team_chat_threads')::text as discarded_team_chat_table,
        to_regprocedure('public.notify_koed_graph_update()')::text
          as graph_notify_function,
        to_regprocedure('public.pds_session_recall_ready(uuid)')::text
          as pds_recall_function,
        (
          select count(*)::int
          from information_schema.columns
          where table_schema = 'public'
            and column_name in ('source_path', 'codex_transcript_path')
        ) as removed_path_columns,
        (
          select count(*)::int
          from pg_trigger
          where not tgisinternal
            and tgname in (
              'collaboration_threads_participant_set_check',
              'collaboration_threads_participant_identity_check',
              'collaboration_participants_set_check'
            )
        ) as collaboration_participant_triggers
        ,
        (
          select count(*)::int
          from pg_trigger
          where not tgisinternal
            and tgname in (
              'pds_personal_sync_policy_enabled_at',
              'pds_session_closure_immutable',
              'pds_conversation_item_read_only',
              'pds_replica_session_read_only',
              'bind_direct_share_reason',
              'bind_direct_reason_publication'
            )
        ) as pds_guard_triggers,
        (
          select count(*)::int
          from pg_trigger
          where not tgisinternal
            and tgname in (
              'retention_policy_shortening_preview_transition',
              'retention_policy_shortening_scope_immutable',
              'retention_policy_shortening_migration_immutable',
              'retention_policy_shortening_preview_aggregate',
              'retention_policy_shortening_scope_aggregate',
              'retention_policy_shortening_migration_aggregate'
            )
        ) as retention_policy_triggers
    `
  );
  const row = result.rows[0];
  if (
    row?.users_table !== "users" ||
    row?.collaboration_threads_table !== "collaboration_threads" ||
    row?.collaboration_messages_table !== "collaboration_messages" ||
    row?.source_artifacts_table !== "conversation_source_artifacts" ||
    row?.source_segments_table !== "conversation_source_segments" ||
    row?.source_cursors_table !== "conversation_source_consumer_cursors" ||
    row?.removed_personal_workspaces_table !== null ||
    row?.migrations_table !== "drizzle.__drizzle_migrations" ||
    row?.discarded_team_chat_table !== null ||
    row?.graph_notify_function !== "notify_koed_graph_update()" ||
    row?.pds_recall_function !== "pds_session_recall_ready(uuid)" ||
    row?.removed_path_columns !== 0 ||
    row?.collaboration_participant_triggers !== 3 ||
    row?.pds_guard_triggers !== 6 ||
    row?.retention_policy_triggers !== 6
  ) {
    throw new Error(
      `Current migration schema assertion failed: ${JSON.stringify(row)}`
    );
  }
};

// Dumps preserve logical order, but compact dropped-column gaps and fractional enum slots.
const schemaFingerprint = async (pool) => {
  const [columns, constraints, indexes, triggers, enums] = await Promise.all([
    pool.query(
      `select table_name, row_number() over (partition by table_name order by ordinal_position)::int as ordinal_position, column_name, data_type, udt_name,
              is_nullable, coalesce(column_default, '') as column_default
         from information_schema.columns
        where table_schema = 'public'
        order by table_name, ordinal_position`
    ),
    pool.query(
      `select c.conname, c.contype, pg_get_constraintdef(c.oid, true) as definition
         from pg_constraint c
         join pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'public'
        order by c.conname`
    ),
    pool.query(
      `select tablename, indexname, indexdef
         from pg_indexes
        where schemaname = 'public'
        order by tablename, indexname`
    ),
    pool.query(
      `select c.relname as table_name, t.tgname,
              pg_get_triggerdef(t.oid, true) as definition
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and not t.tgisinternal
        order by c.relname, t.tgname`
    ),
    pool.query(
      `select t.typname, row_number() over (partition by t.typname order by e.enumsortorder)::int as enumsortorder, e.enumlabel
         from pg_type t
         join pg_enum e on e.enumtypid = t.oid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public'
        order by t.typname, e.enumsortorder`
    )
  ]);
  return sha256(
    JSON.stringify(
      [columns, constraints, indexes, triggers, enums].map(
        (result) => result.rows
      )
    )
  );
};

const seedCurrentFixture = async (pool, ownerUserId) => {
  let ownerId = ownerUserId;
  if (!ownerId) {
    ownerId = randomUUID();
    await pool.query(
      "insert into users (id, email, display_name) values ($1, $2, $3)",
      [ownerId, `stable-${ownerId}@example.test`, "Stable migration owner"]
    );
  }
  const teamId = randomUUID();
  const membershipId = randomUUID();
  const workspaceId = randomUUID();
  await pool.query("insert into teams (id, name) values ($1, $2)", [
    teamId,
    "Migration Acceptance Team"
  ]);
  await pool.query(
    `insert into team_memberships (id, team_id, user_id, role, status)
     values ($1, $2, $3, 'owner', 'enabled')`,
    [membershipId, teamId, ownerId]
  );
  await pool.query(
    "insert into team_workspaces (id, team_id, name) values ($1, $2, $3)",
    [workspaceId, teamId, "Migration Acceptance Workspace"]
  );
  await pool.query(
    `insert into team_workspace_access_grants
       (team_workspace_id, team_id, user_id, access, granted_by_user_id)
     values ($1, $2, $3, 'write', $3)`,
    [workspaceId, teamId, ownerId]
  );
  return { ownerId, teamId, membershipId, workspaceId };
};

const runPostgresTool = (command, args, connectionString) =>
  new Promise((resolvePromise, reject) => {
    const connection = new URL(connectionString);
    const postgresEnvironment = {
      PGHOST: connection.hostname,
      PGPORT: connection.port || "5432",
      PGUSER: decodeURIComponent(connection.username),
      PGPASSWORD: decodeURIComponent(connection.password),
      PGDATABASE: decodeURIComponent(connection.pathname.slice(1))
    };
    const sslMode = connection.searchParams.get("sslmode");
    if (sslMode) {
      postgresEnvironment.PGSSLMODE = sslMode;
    }
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...postgresEnvironment },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(
        new Error(`${command} could not start: ${error.message}`, {
          cause: error
        })
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(
          new Error(
            `${command} failed closed with exit ${code}: ${stderr.trim()}`
          )
        );
      }
    });
  });

const waitForInterruptProbe = async (
  admin,
  database,
  applicationName,
  marker
) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await admin.query(
      `select pid
         from pg_stat_activity
        where datname = $1
          and application_name = $2
          and state = 'active'
          and query like $3`,
      [database, applicationName, `%${marker}%`]
    );
    if (result.rows[0]?.pid) {
      return result.rows[0].pid;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Timed out waiting for interrupted migration probe");
};

const scenarioDatabaseName = (scenario) => {
  const suffix = scenario.replaceAll(/[^a-zA-Z0-9_]/g, "_");
  const digest = sha256(`${targetDatabase}:${scenario}`).slice(0, 8);
  return `${targetDatabase.slice(0, 42)}_${suffix.slice(0, 10)}_${digest}`;
};

const admin = new Client({
  connectionString: withDatabase(databaseUrl, adminDatabase)
});
await admin.connect();
const scratchDir = resolve(rootDir, "scratch");
await mkdir(scratchDir, { recursive: true });

const disposableDatabases = new Set();
const results = [];
const temporaryFolders = new Set();

const createDisposableDatabase = async (scenario) => {
  const database = scenarioDatabaseName(scenario);
  if (
    database === adminDatabase ||
    database === new URL(databaseUrl).pathname.slice(1)
  ) {
    throw new Error(`Refusing to use non-disposable database ${database}`);
  }
  await admin.query(`create database ${quoteIdentifier(database)}`);
  disposableDatabases.add(database);
  return { database, url: withDatabase(databaseUrl, database) };
};

const withPool = async (url, callback, options = {}) => {
  const pool = new Pool({ connectionString: url, ...options });
  pool.on("error", (error) => {
    if (!isPostgresAdminTermination(error)) {
      console.error(error);
    }
  });
  try {
    return await callback(pool);
  } finally {
    await pool.end();
  }
};

const runScenario = async (name, callback) => {
  const startedAt = Date.now();
  await callback();
  const result = { name, status: "passed", durationMs: Date.now() - startedAt };
  results.push(result);
  console.error(
    `[migration-acceptance] ${name}: passed (${result.durationMs}ms)`
  );
};

// --current-schema-only remains accepted for existing callers; it is now the default.
const dataFingerprint = async (pool) => {
  const tables = await pool.query(
    "select tablename from pg_tables where schemaname='public' order by tablename"
  );
  const contents = [];
  for (const { tablename } of tables.rows) {
    const rows = await pool.query(
      `select to_jsonb(row) as value from ${quoteIdentifier(tablename)} row order by to_jsonb(row)::text`
    );
    contents.push([tablename, rows.rows]);
  }
  return sha256(JSON.stringify(contents));
};

const databaseFingerprint = async (pool) => ({
  schema: await schemaFingerprint(pool),
  data: await dataFingerprint(pool),
  ledger: (
    await pool.query("select * from drizzle.__drizzle_migrations order by id")
  ).rows
});

const assertUnchanged = async (pool, before, description) => {
  const after = await databaseFingerprint(pool);
  const changed = Object.keys(before).filter(
    (key) => !isDeepStrictEqual(after[key], before[key])
  );
  if (changed.length) {
    throw new Error(`${description} changed ${changed.join(", ")}`);
  }
};

try {
  const journal = await loadMigrationJournal();
  const records = await migrationRecords(migrationsFolder, journal.entries);
  const current = await createDisposableDatabase("current_schema");
  await runScenario("clean-current-schema", async () => {
    await withPool(current.url, async (pool) => {
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, records);
      await assertCurrentSchema(pool);
      await seedCurrentFixture(pool);
    });
  });

  await runScenario("concurrent-startup", async () => {
    const target = await createDisposableDatabase("concurrent");
    await withPool(target.url, async (pool) => {
      await Promise.all([runDbMigrations(pool), runDbMigrations(pool)]);
      await assertMigrationLedger(pool, records);
      await assertCurrentSchema(pool);
    });
  });

  await runScenario("idempotent-restart", async () => {
    const before = await withPool(current.url, databaseFingerprint);
    // A new connection pool models a process restart against persisted data.
    await withPool(current.url, async (pool) => {
      await runDbMigrations(pool);
      await assertMigrationLedger(pool, records);
      await assertCurrentSchema(pool);
      await assertUnchanged(pool, before, "Restart");
    });
  });

  const verifyTransactionRecovery = async (interrupt) => {
    const target = await createDisposableDatabase(
      interrupt ? "interrupted" : "failed"
    );
    await withPool(target.url, async (pool) => {
      await runDbMigrations(pool);
      await seedCurrentFixture(pool);
      const before = await databaseFingerprint(pool);
      const folder = await mkdtemp(
        resolve(scratchDir, "migration-transaction-")
      );
      temporaryFolders.add(folder);
      await mkdir(resolve(folder, "meta"));
      for (const record of records)
        await writeFile(resolve(folder, `${record.tag}.sql`), record.sql);
      const probe = {
        idx: journal.entries.length,
        tag: "acceptance_transaction_probe",
        when: journal.entries.at(-1).when + 1,
        breakpoints: true
      };
      const probeJournal = { ...journal, entries: [...journal.entries, probe] };
      await writeFile(
        resolve(folder, "meta/_journal.json"),
        JSON.stringify(probeJournal)
      );
      const mutation =
        "create table migration_acceptance_probe (id integer);\n--> statement-breakpoint\nupdate users set display_name='Uncommitted migration probe';";
      const marker = `koed_interrupt_${randomUUID()}`;
      const failureSql = interrupt
        ? `select pg_sleep(30) /* ${marker} */;`
        : "select koed_deliberate_migration_failure();";
      await writeFile(
        resolve(folder, `${probe.tag}.sql`),
        `${mutation}\n--> statement-breakpoint\n${failureSql}`
      );
      const applicationName = `koed-migration-probe-${randomUUID()}`;
      await withPool(
        target.url,
        async (probePool) => {
          const result = runDbMigrations(probePool, {
            migrationsFolder: folder
          }).then(
            () => null,
            (error) => error
          );
          if (interrupt) {
            const pid = await waitForInterruptProbe(
              admin,
              target.database,
              applicationName,
              marker
            );
            const cancelled = await admin.query(
              "select pg_cancel_backend($1) as cancelled",
              [pid]
            );
            if (!cancelled.rows[0]?.cancelled)
              throw new Error("Postgres refused migration cancellation");
          }
          const failure = await result;
          if (!failure)
            throw new Error("Failing migration unexpectedly committed");
          let cause = failure;
          while (cause.cause) cause = cause.cause;
          const expectedCode = interrupt ? "57014" : "42883";
          if (cause.code !== expectedCode) throw failure;
        },
        { application_name: applicationName, max: 1 }
      );
      await assertUnchanged(pool, before, "Failed transaction");
      await assertMigrationLedger(pool, records);
      await writeFile(resolve(folder, `${probe.tag}.sql`), mutation);
      await runDbMigrations(pool, { migrationsFolder: folder });
      await assertMigrationLedger(
        pool,
        await migrationRecords(folder, probeJournal.entries)
      );
      await assertCurrentSchema(pool);
      const created = await pool.query(
        "select to_regclass('public.migration_acceptance_probe')::text as name"
      );
      const changed = await pool.query(
        "select count(*)::int as count from users where display_name='Uncommitted migration probe'"
      );
      if (!created.rows[0]?.name || changed.rows[0]?.count !== 1)
        throw new Error(
          "Transaction retry did not commit the complete migration"
        );
    });
  };
  await runScenario("failed-transaction-recovery", () =>
    verifyTransactionRecovery(false)
  );
  await runScenario("interrupted-transaction-recovery", () =>
    verifyTransactionRecovery(true)
  );

  await runScenario("current-schema-backup-restore", async () => {
    const before = await withPool(current.url, databaseFingerprint);
    const folder = await mkdtemp(resolve(scratchDir, "migration-backup-"));
    temporaryFolders.add(folder);
    const backup = resolve(folder, "current.dump");
    await runPostgresTool(
      process.env.PG_DUMP_BIN ?? "pg_dump",
      ["--format=custom", "--no-owner", "--no-privileges", "--file", backup],
      current.url
    );
    const restored = await createDisposableDatabase("restored");
    await runPostgresTool(
      process.env.PG_RESTORE_BIN ?? "pg_restore",
      [
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
        "--dbname",
        restored.database,
        backup
      ],
      restored.url
    );
    await withPool(restored.url, async (pool) => {
      await assertMigrationLedger(pool, records);
      await assertCurrentSchema(pool);
      await assertUnchanged(pool, before, "Backup restoration");
      await runDbMigrations(pool);
      await assertUnchanged(pool, before, "Restored restart");
    });
  });

  console.log(
    JSON.stringify(
      {
        status: "passed",
        scope: "current-schema",
        migrations: records.length,
        latestTag: journal.entries.at(-1).tag,
        scenarios: results
      },
      null,
      2
    )
  );
} finally {
  try {
    for (const database of disposableDatabases)
      await admin.query(
        `drop database if exists ${quoteIdentifier(database)} with (force)`
      );
  } finally {
    await admin.end();
    for (const folder of temporaryFolders)
      await rm(folder, { recursive: true, force: true });
  }
}
