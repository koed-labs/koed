# Observability

## Recall activity

Desktop's Recall activity page shows recorded final Personal Memory Answers from
AI Clients, including direct Local AI Runtime callers. It is not an inventory of
all MCP traffic. Desktop Ask and Team-bound questions are excluded. Retained Team
authority continues to exclude a question after its Workspace is deleted.

New final answers also retain a versioned, allowlisted metadata object alongside
the encrypted question content. It contains the Memory-found result, descriptive
calling AI Client name/version when supplied, and measured task timing when
available. No historical backfill is performed. Missing metadata stays unknown.
MCP adapters forward bounded client information; the Local AI Runtime and API
own persistence. The stdio adapter reads caller identity from the connection's
`initialize` handshake for legacy MCP clients, or from each request's envelope
for modern clients. Modern requests never inherit a prior request's identity.
Client information is self-reported description, never authority
or a stable installation identity. It may differ from the synthesis worker.
Because this metadata is stored outside encrypted question content, the caller
name and version are reduced to ASCII letters, digits, spaces and `._+/@()-`
before persistence. The API rejects other caller text.

This metadata is validated in one place when it is read: the SQL in
`recall-activity-query.ts`. Filters, totals and timelines use those expressions,
and each displayed row is built from the same expressions' output, with no
second check in application code. A question therefore cannot display one value
and count as another. The rule is:

- Only version 1 metadata is read. A later version is unknown in every field.
- Each field is then read on its own. A missing or wrongly shaped value makes
  that field unknown and leaves the others readable.
- A result is read only for an answered question.
- A caller name or version must be 1 to 128 or 1 to 64 of the characters above,
  with no leading or trailing space. An unreadable name makes the caller unknown;
  an unreadable version leaves the name.
- A duration is read only as a whole number of milliseconds up to seven days
  that equals the difference between its two UTC millisecond timestamps.

An unknown field counts as unknown in totals and matches the unknown result or
unknown caller filter; an unknown duration is outside every duration filter and
the median. Stored text can make a field unknown but cannot fail a page or an
overview. Caller text recorded before the character rule, such as `Codex: App`,
reads as an unknown caller.

Found percentage is `found / (found + not_found)`. Partial evidence, pending
summaries, unknown results and recorded errors do not enter that denominator.
An empty denominator is unavailable. Result filters and timeline breakdowns use
the persisted allowlisted value, without decrypting history. Opening an older
question can still reveal its encrypted historical result, without changing its
aggregate classification.

Duration is the server's task acceptance time (`created_at`) through fenced
completion (`completed_at`), retained before transient task cleanup. It includes
initial queueing, all retries/backoff and final persistence up to the completion
boundary. It is not client request latency or pure worker execution time. The
median is calculated over individual known durations in the selected range.
Blocking calls without those task boundaries and tasks without a final question
do not acquire inferred durations. Incoming question metadata cannot supply
timing; only the task repository stamps it. Date, result, caller and duration
filters apply before pagination and share the same scope with the overview.

The page reads existing PostgreSQL question and token records without an API
cache, rollup table, or background backfill. Counts represent distinct recorded
questions, not submissions, attempts, or a complete failure rate. Recorded errors
are not recall misses. Question dates use final record creation time; token dates
use usage observation time. Neither is request latency. The selected display
timezone determines chart buckets, with half-open query ranges.

Desktop presents a summary above independently scrolling recorded activity and
a Recall-over-time chart. The default range is seven local calendar days. Today
uses hourly server buckets (23 or 25 on daylight-saving transition days), seven
days uses daily buckets, and thirty days groups daily server totals into ten
three-day intervals. Custom ranges retain bounded day/week/month aggregation.
Chart totals cover the entire filtered range, independently of the displayed
50-row page. The question search is labelled as page-only and does not change
aggregate metrics or decrypt additional history. Known usage history and coverage
notes remain available under About these metrics.

Only explicitly linked usage contributes to list totals and charts. Most older
durable-task history has no question link and remains unknown. Opening one
authorized question may match its decrypted worker job to same-owner historical
usage. That bounded read never persists a link or changes aggregate totals, and
cannot discover earlier task retries. Unknown usage is not zero; cumulative
snapshots and replayed observations are excluded from spending totals. Cached
input and reasoning output are subsets, not additions to total tokens.

Question-change events refresh the active view in coalesced batches. Each batch
re-reads the list. The overview aggregates the whole selected range, so change
events refresh it at most once every ten seconds, followed by one catch-up read;
a manual refresh always reads it. A failed overview read stays reported until a
later overview read succeeds; a list-only refresh does not clear it. A visible fallback runs at most once a minute,
backs off after failures, and stops while hidden. Refresh checks IDs, update timestamps, and usage before decrypting only
changed question text. Desktop retains only the active page in memory, with no
disk cache. Account/backend changes and authorization loss clear retained data.

