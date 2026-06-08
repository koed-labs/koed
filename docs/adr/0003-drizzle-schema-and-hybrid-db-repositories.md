# Drizzle Schema And Hybrid DB Repositories

Koed uses Drizzle as the source of truth for database schema and migrations, replacing the previous hand-written SQL migration chain. Repository code remains hybrid: table-shaped account, auth, audit, settings, and similarly simple fragments may use Drizzle, while dense graph, vector search, retrieval, LCM, chronology, and projection queries stay as raw SQL because they depend on Postgres-specific ranking, recursion, expression indexes, and careful result shaping that Drizzle would not simplify.

This reset is acceptable for the current dev-only database history and is not a production data-preserving migration path. CI must keep checking Drizzle migration metadata, smoke-test clean migrations, and run real Postgres-backed repository tests so future schema changes do not silently drift from runtime query needs.
