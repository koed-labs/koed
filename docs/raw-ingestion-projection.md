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
- Source adapter: connector-specific code that maps provider output to a stable
  logical identity and an immutable source observation.
- Canonical conversation item: one `conversation_items` row for one logical
  provider item. Downstream code consumes this row and never branches on the
  source transport.
- Source observation: one `conversation_item_observations` row containing the
  exact app-server lifecycle event, transcript record, or control record that
  established or augmented a canonical item. Observations retain independent
  adapter, transport, payload, hash, source time, observation time, sequence,
  lifecycle kind, and ingestion status.
- Ingestion service: Koed API and repository code that accepts canonical raw
  records, validates ownership, and persists them idempotently.
- Projection pipeline: the implementation path exposed through
  `/v1/memory/conversation-items/project` that derives `sessions`, `turns`,
  `messages`, `tool_events`, `memory_events`, token usage rows, LCM nodes, and
  embeddings from raw source records.

Attached observations are not downstream semantic units. Projection reads them
only when all chunks are required to reconstruct one oversized canonical item;
the reconstructed item still has one canonical identity and one downstream
source link.

Source adapters submit canonical candidates and immutable observations; the
server owns `projection_status` and ignores client attempts to set canonical
priority or Projection state. Canonical identity is based on
provider thread, turn, item, and component identifiers; content hashes validate
observations but never establish identity. Koed writes the canonical row and its
observation in one transaction under an advisory identity lock. A replay of the
same observation is idempotent, while reuse of an observation identity with
different bytes fails visibly. Koed marks canonical rows as `projected` after the
projection pipeline has handled that raw record, including cases where the
correct projection is to preserve only the raw audit row and skip telemetry or
lifecycle noise. Pending and errored raw rows can be run through the Projection
endpoint again for deterministic catch-up. Managed-thread rows remain `held`
until terminal verification and JSONL reconciliation complete; the worker never
scans held rows.

Projection uses the DB-backed `projection_policy_rules` table as the explicit
positive allowlist for Codex transcript item types. The seeded defaults preserve
the current behavior: user, agent, subagent, tool call/result, and reasoning
summary items are projected to the UI and embedded semantic memory; system,
developer, context, lifecycle, token-usage, error, raw reasoning, and unknown
items remain raw provenance only. Canonical transcript `function_call` and
`function_call_output` rows are the tool items used for rendering and semantic
memory; lower-level MCP and patch lifecycle event rows are retained only as raw
provenance. The server refines generic provider `message` records from their
raw role before policy lookup, so developer/system records cannot inherit the
generic message rule. A role-user response item without stable provider
identity stays a raw-only source record; external JSONL uses the explicit
`event_msg:user_message` as the projectable prompt. The seeded defaults keep UI
projection and embedding selection matched for current product behavior, but
the policy fields are deliberately
independent so future rules can represent display-only or recall-only transcript
rows without a schema change. The same policy row also controls whether a
projected Memory Event may become an LCM source through `include_in_lcm`.
Unlisted transcript item types default to raw provenance only until a policy row
deliberately opts them in. After a policy change, the authenticated session
rebuild operation invalidates prior display, Memory Event, embedding, and LCM
derivations and reprojects retained canonical items under the new policy.

## Current Codex Adapters

Codex transcript hooks use `sourceAdapterVersion=codex-transcript-v1` and
`sourceTransport=hook` or `transcript`. Each exact transcript observation
creates or augments its canonical item before selected records are projected
into `memory_events`. Hooks do not write semantic `memory_events` directly; the
raw Projection endpoint is the only hook-backed path that derives chat memory. Hook
payloads are capture signals, not semantic content sources; transcript JSONL
timestamps define source chronology. If an otherwise readable transcript row is
missing a timestamp, catch-up holds it at the current checkpoint until a later
timestamped row allows deterministic interpolation.

The experimental Koed-managed conversation adapter uses
`sourceAdapterVersion=codex-app-server-conversation-v1` and
`sourceTransport=app_server`. A long-running, Koed-owned stdio app-server
connection writes stable `item/started`, `item/completed`, and turn lifecycle
observations promptly. `item/completed` is the preferred canonical payload;
provider lifecycle timestamps remain distinct from Koed observation time.
Incremental text and command-output deltas are deliberately transient and are
not stored as semantic items or source observations because completed item
payloads retain the durable result.

