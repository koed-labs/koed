# Team continuous sharing preparation

Package 2 adds continuous sharing from a Personal selection to a Team Workspace.
Package 1 supplies source identity, Project membership, filtered recall, and change notifications.
The confirmed policies define sharing authority and the implementation sequence.

The [agreed model](recall-and-continuous-sharing-model.md#work-package-2-team-continuous-sharing)
defines the scope.
The [Package 1 validation record](personal-project-validation.md#package-1-verification-fixes)
records the prerequisite fixes and their acceptance.
The User confirmed every policy in the decision register on 20 October 2026.

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

Access removal, exclusions, overlapping detail, snapshot compatibility, and private Project boundaries are settled.
Changes to shared detail and content policy are also settled.
Removing an exclusion resumes eligible sharing and catches up through active rules.
Destinations are independent. Adding one leaves every existing destination unchanged.
The decisions govern the acceptance criteria for the implementation work.

| Decision                                      | Behavior                                                                                                                                               | Status                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Leaving a shared Project                      | Revoke only the sharing reason supplied by that Project. Preserve independent reasons.                                                                 | Confirmed by the User on 20 October 2026 |
| Excluding a source from a Workspace           | Revoke the owner's source access there and block all sharing routes until the owner removes the exclusion.                                             | Confirmed by the User on 20 October 2026 |
| Personal Project privacy and Team collections | Keep Personal Projects private and use them to select Memory for a Team Workspace. Defer Team collections.                                             | Confirmed by the User on 20 October 2026 |
| Changing shared detail or content policy      | Apply changes to existing and future Memory. Require explicit confirmation before sharing more. Preserve independently authorized access.              | Confirmed by the User on 20 October 2026 |
| Independent destinations | Adding a Workspace creates independent sharing. Existing destinations remain unchanged until the owner explicitly stops their rules. | Confirmed by the User on 20 October 2026 |
| Removing a Workspace exclusion                | After explicit removal, reconcile currently active continuous rules and catch up eligible Memory. Leave paused and stopped rules unchanged.            | Confirmed by the User on 20 October 2026 |
| Overlapping detail levels                     | Permit the highest detail supported by a remaining sharing reason and current content policy. Removing a broader reason removes its additional detail. | Confirmed by the User on 20 October 2026 |
| Existing snapshot shares                      | Preserve existing snapshots. Require an explicit owner action to adopt continuous sharing or admit future sources.                                     | Confirmed by the User on 20 October 2026 |

Project removal and destination exclusion have different scopes.
A Project exclusion changes membership in that Project only.
A destination exclusion concerns one owner's source in one Workspace.
It does not exclude another owner's independent contribution.
Neither action deletes Personal Memory.

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

| Boundary                      | Current implementation                                                | Package 2 responsibility                                                                        |
| ----------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Personal selection            | `packages/db/src/personal-selection-consumer-repository.ts`           | Consume membership and source changes without creating sharing authority from membership alone. |
| Local sharing adapter         | `apps/api/src/local-edge/collaboration-shared-memory-control.ts`      | Persist rule intent, reconciliation progress, and destination acknowledgments.                  |
| Team authority and visibility | `packages/db/src/shared-memory-repository.ts`                         | Bind each source's access to current consent and all applicable sharing reasons.                |
| Pending preparation           | `packages/db/src/pending-share-processing-workflow.ts`                | Prepare eligible source revisions before visibility and reject obsolete work.                   |
| Team API                      | `apps/api/src/shared-memory/routes.ts`                                | Expose authorized rule lifecycle and contribution operations.                                   |
| Desktop sharing               | `apps/desktop/src/renderer/collaboration/CollaborationRoutesImpl.tsx` | Show scope, destination, progress, exclusions, and remaining reasons.                           |

## Proposed implementation sequence

These are preparation workstreams, not approved implementation tickets.
Policy decisions can change their boundaries.
Create the detailed tickets after the access rules are resolved.

| Order | Workstream                           | Required result                                                                                                                                            |
| ----- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Rule and contribution contracts      | Define owner, source selection, destination, versions, lifecycle, and independent reasons. Preserve private Project selection and existing consent limits. |
| 2     | Team authority and reason accounting | Authorize rules and per-source contributions. Apply exclusions, reductions, and revocation without removing independent access.                            |
| 3     | Personal selection reconciliation    | Enumerate existing members, follow changes, recover expired cursors, and reconcile across restart and Personal sync.                                       |
| 4     | Admission and source publication     | Admit new sources and later revisions through existing privacy and Pending Share processing. Prevent duplicate contributions.                              |
| 5     | Pause, resume, and stop              | Block queued publication after pause or stop. Resume automatically reconciles eligible membership and content.                                             |
| 6     | Team recall and private selection    | Filter authorized Workspace contributions by Git Anchor without exposing Personal Project names, membership, or local paths.                               |
| 7     | Desktop controls and compatibility   | Explain access reasons and pending state. Apply the approved policy for existing shares and changes to active rules.                                       |
| 8     | Integrated acceptance                | Exercise two owners, offline recovery, authority changes during work, and Personal regressions. Update current behavior documentation.                     |

Rule authority precedes automatic source admission.
Admission precedes a complete continuous publication journey.
Team recall and Desktop work consume the agreed contracts.
Compatibility tests accompany storage and authority changes.

## Acceptance scenarios to refine

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
- Share a Personal Project and make sure that Team responses reveal no private Project name, membership structure, or local folder path.
- Apply the approved snapshot compatibility policy without expanding existing consent silently.

## Preparation completion

Preparation completes when each policy decision has a recorded outcome and example.
The implementation plan must map those outcomes to contracts, ownership boundaries, and acceptance tests.
The tickets must identify dependencies and the tests that establish completion.
The Package 1 fixes remain a separate checkpoint before Package 2 implementation starts.
