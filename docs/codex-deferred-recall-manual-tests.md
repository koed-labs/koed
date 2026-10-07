# Manual tests for Codex deferred recall

These tests cover native Codex lifecycle cases in [ticket 24](../tickets.md#24-integrate-standalone-codex-adapter-and-final-standalone-review).
The User is available for one manual case at a time. The ticket records current
results. The full standalone goal remains incomplete.

Native CLI evidence covers useful work during recall, original-turn delivery,
API Token revocation, expiry, durable cancellation, and scheduler failure.
The observation timeout attempt remains inconclusive under the delayed-read
criterion. The pending-exit attempt failed: the original turn generated an
answer after User-reported CLI disconnection, before SessionEnd retired the
receipt. One natural-timing fork attempt missed the required overlap: the
original task completed before Codex created the child. A User-approved retry
held one real query response unchanged for 90 seconds; the child prompt then
preceded durable completion, and the child received no original answer. This
qualifies CLI fork origin isolation under controlled timing, not natural fork
speed. A separate controlled `/new` test interrupted the parent and completed
package-only work in a distinct Conversation before durable completion. The
original result reached neither that Conversation nor a later parent model
answer. This qualifies that interrupted-parent CLI selection path, not an
active foreground switch. A separate native VS Code extension
26.5930.51102/backend 0.160.0 test demonstrated the positive same-turn path:
package summary before real recall completion, automatic answer/citation,
no duplicate output and scoped cleanup. The additional IDE results and bounded
closeout appear below. Desktop needs separate evidence; CLI results do not
qualify that mode.

One IDE pending-exit attempt was inconclusive: it used ordinary blocking recall
and returned a running code-mode cell rather than a pending receipt. The
pre-prompt monitors also expired before submission. It is not deferred exit
evidence. For a future attempt, start observation at actual task acceptance and
require pending-receipt admission before the User performs the selected action.
Diagnose native hook trust/invocation rather than inferring it from config.

A later User-driven IDE close with the literal gate passed the bounded safety
outcome: pending/work proof preceded native backend exit, the binding was absent
by genuine SessionEnd, and real completion produced no late model answer or
completed-result hook context. SessionEnd found an already-empty ledger, so
the first-removal handler was not directly observed. This qualifies that IDE
window-close sequence with its controlled response hold; the CLI pending-exit
failure and other frontend cases remain separate.

One separate IDE durable-cancellation case passed running/work proof, a single
protected cancel, genuine cancelled execution, one native no-answer notice,
stable history and scoped cleanup. The User kept the window open. Native Stop
or Interrupt did not substitute for cancelling the Koed task. Origin and
setup results are recorded in the closeout below.

A separate IDE execution-failure case on VS Code 1.140.0 passed real accepted
work before the original claim, executor start, genuine hard-deadline failure,
one native no-answer notice and scoped cleanup. This is separate IDE evidence;
the CLI result is not transferred.

A separate IDE timeout retry passed actual nonterminal read before deadline,
unchanged late-object drain after observation abort, one native timeout notice,
real task completion without cancel and no late answer, plus scoped cleanup.
It held a successfully read client-port snapshot, unlike the inconclusive CLI
server-side response delay. Earlier invalid/inconclusive attempts stay separate.
The later IDE closeout is recorded below; Desktop remains unverified.

## IDE closeout checklist

A bounded independent review on 2026-10-06 confirms that the passing IDE
normal-delivery, pending-window-close, cancellation, execution-failure and
observation-timeout cases need no repeat. The review checked selected sanitized
reports and criteria; it is not final whole-ticket acceptance.

A controlled native IDE fork now also passes: the User interrupted the parent,
created a distinct child with recorded parent lineage, and finished real
package-only child work before durable completion. Neither history changed
after completion or window closure, and scoped cleanup passed. The invalid
pre-recall syntax-error attempt remains separate. This does not prove natural
fork speed.

A separate active foreground-switch case also passes. The User opened a distinct
non-fork Conversation without interrupting the original. Actual package work
there preceded durable completion; one answer reached only the still-active
original owner. The selected history stayed unchanged and answer-free across
completion and window closure. Scoped cleanup passed.

Real local credential provisioning and reuse now pass against fresh fixture
storage, including actual protected API access with that credential. A native
healthy-runtime case with only the pre-call readiness hook omitted returns one
ordinary blocking answer, without a pending receipt, nonce or Stop-delivered
duplicate. After native exit, plain configuration repair restores the hook,
preserves Capture definitions and instructions, and passes contributor checking.
Scoped cleanup and selected normal-file comparisons pass.

The final simulated orphan-lock case also passes its bounded cleanup check.
A real bound receipt stayed locked after native exit. The task completed once;
only then did the host remove selected presentation state. One unchanged task
and Memory Question remained, with no cancellation, replay or late answer.
This proves post-completion orphan-state cleanup, not removal during pending
execution or crash/restart recovery. The actual package read succeeded; the
model used npm aliases in its summary, so the stricter summary monitor remains
inconclusive. Keep that limit separate from the verified file work and repair.
Configuration repair does not itself clear receipt locks. Missing runtime is a
fail-closed error, not an invitation to retry through blocking recall.

Independent final review accepts the bounded IDE active-Stop route after checking
nine case reports and 191 source/evidence manifest entries. No further manual IDE
test is required for that scope. Earlier invalid attempts, first-removal attribution
and controlled timing limits remain explicit. Desktop, unresolved CLI outcomes
and whole-ticket completion are separate.

Reuse the existing shared configuration repeat, repair, blocking-selection and
owned-removal checks. They do not establish native readiness or live repair.
Do not add idle wake-up or exited-Conversation replay tests for capabilities the
adapter does not claim. These limits still belong in the whole-objective audit.
Desktop qualification and the unresolved CLI outcomes remain separate.

The [integration guide](codex-integration.md#optional-deferred-recall-in-the-native-cli) describes the optional adapter and its limits.
The historical [F/C/T](investigations/async-memory-delivery/24-standalone-codex/FCT-LIVE-PROPOSAL.md), [exit](investigations/async-memory-delivery/24-standalone-codex/X-ROLE-LIVE-PROPOSAL.md), and [fork](investigations/async-memory-delivery/24-standalone-codex/BRANCH-LIVE-PROPOSAL.md) proposals define evidence requirements.
Their old paths, hashes, and commands do not establish a runnable current fixture.
No prepared runner command in those proposals is an instruction to launch it now.

## First Desktop positive result

A first independent Desktop case on app 26.930.61225/bundled CLI 0.160.1 passes
natural first-turn recall: actual pending receipt, package read/summary 11,618 ms
before real completion, and one automatic owned answer with exact decision/source.
One task/executor/worker and no poll/retry/cancel are recorded. Private routing,
profile/sign-in checks and scoped cleanup pass, with four unchanged normal-file
hashes. Independent review verifies 26 source/evidence hashes and retained native
SQL/rollout/durable joins. Removed receipt and full live-history checks remain
observations, not a fully replayable archive. Desktop lifecycle/origin/recovery
cases still require separate evidence; IDE/CLI results do not qualify them.

A separate controlled Desktop foreground switch also passes. The new non-fork
Conversation completes real package work before original task completion, with
no Stop/fork/quit during the test. The original remains active and receives one
owned answer; the selected new history has no recall, completion hook or answer.
Native histories and SQL items stay stable across completion and after private
quit. Cleanup and four normal-file comparisons pass. Independent review verifies
26 prior hashes and actual receipt/canonical ownership. This does not qualify
fork, interruption or recovery; full live-history completeness remains a recorded
check rather than independent raw archive replay.

A separate controlled interrupted-parent Desktop fork passes native fork lineage,
actual child package work before completion and no result into the child or later
parent model answer. One real task completes without durable cancellation. Both
histories remain unchanged through private Quit, and scoped cleanup passes.
Independent review verifies 27 selected artifact hashes and native/durable owner
joins. The retired receipt binding was not retained; full-history completeness
and 60,143 ms stability remain recorded live checks. Controlled delay does not
qualify natural fork speed, recovery or idle wake.

A subsequent-turn Desktop durable port cancellation also passes. A separate
`pwd` preflight confirms the uniquely named project and native chat cwd before
recall. One real pending receipt and actual package work precede one User-driven
protected cancellation of the running owner. Durable status moves through
`cancel_requested` to `cancelled`, attempt 1; no answer or Memory Question is
saved. One native cancellation notice and no-answer follow-up, no second recall.
Cleanup and four normal-file comparisons pass. Independent review verifies 27
artifact hashes and actual binding/native/durable owner joins. Full-history
completeness and 75,518 ms stability remain recorded live checks. Earlier
fallback and wrong-project attempts remain inconclusive. This is controlled
port cancellation, not first-turn admission, native UI cancellation or recovery.

A subsequent-turn Desktop genuine scheduler/executor failure also passes.
After native cwd preflight, a bounded preclaim gate verifies actual pending
receipt/package work and original personal accepted owner before forwarding
the original claim unchanged. The real scheduler aborts after 1,002 ms; one
task ends `failed`/`hard_timeout`, attempt 1, with no cancel, answer or Question.
One worker entry and returned insufficient/null-model boundary are explicitly
retained, without claiming full inference. One native static failure notice and
no-answer follow-up, no second recall. Cleanup and four normal-file checks pass.
Independent review verifies 27 artifact hashes and owner joins. Full-history
completeness and 79,416 ms stability remain recorded live checks. This qualifies
controlled execution failure, not observation timeout, first-turn admission
or recovery.

The first Desktop observation-timeout fixture passes bounded behavior and cleanup,
but kept the maintained 305-second native watchdog rather than the prescribed
six seconds. Its exact configuration criterion remains unmet; observed fast drain
does not establish that setting. Independent review verifies 31 prior artifacts.

A separately approved fresh retry supplies corrected Desktop T evidence. Retained
before/after and restarted definitions explicitly set the native watchdog to six
seconds, preserve Capture Stop at 30 seconds and preserve other settings. Actual
one-second observation times out; the same authenticated running snapshot drains
unchanged after 1,502 ms, and the observer exits after 1,552 ms within the watchdog.
Backend work completes once with saved Question/result and no cancellation;
no late native answer appears. Cleanup and four normal-file comparisons pass.
Independent review verifies 33 artifacts and owner joins. Full-history completeness
and 55,731 ms stability remain recorded live checks. This qualifies subsequent-turn
client-port late-read timeout, not server-write drain, first-turn admission or
recovery. The prior fixture is not retrospectively reclassified.

Desktop core provisioning/reuse and supported repair/mode/removal operations
also have bounded passing evidence. One genuine provisioned owner/token passes
protected API checks; repeated repair preserves config/guidance/unrelated MCP.
Only delivery PreToolUse is omitted for one native blocking recall: exact found
answer, ordinary task, no nonce/pending receipt/Stop-delivered duplicate.
Post-Quit repair restores prehook; blocking selection and owned removal pass.
Private secrets and preparation database archives are removed. Independent
review verifies 25 artifacts; config/raw-history completeness and 117,873 ms
stability remain recorded live checks. The earlier full contributor bootstrap
exceeded its fixture deadline and is not qualified by direct repair.
Preparation-only failures and comparison corrections did not repeat native
recall. Orphan-lock/crash recovery and unavailable-runtime fallback stay separate.

Desktop post-completion simulated orphan-state cleanup also passes. A reviewed
PostToolUse wrapper runs maintained bind first and creates one exclusive lock
after actual receipt/native/canonical/executor proof. Native useful package work
and full Quit precede completion; selected native/MCP/hook exit is checked before
clearing only the owned presentation directory after genuine completion. One
completed task/Question remains identical, no cancel, replay, new execution or
late answer. Cleanup and four normal-file checks pass. Independent review verifies
30 artifacts and owner/hash joins. Process inventory, full-history completeness
and 27,826 ms stability remain recorded live checks. This proves post-completion
simulated state cleanup; in-flight removal, crash/restart or exited-result recovery
remain unverified. New contributor bootstrap evidence is recorded below.

## Desktop exit gestures

Closing a macOS window and quitting its app are separate actions. For a full-exit
test, quit only the private test instance, including from its Dock menu if the
window has already closed. For a window-close-only test, leave that instance
running in the Dock for observation. Do not quit the normal coordinating app.

The User clarifies that the first Desktop pending-exit attempt used Close Window
followed by Dock Quit. Independent review accepts that combined native-quit
safety: recorded exit precedes genuine completion, with no late answer or replay
and scoped cleanup. Its native exit observations apply to that combined sequence,
not window closure alone. Genuine SessionEnd found the binding already absent;
first-removal attribution remains unobserved. Keep action labels and measured
backend exit separate from host cleanup and User reports.

## Prepare one case

A fixture is isolated synthetic data for one test.
Use synthetic Personal Memory with a unique answer that the prompt does not reveal.
Use the actual Memory Answer executor and existing shared runtime.
Prepare F/C/T controls separately when the User is available.

Before the User starts Codex, the agent completes these steps:

1. Preserve the previous evidence and resolve its cleanup.
2. Prepare a fresh synthetic workspace, private Codex profile, and isolated `KOED_HOME`.
3. Pin the native binary, model, source revision, selected configuration, and case controls.
4. Prepare the actual local PostgreSQL, API, Embedding Service, and Local AI Runtime.
5. Prepare the selected hooks and evidence collection for the exact client mode.
6. Supply the fixture query, expected evidence, package path, launch command, and selected action to the User.

Use Codex 0.159.3 and `gpt-5.6-luna` for comparison with retained CLI evidence.
If those versions change, record the change and treat the run as separate evidence.
Do not substitute a model after an unsuccessful attempt.

The User starts the selected AI Client and completes its native sign-in when required.
The User reviews trust for only the generated folder and selected hook definitions.
In VS Code, open the yellow-badged hook icon labelled **Review hooks** before
submitting a prompt. Review and trust only the generated Koed definitions.
Record that none of those definitions still needs approval. A folder trust
decision or an installed config does not establish hook trust; there may be no
automatic dialog. Before a timed action, require the actual pending receipt,
not merely a running code-mode cell.

When a test uses a code-mode gate, inspect Koed's payload inside the MCP
result envelope: `result.structuredContent`, or the parsed JSON text in
`result.content`. Checking `result.status` rejects a valid deferred result.
Use the reviewed literal gate for timed tests rather than asking the model
to invent this envelope check.
The agent manages isolated services and protected task controls.
Keep normal profiles and unrelated resources outside the fixture.
Do not print tokens, authentication files, environment dumps, or raw private diagnostics.

If setup, trust, ownership, or cleanup differs from the prepared case, stop that attempt.
Retain the reason and evidence.
Do not retry automatically.

## Submit one prompt

Before the case, replace `<FIXTURE_QUERY>` and `<PACKAGE_PATH>` with the values that the agent supplies.
Do not include the seeded answer in the query.
Use the prepared file tool only when its registration is ready.
If the case uses an admission gate, use the exact reviewed prompt that the agent supplies.
The generic prompt below does not satisfy the prepared gate's required output.

```text
Ask memory_answer exactly once with this question:
<FIXTURE_QUERY>

While that recall is pending, read the actual package.json at <PACKAGE_PATH>.
Summarize its package name and scripts from the file contents.
If the prepared read_package_json tool is available, use it without arguments.
Do not poll for memory status, retry recall, or make another memory request.
When the original turn receives the memory result, report its answer and citations.
If delivery reports failure, cancellation, or timeout, report that outcome.
Do not invent a memory answer.
```

A permission wait does not count as useful work.
The package summary must come from the actual file before executor completion.
Retain one native `memory_answer` call, one accepted durable task, and one executor attempt.
If the failure case needs an admission gate, review that gate before launch.
Retain the actual claim time and the unchanged execution deadline after that claim.
Do not fabricate a terminal result to obtain timing.

## Run the remaining cases

Run one case at a time.
Start each case from fresh synthetic Personal Memory and isolated state.
Accept the preceding cleanup before another case starts.
A missed pending window is inconclusive and does not authorize a replacement attempt.

| Case                    | Prepared control or action                                                                                              | Required result                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F: execution failure    | Before launch, the agent prepares the maintained scheduler hard ceiling in the isolated runtime.                        | The real executor starts. The scheduler records a genuine failed task. Codex receives the static failure notification without an answer or another recall.                                                   |
| C: durable cancellation | After pending and running-task proof, the agent calls `LocalAiRuntimeClient.cancelMemoryAnswerTask(taskId)` once.       | The protected call records cancellation. Fresh reads show the cancelled task. Codex receives the cancelled notification without an answer. Completion winning the race is inconclusive.                      |
| T: observation timeout  | The agent uses a reviewed short Stop wait and delays only one actual nonterminal read response.                         | Observation ends with a timeout. Codex receives the timeout notification. The original durable task completes normally without cancellation or another execution.                                            |
| Disconnect/reconnect    | User deliberately quits the daemon-backed frontend after pending proof, then reconnects only the original Conversation. | Actual client exit and retained original work are recorded; original completion/history stays owned, with no new recall or cross-owner output. Completed-history reconnect is not pending-delivery recovery. |
| Explicit stop-and-exit  | User chooses the observed stop-and-exit option or confirms interruption before quitting.                                | Interruption/actual exit precede completion; instrument first owned receipt retirement. No later model answer or unrelated delivery. The narrow original-turn HookPrompt exception remains.                  |
| Fork                    | After pending proof, the User confirms native interruption and uses the observed `/fork` control.                       | The child has a distinct identity and actual fork lineage. Original recall never reaches the child. Parent model output stays unchanged after interruption.                                                  |
| Switch                  | The User selects a different Conversation and submits a package-only prompt there.                                      | Original recall never reaches the selected Conversation. Retained histories distinguish foreground selection from abandonment of the original turn.                                                          |

F uses a real scheduler failure, not a helper that returns a canned error.
The earlier proposal uses `MEMORY_ANSWER_HARD_TIMEOUT_MS=1000` with the real scheduler and executor.
Prepare its current control before the case.
C tests durable cancellation, so do not use native Interrupt as its substitute.

T tests detachment from delivery observation, not cancellation of durable work.
Its case requires an actual nonterminal read before the deadline and later draining of that unchanged response.
If the first read is already terminal, record the case as inconclusive.
Retain genuine later task completion without presenting its answer after the timeout.

Native Stop can interrupt the UI without cancelling the durable task.
The accepted upstream limitation permits a late Stop HookPrompt in the interrupted original turn.
It does not permit a later model answer or delivery into a child, another Conversation, or an abandoned branch.
Record that hook prompt separately from model output.
Do not apply the F/C/T no-answer rule to that accepted original-turn context append.

If `/quit` does not produce actual exit before completion, record the observed disposition.
Forced cleanup does not prove clean native exit or SessionEnd execution.
Keep the runtime available to establish the real task outcome.
Do not infer cancellation from closing the client.

## Retain evidence for each mode

Keep the evidence inside the owned fixture.
Record the action time, native client/version/model, selected configuration, and actual Conversation, turn, call, task, and executor identities.
Retain the pending receipt, real task transitions, selected control response, and both relevant histories.

Make sure that these criteria hold:

1. Useful file work occurs before actual executor completion.
2. The case produces its genuine required terminal outcome or an explicit inconclusive result.
3. F/C/T expose no seeded answer or Evidence Bundle in native output.
4. No case starts a second recall or executor attempt.
5. No child or unrelated Conversation receives the original result.
6. A ten-second observation after the final boundary shows no duplicate delivery or new model output.
7. All recorded owned processes stop, and temporary credentials and runtime registration are removed.
8. Normal configuration and authentication remain unchanged.

A ten-second observation does not prove the absence of a network request.
A screenshot or UI label alone does not prove durable cancellation, origin identity, or process exit.
Retain forced exits, surviving processes, and cleanup errors as failed controls.

Repeat frontend qualification separately for the IDE and Desktop when their fixtures are ready.
Record each mode's useful overlap, delivery boundary, origin behavior, lifecycle outcomes, and setup behavior.
Until evidence passes review, label that mode unverified.
Do not transfer CLI trust, hook, exit, or recovery claims to those modes.

## Final setup and recovery

Isolated configuration checks passed repeated contributor setup, server repair,
blocking selection and owned removal, preserving unrelated settings and Capture
Hooks. A generator whitespace mismatch found during that check was corrected
and covered by a regression test. These checks used a synthetic unavailable
credential and no native session. They do not establish runtime provisioning,
native trust or recovery of a live receipt.

After lifecycle review, test the supported setup and repair paths on an isolated profile.
The agent prepares the exact commands before the User runs them.
Make sure that repeated setup preserves unrelated configuration and Capture Hooks.
Make sure that missing readiness retains blocking recall.

The original Stop wait is five minutes: `--wait-ms 300000` with a 305-second native hook timeout.
If a test changes the wait, set the native timeout to rounded-up wait seconds plus five.
Keep that change in the case fixture.
A wait failure does not guarantee later delivery.

Test plain repair, `--blocking-recall`, and owned removal separately from live lifecycle outcomes.
Retain the selected definitions before and after each operation.
Do not restore old trust state, sessions, or runtime registration into a fresh case.

If locked delivery state needs repair, first close all Codex sessions.
Stop their Koed MCP and hook processes.
Then clear only the selected `KOED_HOME/codex-memory-delivery` state through the prepared recovery procedure.
This does not cancel durable tasks, replay results, or restore delivery to an exited Conversation.
Record remaining crash/restart recovery limits instead of claiming recovery from cleanup alone.

## Remaining closeout after the bounded Desktop set

The nine bounded Desktop cases establish active-turn delivery, combined native
Quit safety, switch/fork isolation, durable port cancellation, real execution
failure, corrected client-port timeout, core/repair/fallback and post-completion
lock cleanup. They do not close ticket 24 by themselves.

Required gaps under the original criteria:

- [x] Qualify the prospectively approved disconnect/reconnect versus explicit
      stop-and-exit distinction. The old bare-quit abandonment verdict remains failed;
      deliberate daemon disconnect may finish only original owned work. Model answers
      after confirmed interruption remain disallowed.
- [x] Qualify CLI observation timeout separately if claiming CLI T. The fresh
      CLI client-port case passes; earlier server drain remains inconclusive.
- [x] Observe the first owned receipt-retirement transition on a reviewed exit
      attempt, or obtain an explicit criterion amendment. SessionEnd found an
      already-empty ledger in bounded frontend exit cases.
- [x] Complete the managed contributor setup/bootstrap under a realistic private
      bound. The User-driven first/repeat batch passes with existing dependencies
      and the approved private verification-disable adaptation. Default dependency
      verification, fresh installation and skipped checks remain unqualified.
- [x] Finish the integrated source/check audit for shared authorization, expiry,
      deduplication, concurrency and restart against the shipped adapter. Reuse
      unchanged shared-runtime evidence instead of repeating frontend tests.
- [x] Resolve the original disconnect/reconnect/restart/resume requirements through
      verified support or an explicit approved unsupported-scope decision where
      they prevent completion. The User approved the documented Codex recovery limits
      on 2026-10-07. No idle wake or exited-session replay is claimed.

Natural-speed repetitions, first-turn variants of every failure, native UI cancel,
Desktop server-write delay, in-flight lock removal, machine crash and OS dependency
installation are optional unless expanding those claims. Window-close alone
needs evidence only if claimed separately from the tested combined native Quit.

The overall audit must distinguish these requirements from optional expansion.
No further manual test should begin merely to repeat unchanged shared logic.

## Integrated evidence mapping and check disposition

The shipped `CodexMemoryDelivery` constructs the shared `MemoryAnswerDelivery`.
The maintained MCP factory supplies its start/get/cancel port through
`LocalAiRuntimeClient`, retaining the existing task runtime and scheduler.
No second executor or task store is introduced.

| Requirement                      | Reused source and regression evidence                                                                                                       | Remaining limit                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Fresh authority and expiry       | Shared delivery final authorized read/expiry tests; Codex binding-current and task/invocation checks; native CLI revocation/expiry evidence | Does not prove host exit eligibility after disconnection                         |
| Identity and deduplication       | Codex nonce replay, changed input, foreign PostToolUse/Stop owner, same-turn tombstone and independent identical-input Conversation tests   | Native hooks can race interruption; accepted exception remains narrow            |
| Capacity and execution ownership | Scheduler single accepted execution, lease-fence and shared blocking/async capacity tests; real native one-task/executor cases              | No new concurrency model or executor is claimed                                  |
| Canonical acceptance             | Task-runtime implicit/explicit default regression and dispatch canonical-input propagation                                                  | Team detached restrictions retain blocking/unsupported classification            |
| Disconnect/restart               | Resource-route Last-Event-ID/disconnect and scheduler lease reconciliation tests; earlier durable-runtime evidence                          | These prove execution/resource behavior, not delivery to resumed Codex receivers |

Earlier closeout verification passed 83 focused shared/Codex/runtime/scheduler
tests. Four existing test fixtures then received honest typing corrections:
typed mock arguments, a real unconnected IncomingMessage and asserted tuple/task
existence. Full `pnpm typecheck:test` now passes; the remediation's six focused
files pass 103 tests, with targeted lint/format checks. This replaces the earlier
recorded test-typecheck gap; it does not waive any native lifecycle criterion.

The integrated independent source audit found Pi's broad HTTP 409 fallback.
Pi now requires the authoritative Team-ineligibility code, with transport and
fallback regressions independently reviewed. Current Node 24 verification passes
180 tests across seven affected files, full test typechecking, lint and formatting.
The User approved the unsupported Codex recovery disposition on 2026-10-07.
Managed contributor bootstrap now passes independent result review within its
approved adapted scope. Final whole-ticket acceptance passes on 2026-10-07.

### Approved prospective CLI exit distinction (2026-10-06)

The User approved the reviewed exit-criterion amendment. Tagged 0.159.3 and
0.160.1 source distinguishes daemon disconnection from an explicit turn interrupt.
Prospective disconnect tests may observe original owned completion and later
access to that same completed history. Explicit stop-and-exit tests still require
confirmed interruption and no later model answer, with first-retirement evidence.
No different receiver may consume the original result. The old failed case stays
failed under its original criterion; the late-HookPrompt exception is unchanged.
No pending-result or runtime-restart recovery claim follows from completed-history
reconnect. Other CLI timeout/bootstrap/recovery gaps remain open.

Later CLI exit and client-port timeout cases close their separate criteria.
The User approves the documented recovery limits. The current remaining gate
was final whole-ticket acceptance, which passes on 2026-10-07.

### Prospective CLI exit checks (2026-10-07)

A fresh CLI 0.160.1 test passes the approved intentional-disconnect and exact
completed-history reconnect criteria. The frontend exited before the real
90-second retrieval hold ended. One accepted task and executor completed, and
only the original Conversation and turn received the answer and evidence. The
User reconnected to that exact Conversation without a new prompt and saw the
completed answer. Task and execution counts stayed at one. Independent review
accepts this bounded result; the earlier abandonment verdict remains unchanged.

A separate explicit stop-and-exit run records the maintained Interrupt hook
removing the original spent receipt under its same-process exclusive lock.
Native interruption confirmation and frontend exit precede backend completion.
There are no native records after confirmed interruption, including a 73-second
window after successful backend completion. Independent result review accepts
this bounded explicit stop-and-exit case.
This observes the first maintained owned retirement under the cooperative-lock
assumption, not kernel-wide removal by uninstrumented writers.

Both private fixtures' services and credentials were removed; selected normal
profile files match their immediate pre-live baselines. These tests add no
pending-result delivery, runtime-restart recovery or idle-wake claim. Separate
Final whole-ticket acceptance passes on 2026-10-07 within the approved scope.

### CLI client-port timeout (2026-10-07)

The User-reset attempt ended before any recall and remains aborted. A fresh retry
passes independently reviewed CLI timeout criteria. Its first actual authorized
task read is running; one-second observation ends with a static native notice.
The identical snapshot drains after 1,501 ms, and the observer finishes after
1,569 ms within its verified six-second watchdog. Capture Stop remains 30 seconds.
One real task completes with a found answer and an answered Memory Question,
attempt 1 and no cancellation. Original native history stays unchanged for
93.258 seconds after completion and through User quit. Scoped cleanup and four
normal-file comparisons pass. This is CLI client-port latency, not HTTP
server-write drain, first-turn admission or runtime-restart recovery.

### User-driven managed contributor bootstrap (2026-10-07)

The User runs a fresh private first/repeat batch after source review. Both genuine
setup commands return healthy and complete real DB/MCP builds, configuration and
client registration. One credential/owner remains valid, and config/guidance
hashes match across runs. Unrelated settings remain intact. The private API
passes real readiness and protected credential checks.

The test uses existing dependency inputs with an approved private-only Boolean
`verifyDepsBeforeRun: false` and a pinned pnpm adapter. No dependency installation
or purge is authorized. Default dependency verification, fresh installation,
skipped capture/doctor checks and OS dependency installation remain unqualified.
Earlier readiness and automatic-install failures are retained separately.

Both process groups and private API/runtime/embedding/PostgreSQL stop. Secrets,
profile and environment state are removed. Seven selected normal-file hashes,
all original source/compiled-input hashes and ten dependency links remain intact.
No recall or model executes. Independent result review accepts this adapted
managed contributor case. Final whole-ticket acceptance passes within the
User-approved scope. No remaining required manual check is open for this scope.
