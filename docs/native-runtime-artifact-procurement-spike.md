# Native Runtime Artifact Procurement Spike

Issue: KOE-287
Date: 2026-07-05
Branch: `koe-244i-linux-wsl-development`

## Recommendation

Use **Koed-owned verified native runtime tarballs assembled in CI from relocatable upstream binaries first**, with source builds only for gaps that cannot satisfy Koed's manifest, relocation, signing, and validation requirements.

Do not use raw Homebrew/Linuxbrew bottle snapshots as release artifacts. Keep Homebrew as the transitional local-development and fallback provider accepted by ADR-0006.

## Why

The release artifact must be self-contained enough for clean machines without Homebrew and must validate through the existing packaged runtime provider:

```bash
koed-server runtime status --provider packaged --json
koed-server runtime install --provider packaged --dependency-mode bundled-local --json
```

A Homebrew-staged macOS arm64 prototype was quick to assemble, but showed release-blocking relocation issues:

- `pg_config --sharedir` from staged `postgresql@17` still reports `/opt/homebrew/share/postgresql@17`.
- `initdb` and Postgres binaries link against absolute Homebrew Cellar/opt libraries such as `/opt/homebrew/opt/icu4c@78/...`.
- `llama-server` uses `@loader_path/../lib` from its Homebrew `bin/` layout; moving it to Koed's current `llama.cpp/llama-server` layout required `install_name_tool` and ad-hoc re-signing.
- after patching the local llama rpath, additional dependencies still referenced `/opt/homebrew/opt/ggml` and `/opt/homebrew/opt/openssl@3`.

Those issues can be patched, but doing so turns the Homebrew bottle path into a fragile binary-rewriting pipeline with signing and notarization consequences. Koed-owned verified runtime tarballs still give Koed deterministic layout, checksums, validation, and provenance, but they do not require Koed to compile every dependency from source when suitable relocatable upstream binaries exist.

## Prototype performed

Environment:

- macOS arm64
- Homebrew prefix: `/opt/homebrew`
- `postgresql@17` 17.10
- `pgvector` 0.8.3
- `llama.cpp` 9840 installed locally; `brew info` latest observed 9850
- `python@3.12` 3.12.13

Prototype staged at a temporary path with Koed's expected packaged runtime layout:

```text
postgres/
  bin/initdb
  bin/pg_ctl
  bin/psql
  bin/pg_config
  share/postgresql@17/extension/vector.control
  share/postgresql@17/extension/vector--*.sql
  lib/postgresql/vector.dylib
llama.cpp/
  llama-server
  lib/*.dylib
embedding-service/
  .venv/bin/python
```

Validation observations:

```text
postgres/bin/pg_config --version => PostgreSQL 17.10 (Homebrew)
postgres/bin/pg_config --sharedir => /opt/homebrew/share/postgresql@17
llama.cpp/llama-server initially failed to load @rpath/libllama-server-impl.dylib after layout move
install_name_tool -add_rpath @loader_path/lib + codesign -s - made llama-server start locally
```

The prototype is useful for proving current manifest/install shape locally, but not acceptable as the release procurement strategy without deeper relocation and signing work.

Build-contract note: after syncing to `origin/koe-244i-linux-wsl-development`, stale local TypeScript build-info files had to be removed before the package-runtime build could progress. After rebuilding API/Worker outputs, `KOED_NATIVE_RUNTIME_SOURCE_DIR=<prototype> pnpm --filter @koed/desktop package:runtime` completed and generated packaged runtime assets for `postgres`, `llama.cpp`, and `embedding-service`. No tracked source files were changed by the prototype.

## Strategy comparison

### 1. Assemble Koed-owned tarballs from relocatable upstream binaries

Verdict: **recommended primary release strategy**.

Use CI as an aggregation, verification, relocation, signing, and packaging pipeline, not as a full build farm unless needed.

Candidate upstream inputs:

- Python: `python-build-standalone` distributions, because they are designed for embedding and relocation.
- `llama.cpp`: official GitHub Release assets pinned by tag and SHA-256, with `otool -L` validation and Koed-side signing.
- PostgreSQL: EDB zip distributions intended for inclusion in application installers, or Postgres.app-style packaged binaries, after relocation and redistribution validation.
- `pgvector`: build from source against the selected staged PostgreSQL `pg_config` if no trusted matching binary exists.

Pros:

- avoids full PostgreSQL/Python/llama.cpp rebuild cost on every artifact bump;
- keeps Koed-owned deterministic artifact layout and manifest checks;
- reduces macOS runner time and Xcode drift exposure;
- lets Koed pin URLs, versions, checksums, and provenance;
- preserves clean-machine behavior without Homebrew.

Cons:

- requires careful upstream redistribution/license review;
- still requires rpath/install-name validation and signing for every Mach-O binary, dylib, and Python extension;
- PostgreSQL choice must prove `CREATE EXTENSION vector` works after relocation;
- upstream binary cadence and platform coverage can affect Koed release timing.

Implementation sketch:

- macOS arm64 artifact workflow downloads pinned upstream archives and verifies SHA-256 before extraction.
- CI stages contents into Koed's `koed-runtime` layout.
- CI builds pgvector against the selected PostgreSQL `pg_config` if needed, then installs extension files into staged PostgreSQL lib/share paths.
- CI patches only minimal rpaths/install names required for Koed layout, signs patched Mach-O files, and records every patch in provenance.
- CI runs `otool -L`, command checks, packaged runtime SHA checks, Postgres `CREATE EXTENSION vector`, and Embedding Service startup.

