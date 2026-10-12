# Conditional Memory Answer validation

Recorded on 2026-10-12. Implementation and the scoped native host validation are complete.
The local [ticket document](../offline-docs/delivery-modes/tickets.md) records acceptance progress.
The [implementation plan](../offline-docs/delivery-modes/PLAN.md) is retained alongside it. Passing adapter checks
does not establish agent behavior under delayed host delivery.

Generated reports and planning files live in `offline-docs/delivery-modes`, which
is already ignored by Git. Report links are available only in this local checkout.
The Pi progress report in that directory retains intermediate attempts; the final
Pi native report is the completed validation evidence.

## Completed adapter checks

- MCP package typecheck, focused lint, and package build passed after Codex
  implementation.
- Codex dispatch and protected-delivery suites passed 69 checks. Two existing
  HTTP authority checks needed escalation solely because the sandbox denied
  binding their temporary loopback server. Both then passed. The delivery suite
  compiles and invokes the actual hook CLI entry point; this is not a live
  Codex model-turn validation.
- Pi delivery, extension, and setup suites passed 81 checks after Pi
  implementation. Focused lint and MCP typecheck passed.
- The actual installed Pi SDK, version 1.1.0, passed the standalone-package
  lifecycle script. It executes a copy of the shipped integration against real
  SessionManager history. It checks mixed blocking/deferred calls, runtime input
  stripping, persistent reopen, saved-completion suppression, and fork/branch
  suppression. Initial history buffering before an assistant message remains
  an observed recovery limitation. This check uses no model or normal Memory.

## Behavioral evidence

Next-action selection passed the paired live cases using Codex CLI 0.160.0 and
gpt-6.1-sol, one run per case. Independent diagnostics selected `non_blocking`;
an immediately dependent decision selected `blocking`. Both scored 100% with
one recall each. See the local [tool-choice report](../offline-docs/delivery-modes/conditional-memory-answer-tool-choice.json). These are immediate
result checks, not delayed-delivery evidence or five-run statistical sampling.

The fixture runner enables MCP 2026-07-28 and explicitly selects that protocol
for the stdio server through `CODEX_MCP_PROTOCOL_VERSION`. The installed CLI
otherwise attempted legacy initialization and never reached a model turn.
An initial incomplete fixture answer legitimately caused a narrower follow-up;
the final fixture includes a complete implementation decision and real
diagnostic files. Current paired results correspond to that corrected fixture.
No client profile or credential file was copied or changed by the evaluator.

The Codex delayed-result matrix passed all seven cases on CLI 0.160.0 with
gpt-6.1-sol: delayed, fast task readiness, not-found, failed execution,
interruption, explicit blocking, and missing-readiness fallback. See the
local [Codex native report](../offline-docs/delivery-modes/conditional-memory-answer-codex-native.json). Each case uses the actual MCP factory and
hook entry point, synthetic task responses on an authenticated loopback
fixture, a temporary workspace, and the host's read-only filesystem sandbox.
The CLI hook-trust override runs only the vetted local automation wrapper;
this is not a test of the interactive hook-review UI. The report distinguishes
task readiness from completion supplied to the model at Stop.

The first delayed run exposed a macOS logical/physical cwd alias mismatch.
Native session, call, turn, and input fingerprints matched, and both directories
resolved to the same fixture workspace. Canonical directory matching corrected
the mismatch without accepting a different physical directory. The protected
delivery suite then passed all 46 checks, including the new alias/foreign-directory
regression. A temporary fixture-only correlation probe was removed after diagnosis.

The successful delayed trace shows a pending receipt, independent diagnostic
read, a `waiting_for_memory` yield, native Stop completion, and a dependent edit
using the randomized recalled settings. Other native cases prove no dependent
edit on missing/failed memory or interruption, and ordinary result delivery for
explicit blocking and absent deferred preparation. Four scorer checks reject
premature edits, missing delivery, duplicate recall, and model polling.

Pi SDK 1.1.0 passed all seven native cases using the configured
`openai-codex / gpt-6-luna` model, a copied standalone extension, persistent
fixture Conversations, and the real extension runner and message APIs. The
synthetic Runtime HTTP seam delegates normal model traffic to the real provider;
it does not mock the model or copy credentials. See the local [Pi native report](../offline-docs/delivery-modes/conditional-memory-answer-pi-native.json).
Mixed and concurrent recalls also passed with distinct randomized alpha/beta
settings, one recall/edit per target, and target-specific completion before
each edit. Queued-completion interruption saves one authorized answer without
a new agent turn. The first recovery failure was in harness cancellation
classification; correcting it allowed the existing recovery path to finish.

