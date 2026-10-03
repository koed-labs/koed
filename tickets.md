# MCP Tasks investigation tickets

Source: [MCP Tasks investigation plan](PLAN.md).\
Date: 2026-09-30\
Review state: Final research report accepted after independent review. Tickets 01–12 and 14 Done within documented limits; ticket 13 safety criteria remain Blocked. Production adoption deferred. User-approved shared-boundary prototype 15 and real-worker validation 16 are Done within isolated limits.

This file contains investigation tickets, not a production rollout commitment.
Each ticket delivers a repeatable experiment or an evidence-backed decision.
Keep MCP Tasks as the common foundation and distinguish native support from client bridges.

Use synthetic queries and results for the first experiments. Preserve Personal
Memory authorization, encrypted task state, Local AI Runtime ownership, and
AI Client Answer Synthesis. Keep Team Workspace execution outside local Personal
task acceptance. Follow ADR 0043's maintained-SDK requirement.

`ready-for-agent` is the triage label. A ticket becomes eligible for execution
only when its blockers are resolved. A blocker can resolve with a documented
negative finding, provided that the dependent ticket can still perform its experiment.
If a required SDK capability is absent, report dependent experiments as blocked.
Do not mark an unavailable client mode as passed.

## Approved breakdown

1. **Prove a maintained MCP Tasks SDK route.** Blocked by: None. Delivers a reference task round trip or a precise SDK blocker.
2. **Build the shared task lifecycle probe.** Blocked by: 01. Delivers repeatable protocol and lifecycle experiments.
3. **Measure Codex CLI task continuation.** Blocked by: 02. Delivers a sourced native-support result for the CLI.
4. **Measure Codex Desktop and IDE task continuation.** Blocked by: 02. Delivers separate evidence for Desktop and the IDE extension.
5. **Prove delivery in Koed-managed Codex.** Blocked by: 02. Delivers a task-to-agent experiment for the owned app-server.
6. **Measure Claude Code interactive task continuation.** Blocked by: 02. Delivers a comparison of native Tasks and client background execution.
7. **Prove delivery in Koed-managed Claude.** Blocked by: 02. Delivers evidence for the actual Agent SDK execution mode.
8. **Prove delivery through the Pi extension.** Blocked by: 02. Delivers a standard task result in the originating Pi Conversation.
9. **Measure Koed-managed Pi RPC continuation.** Blocked by: 02. Delivers separate evidence for RPC execution and session lifetime.
10. **Prove one MCP task through Koed's durable runtime.** Blocked by: 02. Delivers an end-to-end Personal Memory Answer adapter experiment.
11. **Prove cancellation and terminal outcomes.** Blocked by: 10. Delivers correct failure, cancellation, and expiration behavior.
12. **Prove recovery without duplicate history.** Blocked by: 10. Delivers disconnect and restart recovery evidence.
13. **Prove task isolation and result attribution.** Blocked by: 10. Delivers owner isolation and concurrent task identity evidence.
14. **Publish the feasibility decision.** Blocked by: 03–09 and 11–13. Delivers the client matrix, latency comparison, and adoption recommendation.

## 01: Prove a maintained MCP Tasks SDK route

**What to build:** A reference-client experiment that accepts one standard task
and receives its completed result through a maintained SDK extension. If the SDK
cannot provide this path, deliver a sourced adoption blocker.

**Blocked by:** None (can start immediately).

**Triage:** ready-for-agent

**Status:** Done

**Owner:** sdk_route; acceptance review: orchestrator.\
**Attempt:** 1.\
**Latest update:** 2026-09-30 — Accepted maintained SDK route after independent package/source and roundtrip review. TypeScript server support remains an adoption dependency.

- [x] Record the exact Tasks extension revision and compatible protocol revision.
- [x] Identify the maintained server and client packages, versions, and released APIs.
- [x] Compare that route with Koed's pinned SDK and protocol dependencies.
- [x] Demonstrate task acceptance and result retrieval with a recognizable synthetic result.
- [x] Save the capability exchange, task response, and completed-result trace.
- [x] Describe standard polling and notification behavior without mixing older task proposals.
- [x] Record whether SDK task storage can delegate to Koed's existing durable state.
- [x] If the path is unavailable, identify the dependency blocker and viable upgrade options without creating a custom dispatcher.

**Review verdict:** Pass. Orchestrator inspected the current contract, package/release sources and all eight criteria; verified 52 artifact hashes and 14 NuGet archive hashes; independently reproduced both the pinned TypeScript rejection and the maintained .NET task roundtrip in fresh temporary projects. Independent wire validation passed one task receipt and seven status/result responses. Source-supported storage delegation remains a ticket 10 input, not integration proof.

**Evidence:** [SDK report](docs/investigations/mcp-tasks/01-sdk-route/REPORT.md), `REPORT.md` SHA256 `5266b45a0b381542939be2c8a398005433996e12f2723a8d27380efd9b3b89a2`; [independent review traces](docs/investigations/mcp-tasks/review/). Revision unchanged from baseline. Maintained probe route: .NET Tasks 2.2.0 with finite TTL, protocol 2026-07-28.

## 02: Build the shared task lifecycle probe

**What to build:** A controlled task server and reference-client runner that make
client behavior observable from acceptance through completion. Reuse this probe
for each AI Client experiment.

**Blocked by:** 01: Prove a maintained MCP Tasks SDK route.

**Triage:** ready-for-agent

**Status:** Done

**Owner:** sdk_route; acceptance review: orchestrator.\
**Attempt:** 1.\
**Latest update:** 2026-09-30 — Accepted schema-valid controlled polling probe after fresh Release and stdio reproduction. Released SDK push subscriptions remain unavailable.

- [x] Use the selected SDK contract and synthetic Memory Answer inputs and outputs.
- [x] Demonstrate controlled completion, failure, cancellation, and expiration.
- [x] Demonstrate the defined response when the caller does not support Tasks.
- [x] Record task identities, capability declarations, lifecycle messages, and timestamps.
- [x] Exercise notification delivery and the standard status-check path separately.
- [x] Provide short delays and delays that cross client background thresholds.
- [x] Provide repeatable instructions that do not alter normal Koed or AI Client configuration.
- [x] Make native Tasks distinguishable from client background execution of an ordinary MCP call.

**Review verdict:** Pass for the polling probe; positive task push remains blocked by the released SDK. Fresh independent Release build, nine-case suite, exact schema validation, actual current/legacy stdio reproduction and 28 artifact hashes passed. A first verifier invocation required creating its output directory; rerun passed. The unchanged callback long-run evidence is scoped to its pre-final build. No model continuation claim.

**Evidence:** `docs/investigations/mcp-tasks/02-lifecycle-probe/REPORT.md` SHA256 `7a2bc0881bc1bec73149f70642f36fb516524c1d7b3dffb63bc18a13268097c4`; independent outputs in `docs/investigations/mcp-tasks/review/02/`. No active operations.

## 03: Measure Codex CLI task continuation

**What to build:** A Codex CLI experiment that shows whether the agent can start
a standard task, perform independent work, and consume its result later.

**Blocked by:** 02: Build the shared task lifecycle probe.

**Triage:** ready-for-agent

**Status:** Done

**Owner:** sdk_route; review: orchestrator.\
**Attempt:** 1.\
**Latest update:** 2026-09-30 — Accepted live CLI native-negative finding and ordinary fallback. No detached continuation was observed during the 65-second call.

- [x] Record the CLI version, model, transport, relevant configuration, and negotiated capabilities.
- [x] Determine whether the CLI declares Tasks support and accepts a task response.
- [x] Show whether independent agent work occurs before task completion.
- [x] Show whether the completed result reaches the model without model polling.
- [x] Record completion during an active turn and after the turn ends.
- [x] Record how the host attributes the result to its task and original tool call.
- [x] Distinguish Codex host support from Responses API async function calling.
- [x] If native support fails, assess background-hook delivery as a separate candidate and document its limits.
- [x] Classify the outcome with traces, or record the exact blocker and missing evidence.

**Review verdict:** Pass for negative native finding and ordinary fallback. Reviewed actual short/65s traces and55 hashes; no Tasks opt-in on negotiated2025-06-18. Hook delivery is source-only; native idle/result attribution stays unavailable.

**Evidence:** `docs/investigations/mcp-tasks/03-codex-cli/REPORT.md`, SHA256 `f0b8ef560a5178dc546acd5236c75ed22213cc27e1e3c009fb2434aeb875a2c7`. No active operations.

## 04: Measure Codex Desktop and IDE task continuation

**What to build:** Repeat the task-to-agent experiment in Codex Desktop and the
IDE extension. Establish each surface's behavior without inheriting the CLI result.

**Blocked by:** 02: Build the shared task lifecycle probe.

**Triage:** ready-for-agent

**Status:** Done

**Owner:** orchestrator. **Attempt:** 1.

**Latest update:** 2026-09-30 — Accepted separate classifications: Desktop unavailable under the permitted untested outcome, IDE live ordinary fallback. Temporary folder trust removed.

**Evidence:** `docs/investigations/mcp-tasks/04-codex-surfaces/REPORT.md` and `surface-observations.json`. No CLI equivalence claim; no model experiment. Desktop unavailable allowance retained; missing IDE experiment prevents full acceptance.

- [x] Record each surface's version, owning runtime, model, transport, and configuration.
- [x] Capture Tasks negotiation and task-response handling separately for each surface.
- [x] Show independent work before completion and model use of the completed result.
- [x] Record active-turn and idle completion behavior for each surface.
- [x] Record result presentation, tool attribution, and relevant session-lifetime restrictions.
- [x] Identify any shared runtime behavior with evidence rather than assuming equivalence.
- [x] If a surface is unavailable, mark it untested and state how to finish the experiment.
- [x] Produce separate capability classifications for Desktop and the IDE extension.

**Review verdict:** Pass for separate surface classifications: Desktop untested under explicit unavailable-surface criterion; IDE live native-negative / ordinary fallback on its independent0.155.0-alpha.16.3 runtime. Project-only isolation resolved after User-approved temporarytrust; cleanup verified removal of that trust, original model restoration and no owned probe process. Ordinary Promise.all batch is not detached standardtask or speedup evidence.

**Evidence:** `docs/investigations/mcp-tasks/04-codex-surfaces/REPORT.md`, `ide-server.jsonl`, synthetic session excerpts/digest and cleanup. Earlier preflight retained.

## 05: Prove delivery in Koed-managed Codex

**What to build:** An experiment in a Koed-owned Codex app-server Conversation
that delivers a standard task's result while preserving useful agent continuation.
If native delivery fails, assess the smallest app-server bridge.

**Blocked by:** 02: Build the shared task lifecycle probe.

**Triage:** ready-for-agent

**Status:** Done

**Owner:** claude_interactive (persistent remediation); orchestrator (initial component probes and acceptance). **Attempt:** 2.

**Latest update:** 2026-09-30 — Accepted actual persistent Conversation investigation after correcting initial one-shot coverage.

- [x] Run the probe through the actual managed Conversation mode and record its capabilities.
- [x] Show whether the agent continues and receives a native task result.
- [x] If a bridge is required, demonstrate one completed result through the documented app-server delivery API.
- [x] Preserve the originating Conversation, task, query, and invocation identity in the experiment.
- [x] Record active-turn, idle, interruption, and resume behavior.
- [x] Distinguish standalone tool output or added context from a result matched to the original tool call.
- [x] State whether the route requires new host code or an upstream Codex capability.
- [x] Produce a reproducible trace and classify native support and bridge support separately.

**Review verdict:** Pass for native-negative and scoped persistent bridge. Root inspected actual class/client and wire traces, source/fixture boundaries and reran the validator with 32 hashes. MCP 2025-06-18 lacks Tasks negotiation. Actual close/resume keeps the thread and rollout while the external SDK task remains alive. Active useful arithmetic precedes completion; idle and interrupted delivery starts a new turn. Standalone FunctionCallOutput is explicit, not a matched original MCP call. Task-server durable recovery and authorization remain tickets 12/13.

**Evidence:** `docs/investigations/mcp-tasks/05-managed-codex/persistent/REPORT.md`, digest `259309f80e7478b0fdd10a6b51b712ff158d7864d391bf75cf876dd0cd358a71`; initial parent report retained within its narrower scope.

## 06: Measure Claude Code interactive task continuation

**What to build:** A Claude Code interactive experiment that separates native
MCP Tasks support from automatic background execution of ordinary MCP calls.

**Blocked by:** 02: Build the shared task lifecycle probe.

**Triage:** ready-for-agent

**Status:** Done

**Owner:** claude_interactive; review: orchestrator.\
**Attempt:** 1.\
**Latest update:** 2026-09-30 — Accepted live interactive ordinary background continuation. Native Tasks remains unavailable on the tested negotiation paths.

- [x] Record the Claude Code version, model, transport, and relevant background-task configuration.
- [x] Capture native Tasks negotiation, acceptance, continuation, and completed-result delivery.
- [x] Run an ordinary delayed MCP call as the comparison case.
- [x] Record the default background delay and behavior with a short configured delay.
- [x] Show whether the result automatically reaches the model while active and while idle.
- [x] Record tool timeouts, cancellation behavior, and session-exit limitations.
- [x] Assess subagent restrictions separately from main-Conversation behavior.
- [x] Classify native Tasks and client background execution separately, with evidence for each claim.

**Review verdict:** Pass for interactive ordinary backgrounding with native limitation. Root inspected actual PTY/session/wire evidence, verified47 hashes and reran observation validator. Default120048ms and configured533ms, independent work before completion, active/idle automatic delivery, timeout/cancel/stop-exit verified. Forcedcurrent native discovery blocker preserved; subagent restrictions source-only.

**Evidence:** `docs/investigations/mcp-tasks/06-claude-interactive/REPORT.md`, SHA256 `5a89b1a9fdf2c09ce2adcd4e06e592d0f61fc85dbb154c07a1e56a44aca2332c`. No active operations.

## 07: Prove delivery in Koed-managed Claude

**What to build:** A task-to-agent experiment using Koed's actual Claude Agent
SDK execution mode. Determine whether that mode supports continuation and delivery.

**Blocked by:** 02: Build the shared task lifecycle probe.

**Triage:** ready-for-agent

**Status:** Done

**Owner:** claude_interactive; review: orchestrator. **Attempt:** 1.

**Latest update:** 2026-09-30 — Accepted actual tool-free synthesis runner finding and separate altered streaming-input bridge evidence. No native Tasks or durable recovery claim.

- [x] Record the SDK and underlying Claude Code versions, model, input mode, and process lifetime.
- [x] Capture the Tasks capability exchange and the response to a task-backed recall call.
- [x] Show whether the model continues before completion and receives the result automatically.
- [x] Test relevant non-interactive background-task configuration separately from native Tasks support.
- [x] Record what happens when the first result message arrives while a task remains pending.
- [x] Record process teardown, idle completion, and resume limitations.
- [x] If a persistent-session bridge is required, demonstrate a bounded proof or identify the exact missing capability.
- [x] Produce a classification specific to the managed SDK mode rather than inheriting the interactive result.

**Review verdict:** Pass for mode-specific negative and scoped ordinary streaming proof. Root reviewed actual runner/options,19 artifact hashes, native negotiation absence and reran verifier. Actual tool-free mode is blocked; changed streaming input delivers ordinary background completion after useful work. No standard Tasks or durable recovery claimed.

**Evidence:** `docs/investigations/mcp-tasks/07-managed-claude/REPORT.md`, SHA256 `f10666f122fa34b2dd49ad0dd43a9b5b5659e8db45f0ba1a529e76f9f88612f6`. No active operations.

## 08: Prove delivery through the Pi extension

**What to build:** A Pi experiment that accepts a standard Memory Answer task,
returns control to the agent, and delivers the completed result through the
originating Conversation. Assess the installed MCP client and Koed extension separately.

**Blocked by:** 02: Build the shared task lifecycle probe.

**Triage:** ready-for-agent

**Status:** Done

**Owner:** pi_extension; review: orchestrator.\
**Attempt:** 1.\
**Latest update:** 2026-09-30 — Accepted scoped installed Pi extension bridge with useful overlap and delivery identity checks. Durable recovery remains a separate experiment.

- [x] Record the Pi version, model, extension version, and available MCP Tasks support.
- [x] Determine whether the installed MCP client natively consumes the task contract.
- [x] If adaptation is required, demonstrate task consumption through the selected maintained SDK route.
- [x] Demonstrate result delivery through the extension's custom-message API after useful independent work.
- [x] Compare active-turn, follow-up, next-user-turn, and idle-triggered delivery where supported.
- [x] Keep a custom context message distinct from a second result for an already completed tool call.
- [x] Record behavior after session switch, fork, extension reload, and shutdown.
- [x] Document the task identity and recovery state the extension must retain.
- [x] Classify native support and extension bridge feasibility separately.

**Review verdict:** Pass for scoped installed AgentSession extension bridge. Root reviewed six live comparisons, verified67 hashes, independently asserted stable task/Conversation/invocation, zero model polls and work between receipt/completion. Host lifecycle fixtures remain distinct from model/session and durable recovery; terminal renderer untested.

**Evidence:** `docs/investigations/mcp-tasks/08-pi-extension/REPORT.md`, SHA256 `20a55ffde7193db5ba8705db4041909e91ef593f9fc5580476e54e7d95fbe38c`. No active operations.

## 09: Measure Koed-managed Pi RPC continuation

**What to build:** A Pi RPC experiment that establishes whether a managed agent
can continue while a standard task runs and receive its completed result through RPC.

**Blocked by:** 02: Build the shared task lifecycle probe.

**Triage:** ready-for-agent

**Status:** Done

**Owner:** pi_extension; review: orchestrator. **Attempt:** 1.

**Latest update:** 2026-09-30 — Accepted both actual persistent host observations and separately scoped standard-task RPC bridge evidence.

- [x] Record the Pi version, RPC runner behavior, model, and loaded extensions.
- [x] Capture native negotiation or demonstrate the scoped SDK adaptation required for task consumption.
- [x] Show agent activity before completion and subsequent use of the synthetic result.
- [x] Record RPC message ordering and the originating Conversation and task identities.
- [x] Test completion while active and after the agent settles.
- [x] Record process exit, interruption, and resume behavior for pending tasks.
- [x] Identify any difference from interactive extension delivery with a trace.
- [x] Produce an RPC-specific classification and list any required host changes.

**Review verdict:** Pass within explicit mode boundaries. Root inspected real class/host traces, source manifests, 47 original plus 39 persistent artifact hashes and reran the attribution checker. Existing persistent host waits for ordinary recall, keeps its process after normal settlement and resumes/forks completed history. Pending close/cancel results do not reach resumed history; cancel command/close race is an observed limitation. Earlier changed RPC bridge proves useful active/idle overlap but does not prove default-host delivery or durable recovery.

**Evidence:** `docs/investigations/mcp-tasks/09-managed-pi-rpc/REPORT.md` and latest `persistent/REPORT.md` (digest `f7eeda4e84cc7da5e4534cc52d43c6b6dc3df73c2ae9cb6bae34c04b041b01c7`).

## 10: Prove one MCP task through Koed's durable runtime

**What to build:** An isolated adapter experiment that accepts a standard MCP
Memory Answer task, executes it through Koed's durable Personal runtime, and
returns the completed result to the reference SDK client.

**Blocked by:** 02: Build the shared task lifecycle probe.

**Triage:** ready-for-agent

**Status:** Done

**Owner:** sdk_route; review: orchestrator. **Attempt:** 1.

**Latest update:** Accepted isolated durable adapter after fresh root reproduction; no production adoption authorized.

- [x] Map standard task identity and lifecycle states onto existing durable task records.
- [x] Accept one synthetic request through the MCP adapter without waiting for execution completion.
- [x] Execute that request through the existing Local AI Runtime ownership path.
- [x] Retrieve the final result through standard SDK task APIs.
- [x] Demonstrate the chosen notification or host-status-check path without model polling.
- [x] Preserve result-detail modes, Evidence Bundle structure, application-error results, and final Memory Question identity.
- [x] Preserve the shared execution limit and avoid a competing task queue or storage owner.
- [x] Record the behavior for callers without Tasks support.
- [x] Keep Team Workspace requests outside local Personal task acceptance.
- [x] Record any required prefactoring as a narrowly scoped follow-up rather than a broad rewrite.

**Review verdict:** Pass for creation/completion and delegated ownership. Root inspected adapter/runtime source and reproduced the full orchestration with fresh PostgreSQL, protected temporary credentials and a fresh .NET project. Seven schema-valid receipts, 71 status results, four preserved bodies, seven final question links, shared capacity one, duplicate identity, ordinary fallback and canonical Team rejection passed. Services stopped in finally. Evidence: `docs/investigations/mcp-tasks/review/10/`; report digest `a08d0c448bb11d60740c545848d63decbf8bedbf78211ed16fbfd9f453bcc375`. Cancellation, recovery and owner isolation remain separate dependent experiments.

**Additional integrated evidence:** Root combined this durable adapter with the actual managed Codex Conversation and standalone output bridge. One 25-second task accepted in 181.014 ms, retained model arithmetic precedes completion, and the model consumes the stored result with all bindings in the same active turn. One final Memory Question. Maintained schema validates one receipt and 230 status responses. Separate worker review passed source/trace/hash checks. `docs/investigations/mcp-tasks/review/10-model-delivery/REPORT.md` and `INDEPENDENT-REVIEW.md`. This does not establish native or original-call continuation.

## 11: Prove cancellation and terminal outcomes

**What to build:** A complete task experiment that delivers correct outcomes for
execution failure, application errors, explicit cancellation, and expiration.

**Blocked by:** 10: Prove one MCP task through Koed's durable runtime.

**Triage:** ready-for-agent

**Status:** Done

**Owner:** sdk_route; review: orchestrator. **Attempt:** 1.

**Latest update:** Accepted bounded standard terminal/cancellation suite, with prototype error/expiry corrections and explicit cooperative limits.

- [x] Deliver attributed execution failures and distinguish them from application-error tool results.
- [x] Cancel one selected task while an unrelated task continues.
- [x] Exercise queued cancellation, running cancellation, and cancellation racing with completion.
- [x] Preserve Koed's cancellation intent and execution-generation protection under the standard contract.
- [x] Separate adapter disconnection from explicit cancellation.
- [x] Align public task expiration with durable result retention and document access after expiration.
- [x] Show terminal outcomes without repeated model status calls.
- [x] Produce repeatable traces for each terminal case and record cooperative-cancellation limits.

**Review verdict:** Pass for investigated terminal behavior. Root inspected live SDK cancel and delegating-store code, 29 artifact hashes and reran schema/durable assertions into `review/11/`: nine receipts, 78 status responses, four cancellation ACKs, eight retained tasks and five final questions. Selected queued/running/near-completion cancellation preserves intent and affects no unrelated result. Stale mutations reject, detachment does not cancel. Protected 25-hour clock shift and adapter expiry enforcement are explicit fixtures. Original unknown-task HTTP 500/protocol mapping remains a production follow-up, not a claimed fix.

**Evidence:** `docs/investigations/mcp-tasks/11-terminal-outcomes/REPORT.md`, digest `000aa0c9985ed73790196f7199e9e19d13a4a6c89311b050906bf74ec4626391`.

## 12: Prove recovery without duplicate history

**What to build:** An experiment in which accepted Memory Answer work survives
adapter disconnection or Local AI Runtime restart and remains recoverable through
standard task APIs without duplicate final history.

**Blocked by:** 10: Prove one MCP task through Koed's durable runtime.

**Triage:** ready-for-agent

**Status:** Done

**Owner:** claude_interactive; review: orchestrator. **Attempt:** 1.

**Latest update:** Accepted actual runtime recovery and final-history proof. Notification ordering and replay limits remain explicit.

- [x] Disconnect the adapter after acceptance and retrieve the task after reconnecting.
- [x] Restart the Local AI Runtime during execution and recover the accepted request.
- [x] Demonstrate that an expired execution generation cannot commit a late result.
- [x] Repeat acceptance with the same invocation identity and observe one logical task.
- [x] Exercise restart between final Memory Question persistence and terminal task completion.
- [x] Demonstrate one final Memory Question for the recovered logical task.
- [x] Exercise completion before subscription, during subscription, and during reconnect.
- [x] Document notification deduplication and result-delivery guarantees separately from durable work survival.
- [x] Save traces and durable-state evidence that make the recovery behavior reproducible.

**Review verdict:** Pass for investigated durable recovery, with a delivery defect. Root inspected actual shutdown/start, timing seams and repository transactions, verified 64 hashes and reran the validator. Seven logical tasks reuse seven final questions, including restart between question persistence and terminal link. Expired lease and old generation cannot commit. Fourteen fresh adapters retrieve state through standard APIs. SSE version regression `[3,2,4]` and terminal replay are reproduced, not treated as exactly-once delivery. Graceful runtime replacement is distinct from database or machine restart.

**Evidence:** `docs/investigations/mcp-tasks/12-recovery/REPORT.md`, digest `80cc9c71afbf214f8f83b19a995d4827e1697c92cdae9e95b3791e339e52a80d`.

## 13: Prove task isolation and result attribution

**What to build:** A concurrent-task experiment that protects Personal Memory
task operations and retains the correct User, query, invocation, and Conversation
identity from acceptance through completed-result delivery.

**Blocked by:** 10: Prove one MCP task through Koed's durable runtime.

**Triage:** ready-for-agent

**Status:** Blocked (required production subscription and diagnostic safety). Investigation evidence complete.

**Owner:** pi_extension; review: orchestrator. **Attempt:** 1.

**Latest update:** Counterexamples reproduced and reviewed. Experimental host guards pass within their scope, but they do not repair unsafe runtime event delivery or general error serialization.

- [x] Accept concurrent synthetic queries with distinct result markers and originating Conversations.
- [x] Demonstrate that each completed result maps to the correct task and query.
- [ ] Deny another User's task reads, subscriptions, and cancellation requests.
- [x] Exercise revoked authority before result retrieval or delivery.
- [x] Distinguish task-access authorization from selecting the correct Conversation for delivery.
- [x] Exercise stale or mismatched delivery identity and show that unrelated Conversations receive no result.
- [ ] Preserve encrypted durable payloads and bounded diagnostic logs without query or answer content.
- [x] Record the metadata and authorization changes required by the standard adapter.
- [x] Use the client experiments' session-switch and fork evidence when documenting remaining delivery risks.

**Review verdict:** Blocked for those safety criteria, accepted as negative research input to ticket 14. Root inspected actual owner/API/runtime/SDK traces and guard seams, verified 60 artifact hashes and reran the schema/behavior verifier: three receipts, 52 status responses, three attributed results and ten physical ciphertexts. Foreign reads/cancellation deny; foreign SSE crashes the default runtime. Revoked fresh reads deny, but an already-open stream delivers an in-flight authenticated completion after revocation. Candidate preflight and per-event recipient checks prevent host injection only. Normal failed-executor logs are clean, while a separate real logger exception boundary retains supplied content. No unsafe criterion is waived or represented as production-safe.

