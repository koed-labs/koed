# ADR 0067: Independently Versioned Linux Native Runtime

Status: Accepted.

Related decisions:

- [0031 Verified Embedding Acceleration](0031-verified-embedding-acceleration.md)
- [0057 Versioned Component Manifest Pins](0057-versioned-component-manifest-pins.md)

## Context

The combined Linux native archive is about 735 MB. Most of those bytes serve
CUDA. CPU installations need Postgres, pgvector, CPU llama.cpp, and a launcher.
The measured CPU split is about 24 MB compressed. Product-version provenance
also changes archive identity when the native binaries remain unchanged.

Homebrew remains useful for existing installations and explicit source-checkout
choices. Comparing total download sizes requires measuring the complete setup,
including the model and dependencies.

## Decision

Publish an independently versioned Linux x64 CPU core and an optional CUDA
add-on. The product release workflow builds both archives on hosted Linux. The installer checks CUDA on the Operator’s machine.
This supersedes the requirement in ADR 0031 that every new Linux artifact must
contain both variants. The old combined artifact remains during the transition.

Each native artifact has a recipe digest, a monotonic runtime version, and
explicit compatibility contracts. The recipe digest identifies inputs and
build policy. It is not a version ordering mechanism. The runtime version
supports minimum-version admission independently of the product version.
Contracts describe the selection layout, Postgres invocation, and embedding
invocation. CUDA composition also requires the exact same llama.cpp revision.

The recipe records upstream digests, toolchain identities, build environment,
build-logic digests, bundled-library inputs, and packaging policy. The frozen
manifest inventories regular-file digests, relative link targets, sizes, and
modes. Frozen packaging preserves these bytes without rebuilding or inserting
product-version metadata. This guarantees repeatable packaging of frozen inputs.
It does not claim identical output from fresh compilations on different hosts.

The product release contains both archives and their manifests. The release
workflow compiles the URLs and checksums into the Control Plane. Each archive
retains its native build version across cache hits. A fresh build uses the new
product version. Operators cannot override the compiled download locations.

Native selection changes require stopped Koed and the existing lifecycle lock.
One atomic pointer selects a complete set of admitted immutable payloads.
Operators stop and start Koed explicitly. The installer performs no automatic
shutdown, restart, rollback, stale-lock reclamation, or native-payload cleanup.
Retained payloads, models, database data, and other installations stay intact.

Base remains bound to the product version and the existing component admission
boundary. AI Client synthesis, macOS, Desktop provider choices, Privacy Filter
CUDA, and standalone Server archives remain outside this decision.

## Consequences

Product upgrades can reuse a compatible native core without downloading it
again. The Control Plane must enforce a compiled minimum version, target,
contracts, and inventory integrity at startup. An outdated compatible core
remains usable. A recipe digest alone cannot establish compatibility.

Each product release retains its native archives and their build records. Initial updates preserve the Postgres major version and pgvector
version. Database and Homebrew migration remain separate work.
