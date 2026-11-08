# Peer-Online Deletion Completion

Status: Accepted. This decision defines how a group-wide deletion is confirmed
and completed in the peer-online profile; it does not mean the profile is
implemented or available.

Related decisions:

- [0066 Peer-Online Personal Device Sync and Group Governance](./0066-peer-online-personal-device-sync.md)
- [Peer-online sync protocol](../peer-online-sync-protocol.md)

## Context

A User-requested Session deletion is group-wide. ADR 0066 and the protocol
require that a receiving installation applies a deletion durably before
acknowledging, that deletion floors are retained for the life of the group, that
offline devices remain pending until they acknowledge, and that revocation does
not prove a device deleted data.

The existing foundation records a permanent local deletion intent and floor,
hides local source and derived Recall data, and prepares a signed deletion
record. A deletion record is valid only when its author is an active member at
the receiver's current membership head, so a record goes stale whenever
membership changes and must be re-signed with the same deletion identity.
Nothing yet defines who must confirm a deletion, what confirmation is, how
delivery is retried, or when a deletion is complete.

There is no durable intermediary mailbox: deletions travel only between peers
that are online together, and checkpoints may be relayed by a peer other than
their origin.

## Decision

**Identity.** A deletion is identified by its group, origin device, origin
Session, Session key and event ID. All correlation, duplicate detection and
acknowledgement use this identity, never the hash of a particular signed
record. A record re-signed at a newer membership head is the same deletion.
The original floor is never replaced.

**Acknowledgement.** A recipient confirms a deletion with a signed
`koed/peer-online-deletion-ack/v1` record naming the deletion identity, the
recipient device, the hash of the floor it holds and its membership head. It is
emitted only after the floor and the hiding of source and derived Recall data
have committed, for an accepted deletion or an identity duplicate. It is never
emitted for pending, invalid, fenced, quarantined or different-identity
results. Because it is signed, an acknowledgement can be relayed by another
member and kept as durable evidence. It is verified against the recipient's
historical signing key, so an acknowledgement signed before the recipient was
revoked remains valid evidence.

**Recipient roster.** When a deletion is requested, every other active member
at the current head becomes a pending recipient, in the same transaction as the
local intent and floor. A member admitted later is added as a pending recipient
for every existing deletion, because it could otherwise receive the Session
from a peer that has not yet applied the deletion. A revoked recipient that has
not acknowledged becomes "revoked, not confirmed"; it is never treated as
confirmed. A confirmed recipient stays confirmed except through restore
quarantine.

**Delivery and retry.** On each authenticated peer session, membership is
exchanged first, then that peer's pending deletions, then checkpoints. Before
sending, the record is revalidated at the current head and re-signed if stale.
Delivery retries with capped exponential backoff and immediately on each new
session, without giving up. An uncertain delivery is retried; identity
duplicates make retry idempotent.

**Authorship.** Any active member that holds the deletion floor may re-sign the
deletion with its own key at the current head and deliver it. Delivery does not
depend on the requesting installation remaining a member or online.

**Completion.** A deletion is complete when every recipient has acknowledged or
is revoked and not confirmed, and is reported distinctly in the latter case.
Completion stops active retries only. The floor, the deletion record and the
local intent are retained for the life of the group so the deletion can still
be served to late joiners and relays.

**Restore.** Losing acknowledgements through sender rollback is safe and causes
redelivery. Losing an applied floor through recipient rollback is a
resurrection risk addressed by restore quarantine: after quarantine, a
recipient must re-obtain all deletion floors from peers before accepting
checkpoints. Senders do not reopen confirmed recipients by themselves.

## Consequences

- Deletions can stay pending indefinitely while a recipient is offline; this is
  visible status, not an error.
- Acknowledgements are evidence of a recipient's own claim; they cannot prove
  erasure on a device that later misbehaves or is restored from backup.
- Every membership change can require re-signing pending deletions, and any
  member may perform it.
- Roster rows grow with members times deletions and are never compacted while
  the group exists.
- Existing receivers must treat identity duplicates as acknowledgeable, which
  changes the earlier `deleted` result for a re-signed record.

## Alternatives considered

- **Acknowledgement only as a reply on the authenticated session.** Simpler,
  but it cannot be relayed or audited and ties evidence to one connection.
- **Fixed roster at request time.** Smaller, but a member admitted later could
  receive and resurrect deleted Memory from a lagging peer.
- **Only the requesting installation may sign.** Simpler custody, but a deletion
  stalls permanently if that installation is revoked or never returns.
- **Treat revocation as completion.** Rejected: revocation does not show that a
  device deleted anything.
