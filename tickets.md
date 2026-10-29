# Optional Privacy Filter runtime: tickets

Source: [Optional Privacy Filter plan](/Users/hill399/code/@koed-labs/koed-alt/PLAN.md).

These tickets turn the plan into independently verifiable slices.
They use one combined file as requested.
The User approved the ticket breakdown and blocking edges on 2026-10-29.
The User also authorized CUDA compatibility detection, separate CPU/CUDA downloads, and CPU fallback within this work package.
Qualification uses three stages: this Mac, a Linux container or VM without CUDA, and the colleague's CUDA-compatible machine.
Statuses below record current progress. Start only tickets whose blockers are complete.

## Approved breakdown

1. Establish a reproducible Base/Privacy packaging boundary. Blocked by: None. Delivers the baseline, CUDA compatibility rules, and authenticated variant contract.
2. Run Personal Memory from a Desktop app without Privacy payloads. Blocked by: 01. Delivers the smaller base app, complete CPU/CUDA Privacy variants, and composition enforcement.
3. Install the Privacy runtime and model through one action. Blocked by: 02. Delivers capability-based download selection, actual inference, and CPU fallback.
4. Recover interrupted Privacy installations. Blocked by: 03. Delivers cancellation, retry, and relaunch without false readiness or partial activation.
5. Reject invalid Privacy assets before sharing. Blocked by: 03. Delivers demonstrated integrity enforcement through the packaged installation path.
6. Preserve safe Privacy selection during upgrades and concurrent operations. Blocked by: 03. Delivers version-safe upgrades and supported activation recovery.
7. Qualify the implementation on this Mac. Blocked by: 04, 05, 06. Delivers local regression results, macOS packaged acceptance, and a reproducible candidate for Linux testing.
8. Qualify Linux CPU and fallback behavior in Docker or a VM. Blocked by: 07. Delivers Linux CPU evidence and a tested CUDA handoff package.
9. Qualify native CUDA with the colleague. Blocked by: 08. Delivers real CUDA inference and GPU-to-CPU fallback evidence for the candidate.
10. Complete the release evidence and documentation. Blocked by: 09. Delivers the consolidated acceptance record and enforced release gates.

Tickets 04 through 06 have no dependency on one another.
Tickets 07, 08, and 09 form the three qualification stages. Each produces the tested candidate and handoff needed by the next.
Ticket 10 consolidates their results and depends on the earlier work through ticket 09.
No ticket authorizes publication or implementation outside the approved plan.

## Qualification environments and ownership

The User's current Mac is arm64 and has no CUDA-compatible GPU.
The colleague owns the real CUDA qualification run.
Confirm the colleague's operating system, architecture, GPU, and driver before the handoff. A compatible GPU alone does not establish a supported target.

| Stage        | Owner and environment                                                      | What it establishes                                                                                                     | Evidence it cannot replace                                                                                 |
| ------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1, ticket 07 | User and agent on this Mac                                                 | Code regressions, simulated compatibility cases, artifact inventories, real macOS inference, and packaged app behavior. | Linux execution and real CUDA execution.                                                                   |
| 2, ticket 08 | User and agent in Docker or a Linux VM without GPU access                  | Linux CPU installation, no-GPU selection, CPU inference, and the CUDA bundle's CPU fallback path.                       | Successful CUDA initialization or GPU execution. Emulated x64 also cannot establish native x64 acceptance. |
| 3, ticket 09 | Colleague on a supported Linux x64 environment with real NVIDIA GPU access | Native target acceptance, actual CUDA inference, and recovery from CUDA failure to CPU.                                 | macOS signing and packaged acceptance.                                                                     |

Record the host architecture, guest architecture, container or VM configuration, and any emulation in every Linux report.
Use the published Linux x64 artifacts. An arm64 Linux guest does not become a supported artifact target through this test plan.
Docker and Linux VMs are test environments here. They do not replace the product's bundled-local installation path.

## Implementation completion and qualification

Tickets 01 through 06 implement the behavior and include available local tests and controlled failure fixtures.
Their completion records identify the native acceptance owned by tickets 07 through 09.
They do not wait for the colleague to run CUDA before implementation can progress.

Do not mark native CUDA behavior as passed because a fixture selected CUDA or a mock returned success.
Stages 1 and 2 remain useful completed evidence while the colleague's run is pending.
The release remains unqualified until all required stage results pass for the final candidate.

