#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const token =
  process.env.MEMORY_API_TOKEN ?? process.env.CODEX_MEMORY_API_TOKEN;
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

const markerStart = "# >>> koed-self-hosted";
const markerEnd = "# <<< koed-self-hosted";
const shellEscapeDoubleQuoted = (value) =>
  value.replace(/([\\"$`])/g, "\\$1");
const shellDoubleQuoted = (value) => `"${shellEscapeDoubleQuoted(value)}"`;
const hookEnvAssignments = [
  `MEMORY_API_URL=${shellDoubleQuoted(apiUrl)}`,
  `MEMORY_API_TOKEN=${shellDoubleQuoted(token)}`,
  'MEMORY_CODEX_APP_SERVER_BINARY="codex"',
  'MEMORY_HOOK_STRICT="false"',
  'MEMORY_HOOK_TRIGGER_LCM_SUMMARY="true"',
  'MEMORY_HOOK_LCM_SUMMARY_DELAY_MS="10000"',
  'MEMORY_HOOK_LCM_SUMMARY_LIMIT="2"',
  'MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS="48000"'
];
const hookCommand = `env ${hookEnvAssignments.join(" ")} ${shellDoubleQuoted(nodeCommand)} ${shellDoubleQuoted(captureHookPath)}`;
const hookEvents = [
  ["SessionStart", 10],
  ["UserPromptSubmit", 10],
  ["PostToolUse", 10],
  ["Stop", 30],
  ["SubagentStart", 10],
  ["SubagentStop", 30]
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
const koedBlock = `# Replace any existing [mcp_servers.${mcpName}] block before pasting again.
${markerStart}
[mcp_servers.${mcpName}]
command = "${nodeCommand}"
args = ["${mcpCliPath}"]
enabled = true

[mcp_servers.${mcpName}.env]
MEMORY_API_URL = "${apiUrl}"
MEMORY_API_TOKEN = "${token}"
MEMORY_CODEX_APP_SERVER_BINARY = "codex"

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
writeFileSync(codexConfigPath, `${withoutPrevious.trimEnd()}\n\n${koedBlock}`);

console.log(`Updated ${codexConfigPath}`);
console.log("Restart Codex to load the MCP server and hooks.");
console.log(
  "Codex may ask you to review/trust changed hooks after config.toml changes."
);