The API writes structured JSON through Fastify/Pino with
`schema_version: "api_log_v1"` and `service: "koed-api"`. Worker services use
structured Pino events. The implementation does not expose collaboration
Prometheus counters; operate the launch from `/ops/status`, `/v1/capabilities`,
durable audit rows, and exact `event.name` log queries. Do not invent or alert on
metric names that are not emitted.

Memory Answer task lifecycle logs contain task identity, state, attempt, fence,
and bounded error code only. Query, answer, evidence, caller path, and provider
payload remain encrypted content and must not be logged. Local Runtime `/ready`
reports the active task count.

A local reference measurement on an Apple M2 with 16 GB RAM and PostgreSQL 17.10
used 10,000 encrypted recalls, one million capture-usage rows, four owners,
multiple attempts, legacy gaps, and separate Desktop Ask/Team exclusions. Across
20 warm samples, the 50-row list including text decryption measured 18 ms p95;
the 90-day overview measured 52 ms p95. First reads after a PostgreSQL restart
were 33 ms and 63 ms respectively; the OS filesystem cache was not flushed.
A final warm pass with result/caller/duration metadata measured 17 ms list and
48 ms overview p95 over another 20 samples; caches were already warm in that pass.
These are local fixture results, not production latency guarantees.

The first token overview exceeded five seconds because casting question IDs to
text caused repeated full question scans. Keeping the question primary key as
UUID and validating/casting the typed source reference removed those scans.
Preserve the indexed question type in this broad join.

That four-owner fixture did not show a second cost. Without an owner/time index
on usage, the token overview scanned every owner's source references, whatever
the selected range. With 300 owners, 300,000 recalls, 1.6 million usage rows and
2.2 million source references, 7-day and 90-day overviews each took about 600 ms.
The partial index `workflow_token_usage_recall_owner_observed_idx` on
`(owner_user_id, observed_at)` for `mcp_memory_answer` usage lets the query start
from one owner's usage in the range; the same overviews then took 2 ms and 5 ms.
Keep the usage predicates on `owner_user_id`, `observed_at` and `workflow_type`
so this index stays usable. A 50-row list reads its question text in one
encrypted-payload query, not one query per row.

## Safe Request Logs

Request logs contain request ID, method, path without query values, route,
sorted query keys, optional W3C trace IDs, socket metadata, and rounded
`http.duration_ms`. Authenticated logs may contain `auth.kind` and
`actor.user_id`.

Logs and retained evidence must not contain emails, Memory or chat content,
prompts, search text, request/response bodies, cookies, API/device credentials,
token prefixes, passwords, connection strings, encryption/key material, raw
headers, remote package manifests/bytes, vectors, or raw graph payloads.
Unexpected errors retain Pino's error object for restricted debugging, but raw
traces must not be copied into public release evidence. Validation failures
record issue code/path, never rejected values.

## Implemented Signals

General API events include:

- `http.request.failed`
- `api.listen.failed`
- `job.enqueue.unavailable`
- `job.enqueue.failed`
- `graph.cache.invalidate_failed`
- `graph_stream.notification.parse_failed`
- `graph_stream.listener.failed`
- `graph_stream.listener.start_failed`
- `sync.outbox.failed`
- `sync.inbox.failed`
- `sync.service.failed`
- `worker.historical_import.admission`
- `worker.raw_projection.catchup.completed`

Historical-import events include only admission state/reason and aggregate
raw-ingested, projected, embedding-eligible, embedded, semantic-ready,
LCM-complete, pending, scanned, and byte counters. Source status also exposes
registration frontier plus independent historical/live cursor offsets and
bounded prefix sentinel hashes, never transcript records. `/ops/status` reports matching
`historicalImport` counters with `diagnosticOnly: true`. Historical backlog,
missing historical telemetry, or a paused historical batch must not change
`/ready` or readiness state.

Transcript Watcher writes a local aggregate status snapshot under
`KOED_HOME/status` containing lifecycle state and timestamps plus scan, file,
source, batch, record, and advanced-byte counters and one sanitized error code.
`koed status --json` and `doctor --json` separately report only whether
the watcher is enabled and whether its supervised process is recorded/running.
Watcher status is diagnostic-only: disabled, missing, stale, or failed watcher
status never changes API `/ready`, overall readiness, or doctor success. Hook
wake and matched boundary files contain only a version and timestamp under
hashed routing identities. They are not evidence of ingestion success.

Logs, status, metrics, wake hints, and support output must not include transcript
content, Memory content, raw payloads, transcript or local source paths, API
Tokens, credential values, Memory Question text, or request payloads. Watcher
failures log only bounded error codes; path and record details remain local data,
not operational telemetry.

