# Privacy runtime migration plan

Status: complete for the qualified Linux x64 Team CPU scope, 26 October 2026.
Tickets 01–08 passed service qualification, synthetic publication/recovery/denial,
isolated rollback and the explicitly approved manual rollout/restart/observation.
Four normally approved member publications activated and the User confirmed the
Team view opens. Native/GPU qualification and broader initial Git Anchor catch-up
remain outside this completion. See the
[validation record](privacy-runtime-migration-validation.md).

The original benchmarks justified implementation of a
candidate behind the existing Privacy Service interface. Further measurements
are acceptance checks for that candidate; a wider optimization survey is not
required before starting.

This is a runtime and deployment migration for matching current components.
Legacy data and database compatibility remain out of scope. Current persistence,
restart, recovery, source bindings, authorization and publication behavior remain
required. This plan does not authorize a merge, release or change to the running
manual-test backend.

## Evidence and scope

The 23 October remote experiments used synthetic data, pinned model assets,
four CPU quota and a 4 GiB memory limit. All reported gains are measured within
their stated workload; they cannot be multiplied into a production prediction.

| Candidate                                | Evidence                                                                                                                                | Migration decision                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| ONNX Runtime 1.31 CPU                    | 3.19 times faster inference and 2.88 times faster measured classification than 1.24.3 on six cases; exact decoded output                | Primary change                                           |
| Two workers, two threads each            | 22.5% lower mixed-burst completion time than one four-thread worker; container peak 1.76 GiB versus 1.15 GiB; exact output on 41 fields | Bounded concurrency candidate                            |
| Up to eight short fields per model batch | 35.7% lower measured classification time; exact output on 36 short fields                                                               | Batching candidate after the engine and pool             |
| Batching existing long-field windows     | 11.3% lower measured time, with 8.3% baseline drift                                                                                     | Defer specialized long-window scheduling                 |
| Larger windows                           | Four previously masked bytes exposed in each candidate                                                                                  | Exclude                                                  |
| Spinning disabled                        | About 21% lower CPU time but 3.4% longer burst completion                                                                               | Retain current spinning behavior for the first candidate |

