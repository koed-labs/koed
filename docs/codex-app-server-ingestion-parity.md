# Codex App-Server Ingestion Parity

This document defines the local parity target for Koed-managed Codex threads.
It does not change the Supported Capture Hook path for threads started outside
Koed and does not imply production rollout.

## Boundary

Both transports terminate at one canonical ingestion boundary:

```text
app-server lifecycle event --\
                              > conversation_items -> Projection -> Memory
persisted JSONL record ------/           |
                                         +-> conversation_item_observations
```

`conversation_items` contains one row per proven logical item and is the
downstream semantic identity. `conversation_item_observations` contains
immutable provider evidence. Projection may read attached observations only to
reconstruct one oversized transport-chunked canonical item; an observation is
never independently projected, embedded, compacted, recalled, graphed, or
synced. An observation whose canonical identity cannot be proven remains
unlinked rather than creating a duplicate semantic row. JSONL-only context
that has stable source-record identity but no provider semantic identity is
retained as a raw-only canonical source row so Projection Policy can opt it in
later. Canonical persistence and observation persistence share one database
transaction and advisory identity lock.

## Identity

Canonical identity is derived only from stable provider identity:

```text
provider + external_thread_id + external_turn_id + stable_item_id + component
```

Components distinguish a message, reasoning summary, tool call, tool result,
and control record when one provider item represents more than one semantic
unit. Koed assigns each managed prompt a `clientUserMessageId`; app-server
returns it on the user item and JSONL persists it as `client_id`, so that shared
provider value is the user message's stable item id. Generic role-user JSONL
response items without a stable id may contain injected instructions or
environment context and remain raw-only source records in both managed and
external threads. For external threads, the explicit JSONL
`event_msg:user_message` is the projectable prompt representation. Content
hashes are observation integrity checks and are never matching keys.

If a projectable event has no exact provider identity, the adapter stores an
`identity_unresolved` raw observation, excludes it from Projection, and fails
the managed turn visibly. It does not guess from content or create a second
canonical item for later cleanup.

## Precedence

| Field                                   | Canonical precedence                                                                   | Retained observations |
| --------------------------------------- | -------------------------------------------------------------------------------------- | --------------------- |
| Identity                                | Provider thread, turn, item and component ids                                          | Both                  |
| Completed item payload and text         | app-server `item/completed`                                                            | Both                  |
| Started lifecycle snapshot              | Used until completion arrives                                                          | Both                  |
| Item lifecycle source time              | app-server `startedAtMs` / `completedAtMs` when present; JSONL fills a missing value   | Both                  |
| Persisted transcript chronology         | JSONL path and line augment the canonical row; exact sequence and time stay per source | JSONL                 |
| Turn completion                         | app-server `turn/completed`; JSONL `task_complete` recovers the same control identity  | Both                  |
| Transcript-only context and world state | Raw provenance only unless Projection Policy opts in the type                          | JSONL                 |
| Observation time                        | Never replaces known source time                                                       | Both                  |

Canonical payload priority is app-server completed item or turn lifecycle
(300), JSONL reconciliation (200), `item/started` (100), and hook control
fallback (50). Payload, semantic classification metadata, source sequence, and
provider item id follow that precedence. A lower-priority observation can add
missing source location and non-conflicting metadata but cannot replace a
higher-priority completed representation. Every observation retains its own
unmodified identifiers, sequence, source time, and observation time.
Encrypted canonical metadata is merged before Projection using the same
precedence, including additive nested tool input and output fields. Its
plaintext encrypted-column marker is rebuilt from the active encrypted payload
rows in the same transaction, so a source-path or metadata augmentation cannot
leave a sentinel without its decryptable companion.

## Coverage

### Shared data

- user messages, agent messages, and human-readable reasoning summaries;
- command/tool calls and results, status, error, output, and duration;
- structured JSONL tool arguments and normalized Codex command output fields,
  while the exact provider string remains in raw provenance;
