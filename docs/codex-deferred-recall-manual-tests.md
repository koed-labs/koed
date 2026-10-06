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

| Case                    | Prepared control or action                                                                                        | Required result                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F: execution failure    | Before launch, the agent prepares the maintained scheduler hard ceiling in the isolated runtime.                  | The real executor starts. The scheduler records a genuine failed task. Codex receives the static failure notification without an answer or another recall.                              |
| C: durable cancellation | After pending and running-task proof, the agent calls `LocalAiRuntimeClient.cancelMemoryAnswerTask(taskId)` once. | The protected call records cancellation. Fresh reads show the cancelled task. Codex receives the cancelled notification without an answer. Completion winning the race is inconclusive. |
| T: observation timeout  | The agent uses a reviewed short Stop wait and delays only one actual nonterminal read response.                   | Observation ends with a timeout. Codex receives the timeout notification. The original durable task completes normally without cancellation or another execution.                       |
| Pending exit            | After pending and running-task proof, the User requests `/quit`.                                                  | Actual native exit precedes completion. Genuine SessionEnd input retires the owned delivery binding. The task completes without delivery into a new owner.                              |
| Fork                    | After pending proof, the User confirms native interruption and uses the observed `/fork` control.                 | The child has a distinct identity and actual fork lineage. Original recall never reaches the child. Parent model output stays unchanged after interruption.                             |
| Switch                  | The User selects a different Conversation and submits a package-only prompt there.                                | Original recall never reaches the selected Conversation. Retained histories distinguish foreground selection from abandonment of the original turn.                                     |

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
