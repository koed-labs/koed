# Implementation backlog

## Asynchronous Memory Answer adapters

The shared delivery lifecycle supports Pi deferred recall, default Codex
Stop-hook delivery, opt-in Claude Code host backgrounding and the blocking
route. See
`docs/async-memory-answer.md`.

Follow-ups:

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

## Joining-device-first Personal Device pairing

Implemented on 2026-09-14:

- Joining headless and Electron installations create a short-lived device request.
- The existing Authority-hosting Electron installation reviews and explicitly
  accepts that request, using the existing signed enrollment protocol.
- `pnpm koed pair` starts the native Personal runtime with automatic ports
  and credentials. CLI and Electron share supervisor-owned request state.
- Setup no longer requires a recovery JSON export or a recovery code. Advanced
  optional recovery export remains available through the CLI.
- Joined devices publish their own closed sessions without an Authority private
  key. User authentication and secure membership context remain required.
- Request transport is private LAN/Tailscale only. The existing Authority relay
  listener remains in Electron; the joining request listener lives in koed-server.

Validation and current operation are documented in `docs/device-pairing.md`.

Deferred work:

- Internet-accessible relay and restricted-network traversal.
- Approval from joined replicas that do not host the Authority.
- Moving the existing Authority relay listener into the supervisor.

## Personal Device session visibility and automatic publication

Implemented, following ADR-0045:

- Signed cumulative checkpoints preserve V1 permanent closure semantics.
- Durable Pi, Codex, and Claude Code completion evidence triggers publication.
- Ordered, deduplicated checkpoints extend one read-only received Session.
- Pairing and local replication progress are reported separately.

Remaining validation: physical Studio-to-Electron capture, later-turn updates,
and offline catch-up on the updated runtime.

Implemented: received-session badges use verified replica provenance and the
installation-local nickname; device icons no longer guess hardware by row order.

## Public Koed Server release gates

Headless macOS arm64 / Node 24 signed Base and Privacy installation plus Personal
startup/readiness/shutdown is locally verified with test-only keys. Linux, Desktop
and production signing/publication acceptance remain open below.

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
