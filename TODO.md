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
- `pnpm koed-server pair` starts the native Personal runtime with automatic ports
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
