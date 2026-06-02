# Configuration

Use `.env.example` as the canonical self-hosted environment example. It is the starting point for local and production deployments.

For a local deployment, run:

```bash
pnpm env:setup
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
- `DATABASE_URL`: local Postgres URL used by operator scripts such as `pnpm api-token:create`.
- `API_NODE_ENV`: runtime environment for the API service. Use `production` for deployed compose runs.
- `API_HOST`: bind host inside the API container.
- `API_PORT`: API port inside the API container.
- `API_HOST_PORT`: host port mapped to the API container.
- `API_LOG_LEVEL`: API log level. See [observability](observability.md) for
  the structured API log schema and redaction rules.
- `API_DATA_ENCRYPTION_KEY`: reserved base64 32-byte key for encrypted server-side fields. In the current self-hosted build, Memory Events, Memory Nodes, LCM source evidence and summaries, and embedding metadata remain plaintext at the application layer in Postgres.
- `API_TOKEN_PEPPER`: server-side pepper used when hashing API Tokens.
- `API_CORS_ORIGINS`: comma-separated allowed browser origins, such as the history browser.
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
- `HISTORY_NODE_ENV`: runtime environment for the history browser service.
- `HISTORY_API_BASE_URL`: browser-visible API base URL used when building the history browser.
- `WORKER_NODE_ENV`: runtime environment for the worker service.
- `MEMORY_RAW_PROJECTION_INTERVAL_MS`: worker interval for projecting pending raw `conversation_items` into messages, tool events, Memory Events, and token-usage rows. Default `5000`.
- `MEMORY_RAW_PROJECTION_BATCH_LIMIT`: maximum raw rows projected per actor on each worker catch-up pass. Default `1000`.
- `MEMORY_RAW_PROJECTION_ACTOR_LIMIT`: maximum memory owner scopes checked on each worker catch-up pass. Default `10`.
- `MEMORY_VECTOR_CANDIDATE_LIMIT`: vector retrieval candidate count.
- `MEMORY_EVENT_MAX_TOKENS`: maximum tokens per projected semantic Memory Event chunk. Default `2048`; values above `32000` are clamped to the Qwen operational cap.
- `MEMORY_LCM_LEAF_EVENT_THRESHOLD`: event count threshold for creating LCM placeholders. Default `100`.
- `MEMORY_LCM_LEAF_TOKEN_THRESHOLD`: semantic `memory_event.content` token threshold for creating LCM placeholders. Default `32000`; values above `32000` are clamped to the Qwen operational cap. Provenance payload JSON is not counted.
- `MEMORY_LCM_FRESH_EVENT_TAIL`: recent event tail excluded from LCM placeholder creation. Default `10`.
- `MEMORY_LCM_DEPTH1_FANOUT`: leaf fanout for depth-1 LCM placeholder creation. Default `20`.
- `EMBEDDING_MODEL_KEY`: supported embedding model key. The embedding service maps this key to an internal supported model definition and fails startup for unknown keys. Default and currently supported key: `qwen3-0.6b`.
- `EMBEDDING_RERANKER_KEY`: supported reranker model key. Leave blank to disable reranking. Currently supported key: `qwen3-reranker-0.6b`. Docker Compose maps this root setting to each app's process-local `RERANKER_KEY`; direct app-local runs may set `RERANKER_KEY` explicitly, with the app-local value taking precedence.
- `EMBEDDING_SERVICE_TOKEN`: shared internal token required by embedding and reranking endpoints when configured. `pnpm env:setup` generates this for Docker Compose deployments.
- `EMBEDDING_LOG_LEVEL`: embedding service structured JSON log level. Default `info`; use `debug` for scheduler, chunking, batching, and reranker scoring details.
- `EMBEDDING_BATCH_LIMIT`: embedding service batch limit.
- `EMBEDDING_MAX_TOKENS`: maximum tokens per embedding request. Default `4096`; values above `32000` are clamped by the embedding service and values above the configured llama context are reduced to that context.
- `EMBEDDING_MAX_TEXT_CHARS`: transport and abuse guard for the maximum characters accepted for any single embedding or reranking text before model processing. It is not a semantic chunking limit.
- `EMBEDDING_MAX_REQUEST_CHARS`: transport and abuse guard for the maximum total characters accepted for one embedding or reranking request before model processing. It is not a semantic chunking limit.
- `EMBEDDING_LLAMA_N_CTX`: llama.cpp context size for the embedding service. Default `32000`; values above `32000` are clamped by the embedding service.
- `EMBEDDING_RERANKER_BATCH_LIMIT`: reranker batch limit.

## AI Client Values

These values are copied into the AI Client configuration and are not consumed automatically by Docker Compose:

- `MEMORY_API_URL`: API URL used by the MCP Server and Supported Capture Hook.
- `MEMORY_API_TOKEN`: API Token created with `pnpm api-token:create` for the User. Operators can inspect and revoke local token records with `pnpm api-token:list` and `pnpm api-token:revoke`.
- `MEMORY_HOOK_STRICT`: when `true`, Capture Hook failures exit non-zero.
- `MEMORY_RAW_INGEST_BATCH_BYTES`: target maximum request size for Capture Hook raw-ingestion batches. Default `180000`.
- `MEMORY_API_REQUEST_TIMEOUT_MS`: timeout for local MCP and Capture Hook API calls. Default `60_000`.
- `MEMORY_HOOK_DEADLINE_MS`: soft deadline used by Capture Hooks to stop optional work before Codex kills the hook process. Default `8500`.
- `MEMORY_HOOK_TRANSCRIPT_TAIL_BYTES`: maximum appended Codex transcript bytes inspected by PostToolUse, Stop, and SubagentStop hooks per run. The hook checkpoints transcript offsets and resumes unread bytes on the next invocation. Default `1000000`.
- `MEMORY_EXPOSE_DIAGNOSTIC_MEMORY_TOOLS`: when `true`, exposes diagnostic MCP tools such as `memory_access_check`. Default `false`; use the MCP `doctor` CLI command for normal setup checks.
- `MEMORY_EXPOSE_LOW_LEVEL_MEMORY_TOOLS`: when `true`, exposes low-level diagnostic MCP retrieval tools such as `memory_search` and `memory_expand`. Default `false`; normal recall should use `memory_answer`.
- `MEMORY_HOOK_TRIGGER_LCM_SUMMARY`: when `true`, the Capture Hook starts local LCM summary processing after capture.
- `MEMORY_HOOK_LCM_SUMMARY_DELAY_MS`: delay before Capture Hook-triggered LCM summary processing.
- `MEMORY_HOOK_LCM_SUMMARY_LIMIT`: maximum pending LCM summaries processed from a Capture Hook trigger.
- `MEMORY_CODEX_APP_SERVER_BINARY`: Codex app-server binary used by local Synthesis flows. Default `codex`.
- `MEMORY_ANSWER_BRIDGE_ENABLED`: when `true`, MCP startup runs the local browser Memory Answer bridge. Default `true`.
- `MEMORY_ANSWER_BRIDGE_HOST`: local answer bridge bind host. Default `0.0.0.0`.
- `MEMORY_ANSWER_BRIDGE_PORT`: local answer bridge port used by the History Browser. Default `3210`.
- `MEMORY_ANSWER_BRIDGE_CORS_ORIGINS`: comma-separated browser origins allowed to call the local answer bridge.
- `MEMORY_ANSWER_PROVIDER`: AI Client provider for MCP Memory Answer synthesis. Default and only supported value: `codex`.
- `MEMORY_ANSWER_MODEL`: Codex model for MCP Memory Answer synthesis.
- `MEMORY_ANSWER_REASONING_EFFORT`: Codex reasoning effort for MCP Memory Answer synthesis.
- `MEMORY_ANSWER_TIMEOUT_MS`: timeout for each local MCP Memory Answer app-server turn.
- `MEMORY_ANSWER_MAX_ATTEMPTS`: maximum local MCP Memory Answer synthesis attempts.
- `MEMORY_ANSWER_PLANNING_MODE`: `planned` lets the worker plan recall searches and expansions; `single_pass` only uses initial evidence.
- `MEMORY_ANSWER_MAX_SEARCHES`: maximum planned recall searches per MCP Memory Answer.
- `MEMORY_ANSWER_MAX_EXPANSIONS`: maximum planned evidence expansions per MCP Memory Answer.
- `MEMORY_ANSWER_PROMPT_STATE_MAX_CHARS`: prompt-state serialization guard for local Codex memory-answer planning. It bounds transport/context payload size for the planner state JSON; it is not a semantic Memory Event or embedding chunking limit.
- `MEMORY_MANUAL_ANSWER_PROVIDER`: AI Client provider for Explorer manual Memory Questions. Default and only supported value: `codex`.
- `MEMORY_MANUAL_ANSWER_MODEL`: default Codex model for Explorer manual Memory Questions. Leave blank to inherit `MEMORY_ANSWER_MODEL`.
- `MEMORY_MANUAL_ANSWER_REASONING_EFFORT`: default reasoning effort for Explorer manual Memory Questions. Leave blank to inherit `MEMORY_ANSWER_REASONING_EFFORT`.
- `MEMORY_MANUAL_ANSWER_TIMEOUT_MS`: default timeout for Explorer manual Memory Questions. Leave blank to inherit `MEMORY_ANSWER_TIMEOUT_MS`.
- `MEMORY_MANUAL_ANSWER_MAX_ATTEMPTS`: default retry attempts for Explorer manual Memory Questions. Leave blank to inherit `MEMORY_ANSWER_MAX_ATTEMPTS`.
- Manual Memory Question model and reasoning options are read from Codex app-server `model/list`; `.env` only provides the initial default selection.
- `MEMORY_QUESTION_ANSWER_MAX_ATTEMPTS`: bridge-level retry cap for older pending question rows without per-question max attempts.
- `MEMORY_QUESTION_ANSWER_LOCAL_LEASE_SECONDS`: short renewable lease used when the local bridge claims a pending manual Memory Question.
- `MEMORY_LCM_SUMMARY_PROVIDER`: AI Client provider for LCM Summary synthesis. Default and only supported value: `codex`.
- `MEMORY_LCM_SUMMARY_MODEL`: Codex model for LCM Summary synthesis.
- `MEMORY_LCM_SUMMARY_REASONING_EFFORT`: Codex reasoning effort for LCM Summary synthesis.
- `MEMORY_LCM_SUMMARY_TIMEOUT_MS`: timeout for each local LCM Summary app-server turn.
- `MEMORY_LCM_SUMMARY_MAX_ATTEMPTS`: maximum local LCM Summary synthesis attempts.
- `MEMORY_LCM_SUMMARY_RETRY_DELAY_MS`: delay between local LCM Summary retry attempts.
- `MEMORY_LCM_SUMMARY_CONCURRENCY`: maximum concurrent local LCM Summary workers.
- `MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS`: maximum prompt budget for local Codex LCM Summary calls. Default `48000`.
- `MEMORY_LCM_BACKGROUND_INITIAL_DELAY_MS`: delay before the MCP-local LCM Summary Service first checks for pending summaries.
- `MEMORY_LCM_BACKGROUND_PUSH_DELAY_MS`: delay used when the local service is nudged after capture.
- `MEMORY_LCM_BACKGROUND_INTERVAL_MS`: periodic background check interval for pending summaries.
- `MEMORY_LCM_BACKGROUND_BATCH_LIMIT`: maximum pending LCM summaries processed in one background batch.

Configure Codex to run the Supported Capture Hook for `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SubagentStart`, and `SubagentStop`. The subagent hooks let Koed preserve child conversation identity and parent linkage for thread-spawned Codex subagents.

Koed Self-Hosted relies on the connected AI Client for Synthesis; backend LLM provider configuration and server-side synthesis are unsupported in this build.
The MCP-local LCM Summary Service is enabled by default in this build. Failures are reported as diagnostics and pending summaries remain searchable as degraded evidence.
MCP Memory Answer and LCM Summary model, reasoning, timeout, and attempt settings can be edited in the Explorer Settings panel. The API stores those user settings and the local MCP/bridge reads them at execution time. `.env` values are bootstrap defaults only; precedence is API user setting, then `.env`, then code default.

Manual Memory Question settings selected in the Explorer composer are stored on the question row so retry and background catch-up use the same model, reasoning effort, timeout, and attempts. If Codex app-server cannot be started, local Synthesis fails visibly instead of falling back to a backend LLM path.

Capture Policy state `ask` currently blocks automatic capture. It is reserved
for a future AI-client approval flow and is not an implemented backend prompt.

## Data At Rest

Postgres is the source of truth for Users, API Tokens, Capture Policies, Memory Events, Memory Nodes, embeddings, LCM placeholders, LCM summaries, and related evidence. The application hashes API Tokens with `API_TOKEN_PEPPER`, but captured memory content, generated summaries, graph text, and embedding metadata are stored as normal database rows.

Operators should treat the Postgres database and backups as sensitive memory data. Keep Postgres on a private network, restrict database credentials to Koed services and trusted administrators, use encrypted disks or managed-database storage encryption, encrypt backups, and rotate secrets if a backup or database role is exposed.
