# Hosted Tenant Isolation Checklist

Status: launch checklist for hosted V1.0.

This checklist records the minimum tenant-isolation and customer-memory
security posture required before Koed hosted Team is launched. It should be
read with [0004 Team Memory Uses User-Owned Share Grants And Workspaces](adr/0004-team-memory-workspaces.md),
[Security](security.md), and
[Database Row-Boundary Safeguards](database-row-boundary-safeguards.md). Hosted
support/admin access is defined in
[Hosted Support And Admin Access Policy](hosted-support-admin-policy.md).

## Isolation Model

Hosted Team must preserve the flat memory model. Memory remains owned by the
originating User. Team visibility is grant-based.

- Team is the collaboration boundary.
- Workspace is the stable shared memory identity inside a Team.
- Project is local AI-client or code context and must not become the durable
  authorization key.
- Workspace Access decides whether a User can recall, share into, or manage a
  Workspace.
- Share Grants decide which user-owned memory sources are visible to one Team
  and one Workspace.
- API Tokens remain personal-memory credentials. Team Workspace recall and
  graph access require a session identity whose Team Membership and Workspace
  Access are resolved at request time.
- Access Suspension, Workspace archive, Share Grant revocation, personal
  deletion, retention hold, and hard purge are separate lifecycle gates.
- Support and admin tooling must not bypass these boundaries unless the action
  is explicitly scoped, audited, and designed for a support or legal workflow.

## Non-Negotiable Invariants

1. Team Workspace reads fail closed when the requester has no enabled Team
   Membership or no enabled Workspace Access.
2. Team Workspace reads must filter candidates before semantic ranking,
   lexical matching, graph expansion, reranking, and Evidence Bundle assembly.
3. Team-visible derived memory may include only source rows authorized for the
   requested Team and Workspace. A private summary, graph edge, embedding, or
   rollup must not become Team-visible by relabeling.
4. API-token routes remain personal unless the endpoint has an explicit hosted
   Team session contract.
5. Membership, Workspace Access, Share Grants, billing gates, and lifecycle
   states are resolved at request time. Stored credentials must not cache Team
   authority.
6. Workers, embedding services, rerankers, diagnostics, and observability
   pipelines must receive only data that has already passed the caller's access
   boundary or must operate as internal trusted services with private
   networking and no public endpoints.
7. Logs, audit metadata, diagnostics, traces, and error responses must not
   include API Tokens, session cookies, database credentials, raw Memory text,
   source payloads, embeddings, or customer files.
8. Customer memory databases, exports, and backups are sensitive memory
   material. Hosted deployments must use private networking, encrypted storage,
   encrypted backups, least-privilege operational access, and documented
   restore controls.
9. Support access to customer memory must be opt-in or break-glass scoped,
   manager-approved where appropriate, and always auditable.
10. Billing or subscription failure may block ingestion, recall, sharing, or
    management, but it must not hard-delete customer memory.

## Implementation Checklist

