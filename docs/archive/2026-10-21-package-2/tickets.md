> Archived on 21 October 2026. This records the previous Package 2 scope
> and status. Use the [current tickets](../../../tickets.md) for active work.
> Original text is retained below. Relative links point to their new locations.

# Package 2: Team continuous sharing implementation tickets

The User approved these fourteen vertical slices and their blocking dependencies.
This single file replaces the Package 1 tickets and the previous Package 2 draft,
as requested. The [implementation plan](implementation-plan.md)
and [sharing decisions](../../team-continuous-sharing-preparation.md) supply the
engineering constraints and agreed policies. Package 1 completion remains recorded
in the [validation record](../../personal-project-validation.md) and [backlog](../../../TODO.md).

**Implementation authorized on 20 October 2026.** The User instructed the agent
to proceed through this file and defer tests until necessary. Work follows the
blocking dependencies below; P2-01 through P2-08 are locally complete.

## Rules for every slice

Each ticket includes the storage and contracts it needs, authorized API
operations, Desktop controls, and tests of the resulting Team access.
No ticket waits for a separate UI or read-authorization ticket.
Each has one user journey and a concrete demonstration.

Package 2 targets the current alpha build. Breaking API, protocol, and schema
changes are allowed; update the affected callers and services together.
Do not add compatibility adapters, parallel old/new formats, deprecated routes,
mixed-version support, or historical upgrade tests. Remove obsolete paths when
their replacements are ready. Required schema changes are part of each slice
and do not have to be additive.

Preserve sharing intent and consent limits in the current model.
Keep snapshot conversion explicit, Personal Projects private, and Conversation
Source Access separately authorized. Personal-only API Tokens cannot gain Team
authority. Keep the existing transaction owner and processing pipeline.
Do not introduce backend LLM synthesis.

When a selector is added, test all controls already available for that selector.
When a control is added, test all selectors already supported.
The later change supplies coverage for their combination, so unrelated
features do not become artificial blockers.

All authority-changing slices verify queued-work races and the affected
recall, evidence, expansion, cache, and direct-read boundaries.
Validate the current request contract and authority in each slice. An
unavailable operation cannot silently degrade into broader sharing.
Rule versions, consent versions, and publisher fencing prevent stale work;
they remain required regardless of software-version compatibility.

No standalone prefactoring ticket is needed for this approved breakdown.
The existing workflow document keeps bundle invariants in the transaction-owning repository. The first slice
adds the reason model through an owner-visible inspection flow.
There is no wide mechanical refactor requiring an expand–contract exception.

## P2-01: Explain why a Conversation is shared

**What to build:** The owner opens a Conversation and sees each destination,
the reason it is shared, its current detail, and whether updates are active,
paused, or fixed to a snapshot.

**Blocked by:** None.

**Status:** locally-complete

- [x] Record direct shares as durable reasons with their consent limits,
      permitted representations, separately authorized source access, and
      approved repository snapshots in the current model.
- [x] Show owner-only reasons through the API and Desktop. Keep management
      metadata available where current ownership permits it, without restoring
      Workspace content access to a removed reader.
- [x] Explain existing snapshots, continuous shares, and paused or stopped
      sharing accurately. Keep owner-private identifiers out of Team responses.
- [x] Demonstrate the owner explanation for snapshot, continuous, and paused
      shares using the current contract. Verify teammate recall, denial, and
      retention against their recorded authority.

**Sizing boundary:** Existing source-based shares and their explanation only.
No new selector or continuous rule publication in this slice.

