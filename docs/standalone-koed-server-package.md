# Standalone koed-server package design

KOE-292 defines the target distribution shape for a standalone `koed-server`
package that Koed Desktop can install or update on demand, while preserving a
separate headless install path for Operators.

## Decision summary

Koed should move toward a **thin Desktop plus standalone `koed-server` package**
model, with the current fully bundled Desktop remaining as a fallback until the
standalone install/update path is proven.

- Desktop remains the Operator-facing control surface.
- `koed-server` remains the local control plane and owns service lifecycle,
  setup, status, doctor, runtime install, model install, and AI-client
  integration contracts.
- The standalone `koed-server` package contains the JS/service runtime needed to
  run Koed app processes.
- Native runtime artifacts remain a separate artifact line for Postgres,
  pgvector, and `llama-server`.
- Model artifacts remain separate and install under `KOED_HOME/models`.
- Python is excluded from this design. The supported Embedding Service runtime is
  the TypeScript service plus `llama-server`.

This preserves Koed Self-Hosted boundaries: local runtime and Memory data live
under `KOED_HOME`; Desktop is a control surface; server-side LLM synthesis is
not added.

## Current packaged Desktop shape

Current Desktop packaging prepares `apps/desktop/.koed-runtime` and then embeds
it under Electron resources. The packaged `koed-runtime` contains:

```text
koed-runtime/
  api/
    dist/index.js
    node_modules/@koed/db/dist/index.js
    node_modules/@koed/db/drizzle/meta/_journal.json
  worker/
    dist/index.js
  embedding-service/
    dist/index.js
    package.json
  mcp-server/
    dist/cli.js
    dist/capture-hook.js
  explorer-dist/
    index.html
  runtime-asset-manifest.json        # only when native assets are staged
  postgres/                          # optional packaged native runtime asset
  llama.cpp/                         # optional packaged native runtime asset
```

This is validated today by:

- `apps/desktop/scripts/prepare-koed-runtime.mjs`
- `packages/koed-server/src/app-runtime.ts`
- packaged Desktop smoke tests
- packaged runtime status/install for native assets

This shape works, but it makes `Koed.app` carry both the Electron control plane
and the local server runtime. The internal unsigned app has already been large
enough to motivate splitting the server runtime into its own package.

## Package responsibilities

### Desktop package (`koed`)

Desktop should contain:

- Electron app shell and renderer;
- node entrypoint runner needed to invoke a local `koed-server` package;
- bundled metadata for supported `koed-server` versions and download locations;
- a minimal packaged fallback `koed-server` runtime during the transition;
- install/update UI for the standalone `koed-server` package;
- UI for setup, status, doctor, logs, Codex setup, and repair actions.

Desktop should not implement dependency detection, DB migration checks, native
runtime install, model install, API Token setup, Supported Capture Hook setup,
or Codex setup directly. It should call `koed-server` contracts and render their
machine-readable output.

### Standalone `koed-server` package

The standalone package should contain the JS/service app runtime:

```text
koed-server-<version>-<platform>-<arch>/
  koed-server-package-manifest.json
  README.txt
  bin/
    koed-server                       # platform launcher or wrapper
  koed-runtime/
    api/
    worker/
    embedding-service/
    mcp-server/
    explorer-dist/
```

Required `koed-runtime` files:

- `api/dist/index.js`
- `api/node_modules/@koed/db/dist/index.js`
- `api/node_modules/@koed/db/drizzle/meta/_journal.json`
- `worker/dist/index.js`
- `embedding-service/dist/index.js`
- `mcp-server/dist/cli.js`
- `mcp-server/dist/capture-hook.js`
- `explorer-dist/index.html`

The initial CI artifact build is produced by:

```bash
pnpm build
pnpm koed-server:package -- --platform linux --arch x64 --json
```

The script stages production JS/service runtime files with `pnpm deploy`,
writes `koed-server-package-manifest.json` and `README.txt`, validates the
required runtime files, rejects native runtime assets, model files, and Python
embedding leftovers, then emits a deterministic tarball and `.sha256` under
`dist/koed-server-package/<platform>-<arch>/`.

The release workflow publishes supported standalone app-runtime targets as
GitHub Release assets:

```text
koed-server-<version>-<platform>-<arch>.tar.gz
koed-server-<version>-<platform>-<arch>.tar.gz.sha256
koed-server-app-runtime-<version>-<platform>-<arch>.manifest.json
koed-server-app-runtime-<version>-<platform>-<arch>.provenance.json
koed-server-app-runtime-<version>-<platform>-<arch>.provenance.json.sig
koed-release-artifacts-<version>.json
```

