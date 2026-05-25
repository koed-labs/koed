# Pi Integration

Pi Phase 1 integration uses a Pi extension that talks to Koed HTTP APIs directly. It does not require MCP and it does not require the `codex` CLI binary.

## What Phase 1 includes

- `memory_access_check` tool
- `memory_answer` tool
- optional low-level `memory_search` and `memory_expand` tools
- automatic capture of finalized Pi user and assistant messages as personal memory
- local background LCM summarisation without MCP
- optional tool-result capture behind an env flag

## What Phase 1 does not include

- MCP bridge
- Codex transcript shim
- local `codex exec` memory-answer worker
- local `codex exec` LCM summary worker

## Install

From this repository checkout:

```bash
pi install ./packages/pi-extension
```

For one-off local testing without install:

```bash
KOED_API_URL=http://localhost:4170 \
KOED_API_TOKEN=<token> \
pi -e ./packages/pi-extension/src/index.ts
```

## Config file support

The extension reads config in this order:

- packaged defaults from `packages/pi-extension/koed.defaults.json`
- `~/.pi/agent/koed.json`
- `.pi/koed.json`

Project config overrides global config. Environment variables override all file-based config.

Example config:

```json
{
  "apiUrl": "http://studio:4170",
  "apiToken": "cmt_replace_me",
  "captureEnabled": true,
  "captureToolEvents": false,
  "defaultRetrievalScope": "personal",
  "exposeLowLevelTools": false,
  "lcmSummaryEnabled": true
}
```

Packaged default API URL is `http://localhost:4170` so Pi does not assume the common `3000` port.

Recommended pattern:

- keep `apiToken` in `~/.pi/agent/koed.json`
- keep project-specific non-secret overrides in `.pi/koed.json`
- use env vars only for temporary overrides

## Environment

Required only if you do not use a config file:

- `KOED_API_URL=http://localhost:4170`
- `KOED_API_TOKEN=<token>`

Optional:

- `KOED_CAPTURE_ENABLED=true|false` default `true`
- `KOED_CAPTURE_TOOL_EVENTS=true|false` default `false`
- `KOED_DEFAULT_RETRIEVAL_SCOPE=personal|personal+team` default `personal`
- `KOED_EXPOSE_LOW_LEVEL_TOOLS=true|false` default `false`

`lcmSummaryEnabled` currently lives in `koed.json` and defaults to `true`; there is no separate env var required for the Pi background LCM worker.

Compatibility aliases also work:

- `MEMORY_API_URL`
- `MEMORY_API_TOKEN`
- `CODEX_MEMORY_BASE_URL`
- `CODEX_MEMORY_API_TOKEN`

## Diagnostics

If `KOED_EXPOSE_LOW_LEVEL_TOOLS=true`, Pi also exposes:

- `memory_search`
- `memory_expand`
- `memory_lcm_status`
- `memory_lcm_summarize_pending`

Use these only for debugging and inspection. Normal recall should still go through `memory_answer`.

## Verify

1. Start Koed self-hosted stack.
2. Create API token in console.
3. Start Pi with extension installed.
4. Run `memory_access_check`.
5. Tell Pi a fact in one prompt.
6. Ask Pi to recall it in a later prompt.

If capture is working, Koed stores Pi events with `source_runtime = 'pi'`. If LCM summarisation is enabled, pending LCM placeholders are also processed locally by the extension through Pi without needing a separate MCP server.