The actual-SDK redelivery check additionally passed normal follow-up delivery
and dropped-completion redelivery without a turn. The transition check passed
cancelled switch/fork/tree operations, later invocation, and committed-tree
outgoing-branch suppression. It reproduced the known earlier asynchronous
tree-handler race; this feature does not claim to eliminate that limitation.
The adapter's new settle/observer race regression passes with all 61 Pi delivery
checks. Six shared scorer checks reject wrong attribution and premature use of
memory while respecting host-specific delivery boundaries.

Claude Code 2.1.267 with its configured claude-opus-5 model passed eight native
cases: backgrounding enabled, backgrounding disabled, explicit blocking under
host backgrounding, fast completion, not-found, failure, interruption, and an
ambiguous next action. See the local [Claude native report](../offline-docs/delivery-modes/conditional-memory-answer-claude-native.json). Native `task_started`
and `task_notification` events establish the actual notification path. Enabled
backgrounding permits diagnostics before completion; disabled backgrounding
returns the ordinary MCP result before diagnostics. Explicit blocking still
permits host backgrounding. Typed final statuses are required in every completed
case; all edits follow found memory and notification where applicable.
Interruption detaches the waiter while the synthetic executor still reaches its
terminal state. This proves waiter detachment, not production task recovery.

These Claude checks use the native **print host** with explicit
`CLAUDE_AUTO_BACKGROUND_TASKS=1`, threshold 500 ms (disabled: 0),
`MCP_SDK_GENERATION=v2`, and `MCP_PROTOCOL_NEGOTIATION=auto`.
They do not constitute a new interactive TUI, IDE, subagent, or reopened-session
validation. Normal Koed setup does not enable the noninteractive opt-in.
No normal client profile or credential was changed.

## Packaged readiness and scope

The production shared-runtime staging path deployed a standalone dependency
graph to a temporary directory. Its validator now requires the delivery policy,
Pi delivery modules, and their declarations. All three staging checks pass.
`packaged-readiness.mjs <staged-runtime-root>` passed fresh Codex configuration,
replacement of representative old hooks while preserving the blocking opt-out
and unrelated model preference, fresh/replaced Pi assets, and strict execution
input checks for all modes. The local [packaged report](../offline-docs/delivery-modes/conditional-memory-answer-packaged.json) records guidance
hashes. Pi registration in this smoke is simulated; actual SDK lifecycle and
standalone extension/model checks supply separate execution evidence.

The existing dispatch and Pi lifecycle suites were also run against the staged
compiled modules (temporary test copies redirected module imports, including
the staged MCP server transport). All 85 checks passed. The first dispatch
attempt mixed checkout and packaged SDK server instances and failed negotiation;
using the packaged transport corrected the fixture. All 33 staged Codex setup
checks and 93 contributor Codex/Claude/Pi setup checks passed. Temporary test
copies were removed.

The native MCP evaluations require explicit modern protocol selection as noted
above. They do not prove that every host's default negotiation or existing
profile can connect without that prerequisite. Legacy-host transport migration
remains separate from per-call presentation selection. Windows Codex Stop,
managed Conversations, and Claude IDE/subagent/reopen behavior remain unproven;
configured blocking defaults and existing opt-outs are preserved.

No public capability fields were changed. Internal requested-mode, effective-route,
and bounded fallback diagnostics are covered by dispatch/lifecycle checks.
The added package exports are consumed by the actual-factory native fixtures;
they do not advertise new host capabilities. Server-side synthesis, execution
ownership, Team authority, and the durable task lifecycle retain their contracts.

The User deferred the release decision. A minor release is recommended for the
User-visible per-call choice; no changeset or publication decision was made.

Koed recall could not connect to the local server at implementation start.
Adapter checks use deterministic fixtures and do not establish availability of
the User's normal Memory deployment.

## Final static checks

MCP and koed-server typechecks and MCP, eval, and koed-server builds passed.
Lint and formatting passed for every changed implementation/documentation file.
Repository-wide formatting reports the pre-existing untracked `CONFIG.md`.
Repository-wide lint reports 6,589 errors in existing investigation scripts.
Neither finding was changed as part of this feature. `git diff --check` passed.
