# Security

Koed Self-Hosted uses first-run local admin setup. After a user exists, public registration is disabled unless `KOED_ALLOW_PUBLIC_REGISTRATION=true` is explicitly set.

The console uses an HTTP-only session cookie. AI-client integrations use bearer API tokens. Store generated API tokens immediately; only token prefixes are listed later.

Do not expose Postgres or Redis publicly. In Docker Compose they should remain on internal networks. Use TLS when the console/API are accessible outside localhost.

Public health probes are intentionally coarse. `/health` and `/ready` do not expose local paths, model details, dependency exception messages, or secret values.

Diagnostics are redacted by design: they report whether secrets are configured, but not their values. Detailed diagnostic endpoints are intended for authenticated Operator Console sessions, not public reverse-proxy exposure.

The embedding service is an internal backend component. Keep it off public networks. Docker Compose passes `EMBEDDING_SERVICE_TOKEN` to the embedding service, API, and worker so embedding and reranking requests require a shared internal header.

## Data At Rest

Postgres is the source of truth for memory data. API Tokens are hashed before storage, but captured Memory Events, Memory Nodes, LCM source evidence and summaries, graph text, and embedding metadata are stored plaintext at the application layer in this self-hosted build.

Use deployment controls for data-at-rest protection: private database networking, least-privilege database credentials, encrypted volumes or managed-database storage encryption, encrypted backups, and restricted administrator access. Treat database exports and backups as sensitive memory material.

Database role and row-boundary hardening is tracked in
[database-row-boundary-safeguards.md](database-row-boundary-safeguards.md).
