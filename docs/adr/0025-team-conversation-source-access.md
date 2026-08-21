# ADR 0025: Team Conversation Source Access

- Status: Accepted
- Date: 2026-08-10

## Context

Captured Session Share Grants expose semantic layers within a selected
maximum-fidelity ceiling: Memory Events, LCM leaves, or LCM rollups. Koed also
retains exact AI-client source records in an encrypted, signed Conversation
Source Journal for reconciliation and portability. A Team member may need to
watch an owner's Conversation as it develops or explicitly fork a completed
source snapshot, but semantic sharing must not silently expose this
higher-fidelity material.

Treating source bytes as a fourth expansion level would couple two different
decisions. It would also make a representation change unexpectedly grant or
remove access to prompts, tool calls, tool results, and other retained records
that Projection intentionally excludes from Memory.

## Decision

Koed models Conversation Source Access as an explicit capability attached to
an existing active Captured Session Share Grant. It is not a semantic
representation and defaults to absent.

The owner chooses one of two modes:

- `snapshot` pins the current verified artifact and committed segment frontier.
- `continuous` follows verified generations of the same logical source.

Every manifest, segment, stream, and fork request re-evaluates the authenticated
User, Team and Workspace lifecycle, entitlement, enabled membership, Workspace
read access, active parent Share Grant, active source-owner consent, active
source grant, and valid artifact lifecycle before protected bytes are resolved.
Personal API Tokens cannot grant, revoke, read, stream, or fork Team-visible
source. Granting requires fresh browser step-up or an exact one-use Action
Grant created through that step-up. Revocation uses Native review or an
authenticated browser session.

Personal deletion and source-owner account disablement remove source access
unless an applicable retention decision preserves the sanitized Conversation
Source Artifact. No Team retention decision makes exact Personal source
readable.

The exact Conversation Source Journal remains unchanged and owner-only.
Enabling Conversation Source Access creates or reuses a separately encrypted,
sanitized Conversation Source Artifact bound to the source generation and
frontier, pinned classifier generation, effective versioned eight-label content
policy, and sanitized artifact digest. The contextual classifier is combined
with deterministic structured-key and credential-format detection. Failure to
validate classifier identity, offsets, schema, policy, or encryption leaves
Team source pending or unavailable and never substitutes exact Personal source.

Continuous viewing uses durable database state plus PostgreSQL notifications
and SSE. Notifications carry structural wake metadata only. Clients resume
with an opaque viewer-bound cursor and fetch verified sanitized source segments
through authorized routes. There is no data polling and no plaintext in the
durable event envelope. Authorization loss closes the stream.

Forking is an explicit export operation, not participation in the owner's
Conversation. It requires a fresh browser session, enforces segment and byte
limits, verifies the sanitized source chain, and ends at a completed turn
boundary. The result includes lineage headers for the caller's AI Client or
later Koed import flow. Koed does not mutate the source Conversation, and the
fork cannot recover the owner's original values.

Source grants, reads, stream opens, revocations, and fork exports are audited
without logging plaintext, credentials, encryption envelopes, local paths, or
raw source labels.

## Consequences

Owners can share semantic Memory without sharing exact source records, and can
revoke source access without revoking semantic Team Memory. A continuous grant
can support read-only live observation while preserving one Conversation owner.
Forking creates a separate future lineage outside this read-only relationship.

The Source Journal remains the sole exact Personal source. Sanitized Team
artifacts are derived sharing material, not a second ingestion path or an
independently evolving Personal source. No Team plaintext cache or polling
worker is introduced. Privacy filtering reduces exposure but does not guarantee
anonymization or complete secret detection. The owner-wide Shares detail
presents source access as a separate absent, snapshot, continuous, or revoked
capability; semantic status and fidelity changes never alter it implicitly. UI
work is independent and is not part of this decision.
