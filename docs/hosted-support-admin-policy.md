# Hosted Support And Admin Access Policy

This policy defines Koed-managed cloud support/admin access for hosted Team
deployments. It does not grant access by itself. Implementation must continue to
use request-time Koed authorization, Team Membership, Workspace Access, Share
Grants, lifecycle gates, and entitlement gates before any Memory-bearing data is
read or decrypted.

Self-hosted and Team self-hosted deployments are Operator-managed. Koed may
provide diagnostics and runbooks, but Koed-managed support identities do not
receive direct access to those deployments unless the Operator explicitly
creates and controls that access outside Koed-managed cloud.

## Support Identities

Supported hosted support/admin identities are:

- **Support operator session**: a human Koed support or operations user
  authenticated through the hosted identity provider. This identity may view
  redacted operational state only by default.
- **Support service identity**: a narrow internal service identity used for
  scheduled checks, redacted status aggregation, backup verification, alerting,
  or migration/repair workflows. It must not call normal user recall APIs.
- **Break-glass identity**: a time-bound privileged support workflow for
  exceptional incidents. It must be separately approved, customer-visible in
  audit, scoped to a Team/Workspace/User/resource, and disabled by default.

API Tokens, device credentials, MCP Server credentials, WorkOS API keys,
database credentials, and embedding service tokens are not support identities.

## Default Support View

The default support view may expose:

- Team, User, Workspace, and deployment identifiers.
- Entitlement status, plan state, lifecycle state, and seat counts.
- Device enrollment status, upstream capability status, and credential
  existence/status without secret values.
- Queue counts, job status summaries, failure categories, latency summaries,
  backup freshness, restore verification status, and migration readiness.
- Redacted error codes and bounded operational metadata.

The dedicated hosted support view is
`GET /ops/support/teams/{teamId}/overview`. It requires a browser session whose
email is listed in `KOED_OPS_OPERATOR_EMAILS` for hosted/private deployments.
It returns only redacted Team identifiers, entitlement/billing state, counts,
setup/integration health aggregates, and timestamps, and records a Team audit
event with the `hosted_operator_redacted` policy for every successful view. It
also returns support-safe diagnostic surface paths, including `/ops/status` for
global runtime, queue, backup, and readiness state. The hosted support overview
does not duplicate global operational state into Team rows.

The customer-visible Team-manager view remains
`GET /v1/teams/{teamId}/support/overview`. It is intentionally limited to
browser-session Team owners/admins, returns the same redacted operational shape,
and records the `team_manager_redacted` policy. Team-manager access does not
grant Koed hosted-operator privileges, and hosted-operator access does not
grant Team management privileges.

The default support view must not expose raw Memory, prompts, query text,
transcripts, source payloads, request bodies, Evidence Bundles, citations,
rerank documents, embeddings, vectors, files, cookies, API Tokens, invite
tokens, device secrets, provider keys, database URLs, object-storage
credentials, WorkOS secrets, or reusable service credentials.

## Forbidden Default Paths

Support/admin tooling must not use normal user recall, graph, answer,
expansion, rerank, LCM, or Evidence Bundle routes to inspect customer content.
Those routes remain user-facing product routes and must continue to enforce the
requesting User's Team Membership, Workspace Access, Share Grants, lifecycle
gates, and entitlement gates.

Support/admin tooling also must not:

- impersonate a User silently;
- use API Tokens as Team-scoped support credentials;
- run broad SQL queries that bypass repository predicates for product support;
- decrypt Memory-bearing fields before a support policy gate passes;
- include decrypted Memory in logs, traces, queue payloads, metrics,
  diagnostics, status endpoints, audit metadata, or support bundle metadata.

## Break-Glass Requirements

Break-glass access is disabled unless all of these controls exist:

- A named support operator session authenticated through the hosted identity
  provider.
- A reason code and human-readable reason.
- A scoped target: Team is required; Workspace, User, session, Memory Event,
  Memory Node, export, or backup target must be supplied when applicable.
