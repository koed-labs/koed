# Privacy runtime migration validation

The ticket sequence and deployment authority are in [`tickets.md`](../tickets.md).
This record covers the new Linux x64 CPU path. It does not qualify native/GPU
providers or authorize a manual-backend deployment. The recorded changeset waiver
remains in effect.

## Ticket 01: packaged engine

Passed on 26 October 2026. The preparatory runtime delegation preserves the
existing complete tokenizer/window path; its seven windowing cases passed before
worker integration. Ten focused worker cases cover split framing, correct rows,
wrong job/generation, bad shape, non-finite values, oversized/incomplete output,
stalls, exit and cancellation. The four existing configuration and fourteen HTTP
route cases passed. The HTTP disconnect case needed a separate run with socket
access after the local sandbox denied its listener. Targeted ESLint and the
Privacy Service TypeScript build passed. No broad suite or native app build ran.

The clean Docker build pins both base images and every Python wheel; import
validation runs at build time. Runtime verifies all six pinned model files and
checks exact interpreter/engine/NumPy versions. Packaging and licenses are
documented in [the CPU worker guide](privacy-cpu-worker.md).

The isolated `koed-vps` runner used `--network none`, four CPUs, 4 GiB memory and
swap, a PID bound, a read-only root filesystem, no capabilities, no new
privileges, and numeric User `1000:1000`. Only a dedicated read-only public model
volume was mounted. The original volume was read-only while the six public model
files were copied; its permissions and other contents were unchanged. No
database, publication credentials or captured content were provided.

Candidate image manifest:
`sha256:77156c3f090d6dda60b3155ce4358cb10d764169a9ce6967580e6cb6e2fdc38e`
(`koed:privacy-worker-20261026-01c`). Qualification wrapper image:
`sha256:0b90278ac7957cd3768fc0a47b800c9194be52a95d22d730cfe094191762bab3`.
It exited zero without OOM. Startup through model verification, loading and
synthetic masking validation took 5,262 ms. One in-flight observation showed
1.055 GiB usage; this is not a peak or ticket 05 performance qualification.

The six saved production Node references from 23 October were reused. All six
preserved decoded text, complete byte offsets, Viterbi labels, spans and masked
text through the new runtime. All six then passed through the real HTTP service
and supported authenticated client, preserving paths, source SHA-256, byte
counts, decoded-text equality, spans and masks. A concurrent request was rejected
while multi-window work progressed; capabilities reported exactly one slot.
Missing classification authentication and use of that credential for privileged
runtime status were denied; the separate control credential succeeded. Service
closure and runtime disposal stopped the inference child.

The six existing manual Team containers remain running and healthy. No command
changed their services, data, grants or configuration. The local fixture remained
off. The first unsuccessful runner exposed only a model-directory permission
problem; it was corrected with the isolated public model copy. Temporary scripts
and logs remain investigation artifacts. This engine slice does not complete
recovery, concurrency, batching, adoption, publication, rollback or staging gates.

## Ticket 02: supervised recovery

Passed on 26 October 2026. Four focused supervisor cases verify failed whole
requests, delayed retirement before replacement, full synthetic parity rejection,
bounded backoff/exhaustion, ignored retired callbacks, cancellation, subsequent
authenticated success and shutdown during backoff. The ten worker protocol cases
passed with the new unavailable callback. The 24 existing runtime-manager cases
passed, retaining provider switching, CPU fallback, accelerator idle unloading
and disposal semantics in their deterministic provider fixtures. This does not
claim new accelerator hardware qualification. Targeted ESLint and the Privacy
Service build passed.

Candidate manifest:
`sha256:94a6083f7a4cabec2405b618ba02bc2f6db0bf833b4f97e53122da9b1dd4b6c5`
(`koed:privacy-worker-20261026-02`). The isolated qualification wrapper was
`sha256:7b725b3560b1ae444830d619d3dc8d11fe9f07fb1df19da3342b11686e32f631`.
It used the same non-root, network-disabled four-CPU/4 GiB restrictions and
read-only public model volume as ticket 01, and exited zero without OOM.

Through the real HTTP server and supported client, the runner disconnected after
model dispatch, killed a dispatched inference process, and stopped another
process to stall IPC. Each affected request failed; each replacement reloaded
verified model assets and passed the complete synthetic masking corpus, after
which a subsequent authenticated request reproduced the original result with
the same field paths. The stalled-IPC case injected a two-second inference
deadline to bound fault validation; the production per-window limit remains
60 seconds. Replacement did not overlap retiring process resources.

