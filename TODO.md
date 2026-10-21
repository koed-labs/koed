# Implementation backlog

## Operational alpha follow-ups

- [ ] Make explicit LCM preview preparation finalize eligible live-capture
      tails using the correct work class. The Cedar trial used the existing
      compaction function explicitly before its final summary cycle.

- [ ] Normalize generated migration metadata formatting. The handover-wide
      Prettier check reports the journal and 18 generated snapshots. Keep this
      formatting cleanup separate from alpha runtime behavior.

- [ ] Support or clearly prevent adding a direct snapshot after a Git rule has
      already created the destination grant. The current Pending Share reaches
      activation and rejects the existing destination grant. The alpha overlap
      walkthrough must establish the direct reason before Git admission.

- [ ] Reduce Pending Share activation conflicts (PostgreSQL 40001 and 40P01)
      observed during the native trial and Project trial. Rule admission now
      retries these conflicts up to three times before requiring attention.
      Investigate underlying transaction lock ordering and the remaining direct
      activation path; preserve approval, current authority, and publication gates.
- [ ] Make owner share labels show pending activation failures before an active
      rule's update status, and preserve the source title in owner navigation.

- [ ] Make the setup confirmation copy distinguish configured external model
      services from model downloads. The external setup gate already uses
      service health and does not install models.

## Recall grouping and continuous sharing

The agreed model and branch comparison are in
[`docs/recall-and-continuous-sharing-model.md`](docs/recall-and-continuous-sharing-model.md).
Deliver this work in two packages. Package 1 can complete independently while
preserving existing Team behavior. Package 2 uses its stable membership and
source contracts. Resolve each package's open decisions before dependent work.

### Package 1 Personal Project remediation

