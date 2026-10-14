# Koed Desktop release signing and notarization design

**Status:** Design approved in chat; written-spec review required before planning or implementation.

## Intent and success criteria

Ship macOS Koed Desktop release assets with Developer ID Application signing and Apple notarization, stacked on PR #421. Preserve Koed’s existing release contract and gates. Ensure neither normal release nor manual asset recovery can publish unsigned Desktop assets. Keep local/internal packaging unsigned and independent of Apple credentials.

Success means:

- Normal release and recovery use one canonical macOS release pipeline.
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

- **Selected: one complete reusable workflow for release and recovery.** One canonical implementation prevents the recovery path from silently reintroducing unsigned assets. It costs extra source-ref and promotion-tool inputs, so the workflow must own verification and release upload, not only package creation.
- **Duplicate signing logic in both callers.** Smaller initial patch, but release and recovery can drift; rejected because both publish the same trusted artifact class.
- **Custom `notarytool` shell flow and manual DMG creation.** Rejected because electron-builder already performs signed-app notarization/stapling in its packaging lifecycle; a separate script duplicates that behavior and previously drafted assumptions broke the existing artifact pipeline.

Paseo’s direct macOS matrix is a useful signing/smoke pattern, but Koed’s independent recovery workflow makes a shared complete workflow more valuable. Paseo issue #4613 concerns electron-builder `26.8.1`; its unsigned-build launch symptom is unverified and is treated only as a configuration caution, not evidence of a defect in Koed’s installed `26.15.3`.

## Selected architecture

Add `.github/workflows/signed-desktop-release-assets.yml` as a reusable workflow that owns the complete macOS release-asset path: source checkout, native-runtime build/validation, signed package build, smoke and trust checks, artifact inspection, checksum/report generation, and GitHub Release upload. It must not stop at uploading workflow artifacts.

The workflow takes release tag, product version, and immutable source ref as inputs. Normal release calls it from `.github/workflows/release.yml` with the release job’s version/tag and triggering commit. Recovery retains its draft-release and safe-source checks, then calls the same workflow with the resolved release commit. The reusable workflow checks out that source for building and checks out current asset-promotion tooling under `.release-tools`; this preserves recovery’s existing source/tooling separation.

The caller job ID is `signed-desktop-release-assets`. `publish-release.needs` refers to that ID, never to a nested job name or workflow filename. The same caller ID is the dependency in any downstream publication gate.

## Signing credentials and trust boundary

The reusable macOS job declares `environment: desktop-release`. The environment is not present yet. A repository administrator must create it, require reviewer approval, restrict eligible deployment refs to `main`, and add these environment secrets before enabling release use:

- `DESKTOP_MACOS_CSC_LINK`: base64-encoded Developer ID Application `.p12` certificate.
- `DESKTOP_MACOS_CSC_KEY_PASSWORD`: certificate password.
- `DESKTOP_MACOS_APPLE_API_KEY_P8_BASE64`: base64-encoded App Store Connect API `.p8` key.
- `DESKTOP_MACOS_APPLE_API_KEY_ID`: API key ID.
- `DESKTOP_MACOS_APPLE_API_ISSUER`: API issuer ID.

Add non-secret environment variable `DESKTOP_MACOS_APPLE_TEAM_ID` for signature verification. The workflow validates all five secrets and this variable before packaging. It writes the decoded `.p8` only to a runner-temporary file with owner-only permissions, maps certificate values to `CSC_LINK` / `CSC_KEY_PASSWORD`, and maps the API-key path and IDs to electron-builder’s `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. Never print or upload credential material. Use App Store Connect API-key authentication for CI; do not require Apple ID passwords or add Apple credentials to repository-level secrets.

Workflow YAML can reference an environment but cannot configure its required reviewers or ref restrictions. The setup documentation must state that the environment and protections are operational prerequisites. Missing credentials fail closed; release operators must not treat that check as proof that GitHub protection rules are configured.

## Build and verification behavior

Use the production electron-builder packaging path with the supplied credentials; do not call `package:internal:mac`, enable ad-hoc signing, or manually rebuild the app/DMG with `hdiutil`. Leave `mac.notarize` unset in shared configuration rather than setting `true` unconditionally: electron-builder 26.15.3 notarizes when complete Apple credentials are present and skips when none are present. Internal builds receive no Apple credentials; release CI receives them only after environment approval and performs an explicit preflight. This avoids the unconditional-notarization risk reported, but not confirmed, in Paseo issue #4613.

Electron-builder signs the app with Developer ID, submits it for notarization, waits for acceptance, and staples the app before DMG/ZIP targets are produced. The DMG and ZIP contain that same signed, stapled app; do not add a second DMG notarization flow. Verify the app signature, require `Authority=Developer ID Application` and `TeamIdentifier` equal to `DESKTOP_MACOS_APPLE_TEAM_ID`, run Gatekeeper assessment, and validate the stapled ticket. Verify the mounted DMG’s embedded app and run the existing packaged Desktop smoke against the signed package. Any verification failure prevents checksum generation and upload.

Preserve existing DMG/ZIP naming and the artifact-size report. Rename the misleading `koed-desktop-macos-arm64-unsigned.sha256` checksum to `koed-desktop-macos-arm64.sha256`; update release validation and related tests accordingly. Keep `scripts/ensure-release-assets.mjs` as the release upload mechanism. Retain failure diagnostics for smoke failures.

## Recovery and publication safety

Recovery remains limited to draft releases and retains its existing source-version and safe-source checks. It must call the same reusable workflow, use the protected environment, and upload only verified signed assets. `publish-release` remains downstream of the signed asset caller and continues validating all required release assets and metadata; a failed, skipped, or unapproved signing job must never permit publication.

## Documentation and verification scope

Update `apps/desktop/README.md`, `docs/desktop-internal-artifacts.md`, and `docs/running-koed.md` to distinguish signed/notarized release assets from unsigned internal/local artifacts. Add `docs/desktop-notarization.md` with environment creation, reviewer/ref protections, secret formats, and local-vs-CI behavior.

Verify workflow syntax and job dependencies, credential preflight behavior, signature/staple checks, release asset names, recovery eligibility, packaged smoke, artifact inspection, checksum generation, and release publication gates. Keep current pinned GitHub Actions versions and avoid new package dependencies.

## Out of scope

- npm publication and OIDC/KMS provenance work.
- x64, universal, Windows, or Mac App Store packages.
- Changing the local/internal ad-hoc signing path.
- Retaining the draft custom shell-based `scripts/desktop-notarize.mjs`; remove it in favor of electron-builder’s built-in notarization.
- Changing Koed component signing roots or release promotion policy beyond requiring signed Desktop assets.
- Creating GitHub environment settings or secret values from this repository; an administrator must configure them.
