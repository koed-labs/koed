const defaultOptions = {
  database: "koed",
  schema: "public",
  migrationRole: "koed_migrator",
  runtimeRole: "koed_runtime"
};

export const usage = `Usage:
  pnpm hosted:db-roles -- plan [--database <name>] [--schema <name>] [--migration-role <role>] [--runtime-role <role>]
  pnpm hosted:db-roles -- check [--database-url <url>] [--schema <name>] [--json]

Environment:
  DATABASE_URL  Runtime role database URL for check mode
`;

const assertIdentifier = (value, label) => {
  const trimmed = String(value ?? "").trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(trimmed)) {
    throw new Error(`${label} must be a simple Postgres identifier.`);
  }
  return trimmed;
};

const quoteIdent = (value) => `"${value.replaceAll('"', '""')}"`;

export const parseHostedDbRoleArgs = (argv, env = process.env) => {
  const args = [...argv];
  const separator = args.indexOf("--");
  const effectiveArgs = separator >= 0 ? args.slice(separator + 1) : args;
  const command = effectiveArgs[0];
  if (!command || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  if (command !== "plan" && command !== "check") {
    throw new Error(`Unsupported hosted db roles command: ${command}`);
  }
  const flags = {
    database: defaultOptions.database,
    schema: defaultOptions.schema,
    migrationRole: defaultOptions.migrationRole,
    runtimeRole: defaultOptions.runtimeRole,
    databaseUrl: env.DATABASE_URL,
    json: false
  };
  for (let index = 1; index < effectiveArgs.length; index += 1) {
    const arg = effectiveArgs[index];
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    const valueFlags = new Map([
      ["--database", "database"],
      ["--schema", "schema"],
      ["--migration-role", "migrationRole"],
      ["--runtime-role", "runtimeRole"],
      ["--database-url", "databaseUrl"]
    ]);
    const key = valueFlags.get(arg);
    if (!key) {
      throw new Error(`Unsupported hosted db roles flag: ${arg}`);
    }
    const value = effectiveArgs[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    flags[key] = value;
    index += 1;
  }
  return {
    command,
    database: assertIdentifier(flags.database, "database"),
    schema: assertIdentifier(flags.schema, "schema"),
    migrationRole: assertIdentifier(flags.migrationRole, "migration role"),
    runtimeRole: assertIdentifier(flags.runtimeRole, "runtime role"),
    databaseUrl: flags.databaseUrl,
    json: flags.json
  };
};

export const generateHostedDbRoleSql = ({
  database = defaultOptions.database,
  schema = defaultOptions.schema,
  migrationRole = defaultOptions.migrationRole,
  runtimeRole = defaultOptions.runtimeRole
} = {}) => {
  const db = quoteIdent(assertIdentifier(database, "database"));
  const schemaName = quoteIdent(assertIdentifier(schema, "schema"));
  const migrator = quoteIdent(
    assertIdentifier(migrationRole, "migration role")
  );
  const runtime = quoteIdent(assertIdentifier(runtimeRole, "runtime role"));
  const migratorLiteral = migrationRole.replaceAll("'", "''");
  const runtimeLiteral = runtimeRole.replaceAll("'", "''");

  return `-- Koed hosted database role hardening.
-- Run as a database owner/admin. Set passwords or managed secret bindings outside this file.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = '${migratorLiteral}') then
    create role ${migrator} login;
  end if;
  if not exists (select 1 from pg_roles where rolname = '${runtimeLiteral}') then
    create role ${runtime} login;
  end if;
end
$$;

grant connect on database ${db} to ${migrator}, ${runtime};
grant create on database ${db} to ${migrator};
revoke create on database ${db} from ${runtime};

revoke all on schema ${schemaName} from public;
grant usage, create on schema ${schemaName} to ${migrator};
grant usage on schema ${schemaName} to ${runtime};

-- Run migrations as ${migrator}. After each migration run, refresh runtime DML grants:
grant select, insert, update, delete on all tables in schema ${schemaName} to ${runtime};
grant usage, select, update on all sequences in schema ${schemaName} to ${runtime};
grant execute on all functions in schema ${schemaName} to ${runtime};

alter default privileges for role ${migrator} in schema ${schemaName}
  grant select, insert, update, delete on tables to ${runtime};
alter default privileges for role ${migrator} in schema ${schemaName}
  grant usage, select, update on sequences to ${runtime};
alter default privileges for role ${migrator} in schema ${schemaName}
  grant execute on functions to ${runtime};

-- pgvector and pgcrypto extensions must be installed by the migration role or admin role.
-- The runtime role must not own tables, schemas, or extensions, and must not have CREATE on the database or schema.
`;
};

export const checkHostedRuntimeRole = async ({
  databaseUrl,
  schema = defaultOptions.schema,
  clientFactory
}) => {
  if (!databaseUrl?.trim()) {
    throw new Error(
      "DATABASE_URL or --database-url is required for check mode."
    );
  }
  const makeClient =
    clientFactory ??
    (async () => {
      const pg = await import("pg");
      return new pg.Client({ connectionString: databaseUrl });
    });
  const client = await makeClient();
  await client.connect();
  try {
    const scalar = async (sql, params = []) => {
      const result = await client.query(sql, params);
      return result.rows[0];
    };
    const identity = await scalar(
      `select current_user as "currentUser", current_database() as "database"`
    );
    const privileges = await scalar(
      `select
        has_database_privilege(current_user, current_database(), 'CREATE') as "canCreateDatabase",
        has_schema_privilege(current_user, $1, 'USAGE') as "canUseSchema",
        has_schema_privilege(current_user, $1, 'CREATE') as "canCreateInSchema"`,
      [schema]
    );
    const role = await scalar(
      `select rolbypassrls as "bypassRls"
       from pg_roles
       where rolname = current_user`
    );
    const schemaOwnership = await scalar(
      `select exists (
         select 1
         from pg_namespace
         where nspname = $1
           and pg_get_userbyid(nspowner) = current_user
       ) as "ownsSchema"`,
      [schema]
    );
    const owned = await scalar(
      `select count(*)::int as "ownedRelations"
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1
         and c.relkind in ('r', 'p', 'v', 'm', 'S')
         and pg_get_userbyid(c.relowner) = current_user`,
      [schema]
    );
    const missingTablePrivileges = await scalar(
      `select count(*)::int as "missingTablePrivileges"
       from information_schema.tables
       where table_schema = $1
         and table_type = 'BASE TABLE'
         and not (
           has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'SELECT')
           and has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'INSERT')
           and has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'UPDATE')
           and has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'DELETE')
         )`,
      [schema]
    );
    const missingSequencePrivileges = await scalar(
      `select count(*)::int as "missingSequencePrivileges"
       from information_schema.sequences
       where sequence_schema = $1
         and not (
           has_sequence_privilege(current_user, quote_ident(sequence_schema) || '.' || quote_ident(sequence_name), 'USAGE')
           and has_sequence_privilege(current_user, quote_ident(sequence_schema) || '.' || quote_ident(sequence_name), 'SELECT')
           and has_sequence_privilege(current_user, quote_ident(sequence_schema) || '.' || quote_ident(sequence_name), 'UPDATE')
         )`,
      [schema]
    );
    const extensions = await scalar(
      `select
        bool_or(extname = 'vector') as "pgvectorInstalled",
        bool_or(extname = 'pgcrypto') as "pgcryptoInstalled",
        count(*) filter (where pg_get_userbyid(extowner) = current_user)::int as "ownedExtensions"
       from pg_extension`
    );

    const checks = {
      canCreateDatabase: privileges.canCreateDatabase === true,
      canUseSchema: privileges.canUseSchema === true,
      canCreateInSchema: privileges.canCreateInSchema === true,
      bypassRls: role.bypassRls === true,
      ownsSchema: schemaOwnership.ownsSchema === true,
      ownedRelations: owned.ownedRelations,
      ownedExtensions: extensions.ownedExtensions,
      missingTablePrivileges: missingTablePrivileges.missingTablePrivileges,
      missingSequencePrivileges:
        missingSequencePrivileges.missingSequencePrivileges,
      pgvectorInstalled: extensions.pgvectorInstalled === true,
      pgcryptoInstalled: extensions.pgcryptoInstalled === true
    };
    const ok =
      !checks.canCreateDatabase &&
      checks.canUseSchema &&
      !checks.canCreateInSchema &&
      !checks.bypassRls &&
      !checks.ownsSchema &&
      checks.ownedRelations === 0 &&
      checks.ownedExtensions === 0 &&
      checks.missingTablePrivileges === 0 &&
      checks.missingSequencePrivileges === 0 &&
      checks.pgvectorInstalled &&
      checks.pgcryptoInstalled;

    return {
      ok,
      currentUser: identity.currentUser,
      database: identity.database,
      schema,
      checks,
      message: ok
        ? "Runtime role is least-privilege for hosted Koed checks."
        : "Runtime role failed one or more hosted Koed privilege checks."
    };
  } finally {
    await client.end();
  }
};
