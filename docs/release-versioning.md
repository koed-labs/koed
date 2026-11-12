# Release versioning

Koed uses one product release version. Changesets applies the SemVer bump to the
`@koed-labs/koed` release manifest, and the release-version command synchronizes the
root package, `@koed-labs/server`, standalone Koed distribution, and Desktop
application metadata before the version pull request is merged. After Changesets
versions packages, release synchronization adds the matching Desktop changelog
heading and merges the current product and server release notes into the root
changelog. Existing history is retained and repeated synchronization does not
repeat entries.

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

## Source runtime pin updates

A pin fixes a download URL and its checksum. A checksum is a value calculated
from file contents. The source runtime catalog lists approved CPU/CUDA pins.

`pnpm release:version` updates the product version and runs
`pnpm source-runtime:refresh`. Changesets includes changes to
`config/source-runtime-catalogs.json` in the Version Koed PR. Before merging the
PR, review the generated file. Startup reads it without looking for newer
catalogs.

Refresh selects the newest published stable release at or below the checkout
version. Its catalog must meet the minimum core version. Refresh keeps the
original runtime versions and enforces supported formats, interfaces, platforms,
and matching llama.cpp revisions. Drafts and prereleases do not qualify.

A product version change alone does not require a runtime rebuild. A Version
Koed PR for v0.11.2 can keep compatible v0.11.1 downloads. After the release
workflow publishes v0.11.2, a later PR can select its downloads.

A manifest lists the files in an archive. For a new release, refresh downloads
the catalog, both archives, and both manifests from the official repository
through the GitHub API. It makes sure that their sizes and SHA-256 checksums
match the GitHub records and catalog. It also makes sure that manifest
identities and compatibility details match the catalog. Only then does it
replace the committed file.

Refresh keeps unchanged pins. It rejects older releases or changed catalog
bytes under an already reviewed release tag. Missing compatible releases,
unsupported interfaces, or checksum failures stop the update. If a raised
minimum excludes all published runtimes, publish a compatible runtime or revise
the release plan. Refresh never lowers the minimum.

After `pnpm install`, run one of these commands from the repository root:

```bash
pnpm source-runtime:refresh
# Or require a particular published stable release:
pnpm source-runtime:refresh -- --release v0.11.1
```

Review the generated changes. Commit the file. `GH_TOKEN` can authenticate
GitHub reads. The release workflow supplies its existing token. Refresh does
not publish or edit releases. Source preparation and installation still require
approved URLs and matching manifest, archive, and extracted-file checksums.

The existing CI Build job reuses compiled output to install the CPU runtime into
an empty `KOED_HOME` on Linux x64. It runs short tests of the installed programs.
It does not test Desktop onboarding or run the embedding model. Hosted CI
runners have no GPU.

Build recipes specify how to build the runtime. If a build recipe or archive
checksum changes, test CPU/CUDA setup on a real Linux/WSL NVIDIA host before
merging. Use the
[source setup procedure](running-koed.md#test-source-setup-with-a-fresh-home)
to test GPU model execution and CPU fallback. Record the recipe IDs and archive
checksums with the results.

`config/source-component-catalog.json` supplies reviewed Base/Privacy downloads.
Refresh leaves it unchanged. These optional downloads require an exact
product-version match. Source services run from the checkout even if this
catalog is absent or older. Official release builds use their own complete
native and component catalogs.

## Release checks

The release check requires the product, root, `@koed-labs/server`, and Desktop
package versions to match. Changesets keeps public `@koed-labs/server` and
private `@koed-labs/koed` in one coordinated release group while excluding internal
workspace packages. The GitHub release workflow passes exact product version to
standalone component, native runtime, Desktop, and release-metadata builders.

GitHub draft assets are immutable: retries verify existing bytes and only add
missing assets. npm versions are immutable; candidate publication, registry
verification, `latest` promotion, and GitHub publication must run in that order.
Missing or mismatched complete version-matched manifest pins, protected independently
reviewed build identity, read-only candidate verification, npm trusted-publishing
authentication/provenance, SRI, or independent promotion approval blocks publication.
Component KMS/signing configuration is not required; the stack must be pin-only
before merge. Actual native Personal/Team and signed/notarized clean-Mac acceptance
remain gates.

Artifact metadata generation rejects a tag or packaged component whose version
does not match the product release. Desktop package verification compares the
application bundle version and renderer release metadata with the expected
Desktop version.

API capability discovery exposes the product value as `releaseVersion`. The
OpenAPI document version remains an API-contract identifier. The MCP Server
advertises the product release version during initialization while its supported
MCP protocol version remains an independent compatibility identifier.