**Evidence:** `docs/investigations/mcp-tasks/13-isolation-attribution/REPORT.md`, digest `59fb4c6fbf35cef4d7cf74cd63d91773f0a57ed51bcde2979837c362665c5701`. All owned services/credentials cleaned up.

## 14: Publish the feasibility decision

**What to build:** An evidence-backed recommendation that states where MCP Tasks
can support asynchronous Memory Answer today, which client bridges remain
necessary, and which dependencies block adoption.

**Blocked by:** 03: Measure Codex CLI task continuation, 04: Measure Codex Desktop
and IDE task continuation, 05: Prove delivery in Koed-managed Codex, 06: Measure
Claude Code interactive task continuation, 07: Prove delivery in Koed-managed
Claude, 08: Prove delivery through the Pi extension, 09: Measure Koed-managed Pi
RPC continuation, 11: Prove cancellation and terminal outcomes, 12: Prove recovery
without duplicate history, and 13: Prove task isolation and result attribution.

**Triage:** ready-for-agent

**Status:** Done

**Owner:** orchestrator; independent review: claude_interactive.

**Latest update:** Final deferral report passed independent review. Ticket 13 remains safety-blocked and is preserved as permitted negative predecessor input.

- [x] Classify every client mode as native, bridge required, blocked, or untested.
- [x] Separate protocol support, host notifications, model continuation, result delivery, and recovery in the capability matrix.
- [x] Attach exact versions, models, transports, configuration, and evidence references to supported claims.
- [x] Compare the blocking baseline with task acceptance, independent-work start, result delivery, and extra model turns.
- [x] Report speed improvements only when the agent performs useful work during recall.
- [x] Identify the minimum maintained SDK route and client versions for each viable mode.
- [x] Recommend standard adoption, scoped bridges, or deferral with precise dependency blockers.
- [x] Explain the supported recall behavior for clients that do not negotiate Tasks.
- [x] Identify any necessary changes to ADR 0043, capability reporting, and integration documentation.
- [x] Keep approved implementation follow-ups in the implementation backlog rather than the domain glossary.
- [x] If a predecessor reports an unavailable surface or dependency blocker, preserve that limitation in the report and decision.

**Review verdict:** Pass for the feasibility decision, not production adoption. Independent reviewer checked all eleven ticket criteria, all seven overall report criteria, exact mode/version and timing claims, conditional safety mapping and all 22 relative links. No required edits. Final report `docs/mcp-tasks-feasibility.md`, SHA256 `dc0a4c323f705cfc74a3c8001fab41660319b241aa507a6683f5bb721925ab3a`; independent review `docs/investigations/mcp-tasks/review/14-independent-review.md`, SHA256 `f1b96083338a4f72de069b1473ebcc353450d8d600ada2d252d2c07427666f4e`. Production implementation is deferred; no unsafe predecessor criterion is waived.

## Review outcome

The User approved ticket granularity and dependencies on 2026-09-30. The research
report now passes independent review and recommends deferring production adoption.
Tickets 01–12 and 14 are Done within their stated limits. Ticket 13 retains two
unchecked safety criteria, with reviewed counterexamples and scoped guard evidence.
The report consumes that blocked predecessor as explicitly permitted. No dependency
edge, acceptance criterion or production boundary was removed.

## Execution log

- 2026-09-30: Initialization reconciled plan, tickets, ADR 0043, current checkout, and Koed recall. All investigation criteria remain unchecked. Preserved existing `.gitignore` modification and untracked files. Ticket 01 dispatched for a maintained SDK route or sourced blocker; dependent tickets remain Open. No production changes, deployment, or publication authorized.

- 2026-09-30: Ticket 01 expanded its SDK comparison after finding released official .NET Tasks support. Isolated .NET SDK setup is authorized for the reference probe only; this does not choose a production adapter language. Pinned TypeScript negative trace and source snapshots retained. First-use experiment certificate was identified and removed by exact fingerprint; pre-existing certificate retained. NuGet restore environment issue is undergoing one bounded local-feed retry. Native client experiments remain unstarted.

- 2026-09-30: Ticket 01 official .NET Tasks 2.2.0 reference roundtrip succeeded and was independently reproduced by the orchestrator in a fresh project. Fourteen temporary NuGet archive digests verified. Finite-TTL task acceptance and status/result payloads pass the pinned extension JSON schema; final artifact and criterion review pending. TypeScript limitation remains distinct from the working .NET route.

- 2026-09-30: Ticket 01 accepted after independent reproduction and exact wire-schema validation. Ticket 02 starts using the maintained .NET route. SDK availability no longer blocks synthetic protocol probes. Production TypeScript adapter feasibility remains unresolved; release/changeset confirmation is pending the User response.

- 2026-09-30: Ticket 01 report clarified source-only missing .NET task push and pending release confirmation; report digest refreshed to `5266b45a0b381542939be2c8a398005433996e12f2723a8d27380efd9b3b89a2`. Probe source and validated behavior unchanged.

- 2026-09-30: User confirmed no changeset for research artifacts. Ticket 01 report digest refreshed for this confirmation. Ticket 02 accepted after independent current-source reproduction; positive push remains SDK-blocked. Independent tickets 03, 06 and 08 dispatched with separate owned evidence and temporary client profiles.

- 2026-09-30: Claude initial authentication negative was corrected after authorized credential-store access verified claude.ai Pro login; interactive testing resumed. Codex configured model rejected on authenticated model route. Pi configured model absent from installed registry; User model choice pending. Desktop denied automation, IDE experimental isolation remains unresolved.

- 2026-09-30: User approved gpt-5.6-luna for isolated Codex tests and conditionally for Pi where available; Pi registry contains the exact model. Managed Codex baseline passed and confirmed no memory_answer tool in actual one-shot mode. Retained-session standalone toolOutput delivery passed through a real completed SDK task; model quoted exact marker, public task and query. This bridge is new host code, not original-call matching or native Tasks. Active delivery under investigation.

- 2026-09-30: Tickets03,06,08 accepted within documented negative/bridge scopes after artifact review and hashes. Tickets07,09,10 dispatched. User authorized trust of only prepared synthetic IDEfolder; live IDE stdio negotiation records independent owningruntime0.155.0-alpha.16.3, not CLI0.157.0.

- 2026-09-30: Ticket04 accepted separate Desktopuntested/IDEordinary classifications after live IDE experiment and scoped trust cleanup. Ticket07 accepted exact actual synthesismode versus changed streamingSDK distinction. Ticket05 actual persistentmanagedConversation coverage missing from initial one-shot test; bounded remediation assigned to claude_interactive. Ticket09 persistentmanagedRPChost also under remediation; one-shotworker results not generalized.

- 2026-09-30: Durable adapter passed fresh independent reproduction. Actual persistent Codex/Pi coverage corrected and accepted. Cancellation and runtime recovery suites reviewed. Root combined durable task execution with actual managed Codex standalone delivery; separate review passed.

- 2026-09-30: Ticket 13 reviewed as safety-blocked: foreign SSE crash, post-revocation event bytes and exception-serialization risk retained. Candidate guards are scoped experiments. Ticket 14 completed its permitted negative-input synthesis and passed independent review. Production adoption deferred; no changeset, deployment or production behavior change. Final Markdown formatting and local link checks passed.

- 2026-09-30: Final ticket 13 dependency provenance confirms retained Probe.deps.json byte-for-byte against the exact executed build, with no rebuild or experiment change. Supplemental report digest refreshed to `59fb4c6fbf35cef4d7cf74cd63d91773f0a57ed51bcde2979837c362665c5701`; 61 artifact hashes rechecked. Feasibility report and its accepted findings are unchanged.

## 15: Prototype a shared delivery boundary with natural first-turn recall

**What to build:** An isolated client-independent delivery prototype over the
existing durable Personal task API, with a Pi adapter and a blocking adapter.
The Pi experiment must begin with a real model-initiated `memory_answer` call,
continue independent work and consume the later answer in the same Conversation.

**Blocked by:** Reviewed findings 08–14. Ticket 13 unsafe SSE behavior is avoided
with authenticated polling; its production safety criteria remain Blocked.

**Triage:** ready-for-agent

**Status:** Done

**Owner:** pi_extension; independent review: orchestrator. **Attempt:** 1.

**Latest update:** Final isolated prototype passed orchestrator acceptance and
independent mapping review. All behavior, source/artifact hashes, formatting and
cleanup were checked. No production implementation or changeset.

- [x] Shared lifecycle code contains no Pi APIs or independent execution/storage owner.
- [x] Delegate task acceptance/state/cancellation to actual authenticated durable runtime.
- [x] Pi and blocking presentation adapters consume the same shared boundary.
- [x] A real first-turn model initiates memory_answer without a host-created replacement task.
- [x] Useful independent work occurs between receipt and completion.
- [x] Completed result reaches the originating Conversation without another user message or model polling.
- [x] Bind original invocation/task/query/Conversation/generation and recheck authority before delivery.
- [x] Suppress stale delivery and preserve detach versus explicit cancellation.
- [x] Map the boundary to maintained MCP Tasks without a custom dispatcher or unsupported native claim.
- [x] Retain repeatable traces, source hashes, timings, cleanup and explicit synthesis-fixture limits.
- [x] Independent review passes before any production implementation decision.

**Review verdict:** Pass for the isolated prototype. One user message and one
model-initiated canonical call produced a 34 ms receipt, useful findings at 4,554 ms
and an automatic answer at 16,867 ms quoting the unpredictable decision identifier.
Pi and blocking adapters share one lifecycle over the actual authenticated durable
runtime. Seven independent boundary failure cases and actual cancellation,
detach, failure, stale-recipient, expiry and revocation checks passed. Verified 49
artifact, 26 source and ten initial executed-source snapshot hashes. Owned services
stopped and credentials removed. Actual Answer Synthesis is synthetic; native MCP
Tasks, shipped Pi UI/managed RPC integration and durable delivery recovery remain
unproved here. Ticket 13 remains safety-blocked.

Evidence: [report](docs/investigations/async-memory-delivery/15-shared-boundary/REPORT.md),
SHA256 `6870385289aaa1a282d481c1a2dbaad972dccc50b1f6830bcc5c80ce003ecb7e`;
[orchestrator acceptance](docs/investigations/async-memory-delivery/review/15-orchestrator-review.md)
and [maintained MCP mapping](docs/investigations/async-memory-delivery/review/15-mcp-mapping.md).

- 2026-09-30: Ticket 15 completed within the User-approved isolated scope after
  all-read identity/expiry remediation, a file-access approval rejection resolved
  with an exact synthetic-file guard, and a final attribution run. First-run
  missing-verifier/identifier limits retained. Production rollout remains deferred.

## 16: Validate the shared boundary with real Answer Synthesis

**What to build:** An isolated end-to-end experiment reusing ticket 15's boundary
and Pi adapter, actual durable runtime and production MemoryToolExecutor/AI-client
worker over generated memory. The model must consume a real synthesized answer.

**Blocked by:** Reviewed ticket 15. Ticket 13 remains blocked; use authenticated
GET polling. No production rollout dependency is waived.

**Triage:** ready-for-agent

**Status:** Done

**Owner:** real_synthesis; independent review: orchestrator and sdk_route.
**Attempt:** 2.

**Latest update:** Isolated real-worker proof passed orchestrator acceptance and
independent source/configuration review. Actual production retrieval, Codex
synthesis, formatter and answered history executed; no synthetic answer callback
or fallback. Original setup/verifier failures and source revisions are retained.

- [x] Delegate to actual production MemoryToolExecutor and AI-client synthesis worker.
- [x] Seed only synthetic memory and retrieve it through actual authorized API/repository paths.
- [x] Preserve the shared lifecycle and adapter separation without a second executor/store.
- [x] One natural model-initiated memory_answer call continues useful independent work.
- [x] Automatically use the synthesized decision and unpredictable source identifier without another user message.
- [x] Record original invocation/task/query/Conversation plus evidence and final-question linkage.
- [x] Reject fallback, insufficient and synthetic-callback output as positive synthesis proof.
- [x] Record source/configuration pins, resource/timing limits and all remaining fixture distinctions.
- [x] Stop owned services and remove temporary credentials; preserve normal configuration/memory.
- [x] Independent acceptance review passes; blockers remain explicit if required live proof fails.

Two original worker turns failed before producing ticket 16 artifacts. A fresh
bounded worker now owns this integration validation; criteria and scope are unchanged.

**Review verdict:** Pass at report SHA256
`072443fd1dc7c6b74d80e0ce8e2fdfbf49f9b32678bcc1af84a0c53c1be18a2a`.
One natural recall call received a 20 ms receipt; useful work at 3,301 ms preceded
real synthesis at 15,061 ms; automatic final use at 19,699 ms quoted the new source
identifier. One answered final Memory Question links the task and selected seeded
Memory Event. Found/non-fallback worker status, real app-server execution and
persisted provenance passed. Verified 39 artifact hashes, four exact executed
candidate snapshots and corrected current source revisions. All owned services
stopped and temporary credentials removed. Embeddings and source seeding remain
explicit fixtures. Production integration, native Tasks and durable delivery
recovery are not established; ticket 13 remains Blocked. No changeset.

Evidence: [report](docs/investigations/async-memory-delivery/16-real-synthesis/REPORT.md),
[orchestrator acceptance](docs/investigations/async-memory-delivery/review/16-orchestrator-review.md),
[independent review](docs/investigations/async-memory-delivery/review/16-real-worker-review.md).

- 2026-09-30: Ticket 16 accepted after actual-worker validation, independent trace
  and source review, DTO-verifier corrections, formatting and cleanup checks.
  No production rollout or capability claim is inferred from this isolated proof.

## 17: Implement the shared Memory Answer delivery lifecycle

**What to build:** A supported reusable execution-port/observation boundary used
by blocking and deferred presentation, based on reviewed 15/16 behavior.
**Blocked by:** Reviewed 15/16. **Triage:** ready-for-agent. **Status:** Done.
**Owner:** delivery_core; independent review: orchestrator. **Attempt:** 1.

- [x] Canonical task start/read/cancel delegation with bounded polling, fresh terminal read, identity/expiry checks and detach/cancel distinction.
- [x] No client APIs, executor, second result store, synthesis or custom MCP dispatcher in the lifecycle.
- [x] Portable packaging/export supports the installed Pi adapter and future maintained MCP adapter without source duplication.
- [x] Meaningful lifecycle/authority/expiry/cancellation tests and affected build/type checks pass.
- [x] Independent review accepts code and interfaces before integration.

**Review verdict:** Pass. Root inspected the portable source/export/typing and ran the integrated regression selection: 75 tests passed, including 20 shared-lifecycle cases. Typecheck/build and targeted lint/format passed. Independent final review found no generic-boundary or packaging issue.

## 18: Implement Pi deferred recall and delivery recovery

**What to build:** First supported presentation adapter using 17, with automatic
continuation, receipt/history-based recovery and blocking compatibility.
**Blocked by:** 17 contract; implementation may start against agreed contract.
**Triage:** ready-for-agent. **Status:** Done.
**Owner:** pi_delivery; independent review: orchestrator. **Attempt:** 1.

- [x] Canonical memory_answer returns an attributed Personal task receipt and permits useful work before automatic completion.
- [x] Original task/query/invocation/Conversation/generation and trusted runtime authority bind delivery.
- [x] Durable session history or bounded private delivery receipts recover matching pending work after reconnect/resume.
- [x] Fork/switch/shutdown and already delivered results are suppressed; duplicate/replay guarantees and crash limits are explicit.
- [x] Explicit cancellation remains distinct from detach; unsupported capabilities/Team retain blocking behavior.
- [x] Installed packaging, extension tests and persistent-session recovery checks pass.
- [x] Independent code review accepts adapter behavior and recovery limits.

**Review verdict:** Changes required. Independent review reproduced cancelled Pi navigation permanently disabling recall and invalidating pending receipts; the compatibility fixture also needs updating for protected registration. Pi worker owns bounded remediation and new regressions. Existing adapter and persistent SDK tests pass within their stated scope.

**Final review verdict:** Pass. Cancelled transitions now leave recall active; committed shutdown/tree invalidates all matching unsettled history receipts. Independent review reproduced the delayed observer-cleanup race after the fix: one disposition, zero late enqueues. Atomic in-flight reservation and query-reuse checks pass. Worker 40-test selection and actual Pi 0.85.1 SDK persistent/cancellation/earlier-handler tests pass. Installed module copy assertions pass. Live model continuation/restart proof belongs to ticket 20.

## 19: Fix runtime authorization and diagnostic blockers

**What to build:** Regression fixes for ticket 13 unsafe SSE handling and raw
exception serialization, plus task HTTP error status preservation.
**Blocked by:** Reviewed 13 counterexamples. **Triage:** ready-for-agent.
**Status:** Done. **Owner:** runtime_safety; independent review: orchestrator.
**Attempt:** 1.

- [x] Unknown/foreign SSE reads fail before headers without crashing the runtime.
- [x] Every event/keepalive read rechecks authority and preserves monotonic task versions/expiry semantics.
- [x] Revoked access terminates observation without cached result delivery; disconnect is not implicit cancellation.
- [x] Error status distinguishes not-found/denied failures through API/runtime/client.
- [x] Bounded diagnostics cannot serialize memory/credential content through raw exception message/stack/cause.
- [x] Meaningful regression tests and affected type/build checks pass independently.

**Review verdict:** Pass. Root reviewed authorization-before-headers, serialized fresh reads, retention, typed HTTP status and static errors, descriptor-based bounded diagnostics, and shared blocking observation. The integrated 75-test selection passed, including real HTTP denial followed by runtime health. Worker typecheck/build/lint passed. Historical ticket 13 counterexamples remain retained; this implementation supplies regression fixes rather than rewriting the earlier evidence.

## 20: Integrate, validate and document asynchronous recall

**What to build:** Review/integrate 17–19, exercise shipped Pi recovery and real
embeddings against generated memory, and update supported-flow documentation.
**Blocked by:** Reviewed 17–19. **Triage:** ready-for-agent. **Status:** Done.
**Owner:** orchestrator; independent review: runtime_safety.

**Latest update:** Live integrated validation uses delivery_core with root acceptance. Actual cached Qwen embedding and the installed Pi package replace the earlier vector/adapter fixtures. Final independent review accepted Pi navigation remediation. The User confirmed no changeset for this implementation on 2026-09-30.

- [x] Integrated code and supported adapter pass relevant tests/lint/type/build/format checks.
- [x] Real embedding/retrieval/synthesis and automatic continuation are validated on isolated generated memory.
- [x] Persistent resume/restart, fork/switch, duplicate delivery, cancellation and authorization checks support recovery claims.
- [x] docs/TODO/capability reporting explain defaults, fallback, migration/recovery limits and future native MCP boundary.
- [x] User confirms minor changeset or omission before release metadata is added/omitted.
- [x] Independent final review passes; no deployment, push or publication occurs without authorization.

**Review verdict:** Implementation and evidence reuse Pass. See `docs/investigations/async-memory-delivery/review/20-orchestrator-review.md`. Actual normal delivery and three-process pending recovery passed with real embeddings and synthesis; original failures and fixture distinctions are retained. Narrow final guard changes passed targeted tests and independent review. A minor `@koed/koed` changeset was recommended and confirmation requested; no metadata decision is inferred from the prior research-only omission approval.

**Release decision:** The User explicitly requested “No changeset right now.” No changeset is added. Implementation and review criteria are complete. No deployment, push or publication requested.

## 21: Integrate standalone Claude Code background recall setup

**What to build:** An explicit supported setup/launch option for prompt native
MCP backgrounding in independently started Claude Code main Conversations.
**Blocked by:** 17–20 accepted lifecycle; ticket 06 evidence.
**Status:** Done. **Owner:** pi_delivery; independent review: orchestrator.
**Attempt:** 1.

**Latest update:** CLI, TypeScript setup and Local Operator Script opt-in passed
independent review after protected bounded ownership, atomic writes,
capacity/duplicate-path checks, rollback, ambiguous MCP argument and native
disable-value remediation. Ordinary setup preserves its existing behavior.
Documentation distinguishes the preexisting script sign-in gate from
signed-out-capable TypeScript setup. Ticket 21 is accepted; ticket 22 subsequently passed isolated
live validation on 2026-10-01.

- [x] Supported opt-in configures the Claude host, not just the MCP child, and enables prompt continuation without a Koed-managed conversation.
- [x] Existing ordinary MCP result and shared durable runtime semantics remain; no custom task dispatcher/store or backend synthesis.
- [x] Respect existing disable/threshold settings; preserve unrelated settings and support idempotent setup/removal with ownership and rollback.
- [x] Version/capability and main-conversation/subagent/IDE/exit limits are explicit.
- [x] CLI/setup/script parity and meaningful tests/type/lint/build checks pass.
- [x] Independent review accepts implementation before live validation.

**Review verdict:** Pass at the final hashes recorded in
`docs/investigations/async-memory-delivery/review/21-orchestrator-review.md`.
Root reproduced 82 CLI/setup and 15 script tests; targeted worker lint/format,
typecheck/build and second-worker source review passed. Protected bounded
ownership, atomic writes, independent rollback, ambiguous MCP refusal and
native disable-value remediation are accepted. Ticket 22 remains a separate
live-validation gate. No normal profile, release metadata or deployment changed.

## 22: Validate standalone Claude Code with real Koed recall

**What to build:** Generated-only isolated actual interactive Claude Code probe
against shipped MCP and actual Koed retrieval/synthesis, using 21 setup.
**Blocked by:** 21 interface; harness preparation can begin independently.
**Status:** Done. **Owner:** native_claude_validation; independent review: orchestrator.
**Attempt:** Seven scoped lifecycle cases accepted; final documentation review passed.

**Latest update:** Root accepts idle6, active9, timeout1 detachment, explicit
pending-exit1, controlled selected-stop3, retrospective revoke1 and expiry1.
The required standalone main-Conversation recall and scoped failure matrix
pass with real retrieval, synthesis, exact attribution and independent cleanup
review. Ticket21 implementation hashes still match its accepted preservation
review. A second reviewer accepts the final supported documentation and actual
criteria without an additional mandatory repeated-call test. Repeated native
calls in one Conversation and delivery after reopening remain untested.
Active9's lint failure/Read-before-ack timing, artificial stop/authority controls,
timeout forced teardown and selected-stop interrupted teardown remain explicit.
No native MCP Tasks or model-generation interruption is claimed. Codex ticket24
still lacks its current native receiver prerequisite; the overall goal is incomplete.

**Historical credential gate:** Automatic approval review
rejected extracting the existing Claude OAuth token from its known Keychain
entry for an isolated profile, because credential extraction was not explicitly
authorised. No credential read occurred. A scoped approval question is pending;
the worker must not retry extraction or use an indirect workaround. Native
authentication feasibility and implementation work remain independent.
Offline harness preparation and three guard regressions are complete. Root
reproduced those guards and requested the scoped credential decision. Ticket
21 is accepted; the remaining live prerequisite is an authenticated isolated
Claude profile. The rejection has not been bypassed. This blocks ticket 22 and
its dependent final integration acceptance. Codex investigation 23 is now
complete; implementation 24 also awaits its native receiver prerequisite.
On 2026-10-01 the User chose a manual test in their authenticated Claude
session. Its expanded canonical tool call failed with `Rate limit exceeded`;
the rendering does not establish recall initiation before independent work or
background completion. Root recorded this inconclusive observation in
`22-standalone-claude/MANUAL-OBSERVATION.md` and identified the configured MCP
entry as the packaged app runtime, rather than the worktree build. The live
throttle source remains unproved. No criterion or credential gate was waived.
A second User-run fresh-chat test now positively shows a native background
task, useful independent package.json work, initial turn completion and a later
automatic completion notification plus result interpretation without a new
human prompt or model polling. Its result is `not_found` with zero evidence,
so known-fact recall and unpredictable-marker acceptance remain unproved.
This is User-observed normal-profile host behavior, not independently reproduced
isolated worktree integration. The earlier failure and attribution/version
limits are preserved in the manual observation record.
The User then confirmed the queried note predates the tests. Root's actual
same-query global recall returned yellow with one direct Personal Memory source
dated 08:50 BST and no fallback. Claude and Codex configured Koed homes match;
raw Claude completion is requested to distinguish retrieval/synthesis failure
from outer-agent interpretation. Earlier projection readiness and historical
worker/version identity remain unverified; no provider-specific cause is assumed.
Root then inspected the specific stored native transcript: actual host 2.1.267,
original query-only tool input, matching background task and actual not_found
Koed result (Codex gpt-5.6-luna low, prompt v9, no fallback). The second test
omitted search_domain, so the verified schema default is project, unlike root's
successful global lookup. The earlier rate-limited global invocation must not
be conflated with this later query-only invocation. Explicit global/evidence
manual validation is the next discriminating check; no scope default is changed.
The explicit-global rerun now passes the real-memory manual happy path. Root
verified actual stored native records: canonical global/evidence call, useful
independent analysis, initial turn completion, system-origin late notification
and automatic final answer citing the original Personal Memory source, without
model polling/retry or another human prompt. Koed returned found, one evidence
item and no synthesis fallback. This accepts grounded standalone Claude delivery
in that normal-profile run; running build/embedding pins, supported setup journal
and isolated lifecycle/failure criteria remain unverified. Original criteria
and dependencies are retained; no overall completion is inferred.
Root integrated the verified manual flow and explicit global/evidence guidance
into the supported Claude documentation and reconciled the shared delivery
documentation and backlog. This is documentation progress based on new evidence;
it does not replace the isolated acceptance criteria below. The User's manual
test choice supersedes the earlier pending credential-extraction question;
no extraction authorisation is assumed.
Bounded independent documentation review passed against the retained manual
evidence: global guidance preserves the Project default, native notifications
remain distinct from MCP Tasks, and isolated setup/exit-recovery claims are not
inferred. Reviewed Claude integration SHA256
`561ed0b38bfb37c914ebb408c91983f3a139dabaea205f2b452e29422baf792d`
and shared delivery documentation SHA256
`6bf2450bb0d0a78f5904ddd3cb9321b35f5baf596e0067bc8def3021a17e452f`.
Formatting and whitespace checks passed. No product behavior or default search
scope was changed.
Continuation recheck on 2026-10-01: the same existing isolated Claude profile
still reports `loggedIn: false`, `authMethod: none` from the native auth-status
command; no operator token file was supplied through the harness environment.
All delegated workers are terminal, with no live experiment handle to await.
This recheck supplies no new authentication or receiver capability, so live
ticket 22 execution and dependent ticket 24 remain unavailable. The successful
normal-profile manual test is retained within its separate evidence scope.
The User subsequently ran the manual pending-exit test and supplied native
session `669a02be-69a3-4445-a17b-ab7c63014d8d`. Its stored recall receipt precedes
`/exit`; the native task fails with Connection closed. The sole contemporaneous
MCP durable task completes about 22 seconds after exit, and an authenticated
read-only GET confirms completed status, yellow and the original source note.
This supports durable continuation after host detachment within the documented
temporal-attribution limit; no wire mapping of native/durable IDs or restart
recovery is claimed. Evidence is appended to MANUAL-OBSERVATION.md. Original
isolated acceptance criteria remain unchecked.
Manual stop attempt session `f738fbe2-d022-4d66-a578-bad4835f4f57` records a
background receipt and readiness, but no native stop acknowledgement. Its
contemporaneous durable task completed with yellow, one original-note source
and null cancellation timestamps. User reported no stop message; stop action
timing remains unverified, so pending-stop acceptance is not marked passed.
The User clarified that the first stop action was not confirmed. A fresh rerun
in session `9cd00a58-b225-43db-afcf-bec085fecfc6` has User-confirmed stopped state
under /tasks. Its contemporaneous durable task completed with yellow and the
original note, null cancellation timestamps, and no completed-answer native
notification in the inspected transcript. This supports manual host-stop
detachment; menu timing and wire attribution are not independently captured.
The isolated acceptance criteria remain intact.
Manual timeout session `fc58316e-b2a2-47b2-b12e-9eee14a73c84` verifies the
five-second host timeout, native failure notification and automatic error
interpretation without polling/retry. The corresponding durable task completed
about 23 seconds later with yellow and original-note evidence, with no
cancellation timestamps. Package Read preceded recall in this run, so it is
not first-action/independent-read proof. Manual evidence and attribution limits
are retained in MANUAL-OBSERVATION.md; isolated acceptance remains incomplete.
Attempted active-completion session `63cc1f70-c982-4dcb-a608-8d757238874a`
verifies recall before independent file work and another grounded automatic
idle completion. Its initial analysis turn ends over eight seconds before the
native completion is queued, so active-turn completion is not demonstrated.
This timing distinction is retained in the manual observation record.
Sleep-assisted session `d31844ed-d509-4f21-ac4d-e04aae9568c2` supplies active
tool-call evidence: native completion is queued while the Bash sleep call is
outstanding and consumed automatically at the next model boundary. Claude then
omits the requested file analysis, so the full workflow is not passed. The
actual result also has inconsistent evidence IDs: structuredAnswer cites the
original note while emitted evidence contains the prior test's captured answer.
This discrepancy is recorded for investigation in TODO.md; no root cause or
full grounding success is inferred.

