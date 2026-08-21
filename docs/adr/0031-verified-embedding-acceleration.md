# ADR 0031: Verified Embedding Acceleration

Status: Accepted.

Related decisions:

- [0020 Portable Personal Derived Artifact Replication](./0020-portable-personal-derived-artifact-replication.md)
- [0021 Portable Semantic Work Ownership](./0021-portable-semantic-work-ownership.md)
- [0026 Pre-launch Schema Reset and Processing Epochs](./0026-pre-launch-schema-reset-and-processing-epochs.md)
- [0027 Embedding Capacity Calibration And Telemetry](./0027-embedding-capacity-telemetry.md)

## Context

Koed supervises `llama-server` for embedding and reranking. The service formerly
launched every model with zero GPU layers while accepting an independent
backend-class label. That could report CUDA or Metal capacity without using the
accelerator. It also prevented the bundled runtime from taking advantage of
supported local hardware.

Acceleration changes throughput and resource pressure, but does not change the
model artifact, tokenizer, input transform, pooling, normalization, dimensions,
or resulting semantic generation. Existing compatible vectors must remain
portable between CPU, Metal, and CUDA runtimes.

## Decision

Embedding and reranking each use an acceleration policy: `auto`, `cpu`,
`metal`, or `cuda`. Native bundled-local embedding defaults to `auto`.
Reranking defaults to `cpu` so loading a second model cannot unexpectedly
consume accelerator memory. Operators may configure the two policies and
device identifiers independently.

Desktop persists one bounded local inference preference: `auto` enables
compatible acceleration and `cpu` disables it. Service-specific Operator
environment settings remain authoritative and make the Desktop preference
read-only. The preference is deliberately reusable by other local inference
services, but each service retains its own provider implementation and resource
policy.

`auto` prefers Metal on Apple Silicon and CUDA on Linux or WSL when the selected
`llama-server` binary reports a compatible device. Otherwise it uses CPU and
records a bounded fallback reason. A GPU startup failure in `auto` may retry
once on CPU. Explicit `metal` or `cuda` modes fail closed when discovery or
startup fails; they never silently use CPU.

GPU processes receive an explicit device, full model offload, and disabled
automatic fit. Koed does not silently reduce context, batch, parallelism, or
GPU layers to make a process start. Resource settings remain Operator-visible
configuration.

Accelerated embedding and reranker processes pass a native llama-server idle
sleep policy. After five minutes without inference by default, llama-server
unloads model and KV-cache memory while keeping its process and request boundary
available; the next request reloads the model transparently. Embedding and
reranker delays are independent and `0` explicitly disables idle unloading.
CPU processes omit the sleep policy. Authenticated health and capacity identity
report the configured effective delay, but Koed does not infer or claim live
residency without an authoritative runtime signal.

A manually invoked benchmark compares CPU with Metal or CUDA through the same
production Embedding Service, pinned model, dimensions, normalization, and
chunking path. It uses deterministic synthetic Memory Event-sized inputs and
measures process cold start, first request, accelerated idle wake, warm p50/p95
latency and token throughput, process-tree RAM, available VRAM telemetry, and
CPU/GPU cosine agreement. Reports omit vectors and source text. Routine CI tests
the harness contract but does not run hardware measurements.

The resolved process state is authoritative. Health and capacity identity do
not accept a separately asserted backend label. Capacity identity includes the
resolved backend, GPU-layer policy, a non-reversible device identifier hash,
and the existing non-reversible accelerator listing fingerprint. Public health
reports only the bounded backend description; raw device descriptions remain
inside the authenticated capacity boundary.

Packaged macOS arm64 runtimes contain the pinned Metal-capable upstream build.
Packaged Linux x64 runtimes contain a pinned CPU payload and a CUDA payload
built from the same pinned llama.cpp source with CUDA Toolkit 12.4. The Linux
artifact build fails if either required variant is absent.
That payload requires NVIDIA Linux driver 550.54.14 or newer. A launcher selects
the verified payload without changing the established
`KOED_HOME/runtime/llama.cpp/llama-server` path. Docker keeps its CPU starter and
provides a separate, digest-pinned CUDA override requiring the NVIDIA Container
Toolkit.

Git stores the pinned source recipe, upstream checksums, build scripts, and
validation policy, not generated native binaries. A trusted default-branch
workflow cold-builds the Linux CUDA payload only when its content-addressed
recipe key is absent, validates it before cache publication, and preserves the
completed runtime tree. Normal pull-request CI skips that work unless explicitly
requested. Release jobs require the validated cache, repackage it with the
product version, generate a SHA-256 sidecar and provenance manifest, and publish
the immutable archive as a GitHub Release asset. They fail rather than silently
performing a long cold build when the expected cache is missing.
Explicit pull-request proof runs may save a branch-scoped cache for repeat
validation, but that cache is not release-authoritative and cannot replace the
default-branch cache.

The CUDA payload bundles redistributable CUDA runtime libraries. `libcuda.so.1`
is supplied by the installed NVIDIA host driver and must remain external.
Artifact validation permits that exact unresolved dependency only inside the
CUDA payload and rejects every other unresolved loader dependency.

## Consequences

- Accelerator selection is derived from executable capability and successful
  startup rather than configuration claims.
- CPU, Metal, and CUDA produce separate capacity profiles but share semantic
  embedding compatibility and stored vectors.
- Forced acceleration failures are actionable; automatic fallback remains
  observable.
- Idle local accelerators release model memory without restarting Koed, at the
  cost of a measured reload delay on the next request.
- CUDA release artifacts are larger because required redistributable runtime
  libraries travel with the native payload.
- A changed source revision, CUDA version, or payload-producing build script
  invalidates the Linux runtime cache and incurs one trusted cold build before
  release. Validation-policy changes reuse but fully revalidate that immutable
  payload.
- Apple Metal release validation requires Apple Silicon hardware. Non-macOS CI
  can validate policy and manifest contracts but cannot claim hardware proof.

## Non-Goals

- Dynamic GPU provisioning, autoscaling, or multi-tenant GPU scheduling.
- Silent resource tuning in response to memory pressure.
- Treating acceleration changes as embedding epochs.
- Apple Intel, Windows-native CUDA, ROCm, Vulkan, or other accelerator backends.
