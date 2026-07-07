import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkHostedRuntimeRole,
  generateHostedDbRoleSql,
  parseHostedDbRoleArgs
} from "./hosted-db-roles-lib.mjs";

test("parses hosted db role plan args", () => {
  assert.deepEqual(
    parseHostedDbRoleArgs(
      [
        "plan",
        "--database",
        "koed_prod",
        "--schema",
        "public",
        "--migration-role",
        "koed_migrator",
        "--runtime-role",
        "koed_runtime"
      ],
      {}
    ),
    {
      command: "plan",
      database: "koed_prod",
      schema: "public",
      migrationRole: "koed_migrator",
      runtimeRole: "koed_runtime",
      databaseUrl: undefined,
      json: false
    }
  );
});

test("rejects unsafe hosted db role identifiers", () => {
  assert.throws(
    () => parseHostedDbRoleArgs(["plan", "--runtime-role", "koed;drop"]),
    /runtime role must be a simple Postgres identifier/
  );
});

test("rejects unsupported or incomplete hosted db role flags", () => {
  assert.throws(
    () => parseHostedDbRoleArgs(["plan", "--wat"]),
    /Unsupported hosted db roles flag: --wat/
  );
  assert.throws(
    () => parseHostedDbRoleArgs(["plan", "--schema"]),
    /--schema requires a value/
  );
});

test("generates fail-closed hosted db role SQL", () => {
  const sql = generateHostedDbRoleSql({
    database: "koed",
    schema: "public",
    migrationRole: "koed_migrator",
    runtimeRole: "koed_runtime"
  });

  assert.match(sql, /create role "koed_migrator" login/);
  assert.match(sql, /create role "koed_runtime" login/);
  assert.match(sql, /grant create on database "koed" to "koed_migrator"/);
  assert.match(sql, /revoke create on database "koed" from "koed_runtime"/);
  assert.match(sql, /revoke all on schema "public" from public/);
  assert.match(sql, /grant usage on schema "public" to "koed_runtime"/);
  assert.match(
    sql,
    /grant select, insert, update, delete on all tables in schema "public" to "koed_runtime"/
  );
});

test("checks hosted runtime role privileges", async () => {
  const queries = [];
  const client = {
    async connect() {},
    async end() {},
    async query(sql) {
      queries.push(sql);
      if (sql.includes("has_database_privilege")) {
        return {
          rows: [
            {
              canCreateDatabase: false,
              canUseSchema: true,
              canCreateInSchema: false
            }
          ]
        };
      }
      if (sql.includes("rolbypassrls")) {
        return { rows: [{ bypassRls: false }] };
      }
      if (sql.includes("ownsSchema")) {
        return { rows: [{ ownsSchema: false }] };
      }
      if (sql.includes("ownedRelations")) {
        return { rows: [{ ownedRelations: 0 }] };
      }
      if (sql.includes("missingTablePrivileges")) {
        return { rows: [{ missingTablePrivileges: 0 }] };
      }
      if (sql.includes("missingSequencePrivileges")) {
        return { rows: [{ missingSequencePrivileges: 0 }] };
      }
      if (sql.includes("pg_extension")) {
        return {
          rows: [
            {
              pgvectorInstalled: true,
              pgcryptoInstalled: true,
              ownedExtensions: 0
            }
          ]
        };
      }
      if (sql.includes("current_user")) {
        return { rows: [{ currentUser: "koed_runtime", database: "koed" }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await checkHostedRuntimeRole({
    databaseUrl: "postgres://runtime@localhost/koed",
    clientFactory: async () => client
  });

  assert.equal(result.ok, true);
  assert.equal(result.currentUser, "koed_runtime");
  assert.ok(queries.some((query) => query.includes("pg_extension")));
});

test("fails hosted runtime role check when schema create remains available", async () => {
  const client = {
    async connect() {},
    async end() {},
    async query(sql) {
      if (sql.includes("has_database_privilege")) {
        return {
          rows: [
            {
              canCreateDatabase: false,
              canUseSchema: true,
              canCreateInSchema: true
            }
          ]
        };
      }
      if (sql.includes("rolbypassrls")) {
        return { rows: [{ bypassRls: false }] };
      }
      if (sql.includes("ownsSchema")) {
        return { rows: [{ ownsSchema: false }] };
      }
      if (sql.includes("ownedRelations")) {
        return { rows: [{ ownedRelations: 0 }] };
      }
      if (sql.includes("missingTablePrivileges")) {
        return { rows: [{ missingTablePrivileges: 0 }] };
      }
      if (sql.includes("missingSequencePrivileges")) {
        return { rows: [{ missingSequencePrivileges: 0 }] };
      }
      if (sql.includes("current_user")) {
        return { rows: [{ currentUser: "koed_runtime", database: "koed" }] };
      }
      return {
        rows: [
          {
            pgvectorInstalled: true,
            pgcryptoInstalled: true,
            ownedExtensions: 0
          }
        ]
      };
    }
  };

  const result = await checkHostedRuntimeRole({
    databaseUrl: "postgres://runtime@localhost/koed",
    clientFactory: async () => client
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.canCreateInSchema, true);
});

test("fails hosted runtime role check when runtime can bypass rls", async () => {
  const client = {
    async connect() {},
    async end() {},
    async query(sql) {
      if (sql.includes("has_database_privilege")) {
        return {
          rows: [
            {
              canCreateDatabase: false,
              canUseSchema: true,
              canCreateInSchema: false
            }
          ]
        };
      }
      if (sql.includes("rolbypassrls")) {
        return { rows: [{ bypassRls: true }] };
      }
      if (sql.includes("ownsSchema")) {
        return { rows: [{ ownsSchema: false }] };
      }
      if (sql.includes("ownedRelations")) {
        return { rows: [{ ownedRelations: 0 }] };
      }
      if (sql.includes("missingTablePrivileges")) {
        return { rows: [{ missingTablePrivileges: 0 }] };
      }
      if (sql.includes("missingSequencePrivileges")) {
        return { rows: [{ missingSequencePrivileges: 0 }] };
      }
      if (sql.includes("pg_extension")) {
        return {
          rows: [
            {
              pgvectorInstalled: true,
              pgcryptoInstalled: true,
              ownedExtensions: 0
            }
          ]
        };
      }
      if (sql.includes("current_user")) {
        return { rows: [{ currentUser: "koed_runtime", database: "koed" }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await checkHostedRuntimeRole({
    databaseUrl: "postgres://runtime@localhost/koed",
    clientFactory: async () => client
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.bypassRls, true);
});
