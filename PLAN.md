# MCP Tasks investigation

Date: 2026-09-30\
Branch: `feat/async-memory-calls`\
Status: Complete within the current User-approved scope. Shared/Pi 17–20, standalone Claude 21–22, Codex 23–24 and corrections 25–26 passed review. Native CLI, IDE and Desktop evidence supports the documented delivery limits. The User-approved recovery and bootstrap adaptations close the former gaps. Historical failed cases remain unchanged. Ticket 13 retains its negative research verdict, with required safety corrections accepted in 19–20. Stronger recovery and native MCP Tasks adoption remain future work. No changeset, push, deployment or publication follows from completion.

## Objective

Determine whether MCP Tasks can provide one standard foundation for asynchronous
Memory Answer calls across Codex, Claude Code, and Pi. The calling AI Client must
continue useful work while recall runs and receive the completed result later.

Use the existing durable Personal Memory Answer runtime as the execution owner.
Assess client support before choosing implementation work. This plan authorizes
an investigation, not a production rollout.

## Scope and boundaries

Start with Personal `memory_answer`. It is the supported recall entry point and
the main source of waiting time. Inventory the other exposed memory tools, but
assess their need for task execution separately.

Keep these existing boundaries throughout the investigation:

- Keep Answer Synthesis in the AI Client, under Local AI Runtime ownership.
- Reuse `memory_answer_tasks`, its encryption, execution leases, and bounded admission.
- Keep Memory Questions as completed history, separate from task state.
- Keep low-level Diagnostic Memory Tools hidden unless explicitly enabled.
- Preserve result-detail modes, Evidence Bundles, and memory authorization.
- Keep task status checks in the host or transport, outside the model loop.
- Keep Team Workspace execution separate until its upstream authority can own durable acceptance and completion.

Use a maintained MCP SDK extension, as required by ADR 0043. If one is unavailable,
record the dependency and adoption options. Do not create a parallel MCP dispatcher.

## Starting evidence

The repository already accepts durable Personal Memory Answer tasks. It exposes
internal start, state, cancellation, and event-stream endpoints. The MCP adapter
and Pi extension currently wait for the completed result.

The server pins MCP protocol revision `2026-07-28`. It uses
`@modelcontextprotocol/core` and `@modelcontextprotocol/server` version `2.0.0`.
The Tasks extension API and its compatibility with these dependencies remain open questions.

Installed versions observed during the initial review were Codex CLI `0.157.0`,
Claude Code `2.1.267`, and Pi `0.85.1`. Refresh these versions before experiments.
Record Desktop, IDE, and SDK versions separately.

Current Claude Code documentation describes automatic background execution of
long MCP calls. Codex documents background hooks and app-server output delivery.
Pi exposes custom message delivery through its extension API. These features do
not establish native MCP Tasks support.

Existing Koed capability reports mark Claude continuation as `unsupported` and
Codex/Pi continuation as `requires_bridge`. Treat these as current implementation
reports, not conclusions about all released clients.

Repository starting points:

- [Durable Memory Answer execution](docs/durable-memory-answer.md)
- [ADR 0043](docs/adr/0043-durable-memory-answer-execution.md)
- [MCP server factory](packages/mcp-server/src/mcp-server-factory.ts)
- [MCP protocol tests](packages/mcp-server/tests/mcp-v2-protocol.test.ts)
- [Task runtime](packages/mcp-server/src/memory-answer-task-runtime.ts)
- [Task scheduler](packages/mcp-server/src/memory-answer-task-scheduler.ts)
- [Task contract](packages/shared/src/memory-answer-task-contract.ts)
- [AI Client capabilities](packages/mcp-server/src/ai-client-runner.ts)
- [Pi extension](packages/mcp-server/integrations/pi/extensions/koed.mjs)
- [Pi runtime tests](packages/mcp-server/tests/pi-extension-runtime.test.ts)

## Questions that need separate answers

Task execution, notification delivery, and model continuation are separate capabilities.
A notification is an update that a server sends to a client. Receiving one does
not prove that the client supplies its content to the model.

Answer these questions for each client mode:

1. Does the client declare and negotiate the Tasks extension?
2. Does it accept a standard task response from `memory_answer`?
3. Does the agent continue before the task completes?
4. Does the client deliver the completed result without model polling?
5. Does a result arriving after the turn ends start work or wait for another user turn?
6. Does delivery retain the query, task, tool call, and Conversation identity?
7. Can the client recover accepted work and result delivery after disconnection or restart?
8. What configuration, model, transport, or version restrictions apply?

## Investigation sequence

### 1. Establish the protocol and SDK contract

- [x] Read the current Tasks extension specification and record its revision or commit.
- [x] Distinguish the selected extension from older task proposals and protocol revisions.
- [x] Inspect the pinned SDK exports, extension packages, examples, and conformance tests.
- [x] Identify the maintained server and client APIs for task execution.
- [x] Record negotiation, task response, status, completion, cancellation, expiration, and notification schemas.
- [x] Record the polling behavior when notifications are unavailable.
- [x] Determine whether SDK task storage can delegate to Koed's durable task repository.
- [x] Record required upgrades, their release status, and relevant compatibility changes.

Exit condition: a sourced contract and a supported SDK route, or a precise SDK blocker.
Do not infer schemas from method names or copy an earlier proposal without checking its revision.

Reviewed evidence: [ticket 01 SDK report](docs/investigations/mcp-tasks/01-sdk-route/REPORT.md). The maintained .NET route passed a synthetic reference roundtrip and independent reproduction. TypeScript server adoption remains a separate dependency gap; no production adapter choice has been approved.

### 2. Build a controlled protocol probe

A probe is a small server used to observe client behavior. Use synthetic queries
and results so the first experiments need no Personal Memory or synthesis worker.
Run the probe separately from normal Koed configuration.

- [x] Build the probe with the selected maintained SDK extension.
- [x] Support controlled completion, failure, cancellation, and expiration.
- [x] Include stable task identifiers and a recognizable result marker.
- [x] Record request capabilities, discovery responses, lifecycle messages, and timestamps.
- [x] Exercise task negotiation with a reference SDK client before testing AI Clients.
- [x] Demonstrate the defined behavior when the caller does not support Tasks.

Run short tasks and tasks that cross client background thresholds. Use controlled
delays rather than slow model generation. Record task acceptance, independent
agent work, completion, host receipt, and first model use of the result.

Exit condition: a repeatable probe that distinguishes native Tasks from ordinary
MCP calls that the client later moves into the background.

Reviewed evidence: [ticket 02 report](docs/investigations/mcp-tasks/02-lifecycle-probe/REPORT.md). Standard polling is usable; positive task push remains blocked by the released SDK. Reference-host work does not establish model continuation.

### 3. Test each supported client mode

Keep native and adapted results separate. A bridge is client code that delivers
a task result into its Conversation. A successful bridge does not prove native support.
An unavailable client surface remains untested, rather than inheriting another surface's result.

