# Team continuous sharing preparation

Package 2 adds continuous sharing from a Personal selection to a Team Workspace.
Package 1 supplies source identity, Project membership, filtered recall, and change notifications.
The confirmed policies define sharing authority and the implementation sequence.

The [agreed model](recall-and-continuous-sharing-model.md#work-package-2-team-continuous-sharing)
defines the scope.
The [Package 1 validation record](personal-project-validation.md#package-1-verification-fixes)
records the prerequisite fixes and their acceptance.
The User confirmed the policies and implementation scope recorded below.

On 21 October 2026, the User changed the next delivery milestone to an operational
internal alpha. The [current tickets](../tickets.md) govern active work.
The full Package 2 decisions below remain the design for deferred capabilities.

## Settled behavior

A sharing rule follows a Folder, Git Anchor, Project, or individual Conversation.
Folder and Git Anchor selections include existing and future matching Conversations.
A Project follows its current membership, including direct inclusions and inclusion rules.
An individual selection includes only that Conversation.
Every selection follows later eligible turns and completed LCM Summaries.

Pause preserves existing shared access and prevents new publication.
Resume catches up with currently eligible membership and content.
Stop revokes the access supplied by that rule.
An independent sharing reason can preserve access to the same source.
These controls preserve Personal Memory and remain separate from Capture Policy.

Workspace Access, owner consent, content policy, and Share Grants remain required.
Personal membership and repository identity confer no Team authority.
Conversation Source Access remains a separately authorized capability.
Personal Projects remain private selectors for sharing to a Team Workspace.
Sharing their selected Memory does not publish the Project, its name, or its private membership structure.
Team collections are deferred beyond Package 2.
Team recall uses authorized Workspace contributions and Git Anchor filtering.

## Policy decisions

Access removal, exclusions, overlapping detail, snapshot consent, and private Project boundaries are settled.
Changes to shared detail and content policy are also settled.
Removing an exclusion resumes eligible sharing and catches up through active rules.
Destinations are independent. Adding one leaves every existing destination unchanged.
The decisions govern the acceptance criteria for the implementation work.
Package 2 targets the current alpha build. The User removed backward
compatibility requirements, so affected callers, services, and schemas can
change together without support for previous versions.

| Decision                                      | Behavior                                                                                                                                               | Status                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Leaving a shared Project                      | Revoke only the sharing reason supplied by that Project. Preserve independent reasons.                                                                 | Confirmed by the User on 20 October 2026 |
| Excluding a source from a Workspace           | Revoke the owner's source access there and block all sharing routes until the owner removes the exclusion.                                             | Confirmed by the User on 20 October 2026 |
| Personal Project privacy and Team collections | Keep Personal Projects private and use them to select Memory for a Team Workspace. Defer Team collections.                                             | Confirmed by the User on 20 October 2026 |
| Changing shared detail or content policy      | Apply changes to existing and future Memory. Require explicit confirmation before sharing more. Preserve independently authorized access.              | Confirmed by the User on 20 October 2026 |
| Independent destinations                      | Adding a Workspace creates independent sharing. Existing destinations remain unchanged until the owner explicitly stops their rules.                   | Confirmed by the User on 20 October 2026 |
| Removing a Workspace exclusion                | After explicit removal, reconcile currently active continuous rules and catch up eligible Memory. Leave paused and stopped rules unchanged.            | Confirmed by the User on 20 October 2026 |
| Overlapping detail levels                     | Permit the highest detail supported by a remaining sharing reason and current content policy. Removing a broader reason removes its additional detail. | Confirmed by the User on 20 October 2026 |
| Existing snapshot shares                      | Preserve existing snapshots. Require an explicit owner action to adopt continuous sharing or admit future sources.                                     | Confirmed by the User on 20 October 2026 |
| Alpha implementation                          | Permit breaking contract and schema changes. No compatibility adapters, old-format support, mixed-version operation, or historical upgrade tests.      | Confirmed by the User                    |

Project removal and destination exclusion have different scopes.
A Project exclusion changes membership in that Project only.
A destination exclusion concerns one owner's source in one Workspace.
It does not exclude another owner's independent contribution.
Neither action deletes Personal Memory.
Snapshot consent and retention remain product rules for the current model;
they do not require preserving old APIs or storage formats.

Changes to a continuous rule's detail or content policy apply to existing and future Memory.
A reduction removes unsupported access while preserving access supplied by other reasons.
Sharing more requires explicit review and confirmation before eligible history is reprocessed.
Team policy and current source eligibility continue to limit publication.
Already authorized future members and turns require no repeated confirmation.

A Personal Project named `Launch` can select contributions to Engineering.
Engineering receives authorized Memory without acquiring a Team collection named `Launch`.
Another owner can independently share matching repository Memory to Engineering.
Git Anchor filtering can find both owners' authorized contributions without combining their Personal Projects.

The removal decision must also cover source correction and changes received through Personal sync.
The same source can stop matching a Folder or Git Anchor rule without a direct removal action.
The design must distinguish the loss of one inclusion reason from loss of every reason.
Revocation of access remains separate from retention and physical deletion.

## Worked access example

Suppose `Launch` includes a Conversation captured in `@koed-labs/koed`.
The owner shares both `Launch` and the Git Anchor to Engineering.
The two sharing rules provide independent reasons for access to one logical source.

Removing the Conversation from `Launch` ends its Project reason.
The Git Anchor rule continues to provide access.
Stopping the Git Anchor rule then ends the remaining access.
Excluding the Conversation from Engineering blocks both reasons.

The interface must distinguish “Remove from Project,” “Stop this sharing rule,” and “Exclude from this Workspace.”
It must explain any remaining sharing reason.
Removing an exclusion resumes eligible sharing through currently active continuous rules and catches up automatically.
The removal action shows its sharing effect before confirmation.
Paused rules stay paused, and stopped rules stay stopped.
If no active rule includes the Conversation, removing the exclusion publishes nothing.
Current Workspace Access, content policy, and source eligibility still apply.

Sharing `Launch` to Design adds a separate rule and leaves Engineering unchanged.
Each destination has independent detail, policy, exclusions, and lifecycle state.
Stopping the Engineering rule preserves Design sharing and independently authorized Engineering access.

## Existing boundaries to reuse

The [Shared Memory owner workflow](shared-memory-owner-workflow.md)
owns consent, Share Grants, privacy processing, representation changes, and revocation.
Its repository transaction controls when prepared content becomes visible.
Package 2 adds authority to admit future sources without duplicating that transaction owner.

The [Personal selection consumer](personal-selection-contract.md#bounded-personal-selection-consumer)
provides bounded enumeration and durable change cursors.
Finish every page and combine every inclusion reason before replacing a membership baseline.
Stale enumeration requires a fresh baseline.
Expired cursors require reconciliation from current membership.
Source notifications also require an authorized refresh of content, including completed LCM Summaries.

The local publisher connects Personal selection to the selected Team Backend.
It requires durable progress, repeatable requests, and current authorization.
The Team Backend must reject obsolete publication work after pause, stop, exclusion, or authority loss.
An offline local edit cannot claim that remote access ended before the Team Backend acknowledges the change.
The interface must show pending changes until that acknowledgment arrives.

The current database permits one Share Grant per logical source and destination Workspace.
An overlapping rule cannot create another grant for the same destination.
The design needs separate records for the reasons that support that grant.
Each reason must preserve its consent, permitted detail, state, and authorized content revisions.

Pause applies independently to each reason.
A paused detailed reason can retain its previously published content.
An active summary reason can publish later summaries.
Combining the highest detail and newest revision across those reasons would expose unauthorized detail.
The contracts and read path must preserve which reason authorizes each representation.

| Boundary                      | Current implementation                                                | Package 2 responsibility                                                                                             |
| ----------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Personal selection            | `packages/db/src/personal-selection-consumer-repository.ts`           | Consume membership and source changes without creating sharing authority from membership alone.                      |
| Local sharing adapter         | `apps/api/src/local-edge/collaboration-shared-memory-control.ts`      | Persist rule intent, reconciliation progress, and destination acknowledgments.                                       |
| Team authority and visibility | `packages/db/src/shared-memory-repository.ts`                         | Bind each source's access to current consent and all applicable sharing reasons.                                     |
| Processing readiness          | `packages/db/src/pending-share-processing-workflow.ts`                | Evaluate readiness for the repository-owned publication transaction; reuse existing workers for content preparation. |
| Team API                      | `apps/api/src/shared-memory/routes.ts`                                | Expose authorized rule lifecycle and contribution operations.                                                        |
| Desktop sharing               | `apps/desktop/src/renderer/collaboration/CollaborationRoutesImpl.tsx` | Show scope, destination, progress, exclusions, and remaining reasons.                                                |

## Implementation sequence

The [archived implementation plan](archive/2026-10-21-package-2/implementation-plan.md)
defines current contracts, responsibilities, recovery, consent, and validation.
The User approved the [fourteen vertical tickets](archive/2026-10-21-package-2/tickets.md#package-2-team-continuous-sharing-implementation-tickets)
with their blocking dependencies and acceptance criteria.
Each ticket delivers a user flow through its required storage, API, Desktop,
and access tests. The User authorized implementation on 20 October 2026.

| Tickets      | Required result                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| P2-01–P2-02  | Explain existing sharing reasons and deliver continuous sharing for one Conversation, including lifecycle controls. |
| P2-03–P2-04  | Review a Git Anchor's sharing scope, then share its existing and future matching Conversations.                     |
| P2-05, P2-06 | Add exact Folder and private Project sharing independently using the dynamic workflow.                              |
| P2-07        | Add independent destinations without changing existing sharing.                                                     |
| P2-08–P2-09  | Review and apply detail and content-policy changes to existing and future Memory.                                   |
| P2-10–P2-11  | Apply Workspace exclusions, then support explicit removal with eligible catch-up.                                   |
| P2-12        | Convert existing snapshots explicitly without expanding consent to other sources.                                   |
| P2-13–P2-14  | Recover after extended interruptions, then continue rules from another authorized Personal device.                  |

P2-01 and P2-03 have no ticket prerequisites. Subsequent work follows the
blocking edges in the implementation plan, rather than a single numeric chain.
Every slice includes its own controls, current-contract validation, and read enforcement.
The separate package completion checklist verifies the combined flows and
complete selector/control matrix.

## Acceptance scenarios

Retain the existing Team authorization tests.
Extend the deterministic Team fixture with the approved rule behavior.
Test each operation through both its API and the resulting recall boundary.

- Share each selector type and admit existing members, future members, later turns, and completed summaries.
- Pause during queued preparation and make sure that new content remains unavailable.
- Resume after membership changes and make sure that catch-up uses current eligibility.
- Stop during retry and make sure that delayed work cannot restore that reason.
- Remove one overlapping reason and make sure that independently authorized access remains.
- Apply the approved destination exclusion and make sure that overlapping routes obey it.
- Remove an exclusion and make sure that active rules catch up while paused and stopped rules remain unchanged.
- Reduce shared detail and make sure that recall, expansion, and caches cannot expose the removed detail.
- Pause a detailed rule while a summary rule remains active, and make sure that later turns remain summary-only.
- Revoke Workspace Access or consent during catch-up and make sure that publication and reads obey current authority.
- Restart either side during publication and make sure that retries preserve source identity and progress.
- Change Personal membership on another device and reconcile the resulting sharing reasons.
- Recover from an expired cursor and make sure that removed members cannot remain authorized through a stale baseline.
- Share matching Git Anchors from two owners and expose only their authorized contributions.
- Share a Personal Project and make sure that Team responses do not serialize private Project names, membership structure, or local Folder metadata.
- Add a destination, interrupt its publication, and stop one destination's rule without changing sharing to another Workspace.
- Apply the approved snapshot conversion policy without expanding consent silently.

## Preparation completion

Preparation is complete: every identified product decision has a recorded outcome.
The archived implementation plan maps those outcomes to contracts and ownership boundaries.
The User approved the fourteen vertical slices on 20 October 2026.
On 21 October 2026, the User deferred P2-09 through P2-14 for the first alpha.
The [current tickets](../tickets.md) identify evidence for that milestone.
P2-01 through P2-08 are locally complete. See
[Package 2 validation](team-continuous-sharing-validation.md).
The verified Package 1 fixes are recorded in checkpoint `e5c2116b`.