## Shared constraints

Each implementation ticket includes its own regression tests and relevant documentation.
A verification ticket includes fixes for failures within its stated behavior.
An unavailable target, credential, or hardware test remains outstanding evidence.

- Preserve the inference engine, model, tokenizer, and masking rules. Limit provider changes to CPU/CUDA delivery, compatibility selection, and fallback.
- Select the Linux download by operating-system, architecture, NVIDIA GPU, and driver compatibility. Use CPU if compatibility is absent or inconclusive.
- Keep performance benchmarking out of download selection. Preserve existing runtime calibration, contention handling, and macOS behavior.
- Keep CPU support inside the CUDA bundle so fallback needs no second runtime download.
- Reuse the existing Base/Privacy components and model installer. Keep runtime and model downloads separately authenticated.
- Preserve shared Base dependencies, required native assets, licenses, and standalone service behavior. Update shared component consumers for variant compatibility.
- Preserve embedded manifest authority, model hashes, lifecycle locks, ownership rules, and immutable release assets.
- Keep required Team sharing blocked when filtering is unavailable. Never substitute unfiltered content after installation failure.
- Preserve external Privacy Filter configuration and remote connections that do not require local downloads.
- Keep the separate Python privacy engine and unrelated embedding/CUDA runtime assets outside this work.
- Use synthetic privacy examples and isolated profiles. Do not rely on checkout dependencies or global module lookup.
- Follow the repository release process, including changeset confirmation before adding or omitting an implementation changeset.

## 01: Establish a reproducible Base/Privacy packaging boundary

**What to build:** Give maintainers a reproducible inventory of the shipped app and the dependency boundary needed to remove Privacy safely.
Prepare any necessary shared assembly refactor before changing Desktop behavior.
Reuse existing assembly APIs directly when they already meet the requirement.
Define the bounded compatibility check and the identity rules for independently authenticated CPU and CUDA bundles before implementing download selection.

**Blocked by:** None (can start immediately).

**Status:** complete (Mac assessment; native execution remains with tickets 07–09)

- [x] Record the source revision, dependency lockfile identity, toolchain, target, and build configuration for the baseline artifact.
- [x] Inventory the application archive, unpacked files, copied resources, and nested native dependencies.
- [x] Report compressed and expanded sizes separately, including duplicate copies and Privacy-attributable bytes.
- [x] Separate measured Electron results from the earlier standalone package measurements.
- [x] Map direct, transitive, optional, peer, and dynamic dependencies to Base, Privacy, or shared ownership.
- [x] Resolve any Base dependency on ONNX before declaring the removal boundary safe.
- [x] Record the component and Desktop target matrices without introducing a new supported target.
- [x] Record install-flow gaps across runtime provisioning, model provisioning, activation, readiness, and existing installations.
- [x] Define compatibility against the packaged CUDA provider's supported operating system, architecture, GPU, driver, and required libraries.
- [x] The decision table selects CUDA only when compatibility is established, respects explicit CPU preference, and otherwise selects CPU.
- [x] Missing tools, timeouts, incompatible drivers, and inconclusive probes have deterministic CPU outcomes with recorded reasons.
- [x] The probe needs no CUDA payload download or performance benchmark. Existing runtime calibration remains outside this decision.
- [x] Map CPU-only and CUDA-enabled native files, including CPU fallback and any TensorRT retention requirements in the CUDA variant.
- [x] Define variant identities across manifests, archive lookup, catalog keys, caches, and generation selection, including migration for affected consumers.
- [x] If adaptation is necessary, expose the reusable assembly boundary while preserving current consumers and outputs.
- [x] Demonstrate equivalent assembly behavior and isolated dependency resolution after any prefactor.

Completion evidence: The baseline inventory, dependency map, compatibility decision table, variant contract, install-flow findings, and assembly regression results.

Evidence: [Assessment and authenticated variant contract](docs/optional-privacy-runtime-assessment.md). Rebuilt macOS baseline, complete byte/package inventories, zero unresolved Base/Privacy edges, and 43 focused assembly/inventory tests passed. No behavior-changing assembly prefactor was required. The User authorized proceeding without Koed recall and requested omission of the changeset.

## 02: Run Personal Memory from a Desktop app without Privacy payloads

