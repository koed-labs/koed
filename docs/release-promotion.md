# Release signing and promotion

The release workflow keeps GitHub releases as drafts until `scripts/release-promotion-adapter.mjs` completes every verification. Automated asset jobs run only when the release is absent or remains a draft; reruns skip asset acquisition and promotion for already published releases.

Component admission is migrating to [versioned manifest catalogs](component-manifest-catalog.md). Frozen component builds precede complete catalog generation, then standalone/npm and Desktop packaging. Promotion additionally verifies that catalog against every frozen archive and the effective packed npm and Desktop control planes before publication. Existing signer checks below remain transitional release gates until target-specific replacement acceptance permits component-signing source cleanup; they are not a runtime fallback for missing pins. This cleanup does not authorize changing or deleting live cloud resources.

## Read-only candidate verification

`verifyReleaseCandidate(input, readers)` returns evidence, not permission to publish.
Its reader interface contains only GitHub/registry GET operations. The
`--verify-only` entry path does not request OIDC tokens, contact the component
signer, or expose npm publish/dist-tag or GitHub release-update methods. Use a
read-only token (`contents: read`, `actions: read`); do not provide publication or
signing credentials to this job.

The workflow retains frozen catalog/components, app-runtime/npm outputs, native
runtime assets, release metadata and final Desktop ZIP/DMG bytes as immutable
Actions artifacts for 30 days. `reviewed-release-identity` hashes those outputs,
not the mutable release draft, and emits `reviewed-build.json`. Downstream jobs
receive its artifact ID, Actions artifact digest and exact JSON SHA-256 through
job outputs. Verification also binds repository, reviewed commit, workflow path,
run ID/attempt and product version, and rechecks artifact origin/expiry through
GitHub. Missing or expired evidence blocks verification; never regenerate
expected hashes from downloaded draft assets.

For an already approved build, the read-only CLI shape is:

```bash
node scripts/release-promotion-adapter.mjs --verify-only \
  --expected-build /path/to/approved/reviewed-build.json \
  --expected-build-sha256 "$APPROVED_IDENTITY_SHA256" \
  --identity-artifact-id "$APPROVED_IDENTITY_ARTIFACT_ID" \
  --identity-artifact-digest "$APPROVED_IDENTITY_ARTIFACT_DIGEST" \
  --repository "$APPROVED_REPOSITORY" --reviewed-commit "$APPROVED_COMMIT" \
  --approved-run-id "$APPROVED_RUN_ID" --approved-run-attempt "$APPROVED_RUN_ATTEMPT" \
  --release-id "$CANDIDATE_DRAFT_ID" --version "$APPROVED_VERSION" --json
```

All `APPROVED_*` values must come from independently reviewed build evidence,
not candidate-supplied metadata. Artifact digest includes the `sha256:` prefix.
A caller who controls both expected identity and candidate is not independently
authenticated by this comparison.

Verification compares exact remote asset bytes with protected hashes; checks the
complete Base/Privacy × Linux x64 glibc/macOS arm64 tuple matrix, canonical
manifests and archive/file inventories; and statically inspects actual npm
name/version/bin/SRI/inventory and effective npm/Desktop catalog pins. Candidate
modules are parsed, never imported or executed. Desktop inspection extracts
`app.asar` from the final ZIP, without modifying sealed app bytes. The
Desktop job retains the final ZIP, DMG, size report and checksum file as a
run artifact only after signing, notarization, sealing, integrity verification
and composition inspection. Retaining and hashing those bytes binds what is
published; it is not signed/notarized clean-Mac launch acceptance.
Registry checks reject version/SRI conflicts and `latest` downgrades; absent npm
candidate is valid verification evidence, not authorization to create it.

npm inspection accepts the generated `bin/koed.js` launcher only, then resolves
its actual control-plane exports and split-module bindings statically. The CLI
must reach admission calls whose `manifestCatalog` value comes from the same
validated catalog authority inspected by the exported catalog check. Uncalled
nested consumers, incidental catalog references, property overrides and spreads
cannot satisfy this gate. This is a generated-code shape check, not a proof of
arbitrary JavaScript semantics or a replacement for protected build provenance.

`reviewed-build.json` now includes mandatory `runtimeIdentities`. These come from
protected checkout policy in `scripts/reviewed-build-identity-runtimes.mjs`, not
candidate manifests: Node 24.13.1 / ABI 137 / N-API 10 for Linux x64 and macOS
arm64; Electron 39.8.10 / embedded Node 22.22.1 / ABI 140 / N-API 10 for macOS
arm64. Electron must match the resolved Desktop lock and independently validated
runtime policy. Linux glibc 2.35 is the admission baseline, not a candidate-chosen
minimum. Frozen verification checks each component against every required
consumer on its target, including N-API-only contracts. Missing, duplicate or
changed protected runtime identities fail closed; regenerate older reviewed
identities through the approved build job. CLI frozen verification uses the same
protected checkout policy without a candidate runtime-input flag. Runtime
upgrades require separately reviewed measurements and policy/toolchain updates;
these static compatibility checks do not establish native startup acceptance.

`node scripts/component-pin-rehearsal.mjs` exercises real installer/admission
calls in disposable homes with fixture control planes, offline network denial,
HTTPS-shaped fetch fixtures and manifest/archive/extracted-file/missing-pin/
wrong-pin rejection. It uses synthetic payloads and does not establish actual
network isolation, native startup, signatures, notarization or Task 4 acceptance.