The release metadata JSON separates Desktop assets, `koed-server`
app-runtime packages, native runtime artifacts, and model artifacts so Desktop
or headless install flows can reference the supported package versions and
download URLs without treating native runtime or model assets as part of the
app-runtime package.

The package may be platform-specific even when most contents are JS. Platform
specificity is useful for launchers, packaged Node runtime decisions, signature
metadata, and install policy. Linux should distinguish at least `linux-x64` and
future `linux-arm64`; macOS should distinguish `macos-arm64` and future
`macos-x64` if shipped.

### Native runtime artifacts

Native runtime artifacts stay separate from the standalone app-runtime package:

```text
koed-native-runtime-<platform>-<arch>-<version>.tar.gz
  koed-runtime/
    runtime-asset-manifest.json
    postgres/
    llama.cpp/
```

They remain installed through `koed-server runtime status/install` under:

```text
KOED_HOME/runtime/postgres
KOED_HOME/runtime/llama.cpp
```

Keeping these artifacts separate avoids forcing every Desktop update to carry
native database/runtime bytes. It also keeps Homebrew-backed provisioning and
future Koed-hosted native tarballs behind the same `koed-server` runtime
contract.

### Model artifacts

Embedding and reranker model artifacts stay separate and install under:

```text
KOED_HOME/models
```

Desktop first-run may ask `koed-server` to run `models status/install`, but the
standalone `koed-server` package should not embed model files.

## Install locations

Recommended install layout:

```text
KOED_HOME/
  config/
  run/
  logs/
  data/
  models/
  cache/
    koed-server-packages/
      koed-server-<version>-<platform>-<arch>.tar.gz
      koed-server-<version>-<platform>-<arch>.tar.gz.sha256
  runtime/
    koed-server/
      current -> versions/<version>
      versions/
        <version>/
          koed-server-package-manifest.json
          bin/koed-server
          koed-runtime/
    postgres/
    llama.cpp/
```

`KOED_HOME/runtime/koed-runtime` is the current app-runtime location. The
standalone package should introduce `KOED_HOME/runtime/koed-server/current` as
the package root and keep `koed-runtime/` inside that root. During migration,
`app-runtime.ts` can support both shapes:

1. explicit `KOED_SERVER_PACKAGE_ROOT` or `KOED_JS_RUNTIME_ROOT`;
2. `KOED_HOME/runtime/koed-server/current/koed-runtime`;
3. legacy `KOED_HOME/runtime/koed-runtime`;
4. packaged Desktop resources;
5. source checkout fallback only for development.

Installing the server package under `KOED_HOME` keeps the local personal runtime
Operator-owned and easy to back up or remove with Koed state. Desktop may keep a
copy in its app-support cache, but `KOED_HOME` should remain the authoritative
runtime for the active local server.

## Package manifest

Each standalone package should include a manifest:

```json
{
  "schemaVersion": 1,
  "id": "koed-server",
  "version": "0.4.0",
  "platform": "macos",
  "architecture": "arm64",
  "packageKind": "app-runtime",
  "createdAt": "2026-07-07T00:00:00.000Z",
  "minimumDesktopVersion": "0.4.0",
  "maximumDesktopMajor": 0,
  "nodeRuntime": {
    "mode": "desktop-electron-node",
    "minimumNodeMajor": 22
  },
  "koedRuntime": {
    "path": "koed-runtime",
    "requiredFiles": [
      "api/dist/index.js",
      "worker/dist/index.js",
      "embedding-service/dist/index.js",
      "mcp-server/dist/cli.js",
      "mcp-server/dist/capture-hook.js",
      "explorer-dist/index.html",
      "api/node_modules/@koed/db/dist/index.js",
      "api/node_modules/@koed/db/drizzle/meta/_journal.json"
    ]
  },
  "database": {
    "migrationSet": "<hash-or-version>",
    "allowsRollback": false
  },
  "nativeRuntime": {
    "compatibleManifestSchema": 1,
    "requires": ["postgresql@17", "pgvector", "llama-server"]
  },
  "models": {
    "embedding": "qwen3-0.6b",
    "reranker": "qwen3-reranker-0.6b"
  },
  "provenance": {
    "sourceRepository": "owner/repo",
    "sourceCommit": "<git-sha>",
    "sourceRef": "refs/tags/v0.4.0",
    "buildWorkflow": "release",
    "buildRunId": "123"
  },
  "sha256": "<tree-or-archive-sha256>",
  "files": [{ "path": "koed-runtime/api/dist/index.js", "sha256": "..." }]
}
```