**Acceptance:** See [Package 2 validation](../../team-continuous-sharing-validation.md#p2-01-owner-sharing-explanation).

## P2-02: Share one Conversation continuously

**What to build:** The owner shares one Conversation, sees existing Memory
and later eligible turns and completed summaries reach a teammate, and can
pause, resume with automatic catch-up, or stop that sharing.

**Blocked by:** P2-01.

**Status:** locally-complete

Local acceptance covers reviewed Conversation creation, independent snapshot
retention, durable device delivery, exact publication authority, later turns and
delayed summaries, lifecycle controls, read denial and policy contention. See
[P2-02 local acceptance](../../team-continuous-sharing-validation.md#p2-02-local-acceptance).
The combined native selector/control journey remains in the package gate below.

- [x] Review and confirm one Conversation, one Workspace, detail, and policy.
      Create a continuous rule for that source only. Preserve existing shares
      as independent reasons; do not convert a snapshot silently.
- [x] Reuse existing source publication and lifecycle operations. Bind rule
      authority to the reason and the exact representations and revisions it
      permits. Keep one logical source-and-destination grant.
- [x] Demonstrate current content, a later turn, a later completed summary,
      pause during preparation, resume catch-up, and stop during retry.
      Preserve access supplied by other reasons.
- [x] Show pending versus acknowledged state in Desktop. Persist retry identity,
      prevent obsolete publication, and verify teammate reads and denials.

**Sizing boundary:** One fixed source, one publisher, and one destination per
rule. Reuse the existing per-source workflow; no dynamic member discovery.

**Acceptance:** See [P2-02 local acceptance](../../team-continuous-sharing-validation.md#p2-02-local-acceptance).

## P2-03: Review what a Git Anchor would share

**What to build:** The owner selects a Git Anchor and Workspace, inspects the
current eligible Conversations, and sees that future matching Conversations
would also be included, before deciding to share.

**Blocked by:** None.

**Status:** locally-complete

- [x] Provide an owner-only review using the bounded Personal selection
      contract, current source readiness, destination authority, and policy.
- [x] Combine all inclusion records and pages. Show current eligibility and
      unresolved sources without presenting a partial page as the complete set.
- [x] Keep the reviewed selector and destination exact. Refresh invalid or stale
      review state without changing the selected scope silently.
- [x] Demonstrate review, pagination, refresh, and cancel. Review alone creates
      no Share Grant, consent for publication, or Team-visible content.

**Sizing boundary:** A complete inspection flow. Publication is P2-04.
This can use Package 1 and existing destination review without P2-01.

**Acceptance:** See [Package 2 validation](../../team-continuous-sharing-validation.md#p2-03-git-anchor-sharing-review).

## P2-04: Share a Git Anchor continuously

**What to build:** The owner confirms the Git Anchor review. Existing and
future matching Conversations become shared; sources that stop matching lose
only this rule's reason.

**Blocked by:** P2-02, P2-03.

**Status:** locally-complete

- [x] Approve future-member authority explicitly and admit eligible sources
      through the existing Pending Share and privacy workflow.
- [x] Consume bounded membership changes durably with verified source identities,
      complete baselines, idempotent delivery, and one authorized publisher.
      Failed or partial enumeration cannot prove removal.
- [x] Reuse pause, resume, and stop across members and later revisions. Revoke
      this rule's reason when a source stops matching, including while paused.
      Preserve direct and other independent reasons and their permitted detail.
- [x] Demonstrate existing and future sources, overlap with direct sharing,
      source-context correction, queued-work races, and authorized Team Git
      Anchor recall. Include paused detailed access alongside later summary access.

Local acceptance: [Git Anchor publication and membership](../../team-continuous-sharing-validation.md#p2-04-local-acceptance).

**Sizing boundary:** One dynamic selector on one publisher. Build on the review
and source workflow already delivered. Basic durable retry is required here;
extended interruption recovery and device takeover have their own journeys.

## P2-05: Share an exact Folder continuously

**What to build:** The owner shares an exact Folder and its existing and
future matching Conversations using the same review and lifecycle controls.

**Blocked by:** P2-04.

**Status:** locally-complete

- [x] Add Folder selection to review, confirmation, publication, and the owner
      explanation. Keep the exact Folder identity supplied by Personal selection.
- [x] Exclude subfolders, parent folders, and equal paths on unrelated devices.
      Do not publish the local path as Team organization metadata.
- [x] Follow membership changes and corrections. Remove only this reason when
      a Conversation leaves the Folder; preserve other authorized reasons.
- [x] Demonstrate creation, later membership, pause/resume/stop, and Team recall.
      Extend coverage for any other controls already implemented.

Local acceptance: [Exact Folder sharing](../../team-continuous-sharing-validation.md#p2-05-local-acceptance).

**Sizing boundary:** A new selector using the dynamic workflow from P2-04.
It does not depend on Project sharing.

## P2-06: Use a private Project to select shared Memory

**What to build:** The owner shares the Memory selected by a Personal
Project. The Team receives authorized contributions without acquiring the
Project or its private organization.

**Blocked by:** P2-04.

**Status:** locally-complete

- [x] Review and share existing and future Project members, including direct
      Conversation inclusions and existing Git Anchor or Folder inclusion rules.
- [x] Retain a Project's sharing reason while any of its inclusions still makes
      the source a member. Remove that reason when membership actually ends.
- [x] Preserve independent Git, Folder, direct, and other Project reasons.
      Keep Project names and private membership metadata out of Team surfaces.
- [x] Demonstrate membership edits, Project exclusions, Personal sync changes,
      pause/resume/stop, and teammate recall. Do not create Team collections.

Local acceptance: [Private Project sharing](../../team-continuous-sharing-validation.md#p2-06-local-acceptance).

**Sizing boundary:** Project membership uses the already completed Package 1
contract. It does not depend on standalone Folder sharing.

## P2-07: Add a Workspace without changing existing sharing

**What to build:** The owner adds another destination and controls each
Workspace's sharing independently.

**Blocked by:** P2-02.

**Status:** locally-complete

- [x] Start a separately reviewed rule for the new Workspace. Preserve existing
      rules, detail, policy, publication progress, and lifecycle state.
- [x] Show per-destination status and controls. Pause or stop one destination
      without altering another destination or an independent reason.
- [x] Allow an eligible destination to progress when another is unavailable or
      denies publication. Keep authority and retry state destination-bound.
- [x] Demonstrate Engineering and Design receiving the same Conversation,
      independent pause/stop, and isolated destination failure.

Local acceptance: [Independent destinations](../../team-continuous-sharing-validation.md#p2-07-local-acceptance).

**Sizing boundary:** Independent destination management for available selectors.
Dynamic selection is not a prerequisite for the first demonstration.

## P2-08: Change the detail a rule shares

**What to build:** The owner changes a rule's shared detail for existing and
future Memory, with explicit confirmation before disclosing more.

**Blocked by:** P2-02.

**Status:** locally-complete

- [x] Review and confirm increases against current rule and policy versions,
      then reprocess eligible history and follow future content.
- [x] Apply reductions at the Team read boundary when accepted, before narrower
      replacement content finishes processing.
- [x] Preserve the detail and revisions independently permitted by other
      reasons. Do not borrow a paused detailed reason for newer summary content.
- [x] Demonstrate increases, reductions, stale review, overlapping reasons,
      and unchanged paused/stopped state through Desktop and Team reads.

**Acceptance:** See [P2-08 local acceptance](../../team-continuous-sharing-validation.md#p2-08-local-acceptance).

**Sizing boundary:** Detail changes. The reviewed rule-amendment workflow can
then support content-policy changes in P2-09.

## P2-09: Change a rule's content policy

**What to build:** The owner changes what content a rule permits, sees its
effect, and confirms any increase before existing and future Memory change.

**Blocked by:** P2-08.

**Status:** in-progress

- [ ] Extend the reviewed amendment flow to content policy and reprocess
      eligible history under current owner, Team, and Workspace constraints.
- [ ] Enforce restrictions immediately at read and publication boundaries.
      Reject stale confirmations and obsolete processing work.
- [ ] Preserve independently authorized content without combining policies
      into a representation that no remaining reason actually permits.
- [ ] Demonstrate a restrictive edit and a confirmed broader edit, including
      paused rules and overlapping reasons. Do not change lifecycle implicitly.

**Sizing boundary:** Content policy uses P2-08's review, versioning, and
reprocessing flow. It does not wait for Folder or Project sharing.

## P2-10: Exclude a Conversation from one Workspace

**What to build:** The owner excludes a Conversation and removes its access
through every sharing route to that Workspace.

**Blocked by:** P2-04.

**Status:** ready-for-agent

- [ ] Provide an owner-authorized exclusion action with a clear explanation.
      Persist the owner/source/destination block independently of rule state.
- [ ] Revoke existing access and block direct shares, continuous rules, queued
      work, retries, and later attempts to re-admit the source.
- [ ] Preserve Personal Memory, other Workspaces, and other owners' independent
      contributions. Explain why the source is currently blocked.
- [ ] Demonstrate a Conversation shared directly and through a Git Anchor,
      exclusion while processing, and denial through Team read surfaces.

**Sizing boundary:** Apply and enforce an exclusion. Removing it is P2-11.
P2-04 supplies the real dynamic-admission route that must also be blocked.

## P2-11: Remove an exclusion and catch up eligible sharing

**What to build:** The owner reviews and removes a Workspace exclusion.
Active eligible rules resume sharing and catch up automatically.

**Blocked by:** P2-10.

**Status:** ready-for-agent

- [ ] Show which active rules would resume sharing before confirming removal.
      Recheck the exclusion and current authority when applying the action.
- [ ] Reconcile current membership and content, then publish through active
      eligible rules without duplicate contributions or repeated scope consent.
- [ ] Keep paused and stopped rules unchanged. Do not revive revoked snapshots.
      Without an eligible active rule, publish nothing.
- [ ] Demonstrate active, paused, stopped, removed-member, and no-rule cases,
      including pending acknowledgment when the Team Backend is unavailable.

**Sizing boundary:** Restoration and catch-up for an existing exclusion.

## P2-12: Convert an existing snapshot explicitly

**What to build:** The owner chooses a fixed snapshot, reviews the change,
and converts that source to continuous sharing.

**Blocked by:** P2-02.

**Status:** ready-for-agent

- [ ] Keep snapshots unchanged until explicit conversion. Bind approval to
      the current source, destination, rule or grant state, and consent limits.
- [ ] Convert only that source. Do not grant authority for future members of
      a Project, Git Anchor, or Folder.
- [ ] Retain independent reasons and separately authorized source access.
      Handle stale review and replay without partial or duplicate conversion.
- [ ] Demonstrate conversion, a later turn, pause/resume/stop, and continued
      denial of unrelated sources. Reject stale or mismatched conversion approval.

**Sizing boundary:** One existing snapshot and its subsequent source updates.
This does not depend on dynamic selectors or the exclusion interface.

## P2-13: Recover a selection rule after an extended interruption

**What to build:** After Koed or a Team Backend has been unavailable, the
owner sees pending changes reconcile automatically and accurate sharing status.

**Blocked by:** P2-04.

**Status:** ready-for-agent

- [ ] Recover missed events, stale pages, expired cursors, and interrupted
      delivery from a complete current baseline. Preserve transaction-visibility
      cursor semantics and durable operation identity.
- [ ] Catch up eligible members and revisions, remove reasons that ended, and
      reject obsolete publication. A failed baseline cannot prove removals.
- [ ] Distinguish local stop or membership-removal intent from remote
      acknowledgment. Do not claim that remote access ended while offline.
- [ ] Demonstrate a long outage with membership additions/removals, later
      turns, a queued stop, restart, and eventual convergence without duplicates.

**Sizing boundary:** One publisher recovering its rule. P2-04 already owns
basic durable delivery; this adds unattended recovery across expired history
and extended interruptions, with visible progress.

## P2-14: Continue a rule from another Personal device

**What to build:** An authorized second Personal device takes over an
existing rule and continues sharing without creating a duplicate or allowing
the former publisher to overwrite newer authority.

**Blocked by:** P2-13.

**Status:** ready-for-agent

- [ ] Show the current publisher and allow an authorized takeover using the
      existing rule consent. Require verified source availability on the device.
- [ ] Fence the old publisher and take a complete local baseline using P2-13's
      recovery path. Do not copy cursors across database histories.
- [ ] Preserve portable identity and original Folder context. Keep unavailable
      or local-only sources pending rather than guessing a source binding.
- [ ] Demonstrate two devices, offline old-publisher replay, Personal sync
      changes, and one logical contribution per destination after takeover.

**Sizing boundary:** Device handoff and its user-visible state. It does not add
new selectors, consent scope, or Team collections.

## Blocking dependencies

P2-01 and P2-03 have no ticket prerequisites. They form the initial frontier once
implementation is authorized. P2-02 unlocks independent destinations, detail
changes, and snapshot conversion. P2-04 unlocks Folder sharing, Project sharing,
exclusions, and outage recovery. Policy changes follow detail amendment;
exclusion removal follows exclusion; device takeover follows baseline recovery.

These are prerequisite edges, not a requirement to execute all tickets in
numeric order. When a blocker completes, its dependent tickets join the frontier
only after all their other blockers are complete.

## Package completion checklist

This gate sits outside the fourteen feature tickets. It verifies their combined
behavior; it does not defer UI, privacy, or read authorization
implementation to a final ticket.

- [ ] Record acceptance evidence for every ticket and its boundary documentation.
- [ ] Verify the combined two-owner, two-Workspace, two-device journey and the
      complete selector/control matrix, including privacy, denied access,
      overlapping reasons, retention, and independent destinations.
- [ ] Run applicable full fixture, semantic recall, Personal regression, native
      UI, current-schema, formatting, lint, typecheck, and build checks. Record results
      in the Package 2 validation record and distinguish local acceptance from
      unavailable staged deployment checks.
- [ ] Complete sharing, mapping, publication, operation, and package-status
      documentation. Apply the repository's changeset decision process before
      changing release notes. Package completion does not authorize push, merge,
      or deployment.
