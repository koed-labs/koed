import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "configure-claude.mjs"
);

test("claude configure writes credential-free hooks and KOED_HOME-only MCP config", async () => {
  const directory = path.join(
    realpathSync(tmpdir()),
    `koed-configure-claude-${process.pid}-${Date.now()}`
  );
  const koedHome = path.join(directory, "koed home");
  const settingsPath = path.join(directory, ".claude", "settings.json");
  const claudeArgsPath = path.join(directory, "claude-args.jsonl");
  const claudeEnvironmentPath = path.join(
    directory,
    "claude-environment.jsonl"
  );
  const claudeExecutable = path.join(directory, "claude-fixture.mjs");
  mkdirSync(path.join(directory, "packages/mcp-server/dist"), {
    recursive: true
  });
  writeFileSync(path.join(directory, "packages/mcp-server/dist/cli.js"), "");
  writeFileSync(
    path.join(directory, "packages/mcp-server/dist/capture-hook.js"),
    ""
  );
  writeFileSync(
    claudeExecutable,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(claudeArgsPath)}, \`${"${JSON.stringify(process.argv.slice(2))}"}\\n\`);`,
      `appendFileSync(${JSON.stringify(claudeEnvironmentPath)}, JSON.stringify({ MEMORY_API_TOKEN: process.env.MEMORY_API_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY }) + "\\n");`,
      'if (process.argv[2] === "auth") console.log(JSON.stringify({ loggedIn: true }));',
      'if (process.argv[2] === "mcp" && process.argv[3] === "get") process.exit(1);'
    ].join("\n")
  );
  chmodSync(claudeExecutable, 0o700);

  try {
    await execFileAsync(process.execPath, [scriptPath], {
      cwd: directory,
      env: {
        ...process.env,
        CLAUDE_ARGS_FILE: claudeArgsPath,
        CLAUDE_SETTINGS_PATH: settingsPath,
        KOED_CLAUDE_CODE_EXECUTABLE: claudeExecutable,
        KOED_HOME: koedHome,
        MEMORY_API_TOKEN: "must-not-be-copied",
        MEMORY_API_URL: "https://must-not-be-copied.example",
        ANTHROPIC_API_KEY: "must-not-be-copied",
        OPENAI_API_KEY: "must-not-be-copied",
        MEMORY_NODE_COMMAND: "node"
      }
    });

    const invocations = readFileSync(claudeArgsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const add = invocations.find(
      (args) => args[0] === "mcp" && args[1] === "add"
    );
    assert.ok(add);
    assert.ok(add.includes(`KOED_HOME=${koedHome}`));
    assert.doesNotMatch(JSON.stringify(add), /MEMORY_API_(TOKEN|URL)/);
    assert.doesNotMatch(JSON.stringify(add), /must-not-be-copied/);
    for (const line of readFileSync(claudeEnvironmentPath, "utf8")
      .trim()
      .split("\n")) {
      assert.deepEqual(JSON.parse(line), {});
    }

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    for (const eventName of [
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
      "StopFailure",
      "SubagentStart",
      "SubagentStop",
      "SessionEnd"
    ]) {
      assert.equal(settings.hooks[eventName][0].hooks[0].timeout, 3);
      assert.match(settings.hooks[eventName][0].hooks[0].command, /--source/);
      assert.match(settings.hooks[eventName][0].hooks[0].command, /claude/);
      assert.match(
        settings.hooks[eventName][0].hooks[0].command,
        /--koed-home/
      );
      assert.doesNotMatch(
        settings.hooks[eventName][0].hooks[0].command,
        /MEMORY_API_(TOKEN|URL)/
      );
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("claude configure preserves an unrelated user-scoped MCP name collision", async () => {
  const directory = path.join(
    realpathSync(tmpdir()),
    `koed-configure-claude-collision-${process.pid}-${Date.now()}`
  );
  const argsPath = path.join(directory, "claude-args.jsonl");
  const executable = path.join(directory, "claude-fixture.mjs");
  mkdirSync(path.join(directory, "packages/mcp-server/dist"), {
    recursive: true
  });
  writeFileSync(path.join(directory, "packages/mcp-server/dist/cli.js"), "");
  writeFileSync(
    path.join(directory, "packages/mcp-server/dist/capture-hook.js"),
    ""
  );
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      'if (process.argv[2] === "auth") process.exit(0);',
      'if (process.argv[2] === "mcp" && process.argv[3] === "get") { console.log("koed:\\n  Type: stdio\\n  Command: node\\n  Args: /other/mcp-server/dist/cli.js\\n  Environment:\\n    KOED_HOME=/other"); process.exit(0); }'
    ].join("\n")
  );
  chmodSync(executable, 0o700);

  try {
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath], {
        cwd: directory,
        env: {
          ...process.env,
          HOME: directory,
          KOED_CLAUDE_CODE_EXECUTABLE: executable,
          KOED_HOME: path.join(directory, "koed")
        }
      }),
      /unrelated user-scoped MCP server/
    );
    const invocations = readFileSync(argsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      invocations.some(
        (args) =>
          args[0] === "mcp" && (args[1] === "remove" || args[1] === "add")
      ),
      false
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

const backgroundFixture = (settings = {}, options = {}) => {
  const root = path.join(
    realpathSync(tmpdir()),
    `koed-claude-background-script-${process.pid}-${Math.random().toString(16).slice(2)}${options.spacedRepo ? " spaced repo" : ""}`
  );
  const koedHome = path.join(root, "koed");
  const configHome = path.join(root, "isolated-claude");
  const settingsPath = path.join(configHome, "settings.json");
  const statePath = path.join(root, "installed.json");
  const argsPath = path.join(root, "claude-args.jsonl");
  const executable = path.join(root, "claude-fixture.mjs");
  const mcpCli = path.join(root, "packages/mcp-server/dist/cli.js");
  mkdirSync(path.dirname(mcpCli), { recursive: true });
  mkdirSync(configHome);
  writeFileSync(mcpCli, "");
  writeFileSync(path.join(path.dirname(mcpCli), "capture-hook.js"), "");
  writeFileSync(settingsPath, JSON.stringify(settings));
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";',
      `const args = process.argv.slice(2); appendFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args) + "\\n");`,
      `if (args[0] === "--version") console.log(${JSON.stringify(options.version ?? "2.1.227 (Claude Code)")});`,
      'if (args[0] === "auth") console.log(JSON.stringify({loggedIn: true}));',
      `if (args[1] === "get") { if (!existsSync(${JSON.stringify(statePath)})) {console.error("not found"); process.exit(1);} console.log(${JSON.stringify(`koed:\n ${options.commandLine ?? `Command: ${options.previousCommand ?? "node"}`}\n Args: ${mcpCli}${options.extraArguments ?? ""}\n Environment:\n KOED_HOME=${koedHome}\n${options.extraEnvironment ?? ""}`)}); }`,
      `if (args[1] === "add") {writeFileSync(${JSON.stringify(statePath)}, "true"); ${options.failJournal ? `mkdirSync(${JSON.stringify(path.join(koedHome, "config/claude-background-recall.json"))}, {recursive: true});` : ""} ${options.failSettings ? `const {rmSync} = await import("node:fs"); rmSync(${JSON.stringify(settingsPath)}); mkdirSync(${JSON.stringify(settingsPath)});` : ""}}`,
      `if (args[1] === "remove") { const {rmSync} = await import("node:fs"); rmSync(${JSON.stringify(statePath)}, {force:true}); }`
    ].join("\n")
  );
  chmodSync(executable, 0o700);
  if (options.priorEntry) writeFileSync(statePath, "true");
  const environment = {
    ...process.env,
    HOME: root,
    KOED_HOME: koedHome,
    CLAUDE_CONFIG_DIR: configHome,
    KOED_CLAUDE_CODE_EXECUTABLE: executable
  };
  delete environment.CLAUDE_SETTINGS_PATH;
  delete environment.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS;
  delete environment.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
  const run = (args = []) =>
    execFileAsync(process.execPath, [scriptPath, ...args], {
      cwd: root,
      env: environment
    });
  const read = () => JSON.parse(readFileSync(settingsPath, "utf8"));
  return {
    root,
    koedHome,
    settingsPath,
    argsPath,
    run,
    read,
    journal: path.join(koedHome, "config/claude-background-recall.json")
  };
};
test("explicit script opt-in writes host threshold, preserves unrelated env, and removes ownership idempotently", async () => {
  const f = backgroundFixture({ theme: "dark", env: { UNRELATED: "keep" } });
  try {
    const output = await f.run(["--background-recall"]);
    assert.match(output.stdout, /all ordinary MCP calls/);
    assert.deepEqual(f.read().env, {
      UNRELATED: "keep",
      CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "500"
    });
    const journal = readFileSync(f.journal, "utf8");
    await f.run(["--background-recall"]);
    assert.equal(readFileSync(f.journal, "utf8"), journal);
    const adds = readFileSync(f.argsPath, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter((args) => args[1] === "add");
    assert.ok(
      adds.every(
        (args) =>
          !args.some((arg) =>
            arg.includes("CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS")
          )
      )
    );
    await f.run(["--remove"]);
    assert.deepEqual(f.read().env, { UNRELATED: "keep" });
    assert.equal(f.read().theme, "dark");
    assert.equal(existsSync(f.journal), false);
    await f.run(["--remove"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
for (const env of [
  { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "500" },
  { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0" },
  { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" }
]) {
  test(`script preserves prior host choices ${JSON.stringify(env)}`, async () => {
    const f = backgroundFixture({ env });
    try {
      await f.run(["--background-recall"]);
      await f.run(["--remove"]);
      assert.deepEqual(f.read().env, env);
      assert.equal(existsSync(f.journal), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}
test("script opt-in rolls back original settings if ownership journal cannot be written", async () => {
  const f = backgroundFixture({ theme: "dark" }, { failJournal: true });
  const original = readFileSync(f.settingsPath, "utf8");
  try {
    await assert.rejects(f.run(["--background-recall"]));
    assert.equal(readFileSync(f.settingsPath, "utf8"), original);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("script opt-in rejects unsupported Claude versions before profile changes", async () => {
  const f = backgroundFixture(
    { theme: "dark" },
    { version: "2.1.211 (Claude Code)" }
  );
  const original = readFileSync(f.settingsPath, "utf8");
  try {
    await assert.rejects(f.run(["--background-recall"]), /2.1.227 or newer/);
    assert.equal(readFileSync(f.settingsPath, "utf8"), original);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("script rejects lossy multi-argument MCP display before profile replacement", async () => {
  const f = backgroundFixture(
    { theme: "dark" },
    {
      priorEntry: true,
      spacedRepo: true,
      extraArguments: " --option literal value"
    }
  );
  const original = readFileSync(f.settingsPath, "utf8");
  try {
    await assert.rejects(
      f.run(["--background-recall"]),
      /unrelated user-scoped MCP server/
    );
    const calls = readFileSync(f.argsPath, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      calls.some((args) => args[1] === "add" || args[1] === "remove"),
      false
    );
    assert.equal(readFileSync(f.settingsPath, "utf8"), original);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
for (const commandLine of ["", "Command:", "Command:   "]) {
  test(`script rejects missing or blank original command ${JSON.stringify(commandLine)} without profile changes`, async () => {
    const f = backgroundFixture(
      { theme: "dark" },
      { priorEntry: true, commandLine }
    );
    const original = readFileSync(f.settingsPath, "utf8");
    try {
      await assert.rejects(
        f.run(["--background-recall"]),
        /unrelated user-scoped MCP server/
      );
      const calls = readFileSync(f.argsPath, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(
        calls.some((args) => args[1] === "add" || args[1] === "remove"),
        false
      );
      assert.equal(readFileSync(f.settingsPath, "utf8"), original);
      assert.equal(existsSync(f.journal), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}
test("script preserves native truthy disable without adding a threshold", async () => {
  const f = backgroundFixture({
    env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: " TrUe " }
  });
  try {
    const result = await f.run(["--background-recall"]);
    assert.match(result.stdout, /disable setting was preserved/);
    assert.equal(f.read().env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, " TrUe ");
    assert.equal(f.read().env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, undefined);
    assert.equal(existsSync(f.journal), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("script rollback preserves canonical spaced CLI path, original command and literal environment", async () => {
  const originalCommand = "/tmp/owned node path/node";
  const f = backgroundFixture(
    { theme: "dark" },
    {
      priorEntry: true,
      spacedRepo: true,
      previousCommand: originalCommand,
      extraEnvironment: ' LITERAL=quoted "value" with spaces\n EMPTY=\n',
      failJournal: true
    }
  );
  const original = readFileSync(f.settingsPath, "utf8");
  try {
    await assert.rejects(f.run(["--background-recall"]));
    const calls = readFileSync(f.argsPath, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    const restored = calls.filter((args) => args[1] === "add").at(-1);
    assert.equal(restored.at(-2), originalCommand);
    assert.equal(
      restored.at(-1),
      path.join(f.root, "packages/mcp-server/dist/cli.js")
    );
    assert.ok(restored.includes('LITERAL=quoted "value" with spaces'));
    assert.ok(restored.includes("EMPTY="));
    assert.equal(readFileSync(f.settingsPath, "utf8"), original);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("script restores journal independently when settings rollback fails", async () => {
  const f = backgroundFixture({ theme: "dark" }, { failSettings: true });
  try {
    await assert.rejects(
      f.run(["--background-recall"]),
      /settings rollback failed/
    );
    assert.equal(existsSync(f.journal), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