**What to build:** Deliver a base Desktop app that supports Personal Memory without carrying or downloading the Privacy Filter runtime.
Make accidental reintroduction of Privacy-only payloads fail the packaging pipeline.
Keep the optional Privacy component complete and independently usable.
Build distinct Linux CPU-only and CUDA-enabled variants with trusted identities and the same separately pinned model assets.

**Blocked by:** 01: Establish a reproducible Base/Privacy packaging boundary.

**Status:** complete (implementation; native release qualification remains with 07–09)

- [x] Desktop consumes the shared Base assembly output rather than deploying all services and deleting only a wrapper.
- [x] The packaged app contains no Privacy service payload, ONNX Runtime, model weights, or dependencies owned only by Privacy.
- [x] Composition enforcement covers application archives, unpacked files, resources, nested packages, and duplicate copies.
- [x] An intentionally reintroduced Privacy dependency makes the composition test fail.
- [x] Base retains its required services, shared dependencies, migrations, prompts, licenses, and native assets.
- [ ] Both Linux Privacy variants retain complete dependency sets for their supported providers, while the macOS payload remains unchanged.
- [ ] Artifact inventory proves that the CPU variant excludes CUDA and TensorRT provider payloads. Ticket 08 owns real Linux CPU inference.
- [ ] The CUDA variant retains required GPU libraries and the CPU path, with assembly regression coverage. Tickets 08 and 09 qualify execution.
- [x] Variant identity is authenticated in manifests, catalog keys, archive lookup, caches, and generation selection.
- [x] The complete release matrix and affected component consumers support both Linux variants without accepting ambiguous identities.
- [x] Published artifacts and old pins remain immutable. Unsupported manifest or variant identities fail with an actionable compatibility error.
- [x] File inventories and manifests match the final payload, with the existing signing order preserved.
- [x] A fresh packaged app captures and recalls Personal Memory with Team disabled and empty Privacy caches.
- [x] That Personal Memory run neither downloads Privacy assets nor loads them from checkout or global dependencies.
- [x] Existing external-service and remote-connection modes avoid unnecessary local Privacy installation.
- [ ] Comparable artifact reports show the actual size change without promising inference speed improvements.
- [x] Composition enforcement runs before signing and against the final packaged app in CI.

Completion evidence: A working macOS base artifact, local Personal Memory acceptance, authenticated Privacy variant inventories, and separate size reports.
Linux and CUDA execution evidence belongs to tickets 08 and 09.

Implementation evidence: shared Base staging, composition gates, variant-aware manifests/catalog/store/CLI/release consumers, authenticated Personal Memory capture and retrieval without Privacy, 71 assembly/inventory/package-boundary checks (including five catalog cases rechecked after correcting their fixture), and 98 distinct trust/store/lifecycle checks passed. Eight lifecycle cases initially required process-identity access outside the sandbox and then passed. The first Mac artifact size comparison is recorded in [the assessment](docs/optional-privacy-runtime-assessment.md).

The implementation blocker for 03 is complete under the implementation/qualification split above. Unchecked final Linux variant inventories and matching final size reports remain explicit release evidence in 07–09; controlled file-policy fixtures are not native Linux execution. The latest expanded ownership exclusions will be regenerated in the qualification candidate. Signed clean-Mac acceptance remains outstanding.

## 03: Install the Privacy runtime and model through one action

**What to build:** Let a User enable local filtering through one optional Privacy Filter installation action.
The action coordinates runtime and model provisioning, then activates a healthy service before enabling required Team sharing.
Users see the actual installation state and download progress.
On supported Linux devices, choose the variant through the compatibility check and validate actual inference after installation.

**Blocked by:** 02: Run Personal Memory from a Desktop app without Privacy payloads.

**Status:** complete (implementation; unchecked native acceptance remains with 07–09)

