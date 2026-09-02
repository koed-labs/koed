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
  client-neutral core setup, status, doctor, runtime install, model install,
  and explicit AI Client profile integration contracts.
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
  worker/
    dist/index.js
  embedding-service/
    dist/index.js
    package.json
  mcp-server/
    dist/cli.js
    dist/capture-hook.js
    dist/prompts/codex-global-agent-guidance.md
  node_modules/                     # one shared production dependency graph
    @koed/db/
      dist/index.js
      dist/connection.js
      dist/user-api-token-repository.js
      drizzle/meta/_journal.json
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

Standalone and Desktop packaging now assemble that app runtime through the same
private aggregate staging package. Stable service-path wrappers import the
single hoisted dependency graph. Packaging removes pnpm links and metadata,
tests, source maps, TypeScript inputs, and ordinary package documentation while
preserving licence files and MCP prompt Markdown that is loaded at runtime.

Target pruning retains only the reviewed ONNX Runtime, Sharp, and Argon2 native
payload for the selected operating system and architecture. The exact ONNX
filenames are version-pinned in `config/privacy-runtime-package-policy.json`,
so a dependency layout change fails packaging until reviewed. The separate
`onnxruntime-web` package is omitted: the Transformers Node distribution uses
`onnxruntime-node`, while its web implementation is already part of the
published Transformers bundles.

The pinned q4 Privacy model stores weights in ONNX external data. Core ML does
not resolve that sidecar relative to a file-backed model session, so the
Privacy Filter runtime mounts `onnx/model_q4.onnx_data` explicitly for Core ML.
Apple Silicon package proof must cold-load the exact pruned runtime, verify CPU
and Core ML classifier parity, and perform an authenticated classification.

The Desktop release report keeps Electron-specific size accounting separate:
framework and shell, main, preload, renderer, app runtime, native runtime, and
signature bytes are reported independently. This makes renderer duplication or
an unexpectedly broad `app.asar` dependency graph visible before publication.

## Package responsibilities

### Desktop package (`koed`)

Desktop should contain:

- Electron app shell and renderer;
- node entrypoint runner needed to invoke a local `koed-server` package;
- bundled metadata for supported `koed-server` versions and download locations;
- a minimal packaged fallback `koed-server` runtime during the transition;
- install/update UI for the standalone `koed-server` package;
- UI for core setup, status, doctor, logs, and explicit AI Client profile
  setup/repair actions.

Desktop should not implement dependency detection, DB migration checks, native
runtime install, model install, API Token setup, Supported Capture Hook setup,
or AI Client profile setup directly. It should call `koed-server` contracts and
render their machine-readable output. Mandatory Desktop setup calls only the
client-neutral core contract; client detection never implies profile selection.

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
```

Required `koed-runtime` files:

- `api/dist/index.js`
- `api/node_modules/@koed/db/dist/index.js`
- `api/node_modules/@koed/db/dist/connection.js`
- `api/node_modules/@koed/db/dist/user-api-token-repository.js`
- `api/node_modules/@koed/db/drizzle/meta/_journal.json`
- `worker/dist/index.js`
- `embedding-service/dist/index.js`
- `mcp-server/dist/cli.js`
- `mcp-server/dist/capture-hook.js`
- `mcp-server/dist/prompts/codex-global-agent-guidance.md`

The initial CI artifact build is produced by:

```bash
pnpm build
pnpm koed-server:package -- --platform linux --arch x64 --json
```

The script stages one private aggregate production deployment with a hoisted
dependency graph. Deterministic service wrappers preserve the established
entry paths while dependencies are materialized once under the shared
`koed-runtime/node_modules` root. Disposable `.bin` links and pnpm metadata are
removed before validation, so the final tree has no symlinks or package-store
dependency. The script then
writes `koed-server-package-manifest.json` and `README.txt`, validates the
required runtime files, rejects retired Explorer artifacts, native runtime assets, model files, and Python
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
koed-server-app-runtime-<platform>-<arch>-artifact-size-report.json
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
  "schemaVersion": 2,
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
      "node_modules/@koed/db/dist/index.js",
      "node_modules/@koed/db/dist/connection.js",
      "node_modules/@koed/db/dist/user-api-token-repository.js",
      "node_modules/@koed/db/drizzle/meta/_journal.json"
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

Schema 2 is the shared-staging contract. It intentionally replaces schema 1.
The installer rejects older manifests during validation, before activation,
with an actionable schema error. There is no backward-compatibility window.
Schema 2 keeps one canonical `files` table and does not publish the redundant
`koedRuntimeFiles` inventory.

The manifest records:

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

Archive download, gzip decompression, and tar parsing are streaming operations.
The installer enforces fixed reviewed limits of 2 GiB compressed, 8 GiB
expanded, 200,000 files, 2 GiB per file, 4,096 bytes per path, 8 MiB for the
package manifest, and 1 MiB for a pax header. It rejects traversal, duplicate
normalized paths, links, devices, FIFOs, sockets, malformed headers, and every
unsupported tar entry type. Files are created exclusively with no-follow
semantics where the host supports them, and only executable versus
non-executable permission bits survive extraction. Any failure removes the
temporary extraction tree and leaves the active package unchanged.

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
# Required only when Team collaboration is enabled:
koed-server models install --kind privacy --json
koed-server start --daemon --json
```

On the first packaged, bundled-local, Personal Memory start, `koed-server`
creates the local Personal API Token after database migrations complete and
stores the credential under `KOED_HOME`. A headless Operator does not need to
pre-create a token. External mode still requires an explicitly configured API
Token and never provisions one implicitly.

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

## Non-goals

- Do not add backend LLM synthesis.
- Do not move Memory data out of `KOED_HOME`.
- Do not bundle Python runtime assets.
- Do not merge native runtime artifacts into the app-runtime package.
- Do not make Desktop manage remote Team Self-Hosted or Koed-managed cloud
  service lifecycle.
- Do not decide browser auth, device enrollment, local-edge upstream
  credential semantics, commercial encryption/key management, or managed SaaS
  queryable vector strategy. Those decisions belong to the Team SaaS foundation
  ADRs and are consumed here only as package/runtime requirements.
