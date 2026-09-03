# Standalone koed-server Package Boundary

Status: Accepted.

Related decisions:

- [0005 Native Bundled-Local Runtime Asset Provisioning Boundary](./0005-bundled-local-runtime-asset-provisioning.md)
- [0006 macOS Homebrew-First Runtime Provisioning](./0006-macos-homebrew-first-runtime-provisioning.md)
- [0007 Desktop Control Plane Consumes koed-server](./0007-desktop-control-plane-consumes-koed-server.md)

## Context

The current packaged Desktop app bundles the Electron control plane,
`koed-server`, JS/service artifacts, and optionally native runtime artifacts into
one app bundle. That made the internal unsigned app large and couples Desktop
updates to local server runtime updates.

Koed already has a durable local control-plane boundary: Desktop consumes
`koed-server` contracts, and `koed-server` owns service lifecycle, setup,
status, doctor, native runtime install, model install, and AI-client integration
setup. The next packaging question is whether Desktop should continue to embed
all server runtime files, or whether a standalone `koed-server` package should
be installable and updatable independently.

Python runtime assets have been removed from the packaged native runtime and the
Embedding Service development path. This decision assumes the supported local
Embedding Service runtime is the TypeScript service plus `llama-server`.

This ADR does not decide browser auth, device enrollment, local-edge
upstream credential semantics, commercial encryption/key management, or managed
SaaS queryable vector strategy. Those are separate Team SaaS foundation
decisions; the standalone package design consumes them only as package/runtime
requirements.

## Decision

Koed should introduce a standalone `koed-server` app-runtime package and move
Desktop toward a thin-control-plane model that installs or updates that package
on demand.

- Desktop remains the Operator-facing control surface.
- `koed-server` remains the source of truth for local service lifecycle,
  setup, status, doctor, runtime install, model install, migrations, and
  AI-client integration setup.
- The standalone `koed-server` package contains JS/service runtime files:
  API, Worker, TypeScript Embedding Service, MCP Server, Supported Capture Hook,
  DB package artifacts, migrations, and runtime package
  dependencies.
- Native runtime artifacts remain a separate artifact line for
  Postgres/pgvector and `llama-server`.
- Model artifacts remain separate and are installed under `KOED_HOME/models`.
- The active standalone package should install under `KOED_HOME`, with cached
  archives and previous versions also under `KOED_HOME` unless the Operator
  explicitly selects another app-runtime directory.
- Desktop should initially keep a bundled fallback `koed-server` package or
  equivalent embedded runtime until the standalone install/update path is proven
  by CI and smoke tests.
- The first standalone package install requires an explicit bootstrap entrypoint:
  Desktop's bundled fallback, a previous compatible `koed-server` install, a
  future signed/notarized minimal installer or package-manager entrypoint, or a
  source-checkout launcher for development only. The package being installed must
  not be treated as its own trusted installer.
- External dependency mode remains Operator-owned. Installing a standalone
  `koed-server` package must not imply bundled-local native runtime ownership
  unless the selected runtime/dependency mode or setup profile says so.
- Backend LLM synthesis remains out of scope.

## Consequences

Desktop can become smaller and update independently from the local server
runtime. Operators can also install or update `koed-server` headlessly without
installing Desktop.

The split adds a new compatibility boundary. Koed must validate Desktop version,
server package version, DB migration set, native runtime manifest schema,
`KOED_HOME` state, and model metadata before declaring the local stack healthy.
Downgrades must be blocked unless explicitly confirmed and DB-compatible. The
bootstrap entrypoint must also be validated: hosted downloads can start with
SHA-256 verification, but trusted default update channels need stronger
signature or provenance checks before release hardening is complete.

Package installation becomes a first-class `koed-server` capability rather than
Desktop-only logic. Desktop may provide progress UI, but the underlying package
status/install/activate/cleanup operations should also be available to headless
Operators and smoke tests.

Keeping native runtime artifacts separate avoids coupling large database and
`llama-server` assets to each server package update. It also preserves the
Homebrew-backed path and future Koed-hosted native tarball path behind the same
`koed-server runtime status/install` contract.

See [Standalone koed-server package design](../standalone-koed-server-package.md)
for the detailed package layout, install flow, verification model, and
follow-up implementation plan.
