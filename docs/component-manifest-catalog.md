# Versioned component manifest catalogs

## Trust boundary

An official npm control plane or trusted Desktop artifact authenticates GitHub-hosted Base and Privacy components using embedded canonical-manifest SHA-256 digests. This assumes the control-plane distribution is trusted; it does not authenticate a substituted npm package or hostile registry metadata. See [ADR 0057](adr/0057-versioned-component-manifest-pins.md).

A catalog binds the exact product version, component, optional provider variant, platform, architecture, and declared libc identity. The current release matrix requires Base plus separate CPU and CUDA Privacy variants for Linux x64 (glibc 2.35 minimum), and Base plus the unchanged Privacy bundle for macOS arm64. All five distinct required identities must match; a file count alone is insufficient.

Linux Privacy variants use schema-2 manifests and catalog entries with `variant: cpu` or `variant: cuda`. Their archive names end in `-linux-x64-cpu.tar.gz` and `-linux-x64-cuda.tar.gz`. Base and macOS manifests retain schema 1. A schema-1 catalog cannot authenticate a variant, and a schema-2 catalog rejects missing or conflicting Linux variants. Manifest hashes, installer expectations, component indexes and generation digests keep the two variants distinct. Existing published bytes and pins remain immutable. The explicit CLI accepts `components install --component privacy --variant cpu|cuda` with the matching authenticated source. No runtime environment variable, CLI option, MCP input, or Desktop request supplies production catalog authority.

`KOED_COMPONENT_MANIFEST_CATALOG` is a **build input**, not an Operator configuration setting. A workspace build without it emits a catalog-less module. A component runtime also carries that catalog-less module: Base cannot authenticate itself. Native runtime and model verification are separate.

## Release ordering

The release workflow freezes both component targets before producing any catalog-bearing control plane:

1. `frozen-component-release-assets` builds catalog-less Base/Privacy archives on their native target runners. All packaged files remain in the manifest inventory.
2. `component-manifest-catalog` downloads both immutable target artifacts. `scripts/component-manifest-catalog.mjs` validates canonical manifest bytes, exact version and independently declared complete target identities, then writes `component-manifest-hashes.json`.
3. `scripts/verify-frozen-component-assets.mjs` recomputes the catalog and streams archive digest/size verification against every manifest. The complete catalog and frozen assets travel together in one immutable workflow artifact.
4. Standalone/npm and Desktop packaging depend on that artifact. Workspace rebuilds embed its exact catalog into control-plane code. Runtime staging resets its own catalog module to catalog-less bytes before inventory generation. Packaging must not rebuild the frozen components.
5. Standalone keeps its trusted launcher in `control-plane/`, outside `koed-runtime/`; npm uses `vendor/`. The effective executable module exports its catalog binding. A non-executing syntax inspection follows that binding through package-local ESM imports and compares its literal with the frozen catalog. Candidate code never runs in the promotion credential environment. Desktop inspection reads the trusted Server modules inside `app.asar`, not its catalog-less bundled runtime.
6. Frozen assets are reverified after packaging. Promotion re-downloads the draft assets, checks catalog completeness and archive identity, and compares the unpacked npm executable's catalog before any npm publication or release promotion. Existing npm identity/integrity, immutable asset, approval and Desktop signature/notarization gates remain.

A missing input, wrong version, duplicate identity, partial matrix, changed manifest, changed archive, or mismatched effective packaged catalog fails closed. Read-only inspection helpers are release validation, not runtime override paths. Module-graph checks reject stale builds without catalog imports, but import presence alone does not prove runtime use. Packaged behavioral acceptance must independently accept the pinned fixture and reject a canonical mismatched pin; a catalog export or sidecar check cannot replace that proof.

## Local packaging

A production-like standalone or npm package requires a catalog generated from all frozen target manifests:

```bash
VERSION="$(node -p 'require("./packages/koed-server/package.json").version')"
FROZEN="/absolute/path/to/frozen-components"
pnpm build
node scripts/component-manifest-catalog.mjs "$FROZEN" "$FROZEN/component-manifest-hashes.json" "$VERSION"
node scripts/verify-frozen-component-assets.mjs "$FROZEN" "$FROZEN/component-manifest-hashes.json" "$VERSION"
KOED_COMPONENT_MANIFEST_CATALOG="$FROZEN/component-manifest-hashes.json" pnpm build
KOED_COMPONENT_MANIFEST_CATALOG="$FROZEN/component-manifest-hashes.json" pnpm koed-server:package -- --version "$VERSION" --platform macos --arch arm64 --json
```