A fourth failure injected a wrong-job frame and exhausted the three-replacement
budget. Health returned 503 with `inferenceState=unavailable`. A retired frame
did not restore readiness, satisfy another request or create a replacement.
All child process handles were closed on disposal. Test diagnostics contained
only stage names and outcomes, without text, token IDs, logits or credentials.

A separate container started the actual packaged `dist/index.js` entry point.
After a synthetic long request emitted completed-window streaming progress,
Docker stop gave it a 12-second shutdown allowance. It exited zero without OOM
through the five-second drain/cancellation path. No forced container kill was
needed. All six manual Team containers retained their recorded IDs and remained
healthy; no manual deployment or local fixture was changed.

PRIV-01 and PRIV-02 are complete within this Linux CPU scope. The remaining
concurrency, batching, service adoption, publication and rollout gates remain
open. No wider benchmark or native application rebuild was performed.

## Ticket 03: bounded concurrency

Passed on 26 October 2026. Three focused pool cases cover two simultaneous jobs,
bounded queues, request-group rotation, cancelled queued work, result isolation,
reduced capacity and dispatch after validated replacement. The seven existing
complete-window cases and fourteen existing service route cases passed. A new
HTTP case occupied both reservations, sent only a third request's headers, and
received `503`/`Retry-After` without sending its body. Releasing one reservation
then allowed classification. Fourteen client cases passed, including capacity
one/two acceptance and zero/three rejection. Targeted ESLint, Shared build and
Privacy build/typecheck passed. No broader suite ran.

Candidate manifest:
`sha256:5e030b1bb27937464f1e8b78ecc79d38ec3b9a7f526b70a38719d830386abcf3`
(`koed:privacy-worker-20261026-03`). Qualification wrapper:
`sha256:a45d0dda5473323d84703a6e54f28b992e5028cc7b5e5c98048d989bf0133546`.
The isolated runner retained four CPUs/4 GiB, no network, non-root operation,
read-only public assets/root filesystem and the other restrictions from ticket 01.
It exited zero without OOM. Both process command lines selected two intra-op
threads; production code fixes inter-op threads to one. Observed simultaneous
model execution reached two, including both workers serving independent fields
within a single authenticated request. The six retained reference cases preserved
exact spans and masks through the real client, which also validates source hashes,
paths and byte lengths. Complete window/tokenizer output coverage remains in
ticket 01 and the unchanged focused windowing cases.

Two overlapping long requests caused a third caller to receive overload denial.
A short request completed while a longer multi-field request was still active.
Cancellation of one request and a separately killed inference child each left a
second request's repeated field path and original reference output intact. Normal
authenticated classification succeeded after replacement. A CPU-only `auto`
control succeeded without adding a process or calibration competing for pool
capacity. Disposal closed both current child handles. Replacement still retires
the old process before starting another, so recovery cannot add a third model.

Descriptive timings from one warmed observation per workload:

| Workload                                                     | Completion |
| ------------------------------------------------------------ | ---------: |
| Lone long field                                              |   2,036 ms |
| Mixed burst of overlapping four-field and two-field requests |   5,791 ms |
| Short request during an eight-field long request             |     113 ms |

Cgroup peak memory over parity, concurrency, cancellation and replacement was
3,144,650,752 bytes (about 2.93 GiB) within the 4 GiB cap. These single observations
are not medians, p95 estimates, an engine-only comparison, sustained-growth
evidence or ticket 05 adoption. Ticket 05 retains that comparison and its gates.
The Worker eligibility/yielding and single publication/finalization slot were
unchanged; this service qualification grants no Team access. All six manual Team
containers retained their recorded IDs and healthy status. PRIV-03 is complete;
batching, combined adoption, publication and rollout remain open.

## Ticket 04: short-field batching

