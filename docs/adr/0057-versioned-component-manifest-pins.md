# Versioned Component Manifest Pins

Status: Accepted direction; implementation and release acceptance pending.

Related: [0011 Standalone koed-server Package Boundary](0011-standalone-koed-server-package.md).

## Context

Base and Privacy component assets are hosted on GitHub Releases, while the
standalone CLI/control plane is distributed as `@koed-labs/server` on npm and
Desktop is distributed as a trusted release artifact. A separate online KMS
signer introduces operational authorization and release-order dependencies.
Trusted control planes can instead authenticate fixed component manifests by
embedding their canonical SHA-256 digests before publication.

## Decision

Trust the official npm distribution/publication chain and trusted Desktop
release artifact. Hostile npm mirrors and registry-metadata substitution are out
of scope: manifest pins do not authenticate a substituted control-plane package.
Given a trusted control plane, pins authenticate GitHub-hosted component assets.
Keep the existing npm/GitHub distribution split.

Bind an immutable catalog to the exact control-plane product version, component,
platform, architecture, and libc identity where declared. Missing, duplicate,
conflicting, or mismatched entries fail closed. Canonical manifest bytes cover
identity, runtime and ABI compatibility, archive digest and size, required files,
and file inventory. Archive and extracted-file verification remain mandatory.
No Operator-supplied production pin override is introduced.

Build and freeze components first, generate the complete catalog second, then
package the trusted CLI and Desktop. Base contains Server code: the frozen
component build must not be rebuilt using the catalog that authenticates itself.
Its runtime copy is not an independently trusted installer. Verify the effective
catalog inside packaged executables, not only a sidecar, before promotion.

The standalone archive also carries its trusted control-plane launcher outside
`koed-runtime`. Its `bin/koed` delegates to that external control plane, and
supervisor start/restart/re-exec must retain the external entrypoint. The Base
runtime CLI remains catalog-less and cannot admit components. Staging replaces
any build-time catalog module with the fixed catalog-less module before full
inventory and archive generation; no files are excluded from verification. A
later catalog-bearing workspace rebuild therefore does not feed authority back
into frozen Base bytes.

Remove KMS verification only after negative tests pass through actual component
install and release-promotion paths. Cloud signer retirement requires separately
authorized operational changes and evidence; code changes do not prove live
service configuration.

Retain Desktop private IPC nonce/process-identity/constrained-request checks,
bundle inventory verification and lifecycle `bundleDigest`, store filesystem
race defenses, and ownership/lifecycle locks. These checks do not claim a hard
boundary against arbitrary same-user code. Native runtime and model trust remain
separate.

Replacing a prior ordinary selection does not require authenticating its old payloads with a newer single-version catalog. Bounded, canonical no-follow metadata establishes only prior owner/version ordering and local consistency. This evidence exposes no runnable roots, cannot satisfy executable generation admission, rejects malformed or unsupported records, and never authenticates historical publisher identity. The new candidate remains fully verified under current pins before atomic selection replacement under lifecycle/store locks. New-version installation requires a complete matching-version component set; old Base/Privacy cannot be reused across versions. Capability-backed Desktop admission remains separate.

Generation activation rejects version downgrades. Same-version generation
switching is recovery between verified component sets, not whole-release rollback.
Activation compares product versions without database migration metadata; version
rejection does not establish database compatibility or restore database state. A matching older control plane is not permission to downgrade. No SQL
migration or database-compatibility framework is introduced by this decision.

## Consequences

This narrows ADR 0011's stronger signature/provenance requirement for component
assets: authentication comes from manifest digests embedded in an already trusted
control plane, not a detached publisher signature. ADR 0011's independent trusted
bootstrap and bundled-fallback requirements remain. Its database-compatible
rollback direction is not implemented by generation activation, and must not be
presented as an existing guarantee. Legacy package provenance policies remain
separate and unchanged.

A changed component requires a new versioned control plane and catalog. Complete
multi-target component builds must precede npm packaging and Desktop signing;
partial catalogs must not be promoted. This removes online signer dependency but
moves completeness and effective packaged-pin checks into the release gate.
Performance optimizations, alternate component hosting, private IPC replacement,
and broad benchmark work remain outside this decision.
