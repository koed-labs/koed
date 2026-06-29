# Proposed Native Bundled-Local Runtime Asset Provisioning Boundary

Status: Proposed for KOE-243.

## Context

Koed Self-Hosted needs a clear dependency ownership boundary before the local
Electron control-plane work lands on `main`.

Operators can run Koed against dependencies they manage themselves:
Postgres/pgvector, Redis/BullMQ when configured, and an Embedding Service.
Docker Compose is one useful way for an Operator to provide that external stack,
but it is still Operator-managed infrastructure. In that mode, `koed-server`
should connect to configured endpoints, validate readiness, and supervise Koed
app processes. It should not start, stop, install, upgrade, or otherwise mutate
those dependencies.

KOE-243 is developing a local personal path where Koed can run without Docker
Compose, external Postgres, or external Redis. The desired product boundary is
that bundled-local mode means Koed-owned native dependencies under `KOED_HOME`:
native Postgres with pgvector, a native Embedding Service runtime, API, Worker,
Explorer, model files, logs, runtime state, and the Postgres-backed local queue.

The KOE-243 feature branch has explored Compose-managed bundled-local
scaffolds, but this ADR proposes that the merged product boundary treat Docker
Compose as external-only. Compose files may remain in the repository as examples
for Operators who choose an external stack, but they should not be code that
`koed-server` runs as part of the app lifecycle.

Runtime provisioning crosses several long-lived boundaries: CLI behavior,
Desktop first startup, headless server startup, `KOED_HOME` layout, model
downloads, native binary packaging, external dependency mode, and the accepted
AI-client synthesis boundary. A proposal in `main` gives the feature branch a
stable integration target and a place for review before the final implementation
PRs land.

## Decision

This ADR proposes that Koed define bundled-local as a native Koed-owned runtime
under `KOED_HOME`, and define Docker Compose as external-only.

- External dependency mode should remain Operator-owned. Koed should not
  install, start, stop, upgrade, or mutate Operator-managed Postgres,
  Redis/BullMQ, Embedding Service, Docker Compose stacks, Homebrew services,
  systemd services, or cloud resources in external dependency mode.
- Docker Compose should be documented as an optional external dependency
  starter. A Compose file may live under an examples area such as
  `examples/docker-compose/`, but `koed-server start` should not call
  `docker compose` as part of bundled-local startup.
- Bundled-local mode should mean native Koed-owned runtime dependencies under
  `KOED_HOME`. In bundled-local mode, `koed-server` may provision, start, stop,
  and inspect the native dependencies it owns for Koed.
- Bundled-local should default API/Worker jobs to the Postgres-backed local
  queue so Redis is not required for local personal operation. If an Operator
  chooses BullMQ, Redis remains Operator-managed external infrastructure unless
  a separate decision accepts a Koed-owned Redis runtime.
- Native runtime assets should live under stable Koed-owned locations, including
  `$KOED_HOME/runtime/`, `$KOED_HOME/cache/assets/`, and `$KOED_HOME/models/`.
  Exact subdirectories are implementation details, but runtime assets, staged
  downloads, and model files should not be stored in the source checkout as the
  primary product install location.
- Runtime path resolution should prefer explicit overrides first, then
  Koed-owned runtime assets under `KOED_HOME`, then packaged resources when
  available, with source-checkout `vendor` paths only as development fallbacks.
- Dependency mode selection should be explicit and deterministic. The intended
  precedence is:
  1. explicit process-level overrides, such as CLI flags or environment values;
  2. `KOED_HOME/config/server.json`;
  3. a package-managed Desktop default for the Desktop-managed `koed-server`;
  4. a fresh local-personal headless default;
  5. source/developer defaults.
- A fresh local-personal install may default to `runtimeMode=local-personal` and
  `dependencyMode=bundled-local` so `koed-server start` can succeed without
  Docker, external Postgres, or external Redis. This default should come from a
  distribution, profile, or setup intent such as Desktop-managed `koed-server`,
  a local-personal package profile, or an explicit local setup command. It
  should not be inferred merely from an empty config on every bare `koed-server`
  installation.
- External or server/operator-managed installs should be explicit. When external
  endpoints or external mode are configured, or when the selected distribution
  or setup profile is server/operator-managed, `koed-server` must not infer
  bundled-local ownership or provision local native dependencies.
- When bundled-local mode is selected by Desktop defaults, local-personal
  headless defaults, configuration, environment, or setup commands,
  `koed-server` may provision missing required native runtime assets during
  first startup. This supports one-shot local personal startup while preserving
  the external-mode boundary.
- The Electron control plane may start its managed `koed-server` in
  bundled-local mode by default for local personal use. Standalone headless
  `koed-server` may also default to bundled-local for a fresh local-personal
  install, but not for an install configured as external or operator-managed.
- Koed should expose machine-readable runtime, status, doctor, setup, and model
  installation contracts so Desktop, Local Operator Scripts, smoke tests, and
  headless Operators all observe the same behavior.
- Model downloads are allowed during bundled-local first-run setup because the
  Embedding Service requires a model, but they should be visible in setup/status
  progress and stored under `KOED_HOME`. They must not occur in external
  dependency mode.
- Runtime artifact installation should be idempotent. Downloaded artifacts
  should be cached, verified before install, unpacked through temporary paths
  where practical, and leave repairable state on failure.
- Hosted or downloaded runtime artifacts should be described by a manifest that
  includes platform, architecture, version, URL, SHA-256, expected files, and
  executables. Package-manager-backed provisioning may use the same
  status/install contract even when the artifact source is not a Koed-hosted
  tarball.
- Backend LLM synthesis remains out of scope. Koed stores, projects, embeds,
  retrieves, and returns Evidence Bundles. The connected AI Client performs
  Answer Synthesis and LCM Summary synthesis.

## Consequences

This proposal makes the dependency model easier to reason about:

```text
external = Operator-owned dependencies, Docker Compose allowed here
bundled-local = Koed-owned native dependencies under KOED_HOME
```

The KOE-243 implementation should remove or avoid merged behavior where
bundled-local starts Docker Compose. Any existing Compose-managed bundled-local
code in the feature branch should be treated as transitional implementation
work, not as the target product boundary.

The runtime installer becomes part of the `koed-server` control plane rather
than Desktop-only logic. Desktop, headless CLI, smoke tests, and future packaging
surfaces can consume the same runtime status and install contracts.

Bundled-local first startup can be close to one-shot for the Operator: a Desktop
package can start its managed `koed-server` in bundled-local mode and allow the
control plane to provision missing native runtime and model assets before
services become healthy. A fresh local-personal headless `koed-server` install
can get the same default behavior. External or server/operator-managed installs
remain explicit and unaffected.

`KOED_HOME` becomes the stable boundary for Koed-owned runtime state and native
assets. Source-checkout `vendor` paths remain useful for development, but they
are fallbacks rather than the primary product install location. Packaged Desktop
can later provide resources through the same path-resolution layer without
changing app startup semantics.

The manifest and verification requirement keeps a future self-contained path
open. Koed can start with a package-manager-backed implementation while
retaining a migration path to Koed-hosted verified tarballs or bundled Desktop
resources.

If this proposal is accepted, the KOE-217/KOE-243 implementation must update
`docs/service-sequence-overview.md` when service ordering and boundaries change.
This ADR-only proposal does not update the sequence overview by itself.

If this proposal is not accepted, the implementation should explicitly document
whether bundled-local Compose scaffolds remain supported, why Koed owns Docker
Compose in that mode, and how that differs from external dependency mode.
