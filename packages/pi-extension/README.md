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
KOED_API_URL=http://localhost:4170 \
KOED_API_TOKEN=<token> \
pi -e ./packages/pi-extension/src/index.ts
```

## Config file support

The extension reads config in this order:

- `packages/pi-extension/koed.defaults.json` packaged defaults
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
  "exposeLowLevelTools": false
}
```

Packaged default API URL is now `http://localhost:4170` to avoid assuming a crowded `3000` port.

See `packages/pi-extension/koed.defaults.json` and `packages/pi-extension/koed.example.json`.

## Environment

- `KOED_API_URL` or `MEMORY_API_URL` or `CODEX_MEMORY_BASE_URL`
- `KOED_API_TOKEN` or `MEMORY_API_TOKEN` or `CODEX_MEMORY_API_TOKEN`
- `KOED_CAPTURE_ENABLED=true|false` default `true`
- `KOED_CAPTURE_TOOL_EVENTS=true|false` default `false`
- `KOED_DEFAULT_RETRIEVAL_SCOPE=personal|personal+team` default `personal`
- `KOED_EXPOSE_LOW_LEVEL_TOOLS=true|false` default `false`
