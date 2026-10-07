# Codex History Capture

The Transcript Watcher feeds legacy and paginated Codex histories into the same
canonical Conversation Item, Projection and Personal Memory pipeline. Changing
Codex's history format does not change Capture Policy, grant Team access, or
start a second retrieval pipeline.

Projection replay identities and source hashes are unique within a User's
visibility scope. Two Users can capture the same native history independently;
one User's rows do not suppress another's messages, tool events or Memory Events.

Team Conversation Source preparation preserves native protocol identifiers
while masking visible text. Completed `Reasoning` records are excluded from
shared source preparation, including their summary, to keep private model
reasoning out of that transport. Personal Memory can still use the supported
human-readable reasoning summary; the unmodified source remains private evidence.

## Persisted Messages

Legacy rollouts retain their existing decoding and identities. In paginated
rollouts, `event_msg:item_completed` is the durable timeline representation.
Its native thread, turn and item IDs identify messages and tool components.
Managed prompts still use their shared `client_id` when present. Raw Responses
records remain model-context evidence, not additional messages: native
migration can give completed messages different IDs from their Responses
snapshots.

The parser persists history mode and a subagent's own-history ordinal boundary
in its consumer checkpoint, together with approval-helper classification when
the native User Message establishes it. Inherited rows below that boundary remain raw
evidence and do not become new child-thread Memory. Unknown completed-item
types and invalid required identities block canonical processing rather than
silently moving its cursor forward.

## Compressed Sources

The watcher discovers `.jsonl` and `.jsonl.zst` under configured source roots.
Managed reconciliation also reads compressed sources, including a compressed
sibling when Codex's saved plain path is no longer present. Historical import
keeps the native filename label when reading a temporary decoded source.
A regular plain sibling takes precedence over its compressed copy. Compressed
sources are decoded with Node's native Zstandard support into owner-private
temporary files under `KOED_HOME/state`; native source files are not modified.
Plain files are also read through private snapshots during asynchronous capture
and reconciliation. File identity and timestamps are checked around snapshot
creation so a source replacement cannot redirect a later read outside its
validated location.
The reader validates complete frame boundaries, limits the decompression window
to 64 MiB, limits source and decoded sizes to 512 MiB, and bounds its cache at
2 GiB and 1,024 entries. Readers without native Zstandard support report an unsupported-runtime
error for compressed input while retaining plain JSONL support.

Journal cursors refer to decoded JSONL bytes. Physical compressed-file offsets
from Capture Hook signals are not usable as decoded frontiers; durable terminal
records provide the boundary instead. Malformed, truncated or changed compressed
sources do not advance capture. Temporary decoded files are removed when the
reader stops normally. Active readers pin their snapshots; unused snapshots are
evicted when space is needed. Historical import re-materializes each batch from
the native source rather than retaining an evictable temporary filename. Each
batch rechecks root confinement and source identity before consuming the snapshot.
On startup, bounded cleanup removes recognized owner-private cache directories
from dead processes. Live-process directories and unknown contents are left
alone. These permission checks are validated on Linux; Windows ACL behavior
requires separate platform validation.

## Current Source Selection

For paginated sources, the watcher asks Codex `thread/read` with
`includeTurns: false` which physical rollout currently belongs to the logical
thread. Older files retained after a native revert are not selected by filename
or modification time. The metadata connection uses the configured `CODEX_HOME`,
not the isolated home used for capability inspection. It reuses a connection
while active and closes an owned helper after idle time or watcher shutdown.
It does not start a thread, run a turn or call a model. Background paginated
migration is disabled for the helper connection.

An unavailable helper, wrong home/identity or missing current file leaves
capture pending with a diagnostic. Metadata failures are bounded per Codex home
per scan, so one unavailable home does not suppress capture from another.
Koed does not read Codex's private SQLite schema directly. Configured roots in
the standard `sessions` or `archived_sessions` layout resolve to their own Codex
home and use a separate native metadata connection. At most eight owned
connections are retained. Secondary homes do not inherit the primary home's
`CODEX_SQLITE_HOME` override. Arbitrary copied-source directories cannot establish
a native home and remain pending rather than guessing a selected rollout.

