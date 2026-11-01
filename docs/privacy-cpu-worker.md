# Packaged Privacy CPU worker

The Linux x64 Team CPU image uses the authenticated TypeScript Privacy Service
with packaged Python ONNX inference children. It supports bounded two-worker
scheduling and short-field batching. Other native and accelerator paths retain
their existing implementation. A build alone does not qualify or deploy it.
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

| Platform/profile                        | Model execution                                            | Status                                |
| --------------------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| Linux x64 CPU candidate                 | Packaged CPython 3.11.14, ONNX Runtime 1.31.0, NumPy 2.2.6 | Packaged CPU worker profile           |
| General/native Linux, macOS and Windows | Existing Transformers/Node execution                       | Existing support scope retained       |
| CUDA, Core ML and DirectML              | Existing provider path                                     | No new hardware qualification claimed |

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
batching support. Setting the current image to one worker does not disable batching.
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

Finalization retains one deployment-wide lease. Increasing inference capacity
does not increase publication or finalization concurrency.

## Deployment and rollback

Use matching backend/client and Privacy images with independently qualified,
recorded image identities. The client must accept both one-slot and two-slot
capacity. A runtime rollback retains that client and changes only the Privacy
image. It does not authorize a database or API downgrade.

Use a separate volume containing only the six pinned public model files.
Provide read/traverse access for numeric User `1000:1000` and mount it read-only.
Preserve existing deployment mounts, data, classification credentials, and separate
runtime-control credentials. Inference children receive no database or publication
credentials. Keep the service on the deployment's private network.

Docker Compose 2.24.4 or newer is required for `!override`. From the deployment
checkout, set the following variables to the approved deployment and retained
local images. Image tags alone do not establish immutable identity.

```bash
: "${KOED_DOCKER_CONTEXT:?Set the approved Docker context}"
: "${KOED_TARGET_PROJECT:?Set the approved Compose project}"
: "${KOED_DEPLOYMENT_ENV_FILE:?Set the existing private environment file}"
: "${KOED_DEPLOYMENT_OVERRIDE:?Set the existing deployment override}"
: "${KOED_TEAM_RUNTIME_IMAGE:?Set the qualified matching backend image}"
: "${KOED_PRIVACY_CPU_IMAGE:?Set the qualified CPU image}"
: "${KOED_PRIVACY_ROLLBACK_IMAGE:?Set the qualified previous one-slot image}"
: "${KOED_PRIVACY_MODEL_VOLUME:?Set the verified public-only model volume}"
export KOED_TEAM_RUNTIME_IMAGE KOED_PRIVACY_CPU_IMAGE
export KOED_PRIVACY_ROLLBACK_IMAGE KOED_PRIVACY_MODEL_VOLUME

for artifact in "$KOED_TEAM_RUNTIME_IMAGE" "$KOED_PRIVACY_CPU_IMAGE" "$KOED_PRIVACY_ROLLBACK_IMAGE"; do
  docker --context "$KOED_DOCKER_CONTEXT" image inspect "$artifact" --format '{{.Id}}'
done

cpu_compose() {
  docker --context "$KOED_DOCKER_CONTEXT" compose --env-file "$KOED_DEPLOYMENT_ENV_FILE" \
    -p "$KOED_TARGET_PROJECT" \
    -f examples/server-compose/docker-compose.yml \
    -f "$KOED_DEPLOYMENT_OVERRIDE" \
    -f examples/server-compose/privacy-cpu-worker.override.yml "$@"
}
rollback_compose() {
  docker --context "$KOED_DOCKER_CONTEXT" compose --env-file "$KOED_DEPLOYMENT_ENV_FILE" \
    -p "$KOED_TARGET_PROJECT" \
    -f examples/server-compose/docker-compose.yml \
    -f "$KOED_DEPLOYMENT_OVERRIDE" \
    -f examples/server-compose/privacy-cpu-worker.override.yml \
    -f examples/server-compose/privacy-cpu-rollback.override.yml "$@"
}
cpu_compose config --quiet
rollback_compose config --quiet
```

Compare each inspected identity with the independently reviewed deployment record.
Record target containers, current image identities, pending-state counts,
policy-denied outcomes, and the approved observation window before changing services.
Do not print rendered secrets or replace keys, approvals, or model assets.

Stop the API/worker before changing capacity. Then drain the Privacy Service and
start its replacement. Preserve all durable operation identities.

```bash
cpu_compose stop -t 20 koed-server
cpu_compose stop -t 10 privacy-service
cpu_compose up -d --no-deps --no-build privacy-service
cpu_compose exec -T privacy-service node -e \
  'fetch("http://127.0.0.1:8092/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
```

Before restarting the backend, require model verification, startup parity, and
authenticated capacity of `maximumConcurrentRequests=2`. Health alone does not
establish authority or exact masking behavior. Use the normal authenticated
client for the approved synthetic masking probe and current allowed/denied reads.

```bash
cpu_compose up -d --no-deps --no-build koed-server
cpu_compose exec -T koed-server node -e \
  'fetch("http://127.0.0.1:3300/ready").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
```

For restart, repeat the same stop/readiness/start order with preserved volumes.
For rollback, retain the matching backend and start the qualified one-slot image:

```bash
cpu_compose stop -t 20 koed-server
cpu_compose stop -t 10 privacy-service
rollback_compose up -d --no-deps --no-build privacy-service
rollback_compose exec -T privacy-service node -e \
  'fetch("http://127.0.0.1:8092/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
```

Require model verification, parity, exact masking, and authenticated capacity of
one slot before running `rollback_compose up -d --no-deps --no-build koed-server`.
Then require backend readiness. Never restart a one-slot-only client against the
two-slot service. Preserve schema, consent, source, credential, and policy bindings.
Invalidated results and current denials remain unavailable after rollback.

Observe normal durable retry instead of replacing approvals or publications.
A crash can leave a 120-second claim lease. Process liveness does not renew a
stalled classification deadline. Record validated stages, cache reuse, errors,
retry/failure counts, and cgroup memory without content, paths, credentials,
token IDs, or logits.

Stop admitting work and roll back for masking/parity drift, identity mismatch,
exhausted inference recovery, OOM, or current-authority failure. Investigate
sustained memory above 3.2 GiB within the 4 GiB cap or comparable-cohort latency
regressions. Compare cache state, input sizes, queue age, and input-derived
deadlines. A policy denial is not an inference performance failure.

For performance qualification, compare exact output fingerprints before timing.
Report startup and warmup separately, bracket the candidate with baseline runs,
and record resource bounds and baseline drift. Service benchmarks do not establish
live publication speedups or qualify another platform or execution provider.