- [x] One actual main-Conversation memory_answer call releases the agent promptly, allows useful independent work, then automatically consumes an unpredictable recalled marker.
- [x] Actual API, durable runtime, real embeddings and AI Client synthesis execute; fixtures and source/configuration pins are explicit.
- [x] Active/idle completion, attribution, expiry/denial, detach versus cancellation and supported exit behavior are accurately classified.
- [x] No managed SDK substitution, model status polling or normal profile changes.
- [x] All owned resources and credentials cleaned; independent evidence review passes.

The User subsequently chose a dedicated native sign-in profile and completed
the login in VS Code. Root verified that exact isolated profile with Claude's
native auth-status command outside the sandbox: loggedIn true, claude.ai.
The sandbox-only command incorrectly reported signed out; no credential was
extracted or copied in either check. A bounded worker is adapting the harness
to use this profile directly with generated memory and separate runtime
resources, preserving normal configuration and trust gates. Live launch awaits
root review of that adaptation; authentication is no longer the blocker.

Root's resumed check again confirms native `loggedIn: true` without credential
access. The first interactive launch remains at an additional onboarding OAuth
step in VS Code's second terminal; the User has been asked to finish that native
flow. No model prompt or live fixture has been launched. Review reproduced five
native-profile guard tests and requested bounded remediation: private file
identity guards for the shared project, independent original-settings restoration
after a removal error, and per-case Read trace routing for the shared project.
The shared-project folder trust stop remains intact and requires a specific
decision if the native prompt appears. These are preparation findings, not live
acceptance evidence.

The bounded remediation returned and passed root's offline review: all twelve
guard tests pass, settings restoration is independent of removal success, and
the shared project's Read audit now routes to each case's private work directory.
The exact prepared profile/project guards pass. Harness pins are retained in
`22-standalone-claude/NATIVE-HARNESS-REVIEW.md`. This accepts preparation for the
first idle experiment only after interactive onboarding and any folder-trust
gate are resolved. Active overlap and immediate-exit interpretation require
review of actual evidence; the current shared happy-path verifier does not by
itself establish those classifications. No live operations started.
The native launch created the dedicated profile's settings file with mode 0644;
root tightened only that isolated noncredential file to 0600 through an owned
regular-file descriptor. The profile guard then passed; no settings content or
authentication was changed.

Continuation audit: the previous turn made concrete preparation progress.
VS Code still shows the additional native OAuth wait, and process metadata
confirms that CLI process 56203 is live. There is no generated-runtime handle
to await. The installed target remains Claude 2.1.267 (binary SHA256
`a681f3008f0050029aeebcab3af51bb6a55ddeb625a3af3141a4416d43cd2558`);
Codex 0.157.0's hash matches ticket 23's reviewed binary, so no receiver
prerequisite change is established. Root delegated bounded verifier corrections
to distinguish active arrival, idle continuation and immediate pending exit,
and require attributed timeout/stop evidence. Offline classification work may
continue while native onboarding waits; no live permission or criterion waiver
is implied.

Root reviewed the returned lifecycle/project/schema remediation and reproduced
nineteen offline tests plus Python and JavaScript syntax checks. Preparation
passes within its stated limits; root review is retained in
`review/22-native-preparation-review.md`. The shared project now consistently
binds seed, semantic smoke and CLI/relay cwd, and raw invocation arguments are
checked separately from shipped-schema canonical execution. Timeout, stop and
immediate-exit cases require their own attributed evidence; idle cannot pass the
active-tool classifier. The existing arithmetic prompt alone does not establish
active acceptance. No model or generated runtime was launched, and every live
criterion remains unchecked. Native interactive onboarding is still waiting;
the goal remains incomplete and active while the required User action is pending.

The User then completed the second in-browser approval. Root verified the
native interactive login-success screen and continued past informational
security notes, declining optional terminal setup changes. Claude now presents
its actual folder-trust prompt for the prepared generated-only shared project.
Root requested confirmation at that action, as required by computer-use policy;
no trust choice, model prompt or runtime launch has occurred. The earlier OAuth
wait is resolved; live validation now awaits this specific folder-trust decision.

Trust-gate recheck: the existing native terminal still presents the same prompt,
with no confirmation received or trust choice made. The preceding turn advanced
onboarding; this continuation supplies no new implementation progress. This is
the second consecutive turn with the specific trust gate present. Reviewed
preparation is complete, and ticket 24's separate receiver prerequisite remains
unresolved. No live model/runtime test is eligible until the required decision.

Third consecutive trust-gate audit: current UI still shows the same unaccepted
prompt and no confirmation has arrived. The previous continuation made no new
implementation progress. All delegated workers are terminal; no generated
runtime/model process was started, and preparation has already passed review.
Ticket 24 still lacks its verified native current-receiver contract. No remaining
authorised ticket is executable without required User input or a host capability
change. The overall goal is marked Blocked, with its full objective and all
acceptance criteria preserved. The isolated Claude terminal and dedicated login
are retained so the trust step can be completed when the User returns.

The User confirmed that the folder is trusted. Root verified the actual native
input prompt, then exited that onboarding-only CLI without a model prompt.
The exact dedicated profile and generated-folder guards pass; reviewed run,
verifier and runtime hashes match. Root authorised one bounded live idle case
through the prepared harness, with native authentication in place, generated
memory and owned services only. The worker must retain evidence and cleanup,
stop on failed gates, and await review before any subsequent live case. The
trust blocker is resolved; prior blocked audits remain historical. Full ticket
and standalone-goal acceptance are still unproved.

First isolated idle attempt (`native-idle-1`) reached the trusted interactive
input prompt but the harness missed carriage-return formatting; no model prompt,
memory call or durable task was created. Root requested a graceful stop of the
exact owned driver. Resources are terminal, runtime group empty, PostgreSQL
stopped, native settings restored, supported removal preserves unrelated
sentinels, and approved credential copies are removed. The failed verifier and
original attempt evidence are retained; this is a harness preflight failure,
not a tested asynchronous-delivery result.
Readiness/explicit narrow tool-permission remediation passes twenty-one offline
tests, pending root review. The normal configuration hash guard also triggered.
Root compared an exact SHA-matching native backup to the observed after-file:
only `cachedGrowthBookFeaturesAt` changed; MCP entries and Project settings are
identical and contain no fixture entry. Sanitised read-only comparison is in
`native-idle-1/normal-config-diff-review.json`. Writer identity is unproved; root
did not restore or modify normal configuration, waive the guard, or approve a
second launch. A bounded offline fixture write-protection assessment is underway
before retry, covering all parent/child operations and normal profile paths.

Root accepted inherited write-protection preparation and cleanup remediation
after source inspection and independent generated socket/canary, six scanner
and four interruption-control checks. The exact reviewed pins and limits are
in `review/22-native-guarded-launch-review.md`. Authentication under the full
policy and every isolated live criterion remain unproved. One fresh idle retry
is eligible after the current manual provider run is terminal; no second
automated launch has occurred. Native-idle-1 and the raw hash guard are preserved.

Manual session `33bbe3e3-bb01-4657-b73a-108d51e8685d` was synchronous: final
recall returned after 31.339 seconds, before Read and the controlled sleep.
Original-note evidence is correct; no background receipt/notification exists.
Normal settings currently lack the background threshold; host environment is
unknown. Root supplied a temporary host launch setting for the next manual
attempt, with no settings mutation. This does not satisfy active overlap or
waive the isolated criteria. All delegated work is terminal; manual retry
evidence is pending.

Exactly one fresh guarded idle retry is now live (`native-idle-2`, worker handle
5599). All six reviewed source pins matched. Guarded parent PID 61141 verified
canary data and metadata denial before setup. Configuration pins retain native
Claude 2.1.267 Sonnet 5, Codex 0.157 gpt-5.6-luna worker and real Qwen embedding.
No normal configuration was modified by root, and no additional case is approved.
Latest manual aa7ffeb4 evidence is retained separately: background receipt, useful
work, initial turn end, then automatic completion without polling or a new prompt.
The active interval missed completion by 3.522 seconds; the User received a longer
controlled test. Captured-answer provenance is recorded distinctly from direct
original-note selection.

Guarded idle2 is terminal and failed: no accepted native User row, canonical
call or durable task. Setuid ps execution failed during cleanup. Scoped outside-
policy compensation verified/stopped PG 61778 and removed approved credential
copies; recorded native/driver/parent/wrapper processes are absent. Failed evidence
is preserved with missing before-hash/settings-restoration proof, not rewritten
as a successful run. Root reproduced two bounded regression groups for separate
paste/Enter acceptance and kernel group metadata; final preparation review follows.

Manual `c11f31ff-6c94-4186-8846-cc88c4dc8a9e` independently observed completion
enqueue 34.122 seconds into a matched `pnpm lint` tool interval. Claude consumed
the queued Memory Answer automatically when that tool yielded after its foreground
timeout, 280.251 seconds after enqueue. Original-note structured and bundled
evidence agree. No memory poll/retry/cancel or new prompt was needed. Lint later
failed with 1,211 investigation-script errors and was reported automatically,
without fixes. This proves native delivery at a tool boundary, not preemption.
The manual result supplements, rather than replaces, generated isolated acceptance.

**Native idle3 root review:** Actual prompt acceptance, useful pending work,
real executor/embedding/synthesis and automatic idle consumption are observed.
The vague outer prompt resulted in an inner `answer_only` query that did not ask
for the record identifier; omission is a test-prompt limitation requiring bounded
remediation, not proof of a product defect. Original marker and order criteria
remain in force. `native-idle-3/ATTEMPT-REPORT.md`, `resources.json` and
`normal-config-diff-review.json` retain failure and cleanup evidence. The latter
compares exact retained before/after hashes without storing account values:
only the cached-feature timestamp differs, but its writer is unknown. No profile
was restored or modified, and this raw guard failure is not waived.

**Offline prompt correction accepted:** Root inspected the actual prompt and
independently compiled it, extracted its arguments by AST, and passed them
through the shipped schema. It requests decision plus identifier, project scope,
`with_evidence` and explicit `include_evidence:true`, with Read after receipt.
Generated marker remains hidden; verifier/guard and lifecycle branches are
unchanged. PTY SHA256 `8332f003889b6d8a080327cc4aa6ef6c2c3492e0748c0161f448f971206bfd2a`;
report `22-standalone-claude/IDLE3-PROMPT-REMEDIATION.md`. This is preparation,
not live acceptance. Root requested the User close other normal Claude sessions
for a quiet-profile retry; no unrelated process was stopped. Historical raw hash
failure and unknown writer remain recorded. No fourth launch is approved.

**Guarded idle4 authorised:** The User reports all other Claude sessions closed;
root's approved read-only process-name check returned no Claude processes.
Exactly one corrected idle run is authorised through the inherited-policy launcher,
with existing dedicated profile/project and unchanged verifier/guards. Fresh pins,
quiet-hash preflight, actual runtime ownership and complete cleanup remain required.
No later case or retry is authorised by this entry.

**Idle4 startup race:** Native prompt was accepted before MCP tool discovery.
The terminal first response stated only Read was available; no recall or Read
was attempted. Wire tool-list response advertised memory_answer about 931ms after
prompt submission. Root reviewed actual rows and authorised graceful owned cleanup,
then bounded offline discovery-gate remediation. The first prompt must await a
matched successful tools/list response and native input readiness; arbitrary sleep
and model claims are insufficient. No retry is authorised; cleanup review pending.

**Idle4 cleanup/readiness review:** Root checked resources: runtime exit0,
owned native/runtime groups absent, PostgreSQL stopped, auth copies removed,
native settings restored and activeOperations:false. Exact before/after comparison
again found only the cached-feature timestamp changed with Project/MCP values equal.
Readiness now requires a successful response to a matched tools/list request
advertising memory_answer before prompt submission, alongside native readiness.
Root inspected code and reproduced all six grouped guard tests. PTY pin
`5e1dc55a1ef5c136b497c6538fa1d0e49c4968ec45e961bd4307454d72a98e40`;
reports in `native-idle-4/`. No verifier/profile guard changed. Product code
`ai-client-capability-publisher.ts` refreshes every five minutes and Claude driver
discovery executes version/auth probes; running normal Koed processes make that
a plausible writer, not attribution proof. Requested temporary app quit before
retry. No unrelated process stopped or normal profile mutated by root.

**Guarded idle5 authorised:** User quit Koed and authorised continuing. Root's
read-only process check found no Koed.app or Claude processes. Exactly one run
is authorised with the independently reviewed tool-discovery gate, unchanged
raw guards/verifier and fresh quiet-hash preflight. No later case/retry approved.

**Idle5 partial live success:** Tool discovery preceded prompt submission;
first tool was canonical recall, then actual TODO Read and useful pending
findings. Native automatically consumed the returned unpredictable decision
identifier. Raw normal hashes remained unchanged after Koed quit. Cleanup
completed with no owned operations left. Historical clean native exit remains
unverified: driver issued duplicate fallback /exit after terminal closure and
raised EIO before retaining final code. Verifier also encountered an untimed
native metadata row. Root independently inspected transcript/guards and delegated
bounded offline exit-race and conservative untimed-marker handling, without
weakening criteria or authorising another live run.

**Idle6 authorised after exit review:** Root independently inspected exit handling
and conservative untimed-marker safety, and reproduced nine grouped regressions.
Verifier now explicitly requires retained native exit0 plus consumedMarker for
happy paths; historical idle5 remains failed missing that event. Exactly one
fresh guarded idle6 run is authorised with reviewed pins and quiet preflight.
No later case or retry approved; no raw guard or marker requirement relaxed.

**Idle6 root acceptance:** Root independently reproduced verifier exit0, checked
first tool recall then Read, marker consumption, actual final native exit0,
unchanged normal hashes and complete cleanup. Live runtime ancestry is retained
in `native-idle-6/root-external-runtime-identity.json`; it reconstructs root's
actual live tool result after a worker's late empty query overwrote the first
artifact, with that provenance explicit. The scoped idle report passes and the
first two criteria are checked. Remaining broader lifecycle criteria are unchanged.
One fresh existing-mode `native-timeout-1` is authorised next; no other case/retry.

**Timeout1 scoped root acceptance:** Root reproduced detach verifier exit0.
Matched native five-second failure, ordinary wire cancellation and durable
completion without durable cancellation are observed; success delivery is
suppressed. Raw guards and resource cleanup pass. Native final exit-9 is retained
as forced teardown, not supported clean exit evidence; no pending-exit menu was
observed and the busy-followup/stop-hook cause remains unproved. One existing-mode
selected TaskStop case `native-cancel-1` is authorised next, with quiet preflight;
no other case, source change or retry approved.

**Cancel1 negative timing:** TaskStop selected the correct host task only after
its completed notification. The result was is_error:true/not running; Claude
then consumed the completed marker. This is a missed pending window, not a
successful stop or a cancellation defect. Root authorised graceful exact-owned
wrapper interruption rather than waiting for a stopped notification that cannot
arrive. Cleanup review pending; no retry authorised. A bounded controlled-pending
fixture proposal is requested without changing production semantics.

**Pending-exit root acceptance:** Root reproduced `native-exit-1` verifier exit0.
Actual receipt, explicit pending-task stop-and-exit selection and native exit0
preceded durable completion; wire detachment is bound and durable cancellation
absent. No post-exit answer or restart recovery is claimed. Normal hashes and
cleanup pass. Root's later runtime query found no live process, honestly retained;
this is not substituted for live ancestry proof. Selected-stop remains incomplete.
Root accepted only offline source preparation for the documented cancel-only
bounded pending barrier, preserving unchanged real execution and all guards.
No next live run is authorised.

**Controlled-stop preparation review:** Draft cannot be accepted: invocation-key
suffix alone cannot prove the maintained opaque per-connection namespace, and
nonce resealing must not permit old trace acknowledgments. Root authorised only
cancel-only offline same-CLI observation preparation at the existing runtime
client callTool boundary, preserving all arguments/this/signal/results/errors and
logging no credentials. Exact full-key equality and fresh chronology tests are
required before root review and any live launch. Draft/synthetic tests supply no
selected-stop acceptance. Production code and protocol bytes remain unchanged.

**Controlled-stop prep accepted / cancel2 authorised:** Root reviewed same-CLI
preload/relay/observer, full-key/current-connection proof and fresh chronology,
private publication and unchanged real delegate, and independently reproduced
both Node suites plus three Python proof tests. Exactly one `native-cancel-2`
run is authorised with a clearly artificial bounded60s pending gate and fresh
quiet preflight. Other cases and product/guard/verifier semantics are unchanged.
No later case, source adjustment or retry is authorised.

**Cancel2 negative / bounded offline remediation:** Native made no TaskStop,
so the artificial barrier did not release and no real worker execution occurred.
Three existing scheduler retries each reached the barrier bound; no model retry
or fabricated completion is claimed. Final task failed/question null. Cleanup
and raw normal hashes pass; native teardown exit-9 remains explicit. Actual
receipt uses text-block arrays, exposing an independent string-only proof-reader
bug. Root authorised only cancel-specific prompt correction and conservative
string/typed-text-array normalization with raw attribution preserved. Full-key,
freshness, gate and real delegate safeguards remain unchanged. No next live
run is authorised.

**Controlled-stop3 root acceptance:** Root reproduced verifier exit0 and
independently checked exact task/full observed invocation/current nonce,
release before real execution, no answer delivery and unchanged raw hashes/full
cleanup. Accepted scope is selected native request stop with durable work
continuing, using an explicit artificial pending barrier. It supplies no natural
latency measurement or clean native-exit proof; root authorised teardown after
more than five seconds of post-result observation. No model polling/retry, normal
profile changes or product semantics changes. Reports in `native-cancel-3/` and
root `review/22-native-lifecycle-review.md`; all prior failures remain intact.
No additional case is authorised or active.

## 23: Establish standalone Codex automatic delivery mechanism

**What to build:** Bounded current installed-source/native-hook investigation
and isolated prototype for independently started Codex CLI, with IDE/Desktop
classified separately. Outcome supplies implementation prerequisites.
**Blocked by:** Shared lifecycle 17; prior independent modes 03–04.
**Status:** Done. **Owner:** runtime_safety; independent review: orchestrator.
**Attempt:** 1.

**Latest update:** Historical Codex0.157.0 interactive CLI prototypes passed
real recall, useful work, automatic same-Conversation consumption and scoped
revocation/expiry suppression. The current installed0.159.3 binary and official
source refresh still leave supported current-native-receiver eligibility
unresolved. The inspected ordinary MCP path awaits its final result and does
not establish a native MCP Tasks consumer. Ticket23 is Done as bounded research;
its negative prerequisite finding leaves ticket24 Blocked. CLI prototype proof
is separate from IDE/Desktop support and from current-version live proof.
The original0.157 source checkpoint below remains historical.
The isolated TUI probe may inherit only the existing exact repository trust
field, with generated fixture IO and no normal daemon connection. No new
trusted folder or Desktop automation is authorised. Ordinary hooks alone do
not establish idle continuation; `codex exec` has a distinct host lifetime.
Automatic approval review subsequently rejected the repository-cwd rerun with
workspace-write access: prompt restrictions do not enforce isolation from real
repository files. Nothing executed. The worker is assessing an enforceable
read-only sandbox alternative; the rejected workspace-write route remains
blocked and must not be retried indirectly.
The safer rerun was approved with an explicit read-only sandbox and no model
approvals; it is running against the isolated profile and existing exact trust.
An isolated `codex exec` cold-session probe completed useful fixture work, then
accepted a queued completion without an automatic follow-up during a bounded
ten-second observation. This is a negative result for that exited host mode,
not evidence against a loaded interactive TUI.
Actual read-only TUI probes now pass for idle and active queue admission: the
same Conversation consumes an unpredictable synthetic completion automatically,
with one human prompt and no model polling. Root inspected the idle rollout,
MCP binding and exact queue UUID. These are host-transport proofs, not real Koed
authorization or Answer Synthesis. Shared-lifecycle/fresh-authority prototype
validation remains required before ticket acceptance. The original auth
symlink isolation limitation is retained; future runs use private scoped copies
and minimal environments.
The first actual-runtime idle attempt stopped at MCP startup before a receipt
or task was created. The host's shell fallback and independent CSV work do not
satisfy recall. The worker is retaining this failure, cleaning owned resources
and diagnosing the isolated bridge environment before any retry. Offline
shared-lifecycle, maintained-SDK metadata, protected-control and wrapper
gate/next-terminal-chunk checks passed root review; no production adapter or
fresh-authority live acceptance is inferred yet.
Attempt 1's MCP stderr identified a scrubbed `CODEX_HOME`; its complete owned
cleanup and unchanged normal configuration hashes were reviewed. The wrapper
now explicitly configures only its own native-profile path for that MCP child.
Root reproduced the updated offline wrapper guard and approved a separate idle
attempt 2 under the same read-only/generated/private-auth boundary. No acceptance
is inferred until the actual trace is reviewed.
Attempt 2 reached the actual durable runtime, returned a prompt receipt,
completed useful work while running, performed the fresh terminal read and
automatically started the original native Conversation's follow-up. However,
retrieval returned insufficient with zero evidence/candidates; the final answer
did not consume the seeded marker. The retained attempt is a failed full-recall
proof. Fixture query/Project diagnosis is in progress, and the wrapper now
requires evidence plus the exact marker in both result and native final answer.
No further model run is authorised before the fixture fix and gate review.
Diagnosis identified a bridge normalization error: raw `{query}` bypassed the
shipped MCP schema defaults. The production executor then lacked `project_id`,
and all three searches received actual API request errors. The investigation
bridge now parses through `memoryAnswerInputSchema`; production retrieval is
unchanged. An owned model-free API preflight will check the rejected malformed
boundary and a correctly normalized semantic hit before a third model attempt.
The fixture question may naturally request the documenting decision record;
its unpredictable identifier remains absent from the prompt and receipt.
Attempt 3 produced real evidence and the correct synthesized decision, then
automatically delivered it to the same native Conversation. The outer model
dropped the last character of the documenting identifier, so exact-source
acceptance failed. Cleanup passed; this attempt remains separately retained.
After ticket 25's canonical owner correction passed review/build, root approved
normal attempt 4 with the same unpredictable 64-bit identifier and a natural
verbatim-copy instruction. The verifier requires one real evidence item,
non-fallback synthesis, fresh-read/enqueue linkage and the exact unseen marker.
Root independently reproduced the positive verifier on attempt 4 and inspected
both native final messages, actual executor/history and fresh completed-v3 read
before exact-UUID queue admission. The first turn completed useful CSV work;
automatic continuation quoted the full unseen identifier and migration decision.
Cleanup and normal-configuration hashes pass. This accepts the positive fixture
proof; live revocation and expiry checks remain required. The worker is preparing
those separately bounded checks, and the root is reviewing production receiver
readiness requirements without starting dependency-blocked ticket 24.
The independent source review found that native loaded-thread state is memory
residency, not an active interactive receiver lease. Native queue admission can
persist messages after the receiver disappears, and repeated CLI queue commands
generate new message IDs. Hook lifecycle/origin evidence is being assessed before
choosing a production adapter contract; a loaded snapshot alone must not enable
detached delivery or imply safe recovery.
The live revocation counterexample passes root reproduction and trace review:
real synthesis completed with one evidence item; the generated API Token was
revoked after the first terminal snapshot; the fresh delivery read returned 401.
No queued completion or second native turn appeared during ten seconds of
observation. All source pins reconcile, and owned resources/private credentials
were cleaned with normal configuration unchanged. Separate live expiry validation
also passes root reproduction: the fresh completed-v4 read has an expired
retention timestamp, the shared lifecycle detaches, and no native queue or
second turn occurs over ten seconds. Its 100 source pins and cleanup reconcile.
Root reviewed the source-based receiver contract assessment and independently
confirmed the documented delayed SessionEnd behavior. Research is complete;
production current-origin eligibility remains an explicit prerequisite, not a
waived criterion or a successful adapter implementation.

- [x] Inspect actual installed Codex and primary sources for native Tasks/background tools/hooks, late context injection and idle continuation.
- [x] Test a viable public host mechanism in standalone CLI with approved gpt-5.6-luna; reject managed app-server substitution and model polling.
- [x] Preserve original invocation/query/Conversation and fresh-authority delivery; detach/fork/switch/recovery limits explicit.
- [x] Record CLI/IDE/Desktop separately; no unapproved Desktop automation or new workspace trust.
- [x] If blocked, retain authoritative limitation evidence and implementation requirements; do not treat a receipt-only prototype as success.

**Review verdict:** Pass for the bounded investigation and live shared-lifecycle
prototype. Evidence and remaining production prerequisite are recorded in
`docs/investigations/async-memory-delivery/review/23-orchestrator-review.md` and
`23-standalone-codex/authority-runtime/readiness-design.md`. Native Tasks are
still unavailable; queue transport is viable in the tested live host but does
not provide the current native receiver capability needed by ticket 24.