The exact field names may change during implementation, but the manifest must
answer:

- which Desktop versions may install this package;
- which platform/architecture it targets;
- which app-runtime files must exist;
- which DB migration set it contains;
- which native runtime manifest schema it expects;
- which model definitions it knows about;
- how to verify package integrity.

## Verification and trust model

Desktop and headless install flows should verify before activation:

1. download archive to `KOED_HOME/cache/koed-server-packages` or an explicit
   Operator-selected cache;
2. verify archive SHA-256 against a release manifest;
3. extract into a temporary directory under `KOED_HOME/runtime/koed-server`;
4. verify `koed-server-package-manifest.json`;
5. verify every expected file and file hash;
6. validate platform/architecture compatibility;
7. validate Desktop/server compatibility;
8. atomically update `current` pointer or marker;
9. run `koed-server status --json` or a package validation command before
   startup continues.

Signature/provenance rules:

- Signed/notarized Desktop remains required for macOS end-user distribution.
- Standalone `koed-server` archives must continue to be SHA-256 verified.
- Release builds also emit a provenance sidecar that records the source
  repository, source commit/ref, build workflow/run id, package target, package
  manifest hash, package file-tree hash, and produced archive hash.
- If `KOED_SERVER_PACKAGE_SIGNING_PRIVATE_KEY_PEM` or
  `KOED_SERVER_PACKAGE_SIGNING_PRIVATE_KEY_FILE` is present during artifact
  build, the provenance statement is signed with Ed25519 and a detached `.sig`
  sidecar is written. If no signing key is present, the provenance is explicitly
  marked `unsigned-placeholder`.
- Package install can require `--trust-policy require-provenance` or
  `--trust-policy require-signature`. Signature validation uses an Ed25519 PEM
  public key from `--trusted-public-key`, `--trusted-public-key-file`, or
  `KOED_SERVER_PACKAGE_TRUSTED_PUBLIC_KEY_PEM`.
- Local and bundled fallback installs keep the SHA-256 path unless an Operator
  or Desktop configuration opts into stricter policy.
- Native runtime archives keep their own manifest/SHA-256 verification.

Downgrade and rollback rules:

- Automatic downgrade is not allowed.
- Installing an older `koed-server` over a newer active runtime requires an
  explicit Operator confirmation and must first check DB migration compatibility.
- Rollback can switch back to a previous package only if the current DB schema is
  compatible with that package's migration set.
- If DB migrations have advanced beyond the previous package, rollback should
  fail with repair guidance rather than attempting reverse migrations.

## Compatibility rules

Compatibility should be checked in this order:

1. **Desktop ↔ `koed-server` package**: Desktop may install supported server
   versions declared in package metadata. A too-old Desktop must tell the
   Operator to update Desktop.
2. **`koed-server` package ↔ `KOED_HOME` state**: server checks config schema,
   runtime state schema, and DB migration status before declaring healthy.
3. **`koed-server` package ↔ native runtime**: bundled-local requires compatible
   Postgres/pgvector and `llama-server` assets, reported by runtime status.
4. **`koed-server` package ↔ models**: model status verifies installed model
   key/path/checksum where available.
5. **AI Client Integration**: setup/status verifies that the Codex MCP Server
   points at the active API URL/token and the credential-free Supported Capture
   Hook command points at the installed runtime.

DB migrations are the strongest compatibility boundary. Desktop should not swap
server packages while services are running. Update flow should stop the local
supervisor, install/verify the package, start the new server, then let the new
server run normal migration readiness checks.

## Desktop first-run flow

Packaged Desktop local-personal first-run should use this flow:

1. Resolve `KOED_HOME`.
2. Determine desired `koed-server` package version from Desktop metadata or
   update channel.
3. Run package status:
   - installed and compatible;
   - missing;
   - incompatible Desktop;
   - incompatible platform/architecture;
   - checksum/provenance failure;
   - partial install;
   - downgrade blocked.
4. If missing/incompatible, prompt the Operator before network download unless
   the package is bundled with Desktop.
5. Download or copy package from bundled/offline source.
6. Verify and install to `KOED_HOME/runtime/koed-server/versions/<version>`.
7. Activate `current`.
8. Start managed `koed-server` through the package launcher.
9. Run `runtime status/install` for native assets.
10. Run `models status/install` for embedding model assets.
11. Run `status` and `doctor` until ready or actionable.
12. Run/fix Codex integration setup when needed.

Desktop should show failure states as first-class UI states:

