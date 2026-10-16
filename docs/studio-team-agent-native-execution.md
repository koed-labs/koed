# Native Agent execution from Team channels

Ticket 13 replaces the retired Agent Job handoff with ordinary native commands.
The human messaging backend, request consent flow and private Agent conversation remain the shared foundation.
The native replacement is implemented and has passed the focused automated checks below. Live provider and deployed Team acceptance remain open.

## Request and execution boundaries

An explicit Team Agent selection creates a channel request using the existing stable owner and Agent identities.
A colleague proposal does not authorize that owner's computer. The owner reviews the request privately and accepts or declines it.
An owner can refine the bounded, visible channel excerpt before acceptance. Private refinement does not accept the channel request.

Acceptance queues the saved private goal in the already-bound private native conversation.
The request update, command creation and native binding use one database transaction.
A retry of the same accepted decision returns the same binding rather than dispatching again.
Requester withdrawal, offer withdrawal and acceptance retain their existing current-access and version checks.

The private review supplies the verified Agent, local Project and selected computer/provider settings.
A Team Project ID is not a local path or permission to use another computer.
The native command preserves its conversation generation, runner identity and normal execution permissions.
No new Job, assignment classifier, soul instruction or model phase-reporting protocol is introduced.
Recall uses the supported memory_answer flow and existing scope authorization.

The channel request receives an execution status rather than private conversation text.
Accepted and Running are separate facts. A queued command or unavailable runner must not appear as running.
An uncertain or stale execution cannot appear successfully completed.
Existing Job-backed requests remain readable. Native commands are not presented as fabricated Job IDs.

## Storage and dispatch

Migration 0079 adds owner-scoped native execution/command links while retaining legacy Job links.
A database constraint permits one valid accepted linkage shape. It does not accept an unbound Accepted request.
Foreign keys bind the command, execution and owner together. A unique command link prevents reuse across requests.
A status function reads the accepted command and its own pending runtime items. Later private commands do not redefine that request's result.
Owner departure freezes the permitted channel status without exposing continued private activity.

An indexed private-review binding lets API and worker dispatch distinguish request-bound reviews from ordinary Personal chats.
Unanswered requests use read-only planning controls. Withdrawn, declined or unavailable request bindings cannot become unrestricted Personal commands.
The dispatch check consults persisted binding authority before relying on Agent context supplied in a command.
Accepted work uses the owner's verified execution settings through the existing provider adapter.

Older encrypted review bindings need a bounded lookup migration. Each lookup processes at most 100 unchecked owner records.
If more unchecked records remain, the lookup commits that bounded page and returns a retryable unavailable result rather than assuming a Personal chat.
New reviews save the indexed binding atomically. Routine lookups use that index after the older rows are processed.
The API performs this check before enqueue so an incomplete lookup can be retried without dispatching provider work.
For an already queued prompt, the worker requeues the same command under its lease only for the specific backfill-pending error, before provider dispatch and without a pending checkpoint. Other failures retain the existing uncertain-outcome protections.

## Questions, answers and result sharing

Only the owner can control the private execution or prepare a question for the originating channel.
An explicit post shares the reviewed question through existing encrypted channel messaging and its original message thread.
A teammate's reply remains a human message until the owner explicitly forwards that selected answer into the private chat.
No mention, reaction, reply or request grants a colleague execution control.

After the accepted work finishes, the owner can request a private summary draft.
The summary source is the accepted command's retained output, not a later private discussion or another request.
The draft source is bounded to 6,000 characters and retains a truncation marker.
The owner reviews and edits the draft before a separate explicit post to the originating channel.
Neither successful command completion nor draft generation publishes private replies or Memory evidence automatically.

Legacy Job summaries use their original owner-authorized source. Native summaries use the exact accepted command binding.
Summary generation remains a normal private Agent turn. It does not add backend LLM synthesis.

## Authorization and recovery requirements