Scope and completion criteria are in the
[Personal work package](docs/recall-and-continuous-sharing-model.md#work-package-1-personal-project-remediation).
The [implementation plan](docs/personal-project-implementation-plan.md) defines
the following sequence, source contracts, migration rules, and completion tests.
Package 1 is locally implemented. P1-14 and the upgrade-specific P1-15 scope
were superseded on 20 October 2026 because Projects are new on this branch.
Current Personal, Team, migration, and
native acceptance journeys and package checks passed. The User chose to omit
the recommended minor changeset on 20 October 2026. See the
[validation record](docs/personal-project-validation.md).
Package 1 completion evidence remains in that validation record.
The [local ticket file](tickets.md) now contains the operational alpha milestone.

- [x] Confirm exact Folder matching, original context until correction,
      multiple Project membership, and no nesting in Package 1.
- [x] P1.1 Define shared source, Folder, membership, and recall-target contracts,
      including legacy decoding and migration inventory requirements.
- [x] P1.2 Add owner-scoped membership storage, exclusions, versions, and a
      durable selection change journal. Preserve all inclusion reasons.
      P1-05 completes named Projects, direct inclusions, retained removals,
      stale-write protection, and the owner journal. P1-07 adds retained Git Anchor
      rules, authorized preview, dynamic membership, and independent removal.
      P1-08 adds retained exact Folder rules and the shared inclusion-reason reader.
      P1-09 completes retained exclusions, reviewed Add back, and full explanations.
- [x] P1.3 Separate capture-time Git and Folder context and explicit corrections.
      Preserve original attribution across continued capture and imports.
      P1-06 completes independent capture-time Folder identity and exact recall,
      with source-time evidence and durable unresolved history. P1-10 adds
      independent reviewed corrections, resets, and retained audit revisions.
      P1-11 completes verified source-context receipt, causal merge, conflict
      display, capability-gated publication, and separate correction delivery.
      Two-device capture, recall, corrections, conflict resolution, replay, and
      restart passed. Existing Team snapshots remain unchanged.
- [x] P1.4 Use the new targets across Personal retrieval, expansion, graph views,
      Global repository preference, and durable Memory Answer requests.
      P1-02 completes durable selection pinning and the raw-evidence boundary.
      P1-03 completes derived-evidence and recursive expansion boundaries.
      P1-04 completes owner inventory, Conversation lookup, graph inspection, and
      Desktop source-binding pass-through. P1-05 adds direct named Project
      membership, inventory, and recall. P1-06 adds exact Folder selection through
      source lookup, raw/derived evidence, inventory, inspection, and Desktop Ask.
      P1-07 adds Git Anchor rule membership through the same boundary.
      P1-08 adds exact Folder rules without source reassignment or embedding writes.
      P1-09 adds Project-only exclusions throughout those source boundaries.
      P1-17 activates the public adapters and retires legacy source replacement.
- [x] P1.5 Add Personal membership sync and source-context compatibility,
      including offline conflict, removal, replay, and older-peer behavior.
      Preserve P1-01 opaque Project and revision identifiers on import;
      UUID-shaped native records must not become a transport restriction.
      P1-12 completes catalog/direct sync, reviewed conflicts and pending sources,
      verified-body recall, opaque identities, replay, restart, and old-peer
      gating. Existing Team snapshots remain unchanged. P1-13 completes rule/exclusion
      sync, exact reviewed conflicts, future source guards, correction-driven
      recall, restart, policy preservation, and shared capability advertisement.
- [x] P1.6 Replace Personal Desktop moves with inclusion controls and independent
      filters. Keep source correction separate from organization. Native flows
      and the full Desktop regression suite pass.
- [x] P1.7 Integrate the current model and retire legacy writes. Projects are
      available directly. The User removed the existing-Project upgrade and its
      Capture Target preservation/repair workflow. Preserve committed SQL history;
      Project membership remains independent from capture and Team authority.

- [x] P1.8 Run integrated acceptance and update Personal documentation.
      P1-16 publishes the bounded owner enumeration and durable metadata change
      contract for Package 2. P1-17 completes native/Team compatibility acceptance
      and current-behavior documentation. The User chose to omit the recommended
      minor changeset; no new Team publication authority is implied.

### Package 2 Team continuous sharing

Scope and completion criteria are in the
[Team work package](docs/recall-and-continuous-sharing-model.md#work-package-2-team-continuous-sharing).
This package owns sharing authority, local publication, Team backend processing,
Desktop sharing controls, and Team recall. Personal Projects remain private
sharing selectors. Team collections are deferred.
The [decision record](docs/team-continuous-sharing-preparation.md) records the
confirmed behavior. On 21 October 2026, the User approved a smaller operational
alpha milestone. The [implementation plan](docs/team-continuous-sharing-implementation-plan.md)
and [current tickets](tickets.md) define ALPHA-01 through ALPHA-05.
The [archived tickets](docs/archive/2026-10-21-package-2/tickets.md) retain the
original fourteen slices and their criteria. P2-01 through P2-08 are locally
complete. P2-09 through P2-14 and the full package gate are deferred.
See the [Package 2 validation record](docs/team-continuous-sharing-validation.md).
Tests remain deferred until a changed boundary or acceptance requirement needs them.
Package 2 targets the current alpha build. Breaking API, protocol, and schema
changes can be coordinated across components; backward compatibility is out of scope.

The active milestone is:

- [ ] ALPHA-01: Disable unfinished content-policy editing across all entry points.
- [ ] ALPHA-02: Run matching native Desktop and local Docker Team Backend builds.
- [ ] ALPHA-03: Demonstrate sharing, later updates, lifecycle controls, and teammate recall.
- [ ] ALPHA-04: Demonstrate brief disconnect and restart recovery on one publisher.
- [ ] ALPHA-05: Deliver the trial guide, acceptance evidence, and known limitations.

The following list records the original Package 2 decisions and implementation
status. Deferred entries are follow-up work, not prerequisites for the alpha.

- [x] Confirm that Project removal revokes only its sharing reason and that
      a destination exclusion blocks every sharing route for the owner's source.
- [x] Confirm that overlapping reasons combine permitted detail, reductions
      remove unsupported detail, and snapshots require explicit conversion.
- [x] Keep Personal Projects private as sharing selectors and defer Team collections.
- [x] Apply detail and policy changes to existing and future Memory, with
      explicit confirmation before sharing more.
- [x] Resume eligible sharing and catch up after exclusion removal, while
      keeping paused and stopped rules unchanged.
- [x] Keep destination Workspaces independent until the owner explicitly stops sharing.
- [x] Approve and publish the fourteen vertical tickets, their blocking
      dependencies, and the matching implementation plan.
- [x] Remove backward-compatibility concessions, old-format support, and
      historical upgrade testing from Package 2. Keep consent and retention rules.
- [x] P2-01: Explain why a Conversation is shared.
- [x] P2-02: Share one Conversation continuously, including lifecycle controls.
      Local acceptance covers API, publication, Desktop flows, durable delivery,
      delayed summaries, independent reasons and policy contention. The combined
      native journey remains in the package acceptance checklist below.
- [x] P2-03: Review what a Git Anchor would share.
- [x] P2-04: Share a Git Anchor continuously. Local acceptance covers explicit
      future-member approval, complete durable baselines, native source identity,
      correction and removal evidence, old receipts across newer goals and control
      epochs, actual Pending Share/Privacy publication, independent direct sharing,
      paused detail with a later summary, future-source recall, and stop fencing.
      The combined native journey remains in the package acceptance checklist.
- [x] P2-05: Share an exact Folder continuously. Local acceptance covers exact
      Personal identity, path privacy, conclusive membership evidence, durable
      correction and delivery, owner explanations, existing/future publication,
      independent reasons, all lifecycle controls and authorized Team recall.
- [x] P2-06: Use a private Project to select shared Memory. Local acceptance covers
      overlapping inclusions, reason-specific removal and exclusion, signed sync,
      confirmed deletion, private organization, durable recovery, native approval,
      existing/future publication, independent reasons and Team recall. Recall
      preserves exact publication identities until authorization. The combined
      native journey remains in the package acceptance checklist.
- [x] P2-07: Add a Workspace without changing existing sharing. Local acceptance
      covers separate device previews/native approvals, unchanged paused state,
      different detail per destination, independent publication and controls,
      denied-destination isolation, retry and retained snapshots. The combined
      native journey remains in the package acceptance checklist.
- [x] P2-08: Change the detail a rule shares. Local acceptance covers native
      review and exact authority versions, immediate read and cached-recall
      restrictions, preserved independent reasons and paused revisions, active
      history and future processing, durable scope acknowledgment, obsolete
      Privacy work and unresolved-admission fencing for all selectors, stable
      receipt recovery after independent owner-policy expansion, Privacy-policy
      drift rejection, and Desktop owner controls. The combined native journey
      remains in the package acceptance checklist.
- [ ] P2-09: Change a rule's content policy. Deferred with partial implementation: per-rule Privacy
      categories under enclosing constraints, content-bound policy identity,
      reviewed scope contracts, native review, durable delivery, current read
      gates and owner controls are wired. The first Docker case verifies paused
      retained-history reprocessing and restoration without new revisions.
      ALPHA-01 isolates unfinished editing. Resume outstanding acceptance only
      when this capability returns to scope. Preserve paused and stopped lifecycle.
- [ ] P2-10: Deferred. Exclude a Conversation from one Workspace. Prioritize before
      routine sharing of mixed private and work content.
- [ ] P2-11: Deferred. Remove an exclusion and catch up eligible sharing.
- [ ] P2-12: Deferred. Convert an existing snapshot explicitly.
- [ ] P2-13: Deferred. Recover a selection rule after an extended interruption.
- [ ] P2-14: Deferred. Continue a rule from another Personal device.
- [ ] Deferred full-package acceptance: verify the combined
      two-owner, two-Workspace, two-device journey and complete selector/control
      matrix, run applicable checks, and record results.
- [x] Resolve the Docker fixture's `SharedMemoryPersonalEmbeddingReuseConflict`
      for Removed Member Deployment Note before declaring the package fixture
      gate passed. Retained Team authorization must not depend on restoring the
      removed owner's Workspace access. Do not invalidate Personal vectors as a
      validation workaround.
- [ ] Complete remaining full-package sharing, mapping, publication, and operation
      documentation when deferred capabilities return to scope. ALPHA-05 owns
      the current trial guide and status documentation.

## Asynchronous Memory Answer adapters

Ordinary MCP and the Pi extension use explicit non-blocking submission and
result collection over the existing durable tasks. Blocking remains available;
completion does not automatically wake the agent. See `docs/async-memory-answer.md`.

Follow-ups:

- Validate default stdio negotiation and installation upgrades with modern MCP
  on supported host releases. The conditional-delivery native fixtures require
  explicit Codex 2026-07-28 selection and Claude v2/auto negotiation; their
  successful delivery does not prove legacy-profile transport migration.
- Repeat the conditional-delivery Claude matrix in the interactive TUI. The
  2.1.267 native print matrix used an explicit noninteractive background opt-in;
  normal setup does not enable that option.

- Extend agent-behavior evaluation across supported harness versions and models,
  including task-ID retention across context compaction and deliberate collection
  after reconnect. Keep deterministic contract tests separate from model scores.
- Preserve redacted owner cancellation after Team access revocation through the
  model-facing cancellation tool. Its current authorized-read preflight can deny
  cleanup that the backend allows; do not bypass backend task ownership or disclose
  an answer to solve this.
- Test repeated Claude Code recalls in one Conversation and delivery after
  reopening.
- Update AI Client capability snapshots (`host_task_notifications`,
  `model_continuation_during_tool`). They still report Claude Code as
  `unsupported` and Codex/Pi as `requires_bridge`, which does not reflect the
  explicit model collection or the opt-in Claude route. Report these per mode
  and setup state rather than per driver; do not equate a prompt receipt with
  automatic background completion delivery.
- Bind a maintained TypeScript MCP Tasks runtime to the existing execution owner
  when its SDK and supported AI Clients provide the required extension.
- Defer managed Codex and Claude Agent SDK presentation adapters until the
  independent-client work has been addressed.
- Reassess automatic native completion when supported hosts provide a maintained
  receiver mechanism. Preserve current authorized collection as the portable
  path; do not revive Stop-hook feedback or add another execution queue.

## Personal Device pairing and session publication

Current behavior is documented in `docs/device-pairing.md` and ADR-0045.

Follow-ups:

- Internet-accessible relay and restricted-network traversal.
- Approval from joined replicas that do not host the Authority.
- Moving the existing Authority relay listener into the supervisor.
- Validate physical Studio-to-Electron capture, later-turn updates, and offline
  catch-up on the updated runtime.

## Server distribution split (PR #404)

- Land the private Server package and `koed` command migration with existing runtime assembly.
- Land the separate lazy CLI loading/help extraction without component provisioning commands.
- Validate built, signed, installed, and started headless components end to end before enabling npm publication and release promotion.
- Deliver Desktop on-demand Privacy only after install, upgrade, startup, integration setup, and rollback validation; preserve existing bundled Privacy until then.
- Deliver opt-in Desktop Install CLI separately, with relocation, removal, and Electron helper validation.

## Memory Answer evidence-selection follow-ups

Recall now preserves complete observed references when candidates with the same
canonical source merge. It also retains distinct selected parent summaries and
expanded children within the existing evidence budgets. A parent and its
children share lineage and must not count as independent corroboration.

- Reconcile the historical reference-failure count. The investigation summary
  reported eight failed calls, while the retained audit contains nine call
  records with unresolved-reference errors. Determine whether the difference
  is a counting or classification error. The records show two distinct cases:
  valid expanded references discarded when their canonical source was already
  present under a searched node reference, and invalid model selections that
  combine a parent node ID with a nonzero expanded-child position. The former
  is repaired; the latter must continue to fail closed. If the counts cannot be
  reconciled, retain the uncertainty rather than claiming every historical
  failure has been fixed.
- Investigate completeness of the model's selected supporting evidence. In a
  synthetic Harbor archive readiness question, the answer correctly required
  restoring a backup, replaying exactly 120 retained items with zero missing
  IDs within 90 seconds, checking that the persisted byte cursor equals the
  final source byte offset, and obtaining both Store owner and Capture owner
  approval before moving traffic. However, its selected evidence omitted the
  available backup-restoration source. Determine why the model omitted that
  source and improve selection while preserving strict reference validation
  and evidence budgets. Do not silently append unselected evidence or add
  backend LLM synthesis to mask the omission.
- Preserve the validation boundary for selected parent summaries. A
  deterministic final-bundle regression selects a complete rollout summary
  alongside partial children and checks that the deadline, byte-cursor check,
  and both approval-owner facts survive. Five live questions exercised searched
  references, expanded references at nonzero positions, and a deduplicated
  expansion alias, but none selected the complete summary together with partial
  children. Those calls therefore do not establish live coverage of that
  specific case. Retain the deterministic regression and this limitation; do
  not add extra live runs or a harness solely to force coverage.
- Diagnose recurring embedding model checksum failures. During native deployment
  validation, the first download failed SHA-256 verification and was rejected;
  one retry verified the same pinned 639,150,592-byte artifact successfully.
  The transport cause was not established. If the failure recurs, record HTTP
  status, expected and received byte counts, and expected and computed digests
  to distinguish an incomplete or corrupted transfer from an artifact identity
  change. Keep checksum enforcement; do not accept a mismatched artifact or
  change the pinned model merely to make installation succeed.

## Project release follow-ups

- Add explicit controls for larger historical catch-up. Automatic selection
  remains limited to 50 Conversations per supported AI Client from the last
  30 days. Keep selection controls separate from fresh-import Project assignment
  and preserve the migration cutoff for previously captured history.

- Release the locally validated Project cutover as one coordinated change.
  The approved minor changeset and acceptance evidence are recorded in
  `docs/project-cutover-validation.md`. Push, PR creation, and main merge remain
  separate release actions.

- Tickets 17 and 18 are now integrated and locally validated after the ticket 16
  checkpoint. Preserve their release order after the Project cutover when
  preparing the release. The PDS branch preference uses the verified captured
  observation and checks the local effective assignment.
