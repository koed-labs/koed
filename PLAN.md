# Optional Privacy Filter runtime for Koed Desktop

Status: Scope approved, including CPU/CUDA download selection. Assessment, implementation, and release acceptance remain open.
Qualification follows three stages: this Mac, Linux CPU/fallback in Docker or a VM, and native CUDA testing by the colleague.

Prepared on 2026-10-29 against commit `2b485a7c043ba3ceb38da3d5d7d6db791b78cacf`.
Refresh the evidence against the implementation branch before making changes.

## Outcome and scope

Ship the base Electron app without the Privacy Filter service, ONNX Runtime, or dependencies used only by that service.
Provide one optional Privacy Filter installation action that provisions the runtime and model assets.
Personal Memory capture and recall must work without that download when Team collaboration is disabled.

When local Team sharing requires the Privacy Filter, keep sharing blocked until the runtime and model pass integrity and readiness tests.
Preserve external Privacy Filter configuration and remote connections that do not require local inference.
The change reduces the initial Desktop download. Users who install the Privacy Filter still download its required assets.

On supported Linux devices, select the Privacy runtime download through a CUDA compatibility check.
Check the operating system, architecture, NVIDIA GPU, and driver against the requirements of the packaged CUDA provider.
Use the CPU bundle when compatibility is absent or cannot be established.
Keep the existing macOS package and provider behavior unchanged.

Keep these changes outside this work:

- Replacement with `privacy-filter.cpp`, GGML, or another inference engine.
- Changes to the model, tokenizer, masking rules, or supported inference providers beyond the CPU/CUDA delivery split.
- New performance benchmarks or speed-based download selection. Existing runtime calibration and contention handling remain unchanged.
- Changes to the separate Python privacy engine used in Team deployments.
- Removal of Postgres, embedding assets, llama.cpp, or its CUDA dependencies.
- New operating-system support, a new component installer, or a new offline-file selection interface.

## CPU/CUDA download contract

The compatibility check chooses which runtime bundle to download.
It does not benchmark the workload or guarantee that CUDA will initialize successfully.
Keep the check bounded, local, and independent of downloading the CUDA payload first.

| Device result                                                | Runtime download              | Required behavior                                                                   |
| ------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------- |
| Supported Linux target with compatible NVIDIA GPU and driver | CUDA-enabled Privacy bundle   | Include CPU support for fallback and test actual CUDA inference after installation. |
| Supported Linux target without CUDA compatibility            | CPU-only Privacy bundle       | Download no CUDA or TensorRT provider payload and test CPU inference.               |
| Compatibility probe unavailable, timed out, or inconclusive  | CPU-only Privacy bundle       | Report the reason and keep CPU installation available.                              |
| Existing explicit CPU preference                             | CPU-only Privacy bundle       | Respect the preference without downloading unused GPU code.                         |
| Supported macOS target                                       | Existing macOS Privacy bundle | Preserve existing provider selection and native files.                              |

Publish independently authenticated Linux CPU-only and CUDA-enabled variants.
Each variant is a complete Privacy runtime with a distinct identity in its manifest, catalog, cache, and runtime selection.
The CUDA variant retains CPU support, so a provider failure does not require another runtime download.
Both variants use the same separately pinned model assets.

After installing the CUDA variant, run a small synthetic inference test with CUDA explicitly selected.
Make sure that the test records the provider that actually ran, rather than silently accepting CPU execution as CUDA success.
If CUDA initialization or inference fails, use the authenticated CPU path and report the fallback reason.
Keep required sharing blocked until the selected provider passes inference and service readiness tests.
Integrity failures still reject the affected assets and never authorize their execution.

Record compatibility evidence, the selected bundle variant, and the active provider separately.
Reassess compatibility during installation, repair, and upgrade without adding background downloads on every launch.
Retain the existing runtime controls and their explicit error behavior.
Document how those controls interact with the installed variant and the automatic installation fallback.

## Existing evidence

The repository already builds separate Base and Privacy components.
The Privacy component includes the service and its runtime dependencies, including ONNX Runtime.
Model assets use a separate installation path with their own pinned hashes.
The current Linux Privacy package includes CPU support and CUDA provider libraries together.
The existing runtime can select providers automatically, but that selection does not remove unused libraries from the download.

