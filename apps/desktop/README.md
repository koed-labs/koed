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

## Notes

- `desktop:start` builds the app and launches Electron.
- `desktop:dev` runs the renderer dev server only.
- The desktop shell still relies on `packages/koed-server/dist/cli.js` for the
  local control-plane actions.
