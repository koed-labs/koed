# Configuration

Use `.env.example` as the canonical self-hosted environment example. It is the starting point for local and production deployments.

For a local deployment, run:

```bash
pnpm setup:env
```

This creates `.env` and generates `API_DATA_ENCRYPTION_KEY`,
`API_TOKEN_PEPPER`, and `EMBEDDING_SERVICE_TOKEN`. If `.env` already exists,
the command preserves existing values and adds any missing keys from
`.env.example`.

## Required Deployment Values

- `POSTGRES_DB`: Postgres database name used by Docker Compose.
- `POSTGRES_USER`: Postgres user used by Docker Compose.
- `POSTGRES_PASSWORD`: Postgres password. Use a deployment-specific secret.
- `POSTGRES_HOST_PORT`: host port mapped to the Postgres container.
- `API_NODE_ENV`: runtime environment for the API service. Use `production` for deployed compose runs.
- `API_HOST`: bind host inside the API container.
- `API_PORT`: API port inside the API container.
- `API_HOST_PORT`: host port mapped to the API container.
- `API_LOG_LEVEL`: API log level. See [observability](observability.md) for
  the structured API log schema and redaction rules.
- `API_DATA_ENCRYPTION_KEY`: reserved base64 32-byte key for encrypted server-side fields. In the current self-hosted build, Memory Events, Memory Nodes, LCM source evidence and summaries, and embedding metadata remain plaintext at the application layer in Postgres.
- `API_TOKEN_PEPPER`: server-side pepper used when hashing API Tokens.
- `API_CORS_ORIGINS`: comma-separated allowed Operator Console origins.
- `API_REQUEST_BODY_LIMIT_BYTES`: maximum API request body size. Default `4194304`.
- `API_AUTH_RATE_LIMIT_WINDOW_MS`: auth rate-limit window.
- `API_AUTH_RATE_LIMIT_MAX`: auth requests allowed per window.
- `API_MEMORY_RATE_LIMIT_WINDOW_MS`: fallback API-token memory rate-limit window. The default window is 60 seconds.
- `API_MEMORY_RATE_LIMIT_MAX`: fallback API-token memory requests allowed per window. The default is 1000 requests per 60-second window, which is intended to absorb local History Browser and MCP Server bursts in a self-hosted deployment without changing the stricter auth rate limit.
- `API_MEMORY_READ_RATE_LIMIT_WINDOW_MS`: read-oriented memory endpoint rate-limit window.
- `API_MEMORY_READ_RATE_LIMIT_MAX`: read-oriented memory requests allowed per window. The default is 1000 requests per 60-second window.
- `API_MEMORY_WRITE_RATE_LIMIT_WINDOW_MS`: write-oriented memory endpoint rate-limit window.
- `API_MEMORY_WRITE_RATE_LIMIT_MAX`: write-oriented memory requests allowed per window. The default is 300 requests per 60-second window.
- `API_MEMORY_RECALL_RATE_LIMIT_WINDOW_MS`: recall-oriented memory endpoint rate-limit window.
- `API_MEMORY_RECALL_RATE_LIMIT_MAX`: recall-oriented memory requests allowed per window. The default is 300 requests per 60-second window.
- `API_RATE_LIMIT_STORE`: `memory` by default; set `redis` to share API rate-limit counters across API replicas.
- `API_RATE_LIMIT_REDIS_URL`: optional Redis URL for API rate-limit counters; falls back to `REDIS_URL`.
- `API_CACHE_STORE`: `memory` by default; set `redis` to enable short-lived graph response caching.
- `API_CACHE_REDIS_URL`: optional Redis URL for API cache entries; falls back to `REDIS_URL`.
- `API_GRAPH_CACHE_TTL_SECONDS`: graph overview/thread cache TTL when Redis caching is enabled.
- `API_GRAPH_UPDATE_DEBOUNCE_MS`: debounce window for coalescing graph stream update events.
- `API_MEMORY_EVENT_GRAPH_UPDATE_DEBOUNCE_MS`: shorter debounce window for captured event stream updates that drive the open history thread.
- `API_COOKIE_SECURE`: set `true` behind HTTPS; local HTTP development may use `false`.
- `CONSOLE_NODE_ENV`: runtime environment for the Operator Console service.
- `CONSOLE_PORT`: Operator Console port inside the container.
- `CONSOLE_HOST_PORT`: host port mapped to the Operator Console container.
- `CONSOLE_API_BASE_URL`: browser-visible API base URL used when building the Operator Console.
- `WORKER_NODE_ENV`: runtime environment for the worker service.
- `MEMORY_RAW_PROJECTION_INTERVAL_MS`: worker interval for projecting pending raw `conversation_items` into messages, tool events, Memory Events, and token-usage rows. Default `5000`.
- `MEMORY_RAW_PROJECTION_BATCH_LIMIT`: maximum raw rows projected per actor on each worker catch-up pass. Default `1000`.
- `MEMORY_RAW_PROJECTION_ACTOR_LIMIT`: maximum personal/team actor scopes checked on each worker catch-up pass. Default `10`.
- `MEMORY_VECTOR_CANDIDATE_LIMIT`: vector retrieval candidate count.
- `MEMORY_EVENT_MAX_TOKENS`: maximum tokens per projected semantic Memory Event chunk. Default `32000`; values above `32000` are clamped to the Qwen operational cap.
- `MEMORY_LCM_LEAF_EVENT_THRESHOLD`: event count threshold for creating LCM placeholders. Default `100`.
- `MEMORY_LCM_LEAF_TOKEN_THRESHOLD`: token threshold for creating LCM placeholders. Default `32000`; values above `32000` are clamped to the Qwen operational cap.
- `MEMORY_LCM_FRESH_EVENT_TAIL`: recent event tail excluded from LCM placeholder creation. Default `10`.
- `MEMORY_LCM_DEPTH1_FANOUT`: leaf fanout for depth-1 LCM placeholder creation. Default `20`.
- `EMBEDDING_MODEL_KEY`: supported embedding model key. The embedding service maps this key to an internal supported model definition and fails startup for unknown keys. Default and currently supported key: `qwen3-0.6b`.
- `EMBEDDING_RERANKER_KEY`: supported reranker model key. Leave blank to disable reranking. Currently supported key: `qwen3-reranker-0.6b`.
- `EMBEDDING_SERVICE_TOKEN`: shared internal token required by embedding and reranking endpoints when configured. `pnpm setup:env` generates this for Docker Compose deployments.
- `EMBEDDING_BATCH_LIMIT`: embedding service batch limit.
- `EMBEDDING_MAX_TOKENS`: maximum tokens per embedding request. Default `32000`; values above `32000` are clamped by the embedding service.
- `EMBEDDING_MAX_TEXT_CHARS`: maximum characters accepted for any single embedding or reranking text before model processing.
- `EMBEDDING_MAX_REQUEST_CHARS`: maximum total characters accepted for one embedding or reranking request before model processing.
- `EMBEDDING_LLAMA_N_CTX`: llama.cpp context size for the embedding service. Default `32000`; values above `32000` are clamped by the embedding service.
- `EMBEDDING_RERANKER_BATCH_LIMIT`: reranker batch limit.