## 24: Integrate standalone Codex adapter and final standalone review

**What to build:** Implement the verified independent-host route from 23 using
the shared lifecycle, then review standalone provider coverage and docs.
**Blocked by:** 23 viable host mechanism; 21/22 validated Claude integration;
25 canonical task-start boundary.
**Status:** Blocked pending User availability for manual validation. **Owner:** orchestrator with bounded implementation delegation.

**Latest update (2026-10-02):** The User explicitly accepts the observed
native Stop cancellation race as a known limitation to fix after upstream changes,
not an implementation blocker. The tested original-turn Stop continuation supplies
a candidate route without external queue receiver discovery. Implement opt-in
standalone Codex delivery through the existing shared task runtime; normal blocking
recall remains available. Late HookPrompt admission into the interrupted original
turn is the only accepted exception. Other cancellation behavior, origin binding,
authorization, expiry, deduplication, recovery and mode claims still require evidence.
No claim of native MCP Tasks consumption or idle wake-up is introduced.

- [x] A independently started Codex conversation continues useful work and automatically receives its owned Memory Answer without another user message.
- [ ] Supported setup and delivery recovery/cancellation/origin checks reuse the shared runtime and have meaningful integration tests, with the explicitly accepted upstream late-HookPrompt cancellation limitation recorded.
- [ ] CLI/IDE/Desktop supported and unsupported modes have distinct verified claims.
- [ ] Documentation, affected checks and independent review pass; current no-changeset preference preserved.
- [ ] Overall objective completion audit covers every standalone requirement; unavailable mechanisms remain explicit blockers rather than narrowed completion.

## 25: Normalize Memory Answer input at durable acceptance

**What to build:** A bounded owner-boundary correction discovered by ticket 23.
The durable task API currently accepts a valid raw query but stores it without
the supported tool schema's defaults; later execution can disagree about
Project scope. Normalize once before eligibility and durable acceptance so
client adapters and future maintained MCP Tasks share the same canonical input.
This is within the authorised standalone integration work, not a second
executor or a retrieval-algorithm change.

**Blocked by:** Retained ticket 23 boundary diagnosis.
**Status:** Done. **Owner:** pi_delivery; independent review: orchestrator.
**Attempt:** 1.

- [x] The existing task-start owner validates and applies the supported schema defaults before eligibility and scheduling.
- [x] Invalid inputs fail with a static HTTP 400 without acceptance; Team detached restrictions retain their existing behavior.
- [x] Query-only and explicitly defaulted inputs reach the same canonical execution boundary, with caller and invocation binding preserved.
- [x] Meaningful task/runtime regressions, affected type/build/lint/format checks and independent review pass.
- [x] General adapter documentation describes the canonical owner boundary; no changeset or normal-profile mutation.

**Review verdict:** Pass. Root source review and independent 50-test
task/runtime/scheduler reproduction passed. Targeted lint/format, typecheck and
affected MCP build passed after the live-probe cleanup gate. Exact source and
built hashes are recorded in
`docs/investigations/async-memory-delivery/review/25-orchestrator-review.md`.
Historical prototype failures remain unchanged; later runs pin this build.

## 26: Preserve cited source identity when selecting Memory Answer evidence

**What to build:** Bounded answer-worker correction for the manual Claude
payload whose structured answer cites the original note while the returned
Evidence Bundle contains a prior recall response. Validate explicit identities
against indexed candidates and prevent unrelated evidence selection.
**Blocked by:** Retained manual payload diagnosis; no live authentication needed.
**Status:** Done. **Owner:** evidence_selection_fix; review: orchestrator.
**Attempt:** 1.

**Latest update:** Source correction and independent regressions passed.
The User's rebuilt packaged-runtime retest also returned matching original-note
identity in the structured answer and Evidence Bundle, with automatic native
consumption. Source/build and manual live evidence retain their separate scopes.

- [x] Contradictory index and explicit identity cannot select unrelated evidence.
- [x] Matching/index-only selections and source/chunk identity remain supported; missing identities cannot fall back to unrelated indexed candidates.
- [x] Generated original-note/replayed-answer regressions and affected worker checks pass.
- [x] Independent source review, documentation and release preference reconciliation pass; no client/default-scope changes.

**Review verdict:** Pass for the bounded source correction. Root reviewed the
actual implementation and independently reproduced all 17 new regressions.
The full worker file passed 61 of 62 tests; an unchanged Claude SDK test hit
its existing timeout under heavy scheduling load, then passed alone in 3.21s.
Typecheck, targeted lint/format and root package build passed. This is not an
unqualified full-suite green claim. Final source/test/built pins and review
limits are in `docs/investigations/async-memory-delivery/review/26-orchestrator-review.md`.
No changeset or normal-profile change. All worker operations are terminal.
Live packaged-app validation remains separate; tickets 22 and 24 are incomplete.
The User subsequently rebuilt and launched the app. Retest session
`ae15f4e1-9a4c-4e15-84bf-3a3bdd4720ef` verifies identical original-note identity
across structured answer and returned Evidence Bundle, automatic native
consumption, and a packaged worker digest matching the accepted build. Native
and durable results share synthesis job identity. Live source-attribution retest
passes; detailed limits remain in the manual observation and ticket 26 review.
Isolated setup/marker acceptance and Codex receiver prerequisites remain open.

### Ticket22 active-work preparation review

Root accepts ACTIVE-WORK-PREPARATION.md within offline scope: 19 independently
reproduced fixtures and16 source/dependency hashes pass. Exact native Bash
command/result/start evidence and tool-boundary answer chronology are required.
One native-active-1 launch is authorised after fresh quiet-process/raw-hash
preflight; existing live acceptance boxes and Codex dependencies are unchanged.

### Ticket22 native-active-1 review

Changes required for fixture submission; no capability acceptance. Rootverified
1249-byte suppliedprompt versus227-byte exactsuffix nativeUser row, different
actualrecallquery and absentapprovedlint. Resource assertions independently
pass with raw normalhashesunchanged, runtimeexit0/groupsabsent/authremoved/
settingsrestored. Nativecleanexit remainsunverified. Evidence:
22-standalone-claude/native-active-1/ATTEMPT-REPORT.md and separate actual-live
root ancestry reconstruction versus laterempty processobservation. Offline
shorteractiveprompt and exactBashguard review authorised; no liverepeat.

### Ticket23 installed-release refresh accepted

Root reviewed receiver-refresh-0.159.3/REPORT.md (SHA256
e9e4f5bda4b87174e554b3a5d42bb501f87dfcba6a82703d135ff02eb826bff2),
actual queue admission and delayed-unload source, reproduced 47 offline checks
and verified 63 artifact hashes. Official tag resolves to commit
01fc69f4026735edfdf6789820549727a4867b11. The receiver prerequisite remains
unresolved under the reviewed public contract. Ticket23's historical research
acceptance and ticket24's dependencies remain; no new live capability or
production adapter is claimed.

### Ticket22 native-active-2 review

Changes required. The full607-byte native prompt and exact recall were accepted,
and the exact Bash hook permitted the intended command. Native directory
protection then required approval before lint execution. No script-start
evidence or tool result exists; completion during that prompt does not satisfy
active-work acceptance. Terminal verifier exit1/native exit-9, no delivered
answer. Root independently checked cleanup and unchanged normal hashes.
Evidence: native-active-2/ATTEMPT-REPORT.md and the root live ancestry artifact.
Only offline ephemeral directory-access/write-protection preparation is
authorised; the actual access grant requires scoped User authorization under
the approved plan. Original criteria and dependencies remain unchanged.

### Ticket22 concrete directory-access preparation accepted

Root reviewed ACTIVE-DIRECTORY-PREPARATION.md, reproduced 20 offline tests and
verified 23 source hashes. Generated policy evidence covers 11 actual inherited
macOS enforcement checks, not a live Claude directory grant. User authorization
for ephemeral exact repository access is pending under PLAN.md's trust boundary.
No live retry is approved and active/authorization criteria remain unchecked.
Independent helper-only authority deadline/proof preparation proceeds without
changing the reviewed active sources.

### Ticket23 maintained MCP Tasks refresh accepted

Root reviewed mcp-tasks-refresh-0.159.3/REPORT.md (SHA256
77fd2dbdd56355c67f6cd1106d4fe1f65ab0f178fd582a5a541622bfa2c627cc),
reproduced 47 offline checks and verified 49 artifact hashes. Actual native
capability filtering excludes the Tasks namespace; inspected calls await final
results without establishing an automatic deferred-result consumer. This
bounded source conclusion supplies no viable ticket24 prerequisite. No live
provider or profile operation ran. Dependencies and criteria remain unchanged.

### Ticket22 native-active-4 review

Changes required. Exact approved command ran, but pnpm version mismatch stopped
it before ESLint. Original completion enqueue occurred after that result.
Claude additionally attempted a blocked extra Bash command and a second recall;
the strict verifier rejects the run. Native exit -9 is distinct from fixture
exit0. Root verified 33 evidence hashes, terminal cleanup and unchanged current
normal raw hashes. Evidence: native-active-4/ATTEMPT-REPORT.md (SHA256
545e5e3f4f8a8e0291f1a8a9774a7bef45f623563e61257efcfff238f5cb6b55).
No active acceptance or retry. Offline remediation and authority wiring
proposals proceed; existing User scope approval persists.

### Ticket22 active4 offline remediation accepted

Root reviewed ACTIVE4-OFFLINE-REMEDIATION.md, independently reproduced20 scoped
tests and verified25 source/five dependency hashes plus the protected version
result. Existing cached pnpm11.1.2 returned its actual version under network
denial and generated-only writes. Active prompt/command changed; strict
verifier, protections and nonactive behavior remain. One guarded native-active-5
attempt is authorised after fresh preflight; no acceptance or automatic retry.

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

### Ticket23 follow-up: Codex0.160.0 and native Stop candidate

2026-10-01 root review: official0.160.0 immutable source commit
`a956835d020762cb2b570053af06f643a11c0ecc` does not establish native Tasks
consumption or the queue current-receiver prerequisite. Root reran the bounded
verifier:61 source digests,35 baseline comparisons and15 unchanged critical
surface assertions pass. This is source-only; installed0.159.3 is unchanged.
Report: `23-standalone-codex/refresh-0.160.0/REPORT.md`.

A different route is eligible for a synthetic qualification probe: synchronous
Stop runs in the original native session/turn and records attributed automatic
continuation. It keeps the turn active rather than waking an idle turn. This
may avoid external queue receiver discovery while preserving original ownership.
Source shows100ms interruption grace without a visible Stop-result cancellation
recheck; context append and subsequent model sampling need separate native tests.
Root verified all14 retained source/documentation hashes. Report:
`23-standalone-codex/stop-hook-candidate/REPORT.md`.

Root prepared only an inactive generated hook and fixture at
`/private/tmp/koed-codex-stop-probe-80rgdpxa`. Four offline cases passed, including
matching completion, wrong owner/event rejection and recursion suppression;
repeat invocation also returns no action. These are not native, task-receipt,
authority or real-memory tests. No normal profile, credentials, installed binary
or production source changed. Exact isolated hook trust authorization is pending.
Ticket24 remains Blocked for supported integration acceptance; the new candidate
permits preparation and, after authorization, bounded qualification only.

### Ticket23 Stop-probe controller preparation

The exact hook script/definition hashes remain unchanged while trust approval
is pending. Added a fixture-only release controller: one exact generated owner
and wait event are required; terminal and repeated release are refused, and
publication cannot overwrite another release. Four offline cases and repeated
release rejection pass. `readiness-pins.json` records the concrete fixture.
These checks validate fixture controls only; they do not establish native
continuation/interruption or authorize hook trust. No provider was launched.

### Standalone goal: isolated-hook approval blocker audit

The same exact isolated Stop-hook trust approval remains unresolved across
three consecutive resumed goal turns, including the candidate preparation turn
and two automatic continuations. No automatic goal message is a human approval.
Current audit verifies all six prepared fixture hashes, unchanged local commit
2eb73625, no fixture invocation/owner/release evidence, and terminal delegated
source workers. Offline preparation and source audits are complete; no owned
live operation remains to poll. Native qualification cannot proceed within the
existing no-new-trust boundary. Ticket24 and the full standalone objective remain
incomplete. The goal is marked Blocked pending the existing specific approval;
its objective and acceptance criteria are retained.

### Ticket23 isolated Stop-hook trust authorized

2026-10-02 User explicitly replied Approved to the pending exact generated
isolated Stop-hook test at /private/tmp/koed-codex-stop-probe-80rgdpxa. All six
prepared file hashes still match readiness pins. Authorization is limited to
that hook definition in an isolated profile using gpt-5.6-luna and synthetic
data; normal profiles and broader trust remain excluded. Native completion
qualification is now executable; interruption follows only if it works.
No production integration acceptance is implied.

### Ticket23 native Stop mechanism qualification: completion

2026-10-02: completion attempt1 reached the trusted native hook but its driver
looked for legacy live rollout events; it refused release and the hook bounded
out. Retained as an observation failure, not promoted to a successful test.
The approved correction reads only the generated profile's native SQLite
thread history, in read-only mode and bound to exact hook session/turn IDs.

Completion attempt2 demonstrates automatic native continuation with the exact
approved hook: one human UserMessage, successful package.json read/summary,
one typed HookPrompt and marker Agent answer, all in one completed native turn.
Root independently verified ordering/identities and exact recorded PID absence.
No model polling, public queue or second human prompt. Native exit was forced
SIGTERM after quit timeout; clean exit is not claimed. Private auth copy removed
and normal-profile hashes unchanged. Source backend remains0.159.3.

Root also reran actual-rollout production capture verification: hook row remains
raw_only/system with no canonical User identity; marker answer is Agent content.
This is offline parser admission evidence, not live ingestion/Projection proof.
No capture fix is justified from the earlier context-free synthetic probe.

Interruption attempt1 Ctrl-C opened a cancel menu without confirmation; native
turn completed normally. Root verified completed status and actual Cancel task
menu; this is a test-control failure, not a host cancellation defect. The approved
retry confirms that native menu selection and records cancellation separately
from context append/model output. Full ticket24 integration remains unproven.
Artifacts: `23-standalone-codex/stop-hook-candidate/native-probe-*`, root
verification JSONs and capture-provenance verification. No product files changed.

### Ticket23 native Stop mechanism qualification: cancellation and final review

2026-10-02 root review: interruption attempt2 confirmed native Cancel task and
exact-owner backend abort. Hook continuation emitted82.042ms afterward; typed
HookPrompt persisted about86.829ms afterward in the interrupted turn. No marker
answer appeared during10.1535s; model network requests were not directly measured.
This fails the cancellation context-admission fence. Candidate qualification
stops; no real Koed integration is justified by the functional positive control.

Root verified six retained cancellation evidence hashes, reproduced the bounded
0.160.0 two-file source verifier and checked all nine source-report artifacts.
The Stop await/record/continue and100ms task-abort grace blocks are unchanged;
no fix was found in the compared path. Source-only, no0.160.0 live claim.
All owned operations are terminal, private auth copies removed and normal
profiles unchanged. Native teardown required SIGTERM; clean exit is not proven.
Production commit2eb73625 is unchanged. No publication or product edit occurred.

Research review Pass for the bounded evidence; candidate product acceptance
Blocked on actual cancellation admission failure. Ticket24 remains Blocked,
criteria/dependencies retained and overall standalone objective incomplete.
Root review: `23-standalone-codex/stop-hook-candidate/ROOT-ACCEPTANCE.md`.
The minimal upstream issue draft is local only under release-0.160-cancellation-check.
A host fix or another supported receiver capability is required before dependent
Codex integration; repeating the unchanged live path supplies no missing fix.

### Ticket23 host remediation handoff, 2026-10-02

Previous goal turn made progress: native cancellation failure and0.160.0 source
comparison were accepted. This continuation prepares a redacted synthetic
maintainer reproduction, rather than repeating the unchanged live route.
`stop-hook-candidate/upstream-reproduction/` contains the bounded hook, owner-bound
release controller, template definition, synthetic package and instructions.
Offline checks pass matching/repeated release, wrong owner, recursion and malformed
events. These are fixture controls, not another native cancellation qualification.
A seven-member allowlisted tar includes no profile/auth/history/daemon artifacts;
root verified member hashes and excluded local usernames, original IDs and token
fields. Instructions explicitly disclose the manual race timing limitation and
suggest a deterministic native barrier regression. Nothing posted or installed.

Ticket24 still requires a cancellation-safe supported host delivery route.
Automatic active-turn continuation alone does not satisfy its lifecycle criteria.
No owned live operation exists to await; all production files/commit unchanged.
This is the second consecutive turn with the same host-capability blocker, with
meaningful local handoff work completed. Overall goal remains active/incomplete.

### User-approved Codex acceptance amendment and implementation start

2026-10-02 User: "I think we accept that this is an issue and fix it once the
upstream change has been made ... I don't see this as a blocker."
This explicitly permits documenting the observed original-turn post-cancellation
HookPrompt admission rather than requiring a host fix before implementation.
It does not authorize cross-Conversation delivery, stale/fork replay, authority
bypass, unbounded observation, silent profile trust or unsupported mode claims.
Ticket24 is In progress using the qualified Stop route. Its other criteria and
shared execution ownership remain unchanged; historical failed findings retained.

Bounded implementation delegated: delivery_core owns MCP opt-in dispatch and
Codex adapter/runtime tests; native_claude_validation owns setup scripts/tests
and AI-client integration documentation. Root owns acceptance, TODO and ledgers.
No new live/native trust/auth/profile operations authorized by this amendment.
The exact previous synthetic fixture approval remains separately scoped.
No changeset preference persists; no push/PR/external publication.

### Ticket24 implementation checkpoint

The acceptance amendment is reflected in current PLAN/TODO/ticket24. Core
implementation now adds opt-in MCP transport handling, per-call protected nonce
in native updatedInput, actual session/call/turn metadata checks, durable task
acceptance and bounded shared Stop observation. New source and tests remain
under implementation/review; no final acceptance claim. Scoped setup work covers
contributor and packaged operator entry points and required package staging.
Initial generated setup checks pass; package check parity is being completed.

Independent review caught and requested remediation for concurrent identical
calls/one-turn admission, uncertain submission replay, expiry cleanup races,
post-continuation same-turn recalls, failed/expired/denied result feedback,
unsupported subagent eligibility and actual maintained MCP SDK transport tests.
Root verified immutable native PostToolUse serialization source: tools/context.rs
in0.159.3/0.160.0 identical SHA9a9acc6daab2112bd9ca1a07a1e1f2105b20a7f565878157c726ee0d7a3e00cc.
It serializes the native CallToolResult rather than formatted transcript output.
Source-only evidence is retained under24-standalone-codex/native-hook-shape.

The production observation budget is being separated from the synthetic20s
probe; current design uses a bounded five-minute default with matching hook
allowance. No native ticket24 run/profile/trust/auth operation has started.
Root validation plan records local gates and pending mode/lifecycle qualification.
Live qualification of the new production hook needs concrete definition review;
old exact synthetic hook trust does not supply that permission. Workers are
active on authorized local implementation/tests, no owned native process to await.
No changeset/push/PR/publication; prior Pi/Claude commit unchanged.

### Ticket24 setup review checkpoint

Setup worker returned16 frozen source/documentation pins covering contributor and
packaged opt-in, owned-block preservation, hook-chain status and packaging helper
requirements. Root verified all16 current digests, inspected relevant diffs and
independently reproduced33 generated Node tests (all pass). Worker reports161
server setup/CLI/status tests, typecheck/lint/format pass in generated HOME;
root combined server/core reproduction remains pending final core freeze.
No native qualification or hook trust claim follows from setup tests.
Core and independent delivery review remain active; production acceptance pending.

### Ticket24 local review and concrete native trust gate

Core froze six implementation/test/package files; independent reviewer accepted
source and reproduced35 new tests. Root verified current reviewer hashes,
reproduced65 new/shared/protocol tests and33 Node setup/packaging tests, all pass;
server typecheck passed. Root added explicit one-deferred-call-perturn and
crash-orphaned receipt repair limitations to Codex docs after setup worker freeze.
Its prior16pins are retained historical; amended docs are included in root review.
No full/live qualification claim. ROOT-LOCAL-REVIEW.md records bounded acceptance.

Inactive generated profile/fixture: /private/tmp/koed-codex-adapter-native-mmtfrzwk.
Config SHA2ea4dcf39f8a69853b4373b7060ddd58cc87eebc14fbcd9de8a7e0c4a2287c45;
helper SHA5e065b8d2b924e033bf7425dff466c98d1177978301874f44401f8475f6d122a.
Credential-free configure/check passed. Exact0.159.3 native binary hash unchanged.
No credentials/services/native run/trust operation. Old exact synthetic hook
approval does not cover new production definition. Ticket24 In progress;
next live action needs specific generated folder/hook trust approval. Other
lifecycle/mode criteria remain pending. No publication/git/changeset operation.

### Ticket24 packaging completion and trust request

Root completed koed-server build and inspected a newly packed MCP archive.
All six required hook/adapter/generic lifecycle JS/type members match current
emissions; the new bin/export exists. PACKAGE-AUDIT.json retains archiveSHA
f656729d210aa9513668705cdb51d830e9f35545450cc17e5291851fd928b6b3.
This is offline packaging evidence, not fresh-machine installation/live proof.
Current exact native-readiness emitted/config pins still match after build;
fixture has no auth copy or runtime registration. User question requests trust
only for the concrete generated test folder/definition, because earlier specific
synthetic hook approval does not cover this production executable definition.
No response means no approval; no native/model/service operation has started.
All delegated/local test/build operations are terminal. Ticket24 remains In progress
pending native/lifecycle qualification, not Complete or globally Paused.

### Ticket24 exact isolated hook/folder trust approved

2026-10-02 User explicitly replied Approved to the pending generated folder and
exact Koed hook definition at /private/tmp/koed-codex-adapter-native-mmtfrzwk.
Root revalidated nine prepared config/emitted/source assets and pinned0.159.3
native binary. Historical readiness remains a pre-approval record, not overwritten.
One first native positive qualification is delegated to delivery_core using
synthetic memory and gpt-5.6-luna. Require actual durable acceptance/executor,
independent work before completion, exact native original-turn automatic result
consumption and fresh authorized Evidence Bundle. No script-injected completedtask
or managed presentation substitute. Normal profile mutation, wider trust,
symlinked auth and silent binary/model changes remain excluded. Worker prepares
and sends resource/controller plan before native launch. Root owns acceptance.

### Ticket24 native binding observability scope

The exact approved production hook does not log full raw stdin. Root accepts
actual native rewritten MCP arguments/pending result, source-pinned hook runs,
production-created protected receipt identity/inputHash/state/task/invocation
snapshots and typed HookPrompt/exact session-turn history as binding input/effect
proof. Observers may only read receipts, never inject or modify them. This retains
ownership requirements while avoiding a trusted executable instrumentation change;
full raw stdin is not claimed. Preparation continues, no native launch yet.

### Ticket 24: first production native CLI test launch authorised (2026-10-02)

Root reviewed the frozen prospective runtime and native PTY controller; the independent reviewer found no functional launch blocker. Root independently checked 401 source pins below 100 MB with no drift, and the reviewer verified all 403 pins including the cached model. The User approval applies to the exact isolated folder and hook definition, Codex 0.159.3 and gpt-5.6-luna. One real executor/embedding/API/native test is authorised, with no artificial completion or delay. Native owner binding is established from actual rewritten arguments, production receipt snapshots and typed history; full raw hook stdin is not claimed. Private auth is removed during cleanup even if termination fails, with any remaining owned process reported as a failed control. Native qualification and ticket completion remain pending.

### Ticket 24: first native launch failed before prompt (2026-10-02)

The approved production runtime started and seeded generated memory, but the native PTY driver rejected a control line contaminated by a terminal cursor response at the folder-trust screen. No human test prompt or MCP Memory Answer task was submitted. This is failed harness evidence, not an adapter verdict. Root inspected resources.json/outcome.json: runtime exit 0, native SIGTERM exit -15, owned native/runtime groups and daemon PIDs absent, private auth copies removed, normal profile hashes unchanged. Root authorised only bounded terminal-control sanitation with an offline regression and a proposed same-fixture retry plan; a second launch remains pending review. Original failed evidence and executed harness are retained under native-positive-1/evidence.

### Ticket 24: bounded harness correction and retry authorised (2026-10-02)

Root reviewed native-positive-2: only driver control parsing changed, stripping recognised terminal cursor/device response prefixes while rejecting unknown controls. Root independently reproduced four observer/control tests. The independent reviewer verified the first attempt had zero human prompts, executor starts and durable tasks, with private copies absent and normal profile hashes still unchanged. The cursor contamination cause remains an inference from terminal/tool output, separate from the observed rejected control. One retry is authorised after archiving the first owned generated profiles/database and restoring the exact original approved config in the same approved fixture. No product hook/config change, artificial timing, result injection, model substitution or acceptance waiver is authorised. Fresh source pins, profile baseline, reset manifest and cleanup evidence are required.

### Ticket 24: native contract mismatch observed (2026-10-02)

The second real native launch passed folder/hook trust and submitted one prompt. Codex rejected the production PreToolUse updatedInput because permissionDecision:allow was absent. It ignored the nonce update and used ordinary blocking memory_answer, which returned the generated decision and evidence. This does not qualify deferred delivery. Root inspected final resources/outcome: runtime exit 0, native -15, owned groups and daemons absent, private auth removed, normal profile hashes unchanged. Root authorised a bounded source investigation and hook-output regression to establish native validation and downstream approval semantics before correcting the product; no further live case is authorised yet.

### Ticket 24: native rewrite contract correction authorised (2026-10-02)

Root and independent reviewer traced pinned Codex 0.159.3 hook parsing, PreToolUse outcome, hook-runtime continuation and downstream MCP approval. permissionDecision:allow authorises updatedInput only; no approval override crosses the hook outcome, and MCP still evaluates its configured approval mode. Root authorised adding allow only to a valid prepared nonce envelope, with production CLI stdin/stdout contract coverage and affected checks. Hook definitions and MCP approval configuration remain unchanged. Native live qualification is still pending; the blocking result from attempt 2 remains negative async evidence.

### Ticket 24: corrected native qualification authorised (2026-10-02)

The implementation owner passed 36 adapter tests plus typecheck/build/lint/format. Independent review reproduced the actual-source CLI contract regression and accepted the narrow output change; source SHA42ebb689… and built delivery SHA9a8185e0… identify it. Root audited the current package: six helper/shared delivery members match current emissions. Root inspected native-positive-3 controller and prepared readiness: only readiness read/snapshot paths and the corrected delivery emission digest differ; all hook commands, model and native binary remain unchanged. Root authorised one same-fixture retry after preserving attempt 2 and restoring exact approved config, with fresh pins/profile baseline and all owned PID absence checks. Prior failed/blocking evidence remains unchanged. Qualification and ticket completion remain pending.

### Ticket 24: corrected native launch awaits fresh human approval (2026-10-02)

