# Koed Pi Extension

Phase 1 Pi integration for Koed Self-Hosted.

## Features

- registers `memory_access_check` and `memory_answer` Pi tools;
- optional low-level `memory_search` and `memory_expand` tools;
- captures Pi user and assistant messages into Koed personal memory;
- optional tool-result capture;
- uses Koed HTTP API directly, not MCP and not `codex` CLI.

## Install in Pi

From this repo checkout:

```bash
pi install ./packages/pi-extension
```

For one-off local testing:

```bash
KOED_API_URL=http://localhost:3000 \
KOED_API_TOKEN=<token> \
pi -e ./packages/pi-extension/src/index.ts
```

## Environment

- `KOED_API_URL` or `MEMORY_API_URL` or `CODEX_MEMORY_BASE_URL`
- `KOED_API_TOKEN` or `MEMORY_API_TOKEN` or `CODEX_MEMORY_API_TOKEN`
- `KOED_CAPTURE_ENABLED=true|false` default `true`
- `KOED_CAPTURE_TOOL_EVENTS=true|false` default `false`
- `KOED_DEFAULT_RETRIEVAL_SCOPE=personal|personal+team` default `personal`
- `KOED_EXPOSE_LOW_LEVEL_TOOLS=true|false` default `false`
