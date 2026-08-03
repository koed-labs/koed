# Development Portability Uses Verified Workspace Snapshots

Status: Accepted.

Related decisions:

- [0014 Hosted Personal Replication Uses The Conversation Source Journal](./0014-hosted-personal-source-replication.md)
- [0015 Managed Conversation Execution Uses A Fenced Runtime And Durable Realtime Stream](./0015-managed-conversation-execution-and-realtime.md)
- [0016 Conversation Continuation Uses Exclusive Handoff And Explicit Fork Lineage](./0016-exclusive-execution-handoff-and-fork-lineage.md)

## Context

An AI coding Conversation depends on files and tools outside the provider
transcript. Continuing on another device may require:

- repository objects and refs;
- the checked-out commit and branch;
- staged, unstaged, and untracked changes;
- repository boundaries such as nested repositories or submodules;
- Git worktree identity;
- submodule state and local modifications;
- Git LFS objects;
- symlinks and executable bits;
- non-repository workspace files;
- dependency lockfiles and toolchain declarations;
- environment configuration and credentials.

Raw directory copying is unsafe and non-portable. It leaks absolute paths and
credentials, copies caches and build artifacts, mishandles worktrees, and can
overwrite target work. Git remote URLs are matching evidence, not a complete
source: repositories may be local-only, remotes may change, and providers are
not limited to GitHub.

Koed must make a narrow, verifiable claim. It can transfer an immutable
development workspace snapshot and materialize it safely. It cannot guarantee
that every external service, dependency, secret, tool, or operating-system
behavior is reproducible.

## Decision

Koed uses immutable, content-addressed **Development Workspace Snapshots** as
the portability unit for managed Conversation handoff and fork.

A snapshot is separate from Conversation source, Personal Memory, Project
metadata, and Team Workspace authorization. It may be referenced by a handoff
or fork manifest but has its own lifecycle, encryption, retention, and consent.

### Workspace Shape

One snapshot contains:

- an opaque snapshot id and version;
- owning Personal User and source deployment/device;
- one logical workspace root;
- one Repository Snapshot rooted at that workspace in the initial protocol;
- a bounded overlay of non-repository files explicitly eligible for transfer;
- toolchain and dependency declaration metadata;
- source and creation timestamps;
- content digests, byte/file counts, and parent snapshot where applicable;
- capture policy, exclusion policy, and User consent version;
- encryption and object-storage references;
- final manifest digest.

Absolute source paths never enter a remote package. The target chooses its own
local root and records a device-local Project/checkout association after
materialization.

### Point-In-Time Capture

Snapshot capture takes a bounded capture lease and quiesces the managed
execution before reading workspace state. It records filesystem and repository
generation observations, then verifies them again before finalizing. Concurrent
mutation, changing index locks, or an unstable repository fails capture rather
than producing a mixed-time snapshot.

The source adapter either represents an active merge, rebase, cherry-pick,
bisect, or sequencer state completely and structurally, or reports it as
incompatible. It never reduces an in-progress operation to a patch that only
looks clean.

### Initial Repository Compatibility Floor

The first accepted snapshot protocol intentionally supports one ordinary Git
repository whose top-level directory is the selected Project path. It
preserves:

- the complete `HEAD` object closure in a verified provider-neutral Git bundle;
- branch-independent `HEAD`, including detached state;
- staged and unstaged binary patches;
- bounded untracked regular-file bytes and modes;
- linked-worktree state captured through Git's logical repository interfaces,
  without transferring worktree administration;
- sanitized fetch/push remote aliases and refspecs as non-authoritative
  matching evidence; and
- a deterministic digest over Git status, semantic index output, patches,
  untracked bytes, and sanitized remote configuration.

No remote is required, so local-only repositories are portable. Remote
credentials and device-local file remotes are rejected.

Linked worktrees are supported as source topology. Koed reads the selected
worktree's exact Git state and materializes it as an independent target
repository; it does not transfer `.git` administration, absolute paths, or
relationships to sibling worktrees.

The initial protocol fails closed for shapes it cannot reproduce exactly:
nested repositories, gitlinks or submodules, active Git operations, unmerged
indexes, sparse checkout, non-default semantic index flags, partial clones,
alternates, content filters or working-tree encodings, Git LFS pointers,
symlinks, special files, and an unstable repository. These are explicit
incompatibilities, not silently degraded snapshots. Supporting one of those
shapes requires a later protocol version and matching native compatibility
evidence; Project metadata or a remote URL never substitutes for the missing
state.

### File Selection And Secrets

Within that compatibility floor, the default snapshot includes:

