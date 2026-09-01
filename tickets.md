# Tickets: Consistent Koed release versions

These tickets make one Changesets release version propagate consistently to Koed release artifacts and user-visible integration metadata while preserving independent protocol and internal workspace-package versions.

Work the **frontier**: any ticket whose blockers are all done. After the release-version contract is enforced, the Desktop and MCP Server tickets can proceed in parallel; complete both before the end-to-end verification ticket.

## Enforce Koed's single product release version

**What to build:** Make a Changesets release establish one authoritative Koed product version, synchronize every separately versioned Koed release artifact with it, and prevent internal workspace packages from accidentally becoming independent release units.

**Blocked by:** None — can start immediately.

- [x] The release-version command treats `@koed/koed` as the sole Changesets release unit and synchronizes the root, `koed-server`, and Desktop package versions to its exact SemVer value.
- [x] Every internal workspace package that is not a separately published artifact is excluded from Changesets version selection.
- [x] An automated check fails with an actionable message when the product, root, `koed-server`, or Desktop versions diverge.
- [x] Automated coverage demonstrates that synchronizing a product release does not rewrite independent internal workspace-package versions.
- [x] The single-release-unit policy remains compatible with both a normal version pull request and a subsequent artifact-publishing workflow run.

## Show the released version in Desktop About

**What to build:** Make the Desktop About section show the version of the installed Koed application so an Operator can reliably identify the release they are running.

**Blocked by:** Enforce Koed's single product release version.

- [x] The About section obtains its value from the same Desktop application metadata used to version the packaged artifact.
- [x] No hard-coded historical release number remains in the About rendering path.
- [x] Development and test builds display a deterministic version without weakening the packaged application's source of truth.
- [x] Renderer coverage verifies that About displays the supplied application version.
- [x] Packaged Desktop verification proves that the displayed version matches the release version embedded in the application artifact.

## Advertise the released version from the MCP Server

**What to build:** Make the MCP Server identify itself with the Koed product release version so an AI Client and an Operator can correlate the running integration with a Koed release.

**Blocked by:** Enforce Koed's single product release version.

- [x] MCP initialization metadata reports the authoritative Koed product release version instead of a hard-coded historical value.
- [x] The MCP Server resolves the release version correctly in source, Desktop-bundled, and standalone `koed-server` runtime layouts.
- [x] MCP protocol, schema, and transport versions remain independent compatibility identifiers and are not changed merely because the product release changes.
- [x] Automated coverage verifies both the advertised product version and the unchanged protocol-version boundary.
- [x] Missing or malformed release metadata produces an explicit build or startup failure rather than silently advertising a misleading version.

## Verify release-version propagation end to end

**What to build:** Prove that a Koed release bump reaches every externally meaningful version surface while internal service package and protocol versions remain intentionally independent.

**Blocked by:** Show the released version in Desktop About; Advertise the released version from the MCP Server.

- [x] An automated release-focused check verifies one expected version across the product manifest, root package, `koed-server`, Desktop application metadata, standalone server artifact metadata, and native runtime release metadata.
- [x] The same check verifies that Desktop About, API capability discovery, and MCP initialization expose the expected product release version.
- [x] API contract metadata and protocol/schema versions are tested and documented as independent from the Koed product release version.
- [x] Internal API, Worker, Embedding Service, Privacy Service, MCP Server, and shared-library package versions are not required to equal the product release version unless they become separately published artifacts.
- [x] Release documentation explains which values are product release versions, artifact versions, internal package versions, and compatibility-protocol versions.
- [x] A patch changeset records the corrected user-visible and integration-visible version reporting.
