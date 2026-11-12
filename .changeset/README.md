# Changesets

Changesets coordinates `@koed-labs/koed` and the public `@koed-labs/server`
package in one fixed release group. They share the product release version.

Add a changeset for release-noteworthy changes that should appear in the Koed
changelog. Select `@koed-labs/koed` and choose the SemVer bump for the Koed
product as a whole; the fixed group coordinates the server package version.

Do not select internal workspace packages unless they become separately
versioned release artifacts.

See `docs/release-versioning.md` for the distinction between product, artifact,
internal package, and compatibility versions.