Koed-managed prompts use the shared app-server `clientUserMessageId` / JSONL
`client_id` as their exact item identity. Codex may also persist injected setup
context as role-user response items without that id. Those records are captured
as raw-only source records without semantic provider identity and cannot be
mistaken for the User's prompt. The same rule applies to externally managed transcripts;
their explicit `event_msg:user_message` remains the authoritative prompt row.
Event-message duplicates that cannot be proven identical likewise remain
observations rather than second canonical rows. Unique JSONL-only records retain
canonical raw rows so Projection Policy can select them later. JSON-encoded tool
arguments and standard Codex command results are normalized into structured
tool metadata for Projection, while their exact strings remain in encrypted raw
provenance.

The persisted rollout remains the reconciliation and recovery source. Managed
JSONL passes use `sourceTransport=transcript` and attach to the same canonical
keys, add persisted chronology and transcript-only context, and recover a
missed `turn/completed` from `task_complete`. A normal app-server completion and
its JSONL completion share one canonical control identity. Reconciliation runs
before the server atomically releases every held row in the terminal turn, so
display, turn sealing, embedding, and LCM cannot race ahead of durable
transcript catch-up. Projection also processes the completion control last
within its turn, independent of timestamp precision or transport-specific
sequence values. Resuming a managed session verifies the provider thread id
and rollout path, revalidates the original Captured Session, and reuses the
durable Codex home and atomic transcript checkpoint under `KOED_HOME`. A replay
after a checkpoint-write failure is safe because canonical rows and source
observations are idempotent.

Oversized raw items are bounded to 64 transport chunks of 256 KiB each and a
16 MiB logical-item ceiling. The server derives and verifies one chunk-group id
from the logical source, source-item hash, transport, chunk count, and encoding.
Projection reconstructs only a complete exact group and fails closed on missing,
duplicate, oversized, or cross-group chunks.

The installed Codex binary must generate a compatible app-server JSON Schema,
including the experimental declarations consumed by the adapter, before a
managed connection starts. Koed checks the request methods,
notification methods, lifecycle timestamp fields, and ThreadItem variants used
by the adapter. Missing protocol capabilities fail before app-server ingestion
begins. The app-server remains local stdio; it is not exposed to Electron,
browsers, or Team clients.

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
node tables are the projected stores for those workflows. Explicit
`workflow:*` Projection Policy rows keep their telemetry outside conversation
memory without relying on client-supplied Projection state.

Capture Policy is enforced again at canonical raw persistence, including an
active Capture Pause after a Captured Session was created. This is the common
defence for hook, managed, and internal-workflow transports; API metadata cannot
bypass it.

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

Each projected memory event that came from canonical source records should link
back through `memory_event_sources`. A turn-bundled semantic event therefore
links to every canonical `conversation_items` row that contributed text to that
bundle. Exact provider payloads and additive provenance remain on the attached
observation rows. Apart from reconstructing one canonical transport-chunked
item, observations never feed Projection and are never independent embedding,
LCM, recall, graph-export, or sync sources.

Agent-turn `memory_events` are sealed only on a semantic flush condition:
turn-complete hook or transcript-verified managed control, next user
prompt/interruption, a token-limit rollover, or the stale catch-up timeout.
Session, thread, Project, and batch boundaries isolate pending queues but do not
themselves seal an incomplete turn. Detached transcript catch-up may continue
creating idempotent `messages` and `tool_events` while leaving an incomplete
agent bundle pending until one of those seal conditions arrives. The stale
catch-up timeout is based on the newest source item in the pending bundle, so an
active long turn does not seal merely because its first item is old. If adding
the next complete source item would cross
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

The same worker pass reconciles downstream queue admission from PostgreSQL. It
lists every eligible source still missing an embedding and every personal LCM
scope with eligible Memory Events not yet covered by a leaf, then submits
deterministic jobs. PostgreSQL remains the retry source after Redis/BullMQ or the
local queue rejects admission, exhausts retries, or restarts. A complete
embedding response replaces all chunks for that source atomically; a partial or
failed response cannot hide the source from reconciliation. LCM dispatch is
bounded by `MEMORY_LCM_COMPACTION_MAX_EVENTS` (default `1000`, maximum `10000`),
and invalidating an old leaf creates a new dispatch generation.

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

Embeddings and LCM both derive from eligible canonical `memory_events`, but
their representations are intentionally independent. Embeddings may use
`metadata.embeddingContent`; LCM token thresholds and summaries use
`memory_event.content`. Neither path consumes raw transcript JSON or provenance
payloads. The packer must not overlap or
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
docker compose --env-file .env -f examples/docker-compose/docker-compose.yml down -v
docker compose --env-file .env -f examples/docker-compose/docker-compose.yml up --build
```

Preserve `.env` before any reset if it contains local API tokens or developer
configuration.

For a truly fresh hook replay, also remove the local hook optimization cache:

```bash
rm -f ~/.koed/capture-state.json
```
