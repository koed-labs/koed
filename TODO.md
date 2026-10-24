# Implementation backlog

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

Headless macOS arm64 / Node 24 signed Base and Privacy installation plus Personal
and Team startup/readiness/shutdown is locally verified with test-only keys.
Packaged Electron macOS arm64 Team activation/readiness/shutdown also passes.
Linux, the broader Desktop lifecycle matrix, and production signing/publication
acceptance remain open below.

Follow-up to the public `@koed-labs/server` distribution. Merging that work
publishes nothing; do not merge the "Version Koed" release PR until these are closed:

- Complete full v2 build/sign/install/start/shutdown lifecycle acceptance.
  The authorized GitHub signing-only rehearsal passed and its temporary branch
  authorization was revoked.
  The approved KMS public root is embedded; Cloud Run signing and trust-root
  repository configuration are implemented independently from publication approval.
- Confirm npm organization/package ownership and publication credentials.
- Validate Linux/native artifacts and packaged Electron runtime/helper/fuse behavior
  on supported targets (Linux x64 CI jobs are currently skipped).
- Verify packaged Desktop relocation, failure-injection rollback, uninstall and
  terminal-helper behavior.
- Run an authorized release rehearsal, then promotion with
  `KOED_NPM_PUBLICATION_AUTHORIZED` and `KOED_RELEASE_PROMOTION_APPROVED`.

## Manifest-pin release stack acceptance

ADR-0057 replaces runtime component-signature admission with versioned manifest
pins from trusted npm/Desktop control planes. Historical signed-component evidence
above is not acceptance evidence for this replacement.

- Validate fresh catalog-bearing standalone npm/Desktop candidates against frozen
  Base/Privacy bytes on macOS arm64 and Linux x64, including actual positive
  Personal/Team startup, online/offline acquisition, restart and tamper rejection.
- Verify signed/notarized Desktop catalog after final packaging, plus relocation,
  helper/fuse, uninstall and clean-Mac behavior. Keep CUDA validation separate.
- Complete actual pre-promotion candidate verification without publication before
  removing retained KMS release-signing/rehearsal infrastructure. Confirm live
  rehearsal authorization and consumers through separately authorized read-only
  operational inspection; repository state is not evidence of deployed state.
- Retire signer callers/configuration only after acceptance and explicit operational
  authorization. Prefer reversible disablement; do not destroy keys during cleanup.
- Obtain release-note approval: recommend minor for changed component trust,
  configuration and packaging behavior. Keep publication approval disabled.
- Keep broader database compatibility/restoration, CLI IPC replacement, filesystem
  simplification, precomputed bundle identity and broad benchmarking deferred.
  Same-version generation recovery is not whole-release rollback.

## Server distribution split (PR #404)

- Completed: private Server package and `koed` command migration (#408, merged).
- Completed: lazy CLI loading/help extraction (#409, merged).
- Validate built, signed, installed, and started headless components end to end before enabling npm publication and release promotion.
- Deliver Desktop on-demand Privacy only after install, upgrade, startup, integration setup, and rollback validation; preserve existing bundled Privacy until then.
- Deliver opt-in Desktop Install CLI separately, with relocation, removal, and Electron helper validation.

## Distribution integration follow-up at PR #404

Implemented with regression coverage: stopped first Privacy asset installation,
owned Desktop bundle upgrade admission, selected-runtime Privacy readiness and
private Claude Code/Pi setup/repair. Bundle verification, supervisor RPC and Privacy
transactions, status runtime selection and assembly exception policy now have shared
implementation seams. Packaged positive Team activation/readiness/shutdown now
passes locally with test-only signing; fresh review and the remaining lifecycle
acceptance are still required.

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
- Keep production signing/trust-root/npm/promotion gates closed until authorized rehearsal.

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
