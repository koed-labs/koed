# Database Row-Boundary Safeguards

This note records the KOE-127 review of database-level safeguards for Koed
Koed memory storage. It is an implementation plan, not an accepted ADR.

## Current State

The API and worker connect to Postgres with the same role used by Docker
Compose migrations. Row boundaries are enforced in repository SQL predicates
and application authorization checks.

There is no PostgreSQL Row Level Security policy, narrow runtime database role,
or per-request database session variable today.

The highest-risk tables are the tables that store memory payloads or derived
memory evidence:

- `memory_events`
- `memory_nodes`
- `memory_node_sources`
- `memory_embeddings`
- `memory_embeddings_384`
- `memory_embeddings_1024`
- `memory_embeddings_1536`
- `memory_embeddings_3072`
- `messages`
- `tool_events`
- `sessions`
- `workspaces`
- `memory_questions`
- `capture_policies`
- `api_tokens`

## Recommendation

Use a staged approach:

1. Keep repository-only access as the immediate boundary.
2. Add a dedicated runtime database role before adding RLS.
3. Spike RLS on read-heavy memory tables after the runtime role exists.

This keeps local development and migration ergonomics simple while reducing the
blast radius of accidental broad SQL in runtime code.

## Runtime Role Proposal

Create separate database roles:

- Migration role: owns schema changes and can run migrations.
- Runtime role: used by API and worker in `DATABASE_URL`.

The runtime role should have only the permissions needed by repository methods:

- `select`, `insert`, `update`, and limited `delete` only where runtime code
  genuinely deletes rows.
- sequence and type usage as required by migrations.
- no schema ownership.
- no permission to alter tables, create extensions, or bypass RLS.

Docker Compose can preserve local ergonomics by continuing to create the
database with the existing Postgres superuser and then granting runtime
permissions during migration startup.

## RLS Fit

PostgreSQL RLS is a good fit for high-value read boundaries, but it should not
be added as a broad migration without a spike. Koed queries currently need
personal owner checks based on `owner_user_id`. RLS policies would need
request-scoped settings such as:

```sql
set local app.user_id = '<user uuid>';
```

The repository would need a transaction wrapper for every user-scoped operation
so `current_setting('app.user_id', true)` is reliably set before any query runs.
That is feasible, but it is invasive enough to validate on a small surface
first.

Best first RLS candidates:

- `memory_events`
- `memory_nodes`
- `messages`
- `memory_questions`
- `capture_policies`

Tables that need extra care:

- `memory_node_sources`: visibility depends on the linked source row and the
  visible memory node.
- `memory_embeddings`: visibility depends on the linked memory event, memory
  node, or message.
- vector partition tables: enforcement likely belongs through
  `memory_embeddings`, not duplicated vector-table policies.

## Spike Plan

1. Add runtime and migration role support to Docker Compose behind new
   environment variables.
2. Update startup docs so local development can still use the simple single-role
   path, while production can opt into separate roles.
3. Introduce a repository transaction helper that sets `app.user_id` with
   `set local`.
4. Add RLS policies for `memory_nodes` and `memory_events` only.
5. Run existing graph, search, export, expansion, update, delete, and embedding
   tests with RLS enabled.
6. Measure query plans for graph and retrieval hot paths before broadening RLS.
7. Extend policies to derived tables only after the first two tables are stable.

## Non-Goals

- Do not make RLS the only authorization layer. Repository predicates and API
  checks should remain readable and testable.
- Do not add multi-user memory access as part of this work.
- Do not add backend LLM or synthesis behavior as part of this work.

## Acceptance Criteria For The Spike

- Runtime code can run without schema-owner privileges.
- User-scoped memory reads fail closed when `app.user_id` is missing.
- Personal Memory visibility tests pass with RLS enabled.
- Migration commands still work in local Docker Compose.
- Operators have clear upgrade and rollback guidance.
