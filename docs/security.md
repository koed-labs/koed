# Security

Koed Self-Hosted uses first-run local admin setup. After a user exists, public registration is disabled unless `KOED_ALLOW_PUBLIC_REGISTRATION=true` is explicitly set.

The console uses an HTTP-only session cookie. AI-client integrations use bearer API tokens. Store generated API tokens immediately; only token prefixes are listed later.

Do not expose Postgres or Redis publicly. In Docker Compose they should remain on internal networks. Use TLS when the console/API are accessible outside localhost.

Public health probes are intentionally coarse. `/health` and `/ready` do not expose local paths, model details, dependency exception messages, or secret values.

Diagnostics are redacted by design: they report whether secrets are configured, but not their values. Detailed diagnostic endpoints are intended for authenticated Operator Console sessions, not public reverse-proxy exposure.