Acceptance must recheck current owner/requester membership, channel and Team Project access, Agent availability and the bound execution.
A stale offer or private review cannot authorize a different Agent, Project, conversation or runner.
A request accepted before offer withdrawal retains the existing execution rules. Disabling future requests is not cancellation.
A former Team member cannot use retained IDs to recover private content or continue Team reads.

The native command keeps existing execution lease, generation, cancellation and uncertain-outcome protections.
Reload and reconnect recover the durable request and conversation. They must not replay the acceptance prompt.
Ordinary Personal chats continue through their existing native path.

## Scope

Ticket 13 restores the existing channel request workflow for supported native AI Clients.
It does not add a multi-owner execution coordinator. Ticket 27 extends the same
request lifecycle to private/group Collaboration chats under the User-approved
participant-only contract. Eligible Agent owners must be current participants;
review and execution stay owner-private, and explicit question/result sharing
targets the stored originating thread. The required shared Project context does
not widen that thread's audience. See the
[Collaboration chat assessment](studio-collaboration-chat-assessment.md).
Public Square and For you native activity projection remain Tickets 12 and 20.
This request's broad status and owner request inbox remain Ticket 13 responsibilities.

## Validation record

### Recovery and paired-runner follow-up, 2026-10-16

The validated 2026-10-15 checkpoint is committed and pushed as `56155e4b`.
Follow-up work keeps the stopped-history guard intact. Current records do not
prove that a failed first prompt was never accepted by the provider. Eligible
stopped, unaccepted reviews can therefore open a new **blank** private planning
chat through the existing version-checked start and review-binding transaction.
The old prompt is not resent. Accepted requests and uncertain outcomes do not
gain a replay path.

The paired-runner output read uses the existing encrypted runtime items, scoped
to the authenticated owner, assigned Device/deployment, execution generation and
provider turn. Reads keep at most 32 output items and 65,536 UTF-8 text bytes,
with one bounded database lookahead item to report truncation. This is output
recovery for the existing provider adapter, not another execution or Memory path.

The owner-only runtime read also identifies an execution's Team request binding
without returning the private brief. Reopening a bound execution must restore
that context before deciding whether to use a Personal joined conversation.
The live Home reopen check exposed the old misrouting: history loaded, but the
Personal message endpoint rejected the new send with 403. This is a failed
continuation check, not evidence that the access check should be relaxed.

The review panel preserves its controls and unsaved edits during same-request
status reads, while failed authority checks remove the private controls. A
separate Claude 2.1.299 profile was configured through setup/repair and signed
in for this disposable runtime. These setup and automated checks do not certify
the remaining live Claude, restart, additional-Device or deployed acceptance.

Focused checks passed: 98 runner/routing API tests, 69 managed-route tests,
156 worker tests, 25 chat/page tests, four review-panel tests and 16 native
navigation/helper tests. The new SQL bounds test passed against a uniquely
created disposable database, which was removed afterward. DB/API/worker/Studio
type checks passed. Source runtime preparation and the Docker image build passed;
the running test image is `sha256:87a15f46dfec103e583599d510cda82684db15dc1cad2cda6f15915572f24ff2`.

The six Home browser tests pass after moving a cold schema load out of request
handling and waiting for the warmup's authenticated Home feed before closing it.
The feature assertions keep their existing timeouts. A read-only deployment
recheck on 2026-10-16 still returns router-level 404 for both Personal Agent
routes on `next.koed.ai`; deployed Team acceptance still needs a compatible
deployment. No deployed test data was created.

The new Claude request `a9b7ca69-7ec4-4a17-bf72-c19fa6c4ec35` uses execution
`a84e8cfe-f92d-4e3d-bf8f-06cc46a166f6`, Sonnet 4.6 and Medium effort.
Its pre-acceptance turn completed with only read/search/question tools available;
neither the probe nor assignment file was created. Reload restored that private
history and the current review version. Requester and outsider runtime reads
returned 404. Explicit acceptance created exactly one native command and no
retired Jobs, but its provider query returned `ManagedConversationAuthenticationError`.
The command remains indeterminate and the execution reconciling. The assignment
file is absent. CLI auth status still reports signed in; that does not prove the
provider accepted the execution query. No automatic retry or manual database
repair was attempted. Claude accepted-work and recovery acceptance remain open.

