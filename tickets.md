# Settings parity work package

**Target:** implement the approved option B settings design in the current desktop redesign.

**Status:** breakdown approved by the User on 3 November 2026. This is the single local work-package file requested by the User; no external tracker issues have been created. Implementation is present for all five tickets. Qualification follows the blocking edges and validation requirements below; the live Privacy Filter installation gate remains open. The User requested implementation and confirmed that the changeset should be omitted.

**Design decision:** option B, including both subsequent changes: all four detail views use nested pages in the right-hand settings pane, and **Optional tools is the last section of General**. The earlier popup and disclosure designs are superseded for these four views.

## Design reference and evidence

The current local prototype is the visual and interaction target:

| Screen            | Prototype reference                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------- |
| General overview  | [Option B · General](http://127.0.0.1:5197/?variant=B&tab=general)                          |
| Privacy Filter    | [General → Privacy Filter](http://127.0.0.1:5197/?variant=B&tab=general&page=privacy)       |
| Command line      | [General → Command line](http://127.0.0.1:5197/?variant=B&tab=general&page=cli)             |
| Services overview | [Option B · Services](http://127.0.0.1:5197/?variant=B&tab=services)                        |
| Service health    | [Services → Service health](http://127.0.0.1:5197/?variant=B&tab=services&page=health)      |
| Embedding status  | [Services → Embedding status](http://127.0.0.1:5197/?variant=B&tab=services&page=embedding) |

These URLs require the local prototype server and are not durable review artifacts. Ticket 01 must preserve the final approved prototype and fresh reference captures before implementation. Earlier screenshots may show option A or Optional tools above device settings; those are not the accepted baseline.

The prototype was inspected against the current UI branch at `835371e1`. Main's existing setup and embedding implementations were compared at `9b3372c3`; refresh that comparison when implementation starts. The prototype contains simulated installers, example service counts, and example embedding telemetry. It establishes design intent, not production correctness or installer qualification.

The earlier recall failure was traced to the stopped local Koed runtime. After starting it, a focused recall completed and confirmed that navigation/unmounting must not cancel active setup. Shared in-memory installer state and explicit cancellation are retained. The lookup supplied no additional implementation constraints beyond that decision.

## Design contract

- General follows this order: **Appearance → On this device → Optional tools**. Appearance uses B's compact System/Light/Dark control. Optional tools contains the Privacy Filter and Command line cards, side by side when space permits and stacked at narrow widths.
- Preserve the current settings shell, left navigation, typography, neutral surfaces, accent color, spacing, rounded corners, icon treatment, and right-pane scrolling shown by option B.
- Opening any of the four cards/rows replaces the right pane with its nested page. The selected General or Services navigation item stays selected. These entries do not open another popup or expand inline.
- Nested pages have the prototype's parent-labelled back control, heading, description, and content hierarchy. Back and Escape return one level. Return restores the parent scroll position and focus to the originating card/row. Browser back/forward must behave consistently in the browser preview; Electron must provide equivalent in-app navigation without changing unrelated routes.
- Switching General/Services leaves the old detail page. Direct nested-page entry has a valid parent and a safe back destination. Closing and reopening settings preserves existing supported behavior, and does not strand focus or abandon installer work.
- Installation continues when a User leaves a detail page. Returning shows the current job; navigation never starts a duplicate installation or resets progress.
- Services uses B's overview metrics and two navigable status rows. Service health lists actual components on its nested page. Embedding status displays its full telemetry on a separate nested page, without an additional disclosure step.
- Preserve working production capabilities omitted from the narrow prototype. In particular, keep Run setup again available before Optional tools, retain Start/Restart, Open logs, Refresh status, and safe Copy diagnostics behavior, and wire B's Run diagnostics action to actual diagnostics. Unrelated settings sections remain usable.
- Production uses real preferences, installer readiness, supported commands, capability checks, and service/embedding telemetry. It does not ship the prototype switcher, preview-state controls, example data, simulated timers, disabled unrelated tabs, or dependencies on temporary prototype files.

## Scope and implementation constraints

These are desktop settings migration tickets. Reuse the existing desktop installer bridge, shared installation state, preference APIs, status store, and embedding read model. Extend existing regression coverage rather than replacing established behavior with mock success states. Any small prefactor needed to separate reusable setup/status content from its old dialog/disclosure container belongs at the start of the owning slice and must keep existing consumers working.

No new backend synthesis, schema redesign, capture behavior, Privacy runtime selection policy, or embedding algorithm is required. Keep AI Client synthesis and the existing local service boundaries. Existing Privacy rollback-conflict and native release-qualification backlog items remain separate; surface their actual status without claiming this UI migration resolves them. Do not add offline file pickers or manual archive-management flows.

The package does not authorize publishing a release. A minor release was recommended for this user-visible migration. The User explicitly chose to omit the changeset; honor that decision. Update user-facing settings/setup instructions for the new navigation. Update architecture documentation only if implementation changes a documented service or integration flow; otherwise explicitly record that no architecture update is needed.

## Approved breakdown

1. **01 — Ship General and nested command-line setup.** **Blocked by:** none. Delivers B's General layout, live preferences, and an end-to-end command-line install/manage/remove journey; establishes the nested-page navigation used by later slices.
2. **02 — Ship nested Privacy Filter setup.** **Blocked by:** 01. Delivers the other Optional tools card with real install progress, cancellation, recovery, and readiness across navigation.
3. **03 — Ship Services overview and nested service health.** **Blocked by:** 01. Delivers live service health, operational controls, and the shared status/overview presentation used by embedding status.
4. **04 — Ship nested embedding status and overview metrics.** **Blocked by:** 03. Delivers telemetry-backed embedding progress, queues, estimates, and degraded/unknown states through the established Services overview.
5. **05 — Qualify the complete settings journey against the prototype.** **Blocked by:** 02 and 04. Delivers integrated visual/interaction evidence and a real desktop smoke run across setup, navigation, status, and recovery.

After 01, tickets 02 and 03 can proceed independently. Ticket 04 does not depend on 02: an absent optional Privacy Filter must not prevent embedding inspection. Ticket 05 lists only its immediate blockers; 01 and 03 are already transitive dependencies. Every feature slice includes its own validation; 05 is an integrated acceptance gate, not a place to defer basic correctness or design matching.

## Shared validation requirements

### Prototype comparison

For every affected screen, render the implementation and preserved option B reference with equivalent data, viewport, theme, and UI state. Capture both at 100% zoom after fonts have loaded. Compare the complete scrolled content, not only the first viewport.

Use a standard desktop viewport matching the original preview, **1200 × 761**, and a narrow **390 × 700** viewport for layout stress. Compare all six screens in light and dark themes. Verify System follows the operating-system preference. In the actual desktop app, also verify the smallest supported window size; the narrow browser preview is not a claim of a mobile product.

Review shell geometry, selected navigation, section order, card hierarchy, spacing, typography, icon/chevron direction, borders, status colors, button placement, wrapping, scroll behavior, and focus visibility. Use side-by-side captures or overlays; a successful build or DOM assertion alone does not establish visual parity. Record intentional production-only differences and their reason. Do not silently replace the approved layout with a generic settings implementation or copy defects from the prototype.

### State and interaction matrix

| Area           | Required states and journeys                                                                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General        | Appearance and device preference persistence; save/read failure; unsupported controls; Optional tools last; both cards reach nested pages                                                                             |
| Navigation     | Parent → detail → back; Escape; browser back/forward in preview; direct entry; tab switch; close/reopen; focus and scroll restoration; keyboard-only traversal                                                        |
| Privacy Filter | Checking; absent; download with known/unknown total; verification; activation/startup; cancel and cancel failure; retry; install/activation failure; ready; staged/not-ready; missing bridge/packaged-app restriction |
| Command line   | Inspect; absent; install; PATH update; ready; partial PATH failure; retry without reinstalling a valid launcher; removal success/failure; conflicting or unavailable launcher state                                   |
| Service health | Healthy; starting; stopped; needs attention; missing status; optional/unsupported components; action in progress; action failure; refresh after navigation                                                            |
| Embedding      | Working; confirmed idle; unknown progress; unavailable status; unhealthy/incompatible service; absent capability; partial/null telemetry; failed queues; historical-import admission/pause reasons                    |
| Integrated     | Leave setup while running, inspect Services, return to progress/completion; reopen settings and re-read backend state; old status responses do not overwrite newer state                                              |

Use deterministic fixtures for repeatable visual and failure-state comparisons. Add targeted component/bridge tests for the state transitions each slice changes. Real desktop validation must confirm the production bridge and existing installer/status behavior; a fixture-only browser run is insufficient.

Retain evidence with the candidate commit and baseline identifier: paired screenshots, exercised states/actions, expected and observed results, environment, relevant test/check commands, and any remaining limitations. Mark an untested or failed criterion explicitly; do not infer success from a different build, an old report, or the prototype's mock operations.

## 01: Ship General and nested command-line setup

**What to build:** A User can open General in the redesigned desktop, change live appearance/device preferences, find Optional tools at the bottom, and install, inspect, or remove the command line from a nested page while keeping the settings context.

**Blocked by:** None.

**Status:** complete

- [x] Preserve the exact final option B source and fresh captures of all six screens as a durable review artifact or dedicated prototype branch outside the production build. Record its identifier, source revision, and reproduction instructions; retain only non-production artifact references in the evidence record. Verify Optional tools is last before accepting the baseline.
- [x] Introduce the shared nested-page behavior through the working command-line journey. If setup content must be separated from a dialog, do that small prefactor first and keep existing consumers green. Avoid a parallel installer implementation.
- [x] General matches B's ordering and layout. Existing Theme, launch-at-login, menu-bar, graphics, and Run setup again behavior still uses the real supported APIs, including busy, unsupported, and failure states.
- [x] Command line opens in the right pane with the prototype's back control, heading, state panel, installation steps, action placement, ready guidance, and removal action. No setup popup appears.
- [x] Installation requires the existing explicit install action. Use the current launcher inspection, ownership, target/template validity, and PATH checks. Report ready only after verified inspection confirms the command is available to a new shell.
- [x] PATH failure preserves a valid installed launcher. Retry resumes the missing step without reinstalling it; removal keeps the existing PATH-before-launcher ordering and reports partial failures. Do not overwrite an unrelated launcher or unrelated shell configuration.
- [x] The shared navigation contract works for back, Escape, direct entry, tab switching, and focus/scroll restoration. Installation state survives leaving/re-entering the page; repeat clicks and navigation cannot dispatch duplicate work.
- [x] Privacy Filter's card obtains real inspection state and uses an explicit unavailable/incomplete treatment until 02 supplies its full journey; it does not fabricate ready status or dispatch fake setup. The slice can demonstrate the complete command-line path independently.
- [x] Relevant existing preference and command-line regressions pass. Add meaningful coverage for nested navigation, stale inspection responses, partial PATH failure, background continuation, and removal failure.
- [x] Provide prototype-versus-implementation evidence for General and Command line using the shared validation requirements, plus a real supported desktop install/inspect/remove smoke run in an isolated test environment. Update command-line navigation instructions.

## 02: Ship nested Privacy Filter setup

**What to build:** A User can set up and manage the optional Privacy Filter from its General card, see accurate progress and readiness, and safely leave and return while installation continues.

**Blocked by:** 01 — its General layout, nested navigation, and shared setup presentation/lifecycle are the integration surface.

**Status:** in-progress

- [x] The Privacy Filter card and nested page match the approved B reference, including title, description, status panel, setup steps, download progress, action placement, and back behavior. Optional tools remains the final General section.
- [x] Use the existing Privacy installation bridge and shared job state. Entering the page only inspects status; downloading/installation starts only through the explicit install action. Missing bridge or packaged-app-only operation gets an accurate status-only treatment rather than a futile action.
- [x] Preserve runtime/model download, verification, activation, service startup, active provider/fallback information, and real error reporting. Unknown download totals remain indeterminate; no invented size or timer-derived readiness is shown.
- [x] Ready requires the existing verified service/model readiness result. Staged assets, downloaded files, incomplete core setup, or failed activation/startup do not produce an Installed/ready success claim.
- [x] Cancel is offered only while supported; a failed cancellation can be retried, and activation cannot be interrupted through an invalid cancel control. Retry preserves the existing verified-cache and recovery behavior.
- [x] Moving to General, Services, another settings section, or closing/reopening settings does not discard active progress. Re-entry inspects current readiness without allowing stale responses to overwrite a newer job.
- [x] Card state and service visibility come from current backend capabilities/status. Optional absence does not block Personal Memory or create a false running service. No new offline-install UI is introduced.
- [x] Existing install/cancel/stale-read/activation-failure regressions pass. Add coverage for continuing through nested-page navigation, capability restrictions, indeterminate progress, and visible recovery errors.
- [ ] Provide paired visual evidence for idle, progress, failed, and ready screens; demonstrate cancellation/retry and navigation during installation. Include a real supported packaged-desktop installation/readiness check, clearly separated from simulated failure fixtures and broader native release qualification.
- [x] Update Privacy setup instructions to describe nested navigation and background continuation. Keep known rollback-conflict limitations visible rather than expanding this ticket into unrelated installer recovery work.

## 03: Ship Services overview and nested service health

**What to build:** A User can assess Koed's local services from B's overview, inspect component-level health in a nested page, and run the existing service controls without losing truthful status or error feedback.

**Blocked by:** 01 — uses the established settings navigation and detail-page shell. Privacy installation in 02 is not a prerequisite.

**Status:** complete

- [x] Services adopts B's overview hierarchy: metrics, navigable status rows, operational actions, and last-updated feedback. The Service health row opens a nested right-pane page; neither the overview nor the detail page uses inline service expansion.
- [x] Use the current status store and supported component set. Include offered Server package, API, Database, Redis, Worker queues, Embedding Service, Privacy Filter Service, Local AI Runtime, local runtime credential, MCP Server, Capture Hook, LCM Summary Service, and Personal Device Sync status. Omit unsupported components and calculate totals dynamically.
- [x] Distinguish healthy, starting, stopped/not-configured, needs-attention, loading, and unavailable states. An empty or missing snapshot cannot imply all services are healthy. Optional Privacy Filter presence reflects backend status, not a local UI flag or hardcoded count.
- [x] Refresh on relevant entry and reuse/coalesce existing status work. Keep transitional status responsive without adding an unbounded polling loop or multiplying control requests across the overview and nested pages.
- [x] Preserve actual Start/Restart, Open logs, Refresh status, and Copy diagnostics functionality. Wire Run diagnostics to the existing diagnostic command. Busy/error feedback prevents duplicate dispatch, and a failed stop during restart must not proceed to start or claim success. Copied diagnostics retain the existing allowlist and never expose credentials or captured content.
- [x] Service health uses B's full readout layout, parent-labelled back control, error text, and keyboard/focus behavior. Status updates while the detail is open without requiring the User to reopen it.
- [x] Existing service command/failure and diagnostics-sanitization coverage passes. Add targeted coverage for offered component counts, stale/unavailable snapshots, navigation, and concurrent refresh behavior.
- [x] Compare the Services overview and Service health page against the prototype in healthy, starting, attention, and unavailable states. Supply a real desktop refresh/diagnostics/logs smoke result and controlled start/restart success/failure evidence. Any embedding metrics awaiting 04 are unavailable, not fabricated.

## 04: Ship nested embedding status and overview metrics

**What to build:** A User can see current embedding progress on Services and open the nested Embedding status page for model readiness, pending work, throughput, queues, Projection, and historical-import details.

**Blocked by:** 03 — extends its live Services overview, capability handling, and shared snapshot/refresh lifecycle.

**Status:** complete

- [x] The overview's pending-embedding and throughput metrics and Embedding status row use the existing embedding snapshot. The row opens a nested page with the prototype's heading, parent back control, full readout, and no disclosure arrow or second expansion step.
- [x] Show Embedding Service readiness, actual/expected model compatibility and dimensions; pending Memory Events and Memory Nodes/summary counts and estimated tokens; drain estimate when meaningful; throughput window, retries and failures; Memory and LCM queue counts; Live Projection and waiting-for-agent-turn counts; historical-import backlog/bytes and admission/pause reason.
- [x] Calculate counts, labels, time estimates, and units from current telemetry using existing semantics. Historical import correctly reports live-capture priority and other backend pause reasons; it does not imply stalled work is lost or complete.
- [x] Distinguish confirmed idle, working, unknown progress, unavailable telemetry, unhealthy service, and incompatible model. Missing backlog is not zero; no telemetry is not up to date. Omit unsupported embedding capability, and show explicit unavailable values for supported but unreadable telemetry.
- [x] Zero, null, missing, large, and partial values render without broken layouts, misleading progress bars, fixed prototype totals, or invented percentage completion. Independent unavailable metrics remain unavailable rather than borrowing a healthy service state.
- [x] The overview and detail stay consistent as status changes. Back, Escape, direct entry, refresh, and switching away/back follow the shared navigation and status rules without duplicate work.
- [x] Extend existing embedding regression coverage for supported/missing capability, idle versus unknown, queue failures, model mismatch, partial telemetry, drain-estimate availability, and all historical-admission pause reasons. Reuse the backend read model; no synthesis or embedding policy changes are introduced.
- [x] Compare the Services overview and Embedding status page against B with equivalent working, idle, attention, and unavailable fixtures in both themes and viewport sizes. Validate additional production-only unknown/partial states for accurate copy and layout, then verify real telemetry in the desktop app.

## 05: Qualify the complete settings journey against the prototype

**What to build:** A reviewer can reproduce the complete production settings journey and verify that it matches the accepted prototype while using real desktop preferences, installation, and status behavior.

**Blocked by:** 02 — Privacy Filter journey; 04 — completed Services/embedding journey. Their prerequisites already include 01 and 03.

**Status:** in-progress

- [x] Run the shared visual comparison matrix against the preserved final B baseline for all six screens. Specifically prove the final General order and nested-page behavior; stale popup/disclosure references or screenshots with Optional tools above device settings are not valid evidence.
- [x] Complete an integrated journey: change and reload preferences; enter each Optional tools page; begin setup, return to General, inspect Services, and revisit progress/readiness; inspect service and embedding details; exercise Back, Escape, close/reopen, and browser history where supported. Verify focus/scroll restoration and no duplicate operations or lost state.
- [ ] Complete a supported packaged-desktop smoke run using the real bridge in an isolated test environment. Record actual launcher/PATH verification, Privacy Filter readiness, status refresh, diagnostics, and service actions. Keep broader release signing/platform qualification separate and state any environmental limitations.
- [x] Check keyboard-only access, meaningful names/headings and status announcements, readable focus, light/dark/System behavior, reduced motion, narrow layout, and the smallest supported desktop window. Nested content/actions remain reachable by scrolling; no horizontal overflow or trapped focus is accepted.
- [x] Confirm the other settings sections, existing AI Client confirmation behavior, agent settings, Run setup again, safe diagnostic copying, and unavailable-capability behavior still work. Remove temporary migration placeholders; ship no fixture status, prototype route/switcher, simulated mutation, or dependency on prototype artifacts.
- [x] Run the applicable full formatting/lint checks, desktop typecheck/build, affected unit/component suites, and targeted renderer/desktop validations against the final candidate. Explain any targeted equivalent or unavailable environment. When a PR is opened or updated, monitor its checks to completion under repository guidance.
- [ ] Attach an acceptance record mapping every ticket criterion to evidence, the prototype baseline identifier, final candidate commit, viewport/theme/state, test result, and explicit limitation/deviation. Resolve design mismatches; obtain a User decision for intentional material departures before marking parity complete.
- [x] User-facing setup/navigation documentation matches the delivered flow. Record whether an architecture-documentation update was required. Obtain the required release/changeset decision and keep unrelated follow-ups in the established implementation backlog rather than the domain glossary.
- [ ] Mark the package complete only when the feature slices and integrated gate pass. A successful browser prototype, screenshots alone, or green compilation does not substitute for the real integration checks.

## Acceptance record — 3 November 2026

Implementation candidate: `72e35c36` on `feat/settings-parity`, based on `835371e1`. The review artifact records hashes of every changed production/test source file and the exact candidate commit. This work-package record is committed separately so its candidate identifier refers to the implementation being validated.

### Evidence

- **Baseline:** `settings-parity-baseline`, source parent `835371e1`, archive SHA-256 `6257cbb1bc73e99aeba71ef42b21eaf5ea00fabc8ce349498eef95b9e95f6a47`. Preserved source, source hashes, and six light/six dark captures establish the final B reference with Optional tools last.
- **Design review:** `settings-parity-review` contains the paired review index, source manifest, screenshots, structured reports, and validation results. The base matrix covers all six screens × two themes × three viewports (1200×761, 960×640, 390×700) × reference/implementation: 72 combinations and 124 top/bottom captures. Additional service states cover 72 combinations and 102 captures; setup progress/failure/ready states cover 40 combinations and 50 captures. All 184 combinations pass content-width checks. Top/bottom captures cover the complete scrolled content. Visual inspection corrected action contrast, heading wrapping, step spacing, and active-step treatment at narrow widths.
- **Interaction checks:** isolated Electron fixtures pass General order; nested Back/Escape and browser forward; focus/scroll restoration; command-line installation across close/reopen and removal; Privacy cancellation, failure, retry, and continuation through Services; nested health navigation; Light/Dark/System; and reduced motion. Fixtures establish repeatable UI behavior, not native installation readiness.
- **Component regression:** 83 affected settings/Preferences/installation tests pass. The full desktop Vitest run passes 1,284 tests; 20 listener tests were denied by sandbox EPERM. The complete affected pairing file passes all 22 tests outside the sandbox, accounting for all 1,304 tests. The seven packaged-renderer helper tests pass outside the sandbox.
- **Static/build checks:** full formatting and full lint pass (lint needs an 8 GB Node heap in this environment). Final targeted lint, desktop typecheck, renderer build, full desktop build, and local macOS packaging pass. The host uses Node 26 despite the server package's Node 24 engine declaration; packaged runtime checks use Electron 39.8.10. Homebrew native assets are staged through the repository's smoke helper; this is local development validation, not signing or distribution qualification.
- **Native packaged smoke:** the real packaged bridge passes runtime/model verification, first start and health, core/Codex setup, stop/restart/reconnect, renderer fault recovery, and Team fail-closed behavior. The cold onboarding inspection took 10.5 seconds: its previous five-second helper timeout was insufficient. The helper now keeps the same enabled-control assertion with a 30-second startup-only deadline and tested timeout diagnostics; other waits retain five seconds.
- **Native settings journey:** isolated packaged validation completes real core setup, opens General, installs the command line through the native destination dialog, verifies Koed launcher ownership/current template/valid target/configured PATH, then removes both launcher and managed PATH entry. Live Services reports 12/13 healthy, accurately showing attention; live embedding telemetry reports the ready qwen3-0.6b model, 1,024 dimensions, empty queues, and no pending history. A fresh isolated zsh resolves the installed launcher and runs `koed status --json` successfully; its stopped-runtime attention state is preserved rather than called healthy. The first shell probe found an existing host launcher because inherited PATH took precedence; the corrected probe isolates PATH and the shell startup directory. Real settings diagnostics reports “Diagnostics completed,” the logs bridge succeeds, and the nested health page reflects live status.
- **Privacy restriction:** Personal mode accurately reports that Privacy Filter is not required. A separate Team-enabled packaged inspection reports: “Required component manifest pins are unavailable in this Desktop release.” No ready state or successful installation is inferred. The User confirmed that no approved compatible catalog/artifact is available. The available remote catalog targets v0.10.2, while this candidate is v0.10.0, so it is not substituted. Live Privacy installation/readiness remains unverified.

### Criterion mapping and remaining gates

Criteria are numbered in the order listed within each ticket. A checked criterion means the evidence above covers its full scope; partial criteria remain unchecked.

| Ticket | Evidence and qualification status                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01     | Criteria 1–9 are covered by the preserved baseline, production APIs/shared installer state, component regressions, and interaction matrix. Criterion 10 has paired captures, updated navigation documentation, a native install/inspect/remove result, and successful fresh-shell resolution/invocation.                                                                                                                             |
| 02     | Criteria 1–8 and 10 are covered by shared installer regressions, state captures, navigation checks, and updated Privacy instructions. Criterion 9 is partial: deterministic cancellation/retry and paired idle/progress/failure/ready evidence pass, but live packaged installation/readiness is blocked by unavailable compatible manifest pins.                                                                                    |
| 03     | Criteria 1–7 are covered by dynamic component/status tests, existing action/error/sanitization tests, and paired readouts. Criterion 8 has the paired state matrix and packaged start/restart/health evidence; real settings diagnostics/logs and nested health also pass. The prototype has no starting preview; production-only starting captures validate truthful labels and the established overview/readout layout separately. |
| 04     | Criteria 1–8 are covered by the read-model/partial-state regressions, paired working/idle/attention/unavailable captures, nested interaction checks, and real packaged embedding readout.                                                                                                                                                                                                                                            |
| 05     | Criteria 1, 2, 4, 5, 6, and 8 are covered by the integrated evidence and documentation. Criterion 3 is partial because native Privacy readiness is unverified. Criterion 7 records candidate `72e35c36`, the baseline, and the evidence above; complete acceptance remains open because native Privacy readiness is unverified. Criterion 9 remains open while 02's live installation gate is open.                                  |

### Intentional production differences

The production sheet omits the prototype toolbar, preview-state controls, and example-data footers, and uses the freed vertical space. Other settings tabs stay enabled; at the narrow stress width their navigation scrolls horizontally while page content stays within its width. Run setup again, Copy diagnostics, and service actions remain available as required by the design contract. Production failure steps retain explicit recovery/error indicators and backend messages. These differences preserve approved production requirements; they do not introduce a different navigation pattern.

The new Desktop settings guide and updated Privacy installation guide describe the delivered navigation and background continuation. Service boundaries, ingestion, storage, embedding policy, and AI Client integration flow are unchanged, so no architecture-documentation update or new ADR is required. The User approved omitting the changeset. No release was published.

**Completion gate:** do not mark this package complete until a compatible approved manifest catalog is available and the live Privacy installation/readiness check passes, the complete acceptance result is recorded against the identified candidate. Do not replace those checks with simulated success or weaken manifest verification.