- [x] The action reuses the existing runtime component and model installers without introducing a combined archive format.
- [x] A bounded local probe selects CUDA only when the device meets the packaged provider requirements. Other results select CPU.
- [x] Download selection respects explicit CPU preference and preserves macOS behavior without introducing a speed benchmark.
- [x] The installer authenticates the selected variant and never downloads GPU provider payloads for the CPU-only Privacy path.
- [x] Consent covers both required downloads, with an accurate size estimate or an explicit unknown-size state.
- [x] Progress distinguishes runtime download, model download, authentication, activation, and service startup.
- [x] Both assets pass their existing integrity rules before the installation reports readiness.
- [x] Status distinguishes missing runtime, missing model, pending activation, and failed startup.
- [x] An active runtime component alone cannot produce a ready state when its model or service is unavailable.
- [x] Setup, activation, and startup retain the existing operation queue, lifecycle locks, and supported recovery behavior.
- [x] Existing cancellation remains reachable while a download is active.
- [x] A clean packaged app with empty Privacy caches completes installation and performs actual masking.
- [x] The service uses the intended installed component and pinned model without hidden bundled dependencies.
- [x] Post-installation validation requests CUDA explicitly and records the actual provider. Controlled fixtures cover this logic before native qualification.
- [x] Controlled failure tests prove that the installer selects authenticated CPU fallback and reports the reason when CUDA fails.
- [x] Required sharing remains blocked until CPU fallback passes inference and service readiness if CUDA fails.
- [x] Status distinguishes compatibility evidence, selected bundle variant, and active provider, including fallback reasons.
- [x] Existing explicit runtime controls retain their error behavior, with their relationship to automatic install fallback documented.
- [x] Required sharing stays blocked until service readiness and becomes available after successful installation.
- [x] Relaunch reports the installed state accurately and reuses authenticated assets without unnecessary downloads.
- [x] The installation state transitions and user instructions document the delivered behavior.

Completion evidence: A local packaged installation demonstration and controlled tests for variant selection, fallback, readiness, and sharing gates.
Tickets 08 and 09 own the actual Linux CPU and CUDA execution results.

Implementation evidence: Coordinated authenticated runtime/model provisioning, bounded compatibility selection, ONNX execution evidence, synthetic masking, authenticated service readiness, pending-core-setup handling, and recovery are implemented. Packaged Mac cached installation and ordinary relaunch passed, as did native CPU and CoreML checks. Fresh model downloading and installation with empty Privacy caches passed after User LuLu approval. The runtime came from an authorized offline fixture, so exact release-URL runtime downloading remains open. The native Team fixture proved required protected source publication and authorized sanitized reads only after filtering became available. Browser grant creation and native Linux/CUDA execution were not exercised. See [Mac qualification](docs/optional-privacy-mac-qualification.md).

## 04: Recover interrupted Privacy installations

**What to build:** Let a User cancel or retry an installation without losing a valid runtime selection or seeing false readiness.
Recover from network errors, insufficient disk space, and application exit during provisioning.
Preserve authenticated staged assets when the existing installer can safely reuse them.

**Blocked by:** 03: Install the Privacy runtime and model through one action.

**Status:** complete (implementation; unchecked native acceptance remains with 07–09)

- [x] Cancellation works during runtime and model downloads without waiting behind the installation queue.
- [x] The UI identifies the activation boundary after which the operation must finish or recover.
- [x] Network failures and insufficient disk space produce actionable errors without activating partial assets.
- [x] Failure of either download does not mark the overall installation as ready.
- [x] Retry reuses valid completed assets and rejects corrupt or incomplete cache entries.
- [x] Retry retains the authenticated variant identity and shared model cache, and CPU fallback does not trigger another runtime download.
- [x] Relaunch after exit during provisioning reconstructs an accurate state and offers a usable retry path.
- [x] Every failure leaves a valid previous selection unchanged or clearly reports that service recovery remains incomplete.
- [x] Required sharing remains blocked throughout incomplete installation and recovery.
- [x] Automated failure injection covers both download stages and the transition into activation.

Completion evidence: Demonstrations and regression results for cancellation, network interruption, disk exhaustion, retry, and relaunch.

Implementation evidence: Component/model cancellation, interrupted transfer/retry, abandoned partial-file fixtures, ENOSPC/network/inference injection, operation exclusion, and activation-boundary checks passed. Actual packaged download failure preserved selection and remained unready. Cached retry and ordinary relaunch passed. Actual SIGKILL during packaged runtime staging, safe relaunch, and verified retry now passed. See [Mac qualification](docs/optional-privacy-mac-qualification.md).

## 05: Reject invalid Privacy assets before sharing

**What to build:** Demonstrate that the packaged installation action rejects substituted, corrupt, or incompatible executable and model assets.
Keep trust rooted in the trusted app and its embedded manifest pins.
Show an actionable failure without executing the rejected payload or enabling required sharing.

**Blocked by:** 03: Install the Privacy runtime and model through one action.

**Status:** complete (implementation; unchecked native acceptance remains with 07–09)

