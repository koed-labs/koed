# Koed Desktop

Koed Desktop is the Electron control surface for Koed.

It wraps the same local `koed-server` command surface, shows service status,
runs the first-time Codex setup and health checks automatically, and provides
the local Project, Captured Session, and raw Conversation UI in one window.

The main Desktop experience is Project-first. On wide windows it uses a
persistent master-detail workspace: active and disclosed inactive local
Projects remain in the master list while the detail pane shows the selected
Project's Captured Sessions or a raw Conversation. Narrow windows deliberately
switch to list → Project → Conversation drill-down, with breadcrumb controls
returning to the previous level. Project and Captured Session names, source AI Client when available, activity,
counts, and Conversation previews form the primary scanning hierarchy; local
paths, Git identity, discovery provenance, and manual assignment controls sit
in secondary disclosures.

Opening a Captured Session loads its Memory Events through an exact, typed
Electron IPC operation and renders the raw Conversation inside the Desktop.
The managed `koed-server` supervisor provisions and rotates the reusable
Personal API Token through the active runtime database and token pepper.
Electron main retains that supervisor-owned credential in memory, rereads it
after an unauthorized response, derives the loopback local API authority, and
performs the allowlisted Project graph, Memory Event page, and Captured Session
Project-assignment requests. Preload validates each operation and result in
both directions. The renderer receives domain data and typed loaders/callbacks
only; it never receives an API Token, Authorization header, API base URL,
generic request path, or remote authority for these Personal Memory operations.
Desktop and Explorer share the virtualized timeline contract, so long
Conversations retain bounded rendering and older-event pagination without
coupling their navigation shells. Persisted Project discovery metadata is
merged with captured Memory activity locally, so a discovered Project can
remain visible before its first Captured Session.
Settings includes a collapsed, optional Team Backend setup/readiness
disclosure. Users paste only a plain HTTP(S) Team Backend origin; URLs with
credentials, query strings, or fragments are rejected before invoking the
local bridge. Connect validates capabilities, enables local-edge Team route
families, starts browser approval, and stores reusable credentials only through
local secure credential storage.
Disconnect revokes local credential material and disables Team routing. API
Tokens remain Personal Memory credentials; they do not authorize Team Workspace
recall.

Captured Session previews prefer human-readable Conversation text and suppress
tool-call payloads as the primary summary. In the raw Conversation, User and AI
Client messages remain individually visible while consecutive tool calls are
collapsed into an expandable Agent activity group; expanding it preserves every
raw Memory Event and its captured content.

Settings describes local readiness through the User outcomes of Capture,
Recall, and Memory processing. Degraded outcomes offer a relevant recovery
action in context, while service-level status and broad diagnostic actions stay
under Advanced diagnostics.
Separate Git worktrees keep distinct local records while sharing a device-local
Git common-directory signal. Current and historical network remote aliases are
stored only as future matching evidence; Desktop does not yet combine Personal
Memory from multiple devices or use those aliases to create Team Workspace
links.

The current client boundary is intentionally local-first. The Desktop selection
model includes stable Project and Captured Session identity, while backend scope
and authorization remain API concerns. Team Workspace routing remains separate
from Desktop Project selection and never encodes credentials in navigation
state.

## Run

```bash
pnpm --filter @koed/koed-server build
pnpm --filter @koed/desktop start
```

Repo-script aliases:

```bash
pnpm desktop:start
pnpm desktop:dev
```

## Package A Local `.app`

Build an unsigned macOS app directory for local packaging smoke tests:

```bash
pnpm desktop:package
pnpm desktop:package:smoke:mac
open apps/desktop/release/mac/Koed.app
```

`desktop:package`, `desktop:package:mac`, and `desktop:package:smoke:mac` are
macOS-only today. On Linux/WSL, `desktop:package:smoke` exits before launching
anything with a clear macOS-only message; set
`KOED_DESKTOP_PACKAGE_SMOKE_SKIP_NON_DARWIN=1` only in jobs that intentionally
skip this smoke.

This local package bundles the Electron shell, packaged renderer assets, the
`@koed/koed-server` control-plane CLI, JS/service artifacts for API, Worker,
Explorer, MCP Server, Supported Capture Hook, DB migrations, the built
Embedding Service, and runtime package dependencies under
`Contents/Resources/koed-runtime`. It can also stage native Postgres/pgvector
and llama-server assets from `KOED_NATIVE_RUNTIME_SOURCE_DIR`; when present,
packaging writes a platform/architecture `runtime-asset-manifest.json` so
`koed-server runtime install --provider packaged --dependency-mode
bundled-local --json` can verify and install them under `KOED_HOME/runtime`.
For local packaged-native smoke, `pnpm native-runtime:stage:homebrew -- --out
/tmp/koed-native-runtime --force` can create a staging directory from
Homebrew/Linuxbrew formulas; this helper is not a release-quality
redistributable runtime bundle. Python virtualenv files are no longer packaged
native runtime assets. If no native source is staged, missing native runtime assets
show as actionable `koed-server runtime status/install` diagnostics and
Homebrew remains the macOS/Linux fallback.
Point the packaged app back at a checkout for developer diagnostics by opting
into source fallbacks explicitly:

