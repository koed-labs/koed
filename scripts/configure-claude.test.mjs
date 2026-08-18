import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
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
      "appendFileSync(process.env.CLAUDE_ARGS_FILE, `${JSON.stringify(process.argv.slice(2))}\\n`);",
      'if (process.argv[2] === "auth") console.log(JSON.stringify({ loggedIn: true }));'
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
