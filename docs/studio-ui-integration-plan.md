# UI integration: agreed simplification

Updated 2026-10-14 from the User’s explicit decisions. This revision overrides conflicting soul/profile, role-template, Job-protocol and parallel-recall requirements in the historical ticket bodies and plans. It does not approve wholesale removal of reviewed features. Original tickets 01–23 remain as dated implementation evidence, not current release acceptance.

## Product contract

Agents retain stable identity, name, optional free-text job title and Pixelkin appearance. A title is display metadata, never instructions or authority. Execution model, reasoning, permissions and device selection belong to the chat or explicit task. Keep sequential multi-Agent conversations across the same or different providers with bounded public context.

Remove instruction generation/storage from new Agent writes and the role-template lookup/association. Preserve existing encrypted records and authorship/history; do not delete applied migrations or rewrite native source history. New progress and history derive from real execution records. Memory uses the existing supported memory_answer route, with no Agent-dependent parallel retrieval or backend LLM synthesis.

## Ticket sequence

These are local Markdown implementation tickets, not newly created Linear/GitHub issues. Tickets 24–28 implement the authorized simplification. Ticket 29 adds the requested recurring-task feature to the plan; implementing/enabling a scheduler is a separate feature slice. Ticket 30 tracks integration and release evidence.

| Ticket | Work                                       | Current state                                   | Depends on                       |
| ------ | ------------------------------------------ | ----------------------------------------------- | -------------------------------- |
| 24     | Simplify Agent identity                    | Implemented; validation passed                  | —                                |
| 25     | Reuse native execution and history         | Implemented; validation passed                  | 24                               |
| 26     | Use one Memory path                        | Implemented; validation passed                  | 25                               |
| 27     | Standardize chat wiring                    | Personal implemented; Team/PR follow-up         | 24–26                            |
| 28     | Simplify progress panel sources            | Implemented for native chat                     | 25, 27                           |
| 29     | Recurring Agent tasks inspired by OpenDots | Planned                                         | 24–28; provider discovery        |
| 30     | Validate retained UI and release           | Automated checks complete; live acceptance open | 24–28 and release-selected scope |

## Recurring-task reference

Inspected CopilotKit/OpenDots main at `625452e06cde74cb25b0ce319e2c1be0488f5a5f` on 2026-10-14. Reference: https://github.com/CopilotKit/OpenDots. Its `src/server/store.ts` persists interval/next-run state, claims runs with leases, schedules repeats after success and retains interrupted/failed runs for explicit review. `src/server/runner.ts` separates scheduling from an injected executor. Its default chat adapter uses an OpenAI-compatible API (`src/server/dot-agent.ts`), not Codex app-server. Claude support is not established by that adapter.

Reuse concepts only initially: schedule separate from execution, durable occurrence identity, explicit pause/resume/Run now, next-run visibility and honest interruption. Adapt execution through Koed’s existing Codex and Claude native adapters. Decide interval versus calendar/time-zone semantics, missed-run behavior, concurrency and restart handling before implementation. An unavailable provider/device must not trigger another account/provider or silently replay uncertain effects. Scheduled runs use the same Memory and progress path and appear in Agent/conversation history. No OpenDots runtime, credential model, Intelligence dependency or separate Memory store is adopted.

## Validation and data boundaries

Use disposable branch test databases: the currently configured Personal database belongs to a newer main-line runtime and is not compatible with the old packaged Studio test app. Keep Memory service restoration separate from running branch migrations. Preserve all previous staged multi-Agent changes and history. Do not claim that a focused test, a plan status or an old review certifies live Codex/Claude, hosted, Team, PR or Windows/Linux behavior. Record each tested surface and remaining acceptance gap.

## Implementation checkpoint — 2026-10-14

Tickets 24–26 and the native-chat portion of 28 are implemented. Agent metadata writes no longer store soul instructions or profile model defaults. Retained legacy versions remain readable. Native deliveries and executions supply history, actual activity and launch settings without fabricated attempts. The Agent-specific assignment/phase-reporting tools and eager Memory retrieval are removed.

Ticket 27 shares Personal recipient validation between local and hosted chat and retains sequential same/cross-provider execution. Hosted regression checks cover bootstrap, acceptance before navigation, preservation of later draft edits, and access revocation. Team request acceptance that depended on the retired Job protocol now returns an explicit unsupported response rather than writing more Jobs. Replacing that Team workflow and verifying PR-specific adapters remain open acceptance work; this is not an entire-UI completion claim.

Validation: Studio production build, API, worker and Studio typechecks, focused Agent API/editor/launch/activity tests, two existing browser scenarios, and disposable PostgreSQL history/authority checks pass. Release metadata is synchronized. All sixteen disposable multi-Agent execution scenarios pass, including same/cross-provider ordering, idempotent retries, uncertain outcomes, bounded context and identity rename continuity. Live provider execution, hosted two-device use, Team/PR flows, and Windows/Linux release checks remain open. The installed Memory runtime is healthy; this branch has not been deployed into the current Personal database or packaged app.

Backend validation also passes: worker service/dispatcher 109 tests, API context/routes/runner/local-edge 144 tests, DB repository 26 tests, and shared contracts 21 tests. These focused counts overlap some earlier checks; they are not a full-repository test total.

## Remaining ticket count

Five actionable tickets remain open across the original backlog and this revision. Four contain feature/integration work; one covers validation and release. This count consolidates overlapping tickets instead of counting the same work twice.

| Ticket | Remaining work                                                                                                                  | Kind                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 15     | Finish Team Memory-answer feedback wiring and acceptance; Personal feedback is already implemented.                             | Integration; remaining scope decision       |
| 22     | Discover and reuse the selected AI Client’s configured Plugins and Skills through supported provider mechanisms.                | Feature; details still to settle            |
| 27     | Replace retired Team Agent assignment with native execution and verify Team/PR adapters. Personal shared wiring is implemented. | Integration                                 |
| 29     | Implement recurring Agent tasks through Codex and Claude native execution.                                                      | Feature; schedule semantics still to settle |
| 30     | Live provider, hosted/two-device, retained UI, packaging and platform acceptance.                                               | Validation and release                      |

Historical Ticket 21’s progress work is covered by Ticket 28 and final acceptance under 30. Ticket 23’s release checks are consolidated into 30. The unclosed live checks from Tickets 03–05 and other scoped historical tickets are acceptance rows under 30, not additional feature tickets. Legacy Job work in Tickets 10–13 is superseded by 24–28; unfinished Team native replacement belongs to 27. This is a planning consolidation, not a claim that old live checks have passed.

Push verification: whole-tree formatting/lint scans were stopped after traversing generated build output. Root ESLint 10 fails to load the installed React plugin (`contextOrFilename.getFilename`); changed files were checked separately with the already-installed ESLint 9. That root-config scan also reports unsupported hook-rule declarations, server-global configuration errors, and broader existing typed-lint findings; it is not a passing lint gate. Newly exposed refactor leftovers were corrected and package-scoped focused checks used where applicable. Generated artifacts are not release evidence.
