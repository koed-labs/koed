# Transaction visibility in Personal selection cursors

Status: Accepted

## Context

A Personal selection consumer needs bounded pages and a durable checkpoint for
missed changes. Capture, source correction, membership edits, and verified sync
receipt use different transactions. A database sequence allocates IDs before
commit. A slow writer can therefore commit a lower journal ID after another
writer's higher ID has already been observed.

Serializing all source writes on a new owner counter would add a lock to capture
and require consistent ordering across existing source and sync transactions.
An external change-data-capture service would add another local dependency.

## Decision

Retain a local metadata journal with top-level PostgreSQL transaction IDs.
Each owner-bound cursor stores a transaction visibility snapshot. A change
window compares its starting and ending visibility sets and uses the journal
ID only to paginate within that fixed window. Advance the checkpoint after all
pages in the window have been consumed.

A transaction active at the ending snapshot remains outside that window, even
if it later commits a lower ID. It remains visible to a subsequent window.
Rolled-back changes produce no committed journal rows. PostgreSQL documents
that `pg_current_xact_id()` returns the top-level ID even within a savepoint;
`pg_visible_in_snapshot()` must receive that ID, not a subtransaction ID.
See the [PostgreSQL transaction snapshot reference](https://www.postgresql.org/docs/17/functions-info.html#FUNCTIONS-TXID-SNAPSHOT).

Enumeration pages recheck their baseline against the current committed journal
in the same database snapshot used to select sources. A changed baseline is
rejected rather than combined with later membership. Opaque cursor records
freeze their owner, selection, visibility window, page key, and expiry.

Notifications contain bounded metadata categories and event IDs. They can
invalidate an owner's selection conservatively; re-enumeration determines the
actual selected sources. They do not authorize sharing or source-body reads.

## Consequences

Source writes do not acquire a new owner sequence lock. Consumers can recover
missed updates and late commits across service and connection restarts. They
must finish a change window, deduplicate event IDs on retry, and replace a
provisional membership map only after a complete enumeration. Unrelated owner
activity can cause an unnecessary refresh or a stale enumeration.

Cursors depend on the same PostgreSQL transaction history and expire after
24 hours. A logical restore into a new database must discard cursor records
and obtain new baselines. Cursor metadata is not a portable sync artifact.
The metadata journal remains retained. Future pruning must prove that removed
transactions are already visible to every active cursor that could need them;
a creation-time cutoff alone cannot prove that for a long-running writer.
