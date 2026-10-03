# Implementation backlog

## Asynchronous Memory Answer adapters

The shared execution-port and presentation lifecycle supports Pi deferred recall
and the existing blocking route. See `docs/async-memory-answer.md`.

Follow-ups:

- Prioritise independently started AI Clients before Koed-managed Conversations.
  Pi deferred recall and Claude Code's explicit background-recall setup passed
  integration review. Claude's isolated main-Conversation tests cover idle and
  foreground-tool completion, timeout, selected host stop, pending exit,
  revocation and expiry. Repeated calls and reopening delivery remain untested.
  Complete native qualification of the implemented opt-in Codex Stop adapter,
  which uses the shared durable task runtime and exact originating turn.
  A real native CLI 0.159.3 positive and separate revocation/expiry cases passed
  review. Failure, explicit cancellation, observer timeout, pending exit and
  fork/replacement checks remain; IDE and Desktop are source-grounded
  candidates whose actual delivery is still untested.
  The User accepts the upstream cancellation race temporarily: a hook result
  can enter an interrupted original turn during Codex's abort grace interval.
  Document this limitation and revalidate suppression after an upstream fix;
  ownership, authorization, expiry and duplicate checks remain required.
  Assess CLI, IDE and Desktop separately. The Stop route keeps the original
  turn active; it does not wake a completed Conversation. Existing external
  queue receiver and native MCP Tasks prerequisites remain unresolved for those
  alternative paths. Retain blocking recall when deferred setup is unavailable.
- Bind a maintained TypeScript MCP Tasks runtime to the existing execution owner
  when its SDK and supported AI Clients provide the required extension.
- Defer managed Codex and Claude Agent SDK presentation adapters until the
  independent-client work has been addressed.
- Strengthen Pi delivery recovery if its API gains an atomic durable enqueue
  acknowledgement; current recovery has documented crash gaps.

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