Passed on 26 October 2026 for one and two workers. Sixteen worker protocol cases
include duplicate/missing rows, incorrect padded dimensions and lengths, invalid
padding values, identity/order restoration and padding removal, alongside the
retained framing, wrong-job/generation, cancellation and failure cases. Four
request-classification cases cover grouping, complete long fields, bounded
preparation, original ordering, immediate underfilled dispatch, cancellation,
incomplete mapping and streaming consumption without whole-request raw retention.
Four pool cases cover the activation-position budget as well as the existing
fairness and isolation rules. The seven complete-window cases passed after
tokenization was factored for reuse. Two service cases deny missing or duplicate
field callbacks without partial success. A focused CPU-only control case prevents
calibration from competing with batch work. Applicable build, typecheck, targeted
ESLint and formatting checks passed. No broad benchmark or native build ran.

The original 41-field corpus hash and all 41 complete-output digests were reused
from the 23 October one-worker baseline. Each profile checked 36 short fields
forward, the same 36 with reversed companions, and a reordered mixed set of all
41 fields. This is 113 complete comparisons per profile, including exact labels,
spans, masked text, token byte offsets and decoded text. All passed. The same
three orders then passed through the HTTP service and supported authenticated
client, preserving paths, hashes, byte lengths and spans/masks. No new truncation,
long-window batching or model/detector identity change was introduced.

One-worker artifact manifest:
`sha256:15fb99ec765cb20fd86efc3e3a638ef63d4fa199a31fc0fe051f8c06fa23e5a7`
(`koed:privacy-worker-20261026-04`); wrapper:
`sha256:20db45ed7f5dabaf8d886d89df28bb94487b8fad7386a8d4e4eeaa3b950b1e06`.
Its maximum eight-row/256-token shape reached 2,048 padded positions. Peak memory
was 2,218,557,440 bytes (about 2.07 GiB). A real disconnect after batch dispatch
failed closed, stopped its process, validated a replacement and allowed a
subsequent authenticated request.

That observation justified a pooled active-position guard before testing the
two-worker maximum shape. It preserves the allowed eight-row batch and ordinary
window concurrency, while preventing simultaneous activation allocations for two
maximum batches. No failing/OOM experiment was needed to establish that bound.
The final pooled artifact manifest was
`sha256:97dd54ffabef1691623bf8445a3fd047153a21fe3aa3a5fdeb64e499d67d402e`
(`koed:privacy-worker-20261026-04b`); wrapper:
`sha256:e0286e7ce0c50435326900a4af834b09b10e14a511f34e1d4d3f8bd6021688ba`.
It accepted two concurrent maximum-size requests within the combined 2,048-position
activation budget, preserved their results, passed the same parity orders, and
recovered a disconnected batch through validated replacement. Peak memory was
3,260,026,880 bytes (about 3.04 GiB). Both runners exited zero without OOM under
the same four-CPU/4 GiB, non-root, network-disabled, read-only isolation as ticket 01.

Pooled scheduling and input bounds changed between those two batching artifacts;
one-worker batch execution retained the same path. A subsequent CPU-only control refinement also covers the one-worker
profile and passed its focused deterministic check. Ticket 05 freezes the current
combined artifact for adoption measurements. These results establish batching
correctness and bounded resources, not the median/p95 or sustained-growth gates.
Both workers' child handles closed on disposal. All six manual Team containers
retained their IDs and healthy status; the local fixture stayed off. PRIV-04 is
complete. Combined adoption, publication and rollout remain open.

## Ticket 05: combined service adoption

Passed on 26 October 2026. The selected Linux x64 CPU candidate is
`koed:privacy-worker-20261026-05`, immutable identity
`sha256:2db9da6d30b87a58d84c81f4162b561a1a5a7519d32f4abef9d2aab7951bbb64`.
It retains two two-thread model workers, one inter-op thread each, up to two
admitted requests, short-field batching and the combined 2,048-position active
inference budget. No scheduling optimization was deferred. This disposition
allows the publication and rollout-rehearsal gates to proceed; it does not
authorize a change to the manual backend, release, push or merge.

### Method and artifact controls

The actual authenticated HTTP service and the supported client bundled with
each artifact were compared on `koed-vps`. The current service used
`koed:manual-privacy-progress-20261023`, identity
`sha256:4b2398b50466c8c780e7637648d2d8beafac371687bf87b1280d169402b250fa`,
running only its Privacy entry point in an isolated container. The engine-only
control was ticket 01's `koed:privacy-worker-20261026-01c`, identity
`sha256:77156c3f090d6dda60b3155ce4358cb10d764169a9ce6967580e6cb6e2fdc38e`.
The candidate was freshly built from the current implementation. All three used
the same read-only pinned model assets and the same four-CPU/4 GiB memory/swap
limits, non-root User, PID bound, network-disabled/read-only isolation and
synthetic credentials. No database, publication authority or captured content
was provided. Runtime package/model downloads were impossible.

