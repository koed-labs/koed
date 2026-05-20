# Koed T3 History Browser Bodge

This directory is a deliberately rough vendored copy of T3 Code with a small
Koed history-browser mode patched into the web and desktop app. It is here so
the full demo can live on one Koed branch for testing.

This is not a clean product integration. The useful pieces are:

- `apps/web/src/koed/KoedHistoryApp.tsx`
- the `VITE_KOED_HISTORY_BROWSER=1` switch in `apps/web/src/main.tsx`
- the Electron IPC bridge at `apps/desktop/src/ipc/methods/koedMemory.ts`
- the Koed API branch changes for `/v1/memory/graph/stream`
- the Koed MCP CLI `memory-answer` command used by the desktop bridge

Run the Electron version against a local Koed API:

```bash
cd experiments/t3code-history-browser
bun install
TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/home/mark/.codex-memory/config.json","utf8")).apiToken)')
VITE_KOED_HISTORY_BROWSER=1 \
VITE_KOED_API_BASE_URL=http://localhost:3000 \
VITE_KOED_API_TOKEN="$TOKEN" \
KOED_MCP_CLI=/home/mark/code/codex-memory-mvp/packages/mcp-server/dist/cli.js \
bun dev:desktop
```

The renderer is still available at `http://127.0.0.1:5733`, but the important
path is the Electron app. In Electron, the manual memory composer calls the
local Koed MCP CLI, which then runs the local Codex memory-answer worker under
the user's Codex subscription. In a plain browser, manual memory answering is
disabled instead of falling back to raw backend evidence bundles.
