# Proposed macOS Homebrew-First Runtime Provisioning

Status: Proposed for KOE-243.

Depends on: [0005 Proposed Native Bundled-Local Runtime Asset Provisioning Boundary](./0005-bundled-local-runtime-asset-provisioning.md).

## Context

If Koed accepts native bundled-local as the local personal runtime boundary, it
still needs an initial way to provision native assets on macOS. A fully
self-contained distribution would require Koed to build, package, sign,
notarize, host, verify, and test native Postgres/pgvector and `llama-server`
artifacts across architectures. Packaged Desktop resources have a similar
signing, size, and testing burden. Those are desirable future directions, but
they are larger than the immediate need to make local personal Koed setup
reliable on macOS.

The KOE-243 feature-branch work has already shown that native bundled-local can
work on a macOS machine when assets are supplied by Homebrew and manual links:
`postgresql@17`, `pgvector`, `llama.cpp`, an Embedding Service Python runtime,
and an embedding model. Homebrew can therefore serve as the first native asset
source while Koed builds the durable runtime status/install boundary proposed in
ADR-0005.

This ADR is intentionally transitional. It proposes a macOS-first implementation
path, not the final cross-platform packaging answer. During this phase, a clean
single-command local launch is only possible when Homebrew is available and the
required native dependencies are already installed or can be installed by the
first-run setup flow. The first macOS implementation satisfies the
no-Docker/no-external-Postgres/no-external-Redis invariant with Homebrew
available as the native asset source; fully clean non-Homebrew machines require
a later packaged-resource, verified-tarball, or other accepted runtime
distribution path. A later packaging path should remove the Homebrew
requirement.

## Decision

This ADR proposes that Koed use a macOS Homebrew-first runtime provisioning path
as the initial implementation for native bundled-local assets.

- macOS should be the first supported native bundled-local provisioning target.
- Homebrew should be the initial source for native runtime dependencies. The
  first-run setup flow may detect already-installed Homebrew packages or, when
  allowed by the selected bundled-local setup path, invoke Homebrew to install
  missing packages. It should not attempt to bootstrap Homebrew itself.
  Invoking Homebrew mutates package-manager state outside `KOED_HOME`, so it
  must be visible and actionable: Desktop should show progress and require clear
  Operator consent before invoking Homebrew, and headless flows should require
  an explicit setup/install command or flag. Passive `status` and `doctor`
  checks must never install Homebrew packages. Required Homebrew-provided
  dependencies include:
  - `postgresql@17` for `initdb`, `pg_ctl`, `psql`, and compatible Postgres
    runtime files.
  - `pgvector` for the Postgres `vector` extension used by Koed memory storage
    and retrieval.
  - `llama.cpp` for `llama-server`, used by the native Embedding Service.
- The Embedding Service Python runtime and dependencies should be provisioned
  through the same `koed-server` runtime status/install contract. Whether the
  first implementation uses a Koed package resource, a Koed-managed runtime
  environment under `KOED_HOME`, or Homebrew-managed Python dependencies is an
  implementation detail as long as status and repair guidance are consistent.
- This ADR does not require creating Homebrew formulas as part of KOE-217 or
  KOE-243. The immediate implementation may treat Homebrew as a detected or
  invoked asset source for native dependencies on machines where Homebrew is
  already available.
- Future macOS distribution may distinguish the Desktop control plane from the
  headless server package:
  - `koed` is the Electron control plane package. It depends on `koed-server`,
    starts a managed `koed-server`, and defaults that managed server to
    bundled-local mode for local personal use.
  - `koed-server` is the headless control-plane package. It can default to
    bundled-local for fresh local-personal installs, but external or
    server/operator-managed installs must remain explicit.
- Native runtime dependencies should be opt-in through selected mode and package
  choice, not by merely installing a minimal headless `koed-server` package for
  an external-mode deployment. Future formula or package split names are
  implementation details.
- First startup may be a one-shot local setup when the selected mode is
  bundled-local. Desktop can start its managed `koed-server` with bundled-local
  configuration and let the control plane provision Homebrew-backed runtime
  assets and model files before reporting healthy. A fresh local-personal
  headless startup can do the same by default; external-mode startup must not.
- External dependency mode must not install Homebrew runtime dependencies. In
  that mode, `koed-server` should only validate configured Operator-managed
  service endpoints and report repair guidance.
- Homebrew is an asset source, not the owner of Koed's bundled-local runtime
  state. `KOED_HOME` should remain the source of Koed-owned configuration,
  selected runtime paths, resolved dependency versions, supervision state, logs,
  model files, status, and repair guidance.
- The Homebrew-backed runtime installer should detect dependency prefixes,
  validate required binaries, and link, copy, or record them under
  `$KOED_HOME/runtime` so later startup uses stable Koed-owned path resolution.
  It should persist the resolved paths and versions for Homebrew-provided
  dependencies such as Postgres, pgvector, and `llama-server`.
- `koed-server` startup, `status`, and `doctor` should revalidate those
  recorded Homebrew-backed paths and versions for compatibility drift. If a
  later `brew upgrade` changes Postgres, pgvector, or `llama-server` behavior
  underneath Koed, Koed should report clear repair guidance instead of silently
  assuming the previously provisioned runtime is still compatible.