Desktop staging still starts from the full service graph.
It removes the top-level `privacy-service` directory but retains the deployed dependencies.
Electron then copies the staged `node_modules` directory into its resources.
This identifies a packaging gap, but the final Electron artifact still needs an inventory.

The [referenced release run](https://github.com/koed-labs/koed/actions/runs/40752210321) supplied standalone package measurements during the initial investigation.
Linux `onnxruntime-node` occupied approximately 352.2 MB expanded, including a 315.7 MB CUDA provider.
The macOS arm64 copy occupied approximately 36.2 MB expanded.
These figures are not final Electron measurements or promised download savings.

Use these implementation entry points:

| Area                  | Source                                                                                                                   | Relevance                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Desktop staging       | [prepare-koed-runtime.mjs](/Users/hill399/code/@koed-labs/koed-alt/apps/desktop/scripts/prepare-koed-runtime.mjs)        | Uses the complete service graph before removing the wrapper.        |
| Electron packaging    | [electron-builder.yml](/Users/hill399/code/@koed-labs/koed-alt/apps/desktop/electron-builder.yml)                        | Copies staged dependencies and defines the application archive.     |
| Component assembly    | [component-assembly.mjs](/Users/hill399/code/@koed-labs/koed-alt/scripts/component-assembly.mjs)                         | Calculates separate Base and Privacy dependency sets.               |
| Native package policy | [privacy-runtime-package-policy.mjs](/Users/hill399/code/@koed-labs/koed-alt/scripts/privacy-runtime-package-policy.mjs) | Retains required native files for each target.                      |
| Privacy installation  | [privacy-install.ts](/Users/hill399/code/@koed-labs/koed-alt/apps/desktop/src/koed-server/privacy-install.ts)            | Installs and activates the optional component.                      |
| Setup coordination    | [manager.ts](/Users/hill399/code/@koed-labs/koed-alt/apps/desktop/src/koed-server/manager.ts)                            | Coordinates model installation and runtime startup.                 |
| Component trust       | [Component manifest catalogs](/Users/hill399/code/@koed-labs/koed-alt/docs/component-manifest-catalog.md)                | Defines exact-version pins, activation locks, and release ordering. |
| Existing design       | [Server distribution handoff](/Users/hill399/code/@koed-labs/koed-alt/docs/handoffs/publish-koed-labs-server.md)         | Records the intended optional Desktop Privacy boundary.             |

## Phase 1: Assess the complete distribution and install path

Establish a reproducible baseline before changing assembly.
Record the baseline and implementation revisions for each before-and-after comparison.
Keep the lockfile, toolchain, build configuration, and target constant unless the scoped change requires a difference.
Separate source findings, synthetic tests, and tests of actual packaged applications in the evidence record.

1. Trace direct, transitive, optional, peer, and dynamic dependencies of every Base service.
2. Make sure that no Base service needs ONNX Runtime during startup or normal Personal Memory use.
3. Record the complete Privacy dependency set and any dependencies shared with Base.
4. Inventory the final app, including `app.asar`, `app.asar.unpacked`, native libraries, and copied resources.
5. Record compressed download bytes, expanded installed bytes, duplicate copies, and bytes attributable to Privacy.
6. Trace the install action through component download, model download, activation, restart, and readiness reporting.
7. Identify cases where an active component currently reports readiness without a usable model.
8. Record behavior for existing installations, partial installations, upgrades, external services, and remote connections.
9. Make sure that the target matrix matches the release workflow and published support policy.
10. Define the compatibility probe against the exact CUDA provider version and its GPU, driver, and library requirements.
11. Distinguish driver compatibility from transient GPU load without introducing a performance benchmark.
12. Define deterministic CPU selection when the probe fails, times out, or cannot establish compatibility.
13. Map native files to the CPU and CUDA variants, including any required CUDA shared libraries and TensorRT retention rules.
14. Define distinct variant identities and the required migration for manifests, catalog keys, cache entries, and component consumers.

The current component matrix includes Linux x64 and macOS arm64.
The current Desktop release job targets macOS arm64.
A Linux component test does not establish Linux Electron acceptance.
Require Desktop acceptance on every advertised Desktop target without adding new targets in this change.

Completion evidence: A dependency ownership map, artifact inventory, size baseline, compatibility decision table, variant contract, target matrix, and install-flow gaps.
Resolve any unexpected Base dependency before removing its package.
Record unavailable prior decisions or target evidence as unresolved items rather than inferred facts.

## Phase 2: Assemble Base and authenticated Privacy variants

Reuse the existing component assembly boundary.
A dependency set includes all packages needed by its service roots.
Remove Privacy-only packages through that boundary instead of maintaining a deletion list.

1. Refactor Desktop staging to consume the Base output from the shared component assembly path.
2. Factor a reusable assembly entry point if the existing API needs adaptation for Desktop.
3. Preserve the full shared staging path needed by standalone packaging and component production.
4. Preserve Base dependencies, service wrappers, migrations, prompts, licenses, and required native assets.
5. Build complete Linux CPU-only and CUDA-enabled Privacy variants from the shared assembly path.
6. Preserve the existing macOS output and keep each variant independently resolvable.
7. Regenerate file inventories and Desktop manifests after the final payload changes.
8. Preserve the signing order and manifest refresh before sealing the outer macOS app.
9. Add a composition gate before signing and another gate against the final packaged app.
10. Reject CUDA and TensorRT provider payloads in the CPU-only variant while retaining all files needed for CPU inference.
11. Retain the required GPU libraries and CPU fallback path in the CUDA-enabled variant.
12. Bind variant identity into manifests, archive lookup, catalog authority, cache keys, and generation selection.
13. Update the complete release matrix and all affected component consumers for the new identities.
14. Reject ambiguous or unsupported variant identities without changing previously published artifacts or accepting old pins for new variants.

The composition gates must inspect every location that can contain packaged code.
They must reject Privacy service payloads, `onnxruntime-node`, model weights, and other dependencies owned only by Privacy.
Shared contracts and packages genuinely required by Base remain permitted.
The gates must detect nested or duplicate package copies, not only top-level directories.

Completion evidence: A Base artifact without Privacy-only payloads and independently authenticated, complete Privacy variants with recorded sizes.
Run Base and each Privacy variant outside the checkout so parent dependencies cannot hide missing files.
Keep all frozen release components unchanged after their trusted manifest pins are generated.
Record local assembly evidence first. Assign target execution results to the three qualification stages below without blocking implementation on CUDA access.

## Phase 3: Coordinate one optional Privacy Filter installation

Treat the bundle as one user-facing installation action.
Keep the runtime component and model assets as separately authenticated downloads with their existing caches.
Do not introduce a new combined archive format unless assessment proves that the current contracts cannot meet the requirement.

1. Reuse the existing component installer and model installer behind the Privacy Filter action.
2. Show consent, expected download size, progress, cancellation, and actionable retry states.
3. Make sure that status distinguishes missing runtime, missing model, pending activation, and failed startup.
4. Stage and authenticate both required asset sets before reporting the installation as ready.
5. Make sure that readiness requires a healthy service using the intended component, model, and provider.
6. Serialize setup, activation, and restart through the existing management queue and lifecycle locks.
7. Preserve cancellation during downloads and define the point where activation must finish or recover.
8. Reuse valid cached assets on retry without accepting corrupt or incompatible assets.
9. Preserve the previous selection on failure and use supported same-version recovery after failed activation.
10. Handle an app upgrade with an older Privacy installation through the existing version-matched component rules.
11. Keep local downloads optional when Team collaboration is disabled or an external Privacy Filter serves the configuration.
12. Preserve blocked sharing whenever required Privacy assets or service health are unavailable.
13. Run the compatibility check before choosing the download and reporting its expected size.
14. Select only the matching authenticated variant and reuse shared model assets without duplicate downloads.
15. Test actual inference after installation, then activate CPU fallback if CUDA initialization or inference fails.
16. Show the selected bundle, active provider, and any fallback reason without reporting premature readiness.

An installation can retain valid staged assets after cancellation or failure.
It must not expose a partial installation as ready or silently send unfiltered content.
Do not add a cross-version component fallback or treat runtime recovery as database rollback.

Completion evidence: A documented installation state transition table and passing tests for each transition.
Make sure that the UI and runtime status agree after relaunch, cancellation, retry, and recovery.
If existing behavior already meets a requirement, retain it and add only the missing evidence.
Use controlled provider fixtures for implementation tests on the Mac. Native CUDA qualification remains a separate required gate.

## Phase 4: Establish integrity and packaged behavior

The optional runtime contains executable native code.
Its trust comes from the trusted application and its embedded manifest pins, not from a checksum downloaded beside an archive.
Preserve the separate model integrity rules and Apple application signing requirements.

Make sure that these controls remain effective:

- Exact product version, component identity, variant, platform, architecture, and declared runtime compatibility match the trusted catalog.
- Archive sizes, file hashes, safe extraction paths, and contained links pass the existing admission rules.
- Model files match their pinned hashes before the service uses them.
- Missing catalog authority or a changed canonical manifest prevents installation and execution.
- CPU and CUDA variants cannot substitute for one another through filename changes, stale cache entries, or shared catalog keys.
- Runtime selection remains protected by ownership rules, locks, and active-generation pins.
- Downloaded native libraries load from their authenticated component location without checkout or global-module fallback.
- The signed and notarized macOS app loads the downloaded runtime under the existing security configuration.

### Qualification stages and available hardware

The User has an arm64 Mac without a CUDA-compatible GPU. The colleague has access to CUDA-compatible hardware.
Split qualification into the three stages below and retain a separate evidence record for each.
Tickets 01 through 06 can complete implementation and controlled local tests before the colleague runs native acceptance.

| Stage                            | Environment and owner                                                        | Required qualification                                                                                                                             | Limits                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1: Mac, ticket 07                | User and agent on this Mac                                                   | Local regression suites, simulated compatibility cases, artifact composition, macOS installation, actual masking, lifecycle, and signing evidence. | Simulated CUDA cases establish application logic only. Record any unavailable signed or clean-environment acceptance as a release gate. |
| 2: Linux CPU/fallback, ticket 08 | User and agent in Docker or a Linux VM without GPU access                    | Linux CPU download and inference, no-GPU selection, integrity/lifecycle behavior, and real CPU fallback from the authenticated CUDA bundle.        | Record emulation and architecture. These results cannot establish actual CUDA execution or replace required native x64 acceptance.      |
| 3: Native CUDA, ticket 09        | Colleague on a supported Linux x64 environment with actual NVIDIA GPU access | Native CPU acceptance, compatibility-based CUDA download, actual CUDA inference, masking parity, and GPU-to-CPU recovery.                          | A CPU fallback or simulated provider result cannot count as CUDA success. Unsupported or unavailable hardware leaves this gate open.    |

Stage 1 prepares the identified candidate and Linux instructions for stage 2.
Stage 2 prepares a tested handoff for the colleague, with artifact digests, trusted catalog provenance, fixtures, commands, and expected results.
Confirm the colleague's operating system, architecture, GPU, driver, and required libraries before that handoff.
Prepare the package for the User to share without contacting the colleague as part of this planning task.

On this arm64 Mac, record whether Linux x64 execution uses emulation.
An arm64 Linux guest cannot substitute for the supported Linux x64 artifact target.
Use the native colleague run to complete Linux x64 acceptance when the local Linux environment is emulated.
Docker or Linux VMs provide test environments here, without changing the bundled-local product installation path.

Stage 2 can admit the authenticated CUDA variant through a controlled test harness to exercise its CPU fallback path.
Keep any capability simulation in the harness and preserve production manifest authority and admission rules.
Stage 3 must prove successful CUDA execution before testing a reversible provider failure and actual CPU recovery.
Do not require host driver removal or modification to exercise that failure.

Keep completed Mac and VM evidence while the colleague's results are pending.
Ticket 10 consolidates all three stages and any remaining macOS signing acceptance before declaring release readiness.
If a fix changes the candidate, repeat affected earlier checks and CUDA checks against the replacement artifact digests.

### Acceptance scenarios

Use this acceptance matrix. Every result must name its artifact digest, target, runtime versions, and test environment.

| Scenario                                                | Required result                                                                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Fresh Personal Memory installation                      | Capture and recall work with Team disabled, no Privacy cache, and no Privacy download.                                 |
| Final artifact composition                              | No Privacy-only payload exists in application archives, unpacked files, or resources.                                  |
| Fresh local Team setup                                  | One installation action obtains the matching runtime and model, then enables healthy local filtering.                  |
| CUDA-compatible Linux device                            | The installer selects the CUDA variant and records successful actual CUDA inference.                                   |
| CPU-only Linux device or explicit CPU preference        | The installer selects the CPU variant without transferring CUDA or TensorRT provider payloads.                         |
| Missing GPU, incompatible driver, or inconclusive probe | The installer selects CPU and reports the compatibility result.                                                        |
| CUDA fails after download or becomes unavailable later  | The authenticated CPU path restores filtering without another runtime download or false readiness.                     |
| Variant substitution or stale cached variant            | Admission rejects identity mismatches before execution and preserves valid selection state.                            |
| Missing runtime or model                                | Status identifies the missing asset and sharing remains blocked.                                                       |
| Cancel, network failure, or insufficient disk space     | No false readiness, no partial activation, and a usable retry path.                                                    |
| Corrupt archive, manifest, model, or installed file     | Existing integrity rules reject the asset before use.                                                                  |
| Wrong version, target, or native runtime compatibility  | Admission or startup rejects the mismatch with an actionable error.                                                    |
| Concurrent setup, install, or startup                   | Operations preserve selection ownership and lifecycle ordering.                                                        |
| Restart or activation failure                           | Supported recovery preserves a valid selection and reports any remaining failure.                                      |
| Upgrade from the current Desktop release                | User data remains intact and older Privacy assets cannot form a mixed-version runtime.                                 |
| External Privacy Filter or remote connection            | Existing configuration works without an unnecessary local download.                                                    |
| Native provider execution                               | Actual inference runs with each supported provider on suitable hardware, including CPU fallback from the CUDA variant. |
| Masking parity                                          | Existing fixtures retain labels, spans, UTF-8 offsets, secret handling, and final masked output.                       |
| Signed macOS distribution                               | A clean Mac installs the distributed app and completes the optional Privacy installation and inference.                |

Use clean profiles and empty component/model caches for fresh-install tests.
Run acceptance without access to checkout dependencies and without `NODE_PATH` assistance.
Use synthetic privacy examples and record the provider actually selected.
For approximate provider outputs, retain existing tolerances and require unchanged final masking expectations.

Do not disable Gatekeeper, library validation, or integrity rules to pass native-loading tests.
If native signing needs a change, apply it before archive freezing and catalog generation.
Record unavailable hardware or signing credentials as outstanding release gates, not successful tests.

## Phase 5: Add regression coverage and release evidence

Extend existing tests around the changed boundary.
Use behavioral tests and actual package inventories instead of tests that only search source text.
Keep expensive artifact and hardware acceptance separate from fast local tests.

| Test area                     | Required coverage                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Component assembly            | Base/Privacy separation, complete CPU/CUDA variants, shared dependencies, and isolated module resolution.         |
| Desktop artifact reporting    | All packaging locations, Privacy byte attribution, and rejection of accidental reintroduction.                    |
| Install bridge and manager    | Compatibility detection, variant selection, inference readiness, CPU fallback, retry, cancellation, and recovery. |
| Component trust and lifecycle | Changed pins, corrupt files, variant/target/version mismatches, upgrade selection, and frozen asset identity.     |
| Native compatibility          | ONNX and other native dependencies load under the declared Node and Electron runtimes.                            |
| Packaged privacy inference    | The installed component loads the pinned model and preserves masking behavior.                                    |
| Packaged Desktop acceptance   | Personal Memory without Privacy, followed by actual optional installation and Team filtering.                     |

The current general Desktop smoke test can report that Privacy was not exercised.
Add explicit positive installation and inference acceptance through the packaged app.
Native-addon loading alone does not establish model inference or safe sharing behavior.

Use the existing [component compatibility smoke](/Users/hill399/code/@koed-labs/koed-alt/scripts/component-runtime-compatibility-smoke.mjs), [privacy runtime validator](/Users/hill399/code/@koed-labs/koed-alt/scripts/validate-packaged-privacy-runtime.mjs), and [Desktop smoke harness](/Users/hill399/code/@koed-labs/koed-alt/apps/desktop/scripts/smoke-packaged-desktop-app.mjs).
Extend their acceptance contracts where necessary.
Keep model inference and signed-app acceptance explicit in their reports.

Before pushing implementation changes, run the applicable repository suites:

- Run `pnpm fmt:prettier:check` and `pnpm lint`.
- Run relevant package typechecks and builds for each changed package.
- Run component assembly, package-policy, catalog, distribution, and frozen-asset regression tests.
- Run Desktop manifest, artifact-reporting, install-flow, and signing tests affected by the change.
- Run packaged acceptance on the supported native targets and required provider hardware.

Add composition and installation acceptance to the [release workflow](/Users/hill399/code/@koed-labs/koed-alt/.github/workflows/release.yml).
Keep separate Mac, Linux CPU/fallback, and colleague CUDA evidence gates.
Require the colleague's recorded GPU results before final qualification without preventing earlier implementation or local qualification work.
Keep emulation-only execution and unavailable signing acceptance visible as unresolved native release requirements.
Preserve complete catalog generation before Desktop packaging and frozen-asset verification afterward.
Compare final download and installed sizes against Phase 1 with matching builds.
Report the CPU and CUDA variants separately, including the absence of GPU-library downloads on the CPU path.
Explain the measured reduction without claiming an inference performance improvement.

Update the [component catalog documentation](/Users/hill399/code/@koed-labs/koed-alt/docs/component-manifest-catalog.md) and [operation guide](/Users/hill399/code/@koed-labs/koed-alt/docs/running-koed.md) with the final boundary and installation behavior.
Update other setup documentation only where its instructions change.
Document compatibility detection, variant selection, the revised catalog matrix, and CPU fallback without adding a benchmarking requirement.
Record implementation follow-ups in `TODO.md`, and preserve `CONTEXT.md` as the glossary.

The implementation is release-noteworthy because it changes runtime delivery and optional installation behavior.
Recommend a minor release and obtain the required confirmation before adding or omitting its changeset.
Use the repository PR template, report unmet acceptance criteria, and watch CI after opening or updating a PR.

## Completion criteria

Complete the work only when all required evidence is available.
Attach artifact inventories, size comparisons, test results, and native acceptance reports to the implementation review.
Keep these criteria open until the implementation satisfies them:

- [ ] The final base Desktop app contains no Privacy-only runtime payload or model weights.
- [ ] Personal Memory capture and recall work without downloading Privacy assets when Team collaboration is disabled.
- [ ] One optional action installs the authenticated Privacy runtime and pinned model assets.
- [ ] A bounded compatibility check selects the Linux CPU or CUDA bundle without performance benchmarking.
- [ ] The CPU-only Privacy download contains no CUDA or TensorRT provider payload, and macOS behavior remains unchanged.
- [ ] Distinct variant identities are authenticated throughout catalogs, installation, caching, and runtime selection.
- [ ] Actual CUDA failure falls back to authenticated CPU inference before required sharing becomes available.
- [ ] Team sharing remains blocked whenever required filtering is unavailable.
- [ ] Download, cancellation, retry, restart, upgrade, and recovery scenarios pass.
- [ ] The installed runtime resolves all dependencies without relying on the checkout or global modules.
- [ ] Masking behavior remains unchanged, and CPU/CUDA selection and fallback pass native acceptance.
- [ ] Stage 1 records Mac qualification and clearly separates simulated CUDA tests from actual macOS inference.
- [ ] Stage 2 records Linux CPU/fallback qualification, host/guest architectures, and any emulation limits.
- [ ] Stage 3 records the colleague's native CPU, actual CUDA, masking, and GPU-to-CPU fallback results.
- [ ] The signed macOS distribution passes clean-machine optional-install acceptance.
- [ ] Required component targets and all advertised Desktop targets have recorded acceptance results.
- [ ] Final-artifact composition gates prevent Privacy dependencies from returning to the base app.
- [ ] Documentation, release decision, and CI evidence match the delivered behavior.

Creating this plan changes no runtime behavior and requires no separate architecture-document update.
The implementation must include the documentation updates and release evidence described above.