```bash
KOED_REPO_ROOT=/path/to/koed \
KOED_ALLOW_PACKAGED_SOURCE_FALLBACK=1 \
  apps/desktop/release/mac/Koed.app/Contents/MacOS/Koed
```

`KOED_SERVER_CLI=/path/to/cli.js` can override the control-plane CLI directly.
Use the app executable when passing environment variables; macOS `open` does not
reliably preserve inline shell environment assignments for `.app` launches.
Alternatively, set persistent launch services environment with `launchctl setenv
KOED_REPO_ROOT /path/to/koed` before using `open`. Without those overrides, the
packaged app uses its bundled `koed-server` CLI and reports missing runtime
diagnostics instead of crashing.

Packaged Desktop bundled-local startup asks `koed-server` to allocate local
ports automatically. The first successful allocation is persisted under
`KOED_HOME/config/local-ports.json` so subsequent Desktop launches keep stable
API, Explorer, Postgres, and Embedding Service ports while avoiding common
local development or Docker port collisions. First-run setup inspects package,
runtime, model, service, Codex integration, and final verification state before
making changes. After one explicit confirmation, Desktop runs only incomplete
stages in order and stops at the first failure. The model stage reports actual
downloaded and total bytes from the pinned artifact response before checksum
verification. Retrying re-inspects local state and resumes from the first
incomplete stage.

Desktop also compares the active local API URL/token with the supported Codex
MCP and Capture Hook configuration in `~/.codex/config.toml` and
`~/.koed/config.json`. If those user-owned files point at stale local ports or
credentials, the AI Client Integration and Capture Path cards show an explicit
mismatch and offer **Fix Codex integration**. The repair action rewrites the
Koed-managed Codex block and hook config for the currently running Desktop API;
restart Codex and trust updated hooks if prompted before expecting new captures.

## Packaged First-Run

Packaged Desktop uses `Koed` app metadata, `assets/icon.icns`, and
`assets/koed-icon.png` for branding. First run starts bundled-local
`koed-server`, allocates ports, and verifies runtime/model assets under
`KOED_HOME` before the main window reports healthy. Packaged release
signing/notarization is not turned on in this repo yet; `desktop:package` and
`desktop:package:smoke:mac` are unsigned local smoke builds, and
`desktop:package:release` still needs local Developer ID credentials and
release setup. Native Windows packaged app support is not shipped here;
Linux/WSL use is limited to smoke and unpacked-artifact testing.

## Notes

- `desktop:start` builds the app and launches Electron in source-checkout mode.
- `desktop:dev` runs the renderer dev server only.
- `desktop:package` (`desktop:package:mac`) builds `apps/desktop/release/mac/Koed.app` with
  `electron-builder --mac dir` and disables signing/notarization.
- `desktop:package:smoke:mac` builds the unsigned app and verifies the packaged
  renderer, bundled `koed-server`, and `koed-runtime` JS/service artifact layout
  can run without checkout overrides. The smoke launches the packaged
  `koed-server` with a temporary `KOED_HOME`, unsets `KOED_REPO_ROOT`, verifies
  daemon start/status/reconnect/stop, and `--missing-assets` checks actionable
  `doctor --json` output when native runtime assets are absent. Set
  `KOED_NATIVE_RUNTIME_SOURCE_DIR` to stage native assets into the package
  manifest for packaged-provider runtime install tests.
  `pnpm native-runtime:stage:homebrew -- --out /tmp/koed-native-runtime --force`
  can produce a local Homebrew-backed staging directory for those smoke tests.
  `desktop:package:smoke` currently aliases the macOS smoke and guards
  non-Darwin platforms before package execution, though Linux smoke can be
  pointed at unpacked artifacts with `KOED_DESKTOP_PACKAGE_SMOKE_APP_PATH`,
  `KOED_DESKTOP_PACKAGE_SMOKE_RESOURCES_PATH`, and
  `KOED_DESKTOP_PACKAGE_SMOKE_EXECUTABLE` when a Linux packaged build is
  available.
- `desktop:package:internal:mac` builds unsigned macOS `dmg` and `zip`
  artifacts for internal testing, including packaged native runtime assets when
  `KOED_NATIVE_RUNTIME_SOURCE_DIR` is set. CI uploads these artifacts from the
  manual native-runtime workflow; see `docs/desktop-internal-artifacts.md` for
  download, install/open, Gatekeeper-warning, runtime status/doctor, and cleanup
  steps.
- `desktop:package:release` builds macOS `dmg` and `zip` artifacts using the
  release packaging config. Signing/notarization requires a local Developer ID
  identity and release credentials; use `desktop:package` for unsigned local
  smoke builds.
- macOS packaging uses `assets/icon.icns` plus hardened-runtime entitlement
  templates in `build/` for signed release artifacts.
- The packaged desktop shell resolves the bundled
  `node_modules/@koed/koed-server/dist/cli.js` by default; `KOED_REPO_ROOT` and
  `KOED_SERVER_CLI` remain available for developer control-plane overrides.
  Source-checkout runtime fallback also requires
  `KOED_ALLOW_PACKAGED_SOURCE_FALLBACK=1`.