- thread, turn, item, and call identity;
- final turn state and token usage notifications;
- source payload, source hash, sequence, and timestamps.

### Additional app-server structure

- item started/completed lifecycle and exact lifecycle timestamps;
- typed command actions, cwd, exit status, and duration;
- typed MCP app context and errors;
- typed file-change, plan, web-search, image, compaction, and collaboration
  items;
- thread session-tree id, source, cwd, Git metadata, provider, CLI version, and
  name returned by `thread/start` or `thread/resume`;
- Koed `clientUserMessageId` on the managed user input.

### JSONL-only or persistence-authoritative data

- the exact persisted rollout record and transcript path/line position;
- session metadata, turn context, world state, and compaction records not
  represented by a stable ThreadItem;
- persisted inter-agent and context metadata;
- deterministic chronology interpolation for otherwise usable timestamp-less
  rows;
- recovery after app-server or Koed stops before a completion observation is
  committed.
- role-user response records that lack the managed prompt's `client_id`, which
  include injected setup and environment context in current Codex rollouts and
  remain raw-only unless Projection Policy explicitly selects them.

### Deliberately transient data

`item/*/delta` and command-output delta notifications are not persisted. They
are suitable for live delivery but do not establish semantic identity, and the
completed typed item plus persisted rollout retain the durable content. Request
and lifecycle controls that have operational value are retained as raw-only
canonical records and observations.

## Seal ordering

The server stores every turn-scoped managed canonical row as `held`, including
the app-server completion control. Koed drains JSONL reconciliation first and
requires the matching persisted `task_complete` or `turn_aborted` observation
before it atomically releases all held rows in that turn to `pending`. The
normal worker cannot project held rows, so no message, Memory Event, embedding,
or LCM work can run early. The app-server terminal event establishes the live
lifecycle state but cannot authorize Projection by itself. Reconciliation waits
for a bounded period when the terminal JSONL record trails the app-server
notification, then fails visibly without releasing the turn if durable evidence
still has not arrived.

Projection orders a canonical turn-completion control after every non-control
item in that turn even when provider timestamps have different precision or
source transports use unrelated sequence spaces. Tool-call components likewise
sort before their corresponding tool-result components. Multiple projected
display rows may legitimately share a provider sequence; display idempotency
and source hashes, rather than transcript-sequence uniqueness, prevent
duplicates.

Each managed thread keeps its isolated Codex home under `KOED_HOME`, including
the rollout and a mode-`0600` atomic ingestion checkpoint. Resuming after
restart requires that Codex home, the original provider thread id, Koed
Captured Session id, and rollout path. Koed refreshes provider credentials,
verifies the resumed identities and path, revalidates the Captured Session,
then continues reconciliation from the last fully persisted checkpoint. A
crash between database persistence and checkpoint rename only causes an
idempotent replay. Releasing a terminal turn happens before advancing its
checkpoint, so the same replay also recovers a crash in that window.

Only one coordinator may use a managed Codex home. Acquisition uses an
exclusive owner lease tied to the PID and operating-system process start
identity, so PID reuse cannot inherit a stale lease. A dead owner's lease is
quarantined without allowing two contenders to replace one another's live
lease. Normal close releases the lease but preserves the durable home. Explicit
managed-home destruction acquires the same lease before removing the home,
rollout, checkpoint, and stale-lease tombstones.

Hook-triggered foreground reads capture the transcript byte length at signal
time and never read beyond it, even if Codex appends another turn while the pass
is running. Foreground work has a bounded scan budget; a larger backlog advances
one exact sequential page and leaves the remainder to detached catch-up. A
page-ending assistant event is held until the next provider record determines
whether the persisted assistant representation is an event or response item.
`Stop` remains a signal: its control is not admitted until the catch-up cursor
has reached that signal's captured byte boundary.

App-server `thread/started` events for subagents create linked child Captured
Sessions. Child lifecycle items and child rollout JSONL reconcile through the
same identity, hold, terminal-evidence, Projection, embedding, and LCM paths as
the parent thread; they are not flattened into the parent transcript.

