# Studio browser regression suite

Run the synthetic browser suite from the repository root:

```bash
pnpm install
pnpm --filter @koed/studio exec playwright install chromium
pnpm --filter @koed/studio test:ui
```

The `test:ui` command builds the runtime schemas in `@koed/shared` and starts its own Studio Next development server with hosted routing enabled. It uses `127.0.0.1:43119` by default; set `KOED_STUDIO_UI_TEST_PORT` to use another free local port. Playwright starts and stops the server for each run. CI can use the same command and upload `apps/studio/output/playwright/` on failure.

Every same-origin `/me`, `/v1/*`, and `/studio-api/*` request is intercepted by the synthetic API fixture. Requests to other origins are blocked. Known writes update in-memory fixtures, including idempotent message acceptance. Any unrecognized API read or mutation is recorded and fails the test. The suite does not require a backend, provider, account, cookie, or repository-local review artifact.

Current coverage exercises Agents collection filters and cards/list views, verified working activity and Project summaries, stale detail responses, retirement, older Job pagination with retry and original attribution, and late pages after changing Agents. It also covers hosted Team navigation, author controls, thread-draft scoping and reload recovery, keyboard navigation between conversation markers, human versus Agent composer controls, and an offline reply retried once while preserving later typing.

These tests verify browser behavior against synthetic API contracts. They do not validate backend authorization, provider execution, deployment routing, real realtime delivery, or persistence across browsers and devices. Backend and API contract tests remain separate gates.
