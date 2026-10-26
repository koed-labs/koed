# Packaged Privacy CPU worker

The Linux x64 Team candidate uses the existing authenticated TypeScript Privacy
Service with packaged Python ONNX inference children. Engine, concurrency,
batching, service adoption, synthetic publication/recovery/denial and isolated
rollout/rollback have passed Linux CPU qualification. The approved manual rollout, restart, observation and four normally approved
member publications passed. The User confirmed the authorized Team view opens. See the
[Operator runbook](privacy-runtime-rollout.md). Their status is tracked in
[`tickets.md`](../tickets.md); a build alone does not qualify or deploy it.
See [ADR 0062](adr/0062-packaged-privacy-cpu-inference-worker.md) for the trade-off.

## Pipeline and trust boundary

The service verifies every file in `PINNED_PRIVACY_MODEL_FILES` before starting
the child. The TypeScript tokenizer retains complete byte offsets and the
256-token core with 128-token context on each side. Only model execution moves
to the child. TypeScript retains calibration, Viterbi decoding, deterministic
secret detection, decoded-text equality and final masking validation.

Stdio frames use a four-byte unsigned big-endian length followed by JSON.
Protocol version 2 binds each response to a random process generation and job
ID. One outstanding job carries either one existing window of at most 512 tokens,
or up to eight independent short-field rows of at most 256 tokens each and at
most 2,048 padded positions. Request framing is bounded to 64 KiB and response
framing to 2 MiB. Every returned token, including padding, must have 33 finite
logits. Wrong identities, unexpected/trailing frames, invalid shapes, non-finite
values, incomplete output or process failure make classification unavailable.
Neither native errors nor frame content are returned through diagnostics.
The supervisor fails the affected request and retires the child before loading
a replacement. Replacement re-verifies the model and must reproduce the complete
three-input synthetic masking corpus before accepting work. Classification
does not admit new requests into a recovery queue, and failed requests are not
automatically replayed. The affected slot stays unavailable until validation;
an independently healthy pooled slot can continue. Health and privileged runtime status
include content-free `inferenceState` values: `loading`, `ready`, `recovering`,
`unavailable` or `stopping`.

Restart backoffs are 250 ms, one second and five seconds, with at most three
replacement attempts in a five-minute window, including attempts whose loading
or parity fails. Repeated failure exhausts capacity and leaves `unavailable`
until the Operator restarts the service. A healthy interval beyond that window
allows a fresh budget on a later failure. Cancellation also retires its process;
responses from that process cannot complete subsequent work. Optional native
and accelerator provider paths retain their existing implementation.

The child inherits an explicit minimal environment, without classification,
runtime-control, database or publication credentials. It has no listener,
external inference endpoint or package/model download code. Deploy the service
without database mounts or credentials, with the pinned model directory mounted
read-only. Its numeric User is `1000:1000`; provide read/traverse access to those
public model files without widening access to Personal source or secrets.
Classification and privileged runtime control keep separate credentials.
Classification does not authorize publication or alter any Team authority check.

Startup still runs the three-input synthetic masking validation before readiness.
Runtime validation/cache identity additionally hashes worker implementation,
Python source, wheel lock and the build's installed dependency/binary identity.
The pinned classifier hash remains separate. Cache write failures on a read-only
model mount disable persistence of optional runtime measurements; they never
skip validation. Encrypted owner-bound classification reuse and durable retry
remain in their existing authoritative backend components.

## Packaging and support

| Platform/profile                        | Model execution                                            | Status                                                         |
| --------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| Linux x64 CPU candidate                 | Packaged CPython 3.11.14, ONNX Runtime 1.31.0, NumPy 2.2.6 | Tickets 01–08 passed; approved manual CPU deployment qualified |
| General/native Linux, macOS and Windows | Existing Transformers/Node execution                       | Existing support scope retained                                |
| CUDA, Core ML and DirectML              | Existing provider path                                     | No new hardware qualification claimed                          |

`Dockerfile.cpu-worker` pins the Node and Python base manifests by digest.
`worker/requirements-linux-x64.lock` pins every selected CPython 3.11/Linux x64
wheel by version and SHA-256; installation requires hashes and binary wheels.
No build resolves a floating Python dependency. `runtime-identity.json` records
interpreter and installed package hashes. The workspace pnpm lock remains the
source for TypeScript dependencies. The general Dockerfile remains unchanged.