- **Server package missing**: install action available.
- **Download unavailable**: retry, use local artifact, or quit.
- **Verification failed**: delete cached artifact and retry; do not activate.
- **Package incompatible with Desktop**: update Desktop.
- **Package incompatible with existing `KOED_HOME`**: show doctor output and do
  not start.
- **Native runtime missing**: run packaged/Homebrew runtime install flow.
- **Model missing**: run model install flow.
- **Startup failed**: link logs and `doctor --json` output.

## Headless Operator install flow

Headless install should not require Desktop, but the first standalone package
install still needs a trusted bootstrap binary. The bootstrap path must be
explicit rather than implied by the package being installed. Acceptable
bootstrap sources are:

- the bundled fallback `koed-server` launcher embedded in Desktop;
- a previous compatible `koed-server` install already present under
  `KOED_HOME`;
- a minimal signed/notarized installer or package-manager entrypoint such as a
  future Homebrew formula;
- a local source-checkout launcher for development only.

The bootstrap entrypoint may install, verify, activate, and hand off to a
standalone package, but it must not silently select bundled-local dependency
ownership unless the selected setup profile or dependency mode permits that.
Hosted downloads should use `require-signature` once Koed has selected and
published the release trust root. Until then, release workflows may publish
unsigned-placeholder provenance only for non-default/test channels.

Recommended command shape after a bootstrap entrypoint is available:

```bash
koed-server package status --json
koed-server package install \
  --source https://downloads.koed.local/koed-server-<version>-linux-x64.tar.gz \
  --sha256 <sha256> \
  --provenance-file /path/to/koed-server-app-runtime-<version>-linux-x64.provenance.json \
  --signature-file /path/to/koed-server-app-runtime-<version>-linux-x64.provenance.json.sig \
  --trusted-public-key-file /path/to/koed-server-package.pub.pem \
  --trust-policy require-signature \
  --json
koed-server runtime install --provider packaged --dependency-mode bundled-local --json
koed-server models install --kind embedding --json
koed-server start --daemon --json
```

Offline install should use a local artifact path:

```bash
koed-server package install \
  --source /path/to/koed-server-<version>-linux-x64.tar.gz \
  --sha256-file /path/to/koed-server-<version>-linux-x64.tar.gz.sha256 \
  --json
```

External dependency mode remains explicit. A headless Operator can install only
the app-runtime package and point `server.json` at Operator-managed Postgres,
Redis/BullMQ, and Embedding Service endpoints. In external mode, package install
must not install native runtime assets or models unless the Operator explicitly
runs those commands.

## Offline and network behavior

Desktop and CLI should support three package sources:

1. **Bundled fallback**: a minimal `koed-server` package shipped inside Desktop.
2. **Hosted download**: update-channel URL declared by Desktop or config.
3. **Local artifact**: Operator-selected tarball plus checksum.

Network failures should never leave an active runtime half-upgraded. Failed
archives remain in cache only if useful for retry diagnostics; otherwise they
are removed. Partial extraction directories should be cleaned automatically or
reported as repairable state.

## Cleanup and upgrade behavior

Package install should keep at least one previous compatible version by default:

```text
KOED_HOME/runtime/koed-server/versions/<previous>
KOED_HOME/runtime/koed-server/versions/<current>
```

A cleanup command should remove inactive versions and stale cached archives:

```bash
koed-server package cleanup --keep 1 --json
```

Desktop should expose cleanup only as an advanced repair/storage action.
Automatic cleanup should not delete the currently active or last-known-good
package.

## Implementation follow-ups

KOE-292 is design-first. Recommended follow-up implementation issues:

1. KOE-300: Build standalone `koed-server` package artifact in CI.
2. KOE-298: Add package manifest, status, install, activate, and cleanup CLI commands.
3. KOE-302: Teach app-runtime resolution to use `KOED_HOME/runtime/koed-server/current`.
4. KOE-303: Add Desktop first-run package installer/update UI.
5. KOE-301: Add release workflow publishing for `koed-server` package artifacts.
6. KOE-299: Add package signature/provenance hardening.
7. Add headless install documentation and smoke coverage as part of the package CLI and CI follow-ups.

## Non-goals

- Do not add backend LLM synthesis.
- Do not move Memory data out of `KOED_HOME`.
- Do not bundle Python runtime assets.
- Do not merge native runtime artifacts into the app-runtime package.
- Do not make Desktop manage remote Team Self-Hosted or Koed-managed cloud
  service lifecycle.
- Do not decide Explorer-first auth, device enrollment, local-edge upstream
  credential semantics, commercial encryption/key management, or managed SaaS
  queryable vector strategy. Those decisions belong to the Team SaaS foundation
  ADRs and are consumed here only as package/runtime requirements.
