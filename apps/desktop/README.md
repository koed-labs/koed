# Koed Desktop

Koed Desktop is the Electron control surface for Koed.

It wraps the same local `koed-server` command surface, shows service status,
runs the first-time Codex setup and health checks automatically, and embeds
the Explorer so an Operator can start the supervisor and open the local UI
from one window.

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

This local package bundles the Electron shell, packaged renderer assets, and the
`@koed/koed-server` control-plane CLI. It does not yet bundle the full native
Koed runtime, native dependency assets, or model files, so missing local runtime
assets may still show as actionable diagnostics. Point the packaged app back at
a checkout when you want the local control-plane actions to use repo build
outputs instead of the bundled CLI:

```bash
KOED_REPO_ROOT=/path/to/koed \
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
local development or Docker port collisions.

Desktop also compares the active local API URL/token with the supported Codex
MCP and Capture Hook configuration in `~/.codex/config.toml` and
`~/.koed/config.json`. If those user-owned files point at stale local ports or
credentials, the AI Client Integration and Capture Path cards show an explicit
mismatch and offer **Fix Codex integration**. The repair action rewrites the
Koed-managed Codex block and hook config for the currently running Desktop API;
restart Codex and trust updated hooks if prompted before expecting new captures.

## Notes

- `desktop:start` builds the app and launches Electron in source-checkout mode.
- `desktop:dev` runs the renderer dev server only.
- `desktop:package` (`desktop:package:mac`) builds `apps/desktop/release/mac/Koed.app` with
  `electron-builder --mac dir` and disables signing/notarization.
- `desktop:package:smoke:mac` builds the unsigned app and verifies the packaged
  renderer and bundled `koed-server` status/doctor/stop command surface can run
  without checkout overrides. `desktop:package:smoke` currently aliases the
  macOS smoke and guards non-Darwin platforms before package execution.
- `desktop:package:release` builds macOS `dmg` and `zip` artifacts using the
  release packaging config. Signing/notarization requires a local Developer ID
  identity and release credentials; use `desktop:package` for unsigned local
  smoke builds.
- macOS packaging uses `assets/icon.icns` plus hardened-runtime entitlement
  templates in `build/` for signed release artifacts.
- The packaged desktop shell resolves the bundled
  `node_modules/@koed/koed-server/dist/cli.js` by default; `KOED_REPO_ROOT` and
  `KOED_SERVER_CLI` remain available for developer overrides.