| Area                                    | Required boundary                                                                                                                          | Current coverage                                                                                                                                                                                    | Launch status                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Team Workspace authorization            | Requester must have enabled Team Membership and enabled Workspace Access for the requested Workspace.                                      | `packages/core/src/team-workspace-authorization.ts`; `packages/db/src/team-access-repository.ts`; `packages/core/src/team-workspace-authorization.test.ts`; `packages/db/tests/repository.test.ts`. | Covered with automated tests.                                                                                                                          |
| API-token Team access                   | API Tokens must not unlock Team Workspace recall or graph reads.                                                                           | `apps/api/src/memory/recall-routes.ts`; `apps/api/src/memory/graph-routes.ts`; `apps/api/src/server.test.ts`.                                                                                       | Covered with automated tests.                                                                                                                          |
| Share Grant read boundary               | Team reads must use active Share Grants for the same Team and Workspace. Revoked grants and other Workspaces must be excluded.             | `packages/db/src/repository.ts`; `packages/db/src/schema.ts`; `packages/db/tests/repository.test.ts`.                                                                                               | Covered for repository read paths with automated tests.                                                                                                |
| Share Grant lifecycle                   | Share creation, listing, revocation, retained-share recall, and audit must be implemented through constrained API/repository workflows.    | `packages/db/src/team-access-repository.ts`; Team Workspace API routes; `apps/api/src/server.test.ts`; `packages/db/tests/repository.test.ts`; Team audit events.                                   | Covered with automated tests for the V1 Captured Session source boundary.                                                                              |
| Derived memory boundary                 | Team-visible Memory Nodes and source expansion must not mix private sources with shared sources.                                           | `packages/core/src/team-source-boundary.ts`; `packages/core/src/team-source-boundary.test.ts`; repository graph/search tests.                                                                       | Covered with automated tests.                                                                                                                          |
| Team lifecycle and audit                | Team, invite, membership, Workspace, access, and token lifecycle changes must be auditable without raw memory or secrets in metadata.      | `packages/db/src/team-access-repository.ts`; `packages/db/src/audit-repository.ts`; `apps/api/src/server.test.ts`; `packages/db/tests/repository.test.ts`.                                          | Covered with automated tests.                                                                                                                          |
| Personal deletion and member exit       | Removing personal or membership access must not destroy retained Team-shared memory.                                                       | `packages/db/tests/repository.test.ts`; KOE-223.                                                                                                                                                    | Covered with automated tests.                                                                                                                          |
| Workspace archive and access suspension | Archived or suspended resources must leave normal active flows while retaining data for restore, retention, and explicit authorized modes. | Domain model in ADR 0004; database lifecycle fields from Team foundation work; entitlement and billing-seat gates in core/repository/API tests.                                                     | Access suspension and billing-seat gates are covered. Archive/cold-storage product semantics remain explicit policy work when those modes are exposed. |
| Support/admin access                    | Support tooling must not expose raw memory or secrets by default; privileged access must be constrained and audited.                       | [Hosted Support And Admin Access Policy](hosted-support-admin-policy.md); redacted Team support overview route; `apps/api/src/server.test.ts`; `packages/db/tests/repository.test.ts`.              | V1 redacted overview is covered. Raw-content break-glass remains unavailable until a separate privileged workflow exists.                              |
| Runtime database privileges             | Runtime services should not use schema-owner privileges in hosted production.                                                              | `docs/database-row-boundary-safeguards.md`; `docs/hosted-database-roles.md`; `scripts/hosted-db-roles.mjs`; role-plan tests.                                                                        | Role-plan tooling is covered. The actual hosted database must apply and smoke-test runtime/worker/maintenance roles before launch.                     |
| Row Level Security                      | Database-level row isolation can reduce blast radius of accidental broad SQL.                                                              | `docs/database-row-boundary-safeguards.md`.                                                                                                                                                         | Post-V1.0 hardening spike unless customer or compliance requirements make it mandatory earlier.                                                        |
| Logging and diagnostics                 | Logs and diagnostics must redact secrets and raw memory.                                                                                   | `apps/api/src/server/logging.test.ts`; `apps/worker/src/logging.test.ts`; `packages/mcp-server/tests/logger.test.ts`; `/ops/status` redaction tests; `docs/observability.md`; `docs/security.md`.   | Covered for in-repo logging and ops-status surfaces. Deployment log pipeline proof remains part of launch validation.                                  |
| Backups, exports, and key rotation      | Database exports, backups, and encrypted-field key rotation must be treated as sensitive memory material.                                  | `docs/security.md`; `docs/hosted-backups.md`; `scripts/hosted-backup.mjs`; `scripts/hosted-encryption-rewrap.mjs`; encrypted export/package helpers; backup/status tests.                           | Tooling is covered. A clean-environment restore smoke and KMS rewrap smoke on the intended hosted target remain required before launch.                |

## High-Risk Access Paths

These paths need either automated regression tests or an explicit ticket before
hosted V1.0 goes live:

