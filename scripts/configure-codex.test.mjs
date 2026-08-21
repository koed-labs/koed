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
const guidanceSourcePath = path.resolve(
  path.dirname(scriptPath),
  "../prompts/codex-global-agent-guidance.md"
);

const stageGuidance = (dir) => {
  mkdirSync(path.join(dir, "prompts"), { recursive: true });
  writeFileSync(
    path.join(dir, "prompts/codex-global-agent-guidance.md"),
    readFileSync(guidanceSourcePath, "utf8")
  );
};

test("codex configure writes credential-free signal hooks and KOED_HOME-only MCP config", async () => {
  const dir = path.join(
    realpathSync(tmpdir()),
    `koed-configure-codex-${process.pid}-${Date.now()}`
  );
  const hookConfigPath = path.join(dir, ".koed", "config.json");
  const koedHome = path.join(dir, "koed home");
  const codexConfigPath = path.join(dir, ".codex", "config.toml");
  const codexInstructionsPath = path.join(dir, ".codex", "AGENTS.md");
  mkdirSync(path.join(dir, "packages/mcp-server/dist"), { recursive: true });
  writeFileSync(path.join(dir, "packages/mcp-server/dist/cli.js"), "");
  writeFileSync(path.join(dir, "packages/mcp-server/dist/capture-hook.js"), "");
  stageGuidance(dir);

  try {
    await execFileAsync(process.execPath, [scriptPath], {
      cwd: dir,
      env: {
        ...process.env,
        MEMORY_NODE_COMMAND: "node",
        KOED_HOME: koedHome,
        CODEX_HOME: path.join(dir, ".codex"),
        CODEX_CONFIG_PATH: codexConfigPath
      }
    });

    assert.equal(existsSync(hookConfigPath), false);
    const codexConfig = readFileSync(codexConfigPath, "utf8");
    assert.ok(codexConfig.includes(`KOED_HOME = ${JSON.stringify(koedHome)}`));
    assert.doesNotMatch(codexConfig, /MEMORY_API_URL/);
    assert.doesNotMatch(codexConfig, /MEMORY_API_TOKEN/);
    assert.doesNotMatch(codexConfig, /MEMORY_CODEX_APP_SERVER_BINARY/);
    assert.doesNotMatch(codexConfig, /KOED_PROMPT_DIR/);
    assert.doesNotMatch(codexConfig, /capture-hook[^"\n]*--config/);
    assert.ok(
      codexConfig.includes(
        `\\"--koed-home\\" \\"${koedHome.replaceAll("\\", "\\\\")}\\"`
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
    const instructions = readFileSync(codexInstructionsPath, "utf8");
    assert.match(instructions, /<!-- >>> koed-memory-guidance -->/);
    assert.match(instructions, /Before beginning substantive work/);
    assert.match(instructions, /<!-- <<< koed-memory-guidance -->/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("codex configure preserves user instructions and updates one managed block", async () => {
  const dir = path.join(
    realpathSync(tmpdir()),
    `koed-configure-codex-guidance-${process.pid}-${Date.now()}`
  );
  const codexHome = path.join(dir, ".codex");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const codexInstructionsPath = path.join(codexHome, "AGENTS.md");
  mkdirSync(path.join(dir, "packages/mcp-server/dist"), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(path.join(dir, "packages/mcp-server/dist/cli.js"), "");
  writeFileSync(path.join(dir, "packages/mcp-server/dist/capture-hook.js"), "");
  stageGuidance(dir);
  writeFileSync(
    codexInstructionsPath,
    "# User rules\n\n<!-- >>> koed-memory-guidance -->\nold\n<!-- <<< koed-memory-guidance -->\n"
  );

  try {
    const environment = {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_CONFIG_PATH: codexConfigPath
    };
    await execFileAsync(process.execPath, [scriptPath], {
      cwd: dir,
      env: environment
    });
    await execFileAsync(process.execPath, [scriptPath], {
      cwd: dir,
      env: environment
    });

    const instructions = readFileSync(codexInstructionsPath, "utf8");
    assert.ok(instructions.startsWith("# User rules\n\n"));
    assert.equal(
      instructions.match(/<!-- >>> koed-memory-guidance -->/g)?.length,
      1
    );
    assert.match(instructions, /Before beginning substantive work/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("codex configure removes only managed guidance when disabled", async () => {
  const dir = path.join(
    realpathSync(tmpdir()),
    `koed-configure-codex-guidance-disabled-${process.pid}-${Date.now()}`
  );
  const codexHome = path.join(dir, ".codex");
  const codexInstructionsPath = path.join(codexHome, "AGENTS.md");
  mkdirSync(path.join(dir, "packages/mcp-server/dist"), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(path.join(dir, "packages/mcp-server/dist/cli.js"), "");
  writeFileSync(path.join(dir, "packages/mcp-server/dist/capture-hook.js"), "");
  stageGuidance(dir);
  writeFileSync(
    codexInstructionsPath,
    "# User rules\n\n<!-- >>> koed-memory-guidance -->\nold\n<!-- <<< koed-memory-guidance -->\n"
  );

  try {
    await execFileAsync(process.execPath, [scriptPath], {
      cwd: dir,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED: "false"
      }
    });
    assert.equal(readFileSync(codexInstructionsPath, "utf8"), "# User rules");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("codex configure preserves User-owned whitespace across enable and disable", async () => {
  const dir = path.join(
    realpathSync(tmpdir()),
    `koed-configure-codex-guidance-whitespace-${process.pid}-${Date.now()}`
  );
  const codexHome = path.join(dir, ".codex");
  const codexInstructionsPath = path.join(codexHome, "AGENTS.md");
  const original = "# User rules  \n    indented rule\n";
  mkdirSync(path.join(dir, "packages/mcp-server/dist"), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(path.join(dir, "packages/mcp-server/dist/cli.js"), "");
  writeFileSync(path.join(dir, "packages/mcp-server/dist/capture-hook.js"), "");
  stageGuidance(dir);
  writeFileSync(codexInstructionsPath, original);

  try {
    await execFileAsync(process.execPath, [scriptPath], {
      cwd: dir,
      env: { ...process.env, CODEX_HOME: codexHome }
    });
    rmSync(path.join(dir, "prompts"), { recursive: true, force: true });
    await execFileAsync(process.execPath, [scriptPath], {
      cwd: dir,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED: "false"
      }
    });
    assert.equal(readFileSync(codexInstructionsPath, "utf8"), original);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
