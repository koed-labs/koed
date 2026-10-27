# Signed macOS Desktop releases

## Boundary and scope

The normal `.github/workflows/release.yml` path builds macOS arm64 DMG/ZIP
with `pnpm desktop:package:release`. electron-builder performs Developer ID
Application signing, built-in notarization, and app stapling. There is no custom
notarizer, isolated signing workflow, or manual asset recovery workflow.

Release-only `mac.sign` delegates one signing pass to pinned `@electron/osx-sign`
`1.3.3`. Signing changes native bytes, so its per-file callback refreshes native
asset hashes then the Desktop runtime manifest after nested signing and before
outer app sealing. electron-builder `26.15.3` still owns notarization/stapling.
This ordering is guarded by version and installed-loop tests, not a general
builder lifecycle guarantee. Upgrades must revalidate order and signed startup.
The adapter preserves signing options and has no automatic signing retries;
errors abort the job. Local/internal builds never select it.

The security boundary is reviewed `main` code plus protected-environment approval.
The `signed-desktop-release-assets` job checks out the immutable triggering SHA
and requires the `desktop-release` environment before any job step runs. Candidate
main build hooks execute in the same process that receives signing credentials.
Approval therefore trusts that code and its build dependencies; it does not isolate
credentials from approved main code. Unmerged PR workflows must not receive these
credentials.

## Administrator prerequisites

Before enabling releases, configure GitHub environment `desktop-release` with
required reviewers and deployment branches restricted to `main`. Review the
candidate SHA before approving the job. YAML names the environment but cannot
configure these repository settings. Do not store Apple signing credentials as
repository-level secrets.

Set these **environment secrets**:

| Name                                    | Value                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `DESKTOP_MACOS_CSC_LINK`                | Base64-encoded Developer ID Application `.p12` containing its private key |
| `DESKTOP_MACOS_CSC_KEY_PASSWORD`        | Nonempty export password for that `.p12`                                  |
| `DESKTOP_MACOS_APPLE_API_KEY_P8_BASE64` | Single-line standard base64 of the Apple App Store Connect API `.p8` key  |
| `DESKTOP_MACOS_APPLE_API_KEY_ID`        | Apple API key ID                                                          |
| `DESKTOP_MACOS_APPLE_API_ISSUER`        | Apple API issuer ID                                                       |

Set environment **variable** `DESKTOP_MACOS_APPLE_TEAM_ID` to the expected Apple
Developer team ID. The certificate must be valid for Developer ID Application
signing, not Apple Distribution. The API key must have access to notarization.
Never commit or print credentials.

The preparation helper requires the complete set before packaging, decodes the
API key to an exclusive owner-readable runner-temporary file, and exports only its
path. Only preparation/packaging steps receive signing secrets. Cleanup runs even
on failure. electron-builder manages its signing keychain lifecycle. Shared
`mac.notarize` stays unset so local/internal unsigned or ad-hoc packaging remains
unchanged; release credentials activate the built-in flow.

## Publication gates and failures

The job cold-builds and validates the native runtime, packages production assets,
and verifies both the output app and the app mounted from the DMG:

- strict deep code-signature integrity and expected bundle/renderer version;
- Developer ID Application authority and exact expected team;
- Gatekeeper execution assessment and `stapler validate`.

Packaged native smoke and artifact-composition/size policy must then pass before
SHA-256 checksums and immutable release upload. Outputs are
`Koed-<version>-arm64.dmg`, `Koed-<version>-arm64.zip`,
`koed-desktop-macos-arm64.sha256`, and the Desktop size report. Existing server,
complete version-matched component-pin catalog, metadata, protected reviewed-build
identity, read-only candidate verification and approved promotion gates remain required before the
GitHub draft can become public. Failed or skipped signing blocks publication.

On failure, fix the issue and rerun the normal pipeline. Existing release assets
are immutable: identical bytes are accepted, differing bytes are rejected rather
than overwritten. A signing rerun can produce different bytes; resolve such a
conflict through a new patch release, not asset replacement. Rebuild old releases
as patch releases. There is no alternate-source or manual recovery path.

## First signed release: clean-Mac acceptance

This check requires an actual authorized signed release; unit tests do not replace
it. Record the release version, asset, macOS version, and result:

1. Download the published DMG or ZIP and checksum file through a browser on a clean
   Mac without development trust overrides.
2. Check `shasum -a 256 -c koed-desktop-macos-arm64.sha256` with both named archives
   downloaded, or verify the downloaded archive against its corresponding line.
3. Open the DMG and drag Koed to Applications, or extract the ZIP. Launch normally,
   preserving download quarantine; do not use Control-click Open or remove xattrs.
4. Confirm Gatekeeper accepts the app without an unidentified-developer bypass,
   and packaged startup/setup reaches the expected local runtime state.
5. Keep the acceptance result with release evidence. A failure is a release blocker,
   not justification for asking Users to disable Gatekeeper.

Internal unsigned builds have a separate trust model; see
[Desktop internal artifacts](desktop-internal-artifacts.md).