Managed resume permits a changed rollout path only when native metadata
corroborates the selected file inside the configured Codex history directory.
The journal still verifies source identity and exact evidence before accepting
a rewritten generation; a matching logical thread ID alone is insufficient.

## Native Migration

A verified legacy-to-paginated rewrite creates a successor source generation.
The original signed journal and Captured Session are retained. Koed verifies
recognized native transformations against the exact previously journalled
evidence, including ordering, thread and turn IDs, timestamps and mapped fields.
It does not match conversations by approximate text similarity.

Both the journal admission boundary and the live processing frontier are mapped
into the rewritten source. History before the original admission boundary is
not added merely because Codex migrated the file. The rewritten admitted prefix
is preserved as evidence, but does not recreate old messages, Memory Events or
downstream work. Subsequent activity continues after the mapped frontier. The
successor identity binds the verified rewritten prefix; changed replay attempts
are rejected.

Automatic verification is bounded at 64 MiB and supports text messages,
image/audio attachments with their original ordering and detail, reasoning,
command/MCP/dynamic tool completions, patch results, web search, compaction,
review-mode, image-generation and subagent-activity conversions. Supported
legacy path, context and rate-limit normalization is verified against the same
source evidence; unknown native transformations remain blocked.
Synthesized implicit turns require complete originally admitted history,
including its header; headerless admission still requires an exact explicit
turn anchor. Canonical hook fragments require a retained native response ID.
Rollback verification supports a bounded event-only, explicit-turn subset with
complete admitted history. Rollbacks involving Responses boundary pairing,
compaction, retained context, inter-agent communication or overlapping turns,
id-less or noncanonical hooks, unclosed explicit turns and other unproven
mappings remain blocked. A pending old canonical cursor must catch up before a
rewrite transition.

A native revert can create a successor generation without deleting retained
Memory. Its `history_base` must resolve to an admitted physical rollout, and its
decoded byte and ordinal cutoff must agree with an exact boundary in retained
signed evidence. Native normalization can refer to an older physical rollout:
verification follows previously admitted generation closures and fork linkage,
not arbitrary files found beside the source. Ancestry proof is bounded at 32
generations, 64 MiB of evidence and 4,096 segment pages. A normalized physical
reference may skip an immediate logical fork parent, but its admitted logical
ancestry must still prove the inherited range. A subagent parent relationship
also requires an explicit retained physical reference and an unchanged
own-history fence; a parent ID alone is not enough. The new header is
retained as evidence; new activity is captured after it. Cutoffs outside the
retained admitted range, changed logical metadata and missing ancestry evidence
remain blocked rather than importing previously unauthorized history.
Replacement-recorder timestamps and CLI versions may change during revert;
they must remain valid metadata and do not replace the logical identity or
exact predecessor-cutoff proof.

## Replication

Paginated source generations use `codex-transcript-v2`; legacy sources retain
`codex-transcript-v1`. The versioned v2 source descriptor includes only the
native thread identity, history mode, thread kind and optional own-history
boundary needed to start parsing admitted bytes without a header. Existing v1
descriptors and signed segment formats are unchanged. A receiver that does not
support v2 must reject it rather than acknowledge incomplete processing.

Hosted and peer materialization preserve native item identity even when the
local Captured Session has a different external identifier. Native thread
identity is bound separately from the logical source generation identifier;
an established binding cannot be changed by a conflicting replay. Before skipping a
migrated prefix, the receiving worker requires the signed predecessor to be
completely materialized and verifies the same native transformation locally.
Missing predecessors remain pending; altered or unproven evidence does not
advance the consumer cursor. Personal Device Sync cryptographic membership/key
epochs are independent and are not reset by native history migration.
Native revert successors require the same physical-rollout and exact cutoff
proof on the receiving device before their header frontier is skipped.
