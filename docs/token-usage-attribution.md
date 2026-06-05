# Token Usage Attribution

Koed stores token usage as product telemetry, not as Memory. Usage rows must not
be embedded, used as semantic retrieval input, or included as LCM source
material.

## Audit

`workflow_token_usage` already exists from the raw ingestion work. It stores
workflow identifiers, optional source links, model/context-window fields,
input/cached/output/reasoning/total token counts, `usage_scope`, metadata,
idempotency keys, and raw-source hashes.

Current call sites are:

- Raw conversation projection records Codex app-server
  `thread/tokenUsage/updated` events linked to `conversation_items`.
- Raw conversation projection records Codex transcript `token_count` rows
  linked to `conversation_items`.
- Manual browser Questions record the worker's app-server `last` token usage
  directly and then project the raw telemetry rows.
- MCP `memory_answer` records each app-server execution under a generated
  `jobId` returned in `localMemoryWorker.jobId`.
- LCM Summary Service calls record the worker's app-server `last` token usage
  directly and then project the raw telemetry rows.

Source-link validation is enforced before insert for optional `sessionId`,
`turnId`, and `conversationItemId`. Each referenced row must be visible to the
caller and, when multiple links are present, must belong to the same linked
session/turn boundary.

Additional attribution links use the typed
`workflow_token_usage_source_references` table. `question`, `lcm_node`,
`message`, `tool_event`, and `memory_event` references are validated against the
caller's personal visibility before insert. `answer_job` references are local
Koed worker job identities and must match the usage row's `workflow_id`; they do
not point at a separate backend synthesis table in the current build.

Idempotency is scoped to the owning user. Personal rows are unique by
`(owner_user_id, idempotency_key)`.

Because this table already owns durable usage persistence, KOE-145 evolves
`workflow_token_usage` instead of introducing a competing table.

## Attribution Fields

`usage_source` identifies where the count came from, for example `app_server`,
`transcript`, `connector_native`, or `local_estimate`. The
`/v1/memory/token-usage` API accepts these attribution fields directly so
connectors can distinguish native provider usage from local estimates.

`usage_accuracy` identifies whether the count is `provider_reported`,
`provider_replayed`, `provider_partial`, or `local_estimate`.

`usage_kind` separates `turn_delta` rows from `cumulative_snapshot`, `estimate`,
and structural tokenizer counts. Rollups must not sum cumulative snapshots as
spend.

Tokenizer metadata is recorded only when a local tokenizer estimate or
structural tokenizer count is used. Provider-reported rows may leave tokenizer
fields empty.

## Current Tokenizer Helpers

`packages/core` provides OpenAI/Codex-oriented token counting and chunking using
`js-tiktoken`, with `o200k_base` and `cl100k_base` support plus a heuristic
fallback. The helper returns the resolved model, encoding, exact-match flag,
token count, and tokenizer name.

These helpers are sufficient for Codex-style local estimates and structural
splitting in the current build. Non-Codex connectors can use them as
fallback estimates only when native/provider usage is absent or incomplete, and
must mark those rows as estimates.

## Rollup Rules

Spend-oriented rollups should prefer rows with
`usage_accuracy=provider_reported` and `usage_kind=turn_delta`.

Codex transcript `token_count` rows are stored with `usage_source=transcript`,
`usage_accuracy=provider_reported`, and `usage_kind=turn_delta`. Main
conversation rows use `workflow_type=main_agent_turn`; subagent rows use
`workflow_type=subagent_turn` and preserve parent thread/session metadata when
available.

Planned Memory Answers preserve every app-server execution that reports token
usage in
`localMemoryWorker.appServerExecutions`. Browser Questions and MCP
`memory_answer` calls persist each execution as a separate provider-reported
turn-delta row, so planner/search/final steps and retry attempts are not
collapsed into only the final answer turn. Failed retry attempts are persisted
when Codex emits provider usage before the failure; attempts that fail before
provider usage is observable are not fabricated as spend.

Rows with `usage_kind=cumulative_snapshot` are useful for diagnostics and model
context visibility, but must not be summed as spend.

Rows with `usage_accuracy=local_estimate` must be labelled as estimates in
responses and documentation. They are useful for diagnostics, optimization, and
chunking decisions, but are not billing-grade usage.

The internal diagnostic endpoint
`GET /v1/memory/token-usage/rollups` returns visible usage grouped by requested
dimensions. By default it includes only `provider_reported` `turn_delta` rows.
Callers must pass `include_estimates=true` to include estimate-aware rows.