- tracked repository content required by the selected Git state;
- staged and unstaged tracked changes, including tracked deletions;
- untracked, non-ignored files within configured size and type bounds;
- explicitly named environment templates such as `.env.example`, only after
  the same content scan applied to every other packaged blob;

The initial protocol excludes:

- provider homes and credentials;
- `.git` administrative directories;
- real `.env` variants, recognized credential files, and private-key material;
- OS credential stores, browser profiles, keychains, SSH/GPG material, cloud
  credentials, API Tokens, device credentials, database credentials, raw KMS
  material, and repository auth helpers;
- ignored files;
- nested repositories, submodules, symlinks, sockets, devices, FIFOs, and
  other unsupported file shapes;
- files outside the logical workspace root.

A bounded secret scanner and file-class policy run before packaging. Detection
scans the complete bundled `HEAD` object closure, current semantic-index blobs,
tracked working bytes, and packaged untracked bytes. Known credential paths,
private keys, and accepted token patterns are hard-denied with no override.
The initial protocol does not publish a degraded snapshot by silently
excluding required content. This is a safety layer, not a claim that every
secret can be detected. Failure surfaces use stable redacted reason codes;
remote operational metadata never includes source paths or matching content.

Symlinks and special files are rejected by the initial protocol.

Exact working-tree bytes are stored independently from semantic Git index
state. This preserves staged and unstaged differences without asking checkout
filters to regenerate content. Git filters are recorded only as sanitized
requirements and are never executed automatically on the target.

### Filesystem Compatibility

Manifest paths use UTF-8, `/` separators, NFC normalization, and no empty,
`.` or `..` components. The initial implementation accepts only regular files
beneath one verified root and checks destination ownership, real paths, and
filesystem boundaries before writing. It never silently renames, flattens,
dereferences, or drops content. A platform is supported only after its native
fixture matrix proves that these checks preserve the accepted source state.

### Reproducibility Manifest

Koed records non-secret declarations that help the target explain readiness:

- operating system and architecture;
- Git version and repository object format;
- language/tool versions inferred from accepted version files;
- dependency lockfile digests;
- container/devcontainer or reproducible-environment manifest digests;
- required but intentionally omitted secret names, never values;
- required external service classes;
- detected incompatibilities.

Koed does not transfer installed dependencies by default. The target may run
explicit, User-approved environment bootstrap commands only after
materialization and under the execution sandbox. A lockfile is evidence, not
proof that installation will succeed.

### Packaging And Storage

Snapshots use a strict versioned manifest, deterministic ordering,
content-addressed chunks, authenticated digests, bounded compression, resumable
upload/download, idempotency, and the existing encrypted object/package
boundary.

Remote/commercial storage uses application-layer envelope encryption under the
accepted KMS, BYOK, or CMEK posture. Local snapshots use restrictive filesystem
permissions and optional local application-layer encryption. Snapshot bytes,
file names when sensitive, patches, Git objects, paths, and manifests never
enter logs, queue payloads, metrics, traces, diagnostics, audit metadata, or
support views.

The manifest version defines hard limits for individual files, total expanded
bytes, Git objects, LFS objects, file count, directory depth, compression ratio,
chunk count, component/path length, and required destination disk reserve.
All readers enforce the lower of protocol and deployment limits before
allocation and again while expanding.

### Target Materialization

The target reserves a previously nonexistent operation-owned path beneath an
Operator-approved, User-owned root. It uses restrictive permissions and
no-follow file creation, rejects path escapes, symlinked parent directories,
filesystem-boundary changes, and ownership changes, and never grants provider
execution or publishes readiness until verification completes. It:

1. authenticates and authorizes the owning User and target device;
2. verifies manifest version, identity, digests, bounds, and encryption
   context;
3. reconstructs the accepted repository object closure and checks the requested
   `HEAD`;
4. creates a target-local repository without copying source `.git`
   administration;
5. applies staged, tracked-working, and bounded untracked overlays;
6. rejects path traversal, unsafe symlinks, special files, duplicate paths,
   unsupported modes, malformed encodings, and size expansion beyond declared
   bounds;
7. recomputes repository and workspace state digests;
8. removes operation-only package material;
9. records the device-local Project/checkout association and readiness only
   after exact verification.

Koed never overwrites or merges into a non-empty target directory during
automatic handoff. A conflicting target path requires another empty location or
a separate explicit merge workflow.

Target Git configuration is rebuilt from an allowlist. Hooks, credential
helpers, URL rewrites, alternates, arbitrary filters, and transferred
`safe.directory` values are excluded. Koed never sets `safe.directory=*`.
Checkout runs as the target owner or trusts only the exact verified path.
Failure cleanup removes only the operation-owned target and temporary package
directory with the same no-follow and ownership checks. A target left by a
crash remains unpublished and is either verified idempotently for the same
operation or removed before retry.

