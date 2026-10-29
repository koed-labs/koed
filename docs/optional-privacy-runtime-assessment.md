# Optional Privacy runtime assessment

Ticket 01 was assessed on 29 October 2026 against source revision
`2b485a7c043ba3ceb38da3d5d7d6db791b78cacf`. Koed recall was unavailable;
the User authorized proceeding from the approved plan and tickets. The User also
requested omission of the implementation changeset, after a minor release was
recommended. Publication remains separate.

## Reproducible macOS baseline

The baseline was rebuilt with Node 24.14.0, pnpm 11.1.2, Electron 39.8.10
(embedded Node 22.22.1), macOS arm64, and `package:internal:mac`.
The build used ad-hoc signing; this is not Developer ID or notarization evidence.
No native runtime source was supplied. Native runtime comparisons must use this
same configuration. The older local app was not used as the baseline.

The dependency lockfile SHA-256 is
`d5911feed523c651a33de4f52e4cfdc18e3de9f846c3d42226674629d3fb7515`.
The electron-builder configuration SHA-256 is
`b007f331ccc5c079d12bbfd1c7b42a64fcd95714c3ce13562fd75b9937b887b0`.
Only assessment tooling and the approved planning documents differed from HEAD;
the staging and application behavior were unchanged.

| Measurement                |                  Bytes | SHA-256                                                            |
| -------------------------- | ---------------------: | ------------------------------------------------------------------ |
| DMG download               |            267,988,304 | `a8d0455c98bb21e619599442c77f4fca83c6623a9b13fd4fc6ebba17898d2045` |
| ZIP download               |            271,947,232 | `0437170d0ed5b298d8ca40ec96d894887ce466c41e2a1188fc6c9fcfd690622a` |
| Installed regular files    |            819,519,609 | Per-file inventory                                                 |
| Privacy-only regular files |             61,083,308 | Per-file inventory                                                 |
| Privacy inside ASAR        |        0 logical bytes | Inspected, including unpacked members                              |
| Duplicate content          | 44,205,683 extra bytes | All app files; not all attributable to Privacy                     |

The ONNX macOS library accounts for 35,937,208 bytes; its Node binding accounts
for 266,152 bytes. These are final Electron measurements, separate from the
earlier standalone Linux/macOS estimates in the plan. Compressed Privacy savings
must be measured by comparing the replacement DMG/ZIP, not by treating expanded
package bytes as download savings.

Use `scripts/assess-privacy-packaging.mjs --runtime <shared-runtime> --app
<Koed.app> --dmg <distribution.dmg> --zip <distribution.zip> --out
<report-directory>` to record build provenance, dependency ownership, hashes,
package copies, symlinks, ASAR members, unpacked files, resources and duplicates.
The runtime input must still contain the complete dependency graph. Assessment
does not start services or run tests. Framework symlinks are recorded without
counting their targets repeatedly. Unpacked ASAR members are not counted twice
as duplicate content. Download totals and expanded totals are separate.

## Dependency boundary

The existing `stageRuntimeComponents` and `projectRuntimeComponents` APIs already
provide the reusable assembly boundary; no behavior-changing prefactor is needed.
`inspectRuntimeComponentOwnership` reads those same declared dependency closures
and runs the existing JavaScript import audit without changing the payload.
The baseline has 215 Base-only, 28 Privacy-only and 10 shared package instances.
Direct, transitive, optional and peer declarations are retained in the report.
The maintained dynamic-import exceptions remain subject to the existing audit.
Both closures had zero unresolved imports. Base had 153 maintained edges and
Privacy had 21. This establishes a source boundary, not native inference acceptance.

The Base roots are API, worker, Embedding Service, MCP Server and Server control
plane. The Privacy root is Privacy Filter Service. Only the Privacy service
declares Transformers; no Base root or transitive Base dependency requires ONNX.
The Base control plane's Privacy installation/status/bootstrap modules do not
import the inference engine; they must remain in Base.

Privacy-only packages are Hugging Face Jinja/tokenizers/Transformers, ONNX common
and Node packages, sharp and its selected image libraries, adm-zip, boolean,
define-data-property, define-properties, detect-node, es6-error,
escape-string-regexp, global-agent, globalthis, has-property-descriptors,
json-stringify-safe, matcher, object-keys, roarr, semver-compare, serialize-error,
sprintf-js and type-fest. `onnxruntime-web` is already excluded under the reviewed
Node package policy. Shared packages are `@koed/shared`, `@noble/hashes`,
detect-libc, es-define-property, es-errors, gopd, json-canonicalize, semver, undici
and zod. Keep shared packages and their licenses in both independent components.

