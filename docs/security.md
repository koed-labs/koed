# Security

For responsible disclosure, supported versions, and vulnerability reporting,
see [../SECURITY.md](../SECURITY.md). Do not disclose captured Memory data,
database exports, backups, API Tokens, cookies, or private deployment secrets in
public reports.

Koed uses local operator token bootstrap for AI-client access. `pnpm api-token:create` creates a passwordless local owner user when needed, creates a bearer API token for that user, stores only the token hash and prefix, and prints the full token once.

Operators list and revoke local tokens with `pnpm api-token:list` and `pnpm api-token:revoke`. Browser session registration is disabled by default in deployed environments; use local operator scripts from the deployment checkout instead.

AI-client integrations use bearer API tokens. Store generated API tokens immediately; only token prefixes are listed later.

Do not expose Postgres or Redis publicly. The Docker Compose starter is for
local source-checkout dependencies; do not run it on a public host without
binding dependency ports to localhost or restricting them with a firewall. Use
TLS when the API or Explorer are accessible outside localhost.

Public health probes are intentionally coarse. `/health` and `/ready` do not expose local paths, model details, dependency exception messages, or secret values.

Diagnostics are redacted by design: they report whether secrets are configured, but not their values. Detailed diagnostic endpoints are not intended for public reverse-proxy exposure.

The embedding service is an internal backend component. Keep it off public networks. Docker Compose passes `EMBEDDING_SERVICE_TOKEN` to the embedding service, API, and worker so embedding and reranking requests require a shared internal header.

## Data At Rest

Postgres is the source of truth for memory data. API Tokens are hashed before storage, but captured Memory Events, Memory Nodes, LCM source evidence and summaries, graph text, and embedding metadata are stored plaintext at the application layer in the current build.

Use deployment controls for data-at-rest protection: private database networking, least-privilege database credentials, encrypted volumes or managed-database storage encryption, encrypted backups, and restricted administrator access. Treat database exports and backups as sensitive memory material.

Database role and row-boundary hardening is tracked in
[database-row-boundary-safeguards.md](database-row-boundary-safeguards.md).
Hosted Team tenant isolation and support-access constraints are tracked in
[hosted-tenant-isolation-checklist.md](hosted-tenant-isolation-checklist.md).
