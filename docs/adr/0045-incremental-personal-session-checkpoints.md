# Incremental Personal Captured Session checkpoints

Accepted 2026-09-15. This amends ADR-0012 and the closed-session-only publication
boundary in the Personal Device Sync protocol. A completed AI Client turn should
become available on the User's other Personal devices automatically, while the
originating Conversation remains resumable. Completing a turn does not close a
Captured Session permanently.

## Decision

Publish immutable, signed cumulative checkpoints at durable completed-turn
boundaries. A checkpoint contains a prefix of the Captured Session's source
records, the stable source identity, its own ordinal, and the previous
checkpoint's closure hash. A receiving device verifies the signature, ordering,
and unchanged prefix before extending one read-only local Captured Session.
Only the originating device can extend that source. Duplicate delivery does not
create another Session or duplicate items; a missing predecessor waits for
catch-up. Conflicting source history fails closed.

The new `version: "2", profile: "cumulative_checkpoint"` manifest profile is explicit and distinct
from the existing immutable closed-session manifest. It reuses encrypted package
transport, membership, recipient keys, durable outbox/inbox, and acknowledgements.
Older receivers reject the new manifest rather than interpreting a checkpoint
as permanent closure. Upgrade both devices before testing checkpoint sync.

The initial implementation sends cumulative prefixes rather than compact deltas.
This simplifies verification and recovery using the existing package machinery,
at the cost of repeated bytes and the existing package-size limit. Delta encoding
can be added under a future explicit profile; it must preserve the same source
identity and prefix integrity guarantees.

When membership changes, the originating installation queues retained checkpoints
for the current recipients, including predecessors needed by a newly paired
device. It retains the signed source manifest inside encrypted local storage and
rewraps transport encryption for the current epoch without changing source
identity or signatures. Retries remain idempotent; former members do not receive
new epoch transport.

## Capture and visibility

Publication follows durable capture completion evidence, not an idle timer or
terminal-process exit. Pi final assistant records, Codex completed-turn records,
and Claude Code's journalled completion frontier provide the corresponding
boundaries. Capture Policy and Personal Sync Policy remain required. Automatic
publication covers Sessions created after Personal Sync Policy activation;
linking a device does not authorize historical import.

Received checkpoints preserve the source AI Client and verified origin device.
They appear in local session inspection with the installation's device nickname,
and undergo local Projection for Personal Memory. They do not grant Team access
or let the receiving installation resume or edit the originating Conversation.

The internet-accessible relay, restricted-network traversal, and transfer of
content authority remain deferred. The existing LAN/Tailscale transport applies.
