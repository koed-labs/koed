# ADR 0027: Embedding Capacity Calibration And Telemetry

Status: Accepted.

Related decisions:

- [0007 Desktop Control Plane Consumes koed-server](./0007-desktop-control-plane-consumes-koed-server.md)
- [0009 Commercial SaaS Encryption And Key Management](./0009-commercial-saas-encryption-key-management.md)
- [0010 Managed SaaS Queryable Vectors](./0010-managed-saas-queryable-vectors.md)
- [0025 MCP v2 and Local AI Runtime Ownership](./0025-mcp-v2-local-ai-runtime-ownership.md)
- [0026 Pre-launch Schema Reset and Processing Epochs](./0026-pre-launch-schema-reset-and-processing-epochs.md)
- [0031 Verified Embedding Acceleration](./0031-verified-embedding-acceleration.md)
- [Hosted Capacity Plan And Load Checks](../hosted-capacity-plan.md)

## Context

Embedding work is costed by model input tokens, not by queue rows. A queue with
ten large sources can represent more work than one with hundreds of short
sources, and the same backlog drains at materially different rates on CPU,
Metal, CUDA, or differently configured llama-server pools.

Koed already has a production Embedding Service adapter, a synthetic benchmark,
PostgreSQL and BullMQ queue backends, historical-import coverage counters, and
an authenticated operations snapshot. These parts do not yet form one durable
capacity contract. Adapter-measured tokens are discarded by the Worker, queue
counts do not cover every embedding path consistently, and process-local logs
cannot produce restart-safe throughput or completion estimates.

Health probes, human operations status, and machine telemetry have different
security and performance requirements. Combining them would either expose too
much publicly or make readiness depend on expensive operational queries.

## Decision

Koed uses a durable, token-costed embedding capacity model.

The production Embedding Service adapter remains the measurement authority.
Every stored embedding chunk records the adapter-reported input token count.
Koed does not retokenize source text in an observability path and does not
estimate completed token throughput from character counts.

The adapter exposes two intentionally distinct measurements. Per-chunk counts
come from llama-server's tokenizer without model-added special tokens and are
persisted with the embedding. Request-level measured tokens come from the
embedding execution response and include its prompt-token overhead; capacity
profiles and throughput telemetry use that execution total when the runtime
provides it. If a supported llama-server response omits usage metadata, the
Worker uses the sum of the response's validated per-chunk tokenizer counts so
semantic ingestion and calibration remain available. Equality between the two
measurements is neither required nor expected.

One versioned capacity profile identifies a stable worker pool, embedding
processing contract, compatible model artifact, runtime configuration, hardware
class, and calibration mode. This capacity-contract identity measures execution
throughput; it does not replace ADR 0026's complete embedding compatibility
identity or publish a generation. Until the bounded generation registry exists,
the current model, dimensions, artifact, tokenizer, transform, pooling, and
normalization fields form the fail-closed compatibility subset consumed by this
feature. A short synthetic
calibration runs asynchronously after model readiness when no compatible
profile exists. It uses only generated fixtures and never User Memory. Live
capture and Recall remain available while calibration is missing or fails, but
automatic unbounded historical admission fails closed until a usable profile
exists. A longer explicit or idle-time calibration may refine the profile.
Both modes pass generated 512, 1024, 2048, and 4096 target-token classes
through the production adapter. The profile retains only bounded target class,
adapter-measured token count, and duration records, never fixture text.

Capacity identity includes the bounded deployment pool key, model key and
artifact hash, embedding capacity-contract revision, runtime settings that
materially affect throughput, backend class, and a non-reversible hardware
fingerprint. Non-CPU backends also bind that fingerprint to a non-reversible
hash of llama-server's device listing; if the listing cannot be established,
capacity identity and historical admission fail closed. The Worker verifies
that the service-reported model and dimensions exactly match its configured
embedding contract before reusing a profile. A material identity change
invalidates old measurements from that pool instead of silently reusing their
throughput. It does not invalidate an independent pool. PostgreSQL advisory leases ensure only one Worker replica
calibrates a given pool at a time. Active compatible pool rates aggregate into
the deployment capacity snapshot. Workers heartbeat their active profile in
PostgreSQL; a profile whose pool has stopped heartbeating expires from active
capacity and ETA calculations without deleting its calibration history.

