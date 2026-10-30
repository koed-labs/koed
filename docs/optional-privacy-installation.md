# Optional Privacy Filter installation

The Base Desktop app supports Personal Memory without the Privacy Filter runtime or model.
Local Team sharing requires the Privacy Filter Service when Team collaboration is enabled.
One installation action in Preferences or onboarding provisions both optional assets after consent.
Team-enabled onboarding exposes the required Privacy installer before core setup can finish.
Preferences refreshes installation status when opened and when a setup dialog opens, without interrupting an active installation.
The runtime archive and model files remain separate downloads with separate integrity rules.

## Installation and readiness

The installer chooses a compatible runtime before download.
It authenticates the runtime against manifest hashes embedded in the trusted, version-matched control plane.
It downloads the model from its pinned upstream revision and authenticates every file by SHA-256 and size.
The total download size is unknown until the transfers supply their sizes.
Progress identifies runtime download, model download, integrity validation, inference, activation, and service startup.

Before activation, the installer runs a synthetic masking example with the installed runtime and pinned model.
No private User content enters this example.
The installer stages a generation, which records one compatible set of runtime components.
It then stops Koed, activates the generation, and starts Koed again.
Readiness requires a reachable, authenticated Privacy Filter Service with the pinned classifier and an execution-verified provider.
Readiness uses the same environment-file settings and credential precedence as service startup.
An active runtime without its model or healthy service does not count as ready.

During first-run setup, storage or embedding assets can still be missing.
The Privacy installer leaves the assets staged if services are running, or activates them if services are stopped.
It reports pending setup in both cases.
Complete **Set up Koed** or **Retry setup** to provision the remaining core assets and start the service.
Required Team sharing stays blocked until filtering becomes ready.
Personal-only, external-service, and remote-connection configurations do not request these local downloads.

## Linux CPU and CUDA selection

The Linux x64 release contains distinct CPU and CUDA runtime archives.
The CUDA archive also contains the CPU provider, so fallback needs no second runtime download.
The CPU archive excludes CUDA and TensorRT provider payloads.
The macOS arm64 release keeps its existing runtime and provider selection.
Other operating-system and architecture combinations remain unsupported.

The Linux probe has a shared five-second budget and bounded output.
It reads GPU zero through `nvidia-smi` and examines installed host libraries through `python3` and `ctypes`.
It does not download CUDA assets, run inference, or benchmark performance.
Missing tools, timeout, incompatible versions, and inconclusive results select the CPU archive with a recorded reason.
An explicit CPU preference skips the GPU probe.
Installation follows the hardware acceleration preference saved in Preferences unless the Operator environment overrides it.
Hidden or remapped devices and multiple GPUs select CPU when the default device mapping is inconclusive.

The pinned ONNX Runtime 1.24.3 provider uses CUDA 12.8 and cuDNN 9.
Automatic CUDA selection requires driver 570.26 or later and a supported compute capability from 6.x through 9.x.
It also requires CUDA runtime version 12080 through 12999 and cuDNN major version 9.
The required host libraries appear in `PRIVACY_CUDA_REQUIREMENTS` in the Server source.
These conservative requirements avoid a claim of support based only on a GPU name.
The pinned [ONNX build](https://github.com/microsoft/onnxruntime/blob/v1.24.3/tools/ci_build/github/linux/build_cuda_c_api_package.sh) uses CUDA 12.8.
The [ONNX provider requirements](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html) identify the corresponding CUDA and cuDNN dependencies.
The driver threshold follows the [CUDA 12.8 toolkit requirements](https://docs.nvidia.com/cuda/archive/12.8.0/cuda-toolkit-release-notes/index.html).
This conservative policy accounts for PTX requirements as well as same-major CUDA compatibility.
Unknown GPU architectures select CPU until their support is reviewed.

The CPU variant retains `libonnxruntime.so.1` and `onnxruntime_binding.node`.
It excludes `libonnxruntime_providers_cuda.so`, `libonnxruntime_providers_shared.so`, and `libonnxruntime_providers_tensorrt.so`.
The CUDA variant retains all five files and its complete dependency closure.
Removing TensorRT from that variant requires a separately reviewed policy change and affected native qualification.
The macOS bundle retains its existing native files and provider behavior.
The [manifest catalog contract](component-manifest-catalog.md) defines variant identities and authentication.

After installation, inference requests CUDA explicitly and compares masking against the CPU result.
An ONNX execution profile must identify a kernel that ran through `CUDAExecutionProvider`.
A requested provider name alone cannot establish CUDA execution.
If CUDA initialization, execution, or masking comparison fails, the installer runs CPU inference again.
Only successful CPU recovery permits activation, and status records the fallback reason.
Failure of both providers leaves the previous selection unchanged.

`PRIVACY_RUNTIME_PROVIDER=cpu` preserves explicit CPU operation.
The existing `KOED_HARDWARE_ACCELERATION` preference applies when no Privacy-specific provider is set.
Automatic installation selection does not replace explicit runtime error behavior.
For example, an explicit CUDA runtime request can still fail after an installation probe used CPU fallback.
The separate Python engine remains CPU-only and keeps its existing configuration requirements.
Existing runtime calibration and contention handling remain unchanged.

## Cancellation, retry, and relaunch

Cancellation remains available during runtime download, model download, authentication, and inference verification.
The activation progress message identifies the point after which cancellation is unavailable.
Activation must finish or restore the previous selection before the operation completes.
Restart and readiness failures remain visible even when the previous selection returns successfully.
If recovery cannot establish a safe selection or restart, the error identifies the incomplete recovery.
If an essential service exits during startup, the supervisor cancels readiness polling and stops its managed resources immediately.
It releases ownership only after confirmed cleanup, so Desktop can authenticate and restore the previous generation.
Startup failure never substitutes for successful filtering or permits required sharing.

Retry authenticates cached runtime and model assets before reuse.
Incomplete transfers never become accepted cache entries.
A failed model transfer does not activate a runtime-only installation.
After application exit, status reconstructs readiness from the current generation, pinned model, and live service.
Staged assets and old diagnostic records cannot establish readiness by themselves.
Ordinary status, start, and relaunch do not download another runtime variant automatically.

Offline runtime installation through the private bridge still requires the archive and matching manifest.
Desktop does not expose an offline file picker.
The separate model installer can reuse complete pinned files already present in its cache.
An archive checksum supplied beside a download cannot replace embedded manifest authority.

## Qualification limits

Controlled compatibility and failure fixtures can run on this Mac.
They cannot establish Linux execution or successful CUDA execution.
Native Linux x64 acceptance requires CPU and fallback evidence.
CUDA acceptance requires a compatible NVIDIA host and actual CUDA kernel execution.
The release remains unqualified until those results pass for the final candidate.