### Local Docker live result, 2026-10-15

The Codex channel-request core flow passes against the isolated Docker Team backend and native owner runtime. This is one computer with separate authenticated owner, requester and outsider accounts, not a deployed or two-Device acceptance result.

- A real provider tool attempted the synthetic pre-acceptance write and exited with code 1, `operation not permitted`. Its recorded turn used read-only sandboxing and approval policy `never`. Neither the probe nor assignment file existed before acceptance.
- Explicit owner acceptance created one native command in the same private execution. The provider created and read back the exact requested file; it was the only changed file. Repeating the same acceptance returned 200 without another acceptance command. No retired Job or Job-attempt rows were created.
- Owner review/runtime reads returned 200. Requester and outsider review reads returned 403 and private runtime reads returned 404.
- A private follow-up completed in the same execution. The actual summary prompt's quoted source contained 129 characters from the accepted command, with no planning or private-follow-up marker. The draft remained private until the owner edited and explicitly shared it. The requester then saw the edited result in the originating channel. Source truncation remains covered by automated tests, not a live oversized-output case.
- Reload recovered the same execution, Project, Agent, model, effort and conversation history. A new explicit continuation returned `T13-RELOAD-OK`. Private planning, follow-up and reload markers are not authorized for channel publication.
- The normal Personal runtime remained healthy. Docker volumes, the disposable pairing and test data were preserved. Older review application/model/gateway containers remain paused during this isolated run. Long-session validation used supported capability refresh commands; unattended capability refresh is not established by this test.

Remaining implementation and broader acceptance are listed below and in `TODO.md`. Ticket 13 stays open. The following checkpoints retain failed attempts and their corrections rather than treating them as passing evidence.

Live validation preflight on 2026-10-15:

- Hosted Studio and native Desktop builds pass. Testing uses a disposable Team backend and a separate disposable local edge; the User's current Personal database is outside this setup.
- An authenticated channel requester recovered an interrupted human-message send through **Reconcile send**. Actual API reads confirmed one matching message and zero Agent requests.
- Desktop setup incorrectly rejected checksum-verified embedding-model status because that command omits the `ok` field used by installation results. The setup check now accepts that status contract while retaining explicit success checks for installation and Privacy Filter models. All 102 Desktop manager tests, Desktop typechecks, preload verification and changed-file lint pass.
- The corrected native setup reaches 100% complete, with Codex reporting authenticated and managed-conversation ready. The User approved the disposable device, and supported enrollment reconciliation confirmed the owner identity. That grant was subsequently discarded with the disposable database; it is not a current connection or evidence of execution acceptance.
- Actual authenticated channel/request-list reads return 200 for the owner and requester and 403 for the unrelated outsider. This checks Team read isolation only; owner-private request review remains untested.
- These messaging and enrollment observations belong to an earlier disposable fixture. Scratch credential exposure required discarding its databases and credentials. A fresh isolated source now passes authenticated Personal Agent reads and renders the native Agent collection; no Agent request or provider execution has passed.
- Source review identified a test-profile limitation: the `developer` Team backend supports the messaging foundation, but Personal Agent and managed-conversation routes use session/API-token authentication there, rather than the paired-device authentication needed for native remote execution. Continue against a supported hosted Team profile; do not broaden developer authentication merely to pass validation.
- Read-only discovery found the existing configured Team backend at `https://next.koed.ai`. Its public capabilities report release `0.8.1`, profile `team_self_hosted`, WorkOS authentication, managed conversations available and collaboration partial. The current branch reports `0.9.0`. Its published OpenAPI includes five Personal Agent paths that are absent from the remote OpenAPI. This establishes an API-contract mismatch, rather than a verified current-branch deployment. No exact deployed commit is exposed by the inspected public metadata, and GitHub lists no deployment records. The User authorized creating an isolated test Team; deployment changes have not been authorized. A compatible backend remains required for this acceptance run.

