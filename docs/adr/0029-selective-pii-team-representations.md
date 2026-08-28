# Selective PII Team Representations

Status: Accepted.

Related decisions:

- [0004 Team Memory uses user-owned Share Grants and Workspaces](./0004-team-memory-workspaces.md)
- [0009 Commercial SaaS encryption and key management](./0009-commercial-saas-encryption-key-management.md)
- [0010 Managed SaaS queryable vectors](./0010-managed-saas-queryable-vectors.md)
- [0012 Symmetric replicated Personal Memory](./0012-symmetric-replicated-personal-memory.md)
- [0020 Portable Personal derived artifact replication](./0020-portable-personal-derived-artifact-replication.md)
- [0025 Team Conversation Source Access](./0025-team-conversation-source-access.md)
- [0028 Agent-directed Memory Answer retrieval](./0028-agent-directed-memory-answer-retrieval.md)
- [0030 Personal Semantic Work Is Computed Once And Replicated](./0030-single-personal-semantic-computation.md)

## Context

Personal Memory may legitimately contain names, addresses, credentials, and
other private identifiers that the owner wants to retain and recall. The same
content must not automatically enter Team-readable Conversation Source,
Memory Events, LCM Summaries, Curated Memories, lexical anchors, evidence, or
embeddings.

Duplicating the Personal database would multiply storage, Projection, LCM, and
embedding work. Redacting the canonical Personal source would instead destroy
owner fidelity. A model-only filter would also be an inadequate safety
boundary because privacy classifiers can miss novel secrets or misclassify
out-of-distribution text.

## Decision

The exact Conversation Source Journal and all Personal derived artifacts remain
the owner's canonical full-fidelity material. Koed creates sanitized,
encrypted Team representations only when content crosses a decryptable
non-owner boundary. Unshared Personal capture and Projection perform no privacy
classification work.

OpenAI Privacy Filter is the initial contextual classifier. Koed pins the model,
tokenizer, constrained Viterbi decoder, calibration, input-extraction contract,
and deterministic detector generation into one immutable classifier hash. One
inference records all supported labels. Versioned content policy then chooses
which detected spans to replace, so a policy-only change rematerializes from
cached encrypted spans without rerunning the model.

Privacy Filter augments rather than replaces deterministic structured-key and
credential-format detection. The union of deterministic and model spans is
applied using schema-aware field extraction. Canonical Team text uses fixed
typed placeholders rather than length-preserving masks. A classifier, offset,
schema, encryption, or policy failure leaves Team material pending or
unavailable and never falls back to Personal source.

Classification results contain no second plaintext copy. Their labels and
validated byte offsets are envelope encrypted and content-addressed within the
owner and trust boundary. Team material continues to use the existing encrypted
Share Grant representation and lifecycle tables.

Personal Device Sync may transport exact source only inside end-to-end
encrypted packages that the relay and authority cannot decrypt. An explicitly
selected owner-authorized hosted Personal backend may process exact encrypted
Personal source solely for that owner. Team-visible paths receive only
sanitized source or representations, even when the Personal and Team data
planes run in the same managed service. A user-operated private server follows
the same distinction according to Operator policy.

Every synthesized Team surface is classified independently. In particular,
LCM titles, summary text, lexical anchors, Curated Memory fields, and expansion
material are classified even when their source Memory Events were already
classified. Personal lexical anchors may contain private identifiers, but LCM
prompts must not deliberately promote credentials or other `secret` values.

Team representation choice is a maximum-fidelity ceiling:

- `memory_events` authorizes Memory Events plus complete leaves and rollups
  derived from the same source frontier;
- `lcm_leaves` authorizes complete leaves plus complete rollups; and
- `lcm_rollups` authorizes rollups only.

Conversation Source Access and consent-bound Curated Memories remain separate.
Every materialized layer has its own current, complete, sanitized, encrypted,
and authorized state. Absence of a derived layer does not permit substitution
with finer source.

