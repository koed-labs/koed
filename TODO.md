# Implementation backlog

## Optional Privacy runtime release gates

The optional runtime implementation and development qualification are complete.
Retain candidate-bound development evidence with the PR and protected build artifacts.
Publication remains a separate decision.

- [ ] Bind all native reports, frozen components, and the complete embedded catalog to the final reviewed release candidate.
- [ ] Complete signed/notarized clean-Mac launch and downloaded native-code acceptance using the final signed artifacts.
- [ ] Complete required release CI and exact public runtime-URL installation against that candidate.

The [installation guide](docs/optional-privacy-installation.md) defines compatibility selection, filtering readiness, and CPU fallback.

## Desktop Preferences design

- [ ] Establish and document a supported location for manually downloaded
      Privacy Filter component files. The current component installer downloads
      into temporary `runtime/components/.stage-*` directories and does not
      discover archives placed there manually. Keep this out of the Preferences
      UI. Verify matching release manifests and archives through the normal
      installer before activation; document the stable location only once this
      workflow is supported.

## Production sharing follow-ups

- [ ] Investigate switching backends when the previous backend is offline.
      Connecting to the new remote backend was blocked by pending revocation
      of its device credential on the stopped local fixture and surfaced only
      “Collaboration is temporarily unavailable.” Assess separating new-backend
      connection from durable old-backend revocation, with clear status and
      recovery controls. Preserve identity isolation, credential and route
      fencing, and pending revocation; do not report old remote access as ended
      until the old backend acknowledges it. Reproduce with backend A offline
      while connecting to backend B, then bring A online and verify cleanup.

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

- [ ] Reassemble and verify packaged candidates after sharing-review corrections.
      Preserve selection scope, fixed snapshots, consent, Privacy, publication,
      complete membership, and fresh removal-proof checks during capture.

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

## Public distribution and manifest-pin release gates

- [ ] Complete native Personal and Team build/install/start/restart/shutdown
      acceptance with frozen Base/Privacy artifacts and a complete version-matched
      catalog embedded in the trusted npm/Desktop control planes. Include online
      and offline acquisition, tamper rejection, and the actual read-only candidate
      verifier without publication. Bind reports to protected, independently
      reviewed build identity.
- [ ] Exercise a fresh global install from the packed npm artifact outside the
      checkout. Verify `koed --help` needs no downloads, paths with spaces work,
      dependency and license inventories are complete, and no workspace dependency,
      external symlink, checkout fallback, or `koed-server` executable alias remains.
      Preserve standalone distribution and Node 24 support. Qualify Electron's
      embedded runtime separately from Node.
- [ ] Verify Base-only Personal, local Team Privacy, external Privacy, and
      external-to-local Privacy transitions. Include missing, corrupt, wrong-version,
      and wrong-target components, cancellation/retry, failed-download recovery,
      stopped installation, integration setup/repair, and state-preserving atomic
      upgrade and recovery without mixed versions.
- [ ] Complete signed/notarized clean-Mac launch, downloaded native-code acceptance,
      relocation, failure-injection rollback, uninstall, and helper/fuse checks.
      Verify the final packaged catalog. Treat whole-release rollback separately
      from same-version generation recovery.
- [ ] Qualify supported Linux targets, the declared glibc baseline, and actual
      WSL2 on a Windows host. Container results do not establish WSL2 behavior or
      native performance. Keep CUDA reports tied to their exact candidate.
- [ ] Qualify opt-in Desktop Install CLI: launcher validity, PATH checks,
      conflict handling, repair/removal, relocation, npm coexistence, and execution
      through the bundled runtime without system Node. Preserve User state on uninstall.
- [ ] Verify coordinated product, npm, component, standalone, Desktop, and
      release-note versions. Call out the removed executable alias in release notes.
      Confirm npm organization/package ownership, publication credentials,
      authentication/provenance, immutable asset handling, npm SRI, dist-tag policy,
      and recovery after partial npm/GitHub/Desktop publication.
- [ ] Run required database-backed suites against an explicitly configured
      disposable database and complete CI for the reviewed candidate. Record fresh
      results rather than inheriting old test counts.
- [ ] Run the authorized release rehearsal before separately authorized promotion
      with `KOED_NPM_PUBLICATION_AUTHORIZED` and `KOED_RELEASE_PROMOTION_APPROVED`.
      Preserve protected candidate review and external environment approval controls.

Keep Apple Developer ID signing/notarization, unrelated hosted/encryption KMS,
and legacy app-runtime provenance. Component signer provisioning is not a release
prerequisite. Broader database compatibility/restoration, CLI IPC replacement,
filesystem simplification, precomputed bundle identity, and broad benchmarking
remain deferred. Preserve the coordinated product version policy.

## Sharing staging acceptance

These criteria remain unresolved until candidate-bound evidence establishes a pass
or they are tracked as release blockers. Local automated results do not establish
recovery across two hosts.

- [ ] Run staged two-User Pending Share activation for all three semantic
      representations, revocation, exact Conversation Source Access, and recovery
      after a two-host network interruption. Use current matching components.
- [ ] Obtain comparable before/after encrypted package-byte and record-count
      measurements for the original reported Captured Session. The retained
      baseline is 38 Memory Events, one LCM leaf, a 3.84 MB encrypted package,
      and about 412 KB of Approval Activity display projection. The original
      source fixture is unavailable in this checkout. The synthetic measurement
      command cannot establish an equivalent result.
- [ ] Run staged capacity validation and measure frame time under target load.
      Retain the existing 100 ms frame-time limit.
- [ ] Complete real WorkOS-backed enrollment and Step-up acceptance where supported.
      Developer-profile or local-session checks do not establish provider acceptance.
      Exercise the current one-review sharing flow through normal Desktop controls.

The [collaboration launch guide](docs/collaboration-launch-validation.md) defines
approval checks and content-safe sharing measurements.

## Local status control-request amplification

- Measure and reduce duplicate authenticated control requests during startup and
  diagnostics. Supervisor readiness collects status every 500ms; renderer/tray
  status, MCP doctor, and background task claims share the 120-per-minute local
  AI Client control bucket. Reproduce slow startup with request accounting before
  choosing caching, coalescing, or cadence changes. Preserve authentication and
  production rate limits; smoke-only bounded doctor recovery is not this fix.

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

- [ ] Add explicit controls for larger historical catch-up. Automatic selection
      remains limited to 50 Conversations per supported AI Client from the last
      30 days. Keep selection controls separate from fresh-import Project assignment
      and preserve the migration cutoff for previously captured history.
- [ ] Release the Project cutover as one coordinated change. Preserve coordinated
      product versions and integrate branch-preference behavior after that
      cutover. PDS branch preference must use verified captured observations and
      check the local effective assignment.

## Commander CLI follow-ups

- Investigate the Desktop revocation wrapper. It sends device metadata without
  the signed transition file descriptors required by the advanced CLI. Preserve
  protected-input validation and existing authority boundaries.