- [x] Missing catalog authority and changed canonical manifest pins prevent component admission.
- [x] Wrong product version, component identity, platform, architecture, or declared native compatibility prevents admission or execution.
- [x] Renamed archives, mismatched variant metadata, or stale cache entries cannot substitute one Privacy variant for another.
- [x] An incomplete or conflicting variant catalog fails admission. Old pins cannot authenticate newly introduced variants.
- [x] Corrupt archives, wrong sizes, missing files, and altered installed files fail the applicable integrity checks before use.
- [x] Unsafe archive paths and escaping links cannot write or load code outside the admitted component.
- [x] Corrupt or substituted model files fail their independent pinned-hash rules.
- [x] A checksum supplied beside a substituted archive cannot replace the authority embedded in the app.
- [x] The packaged behavior accepts an authorized fixture and rejects a mismatched fixture through the actual installer path.
- [x] Every rejection preserves selection integrity, reports the reason, and keeps required sharing blocked.
- [x] Integrity rejection never triggers execution of the rejected assets. CPU fallback uses only an authenticated and healthy runtime.
- [x] Regression tests exercise behavior rather than only inspecting source text or catalog exports.

Completion evidence: Positive and negative packaged admission results with artifact identities and proof that rejected assets were not used.

Implementation evidence: The actual packaged action rejected substituted manifest authority and corrupted archive bytes before model downloading or execution. The authorized fixture passed the same admission path and real inference. Pin/catalog/variant/target/runtime/archive/cache/model rejection checks passed. These are controlled fixtures and Mac results, not Linux/CUDA execution. See [Mac qualification](docs/optional-privacy-mac-qualification.md).

## 06: Preserve safe Privacy selection during upgrades and concurrent operations

**What to build:** Keep a User's runtime selection valid across app upgrades, overlapping management requests, and failed activation.
Reuse the existing ownership and lifecycle rules.
Recover only through supported version-matched selections without changing user data.

**Blocked by:** 03: Install the Privacy runtime and model through one action.

**Status:** complete (implementation; unchecked native acceptance remains with 07–09)

- [x] Upgrade acceptance starts from the current distributed Desktop release with an installed Privacy component and model.
- [x] The updated app identifies incompatible older Privacy assets and obtains the matching component before local filtering resumes.
- [x] Installation, repair, and upgrade reassess CUDA compatibility and select the correct version-matched variant.
- [x] Ordinary relaunch reuses authenticated assets without automatically downloading a different variant.
- [x] If CUDA becomes unavailable after a driver or hardware change, the installed CUDA bundle can run its authenticated CPU path.
- [x] No runtime combines Base and Privacy components from incompatible product versions.
- [x] Concurrent setup, installation, activation, and startup requests retain queue ordering and cross-process lifecycle protection.
- [x] Active runtime pins and ownership rules prevent unauthorized replacement of a running selection.
- [x] Activation and restart failure tests preserve or restore the supported same-version selection.
- [x] A failed recovery leaves an explicit stopped or unavailable state rather than claiming readiness.
- [x] Existing downgrade rejection remains effective, and runtime recovery does not imply database rollback.
- [x] User data and valid reusable model assets survive the upgrade.
- [x] External-to-local Privacy transitions invoke the optional install flow, while external configuration remains usable without local assets.

Completion evidence: Upgrade, concurrent-operation, transition, and recovery results from isolated packaged installations.

Implementation evidence: Expected-selection comparison runs inside lifecycle/store locks for activation and rollback. Controlled ownership, active-pin, downgrade, upgrade-ordering, concurrent selection, same-version recovery, and persisted CPU-fallback checks passed. Packaged retry/relaunch retained authenticated assets. The actual v0.8.1 distributed packaged CLI to new Desktop upgrade also passed with synthetic memory, matching classification spans, and reused model assets. Packaged external-to-local availability and activation also passed; the native fixture Worker consumed an external Privacy endpoint without local model assets. The old GUI was not automated. See [Mac qualification](docs/optional-privacy-mac-qualification.md).

## 07: Qualify the implementation on this Mac

**What to build:** Establish everything the User can prove on this arm64 Mac before asking for Linux or CUDA help.
Exercise the actual macOS app and preserve its existing provider behavior.
Produce identified artifacts and reproducible instructions for the Linux stage.

**Blocked by:** 04: Recover interrupted Privacy installations. 05: Reject invalid Privacy assets before sharing. 06: Preserve safe Privacy selection during upgrades and concurrent operations.

