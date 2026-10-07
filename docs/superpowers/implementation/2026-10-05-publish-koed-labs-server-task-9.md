# Task 9 implementation evidence — packed public npm control plane

## Scope

Created a packed `@koed-labs/server` artifact assembled from the compiled control-plane CLI. Esbuild bundles workspace/private JavaScript dependencies into `vendor/`; generated package exposes only executable `koed`, declares Node `>=24 <25`, includes root license and third-party notices, and has no npm lifecycle downloader or runtime package dependency installs. The launcher rejects unsupported Node major versions before loading bundled code.

`node scripts/build-public-server-package.mjs` creates `package/` plus `tarballs/koed-labs-server.tgz`. Assembly verifies that emitted external imports are Node builtins only. Archive smoke checks packed contents, public manifest, no `node_modules`, no symlinks, no workspace/file/checkout paths, and no `koed-server` bin alias.

## Verification

Node `v24.13.1` at `/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin/node`:

- `pnpm --filter @koed-labs/server typecheck`: passed.
- `pnpm --filter @koed-labs/server build`: passed.
- Focused CLI/component Vitest: 3 files, 58 tests passed.
- `node --test scripts/build-public-server-package.test.mjs scripts/packed-control-plane.test.mjs`: 2 tests passed.
- Packed artifact installed with `npm install --global --prefix ... --offline` to a clean prefix containing spaces. Actual global `koed` executable invoked outside checkout with clean environment: help, `models status --json`, and `runtime status --json` behaved as expected. Fetch spy observed zero network requests. Node 26 invocation returned actionable `Node.js >=24 <25` error.
- Targeted ESLint and Prettier checks, and `git diff --check`: passed.

No npm publication, Desktop work, or release workflow changes were made. Signing/trusted production component artifacts and actual registry publication remain external gates; package does not download service payloads. User-approved minor changeset decision carries forward; no changeset added.