The CPU/concurrency baseline repeated within 1.1%. Those measurements include
the experimental Python transport and production decoding, and exclude parts of
the service and publication path. They do not replace the earlier live remote
rate of approximately 0.96 KiB/s. See the
[initial engine validation](team-continuous-sharing-validation.md#isolated-remote-privacy-engine-benchmark--23-october-2026)
for its method and limitations. The later experiments used 41 synthetic fields,
60,076 UTF-8 bytes and 9,171 tokens; the short-field and long-field experiments
used the corresponding subsets.

## Proposed service design

Retain the authenticated TypeScript Privacy Service as the classification and
control boundary. Keep its tokenizer, offsets, existing windows, calibration,
Viterbi decoder, deterministic detector and final masking validation. Replace
only CPU model execution first.

The preferred implementation candidate is a supervised local inference worker
using the official Python ONNX Runtime 1.31 package, pinned with its interpreter,
NumPy and transitive dependencies. Python is an
[upstream-supported ONNX Runtime binding](https://onnxruntime.ai/docs/get-started/with-python.html).
The measured Python engine already accepts the exact production tensors. This
avoids making a newer Node binding a prerequisite for the service migration.
If a supported matching Node package is available at implementation time, compare
packaging and maintenance cost once; do not start another engine search or patch
native ABI symbols. Record the selected packaging trade-off in an ADR when it is
adopted.

Workers live inside the Privacy Service deployment and communicate over bounded,
versioned local IPC. They receive token tensors and return validated logits. They
have no database, publication credentials, model-download path or independently
exposed network endpoint. Token IDs and logits remain sensitive data: do not log,
persist, or expose them through diagnostics. The service owns worker startup,
readiness, cancellation, failure handling and shutdown. A process-generation and
job identity must prevent a late response from satisfying a different job.

Use the existing four-CPU/4 GiB Linux x64 Team deployment as the first target.
The initial optimized candidate has at most two CPU model workers with two
intra-op threads each and one inter-op thread. Native macOS/Windows/Linux
packaging and accelerator providers retain their supported paths until separately
qualified. The Linux result must not silently change their defaults or require
Users to install Python. Document the deployment/platform coverage explicitly;
no global runtime replacement is complete until the intended platforms pass.

## Security and behavior that must survive

- Keep the pinned model, tokenizer, calibration, detector and decoder identities,
  256-token core, 128-token context on each side, and complete field coverage.
  Do not truncate fields or increase the context window.
- Keep authenticated classification separate from privileged runtime controls.
  Preserve request/body/field limits, decoded-text equality, field paths, source
  hashes, byte lengths, span coverage and finite, correctly shaped outputs.
- Keep classifier identity distinct from runtime implementation identity. An
  engine or worker change updates runtime validation/cache fingerprints. Reuse
  classifier identity only when the defined pinned classifier artifacts remain
  unchanged and output qualification passes; never relabel changed behavior to
  satisfy a check.
- Retain runtime startup parity and provider activation checks, CPU fallback
  rules, cancellation semantics and serialized provider switching. Bound the
  combined memory of active, loading and retiring pools.
- Keep source, destination, owner, consent, policy, membership, revocation and
  publisher-fence checks in their current authoritative owners. Classification
  success cannot grant access or authorize publication. Recheck current authority
  at the existing publication boundary.
- Preserve encrypted, owner-bound field/chunk results, current cache eligibility,
  durable retries and current-build recovery. Only verified complete results may
  be reused. The final publication/finalization lock stays at one.
- Emit only content-free, validated completed-work progress within the existing
  input-derived bound. Waiting in a queue or observing a live worker is not
  classification progress and cannot renew an inactivity deadline.
- Reject overload explicitly with the existing retry semantics. Failed,
  cancelled, malformed or incomplete work must not produce a successful partial
  classification, a cached success or a visible publication.

## Delivery stages

### PRIV-01: Select and package the inference boundary

Confirm the existing request/control contracts and runtime lifecycle. Select the
supported worker package and record the dependency/platform matrix, artifact
hashes, licenses and reproducible build inputs. Define bounded IPC framing,
tensor shapes, output limits, job/generation identity and error handling. Keep the
boundary narrow; the experimental scripts are evidence, not production code.

Exit: a clean Linux image starts and stops the selected engine with verified local
model assets, no runtime package downloads, and a six-case production-tensor
parity check. This is the one packaging proof needed before implementation.

### PRIV-02: Replace CPU execution with one supervised worker

Add a focused runtime adapter behind the existing service, initially retaining
one request admission and a four-thread model worker. Preserve the TypeScript
tokenizer and final decoder/masking path. Integrate readiness, startup parity,
runtime fingerprints, provider lifecycle and bounded restart/backoff. A worker
failure fails the affected work; capacity returns only after replacement and
validation. Cancellation stops undispatched work and rejects late results.

Exit: the real authenticated service contract passes unchanged success and denial
checks. Worker exit, malformed output, stalled IPC and cancellation fail closed,
without leaking data or leaving capacity permanently occupied. Record the engine
change independently from subsequent scheduling changes.

### PRIV-03: Add bounded concurrency and fair scheduling

Introduce at most two two-thread model workers within the total CPU/memory
budget. Admit at most two authenticated requests, reserving capacity before body
allocation, with additional bounds on active bytes, tokens and queued model work.
Schedule only already-admitted work. Keep field/job identities isolated and avoid
starving a small ready request behind repeated work from a large request.

The current shared capabilities contract fixes concurrency at one. Update its
schema, advertised capacity, service and client validation together; do not simply
remove the busy guard or bypass a literal check. Provider controls must coordinate
with active work across the entire pool. Represent the bounded capacity of the
active runtime profile truthfully: existing single-worker/native or accelerator
paths may still have one slot, while the qualified CPU pool has up to two. This
is current-profile capability, not a legacy protocol adapter. Never advertise two
ready slots for a one-slot runtime.

Verify that real caller behavior can use the capacity. A single admitted request
may supply independent fields to both workers within the same limits. This must
not require broader publication-finalization concurrency or unbounded target
fan-out. Preserve Worker target yielding and durable eligibility ordering.

Exit: focused checks cover simultaneous requests, overload, identity isolation,
cancellation of one request while another completes, worker replacement and
provider transitions. Measure both a mixed burst and a lone long request so a
throughput improvement does not conceal a material latency regression.

### PRIV-04: Batch ready short fields

Batch at most eight fields of at most 256 tokens, grouped by length within one
admitted request. Use independent attention-masked tensor rows, at most 2,048
padded positions for these short-field batches, and exact per-field output
mapping. Keep complete long-field processing on the existing windows. Dispatch
an underfilled batch immediately when it is the available work; do not add a
timer solely to fill a batch or batch across authorization/request boundaries.

Exit: the existing short/mixed corpus and reordered companions preserve labels,
spans, masked text and offsets. Invalid row counts, duplicate/missing field IDs,
padding errors and cancellation cannot produce a successful mixed-up response.

### PRIV-05: Qualify the combined service candidate

Run the actual HTTP service and supported client on an isolated remote runner
with the same resource cap and synthetic workload for the current service,
engine-only replacement and combined candidate. Include real request partitioning
(normally 8 KiB chunks), one larger indivisible field, overlapping requests and a
short sustained mixed sequence. Include tokenization, IPC, decoder, masking,
progress and transport in the measured path. Report cache state and startup
separately. Do not multiply earlier microbenchmark improvements.

Use the existing 41-field corpus plus a small set of explicitly labeled sensitive
boundary cases. Require exact baseline output on the parity corpus and no missed
labeled sensitive spans. Any mismatch needs resolution before adoption; the
existing output is not itself proof of privacy detection quality.

Proposed adoption gates for the four-CPU/4 GiB Team profile are at least 25% lower
median mixed-burst service completion time than the current service, no short-
request p95 regression outside measured run variation, and peak container memory
at most 3.2 GiB with no continuing growth in the bounded sustained check. These
are targets for the migration, not results already achieved. If a scheduling
optimization misses them, retain the separately qualified engine change and
defer that optimization rather than expanding the benchmark matrix.

Reuse unchanged security evidence. Run focused checks for changed admission,
progress, cache/fingerprint, cancellation and worker-failure behavior. Finish with
one bounded synthetic publication journey through normal preparation, Privacy,
activation and authorized read-back, plus a current-authority denial before
activation. Existing grants/approvals remain exact; fixture setup uses normal
authorization. The unrelated Git Anchor admission backlog is a separate issue.

Exit: matching candidate artifacts, measured service results, unchanged security
boundaries, successful publication and one verified denial. Record remaining
platform qualifications explicitly. No broad new harness is required.

### PRIV-06: Stage rollout and document rollback

After candidate review and deployment authorization, stage the matching build on
`koed-vps`. Keep the local Team fixture off and unrelated remote containers
running. Retain the previous matching artifact set and configuration. Drain or
cancel in-flight classifications within a bounded deployment window; allow
durable work to resume after readiness and parity checks pass. Never resubmit
ambiguous publications or change grants to make a rollout succeed.

Observe content-free stage timings, queue/capacity behavior, errors and memory on
the approved manual workload. Do not log captured content. If failures, masking
drift, sustained memory growth or material latency regression appear, restore the
previous matching component set. A changed capacity contract requires coordinated
service/client rollback; mixed-version operation is not a requirement. Preserve
current durable work and valid encrypted checkpoints, rechecking their identity
and current authority during recovery. No database reset is part of rollback.

Exit: deployment and rollback instructions are concrete, a restart/recovery check
passes, and the observed workload is reported with its limits. Update
configuration, running/deployment and runtime packaging documentation for the
actual supported behavior. Apply the existing agreement to omit a changeset;
merge and release remain explicit later actions.

## Work tracking

The [implementation backlog](../TODO.md) tracks PRIV-01 through PRIV-06. The
[production ticket index](../tickets.md#privacy-runtime-migration-planned-26-october-2026)
links this work package. Keep completed PROD evidence intact and keep the backend
switch/disconnect and initial Git Anchor admission investigations separate.