The saved 41-field corpus contains 60,076 UTF-8 bytes and 9,171 tokens. Its hash
remains `fb9d88a078a4a350da865bfdc8999eb910a744bb9462d2358be60aa1a2cb284f`.
Seven ordinary request partitions contained 1,427, 6,811, 8,050, 7,971, 4,870,
9,836 and 21,111 field-text bytes. Requests normally respected 8 KiB packing;
the two oversized indivisible fields remained complete. The largest field ran
first, with three short probes interspersed through the burst. A bounded client
admission queue respected each service's actual one/two-slot capabilities, so
the candidate demonstrated overlap without manufacturing baseline overload.
Transport, tokenization, private IPC where applicable, decoding, masking and
validated progress were all inside the measured request path.

Process order was current service, engine-only, combined candidate, current
service again. Each fresh process reported startup separately, ran the labeled
boundary cases, completed one whole-corpus warmup, then ran three measured
bursts. The candidate also ran two further consecutive sustained bursts. HTTP
classification results were not cached. OS page cache was not flushed; startup
and warmup were excluded from adoption timing. The repeated baseline median
drifted by 0.56%. No other qualification/build workload ran concurrently with
the timing passes. Exact wrapper identities and executable replay steps are in
[the replay guide](privacy-runtime-qualification.md).

### Results

| Artifact                                | Median mixed-burst completion | Short-request service p95 | Median CPU per burst |
| --------------------------------------- | ----------------------------: | ------------------------: | -------------------: |
| Current service, six bracketing samples |                      29.774 s |                  666.6 ms |         118.36 CPU s |
| Engine-only, three samples              |                      10.186 s |                  135.8 ms |          39.62 CPU s |
| Combined candidate, three samples       |                       7.781 s |                  424.5 ms |          27.92 CPU s |

The short-service p95 is a nearest-rank observation from 18 baseline probes and
nine probes per candidate/control. Ready-to-complete p95, including the bounded
client admission queue, was approximately 30.010 s for the baseline, 10.285 s
for engine-only and 6.564 s for the candidate. These small samples describe this
workload; they do not establish a general latency SLO. Engine-only had the lowest
admitted short-request latency. The combined candidate traded some of that
advantage for a further 23.6% reduction in mixed-burst completion relative to
engine-only, while improving both metrics against the current service. Earlier
microbenchmark speedups were not multiplied into these results.

The full HTTP outputs matched exactly across all 41 fields in every warmup,
measured and sustained pass, including the repeated baseline. Field/source
binding remained under the supported client's normal validation. Four explicitly
labeled sensitive spans covered an email following multibyte text, an email near
a 256-token core boundary, a password following a Japanese line, and a phone
number. Every variant covered every labeled byte. There were no request failures
or masking mismatches. Complete labels and token-offset parity remain backed by
ticket 04's saved-reference comparisons; this HTTP comparison does not invent an
endpoint that returns sensitive token tensors or logits. These four cases are a
small boundary check, not a general classifier-quality evaluation.

Startup observations were 11.0–12.4 s for the current service, 3.7 s for
engine-only and 7.5 s for the two-worker candidate. Observed cgroup peak memory
was 2.55–3.23 GiB for the bracketing baseline, 1.19 GiB for engine-only and
2.14 GiB for the combined comparison. Page-cache charging differs between fresh
containers, so these are recorded absolute observations rather than a general
cross-artifact memory reduction claim.

### Bounded memory follow-up and disposition

The initial sustained candidate slice rose by about 37 MiB after warmup. That
alone was insufficient evidence for the no-continuing-growth gate. One targeted
memory-only run therefore used the same immutable candidate, one warmup and
twelve consecutive mixed passes (91.33 s of sustained work). A qualification-only
preload observed numeric Node heap/RSS and the two inference processes' RSS.
It added no source logging, inference endpoint or forced garbage collection,
and its timings were excluded from adoption statistics.

