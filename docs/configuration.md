# Configuration

Use `.env.example` as the canonical self-hosted environment example. It is the starting point for local and production deployments.

For a local deployment, run:

```bash
pnpm setup:env
```

This creates `.env` and generates `API_DATA_ENCRYPTION_KEY` and
`API_TOKEN_PEPPER`. If `.env` already exists, the command leaves it unchanged.

## Required Deployment Values

- `POSTGRES_DB`: Postgres database name used by Docker Compose.
- `POSTGRES_USER`: Postgres user used by Docker Compose.
- `POSTGRES_PASSWORD`: Postgres password. Use a deployment-specific secret.
- `POSTGRES_HOST_PORT`: host port mapped to the Postgres container.
- `API_NODE_ENV`: runtime environment for the API service. Use `production` for deployed compose runs.
- `API_HOST`: bind host inside the API container.
- `API_PORT`: API port inside the API container.
- `API_HOST_PORT`: host port mapped to the API container.
- `API_LOG_LEVEL`: API log level.
- `API_DATA_ENCRYPTION_KEY`: base64 32-byte key for encrypted server-side data.
- `API_TOKEN_PEPPER`: server-side pepper used when hashing API Tokens.
- `API_CORS_ORIGINS`: comma-separated allowed Operator Console origins.
- `API_REQUEST_BODY_LIMIT_BYTES`: maximum API request body size.
- `API_AUTH_RATE_LIMIT_WINDOW_MS`: auth rate-limit window.
- `API_AUTH_RATE_LIMIT_MAX`: auth requests allowed per window.
- `API_MEMORY_RATE_LIMIT_WINDOW_MS`: API-token memory rate-limit window.
- `API_MEMORY_RATE_LIMIT_MAX`: API-token memory requests allowed per window.
- `API_COOKIE_SECURE`: set `true` behind HTTPS; local HTTP development may use `false`.
- `CONSOLE_NODE_ENV`: runtime environment for the Operator Console service.
- `CONSOLE_PORT`: Operator Console port inside the container.
- `CONSOLE_HOST_PORT`: host port mapped to the Operator Console container.
- `CONSOLE_API_BASE_URL`: browser-visible API base URL used when building the Operator Console.
- `WORKER_NODE_ENV`: runtime environment for the worker service.
- `MEMORY_VECTOR_CANDIDATE_LIMIT`: vector retrieval candidate count.
- `MEMORY_RERANKING_ENABLED`: enables local reranking when the embedding service supports it.
- `MEMORY_LCM_LEAF_EVENT_THRESHOLD`: event count threshold for creating LCM placeholders.
- `MEMORY_LCM_LEAF_TOKEN_THRESHOLD`: token threshold for creating LCM placeholders.
- `MEMORY_LCM_FRESH_EVENT_TAIL`: recent event tail excluded from LCM placeholder creation.
- `MEMORY_LCM_DEPTH1_FANOUT`: fanout for depth-1 LCM placeholder creation.
- `EMBEDDING_MODEL_REPO`: Hugging Face repository for the local embedding model.
- `EMBEDDING_MODEL_FILE`: model file loaded by the embedding service.
- `EMBEDDING_MODEL_NAME`: model name reported in retrieval metadata.
- `EMBEDDING_DIMENSIONS`: embedding vector dimensions expected by API, worker, and database.
- `EMBEDDING_VERSION`: embedding version string stored with generated vectors.
- `EMBEDDING_BATCH_LIMIT`: embedding service batch limit.
- `EMBEDDING_MAX_TOKENS`: maximum tokens per embedding request.
- `EMBEDDING_LLAMA_N_CTX`: llama.cpp context size for the embedding service.
- `EMBEDDING_RERANKER_ENABLED`: enables the embedding-service reranker.
- `EMBEDDING_RERANKER_MODEL`: reranker model loaded by the embedding service.
- `EMBEDDING_RERANKER_BATCH_LIMIT`: reranker batch limit.

## AI Client Values

These values are copied into the AI Client configuration and are not consumed automatically by Docker Compose:

- `MEMORY_API_URL`: API URL used by the MCP Server and Supported Capture Hook.
- `MEMORY_API_TOKEN`: API Token created in the Operator Console for the User.
- `MEMORY_HOOK_STRICT`: when `true`, Capture Hook failures exit non-zero.
- `MEMORY_HOOK_MAX_ITEMS`: maximum transcript items processed by the Capture Hook per run.
- `MEMORY_HOOK_TRIGGER_LCM_SUMMARY`: when `true`, the Capture Hook starts local LCM summary processing after capture.
- `MEMORY_HOOK_LCM_SUMMARY_DELAY_MS`: delay before Capture Hook-triggered LCM summary processing.
- `MEMORY_HOOK_LCM_SUMMARY_LIMIT`: maximum pending LCM summaries processed from a Capture Hook trigger.
- `MEMORY_LCM_BACKGROUND_INITIAL_DELAY_MS`: delay before the MCP-local LCM Summary Service first checks for pending summaries.
- `MEMORY_LCM_BACKGROUND_PUSH_DELAY_MS`: delay used when the local service is nudged after capture.
- `MEMORY_LCM_BACKGROUND_INTERVAL_MS`: periodic background check interval for pending summaries.
- `MEMORY_LCM_BACKGROUND_BATCH_LIMIT`: maximum pending LCM summaries processed in one background batch.

Koed Self-Hosted relies on the connected AI Client for Synthesis; backend LLM provider configuration and server-side synthesis are unsupported in this build.
The MCP-local LCM Summary Service is enabled by default in this build. Failures are reported as diagnostics and pending summaries remain searchable as degraded evidence.

Capture Policy state `ask` currently blocks automatic capture. It is reserved
for a future AI-client approval flow and is not an implemented backend prompt.
