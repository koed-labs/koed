# Team continuous sharing: operational alpha plan

On 21 October 2026, the User approved an operational internal alpha as the next
milestone. The [current tickets](tickets.md) define its work and acceptance.
The [archived plan](../2026-10-21-package-2/implementation-plan.md) and
[archived tickets](../2026-10-21-package-2/tickets.md) preserve the previous
Package 2 scope and engineering design.

## Delivery boundary

Use the locally completed P2-01 through P2-08 flows as the implementation base.
Isolate the incomplete P2-09 editing operation. Defer P2-09 through P2-14 and
the full package matrix until later milestones.

The first trial uses one publishing device, one owner, one teammate, and one
Workspace. Start with selected Conversations and one Git Anchor. Retain the
completed Folder, Project, detail-change, and independent-destination code.

Follow ALPHA-01 through ALPHA-05 in the current tickets. Disable unfinished
editing, run matching builds, demonstrate sharing, demonstrate brief recovery,
and deliver the trial guide. Fix blockers to those journeys before handover.

## Guarantees and operation

The [decision record](../../team-continuous-sharing-preparation.md) still defines
consent, privacy, retention, and independent sharing reasons. Deferral changes
delivery order. It does not weaken authorization for enabled operations.

Use the local Docker daemon for the Team Backend and reuse existing model
services. Run heavy checks sequentially. Run focused tests only when changed
behavior or an acceptance requirement needs evidence.

Record results in [Package 2 validation](../../team-continuous-sharing-validation.md).
Keep implementation follow-ups in [TODO.md](../../../TODO.md). The User chose to omit
the changeset. Alpha completion does not authorize publication or deployment.

## Completion

The milestone ends with a running app, a demonstrated native sharing journey,
accurate brief-disconnect recovery, launch instructions, and known limitations.
The current tickets hold the complete alpha acceptance criteria.

The original full Package 2 remains incomplete. Workspace exclusions are the
next priority before routine sharing of mixed private and work content.
