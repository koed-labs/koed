# Personal Semantic Work Is Computed Once And Replicated

Status: Accepted.

Related decisions:

- [0012 Symmetric Replicated Personal Memory](./0012-symmetric-replicated-personal-memory.md)
- [0014 Hosted Personal Replication Uses The Conversation Source Journal](./0014-hosted-personal-source-replication.md)
- [0020 Portable Personal Derived Artifact Replication](./0020-portable-personal-derived-artifact-replication.md)
- [0021 Portable Semantic Work Ownership](./0021-portable-semantic-work-ownership.md)
- [0029 Selective PII Team Representations](./0029-selective-pii-team-representations.md)

## Context

The same logical Personal source can exist on its origin device, other enrolled
Personal devices, and an owner-authorized hosted Personal backend. Repeating
embedding inference and LCM synthesis at every replica wastes CPU, GPU, AI
Client usage, energy, and time. It can also produce incompatible derived
results for one logical input.

Personal Device Sync already defines portable Memory Event, embedding, and LCM
artifacts plus fenced semantic-work claims. Hosted Personal Source Replication
currently treats semantic data as deployment-local derivation, so it does not
share that ownership contract. LCM workers also acquire only a process-local
lock before synthesis, while PDS claims completed LCM output after synthesis.

Team materialization creates a second valid semantic input only when privacy
sanitization changes the Personal input. Authorization may require separate
physical vector rows without requiring repeated model inference.

## Decision

Koed accepts one semantic computation per stable Personal work identity and
compatible contract, then distributes the accepted result as an encrypted
portable artifact.

### Identity And Compatibility

The topology-neutral work identity binds:

- owner and origin logical source and generation;
- stable logical Memory Event or LCM source-range identity;
- canonical source-content or source-closure hash;
- semantic work class; and
- the complete compatibility contract.

Embedding compatibility includes model artifact, tokenizer, input transform,
prompt prefix, dimensions, pooling, normalization, and serialization
generation. LCM compatibility includes node kind, ordered logical sources,
algorithm, prompt, model, structured-output schema, and correction revision.

Local database IDs, paths, hostnames, Team identifiers, queue jobs, and process
leases are not semantic identity.

### Authority, Preference, And Fencing

Exactly one reachable authority coordinates a work identity at a time:

- the Personal Device Group authority coordinates PDS-only topology; or
- the owner-authorized hosted Personal backend coordinates hosted topology.

A claim records claimant type and identity, preference tier, compatibility
hash, monotonic fencing generation, claimed time, heartbeat, expiry, and state.
The accepted artifact records the current fencing generation and producer
attestation. Only the current claimant may complete work. Late or stale
completion is rejected.

When Hosted Personal Source Replication is explicitly enabled and the backend
advertises the exact compatible embedding capability, the hosted backend owns
new Personal embedding work. A Personal device does not start competing local
inference while that policy remains active. The User or Operator must disable
or retarget the policy before local authority resumes.

Artifact acceptance revalidates the policy generation, selected upstream,
owner, and canonical source-content hash immediately before the local write.
A remote completion that raced a policy or source change is rejected as stale.

If the common authority is unreachable, a replica may continue offline Recall
from already accepted artifacts but must not start competing semantic
inference. Immediate partition fallback and a guarantee of one computation are
mutually exclusive.

### Embedding Artifacts

The claimant publishes an immutable `memory_embedding/v1` artifact. A PDS
producer signs the artifact with its enrolled device identity. A hosted
Personal backend returns the artifact only through the authenticated sync
device route, envelope-encrypted to the enrolled recipient deployment and
bound to the owner, source-content hash, complete compatibility contract, and
recipient key. TLS, the scoped device credential, authenticated encryption,
and those payload hashes are the direct hosted producer attestation; the
hosted backend is not represented as a PDS device.

An authorized device verifies the applicable producer authority, owner,
logical source, source closure, canonical input hash, compatibility, fencing
generation where present, lifecycle floor, recipient binding, and payload
digest before import. It rebuilds its deployment-local vector index from the
imported vector without calling the Embedding Service. If the accepted hosted
result later enters PDS, the enrolled serving device signs the PDS artifact and
records hosted origin provenance; the PDS signature attests that device's
verified import rather than making the hosted backend a group member.

### LCM Artifacts

One connected Local AI Runtime acquires the durable fenced LCM claim before
invoking its AI Client. It renews the lease during synthesis and submits the
result with the claim generation. The authority accepts one result and rejects
stale submissions.

The backend may coordinate LCM work but does not call an LLM. Accepted
`lcm_node/v1` artifacts are distributed to authorized Personal replicas and
indexed there without another synthesis call.

### Team Privacy Derivatives

If a Team-safe embedding input is byte-identical to the accepted Personal input
under the same compatibility contract, Koed reuses the accepted vector. If
sanitization changes the input, Koed computes one Team-safe vector within the
authorized owner, Team, policy, classifier, source-revision, and compatibility
boundary, then reuses it for equivalent grants.

Physical Team vector rows remain grant-scoped. No cache or equality lookup may
cross owners or Teams or become a plaintext correlation oracle. A Team-safe LCM
representation is a deterministic post-filter of the accepted Personal LCM
artifact and never causes a second LLM synthesis.

### Transport Separation

Hosted Personal Source Replication and Personal Device Sync keep separate
authentication, encryption, outbox/inbox, lifecycle, and anti-entropy
protocols. They share semantic identities, compatibility validation, producer
attestation, and portable payload schemas. A transport delivers an accepted
artifact; it does not become semantic-work authority.

Registering a Team backend, joining a Team, linking a Project to a Workspace,
or creating a Share Grant does not enable Hosted Personal Source Replication or
authorize exact Personal semantic artifacts.

## Consequences

- Compatible embedding inference and LCM synthesis are not repeated per
  deployment.
- Offline Recall remains available from imported artifacts.
- A reachable authority is required before starting new semantic inference.
- Hosted Personal storage gains owner-private, authenticated,
  recipient-encrypted semantic artifacts and download/fanout state.
- Deployment-local rows and indexes remain independently rebuildable and
  authorization-scoped.
- Compatibility changes create new work identities instead of coercing old
  artifacts.
- Crash recovery may produce more than one attempted call near lease expiry,
  but fencing permits one accepted result.

## Rejected Alternatives

- Recompute every embedding and summary from replicated source.
- Replicate PostgreSQL tables, queues, indexes, or process leases.
- Treat the hosted Personal backend as an enrolled PDS device.
- Allow local inference during an authority partition and claim exactly-once
  computation.
- Reuse Team Share Grant caches as Personal artifact authority.
- Deduplicate by a global plaintext or vector hash.
- Run backend LLM synthesis for LCM.