PostgreSQL is the durable operational truth for completed embedding work and
calibration profiles. Canonical Memory Event rows provide arrival counts
without adding a telemetry write to the Projection transaction. Low-cardinality
minute buckets retain completion, retry, failure, token, chunk, queue-wait,
execution, and end-to-end duration aggregates across Worker restarts and
replicas. Rolling windows use complete minute buckets so their denominators and
bucket boundaries agree. Canonical source and embedding rows remain the truth
for current semantic coverage and pending token cost. BullMQ and the PostgreSQL
local queue are execution transports and must report equivalent queue
categories.

Rolling throughput distinguishes Memory Event arrival from completed Memory
Event, Memory Node, and message embeddings. The Worker owns embedding execution
and LCM compaction admission; the `koed-server`-supervised Local AI Runtime owns
AI-client-backed LCM Summary synthesis under ADR 0025. LCM compaction completion
is therefore a separate operational class and does not prove Local AI Runtime
synthesis or Memory Node embedding readiness, nor does it inflate the generic
embedding completion rate.

The operational surfaces are separated:

- `GET /health` and `GET /ready` stay unauthenticated, cheap, coarse, and
  side-effect free.
- `GET /ops/status` provides a redacted snapshot to a browser-authenticated
  Koed Operator. Hosted-capable profiles additionally enforce the existing
  Koed operator authorization policy.
- `GET /v1/historical-import-admission` provides a content-free local
  `{ admitted, reason }` decision to an authenticated User session or Personal
  API Token. It shares the Worker admission policy and reads coordinator-owned
  health/capacity state; the Local AI Runtime does not infer admission from
  `/ops/status` or probe the Embedding Service independently.
- `GET /internal/metrics` exports OpenMetrics-compatible low-cardinality counters,
  gauges, and histograms for machine collection. It is disabled unless a
  dedicated monitoring bearer credential is configured, must remain inside
  the trusted deployment network, and is not routed through the normal public
  gateway.

Personal API Tokens, Capture Hook credentials, upstream or local-edge device
credentials, Team Membership, and ordinary User sessions do not grant hosted
operations or machine-metrics access. Automated monitoring never reuses a
human browser cookie.

Metrics do not use tenant, Team, User, Project, Captured Session, source-row,
path, prompt, or other private or unbounded values as labels. Per-Captured-
Session semantic coverage is an authorized product/status query rather than a
monitoring label.

Estimated drain time is a range derived from pending measured or safely
estimated tokens, queue-ahead work, the active capacity profile, and observed
effective throughput. Raw job count is diagnostic context, not the primary
capacity signal. An unavailable or low-confidence estimate is reported as such
instead of presenting false precision.

Before any usable profile exists, Koed uses a documented conservative fallback
of 5 input tokens per second solely to communicate a low-confidence ETA range.
The fallback never opens historical auto-admission. Per-Captured-Session ETA
adds its own pending estimated tokens to higher-priority live/normal semantic
work and newer historical work ahead of that source. No source content is read
to calculate this position. Source ETAs aggregate only active profiles for the
current model key, dimensions, and capacity contract revision.

Historical source status keeps projection-tokenizer estimates and
adapter-measured completion tokens as separate quantities. It persists the
remaining estimated token cost and exposes a profile-derived lower/upper ETA
range; it never subtracts Qwen-measured tokens from another tokenizer's
estimate.

Calibration, status, readiness, and metrics requests are separate operations.
No HTTP status or scrape request may start calibration or embedding work.

## Consequences

- Operators can compare Memory Event arrival with definitive embedding service
  throughput and backlog growth.
- Local, private-VPS, Team Self-Hosted, and managed pools use the same capacity
  vocabulary while retaining different deployment and authorization policies.
- Historical-import UX can distinguish raw ingestion, Projection, partial
  semantic coverage, full embedding readiness, and LCM completion.
- The database gains small operational aggregate and capacity-profile tables,
  plus input-token metadata on embedding rows.
- Monitoring remains useful across process restarts without storing Memory in
  metrics or queue payloads.
- A private metrics collector or ingress must be configured for automated
  monitoring; public readiness alone is intentionally insufficient.

## Non-Goals

- Multi-tenant fair scheduling or dynamic priority policy.
- Dynamic GPU provisioning or autoscaling. Local verified accelerator selection
  is defined by ADR 0031.
- Reranker capacity management.
- User-facing dashboard design.
- Running a benchmark inside health, readiness, status, or metrics handling.
