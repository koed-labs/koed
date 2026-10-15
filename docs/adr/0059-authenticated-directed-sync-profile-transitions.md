# Authenticated Directed Sync profile transitions

Status: Accepted; implementation and release validation are tracked by ticket 16.

## Context

Captured Session Sync V2 requires an explicit repository snapshot. V1 uploads may
already exist on the source, target, or both. Their encrypted bodies must remain
unchanged. A relationship accepts package sequences contiguously, and upload
sequence and idempotency keys are unique. Replacing a V1 body under the same
sequence would break those commitments. Skipping the source sequence alone would
strand the receiver. Keeping a V1 body reader would violate the coordinated alpha
cutover.

## Decision

Use a separate authenticated control request to reconcile one retained V1 upload.
The request binds the relationship, protocol package ID, sequence, cursor range,
request hash, package checksum, and manifest digest. It carries no memory body.
The target requires the relationship's current scoped Device Credential and
principal binding, and holds the relationship lock throughout the transition.

If retained metadata proves the package was applied, the receipt records
`applied` and its completed cursor. Otherwise the target can record `superseded`
only for the next sequence at its current processing cursor. This consumes the
sequence without advancing the data cursor. Existing V1 uploads and chunks are
retained. Unapplied uploads become superseded; stale inbox claims are cancelled.
An applied upload remains completed. The target is stale until current-profile
synchronization establishes readiness.

The receipt is immutable and unique by relationship/package and
relationship/sequence. An identical request returns the original receipt.
Conflicting requests fail. Current upload admission cannot reuse a consumed
sequence, and superseded uploads cannot accept or verify more chunks. Pause,
revocation, credential, and principal fences remain binding on receipt replay.

The source must validate the authenticated receipt against its exact retained
request before advancing local sequence state. For a superseded upload, it keeps
the data cursor and publishes V2 at the next sequence. For an applied upload, it
adopts only the proven completed cursor. Both paths must preserve old encrypted
bytes and durable queue history, then schedule the current repository snapshot.
Source-side adoption and worker integration remain release gates until tested.

## Consequences

This adds a durable receipt and explicit retirement operation. It avoids a legacy
body reader, ciphertext rewriting, sequence reuse, database resets, and automatic
historical reassignment. An inconsistent retained state fails closed rather than
being inferred from a timeout or missing acknowledgement. Existing Team grants
and Workspace authorization remain independent.

The target native metadata fixture exercises absent, partial, and completed
uploads, replay and conflicts, retained chunks, queue fencing, credential denial,
and next-sequence V2 admission. It does not substitute for the final source/target
worker rehearsal with retained V1 packages.
