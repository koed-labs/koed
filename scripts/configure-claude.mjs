#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const mode = process.argv.includes("--remove")
  ? "remove"
  : process.argv.includes("--check")
    ? "check"
    : "configure";
const repoRoot = process.cwd();
const nodeCommand = process.env.MEMORY_NODE_COMMAND ?? process.execPath;
const claudeCommand = process.env.KOED_CLAUDE_CODE_EXECUTABLE ?? "claude";
const mcpName = process.env.MEMORY_MCP_NAME ?? "koed";
const koedHome = resolve(process.env.KOED_HOME ?? `${homedir()}/.koed`);
const settingsPath = resolve(
  process.env.CLAUDE_SETTINGS_PATH ?? `${homedir()}/.claude/settings.json`
);
const mcpCliPath = resolve(repoRoot, "packages/mcp-server/dist/cli.js");
const captureHookPath = resolve(
  repoRoot,
  "packages/mcp-server/dist/capture-hook.js"
);

for (const filePath of [mcpCliPath, captureHookPath]) {
  if (!existsSync(filePath)) {
    console.error(`${filePath} does not exist. Build @koed/mcp-server first.`);
    process.exit(1);
  }
}

const runClaude = (args) =>
  spawnSync(claudeCommand, args, {
    encoding: "utf8",
    env: process.env
  });

const auth = runClaude(["auth", "status", "--json"]);
if (mode !== "remove" && auth.status !== 0) {
  console.error("Claude Code is not signed in. Run `claude auth login` first.");
  process.exit(1);
}

const settings = existsSync(settingsPath)
  ? JSON.parse(readFileSync(settingsPath, "utf8"))
  : {};
settings.hooks = settings.hooks ?? {};
const hookCommand = [
  nodeCommand,
  captureHookPath,
  "--source",
  "claude",
  "--koed-home",
  koedHome
]
  .map((value) => JSON.stringify(value))
  .join(" ");
const hookEvents = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd"
];
const withoutKoedHook = (entries) =>
  (Array.isArray(entries) ? entries : []).filter(
    (entry) =>
      !JSON.stringify(entry).includes(captureHookPath) &&
      !JSON.stringify(entry).includes("koed-capture-hook")
  );
const hasKoedHook = (entries) =>
  (Array.isArray(entries) ? entries : []).some((entry) =>
    JSON.stringify(entry).includes(captureHookPath)
  );

if (mode === "check") {
  const mcp = runClaude(["mcp", "get", mcpName]);
  const missingHooks = hookEvents.filter(
    (eventName) => !hasKoedHook(settings.hooks[eventName])
  );
  if (mcp.status !== 0 || missingHooks.length > 0) {
    console.error(
      `Claude Code integration needs repair${
        missingHooks.length > 0
          ? `; missing hooks: ${missingHooks.join(", ")}`
          : ""
      }.`
    );
    process.exit(1);
  }
  console.log("Claude Code integration is configured.");
  process.exit(0);
}

if (mode === "remove") {
  runClaude(["mcp", "remove", "--scope", "user", mcpName]);
  for (const eventName of hookEvents) {
    const remaining = withoutKoedHook(settings.hooks[eventName]);
    if (remaining.length > 0) settings.hooks[eventName] = remaining;
    else delete settings.hooks[eventName];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600
  });
  chmodSync(settingsPath, 0o600);
  console.log(
    "Claude Code integration removed; unrelated settings were preserved."
  );
  process.exit(0);
}

spawnSync(claudeCommand, ["mcp", "remove", "--scope", "user", mcpName], {
  encoding: "utf8",
  env: process.env
});
const add = spawnSync(
  claudeCommand,
  [
    "mcp",
    "add",
    "--scope",
    "user",
    mcpName,
    "--env",
    `KOED_HOME=${koedHome}`,
    "--",
    nodeCommand,
    mcpCliPath
  ],
  { encoding: "utf8", env: process.env }
);
if (add.status !== 0) {
  console.error(add.stderr?.trim() || "Claude MCP setup failed.");
  process.exit(1);
}

for (const eventName of hookEvents) {
  const withoutKoed = withoutKoedHook(settings.hooks[eventName]);
  settings.hooks[eventName] = [
    ...withoutKoed,
    {
      hooks: [
        {
          type: "command",
          command: hookCommand,
          timeout: 3
        }
      ]
    }
  ];
}
mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
  mode: 0o600
});
chmodSync(settingsPath, 0o600);

console.log("Claude Code integration configured.");
console.log(`KOED_HOME: ${koedHome}`);
console.log(`Claude settings: ${settingsPath}`);
console.log("Restart Claude Code before verifying capture and recall.");
