# Presentation Agents reuse native execution and Memory

Accepted 2026-10-14 from the User’s revised product decisions.

## Decision

Keep humanized Agents: stable identity, name, optional free-text job title and
Pixelkin appearance. Remove role-derived instructions, soul text and profile
model/effort defaults from new identity writes and the editor. A job title is
metadata, not an instruction or permission. Model, reasoning, device and access
remain explicit conversation or task settings.

Reuse the existing managed native command lifecycle. New requests do not create
an Agent Job or require the model to send assignment, phase or completion tools.
Project work history is an authorized read of native commands/deliveries, merged
with retained legacy records. Existing leases, generation checks, idempotency,
source identity and uncertain-outcome protections remain execution concerns.

All AI chat recall uses the supported native `memory_answer` flow. Remove the
alternative eager named/generic searches and injected evidence policies. The
canonical Memory flow retains authorization, scope and its own failure behavior;
Agent appearance does not choose another policy. No backend LLM synthesis is
introduced.

Keep the progress panel using native runtime events, public summaries and
labeled diffs. Local/hosted Personal launch resolution shares one implementation.
Sequential same/cross-provider conversations and bounded public context remain
under ADR-0047; they coordinate native sessions without adding a Job engine.

## Transition

Do not delete applied migrations, historical encrypted instructions, legacy Jobs
or transcripts. New empty-soul identity versions do not create instruction
payloads. Legacy command contexts are parsed into presentation metadata before
execution; old instructions and injected Memory are not reactivated. Obsolete
Agent signal endpoints reject writes with 410. Version and owner checks remain.

The recurring-task feature is planned independently in ticket 29. Scheduling
must submit existing native commands through Codex and Claude adapters, use the
same Memory/progress paths, and preserve occurrence identity and uncertain-effect
handling. OpenDots is a source reference, not an adopted runtime or credential
service.

See [the integration ticket plan](../studio-ui-integration-plan.md) for validation
and retained-surface follow-ups. Old “done” labels do not establish acceptance of
the new scope.