Automatic approval review rejected the third live native launch before process creation. Its stated reason: the User approved the initial isolated test, but no trusted User message explicitly authorises the corrected retry after a production adapter change and prior attempts. Root delegated approval was insufficient to that review. No workaround or third runner, credential copy, service or model request was launched. The already authorised owned reset is retained in the reset manifest; exact approved config and corrected readiness hashes match. Root asked for explicit approval of one corrected test in the same fixture with Codex 0.159.3/gpt-5.6-luna and cleanup. Ticket remains incomplete and goal active; this is the first occurrence of this approval blocker, not a completed or blocked goal.

### Ticket 24: fresh human approval for corrected third test (2026-10-02)

The User explicitly answered Approved to the pending question describing one corrected test in the same isolated fixture using Codex 0.159.3 and gpt-5.6-luna, private credential copies, synthetic memory and cleanup. Root inspected retained blocked/reset state and resumed the frozen native-positive-3 case, requiring fresh readiness/profile/PID checks before launch. This supersedes the launch approval blocker without authorising additional cases or changing hook definitions/model selection. Independent evidence review resumes; native qualification and overall completion remain unproven.

### Ticket 24: first production native positive accepted (2026-10-02)

Root and independent review accept native-positive-3 for one standalone Codex 0.159.3/gpt-5.6-luna original-turn case. Actual MCP pending receipt: 72 ms. Package read and useful summary precede real executor completion by 48.684 seconds. The native Stop HookPrompt payload equals the actual executor result; the final response preserves the previously unavailable random decision and original event citation. One human prompt, call, command, task, executor and completed native turn; nonce, canonical-input hash and native session/turn/call invocation tuple match. Answered Memory Question and encrypted durable snapshots are retained. Both native/runtime exits are 0; root independently observed seven exact recorded PIDs absent, sensitive fixture files absent and current normal profile hashes unchanged. Root summary: ROOT-POSITIVE-REVIEW.json; independent report: native-positive-3/INDEPENDENT-REVIEW.md. First acceptance box passes; lifecycle/native failure checks, mode qualification and overall completion remain incomplete. No further live case is authorised by this third-test approval.

### Ticket 24: conservative completion timing reconciliation (2026-10-02)

The positive review initially used SQLite item-creation timestamps for the useful summary. Root and independent reviewer corrected that interpretation without changing the frozen core evidence. The complete raw package output is retained at 08:14:40.722Z and complete summary at 08:14:58.986Z; actual executor result is 08:15:34.285Z. The conservative proven summary margin is 35.299 seconds, replacing the earlier 48.684-second item-creation comparison as the completion claim. Root reproduced every offline verifier assertion with its output redirected outside frozen evidence, and updated ROOT-POSITIVE-REVIEW.json. Exact owner/nonce/task/result/evidence and cleanup acceptance remain unchanged. Native lifecycle qualification and other client modes still remain open.

### Ticket 24: remaining lifecycle and mode preparation (2026-10-02)

The offline completion audit distinguishes accepted shared/Pi/Claude work and one real Codex CLI positive from remaining native qualification. A read-only mode audit pins installed desktop/IDE versions and exact critical backend source contracts; local IDE/Desktop are untested candidates, not proven unsupported. Root keeps native branch/fork/replacement qualification required and authorises only offline wiring of the six proposed lifecycle controls plus branch preparation. Timeout test definition changes only the documented helper wait and matching native timeout; neither inert configuration is installed or trusted. No new live case, credential copy or service is authorised by the third-test approval. The independent lifecycle-preflight worker encountered a transient model-capacity failure; no replacement model or claim of completed independent review is introduced. Core harness preparation and root review remain executable.

### Ticket 24: offline lifecycle review and mode reconciliation (2026-10-02)

Root inspected the six-mode prospective controls, protected ordinary-read attribution, owner binding and actual HTTP/control chronology. Independent review identified a missing tracked exit monitor, mismatched timeout fence bound and incomplete retrospective qualification assertions; implementation remediation remains offline and acceptance is pending. Native fork/replacement remains required separately. Root reproduced all twelve retained installed-backend source digests and critical rewrite/metadata/Stop fragments; IDE/Desktop are source-grounded candidates with frontend isolation/trust/delivery still unqualified. No new live test, credential copy, service, model call or normal-profile change is authorised or performed in this checkpoint.

### Ticket 24: isolated frontend preparation delegated (2026-10-02)

While the CLI lifecycle harness is remediated, root delegates a bounded read-only procedure audit for local IDE/Desktop isolation, bundled backend selection and hook trust review. This can establish prerequisites or precise gaps, not native delivery. Frontend launches, auth copies, normal-profile/preference writes, trust injection and model calls remain outside this task. Root retains progress and acceptance ownership.

### Ticket 24: R/E first-batch preparation frozen for independent review (2026-10-02)

Root accepts the offline revocation/expiry source preparation subject to final independent review. Root reproduced 22 control/provenance tests and 12 retrospective verifier tests; all 48 source pins match manifest baf8cfeb…, and nineteen prospective readiness pins per case match. R readiness ede0e225… and E readiness 89ada178… additionally require an approved owned archive/reset to restore the canonical fixture config; the retained positive3 fixture is intentionally not yet launch-ready. ROOT-FIRST-BATCH-REVIEW.json records exact scope and prerequisites. No live R/E approval or execution has occurred. F/C/T verifier preparation, genuine X exit evidence, native B fork/replacement and IDE/Desktop qualification remain separate open gates. B offline preparation is delegated in a new directory without altering the frozen R/E definitions.

### Ticket 24: R/E independent preflight accepted; fresh approval requested (2026-10-02)

Independent review reproduces 22 Node and 12 Python tests and all frozen pins/config/reset controls, accepting only R/E prospective preparation for an approval request. Root requested explicit authorization for exactly those two isolated native cases, including owned prior-state archive, fresh native UI trust, private auth copies and cleanup, with unchanged 0.159.3/gpt-5.6-luna/hooks, no retry or normal-profile changes. No answer means no live approval. B and frontend prerequisite preparation continue offline in separate ownership. Ticket and full goal remain incomplete.

### Ticket 24: frontend candidates and further lifecycle preparation (2026-10-02)

Root reproduced all eight installed frontend source hashes/excerpt offsets and four retained artifact pins supporting isolated IDE/Desktop candidate procedures. Root prepared two inert TOML definitions under frontend-fixture-preparation, preserving the eleven baseline hooks and MCP approval while changing only explicit model/read-only/on-request settings and owned future fixture paths; no fixture/profile/config installation or native launch occurred. Actual frontend protection, auth/shared-facility isolation, backend selection, trust loading and delivery remain unqualified. F/C/T valid prospective verifier schemas and passive X SessionEnd evidence preparation are delegated into separate directories, keeping frozen R/E definitions untouched. The live R/E question is still pending; no silence-based authorization is inferred.

### Ticket 24: post-review artifact pin reconciliation (2026-10-02)

The final independent review document was updated after the original 48-file freeze. Root verifies exactly that document differs and the other 47 original pins remain unchanged; POST-REVIEW-PINS.json records the old/new review digest without rewriting the historical manifest. Executable harness, verifier, configuration and R/E readiness hashes remain unchanged. The pending live approval request and original point-in-time hash assertions retain their exact scope.

### Ticket 24: two CLI cases authorised; conditional pause requested (2026-10-02)

The User asks to pause after finishing these next two Codex CLI tests so the machine can be shut down. This directly authorises the pending concrete R/E batch described in the approval question, and requires a goal pause after both cases and owned cleanup are terminal. Root dispatches only frozen reviewed R/E, with fresh owned PID/hash/archive/reset/native trust checks, no retry or additional live mode. Other offline preparation workers are instructed to stop at safe checkpoints and hand back their partial artifacts. Root will verify cleanup and call update_goal(paused), preserving incomplete criteria.

### Ticket 24: conditional pause cancelled (2026-10-02)

The User says to continue and that no pause is needed now. This cancels the earlier pause-after-two-tests instruction before any goal status change. R/E remains the only authorised current live batch; root continues cleanup/review and the full standalone goal afterward, without treating cancellation as approval of new live definitions. Offline preparation checkpoints are preserved.

### Ticket 24: revocation accepted; expiry expectation under reconciliation (2026-10-02)

Root and independent review accept R: all 41 frozen artifacts match; the exact original owner/nonce/task/key has one execution, actual completed HTTP200 is followed by one generated-token revocation and mandatory fresh HTTP401/typed runtime401, with only a static original-turn unavailable notice. Root reproduced the frozen qualifier and independently observed all eight recorded R PIDs absent. E also completed native/runtime0 and root matched its 41 frozen artifacts and eight absent PIDs; copied credentials/registration are absent and current normal hashes match. Its original verifier failed and remains frozen: ordinary protected GET returns HTTP200, not the predicted410; shared delivery checks the expired fresh snapshot and emits a static observation-ended notice. Source/criterion reconciliation and a separate corrected retrospective verifier are pending root/independent acceptance, with no rerun or product change. Both authorised cases are terminal; no extra live case is authorised.

### Ticket 24: scoped revocation and expiry qualification accepted (2026-10-02)

Root and independent review accept both authorised native cases. R passes its frozen verifier; E passes a separately pinned retrospective verifier and nineteen meaningful offline regressions after source-grounded correction: ordinary GET returns an authenticated retained snapshot200, then the shared lifecycle suppresses expired fresh retention before presentation. Original failed410/static-denied assertions and all41 E raw artifact hashes remain frozen, with no rerun, waiver or product change. Root independently verifies all16 recorded R/E PIDs absent, credentials/registration absent and current normal hashes unchanged. ROOT-BATCH-CLEANUP-REVIEW.json records acceptance. Native failure/cancel/timeout/exit/fork and frontend qualification remain open; full goal and ticket24 stay incomplete. The User cancelled the conditional pause; offline B preparation resumes, with no additional live case authorised.

### Ticket 24: remaining preparation resumed after pause cancellation (2026-10-02)

Root resumes separately owned offline B fork preparation, F/C/T harness wiring and instrumented X exit preparation. No new live case, authentication copy, trust action, service or model request is authorised by this preparation. Root also recomputes both inert frontend config digests and exact structural equivalence after the owned path and three explicit model/protection settings are normalised: all eleven hooks and MCP approval match the reviewed baseline, and neither proposed fixture directory exists. frontend-fixture-preparation/ROOT-CONFIG-REVIEW.json records this limited review. Targeted formatting of TODO, async documentation and completion audit passes; git diff --check passes. Full goal remains active and incomplete.

### Ticket 24: instrumented exit checkpoint reviewed (2026-10-02)

Root matches all seven checkpoint and six reference pins and reproduces fifteen synthetic tests. Instrumentation now forwards each legitimate SessionEnd once, even when diagnostics fail; production helpers remain unchanged. This is not live-ready or native qualification: source-backed active-task exit controls, backend/TUI identity separation, guarded runner/cleanup and a main verifier reconstructing raw owner/durable/history evidence remain required. Pure dictionary fixtures do not establish those facts or native app-server run status. Root requests bounded offline integration in a separate instrumented-runner directory, preserving the frozen checkpoint and exact future hook trust boundary. ROOT-INSTRUMENTED-CHECKPOINT-REVIEW.json records Changes required. No live resources or new launch approval.

### Ticket 24: fork preparation review requests bounded corrections (2026-10-02)

Root reproduces31 pure B tests and reviews the actual controller/metadata/native history joins. Preparation is not accepted yet: CHECKPOINT correctly limits the upstream exception to a late original-turn HookPrompt, but the verifier must additionally reject a parent model answer/Evidence leak; the final report must expose actual exit/forced-cleanup outcomes, and missing normal baseline or recorded process/PGabsence evidence must fail cleanup qualification. Root requests offline branch-only remediation preserving the frozen checkpoint snapshot and tests of each missing proof. ROOT-B-PREPARATION-REVIEW.json records the point-in-time digests and Changes required. No live fork, credential copy, service or model request is authorised.

### Ticket 24: fork review finding corrected against frozen revision (2026-10-02)

Root rereads the final frozen verifier and confirms it already rejects a parent model answer carrying the marker/source/markdown and binds any late parent HookPrompt to the exact Stop definition. The earlier missing-guard finding came from a draft read before freeze; ROOT-B-PREPARATION-REVIEW.json records this correction without removing history. Artifact-level mutation coverage is still requested. The remaining preparation findings concern explicit actual exit/forced-cleanup reporting and required baseline/recorded process/PGabsence proofs.

### Ticket 24: independent remaining-case review and remediation (2026-10-02)

Independent F/C/T review reproduces13 Python methods,9 Node tests and414 source pins; observation/execution joins are accepted offline, but strict cleanup evidence, historical owned PID/PGabsence and exceptional artifact freezing require correction. Independent B review reproduces39tests/all28pins and a full-artifact counterexample: a plain late parent model answer beyond fork cutoff passes the marker filter, exceeding the context-only HookPrompt exception. Root requests bounded offline corrections in each separately owned candidate, preserving prior snapshots and frozen R/E/product code. X runner integration also fixes independently guarded cleanup rather than cloning an exception path that can skip teardown. ROOT-REMAINING-PREFLIGHT-REVIEW.json records exact independent report digests. No further live case is approved, and accepted positive/R/E results remain unaffected.

### Ticket 24: remaining preflight corrections, continued (2026-10-02)

The User confirms continued work with no pause. Root reads the actual independent
B review3, F/C/T review2 and instrumented X review before dispatching bounded
offline remediation. B's two preservation/equality fixes return a 54-test,
33-pin revision for independent review4: preflight refusal cannot finalize an
existing frozen case, and interrupted/final parent agent items must match in
both directions with unique IDs. F/C/T still requires exact PostgreSQL binary
identity and an accurate, recorded created-Popen termination contract. X still
requires real-wrapper/verifier field compatibility, a measured all-session
output boundary, fenced group cleanup, partial-start PostgreSQL cleanup and
independently guarded sanitized finalization. Earlier evidence and manifests
remain unchanged; none of these offline results qualifies a native case.

Root reconciles X measurement with ticket24: verified backend-originated native
SessionEnd input, unchanged production-helper execution and exact receipt
retirement can establish the narrower pending-exit behavior when actual exit,
durable noncancellation, absence of new session model output and cleanup also
pass. This does not establish app-server HookStarted/HookCompleted IDs/status,
passive notifications or idle wake-up; those claims remain explicitly excluded.
The earlier notification proposal is retained with its measurement gap. No
behavioral criterion, accepted upstream exception or dependency is widened.
No new live case, credential copy, trust action, service or model call is run.

### Ticket 24: fork preflight accepted and concrete approval requested (2026-10-02)

Independent review4 accepts the final two-fix B preparation, reproducing54 pure
tests and all33 source pins/21 nonfixture readiness pins. Root inspects the
actual invocation-created finalization and bidirectional full parent-agent
equality guards and independently matches33/21 pins. Source manifest
fdc12dddd579732a62897deedd487bd81267af20532faadfc4705deaec2c966d,
readinessff0cf0948b0a77897508fe859073957585d50edee45908d292fa3ab6cb8c9a15,
independent report5f1af7201a5a418061d9f9e457d3ee4e448ffbe677385cb61f6d862bde9a5a9e.
Root prepares BRANCH-LIVE-PROPOSAL.md and requests approval for exactly one native
fork case with owned archival reset, fresh native trust, private auth copies,
synthetic services and complete cleanup. That request is pending; no silence
or general continuation is recorded as approval. Final proposal/source scope
review continues offline alongside F/C/T and X corrections. No native B proof
or overall completion follows from preparation acceptance.

### Ticket 24: F/C/T final preparation accepted (2026-10-02)

Independent review3 passes the corrected offline F/C/T preparation:40 Python
tests,420 source/nonfixture readiness pins, affected syntax/TOML checks and
unchanged prior11 Node test evidence. Manifest
a87e0a6f47fa87b2770b9f9393480d7434d789534f24bdcb5758f99c666fe079;
review reportb337ca429872a9e77c612c8e509fac24d9c5926280d6c9de4e43b406cdf9c924.
Root reads the actual corrected PostgreSQL executable/hash adoption and
created-Popen signal/current identity, request-status and poll/wait/reap paths;
independently matches all five changed/new source pins and verifies all prior
external pin values remain unchanged. Existing-case refusal, partial PG startup
and exceptional new-case retention remain covered. No native F/C/T qualification
follows. Specific reviewed live/reset/trust scope remains pending preparation
and authorization; the existing single-B approval question covers only B.
Instrumented X remediation and bounded frontend isolation source review
continue in separate ownership. Accepted positive/R/E evidence stays unchanged.

### Ticket 24: concrete F/C/T batch review and approval request (2026-10-02)

Root prepares FCT-LIVE-PROPOSAL.md for at most three sequential single-attempt
native cases, with entire owned-fixture archival reset into distinct private
sibling paths and fresh package-only workspace/config/profiles before each.
Independent scope review passes, retaining the original report and a separate
T clarification addendum: final proposal SHA256
18fa3bbd2efc6b006c7df9b5ad57be3e94d66fa9481415c1fab5eafd1d479fbc
explicitly requires genuine completed/found T execution without executor abort
or durable cancellation while presentation stays suppressed. Readiness/source
and selected configuration hashes match the frozen harness. Root requests
specific approval for this exact batch, after any approved B cleanup; it remains
pending separately from the single-B question. No launch, reset, auth copy or
trust action has occurred. Source-only frontend isolation review identifies a
legacy same-UID IPC fallback requiring further preparation; that observation is
not promoted to actual frontend isolation or an unsupported-mode verdict.

### Ticket 24: F/C/T live batch authorized (2026-10-02)

The User explicitly approves the reviewed three-test batch. Root dispatches F
first under the frozen source/readiness and final proposal scope, with actual
E cleanup/hash/ownership checks before the approved archival reset. There is
no approved or started B case, so no fork cleanup dependency is active. C and T
remain in this authorization only after root accepts each preceding case's
owned cleanup. Exactly one attempt per mode, no retry; unexpected failure ends
the batch. Temporary auth copies, synthetic local services and fresh exact
native UI folder/hook trust are authorized only in the named isolated fixture.
Normal profiles remain outside writes. Product/frozen harness/evidence criteria
are unchanged; unfamiliar UI, drift or policy rejection stops the attempt.
Instrumented X and frontends remain offline and unapproved for launch.

### Ticket 24: F startup failure ends the approved batch (2026-10-02)

F preflight matched all420 source identities, E41 raw artifacts, E normal hashes
and exact preceding owned PID absence. The approved entire-fixture archive used
directory rename without following29 native-generated internal symlinks; root
clarified that existing inert links are preserved, never copied/restored, while
root/destination/new config/package/auth ownership and symlink gates stay strict.
Fresh selected config/workspace completed422 readiness comparisons before launch.

Native startup then failed before folder/hook trust, any human prompt or Memory
Answer execution. owned_survey raised a recorded-root identity rejection and
discarded the rejected current row. Actual PID reuse versus legitimate startup
argv/executable transition is therefore unresolved; neither is inferred. The
batch stops: C/T and retry did not run. Runtime exits0; native forced exit-15
and failed cleanup phases/credential-control booleans remain raw and unchanged.

Root independently matches43 original and47 supplementary F artifact hashes,
observes all19 recorded PIDs absent through exact scoped ps, verifies actual
auth.json descendants/connection/registration/postmaster PID absent and current
normal hashes unchanged. ROOT-F-STARTUP-REVIEW.json accepts this scoped cleanup,
not F behavior or clean native exit. REPORT.md SHA256
45acedabbcd40b9ebb43e414cc05285a2bb5e30ce2c02c02882545736da596b5;
supplementary manifest782a093971a94b42164f2265caadfd036314e5e107bf65409c16ac36795104c1.
Bounded offline diagnostics proceed in a new overlay with unchanged fail-closed
decisions, safe expected/current mismatch retention and separate auth/alias
isolation proof; frozen420 sources and failed native evidence remain preserved.
Fresh execution is not authorized by this failed batch.

### Ticket 24: exit corrections and frontend source prerequisites reviewed (2026-10-02)

Independent Xv2 review accepts all six prior offline corrections:31 pure tests,
21 syntax checks,40 current pins, preserved prior33 and nonfixture readiness.
Root reads the actual wrapper/artifact boundary corrections and independently
matches all40 manifest members. Review6161295e986e4262a5f414735a0017cb1832959193201ddddf5227025c8766fc;
manifest50650627378d71f5948d7d8f25317269d8ce0e1809bd37d526982ab799d03d10.
This is not native X qualification. A separate source-only applicability note
after F finds that X also discards comparator mismatches before publication;
argv alone would not trigger X, but its compared executable/start/UID/PGID
changes remain unobservable on failure. Narrow guarded diagnostics are required
before its concrete live proposal; no guard relaxation or native HookRun claim.

Root reviews the frontend follow-up and independently reproduces7 installed
records/28 exact excerpt offsets and4 current report pins. Six fetched public
immutable0.159.2 auth sources match their Git blob identities. Distinct canonical
Codex homes scope direct and encrypted-secret keyring accounts; shared OS storage
alone does not prove normal-account overwrite. Both frontend legacy IPC paths
also require explicit private TMPDIR and actual inheritance/socket verification.
VS Code's installed in-memory SecretStorage option is a candidate, not proof of
zero Keychain consumers. Final frontend report
64c7d95af7ff8d9fbd0efab238ad2c0b1a05f281b725eaa62d304b6657663db5
and manifest a66e4dbb5bf9fa3961b911e7c9ab7576a9420b1788c67e0aedc392cb56219547
preserve earlier wording/pins separately. Generated frontend state, credentials,
trust, actual backend environment and delivery still require concrete preparation
and approval; no frontend launch or mode qualification occurred.

### Ticket 24: neutral Python admission reproduction (2026-10-02)

Root runs two bounded neutral generated Python child checks, with no Codex,
frontend, auth/profile, services, memory request or model invocation. The installed
Python3.14.3 launcher path passed to Popen appears in actual scoped ps as its
framework Python.app executable; remaining script arguments match. Literal argv
equality fails. Launching the exact pinned framework executable directly makes
the same actual comparison pass. Both children exit0 under Popen wait and both
temporary directories are independently absent. Separate
PYTHON-STARTUP-IDENTITY-PROBE.json retains evidence and binary/source hashes.

Official version-tag Python launcher source explicitly routes to that framework
app via POSIX_SPAWN_SETEXEC/execve. This demonstrates a concrete local driver
admission fault but cannot recover F's discarded row or prove its historical
first failure. Root directs the new prospective overlay to use the exact reviewed
framework interpreter and pin its hash, retaining literal identity guards rather
than adding general executable normalization. Safe first-mismatch chronology and
source-backed native alias isolation remain part of the bounded correction.
No native retry, C/T test, frontend launch or new live authorization follows.

### Ticket 24: diagnostic overlays under affected review (2026-10-02)

Root independently matches all11 frozen X diagnostic-overlay manifest members
and inspects its actual four-file patch. Independent affected review is running,
including the parent cleanup identity assertion as well as startup and group
comparison paths. X remains unapplied and unqualified; no live resources exist.
Manifest ec92a3aee624ef239944834920a420779b9169062b533d1c9fd5416f40d4519a.

The separate F/C/T diagnostic overlay received Changes required for rejecting
the observed native current/bin/codex alias chain. Bounded remediation must
validate only the exact private current-to-pinned-release chain in collection
and verification, preserving frozen version1 and failed F evidence. Root
fresh post-cleanup link observations are separate from historical F startup
evidence. The ended batch does not authorize a retry, C or T. Integration and
a concrete revised execution proposal follow successful affected review.

### Ticket 24: X diagnostic coverage remediation required (2026-10-02)

Independent review reproduces the actual parent native cleanup AST rejecting a
changed executable with zero diagnostic records and zero signals. Equivalent
direct parent/driver backend metadata assertions also bypass the overlay.
Review report09eda235b6db59259549f0fe7352acce5621f93419baf14a4350b8ee12bbf7b2
retains the source counterexample,11 passing tests and matching frozen pins.
Root inspects these actual paths and dispatches a bounded version2 correction
with prior-overlay preservation. Expected/current records and unavailable
metadata must precede original rejection or absence handling; publication must
remain non-authoritative. Guard, exception, signal and cleanup decisions cannot
change. This is offline harness remediation only, not X qualification or a
fresh live authorization. Product adapter and earlier accepted cases unchanged.

### Ticket 24: F/C/T diagnostic overlay version2 accepted for assembly (2026-10-02)

Independent affected review Pass7dd1949d1c7ba84d25136487a8c0f20dc7a0dbf41cc090007b512f21d6088cc5
accepts the exact owned current-to-pinned-release chain and complete alias
inventory crossjoin. Forty pure tests/nine syntax checks pass. Root reads the
actual alias collector/verifier and review, independently matches13 current
and13 preserved version1 members and original prior manifest. Frozen F
controls remain failed; fresh link observations are not historical proof.

Root dispatches complete offline assembly in the new same-depth
lifecycle-diagnostic-preparation only: frozen top-level harness/config/tests,
exact seven-file overlay mapping, revised complete source/readiness pins and
Framework App interpreter identity. No fixture reset, auth/profile/trust/native
or service operation is authorized. Integration review must precede a concrete
new launch proposal; the original batch remains ended. X diagnostic version2
has matching11 root-checked manifest members and is independently under review
for the three direct cleanup identity paths.

### Ticket 24: complete-candidate integration and X overlay accepted (2026-10-02)

F/C/T integrated tests retain80 original/diagnostic cases and expose expected
fixture-schema/UID/structured-error assertions needing migration. An actual
malformed controllerIdentity=None also reveals an AttributeError before the
existing typed controller guard. Root authorizes a narrow integration-only
type-validation correction, retaining ValueError/KeyError rejection and strict
alias validation. The accepted overlay and original frozen harness stay unchanged;
record the small delta separately and re-review the complete candidate.

X diagnostic version2 passes independent affected review
77a26f34dd57698feda8dbb8d076cd3c1f54ddf0094bd08768eae092a63404c2:
14 pure tests/five syntax checks, all current11/prior11/frozen40 records match.
Root reads actual direct identity-path changes/helper and matches11 current
manifest members. Complete offline assembly is dispatched only into new
exit-preparation/instrumented-runner-diagnostic with repinned imports/readiness.
No fixture, credentials, trust, process surveys, native clients or services are
authorized; normal native alias applicability must be reported, not assumed.
Both complete candidates require independent integration review and distinct
fresh live approval. No product change or lifecycle qualification follows.

### Ticket 24: complete F/C/T diagnostic candidate accepted offline (2026-10-02)

Independent integration review Pass
f5ac332d5975a7192a26da46e902ab7a002eff4081029e2079e92035d5b7fadb
accepts all81 tests, unchanged original40/diagnostic40 plus typed-negative1,
14 syntax checks,23 import joins and both configs. Root inspects the actual
report and three-line guard delta, independently matches36 artifact members
and423 current source/binary hashes. Frozen420/F47 remain unchanged. Prepared
F/C/T425-pin manifests each add only two explicit future fixture expectations;
current fixture readiness and live qualification are not claimed.