- Approval by an authorized Koed manager or a customer-approved policy rule.
- A short expiry, with a maximum of 60 minutes for raw Memory access.
- Customer-visible audit rows containing actor, approver, reason, scope,
  started-at, expires-at, ended-at, result, and whether raw Memory access was
  permitted.
- A separate redaction boundary so retrieved content is never copied into
  ordinary logs, traces, diagnostics, or audit metadata.
- A revocation path that immediately stops future reads and invalidates any
  support session lease.

Break-glass audit metadata may include identifiers, statuses, timestamps, reason
codes, approval ids, and result codes. It must not include raw Memory, prompts,
query text, transcripts, source payloads, embeddings, files, cookies, tokens,
passwords, database URLs, provider secrets, or object-storage credentials.

## Support Bundles And Exports

Hosted redacted support bundles are available at
`POST /ops/support/teams/{teamId}/bundle` for configured hosted ops operator
sessions. This route packages the redacted hosted support overview only; it
does not include raw Memory, prompts, transcripts, source payloads, evidence,
files, embeddings, vectors, cookies, API Tokens, device secrets, provider
secrets, database URLs, or WorkOS secrets. The package must be
envelope-encrypted, scoped to the Team, expiring, and audited with the
`hosted_operator_redacted` policy. If no envelope provider is configured, bundle
creation fails closed.

Support bundles and exports that contain hosted customer raw content remain
disabled by default. When implemented, they must be customer-initiated or
break-glass-approved, envelope-encrypted, scoped, expiring, and audited.
Default support bundles may include only redacted operational metadata.

Exports or bundles that contain raw Memory, evidence, source payloads,
canonical embeddings, or customer files must use the commercial envelope
encryption policy and must not be written to ordinary logs, persistent
plaintext temporary files, or unencrypted object storage. Hosted backup restore
checks may decrypt to a temporary local file only for the duration of
`pg_restore` verification and must delete that file before returning.

Managed/encrypted deployments must package exports and support bundles through
the shared encrypted package envelope. The package manifest may include counts,
checksums, object class, key/provider metadata, timestamps, and scope, but not
raw Memory, source payloads, credentials, ciphertext DEKs, or
plaintext-equivalent vectors. If the envelope provider is unavailable, package
creation and package decrypt must fail closed with a redacted error.

## Customer Controls

Hosted Team customers must be able to inspect support/admin audit history for
their Team. Customer-visible audit should distinguish:

- redacted support diagnostics;
- automated service health checks;
- approved break-glass sessions;
- export/support-bundle creation;
- repair or mutation actions;
- failed or denied support attempts.

Future customer controls should allow disabling raw-content break-glass except
where legal, abuse, or security response requirements override the setting. Any
override must still be audited.

## Self-Hosted And Team Self-Hosted

For private VPS, open-source self-hosted, and Team self-hosted deployments,
Operators own infrastructure access. Koed support should default to runbooks,
redacted diagnostics, and customer-shared logs or bundles. Koed-managed support
operators do not receive direct backend, database, or Memory access unless the
Operator creates that access and accepts the responsibility for credentials,
network exposure, and audit.

Self-hosted support bundles should follow the same redaction and encryption
rules as hosted support bundles when they include customer data.

## Validation Gates

Before exposing support/admin tooling in Koed-managed cloud:

- Support/admin capabilities must be advertised as unavailable or partial until
  scoped support routes exist.
- Tests must prove raw Memory and reusable secrets do not appear in diagnostics,
  logs, queue payloads, audit metadata, status responses, or default support
  views.
- Tests must prove unauthorized candidates are filtered before decrypt,
  reranking, graph expansion, Evidence Bundle assembly, and support/export
  packaging.
- Break-glass tests must prove expiry, revocation, approval, customer-visible
  audit, and redaction behavior before raw-content access is enabled.
