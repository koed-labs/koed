# Team continuous sharing implementation plan

Package 2 adds continuous sharing from a Personal selection to a Team Workspace.
The User confirmed the product decisions on 20 October 2026.
The [decision record](team-continuous-sharing-preparation.md) contains the
policies and examples. This plan turns them into engineering work.
The [local tickets](../tickets.md#package-2-team-continuous-sharing-implementation-tickets)
contain dependencies and acceptance criteria.

This is preparation, not an implementation or validation result.
The baseline is `codex/repo-targeted-recall` at `6d7ce920`, plus the
[verified Package 1 fixes](personal-project-validation.md#package-1-verification-fixes)
in the working tree. Keep those fixes as a separate checkpoint before
Package 2 implementation.

## Outcome and boundaries

A User can share a Project, Git Anchor, exact Folder, or individual Conversation
to a Team Workspace. Sharing includes existing eligible Memory and follows
future members, later turns, and completed LCM Summaries.
A Conversation selection follows only that Conversation.

Personal Projects stay private. They select Memory for sharing without
publishing a Project object, its name, its membership structure, or local
Folder metadata. Team collections are outside this package.
Team recall continues to use authorized Workspace contributions and Git Anchors.
Content that the owner explicitly shares still follows its reviewed content
policy; keeping organization metadata private is not a promise to remove every
Project name mentioned in source text.

Each destination has its own rule, consent, detail, policy, and lifecycle.
Adding Design as a destination leaves Engineering sharing unchanged.
Stopping an Engineering rule removes only that rule's authority.
There is no implicit move or retarget operation.

Personal selection does not grant Team access.
Workspace Access, owner consent, content policy, and a current Share Grant
remain required. Conversation Source Access remains separately authorized.
API Tokens retain their existing Personal-only boundary.
No backend LLM synthesis is introduced.

## Authority and storage contract

P2-01 specifies these records and transitions before schema implementation.
The exact table and API names remain engineering choices.

| Record | Required meaning |
| --- | --- |
| Continuous rule | One owner, private selection reference, destination, confirmed consent scope, detail and content policy, lifecycle state, and monotonic authority version. |
| Source reason | The authority supplied by one rule or existing direct share for one logical source in one destination. Retains its own consent, state, permitted representations, and authorized and published source revisions. |
| Selection membership | Owner-only source identities, inclusion reasons, and current selection versions. Supplies eligibility, not Team authority. |
| Workspace exclusion | A retained block for one owner's logical source in one Workspace. Overrides every sharing route there, including direct shares. |
| Publication work | Durable work bound to source identity and revision, rule and policy versions, exclusion state, publisher authority, and an idempotency key. |
| Publisher progress | Local enumeration and change cursors, complete membership baseline, pending operations, and remote acknowledgments. A cursor belongs to one Personal database history. |

The current database allows one Share Grant for each logical source and
destination. Keep that invariant. Store overlapping reasons separately rather
than creating a grant per rule. Direct shares and existing consent must remain
independent reasons with their original limits.

The Team transaction owner computes effective access from remaining reasons.
It must preserve the relationship between each representation, revision, and
the reason that authorizes it. Combining the greatest detail with the newest
revision from different reasons is unsafe.

For example, a paused detailed rule can retain detailed revision 1 while an
active summary rule publishes a summary of revision 2. Detailed revision 2 is
not authorized. Removing the detailed reason must remove its additional detail
without losing the permitted summary. The same rule applies to differing
redaction policies and to cached or expanded content.

Restrictive authority changes must take effect at the Team read boundary
before replacement content finishes processing. Old broader content cannot
remain readable while a worker prepares its narrower replacement.
Every publication transaction must reject obsolete authority.

## Responsibilities

| Boundary | Existing owner | Package 2 extension |
| --- | --- | --- |
| Personal membership and changes | `packages/db/src/personal-selection-consumer-repository.ts` | Consume the bounded contract, preserving all inclusion reasons and owner checks. |
| Shared contracts | `packages/shared/src/personal-selection-consumer-contract.ts` and Shared Memory contracts | Define rule commands, reason authority, version checks, and capability negotiation. |
| Local durable delivery | `packages/db/src/collaboration-shared-memory-authority-store.ts` and `apps/api/src/local-edge/collaboration-shared-memory-control.ts` | Store publication intent, reconciliation progress, retries, and Team acknowledgments. |
| Team authority and publication | `packages/db/src/shared-memory-repository.ts` | Own transactional consent, reason accounting, grant access, exclusions, and publication. |
| Processing readiness | `packages/db/src/pending-share-processing-workflow.ts` and Shared Memory workers | Reuse privacy, encrypted materialization, and embedding preparation. Recheck authority at final publication. |
| Authenticated commands | `apps/api/src/shared-memory/routes.ts` and high-risk action definitions | Validate owner authority and bind confirmations to reviewed rule changes. |
| Team recall | `apps/api/src/memory/team-shared-memory-surface.ts` and repository read methods | Enforce current reason, revision, representation, and Workspace authority on every surface. |
| Desktop | `apps/desktop/src/renderer/collaboration/CollaborationRoutesImpl.tsx` | Show selectors, destinations, effects, remaining reasons, and pending versus acknowledged state. |

Keep the existing
[Shared Memory owner workflow](shared-memory-owner-workflow.md) as the
transaction owner. The local adapter coordinates separate systems; it cannot
make a local write and a remote Team write atomic.
Do not introduce a second application state machine for the same grant workflow.

## Publication and reconciliation

1. Preview the selected scope, destination, detail, policy, existing membership,
   and future sharing behavior. Bind owner confirmation to that reviewed intent.
   Create explicit continuous rule authority. A one-use per-source action grant
   cannot authorize arbitrary future members.
2. Enumerate the Personal selection through every bounded page. Combine every
   inclusion reason for each source before installing the complete baseline.
   Resolve verified portable source identity, or retain explicit local-only
   identity. Never guess another device's source binding.
3. Persist member differences and source refresh work before acknowledging local
   progress. Deliver operations idempotently to the Team Backend. Selection and
   source versions must make stale replay detectable.
4. Admit eligible sources through the existing Pending Share and privacy
   pipeline. Prepare authorized encrypted representations before visibility.
   At publication, verify current rule, consent, exclusion, policy, source
   eligibility, and publisher authority in the Team transaction.
5. Follow later selection and source changes. A source event requires a current
   authorized refresh, including completed LCM Summaries. Track published content
   per reason so one rule cannot borrow another rule's revision or detail.
6. On resume or recovery, reconcile current membership and content before
   catch-up. Retrying the same work must neither duplicate contributions nor
   restore authority that has ended.

Use the visibility-safe cursors in
[ADR 0061](adr/0061-personal-selection-cursor-visibility.md).
Do not replace them with a maximum event ID.
Expired cursors and stale enumeration require a new complete baseline.
Never infer removals from a partial, unavailable, or failed enumeration.
Pending or conflicted sources do not authorize new admission.

Local edits can occur while the Team Backend is offline.
Persist their intent and show pending remote application until acknowledgment.
Do not claim remote revocation before the Team Backend receives it.
After receipt, obsolete queued work must not restore access.
Transport failure alone must not be interpreted as a membership removal.

Use one current publisher authority per logical rule, with a lease and fencing
version or an equivalent contract specified in P2-01.
Two Personal devices must not publish competing stale baselines.
Publisher takeover requires current authority and a fresh local baseline.
Personal synchronization must not copy a live cursor into another database
history. Recovery must not require renewed consent for already approved scope.
Failure at one destination must not block another destination's progress.

## Lifecycle and policy changes

| Action | Existing access | New publication |
| --- | --- | --- |
| Pause | Keep content already authorized by this reason, subject to current policy and exclusions. | Block new members and revisions, including queued work. |
| Resume | Preserve independently authorized access. | Reconcile current eligibility and catch up automatically. |
| Stop | Revoke this reason; keep other permitted reasons. | Reject all later work for the stopped authority version. |
| Lose selector membership | Revoke the affected reason even if its rule is paused. Other applicable reasons remain. | No publication through that reason while the source is outside the selection. |
| Exclude from Workspace | Revoke this owner's source access there through every route. | Block every route until explicit removal of the exclusion. |
| Remove exclusion | Do not revive revoked snapshots or change paused or stopped rule state. | Reconcile and catch up through applicable active continuous rules. No active rule means no publication. |
| Reduce detail or policy permission | Remove access that no remaining reason permits. | Follow the reduced permission for eligible future content. |
| Increase detail or policy permission | Require explicit review and confirmation, then reprocess eligible existing Memory. | Follow the newly approved permission for future content. |
| Add a destination | Leave existing destinations unchanged. | Start the separately approved destination rule. |

Selection removal includes direct membership edits, rule edits, source-context
corrections, and equivalent changes received through Personal sync.
Losing one inclusion reason within a Project does not end its source reason if
another inclusion still makes the source a member.

An exclusion does not delete Personal Memory or affect another owner's
independent contribution. Removing it must show the automatic sharing effect.
Policy edits do not implicitly resume a paused rule or restart a stopped rule.
Previously approved future members and later turns do not prompt again.

Preserve existing retention rules. Losing Workspace Access prevents the
departing User from reading or publishing; it does not by itself revoke their
previously retained Team contribution. Keep source retention, explicit access
revocation, and physical deletion separate.

## Compatibility and activation

Use additive migrations after the current Package 1 migrations.
Do not rewrite committed migration history or reset a database.
Represent existing grants and consents as independent reasons without changing
their published content, destination, state, or consent limits.

Existing snapshots remain snapshots until explicit conversion.
Converting one source does not authorize future members of a Project.
Existing source-continuous consent follows that source only.
It cannot become selection-wide future-member authority by inference.
When an old share overlaps a new rule, preserve their separate authorization.

Preserve existing approved repository snapshots and the reviewed update path.
Changing Personal organization or source context must not silently rewrite
metadata already disclosed to Team readers.
Do not expose private Project labels or local Folder paths as new Team metadata.

Negotiate capabilities across Desktop, local API, Team API, and workers.
Older callers must not widen new rule authority through legacy commands.
Keep public creation of new rules disabled until publication, revocation,
read enforcement, compatibility, and controls work together.
P2-12 enables the completed feature only after its acceptance checks pass.
This is a local implementation gate, not authorization to deploy.

## Ticket sequence

Every ticket includes focused tests and documentation for its changed boundary.
Dependencies identify prerequisites, not approval to execute.

| Ticket | Result | Depends on |
| --- | --- | --- |
| P2-01 | Rule, reason, publication, and publisher authority contracts | Verified Package 1 checkpoint |
| P2-02 | Persistent rule authority and separate source reasons | P2-01 |
| P2-03 | Durable Personal selection reconciliation | P2-02 |
| P2-04 | Existing and future source admission | P2-03 |
| P2-05 | Later turns and completed summaries | P2-04 |
| P2-06 | Pause, automatic resume catch-up, and stop | P2-05 |
| P2-07 | Membership loss and Workspace exclusions | P2-06 |
| P2-08 | Reviewed detail and content policy changes | P2-07 |
| P2-09 | Complete Team read enforcement and private organization | P2-08 |
| P2-10 | Existing share compatibility and explicit conversion | P2-09 |
| P2-11 | Desktop controls and destination independence | P2-10 |
| P2-12 | Integrated acceptance and activation | P2-11 |

Read authorization and compatibility tests start with P2-02.
P2-09 and P2-10 complete coverage across all surfaces; they are not permission
to expose unsafe intermediate behavior.
The deliberately ordered sequence establishes each authority invariant before
the next ticket relies on it.

## Acceptance evidence

Extend the deterministic
[Team fixture truth sheet](team-saas-synthetic-fixture.md) and use the
[launch validation harness](team-saas-launch-validation.md).
Preserve existing actors, denials, retained knowledge, and representation
expectations. Add deterministic cases for the new behavior.
Use an isolated local test database and synthetic content.

| Area | Required proof |
| --- | --- |
| Selections | All four selector kinds; exact Folder boundaries; existing and future members; later turns and completed summaries. |
| Overlap | Project, Git Anchor, and direct reasons converge on one logical source; removing one preserves the others. |
| Revision and detail | A paused detailed reason at revision 1 cannot expose detailed revision 2 from an active summary reason. Reductions apply to recall, caches, and expansion. |
| Lifecycle races | Pause, stop, exclusion, consent loss, and policy reduction during preparation or retry prevent obsolete publication. Resume catches up once. |
| Exclusion recovery | All routes blocked in one Workspace; removing the exclusion catches up active rules only; no effect on other owners or destinations. |
| Destination independence | Start sharing to a second Workspace, fail one destination, and stop one rule without changing the other Workspace. |
| Recovery | Late-committed events, bounded pages, expired cursors, offline edits, restart, replay, Personal sync, and publisher takeover preserve membership and authority. |
| Compatibility | Existing snapshots, source-continuous grants, repository metadata, separately authorized source access, and retained contributions retain their limits. |
| Team visibility | Two owners share matching Git Anchors into authorized Workspaces. Private, revoked, disabled, removed-reader, and wrong-Workspace cases remain denied. |
| Private organization | Responses, counts, summaries, logs exposed to readers, and evidence links do not serialize private selector metadata. |

Test direct API calls as well as Desktop flows.
Cover browser sessions, scoped device credentials, and API Token rejection.
Use the [Shared Memory surface inventory](shared-memory-surface-inventory.md)
for search, candidates, graph, summaries, evidence, source expansion, and
Conversation Source Access boundaries.
Semantic checks need the normal Team embedding reconciler; fixture seeding
alone is not evidence that recall works.

Run applicable formatting, lint, typechecks, builds, real database tests, and
Personal regressions. Record commands and outcomes in a Package 2 validation
record. Mark unavailable staged checks explicitly; do not present local
acceptance as remote deployment validation.

Update current-behavior sharing, mapping, publication, and operation docs with
implementation. Apply the repository's changeset decision process when
release notes become relevant. Preparation alone changes no runtime behavior.
