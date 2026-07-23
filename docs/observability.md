# Observability

The API writes structured JSON logs through Fastify and Pino. API logs use
`schema_version: "api_log_v1"` with `service: "koed-api"` and the resolved
runtime environment.

## Request Logs

Request logs intentionally avoid request bodies, response bodies, full headers,
and query values. The request serializer emits:

- `request.id`: the Fastify request id. The API accepts a safe inbound
  `x-request-id` value and returns `x-request-id` on every response.
- `request.method`
- `request.path`: URL pathname without query string values.
- `request.route`: Fastify route pattern when available.
- `request.query_keys`: sorted query parameter names, never values.
- `request.trace.trace_id` and `request.trace.span_id`: parsed from a valid
  W3C `traceparent` header when present.
- `client.ip` and `client.port`: remote socket metadata when available.
- `http.duration_ms`: request duration from Fastify completion logs, rounded to
  an integer millisecond value.

## Error Logs

Unexpected server errors are logged at `error` with `err` so Pino can retain the
error type, message, stack, and cause. Expected client/domain errors are logged
at `warn` with sanitized fields. Zod validation failures include issue codes and
paths, not rejected values.

## Auth Context

After authentication succeeds, logs may include:

- `auth.kind`: `session` or `api_token`.
- `actor.user_id`: the authenticated user id.

Logs must not include emails, raw API tokens, token prefixes, session cookies,
passwords, request bodies, memory content, search query text, or raw graph
notification payloads.

## Domain Events

Operational events use namespaced `event.name` values:

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
`koed-server status --json` and `doctor --json` separately report only whether
the watcher is enabled and whether its supervised process is recorded/running.
Watcher status is diagnostic-only: disabled, missing, stale, or failed watcher
status never changes API `/ready`, overall readiness, or doctor success. Hook
wake hints contain only a timestamp and are not evidence of ingestion success.

Logs, status, metrics, wake hints, and support output must not include transcript
content, Memory content, raw payloads, transcript or local source paths, API
Tokens, credential values, Memory Question text, or request payloads. Watcher
failures log only bounded error codes; path and record details remain local data,
not operational telemetry.

Use the database `audit_events` table for durable operator/audit history such
as token lifecycle changes, login outcomes, policy changes, and destructive
memory actions. Operational logs are for debugging and monitoring.

Cross-Identity Sync logs include only the queue side, bounded attempt count,
and redacted error class. Remote response bodies, package manifests and bytes,
Memory content, relationship/customer identifiers, credentials, recipient-key
material, and provider details are not log fields. `/ops/status` reports
bounded-cardinality queue depth/age, retry count, relationship state counts,
recent byte/record throughput, and source/target record lag. Record throughput
uses the authenticated package-manifest record count rather than cursor
distance because monotonic source cursors may contain gaps between sessions.
Source lag counts unsynchronized canonical changes for each selected session;
target lag counts authenticated package records beyond the processing cursor.

Current durable audit action names:

- `api_token.created`
- `api_token.revoked`
- `capture_policy.upserted`
- `capture_policy.deleted`
- `memory.deleted`
- `memory.presentation_updated`
- `memory_event.invalidated`
- `cross_identity_sync.relationship.created`
- `cross_identity_sync.upload.committed`
- `cross_identity_sync.processing.completed`
- `cross_identity_sync.processing.failed`
- `cross_identity_sync.transport.failed`
- `cross_identity_sync.relationship.revoked`
- `cross_identity_sync.relationship.remote_revoked`
- `cross_identity_sync.relationship.retry_requested`

Audit metadata may include identifiers, target names, target type, capture
state, visibility, pause timestamps, token prefixes, actor type, and changed
field names. Audit metadata must not include token secrets, token hashes,
session cookies, passwords, memory content, search query text, or raw request
bodies.

## Embedding Service Logs

The embedding service writes structured JSON logs with
`schema_version: "embedding_service_log_v1"` and
`service: "koed-embedding-service"`. Configure verbosity with
`EMBEDDING_LOG_LEVEL` in the root environment, which maps to service-local
`LOG_LEVEL`.

`info` logs cover model load lifecycle, embed/rerank completion, failures, and
reranker lazy-load lifecycle. `debug` logs add scheduler snapshots, chunk counts,
token counts, embedding batch sizes, fallback-to-single-chunk embedding, and
reranker score counts.

Embedding logs must not include input text, query text, document text, chunks,
vectors, API tokens, full headers, cookies, request bodies, or raw exception
traces.