Desktop currently deploys the complete graph and removes only the service
wrapper. Ticket 02 must consume the assembled Base, preserving wrappers,
migrations, prompts, native assets and notices. Enforcement must use actual
package ownership and inspect all final packaging locations.

## Targets and native files

Component support remains macOS arm64 and Linux x64 with glibc 2.35 minimum.
The advertised release Desktop target remains macOS arm64. The Linux packaging
script does not establish an advertised or qualified Linux Electron release.
Do not infer Linux x64 acceptance from this arm64 Mac or an arm64 Linux guest.

| Privacy payload                        | Retained ONNX native files                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64, unchanged                 | `libonnxruntime.1.24.3.dylib`, `onnxruntime_binding.node`                                                                       |
| Linux x64 CPU                          | `libonnxruntime.so.1`, `onnxruntime_binding.node`                                                                               |
| Linux x64 CUDA, including CPU fallback | CPU files plus `libonnxruntime_providers_cuda.so`, `libonnxruntime_providers_shared.so`, `libonnxruntime_providers_tensorrt.so` |

Retain TensorRT in the CUDA variant until native qualification supports changing
the reviewed policy. The CPU variant removes all three provider shared libraries.
Neither variant changes the model, tokenizer, Python engine or unrelated
embedding/llama.cpp CUDA assets. Linux execution remains a later stage.

## Bounded CUDA compatibility contract

