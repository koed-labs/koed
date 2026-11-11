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
- Managed coding Conversations record one provider-reported turn-delta row per
  completed durable prompt command on the execution device. The row is keyed
  to the managed execution and local Captured Session; provider turn identity
  and cumulative processed tokens remain bounded metadata rather than foreign
  keys to provider-native ids.

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

Personal Memory Answer task executions also submit `memoryAnswerTaskId`, stored
as a validated `memory_answer_task` source reference. The API checks Personal
ownership and excludes Team-bound tasks, including retained Team authority after
Workspace deletion. Fenced task completion links every recorded run of that task
to its final question in the same transaction. Worker job IDs remain per-run,
and attempt idempotency remains per-attempt. Task expiry does not remove usage
or its question references. Historical rows are not backfilled.

The executor waits for all attempted usage submissions to settle before returning
to the task scheduler, even when a sibling write fails. Telemetry failures are
logged and dropped; they do not retry synthesis or create a late-arrival queue.

Memory Answer usage attributes the actual Codex, Claude Code, or pi synthesis
worker through its provider's execution identity and transport. Native incomplete
counts remain `provider_partial`; missing counts remain null. Worker identity is
not the identity of the AI Client requesting recall. Both Desktop Ask and external
Memory Answer currently select the `mcp_memory_answer` settings flow, so usage
retains that workflow key. Trusted `metadata.questionOrigin` distinguishes
`desktop_ask` from `mcp_memory_answer` without changing workflow grouping or
selecting the unused manual flow. Historical attribution is not rewritten.

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

The managed Conversation surface reads only the latest owning User's usage row
through `GET /v1/managed-conversations/{executionId}/usage`. That response is a
redacted presentation projection: it exposes provider, model, current context
tokens, context-window capacity, configured reasoning effort, bounded token
breakdowns, accuracy, and observation time. It does not expose source metadata,
provider paths, command payloads, account details, or another User's usage. A
local edge presents usage reported by its local execution runner even when
durable execution authority is remote.

Codex context consumption uses the provider's `last.totalTokens`; cumulative
`total.totalTokens` is shown separately as processed usage and is never used as
the context-window numerator. Claude uses the Agent SDK's reported model-usage
snapshot. Partial, replayed, or locally estimated data retains its accuracy in
the presentation projection and is never treated as exact provider telemetry.
When provider context data is absent, the desktop keeps the AI Client, model,
and configured reasoning effort visible, but omits the context label, counts,
and meter. The Personal Device transfer control shares this metadata row.

Rows with `usage_accuracy=local_estimate` must be labelled as estimates in
responses and documentation. They are useful for diagnostics, optimization, and
chunking decisions, but are not billing-grade usage.

The internal diagnostic endpoint
`GET /v1/memory/token-usage/rollups` returns visible usage grouped by requested
dimensions. By default it includes only `provider_reported` `turn_delta` rows.
Callers must pass `include_estimates=true` to include estimate-aware rows.

## Failure-path accounting

The Recall activity implementation audits Codex app-server, Claude Agent SDK,
and pi RPC with synthetic native-protocol fixtures. These checks do not make
billable provider calls. Reported usage is submitted even when cancellation,
an escaping completion callback, or final question persistence prevents the
answer from being returned. Task completion still awaits all submissions.
Telemetry failures are logged and dropped without rerunning Answer Synthesis.

- Codex preserves the latest observed turn usage on provider failure, timeout,
  and session closure. Failed inner attempts remain separate from task retries.
- Claude retains usage from error results and results followed by an SDK
  exception. Each independent query uses its latest cumulative result once.
  If cancellation prevents a result, unique main-loop assistant message IDs
  can supply partial input/cache counts; their output placeholders are ignored.
  Input includes native uncached, cache-read, and cache-creation counts. The
  result replaces these partial observations rather than adding to them.
  This follows the [Agent SDK usage definitions](https://code.claude.com/docs/en/agent-sdk/cost-tracking).
- pi accumulates terminal assistant `message_end` usage independently of the
  bounded diagnostic event buffer. Streaming updates and replayed identified
  messages are excluded. Input includes native input, cache-read, and
  cache-write counts; reported total and output retain their native meaning.
  Reasoning is an output subset. Error and cancellation paths carry observed
  usage through the same worker accounting as successful responses. The
  [pi message definitions](https://pi.dev/docs/latest/message-types) describe
  these native fields. pi's requesting extension reaches the Local AI Runtime
  directly; that route does not imply MCP or identify the synthesis worker.

No provider report means unknown consumption. A process killed before it emits
usage cannot be reconstructed, and an unavailable telemetry backend can still
lose a submitted record. Cancelled or failed tasks without a final question
remain outside the page's linked totals. These are coverage limits, not zero
usage. Historical records are not rewritten to repair earlier normalization.
