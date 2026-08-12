# Hosted Product Analytics

Hosted activation analytics are privacy-safe product events used to understand
where a Team gets stuck before hosted launch. They are not Memory, raw
transcripts, prompts, evidence, or support diagnostics.

## Endpoint

Browser-session clients may record activation events with:

```http
POST /v1/analytics/activation-events
```

The route requires a browser session. API Tokens, device credentials, Capture
Hooks, and MCP Server credentials must not record hosted product analytics.

Browser-session clients may read a redacted activation funnel summary with:

```http
GET /v1/analytics/activation-funnel
```

The summary accepts optional `teamId`, `teamWorkspaceId`, `since`, and `until`
query parameters. Team-scoped summaries require an enabled Team owner/admin.
Personal summaries include only the authenticated User's own activation events.

## Allowed Events

V1 activation events are:

- `signup_completed`
- `desktop_connected`
- `mcp_setup_started`
- `mcp_setup_completed`
- `capture_hook_setup_started`
- `capture_hook_setup_completed`
- `first_capture_completed`
- `first_memory_answer_completed`
- `first_recall_completed`
- `team_created`
- `workspace_created`
- `invite_sent`
- `invite_accepted`
- `session_shared`
- `paid_conversion_started`
- `paid_conversion_completed`

Allowed surfaces are `desktop`, `koed_server`, `mcp_server`,
`capture_hook`, and `api`.

## Privacy Boundary

The analytics route stores durable `analytics.activation.*` audit events behind
a strict payload boundary:

- event name is enumerated;
- surface is enumerated;
- deployment profile is optional and enumerated;
- Team and Workspace IDs are accepted only when the authenticated User has the
  matching Team or Workspace access;
- metadata uses an explicit allowlist of low-cardinality operational keys such
  as `os`, `platform`, `source`, `step`, `durationMs`, `elapsedMs`, `count`,
  `retryCount`, and `repaired`;
- metadata is flat scalar data only, limited to 20 keys, and string metadata
  values must be short token-like values rather than free-form text;
- durations must be non-negative numbers, counts must be non-negative integers,
  and boolean fields must be actual booleans.

Analytics metadata must not contain raw Memory, source text, prompts,
transcripts, answers, evidence bundles, tool output, files, database URLs,
provider secrets, API Tokens, cookies, or billing-provider secret values.

## Reporting

For initial hosted runs, analytics are stored in Postgres and summarized through
`GET /v1/analytics/activation-funnel`, so operators do not need database shell
access for the main activation funnel. Before broader hosted launch, reporting
can move to an analytics warehouse or product analytics provider as long as the
same privacy boundary remains the source of truth.

Activation funnel reporting should group by event, surface, deployment profile,
Team, Workspace where applicable, and time window. It should not group by or
export customer Memory content.

## Implementation Split

Backend/API owns:

- `POST /v1/analytics/activation-events`;
- `GET /v1/analytics/activation-funnel`;
- stable event and metadata schemas;
- authorization checks for Team and Workspace scoped events;
- privacy-safe aggregation and redaction tests.

Desktop/web owns:

- emitting `desktop_connected`, MCP setup, Capture Hook setup, first capture,
  first memory answer, invite, invite acceptance, and billing conversion events
  from the relevant user flows;
- rendering the activation funnel from the API response instead of querying
  production databases directly.

Operations owns:

- deciding whether hosted production also forwards these redacted events to a
  warehouse or product analytics provider;
- preserving the same no-raw-Memory/no-secret schema boundary if forwarding is
  introduced.