| Client mode                   | Native Tasks negotiation                                   | Agent continues                                    | Result reaches model                                        | Recovery                                                             | Evidence                         |
| ----------------------------- | ---------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------- |
| Codex CLI                     | No opt-in; protocol 2025-06-18                             | No activity during tested 65s call                 | Ordinary result only                                        | Detached Tasks unavailable                                           | Ticket03                         |
| Codex Desktop                 | Untested: automation denied                                | Untested                                           | Untested                                                    | Untested                                                             | Ticket04                         |
| Codex IDE                     | No opt-in; independent runtime 0.155.0-alpha.16.3          | Ordinary batch only                                | Ordinary result only                                        | Detached Tasks unavailable                                           | Ticket04                         |
| Koed-managed Codex app-server | Persistent client lacks Tasks opt-in                       | Scoped standalone bridge allows useful overlap     | Active/idle/interrupted output on actual class              | Same persistent thread resumes while external task owner stays alive | Ticket05 + persistent supplement |
| Claude Code interactive       | Default lacks Tasks; forced current discovery blocked      | Ordinary background: useful overlap                | Automatic active/idle notification                          | Stop-and-exit loses pending task                                     | Ticket06                         |
| Koed-managed Claude Agent SDK | Actual runner has no MCP connection                        | Actual none; adapted streaming ordinary overlap    | Adapted streaming delivers automatically                    | Persistence disabled in tested modes                                 | Ticket07                         |
| Pi with extension             | No installed native MCP client                             | Scoped SDK extension bridge overlap                | Active/idle/follow-up/nextTurn distinctions proved          | Stale delivery guarded in fixture; durable recovery absent           | Ticket08                         |
| Koed-managed Pi RPC           | Worker omits recall; persistent extension uses direct HTTP | Adapted RPC component overlap; existing host waits | Adapted active/idle proof; current host lacks late delivery | Completed history resumes/forks; pending close/cancel result lost    | Ticket09 + persistent supplement |

For Codex, compare native MCP Tasks with app-server delivery and background hooks
only if native support leaves a gap. Distinguish Responses API async function
calling from support in the installed Codex host.

