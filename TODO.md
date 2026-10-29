# Implementation backlog

## Optional Privacy runtime delivery (29 October 2026)

The approved `tickets.md` owns the implementation and qualification sequence.
Tickets 01–06 have local implementation and controlled failure coverage.
The User authorized proceeding without unavailable Koed recall and requested omission of the changeset.

- Qualify exact runtime release-URL downloading against the complete immutable candidate.
  Fresh model downloading and packaged installation passed after the User approved LuLu connections.
  The Mac runtime used an authorized offline fixture because this candidate is unpublished.
- Retain native Linux x64 build, CPU inference and CUDA-bundle CPU fallback as ticket 08 gates.
  The Mac handoff includes frozen Mac components, source identities, and executable Linux instructions.
- Retain colleague CUDA execution and clean signed/notarized Mac acceptance as release gates.
  Fixtures and ad-hoc apps cannot pass those gates. Keep publication separate.

Packaged abrupt-exit recovery, external-to-local availability, and the native Team fixture's
filtering/authorization boundary passed. The v0.8.1 packaged CLI to new Desktop upgrade retained
synthetic memory and model assets. The old GUI and browser grant creation were not automated.

See [Mac qualification](docs/optional-privacy-mac-qualification.md) for evidence and limitations.

## Desktop Preferences design

- [ ] Establish and document a supported location for manually downloaded
      Privacy Filter component files. The current component installer downloads
      into temporary `runtime/components/.stage-*` directories and does not
      discover archives placed there manually. Keep this out of the Preferences
      UI. Verify matching release manifests and archives through the normal
      installer before activation; document the stable location only once this
      workflow is supported.

## Production follow-ups from the accepted alpha

- [ ] Investigate switching backends when the previous backend is offline.
      Connecting to the new remote backend was blocked by pending revocation
      of its device credential on the stopped local fixture and surfaced only
      “Collaboration is temporarily unavailable.” Assess separating new-backend
      connection from durable old-backend revocation, with clear status and
      recovery controls. Preserve identity isolation, credential and route
      fencing, and pending revocation; do not report old remote access as ended
      until the old backend acknowledges it. Reproduce with backend A offline
      while connecting to backend B, then bring A online and verify cleanup.

