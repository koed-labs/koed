# Ticket 04: Project chat assessment

Assessed on 2026-10-15 against `233b5a18bd5cca6f34cb67e9a8ab27d313444ecb`, using three Luna Extra High reviews and the original Ticket 04 decision and manual-review records. Koed recall returned an unverifiable answer; no recalled claims were used. This assessment preserves the User's accepted local Codex scope and explicit deferrals.

## Accepted and implemented

- Local New Chat loads registered Projects through `/studio-api/projects`, merges them with Home context, and preserves registered opaque IDs. It does not require a captured Conversation for a registered folder to be selectable. See `apps/studio/src/app/page.tsx`, `LocalConversationBrowser.tsx` and `packages/koed-server/src/project-metadata.ts`.
- Local Project starts resolve the selected registered ID on the execution computer. Standalone starts use an independent workspace. The browser does not supply the runner's filesystem path.
- Codex receives the verified working directory. The original live Electron and loopback-browser review demonstrated Project and standalone starts, same-thread standalone-to-Project and Project-to-Project moves, destination instruction markers, drag/drop, cancellation, notice preference and retention of edits in a user-owned source folder. These passes remain accepted; they are historical live evidence, not a new provider run.
- Memory uses the supported `memory_answer` path. Project instructions belong to the AI Client's working context; a second Agent-specific instruction or Memory assembly path is not needed.

## Confirmed gaps

| Area                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                   | Disposition                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary Claude Project instructions | The worker configures `settingSources: []`; the pinned SDK states that this disables filesystem settings and that `project` is required for native `CLAUDE.md` loading. Selecting skills changes this behavior, so ordinary chats do not receive the same Project instruction loading. See `apps/worker/src/managed-conversation-service.ts` and `packages/mcp-server/src/claude-managed-conversation.ts`. | The instruction-only implementation is staged behind a default-off gate without importing permission or hook settings; live Claude and cross-home snapshot preservation remain unverified. Ordinary Claude starts are distinct from the deferred Claude Project Move verification.                                                     |
| Hosted registered-Project catalogue  | Browser launch options and ordinary hosted Project-start authorization use `listLcmGraphThreads`, capped at 500, rather than the assigned computer's registry. An empty registered Project can be omitted and rejected. See `apps/api/src/managed-conversations/routes.ts`, `browserLaunchOptions` and the Project-start check.                                                                            | Retain under the explicitly deferred hosted scope. No existing owner/device-scoped registry publication was found. A future fix needs an authenticated runner publication of opaque IDs and display names, exact device/credential scope, freshness and revocation rules. Paths stay local; the runner still resolves the selected ID. |

Enabling an SDK settings source is broader than reading an instruction file. Any Claude correction must preserve Koed's selected permissions, tool policy and MCP configuration rather than treating all folder configuration as authority.

## User decision — 2026-10-15

Keep Koed's existing permission isolation and design instruction-only Claude loading before enabling it. Do not enable the SDK's Project settings source as a shortcut. The User approved omitting an additional changeset for this documentation-only assessment and including the eventual behavior fix in the existing minor changeset. Those are separate decisions; a release note must not claim that an unimplemented fix has shipped.

See the [instruction-only loading design](studio-claude-project-instructions.md) for implementation boundaries and validation gates. This resolves the authority choice; implementation is now staged behind the validation gate. Hosted catalogue and Move deferrals remain unchanged.

## Remaining acceptance and deferrals

- Preserve the explicit deferrals for hosted/two-device starts and Moves, offline Pending/cancel, other-provider Move, and a real Move producing dirty Koed-managed source retention. Hosted Move remains gated.
- Keep live missing-destination, active-turn, queued-command and unavailable-runner cases open. Existing authority/runner tests are useful coverage, not live acceptance.
- Keep different-installation notice preference and offline source-edit status checks open. The same-installation notice preference already passed.
- Current Claude Project starts, continuation and reload need provider verification after any instruction correction. Mocked SDK options alone cannot establish a real Claude reply or instruction-following result.
- Synthetic deletion of a retained managed worktree does not establish that a real Move created that retention record.

The original ledger remains in the prototype checkout under `.scratch/koed-frontend-integration/issues/04-start-a-chat-in-a-project-or-outside-a-project.md` and `ticket-04-manual-test-script.md`. The versioned [Move contract](studio-project-move.md) describes the execution boundary.

## Validation of the assessment baseline

Current-source checks passed: 194 API/runner tests, 30 Studio launch/selection/handoff/component tests, and 42 hosted-client/sidebar/Move-preference tests. Three extensionless-import test files initially failed under direct Node invocation; they passed under Vitest. An initial root Vitest command also discovered old scratch checkouts; its failures were excluded from current-source results and the three current API/runner files were rerun with scratch paths excluded. No live Personal database, provider session or running application was changed for this assessment.

Ticket 04 remains open. The assessment removes the unsupported claim that all Project catalogues or instructions need rebuilding; it does not certify the gated Claude implementation or certify deferred hosted/provider behavior.