These preflight checks do not establish live Agent execution or deployed Team acceptance. The remaining live checks below stay open until their own evidence is recorded.

Follow-up read-only route checks returned explicit router-level 404 responses (`Route GET:… not found`) for both `/v1/personal-agents` and `/v1/personal-agents/capabilities` on `next.koed.ai`. This confirms the live backend lacks the Personal Agent routes required by the current branch; the discrepancy is not limited to its OpenAPI document. Its exact deployed commit remains unknown. Do not create test data there until a compatible deployment is available.

The User subsequently authorized a local Docker replica using `koed-private`. Its deployment Compose file at commit `2fe14506f9f2c9e480c29c6b0ae2b17cd0332cb2` provides the service layout. The isolated replica builds the current application branch and uses dedicated Compose volumes, a loopback gateway, read-only model assets and fresh test credentials. Local-auth overrides do not validate Google/WorkOS or public HTTPS. Disposable users and Team memberships can be provisioned through normal Developer APIs before restarting the same volumes under `team_self_hosted`; no verified external identity is fabricated. The preserved deployment identity may retain its initial Developer profile metadata. Team administration after switching still requires WorkOS. Record actual pairing and execution results separately from replica startup.

Docker startup checkpoint: image `sha256:a8c8d423758f9c07825292cc2dc706b456dc3634392c60a6acc70643f5e22326` runs the current branch runtime with this session's hosted UI export at `http://localhost:3341/studio/collaboration`. Following ordinary API fixture provisioning and restart, public capabilities report `0.9.0` / `team_self_hosted`; `/ready` and the Studio page return 200. Actual owner/requester channel reads return 200, outsider reads return 403, and owner Personal Agent reads return 200. The UI renders its local-auth sign-in form. PostgreSQL, Redis, embedding, privacy and application health checks pass; the gateway runs with loopback binding. Privacy restarted twice during startup and subsequently became healthy; the cause was not established. The gateway was restarted after application recreation to refresh nginx's upstream address. No Docker-backed device pairing or Agent execution has passed yet.

Docker pairing follow-up, 2026-10-15:

- Native Settings started enrollment against `http://127.0.0.1:3341`. The User authorized the exact device approval, the browser confirmed approval, and supported reconciliation returned `exchanged` / credential `configured`. Its principal matches the disposable Team owner. The Docker backend is the active upstream. The IPv4 address was necessary because secure fetching of `localhost` selected an unbound IPv6 loopback address and failed with `ECONNREFUSED`.
- The native UI created one disposable Agent under the remote owner's catalogue. The native Collaboration screen loaded the isolated Team. The browser requester uses actual password authentication through a loopback fixture helper; this does not establish manual sign-in or Google/WorkOS acceptance.
- Live testing found that the Collaboration page unmounted its workspace on every focus refresh. Returning from the native folder picker discarded the Project form; focus also discarded an open Public Square Agent offering form. The correction preserves the mounted workspace during same-authority focus revalidation, fails closed on errors, resets on authority/access changes and retains explicit refresh behavior. Eight focused React regressions, changed-file lint and Studio typechecking pass. The first native rebuild passed; repeating the OS folder-picker flow preserved the exact name/path and successfully created the connected Project channel.
- Source review identified a separate Agent detail availability bug: it compared the remote Team principal with the local private-draft owner. The correction uses the authenticated remote principal/backend and Agent ID, preserves server ownership and `canManage` checks, and clears stale Team context. Three focused React regressions, changed-file lint and Studio typechecking pass. Live validation of this correction remains pending.
- The final native Studio production build with both UI corrections passes. The User approved both corrections in the existing minor changeset.
- Before any proposal/acceptance, read-only Docker database counts were zero Team Agent requests, zero native commands and zero retired Agent Jobs. Device pairing, Agent creation and Project setup are not evidence of live Agent execution.
- Repeated UI timeouts progressed to an unresponsive Docker engine: the local engine ping endpoint timed out and container status commands stalled. The obsolete isolated native Developer target was stopped. The User authorized restarting Docker Desktop while preserving volumes; the supported restart command completed and Desktop reported `starting` with new backend/VM processes. Recovery checks remain separate from execution acceptance. No Docker-backed Agent proposal, acceptance, provider command or explicit result publication has passed yet.