Root prepares the concrete new FCT-DIAGNOSTIC-LIVE-PROPOSAL.md with distinct
absent -before-F/C/T-diagnostic1-oct02 archive paths, original whole-fixture
preservation, fresh private profiles/auth/service/native trust and one attempt
per mode. The earlier failed batch cannot authorize this run. Bounded proposal
review is dispatched; no reset, credentials, trust or native execution occurs.
X complete diagnostic source candidate is separately under independent review;
its reported alias/comm admission risk remains source-only and unmodified.

### Ticket 24: fresh diagnostic batch proposal accepted; approval pending (2026-10-02)

Independent proposal review Pass
f76c314562c8553416fad73758b04dcd719e963b06a131c862ed3474769efdee
accepts proposal SHA b0105aef65f64af7e9a80dc88a05578630ea407b0a2b484bdf0c875828423a14.
Root reads the actual review and requests explicit fresh F/C/T batch approval.
The earlier unexpected-failure stop ended its single-attempt authority. Silence
is not approval; no fixture reset, auth copy, trust action or native/service
launch occurs. The single-B question remains separately unanswered and no B
case has run. X independent full-candidate review is continuing offline; its
actual backend-selection source is under a pure two-role counterexample check.
The active goal remains incomplete, with no pause request or live resources.

### Ticket 24: X full-candidate selector correction required (2026-10-02)

Independent complete X review Changes required
fe250a57e7f66127bbf5e016877e4c9e80f271afa12b5e65f74ca2f2520caf0d
reproduces the actual backend_pins AST rejecting the archived legitimate
managed-server plus pid-update-loop topology; one-record control passes. This
is a generated current survey using earlier real role records, not historical
F cause proof or false caller acceptance. All48 tests,20 Python/four Node syntax
checks and427 actual source hashes match. Actual frozen X baseline is
manifest-v2.json40; historical manifest.json33 is preserved, with no drift.

Root reads actual selector and review and dispatches a bounded offline
role-selection candidate into new same-depth instrumented-runner-role. Keep
one unique actual server for caller policy and both proven-owned roles for
cleanup, retain strict path/hash/UID/start/executable guards and typed rejection
of ambiguity/race/foreign/unknown roles. Preserve original candidate41 and all
earlier evidence; no general alias normalization or mutable FCT import. Every
original48 test remains. No real process survey, credentials/profile/fixture,
services, trust, native/model or network work is authorized. Fresh F/C/T
approval remains pending independently; no native case is active.

### Ticket 24: role candidate original counterexample fixed; partial cleanup gap (2026-10-02)

Root reads the actual role helper, driver and independent review
28df7e077e882f024b91643deb2d82ebd50d99527108d7bdfa37bfd892562b2a,
and independently matches44 candidate artifacts plus429 current source hashes.
The original two-role topology now selects only the managed server for policy
and retains both roles after successful selection. All57 tests pass.

Independent actual-driver AST reproduction finds a valid-server then unknown-role
row loses the earlier proven lease before select returns: ValueError, empty
cleanup memory and no artifact. Driver/parent daemon cleanup then have no
recorded target. This is prospective harness coverage, not a proved live leak.
Root requests bounded version2 correction with original44 preserved: retain
individually proven roles before later validation/cardinality/publication failure,
never adopt rejected/foreign/raced rows or return caller-policy success. Test
actual partial cleanup, publication failure and unchanged typed guard failures.
The literal metadata/role timing and residual race must remain accurate.
No provider/profile/auth/fixture/process/service operation is authorized.

This goal continuation makes progress through the source counterexample and
affected review/remediation; the previous turn likewise progressed through
accepted full F/C/T integration and concrete proposal. Fresh F/C/T approval
and separately pending B approval remain unanswered. No native case is live.

### Ticket 24: role-v2 partial retention fixed; parent proof/survey corrections (2026-10-02)

Independent affected reviewae8922d394ee3620af6312b36c983cd298bc898f5b17fc4220285cbe9cde5885
confirms per-row retention fixes the actual partial-lease counterexample and
final metadata brackets both role reads, with residual OS races explicit. All61
tests pass. Actual parent AST cases still show malformed status skips known
cleanup, truthy string selectionComplete is accepted and symlink status is
followed. Another actual driver case rejects300 unrelated processes plus two
valid scoped roles because the new bound precedes PROFILE filtering. These
are prospective harness gaps, not live/provider or product-failure claims.

Root reads the actual review and authorizes only bounded version3 corrections:
private bounded nofollow typed readers for both status/leases; invalid status
cannot skip independently validated known cleanup or claim complete absence;
invalid leases cannot authorize signals. Scope the count limit after PROFILE
filtering while retaining whole-input byte bound and all admission guards.
Preserve role-v2 all45 and earlier snapshots, every prior61 criterion, exact
production/caller/signal/lifecycle behavior and fresh approval boundaries.
No native tests, processes, services, credentials, profiles or fixture resets
are authorized. Fresh F/C/T and separate B approvals remain pending.

### Ticket 24: role-v3 review and actual publication mismatch (2026-10-02)

Root inspects the frozen v3 source and matches all46 artifact members,35 local
and394 reused external pins. Independent affected review is active; all68
pure tests reportedly pass. Both root and reviewer identify the actual terminal
outcome writer still using Path.write_text while the new parent reader requires
a private file. Ordinary umask022 can produce0644 and reject a valid outcome;
tests instead seeded0600 using the private writer. Actual freeze-path
reproduction and bounded correction are required before X live eligibility.
No native/process/profile/auth/service operation ran.

The received approval reply names the original FCT-LIVE-PROPOSAL batch. Its F
startup attempt and unexpected-failure stop are retained; that batch authority
is already consumed. The separately reviewed corrected diagnostic batch has
a fresh explicit approval request pending. No new F/C/T or B case is started.

Independent v3 review Changes required
d4f12475d49eb4dc5ae784652e0f075998fe1e6084af283689408f34094d215d
reproduces actual freeze producing0644 under022 inside0700, then the actual
private reader rejects it. Prior three findings are corrected; no reader
weakening is accepted. Root reads the review and dispatches bounded v4: preserve
all46 v3 artifacts, privately publish the actual terminal outcome through the
existing atomic writer, test actual freeze-to-reader and affected failure
finalization, preserve all68 criteria and native/product boundaries. No live
authority or full ticket completion follows.

### Ticket 24: role-v4 accepted offline; exit proposal and IDE controller (2026-10-02)

Independent affected review Pass
0d4c272a475dfa0f8e6dee6978f3f85b186598f3ab8a6dd58c743eba6122a747
accepts the actual private atomic terminal-outcome writer and reader contract.
All70 tests and23 in-memory compilation checks pass; original68 assertion ASTs
are retained. Root reads actual sources/delta/review, independently reproduces
the two finalizer regressions and matches48 artifacts plus430 actual source
hashes. Prior46/45/44/41/11/X40 remain preserved. No live X proof follows.

Root prepares X-ROLE-LIVE-PROPOSAL.md with exact v4/config/readiness/native/model
and framework invocation, fresh whole-fixture archive, previous-case cleanup
gate, private auth/services/folder/per-entry hook trust, one attempt and actual
pending-exit lifecycle requirements. Independent proposal review is dispatched;
no X approval request or operation has occurred. F/C/T fresh approval remains
pending, and the unparseable user message grants no authority.

Bounded independent offline IDE controller preparation is delegated into a new
frontend-controller-preparation directory, using accepted installed-source
isolation evidence and no mutable lifecycle-candidate imports. It must supply
concrete nonlaunch helpers/tests and distinct frontend gates, not claim source
preparation proves UI/backend/auth/IPC inheritance or mode qualification.
No profile, credential, socket, process, frontend, service or network operation
is authorized. This goal continuation progresses through corrected source,
actual affected regressions, accepted independent review and concrete proposals.
The preceding goal turn progressed through the actual writer mismatch and
bounded correction. No overall completion or blocked claim is made.

Independent X proposal review Pass
71b2c6daafd4471b7426a47a7b3d363e60060a9e217bd7594ebeb36c89b3ccc3
accepts proposal SHA
ef5d975272d043e69cb6675d41bac25cda041fd9562b93fbb6803a1000654bda
for a scoped approval request only. Root reads the actual review. No scope gate
is missing; archive absence is metadata-only and must be rechecked after approval.
X remains unrun and no extra approval question is issued while the corrected
F/C/T question is pending. Actual SessionEnd/helper retirement, timing, absence
window and cleanup remain required live evidence. No product architecture
changed in these harness corrections or proposal preparation.

### Ticket 24: IDE controller timing contract corrected during preparation (2026-10-02)

Root reads the actual draft nonlaunch predicates. Its initial sorted stage order
incorrectly requires durable completion after Stop delivery/model answer and
work before PostToolUse binding. Root requests the actual-event partial order;
the current source now requires pending before useful work, useful work before
genuine completion and completion before Stop/HookPrompt/model use, while
artifact collection order stays separate. Author reports17 pure checks passing;
the candidate is not frozen or accepted yet.

Root also asks for source reconciliation of mandatory connected IPC: a stdio
IDE should not inherit an unnecessary Desktop/router prerequisite merely to
prove isolation. Foreign/shared sockets must remain excluded; whether owned
connection or observed absence is appropriate must follow actual installed
source. Backend credential behavior from startup stays a distinct gate from
VS Code in-memory frontend SecretStorage. No live operation or new authority
follows. Previous goal continuation made concrete progress through role-v4
regressions/review and the accepted single-X proposal. This continuation
continues a confirmed running worker and changes the draft's incorrect timing
requirement; no global blocked or completion claim applies.

### Ticket 24: IDE launcher/tree pins accepted; controller UID join required (2026-10-02)

The frozen seven-file launcher inventory is accepted as read-only preparation.
Root reads the actual launcher/scanner/report and independently checks its exact
19,408-entry path set, every19,297 regular-file hash (823,164,753 bytes), all six
launcher pins and seven artifact members. No mismatches; verification handle
48857 exits0. ROOT-FRONTEND-LAUNCH-PINS-REVIEW.json records scope and limits.
Actual launcher chooses MacOS/Code; inherited remote/Node selectors must not
reach a future launch. Neither inventory nor metadata proves active selection,
copy integrity, ancestry, inherited environment, auth/trust or native delivery.
No installed code, frontend, auth or network operation ran.

Root reproduces all18 pure controller tests and matches seven artifacts/14
evidence pins. Independent controller review Changes required
56047393a0e00ca5a12b62d1785f3a95d0f9ac73973726a07456e8b1d8842904
finds controllerUID501/directories501 with root/treeUID502 accepted when IPC
candidates are absent. Root reads actual review and dispatches bounded v2:
preserve all7 and manifest, join all admitted process UIDs to controller UID
independently of IPC, add absent/connected negative controls, preserve all18
assertions. No broader controller/launch authority or product change follows.
Actual frontends and remaining native CLI lifecycle cases remain unqualified.

### Ticket 24: IDE UID correction accepted; bounded discovery coordinator (2026-10-02)

Independent affected controller review Pass
623dd621f37479f8972b553c6f02127a142867e789e3af2da289fe631e3a0f67
accepts the three-line UID join. All19 tests pass; original18 method/assertion
ASTs are unchanged. Root reads actual delta/review, reproduces the eight-case
ownership regression and matches all18 current artifacts. Prior seven members
and original manifest remain byte-exact. This accepts only supplied-fact
predicates, not observed frontend ownership or launch readiness.

Root separately authorizes bounded frontend-discovery-preparation source-only
creation/admission/independent-cleanup ports. Pinned macOS CLI uses
LaunchServices; its complete branch explicitly forwards environment with
--env, so env:{} for open is not evidence of lost private environment. Main.js
argument handling supplies source support for a prospective direct pinned
MacOS/Code GUI invocation and private arguments, avoiding invented CLI-to-GUI
parentage. Actual startup remains unproved.

New nine-member candidate reports18 generated tests and three in-memory
compiles; new inert discovery.toml disables Koed MCP and contains no hooks.
Original configs and product remain untouched. Real creation/sampling, private
allocation, effective-auth observations, UI, raw decoder and live cleanup
qualification remain unwired/unproved. Independent review is dispatched; no
launch or qualification verdict is accepted yet. The corrected F/C/T approval
remains pending, and no native/frontend/credential operation is started.

### Ticket 24: discovery source review requires partial coverage and sink corrections (2026-10-02)

Root reads actual discovery coordinator/source report and independent review
0dd7e8428a0d2c557addd0069de196d107b922193381e43f2cae4891a2b56a5e.
Generated actual run root100/valid anchored101/later foreign102 rejects before
retaining101, cleans/checks only100, and reports completeAbsence true with101
still present. Primary ValueError is retained; no whole-case false pass or real
process is claimed. A separate actual function probe shows publisher return
value reaches freeze before result stripping. All18 tests/three compiles/nine
artifacts/ten pins match, but source acceptance remains Changes required.

Root authorizes bounded v2 preserving all9/original manifest: retain safely
proved partial rows, never rejected/foreign rows, and explicitly keep full
absence incomplete when discovery coverage is unresolved. Discard sink return
values before any later sink; retain static status/errors and independent
finalization. All18 methods remain. Four original full-absence expectations
require documented True-to-False correction for incomplete sampling/publication
paths, with independent known-PID absence assertions and genuinely accepted
positive full-absence controls retained. Author changed the final two before
requesting confirmation despite the prior instruction; root explicitly approves
that identified pair after reviewing their conditions, with no broader change
authorized. Historical tests remain byte-exact in prior-v1. No live operation,
OS port wiring, mode acceptance or product architecture change is authorized.

This goal turn makes concrete progress through independent controller acceptance,
full installed-file verification, prospective direct GUI source support and
actual coordinator counterexamples/remediation. Previous goal turn progressed
through timing/IPC source corrections and a confirmed running worker. Fresh
F/C/T approval remains pending; the objective is active and incomplete.

### Ticket 24: discovery revision 2 accepted for offline scope (2026-10-02)

Root reads the actual revision patch, expectation mapping and independent Pass
report a00a1139999849fd31afe613d9d6443fd8a06dcfe0628c2a8eb06f3dcf63b6ce.
Root matches all22 frozen members and reproduces the three affected regressions:
attributable child retention before foreign rejection, incomplete discovery
coverage, and publisher/freezer return containment. Independent review reports
all21 pure tests and three in-memory compiles passing. Preserved prior evidence,
unchanged creation/configuration contract and the four explicitly approved
stronger expectation corrections remain documented.

Acceptance is bounded to injected source-only ports. Actual frontend creation,
process observation, private allocation, authorization observations, UI, raw
artifact decoding and live cleanup remain unproved/unwired. Ticket24 is still
incomplete. No native/frontend/credential operation or new live test started;
fresh corrected F/C/T approval remains pending. The latest uninterpretable User
message is not treated as approval. No product or architecture change follows
from this acceptance; this entry updates investigation progress only.

### Ticket 24: concrete frontend OS adapter preparation dispatched (2026-10-02)

The previous goal turn made progress by accepting the independently reviewed
discovery correction, reproducing its three affected regressions and verifying
all22 artifact hashes. Root now delegates a bounded sibling source-only macOS
creation/observation/signal/reap adapter implementation. Generated low-level
ports must validate actual executable identity, start time, ownership, ancestry
and immediate signal fences, retain creation handles across inspection failure,
and expose incomplete coverage and residual OS races. Default OS implementations
may be written but must not execute during preparation. No generic PID adoption,
group signals, profile/auth allocation, live surveys, native/frontend startup or
trust changes are authorised. Existing artifacts remain preserved.

A separate read-only coverage reconciliation compares current user-facing and
completion-audit claims against accepted versus still-unrun evidence. Both
workers have explicit bounded ownership; root retains ticket/PLAN writing. The
corrected F/C/T question remains pending. This preparation advances remaining
qualification prerequisites without asserting live mode support or completion.

### Ticket 24: OS port draft integration boundary identified (2026-10-02)

Both preparation workers are confirmed running, so the preceding turn includes
a verified wait as well as bounded dispatch/progress recording. Root reads the
actual os_ports.py draft: its record-based signal signature differs from the
accepted coordinator PID/TERM port, and separate lease registries need an
explicit bridge. Survey complete/errors must propagate through that bridge;
passing only successful rows could falsely turn incomplete discovery into full
coverage. Root requests actual generated bridge integration tests before freeze,
plus consideration of metadata-first ancestry selection to avoid hashing every
unrelated system executable. This is draft review, not a failing frozen verdict
or any live observation. No OS port implementation is invoked. The current
source-only worker continues; credentials, frontends and live tests stay untouched.

### Ticket 24: dated coverage addendum accepted; OS adapters under review (2026-10-02)

Root reads the coverage review and matches its two frozen members and source
references, apart from the independently evolving ticket progress record. Root
preserves the original audit files and writes CURRENT-COVERAGE-ADDENDUM.md.
Independent supplemental review Pass37419e2ce580822e3dc0b040d61a0e2b4897d839497436ff83350ec1f7137a09
accepts its distinction between proved normal/R/E behavior, failed preprompt F,
reviewed unrun preparations and source-only frontend prerequisites. User-facing
async-memory and Codex integration docs need no correction from this review.

The new concrete OS candidate freezes15 members under manifest
8c566e98571b065bff97f20f166ddc175639981782cfa16ed6370257ce3f46ea.
Root inspects the actual code/report/mapping, matches all15 hashes and reproduces
all16 generated tests. CoordinatorMapping reconciles both lease registries and
propagates incomplete scope. Survey hashes only ancestry-selected executables.
No real low-level function executes. Independent affected review is dispatched
in a separate directory. ABI/runtime behavior, actual creation and residual
PID-check-to-signal races remain explicit limits. Allocation, authentication, UI,
raw decoder and resource persistence/cleanup still require concrete evidence.
This is preparation, not live frontend acceptance. Ticket24 and the full goal
stay incomplete. Fresh corrected F/C/T approval remains pending.

### Ticket 24: private resource and persistence ports prepared independently (2026-10-02)

The preceding turn makes concrete progress through root OS candidate checks and
accepted supplemental coverage documentation. Independent OS review is confirmed
running. Root separately delegates bounded source-only resource ownership and
sanitized persistence callbacks, which depend on the accepted discovery envelope
rather than the OS candidate under review. Only generated test resources can be
created in the new owned preparation directory. Callable allocation/cleanup
definitions must refuse preexisting or replaced/foreign paths, retain partial
ownership and report independent failures. Durable publication/freeze must
restrict schemas and exclude raw auth, arbitrary payloads and error messages.

No actual future profile, extension copy, auth, Keychain, socket, GUI, process,
service, native/model request, trust or fixture operation is authorised. This
work closes concrete runner prerequisites without claiming allocation approval
or live delivery. Existing evidence, original criteria and the pending corrected
F/C/T question remain unchanged.

### Ticket 24: OS admission counterexamples require remediation (2026-10-02)

Independent review identifies two actual generated-function counterexamples.
Root independently reproduces both against the frozen candidate: numeric PID
ordering admits allowed child101 through foreign parent150 before rejecting that
parent, and a repeat survey overwrites child101's historical start identity.
Direct OS-port fake signalling then accepts those improper leases. The mapping
rejects the unanchored child but cannot include its separate OS lease in cleanup
history. These are test-runner defects, not real process or product observations.

Root dispatches bounded remediation to an existing separate worker in a new
sibling directory. The original15 members/manifest and all16 tests/assertions
must remain byte-exact. Validated ancestor-first admission and immutable
historical leases must preserve safe partial cleanup and incomplete coverage,
with generated regressions exercising actual mapping. No ABI/creation/resource
contract widening or real OS operation is authorised. Private-resource/persistence
preparation continues separately. OS candidate acceptance remains Changes
required until remediation passes independent affected review. The goal stays
active and incomplete, with fresh corrected F/C/T approval still pending.

### Ticket 24: frozen OS findings and compiled declaration proof (2026-10-02)

Root reads the frozen independent Changes required report
396ad824ae0f5e024050b57501047b4108f264a9a80d434618ac3ced4e833a33
and matches its five manifest members. The remediation worker receives this
exact review, with no accepted ownership exception or criterion relaxation.
The preceding turn made concrete progress by reproducing both counterexamples
and dispatching bounded corrections. Three current workers are confirmed live.

Root independently compiles nine static assertions against local pinned macOS
SDK headers with Clang arm64 syntax-only compilation. Exit0, no diagnostics,
no executable output or libproc query. The declared136-byte structure,120/128
start offsets,4-byte UID/GID, selectors and bounds match proposed ctypes.
frontend-abi-compile-review preserves source/checks/three-member manifest and
seven relevant header pins. This proves compiled declarations only, not live
kernel ABI, process ownership, runtime behavior or frontend delivery. Independent
affected declaration review is dispatched separately. Resource preparation and
ownership remediation remain active; no new live authority is inferred.

### Ticket 24: resource callbacks under review; OS remediation returned (2026-10-02)

Root reads supplemental ABI Pass77294e808acfba158732bcf1f267e2db5c9b99ff861194246e56a60dc9390426
and matches the unchanged original declaration artifacts. Its independent compiler
reproduction accepts declarations only. It does not qualify runtime ownership.

Resource preparation freezes seven members under
a5e9a7df2bbb46a53ba09e5c43f17dc790682335f0b0790acafe465feac8003b.
Root reads actual175-line callback source/report, matches all7 hashes and
reproduces15 injected-memory filesystem tests. Independent review is running.
RealFS/libc remain uninvoked, with no future profile or credential allocation.

OS remediation returns a separate26-member candidate manifest
e5c050bc18b655894e44e2b5a19583fa42089a03e30ad4ae5134c4171634c82a.
Root reads its exact delta/report: validated parents gate child eligibility,
first identity remains immutable, and independent finalization retains safely
proved OS leases for coordinator cleanup. Author reports25 generated tests
including16 unchanged originals. This candidate awaits independent affected
review; no acceptance or live mode claim follows from the author's result.
The original OS candidate and its failed verdict stay preserved.

### Ticket 24: resource publication ancestor fence requires correction (2026-10-02)

The independent resource reviewer confirms that publication guards the root and
file descriptor/path but omits its owning evidence directory after creation.
Root reproduces actual Persistence.publish with injected FS.write replacing
only that directory's path identity: publication returns success and records an
artifact in the detached old directory. No real filesystem action occurs.

Root dispatches bounded sibling remediation preserving all7 original members,
the manifest and15 original test/assertions. Retained exact ancestor descriptor
and path checks must cover publication, rename, read/freeze and cleanup. A
replaced directory must produce explicit failure without deleting foreign paths
or discarding safe partial ownership. Residual races remain documented. No
resource/auth/controller scope widening or real low-level call is authorised.
Independent review continues to freeze its original finding; OS remediation
already returned and awaits affected independent review. Goal progress consists
of actual failure reproduction and concrete corrections, not a passing live
claim. The original pending corrected F/C/T question remains unanswered.

### Ticket 24: affected remediation checks and active review checkpoint (2026-10-02)

Root reads the frozen resource Changes required report
0d0368863c887f23822ad4e3886a97d72a2cdfc0cf3d7375ffa04b4586bc7338
and matches all4 review members. Its actual directory-ancestry finding agrees
with root's independently reproduced publication defect. Aggregate cleanup
remains false and no real foreign deletion is claimed. Remediation is active.

Root matches all26 OS remediation members and reproduces all25 generated
regressions, including the16 byte-exact original methods. Independent affected
review remains running. The previous goal turn changed authoritative evidence
through resource reproduction, bounded remediation and exact review dispatch.
The current turn adds actual root checks. Neither author tests nor root checks
replace required independent acceptance or live mode evidence. No owned live
frontend/test resource exists; pending corrected F/C/T authority stays unchanged.

### Ticket 24: OS correction accepted offline; resource correction under review (2026-10-02)

Root reads actual independent OS Pass report
f2e687de356347620169526727e0a5dfa3a93645483dcfa5178e76c4e2541e4e
and matches its four frozen members. Independent25 candidate+3 actual-function
probes confirm foreign-ancestor exclusion, immutable reused identity and valid
partial cleanup transfer while failure coverage remains false. Root already
inspected the exact delta and reproduced25 regressions/all26 candidate hashes.
The two source-admission defects are accepted as corrected within this bounded
stage. Live ABI, observation, GUI and cleanup remain unqualified.

Resource author returns separate17-member manifest
0495896f3b9233c422e8b3567559c2adc7bc55151c27764bc95b2edb524aea0d,
reportd0319eded59bfc37758268d66fc696b893fc1842f02e43f82505613928cb8a7d.
All15 originals are retained with six new generated ancestor-race tests. The
independent affected review is dispatched. Original failed resource candidate
and review stay preserved. No real low-level resource or frontend operation
occurs, and no mode/setup/lifecycle acceptance box changes.

### Ticket 24: resource correction accepted; concrete combined ports integration (2026-10-02)

Root reads independent resource Pass37d734c9f5005383c880b691a78b93c9ad80024df3f6f61dc259ff20b78f2ef9,
inspects the exact revision/mapping, matches17 candidate/four review members and
reproduces21 generated tests. All15 original methods remain unchanged. This
accepts retained directory ancestry at checked source boundaries only; real
filesystem and postcheck races remain unqualified.

With both OS and resource prerequisites accepted, root delegates small bounded
source-only controller integration using byte-exact modules and actual combined
in-memory ports. The deliverable must retain exact allowlists/stages, known PID
cleanup, survey uncertainty and independent failure finalization. Fixture
cleanup cannot destroy evidence before freezing. If the fixed-root contract
prevents separate resource lifetimes, report that actual conflict rather than
inventing allocation authority or silently skipping cleanup/persistence. No
new executor, UI/auth/copy/decoder approximation or default OS/allocation run
is authorised. The previous goal turn and this turn make concrete progress
through accepted root/independent corrections and their prerequisite integration.
Live tests and mode qualification remain incomplete; pending authority unchanged.

### Ticket 24: combined resource lifetimes expose a concrete prerequisite (2026-10-02)

The integration author reads accepted Ledger's actual constructor/allocation:
both fixture and evidence require contract.ROOT, while exclusive allocation
rejects the second ledger. Distinct synthetic filesystem namespaces cannot
establish constructible independent lifetimes. Root stops that substitution and
requests a frozen minimal assembly checkpoint instead. No callback tests or
scope claims are accepted as resolving this conflict.

Root authorises a bounded source-only policy variant in a new sibling: explicit
fixture role retains the existing exact root, evidence role permits only that
root plus the literal -evidence suffix. Caller preapproval/UID, exclusivity,
private ownership and descriptor/ancestor guards remain required. No arbitrary
root/inherited adoption or actual allocation follows. Original21 tests and17
accepted members/manifest must remain byte-exact; new tests must use both
actual ledgers on one injected-memory filesystem and prove fixture cleanup
leaves evidence available for independent freeze. This prerequisite requires
independent review before combined integration resumes. The new expected path
is prospective proposal data, not live authority. No product/executor, auth,
frontend, profile or trust change occurs. The full criteria remain incomplete.