### 2. Build PostgreSQL, pgvector, llama.cpp, and Python runtime from source in CI

Verdict: **fallback for components that lack acceptable relocatable upstream binaries**.

Pros:

- maximum control over install prefix and layout;
- compatible with `@loader_path` / `$ORIGIN` from build time;
- pgvector built against exact PostgreSQL 17 headers and `pg_config`;
- clean source provenance: source tarball URL, upstream tag, checksum, build logs.

Cons:

- slow and expensive on macOS runners;
- more build scripts to maintain;
- exposed to Xcode runner image drift;
- must pin compilers/build flags;
- macOS signing/notarization still required after packaging.

### 3. Stage from Homebrew/Linuxbrew bottles in CI

Verdict: **keep for local fallback; reject for release-quality primary path**.

Pros:

- fastest spike path;
- package manager supplies versions and dependencies;
- matches ADR-0006 fallback behavior.

Cons:

- absolute `/opt/homebrew` and Cellar paths in Postgres and dependencies;
- bottle tag varies by macOS generation;
- relocation requires binary patching, dependency copying, and re-signing;
- package-manager provenance becomes mixed with Koed-modified binaries;
- Linuxbrew has similar prefix/glibc concerns.

### 4. Consume trusted upstream PostgreSQL binary distribution, build/inject pgvector

Verdict: **recommended PostgreSQL sub-strategy if EDB zip or Postgres.app-style binaries pass relocation, redistribution, signing, and `CREATE EXTENSION vector` validation**.

Pros:

- PostgreSQL project macOS page links EDB zip binaries intended for inclusion in another application installer;
- lower database-engine maintenance burden than full source build;
- pgvector can still be built against exact `pg_config`.

Cons:

- provenance/licensing/signing chain differs from Koed-built artifacts;
- zip layout and relocatability need validation;
- platform coverage/version cadence controlled by upstream;
- does not solve llama.cpp or Python runtime.

### 5. Publish Koed-hosted verified native runtime tarballs

Verdict: **recommended distribution mechanism**.

Use after CI creates validated artifacts from relocatable upstream binaries and selective source builds. Tarballs should include manifest metadata, SHA-256, version/provenance file, and platform/architecture identifiers. Desktop CI can either embed them directly or download by checksum before packaging.

## Proposed artifact contract

Artifact name:

```text
koed-native-runtime-${platform}-${arch}-${runtimeVersion}.tar.zst
```

Artifact builds should be triggered by dependency version bumps or manual dispatch, then published for Desktop packaging jobs to consume. Normal Desktop PR CI should download/verify the prebuilt artifact rather than rebuilding native dependencies.

Minimum contents:

```text
koed-runtime/
  runtime-asset-manifest.json
  provenance.json
  postgres/
    bin/initdb
    bin/pg_ctl
    bin/psql
    bin/pg_config
    lib/**
    share/**
  llama.cpp/
    llama-server
    lib/**
  embedding-service/
    app.py
    requirements.txt
    .venv/bin/python
```

`provenance.json` should include:

- source URLs/tags/checksums;
- build OS/runner image;
- compiler versions;
- configure/CMake flags;
- dependency versions;
- artifact SHA-256;
- license list.

## Follow-up issue scope

### KOE-288

Build macOS arm64 verified native runtime artifact in CI and upload artifact. Prefer relocatable upstream binaries (`python-build-standalone`, official `llama.cpp` releases, EDB/Postgres.app-style PostgreSQL) with selective source builds only where required, especially pgvector. Include loader validation, PostgreSQL 17 check, pgvector file check, `CREATE EXTENSION vector`, llama validation, Python runtime validation, manifest generation, signing checks, and provenance output.

### KOE-289

Download CI artifact into Desktop package job, set `KOED_NATIVE_RUNTIME_SOURCE_DIR`, package app, run full packaged Desktop smoke without source fallback.

### KOE-290

Port the verified artifact pipeline to Linux x64 on documented glibc 2.35+ baseline. Prefer relocatable upstream binaries where practical, with selective source builds for gaps. Validate with `ldd`, packaged provider, `CREATE EXTENSION vector`, Embedding Service startup, and WSL guidance.

## Open risks

- macOS runner cost: full native compilation on GitHub Actions is expensive, especially Apple Silicon runners. Artifact builds should run only on dependency bumps/manual dispatch, not every PR.
- Architecture strategy: decide whether Desktop ships arm64 only first, separate x64/arm64 artifacts, or universal binaries assembled with `lipo`.
- Xcode drift: source builds can break when GitHub updates macOS runner images or Xcode/SDK defaults.
- macOS codesigning/notarization: every Mach-O executable, dylib, `.so`, and Python extension may need ad-hoc signing during artifact assembly and final Developer ID signing/notarization during Desktop packaging.
- PostgreSQL relocatability: chosen distribution must prove `pg_config --sharedir` and runtime extension lookup work under `KOED_HOME/runtime/postgres`, not a build or package-manager prefix.
- Python runtime size: bundled venv prototype was ~151 MiB. Prefer `python-build-standalone` evaluation before trimming a normal venv or building Python from source.
- llama.cpp model/runtime compatibility: artifact ships server binary only; model install remains separate under `KOED_HOME/models`.
- Linux baseline: glibc 2.35+ must be enforced in artifact metadata and runtime diagnostics.
