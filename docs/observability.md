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

Use the database `audit_events` table for durable operator/audit history such
as token lifecycle changes, login outcomes, policy changes, and destructive
memory actions. Operational logs are for debugging and monitoring.

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
