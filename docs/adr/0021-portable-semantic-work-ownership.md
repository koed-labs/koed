# Portable Semantic Work Ownership

Status: Accepted.

Related decisions:

- [0015 Managed Conversation Execution And Realtime](./0015-managed-conversation-execution-and-realtime.md)
- [0016 Exclusive Execution Handoff And Fork Lineage](./0016-exclusive-execution-handoff-and-fork-lineage.md)
- [0020 Portable Personal Derived Artifact Replication](./0020-portable-personal-derived-artifact-replication.md)

## Context

Personal Device Sync can place the same canonical Conversation source on
multiple enrolled devices. Projection, embedding, and LCM summarisation are
expensive derived work. If every replica independently processes the same
source, devices waste compute and can publish incompatible results.

Managed Conversation execution already has exclusive write authority,
generation fencing, handoff, and explicit fork lineage. That authority does not
by itself coordinate background semantic work, and physical queue leases are
not portable identities.

## Decision

Koed distinguishes:

- **Conversation execution authority**, which controls who may append source;
- **semantic work authority**, which controls who may publish one derived
  result for one stable logical input; and
- **artifact compatibility**, which controls whether another device may reuse
  that result.

### Stable Semantic Identity

Semantic work is identified without local database IDs:

- Projected Memory Event identity binds the source fingerprint, source-closure
  hash, ordered source-item ordinals, Projection policy key and revision, and
  canonical event-content hash.
- Memory Event embedding identity additionally binds chunk index/count and the
  complete embedding contract.
- LCM leaf identity binds the ordered logical Memory Event identities in its
  exact source range and the LCM contract.
- LCM rollup identity binds the ordered logical child-node identities and the
  LCM contract.

The LCM contract includes node kind, algorithm version, prompt version,
summary model, structured-output schema, and source-selection policy. Corrected
summaries have a distinct revision identity.

### Claims And Fencing

An enrolled device claims one stable semantic-work identity for a bounded
period. A claim contains the group, work identity, work class, claimant device,
claim generation, compatibility contract hash, claimed time, and expiry.

Claim acquisition and renewal are compare-and-swap operations under the
Personal Device Group authority. Every published artifact carries the claim
generation. A stale claimant cannot publish after the claim is replaced.
Expiry makes work reclaimable but does not authorize Conversation source
writes.

Queue jobs and process leases remain local implementation details.

### Preferred Worker

The device holding managed Conversation execution authority is preferred for
Projection and owns LCM work on that Conversation. After handoff, the unfinished
LCM frontier is reconstructed from ordered logical Memory Events and complete
leaf coverage under the transferred source authority.

Embedding work may be claimed by another active enrolled device when the
execution device does not advertise a compatible ready embedding capability.
Capability advertisements are bounded, signed state containing the exact
embedding contract and readiness, not arbitrary host telemetry.

New embedding claims require a fresh `ready` advertisement for the exact
contract. Renewal preserves claimant, work class, contract, and source binding;
it cannot retarget an existing generation. A synchronized Memory Event or LCM
node enters a device's embedding queue only while that exact active claim names
its local mapped source and current content hash.

If no compatible device is available, source and Memory Events remain durable,
lexical Recall remains possible, and embedding work stays pending.

### Handoff And Fork

A handoff transfers Conversation write authority. The target reconstructs and
continues the same logical source range.

A fork closes the parent's pending LCM range at the fork boundary, even when it
is below the normal count or token threshold. The child begins a new source
lineage with an empty frontier. Shared pre-fork artifacts may be reused by
identity; post-fork artifacts cannot cross branches.

Returning execution to another device is a handoff, not a fork.

### External AI Clients

For Conversations written outside Koed-managed execution, the transcript
remains authoritative and the Transcript Watcher catches up idempotently.
Koed cannot prevent two independently writable external transcript copies.
Conflicting source closures are quarantined; they are never silently merged or
resolved by last writer.

## Consequences

- Multiple devices can reuse expensive work without accepting ambiguous local
  row identities.
- Handoff preserves LCM progress instead of restarting compaction.
- Devices without embedding capability can delegate only the missing semantic
  work.
- Coordination remains safe across crashes because publication is fenced.
- Compatibility changes create new work identities rather than mutating old
  results in place.

## Non-Goals

This decision does not:

- turn PDS into PostgreSQL replication;
- transfer process ownership, queue jobs, or runtime credentials;
- permit a semantic-work claim to grant Conversation write authority;
- infer that independently modified external transcripts are one Conversation;
- make incompatible model outputs interchangeable.