The pinned Node package is ONNX Runtime 1.24.3. Its
[install metadata](https://github.com/microsoft/onnxruntime/blob/v1.24.3/js/node/script/install-metadata.js)
obtains Linux x64 CUDA 12 provider files from the matching 1.24.3 NuGet package.
The pinned [CUDA build](https://github.com/microsoft/onnxruntime/blob/v1.24.3/tools/ci_build/github/linux/build_cuda_c_api_package.sh)
uses CUDA 12.8 with real code for compute capabilities 6.0, 7.0, 7.5, 8.0,
9.0a and forward PTX for 9.0. NVIDIA permits same-major binary compatibility,
but this installer should conservatively admit known 6.x, 7.x, 8.x and 9.x
devices only; unknown future architectures select CPU pending review.
The [ONNX requirements](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)
require the matching CUDA 12.8-or-newer runtime and cuDNN 9.

Require Linux x64/glibc 2.35, a visible NVIDIA device, driver at least 570.26,
the reviewed compute-capability families, CUDA runtime at least 12.8 within
major 12, cuDNN major 9, and resolvable CUDA provider dependencies. The driver
threshold deliberately uses the
[CUDA 12.8 toolkit driver](https://docs.nvidia.com/cuda/archive/12.8.0/cuda-toolkit-release-notes/index.html)
rather than the looser CUDA 12 minor-compatibility floor; PTX can need the newer
driver. This is conservative download selection, not a guarantee of inference.
Record the actual Linux provider's ELF dependency list when building its release
artifact and use that reviewed list to validate required libraries before transfer.
Do not assume that a CUDA number in `nvidia-smi` proves installed CUDA/cuDNN libraries.

| Observation                                                                                            | Download decision                             |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Explicit CPU preference                                                                                | CPU, without GPU probing                      |
| macOS arm64                                                                                            | Existing macOS bundle and provider rules      |
| Complete compatible Linux evidence                                                                     | CUDA bundle, then explicit CUDA inference     |
| No NVIDIA device, old driver, unsupported compute capability or missing library                        | CPU with recorded reason                      |
| Missing `nvidia-smi`/library tools, malformed output, permission failure, timeout or uncertain version | CPU with recorded reason                      |
| Unsupported OS/architecture                                                                            | Unsupported target; do not invent an artifact |

Probe commands must have fixed arguments, bounded output and a shared wall-clock
budget of at most five seconds. Probe only local driver/device/library metadata;
do not download a provider or benchmark to choose a download. Existing runtime
calibration and pressure observations stay independent. Tickets 03 and 07 must
exercise all outcomes with controlled fixtures, explicitly labeled simulation.

## Authenticated variant contract

Retain schema-1 Base and macOS Privacy identities and immutable historical
archives. New Linux Privacy manifests use schema 2 with required `variant: cpu`
or `variant: cuda`; no implicit variant is allowed. Use archive names
`koed-privacy-<version>-linux-x64-<variant>.tar.gz`. Schema 2 catalogs include
both variants plus Base Linux x64 and the two existing macOS identities (five
distinct entries). Bind the variant into canonical manifest hashes, catalog keys,
expected install identity and archive names. Reject partial or conflicting variant
sets. An old unvarianted pin cannot authorize a new variant.

Component storage already uses manifest digests, and generation identity includes
component manifest digests. Preserve those content-addressed identities and
authenticate variant equality on cached/staged reads and expected installation.
Upgrade metadata may describe older selections for ordering, but cannot authorize
old Privacy execution. Consumers requiring updates include release assembly,
catalog creation/embedding, frozen-asset verification, metadata/promotion, CLI
source selection, Desktop private install IPC, store admission and status.
Both variants retain the same independently pinned model cache. No combined
archive or new installer is needed.

## Baseline installation gaps

At the recorded baseline, the Desktop action provisions only the runtime component. Model setup
is a separate manager path. Its status treats an active runtime as ready, and
the stopped-install fast path can return success before service startup. Neither
establishes model integrity, selected-provider inference or service readiness.
Cancellation already bypasses the operation queue for component transfers; the
model downloader has no signal/progress contract yet. Its retry and verified blob
reuse can be retained while adding cancellation and unique partial paths.

Keep setup, activation and startup on the existing operation queue and
cross-process locks. Preserve the prior generation until both downloads are
authenticated. Before required sharing is available, require the installed model,
the selected component, explicit inference and healthy service. CUDA failure must
recover through that bundle's authenticated CPU path with no second runtime
download. Existing explicit provider controls retain their errors. Reconstruct
missing-runtime, missing-model, staged, starting, ready and failed states after
restart; do not persist an unsupported ready flag.

Remote connections, external Privacy services and Team-disabled Personal Memory
must not trigger local Privacy downloads. Current component requirements already
derive from effective runtime configuration; retain that source of truth.

## Evidence limits

The baseline build and static graph/inventory inspection ran on this Mac.
These are not Personal Memory capture/recall, optional installation, masking,
Linux CPU, CUDA or signed clean-Mac acceptance. The 43 focused assembly and inventory tests passed when needed to verify this
boundary. Broader tests remain deferred at the User's request. Tickets 07–09 own
native qualification; release remains unqualified until their evidence is complete.

## Ticket 02 implementation checkpoint

The first replacement macOS artifact passed the final composition inventory with
zero Privacy payload files. In the matching no-native-source build configuration:

| Measurement             | Replacement bytes | Reduction from baseline |
| ----------------------- | ----------------: | ----------------------: |
| DMG                     |       233,045,177 |              34,943,127 |
| ZIP                     |       236,971,919 |              34,975,313 |
| Installed regular files |       694,171,344 |             125,348,265 |

Shared Base assembly also applies the existing terminal-runtime target policy.
It removes 63,054,768 bytes of foreign-platform node-pty payload that Desktop's
old full-graph staging retained. The remaining reduction includes Privacy
dependencies, orphaned dependencies of the already removed ONNX web backend,
and metadata/signature differences. Do not attribute the full installed reduction
to Privacy or claim any inference performance improvement. The ownership gate
also excludes packages outside the Base closure, including those orphaned web
dependencies. The embedded Pi integration remains inside its Base-owned package.

The package-boundary run passed 70 of 71 checks; the sole failure was a stale
wrong-version fixture that changed an archive name without its matching product
version. Correcting both identity fields retained version rejection, and the five
catalog checks then passed. Broader suites remain deferred. Packaged Personal
Memory and native acceptance remain in progress; these byte measurements alone
do not establish startup, capture, recall or release readiness.

The isolated developer-profile Personal Memory run subsequently passed: an actual
Claude transcript went through the supported Capture Hook and Transcript Watcher,
and authenticated Personal Memory retrieval returned its synthetic recovery
phrase. No Privacy runtime/model was downloaded and no Privacy service started.
AI Client answer synthesis was not exercised. The acceptance app used the same
Base plus Homebrew-staged native assets, with refreshed manifests and ad-hoc
signing; it is separate from the matching size-comparison build and cannot
substitute for signed/notarized release acceptance. The fixture needed private
profile and host-proof parent directories; failed initial fixture attempts were
rejected by the unchanged identity checks. No identity protection was disabled.

The old full-graph Desktop also contained 1,597,530 bytes of orphaned ONNX web
dependencies that were outside both reachable closures. Base assembly removes
those too, and the composition exclusions include every staged package outside
Base, preventing orphaned dependencies from returning under a different package
location.

## Delivered implementation and qualification

The coordinated installation now authenticates the runtime and separately pinned model,
runs synthetic inference, stages a generation, and requires authenticated service readiness.
[Installation behavior](optional-privacy-installation.md) documents states, cancellation,
provider selection, recovery, and explicit controls.
[Mac qualification](optional-privacy-mac-qualification.md) records actual evidence and remaining gates.
The User requested omission of the changeset for this work.
