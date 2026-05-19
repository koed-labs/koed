# Configuration

Use `.env.example` as the starting point.

Required production values:

- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `API_DATA_ENCRYPTION_KEY`
- `API_TOKEN_PEPPER`
- `API_CORS_ORIGINS`

LLM synthesis:

```text
MEMORY_MODE=codex_subscription
```

Koed Self-Hosted relies on the connected AI client for synthesis. Backend recall returns evidence; the backend does not make server-side LLM calls in this build.

Provider API keys are encrypted at rest with `API_DATA_ENCRYPTION_KEY` where legacy/internal provider configuration still exists. They are never returned by API list endpoints or diagnostics.
