# Hosted Database Roles And RLS Decision

Hosted, private VPS, and Team Self-Hosted deployments should use separate
Postgres roles for schema migration and normal runtime traffic. This reduces
blast radius if an API, Worker, or diagnostic path is compromised.

## Role Model

Use two roles:

- `koed_migrator`: runs Drizzle migrations, owns schema changes, and can create
  required extensions.
- `koed_runtime`: used by `koed-server`, API, Worker, queue processing,
  operator diagnostics, and hosted smoke/capacity checks.

The runtime role should have:

- `CONNECT` to the Koed database.
- `USAGE` on the application schema.
- `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on Koed tables.
- sequence usage needed for inserts.
- execute permission on application functions if migrations add any.

The runtime role must not have:

- `CREATE` on the database.
- `CREATE` on the application schema.
- schema ownership.
- table, sequence, extension, or type ownership.
- extension creation privileges.
- `BYPASSRLS`.

`pgvector` and `pgcrypto` should be installed by the migration role or a
database administrator. The runtime role only uses the resulting tables,
indexes, and operators through normal DML queries.

## Operator Commands

Generate the SQL plan:

```bash
pnpm hosted:db-roles -- plan \
  --database koed \
  --schema public \
  --migration-role koed_migrator \
  --runtime-role koed_runtime
```

Run the generated SQL as the database owner or an administrator. Store role
passwords or managed credential bindings outside source-controlled config.

Run migrations with the migration role:

```bash
DATABASE_URL=postgres://koed_migrator:<password>@127.0.0.1:5432/koed \
  pnpm --filter @koed/db migrate:up
```

Run `koed-server` with the runtime role:

```bash
DATABASE_URL=postgres://koed_runtime:<password>@127.0.0.1:5432/koed
```

Check the runtime role:

```bash
DATABASE_URL=postgres://koed_runtime:<password>@127.0.0.1:5432/koed \
  pnpm hosted:db-roles -- check --json
```

The check fails if the runtime role can create database/schema objects, owns
application relations, lacks expected DML privileges, or cannot see required
extensions.

## RLS Decision

Do not add broad Row Level Security in this launch slice.

RLS can add defense in depth for high-value memory tables, but only after the
runtime role is separated and repository authorization remains proven. Koed
authorization currently depends on application predicates that combine Personal
Memory ownership, Team Membership, Workspace Access, Share Grants, lifecycle
state, entitlement gates, and retained Team-visible knowledge. Encoding that
whole resolver in RLS policies too early would create a second authorization
implementation that can drift from the repository layer.

The launch position is:

- repository predicates and API authorization remain authoritative.
- database roles reduce schema/extension mutation blast radius.
- RLS is deferred to a focused spike on read-heavy memory tables.
- any future RLS policy must be additive defense in depth, never a replacement
  for repository predicates.

Good first RLS candidates remain `memory_events`, `memory_nodes`, `messages`,
`memory_questions`, and `capture_policies`. Derived tables such as
`memory_node_sources`, `memory_embeddings`, and vector partitions need extra
care because visibility depends on linked source rows and retained Team
knowledge.

## Validation

After applying role hardening:

1. Run migrations as `koed_migrator`.
2. Run `pnpm hosted:db-roles -- check --json` as `koed_runtime`.
3. Start `koed-server` with the runtime `DATABASE_URL`.
4. Run `pnpm team-fixture:seed` against a disposable validation database using
   the hardened role setup.
5. Run `pnpm team-launch:validate`.
6. Confirm authorized Team-visible recall works and private/revoked/removed
   member boundaries still fail closed.

The fixture and launch validation are the repository-authorization proof. They
must pass after role hardening before a private VPS or hosted deployment is used
for real memory.
