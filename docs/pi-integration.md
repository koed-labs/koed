# Pi Integration

Pi Phase 1 integration uses a Pi extension that talks to Koed HTTP APIs directly. It does not require MCP and it does not require the `codex` CLI binary.

## What Phase 1 includes

- `memory_access_check` tool
- `memory_answer` tool
- optional low-level `memory_search` and `memory_expand` tools
- automatic capture of finalized Pi user and assistant messages as personal memory
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
KOED_API_URL=http://localhost:3000 \
KOED_API_TOKEN=<token> \
pi -e ./packages/pi-extension/src/index.ts
```

## Environment

Required:

- `KOED_API_URL=http://localhost:3000`
- `KOED_API_TOKEN=<token>`

Optional:

- `KOED_CAPTURE_ENABLED=true|false` default `true`
- `KOED_CAPTURE_TOOL_EVENTS=true|false` default `false`
- `KOED_DEFAULT_RETRIEVAL_SCOPE=personal|personal+team` default `personal`
- `KOED_EXPOSE_LOW_LEVEL_TOOLS=true|false` default `false`

Compatibility aliases also work:

- `MEMORY_API_URL`
- `MEMORY_API_TOKEN`
- `CODEX_MEMORY_BASE_URL`
- `CODEX_MEMORY_API_TOKEN`

## Verify

1. Start Koed self-hosted stack.
2. Create API token in console.
3. Start Pi with extension installed.
4. Run `memory_access_check`.
5. Tell Pi a fact in one prompt.
6. Ask Pi to recall it in a later prompt.

If capture is working, Koed stores Pi events with `source_runtime = 'pi'`.