- Team Workspace recall, answer, graph node, graph event, graph thread, and
  expansion routes.
- Any endpoint that accepts `team_workspace_id` or `teamWorkspaceId`.
- Share Grant creation, revocation, and retained-share recall.
- Team invite, membership disablement, Workspace Access changes, and role
  changes.
- Billing or seat lifecycle gates that can disable ingestion, recall, sharing,
  or management.
- Support/admin customer lookup, diagnostics, export, repair, and break-glass
  actions.
- Background worker jobs that project, summarize, embed, rerank, or index
  customer memory.
- Observability, logging, traces, and error reporting.
- Backups, restores, migrations, database exports, and local support bundles.

Current automated coverage exists for Team Workspace recall/search/answer,
graph node/event/thread, expansion, deprecated browser-route Team-scope
rejection, repository Share Grant read predicates, derived memory source
boundaries, Share Grant lifecycle, Team membership / Workspace Access audit
boundaries, billing-seat access suspension, redacted support overview,
ops-status redaction, encrypted backup/package helpers, and hosted activation
analytics privacy boundaries. Deployment proof is still required for the
actual hosted target: WorkOS/AuthKit, billing provider behavior, backup
schedule/restore smoke, private networking, operational alert routing, and log
pipeline redaction.

## Support And Admin Access Policy

Hosted V1.0 should ship with the conservative support posture defined in
[Hosted Support And Admin Access Policy](hosted-support-admin-policy.md).
Summary:

- Default support views show operational state, identifiers, counts, timestamps,
  sync states, job states, plan states, and redacted error summaries.
- Raw Memory text, source payloads, Evidence Bundles, embeddings, uploaded
  files, and database exports are hidden by default.
- Any support action that can reveal, export, replay, repair, or mutate customer
  memory requires an explicit privileged workflow.
- Privileged workflows must record actor, reason, target Team, target
  Workspace, target User when applicable, action type, timestamp, and result.
- Audit metadata must not include raw Memory text, API Tokens, session cookies,
  invite tokens, passwords, database URLs, provider keys, or uploaded customer
  files.
- Support tooling must respect Access Suspension and retention policy. A
  suspended Team is not a license for broad support visibility.

KOE-199 is the implementation tracker for hosted admin and support operations.
It is a launch blocker only for support/admin tooling, but the constraints above
apply before any such tooling is exposed.

## Hosted Launch Gate

Before hosted V1.0 goes live, confirm:

- [ ] All Team Workspace recall and graph routes require session identity for
      Team scopes.
- [ ] API Tokens remain personal-memory credentials.
- [ ] Team candidate selection uses Team Membership, Workspace Access, and
      active Share Grants before retrieval ranking or expansion.
- [ ] Derived memory admits only authorized source rows for the requested Team
      and Workspace.
- [ ] Team lifecycle, Share Grant, and access-management actions write redacted
      audit events.
- [ ] Billing and seat lifecycle behavior is implemented and the chosen billing
      provider/stub has been validated against paid, grace, over-limit, and
      blocked states.
- [ ] Support/admin tooling is limited to the redacted overview, or any richer
      support workflow has explicit scope, approval, expiry, encryption, and
      audit controls.
- [ ] Hosted Postgres, Redis, embedding service, worker, diagnostics, and
      observability endpoints are private to the hosted network.
- [ ] Database storage, backups, and restore paths are encrypted and operator
      access is restricted.
- [ ] Any remaining blocker has a Linear issue linked from this checklist or
      KOE-197 before launch approval.

## Current Verdict

The repository has a solid application-level tenant boundary for the Team
Workspace foundation: Team-scoped API routes use session identity, repository
queries filter on active grants, and core helpers fail closed for missing or
mismatched access. The remaining hosted-launch risk is mostly deployment proof:
WorkOS/AuthKit configuration, billing-provider behavior, backup/restore
execution, operational alerting, private networking, and production database
hardening must be validated against the actual hosted target rather than
assumed from local tests.
