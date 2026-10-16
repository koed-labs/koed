import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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

test("codex configure writes credential-free hooks and pre-approved read-only recall", async () => {
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
  writeFileSync(
    path.join(dir, "packages/mcp-server/dist/codex-memory-hook.js"),
    ""
  );
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
    assert.ok(
      codexConfig.includes(
        '[mcp_servers.koed.tools.memory_answer]\napproval_mode = "approve"'
      )
    );
    assert.doesNotMatch(codexConfig, /MEMORY_API_URL/);
    assert.ok(
      codexConfig.includes(
        '[mcp_servers.koed.tools.memory_workspaces]\napproval_mode = "approve"'
      )
    );
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
      "PreToolUse",
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

const withCodexFixture = async (run) => {
  const dir = mkdtempSync(
    path.join(realpathSync(tmpdir()), "koed-codex-delivery-")
  );
  const dist = path.join(dir, "packages/mcp-server/dist");
  const codexHome = path.join(dir, "profile");
  mkdirSync(dist, { recursive: true });
  mkdirSync(codexHome);
  for (const name of ["cli.js", "capture-hook.js", "codex-memory-hook.js"]) {
    writeFileSync(path.join(dist, name), "");
  }
  stageGuidance(dir);
  const config = path.join(codexHome, "config.toml");
  const instructions = path.join(codexHome, "AGENTS.md");
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: dir,
    CODEX_HOME: codexHome,
    KOED_HOME: path.join(dir, "koed home"),
    MEMORY_NODE_COMMAND: process.execPath
  };
  const invoke = (args = [], overrides = {}) =>
    execFileAsync(process.execPath, [scriptPath, ...args], {
      cwd: dir,
      env: { ...env, ...overrides }
    });
  try {
    await run({ dir, dist, codexHome, config, instructions, env, invoke });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("Codex task setup preserves capture, user settings, and managed guidance", async () => {
  await withCodexFixture(async ({ config, instructions, dist, invoke }) => {
    const unrelated =
      '# User configuration\nmodel = "user-model"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "user-stop"\n';
    writeFileSync(config, unrelated);
    writeFileSync(instructions, "# User guidance\n");
    rmSync(path.join(dist, "codex-memory-hook.js"));
    const { stdout } = await invoke(["--deferred-recall"], {
      MEMORY_MCP_NAME: "memory-local"
    });
    assert.match(stdout, /deprecated/);
    const installed = readFileSync(config, "utf8");
    assert.ok(installed.startsWith(unrelated));
    for (const tool of [
      "memory_answer",
      "memory_answer_result",
      "memory_answer_cancel",
      "memory_workspaces"
    ]) {
      assert.ok(
        installed.includes(
          `[mcp_servers.memory-local.tools.${tool}]\napproval_mode = "approve"`
        )
      );
    }
    for (const event of [
      "PreToolUse",
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
      "SubagentStart",
      "SubagentStop"
    ]) {
      const groups = installed.split(/(?=^\[\[hooks\.[A-Za-z]+\]\])/m);
      assert.ok(
        groups.some(
          (part) =>
            part.startsWith(`[[hooks.${event}]]`) &&
            part.includes("capture-hook.js")
        )
      );
    }
    assert.equal((installed.match(/capture-hook\.js/g) ?? []).length, 7);
    assert.ok(
      installed.includes(
        '[[hooks.PreToolUse]]\nmatcher = "mcp__memory-local__memory_answer"'
      )
    );
    await invoke(["--check"], { MEMORY_MCP_NAME: "memory-local" });
    await invoke(["--blocking-recall"], { MEMORY_MCP_NAME: "memory-local" });
    assert.equal(readFileSync(config, "utf8"), installed);
    await invoke([], {
      MEMORY_MCP_NAME: "memory-local",
      KOED_CODEX_STOP_DELIVERY: "1"
    });
    assert.equal(readFileSync(config, "utf8"), installed);
    await invoke(["--remove"], { MEMORY_MCP_NAME: "memory-local" });
    assert.ok(readFileSync(config, "utf8").includes(unrelated.trimEnd()));
    assert.equal(readFileSync(instructions, "utf8"), "# User guidance\n");
  });
});

test("Codex setup reconciles older owned configuration into task collection", async () => {
  await withCodexFixture(async ({ config, invoke }) => {
    const unrelated = 'model = "user-model"\n';
    writeFileSync(
      config,
      unrelated +
        '\n# >>> koed\n[mcp_servers.koed.env]\nKOED_CODEX_STOP_DELIVERY = "1"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "node codex-memory-hook.js"\ntimeout = 305\n# <<< koed\n'
    );
    await assert.rejects(invoke(["--check"]));
    await invoke();
    const installed = readFileSync(config, "utf8");
    assert.ok(installed.startsWith(unrelated));
    assert.equal((installed.match(/^# >>> koed$/gm) ?? []).length, 1);
    const stopGroups = installed
      .split(/(?=^\[\[hooks\.[A-Za-z]+\]\])/m)
      .filter((part) => part.startsWith("[[hooks.Stop]]"));
    assert.equal(stopGroups.length, 1);
    assert.match(stopGroups[0], /capture-hook\.js/);
    assert.match(stopGroups[0], /timeout = 30/);
    await invoke(["--check"]);
    await invoke();
    assert.equal(readFileSync(config, "utf8"), installed);
  });
});

test("Codex owned-block validation fails before configuration mutation", async () => {
  await withCodexFixture(async ({ config, instructions, invoke }) => {
    writeFileSync(
      config,
      "# User settings\n# >>> koed\n# >>> koed\n# <<< koed\n"
    );
    writeFileSync(instructions, "User instructions\n");
    const before = readFileSync(config, "utf8");
    await assert.rejects(
      invoke(["--deferred-recall"]),
      /duplicated or incomplete/
    );
    assert.equal(readFileSync(config, "utf8"), before);
    assert.equal(readFileSync(instructions, "utf8"), "User instructions\n");
    await assert.rejects(
      invoke(["--deferred-recall", "--blocking-recall"]),
      /Choose either/
    );
    await assert.rejects(invoke(["--remove", "--check"]), /Choose either/);
  });
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
  writeFileSync(
    path.join(dir, "packages/mcp-server/dist/codex-memory-hook.js"),
    ""
  );
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
  writeFileSync(
    path.join(dir, "packages/mcp-server/dist/codex-memory-hook.js"),
    ""
  );
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
  writeFileSync(
    path.join(dir, "packages/mcp-server/dist/codex-memory-hook.js"),
    ""
  );
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
