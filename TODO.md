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
  Real native CLI 0.159.3 positive, revocation/expiry, scheduler failure and
  durable cancellation cases passed bounded review. Controlled fork and `/new`
  origin checks passed after parent interruption. Observation timeout remains
  inconclusive, and pending exit failed because the original turn produced a
  model answer after CLI disconnection. Configuration repeat/repair/removal
  checks passed; full setup and live recovery remain. A separate native VS Code
  positive case demonstrated same-turn automatic delivery with useful overlap
  and scoped cleanup. A controlled IDE pending window-close also passed its
  bounded safety outcome; first binding-removal attribution remains uncaptured.
  IDE durable cancellation also passed with a native no-answer notice and
  scoped cleanup. IDE execution failure passed a genuine scheduler failure and
  native no-answer notice. IDE observation timeout passed an unchanged late
  client-read drain, real completion without cancel and no late answer.
  Controlled IDE fork isolation also passed with native parent/child lineage,
  useful child work before completion and no later answer in either history.
  Active IDE foreground switching also passed: one answer stayed in the continuing
  original owner and the new Conversation stayed answer-free. Real credential
  provisioning/reuse, native missing-prehook blocking fallback and configuration
  repair/check also passed. Simulated orphan-lock cleanup after task completion
  passed without replay or late answer; pending-task removal and crash recovery
  are not claimed. Independent review accepts the bounded IDE active-Stop route.
  First Desktop positive delivery on bundled0.160.1 passed natural useful overlap,
  automatic owned answer/source, cleanup and bounded independent review. Desktop
  Close Window followed by native Dock Quit also passed bounded pending-exit
  safety; window-close alone and first-retirement attribution remain unverified.
  Controlled active Desktop switching passed distinct non-fork owners and no
  selected-conversation answer leak, with cleanup/independent review. Controlled
  interrupted-parent Desktop fork also passed child origin isolation, no later
  parent answer and cleanup/independent review. Subsequent-turn Desktop durable
  cancellation passed one protected cancel and native no-answer notice, no saved
  answer/Question, cleanup and independent review. Earlier fallback/wrong-project
  attempts remain inconclusive. Desktop real scheduler/executor failure also
  passed one hard_timeout attempt, one native no-answer notice and cleanup/
  independent review. Corrected Desktop observation timeout also passed exact6s
  native watchdog, unchanged late-read drain, backend completion/no late answer
  and cleanup/independent review. Prior305s fixture remains behavior-only.
  Desktop real core provisioning/reuse, supported repair/config selection/removal
  and native missing-prehook blocking fallback also passed cleanup/independent
  review. Desktop post-completion simulated orphan-state cleanup also passed
  unchanged one task/Question, no replay/late answer and scoped cleanup/independent
  review. Full contributor setup/bootstrap remains deferred; in-flight/crash/
  restart recovery and unresolved CLI outcomes remain explicit follow-ups.
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