- [x] Fix destination-specific source sync after switching backends. Source
      preparation and owner pause/revoke select the requested backend;
      preparation also selects its deterministic relationship. The original two
      blocked remote Pending Shares completed with unchanged approvals and
      security bindings. Old local relationships remain paused and unchanged.
      Ninety collaboration-command tests and 20 live lookup-isolation checks
      pass. See the [validation record](docs/team-continuous-sharing-validation.md#backend-switch-destination-bound-source-sync--23-october-2026).

- [ ] Investigate the remaining initial Git Anchor admissions in the remote
      manual trial. The approved selection contains 15 initial native-eligible
      Conversations, but only two reached remote admission; 13 have no remote
      receipt or outstanding admission mutation. Four of those are repeatedly
      deferred and nine have not been attempted. Inspect candidate-admission
      failures and source scheduling fairness without widening eligibility,
      replacing ambiguous writes, or changing the approved selection. Two later
      Conversations have already completed. Keep this separate from recovery of
      the two existing Pending Shares and the destination-specific sync fix.

- [ ] Bound Privacy transport work, persist partial chunk results, cancel
      abandoned inference, and expose owner-only progress. Verify the six
      existing Git Anchor publications complete with their original approvals.

- [ ] Execute the [Privacy runtime migration plan](docs/privacy-runtime-migration-plan.md)
      agreed for planning on 26 October 2026. Use the existing authenticated
      service boundary and a supported, reproducible inference worker; a newer
      Node binding is not a prerequisite. The preferred candidate uses official
      Python ONNX Runtime behind the existing TypeScript tokenizer and masking.
      Preserve all classifier, source, consent, policy and publication checks.
      Implement and qualify the engine, concurrency and batching separately.
      See the [initial benchmark record](docs/team-continuous-sharing-validation.md#isolated-remote-privacy-engine-benchmark--23-october-2026)
      and the plan's later benchmark summary. Further measurements are bounded
      migration gates, not an open-ended optimization survey.
  - [x] PRIV-01: select and reproducibly package the supported inference boundary.
  - [x] PRIV-02: integrate one supervised CPU worker with existing service behavior.
  - [x] PRIV-03: add bounded two-worker concurrency and coordinated capacity contracts.
  - [x] PRIV-04: batch up to eight ready short fields within one admitted request.
  - [x] PRIV-05: qualify the combined service and one synthetic publication journey.
        Service adoption, normal publication, encrypted recovery and current-authority denial passed tickets 05–06.
  - [x] PRIV-06: stage authorized rollout, restart/recovery and matching-build rollback.
        Isolated rollback, approved manual rollout/restart/observation and four normally approved member publications passed tickets 07–08. The User confirmed the authorized Team view opens.

Manual-test correction: continuous Git Anchor and Project sharing review now
checks selection scope instead of requiring capture to stop. Nine isolated
consumer cases and eleven review-security cases pass. Live Project (four sources)
and Git Anchor (eight sources) preview and approval-review handoffs pass in the
updated development runtime. A follow-up correction also shows standalone selection rules in Shares and
allows initial publisher catch-up during capture, with complete membership and
fresh removal-proof checks. Fixed-snapshot, consent, Privacy and publication
checks remain required. Reassemble and verify packaged
candidate artifacts before distributing this later source correction.

- [x] Preserve verified Pi tool names and call IDs, align owner-preview tool
      eligibility, and keep published owner previews at their approved activation
      detail. Native wrappers and sibling reasoning stay excluded; canonical
      hashes, exact candidate validation, consent, device and Privacy checks stay
      strict. All four original failed publications recover through normal owner
      retry, and authenticated owner previews and grant reads pass. The local CPU
      backend uses the supported 120-second Privacy request timeout. See the
      [validation record](docs/team-continuous-sharing-validation.md#pi-tool-provenance-and-preview-correction-23-october-2026).

The User accepted the operational alpha on 21 October 2026 after manual testing.
The [production tickets](tickets.md) own the sequence and acceptance criteria.
PROD-01 through PROD-06 and P2-09 through P2-14 are locally complete.
The [candidate status](docs/team-continuous-sharing-release-candidate.md) records
matching artifacts, operator steps, exact acceptance scope and release prerequisites.
The [validation record](docs/team-continuous-sharing-validation.md#prod-06-final-local-disposition-23-october-2026)
contains the final disposition of every combined criterion.

The final native snapshot-after-rule correction passes matching-package acceptance:
the approved snapshot stays fixed at revision 51 while the transferred Git rule
advances to revision 55. The final encrypted backup, exact 262-table comparison
and actual restored-service checks preserve Alice's ten and Bob's three logical
contributions, independent reasons, consent, source revocation and publisher fences.
The acceptance database and backup are preserved separately; the clean manual-test
Team is running. Disposable native acceptance profiles remain stopped.

The User waived Koed recall and chose to omit the changeset for this work package.
Secure credential storage remains enabled. Portable native assets, signing and
notarization, WorkOS, remote staging and applicable GPU qualification require their
actual release inputs. They are not local passes. No push, PR, merge, external
deployment or publication is authorized by this completed local gate.

- [x] [PROD-01](tickets.md#prod-01-resolve-activation-contention): resolve activation
      contention across rule and direct sharing. Focused concurrency, source-update,
      retry-limit, revocation and policy-lock checks passed.
- [x] [PROD-02](tickets.md#prod-02-complete-normal-lcm-publication): finalize eligible
      live-capture tails through normal preparation and configured AI Client synthesis.
      A later synthetic turn reached Team LCM publication through ordinary APIs.
- [x] [PROD-03](tickets.md#prod-03-support-both-sharing-creation-orders): support a
      direct snapshot after a selection rule creates the destination grant.
- [x] [PROD-04](tickets.md#prod-04-make-owner-sharing-state-accurate): correct failure
      labels, source titles, revision explanations, and independent-reason controls.
- [x] [PROD-05](tickets.md#prod-05-make-the-production-build-reproducible): complete
      packaged startup, setup copy, and necessary build hygiene without demo paths.
      Fresh native core verification, approved fixture enrollment, shutdown,
      restart and authorized Shared Memory reads pass on matching artifacts.

Retain the completed Shares refresh, latest published source preview, and
fresh-rule admission after snapshot revocation. Their evidence remains in the
[validation record](docs/team-continuous-sharing-validation.md).

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
The [local ticket file](tickets.md) now contains the production plan.

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
confirmed behavior. The User accepted the operational alpha after manual testing
on 21 October 2026 and approved the production plan. The
[implementation plan](docs/team-continuous-sharing-implementation-plan.md) and
[current tickets](tickets.md) define the active production sequence.
The [alpha archive](docs/archive/2026-10-21-operational-alpha/tickets.md) preserves
ALPHA-01 through ALPHA-05. The
[original archive](docs/archive/2026-10-21-package-2/tickets.md) preserves the
fourteen feature slices. P2-01 through P2-14 are locally complete. The full
package gate remains open.
See the [Package 2 validation record](docs/team-continuous-sharing-validation.md).
Run focused tests for changed behavior or acceptance requirements. Run broader
checks at integration checkpoints and the final production gate.
Coordinate current API, protocol, and schema changes across components.
Legacy datasets, historical database layouts, old protocols, mixed-version
operation, and historical upgrades are out of scope for this package.
Bring forward resolved principles and designs. Preserve current-build persistence,
restart, recovery, and backup restoration, plus all production behavior and
security guarantees. The current tickets supersede historical compatibility
requirements. This does not authorize deletion of unrelated data or backups.

The accepted alpha milestones are complete within their recorded scope:

- [x] ALPHA-01: Disable unfinished content-policy editing across all entry points.
- [x] ALPHA-02: Run matching native Desktop and local Docker Team Backend builds.
- [x] ALPHA-03: Demonstrate sharing, later updates, lifecycle controls, and teammate recall.
- [x] ALPHA-04: Demonstrate brief disconnect and restart recovery on one publisher.
- [x] ALPHA-05: Deliver the trial guide, acceptance evidence, and known limitations.

Production starts with PROD-01. Workspace exclusions, P2-10 and P2-11, remain
the first new feature priority. The current tickets define all remaining
follow-ups, dependencies, and the PROD-06 production acceptance gate.

The following list records the original Package 2 decisions and implementation
status. Open entries now belong to the production plan, not the accepted alpha.

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
- [x] P2-09: Change a rule's content policy. Both production slices pass local
      acceptance: restrictive denial, fresh broader approval, current enclosing
      permissions, active and paused history, subsequent revisions, independent
      reasons, recall and cached expansion denial, obsolete Privacy work, exact
      delivery receipt recovery and stopped-state preservation. Editing is
      restored across HTTP, native/browser approval, durable delivery and both
      Desktop owner placements. The combined native journey passes PROD-06.
- [x] P2-10: Exclude a Conversation from one Workspace. Focused publication,
      recall, delivery, approval, Desktop and destination-isolation checks passed.
- [x] P2-11: Remove an exclusion through fresh native approval. Eligible active
      rules catch up; paused, stopped, removed-member and no-rule cases stay private.
- [x] P2-12: Convert a snapshot created by the current build explicitly. Exact
      snapshot and destination authority, consent limits, native approval,
      durable retry, delayed retirement, stale and duplicate rejection, later
      turns and pause/resume/stop pass local checks. Independent reasons and
      another Workspace remain unchanged; separate Source Access authority is
      preserved. The combined native journey passes PROD-06.
- [x] P2-13: Recover a selection rule after an extended interruption.
      Expired and unavailable checkpoint recovery preserves the installed
      baseline and exact outstanding request in six focused cases. Fresh
      offline stop review failures explain the online approval boundary.
      Combined journal recovery now covers the outage, queued stop and independent
      Workspace without duplicates. Actual Team publication and read-back pass
      after restart, missing history, membership changes and later turns.
      The combined native recovery journey passes PROD-06.
- [x] P2-14: Continue a rule from another Personal device running the current build.
      Backend native-reviewed transfer and exact replay now preserve active/paused
      state, existing grants, consent and original source identity. Former publisher
      writes are fenced; later source publication requires both the committed
      transfer and a native-bound portable member. Receiving review, protected
      delivery and new local baselines now pass focused checks, including paged
      existing-member reconciliation and later available Personal evidence.
      Resolve receiving Project views through signed portable catalog identity.
      Discovery, creation review and fresh queue validation now use that identity,
      while proven native Projects remain supported before Personal sync setup.
      Interactive owner controls now pass focused UI, route and renderer build
      checks. The native Git Anchor two-device journey now passes.
      Previously published sources removed automatically by selection can now
      re-enter through retained-source admission and durable delivery. Team
      prepares current candidates from original sync mappings, creates fresh
      consent under the approved future rule and reuses the destination grant.
      Original credential/policy revocation before activation denies publication;
      exact receipt recovery never queues a receiving-device source upload.
      Stale retained admissions now recover under fresh exact authority and
      leave healthy work unchanged. Bounded journal observation survives restart
      until Team initializes the member. Originally native unpublished admissions
      now continue from their accepted candidate, including first destination
      creation and initial policy creation within the approved scope. Explicit
      cancellation and later policy restrictions remain vetoes. Combined restoration and controls now pass PROD-06.
- [x] PROD-06 production acceptance milestone: combined two-owner, multi-Workspace,
      two-device native acceptance and focused processing intersections pass.
      Matching artifacts, restart and recovery, exact encrypted same-build restore,
      applicable checks and the candidate handoff are recorded. Unavailable release
      qualifications remain explicit prerequisites.
- [x] Resolve the Docker fixture's `SharedMemoryPersonalEmbeddingReuseConflict`
      for Removed Member Deployment Note before declaring the package fixture
      gate passed. Retained Team authorization must not depend on restoring the
      removed owner's Workspace access. Do not invalidate Personal vectors as a
      validation workaround.
- [x] Complete production sharing, mapping, publication, and operation documentation.
      Preserve ALPHA-05's trial guide and evidence; current operator handoff and
      release prerequisites are in the candidate status record.

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

## Public Koed Server release gates

Historical signed-path macOS arm64 / Node 24 Base/Privacy and packaged Electron
Team lifecycle checks passed with test-only keys. These are not pin-only acceptance.
Actual native Personal/Team, the broader Desktop lifecycle matrix, signed/notarized
clean-Mac and publication acceptance remain gates below.

Follow-up to the public `@koed-labs/server` distribution. Merging that work
publishes nothing; do not merge the "Version Koed" release PR until these are closed:

- Complete pin-only build/install/start/restart/shutdown lifecycle acceptance.
  Require the complete canonical version-matched catalog embedded in trusted
  npm/Desktop control planes; retain protected independently reviewed build
  identity and read-only candidate verification.
- Confirm npm organization/package ownership and publication credentials.
- Validate Linux/native artifacts and packaged Electron runtime/helper/fuse behavior
  on supported targets (Linux x64 CI jobs are currently skipped).
- Verify packaged Desktop relocation, failure-injection rollback, uninstall and
  terminal-helper behavior.
- Run an authorized release rehearsal, then promotion with
  `KOED_NPM_PUBLICATION_AUTHORIZED` and `KOED_RELEASE_PROMOTION_APPROVED`.

## Local status control-request amplification

- Measure and reduce duplicate authenticated control requests during startup and
  diagnostics. Supervisor readiness collects status every 500ms; renderer/tray
  status, MCP doctor, and background task claims share the 120-per-minute local
  AI Client control bucket. Reproduce slow startup with request accounting before
  choosing caching, coalescing, or cadence changes. Preserve authentication and
  production rate limits; smoke-only bounded doctor recovery is not this fix.

## Manifest-pin release stack acceptance

ADR-0057 replaces runtime component-signature admission with versioned manifest
pins from trusted npm/Desktop control planes. Historical signed-component evidence
above is not acceptance evidence for this replacement.

- Validate fresh catalog-bearing standalone npm/Desktop candidates against frozen
  Base/Privacy bytes on macOS arm64 and Linux x64, including actual positive
  Personal/Team startup, online/offline acquisition, restart and tamper rejection.
- Verify signed/notarized Desktop catalog after final packaging, plus relocation,
  helper/fuse, uninstall and clean-Mac behavior. Keep CUDA validation separate.
- Require component pin-only before merge: remove component KMS, hosted signer,
  roots, sidecars, component-signing OIDC and obsolete configuration/docs now,
  without staging source retention on acceptance. Actual pre-promotion candidate
  verification without publication and native/signed acceptance remain gates.
- No live cloud deletion or repository-variable change is authorized or required.
  Preserve Apple Developer ID signing/notarization, unrelated hosted/encryption
  KMS and legacy app-runtime provenance.
- Preserve the approved existing minor changeset. Keep publication approval
  disabled; npm authentication/provenance, immutable assets and SRI remain gates.
- Prior checkpoint: Server 970, Desktop 967, root scripts 503 tests passed;
  pin-only cleanup verification pending. These are not fresh results.
- Keep broader database compatibility/restoration, CLI IPC replacement, filesystem
  simplification, precomputed bundle identity and broad benchmarking deferred.
  Same-version generation recovery is not whole-release rollback.

## Server distribution split (PR #404)

- Completed: private Server package and `koed` command migration (#408, merged).
- Completed: lazy CLI loading/help extraction (#409, merged).
- Validate built, catalog-pinned, installed, and started headless components end to end before enabling npm publication and release promotion.
- Deliver Desktop on-demand Privacy only after install, upgrade, startup, integration setup, and rollback validation; preserve existing bundled Privacy until then.
- Deliver opt-in Desktop Install CLI separately, with relocation, removal, and Electron helper validation.

## Distribution integration follow-up at PR #404

Implemented with regression coverage: stopped first Privacy asset installation,
owned Desktop bundle upgrade admission, selected-runtime Privacy readiness and
private Claude Code/Pi setup/repair. Bundle verification, supervisor RPC and Privacy
transactions, status runtime selection and assembly exception policy now have shared
implementation seams. Historical packaged positive Team lifecycle passed with
test-only signing; this is not pin-only acceptance. Fresh review and remaining
lifecycle acceptance are still required.

- Completed local signed component admission, native-operation coverage, and packaged Team startup acceptance for Node 24.14.0 and the exact Electron 39.8.10 / embedded Node 22.22.1 macOS arm64 payload. Other Electron targets remain unvalidated.
- Passed packaged-manager Team `setup_core` after Privacy activation and before
  daemon start using packaged Electron Node mode, a disposable test-signed app,
  the real private supervisor, and an isolated fixture PostgreSQL. Team readiness
  reached healthy and shutdown succeeded. Full GUI launch for this check remains
  unverified after macOS aborted a separate disposable app launch before IPC.
  Stopped management starts no services; `setup_core` requires reachable
  PostgreSQL to provision or revalidate the local API Token.
- Run packaged Team upgrade, relocation, rollback,
  uninstall and helper/fuse acceptance, plus Linux native validation.
- Keep npm/publication approval disabled until authorized pin-only candidate
  verification and acceptance. Component signer configuration is not a gate.

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
