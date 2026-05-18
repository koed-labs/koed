# Configuration

Use `.env.example` as the starting point.

For a local deployment, run:

```bash
pnpm setup:env
```

This creates `.env` and generates `API_DATA_ENCRYPTION_KEY` and
`API_TOKEN_PEPPER`. If `.env` already exists, the command leaves it unchanged.

Required production values:

- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `API_DATA_ENCRYPTION_KEY`
- `API_TOKEN_PEPPER`
- `API_CORS_ORIGINS`

Recommended default:

```text
MEMORY_MODE=codex_subscription
```

In this mode, backend recall returns evidence and local Codex performs synthesis. Server-side model provider configuration is optional and should only be enabled intentionally.

Provider API keys are encrypted at rest with `API_DATA_ENCRYPTION_KEY`. They are never returned by API list endpoints or diagnostics.
