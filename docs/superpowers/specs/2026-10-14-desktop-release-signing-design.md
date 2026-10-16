# Koed Desktop release signing and notarization design

**Status:** Approved for implementation, including the narrowly approved delegating signing adapter needed to finalize runtime manifests. Trust boundary: `main` plus protected-environment approval.

## Intent and success criteria

Ship macOS Koed Desktop release assets with Developer ID Application signing and Apple notarization, stacked on PR #421. Preserve Koed’s existing release contract and gates. Keep one trusted path from `main` to signed release assets, with failures blocking publication. Disable manual asset recovery initially. Keep local/internal packaging unsigned and independent of Apple credentials.

Success means:

- Normal release is the only enabled macOS release-asset pipeline; manual asset recovery is disabled.
- Reviewed `main` code and explicit `desktop-release` environment approval form the signing trust boundary.
- The built `.app` has a valid Developer ID signature, accepted notarization, and a stapled ticket before packaging.
- Smoke, artifact inspection, checksums, release-asset upload, and publication validation still gate release promotion.
- Missing or partial Apple credentials fail before packaging; an artifact without the expected Developer ID signature or stapled ticket fails before upload.
- GitHub Actions uses protected environment `desktop-release`; its repository settings must be configured before release use.

## Current constraints

- `apps/desktop/package.json` distinguishes internal packaging (`KOED_ADHOC_SIGN_MACOS_APP=true`, `CSC_IDENTITY_AUTO_DISCOVERY=false`) from `package:release`.
- `apps/desktop/scripts/after-pack.mjs` keeps ad-hoc signing opt-in. Production packaging must not use the internal command or its environment overrides.
- `.github/workflows/release.yml` currently builds arm64 Desktop assets, runs packaged smoke and artifact inspection, creates checksums, then uploads with `scripts/ensure-release-assets.mjs`. `publish-release` validates required draft assets.
- `.github/workflows/release-desktop-assets.yml` is a separate manual recovery path and currently uploads unsigned assets. It validates the draft release source and checks out current release tooling under `.release-tools`.
- Installed electron-builder is `26.15.3`. Its macOS signer uses `@electron/notarize` and notarizes/staples the app during the signing flow when credentials are supplied. `notarize: false` disables this. API-key variables are `APPLE_API_KEY` (path to `.p8`), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
- Existing release assets are arm64 DMG and ZIP. This change does not add x64/universal artifacts.

## Alternatives considered

- **Selected: one normal release path with electron-builder signing and notarization.** This improves first-launch trust without adding recovery infrastructure before there is a concrete operational need. Trust reviewed `main` code after environment approval.
- **Shared reusable workflow for release and recovery.** Sensible if recovery becomes necessary, but source/tooling separation, recovery eligibility, and cross-workflow coordination are unnecessary complexity now. Defer rather than maintain two signing implementations.
- **Strictly isolated signer.** Rejected for this scope: the approved boundary is `main` plus environment approval, not isolation of candidate build hooks from signing credentials.
- **Custom `notarytool` shell flow and manual DMG creation.** Rejected because electron-builder already performs signed-app notarization/stapling in its packaging lifecycle.

Paseo issue #4613 concerns electron-builder `26.8.1`; its unsigned-build launch symptom is unverified and is treated only as a configuration caution, not evidence of a defect in Koed’s installed `26.15.3`.

## Selected architecture

Keep the complete macOS release-asset path in `.github/workflows/release.yml`: source checkout, native-runtime build/validation, electron-builder signed package build, smoke and trust checks, artifact inspection, checksum/report generation, and GitHub Release upload. Build the immutable triggering commit from `main`, using the normal release version and tag. Do not add a reusable recovery workflow, alternate source inputs, or a separate `.release-tools` checkout.

Disable `.github/workflows/release-desktop-assets.yml` as a manual asset recovery entry point; it must not remain an alternate unsigned upload path. The normal release job is the only signer and Desktop release-asset uploader. `publish-release.needs` must depend on that job and require its success.

## Signing credentials and trust boundary

The normal macOS release job declares `environment: desktop-release`; required approval must occur before the job starts. The environment is not present yet. A repository administrator must create it, require reviewer approval, restrict eligible deployment refs to `main`, and add these environment secrets before enabling release use:

- `DESKTOP_MACOS_CSC_LINK`: base64-encoded Developer ID Application `.p12` certificate.
- `DESKTOP_MACOS_CSC_KEY_PASSWORD`: certificate password.
- `DESKTOP_MACOS_APPLE_API_KEY_P8_BASE64`: base64-encoded App Store Connect API `.p8` key.
- `DESKTOP_MACOS_APPLE_API_KEY_ID`: API key ID.
- `DESKTOP_MACOS_APPLE_API_ISSUER`: API issuer ID.

