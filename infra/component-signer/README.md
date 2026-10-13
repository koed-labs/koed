# Component signing service

This private Cloud Run service authenticates GitHub Actions OIDC requests and
signs Koed component manifests using a pinned Google Cloud KMS Ed25519 key version.
It stores no private key or service-account credential. Secret Manager is not required.

The service accepts only the immutable configured repository/owner IDs, the
`koed-labs/koed` repository, and these main-branch workflow/event pairs:

- `.github/workflows/release.yml`: `push`.
- `.github/workflows/release-desktop-assets.yml`: `workflow_dispatch`.

GitHub JWTs must use issuer `https://token.actions.githubusercontent.com`, audience
`koed-component-signer`, RS256, valid expiry/not-before and an issue age below ten
minutes. Cloud Run permits HTTP invocation; application authorization protects
both signing and verification. Forks, PR events, other workflows and other refs
are denied. A temporary `KOED_SIGNER_REHEARSAL_SHA` pin additionally permits only
the CI workflow on `codex/headless-distribution-fixes`, with an exact matching
commit and `workflow_dispatch`. Remove the pin after signing-only acceptance. Requests are bounded to 8 MiB and 30 seconds. Audit output contains
workflow/run identity and manifest digest, never JWTs or credentials.

`POST /v1/sign` accepts `{keyId, manifest}` and returns `{signature}`.
`POST /v1/verify` accepts `{keyId, manifest, signature}` and returns `{verified}`.
`GET /health` reports process readiness, not KMS or workflow acceptance.

The service shares manifest validation and canonicalization with Koed's installer
and v2 message construction with release scripts. KMS receives raw signing data;
CRC32C checks, pinned key-version checks and independent signature verification
are required before returning a signature. Public-key integrity is checked too.

## Local checks

Run from repository root:

```bash
npm ci --prefix infra/component-signer --ignore-scripts
pnpm --filter @koed-labs/server build
node --test infra/component-signer/service.test.mjs
```

The isolated npm lockfile is for this private deployment, outside the pnpm
workspace. Tests cover token cryptography, repository/workflow authorization,
manifest tampering, signature schema rejection and KMS integrity failures.

## Deployment

Build the Server first. Assemble a minimal source context containing:

- This directory's `server.mjs`, `service.mjs`, `package.json`, `package-lock.json`
  under `infra/component-signer/`.
- `scripts/component-signature-format.mjs` at its repository-relative path.
- Built `packages/koed-server/dist/component-verification.js` at that path.
- This directory's Dockerfile at the context root.
- A root `package.json` containing `{"private":true,"type":"module"}`.

Deploy this context with `gcloud run deploy --source`, the runtime service account,
region `europe-west2`, a maximum of two instances and these environment variables:
`KOED_SIGNER_KEY_ID`, `KOED_SIGNER_KMS_KEY_VERSION`,
`KOED_SIGNER_REPOSITORY_ID`, `KOED_SIGNER_OWNER_ID`.
The Dockerfile runs as the unprivileged Node user. Redeploy to update its base image.

The runtime account needs `roles/cloudkms.signerVerifier` on the specific key.
The build account needs `roles/run.builder` in the project. Keep signing-key
administration and service deployment permissions separate from runtime access.

Production public roots, workflow variables, npm authorization and promotion
approval remain independent. Deployment does not authorize a product release.
A real authorized GitHub workflow rehearsal must pass before enabling promotion.

## Current deployment

Project: `koed-release-signing-20261013`; region: `europe-west2`.
Service: `https://koed-component-signer-943160955041.europe-west2.run.app`.
Key ID: `koed-components-2026-01`.
KMS key version:
`projects/koed-release-signing-20261013/locations/europe-west2/keyRings/koed-release/cryptoKeys/component-signing/cryptoKeyVersions/1`.
Runtime account: `koed-component-signer@koed-release-signing-20261013.iam.gserviceaccount.com`.

Health and missing/invalid-token denial probes passed. The authorized
[GitHub signing rehearsal](https://github.com/koed-labs/koed/actions/runs/38480694817)
passed for both oversized synthetic manifests, including archive verification,
remote verification and tampering denial. Temporary branch authorization was
removed afterward. Production trust roots and GitHub release variables
are configured separately from this deployment. npm publication and promotion
remain independent authorization gates.
