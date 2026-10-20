# Recall and continuous sharing model

The agreed model separates source context, Project membership, and sharing.
A Project groups Memory without replacing its Git anchor or folder context.
Sharing includes existing and future members and follows later turns until the
User pauses or stops it. Resume catches up automatically.

This is the product direction agreed on 19 October 2026. The implementation
comparison uses branch `codex/repo-targeted-recall` at `8896cc14`.
That comparison describes the planning baseline. Package 1 is now implemented
locally, with [executed acceptance](personal-project-validation.md). The User
chose to omit the recommended minor changeset on 20 October 2026. Package 2
remains planned. Project integration is new on this branch; the User removed
the existing-Project upgrade requirement on 20 October 2026. The backlog is in
[TODO.md](../TODO.md#recall-grouping-and-continuous-sharing).

Delivery is split into two work packages:

| Package                                                                        | Outcome                                                             | Dependency                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------ |
| [1 Personal Project remediation](#work-package-1-personal-project-remediation) | Independent source context, Project membership, and Personal recall | Can complete without new Team sharing behavior   |
| [2 Team continuous sharing](#work-package-2-team-continuous-sharing)           | Continuous sharing of the selected members and later content        | Uses Package 1's membership and source contracts |

Package 1 establishes the Personal model and preserves existing Team behavior.
Package 2 adds sharing authority and publication across that model.
Team design can proceed alongside Package 1, but integrated delivery follows
its stable contracts and acceptance results.

## Source context and Project membership

A Git Anchor identifies the selected repository. A Folder identifies local
directory context. A Project is a named grouping created by the User.
These provide independent ways to select the same Memory.

Folder matching includes only the selected Folder, not its subfolders.
A Conversation keeps its original recorded Git and Folder context until an
explicit correction. It can belong to several named Projects.
Package 1 does not support nested Projects.

A Project supports three kinds of inclusion:

| Inclusion    | Members                                                               |
| ------------ | --------------------------------------------------------------------- |
| Git Anchor   | Existing and future Conversations associated with that repository     |
| Folder       | Existing and future Conversations associated with that folder context |
| Conversation | Only the selected Conversation                                        |

Adding a Conversation to a Project preserves its Git and folder attributes.
It creates no separate memory lifespan and changes no ownership.
Removing an explicit inclusion removes that inclusion only. Another inclusion
can still select the same Conversation.

Use "Add to Project" and "Remove from Project" for organization.
Correcting a mistaken repository or folder assignment is a separate operation.
Retain the original capture provenance when a User corrects an assignment.

## Personal recall

The caller can select a named Project, a Git Anchor, or a Folder.
Conversation recall and Global recall remain available.
Every selection remains within the caller's authorized Memory.

| Recall target | Eligible Memory                                                              |
| ------------- | ---------------------------------------------------------------------------- |
| Named Project | The union of its explicit Conversations and matching inclusion rules         |
| Git Anchor    | Memory associated with that repository, across matching clones and worktrees |
| Folder        | Memory associated with the selected local folder context                     |
| Conversation  | Memory from that Conversation                                                |
| Global        | All Memory authorized within the selected Personal or Team scope             |

A caller working in a repository can use that repository as context.
This does not select every Project that includes the repository.
Recall of a named Project requires an explicit target or explicitly selected
Project context. Project membership never silently widens repository recall.

Overlapping inclusions return one logical source. A summary and its supporting
source also retain their shared lineage. They do not become independent evidence
because several filters can find them.

For example, a Conversation starts in a clone of `@koed-labs/koed`.
The User adds it to `Test project`. It remains eligible through that Git Anchor,
its recorded Folder context, and `Test project`.
Other members of `Test project` do not become eligible for Koed repository recall.

## Team sharing

A Team Workspace is the destination for shared Memory.
The User can share a Folder, Git Anchor, Project, or individual Conversation
to a selected Team and Workspace. Each selection contributes the User's
matching Memory. It does not share filesystem contents or repository files.
A Personal Project remains private when used as a sharing selector.
Sharing its Memory does not publish its name or private membership structure.
Team collections are deferred beyond Package 2.

New sharing always includes existing and future matching Conversations.
Later turns update the shared Memory automatically.
The sharing flow has no current-members-only or Snapshot/Continuous choice.
The User selects the destination, shared detail, and applicable content policy,
then reviews and activates the continuous share.

Adding a Conversation, Git Anchor, or Folder to a shared Project extends its
sharing selection. The interface must show the destination and sharing effect.
Future captures covered by the approved selection require no repeated manual
share action. Publication still requires current authority and policy processing.

A Share Grant authorizes one source in one Workspace.
The continuous selection needs authority to admit additional sources as they
qualify. Each source remains subject to current access and content-policy rules.
A Pending Share gives the Workspace no access before its representation is ready.

Shared detail controls which Memory representation recipients can read.
Continuous semantic sharing does not grant Conversation Source Access.
That separate capability controls access to verified source records.
This decision does not remove its separate authorization or snapshot mode.

## Pause resume and stop

The sharing controls affect publication and access to shared Memory.
They do not change the User's Personal Capture Policy or Capture Pause.
Personal capture can continue while sharing is paused.

| Control      | Meaning                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Pause        | Keep already shared Memory accessible. Publish no new members or later content.                      |
| Resume       | Catch up with eligible members and later content accumulated during the pause. Continue publication. |
| Stop sharing | End this sharing rule and revoke the access that it supplies. Preserve Personal Memory.              |

Catch-up uses the current selection, access, and content policy.
It cannot bypass a current exclusion, revocation, or loss of authorization.
The interface must distinguish catching up from being fully current.
An unavailable destination leaves work pending rather than marking it complete.

Independent sharing reasons remain independent. If a Conversation is shared
directly and through a Project, stopping one reason leaves the other active.
The interface must explain the remaining reason. Revocation, Personal deletion,
and Team retention remain separate lifecycle operations.

## Team example

The User has a folder named `research` and the `@koed-labs/koed` Git Anchor.
The Project `Launch` includes both, plus one explicitly selected Conversation.
The User shares `Launch` continuously to Koed Team's Engineering Workspace.

Existing eligible Conversations enter the sharing process.
New Conversations matching either inclusion enter it automatically.
Later turns update each shared representation under the approved policy.
The explicitly selected Conversation does not include unrelated Conversations
from its repository or folder.

Alice can contribute her own Koed repository Memory to Engineering.
Her checkout path can differ. Repository recall in Engineering can find both
Users' authorized contributions. Cloning the repository does not authorize
sharing, and matching repository identity exposes no unshared Personal Memory.

The Team sees authorized contributions without receiving a collection named `Launch`.
The Personal Project name, private membership structure, and local folder paths remain private.
Alice can select her own contributions independently.
Team collections remain outside Package 2.

## What changes on this branch

The branch currently uses one effective repository identity for both organization
and recall. A User override replaces the automatic identity.
Named Projects participate in this same identity union.
The new model requires separate source context and membership.

| Area               | Current branch                                                     | Required change                                                                |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Identity           | `local_project` is a repository identity kind                      | Separate named Project identity from repository and Folder context             |
| Organization       | A Conversation move replaces its effective identity                | Store Project membership without replacing source context                      |
| Whole Project move | Rewrite assignments and save a route for future capture and recall | Replace named-group routing with continuing inclusion rules                    |
| Folder recall      | Folder identity is principally a fallback when Git is absent       | Make Folder filtering independent, including inside Git checkouts              |
| Recall request     | `project` covers repositories, folders, and named groups           | Carry an explicit target kind and identity through all recall surfaces         |
| Sharing admission  | Consent and grants bind individual sources                         | Add owner-authorized continuous selection across qualifying sources            |
| Sharing mode       | Semantic shares support snapshot and continuous modes              | Use continuous behavior for new shares in this model                           |
| Pause and resume   | Existing controls govern source advancement                        | Also govern new-member admission and catch-up across the selection             |
| Team context       | Grants carry repository snapshots                                  | Preserve approved Git context and keep Personal Project organization private   |
| Desktop            | Move and Restore operate on assignment                             | Provide inclusion controls, independent filters, and continuous sharing status |

## Work package 1 Personal Project remediation

The outcome is a usable Personal model with independent Project, Git Anchor,
and Folder recall. Organization no longer replaces source context.
This package includes the Personal schema, capture integration, retrieval,
Desktop controls, Personal Device Sync, and migration of existing assignments.

Existing Team sharing must continue to work through this change.
Compatibility changes needed to preserve its contracts belong in this package.
New continuous selection and rule-based publication belong in Package 2.
Team collections are deferred. Package 1 can complete and land independently.

The [Personal Project implementation plan](personal-project-implementation-plan.md)
records the confirmed decisions, engineering defaults, ordered work items,
migration rules, and validation criteria. Use that plan to implement this package.

### Identity and membership

Separate the named grouping from
[`repositoryIdentitySchema`](../packages/shared/src/repository-identity.ts).
The current [`Session schema`](../packages/db/src/schema.ts) retains automatic
identity, overrides, and capture provenance. Preserve those facts while adding
an independent Folder selection and Project inclusion model.

Replace the grouping use of
[`project-routing-repository.ts`](../packages/db/src/project-routing-repository.ts).
Its `moveProjectConversations` operation changes Session overrides and writes
`personal_project_routes`. Its route lookup also redirects recall.
Neither operation represents umbrella membership.

An inclusion must record its owner, Project, source kind, and source identity.
The implementation must retain each reason when inclusions overlap.
Removing one reason cannot remove another. A Conversation can belong to multiple
Projects. The implementation plan defines the proposed storage responsibilities.

### Recall contracts and retrieval

Update [`memory-tool-schemas.ts`](../packages/mcp-server/src/memory-tool-schemas.ts),
[`repository-recall-context.ts`](../packages/mcp-server/src/repository-recall-context.ts),
and the API and database contracts together.
The existing `global`, `project`, and `session` domain values do not distinguish
the three requested filters. Exact replacement field names remain open.

Pin the requested target before task acceptance.
Persist it in the encrypted durable request for blocking and non-blocking calls.
Worker retries must not infer a new target from their working directory.
An invalid target must not fall back to Global recall.

Replace the single-assignment predicate in
[`project-scope-sql.ts`](../packages/db/src/project-scope-sql.ts)
with target-specific selection. Apply the same boundary before candidate limits,
through expansion, and in graph inspection.
Cover raw Memory Events, LCM summaries, Curated Memory, and replicated sources.
Mixed summaries must not expose source content outside the selected boundary.

Keep repository preference separate from named Project membership.
Adding a Conversation to a Project cannot remove its current-repository
classification in Global recall. Preserve query budgets, deduplication,
source lineage, and the existing AI Client synthesis boundary.

### Personal Desktop controls

Replace the organization behavior in
[`ProjectActions.tsx`](../apps/desktop/src/renderer/views/personal/ProjectActions.tsx)
and
[`MoveConversationDialog.tsx`](../apps/desktop/src/renderer/views/personal/MoveConversationDialog.tsx).
Show Project inclusion separately from original Git and Folder context.
Keep correction of source context as a distinct action.

Provide separate recall filters for Projects, Git Anchors, and Folders.
Show why each Conversation belongs to a Project, including overlapping rules.
The Desktop grouping and recall results must use the same membership boundary.

### Personal sync and migration

Keep selected-anchor discovery and normalization from
[ADR 0057](adr/0057-selected-repository-identity.md).
Project inclusion is separate from the existing encrypted journal for
[Personal Project anchor selection](personal-project-selection.md).
Design membership replication without putting local paths or Personal inclusion
records into Team metadata or relay-visible data.

Plan the transition from existing named overrides and routes explicitly.
A named override can express grouping intent. A repository override can express
a deliberate source correction. The migration must not erase that distinction.
Unresolved history cannot acquire invented Git or folder provenance.
Existing retained provenance remains evidence rather than automatic authority.

Preserve existing Team grant repository snapshots during the transition.
Changing Personal organization must not silently retarget Team filtering.
Keep existing sharing consent and source access unchanged.
Compatibility for existing sharing modes and disclosed Team metadata belongs in Package 2.

Update the repository recall, Personal Desktop, client integration, and Personal
Device Sync documentation with the implementation.
The older [Project-first recall proposal](project-first-recall-proposal.md)
does not authorize automatic widening from a repository to its umbrella Projects.
No new backend synthesis service is needed.

### Handoff and completion

Package 1 must supply stable owner-scoped Project, inclusion, and source identities.
Package 2 needs authoritative member enumeration with inclusion reasons and
versions. It also needs a durable way to discover membership and source changes.
The implementation can select the storage and change-notification mechanism.
These contracts select sources but confer no Team sharing authority.

Complete acceptance scenarios 1 through 4, plus the Personal parts of 11 and 12.
Also make sure that membership survives Personal sync and that stale writes
cannot undo newer edits. Make sure that existing Team shares retain their
approved content, repository snapshots, and access boundaries.
The package is complete when Personal organization and recall work without
Package 2, and their compatibility and migration tests pass.

## Work package 2 Team continuous sharing

The outcome is continuous sharing from a Folder, Git Anchor, Project, or
Conversation to a selected Team Workspace. Existing and future members and
later turns follow the approved rule. Pause, automatic resume catch-up, and
stop control publication and access.

This package uses Package 1's source and membership contracts.
It includes Team backend authority, local publication work, and the local
Desktop sharing controls. It also includes Team recall of authorized Workspace
contributions and Git Anchors. Team collections are deferred.
Personal membership design remains owned by Package 1.

### Sharing authority and processing

Extend the existing
[`Shared Memory owner workflow`](shared-memory-owner-workflow.md).
Its consent binds a source, destination, mode, representation, and reviewed
content. Continuous consent follows revisions of that source.
It does not authorize arbitrary future Project members.

Add explicit authority for the owner's continuous selection and destination.
Record the selection version, shared detail, policy, and active or paused state.
Track which inclusion or direct action supplies each source's sharing authority.
Use existing Share Grants for source access instead of trusting a live
Personal Project lookup as an access grant.

Extend
[`shared-memory-repository.ts`](../packages/db/src/shared-memory-repository.ts)
and
[`pending-share-processing-workflow.ts`](../packages/db/src/pending-share-processing-workflow.ts).
New members and later revisions need durable work records and safe retries.
Policy processing and encrypted representation preparation must finish before
Team visibility begins. Retries cannot create duplicate logical contributions.

Pause must prevent publication from already queued work as well as new work.
Resume must reconcile current membership and all eligible source advances.
Stop must invalidate queued authority and the grants supplied only by that rule.
Workers must recheck rule versions and source authorization before publication.
This prevents late work from restoring access after stop or exclusion.

### Sharing controls and Team recall

Update the sharing controls in
[`CollaborationRoutesImpl.tsx`](../apps/desktop/src/renderer/collaboration/CollaborationRoutesImpl.tsx)
and their API contracts. Show destination, shared detail, publication state,
pending members, catch-up progress, and remaining sharing reasons.
Remove the Snapshot/Continuous choice from the new semantic sharing flow.

Keep Workspace selection explicit or bound to an enabled mapping.
A repository fingerprint grants no Workspace Access. Team filtering must operate only on authorized representations and
approved metadata. Local folder equality cannot merge different Users' contexts.

Keep Personal Projects private as selectors for source contributions.
Preserve Git Anchor filtering across authorized contributions from different Users.
Do not expose Personal Project names, private membership structure, local folder paths,
or unshared source metadata through counts, summaries, or evidence expansion.

### Sharing migration and completion

Existing snapshot shares require a compatibility policy.
Do not expand their consent into continuous or future-source sharing silently.
Migrate existing grants and disclosed metadata only through the approved policy.
Conversation Source Access remains separately authorized.

Update Team mapping, sharing, local publication, and operation documentation.
Complete acceptance scenarios 5 through 10, plus the Team parts of 11 and 12.
Repeat Personal regression coverage where shared contracts change.
The package is complete when the two-User flow, queued-work races, catch-up,
revocation, and migration tests pass without widening unauthorized access.

## Implementation decisions

The core membership and continuous sharing behavior is settled.
Package 1 preparation separates confirmed choices from engineering defaults.
Package 2 still requires the product decisions listed below.

### Package 1 decisions

The User confirmed exact Folder matching, original context until correction,
multiple Project membership, and no nesting for Package 1.
The [implementation plan](personal-project-implementation-plan.md#engineering-defaults)
defines proposed exclusion behavior, capture-policy compatibility, migration,
request contracts, and Personal membership synchronization.
Package 2 must consume the same source and membership definitions.

### Package 2 decisions

On 20 October 2026, the User confirmed the following policies.
Removing a Conversation from a shared Project revokes the sharing reason
supplied by that Project. Independent rules and direct shares retain their
own authority.

Excluding the owner's Conversation from a Team Workspace revokes its existing
access there and blocks every sharing route until the owner removes the exclusion.
The exclusion preserves Personal Memory and other Users' independent contributions.
Removing the exclusion resumes eligible sharing and catches up automatically
through currently active continuous rules. Paused and stopped rules keep their states.
Without an applicable active rule, removing the exclusion publishes nothing.
The removal action shows the sharing effect before confirmation.

When several reasons share one source, the highest detail permitted by a
remaining reason and current policy is available. Removing a broader reason
removes its additional detail while preserving narrower authorized access.
Each reason still authorizes only its own eligible content revisions.

Changes to an active continuous rule's shared detail or content policy apply
to both existing and future Memory. Sharing more requires explicit review and
confirmation before reprocessing eligible history and following future updates.
Reductions remove unsupported access while preserving independently authorized access.
Already authorized new members and later turns require no repeated confirmation.

Personal Projects remain private and select Memory for sharing to a Team Workspace.
Sharing does not create a Team collection or publish Personal Project organization.
Team collections are deferred beyond Package 2.

Existing snapshot shares retain their content and consent limits.
An explicit owner action is required to convert them to continuous sharing.
Previously disclosed metadata retains its existing authorization boundary.

Each destination Workspace has independent sharing rules.
Adding a Workspace leaves existing sharing unchanged until the owner explicitly stops it.
Each rule retains its destination, detail, policy, and lifecycle state.
Changing destinations uses separate start and stop actions.

These policies preserve Personal ownership and current Workspace Access requirements.
The [Package 2 preparation](team-continuous-sharing-preparation.md) records
the confirmed decisions and implementation sequence.

## Acceptance scenarios

These scenarios define the required behavior for implementation validation.
Use the existing deterministic recall and Team authorization fixtures where
they cover the boundary. Extend them for membership and continuous selection.
The existing [Project cutover results](project-cutover-validation.md) cover the
current assignment model. They do not establish these new behaviors.

1. Add a Koed Conversation to `Test project`. Recall it through the Project,
   Git Anchor, and applicable Folder without changing its source identity.
2. Include a Git Anchor and a Folder. Existing and future matching Conversations
   join the Project. An individual inclusion admits only that Conversation.
3. Find one Conversation through overlapping inclusions. Return one logical
   source, retain all membership reasons, and preserve evidence lineage.
4. Recall the Koed repository. Exclude unrelated members of its umbrella Project,
   including content carried by mixed summaries and expansion.
5. Share each selector type. Admit its existing and future members and later
   turns under current authority and policy, without exposing pending content.
6. Pause while publication is queued. Keep prior shared content readable and
   prevent publication of new members or revisions.
7. Capture and change membership while paused. Resume and automatically catch
   up with the currently eligible set, without duplicate contributions.
8. Stop while work is queued or retrying. Prevent renewed access from that rule.
   Preserve Personal Memory and access supplied by independent active rules.
9. Share matching repositories from two Users with different checkout paths.
   Recall both authorized contributions and no unshared Personal content.
10. Remove Workspace Access, revoke consent, or invalidate content policy during
    catch-up. Deny affected publication and reads through the existing boundaries.
11. Retry after worker restart or temporary destination failure. Preserve the
    selected target, progress, rule state, and source identity.
12. Transition old assignments and shares using the approved migration policy.
    Preserve unknown provenance, explicit corrections, and existing consent limits.