Both inference processes remained near 960 MB RSS. Natural garbage collection
reclaimed the service heap: heap-used fell from 506,714,480 bytes after warmup to
404,695,616 at the final observation; Node RSS fell from 740,630,528 to 605,958,144
bytes. Cgroup memory finished at 2,143,531,008 bytes, below its 2,304,110,592-byte
warmup observation. The memory-only peak was 2,357,751,808 bytes (about 2.20 GiB).
All output fingerprints still matched the original baseline, with zero failures.
This demonstrates reclamation within the bounded sequence; it does not claim
long-duration leak qualification. The unchanged maximum-shape batching path also
retains ticket 04's higher 3.04 GiB peak under simultaneous maximum-size requests.

| Proposed gate                                                       | Result                            | Evidence                                                                                                      |
| ------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| At least 25% lower median mixed-burst completion                    | Pass                              | 73.87% lower than the six-sample current-service baseline                                                     |
| No short-request p95 regression outside observed baseline variation | Pass                              | 424.5 ms versus 620.9–666.6 ms across the baseline brackets                                                   |
| Peak at most 3.2 GiB within the 4 GiB cap                           | Pass                              | 2.20 GiB in the current candidate's sustained check; unchanged maximum-shape path previously reached 3.04 GiB |
| No continuing retained growth in the bounded run                    | Pass within the observed sequence | Stable inference RSS and natural reclamation below the warmup heap/cgroup values                              |
| Exact masking and no missed labeled boundary spans                  | Pass                              | All 41 output fingerprints equal; all four labeled spans fully covered                                        |

All five qualification containers exited zero without OOM. The six manual Team
containers retained their recorded IDs and remained healthy. The eight unrelated
rootful containers on the same host retained identical IDs/names and remained
running. The local fixture stayed off. Existing security, cancellation and
publication-boundary evidence was reused rather than rerunning broad suites.
Ticket 05 is complete. PRIV-05 remains open until ticket 06 proves publication,
checkpoint recovery and a genuine current-authority denial. Native/GPU coverage,
coordinated rehearsal and authorized manual staging remain separate gates.

## Ticket 06: normal publication, encrypted recovery and current authority

Passed on 26 October 2026 in the disposable `koed-privacy06` deployment on
`koed-vps`. The local fixture stayed off. The six manual deployment containers
were not changed. This was a focused synthetic journey, not the full Team fixture
or launch suite. No additional automated test suite ran.

The headless backend is `koed:privacy-team-20261026-06`, immutable image identity
`sha256:eeebfa55b40eb632dfa312000448994ecb4fc43476516e99c5cc75eaa125f0cf`.
It was built from the current working tree with the normal server Dockerfile,
including the matching API, worker and shared capacity contract. Privacy used the
selected ticket 05 image, two workers, four CPUs, 4 GiB memory/swap, a read-only
root and the dedicated read-only public model volume. Fresh PostgreSQL databases,
Personal homes, device proofs and independent generated keys were used. There
were no published ports. A container-local loopback development gateway preserved
the normal HTTPS-or-loopback enrollment restriction. The embedding image was
`koed:manual-embedding-20261023`; only its public GGUF model was mounted read-only.

One synthetic Bob registered through `/auth/register` and created a Team and its
default Workspace through the normal browser APIs with idempotency keys. The
headless Personal origin used normal local credential provisioning, upstream
registration, capability validation and browser-reviewed device enrollment.
Approved operation families were exactly `team_workspace_read`, `team_chat_read`,
`team_chat_write`, `share_grant_management` and `sync`. Personal owner
`522c6409-7ddc-4f0d-b41c-f24b900b1a88` mapped to Team principal
`466b6140-9c13-48bb-869b-cbcd3dc8df68`. The destination was Team
`3bbdca17-0955-4e33-8ed8-50474dbe17eb`, Workspace
`7c43edef-6f0f-40aa-bc7b-65d1676b5af9`.

Fabricated Codex rollout files were ingested through the supported TypeScript
transcript watcher. Each final source had 24 user/assistant turns, 48 projected
Memory Events and distinct chronological timestamps. Preparation used
`collaboration.prepare_shared_memory_source`, normal encrypted cross-deployment
sync, `collaboration.preview_shared_memory_candidate`, and a manifest-bound
`collaboration.preview_shared_memory` approval. Each `collaboration.share_memory`
was separately reviewed and approved through the normal protected action-grant
flow. Approved scope was snapshot mode, Memory Event activation and maximum
fidelity, the source's three declared capabilities, no Curated Memory and no
expiry. No database writes manufactured sources, approvals, grants or recovery.
Read-only SQL observed lifecycle counters and encrypted checkpoint metadata.