Docker recovery and private-review checkpoint, 2026-10-15:

- Docker recovered with its volumes intact. The isolated test stack is healthy. Four older review application/gateway/model containers were paused to avoid running duplicate model services; their volumes and database services were preserved. The User's Personal runtime remains separate.
- The requester created a real channel Agent proposal through hosted Studio. Before private review, the database contained one request, zero native commands and zero retired Agent Jobs. A proposal alone did not dispatch provider work.
- The owner saved a private brief and opened its bound native conversation. Actual authenticated reads allow the owner to read the review and conversation; requester/outsider reads are denied. These checks cover the disposable fixture only.
- Live testing exposed misleading private-review instructions: the first brief must be saved before starting private planning, but the UI described the opposite order. The copy and disabled-send guidance now describe the existing gate. Eleven focused React tests pass; no execution permission checks were relaxed.
- The first private planning send created a durable execution, but its start command remains blocked on local runtime-binding preparation. The binding has the exact disposable Project path and remains pending. No provider turn, read-only write denial, assignment acceptance or result publication has passed at this checkpoint. Worker wake handling is under investigation; do not treat this as completed Ticket 13 validation.
- A later processing pass released that start, which failed its dispatch-time AI Client settings check before provider execution. Current runner identity, local owner and selected settings all pass the same admission function; the historical failing predicate has not been established. The requester then withdrew this proposal through hosted Studio. Database reads confirm `withdrawn`, no accepted command and no retired Job writes. A fresh proposal remains awaiting owner review for the repaired-startup test.
- Source review found that remote SSE replaced the local command listener even though local runtime-binding creation uses that PostgreSQL notification channel. The correction also listens for local command notifications on the existing local source-replication connection. The initial regression keeps SSE open and delivers a local binding notification; lifecycle race coverage is being strengthened. The focused worker/settings run passes 135 tests, and worker typechecking and compilation pass. These automated checks do not establish live provider execution.
- The repaired native runner prepared and acknowledged a fresh Project binding and completed its start command within ten seconds. No provider prompt was enqueued: live UI testing found that saving the execution-bound review changed URL metadata, which reparsed handoff settings and remounted the chat between start and prompt. The page now keys selection changes from the actual setting values. A rendered-page regression verifies that a review-version-only change neither refetches the Agent nor remounts the chat. Live validation of the corrected first-send path remains pending.
- The second empty execution was stopped through the authenticated API and its requester proposal withdrawn through hosted Studio. A third proposal is awaiting owner review for the complete path. Neither superseded proposal was accepted or created a legacy Job.
- The native Agent detail panel now resolves the paired remote owner correctly and displays the existing offer as **Available to this Team**, with its approved description and enabled availability control. No Team availability settings were changed during this check.
- A further live retry completed runtime startup but still aborted before prompt enqueue. It retained the draft. The chat bootstrap effect also depended on review-version metadata and aborted its controller when the binding advanced that version. This second reset is being corrected without changing Team/request scope isolation. The third empty execution was stopped, and its proposal withdrawn. No provider turn or assignment acceptance has passed yet.
- Notification lifecycle coverage now includes failure of the second `LISTEN` and shutdown during setup. The complete worker run passes 523 tests with three skipped; the focused service suite passes 130 tests and worker typechecking passes. Changed-file worker lint still reports five pre-existing findings outside the edited code; it is not a clean whole-file lint gate.
- The complete lifecycle correction passes a gated-start React regression: advancing review metadata preserves the draft/model and posts exactly one prompt after start resolves. Studio typechecking, changed-file lint/format and the production build pass. The next native retry displayed the initial message, retained model/effort and navigated to the durable execution route.
- That first queued planning prompt failed before provider dispatch because the remote authority adapter did not implement `getOwnerReviewBindingForExecution`. Its companion pending-request lookup is also missing. These reads must use authenticated runner routes with owner/Device/execution checks; a local fallback that treats an unknown review as ordinary work is not permitted. The private execution remains recoverable through **Reconnect conversation** while this wiring correction is prepared. No read-only provider probe, accepted assignment or public result has passed yet.
- The runner lookup correction now passes 23 worker authority-client tests and 95 API routing/auth tests, both service typechecks, lint and format checks. The exact backfill-pending error retains its narrow pre-dispatch retry behavior across the API boundary. Credential catalogue reads stay local to the native owner. Both source and Docker builds pass; image `sha256:1e5fd676e9cbecfb994b3e4f4f6b1bac47d8e264512c164eaf433f7148cb8ab3` replaced only the isolated Docker application service. The gateway was restarted for its new upstream address; existing pairing and database volumes were preserved.
- **Reconnect conversation** stopped the failed execution, but a continuation was rejected because that execution has no provider history to resume. Keep this history guard intact. A new unaccepted review is being used to validate the corrected first provider turn. Safe recovery for this empty-history case and the remaining non-Codex/file/Move adapter gaps are recorded in `TODO.md`; they are not passing acceptance evidence.

