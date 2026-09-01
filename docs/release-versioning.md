# Release versioning

Koed uses one product release version. Changesets applies the SemVer bump to the
`@koed/koed` release manifest, and the release-version command synchronizes the
root package, `koed-server`, and Desktop application metadata before the version
pull request is merged.

## Version categories

- **Product release version:** Identifies a Koed distribution. Desktop About,
  API capability discovery, MCP Server initialization, and GitHub Release
  metadata report this value.
- **Artifact version:** Identifies a Desktop, standalone `koed-server`, or native
  runtime artifact. Separately published Koed artifacts use the product release
  version so an Operator can correlate installed components with one release.
- **Internal package version:** Identifies a private workspace package such as
  the API, Worker, Embedding Service, Privacy Service, MCP Server, or a shared
  library. These packages ship inside a versioned distribution and do not bump
  with each product release unless they become separately published artifacts.
- **Compatibility version:** Identifies an API contract, protocol, schema, or
  transport format. Compatibility versions change only when that contract
  changes; they do not follow product releases.

## Release checks

The release check requires the product, root, `koed-server`, and Desktop package
versions to match. It also verifies that Changesets excludes internal workspace
packages and that the GitHub release workflow passes the product version to the
standalone server, native runtime, and release-metadata builders.

Artifact metadata generation rejects a tag or packaged component whose version
does not match the product release. Desktop package verification compares the
application bundle version and renderer release metadata with the expected
Desktop version.

API capability discovery exposes the product value as `releaseVersion`. The
OpenAPI document version remains an API-contract identifier. The MCP Server
advertises the product release version during initialization while its supported
MCP protocol version remains an independent compatibility identifier.
