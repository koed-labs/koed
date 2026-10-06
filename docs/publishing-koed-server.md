# Publishing Koed Server

`@koed-labs/server`, the standalone Koed distribution, and Desktop use the same
product version. The public package is built with the existing public-server
package builder; standalone release artifacts are independently assembled as
base and privacy components. Each component archive has SHA-256, a component
manifest, and detached signature metadata. Unsigned local builds are marked
`unsigned-placeholder`; they are not official release artifacts.

## Required production infrastructure

Release publication remains blocked until Operator-managed infrastructure is
configured. CI requires all of these repository variables before promotion:

- `KOED_COMPONENT_SIGNER_URL`: approved external signing service endpoint.
- `KOED_COMPONENT_SIGNER_KEY_ID`: production signing identity.
- `KOED_COMPONENT_TRUST_ROOTS_SHA256`: SHA-256 of approved production trust
  roots. Empty or malformed value fails closed.
- `KOED_NPM_PUBLICATION_AUTHORIZED=true`: npm organization has enabled GitHub
  Actions trusted publishing for the exact repository and workflow, with
  package write permission and OIDC; no long-lived npm token is used.
- `KOED_RELEASE_PROMOTION_APPROVED=true`: separate explicit release approval.

The release workflow currently has no external signer integration, approved
trust roots, or npm publication integration. Setting placeholder variables is
not sufficient to establish trust or authorize a real release. Do not configure
these variables until signer verification, npm OIDC publishing, and production
trust-root validation have been reviewed and connected. Until then, CI can
assemble unsigned candidate assets but must leave GitHub releases as drafts and
must not publish npm packages or stable tags.

## Immutable candidate and retry protocol

1. Build all release bytes from one product version and retain the npm tarball,
   SHA-512 integrity, and deterministic inventory SHA-256.
2. Upload missing GitHub draft assets only. Existing same-name assets are
   downloaded and compared byte-for-byte by SHA-256; exact matches are
   idempotent, while any mismatch blocks without overwrite.
3. Publish the npm version once under its immutable semver identity and a
   version-specific candidate dist-tag. If the version already exists, verify
   exact SHA-512 integrity and inventory before continuing; mismatches block.
4. Verify the candidate from the npm registry, then move `latest` only if that
   cannot downgrade it. Publish the GitHub release only after all expected
   asset identities and checksums verify.
5. Retries resume from remote state: missing assets may be added to a draft,
   matching assets and an identical npm candidate are no-ops, and conflicting
   bytes, identities, or tags block. Never use asset replacement, npm version
   overwrite, or blind `--clobber`.

`scripts/release-promotion-lib.mjs` is a pure state planner for this ordering;
it emits no credentials and performs no publication. `scripts/ensure-release-assets.mjs`
implements byte-checked, no-overwrite GitHub draft asset retries. Actual external
signing, npm candidate publication/registry verification, and trust-root
verification remain infrastructure gates, not simulated successes.

## Signing and key rotation

Production signing keys stay in an external signer; private key material must
not enter the repository, workflow artifacts, or logs. Component manifests
bind product version, target, required files, runtime constraints, and archive
hash. Signatures use the existing Koed component-manifest canonical format.
Before signing is enabled, verifier policy must pin reviewed trust roots and
key IDs. Rotation requires publishing the new approved trust roots, verifying
artifacts signed by both old and new keys during the transition, then removing
old roots only after all supported artifacts have migrated. Fixture keys used
by tests are never production trust roots.
