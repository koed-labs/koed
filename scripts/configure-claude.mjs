#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  captureClaudeBackgroundJournal,
  configureClaudeBackgroundRecall,
  removeClaudeBackgroundRecall,
  writeClaudeBackgroundJournal,
  writeClaudeSettingsFileAtomic
} from "../packages/koed-server/src/claude-background-settings.mjs";

import { parseClaudeOwnedMcpEntry } from "../packages/koed-server/src/claude-mcp-entry.mjs";

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
  process.env.CLAUDE_SETTINGS_PATH ??
    `${process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME ?? homedir()}/.claude`}/settings.json`
);
const mcpCliPath = resolve(repoRoot, "packages/mcp-server/dist/cli.js");
const captureHookPath = resolve(
  repoRoot,
  "packages/mcp-server/dist/capture-hook.js"
);
const allowedEnvironment = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "CLAUDE_CONFIG_DIR",
  "SYSTEMROOT",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT"
];
const childEnvironment = Object.fromEntries(
  allowedEnvironment.flatMap((name) =>
    process.env[name] ? [[name, process.env[name]]] : []
  )
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
    env: childEnvironment,
    timeout: 30_000
  });
const mcpEntryIsKoedOwned = (output) =>
  Boolean(parseClaudeOwnedMcpEntry(output, mcpCliPath, koedHome));

if (mode === "configure" && process.argv.includes("--background-recall")) {
  const version = runClaude(["--version"]);
  const numbers = version.stdout
    ?.match(/(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  if (
    version.status !== 0 ||
    !numbers ||
    !(
      numbers[0] > 2 ||
      (numbers[0] === 2 &&
        (numbers[1] > 1 || (numbers[1] === 1 && numbers[2] >= 227)))
    )
  ) {
    console.error(
      "Claude Code 2.1.227 or newer is required for Koed background recall setup."
    );
    process.exit(1);
  }
}

const auth = runClaude(["auth", "status", "--json"]);
if (mode !== "remove" && auth.status !== 0) {
  console.error("Claude Code is not signed in. Run `claude auth login` first.");
  process.exit(1);
}

const originalSettings = existsSync(settingsPath)
  ? readFileSync(settingsPath, "utf8")
  : null;
const settings = originalSettings === null ? {} : JSON.parse(originalSettings);
const backgroundSnapshot =
  mode === "remove" || process.argv.includes("--background-recall")
    ? captureClaudeBackgroundJournal(koedHome)
    : undefined;
const background =
  mode === "configure" && process.argv.includes("--background-recall")
    ? configureClaudeBackgroundRecall(
        settings,
        process.env,
        settingsPath,
        backgroundSnapshot
      )
    : undefined;
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

const writeSettings = (content) => {
  if (
    background ||
    (backgroundSnapshot?.content !== null &&
      backgroundSnapshot?.content !== undefined)
  )
    writeClaudeSettingsFileAtomic(settingsPath, content);
  else {
    writeFileSync(settingsPath, content, { mode: 0o600 });
    chmodSync(settingsPath, 0o600);
  }
};
const restorePriorMcp = (existingMcp, exactEntry) => {
  if (existingMcp.status !== 0) return;
  if (exactEntry) {
    const restored = runClaude([
      "mcp",
      "add-json",
      "--scope",
      "user",
      mcpName,
      JSON.stringify(exactEntry)
    ]);
    if (restored.error || restored.status !== 0)
      throw new Error(
        restored.error?.message || restored.stderr?.trim() || "restore failed"
      );
    return;
  }
  const entry = parseClaudeOwnedMcpEntry(
    existingMcp.stdout ?? "",
    mcpCliPath,
    koedHome
  );
  if (!entry)
    throw new Error(
      "Claude MCP output cannot be restored without guessing its original arguments"
    );
  const restored = runClaude([
    "mcp",
    "add",
    "--scope",
    "user",
    mcpName,
    ...entry.environment.flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`
    ]),
    "--",
    entry.command,
    ...entry.args
  ]);
  if (restored.status !== 0) throw new Error("Claude MCP restoration failed.");
};
const rollbackSettings = () => {
  if (originalSettings === null) {
    if (existsSync(settingsPath)) unlinkSync(settingsPath);
  } else writeSettings(originalSettings);
};
const failWithRollback = (
  error,
  existingMcp,
  removeReplacement,
  exactEntry
) => {
  const failures = [error instanceof Error ? error.message : String(error)];
  try {
    rollbackSettings();
  } catch (restoreError) {
    failures.push(
      `Claude settings rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
    );
  }
  if (backgroundSnapshot) {
    try {
      writeClaudeBackgroundJournal(
        backgroundSnapshot,
        backgroundSnapshot.content
      );
    } catch (restoreError) {
      failures.push(
        `Claude journal rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
      );
    }
  }
  if (
    removeReplacement &&
    runClaude(["mcp", "remove", "--scope", "user", mcpName]).status !== 0
  )
    failures.push("Claude MCP rollback failed.");
  try {
    restorePriorMcp(existingMcp, exactEntry);
  } catch (restoreError) {
    failures.push(restoreError.message);
  }
  console.error(failures.join(" "));
  process.exit(1);
};