### Ticket 24: two-root lifetime variant returned for independent review (2026-10-02)

The preceding turn makes concrete progress through accepted resource correction
and actual lifetime conflict detection. Root matches all10 blocked-assembly
checkpoint artifacts and reads its refusal before callbacks. This historical
checkpoint does not qualify combined operation.

Lifetime variant freezes26 members under manifest
35045391b7332c0fdcbca7593834b26df4673eee55c3c82c9cb0e8303472a98c.
Root reads the exact delta/report, matches all26 hashes and reproduces seven
affected tests. Author reports28 tests including21 unchanged originals. One
injected filesystem supports exclusive fixture and evidence roots, with actual
freeze after fixture cleanup. Role/path checks restrict the variant to the
existing root and literal -evidence sibling. Separate evidence cleanup requires
explicit caller request and export/review attestations, not inferred success
or User approval. No live allocation follows from either flag.

Independent bounded lifetime review is dispatched. Existing private/exclusive
ancestor checks and original policies remain preserved. Integration can resume
only after that review accepts the prerequisite. Actual allocation/copy/auth,
frontend startup/trust, decoder and mode/lifecycle qualification remain open.

### Ticket 24: lifetime prerequisite accepted; combined integration resumed (2026-10-02)

Root reads actual independent lifetime Pass
65774fed12528ccf1bb7142b43c69a878b4716fdf22a9b10ab3f499b5a78e26c
and matches all4 frozen review members. Root's earlier26 candidate hashes and
seven affected tests, plus independent28 candidate/three shared-FS actual probes,
accept the bounded two-lifetime source path. The prospective evidence root is
not an existing allocation grant. No live qualification follows.

Root resumes combined integration in a new v2 sibling, preserving the original
10-member blocked checkpoint. Byte-exact accepted process/resource/discovery
modules must connect actual generated ports on one filesystem, with caller-
supplied already-owned ledgers and explicit allowlists. Failure ordering must
retain survey uncertainty, partial PID inventory and independent freeze. The
controller must record safe fixture cleanup failure before the accepted observer
discards callback returns; a returned false cleanup result cannot count as
success. Evidence cleanup remains a separate lifetime. No UI/auth/copy/decoder
stubs supply missing evidence, and no default OS/profile/fixture allocation or
real low-level action is authorised. Previous goal turn made progress through
variant root checks; current turn accepts its independent prerequisite and
resumes the dependent implementation. Full objective remains incomplete.

### Ticket 24: combined controller frozen for independent acceptance (2026-10-02)

Combined v2 freezes12 members under manifest
9b848ea3ed16dba9bac288a4fee249a320d8f0d3a396018334845ea1bc86a69f,
report85d9879b62706dda38af3980da8b164b38f8a70365c68b3e22e016f3d84478c3.
Root reads actual Controller/report, matches all12 hashes and reproduces15
focused generated tests. Four accepted modules remain byte-exact, and the
original10-member blocked checkpoint remains preserved. Root's identified UID
interoperability join is now enforced for both ledgers and retained root/directory
observations before creation. One memory namespace uses distinct parent handles.

Combined tests exercise actual process/persistence callbacks, cleanup-before-
freeze lifetime, returned cleanup failure and simultaneous observer/finalization
failures. Static failure stages survive while arbitrary payloads remain excluded.
Independent affected review is dispatched; no source acceptance follows yet from
author/root tests alone. No actual low-level operation runs. Explicit missing
startup gates and liveReady=false preserve the distinction from frontend proof.
Previous goal turn accepts the lifetime prerequisite; current turn adds genuine
combined checks and review dispatch, leaving full criteria and approvals intact.

### Ticket 24: combined diagnostic exception-name boundary requires correction (2026-10-02)

Root reads independent Changes required report
aedfbb98aeb1083fbd1fbf883168f4449f53bf0fb73dbf2e3becf81ed2d85312
and matches all4 review artifacts. Actual metadata/publisher custom class names
reach returned diagnostics; a custom filesystem write error during final freeze
enters the available manifest. Root independently reproduces metadata/output
and final-write/manifest paths. Messages remain excluded, failure remains
visible, and successful all-available freezing after a failed final publication
retains its intentional semantics. No actual disclosure or live operation occurs.

Root dispatches bounded v3 in a new sibling preserving all12 v2 members/manifest,
15 original tests and four byte-exact accepted modules. Static exception
boundaries must precede accepted callback catches for both OS and filesystem
ports; output-only normalization cannot fix persisted class names. Primary
error/failure ordering, handle retention, ownership/UID, evidence lifetimes and
independent cleanup/freeze must remain intact. Arbitrary names/messages must
not enter returned or retained available evidence. No API/path/auth/executor
scope widening or real low-level call is authorised. Overall criteria remain
incomplete and pending live authority is unchanged.

### Ticket 24: combined exception boundary frozen for affected review (2026-10-02)

V3 freezes27 members under manifest
6cf4de933027104cf5c4444a00cb8f4de059df3dc4ace5d0a38b4fa53fb842dd,
report5555c9eb8592e4e9aa5c2e375070b97c0fdb5a6911b7b834971253e3961b8102.
Root reads actual boundary/composition/report, matches all27 hashes and
reproduces23 generated tests. Four accepted modules and original15 methods
remain byte-exact; original12 v2 members/manifest stay preserved.

Process/filesystem/coordinator failures receive fixed replacement classes
before accepted internal catches save names. One adapter preserves the same
underlying filesystem/descriptors, and process handles/leases stay unchanged.
Final diagnostic normalization supplements rather than replaces persistence
protection. Unknown metadata/publisher/write/read/cleanup/reap names and messages
are checked against output and all available file bytes. Actual static failures
and intentional all-available freeze semantics remain visible. No real callback
or low-level operation runs. Independent affected review is dispatched.

Previous goal turn made progress through actual two-path reproduction and
bounded remediation. Current turn confirms the active worker, reads its actual
code and tests the returned candidate. Source acceptance and full frontend
qualification remain unproven pending review and separately authorised live
gates. No release decision, mode checkbox or approval scope changes.

### Ticket 24: combined diagnostic boundary accepted offline (2026-10-02)

Root reads frozen independent V3 Pass report
a446c38d46ec9bdb6c2b48aa549863dad0a1b5ecf943cd037177fa4a2ccdcc88
and matches all4 review members. Root's earlier27 candidate hashes and23
generated checks, plus independent six actual-function probes, accept the
bounded source correction. Unknown names/messages are excluded before copied
modules catch process/filesystem errors and save diagnostics, with an additional
final-output safeguard. Spoofed-name/subclass and late callback controls pass.
Primary failure stages, handle/lease ownership, resource lifetimes and intentional
all-available freeze semantics remain intact. Original15 tests and four accepted
module copies stay byte-exact.

This accepts combined supplied-port composition only. No real startup, root
allocation/copy/readiness, backend account access, environment/IPC inheritance,
UI trust, raw decoder, native memory recall or frontend delivery is proved.
The liveReady=false/missingStartupGates record and original mode criteria remain
unchanged. Corrected CLI F/C/T authorization is still pending. No provider/mode
acceptance checkbox changes, no product/executor or release change follows, and
the full standalone objective remains active and incomplete.

### Ticket 24: next eligible offline discovery setup (2026-10-02)

Root reads the independent next-step audit and verifies both members under
manifest7376faea47e9eb722ba7cd33a6a544181e0bfdf3489c611cb2d33a67bf337bf2.
A finite prerequisite remains: concrete isolated IDE discovery setup and bounded
selected-extension copy/cleanup source. Accepted composition requires allocated
ledgers, while the installed inventory does not implement copying. This does
not establish a global impasse or qualify any frontend mode.

Bounded source-only preparation is dispatched to codex_followup_preflight in
frontend-discovery-setup-preparation, with injected memory tests, exact separate
fixture/evidence lifetimes, disabled MCP/no hooks, preserved accepted modules and
explicit partial cleanup. No real allocation, copying, startup, authentication,
trust or process callback is permitted. Root remains the progress writer.
Corrected CLI F/C/T and B requests remain pending; X remains unrequested.
No acceptance checkbox, approval scope, release decision or product behavior
changes. A concrete setup candidate and scoped discovery proposal require review.

The setup author identifies concrete API limits before changing source: artifact
Ledger.capture requires0600 and retains each file descriptor; atomic_json is
restricted to small generated evidence. Root authorises a separately reviewed
source-only copied-tree journal under the owned fixture extensions leaf, with
bounded streaming, intentional0700 executable/directory modes, per-entry
ownership checks, closed regular-file handles and cleanup before fixture removal.
Accepted ledger/persistence modules remain byte-exact. No live operation or new
allocation authority follows from this source implementation choice.

### Ticket 24: discovery copy source checkpoint under review (2026-10-02)

The new copy_journal.py is present alongside accepted copied modules and disabled
discovery configuration. Root inspects actual source before candidate freeze and
requests corrections: source directories must close deepest first; final copy
verification must reopen and rehash content rather than trust saved hashes;
reopened cleanup descriptors must match recorded identity; streamed source
descriptor metadata must remain pinned. Generated actual-function regressions
are required. The author is still completing setup binding and small memory
ports/tests. Candidate is not accepted or ready for live execution. No real
copy, allocation, startup or credential operation has occurred.

Root revalidates the previous goal turn as progress: actual checkpoint inspection
changed the next source corrections and author implementation. Current state has
a live author and the setup binding plus12 generated checks, reproduced passing
by root. The strict selected-inventory entrypoint rejects wrong pins before
allocation, and the tests exercise actual combined-controller cleanup. This is
not a frozen verdict. Root also requires explicit inert real copy-port definitions
or a documented constructibility blocker, to avoid substituting a memory-only
implementation for a usable proposed setup route. No real copy port is invoked.

### Ticket 24: complete inventory parser and inert copy adapter (2026-10-02)

Root parses the actual retained7,962,385-byte extension manifest through the
new Inventory class:19,408 entries and823,164,753 regular bytes pass without
calling copy ports. Manifest SHA7d7d98d251772cde864bc7e4d826fb43bd6fb14f02a28520d31a0a2e201f5f79
matches the selected route constant. Six accepted source copies remain byte-exact.
The prior goal turn made progress by reproducing12 generated checks and requiring
a concrete real adapter definition; current source now includes that inert
adapter and additional checks. Root inspects its source without invoking it.

Author is completing finite installed helper pins and a discovery-only proposal.
The executable-map gate remains explicit; no GUI-only allowlist or generated
checks prove native process coverage. Candidate freeze and independent review
remain pending. No actual file copy, allocation, credential access or launch.

### Ticket 24: frozen discovery setup requires descriptor cleanup correction (2026-10-02)

Candidate freezes18 members under artifact-manifest
56f52788a17329efeeec6045223f9b2f1b1133f35f0a5d6ccdcf72b4d188b50a;
report88dfd880f0d1fbb529d6bae7e1ff027d44cfc2326e4ab4c018fe421a9bd93be1.
Root verifies all18 hashes and reproduces13 generated checks using the direct
pinned Python, with no real copy or filesystem adapter calls. Independent
source review is active in frontend-discovery-setup-review.

Reviewer finds, and root reproduces, changed source-root pathname identity
after owned descriptor acquisition: setup correctly fails and freezes evidence,
but pre-close source_guard prevents closing the retained source directory.
Memory probe leaves one source descriptor and one journal directory; cleanup
status is false. Real source-parent closure is similarly skipped while source
dirs remain. Source closure must be attempted independently of namespace/content
validation, preserving failure and forbidding deletion/adoption. Verdict is
Changes required pending complete frozen review and bounded remediation.

Full scope remains unchanged and incomplete. Five static helper candidates do
not prove native coverage; extension activation, workspace trust and backend
auth remain observed live gates. No fresh trust/allocation or launch grant follows.
The previous goal turn made source progress; current review and reproduction
change the next correction. No global impasse or completion is claimed.

### Ticket 24: descriptor correction frozen for affected review (2026-10-02)

Root reads original independent Changes-required report
06f767645d073e264c17fd6494fa35ce58bdf07c34d3b9b37defa8242fdb1f39
and verifies all five review members under manifest30baefc6fa1a9bd872a1ee88985881fa6aac4a42fec9363151be243776884193.
The separate remediation freezes41 members under artifact-manifest
438d704c4febdbb08de12223c48ee2940e6881396de122558b965254bd9d8660;
report74ea2cb02b1b537717afad581584406ff7bca3a1171cdaf2339402f98fa22a94.
Root matches all41 hashes, reads the actual corrected close_sources and report,
and reproduces all16 generated tests with pinned Framework Python.

Path/content audits still fail the outcome, but no longer suppress exact
factory-owned descriptor closure; directories close deepest/root-last, parent
finish runs independently, and close-failed handles remain for retry. Prior
18+manifest, original13 checks and accepted modules are preserved. Affected
independent review is dispatched in frontend-discovery-setup-remediation-review.
No source resource is deleted/adopted and no real adapter/native operation runs.
Live readiness, provider-mode criteria and all existing approval gates remain
unproved or unchanged. Ticket24 and the full standalone goal remain incomplete.

### Ticket 24: source closure accepted; native state cleanup remains unprepared (2026-10-02)

Root reads frozen affected Pass report
88d5c774dd58d8adc86b8af0dcd67d401b75f937863b29d8a762146bfd072957
and matches four review members under manifeste02461e4b285472f21676e7310b12eb57a9760b143037071f39b7d6d8820a643.
Prior root41 hashes/16 generated checks and independent five actual-function
probes accept the bounded descriptor correction. Path/metadata failures remain
failed, while closable factory-owned source handles and parent retire separately.
All original artifacts/accepted modules remain intact. This is source acceptance
only, not a native mode or live authority.

Root next-readiness probe creates one generated memory file in frontend-state
after preparation, then invokes the actual Combined Controller: aggregateOk
false and fixtureCleanup false, with generated file and fixture root retained.
The ledger intentionally cannot remove unregistered client-generated state.
No actual frontend write occurred. A bounded read-only eligibility audit is
dispatched to determine a concrete runtime-state cleanup/map prerequisite or
required scope decision, without inventing substitute qualification. Native
map coverage, activation, auth/IPC/trust and existing CLI approval gates remain.
Ticket24/full objective remain active and incomplete; no criteria are waived.

### Ticket 24: bounded runtime-state policy and map preparation eligible (2026-10-02)

Root reads NEXT-ELIGIBLE-WORK d4ae4657b9a7bcb900e9936d466c87d9a6e49f32c7dd65258a11e64525d28613
and matches four audit members under837c07fab40e5bbddabadf4ba356832bdb514c90def419ac2482156aaf0cbdae.
Audit reproduces the unregistered state counterexample and confirms a finite
offline prerequisite, without a normal-state ownership waiver: exact retained
runtime leaves, bounded nofollow metadata/removal policy and a provisional exact
executable map/proposal. Actual deletion, startup/account/socket scope still needs
its later explicit concrete approval. Native behavior remains unproved.

Author is dispatched in frontend-runtime-state-preparation only. Accepted modules
and prior tests stay unchanged; all execution is generated memory. Runtime
deletion requires fresh historical lease absence/full coverage, not supplied
drained booleans or root reap. A failed drain gate must inhibit all fixture
deletions, including static/copy entries, while independently retiring owned
local descriptors and freezing evidence. Unknown/reparented children and unknown
file types remain unresolved; source-only policy cannot prove global absence.
No actual FS/port/copy/launch/auth/native operation is authorised or performed.
The work stops at a finite reviewable policy/composition/proposal candidate.

### Ticket 24: runtime-state candidate has three reviewed source findings (2026-10-02)

Root reads independent Changes-required report
99c533ea08725697258adfde6e680a6c6e03b03e44d335b84bb520c3f46b386e
and verifies23 candidate plus4 review artifact members. Root reproduces all27
existing candidate checks and all3 independent memory counterexamples.
Candidate manifestaf843d99f46b454d4950e3b450670ce518551c78f91760745ee9d45bb5c64921;
review manifest00cb5cd54a145d1ab3aea6085bc26afb44082aa8af389a0da9762892b3a09dd5.

Late failed historical absence can resume runtime deletion on a later row; mutable
mode changes suppress same factory-object FD retirement; directory0600/0644
admission exceeds proposed0700/0755. Root additionally reproduces the unchanged
factory inode/mode-only FD case. Separate bounded remediation is dispatched in
frontend-runtime-state-remediation, preserving the original27 tests and all prior
artifacts. Strict pinned retained Setup binding must be explicit, without changing
accepted helper APIs or inventing another framework.

Author reports the three corrections and five additional generated controls
implemented; freeze/affected independent review pending. No real adapter or
resource operation runs. Scope, live readiness and original native/approval gates
remain unchanged. This turn makes source acceptance/reproduction/correction
progress; no global impasse or full completion is claimed.

### Ticket 24: runtime corrections frozen for affected review (2026-10-02)

Runtime remediation freezes50 members under
b858fda90a4ed5303d2f0956f2546c6b0a7b4fa5e71ba3f04c8599589cf3cab7;
report55b3ad461152c886cad98984f2b10603041922248dcfa0fc920831fe53bb326d.
Root matches all50 hashes, reads report/actual source delta, and reproduces all32
generated checks. Original27 assertions/accepted copies and prior23+manifest
remain preserved. Affected independent review is dispatched separately.

A permanent failed-drain latch inhibits every later deletion. Opened factory
object dev/inode/type fence genuine reuse; mutable UID/mode changes remain audit
errors but permit safe owned descriptor closure. Directory modes match the exact
proposed0700/0755 policy. A small strict pinned helper retains Setup/outcome for
the unchanged Controller/compose route; accepted dictionary helper stays unchanged.
All native/global/orphan/map/auth/account/socket and approval gates stay unproved.
No real adapter, profile, copy, deletion, launch, model or other live operation
occurs. Source review pending does not qualify any mode or complete the goal.

### Ticket 24: bounded runtime-state corrections accepted offline (2026-10-02)

Root reads frozen affected Pass report
6754cb28bd87f54742fa9b317d1c4211493873cb63c514af45d22240784a29bb
and matches four review members under742bcfe9f4f60b9d379b85fbee39c9eb68a4522737d8bd71463762095bc7977d.
Root50 candidate hashes/32 generated checks and independent three corrected
actual-function counterexamples accept only this source correction. Failed drain
stays latched; same factory-object mutable metadata does not suppress retirement;
genuine different objects stay withheld; directory policy remains exact. Strict
pin validation retains Setup for the unchanged controller/composition route.
All prior artifacts/assertions remain intact.

No native startup, global/orphan absence, executable-map completeness, effective
account/auth/network/IPC behavior or frontend memory delivery follows from this
source pass. The reviewed prospective scope retains those live dependencies and
safe unresolved fixture retention. Existing CLI F/C/T and B authorization requests
remain pending; X and discovery have no execution grant. No product behavior
changed in this preparation, so architecture documentation needs no new update;
investigation evidence/progress is retained. No mode/acceptance checkbox changes.
Full standalone objective and Ticket24 remain active and incomplete.

### Ticket 24: remaining execution boundary recheck (2026-10-02)

Root rechecks the actual Plan active-goal scope, all five Ticket24 criteria,
latest coverage addendum and corrected F/C/T/discovery proposals. The preceding
goal turn and this continuation make no implementation or qualification progress.
All three retained workers are terminal; there is no live operation to await.
Reviewed offline corrections are accepted, but the remaining lifecycle and mode
proofs require native execution. Corrected F/C/T and B requests remain unanswered;
X and frontend discovery have no execution grant. Discovery also retains explicit
startup/account/shared-facility observation gates, not an isolation claim.
No additional source framework, repeated passing check or limitation report can
satisfy those missing native criteria. Existing approval is not renewed by the
unparseable message or automatic goal continuation. This is the second consecutive
no-progress turn at this execution-authorization boundary; keep the goal active
and incomplete pending the blocked threshold or a human/external-state change.

### Ticket 24: persistent execution-authorization blocker (2026-10-02)

The third consecutive goal turn revalidates the same boundary: no new human
approval, all retained workers completed, and no confirmed live operation.
Corrected F/C/T and B approvals remain pending; exit and frontend discovery are
not granted. Required native lifecycle and separate mode evidence cannot be
replaced by further generated checks. All accepted implementation and offline
reviews are preserved; no acceptance criteria or mode claims change. Mark the
goal Blocked, not Complete or Paused. Resume from the exact reviewed proposal
after scoped approval, with fresh prerequisite and cleanup checks.

### Ticket 24: corrected diagnostic batch explicitly approved (2026-10-02)

The User replies Approved to the linked FCT-DIAGNOSTIC-LIVE-PROPOSAL. This grants
the exact corrected sequential F/C/T single-attempt batch, including reviewed
archive/reset, private auth copies, synthetic services and observed native
folder/hook trust. The old failure remains preserved; this is fresh authority,
not a retrospective renewal. B, X and frontend discovery remain outside scope.
The retained implementation worker is dispatched for current prerequisite checks
and F only, then must stop for root evidence/cleanup acceptance before C or T.
Unexpected failure ends the batch; no retry or weakened ownership controls.
Goal resumes active; full qualification and completion remain unproved.

### Ticket 24: corrected F startup failure stops the approved batch (2026-10-02)

Fresh preflight matched36 candidate/423 source pins/47 original failed-F artifacts;
prior19 PIDs were absent. The approved exclusive archival reset preserved the
old root and eight inert links;425 selected readiness pins matched before launch.
Single F session30279 exited1 at postmaster process observation, before runtime,
driver, native trust, prompt or Memory Answer acceptance. Owned PostgreSQL did
start and its unique-data fast-stop succeeded. C/T were not started; no retry.
The batch's unexpected-failure stop is enforced.

Original33 frozen failure artifacts remain unchanged. Supplementary38-member
manifest db0c1fbb5b141249c95159e9791ea29107abc116f9875ceb9f44cd1a13e5ffe3
retains actual owned PostgreSQL log and limited cleanup proof. Root matches all38
hashes and current normal hashes, verifies selected private state absent, and
independently observes recorded controller/database PIDs32661,32685,32686,32688,
32691 absent with targeted metadata-only ps exit1/no rows. No global historical
process-union absence claim follows from the runner's empty observation history.

Whole-system ps display text was parsed globally as shell argv. Generated tests
demonstrate unrelated quote rejection and balanced-quote argument mutation; fresh
post-failure sample has one metadata-pattern rejection, zero tokenization errors.
The historical offending row was not retained, so exact startup cause remains
unproved. This is failed harness evidence, not a failed memory-adapter verdict.
Independent evidence review is pending. A finite command-free metadata/lossless
owned-argv correction design is prepared; frozen evidence stays unchanged.
Full goal remains active/incomplete; further behavioral execution needs a new
reviewed scope and approval, not continued use of this ended batch.

### Ticket 24: startup evidence accepted; bounded observation correction (2026-10-02)

Root reads independent report3af2a12fd7ef9e80b963fdc183525de365230afc346348caa83243ae423ebed6
and matches four members under6f43daccb1acedb04dad2f261ee3df1c9cba1d44ff10c1ec32285f97c625f04f.
Limited later cleanup is accepted; F remains an unqualified startup failure,
historical process union and exact cause unproved. No C/T or retry occurs.
Root dispatches only finite offline process-observation remediation in a new
directory: strict complete command-free metadata plus source-backed lossless
arguments for relevant owned processes, generated counterexamples and preserved
identity/ownership/signal fences. SDK/primary source verification precedes ABI
implementation; no real process argument/environment query is authorised.
Frozen case/candidate/tests remain preserved. This preparation must pass affected
independent review before any new concrete live proposal; full goal stays active.

### Ticket 24: offline observation correction resumed (2026-10-03)

The User asks to continue and approves proceeding. Actual worktree has no
process-observation-remediation output: the previous author turn hit an account
usage limit before creating it. A fresh bounded author is dispatched under the
invoked orchestrator for that existing offline task. No live retry proposal has
yet been prepared or reviewed, so this continuation grants no guessed reset,
new native trust or behavioral test. Frozen failed F and accepted limited cleanup
remain intact; C/T remain unrun. Source-backed lossless observation, generated
controls and independent review precede the next concrete execution scope.

### Ticket 24: observation component reviewed; entry guard corrected (2026-10-03)

Root verifies36 frozen members and99 generated checks in process-observation-
remediation (manifest3b390d97600a36afbd4c008dee8984390173a2fa4139a18d158841001990ebae).
Independent reviewc392a77857e61ab02bc0464f11abeffab5079310463ec557f288bafe39b748c5
accepts bounded component behavior but requires the driver offline barrier before
private/environment reads. Root reads that actual report and matches seven review
members under993b2ca9648100edbc87cfe8b8cf9439b4a98bd9a06baf123c71921aecf021aa.

Source-backed command-free enumeration retains complete numeric snapshots while
allowing unrelated churn and excluding only the exact created observer from
ownership closure. Lossless arguments require predeclared nonempty literal vectors;
empty-argv0/environment ambiguity and unknown argument policies reject before
arbitrary values are returned or hashed. That finite component does not supply
missing PostgreSQL/controller/runtime descendant policies or live compatibility.
The copied harness remains intentionally unready and cannot qualify live F.

Author freezes a same-depth entry-guard correction with driver rejection first
after its docstring, before imports/env/private body. Root matches35 members under
4516356fd680f1e1333e21e046806cab158fe34e7ba50621cb9d3840128ce20a
and reproduces100 tests, including a full-source zero-operation spy regression.
All prior99 assertion sources and original artifacts remain intact; affected
independent review is dispatched. Separately, a read-only inventory maps exact
trusted factory argv inputs from current launch sources to the missing policies.
It may identify finite integration prerequisites but may not guess arguments,
waive unknown identities, introduce a new executor or authorize live operations.
No private query/reset/auth/native/service/model operation occurs. Full goal stays
active/incomplete; production behavior and architecture documentation unchanged.

### Ticket 24: offline entry-guard correction accepted (2026-10-03)

Root reads affected independent Pass report5ab7c6ebef9402d60b3ac235a1c79d2590f2c15506e913ee5401af4ca95dd751
and matches four members under8600b0544f2122b4a2613afb1a2e3854b024cc8e522c38d8450541325768ab2b.
Root35 correction hashes/100 generated checks and independent preservation/source
checks accept the sole driver rejection relocation and zero-operation regression.
No missing argument policy, Darwin ABI behavior, helper observation, lifecycle or
mode claim is accepted. The candidate stays offline/unready. The finite source
inventory of actual factory commands and PostgreSQL title behavior continues;
it must supply concrete inputs before another integration or live proposal.
Full objective remains active/incomplete. No owned live operation is running.

### Ticket 24: factory inventory accepted; finite integration dispatched (2026-10-03)

Root reads report12aadf13ac5c47d70ccac39a710a50a429ce201d6b10b18fe8967d2634d43732,
matches its three-member manifest6b1ae61cde56acf5e615a04f67f7d5e80dd27b78da080c5a3d49dffc2674487f
and verifies all39 actual source hashes. This accepts a source inventory, not
native observation or a runnable test. The preferred PostgreSQL boundary uses
explicit passive descendant absence records with stable root lineage and exact
executable identity; no child argument/title collection or direct signaling.
Postmaster roots and signal targets retain full factory-known argument checks.

