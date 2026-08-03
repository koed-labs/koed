import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
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
  "configure-codex.mjs"
);

test("codex configure writes credential-free signal hooks and MCP credentials", async () => {
  const dir = path.join(
    realpathSync(tmpdir()),
    `koed-configure-codex-${process.pid}-${Date.now()}`
  );
  const hookConfigPath = path.join(dir, ".koed", "config.json");
  const koedHome = path.join(dir, "koed home");
  const codexConfigPath = path.join(dir, ".codex", "config.toml");
  mkdirSync(path.join(dir, "packages/mcp-server/dist"), { recursive: true });
  writeFileSync(path.join(dir, "packages/mcp-server/dist/cli.js"), "");
  writeFileSync(path.join(dir, "packages/mcp-server/dist/capture-hook.js"), "");

  try {
    await execFileAsync(process.execPath, [scriptPath], {
      cwd: dir,
      env: {
        ...process.env,
        MEMORY_API_TOKEN: "cmt_test",
        MEMORY_API_URL: "http://127.0.0.1:3300",
        MEMORY_NODE_COMMAND: "node",
        KOED_PROMPT_DIR: "custom-prompts",
        KOED_HOME: koedHome,
        CODEX_CONFIG_PATH: codexConfigPath
      }
    });

    assert.equal(existsSync(hookConfigPath), false);
    const codexConfig = readFileSync(codexConfigPath, "utf8");
    assert.match(codexConfig, /MEMORY_API_TOKEN = "cmt_test"/);
    assert.doesNotMatch(codexConfig, /capture-hook[^"\n]*--config/);
    assert.ok(
      codexConfig.includes(
        `\\"--koed-home\\" \\"${koedHome.replaceAll("\\", "\\\\")}\\"`
      )
    );
    assert.ok(
      codexConfig.includes(
        `KOED_PROMPT_DIR = ${JSON.stringify(path.join(dir, "custom-prompts"))}`
      )
    );
    for (const eventName of [
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "SubagentStart"
    ]) {
      assert.match(
        codexConfig,
        new RegExp(
          `\\[\\[hooks\\.${eventName}\\.hooks\\]\\][\\s\\S]*?timeout = 10`
        )
      );
    }
    for (const eventName of ["Stop", "SubagentStop"]) {
      assert.match(
        codexConfig,
        new RegExp(
          `\\[\\[hooks\\.${eventName}\\.hooks\\]\\][\\s\\S]*?timeout = 30`
        )
      );
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
