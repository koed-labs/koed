# Raw Ingestion and Projection

Koed stores coding-tool output in two layers:

- Raw ingestion records preserve source events as closely as possible to the
  originating tool.
- Projected records are Koed-specific semantic units used by retrieval,
  summaries, graph views, Questions, and the explorer APIs.

In domain terms, **Projection** is the transformation from captured source
activity into Koed semantic memory structures. This document describes the
implementation boundary for that transformation.

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
- Projection pipeline: the implementation path exposed through
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
boundary. Within an agent turn, projection keeps tool calls and tool results in
the same embeddable semantic bundle as the related reasoning and final answer so
retrieval sees the whole evidence chain. The bundle metadata carries an ordered
item manifest with source ids, actor/kind, tool names/call ids when available,
source chronology, and text offsets so renderers and evidence expansion can
still distinguish agent prose, tool calls, tool results, subagent output, and
final assistant text. A user interruption submitted while the agent is running
is also a `user_turn` boundary: agent work before the interruption and agent
work after the interruption become separate semantic units.

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

Agent-turn `memory_events` are sealed only on a semantic flush condition:
turn-complete hook, next user prompt/interruption, session/turn/thread/workspace
boundary change, a token-limit rollover, or the stale catch-up timeout. Foreground
projection may continue creating idempotent `messages` and `tool_events` while
leaving an incomplete agent bundle pending until one of those seal conditions
arrives. The stale catch-up timeout is based on the newest source item in the
pending bundle, so an active long turn does not seal merely because its first
item is old. If adding the next complete source item would cross
`MEMORY_EVENT_MAX_TOKENS`, projection seals the current bundle and rolls the
overflowing item into the next `agent_turn` bundle. `MEMORY_EVENT_MAX_TOKENS` is
a soft bundle target: it is not a reason to split a single source item. If one
source item exceeds that target but still fits within `EMBEDDING_MAX_TOKENS`, it
is kept as one memory event. Only a source item that exceeds the embedding hard
cap is split, and those forced split fragments keep the original item metadata
plus explicit split index/count metadata.

The worker runs a raw-projection catch-up loop so pending or previously failed
raw rows are eventually projected after restart, outage, or hook deadline
pressure. `MEMORY_RAW_PROJECTION_INTERVAL_MS`,
`MEMORY_RAW_PROJECTION_BATCH_LIMIT`, and `MEMORY_RAW_PROJECTION_ACTOR_LIMIT`
bound that background work. Local app-server answer and LCM workers also ask
the API to project the exact raw rows they just persisted before they write the
derived answer or summary.

When a display item is deleted, Koed excludes the underlying raw source item
from semantic memory immediately and invalidates affected Memory Events and
embeddings. A durable rebuild job then waits for
`SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS` before the worker creates replacement
Memory Events from the surviving source items and embeds them through the normal
embedding workflow.

## Token Usage

`workflow_token_usage` stores token attribution by workflow, model,
session/turn, and raw `conversation_items` source where available. It also marks
the usage source, accuracy, and kind so provider-reported turn deltas can be
kept distinct from cumulative snapshots and local estimates. This keeps token
attribution separate from retrieval text while allowing future
pricing/benchmarking by workflow, model, Question, LCM summary, and source raw
record. See `docs/token-usage-attribution.md` for the current attribution
boundary.

## Token Bounds

Koed's operational Qwen cap is 32768 tokens. Runtime configuration defaults
semantic Memory Event bundle rollover to 2048 tokens and embedding requests to
4096 tokens. Values above 32768 are clamped. Projection keeps source-item
boundaries intact at the 2048-token bundle target. It only splits inside a single
raw source item when that item alone exceeds the embedding hard cap, then links
every forced fragment to the same raw source item or items with split metadata.

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
docker volume rm koed_postgres-data
docker compose up --build
```

Preserve `.env` before any reset if it contains local API tokens or developer
configuration.

For a truly fresh hook replay, also remove the local hook optimization cache:

```bash
rm -f ~/.koed/capture-state.json
```
