# ADR 0029: Model Conversation Sources as Verified Component Sets

## Status

Accepted

## Context

An AI Client Conversation is not necessarily represented by one file. Claude
Code can retain a main transcript, subagent transcripts, and referenced
sidecars. Treating one path as the Conversation Source would either lose
provider evidence or publish a partially captured Conversation as complete.

Managed continuation also has two distinct meanings. The source owner may
resume the same provider session when its identity and source continuity are
verified. Another User may inspect an authorized source, but continuing it
must create a fork with a separate provider session and Memory lifecycle.

## Decision

Koed models a logical Conversation Source generation as a deterministic set of
components. Every component has a stable logical ID, primary or auxiliary role,
optional parent component, framing, byte frontier, and content digest. Local
absolute paths are reader-only metadata and never form portable identity.

The generation is publishable only when every component in its signed closure
manifest is present and verifies. Append, retry, replication, Personal Device
Sync, and authorized sharing preserve component identity and fail closed on a
missing, extra, mutated, reordered, or cross-generation component. New source
formats extend the component manifest rather than adding a provider-specific
single-file path.

Resume is permitted only for the source owner against the same AI Client
instance, provider session, Project identity, and continuous verified source.
Only one device may hold writable authority for that provider session. A
portable continuation after explicit transfer preserves the provider session
only after the complete source and execution authority are restored.

Viewing another User's authorized Conversation Source is read-only. A request
to continue it is an explicit Fork/Import: Koed asks the provider integration
to create a distinct session, journals a new logical source, records provenance
to the parent, and never writes to the parent's component set.

## Consequences

- Capture cannot finalize solely because the main transcript emitted a terminal
  event; the complete discovered component set must first become stable.
- Replication and download authorization operate on a generation manifest and
  its components, not an assumed primary file.
- Derived Memory may be rebuilt from a verified source, but reusable portable
  derived artifacts can sync independently to avoid needless recomputation.
- A source-generation closure is immutable. Later bytes create or extend the
  appropriate active generation under the source protocol rather than mutating
  a published closure.
- Provider-specific resume mechanics stay behind the AI Client Driver while
  Koed owns authorization, exclusivity, lineage, and durable identity.
