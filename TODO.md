# Implementation backlog

## Asynchronous Memory Answer adapters

The shared delivery lifecycle supports Pi deferred recall, default Codex
Stop-hook delivery, opt-in Claude Code host backgrounding and the blocking
route. See
`docs/async-memory-answer.md`.

Follow-ups:

- Validate default stdio negotiation and installation upgrades with modern MCP
  on supported host releases. The conditional-delivery native fixtures require
  explicit Codex 2026-07-28 selection and Claude v2/auto negotiation; their
  successful delivery does not prove legacy-profile transport migration.
- Repeat the conditional-delivery Claude matrix in the interactive TUI. The
  2.1.267 native print matrix used an explicit noninteractive background opt-in;
  normal setup does not enable that option.

- Revalidate Codex cancellation after an upstream fix. A confirmed interruption
  can currently admit a late Stop hook prompt into the interrupted turn. Keep
  the ownership, authorization, expiry and duplicate safeguards.
- Prevent Pi recall turns from crossing an in-progress `/tree` navigation.
  Pi 0.85.1 checks `isStreaming` only before awaiting `session_before_tree`
  handlers and branch summarisation, and emits no event when navigation is
  cancelled or fails. Either gate presentation from `session_before_tree` with
  a release on signal abort, `agent_start` or a bounded timeout, or ask Pi to
  re-check streaming before committing the branch.
- Let Desktop-managed Pi Conversations present turns they did not prompt, so
  they can use deferred recall instead of blocking.
- Resolve `/quit` during a pending Codex recall: the original backend turn can
  still finish and produce an answer after the CLI disconnects.
- Test repeated Claude Code recalls in one Conversation and delivery after
  reopening.
- Update AI Client capability snapshots (`host_task_notifications`,
  `model_continuation_during_tool`). They still report Claude Code as
  `unsupported` and Codex/Pi as `requires_bridge`, which does not reflect the
  default deferred delivery for Codex and Pi or the opt-in Claude route. Report these
  per mode and setup state rather than per driver.
- Bind a maintained TypeScript MCP Tasks runtime to the existing execution owner
  when its SDK and supported AI Clients provide the required extension.
- Defer managed Codex and Claude Agent SDK presentation adapters until the
  independent-client work has been addressed.
- Strengthen Pi delivery recovery if its API gains an atomic durable enqueue
  acknowledgement. Dropped completions are redelivered when the run settles,
  but receipt buffering before the first assistant message remains a crash gap.
- Add stronger Codex recovery when a supported host supplies the required
  receiver mechanism. Pending-result delivery after backend loss or runtime
  restart, idle wake and exited-session replay remain future work. Keep the
  original-owner, authorization, expiry and duplicate safeguards.

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