## AI Client Values

These values are copied into the AI Client configuration and are not consumed automatically by Docker Compose:

- `MEMORY_API_URL`: API URL used by the MCP Server and Supported Capture Hook.
- `MEMORY_API_TOKEN`: API Token created in the Operator Console for the User.
- `MEMORY_HOOK_STRICT`: when `true`, Capture Hook failures exit non-zero.
- `MEMORY_RAW_INGEST_BATCH_BYTES`: target maximum request size for Capture Hook raw-ingestion batches. Default `180000`.
- `MEMORY_API_REQUEST_TIMEOUT_MS`: timeout for local MCP and Capture Hook API calls. Default `4000`.
- `MEMORY_HOOK_DEADLINE_MS`: soft deadline used by Capture Hooks to stop optional work before Codex kills the hook process. Default `8500`.
- `MEMORY_HOOK_TRANSCRIPT_TAIL_BYTES`: maximum appended Codex transcript bytes inspected by PostToolUse, Stop, and SubagentStop hooks per run. The hook checkpoints transcript offsets and resumes unread bytes on the next invocation. Default `1000000`.
- `MEMORY_EXPOSE_DIAGNOSTIC_MEMORY_TOOLS`: when `true`, exposes diagnostic MCP tools such as `memory_access_check`. Default `false`; use the MCP `doctor` CLI command for normal setup checks.
- `MEMORY_EXPOSE_LOW_LEVEL_MEMORY_TOOLS`: when `true`, exposes low-level diagnostic MCP retrieval tools such as `memory_search` and `memory_expand`. Default `false`; normal recall should use `memory_answer`.
- `MEMORY_HOOK_TRIGGER_LCM_SUMMARY`: when `true`, the Capture Hook starts local LCM summary processing after capture.
- `MEMORY_HOOK_LCM_SUMMARY_DELAY_MS`: delay before Capture Hook-triggered LCM summary processing.
- `MEMORY_HOOK_LCM_SUMMARY_LIMIT`: maximum pending LCM summaries processed from a Capture Hook trigger.
- `MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS`: maximum prompt budget for local Codex LCM summary calls. Default `48000`.
- `MEMORY_LCM_BACKGROUND_INITIAL_DELAY_MS`: delay before the MCP-local LCM Summary Service first checks for pending summaries.
- `MEMORY_LCM_BACKGROUND_PUSH_DELAY_MS`: delay used when the local service is nudged after capture.
- `MEMORY_LCM_BACKGROUND_INTERVAL_MS`: periodic background check interval for pending summaries.
- `MEMORY_LCM_BACKGROUND_BATCH_LIMIT`: maximum pending LCM summaries processed in one background batch.

Configure Codex to run the Supported Capture Hook for `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SubagentStart`, and `SubagentStop`. The subagent hooks let Koed preserve child conversation identity and parent linkage for thread-spawned Codex subagents.

Koed Self-Hosted relies on the connected AI Client for Synthesis; backend LLM provider configuration and server-side synthesis are unsupported in this build.
The MCP-local LCM Summary Service is enabled by default in this build. Failures are reported as diagnostics and pending summaries remain searchable as degraded evidence.

Capture Policy state `ask` currently blocks automatic capture. It is reserved
for a future AI-client approval flow and is not an implemented backend prompt.

## Data At Rest

Postgres is the source of truth for Users, API Tokens, Capture Policies, Memory Events, Memory Nodes, embeddings, LCM placeholders, LCM summaries, and related evidence. The application hashes API Tokens with `API_TOKEN_PEPPER`, but captured memory content, generated summaries, graph text, and embedding metadata are stored as normal database rows.

Operators should treat the Postgres database and backups as sensitive memory data. Keep Postgres on a private network, restrict database credentials to Koed services and trusted administrators, use encrypted disks or managed-database storage encryption, encrypt backups, and rotate secrets if a backup or database role is exposed.
