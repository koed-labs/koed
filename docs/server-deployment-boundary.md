# Server Deployment Boundary

Koed's server deployment unit is `koed-server` plus its dependencies. API,
Worker, Explorer, queue processing, and operational checks are implementation
surfaces inside that server boundary; Operators should not need to reason about
them as separate product deployments unless they are debugging or scaling an
internal process.

## Product Shape

A server or private VPS deployment should run:

- `koed-server` as the application/control-plane process.
- Postgres with pgvector as the memory database.
- A work queue backend: the Postgres-backed local queue for simple deployments,
  or Redis/BullMQ when the Operator intentionally chooses that queue backend.
- The Embedding Service backed by `llama-server`.
- A reverse proxy that terminates TLS and exposes only the intended
  browser/API surface.
- Backup and restore verification jobs for Postgres.
- Separate Postgres migration/runtime roles for hosted or private VPS
  deployments.
- Optional object storage when future sync, import, or Memory Inbox payloads
  need durable blob storage.

`koed-server` owns the application boundary: migrations, readiness, route
registration, configuration validation, health/status reporting, supervised app
processes, and local setup commands. Dependencies may be native services,
managed infrastructure, systemd units, containers, or Docker Compose examples,
but they remain dependencies of the server deployment.

## Deployment Modes

Local Desktop native setup is the local personal path. Koed Desktop starts and
monitors its managed local `koed-server`, and bundled-local mode may run native
Postgres and Embedding Service resources under `KOED_HOME`. This path should
not require Docker.

Source-checkout development can use Docker Compose as a convenience starter for
external dependencies. In this mode, Compose may start Postgres, Redis, and the
Embedding Service while `koed-server` connects to those endpoints. Compose is a
developer and Operator helper, not the long-term product architecture.

Private VPS and Team Self-Hosted deployments should be documented and operated
as `koed-server` plus dependencies. The Operator may still choose containers,
but the product contract is the server boundary, its public routes, its
capabilities, and its dependency readiness.

Koed-managed cloud should use the same server boundary with Koed-operated
infrastructure. Cloud-only choices such as WorkOS/AuthKit, entitlement gates,
support access, and managed backups attach to the same `koed-server` API and
authorization model.

## Internal Process Names

Older docs and scripts may mention API, Worker, Explorer, or Compose stacks.
Use this mapping when reading or updating them:

- API means the internal HTTP app served by `koed-server`.
- Worker means the internal background processor used by `koed-server`.
- Explorer means the browser UI served beside or inside the server boundary.
- Docker Compose means one possible dependency starter for source checkouts or
  an Operator-chosen container layout.

Keep those names where they identify code paths, logs, packages, process-local
environment variables, or troubleshooting steps. Avoid presenting them as the
top-level product architecture for server/private VPS deployments.

## Health And Readiness

Infrastructure should use `/ready` as the coarse readiness gate. Operators
should use `koed-server status --json`, `koed-server doctor --json`,
`/v1/capabilities`, authenticated diagnostics, and `/ops/status` for richer
status and remediation.

Reverse proxies and load balancers should route only the intended
browser/API-facing surface. Postgres, Redis, and the Embedding Service should
stay private to the deployment network.

## Migration Notes

If a previous setup was described as "API plus Worker plus Compose", translate
it to "`koed-server` plus dependencies":

- Run or package `koed-server` as the application service.
- Provide Postgres/pgvector, queue backend, and Embedding Service endpoints.
- Configure reverse proxy/TLS in front of `koed-server`.
- Run backup/restore jobs against Postgres.
- Keep Compose files as examples or local dependency starters unless the
  Operator explicitly chooses containers for their own server deployment.

Do not infer long-term product behavior from the current Compose example. It is
allowed to exist because it is useful, but it is not the product boundary.

## Related Planning

This document is the repo-side deployment-boundary reference for server,
Desktop, and hosted deployment work. Keep it aligned with the route contract,
auth/device boundary, bundled-local runtime, and encryption posture docs as
those public references evolve.
