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
open apps/desktop/release/mac/Koed.app
```

This minimal package is intentionally dev-machine dependent. It verifies the
Electron shell, packaged renderer assets, and `app.isPackaged` startup path, but
it does not yet bundle the full Koed runtime, native dependency assets, or model
files. Point the packaged app back at a checkout when you want the local
control-plane actions to use the repo build outputs:

```bash
KOED_REPO_ROOT=/path/to/koed open apps/desktop/release/mac/Koed.app
```

`KOED_SERVER_CLI=/path/to/cli.js` can override the control-plane CLI directly.
Without those overrides, the packaged app reports missing backend diagnostics
instead of crashing.

## Notes

- `desktop:start` builds the app and launches Electron in source-checkout mode.
- `desktop:dev` runs the renderer dev server only.
- `desktop:package` builds `apps/desktop/release/mac/Koed.app` with
  `electron-builder --mac dir` and disables signing/notarization.
- The desktop shell still relies on `packages/koed-server/dist/cli.js` for the
  local control-plane actions.