**Status:** in-progress (available Mac checks passed; remaining acceptance gates are explicit)

- [x] Formatting, lint, relevant typechecks, builds, and applicable regression suites pass on this Mac.
- [x] Controlled fixtures cover compatible CUDA, incompatible drivers, missing probe tools, timeouts, inconclusive results, and explicit CPU preference.
- [x] Fixture evidence is labeled as simulated behavior and makes no claim of real CUDA execution.
- [x] Final macOS application archives, unpacked files, and resources contain no Privacy-only payloads.
- [x] A fresh isolated profile captures and recalls Personal Memory without Privacy assets or downloads.
- [ ] The packaged app downloads the macOS Privacy runtime and model, then performs real masking with its supported providers.
- [x] Missing assets, cancellation, retry, integrity rejection, upgrade, and recovery preserve honest readiness and blocked sharing.
- [x] Existing macOS provider selection, runtime calibration, and contention handling remain unchanged.
- [x] Masking fixtures preserve labels, spans, UTF-8 offsets, secret handling, and final output within existing tolerances.
- [ ] Signed/notarized acceptance uses the actual release candidate when available, including a CI-produced candidate if signing is unavailable locally.
- [x] Reports distinguish ordinary developer-profile tests, isolated-profile tests, and required clean-environment signing acceptance. Missing signing evidence remains a release gate.
- [x] Every report records artifact digests, model identity, runtime versions, architecture, provider, and environment isolation.
- [x] The Linux handoff includes exact candidate artifacts, trusted catalog provenance, synthetic fixtures, prerequisites, and executable test instructions.

Completion evidence: The Mac qualification report and a reproducible Linux candidate handoff.
Local checks can finish while separately identified signing acceptance remains pending, but final release qualification cannot omit it.

Mac evidence: 248 affected checks and 51 runtime-selection checks passed, plus the maintained import-policy check. Final Base inventory contains zero Privacy-only files. Actual Personal Memory capture/recall, cached Privacy installation, classification, ordinary relaunch, and Node/Electron CoreML switching/reload passed. Fresh model downloading, actual abrupt-exit recovery, external-to-local availability, and native Team materialization/authorization passed. The runtime used an authorized offline fixture; exact release-URL runtime downloading and clean signing remain open. The released packaged-CLI-to-Desktop upgrade retained synthetic memory and model assets. See [Mac qualification](docs/optional-privacy-mac-qualification.md) and [Linux handoff](docs/handoffs/optional-privacy-linux-qualification.md).

## 08: Qualify Linux CPU and fallback behavior in Docker or a VM

**What to build:** Let the User exercise the actual Linux artifacts without a CUDA-compatible machine.
Run the CPU installation path and the CUDA bundle's CPU fallback path in a container or Linux VM.
Produce a tested, self-contained handoff for the colleague's GPU run.

**Blocked by:** 07: Qualify the implementation on this Mac.

**Status:** ready-for-agent

- [ ] Record the host/guest architectures, Linux distribution, libc, runtime versions, container or VM configuration, and any x64 emulation.
- [ ] Test the supported Linux x64 artifacts. Label emulated execution separately from native target acceptance.
- [ ] A fresh no-GPU environment selects the CPU-only Privacy variant and downloads no CUDA or TensorRT provider payload for that path.
- [ ] The installed CPU component loads the pinned model and performs actual masking without checkout or global-module fallback.
- [ ] Controlled missing-tool, incompatible-driver, timeout, and inconclusive-probe cases produce CPU selection and actionable reasons.
- [ ] A test harness admits the authenticated CUDA variant to exercise its CPU path without adding a production capability or pin-authority bypass.
- [ ] Unavailable CUDA initialization falls back to CPU within that bundle, with no second runtime download.
- [ ] Actual CPU inference and service readiness succeed before required sharing becomes available after fallback.
- [ ] Linux install, relaunch, cancellation, retry, integrity rejection, upgrade, and selection recovery pass for the exercised paths.
- [ ] CPU masking results match the shared fixtures, while all native CUDA success claims remain explicitly untested.
- [ ] Component-only testing is labeled separately from Electron GUI testing. Run GUI acceptance only for an advertised Desktop target.
- [ ] The colleague handoff pins candidate digests, catalog provenance, model identity, fixtures, commands, expected results, and report fields.
- [ ] The handoff identifies the supported GPU host requirements and requests CPU, CUDA, and CUDA-to-CPU fallback runs.

