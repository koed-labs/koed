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

## Public Koed Server release gates

Headless macOS arm64 / Node 24 signed Base and Privacy installation plus Personal
and Team startup/readiness/shutdown is locally verified with test-only keys.
Packaged Electron macOS arm64 Team activation/readiness/shutdown also passes.
Linux, the broader Desktop lifecycle matrix, and production signing/publication
acceptance remain open below.

Follow-up to the public `@koed-labs/server` distribution. Merging that work
publishes nothing; do not merge the "Version Koed" release PR until these are closed:

- Install production component trust roots into control-plane builds; configure an
  authorized signer and set `KOED_COMPONENT_SIGNER_URL`, `KOED_COMPONENT_SIGNER_KEY_ID`
  and the trust-root repository variables.
- Confirm npm organization/package ownership and publication credentials.
- Validate Linux/native artifacts and packaged Electron runtime/helper/fuse behavior
  on supported targets (Linux x64 CI jobs are currently skipped).
- Verify packaged Desktop relocation, failure-injection rollback, uninstall and
  terminal-helper behavior.
- Run an authorized release rehearsal, then promotion with
  `KOED_NPM_PUBLICATION_AUTHORIZED` and `KOED_RELEASE_PROMOTION_APPROVED`.

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
