# Release signing and promotion

Both automated release and Desktop recovery workflows keep GitHub releases as drafts until `scripts/release-promotion-adapter.mjs` completes every verification.

## Required repository variables

Configure these values before expecting release promotion to pass:

- `KOED_COMPONENT_SIGNER_URL`: HTTPS endpoint implementing `POST /v1/sign` and `POST /v1/verify`.
- `KOED_COMPONENT_SIGNER_KEY_ID`: production Ed25519 key identifier.
- `KOED_COMPONENT_TRUST_ROOTS_JSON`: JSON object `{ "schemaVersion": 1, "keys": { "<keyId>": "<Ed25519 public key PEM>" } }`.
- `KOED_COMPONENT_TRUST_ROOTS_SHA256`: SHA-256 of exact UTF-8 bytes written as `KOED_COMPONENT_TRUST_ROOTS_JSON`.
- `KOED_CONTROLPLANE_TRUST_ROOTS_SHA256`: SHA-256 of canonical sorted-key JSON serialization of public key map embedded in published `@koed-labs/server` `dist/component-trust-roots.js`.
- `KOED_NPM_PUBLICATION_AUTHORIZED=true`: confirms npm trusted publishing is configured for this workflow.
- `KOED_RELEASE_PROMOTION_APPROVED=true`: explicit independent release approval.

Public signing keys must equal keys compiled into the control-plane package. Both signing and promotion compare public-key maps and their digest with the built package. Current source `packages/koed-server/src/component-trust-roots.ts` has an empty production map, so promotion correctly remains blocked until production trust-key installation is completed separately and built package digest is configured. Do not install production keys as part of a release.

The signing endpoint accepts GitHub Actions OIDC bearer tokens for audience `koed-component-signer`. `/v1/sign` receives `{keyId, manifest}` and returns `{signature:{schemaVersion:1,keyId,algorithm:"ed25519",signature}}`; `/v1/verify` receives `{keyId,manifest,signature}` and returns `{verified:true}` only for a valid signature. No private signing credentials are stored or used locally.

## Promotion checks

The workflow signs each component manifest remotely, then verifies canonical manifest bytes, component/version/target identity, Ed25519 signature, and signed archive SHA-256/size. Promotion streams release assets directly to files (including assets larger than the subprocess buffer), without replacing them, verifies the npm tarball's exact package/version/SHA-512 integrity against release identity, checks exact registry metadata, publishes only a missing candidate with npm provenance, and delegates action ordering/downgrade prevention to `scripts/release-promotion-lib.mjs`. It promotes npm `latest` and publishes GitHub release only after all checks pass. Existing asset upload remains immutable through `scripts/ensure-release-assets.mjs`.

Recovery applies same checks to existing draft assets; it does not rewrite previously uploaded immutable signatures. Missing configuration, untrusted roots, unsigned/placeholder assets, registry mismatch, or signer errors leave release draft and fail workflow.

Candidate publication uses `candidate-<version>` (for example, `candidate-0.9.0`), which npm accepts as a dist-tag. Canonical manifest bytes have no trailing newline and are identical to the installer signing domain. Promotion reads trust roots from the actual packed `package/dist/component-trust-roots.js`; adapter tests extract a real tarball and stream multi-megabyte assets.

## Component signature format and Google Cloud KMS

Detached component signatures use `schemaVersion: 2` and `algorithm: "ed25519"`.
The signing message is the UTF-8 domain `koed-component-manifest-sha256-v2` followed
by a newline, then the raw 32-byte SHA-256 digest of the canonical manifest bytes.
The manifest remains schema version 1. Do not sign the digest's hex/base64 text,
prehash this message again, or use Ed25519ph. This is ordinary Ed25519 over the
explicit domain and digest. SHA-256 collision resistance is an additional assumption.

The fixed-size message fits Google Cloud KMS's 64 KiB raw signing input limit;
real component manifests exceed that limit. The unreleased full-manifest v1
signature envelope is rejected. Rebuild and re-sign earlier test artifacts rather
than relabeling their signatures. Legacy package provenance uses a separate format
and is unchanged.

The external signer must implement these exact bytes for both signing and verification.
Google Cloud KMS uses `EC_SIGN_ED25519` with raw `data`, not a KMS `digest` field.
A KMS key alone does not authorize production trust, npm publication or promotion.
