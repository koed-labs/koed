# Koed Explorer

Koed Explorer is a focused web app for browsing captured Koed memory history.
The Explorer package keeps only the browser app and the minimal tooling needed
to build it.
Upstream desktop, server, marketing, release, remote-access, and platform
package paths have been removed from `apps/explorer`; Koed Desktop and the
local control plane live elsewhere in this repository.

## Current Scope

- Browse Koed memory graph/session history from the React app.
- Run as a browser-hosted Vite app.
- Keep the active workspace scoped to `apps/explorer`.
- Remove desktop, server, release, package-library, and marketing paths from the
  active workspace.

## Requirements

- pnpm 11.1.2
- Node.js 24.13.1
- A running Koed API that exposes `/v1/memory/graph/stream` (the
  `koed-server` supervised default is `http://localhost:3300`)
- A Koed API token

## Development

For the guided local setup, run from the repository root:

```bash
pnpm clients:bootstrap
```

If you already have a Koed API Token and only need to wire Explorer config:

```bash
pnpm explorer:bootstrap --token "$KOED_API_TOKEN"
```

Run the browser app against a local Koed API:

```bash
VITE_KOED_API_BASE_URL=http://localhost:3300 \
VITE_KOED_API_TOKEN="$KOED_API_TOKEN" \
pnpm explorer:dev
```

## Quality Gates

Before considering a change complete, run:

```bash
pnpm fmt:check
pnpm typecheck
```

Use `pnpm test` for Vitest.

## Main Fork-Specific Files

- `src/koed/KoedExplorerApp.tsx`
- `src/main.tsx`

## Performance Architecture

The browser intentionally keeps the project/thread shell separate from
selected-thread detail data. Be careful when changing sidebar shell loading,
thread detail loading, prewarming, cache retention, or long event rendering.

## License and Attribution

Koed Explorer is licensed under the GNU Affero General Public License version 3
only (`AGPL-3.0-only`). See [LICENSE](LICENSE).

Koed Explorer was forked from and inspired by
[T3 Code](https://github.com/pingdotgg/t3code), an MIT-licensed project by
T3 Tools Inc. T3 Code's upstream MIT license notice is preserved separately.

Thank you to the T3 Code team for making their work available as open source.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the upstream notice.

## Remaining Cleanup

The main remaining reduction target is UI and CSS still inherited from the old
shell. Keep removals scoped to code that is no longer reachable from
`apps/explorer`.
