# Raw Ingestion and Projection

Koed stores coding-tool output in two layers:

- Raw ingestion records preserve source events as closely as possible to the
  originating tool.
- Projected records are Koed-specific semantic units used by retrieval,
  summaries, graph views, Questions, and the explorer APIs.

## Terms

- Connector: an integration boundary for a coding tool family, such as Codex.
  Future connectors can be added for other tools without changing Koed's
  semantic memory model.
- Source adapter: connector-specific code that converts raw tool output into
  canonical `conversation_items` rows. The adapter must set
  `source_kind`, `source_adapter_version`, source identifiers, source record
  type, raw JSON, and an idempotency key.
- Ingestion service: Koed API and repository code that accepts canonical raw
  records, validates ownership, and persists them idempotently.
- Projection pipeline: repository code exposed through
  `/v1/memory/conversation-items/project` that derives `sessions`, `turns`,
  `messages`, `tool_events`, `memory_events`, token usage rows, LCM nodes, and
  embeddings from raw source records.

Raw adapters submit records with `projection_status=pending` when the raw
record needs semantic projection. Koed marks raw rows as `projected` after the
projection pipeline has handled that raw record, including cases where the
correct projection is to preserve only the raw audit row and skip telemetry or
lifecycle noise. Adapters may submit background workflow telemetry as
`projection_status=raw_only` when another first-class table is already the
projection target. Pending and errored raw rows can be run through the
projection endpoint again for deterministic catch-up.

## Current Codex Adapters

Codex transcript hooks use `sourceAdapterVersion=codex-transcript-v1` and
`sourceTransport=hook`. Each transcript line becomes one raw
`conversation_items` row before selected records are projected into
`memory_events`. Hooks do not write semantic `memory_events` directly; the raw
projection endpoint is the only hook-backed path that derives chat memory.

Codex app-server workers use `sourceAdapterVersion=codex-app-server-v1` and
`sourceTransport=app_server`. Koed records app-server thread/turn calls and
notifications used by memory Questions and LCM summaries before persisting the
derived answer or summary. Token usage notifications are also recorded into
`workflow_token_usage` and linked to the raw app-server notification when the
source item is available.

Question-answer and LCM app-server events are background workflow telemetry, not
user chat threads. Their raw events and token usage are retained, but their
incremental deltas and completed answers must not be projected into the Chats
graph as standalone conversation memory events. The Questions table and LCM
node tables are the projected stores for those workflows, so their app-server
telemetry is terminal `raw_only` data rather than raw rows that should remain in
the projection backlog.

## Derived Memory Events

`memory_events` are semantic retrieval units, not raw hook fragments. User
prompts project as standalone `user_turn` units. Agent work projects as ordered
`agent_turn` units containing agent messages, human-readable reasoning
summaries, subagent messages, tool-call/tool-result content, and final assistant
messages that occur after a user prompt until the next user prompt or turn
boundary. Within an agent turn, projection keeps tool-only spans as `actor=tool`
semantic events instead of merging them into visible agent prose; this preserves
tool semantics for retrieval while allowing the explorer to keep tool rendering
separate from normal assistant messages. A user interruption submitted while the
agent is running is also a `user_turn` boundary: agent work before the
interruption and agent work after the interruption become separate semantic
units.

Telemetry, lifecycle noise, raw reasoning content, encrypted reasoning, and
rolling model context should remain raw records or metadata unless there is a
deliberate retrieval reason to project them. Incremental app-server deltas are
raw telemetry; if an app-server-backed conversation is projected into chat
memory, use stable completed records rather than partial deltas.

Koed intentionally projects human-readable Codex reasoning summaries into chat
messages and semantic memory. These summaries explain agent intent, tool-use
rationale, and investigation direction in a way that is useful for future
retrieval. Koed distinguishes them from raw reasoning by following Codex's own
shape: `summary` / `summary_text` / `AgentReasoning` records are displayable
summaries, while `content` / `raw_content` / `AgentReasoningRawContent` /
reasoning text deltas are raw reasoning and stay raw-only.

Each projected memory event that came from raw source records should link back
through `memory_event_sources`. A turn-bundled semantic event therefore links to
every raw `conversation_items` row that contributed text to that bundle. The raw
source rows remain the audit trail for exact Codex payloads and future
re-projection.

The worker runs a raw-projection catch-up loop so pending or previously failed
raw rows are eventually projected after restart, outage, or hook deadline
pressure. `MEMORY_RAW_PROJECTION_INTERVAL_MS`,
`MEMORY_RAW_PROJECTION_BATCH_LIMIT`, and `MEMORY_RAW_PROJECTION_ACTOR_LIMIT`
bound that background work. Local app-server answer and LCM workers also ask
the API to project the exact raw rows they just persisted before they write the
derived answer or summary.

## Token Usage

`workflow_token_usage` stores local Codex app-server token counts by workflow,
model, session/turn, and raw `conversation_items` source where available. This
keeps token attribution separate from retrieval text while allowing future
pricing/benchmarking by workflow, model, Question, LCM summary, and source raw
record.

## Token Bounds

Koed's operational embedding and semantic-event cap is 32000 tokens. Runtime
configuration may lower that value, but values above 32000 are clamped.
If a projected semantic unit exceeds that cap, split it into ordered chunks and
link every chunk to the relevant raw source item or items. Projection keeps
source-item boundaries intact where possible and only splits inside a single raw
source item when that item alone is over the token cap.

LCM leaves are packed from the same canonical semantic `memory_events` text
used for embeddings. LCM token thresholds count only `memory_event.content`,
not raw transcript JSON or provenance payloads. The packer must not overlap or
re-split semantic events: it may group several small semantic events together,
but it flushes before adding another event that would cross the leaf token
threshold. If one semantic event is slightly over the threshold because of
tokenizer drift or a defensive projection edge case, it remains a single leaf
source item and the LCM summary worker's larger prompt budget/token-bounded
fallback handles it. LCM prompts include lightweight anchors such as source id,
turn id, actor, and creation time, but not bulky metadata payloads.

## Fresh Reset

This project is still a PoC/MVP. If the raw ingestion schema changes before
release, a fresh local reset is acceptable:

```bash
docker compose down
docker volume rm koed-self-hosted_postgres-data
docker compose up --build
```

Preserve `.env` before any reset if it contains local API tokens or developer
configuration.

For a truly fresh hook replay, also remove the local hook optimization cache:

```bash
rm -f ~/.koed/capture-state.json
```
