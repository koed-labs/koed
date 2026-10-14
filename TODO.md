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

## Server distribution split (PR #404)

- Land the private Server package and `koed` command migration with existing runtime assembly.
- Land the separate lazy CLI loading/help extraction without component provisioning commands.
- Validate built, signed, installed, and started headless components end to end before enabling npm publication and release promotion.
- Deliver Desktop on-demand Privacy only after install, upgrade, startup, integration setup, and rollback validation; preserve existing bundled Privacy until then.
- Deliver opt-in Desktop Install CLI separately, with relocation, removal, and Electron helper validation.