Automated validation on 2026-10-14:

- Real disposable PostgreSQL Team request suite: 5 tests pass, including native atomic acceptance, exact retry, public/private boundaries, owner departure, explicit result posting, duplicate binding rejection and bounded legacy backfill.
- Worker managed-conversation suite: 114 tests pass, including persisted owner-review authority, planning/work classification and narrowly fenced backfill requeue.
- API collaboration, managed-conversation and summary-source suites: 114 tests pass. The 22 summary tests cover exact accepted-command sourcing, owner binding, terminal states and bounded content.
- Studio Team request/progress suite: 7 tests pass; Team request/mention/sharing helpers: 19 tests pass.
- Existing hosted Team browser suite: 8 scenarios pass, covering human messaging, shared composer, reload, retry and access revocation with synthetic service responses.
- Migration acceptance matrix: all 15 scenarios pass through migration 0079. Personal multi-Agent regression: all 16 disposable database scenarios pass.
- Studio production build and API, worker, DB and Studio typechecks pass. Shared request contract tests, migration metadata checks and release consistency checks pass.

A broader API test run also reported 16 failures outside these focused flows; a clean-revision baseline was not established. This checkpoint is not a passing whole-repository test gate. Changed-file backend lint also reports six findings in unchanged portions of the worker service; this is not a passing whole-repository lint gate.

Remaining live acceptance and implementation:

- Safe empty-provider-history recovery and the remote non-Codex output-list fallback before complete Claude acceptance; retain existing safety checks.
- Extend the passing Codex loopback acceptance/isolation/sharing checks to Claude, other Devices, deployed Teams and Google/WorkOS authentication.
- Cancellation, withdrawal races, offer/Project/device changes and access loss. Requester withdrawal itself passed in disposable fixtures; race coverage remains automated.
- Waiting/uncertain states, legacy requests, worker restart, nested-thread destinations, reviewed questions and explicit answer forwarding.
- Live oversized-output truncation, unattended capability refresh and complete native/hosted human-message regression.
- Review-control focus revalidation and human-derived conversation titles after reload, recorded for retained UI acceptance under 30.

Use disposable branch databases. Do not apply branch migrations to the User's current Personal database.
A focused or synthetic test is not evidence that live Codex/Claude, two-computer or deployed Team acceptance passed.
