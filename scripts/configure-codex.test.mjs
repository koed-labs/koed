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

test("deferred Codex setup installs synchronous matched delivery hooks and preserves capture", async () => {
  await withCodexFixture(async ({ config, instructions, invoke }) => {
    const unrelated =
      '# User configuration\nmodel = "user-model"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "user-stop"\n';
    writeFileSync(config, unrelated);
    writeFileSync(instructions, "# User guidance\n");
    await invoke(["--deferred-recall"], { MEMORY_MCP_NAME: "memory-local" });
    const installed = readFileSync(config, "utf8");
    assert.ok(installed.startsWith(unrelated));
    assert.match(installed, /KOED_CODEX_STOP_DELIVERY = "1"/);
    assert.match(
      installed,
      /KOED_CODEX_MEMORY_TOOL = "mcp__memory-local__memory_answer"/
    );
    assert.equal((installed.match(/^# >>> koed$/gm) ?? []).length, 1);
    const delivery = installed
      .split(/(?=^\[\[hooks\.[A-Za-z]+\]\])/m)
      .filter((part) => part.includes("codex-memory-hook.js"));
    assert.equal(delivery.length, 5);
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const block = delivery.find((part) =>
        part.startsWith(`[[hooks.${event}]]`)
      );
      assert.match(block, /matcher = "\^mcp__memory-local__memory_answer\$"/);
    }
    const stop = delivery.find((part) => part.startsWith("[[hooks.Stop]]"));
    assert.match(stop, /timeout = 305/);
    assert.doesNotMatch(stop, /async\s*=/);
    assert.match(
      delivery.find((part) => part.startsWith("[[hooks.Interrupt]]")),
      /timeout = 3/
    );
    assert.match(
      delivery.find((part) => part.startsWith("[[hooks.SessionEnd]]")),
      /timeout = 10/
    );
    assert.equal((installed.match(/capture-hook\.js/g) ?? []).length, 6);
    assert.doesNotMatch(installed, /MEMORY_API_TOKEN|MEMORY_API_URL/);
    await invoke([], {
      MEMORY_MCP_NAME: "memory-local",
      KOED_CODEX_STOP_DELIVERY: "1"
    });
    assert.equal(readFileSync(config, "utf8"), installed);
    const guidance = readFileSync(instructions, "utf8");
    await invoke(["--check"], { MEMORY_MCP_NAME: "memory-local" });
    assert.equal(readFileSync(config, "utf8"), installed);
    assert.equal(readFileSync(instructions, "utf8"), guidance);
    await invoke(["--blocking-recall"], { MEMORY_MCP_NAME: "memory-local" });
    const blocking = readFileSync(config, "utf8");
    assert.match(blocking, /KOED_CODEX_STOP_DELIVERY = "0"/);
    assert.doesNotMatch(blocking, /codex-memory-hook\.js/);
    await invoke([], { MEMORY_MCP_NAME: "memory-local" });
    assert.equal(readFileSync(config, "utf8"), blocking);
    assert.equal((blocking.match(/capture-hook\.js/g) ?? []).length, 6);
    assert.ok(blocking.startsWith(unrelated));
    await invoke(["--remove"], { MEMORY_MCP_NAME: "memory-local" });
    assert.ok(readFileSync(config, "utf8").includes(unrelated.trimEnd()));
    assert.doesNotMatch(
      readFileSync(config, "utf8"),
      /# >>> koed|capture-hook\.js/
    );
    assert.equal(readFileSync(instructions, "utf8"), "# User guidance\n");
    const removed = readFileSync(config, "utf8");
    await invoke(["--remove"]);
    assert.equal(readFileSync(config, "utf8"), removed);
  });
});

test("Codex setup defaults to deferred recall and upgrades blocks without a recorded selection", async () => {
  await withCodexFixture(async ({ config, invoke }) => {
    await invoke();
    const installed = readFileSync(config, "utf8");
    assert.match(installed, /KOED_CODEX_STOP_DELIVERY = "1"/);
    assert.match(installed, /codex-memory-hook\.js/);
    await invoke(["--check"]);
    await invoke(["--blocking-recall"]);
    const legacy = readFileSync(config, "utf8").replace(
      /^KOED_CODEX_STOP_DELIVERY = "0"\n/m,
      ""
    );
    assert.doesNotMatch(legacy, /KOED_CODEX_STOP_DELIVERY|codex-memory-hook/);
    writeFileSync(config, legacy);
    await assert.rejects(invoke(["--check"]));
    await invoke();
    assert.equal(readFileSync(config, "utf8"), installed);
  });
});

test("Codex owned-block validation and missing delivery artifact fail before configuration mutation", async () => {
  await withCodexFixture(async ({ config, instructions, dist, invoke }) => {
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
    writeFileSync(config, "# User settings\n");
    rmSync(path.join(dist, "codex-memory-hook.js"));
    await assert.rejects(
      invoke(["--deferred-recall"]),
      /Build @koed\/mcp-server/
    );
    assert.equal(readFileSync(config, "utf8"), "# User settings\n");
    await assert.rejects(invoke(), /Build @koed\/mcp-server/);
    assert.equal(readFileSync(config, "utf8"), "# User settings\n");
    await invoke(["--blocking-recall"]);
    assert.match(
      readFileSync(config, "utf8"),
      /KOED_CODEX_STOP_DELIVERY = "0"/
    );
    const installed = readFileSync(config, "utf8");
    await invoke(["--check"]);
    await assert.rejects(invoke(["--check", "--deferred-recall"]));
    assert.equal(readFileSync(config, "utf8"), installed);
    await assert.rejects(
      invoke(["--deferred-recall", "--blocking-recall"]),
      /Choose either/
    );
    await assert.rejects(invoke(["--remove", "--check"]), /Choose either/);
    assert.equal(readFileSync(config, "utf8"), installed);
  });
});

test(
  "delivery hook command passes literal home paths without shell substitution",
  { skip: process.platform === "win32" },
  async () => {
    await withCodexFixture(async ({ dir, dist, config, invoke }) => {
      const literalHome = path.join(
        dir,
        "literal ' $HOME $(touch unwanted) `whoami`"
      );
      writeFileSync(
        path.join(dist, "codex-memory-hook.js"),
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n"
      );
      await invoke(["--deferred-recall"], { KOED_HOME: literalHome });
      const block = readFileSync(config, "utf8")
        .split(/(?=^\[\[hooks\.[A-Za-z]+\]\])/m)
        .find((part) => part.startsWith("[[hooks.PreToolUse]]"));
      const command = JSON.parse(block.match(/^command = (.+)$/m)[1]);
      const { stdout } = await execFileAsync("/bin/sh", ["-c", command], {
        cwd: dir,
        env: { PATH: "/usr/bin:/bin" }
      });
      assert.deepEqual(JSON.parse(stdout), [
        "--koed-home",
        literalHome,
        "--memory-tool",
        "mcp__koed__memory_answer",
        "--wait-ms",
        "300000"
      ]);
      assert.equal(existsSync(path.join(dir, "unwanted")), false);
    });
  }
);

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