The selected dependency licenses are CPython's PSF license, Node's MIT license
and bundled notices, ONNX Runtime's MIT license, NumPy's BSD license and bundled
library notices, Protobuf's BSD license, FlatBuffers' Apache 2.0 license, and
Packaging's Apache 2.0/BSD dual license. Installed wheel license directories,
Python notices and the copied C++ runtime notices remain in the image. Wheel
digests are in the lock; base digests are in the Dockerfile and runtime identity.
Upstream references: [Python binding support](https://onnxruntime.ai/docs/get-started/with-python.html),
[ONNX Runtime 1.31.0](https://pypi.org/project/onnxruntime/1.31.0/).

## Candidate operation

Build from the repository root on the authorized remote Docker engine:

```bash
docker --context koed-vps build --platform linux/amd64 \
  -f apps/privacy-service/Dockerfile.cpu-worker \
  -t koed:privacy-cpu-candidate .
```

The image selects `PRIVACY_RUNTIME_ENGINE=onnx-worker` and
`PRIVACY_RUNTIME_PROVIDER=cpu`. It requires the existing
`KOED_PRIVACY_TRANSFORMERS_CACHE`, `PRIVACY_SERVICE_TOKEN` and
`PRIVACY_RUNTIME_CONTROL_TOKEN` settings. `auto` also remains CPU-only in this
image; explicit accelerator preferences are rejected. Provider capabilities do
not advertise an accelerator. The default `transformers` engine remains unchanged
outside this image. The worker engine rejects other operating systems/architectures.

Use four CPUs and a 4 GiB memory/swap limit. `PRIVACY_CPU_WORKERS=2` is the
candidate image default: two model processes, two intra-op threads each, one
inter-op thread each, and at most two admitted requests. `PRIVACY_CPU_WORKERS=1`
selects one four-thread process and one request, with the same short-field
batching support. The frozen ticket 01 image remains the engine-only benchmark
control; setting the current image to one worker does not disable batching.
Native/accelerator paths still advertise one. The service/client contract accepts
exactly one or two as the current profile's capacity. While one pooled worker
recovers, advertised admission drops to one; when neither is ready, classification
admission fails closed. The recovered slot returns only after validated loading.

The HTTP adapter authenticates and reserves classification capacity before
buffering its body. At most two 2 MiB encoded bodies and two 1 MiB field payloads
are admitted. Each request prepares up to eight already-present fields, stopping
at two long fields. Short fields are grouped by length, without waiting for a
batch-fill timer. The prepared-token guard is 258,048 per request, at most 516,096
across two requests. At most two units per request and four units overall are
outstanding, including running jobs. A unit is an unchanged long-field window or
one short-field batch. Each batch is limited to eight rows, 256 tokens per field
and 2,048 padded positions. The pool also limits active inference to 2,048 padded
positions across both processes, so two maximum batches do not allocate large
activation buffers simultaneously. Existing long windows still run concurrently.
Ready units rotate between request
groups. Waiting requests emit no progress, and the next window of a long field
cannot jump ahead of already waiting work. One request's independent fields can
use both workers. A field failure cancels its siblings and waits for cleanup;
completed fields never escape in a partially successful response. Result order
and field/source bindings remain exact. Rows carry opaque field IDs and exact
lengths. The service rejects duplicate/missing IDs, incorrect padded dimensions
and invalid values before trimming padding and decoding. It validates and masks
completed groups through a callback, releasing raw outputs rather than retaining
the entire request's logits. Only validated field and window completion advances
progress; batch preparation and padding do not.

Keep the service internal to matching Team components. Excess authenticated
requests retain `503`/`Retry-After` behavior.
Validated completed windows and fields are the only classification progress;
process liveness and queue waiting are not progress. An inference response has a
60-second per-window bound; model startup has a 90-second IPC readiness bound.
Failure closes the child with SIGTERM, escalating to SIGKILL after one second.
Cancellation returns no successful partial classification or cache entry.
Service shutdown drains HTTP work for up to five seconds, then closes remaining
connections to propagate cancellation. It stops recovery backoffs and waits for
loading/retiring resources to close before exiting.

The later tickets qualify combined adoption and publication. They do
not widen publication/finalization concurrency. Keep rollout,
rollback and manual-backend deployment behind their recorded acceptance gates.