## Policy and security

- Capture Policy and Capture Pause are enforced at canonical raw persistence,
  including policy changes after session creation.
- Projection Policy independently controls display, message/tool creation,
  Memory Event creation, embedding, and LCM inclusion by canonical item type.
- A session rebuild applies policy changes to retained source data by
  invalidating and regenerating downstream derivations under a session-scoped
  Projection lock.
- The worker derives missing embedding jobs and LCM compaction scopes from
  durable PostgreSQL state on every catch-up pass. Deterministic queue ids make
  retries idempotent; an admission failure or exhausted queue retry remains
  discoverable after restart. Embedding chunks replace one complete source set
  atomically, and partial sets remain pending. LCM dispatch batches are bounded
  and include invalidated-leaf generation in their identity so refreshed work
  cannot collide with an already-completed queue job.
- Oversized raw items use at most 64 transport chunks of 256 KiB each, with a
  16 MiB logical-item ceiling. Every chunk carries a server-verified group id
  derived from its logical source and source-item identity; Projection never
  combines chunks from different groups.
- Managed deployment profiles store redacted canonical and observation
  payloads and non-empty source text/paths with separate encrypted-field
  companions. Empty optional text does not create an invalid empty encrypted
  companion. Project/workspace metadata is derived from the verified Captured
  Session and remains inside the encrypted metadata companion. Bounded routing
  metadata and role-aware Projection classification are server-derived;
  observation rows cannot become a plaintext side channel.
- Source observation rows are local provenance and are not included in graph,
  evidence, embedding, LCM, or sync payloads.
- The installed Codex binary must pass generated JSON Schema capability checks,
  including the experimental app-server declarations used by this adapter,
  before the managed stdio process starts.

## Automated evidence

- `codex-conversation-source-adapter.test.ts` compares app-server and JSONL
  canonical keys and covers lifecycle, tools, controls, unsupported identity,
  non-display ThreadItem variants, consecutive turns, and interruption.
- `codex-managed-conversation.test.ts` exercises a real stdio JSON-RPC child,
  verifies reconciliation-before-seal ordering, byte-bounded multi-page
  completion, parent/child thread isolation, delayed terminal reconciliation,
  exclusive durable-home ownership, checkpoint reuse, and completion recovery
  through `thread/resume` plus JSONL.
- `codex-app-server-protocol-compatibility.test.ts` checks generated protocol
  capability acceptance and explicit drift failure.
- `repository.test.ts` proves transactional canonical/observation idempotency,
  integrity conflict rollback, source-time precedence, Capture Policy/Pause,
  encrypted observation storage, managed-versus-external projected parity,
  embedding eligibility, and independent LCM source policy.
- Existing semantic projection tests continue covering the 2048-token soft
  target, whole-item rollover, embedding hard-cap splitting, ordered item
  manifests, source links, deletion rebuild, and externally managed hook/JSONL
  catch-up.

## Upgrade behavior

The migration preserves existing canonical conversation rows and encrypted
companions in place. It does not invent historical observations or relabel
ciphertext as evidence from a source that was not recorded at the time. New and
exactly replayed source records create immutable observations from that point
forward; an exact replay can attach its verified observation to the existing
canonical row idempotently. Existing rows receive canonical keys and policy
eligibility fields, while projection status values outside the current finite
state set normalize to `pending`. Duplicate legacy canonical keys retain one
deterministic canonical parent and receive distinct legacy provenance
identities on the other rows. Legacy transport chunks receive a deterministic
source-group marker and converge on exact replay without losing encrypted
companions. Operators should allow capacity for the new indexes and future
observation rows before applying the migration to a populated deployment.

## Current product constraint

The managed coordinator is a local backend module with no Desktop or Explorer
entry point. It does not attach to an independently running Codex process.
Externally managed threads continue using the Supported Capture Hook and JSONL
catch-up. Product integration and any migration away from that path require a
separate decision after local evidence is accepted.