| Journey            | Pending Share                          | Outcome                                                                                  |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| Normal publication | `240fab07-e15a-555f-a718-12544d8335b6` | Activated; 48 masked Memory Events read through the scoped initial-view API              |
| Crash recovery     | `044ec56f-025c-5d3e-b6ec-046ee8258375` | Activated after backend exit 137 and normal durable retry; 48 masked Memory Events read  |
| Current authority  | `1508daa8-55a4-590b-8056-f2f394cfb218` | Remained unavailable after a source-owner fidelity restriction; scoped read returned 403 |

With Privacy stopped, eligible work remained preparing at `privacy_filtering`
with Workspace access `none`. After capacity returned, the recovery observer
found seven newly verified field results before a complete semantic chunk had
finished. Docker then killed only the disposable Team backend; its confirmed
exit code was 137. The interrupted target had zero of three complete manifest
chunks, so no successful partial semantic result was accepted. The draft grant
was unreadable (403). The first independent grant remained readable.

The same backend restarted on its existing database and homes. After the normal
120-second claim lease, durable processing reported seven classifier cache hits,
then completed all three chunks and activated the original Pending Share without
resubmission. A read-only comparison of all 57 result records present at the crash
preserved IDs, owners, classifier hashes, owner fingerprints, byte counts and
payload-binding hashes. Their payloads used AES-256-GCM in owner-bound Personal
scope. Both semantic targets retained source preview, logical Memory, owner,
Team, Workspace, source revision, classifier and effective Privacy policy
bindings. Consent, mutation, logical grant and approved publisher identity stayed
with the original operation. Both authorized reads contained all 48 items and no
unmasked fabricated email address.

For the third distinct source, Privacy was held unavailable until the approved
Pending Share reached filtering with no Workspace access. The source owner then
used the normal policy PUT with expected version 1 to narrow maximum fidelity to
`lcm_rollups` at version 2. The old semantic target became `invalidated`; restored
classification capacity did not activate the grant. The operation stayed durably unavailable and subsequently reached
`needs_attention` with `activation_failed`, rather than being forced into success.
The scoped read returned 403, while both independently approved sources still
returned their 48 masked items. Personal source data was retained.

The unchanged encrypted-cache repository and deployment-wide finalization lease
remain the authority boundary; classification concurrency does not increase
publication concurrency. Ticket 03's process/job/path/hash isolation and ticket
02's validated-progress, cancellation and stall evidence are reused. Existing
repository checks cover owner-bound cache lookup and current grant/consent/policy
reads; the worker retains a single finalization lease. This journey used one
synthetic Team principal and does not claim a new multi-principal authorization
matrix, long-duration reliability result, native/GPU qualification, Git Anchor
catch-up or backend-disconnect fix.

Two setup failures were retained separately: the legacy synchronized preview
could not authorize a current Pending Share, and an initial artificial transcript
with identical event timestamps failed `candidate_manifest_changed` before
classification. Neither produced readable access or cache success. Distinct
chronological synthetic sources passed the current manifest-bound path. An early
in-container signal did not interrupt the backend and is excluded from crash
recovery evidence; only the Docker-confirmed exit 137 counts.

## Ticket 07: coordinated runtime rollout and rollback

Passed on 26 October 2026 on the same isolated current-build Team deployment.
The [Operator runbook](privacy-runtime-rollout.md) freezes the exact matching
backend/client, candidate and previous Privacy runtime identities, configuration,
cutover order, rollback triggers and observation limits. The two Compose override
files were rendered against the existing manual deployment configuration using
`config --quiet`; this was read-only and revealed no private configuration.

A synthetic 162,000-byte long-field request was in flight when Docker sent normal
shutdown to the candidate. Its five-second application drain expired, then the
connection was closed and inference children disposed. Docker stop completed in
6,408 ms; the supported client reported `PrivacyServiceUnavailableError` after
6,997 ms, without successful partial fields. The service was then replaced by the
frozen previous Privacy image while retaining the matching current backend/client
and all database/home volumes. That client accepts the previous one-slot and
selected two-slot contracts, so no unsupported mixed capacity was required.