Implemented Team Worker events are:

- `sync.outbox.failed`, `sync.inbox.failed`, `sync.service.failed`
- `collaboration.replay_history.pruned`
- `collaboration.replay_history.prune_failed`
- `retention.purge.attempt_started`
- `retention.purge.completed`
- `retention.purge.awaiting_completion`
- `retention.purge.retry_scheduled`
- `retention.purge.terminal_failure`
- `retention.purge.loop_failed`

PDS relay capability liveness requires both configured Authority signer and a
successful relay repository status query. `/ops/status` reports implemented,
bounded-cardinality relay metrics: uploading/committed/expired transport counts,
active ciphertext-byte total, pending-recipient count, oldest pending ACK lag,
group quota usage/limit, and uploading/expired retry classes. It does not report
per-origin cursor state. Audit stores transition kind, opaque group/head, actor
key id, outcome, and timestamp. Relay logs/metrics/audit exclude Memory, raw
source IDs, fingerprints, Project aliases, keys, recovery-kit data, signatures,
nonces, ciphertext, credentials, browser identity, and signed record bodies.
PDS request logs use relay route templates/category only; they omit concrete
route IDs and query keys. Local materialization status reports only bounded
outbox/inbox/replica state counts and secure-worker heartbeat readiness. It does
not expose per-origin high-water marks, source fingerprints, package IDs,
closure hashes, paths, retained ciphertext, keys, or source content. Conflict
quarantine is a redacted state, never an automatic winner selection. Lifecycle metrics add only tombstone ledger count, pending snapshot ACK count, oldest tombstone ACK lag, deletion-floor count, restore rollback rejections, and conflict-resolution state counts. They never expose floor tokens, logical IDs, candidate hashes, package IDs, source fingerprints, or signed records. See [Personal Device Sync Protocol V1](personal-device-sync-protocol.md).

Cross-Identity Sync failure logs expose only queue side, bounded attempt, and
redacted error class. Replay-prune logs expose deleted counts or error class.
Retention logs expose content-free purge job/attempt IDs, artifact kind/count,
reason, and error class.

`GET /ops/status` requires an Operator session. Its `crossIdentitySync`
component is `degraded` when any outbox, inbox, or relationship failed count is
nonzero and `error` when status cannot be read. Details include the implemented
queue depth/age, retry and relationship-state counts, recent byte/record
throughput, source/target record lag, and worker heartbeat state. The endpoint
also reports API, database/migrations/pgvector, Redis, embedding, queue, backup,
and other configured component status. `GET /v1/capabilities` exposes
`teamCollaborationEnabled` and availability for Team Workspaces, collaboration,
Share Grants, Cross-Identity Sync, and enrollment.

Durable `audit_events` are the source for authorization and lifecycle history.
Current collaboration-related action names include:

`koed personal-sync status --json`, `credential status`, `key-epoch
status`, and `replica status` use same redaction boundary. They show only
policy, epoch, device lifecycle, freshness, processing, failure, conflict,
revocation, and tombstone counters. They never show secret-provider references,
private keys, recovery bytes/passwords, Team authority, API Tokens, paths,
vectors, package bytes, or plaintext.

Current durable audit action names include:

- `cross_identity_sync.relationship.created`
- `cross_identity_sync.upload.committed`
- `cross_identity_sync.processing.completed`
- `cross_identity_sync.processing.failed`
- `cross_identity_sync.transport.failed`
- `cross_identity_sync.relationship.revoked`
- `cross_identity_sync.relationship.remote_revoked`
- `cross_identity_sync.relationship.retry_requested`

Query other Team/high-risk action names by the exact action written by the
tested route; do not infer success from an HTTP request log alone.

## Post-Deploy Queries

Run these against the deployment log store using its JSON-field syntax. The
examples are logical predicates, not a claim about a specific log vendor:

```text
event.name IN (
  "sync.outbox.failed", "sync.inbox.failed", "sync.service.failed",
  "collaboration.replay_history.prune_failed",
  "retention.purge.retry_scheduled", "retention.purge.terminal_failure",
  "retention.purge.loop_failed"
)

request.path STARTS_WITH "/v1/collaboration" AND http.status_code >= 500
request.path STARTS_WITH "/v1/shared-memory" AND http.status_code >= 500
request.path STARTS_WITH "/v1/cross-identity-sync" AND http.status_code >= 500
request.path STARTS_WITH "/v1/high-risk" AND http.status_code >= 500
auth.kind = "api_token" AND request.path MATCHES_TEAM_ROUTE
```

The last query is investigative: Team requests authenticated as `api_token`
must be denied and must have no corresponding successful durable Team action.
Correlate by request ID and content-free audit identifiers. Also sample:

```bash
curl -fsS -H 'Cookie: <Operator session cookie>' https://<api>/ops/status
curl -fsS https://<api>/v1/capabilities
```

Do not paste either secret or unredacted output into evidence.

## Launch Thresholds

Manually test the post-enable path through one successful Cross-Identity Sync
cycle. Record redacted `/ops/status` samples before enable, after enable, and
after the sync cycle.

Immediately set `KOED_TEAM_COLLABORATION_ENABLED=false` on every API and Worker
and restart them when any of these occurs:

- unauthorized Team content, API Token Team success, or a successful altered,
  stale, reused, wrong-device, wrong-backend, or wrong-Team Action Grant;
- ciphertext/key/provider failure, Personal-to-Team scope leak, replay gap,
  acknowledged event loss, or revoked/disabled content exposure;
- any `retention.purge.terminal_failure`;
- `/ops/status.components.crossIdentitySync.status` is `error`, or is
  `degraded` because a failed outbox, inbox, or relationship count is nonzero;
- any migration, backup verification, or restore-smoke failure.

Keep the switch off and forward-fix when `sync.service.failed`,
`collaboration.replay_history.prune_failed`, `retention.purge.loop_failed`, or
`retention.purge.retry_scheduled` repeats in two consecutive five-minute samples,
or when queue depth/oldest age, source/target lag, or heartbeat state worsens in
two consecutive samples. These are trend triggers because the implementation
exposes status values but no universal numeric service-level threshold.

A single recovered retry is recorded but does not fail launch when the next
sample is healthy, no terminal event occurred, and the full sync cycle
completes. Any Team 5xx during the manual flow blocks signoff until explained,
fixed, and rerun. Normal traffic percentage/error-rate thresholds require an
external request-log aggregator and an established baseline; Koed does not
currently emit that metric itself.

## MCP Server and Local AI Runtime

MCP Server and Local AI Runtime logs use `schema_version: "mcp_log_v1"`.
`MEMORY_LOG_LEVEL` sets the level. Log metadata is bounded and redacts content
keys such as queries, answers, results, requests, responses and tokens. Error
objects keep only their class name, numeric status fields, allowlisted system
codes such as `ECONNREFUSED`, and one level of cause. They never include the
exception message or stack.

For local debugging, `KOED_LOG_ERROR_DETAIL=1` adds bounded error messages and
stacks. Those can contain Memory content, provider responses or credentials.
Keep the setting off by default, and do not share logs written with it.

## Embedding Service

Embedding logs use `schema_version: "embedding_service_log_v1"` and
`service: "koed-embedding-service"`. `EMBEDDING_LOG_LEVEL` maps to service-local
`LOG_LEVEL`. Info covers model lifecycle and completion/failure; debug
adds scheduler, chunk/token, batch, fallback, and score counts. Input/query
text, chunks, vectors, credentials, headers, cookies, bodies, and raw traces are
prohibited.

### Embedding Capacity Metrics

Embedding capacity follows
[ADR 0027](adr/0027-embedding-capacity-telemetry.md). `GET /ops/status` is the
redacted human-Operator snapshot. `GET /internal/metrics` is the private
OpenMetrics-compatible machine surface and is disabled unless a dedicated
monitoring bearer credential is configured. Health and readiness remain coarse
and never calculate capacity or initiate calibration.

The surface must also be excluded from the public reverse proxy. The server
Compose `public-gateway-test` profile is the deployment-boundary check: normal
routes pass while `/internal/*` returns `404`, even with the monitoring token.
Capacity profiles are scoped per equivalent worker pool and aggregate without
using pool or tenant identifiers as metric labels. Until calibration succeeds,
the Operator snapshot may show the documented 5-token/second conservative ETA,
but historical admission remains closed.

The machine surface uses low-cardinality queue, source-class, model, and outcome
labels only. It exposes Memory Event arrival, embedding completion, chunk and
measured-token counters, retry/failure counters, queue state, backlog age,
pending token cost, duration summaries, calibrated capacity, and drain-range
gauges. Tenant, Team, User, Project, Captured Session, source-row, prompt, path,
Memory text, and vector values are forbidden as metric labels or values.

The rolling Operator snapshot separates Memory Event arrivals from completed
Memory Event, Memory Node, and message embeddings. Worker-owned LCM compaction
admission is reported separately and is excluded from the generic embedding
completion rate. It does not prove AI-client-backed LCM Summary synthesis, which
belongs to the `koed-server`-supervised Local AI Runtime, or downstream Memory
Node embedding readiness. Arrival counters come from canonical Memory Event
rows, while completed work uses durable telemetry buckets. Rolling rates use complete minute buckets;
active capacity excludes worker pools whose profile heartbeat has expired.

Attach only the content-safe summary required by the structured release record
in [Collaboration Launch Validation](collaboration-launch-validation.md).
