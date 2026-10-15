# Signed checkpoint profile baselines

Status: Accepted; implementation and release validation are tracked by ticket 16.

## Context

Personal Device Sync has already published signed cumulative checkpoint chains.
The repository-assignment preparation emits V3 checkpoints, while earlier chains
use V2. Existing encrypted packages and checkpoint ledgers must survive the
Project cutover. An offline or newly paired receiver cannot depend on decoding
all earlier profiles. Resetting ordinals would collide with immutable ledger
entries and would obscure the existing source identity.

## Decision

The released cumulative checkpoint manifest uses version 4. Its required
`profileTransition` field is null for ordinary checkpoints. One upgrade baseline
can instead carry a signed boundary containing `previousProfile` set to
`pre_repository_cutover`, the exact previous manifest and closure hashes, the
previous source sequence, and the previous checkpoint ordinal. The new ordinal
is the previous ordinal plus one; the source sequence increases. The logical
Memory identity, source fingerprint, deletion floor, and source Session identity
remain unchanged. No old manifest reader is added.

A separate database profile epoch distinguishes retained pre-cutover state from
current publications and materializations. Adding this metadata does not rewrite
signed packages. The publisher can issue its baseline without waiting for a new
turn. It retains the complete raw prefix and records the new epoch atomically
with publication.

An authenticated baseline can establish the current profile at a nonzero ordinal
for an offline receiver. A receiver with an older materialization preserves its
entire verified prefix and source identity. A boundary referencing its known head
must match that head's immutable manifest hash, closure hash, and sequence. A
receiver that missed older checkpoints can advance only through the signed
baseline while preserving its known prefix. Current-profile receivers continue
to require ordinary contiguous append; they accept a repeated baseline only as
an exact replay.

Database append guards admit a nonzero baseline or an old-to-current epoch
transition only within the trusted receiver transaction. This does not grant
access, change Workspace selection, replace a User override, or resolve
historical-unresolved assignment.

## Consequences

The release must coordinate producers, secure-runtime signing, readers, database
metadata, and fixtures. Retained ciphertext and ledgers remain available for
provenance, without making old profiles executable by the current reader.

Rewriting signed history would invalidate signatures. Resetting ordinals would
require replacing or renaming ledger history. Keeping legacy readers would
violate the coordinated alpha cutover. Requiring all old predecessors would
strand offline receivers. The signed baseline avoids these outcomes while
retaining source and prefix fences.

This decision covers cumulative checkpoint chains. Previously closed source
publication and persisted directed-sync upload transitions remain explicit
integration checks in ticket 16; they are not declared complete by this ADR.

## Validation

The dedicated pre-0058 source migration fixture uses a signed V3 publication
created by the prior publisher. It verifies rollback on build failure, exactly one
V4 baseline without additional turns, unchanged retained ciphertext and source
item mappings, and a later ordinary checkpoint after native Pi capture resumes.
The Session remains historical-unresolved throughout. The companion receiver
migration fixture covers retained source bytes, replica identity, and ledger
continuity across the same database migration.