Add non-secret environment variable `DESKTOP_MACOS_APPLE_TEAM_ID` for signature verification. The workflow validates all five secrets and this variable before packaging. It writes the decoded `.p8` only to a runner-temporary file with owner-only permissions, maps certificate values to `CSC_LINK` / `CSC_KEY_PASSWORD`, and maps the API-key path and IDs to electron-builder’s `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. Never print or upload credential material. Use App Store Connect API-key authentication for CI; do not require Apple ID passwords or add Apple credentials to repository-level secrets.

Workflow YAML can reference an environment but cannot configure its required reviewers or ref restrictions. The setup documentation must state that the environment and protections are operational prerequisites. Missing credentials fail closed; release operators must not treat that check as proof that GitHub protection rules are configured.

### Approved security boundary

The intended boundary is reviewed `main` code plus protected-environment approval. Electron-builder's built-in signing flow runs candidate `main` build hooks in the same process that receives signing credentials. Those hooks and reviewed release code are trusted after approval; this design does not isolate them from secrets. Unmerged PR workflows must not receive signing secrets or enter this release path. Environment reviewers must approve the exact release commit and workflow they are trusting.

## Build and verification behavior

Use the production electron-builder packaging path with the supplied credentials; do not call `package:internal:mac`, enable ad-hoc signing, or manually rebuild the app/DMG with `hdiutil`. Leave `mac.notarize` unset in shared configuration rather than setting `true` unconditionally: electron-builder 26.15.3 notarizes when complete Apple credentials are present and skips when none are present. Internal builds receive no Apple credentials; release CI receives them only after environment approval and performs an explicit preflight. This avoids the unconditional-notarization risk reported, but not confirmed, in Paseo issue #4613.

### Approved manifest-finalization adapter

Runtime manifests hash nested native binaries. Developer ID signing changes those bytes, so preparation-time hashes cannot remain authoritative. Release-only `mac.sign` delegates exactly once to public `@electron/osx-sign` `signAsync`, preserving builder-generated signing options. Its synchronous `optionsForFile` wrapper finalizes native-asset hashes, then the complete Desktop runtime manifest, when called for the exact outer app path: nested signing has completed, but the outer resource seal has not been created. Preserve metadata and symlink checks, include signing-generated files, and never relax runtime verification. Share inventory logic with runtime preparation.

Pin electron-builder `26.15.3` and explicitly depend on `@electron/osx-sign` `1.3.3`. This callback-order dependency is narrower than a supported lifecycle hook: guard the installed version and test the installed signing loop with simulated commands, including awaited child completion before finalization. Missing/repeated outer callbacks and finalization errors fail closed. The adapter does not retry signing automatically; failures abort the job and use the normal rerun policy. Local/internal builds do not select the adapter. This is one delegated signing pass, not a second signer, manual `codesign`, or custom notarizer. A dependency upgrade requires revalidating ordering and real signed-package startup.

Electron-builder submits the signed app for notarization, waits for acceptance, and staples the app before DMG/ZIP targets are produced. The DMG and ZIP contain that same signed, stapled app; do not add a second DMG notarization flow. Verify the app signature, require `Authority=Developer ID Application` and `TeamIdentifier` equal to `DESKTOP_MACOS_APPLE_TEAM_ID`, run Gatekeeper assessment, and validate the stapled ticket. Verify the mounted DMG’s embedded app and run the existing packaged Desktop smoke against the signed package. Any verification failure prevents checksum generation and upload.

Preserve existing DMG/ZIP naming and the artifact-size report. Rename the misleading `koed-desktop-macos-arm64-unsigned.sha256` checksum to `koed-desktop-macos-arm64.sha256`; update release validation and related tests accordingly. Keep `scripts/ensure-release-assets.mjs` as the release upload mechanism. Retain failure diagnostics for smoke failures.

## Failure handling and publication safety

Manual asset recovery is disabled initially. If a release build fails, fix the cause and rerun the normal pipeline through its normal approval and verification gates. If an old release needs rebuilding, ship a patch release rather than replacing its assets through a recovery workflow. Recovery eligibility logic, source/tooling separation, and cross-workflow coordination are out of scope until a concrete operational need exists.

`publish-release` remains downstream of the normal signed asset job and continues validating all required release assets and metadata. Signature/staple checks, packaged smoke, artifact inspection, and checksums must pass before publication. A failed, skipped, or unapproved signing job must never permit publication.

## Documentation and verification scope

Update `apps/desktop/README.md`, `docs/desktop-internal-artifacts.md`, and `docs/running-koed.md` to distinguish signed/notarized release assets from unsigned internal/local artifacts. Add `docs/desktop-notarization.md` with environment creation, reviewer/ref protections, secret formats, and local-vs-CI behavior.

Verify workflow syntax and job dependencies, credential preflight behavior, signature/staple checks, release asset names, disabled manual recovery, packaged smoke, artifact inspection, checksum generation, and release publication gates. Confirm release execution is limited to `main` and approval is required before the signing job starts. Keep current pinned GitHub Actions versions. The only new package dependency is the approved exact `@electron/osx-sign` adapter dependency above.

For the first signed release, download the published release asset on a clean Mac without development credentials or prior local trust overrides, launch it through the normal download/open flow, and confirm expected Gatekeeper behavior and successful startup. Record the result as first-release validation; this complements automated pre-publication checks.

## Out of scope

- npm publication and OIDC/KMS provenance work.
- x64, universal, Windows, or Mac App Store packages.
- Changing the local/internal ad-hoc signing path.
- Retaining the draft custom shell-based `scripts/desktop-notarize.mjs`; remove it in favor of electron-builder’s built-in notarization.
- Changing Koed component signing roots or release promotion policy beyond requiring signed Desktop assets.
- Creating GitHub environment settings or secret values from this repository; an administrator must configure them.
