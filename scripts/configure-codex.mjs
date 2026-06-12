#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const token =
  process.env.MEMORY_API_TOKEN ?? process.env.CODEX_MEMORY_API_TOKEN;
if (!token) {
  console.error(
    "Set MEMORY_API_TOKEN to a Koed API token from `pnpm api-token:create`."
  );
  process.exit(1);
}

const repoRoot = process.cwd();
const apiUrl =
  process.env.MEMORY_API_URL ??
  process.env.CODEX_MEMORY_BASE_URL ??
  "http://localhost:3300";
const nodeCommand = process.env.MEMORY_NODE_COMMAND ?? "node";
const appServerBinary = process.env.MEMORY_CODEX_APP_SERVER_BINARY ?? "codex";
const mcpName = process.env.MEMORY_MCP_NAME ?? "koed";
const codexConfigPath = resolve(
  process.env.CODEX_CONFIG_PATH ?? `${homedir()}/.codex/config.toml`
);
const hookConfigPath = resolve(
  process.env.MEMORY_HOOK_CONFIG ?? `${homedir()}/.koed/config.json`
);
const hookRequestTimeoutMs = Number.parseInt(
  process.env.MEMORY_HOOK_API_REQUEST_TIMEOUT_MS ?? "1500",
  10
);
const mcpCliPath = resolve(repoRoot, "packages/mcp-server/dist/cli.js");
const captureHookPath = resolve(
  repoRoot,
  "packages/mcp-server/dist/capture-hook.js"
);

for (const filePath of [mcpCliPath, captureHookPath]) {
  if (!existsSync(filePath)) {
    console.error(
      `${filePath} does not exist. Run pnpm --filter @koed/mcp-server build first.`
    );
    process.exit(1);
  }
}

mkdirSync(dirname(hookConfigPath), { recursive: true, mode: 0o700 });
writeFileSync(
  hookConfigPath,
  JSON.stringify(
    {
      apiUrl,
      apiToken: token,
      captureEnabled: true,
      requestTimeoutMs:
        Number.isFinite(hookRequestTimeoutMs) && hookRequestTimeoutMs > 0
          ? hookRequestTimeoutMs
          : 1500
    },
    null,
    2
  ) + "\n",
  { mode: 0o600 }
);

const markerStart = "# >>> koed";
const markerEnd = "# <<< koed";
const hookCommand = `${nodeCommand} ${captureHookPath} --config ${hookConfigPath}`;
const hookEvents = [
  ["SessionStart", 3],
  ["UserPromptSubmit", 3],
  ["PostToolUse", 3],
  ["Stop", 10],
  ["SubagentStart", 3],
  ["SubagentStop", 10]
];
const hookBlocks = hookEvents
  .map(
    ([eventName, timeout]) => `[[hooks.${eventName}]]
[[hooks.${eventName}.hooks]]
type = "command"
command = "${hookCommand}"
timeout = ${timeout}`
  )
  .join("\n\n");
const koedBlock = `${markerStart}
[mcp_servers.${mcpName}]
command = "${nodeCommand}"
args = ["${mcpCliPath}"]
enabled = true

[mcp_servers.${mcpName}.env]
MEMORY_API_URL = "${apiUrl}"
MEMORY_API_TOKEN = "${token}"
MEMORY_CODEX_APP_SERVER_BINARY = "${appServerBinary}"

${hookBlocks}
${markerEnd}
`;

const existing = existsSync(codexConfigPath)
  ? readFileSync(codexConfigPath, "utf8")
  : "";
const withoutPrevious = existing.replace(
  new RegExp(`\\n?${markerStart}[\\s\\S]*?${markerEnd}\\n?`, "g"),
  "\n"
);
mkdirSync(dirname(codexConfigPath), { recursive: true, mode: 0o700 });
writeFileSync(codexConfigPath, `${withoutPrevious.trimEnd()}\n\n${koedBlock}`);

console.log("Codex integration configured.");
console.log(`Detected API URL: ${apiUrl}`);
console.log(`Detected Node command: ${nodeCommand}`);
console.log(`Detected Codex app-server binary: ${appServerBinary}`);
console.log(`Wrote Codex MCP config: ${codexConfigPath}`);
console.log(`Wrote Capture Hook config: ${hookConfigPath}`);
console.log(
  "Next: restart Codex, then run `pnpm codex:verify-capture` or `pnpm codex:doctor` to confirm the integration is healthy."
);
console.log(
  "Codex may ask you to review or trust changed hooks after config.toml changes."
);