Embedding reuse depends on a canonical final-input fingerprint. An unchanged
Team input reuses the Personal embedding computation under an authorized worker
lease. A changed input receives one Team-safe embedding. Policy or classifier
generation changes rematerialize provenance but do not rerun embedding when the
final input and embedding generation are unchanged. Grant-scoped vector rows
may remain physically separate to preserve indexed authorization and
revocation.

Transient classifier and embedding-service outages do not convert Team
material into terminal failures. Retry state and the next eligible attempt are
persisted with the target; PostgreSQL notifications handle new work and one
exact timer wakes the earliest deferred target, abandoned-claim expiry, or
stale outbox lock. In-process failures use bounded retry backoff, and long
inference and finalization work heartbeat their PostgreSQL-clocked fenced
claims. Stale Team representations are invalidated from current database state
before any external Privacy Service preflight, so an outage cannot preserve
material governed by superseded source, authorization, classifier, or policy
bindings. Contract, binding, schema, and other deterministic failures remain
terminal and fail closed.

## Consequences

- Personal Memory retains full fidelity and Personal search behavior.
- Team-visible source and semantic content are independently sanitized before
  decryptable egress.
- Continuous Conversation Source sharing classifies only newly committed
  immutable records. Semantic Memory Event and LCM revisions reuse unchanged
  bounded classification chunks, classify only changed or newly appended
  chunks, and bind their ordered immutable results into one expected manifest
  and one complete result manifest for the revision. Each chunk survives
  restart independently. No partial manifest is Team-visible.
- Most shared items require one privacy-classifier pass but no second embedding
  inference.
- The product hardware preference applies to Privacy inference as well as
  embedding. The Privacy Service verifies its own platform provider and unloads
  accelerated model memory after five idle minutes by default; provider failure
  continues to fail Team materialization closed.
- Generated summaries require their own classifier pass because synthesis can
  restate or introduce sensitive text.
- Privacy model assets, encrypted span results, and changed Team representations
  add bounded storage without duplicating the Personal database.
- A Privacy Filter outage does not block Personal capture, Projection, LCM, or
  Recall, but it does block new Team materialization.
- Privacy work uses durable foreground/background scheduling, bounded quanta,
  fenced leases, PostgreSQL wake notifications, and an exact deferred-retry
  timer. Share-blocking work runs first, while the oldest background job is
  promoted after a bounded wait. Scheduling and claims never confer access.
- Final publication rechecks source, consent, policy, Workspace authority, and
  every encrypted classification binding in one transaction before the single
  complete sanitized payload becomes ready.
- Whole-preview reconstruction is serialized across Worker processes by one
  crash-released PostgreSQL advisory-lock slot. Peak-memory telemetry governs
  any future capacity change; target count alone is not sufficient evidence.
  The maximum-preview capacity fixture measures the full 64 MiB
  classification-text ceiling and has demonstrated a transient heap delta in
  the hundreds of MiB, so the initial deployment-wide limit remains one.
- Migration `0034` is the internal alpha selective-PII baseline. It refuses
  populated legacy
  Team-sharing rows whose unsanitized content cannot be given truthful privacy
  provenance. Test data must be reset before applying it; Personal canonical
  source is outside that reset boundary. Release migrations will be collapsed
  into the supported initial schema before the first stable release.
- Koed describes this as exposure reduction and data minimization, not as a
  guarantee of anonymization or complete secret detection.

## Rejected Alternatives

### Redact the canonical Personal source

Rejected because it destroys owner fidelity and prevents Personal retrieval of
content the owner intentionally retained.

### Duplicate the Personal database

Rejected because it duplicates ingestion, Projection, lifecycle, LCM, and
embedding work while creating reconciliation risk.

### Run the classifier on every Personal capture

Rejected because unshared data would consume model compute and generated LCM
output would still require independent classification.

### Trust Privacy Filter as the only secret boundary

Rejected because the model documents false negatives, false positives,
language limitations, and novel-secret failure modes.

### Store length-preserving star masks as canonical Team text

Rejected because they disclose value shape and length and reduce semantic
utility. A UI may render typed placeholders as stars without changing stored or
embedded Team content.