Use the actual product version and existing frozen component directory; commands do not generate cross-target components or authorize publication. For temporary local files use repository `scratch/`.

Internal CI/native-runtime testing may explicitly build a standalone artifact with `--catalogless-development`. This mode embeds no catalog authority, rejects a simultaneous release catalog build input, and cannot install components. Public npm packaging has no such mode. It does not provide release-candidate component-admission acceptance.

## Prior-generation ordering and upgrades

Install each new version using its version-matched trusted control plane and new Base/Privacy components. Never compose a new generation from old-version components. Status may describe an owned previous-version selection as incompatible without authenticating its payloads; it does not grant permission to start that selection.

Activation fully verifies the candidate against current compiled pins. Under the existing lifecycle/store locks it then reads bounded, canonical, no-follow metadata for the prior ordinary selection to establish owner and version ordering only. This evidence checks strict schema, contained normalized references, stored/embedded manifest digests and identity agreement, target agreement and recomputed generation identity. It exposes no component roots or runnable generation and does not authenticate historical publisher identity. Malformed prior metadata fails closed; neither old payload reuse nor ignoring corrupt state is an upgrade fallback.

A stopped, same-owner selection can advance to a newer verified generation; genuine downgrades remain rejected and same-version recovery remains supported. Active runtime pins prevent replacement. Failures preserve the selected pointer and release locks. Start and payload reuse still require full verification under current pins.

Desktop ownership discovery and changed-bundle status use a separate bounded,
no-follow journal reader, not full verification of the overwritten application's
old resources or old Privacy pins. A validated private Desktop capability must
match journal ownership and installation resources before replacement; this
journal cannot authorize payload execution. Privacy journals also bind their
canonical generation identity. The matching-owner ordinary-generation fallback
remains available without admitting its payloads through Desktop journal evidence.
Unchanged bundle reuse still requires full verification, and replacement verifies
the new bundled Base and rejects version downgrades under lifecycle/store locks.
Old Privacy is reported incompatible, never attached to the replacement bundle.

## Stopped Desktop management ordering

Within one Desktop manager, stopped Privacy management, setup/doctor authority,
activation, and daemon startup share a serialized operation queue. These paths
must not initialize temporary supervisors concurrently: each verifies and pins
the Desktop generation under the same exclusive lifecycle lock. Queue entries
recheck supervisor state when executed; Privacy cancellation bypasses the queue
so an active installation can still be cancelled. This ordering does not replace
cross-process lifecycle locking or add Desktop ownership of a CLI-started runtime.

The native smoke harness keeps production rate limits unchanged. Its final doctor
check allows one 61-second cooldown only when structured API diagnostics report
HTTP 429 and MCP diagnostics confirm the local rate-limit source. Only known
quota-dependent AI Client capability-unavailability diagnostics may accompany
that failure; unrelated blocking checks reject recovery. Both doctor calls and
the cooldown share a deadline. Both attempts retain artifact-provenance checks;
unknown/remote throttling, other failures, a
stopped supervisor, or a failed final doctor remain failures. This bounded harness
recovery does not validate or fix runtime status-polling amplification.

## Merge and acceptance gates

The stack must be component pin-only before merge: remove component KMS, hosted
signer, signer roots, signature sidecars and component-signing OIDC dependencies.
Do not retain obsolete source/configuration pending acceptance. Protected,
independently reviewed build identity, read-only candidate verification,
publication approval, npm authentication/provenance, immutable assets and SRI remain.
Source cleanup neither authorizes nor requires live cloud or repository-variable changes.

Required acceptance evidence still includes actual native Linux and macOS
Personal/Team component installation/reuse, packaged managed lifecycle and Desktop
boundary checks, npm promotion negatives, signed/notarized clean-Mac Desktop
acceptance, and separate native-runtime/model coverage. A local fixture smoke or
workflow-schema test is not equivalent to those target-specific results. Apple
Developer ID signing/notarization, unrelated hosted/encryption KMS and legacy
app-runtime provenance remain unchanged.