- The installer should validate that bundled-local Postgres can enable pgvector,
  ultimately through `CREATE EXTENSION IF NOT EXISTS vector` against the Koed
  database during startup or an equivalent preflight.
- The installer should preserve advanced overrides such as
  `KOED_POSTGRES_BIN_DIR`, `KOED_POSTGRES_*_BIN`,
  `KOED_EMBEDDING_PYTHON_BIN`, and `KOED_EMBEDDING_LLAMA_SERVER_BIN`.
- Model files should be stored under `$KOED_HOME/models`. They may be downloaded
  during bundled-local first-run setup, but they are not side effects of
  installing the minimal `koed-server` package and must not be downloaded in
  external dependency mode.
- This Homebrew path should not replace the future option to ship packaged
  Desktop resources or Koed-hosted verified tarballs with SHA-256 verification.
- Linux, Windows, non-Homebrew macOS installs, and fully self-contained native
  runtime packaging remain future work unless separately accepted.

## Future State / Beyond Homebrew

This ADR does not decide the final native asset packaging strategy. The expected
next step after Homebrew is a Koed-owned, verified runtime bundle installed
under `KOED_HOME/runtime` through the same `koed-server` runtime status/install
contracts.

At the high-level architecture boundary, this future bundle should preserve the
same model proposed by ADR-0005:

```text
external = Operator-owned dependencies
bundled-local = Koed-owned native runtime under KOED_HOME
```

Homebrew is only the first macOS asset source for proving that boundary. A later
packaged runtime should make the asset source swappable without changing
Desktop, headless startup, status, doctor, or setup semantics.

A likely future direction is a "stitched upstream" packaging approach. Instead
of Koed becoming the long-term maintainer of a full PostgreSQL source-build
pipeline, Koed may reuse trusted upstream-maintained PostgreSQL binary
distributions for the core database engine, then build, inject, or validate the
`pgvector` extension against that distribution's `pg_config` and headers during
Koed's asset-bundling process. This keeps the heavy database-engine maintenance
burden outside Koed while making Koed's required vector extension compatibility
explicit and testable.

Current examples that inform this direction include upstream projects that
package PostgreSQL for embedded or test-runtime use, such as theseus-rs-style or
zonkyio-style precompiled PostgreSQL distributions. These examples are
references for the kind of packaging approach Koed may evaluate; this ADR does
not select one as the accepted supply-chain source.

Any future packaged runtime should preserve these requirements:

- pinned versions and platform/architecture metadata;
- manifest and SHA-256 verification before install;
- deterministic validation that bundled-local Postgres can load `pgvector`;
- relocatable runtime paths so assets can live under `KOED_HOME/runtime`;
- compatible dynamic library lookup for packaged assets;
- clear repair/status output through `koed-server`;
- no dependence on Docker Compose or external Postgres for local personal mode.

The exact build-vs-reuse strategy, upstream binary source, pgvector build or
injection process, signing/notarization process, and release pipeline should be
decided in a later ADR after prototype validation.

## Consequences

The first native bundled-local provisioning implementation can be much smaller
than a fully self-contained binary distribution. Homebrew handles native package
installation, architecture selection, and most dynamic library compatibility for
Postgres, pgvector, and llama.cpp. Koed can focus on detection, validation,
`KOED_HOME` runtime layout, status/doctor repair guidance, model installation,
and first-run orchestration.

The Desktop package can provide a near one-shot macOS local personal setup when
Homebrew is available: the user opens Koed, the Electron control plane starts
its managed `koed-server` in bundled-local mode, and the control plane and
server detect or install the Homebrew-backed native runtime dependencies and
model assets needed for that mode before Koed becomes healthy. The initial
startup may take longer, but it follows from the Desktop package's chosen local
personal default. If Homebrew is missing, the setup should fail or pause with
clear repair guidance rather than silently installing Homebrew or falling back
to external dependency mode.

A fresh local-personal headless install can also provide a near one-shot startup
when Homebrew is available, because the local-personal default may select
bundled-local mode. External or server/operator-managed headless installs keep
the dependency ownership boundary explicit: configuring external dependency mode
with service endpoints prevents local Homebrew runtime provisioning.

Future Homebrew formula or package work should preserve that boundary. If a
package named `koed-server` is intended for external-mode Operators, it should
remain minimal and avoid forcing native bundled-local dependencies. A separate
local-runtime package or Desktop package may carry or invoke the Homebrew-backed
runtime provisioning path. The important part is the opt-in boundary, not the
exact formula names.

This proposal intentionally accepts a temporary Homebrew dependency for macOS
local personal setup. Operators without Homebrew, Operators on other platforms,
and packaged Desktop distributions still need future packaging work. The
runtime status/install contract from ADR-0005 should make that future work an
implementation swap rather than a redesign. The long-term target remains a clean
local personal launch without requiring Homebrew-preinstalled native
dependencies, using packaged Desktop resources, Koed-hosted verified tarballs,
or another accepted runtime distribution mechanism.

The Homebrew-first path must not weaken security checks for Koed-hosted or
downloaded artifacts. Any non-Homebrew tarball or model download still requires
manifested SHA-256 verification before installation. Homebrew package integrity
is delegated to Homebrew for this transitional path.

If ADR-0005 is not accepted, this Homebrew proposal should be revisited because
its package split and first-run behavior depend on the proposed external-only
Compose boundary and native bundled-local ownership model.