Completion evidence: The Linux CPU/fallback report, architecture limitations, and a reproducible colleague test package.
The colleague package is prepared for the User to share. This ticket does not authorize contacting the colleague.

## 09: Qualify native CUDA with the colleague

**What to build:** Have the colleague demonstrate actual CUDA inference using the same candidate that passed local and VM qualification.
Prove that the native Linux target also supports the CPU variant and recovery from CUDA failure.
Return enough evidence to distinguish GPU success from silent CPU execution.

**Blocked by:** 08: Qualify Linux CPU and fallback behavior in Docker or a VM.

**Status:** ready-for-agent

- [ ] The colleague confirms a supported Linux x64 environment with real GPU access, compatible NVIDIA hardware, and the required driver/libraries.
- [ ] Record operating system, architecture, GPU model, driver/library versions, runtime versions, artifact digests, and model identity.
- [ ] A fresh installation detects compatibility and downloads the authenticated CUDA variant without forced success fixtures.
- [ ] Actual CUDA initialization and model inference succeed, with evidence of the provider that executed the workload.
- [ ] A CPU result, automatic CPU fallback, or simulated provider response cannot count as CUDA success.
- [ ] The colleague runs the CPU-only variant natively to complete target acceptance that an emulated local VM cannot establish.
- [ ] CUDA and CPU masking preserve the same labels, spans, UTF-8 offsets, secret handling, and final output expectations.
- [ ] A reversible test makes CUDA unavailable or injects provider failure without uninstalling or changing the colleague's host driver.
- [ ] The installed CUDA bundle recovers through real CPU inference without a second runtime download or false readiness.
- [ ] Required sharing remains blocked until fallback passes inference and service readiness.
- [ ] Relaunch and applicable runtime selection checks preserve authenticated assets and report the active provider accurately.
- [ ] The colleague returns structured results and diagnostic logs using synthetic data, with failures and untested cases explicit.
- [ ] No performance benchmark is required. CUDA availability, actual execution, masking, and safe fallback determine acceptance.
- [ ] If the host is unsupported or the CUDA run is unavailable, this ticket remains incomplete and the CUDA release gate stays open.

Completion evidence: The colleague's native CPU, CUDA, masking, and fallback report for the identified candidate.
If fixes change the candidate, repeat affected earlier checks and the GPU checks against the replacement artifact digests.

## 10: Complete the release evidence and documentation

**What to build:** Consolidate the three qualification stages into a release acceptance record tied to the final distributed artifacts.
Make release CI enforce the required evidence and preserve the existing signing and integrity requirements.
Document the behavior users receive and any remaining unmet gate.

**Blocked by:** 09: Qualify native CUDA with the colleague.

**Status:** ready-for-agent

- [ ] Final artifacts include the complete frozen component set, both Linux variants, the macOS variant, and the matching embedded catalog.
- [ ] Frozen components remain unchanged after catalog generation and pass verification after Desktop packaging.
- [ ] The final application archives, resources, and installed tree pass the composition gate from ticket 02.
- [ ] Mac, Linux CPU/fallback, and colleague CUDA reports identify the corresponding final candidate artifacts and their common source/build provenance.
- [ ] Required clean-environment acceptance of the signed/notarized macOS app is complete using the actual distributed artifact.
- [ ] Downloaded native code loads with the existing Gatekeeper, signing, notarization, and library-validation configuration.
- [ ] Any required native-signing change occurs before archive freezing and catalog generation, with affected acceptance repeated.
- [ ] Every required component and advertised Desktop target has acceptance evidence, with emulation and component-only limits explicit.
- [ ] Release CI requires positive Privacy installation and inference evidence for all three stages, including the colleague's real CUDA results.
- [ ] Missing colleague evidence, skipped Privacy inference, emulation-only results, or missing signing acceptance cannot satisfy their native release gates.
- [ ] Final compressed and installed sizes are compared with the baseline, with CPU and CUDA variants reported separately.
- [ ] Documentation explains compatibility detection, selected variants, readiness, CPU fallback, external configuration, and version compatibility.
- [ ] The implementation follows the repository changeset decision process, with a minor release recommended for the runtime-delivery change.
- [ ] Applicable local checks and release CI pass, and the review lists any unmet acceptance criterion without declaring release readiness.

Completion evidence: The consolidated release acceptance record and updated operating documentation.
Release publication remains a separate action.