if (mode === "check") {
  const mcp = runClaude(["mcp", "get", mcpName]);
  const missingHooks = hookEvents.filter(
    (eventName) => !hasKoedHook(settings.hooks[eventName])
  );
  if (
    mcp.status !== 0 ||
    !mcpEntryIsKoedOwned(mcp.stdout ?? "") ||
    missingHooks.length > 0
  ) {
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
  const backgroundRemoval = removeClaudeBackgroundRecall(
    settings,
    settingsPath,
    backgroundSnapshot
  );
  const existingMcp = runClaude(["mcp", "get", mcpName]);
  if (
    backgroundSnapshot?.content !== null &&
    existingMcp.status === 0 &&
    !mcpEntryIsKoedOwned(existingMcp.stdout ?? "")
  ) {
    console.error(
      "Claude MCP entry is unrelated or its display has ambiguous arguments; it was not removed."
    );
    process.exit(1);
  }
  if (
    existingMcp.status === 0 &&
    mcpEntryIsKoedOwned(existingMcp.stdout ?? "")
  ) {
    const removed = runClaude(["mcp", "remove", "--scope", "user", mcpName]);
    if (removed.status !== 0) {
      console.error(removed.stderr?.trim() || "Claude MCP removal failed.");
      process.exit(1);
    }
  }
  try {
    for (const eventName of hookEvents) {
      const remaining = withoutKoedHook(settings.hooks[eventName]);
      if (remaining.length > 0) settings.hooks[eventName] = remaining;
      else delete settings.hooks[eventName];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
    writeSettings(`${JSON.stringify(settings, null, 2)}\n`);
    writeClaudeBackgroundJournal(backgroundSnapshot, backgroundRemoval.journal);
  } catch (error) {
    failWithRollback(error, existingMcp, false);
  }
  console.log(
    "Claude Code integration removed; unrelated settings were preserved."
  );
  process.exit(0);
}

const existingMcp = runClaude(["mcp", "get", mcpName]);
let previousMcp;
if (existingMcp.status === 0) {
  const configPath = process.env.CLAUDE_CONFIG_DIR?.trim()
    ? resolve(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : resolve(process.env.HOME?.trim() || homedir(), ".claude.json");
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    previousMcp = config.mcpServers?.[mcpName];
  }
  if (
    !previousMcp &&
    !parseClaudeOwnedMcpEntry(existingMcp.stdout ?? "", mcpCliPath, koedHome)
  ) {
    console.error(
      "Claude Code already has an unrelated user-scoped MCP server named " +
        mcpName +
        "; its exact configuration is unavailable for safe replacement."
    );
    process.exit(1);
  }
  const remove = runClaude(["mcp", "remove", "--scope", "user", mcpName]);
  if (remove.error || remove.status !== 0) {
    console.error(
      remove.error?.message ||
        remove.stderr?.trim() ||
        "Claude MCP removal failed."
    );
    // The CLI may have removed the entry before reporting failure.
    const currentMcp = existsSync(configPath)
      ? JSON.parse(readFileSync(configPath, "utf8")).mcpServers?.[mcpName]
      : undefined;
    if (!currentMcp && previousMcp) {
      try {
        restorePriorMcp(existingMcp, previousMcp);
      } catch (restoreError) {
        console.error(`Claude MCP rollback failed: ${restoreError.message}`);
      }
    }
    process.exit(1);
  }
}
const add = runClaude([
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
]);
if (add.error || add.status !== 0) {
  console.error(
    add.error?.message || add.stderr?.trim() || "Claude MCP setup failed."
  );
  if (existingMcp.status === 0) {
    // A failed or timed-out add may still have written the replacement.
    runClaude(["mcp", "remove", "--scope", "user", mcpName]);
    try {
      restorePriorMcp(existingMcp, previousMcp);
    } catch (restoreError) {
      console.error(`Claude MCP rollback failed: ${restoreError.message}`);
    }
  }
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
try {
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  if (backgroundSnapshot && background)
    writeClaudeBackgroundJournal(backgroundSnapshot, background.journal);
  writeSettings(`${JSON.stringify(settings, null, 2)}\n`);
} catch (error) {
  failWithRollback(error, existingMcp, true, previousMcp);
}

console.log("Claude Code integration configured.");
console.log(`KOED_HOME: ${koedHome}`);
console.log(`Claude settings: ${settingsPath}`);
console.log("Restart Claude Code before verifying capture and recall.");

if (background) console.log(background.report.message);