Root dispatches bounded offline integration in process-factory-policy-integration:
forward exact launch inputs through surveys/cleanup, enforce the passive type in
history/absence/signal guards, and replace display-derived Stop argv equality
with a lossless proof join. Existing100 tests and frozen evidence remain intact;
new generated counterexamples and independent review are required. Actual shell
selection and unknown model-command descendants cannot be guessed or waived.
All entry barriers remain. No live retry, private query/reset, auth copy, trust,
service/model operation or production change is authorized by this dispatch.
Ticket24 and the full standalone objective remain incomplete.

### Ticket 24: finite factory integration frozen for review (2026-10-03)

Root reads report501f01b3397d35644fbc1d8c01e83b165f11587ee5fce280866bb50fffe2bc43,
matches40 members underd9d57837a5805590a8f0a312d447add988b0ae241d1da8a66c2b5948e4e0d5c3,
verifies438 actual source pins and seven unchanged prior assertion-source files,
and reproduces113 Python checks with pinned Framework Python plus12 Node checks.
Mutable review caught invalid mode substring acceptance and missing initial/late
native child factory inputs; those have explicit correction/regression coverage.
Passive PostgreSQL records join actual factory port/root and both captured
numeric/executable snapshots, retain distinct historical reparent refresh proofs,
and refuse signal paths and reclassification. Current Stop qualification requires
lossless identities; historical generated fixtures have a separate restricted API.

Frozen affected independent review is dispatched. This is source/generated
evidence only. Shell/intermediate Stop policies, other short-lived hook capture,
arbitrary model children and real Darwin qualification remain unresolved. All
live entry barriers remain, including the prepared Stop subprocess. This artifact
does not propose a live retry or qualify F/C/T; ticket24 remains In progress.
Production behavior is unchanged; no architecture documentation update is needed
for this isolated harness correction. No owned live operation is running.

### Ticket 24: initial-admission propagation remediation (2026-10-03)

Root reads independent Changes required report69667991ff376f4ca2fd04e03a2df30455398f89ba75b8e3e2b2f0349cc36bb6
and matches seven review members under970a9664d6ea532a62cc42290c874ad03a35b94f76a9bd75dab1e39f5660616b.
Generated executions of actual ResourceSession methods confirm two defects:
controller observation lacks the new native source seed before expanding an
already-born MCP child; initial runtime admission validates an already-emitted
embedding event against recorded roots rather than the supplied admission seed.
The review accepts other bounded passive/strict Stop/factory checks, with native
readiness still false. These harness defects do not change adapter findings.

Root dispatches only those two joins in process-factory-admission-remediation,
with retained reproductions and forged-source/creator/vector/UID controls. Prior
113 Python/12 Node assertion sources and all frozen artifacts must remain intact.
No new observation authority, generic framework, retry semantics or live operation
is included. Affected independent review precedes acceptance. Ticket24 remains
In progress; no F/C/T claim or fresh behavioral authorization follows.

### Ticket 24: admission corrections accepted; owned-reader check preparation (2026-10-03)

Root reads report02ba92e94d9ad6039442ca117a10c95150248a622745b219e08096ebe4297cab,
matches41 members under4e9a843850d0465da7743ce652df62b8b0307c317c08a6ead84784001c05974a,
verifies439 actual source pins and unchanged prior113/12 test sources, and
reproduces118 Python checks with pinned Framework Python. Node evidence remains
applicable through unchanged sources. Root reads affected independent Pass
reporta306e6dcb241c94e9b303714e810f583df860ba337fd4059509794089018cad8
and matches seven review members under15f3397a3a8cdec2ddd1d64c592af0c6266b2187a27caffa09cbf1ff5d5174ad.
The two joins are accepted within generated/source scope: native admission uses
the actual driver creation journal and retained start/UID/PID; initial runtime
events join the supplied seed and actual controller-created handle. Other frozen
components and all offline/live-readiness limitations remain unchanged.

Root dispatches a minimal offline owned-process reader qualification preparation,
with a separately reviewable proposal. It targets macOS reader ABI using two
literal synthetic Python children and sanitized environment, not Codex, account
credentials, hooks, services or lifecycle qualification. No actual native query
or launch is authorized to the preparation worker. Root will assess execution
authorization after concrete review: this owned reader check has no provider,
auth, profile or trust scope, so fresh human approval is not a universal prerequisite.
Consumed F/C/T authorization is not reused; those cases remain unrun/unqualified.
No architecture documentation update is needed for these isolated harness changes.

### Ticket 24: reviewed owned-reader attempt authorized by root (2026-10-03)

Root reads bounded preparation/proposal and independent Pass
report31ac095b9b22e62a5e1d3a3222dc9c338f2000352150378378074e490bbd8466,
matches four review members underdc06cde0ac93c7f892eb9b06455692edee26754e92c50b19abe648cdd13d85ed,
reproduces8 generated checks, matches7 preparation members and4 source pins.
Root assesses this exact one-attempt owned synthetic reader check as reversible
local debugging within the User's continue/Approved investigation authorization.
It has no provider/auth/profile reset/trust/service/model/network operation and
does not reuse or enlarge the ended F/C/T grant. Root authorizes only the reviewed
env-i isolated Framework invocation of probeeb472fefc05a208cdae964d2b23495964e45450df3973bded1d5321f94759c01,
with two literal owned children, selected-only native ports and direct-handle
cleanup. Unexpected failure stops this attempt; no automatic retry or source patch.
Host ABI result and cleanup must be inspected before acceptance. F/C/T remain
unqualified and their frozen live barriers remain unchanged.

### Ticket 24: owned-reader attempt stops at environment guard (2026-10-03)

The exact reviewed invocation exits1 with sanitized-environment-required at
probe.py66, before reader load/output allocation/child or native query creation.
Root preserves this prelaunch refusal in process-reader-native-attempt-1. No
selected-child ABI or provider qualification follows. A separate sanitized
interpreter diagnostic reports only keys and allowed locale: macOS adds
\_\_CF_USER_TEXT_ENCODING to the three literal supplied keys; LC_ALL remains C.
Its OS-derived value is not printed/retained. This is no probe rerun or normal
environment read. Root dispatches only a separate literal-environment source
correction and strict unknown-key/wrong-literal regressions. The original source
and ended single attempt stay frozen; new execution requires separate review and
root authorization assessment. No F/C/T/profile/auth/trust/service/model scope
changes. Full objective remains active/incomplete.

### Ticket 24: strict reader environment correction accepted (2026-10-03)

Root verifies11 members under44c1386e6cad8b5500a795511deb4b7a5ad69e236647119c4e83d2fbf6a7d346,
reproduces11 generated checks and reads affected independent Pass
reportd8e2facd70bb701940e89375d9db27bfca7d814a7b7ffdba8c0523c23eb11926,
matching5 members under4ddcf1008db6846343491920625ffc2d554cf7695f7eca3ef927c053f37726fd.
The sole ENV literal change prescribes synthetic \_\_CF_USER_TEXT_ENCODING=0x1F5:0:0
in the env-i launcher/main/children. Current public UID501 corroborates the
encoding context; it changes no process credential or authority. Strict unknown,
missing and wrong literals reject. Original failed attempt and all reader/query/
cleanup functions remain unchanged. Fresh five source pins match.

Root authorizes one distinct exact invocation of
probeb11d86ebfc8fe442112a63d657f7dfdc6c35e0cc6aa35059bf9a33e41b5df6ca
under the same reversible local debugging authorization assessment. This is
separately reviewed, not an automatic retry or reused provider/F/C/T grant.
Unexpected failure stops; actual ABI and cleanup acceptance remain pending.

### Ticket 24: bounded reader success and next source work (2026-10-03)

The separately authorized corrected owned-reader invocation exits0. Root inspects
actual result and private modes, preserves byte-identical result/source pins in
process-reader-native-attempt-2 (manifest9d29b78de0cbb68fc2b79e9aa8e58eb8acc86a879126ff3384e284a30f26069e;
report5404b4cd12f3d5accb66043a58b2162f2dad127d627244e8442a9b94e5323f65).
Only selected PID14502 receives native queries; both owned children are reaped
and absent from final command-free metadata. Literal arguments match exactly.
Independent evidence review is pending. This primitive success does not qualify
historical F cause, complete lifecycle, provider modes or F/C/T; no provider grant
is renewed. No active test children remain within this recorded scope.

Root verifies exact-commit hook-shell-source-refresh reportfc0b1723c7dc00c63781a75cb580854986c157f405ee1d361d72c4cb4308cfb1,
25 manifest members,20 Git blob/source hashes and2 config pins. Conditional
shell factory source chain is accepted, actual provider shell selection remains
unproved. Its older remaining-gap paragraph does not invalidate the subsequent
accepted display-verifier/synthesis source corrections; current lifecycle proof
remains separate. Root dispatches finite offline conditional wrapper integration
and exact-commit useful-work factory research. The positive3 outer CLI actually
uses custom code-mode exec calling tools.exec_command for cat package.json;
inner synthesis feature flags cannot establish the outer process factory.
All prior artifacts and native execution barriers remain unchanged. Ticket24
is In progress, with no renewed F/C/T execution authorization.

### Ticket 24: owned-reader live evidence accepted (2026-10-03)

Root reads independent Pass reportae9d66e705c3b44c861c1f9da4ad33a1bbecf0512362babdde41d41de6df5461,
matches3 review members underc81e3cf2ee28f5e3cfe650ebf93c358d8f4359a12dd363022e252da9f2fc972b,
and independently verifies3 author members,3 source pins and original result
byte equality. The reviewed macOS primitive passes this exact owned-child ABI
and literal-vector check with scoped cleanup. This supplies the bounded reader
prerequisite; it does not establish whole-harness readiness, historical F cause,
unknown descendants, provider shell selection or F/C/T/frontend behavior.
Source-only hook/useful-work factory follow-ups continue. No provider execution,
profile/trust change, changeset or architecture documentation update follows.

### Ticket 24: exact useful-work source chain and simpler fixture preparation (2026-10-03)

Root reads useful-work-factory-source REPORT and fixed-file supplement, verifies
32 frozen members,29 exactcommit Git blobs and2 supplement members. Original
manifest e0d85f481f1422e8ac06830cef65a768a0fb724c9e1e27eadaecc99002ae4390;
supplement7e83801e274621939965efc37caeeebf47e33c3361516233d7b0d41bfe0d5cc6.
Outer custom code-mode dispatches nested exec_command, with optional snapshots,
Seatbelt and separately grouped macOS command children. CLI group exit does not
prove their cleanup. Numeric absence-only observation is possible but cannot
repair surviving children or qualify unseen/reparented coverage.

The criteria permit actual useful fixture file read/summary without prescribing
a shell. Root dispatches a finite offline test-only fixed-path package.json MCP
tool preparation on the existing actual server instance, with explicit outer
code-mode disabled and unchanged memory hook/Stop route. No canned file output,
extra memory executor, product tool, sandbox removal or live authorization.
Native discovery/ordering and lifecycle evidence will still require review and
validation. The old source/harness and all criteria remain preserved.
Conditional hook policy7-member preparation returned for independent affected
review; no current producer or execution wiring is introduced. Architecture
boundaries and product source are unchanged, so no docs update is required here.

### Ticket 24: conditional wrapper source preparation accepted (2026-10-03)

Root reads affected independent Pass reportfff073edc88c522f2f90dedb2f1ccda90505c5a811084e1e343904c438ece5a5,
verifies4 review members underbddd0a4ae14188e41860cef17e72945756c7f613b35a457475233356cd43ff50,
7 preparation members/eight source pins, and reproduces6 affected generated
checks. Exact trusted TOML command remains one argument and missing selection
rejects. This accepts finite conditional value validation only; no collector,
current shell selection, live freshness/effective settings or launch authority
is established. Future producer/config/root linkage must be reviewed and pinned.
Short-life/helper/cleanup qualification remains incomplete. Fixed-file fixture
preparation continues; no provider test or product change occurred.

### Ticket 24: fixed-file fixture returned; concrete launch binding continues (2026-10-03)

Root reads fixed-file-mcp-preparation report2779f1483446054ee46a70049ba69660d100505eaebe75e43b03bbc210681776
and matches15 frozen members under37fced86d302a6b48c514249c4a16264b14840e25047dfed8b55b5eddf5ee79d.
Independent affected review is underway. Same-server test-only registration,
actual bounded file bytes/digest, strict empty input, nonblocking nonregular
rejection and guard-first entry are prepared;13 generated assertions reported.
No actual production capability probe or provider was started. Eight explicit
outer features disable shell/code-mode/snapshots, but model metadata can override
feature-selected tool mode. Root dispatches exact-source generated outercatalog
binding, without reading account caches or normal profiles.

Controlled hook-selection producer source preparation continues separately.
Worker reports the fresh CLI/default-local/no-inherited-shell source equivalent
closed, with explicit deferred_executor=false added to its proposed launch.
Root has not yet accepted its unfrozen result; trusted actual factory inputs,
root journal linkage and reconciled config/vector pins still need review.
All existing entries remain rejected and F/C/T remain unrun/unqualified; no new
provider approval, product configuration, executor or lifecycle waiver follows.

### Ticket 24: guarded fixed-file fixture accepted offline (2026-10-03)

Root reads independent Pass report4148cfb9f3b2d62ede64ebe5a40dd09439f456aca724522d51f47211d6d7b073,
matches4 review members underf6724849995e9b8a17f302cdb117af81b665b315e60d7530f49da96f881507f4,
and reproduces13 affected Node assertions with pinned Node26.7.0. Finite same-server
fixture registration/config preparation is accepted. This does not instantiate
production memory, qualify actual MCP dispatch/timing, or authorize a provider
attempt. Direct outercatalog, trusted hook selection, fixed-path prelaunch proof
and full-harness joins still require review. All live barriers remain closed;
no product architecture docs update is needed for this isolated fixture source.

### Ticket 24: catalog and useful-work verifier accepted as offline preparations (2026-10-03)

Root reads the actual outer-catalog report, verifies35 manifest members and25
exact-commit Git blobs, and reproduces10 generated checks. The profile/catalog
source preparation passes within its stated scope. A requested false feature
value is not proof of effective configuration: strict startup changes the CLI
to its embedded route, while managed feature normalization and requirements can
still alter values. The original default-daemon evidence remains distinct.

Root independently reviews fixed-file-useful-work-verifier-preparation, matches
15 manifest members,19 source pins and8 Git blobs, and reproduces5 generated
tests including63 negative controls. Report2468d6d6575d6934e199f3e9cabd30802c366f92b92889e10b9539bf20a0a9a1
passes bounded offline review. It validates actual file bytes and original-turn
summary in a complete owned snapshot before actual release/start, rejects
alternate work, and preserves the existing lifecycle verifier through an audited
memory-only view. Creation timestamps are not completion evidence.

Neither preparation supplies its own trusted runtime inputs. Root dispatches
bounded preclaim-gate/prelaunch producer implementation, independent strict-CLI
variation review, and minimum-effective-control source research. The gate must
precede the genuine claim and its timeout; no deadline reset, canned result,
extra executor or lifecycle waiver is permitted. All operational barriers stay
closed. No F/C/T attempt, normal configuration change or provider launch occurs;
ticket24 and the overall goal remain incomplete.

### Ticket 24: strict CLI affected review requires journal correction (2026-10-03)

Root reads independent Changes required report6478289a2b6e639b9ca563f97fe0b5bd4520f47f29b84cd3e5a5d3c59c938bf7
and verifies its three review members. The proposed strict Stop validator can
accept contradictory retained argv/executable comparison fields even though
its five generated tests pass. Root requests a fresh bounded correction using
the actual creator comparison schema, missing/contradictory-field controls,
and the current start fence; an absent expected start in an initial comparison
must not be invented. No patch or new Stop schema is installed.

Root also reads effective-config and strict-startup source reports and verifies
their15 and13 manifest members. They identify a real mode difference: native
strict CLI startup uses the embedded route; the existing managed daemon exposes
no equivalent strict selector. Required effective inputs remain a technical
unknown. Source-only notes do not impose blanket new approval requirements on
ordinary relevant public metadata reads. Minimum necessary controls and their
actual proof inputs remain under investigation, without weakening criteria.

### Ticket 24: minimum configuration predicate and bounded public observation (2026-10-03)

Root reads minimum-controls report2b57a71e9b787efcdf6d68fbd8c677d653910995b519fc1aa234c7d8bce28b4d,
verifies18 members and16 exact-commit Git blobs, and confirms the retained outer
catalog is Direct with Disabled shell metadata. Source review accepts harmless
UnifiedExec normalization behind the absent shell registration gate. All-nine-
false is not required; actual necessary proof concerns the bound catalog,
background snapshots, selected hook shell, and ready owned local environment.
No ticket behavior criterion or lifecycle check is waived.

Root performs one ordinary read-only public presence observation, exits0 at
2026-10-03T17:20:24.977336Z. Both exact system policy paths are absent and both
Codex admin keys are unforced. public-policy-presence retains code/result/report;
report678fa4c1bc7691930687ca6e400369fa5a3a037dadd9fa1d75a10fdcee0d17f2.
Only lstat and forced-state booleans are queried; no file/preference values,
normal profiles or credentials are read. Independent affected review is pending.
This point-in-time observation is not a future startup lease. Cloud requirements
remain unknown and receive a finite exact-source follow-up. No provider or FCT
attempt occurs, and all launch barriers remain closed.

### Ticket 24: public presence evidence review accepted (2026-10-03)

Root reads independent Pass report030383cab7700331bbb4751ef600545b6ee442969baf27c2402e4f6a3d53e60e
and verifies its two members. Domain, keys, exact paths, CoreFoundation ABI,
narrow output and owned allocation cleanup match the pinned source. Root accepts
the original exit0 observation within its stated point-in-time scope only.
The UTC timestamp precedes sequential probes, so this is neither atomic nor a
launch lease. No cloud, retained-startup, provider or lifecycle claim follows.

### Ticket 24: conditional producer affected join correction (2026-10-03)

Root inspects process-hook-selection-producer-preparation actual definitions
and reproduces its seven generated tests. Its operational entry still rejects
before collecting facts. The generated bind_observed validator has the same
incomplete retained-comparison join as the strict Stop variation: it checks the
current argv digest but omits the expected digest, argument count/classes and
executable comparison fields. Root requests correction of both affected views
in a fresh sibling bundle, preserving originals and current-start semantics.
Passing generated tests do not close that inconsistency. This is a bounded
offline preparation finding; no operational producer or live scope is enabled.

### Ticket 24: cloud prerequisite narrowed by exact account predicate (2026-10-03)

Root reads cloud-input report56e0f690b9e8ae418af7aff2a0690b3b988c2a98f9be5f62dd67187c9f5cc04e,
verifies23 members and21 exact-commit public Git blobs. The inspected source
loads cloud policy only for Codex-backend auth with its exact business,
education or enterprise plan predicate; Team labels are not that predicate.
This is a source finding, not a classification of the User's account.

A token-free classification bound to an authorized future private auth copy
and its actual unchanged startup use could close the ineligible branch. Root
dispatches finite generated classifier preparation without reading any auth.
For eligible/unknown inputs, later configuration projections do not alone prove
the bootstrap-to-retained-to-replacement cloud input lifetime. Old auth copies
are gone, no normal auth read/copy or account API call is renewed, and no native
test is authorized by this source result. All original ticket criteria remain.

### Ticket 24: User directs manual assistance over costly test setup (2026-10-03)

The User asks to defer a test until they are available when automated setup
becomes lengthy and manual assistance would be easier. Root defers the remaining
live Codex edge cases accordingly. No new native launch, auth copy, trust reset
or service startup will occur for them while the User is away. This defers
experiments, not the entire goal; ticket24 remains incomplete/In progress, with
its dependencies and acceptance criteria intact. Existing research is preserved.

Root stops expansion of cloud/classifier/startup-proof preparations. The finite
classifier returned with13 generated checks, but its operational port remains
rejected and no independent acceptance or account classification is claimed.
This test-harness research is not a product dependency of deferred recall.

Root reads preclaim-gate independent Changes required reportb60f40ed0645ecb34ae2b45c5b711a52538495e1ee543c8a8e67c582b036639a.
Publication can consume the admission deadline before the real claim. Only a
small post-publication deadline correction and the already requested retained
journal correction continue; no additional automated harness expansion follows.

Manual resumption will run one synthetic case at a time. Root prepares the
case-specific isolated services, configuration and exact prompt after reviewing
the smaller manual setup; the User starts the native CLI, handles its own sign-in
and folder/hook trust, submits one recall/useful-work prompt, and confirms stop
or exit where the case requires it. Root retains actual task/native outcome and
scoped service cleanup evidence. F requires genuine scheduler failure, C an
actual protected cancellation with race recorded, and T an observation deadline
with durable completion and no cancellation. A transcript alone does not prove
these durable outcomes. No prompts are presented as runnable until that setup
is concrete and reviewed. Failure/cancellation/timeout come before additional
fork/exit/frontend work; no normal-profile or global-setting changes are implied.

### Ticket 24: small corrections returned; documented validation scope (2026-10-03)

Root reads retained-comparison-remediation report8507097faf20d744140dc1d214dda4611d75d37c4f5b916e1d042b2f99784ec5
and dispatches independent affected review. Fifteen small generated checks are
reported passing; acceptance remains pending. The strict fixture now uses the
actual retained comparison output without relaxing its assertions. Operational
entries remain rejected and original artifacts are preserved.

Only the tiny preclaim publication/deadline correction remains authorized after
this review. Automated cloud/startup/observer expansion and live cases remain
deferred under the User's manual-assistance preference.

Root updates docs/codex-integration.md and docs/async-memory-answer.md to name
verified native overlap/delivery/revocation/expiry behavior and explicitly name
the unverified failure, explicit cancellation, observer timeout, pending exit,
fork and frontend cases. These documentation changes describe current evidence;
they introduce no behavior, broader qualification or release claim. Targeted
Prettier and git diff --check pass; the approved no-changeset preference persists.

### Ticket 24: final small offline corrections accepted; live cases deferred (2026-10-03)

Root reads retained-comparison-review Pass reportd032c0fd8750c5c59654c1e8d0b9ff0e9b90f57076cd1b9dc4d70b94660bfc1c,
matches its two members and the seven correction members. Both affected joins
now require consistent actual comparison fields; fifteen focused generated
checks pass independently, including the original counterexample. Root accepts
this bounded source correction without native-readiness or installation claims.

Root reads preclaim-deadline-review Pass report9832fe25b28e771825fac29f257528f47b5ce9cd6e4342a6d0f9e198145b3aa7,
matches its two members and seven correction members, and inspects the actual
post-publication closed/absolute-deadline check before the original claim.
Eight focused Node checks pass independently, including the exact expiration
boundary. The genuine execution timeout is unchanged. This bounded source
correction is accepted; the operational port remains rejected and uninstalled.

All bounded workers are terminal and further automated setup expansion stops.
No live native/provider run, auth copy, trust change or service launch occurred.
Failure, cancellation, observation timeout and the remaining lifecycle/frontend
cases await the User's availability for manual assistance. Ticket24 and the
overall goal remain incomplete; no acceptance criterion is waived, no goal
completion or whole-goal pause is claimed, and no commit/push/PR/changeset follows.

### Ticket 24: deferred-test dependency audit 1 (2026-10-03)

The preceding goal turn made progress: both small source corrections passed
independent review, current validation scope was documented, and formatting
checks passed. Root now rechecks ticket24's actual unchecked criteria and current
worker state. All three workers are terminal. Setup/lifecycle integration,
separate native mode qualification and the final completion audit still require
the deferred live evidence; current source preparations do not supply it.

No eligible authorized work remains without either the User's availability for
manual assistance or expanding the costly automated setup they directed us to
defer. This is the first consecutive audit of that dependency. The goal remains
active and incomplete; no new test, source-framework expansion or retry starts.

### Ticket 24: deferred-test dependency audit 2 (2026-10-03)

The previous audit turn made no implementation or qualification progress; its
record did not resolve the dependency. Root rechecks the worktree, active goal
and authoritative worker state. All workers remain terminal, no new human
availability or authorization has arrived, and the same deferred live criteria
remain missing. No safe eligible next action supplies those proofs without the
manual assistance or costly setup the User asked to defer. The goal remains
active and incomplete on this second consecutive audit; no experiment restarts.

### Ticket 24: deferred-test dependency audit 3; blocked on manual availability (2026-10-03)

The previous audit turn was no progress. Root rechecks the actual unchecked
criteria, active goal and terminal worker state. The same missing manual live
evidence has persisted for three consecutive goal turns, with no new human
availability and no eligible independent work. Root marks ticket24 Blocked
pending User availability and requests the corresponding blocked goal status.
This is a dependency state, not a whole-goal pause or completion claim. Existing
implementation, reviewed corrections and scope limits remain preserved; no
costly setup, experiment, auth action or new delegation starts.

### Checkpoint cleanup and manual test documentation (2026-10-03)

The User authorizes cleanup of disposable failed fixtures, documentation of
required manual tests, and a local checkpoint commit. Live tests remain deferred.
Root independently refreshes ownership, device/inode, exact membership and
byte equality before removing only /private/tmp/koed-owned-reader-jkyw6eaa and
/private/tmp/koed-shell-source-B7AYHD. Four files totaling231487 bytes retain
identical copies in the investigation archive. Root confirms both scratch
directories are absent after deletion. No process signals or service actions
occur. The old native/frontend fixture paths and known macOS temporary koed
entries were already absent. The44.85MB source/evidence archive is preserved.

docs/codex-deferred-recall-manual-tests.md records the remaining cases, human
and agent responsibilities, real task controls, pass/inconclusive evidence,
cleanup, frontend qualification and setup/recovery limits. Old guarded runners
are historical prerequisites, not runnable instructions. The integration guide
links this checklist. The feasibility report now explicitly identifies its
initial research scope and directs readers to current implementation status.

Checkpoint validation passes250 targeted tests:56 MCP delivery/dispatch/shared
lifecycle,161 server CLI/setup/status, and33 configuration/packaging/staging
script tests. Both relevant package typechecks/builds and targeted lint/format
pass. The existing doctor test first failed because default-home persistence
met the sandbox boundary; the three-file suite passes with an owned temporary
KOED_HOME. No normal profile mutation or test-source workaround occurs.

The checkpoint includes the Codex product changes and package planning/docs.
Unrelated deployment reference files and the pre-existing ignore edit stay
outside its scope. Private/ignored evidence is not force-added. No changeset,
push, PR, publication, live model call or native test is authorized by this
checkpoint. Ticket24 and the overall standalone objective remain incomplete.

The independent manual-document review passes after clarifying the single
memory_answer call and the exact prompt required for a gated case. Plain file
summary instructions are not presented as sufficient for that gate. Formatting
and staged whitespace checks cover the checkpoint, including preserved Markdown
line breaks. All three bounded workers finish without live fixture setup.
