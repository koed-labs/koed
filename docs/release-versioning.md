# Release versioning

Koed uses one product release version. Changesets applies the SemVer bump to the
`@koed/koed` release manifest, and the release-version command synchronizes the
root package, `@koed-labs/server`, standalone Koed distribution, and Desktop
application metadata before the version pull request is merged.

## Version categories

- **Product release version:** Identifies a Koed distribution. Desktop About,
  API capability discovery, MCP Server initialization, and GitHub Release
  metadata report this value.
- **Artifact version:** Identifies a Desktop, standalone base/privacy component,
  public `@koed-labs/server` package, or native runtime artifact. Separately
  published Koed artifacts use product release version so Operator can
  correlate installed components with one release.
- **Internal package version:** Identifies a private workspace package such as
  the API, Worker, Embedding Service, Privacy Service, MCP Server, or a shared
  library. These packages ship inside a versioned distribution and do not bump
  with each product release unless they become separately published artifacts.
- **Compatibility version:** Identifies an API contract, protocol, schema, or
  transport format. Compatibility versions change only when that contract
  changes; they do not follow product releases.

## Release checks

The release check requires the product, root, `@koed-labs/server`, and Desktop
package versions to match. Changesets keeps public `@koed-labs/server` and
private `@koed/koed` in one coordinated release group while excluding internal
workspace packages. The GitHub release workflow passes exact product version to
standalone component, native runtime, Desktop, and release-metadata builders.

GitHub draft assets are immutable: retries verify existing bytes and only add
missing assets. npm versions are immutable; candidate publication, registry
verification, `latest` promotion, and GitHub publication must run in that order.
Empty production signer/trust-root configuration, missing npm trusted-publishing
authorization, or absent independent promotion approval blocks publication.

Artifact metadata generation rejects a tag or packaged component whose version
does not match the product release. Desktop package verification compares the
application bundle version and renderer release metadata with the expected
Desktop version.

API capability discovery exposes the product value as `releaseVersion`. The
OpenAPI document version remains an API-contract identifier. The MCP Server
advertises the product release version during initialization while its supported
MCP protocol version remains an independent compatibility identifier.
