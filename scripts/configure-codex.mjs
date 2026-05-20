#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const token = process.env.MEMORY_API_TOKEN ?? process.env.CODEX_MEMORY_API_TOKEN;
if (!token) {
  console.error("Set MEMORY_API_TOKEN to a console-created Koed API token.");
  process.exit(1);
}

const repoRoot = process.cwd();
const apiUrl =
  process.env.MEMORY_API_URL ??
  process.env.CODEX_MEMORY_BASE_URL ??
  "http://localhost:3000";
const nodeCommand = process.env.MEMORY_NODE_COMMAND ?? "node";
const mcpName = process.env.MEMORY_MCP_NAME ?? "koed";
const codexConfigPath = resolve(
  process.env.CODEX_CONFIG_PATH ?? `${homedir()}/.codex/config.toml`
);
const hookConfigPath = resolve(
  process.env.MEMORY_HOOK_CONFIG ?? `${homedir()}/.koed/config.json`
);
const mcpCliPath = resolve(repoRoot, "packages/mcp-server/dist/cli.js");
const captureHookPath = resolve(repoRoot, "packages/mcp-server/dist/capture-hook.js");

for (const filePath of [mcpCliPath, captureHookPath]) {
  if (!existsSync(filePath)) {
    console.error(`${filePath} does not exist. Run pnpm --filter @koed/mcp-server build first.`);
    process.exit(1);
  }
}

mkdirSync(dirname(hookConfigPath), { recursive: true, mode: 0o700 });
writeFileSync(
  hookConfigPath,
  JSON.stringify({ apiUrl, apiToken: token, captureEnabled: true }, null, 2) + "\n",
  { mode: 0o600 }
);

const markerStart = "# >>> koed-self-hosted";
const markerEnd = "# <<< koed-self-hosted";
const hookCommand = `${nodeCommand} ${captureHookPath} --config ${hookConfigPath}`;
const koedBlock = `${markerStart}
[mcp_servers.${mcpName}]
command = "${nodeCommand}"
args = ["${mcpCliPath}"]
enabled = true

[mcp_servers.${mcpName}.env]
MEMORY_API_URL = "${apiUrl}"
MEMORY_API_TOKEN = "${token}"

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "${hookCommand}"
timeout = 10

[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = "${hookCommand}"
timeout = 10

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "${hookCommand}"
timeout = 30
${markerEnd}
`;

const existing = existsSync(codexConfigPath)
  ? readFileSync(codexConfigPath, "utf8")
  : "";
const withoutPrevious = existing.replace(
  new RegExp(`\\n?${markerStart}[\\s\\S]*?${markerEnd}\\n?`, "g"),
  "\n"
);
writeFileSync(
  codexConfigPath,
  `${withoutPrevious.trimEnd()}\n\n${koedBlock}`
);

console.log(`Updated ${codexConfigPath}`);
console.log(`Wrote ${hookConfigPath}`);
console.log("Restart Codex to load the MCP server and hooks.");
console.log("Codex may ask you to review/trust changed hooks after config.toml changes.");