For Claude Code, compare native Tasks with automatic background execution of
ordinary MCP calls. Record `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, non-interactive
restrictions, and subagent restrictions. Test the Agent SDK's actual managed
execution mode separately.

For Pi, determine whether its installed MCP client consumes Tasks. The current
Koed extension calls the Local AI Runtime directly. Assess the changes required
to consume the standard task contract and deliver results through `sendMessage()`.

Exit condition: each available mode has traces that support its classification.
Record unavailable modes and the exact evidence still needed.

### 4. Map MCP Tasks to Koed execution

Prepare a mapping before changing the adapter. Map task creation, public task
identity, statuses, cancellation intent, final results, expiration, and updates.
Keep retry attempts and execution lease generations internal unless the standard requires them.

- [x] Reuse durable acceptance and invocation identity to avoid duplicate work.
- [x] Map Koed lifecycle states to the selected standard without losing cancellation semantics.
- [x] Preserve application-error results separately from protocol and execution errors.
- [x] Align public task lifetime with durable result retention.
- [x] Reauthorize task reads, subscriptions, cancellation, and delivery for the owning User.
- [x] Bind delivery to the originating Conversation and invocation.
- [x] Keep disconnect behavior separate from explicit cancellation.
- [x] Assess whether adapter subscriptions can reconnect from durable state without missed terminal results.
- [x] Preserve the single shared answer execution limit.
- [x] Record any storage, SDK, or capability-contract changes that adoption requires.

Exit condition: a reviewed mapping that reuses existing execution ownership.
If the SDK requires competing durable storage, document that conflict and its alternatives.

### 5. Prove delivery, recovery, and useful continuation

Repeat the controlled experiments through the proposed Koed task adapter. Use a
synthetic result before running a real Personal Memory Answer. Record accepted
work survival separately from successful delivery to a resumed client.

| Scenario                             | Evidence required                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| Normal completion                    | The agent performs independent work before completion and uses the result afterward. |
| Result after turn completion         | The trace shows the exact idle behavior and any continuation trigger.                |
| Failure or expiration                | The agent receives an attributed terminal outcome without repeated polling.          |
| Explicit cancellation                | Cancellation affects only the selected task and handles a racing completion.         |
| Adapter disconnect                   | Accepted work remains durable and a reconnect retrieves its terminal state.          |
| Local AI Runtime restart             | Recovery creates no duplicate final Memory Question.                                 |
| Repeated acceptance or notification  | Work and visible delivery follow documented deduplication guarantees.                |
| Concurrent recalls                   | Each answer retains the correct query, task, and Conversation identity.              |
| Conversation switch, fork, or resume | Late results do not enter an unrelated Conversation or abandoned branch.             |
| Different User or revoked authority  | Unauthorized task access and delivery fail.                                          |

Measure waiting time against the existing blocking path. Report acceptance
latency, time to independent work, result delivery latency, and extra model turns.
Do not claim a speed improvement from a task receipt alone.

The agent can inspect files and gather independent evidence while recall runs.
Before a memory-dependent decision, it must receive the relevant result or report
that recall failed. Define that behavior in the experiment instructions.

Exit condition: repeatable traces prove the proposed client behavior and its limits.
Document any delivery guarantee that remains weaker than durable task execution.

### 6. Record the feasibility decision

Produce a report in `docs/mcp-tasks-feasibility.md` after the experiments.
Classify each client mode as native, bridge required, blocked, or untested.
Include versions, transports, configuration, model identity, evidence paths, and restrictions.

Recommend one outcome based on the evidence:

- Adopt MCP Tasks across the supported modes that pass the experiments.
- Adopt MCP Tasks with explicitly scoped client bridges for documented delivery gaps.
- Defer adoption until named SDK or client dependencies provide the missing capabilities.

List the minimum SDK and client versions for each viable route. State whether
standard task notifications suffice or the host needs bounded status checks.
Explain how clients without Tasks support retain a defined recall behavior.

Put approved implementation follow-ups in `TODO.md`. Propose updates to ADR 0043,
capability reporting, and integration documentation only where the evidence requires them.
Keep this investigation plan separate from a production implementation commitment.

## Completion criteria

- [x] The report identifies the exact MCP Tasks contract and maintained SDK route.
- [x] The client matrix separates native protocol support, continuation, delivery, and recovery.
- [x] Every supported claim links to a trace or an exact source and version.
- [x] Untested modes and blockers remain explicit.
- [x] The latency comparison demonstrates useful work during recall.
- [x] The Koed mapping preserves ownership, authorization, encryption, and final history.
- [x] The recommendation identifies a viable next implementation step or a precise dependency blocker.

The checklist assesses the research report and reviewed mapping. It does not certify
production behavior. The mapping requires authorization before event delivery and
safe diagnostics; ticket 13 counterexamples show that the existing runtime does not
satisfy those requirements. Its two safety criteria remain unchecked. Deferral is
one of this plan’s permitted outcomes, and no implementation follow-up was approved.

Reviewed final report: [MCP Tasks feasibility](docs/mcp-tasks-feasibility.md).
Independent assessment: [ticket 14 review](docs/investigations/mcp-tasks/review/14-independent-review.md).

## Primary references

These sources informed the initial review. Refresh them before experiments and
record the versions used. Their presence does not mark an experiment as passed.

- [MCP Tasks overview and specification links](https://modelcontextprotocol.io/extensions/tasks/overview)
- [MCP extension support matrix](https://modelcontextprotocol.io/extensions/client-matrix)
- [Codex MCP integration](https://developers.openai.com/codex/mcp)
- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Codex background hooks](https://developers.openai.com/codex/hooks#run-hooks-in-the-background)
- [Responses API async tool calling](https://developers.openai.com/api/docs/guides/async-tool-calling)
- [Claude Code MCP background execution](https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background)
- [Claude Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Pi extension documentation for v0.85.1](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md)

## Continued phase: shared delivery boundary and natural first-turn recall

The User clarified the objective after the feasibility report: an agent must
invoke Koed on its first turn, continue useful work while recall is pending,
and receive the result through polling or native delivery. On 2026-09-30 the
User approved continuing with a shared execution-and-delivery boundary and
client adapters, preserving eventual MCP Tasks adoption. This phase authorizes
isolated prototypes and evidence, not production rollout.

Keep the completed investigation and its negative findings intact. The shared
boundary delegates acceptance, state and cancellation to the existing durable
Personal runtime. Client adapters own acknowledgment, continuation triggers,
Conversation attribution and presentation. No second executor, generic queue,
parallel MCP dispatcher or backend synthesis is introduced.

The first prototype uses a real Pi agent and a naturally agent-initiated
`memory_answer` call. Its answer data and synthesis are explicitly synthetic
until a separate real-executor proof is completed. Use authenticated polling,
not the unsafe SSE paths. A second blocking adapter must use the same shared
boundary. Record a maintained MCP Tasks mapping without claiming native client
support or selecting .NET for production.

Exit criteria:

- [x] One client-independent lifecycle boundary delegates to real durable execution.
- [x] Client adapters contain presentation and continuation behavior only.
- [x] A real model initiates recall in a single first-turn user workflow.
- [x] Useful independent work precedes completion and the model uses the result without another user prompt.
- [x] The original invocation, task, query and Conversation remain bound.
- [x] Fresh authorization and stale-Conversation checks guard delivery.
- [x] Blocking fallback and future maintained MCP Tasks mapping reuse the boundary.
- [x] Synthetic execution, real synthesis and recovery guarantees remain distinct.
- [x] Independent review accepts the prototype and its documented limits.

Reviewed prototype: [ticket 15 report](docs/investigations/async-memory-delivery/15-shared-boundary/REPORT.md).
Acceptance: [orchestrator review](docs/investigations/async-memory-delivery/review/15-orchestrator-review.md).
The live proof uses synthetic Answer Synthesis with real durable runtime components;
it does not complete a production adapter, real retrieval or delivery recovery.

## Continued validation: real Answer Synthesis

On 2026-09-30 the User asked to continue after ticket 15, whose stated next step
was real Answer Synthesis validation. Ticket 16 reuses the reviewed shared boundary
and Pi delivery adapter in an isolated synthetic-memory deployment. It replaces
the synthetic execution callback with the production MemoryToolExecutor and
AI-client Memory Answer worker. No production rollout, normal-memory ingestion or
new execution owner is authorized. Preserve ticket 13 blockers and ticket 15 limits.

Use approved gpt-5.6-luna for isolated model work. Seed only generated memory in a
new owned database. Bound file/model payloads and credentials as in ticket 15.
Actual retrieval, synthesis, formatter and final history must be identified; any
embedding fixture must remain explicit and cannot establish real embedding quality.
Do not accept fallback/error/insufficient output as successful synthesis. Avoid SSE.

Exit criteria:

- [x] Real MemoryToolExecutor and AI-client worker execute the accepted task.
- [x] Generated stored memory is recalled through actual authorized retrieval.
- [x] The outer agent initiates canonical recall and performs useful work while pending.
- [x] The synthesized decision and previously unavailable source identifier reach the same Conversation automatically.
- [x] Task, invocation, query, evidence and final Memory Question remain attributable.
- [x] No successful claim depends on a synthetic synthesis callback or fallback.
- [x] Versions, source hashes, traces, timings, fixture limits and cleanup are reviewed independently.

Reviewed evidence: [ticket 16 report](docs/investigations/async-memory-delivery/16-real-synthesis/REPORT.md)
and [orchestrator acceptance](docs/investigations/async-memory-delivery/review/16-orchestrator-review.md).
Actual retrieval/synthesis/history and automatic Pi SDK delivery are proven in the
isolated fixture. Embedding quality, shipped client integration, durable delivery
recovery and ticket 13 production safety remain separate work.

## Approved implementation: shared recall delivery and Pi adapter

The User asked to proceed after the proposed narrow production implementation:
move the tested lifecycle into supported code, add Pi delivery and recovery,
retain blocking recall, and fix the known authorization/logging blockers before
release. This authorizes repository implementation and isolated validation, not
deployment, publication, normal-memory experiments or unrequested client changes.
The original investigation's deferral remains historical; no native Tasks support
or maintained TypeScript Tasks runtime is inferred from these changes.

Tickets 17–20 implement one lifecycle over the existing durable executor, a Pi
presentation adapter, bounded recovery to the same Conversation and prerequisite
runtime safety corrections. Conversation history/delivery receipts are delivery
state, never a second execution queue. Forked or switched Conversations must not
inherit pending delivery; reconnect resumes only matching pending receipts and
suppresses already recorded completions. Document crash/replay limits precisely.
Blocking recall remains available for unsupported adapter capabilities and Team
requests; Personal detached eligibility stays authoritative in the runtime.
Future maintained MCP Tasks adapters consume the same execution port and let the
native host own continuation. No custom dispatcher or backend synthesis.

Keep each worker's files separate and integrate after review. Preserve unrelated
working-tree changes. Update docs and TODO; do not put implementation in CONTEXT.
User-approved gpt-5.6-luna and generated-only isolated services remain authorized.
Real embedding validation must use an owned process/model cache reference rather
than normal Memory; record any unmet release validation explicitly. The User confirmed no changeset for this implementation under AGENTS.

Implementation exit criteria:

- [x] One reusable lifecycle delegates actual acceptance/read/cancel without client APIs or a second executor/store.
- [x] Pi acknowledges Personal recall promptly and automatically consumes the attributed result; defined blocking fallback remains.
- [x] Matching pending receipts recover after restart/resume; stale/forked/delivered results are suppressed.
- [x] Cancellation, expiry, identity, authorization and ownership retain their defined semantics.
- [x] Runtime SSE and diagnostic counterexamples have regression fixes and tests, or release is explicitly blocked.
- [x] Shipped adapter and real embeddings receive isolated end-to-end validation.
- [x] Documentation, release decision and affected checks are complete, with independent review.

## Next priority: independently started AI Clients

The User prioritised independently started providers over Koed-managed
Conversations on 2026-09-30. The next target is Claude Code's interactive main
Conversation, followed by separately assessed standalone Codex CLI, IDE and
Desktop modes. Managed Codex app-server and Claude Agent SDK adapters are
deferred; their host-control capabilities must not substitute for this scope.

Claude Code's documented ordinary MCP backgrounding and ticket 06's actual
interactive continuation evidence provide the first route. Validate it against
Koed's supported MCP adapter and shared durable runtime, with a prompt receipt,
useful independent work and automatic completion in the original Conversation.
Keep ordinary MCP results and host background notifications distinct from
standard MCP Tasks. Threshold configuration belongs to Claude's host process;
setting an environment variable only on the Koed MCP child cannot configure it.
Use isolated per-launch configuration before any supported setup change. Do not
silently modify normal Claude/Codex profiles. Session-exit recovery, subagents
and IDE restrictions must retain their separately tested classifications.

For independently started Codex, assess host-supported late context injection
and idle continuation before implementing an adapter. A prompt task receipt
without automatic delivery is not completion. Reuse the existing execution owner
and shared lifecycle wherever the host supports a presentation adapter. Native
MCP Tasks remain a future maintained adapter, not a reason to create another
executor or protocol dispatcher.

Primary-source backgrounding reference checked on 2026-09-30:
https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls.
Prior evidence: ticket 06 interactive Claude and tickets 03–04 independent Codex.

## Active goal: integrate standalone providers

The User is away and explicitly authorised continuing repository implementation
and isolated validation of independently started providers under this
orchestrator. This is an active multi-turn goal; completing Claude alone does
not complete the standalone-provider objective. Preserve Pi's accepted adapter.
Prioritise standalone Claude Code, then Codex CLI/IDE/Desktop with separate
capability evidence. Managed-only delivery is not a substitute. No normal
profile mutations, deployment, publication, or new trust changes are authorised.
The User's current no-changeset preference remains in force for this work.

Complete the supported client integration and setup path where host capabilities
permit it; validate real Koed recall and automatic same-Conversation model use.
For an unavailable host mechanism, gather authoritative current evidence and
record the exact blocker without manufacturing a model-polling substitute.
Implementation tickets cannot pass solely with a limitation report. Continue
authorised independent work while any host requirement remains unresolved.

Ticket 23 exposed a canonical-input prerequisite for general adapters: durable
task acceptance must apply the supported Memory Answer schema defaults rather
than rely on every presentation adapter to do so. Bounded remediation ticket 25
normalizes at the existing owner, preserves eligibility and identity, and adds
regressions. It changes neither retrieval algorithms nor the execution owner.
Ticket 24 retains its original dependencies and also requires this correction.

Standalone Codex investigation ticket 23 passed bounded review: public native
queue transport delivered a real freshly authorized Memory Answer automatically
to its original interactive Conversation, and live revocation/expiry cases
suppressed delivery. This is a prototype capability, not a supported adapter.
Current public metadata and hooks do not supply trustworthy current native
receiver eligibility through switching, forking or exit. Ticket 24 remains
blocked on that host contract and ticket 22's authenticated isolated validation.
No dependency or implementation criterion has been removed. Blocking Codex
recall remains supported while these prerequisites are unresolved.

Blocked audit: the isolated Claude authentication and Codex current-receiver
prerequisites remain unresolved across three consecutive goal turns. Final
artifact reconciliation completed; all workers are terminal, and no owned live
probe or other executable ticket remains. Tickets 22 and 24 and the overall
standalone integration goal are incomplete. Further progress requires authorised
isolated Claude authentication or a demonstrated native host receiver capability;
the investigation's prototype success does not waive either requirement.

On 2026-10-01 the User chose manual Claude testing instead of credential
extraction. The explicit-global rerun supplied new real-memory evidence:
independent work preceded a native completion notification, and Claude
automatically cited the original Personal Memory note. Root verified the
specific stored transcript and incorporated the flow and search-scope guidance
into the integration documentation. This resumes bounded evidence integration;
it does not supply isolated authentication or waive ticket 22's setup and
lifecycle criteria. Codex's current-receiver prerequisite remains unresolved.

Resumed blocked audit: across three consecutive continuation turns, isolated
Claude authentication and the Codex current-receiver prerequisite remain
unavailable. The manual-evidence documentation integration passed independent
review, but supplies neither missing prerequisite. Final native recheck still
reports isolated Claude signed out with no operator token supplied. Installed
Codex remains 0.157.0 with the exact previously reviewed binary digest; no new
host capability is available from that installation. Workers are terminal and
no live probe can be awaited. Tickets 22 and 24 remain incomplete; the goal is
blocked pending isolated authentication or a demonstrated receiver capability.

Manual Claude lifecycle tests subsequently supplied timeout/stop/exit and active
tool-call evidence within their recorded limits. The active-tool-call result
also exposed inconsistent source attribution between structured answer and
returned evidence. The User authorised continuing this investigation and
remediation. Ticket 26 repairs selection at the existing answer-worker boundary,
without changing retrieval scope, execution ownership or client mechanisms.
Tickets 22 and 24 retain their outstanding prerequisites and criteria.

The User then completed native login directly in a dedicated isolated Claude
profile. Native auth-status verification succeeds outside the sandbox without
credential extraction/copy. Ticket 22 resumes with a bounded harness adaptation
to select that exact profile while preserving generated-only execution,
normal-profile isolation and the existing trust stop condition. Root review
precedes live launch; earlier isolated authentication failures remain historical
evidence, and Codex's current-receiver prerequisite is unchanged.

The resumed native authentication check succeeds. Interactive first-run
onboarding is still waiting for its additional native OAuth flow in VS Code.
Root review identified bounded harness cleanup and shared-project trace-routing
repairs, now delegated before any live launch. The generated-folder trust stop
and all original standalone acceptance criteria remain in force.

Further offline review corrected shared-project identity across generated
memory, semantic recall and CLI/relay cwd, and verifies canonical arguments
through the shipped schema. Nineteen offline tests and syntax checks pass.
Lifecycle classifiers require separate active-tool, idle, timeout, selected
stop and pending-exit evidence; their synthetic regressions establish no live
acceptance. The existing native onboarding process is live and waiting for its
additional OAuth step. No generated runtime or model experiment was launched;
standalone integration and the overall goal remain incomplete.

The User completed the additional browser approval and native interactive
onboarding advanced to the generated shared project's actual folder-trust
prompt. Informational notes were acknowledged and optional terminal changes
declined. Required action-time trust confirmation is pending; no trust choice
or live model/runtime launch has occurred. Earlier OAuth waits remain historical
evidence, not the current blocker.

Resumed blocked audit reached three consecutive turns with the generated-folder
trust gate unresolved. Current UI confirms the prompt is still unaccepted; all
delegated work is terminal and offline preparation is reviewed. No further
authorised integration work is executable while that required decision and
Codex's existing receiver prerequisite remain missing. The overall goal is
Blocked, not complete; its original standalone scope and criteria are retained.

The User subsequently confirmed the generated folder is trusted. Root verified
the actual native input prompt and exited the onboarding-only CLI, then accepted
the unchanged preparation guards/pins and authorised one isolated live idle
experiment. The trust prerequisite is resolved; earlier blocked status is
historical. Further cases depend on review of real evidence and cleanup, and
Codex's separate receiver prerequisite remains unchanged.

The first trusted idle attempt stopped before any model prompt because its
readiness detector missed native terminal carriage returns. Real generated
embedding/retrieval startup succeeded and owned cleanup completed. A normal
configuration hash difference is limited to a cached-feature timestamp in an
exact-hash comparison; fixture entries and Project settings are absent/unchanged,
but writer attribution is unproved. The failed attempt remains evidence, not
acceptance. Offline detector/tool-permission fixes and an all-fixture normal
profile write-protection assessment precede any second launch; no guard or
original criterion is waived.

The inherited normal-profile write policy and bounded cleanup remediation pass
root preparation review. Generated enforcement and scoped offline checks are
evidence of preparation only; no further live run has occurred. The latest
manual active-boundary attempt stayed synchronous and supplies no overlap
proof. A corrected temporary host launch setting was supplied for manual retry.
Isolated idle retry is eligible after the manual run is terminal; original
criteria, raw configuration checks and Codex receiver prerequisites remain.

Root authorised one guarded native-idle-2 retry after reviewing final cleanup
controls and confirming the previous manual session ended. Inherited policy
checks and pinned versions are recorded; the worker owns live handle 5599.
Latest manual evidence proves automatic idle delivery after useful work but
not active-tool arrival. No additional live case or criterion waiver is approved.

The guarded idle2 attempt failed before prompt acceptance and then required
scoped compensation for its database/auth cleanup after setuid ps was denied.
Failed before-hash/settings-restoration evidence remains explicitly missing.
Submission and independent cleanup safeguards are under final root review.
Manual c11f31ff now proves native completion enqueue during an outstanding
independent lint call and automatic Memory Answer consumption at the subsequent
tool boundary; lint itself failed and was reported without fixes. This does not
prove tool/model interruption or waive the original isolated requirements.

The third guarded idle experiment accepted the native prompt and automatically
consumed the correct real Memory Answer. Full isolated acceptance still failed:
Read-before-recall order, omitted unpredictable identifier, deadline exit, and
changed normal-profile hash. Owned cleanup completed normally. Exact retained
backup comparison limits the hash change to a cached-feature timestamp with
Project and MCP settings equal; writer attribution remains unknown and the raw
isolation guard is not waived. Bounded offline prompt remediation proceeds;
no fourth live launch is approved. Tickets 22 and 24 remain incomplete.

Root accepted the bounded offline test-prompt correction after independent syntax,
shipped-schema and marker-hiding checks. A quiet normal Claude profile is now
requested before another live run, to avoid concurrent activity invalidating
the raw hash guard. This does not attribute the historical writer or waive the
criterion. No other Claude session was terminated and no fourth launch occurred.

The User closed normal Claude sessions and a read-only process check found none.
One corrected guarded idle4 test exposed prompt submission before MCP discovery;
no recall ran. Owned cleanup completed. Root reviewed and reproduced the offline
matched-tool-list readiness gate. The normal cached-feature timestamp still
changed; normal Koed desktop/runtime processes remain and periodic Claude
availability probes are a plausible independent source, without writer proof.
A temporary Koed app quit is requested before retry. No guard waiver, normal
profile change, unrelated termination or further launch occurred.

After the User quit normal Koed, the corrected isolated idle6 scenario passed
independent root review: prompt submitted after tool discovery, recall first,
565ms background receipt, useful findings at5.15s, automatic decision identifier
consumption at17.29s, clean native exit0 and full cleanup. Raw normal hashes
remained unchanged. Earlier failed attempts retain their limits; this is idle
acceptance only. The next single authorised case is isolated timeout/detach.
Active, selected stop, pending exit and wider lifecycle review remain separate;
Codex's native receiver prerequisite is unchanged.

Isolated timeout/detach and explicit pending stop-and-exit scenarios now pass
root's scoped verifier review. Timeout teardown forced native exit and therefore
supplies no clean-exit proof; explicit pending-exit recorded actual exit0 before
durable completion. Both preserve durable work and suppress later answers, with
normal hashes unchanged and owned cleanup complete. Selected TaskStop missed
its pending window and is not accepted. A cancel-only bounded artificial pending
barrier is authorised for offline fixture preparation, not live use; it must
preserve the same real executor and exact identity bindings. Overall standalone
acceptance and Codex receiver prerequisites remain incomplete.

The corrected controlled selected-stop3 scenario passes root review: exact
TaskStop acknowledgment and full current invocation binding release the artificial
pending barrier, then the same real executor completes durable work without
cancellation or later native answer. Its artificial timing and interrupted
native teardown remain explicit. Raw hashes and full cleanup pass. Idle,
timeout/detach, explicit pending exit and controlled selected stop now have
accepted scoped evidence. Isolated active/expiry-denial/repeated lifecycle
review and Codex's receiver prerequisite remain open; no overall completion,
production rollout or further live case is claimed.

Root resumed bounded offline preparation for isolated active-work and
expiry/authorization-denial coverage under ticket22. The accepted idle, timeout,
pending-exit and controlled-stop evidence is reused within its recorded scope.
A fresh read-only process check found no normal Koed or Claude session; this is
a preflight observation, not permission to mutate profiles or launch another
case. Preparation must exercise Claude's actual ordinary blocking MCP path and
shared lifecycle, with meaningful independent work and fresh authority reads.
No live case is yet authorised, and Codex's receiver prerequisite remains.

Root accepts active-work preparation after source review, independent reproduction
of 19 offline tests and verification of all16 source/dependency pins. One
guarded native-active-1 run is authorised, conditional on fresh quiet-process,
profile/project and raw-hash preflight. It uses exactly one native foreground
read-only repository lint command; actual lint failure does not count as CI
success. Completion must enqueue during that bound command and be consumed
automatically after its result. No timing padding, model polling, normal profile
mutation or additional live case is authorised.

The authorised active1 launch stopped at fresh preflight: a normal VS Code
Claude process73528 was observed (extension native binary2.1.286). All16 pins
and generated profile/project guards passed, but no live fixture, handle, model
call or service launched. Root requested the smallest quiet-profile action; no
unrelated process was signaled. The isolated executable remains pinned2.1.267;
normal version observation is not substituted for tested evidence. Offline
authorization preparation remains eligible. This is a new preflight blocker,
not overall completion or a three-turn impasse.

The User closed the VS Code Claude session and root verified no remaining
Claude process. Normal Koed.app is running again; root requested temporary quit
before active1, without signaling unrelated processes. Root reviewed the
offline authorization design and authorised bounded harness-only preparation
for real post-completion token revocation and synthetic task expiry at the
ordinary shared lifecycle final-read boundary. No live authorization case,
production change or criterion waiver is included.

Root refreshed installed Codex binary metadata: the normal launcher resolves
to the0.159.3 release directory and hash4d210f7c5a18fd0386434df23b5bdbb8c0e7257d3e8a2b30b0769c8bbe99a878,
which differs from investigated0.157.0. A bounded primary-source receiver
contract refresh is delegated before treating the earlier blocker as current.
This permits no daemon/profile/queue interaction or production adapter change;
previous versioned findings and ticket24 dependencies remain intact.

The User quit normal Koed; root fresh exact process query is empty and all16
active preparation hashes remain unchanged. Root authorises the single active1
run after immediate guards. Current Codex worker CLI0.159.3 is independently
version/hash verified and explicitly approved for this run with unchanged
User-approvedgpt-5.6-luna and generated auth/catalog. Its changed hash is
recorded; previous0.157 acceptance is not generalized. Outer Claude remains
pinned2.1.267. Offline authorization drafts stop before wiring existingharness
files while this live case executes.

Native-active-1 is terminalexit1 and not accepted: native User input contains
only an exact227-byte suffix of the1249-byte launch prompt (1022 bytes absent).
The specified recall query was not received; actual native query asked TODO
blockers and an unrelatedls ran instead of approvedlint. Root independently
checked input truncation and cleanup: all normal hashes match, runtimeexit0,
groups absent, auth copies removed and isolatedsettings restored. No final
native exit-code evidence or activeoverlap is claimed. Root authorises only
offline concise activeprompt remediation and Bashpermission guard review;
no retry or authorization livecase is authorised.

Root accepts the bounded Codex 0.159.3 receiver-contract refresh after reading
the actual stored-thread admission and delayed-unload sources, reproducing 47
offline checks and verifying all 63 artifact hashes. Official source commit
01fc69f4026735edfdf6789820549727a4867b11 remains separate from the installed
binary hash; reproducible build identity is not claimed. The reviewed public
queue, hook and lifecycle contracts still do not establish a current native
receiver generation. Ticket24 keeps its prerequisite; older live evidence is
not generalized to the new binary. No daemon, queue or profile operation ran.

Root accepts the minimal active prompt and command-guard remediation after
reviewing actual hook enforcement, generated wiring and audit archival,
reproducing 22 offline tests and verifying all 21 source hashes. The active
prompt is 607 bytes; other accepted mode literals and shared transport remain
unchanged. One guarded native-active-2 attempt is authorised after immediate
quiet/profile/hash preflight, with explicitly approved Codex 0.159.3 worker.
Exact received prompt, command start, permitted hook audit, active enqueue and
post-yield answer remain required. No automatic retry or live authorization
case is included.

Native-active-2 received the exact prompt and canonical recall, but its lint
command stopped at the outside-working-directory permission prompt. Matching
completion enqueue during that prompt is not meaningful independent work. The
case is terminal, verifier exit1, native exit-9; root independently confirmed
resource cleanup, restored isolated settings and unchanged normal hashes.
Root authorises only offline preparation of an ephemeral exact repository
additional-directory option with inherited repository write denial except
the exact owned evidence directory. Existing native read restriction, command
hooks and normal-profile protections remain. Generated-only policy tests must
pass before a concrete scoped User authorization request; no live trust change
or retry is authorised.

Root accepts the concrete active-directory preparation after reading actual
policy and launcher/PTY access gates, independently reproducing 20 offline
tests (including 11 inherited generated-sentinel enforcement checks), and
verifying all 23 source hashes. Scoped User approval is requested for ephemeral
repository access in the next isolated active run. No live flag, directory
trust change or retry has occurred. Existing normal-profile protections and
canonical repository write denial remain required. Independent offline
authority-fence deadline/proof helper work is authorised while approval is
pending; the 23 reviewed active sources must stay frozen.

The User directly approved the prepared local access proposal (“You are
approved for the local write”). Root applies this to the pending isolated
active test: ephemeral exact repository directory access, with canonical
repository write denial except the exact owned evidence directory. Root fresh
process preflight is empty and all 23 active source hashes match. One guarded
native-active-3 run is authorised with existing hooks, directory read block,
profile protections and approved worker pins. Any new persistent trust prompt
remains a hard stop; no guard removal, other case or automatic retry is allowed.
Authority helper preparation is frozen and unwired while this case executes.

Root accepts the unwired authority helper checkpoint after reviewing the
actual deadline races and proof handling, reproducing eight Node and three
Python test groups, and verifying seven source/dependency/schema hashes plus
the active manifest digest. Underlying timed-out controls can still settle and
must be accounted for in future cleanup; live HTTP/native proof remains open.

Native-active-3 stopped before Claude launch because run.py omitted the approved
repository-access flag from its constructed child environment. The child guard
failed closed. Root independently checked clean resources, restored isolated
settings, removed auth copies and unchanged normal hashes. Empty late root
process observation remains explicit; no native recall, lint or synthesis ran.
Only offline scope-flag propagation remediation is authorised now. The User's
scoped approval persists for completing the same prepared local test; no guard
removal, extra trust change, other live case or automatic retry is permitted.

Root accepts active scope propagation remediation after inspecting the actual
child-environment helper and setup ordering, reproducing seven scoped tests
and verifying all 25 source hashes. Active approval is validated before setup
and reaches only the active child; other modes preserve their environment.
One guarded native-active-4 attempt is authorised under the existing scoped
User approval, with fresh preflight and unchanged protections. No new trust
acceptance, protection bypass, additional case or automatic retry is allowed.

Root accepts the bounded Codex 0.159.3 MCP Tasks source refresh after inspecting
the actual capability filter, initialization and awaited call-result branches,
reproducing 47 offline checks and verifying 49 artifact hashes. The inspected
native paths do not negotiate Tasks or establish an automatic deferred-result
consumer. This is a bounded source finding, not exhaustive absence or live
validation. Ticket24 retains its receiver prerequisite and dependencies.

Native-active-4 is terminal and rejected: the exact lint command exited before
ESLint because Corepack supplied pnpm11.5.1 rather than required11.1.2; Claude
also attempted an extra blocked Bash command and made a second memory request.
Original completion arrived after the failed command returned. Root verified
33 retained evidence hashes, cleanup assertions and current normal raw hashes.
Native exit was -9, despite parent fixture exit0. No active-work acceptance is
claimed. Only offline package-manager/prompt remediation proposal and authority
wiring design are authorised now; no retry, guard removal or live authority
case. The User's scoped local-access approval persists.

Root reviewed active4's offline remediation proposal and independently verified
all ten dependency/source pins. Cached pnpm11.1.2 may be invoked directly under
generated-only protected --version validation before exact active command and
prompt remediation. Nonactive prompts, shared transport and strict criteria
remain unchanged. No cache/profile write, download, policy bypass, MCP guard or
live retry is authorised. Fresh offline regressions and pins require review.

Root accepts active4 offline remediation after reviewing the exact command,
protected version-check policy/result and unchanged strict guard/verifier,
reproducing 20 scoped tests and verifying25 source/five dependency hashes plus
the retained version result. One guarded native-active-5 attempt is authorised
with immediate quiet/profile/project/raw-hash/source/dependency checks and the
existing scoped User approval. No new trust choice, protection removal, other
live case or automatic retry is authorised. Authority design remains offline;
shared sources stay frozen during this run.

Native-active-5 is terminal and rejected: Claude waited for completed memory
before independent work. Exactly one canonical recall and automatic unknown
marker consumption occurred, but TODO Read followed completion and lint never
ran. Actual native exit0 and cleanup/raw hashes pass; root independent process
observation was late/empty and is not live ancestry proof. Root reviewed the
negative report and retained hashes. Offline active-only prompt/exit-readiness
remediation is authorised: immediate work after background acknowledgement,
and marker plus matching Bash terminal result before active teardown. Strict
useful-work/overlap acceptance, nonactive teardown and deadlines remain; no
live retry is authorised. Authority operation helper preparation remains offline.

Root accepts the offline authority-operation tracker after inspecting admission,
late settlement, invalidation and bounded drain, independently reproducing all
nine tests and verifying four new artifact hashes. It is unwired and provides
no live authorization proof or cancellation guarantee. The enclosing fence
must explicitly invalidate it on timeout/failure; only callback-returned
promises are tracked. Authority wiring/live cases remain separately reviewed.

Root accepts active5 offline remediation after inspecting the conservative
exact-Bash terminal-result teardown helper and active-only driver branch,
reproducing27 tests and verifying27 source/five dependency hashes. Strict
acceptance and nonactive deadlines/teardown remain unchanged. One guarded
native-active-6 is authorised after fresh quiet/profile/project/raw-hash/source
and dependency preflight. No new trust, protection bypass, other live case or
automatic retry. Existing scoped User directory approval persists.

Native-active-6 is terminal and rejected: useful TODO findings occurred while
recall was pending, but the explicit external Node/cache executable paths
triggered native directory-read protection before ESLint. Completion during
that permission wait is not meaningful active work. No choice or signal was
issued. Native exit-9/parent exit1; root verified34 evidence hashes, cleanup,
current normal raw hashes and exact owned PID absence. Original live root
ancestry remains unchanged. Root authorises only offline exact cd-to-repository
and pnpm command remediation/protected version check with no new trust or
policy bypass. Native permission processing of this alternative remains unproved.
No live retry is authorised; criteria and dependencies remain unchanged.

Root authorises offline authority wiring in a new same-depth sibling
22-standalone-claude-authority harness, preserving all original22 sources and
evidence during active remediation. Only source copies and generated pure
regressions are permitted; no auth/profile/evidence-data copy, production edit
or native/API/DB/model/service launch. Reviewed final-read authority design and
accepted fence/proof/operation helpers govern the wiring. Source/dependency
pins and independent root review precede separately authorised live cases.
Incomplete wiring must remain explicit rather than counted as native proof.

Root accepts active6 offline command remediation after reviewing the exact
compound command, Corepack cwd/cache assumptions and protected version result,
reproducing27 tests and verifying27 source/eight dependency hashes. Version
11.1.2 was observed without network or writes outside the generated root. One
guarded native-active-7 is authorised after fresh quiet/profile/project/raw
hash/source/dependency checks. No new trust choice, policy bypass, extra live
case or automatic retry; original active criteria and User scope remain.

Native-active-7 is terminal and rejected: exact command failed before ESLint
with GVM_ROOT-not-set; extra Bash true was blocked. Completion followed the
failed command, so no active overlap. After fresh exact identity, only the
owned wrapper received authorised SIGINT. Native final exit status is
unverified; resource cleanup and normal hashes pass. Root verified35 evidence
hashes and current raw hashes. Offline version-qualified Corepack command
remediation is authorised, without cd, external cache arguments, GVM/profile
changes, broader env or version-policy bypass. Its native shell behavior
remains unproved; no further live case or automatic retry is authorised.

Root accepts active7 offline version-qualified command remediation after
reviewing the exact command and protected result, reproducing27 tests and
verifying27 source/nine dependency hashes plus the result digest. One guarded
native-active-8 is authorised after fresh immediate preflight, with unchanged
guards, exact command and strict criteria. No new trust/protection bypass,
other case or automatic retry. Native GVM/permission behavior remains unproved.

Root source review found authority sibling lookup assumed a task.request field
absent from maintained MemoryAnswerTaskRecord. Worker is correcting binding to
the actual single claimed executor input/cwd plus exact DB task/invocation/owner,
without another claim/decryption API. Regression and documented limits are
required before acceptance or any live authority launch.

Native-active-8 is terminal with scoped actual ESLint overlap and automatic
answer after tool yield, but remains unaccepted: original parser ignored full
queue-remove notification content, driver consumedMarkerfalse/nativeexit-9.
Read preceded background receipt by150ms; canonical recall remained first.
Root inspected native queue enqueue/remove (same full content, absorbed_mid_turn)
and verified notification result equals both original wire structuredContent
and parsed sole text JSON. Original active trace lacks relay/PID metadata, so
that stronger provenance is not retrospectively claimed. Cleanup/current raw
hashes and retained evidence pins pass. Only offline active queue-format proof,
owned relay metadata and driver/verifier remediation are authorised; originals
and strict nativeexit0/meaningfulwork/no-extra-call criteria remain intact.

Authority sibling review reproduced10 Node and6 Python tests and verified51
copied/modified,7 new and10 shipped dependency hashes. Lookup correction to
real claimed executor input/cwd is accepted offline. Changes required before
live: first admitted completed GET must also join actual initial HTTP200 trace,
not only synthetic get-end status. Worker is adding interval/ordinal joining
and missing/foreign/wrong-status regressions. No authority launch authorised.

Root accepts the active queue-remove parser preparation after reviewing exact
full response equality, receipt/native-session/owned direct-parent relay joins,
chronology and unchanged nonactive path, reproducing32 tests and verifying30
source/nine dependency hashes. Exact observed $ eslint . header support retains
script-start meaning and rejects pre-execution errors. One guarded native-active-9
is authorised after immediate fresh preflight. Strict clean nativeexit0, real
work overlap, one recall and automatic answer criteria remain; no new trust,
protection bypass, other case or automatic retry.

Root accepts authority sibling offline preparation after inspecting ordinary
client composition, owner/control/status paths, bounded drain and launch gates,
reproducing10 Node tests and updated8 Python tests and verifying58 source
copies/new sources and10 dependencies. Initial real HTTP200 interval joining
now rejects missing/foreign/wrong-status/overlapping evidence. This is not live
HTTP/native validation. Neither authority live case is authorised yet; the
shared isolated native profile must remain exclusive to active9 while it runs.

Root accepts native-active-9 within actual foreground-tool completion scope
after reproducing strict verifier exit0, verifying37 retained evidence hashes,
current raw normal hashes and independently observing all13 recorded owned
PIDs absent, including the detached lint shell/children. Receipt574ms/findings
2.53s/lint54.13s, enqueue9.524s into lint, automatic answer afteryield and actual
nativeexit0 pass. Full notification/wire result and direct native relay/session
bindings agree with root live ancestry. Lint failed; Read issuance165ms before
acknowledgement is retained rather than claiming literal acknowledgement-first
ordering. Canonical recall was first and useful findings occurred while pending.
No generation interruption, restart recovery or whole-ticket completion is
claimed. Authority/expiry and repeated lifecycle cases remain eligible.

With active9 fully cleaned and its profile restored, root authorises ONE
guarded sibling native-revoke-1 case under accepted58-source/10-dependency
preparation and existing approved native profile/worker pins. Fresh quiet normal
process/profile/project/raw-hash/source/dependency checks remain mandatory.
Only the generated token may be revoked after the exact completed-task/current
nonce proof; actual initial HTTP200 then fresh HTTP401/typed ordinary401 and
marker suppression/native automatic failure/clean exit/cleanup are required.
No expiry case, new trust/protection choice, source edit, retry or normal-profile
mutation is authorised. The isolated profile is exclusive to this case.

Root accepts native-revoke-1 retrospectively after independently reproducing
ten corrected timestamp/classifier tests and strict offline verification with
only the validation output redirected outside the frozen case and writes inside
it denied. All96 frozen hashes remain unchanged, including original KeyError
failure and executed source pins. Runtime ISO at/native timestamp/numeric atMs
are now parsed explicitly; ambiguous/malformed fields fail. The live case had
actual initialHTTP200 read46, one generated-token revoke behind a current
completed-read nonce/full-key fence, freshHTTP401 read47/ordinary runtime401,
automatic same-Conversation failure, no presented marker, ten-second observation
and nativeexit0. This is retrospective parser repair, no behavioral rerun or
general natural timing claim. Original cleanup/current normal hashes and root
absence of eight recorded owned PIDs pass. Expiry and repeated lifecycle remain
open. Root authorises exactly one guarded native-expire-1 after fresh preflight,
using the exclusive existing isolated profile and unchanged runtime/worker pins.
Only the exact generated completed task expires_at may change; valid-token
actualHTTP200 expired record/typed410, suppression/automatic failure/clean exit
and full cleanup are required. HTTP404, new trust/protection choice, normal
profile mutation, source edits, other cases and automatic retry are not allowed.

Root accepts native-expire-1 after strict verifier reproduction exit0 and
independent95-artifact/current-source hash review. Receipt576ms, useful TODO
findings8.026s. Exact first completed read40 actualHTTP200 was fenced only after
real execution; current full-key/nonce proof changed only generated expires_at.
Fresh read41 actualHTTP200 retained the expired completed record with a valid
token; ordinary runtime410 and MCP error reached the same native Conversation
automatically. No marker was presented; ten-second observation/nativeexit0,
one completed noncancelled executor, bounded drained operations and full cleanup
pass. Root independently observed eleven recorded PIDs absent/current three
normal raw hashes unchanged; no root positive live ancestry was captured.
Artificial terminal-read fence and timestamp correction are explicit; natural
retention/restart recovery/native MCP Tasks are not claimed. Handle46035 exit0,
reportSHA004a377b8b6f95af86c22e0407d701141fed1fdb6409a820a449a1656eedb9dc.
No additional live case authorised. Remaining ticket22 criterion reconciliation
is an offline review of accepted evidence, including repeated setup/removal.

Ticket22 final review Pass / Done: all five actual criteria pass across accepted
idle6/active9/timeout1/exit1/selected-stop3/revoke1/expiry1. Independent final
review accepts supported documentation, accurate scoped classifications and
reuse of ticket21 preservation tests. Root verified its five implementation
hashes still match accepted review; targeted documentation Prettier and
git diff --check pass. No additional repeated native call criterion is introduced.
Repeated calls in one Conversation, notification replay and reopening delivery
remain untested, while shared adapter deduplication/recovery evidence retains
its earlier scope. Documentation hashes async167b70803c18d6f3a175f94a8d51de224cd3535cabd681dbd6027d70c08bdd23
and Claude199b469b523430e098c9200cf2e2041f4fc39d8ad2fd03e786524b1d8e7fb52e
match independent review. No owned live operation remains. User no-changeset
preference persists. Ticket24 remains Blocked on ticket23's unresolved supported
current-native-receiver contract; completion of22 does not supply that capability.
Overall standalone integration goal remains incomplete.

2026-10-01 final standalone reconciliation review Pass: independent reviewer
verified28 current checkpoint hashes, all21 unchanged ticket20 package files
and cited evidence paths. PLAN header, TODO backlog and tickets23/24/26 latest
updates now reflect completed Claude validation and the remaining Codex receiver
prerequisite. StatusSHA9be47061ee7d764efdc68f0063f95e8277f34a6ca46c4e1ee65cf2553991bb93,
backlogSHAc46368c08b5d129dec34c501cd3cd69fde921b2d08ebdbbb0b965544c7c17401
and pinsSHAfca3c5aa89cdb138c76e5cdb0f69c1beb7fc9c89de174bc7ee13d1a03dfe8716.
Targeted documentation formatting and git diff --check pass. No production
source or live service changed in this reconciliation. Previous goal turn
made progress by completing Claude22; this turn made progress by reconciling
current implementation/evidence/backlog and completing independent audit.
All workers and live operations are terminal. No remaining approved ticket is
executable:24 requires a supported current-native-receiver contract or native
MCP Tasks completion consumer that reviewed installed0.159.3 paths do not supply.
Overall goal remains active/incomplete, with this residual blocker recorded
for the next bounded audit. No dependency waiver, guessed adapter, managed
substitute, changeset, publication or deployment was introduced.

2026-10-01 residual blocked audit: the same Codex current-native-receiver/MCP
Tasks consumer prerequisite remains unresolved across the Claude completion,
final standalone reconciliation and current continuation turns. The prior turn
made progress by completing the independent current-state audit. This turn's
recheck yields no new capability: installed0.159.3 binary hash is unchanged,
ticket24 criteria/dependencies remain unmet, all other approved integration
tickets are Done, workers are terminal and the last live cases are cleaned.
There is no verified live operation to wait for and no remaining authorised
ticket executable without the external host capability or a separately approved
plan change. Mark the persistent goal Blocked, not Complete. Preserve completed
Pi/Claude work, unchanged criteria and current no-changeset preference.

### Codex follow-up after local Pi/Claude commit

Local commit `2eb7362541218750b77c0921c4a32c2383094573` contains the39 reviewed
Pi/Claude/shared implementation files. No push/PR/changeset was made.
Codex0.160.0 source-only refresh does not resolve native Tasks or external queue
receiver requirements. A synchronous native Stop-hook candidate instead keeps
the originating turn active through an outside-model completion wait and
requests attributed continuation in that turn. It is not idle wake-up.
Its cancellation fence is unproven; the source's100ms interruption grace calls
for separate context-append and model-sampling assertions.
An inactive generated synthetic fixture was prepared and checked offline.
New isolated hook trust approval is pending; normal profiles remain excluded.
No acceptance criterion or dependency has been removed. Candidate qualification
is distinct from ticket24 product integration acceptance and full lifecycle
validation. See the latest ticket23 follow-up and new source reports.

### Native Stop qualification outcome, 2026-10-02

The User approved the exact synthetic isolated hook. Native completion works in
the original active turn after independent work. Confirmed cancellation nevertheless
admits late HookPrompt context to the interrupted turn; no later model answer
was observed. This candidate fails the required cancellation fence. Relevant
0.160.0 source blocks are unchanged; that finding is source-only. Root acceptance
review and local upstream issue draft are retained under ticket23 evidence.
All owned operations are terminal, credential copies removed, normal profiles
unchanged and local commit2eb73625 retained. No product integration or external
publication followed. Ticket24 remains Blocked; overall objective incomplete.
No criterion or dependency is waived. The next dependent implementation requires
a corrected native cancellation path or another supported receiver capability.

### User-approved temporary cancellation exception, 2026-10-02

The User explicitly accepts the observed late Stop HookPrompt admission into the
interrupted original Codex turn as a documented upstream limitation. This finding
no longer blocks implementing the qualified original-turn route. Record it in
implementation documentation and TODO, and revalidate after an upstream fix.
Only this exception changes acceptance; all other ownership, authorization,
expiry, duplicate, bounded lifecycle and mode-specific evidence requirements
remain. Preserve the generic execution/presentation boundary and existing task
runtime. No native MCP Tasks or idle wake-up claim follows. Ticket24 is In progress.

### User-approved Codex recovery limits, 2026-10-07

The User accepts the reviewed recovery limits for the current Codex adapter.
Automatic delivery belongs to the original eligible backend turn. An intentional
CLI disconnection can leave that turn active. Reopening its completed history
does not establish pending-result recovery.

Guaranteed pending-result delivery after backend or Conversation loss, or across
Local AI Runtime restart, remains unsupported. Idle wake and exited-session
replay also remain unsupported. Keep stronger recovery as future work in TODO.
An original observation can survive a fast restart without a failed read. This
does not establish a restart-delivery guarantee.

This approval closes only the outstanding Codex receiver-recovery criterion.
Pi recovery, durable execution, authorization, expiry, ownership, deduplication
and cancellation requirements retain their existing scope. The accepted narrow
late-HookPrompt exception remains unchanged. Full contributor bootstrap, current
checks, documentation and final independent acceptance still must pass.