The previous runtime completed CPU loading and startup parity in 10,639 ms,
advertised one slot and successfully classified one short and one multi-window
synthetic input. Cutting forward restored the selected two-slot image and the
exact same masking/spans fingerprint:
`86b81db73ccb71837582cb7f0843ab7106174b17e982fba0b3f69c875fe278fb`.
This is a focused cutover check, not another performance matrix.

Both previously activated shares returned all 48 masked Memory Events under each
runtime. The source-owner-restricted share remained unavailable and returned 403
under both; its old semantic target remained invalidated. An aggregate fingerprint
of the four Pending Share records' immutable approval, mutation, consent, preview,
source, destination and authority bindings was unchanged:
`4ad80ad4f29e026e2a08ee5b3145b6912c826e4d29446fd660b666029f9b76b5`.
All 57 encrypted result checkpoint records retained their identity and the two
completed semantic targets retained their binding identity and three-of-three
complete manifests. Ticket 06's actual same-image backend crash/restart and
ordinary lease recovery are reused for restart evidence. No database was reset,
source resubmitted or approval broadened.

Rollback deliberately retains the current matching backend/client and changes
the Privacy runtime. Read-only source fingerprints showed that the old full
manual image has different API/database source from the current backend, despite
identical migration files and worker sources. A full API/database downgrade is
not qualified by this runtime migration. The runbook prevents treating that
older full image as the current database/publication rollback set.

The six manual containers retained their original IDs and stayed healthy. The
eight unrelated rootful container identities were unchanged. The isolated
qualification containers were stopped after recording evidence; their fresh
durable volumes, frozen images and public-only model volume were retained. The
local fixture stayed off. Targeted formatting, `git diff --check` and Compose
render validation passed; no broad test suite or native build ran.

Read-only manual workload counts showed five already activated shares and five
ready Privacy targets, with no pending publication cohort. Ticket 08 remains
behind explicit deployment/workload authorization. Live complete-publication
performance and an authorized manual restart are not claimed from this isolated
rehearsal.

## Ticket 08: approved manual staging

Passed on 26 October 2026. The User explicitly approved rollout of the frozen
artifact set to `koed-manual-20261023`, the bounded restart/recovery check and ten
minutes of content-free observation, then approved a Git Anchor share through the
normal flow. No publication was created or resubmitted by the rollout driver.
The approved [Operator sequence](privacy-runtime-rollout.md) was used, preserving
all existing database/home volumes, keys, source bindings and grants.

The deployed matching backend is `koed:privacy-team-20261026-06`, identity
`sha256:eeebfa55b40eb632dfa312000448994ecb4fc43476516e99c5cc75eaa125f0cf`.
The deployed CPU service is `koed:privacy-worker-20261026-05`, identity
`sha256:2db9da6d30b87a58d84c81f4162b561a1a5a7519d32f4abef9d2aab7951bbb64`.
It runs as User `1000:1000`, with a read-only root, only the read-only public
model mount, four CPUs and a 4 GiB memory/swap cap. The previous one-slot runtime
image and matching current backend remain the qualified rollback set.

Before cutover, the target had five activated shares and five ready Privacy
targets. Their aggregate immutable binding fingerprint was
`1101f10e1d65e2d1f1d504f5ec9c1d42cbe6b4c763406bdaa41cac71c8c0f139`.
The API/worker stopped before Privacy changed. Candidate model verification,
loading and startup parity finished before the service listened at 7,219 ms;
only then did the matching backend start. The normal authenticated client
advertised two slots and returned the exact qualified short/multi-window masking
fingerprint `86b81db73ccb71837582cb7f0843ab7106174b17e982fba0b3f69c875fe278fb`.

The bounded restart repeated the API/worker-stop, Privacy-stop, Privacy-ready,
backend-start ordering without recreating data. Reload and parity finished at
7,327 ms. Backend and gateway readiness returned 200, and the authenticated
Privacy probe retained the same two-slot capability and exact fingerprint. All
five original shares remained activated/ready and retained the original binding
fingerprint. Unauthenticated Shared Memory owner and Team navigation reads were
denied with 401. No broad tests or native builds ran.

Automatic approval review rejected copying the existing protected test-user login
file into the backend because rollout approval did not specifically authorize
that credential transfer. The transfer was not performed or retried. The User's
existing normal Team session provided the authorized view check: the User
confirmed that a shared conversation opens. No stored credential was transferred.

