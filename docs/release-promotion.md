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
`app.asar` from the Desktop ZIP. On PR #421 alone, the Desktop workflow produces
**unsigned** artifacts; hashing them is not code signing or notarization. The
#428 signing layer must retain the final signed ZIP and DMG after sealing and
inspection. Neither hash verification nor signing replaces signed/notarized
clean-Mac launch acceptance.
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

## Production protection and authorization

Before enabling publication, repository owner must configure the `production` GitHub environment with required reviewers, prevent self-review, disable administrator bypass, and restrict deployment branches to protected `main`. Restrict repository write access, release creation, workflow changes, environment administration, npm publishers, and npm dist-tag changes to trusted maintainers. Configure npm trusted publishing for this repository, `.github/workflows/release.yml`, and the `production` environment; enable both publish and dist-tag permissions (the latter is separately opt-in). The publication job pins npm 11.21.0, which supports OIDC dist-tag operations. Remove unnecessary npm publishing tokens and other trusted publishers only after the owner verifies the trusted-publisher configuration. Set `KOED_NPM_PUBLICATION_AUTHORIZED=true` separately to confirm npm authorization. These external settings are mandatory and cannot be established by this repository; environment creation alone does not protect publication.

The production environment job starts only after reviewed identity and read-only verification. Reviewers must inspect that run's commit, version, verification results, identity artifact and digest before approving. The job queries GitHub's run approval history and requires an approved `production` review by a human other than both initiating and triggering actors. Missing identities, evidence, or API access fail closed. Only first attempts and stable versions are accepted; reruns must use a new run and fresh review. The adapter repeats the approval check and requires separate npm authorization before mutation. Approval is run-level GitHub evidence, not a cryptographic signature over the identity digest; trusted workflow code and protected settings remain essential. GitHub approval history is not proof of what the reviewer inspected.

The release and draft recovery workflows share one cross-ref concurrency group; other workflows or external publishers are not serialized by it and must be restricted separately. Component authentication needs no external signing service or public-key configuration.

## Promotion checks

The protected public inventory is built from the catalog file alone in the component-catalog artifact and the top-level files in the standalone, native, Desktop, and metadata staging artifacts. Nested component trees are private build outputs, not release assets. Staged distribution manifests, size reports, and any optional provenance signatures are included. Draft inventory and bytes are checked again immediately before the GitHub publication PATCH.

The workflow verifies canonical manifest bytes against the complete version-matched catalog, component/version/target identity, and archive SHA-256/size. Promotion streams release assets directly to files (including assets larger than the subprocess buffer), without replacing them, verifies the npm tarball's exact package/version/SHA-512 integrity against release identity, checks exact registry metadata, publishes only a missing candidate with npm provenance, and delegates action ordering/downgrade prevention to `scripts/release-promotion-lib.mjs`. It publishes the GitHub release first, then re-reads it, checks the exact protected asset inventory for missing, extra or duplicate assets, and re-hashes every asset against the protected build bytes, including Desktop, native and metadata assets. Only then does it move npm `latest`; `latest` is never moved while the matching GitHub components are unpublished or unverified. Release assets are hashed in chunks and the Desktop ASAR is extracted to disk rather than buffered; the npm tarball inspection still reads the whole tarball into memory. Existing asset upload remains immutable through `scripts/ensure-release-assets.mjs`.

The Desktop draft-asset recovery workflow is disabled: its draft-selected source has not been authenticated before privileged execution. Production promotion requires a fresh protected release run and its reviewed identity. Missing approval, missing or mismatched pins, incomplete assets, changed bytes or registry mismatch fail the workflow. A failure before publication leaves the release as a draft; a failure after publication can leave a public GitHub release without a matching `latest` promotion.

### Operator fallback after a partial release

1. Stop further promotion and investigate which GitHub and npm mutations actually succeeded. Record the version, workflow run, approval and artifact evidence, registry state, and any possible user exposure. Preserve the original evidence while it remains available; involve the repository and npm owners.
2. Verify which version `latest` currently points to. Do not move it to the failed candidate without an authenticated, independently authorized recovery; keep the last known-good version as `latest` if it is still there. Do not blindly reset or downgrade a tag that may have changed independently.
3. Assess the public GitHub release and any published npm candidate. Owners should decide how to communicate or handle their visibility based on the actual failure. Do not replace published bytes, reuse a published npm version with different contents, or treat cleanup as authorization to promote it.
4. If the original release cannot be safely recovered, cut a **new version** and run the full build, verification, approval and applicable native/signed acceptance process. A new version is not a shortcut around the existing acceptance gates.

There is no automated cleanup or supported authenticated manual promotion procedure today. Handling public release visibility or registry state may require separate owner decisions and permissions.

### Blocked recovery cases

There is no supported authenticated manual promotion procedure for a release published before npm `latest` moves. Do not move `latest` based on the public release, a digest supplied by the recovery operator, or an approval alone. The adapter, candidate verifier and workflow require a draft; the verifier also rejects a completed failed workflow run. Consequently the existing `--verify-only` command cannot authenticate this published state or a failed original run. Do not edit the release back to a draft to bypass these checks.

A safe recovery path requires all of the following before any mutation:

- Independent trusted evidence tying the original human-reviewed identity artifact ID, artifact digest and JSON SHA-256 to the original repository, protected workflow, commit, stable version, run ID and first attempt; GitHub approval history and protected environment configuration alone do not prove which digest the reviewer inspected. The original identity and all referenced Actions artifacts must remain accessible and unexpired. They expire after 30 days; candidate assets or freshly computed hashes cannot replace them.
- GitHub `actions: read` and `contents: read` access to revalidate the original run, its approval history and artifact origins, plus access to independently verify the repository/environment protections and trusted publisher configuration. Failed runs need an explicitly authenticated recovery verifier; the current origin check accepts only an in-progress or successful run.
- A verifier for the published release that compares the **entire** asset inventory and every asset's bytes with the trusted identity, repeats component and Desktop checks, and validates the exact npm package/version, tarball integrity and registry metadata. The existing draft verifier does not establish this published-release evidence.
- A fresh authorized human recovery decision and exclusive control of all npm dist-tag writers throughout final verification and mutation. Re-read `latest` immediately before any change and reject a newer or invalid version. A local check alone cannot prevent a concurrent external publisher from causing a downgrade; npm dist-tag updates do not provide a compare-and-swap guard here.

For a draft failure, a rerun of the same workflow attempt is forbidden by the first-attempt approval policy. A new protected release run and fresh independent review may promote the draft only if its reviewed build matches every existing immutable draft asset and all normal checks pass; rebuilding is not proof of the original reviewed bytes. If no such new run can be started or matching evidence cannot be established, leave the draft unchanged and escalate to repository/environment and npm administrators. These are prerequisites, not an authorization to bypass the checks. No live configuration, approval, artifact availability or registry state was verified by this document.

Candidate publication uses `candidate-<version>` (for example, `candidate-0.9.0`), which npm accepts as a dist-tag. Canonical manifest bytes have no trailing newline. Promotion statically inspects the effective packed control-plane catalog; a detached catalog file alone cannot establish admission authority.
