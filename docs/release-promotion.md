# Release verification and promotion

The release workflow keeps GitHub releases as drafts until `scripts/release-promotion-adapter.mjs` completes every verification. Automated asset jobs run only when the release is absent or remains a draft; reruns skip asset acquisition and promotion for already published releases.

Component admission uses [versioned manifest catalogs](component-manifest-catalog.md). Before merge, the stack must be pin-only: no component KMS, hosted signer, signer roots, signature sidecars or component-signing OIDC dependency. Frozen component builds precede complete catalog generation, then standalone/npm and Desktop packaging. Promotion verifies that catalog against every frozen archive and the effective packed npm and Desktop control planes before publication. Native Personal/Team and signed/notarized clean-Mac acceptance remain gates, not prerequisites for retaining obsolete signing code. Source cleanup neither authorizes nor requires live cloud or repository-variable changes.

## Read-only candidate verification

`verifyReleaseCandidate(input, readers)` returns evidence, not permission to publish.
Its reader interface contains only GitHub/registry GET operations. The
`--verify-only` entry path does not request OIDC tokens or publication credentials,
or expose npm publish/dist-tag or GitHub release-update methods. Use a
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
Component authentication is pin-only; missing pins fail closed. Actual native
and signed Desktop acceptance remains required independently of source cleanup.

## Required repository variables

Configure these values before expecting release promotion to pass:

- `KOED_NPM_PUBLICATION_AUTHORIZED=true`: confirms npm trusted publishing is configured for this workflow.
- `KOED_RELEASE_PROMOTION_APPROVED=true`: explicit independent release approval.

npm trusted publishing retains its publication OIDC/provenance requirements.
Component authentication needs no external signing service or public-key configuration.

## Promotion checks

The workflow verifies canonical manifest bytes against the complete version-matched catalog, component/version/target identity, and archive SHA-256/size. Promotion streams release assets directly to files (including assets larger than the subprocess buffer), without replacing them, verifies the npm tarball's exact package/version/SHA-512 integrity against release identity, checks exact registry metadata, publishes only a missing candidate with npm provenance, and delegates action ordering/downgrade prevention to `scripts/release-promotion-lib.mjs`. It publishes the GitHub release first, then re-reads it and re-hashes every immutable asset against the protected build bytes, and only then moves npm `latest`; `latest` is never moved while the matching GitHub components are unpublished or unverified. Release assets are hashed in chunks and the Desktop ASAR is extracted to disk rather than buffered; the npm tarball inspection still reads the whole tarball into memory. Existing asset upload remains immutable through `scripts/ensure-release-assets.mjs`.

Recovery applies the same checks to existing immutable draft assets. Missing approval, missing or mismatched pins, incomplete assets, changed bytes or registry mismatch leave the release draft and fail the workflow.

Known recovery gap: if a run stops after the GitHub release is published but before npm `latest` moves, `latest` is safely unchanged, but the adapter, candidate verifier and workflow all require a draft, so a rerun is blocked and recovery is manual. Resuming from a published release must be authenticated against the original reviewed build evidence, not public artifacts alone; that design is deferred to the beta/stable promotion work.

Candidate publication uses `candidate-<version>` (for example, `candidate-0.9.0`), which npm accepts as a dist-tag. Canonical manifest bytes have no trailing newline. Promotion statically inspects the effective packed control-plane catalog; a detached catalog file alone cannot establish admission authority.

## Historical signed-path lifecycle evidence — not pin acceptance

On 2026-10-14, fresh macOS arm64 Base and Privacy Filter component archives were
signed with KMS key version 1 (`koed-components-2026-01`) using the v2 message.
The public control-plane npm tarball was installed offline outside the checkout,
with its embedded production trust roots unchanged. Component installation and
generation activation passed in isolated homes, followed by healthy Personal and
Team startup, shutdown, restart and final shutdown. Team diagnostics verified the
API, database, queues, embedding and Privacy services, Local AI Runtime, API Token,
MCP Server and device identity. No test service processes remained afterward.

This historical run used preinstalled native PostgreSQL and llama.cpp binaries
and cached pinned model files. It is not pin-only acceptance and does not validate
native dependency installation, a fresh Desktop GUI handshake, other platform
targets, upgrade or rollback migration, or production publication. Publication
remained disabled. It imposes no component-signer retention requirement.
Apple Developer ID signing/notarization, unrelated hosted/encryption KMS and
legacy app-runtime provenance remain unchanged.

Assembly audits account for the remote MCP client's exact dynamic import of the
selected MCP runtime contracts. That exception requires the concrete
`@koed/mcp-server` contracts entrypoint in the component dependency closure;
unowned dynamic imports continue to fail closed.