The live observation ran from 11:59:28 to 12:09:28 UTC on 26 October 2026
(600,284 ms): 298 health/metadata samples, zero health or query errors, and no
new publication. All five original shares remained activated/ready with the
original immutable binding fingerprint. The separate 602-second resource observer
recorded 35 valid samples without sampling errors. Privacy memory was
1,895,809,024 bytes initially and 1,895,505,920 bytes finally, with a
2,105,536,512-byte peak inside the 4,294,967,296-byte cap. Every memory limit,
OOM and OOM-kill counter remained zero. Both deployed containers were healthy
with no OOM and no automatic restart.

The User then normally approved a Git Anchor rule at 12:26:58 UTC. The bounded
cohort contains four observed member publications; it is not a declaration that
all initial Git Anchor catch-up has completed. All four activated and the User
confirmed that a shared conversation opens in the authorized Team view. No
source content or credentials were read through the rollout observer.

| Observed member | Fields | Input bytes | Before Privacy target | Privacy target to ready | After Privacy ready | Accepted to activated |
| --------------- | ------ | ----------- | --------------------- | ----------------------- | ------------------- | --------------------- |
| 1               | 5      | 2,753       | 6.042 s               | 1.506 s                 | 0.879 s             | 8.427 s               |
| 2               | 273    | 20,456      | 6.124 s               | 23.718 s                | 1.580 s             | 31.422 s              |
| 3               | 2      | 320         | 94.353 s              | 0.931 s                 | 0.790 s             | 96.074 s              |
| 4               | 3      | 665         | 74.250 s              | 0.564 s                 | 30.466 s            | 105.280 s             |

Times are from durable lifecycle timestamps, not sampled progress estimates.
Privacy target duration includes scheduling, bounded passes, classification,
checkpointing and finalization. Before/after durations must not be attributed to
inference; source sync, admission and activation remain separate stages. Member
3 had three Pending Share processing attempts; the others had one. None ended
with a failure code, and all four Privacy targets had zero classification retry
attempts, no classifier error and complete manifests (1, 18, 1 and 1 chunks).

The cohort contained 283 fields / 24,194 input bytes. Eleven work passes made 21
inference calls, attached all 21 chunks and yielded eight times within the normal
work budget. There were no classifier cache hits and no classifier failures.
Seventy-two cumulative observations of already-ready manifest chunks across
continuation passes are reuse observations, not 72 distinct inputs. Summed
service-call time was 14,762.8 ms, measured classification work 18,329.3 ms and
finalization 2,305.9 ms; these sums are not whole-cohort elapsed time. The four
observed activations finished 206.705 seconds after the rule was created. The
rule retained authority version 1 and publisher fence 1.

A separate 300,198-ms live-cohort window had 149 health samples, no health/query
errors and four ready Privacy targets. Its resource observer ran 308.4 seconds
with 18 valid samples and no sampling errors. Current Privacy memory moved from
1,941,872,640 to 1,944,571,904 bytes. The cgroup lifetime peak, including all
publications since the deployed service restarted, remained 2,105,536,512 bytes
(1.96 GiB) inside the 4 GiB cap. Limit and OOM counters remained zero. Final state
was nine activated shares and nine ready Privacy targets; the original five
retained their exact binding fingerprint. Both deployed images were healthy,
with no OOM and no automatic restart.

This is one normally approved rule and four differently sized member inputs,
with no paired prior-runtime publication baseline. The 73.87% service benchmark
gain therefore remains a service-only result; no numerical live-publication
speedup is claimed. The User confirmed one authorized conversation view, not a
new multi-principal security matrix. Rule-member diagnostics still carried
`source_not_ready` reconciliation markers when sampled after activation; those
initial-admission/catch-up diagnostics were not altered or declared fixed. The
scoped publication and Privacy runtime gates passed without changing grants,
policy, source identity, publisher fences or finalization concurrency.

The local fixture and disposable qualification services remain stopped. The four
unchanged manual dependencies and eight unrelated rootful containers are left
running. Rollback remains the frozen one-slot Privacy service with the matching
current backend, without a database downgrade or reset. The changeset waiver is
retained; no push, merge or release was performed. Ticket 08 is complete.