### Readiness

Readiness is an evidence-backed conjunction, not one overloaded state.
Independent dimensions are:

- snapshot integrity and object closure;
- filesystem fidelity;
- environment/tool/secret/service availability;
- provider-adapter compatibility;
- current execution-lease and source-boundary compatibility.

Each dimension stores status, reason code, evidence digest, checked timestamp,
and expiry. Unknown or expired evidence fails closed. The UI may summarize the
dimensions as:

- `missing`: no snapshot or local Project mapping;
- `transferring`: verified chunks are incomplete;
- `verifying`: bytes are present but state digest is not proven;
- `materialized`: exact snapshot content is present;
- `environment_incomplete`: files are present but declared tools,
  dependencies, secrets, or services are unavailable;
- `ready`: provider adapter and required workspace checks passed;
- `incompatible`: target cannot safely reproduce the required state;
- `conflicted`: source or target state disagrees with the manifest;
- `revoked` or `deleted`: lifecycle prevents new use.

Only `ready` may participate in same-Conversation handoff. A fork may start from
`materialized` or `environment_incomplete` only after the User acknowledges the
limitations and the provider adapter can run safely.

Snapshot inventory states whether continuation is exact or incompatible and
records the accepted repository, files, object closure, remote evidence, and
failure reason. Project association is device-local organization and remains
separate from any Team Workspace mapping or Team authorization.

### Lifecycle

A snapshot is immutable. Later work produces a new snapshot linked to its
parent. Retention, sync revocation, Conversation deletion, Project deletion,
Team Share Grant revocation, and hard purge are separate lifecycle operations.

Deleting a local checkout does not silently delete retained encrypted snapshots
or Personal Memory. Revoking future Personal synchronization does not erase
bytes already downloaded by a trusted device. Hosted deletion follows the
User's Personal retention and legal-hold policy and records a tombstone that
prevents stale replay.

Snapshot lifecycle normatively inherits ADR 0014's monotonically increasing,
rollback-excluded authority floor. Before discovery, chunk access, DEK unwrap,
decrypt, materialization, and readiness publication, Koed rechecks the current
User and device, snapshot consent, handoff or fork operation, retention,
legal-hold, revocation, and tombstone state. A restored backend or stale device
cannot re-publish, download, materialize, or execute a snapshot below that
floor.

### Team Boundary

Development Workspace Snapshots are Personal execution artifacts. Team
Membership, Workspace Access, a Share Grant, or permission to watch a shared AI
Conversation does not grant repository snapshot access. Sharing or sponsoring
development execution requires a separate explicit grant and authority model.

### Required Compatibility Tests

Release evidence for a claimed platform covers its native filesystem. The full
future fixture matrix includes native Windows on NTFS, WSL on its Linux
filesystem, WSL on DrvFS, default case-insensitive macOS, and case-sensitive
Linux. It includes:

- accepted clean, detached, dirty, local-only, and linked-worktree
  repositories, including tracked deletions;
- rejected unmerged, sparse, partial-clone, nested-repository, submodule, LFS,
  alternate, filter, and semantic-index-flag cases;
- hostile Git config, hooks, credential helpers, URL rewrites, and
  credential-bearing remotes;
- case and Unicode collisions, Windows-invalid paths, long paths, symlinks
  without target privileges, junctions, reparse points, and cycles;
- huge files and objects, decompression expansion, disk exhaustion, concurrent
  workspace mutation, and index-lock races;
- secret material reachable only through Git objects, LFS, or submodules;
- crash and retry before publication, during materialization, before rename,
  and after rename but before readiness commit.

No platform may be claimed as supported without passing its native filesystem
matrix. A missing platform result is an explicit compatibility limitation, not
an assumed pass.

## Consequences

- Koed can safely move accepted dirty and local-only single-repository work
  without assuming GitHub or a clean commit.
- Transfers are larger and more expensive than Conversation source alone.
- Some environments remain non-portable because of unavailable credentials,
  services, hardware, operating systems, or proprietary tools.
- Automatic handoff favors correctness over merging into an existing checkout.
- Users receive explicit readiness and incompatibility states rather than a
  false promise of reproducibility.

## Rejected Alternatives

- Copying the entire working directory or provider home.
- Requiring every change to be committed and pushed to GitHub.
- Treating a Git remote URL as repository identity or authorization.
- Copying `.git` administrative directories between worktrees or devices.
- Transferring ignored files, credentials, caches, dependencies, or build
  output by default.
- Applying a snapshot over a non-empty target directory.
- Claiming transcript portability alone makes development work portable.
- Treating Team access to a Conversation as access to repository contents.
