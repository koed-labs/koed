# ADR 0067: Independently Versioned Linux Native Runtime

Status: Accepted.

Related decisions:

- [0031 Verified Embedding Acceleration](0031-verified-embedding-acceleration.md)
- [0057 Versioned Component Manifest Pins](0057-versioned-component-manifest-pins.md)
- [Linux baseline measurements](../qualification/linux-native-baseline.md)

## Context

The combined Linux native archive is about 735 MB. Most of those bytes serve
CUDA. CPU installations need Postgres, pgvector, CPU llama.cpp, and a launcher.
The measured CPU split is about 24 MB compressed. Product-version provenance
also changes archive identity when the native binaries remain unchanged.

Homebrew remains useful for existing installations and explicit source-checkout
choices. Its complete installation costs differ from native archive sizes.
The baseline therefore records the complete Homebrew path and treats proposed
CPU download savings as provisional.

## Decision

Publish an independently versioned Linux x64 CPU core and an optional CUDA
add-on. The core can build, qualify, and ship without CUDA tools or GPU hardware.
CUDA publication requires real GPU qualification against exact frozen artifacts.
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

A reviewed native release provides immutable URLs and archive and manifest
digests. The trusted Control Plane compiles those pins. Operators cannot
override production native pins. A catalog containing only the core is valid.
Published identities must not be overwritten or deleted, including their tags.
Native releases must not become the latest product release.

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

Separate native identities add release-retention and pin-promotion obligations.
CUDA retains independent provenance so unrelated Postgres changes do not force
a new add-on. Initial updates preserve the Postgres major version and pgvector
version. Database and Homebrew migration remain separate work.