Publication approval remains separate and is checked before any mutation.
Production promotion reruns protected candidate verification immediately before
its first mutation and binds publication bytes to that evidence. No receipt or
caller-supplied success flag substitutes for either approval or verification.
Transitional production signer/root checks remain required until Task 4's real
replacement-path acceptance passes; their removal belongs to Task 5.

## Required repository variables

Configure these values before expecting release promotion to pass:

- `KOED_COMPONENT_SIGNER_URL`: HTTPS endpoint implementing `POST /v1/sign` and `POST /v1/verify`.
- `KOED_COMPONENT_SIGNER_KEY_ID`: production Ed25519 key identifier.
- `KOED_COMPONENT_TRUST_ROOTS_JSON`: JSON object `{ "schemaVersion": 1, "keys": { "<keyId>": "<Ed25519 public key PEM>" } }`.
- `KOED_COMPONENT_TRUST_ROOTS_SHA256`: SHA-256 of exact UTF-8 bytes written as `KOED_COMPONENT_TRUST_ROOTS_JSON`.
- `KOED_CONTROLPLANE_TRUST_ROOTS_SHA256`: SHA-256 of canonical sorted-key JSON serialization of public key map embedded in published `@koed-labs/server` `dist/component-trust-roots.js`.
- `KOED_NPM_PUBLICATION_AUTHORIZED=true`: confirms npm trusted publishing is configured for this workflow.
- `KOED_RELEASE_PROMOTION_APPROVED=true`: explicit independent release approval.

Public signing keys must equal keys compiled into the control-plane package. Both signing and promotion compare public-key maps and their digest with the built package. The approved Google Cloud KMS public key `koed-components-2026-01` is embedded in `packages/koed-server/src/component-trust-roots.ts`. Build/package roots must match the configured key map and digests. Trust-key changes are reviewed source changes, not keys installed dynamically during a release.

The signing endpoint accepts GitHub Actions OIDC bearer tokens for audience `koed-component-signer`. `/v1/sign` receives `{keyId, manifest}` and returns `{signature:{schemaVersion:2,keyId,algorithm:"ed25519",signature}}`; `/v1/verify` receives `{keyId,manifest,signature}` and returns `{verified:true}` only for a valid signature. No private signing credentials are stored or used locally.

## Promotion checks

The workflow signs each component manifest remotely, then verifies canonical manifest bytes, component/version/target identity, Ed25519 signature, and signed archive SHA-256/size. Promotion streams release assets directly to files (including assets larger than the subprocess buffer), without replacing them, verifies the npm tarball's exact package/version/SHA-512 integrity against release identity, checks exact registry metadata, publishes only a missing candidate with npm provenance, and delegates action ordering/downgrade prevention to `scripts/release-promotion-lib.mjs`. It promotes npm `latest` and publishes GitHub release only after all checks pass. Existing asset upload remains immutable through `scripts/ensure-release-assets.mjs`.

Recovery applies same checks to existing draft assets; it does not rewrite previously uploaded immutable signatures. Missing configuration, untrusted roots, unsigned/placeholder assets, registry mismatch, or signer errors leave release draft and fail workflow.

Candidate publication uses `candidate-<version>` (for example, `candidate-0.9.0`), which npm accepts as a dist-tag. Canonical manifest bytes have no trailing newline and are identical to the installer signing domain. Promotion reads trust roots from the actual packed `package/dist/component-trust-roots.js`; adapter tests inspect a real tarball and exercise production signature verification and mutations through local mocks.

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

## Hosted signing API

`infra/component-signer` implements the GitHub OIDC contract on Cloud Run with
Google Cloud KMS and the v2 component message. It uses an attached service identity
rather than stored credentials. See its README for deployment and authorization
rules. The configured GitHub repository and owner IDs are immutable identities;
release and recovery workflows must run on `main`. Deployment and a successful
health probe alone do not establish authorized end-to-end signing acceptance.

A signing-only rehearsal can be dispatched through CI. Outside `main`, its
Cloud Run authorization must be temporarily pinned with `KOED_SIGNER_REHEARSAL_SHA`
to the exact reviewed commit on `codex/headless-distribution-fixes`. Only that
CI workflow, ref, commit and `workflow_dispatch` event are accepted. Remove the
pin after the rehearsal. It signs synthetic oversized manifests, verifies their
archives and checks tampering; it performs no npm/GitHub release promotion and
does not establish native Linux or full service lifecycle acceptance.

## Local KMS lifecycle validation

On 2026-10-14, fresh macOS arm64 Base and Privacy Filter component archives were
signed with KMS key version 1 (`koed-components-2026-01`) using the v2 message.
The public control-plane npm tarball was installed offline outside the checkout,
with its embedded production trust roots unchanged. Component installation and
generation activation passed in isolated homes, followed by healthy Personal and
Team startup, shutdown, restart and final shutdown. Team diagnostics verified the
API, database, queues, embedding and Privacy services, Local AI Runtime, API Token,
MCP Server and device identity. No test service processes remained afterward.

This run used authenticated `gcloud` signing, preinstalled native PostgreSQL and
llama.cpp binaries, and cached pinned model files. It complements the separate
GitHub OIDC signing-service rehearsal; it does not validate native dependency
installation, a fresh Desktop GUI handshake, other platform targets, upgrade or
rollback migration, or production publication. Publication remained disabled.

Assembly audits account for the remote MCP client's exact dynamic import of the
selected MCP runtime contracts. That exception requires the concrete
`@koed/mcp-server` contracts entrypoint in the component dependency closure;
unowned dynamic imports continue to fail closed.
