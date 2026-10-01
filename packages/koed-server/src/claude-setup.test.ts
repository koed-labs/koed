import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_HOOK_EVENTS,
  claudeAuthenticationState,
  claudeMcpEntryIsKoedOwned,
  removeClaude,
  setupClaude
} from "./claude-setup.js";

const temporaryDirectories: string[] = [];
const spawnResult = (stdout = "", status = 0, stderr = "") =>
  ({ stdout, stderr, status, signal: null, pid: 1, output: [] }) as never;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Claude Code setup", () => {
  it("requires a successful explicit logged-in auth probe", () => {
    expect(claudeAuthenticationState(spawnResult('{"loggedIn":true}', 1))).toBe(
      "unknown"
    );
    expect(claudeAuthenticationState(spawnResult("", 0))).toBe("unknown");
    expect(claudeAuthenticationState(spawnResult("probe failed", 1))).toBe(
      "unknown"
    );
    expect(claudeAuthenticationState(spawnResult('{"loggedIn":true}', 0))).toBe(
      "authenticated"
    );
  });

  it("proves MCP ownership with exact runtime and Koed home paths", () => {
    const output =
      "koed:\n  Command: node\n  Args: /expected/mcp-server/dist/cli.js\n  Environment:\n    KOED_HOME=/expected/koed\n";

    expect(
      claudeMcpEntryIsKoedOwned(
        output,
        "/expected/mcp-server/dist/cli.js",
        "/expected/koed"
      )
    ).toBe(true);
    expect(
      claudeMcpEntryIsKoedOwned(
        output,
        "/other/mcp-server/dist/cli.js",
        "/other/koed"
      )
    ).toBe(false);
  });

  it("preserves unrelated settings and configures credential-free MCP and hooks", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-setup-"));
    temporaryDirectories.push(root);
    const settingsPath = resolve(root, ".claude/settings.json");
    const mcpCli = resolve(root, "packages/mcp-server/dist/cli.js");
    const captureHook = resolve(
      root,
      "packages/mcp-server/dist/capture-hook.js"
    );
    const claudeExecutable = resolve(root, ".local/bin/claude");
    const claudeNodeEntry = resolve(
      root,
      ".local/lib/node_modules/@anthropic-ai/claude-code/cli.js"
    );
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    mkdirSync(resolve(root, ".claude"), { recursive: true });
    mkdirSync(resolve(root, ".local/bin"), { recursive: true });
    mkdirSync(resolve(claudeNodeEntry, ".."), { recursive: true });
    writeFileSync(mcpCli, "");
    writeFileSync(captureHook, "");
    writeFileSync(claudeNodeEntry, "process.exit(0);\n");
    chmodSync(claudeNodeEntry, 0o755);
    symlinkSync(claudeNodeEntry, claudeExecutable);
    const canonicalClaudeNodeEntry = realpathSync(claudeNodeEntry);
    writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: "dark",
        hooks: {
          SessionStart: [
            { hooks: [{ command: "unrelated-hook" }] },
            {
              hooks: [
                {
                  command:
                    "node /old/runtime/capture-hook.js --source claude --koed-home /old/koed"
                }
              ]
            }
          ]
        }
      })
    );
    const calls: Array<{
      command: string;
      args: string[];
      rawArgs: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");

    const result = setupClaude(
      {
        HOME: root,
        PATH: "/usr/bin:/bin",
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root,
        CLAUDE_SETTINGS_PATH: settingsPath,
        MEMORY_API_TOKEN: "must-not-leak",
        MEMORY_API_URL: "https://must-not-leak.example",
        ANTHROPIC_API_KEY: "provider-secret-must-not-leak",
        OPENAI_API_KEY: "other-provider-secret-must-not-leak"
      },
      ((
        command: string,
        rawArgs: string[],
        options?: { env?: NodeJS.ProcessEnv }
      ) => {
        const args = command === process.execPath ? rawArgs.slice(1) : rawArgs;
        calls.push({ command, args, rawArgs, env: options?.env });
        return args[0] === "--version"
          ? spawnResult("2.1.227 (Claude Code)\n")
          : args[0] === "auth"
            ? spawnResult('{"loggedIn":true}\n')
            : args[0] === "mcp" && args[1] === "get"
              ? spawnResult("", 1)
              : spawnResult();
      }) as never
    );

    expect(result).toMatchObject({ ok: true, state: "healthy" });
    expect(calls.every(({ command }) => command === process.execPath)).toBe(
      true
    );
    expect(
      calls.every(({ rawArgs }) => rawArgs[0] === canonicalClaudeNodeEntry)
    ).toBe(true);
    expect(calls.every(({ env }) => env?.ELECTRON_RUN_AS_NODE === "1")).toBe(
      true
    );
    const add = calls.find(
      ({ args }) => args[0] === "mcp" && args[1] === "add"
    );
    expect(add?.args).toContain(`KOED_HOME=${resolve(root, "koed")}`);
    expect(JSON.stringify(add?.args)).not.toContain("must-not-leak");
    expect(add?.env).not.toHaveProperty("MEMORY_API_TOKEN");
    expect(add?.env).not.toHaveProperty("MEMORY_API_URL");
    expect(add?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(add?.env).not.toHaveProperty("OPENAI_API_KEY");

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      theme?: unknown;
      hooks: Record<string, unknown>;
    };
    expect(settings.theme).toBe("dark");
    expect(JSON.stringify(settings.hooks.SessionStart)).toContain(
      "unrelated-hook"
    );
    expect(JSON.stringify(settings.hooks.SessionStart)).not.toContain(
      "/old/runtime/capture-hook.js"
    );
    for (const eventName of CLAUDE_HOOK_EVENTS) {
      expect(JSON.stringify(settings.hooks[eventName])).toContain(captureHook);
    }
    expect(
      JSON.parse(
        readFileSync(
          resolve(root, "koed/config/ai-client-instances.json"),
          "utf8"
        )
      )
    ).toMatchObject({
      instances: [
        {
          instanceId: "claude.default",
          executablePath: claudeExecutable
        }
      ]
    });
  });

  it("configures MCP, hooks, and registry while Claude Code is signed out", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-signed-out-"));
    temporaryDirectories.push(root);
    const settingsPath = resolve(root, ".claude/settings.json");
    const runtimeDirectory = resolve(root, "packages/mcp-server/dist");
    const mcpCli = resolve(runtimeDirectory, "cli.js");
    const captureHook = resolve(runtimeDirectory, "capture-hook.js");
    const koedHome = resolve(root, "koed");
    mkdirSync(runtimeDirectory, { recursive: true });
    mkdirSync(resolve(root, ".claude"), { recursive: true });
    writeFileSync(mcpCli, "");
    writeFileSync(captureHook, "");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: "dark",
        hooks: { SessionStart: [{ hooks: [{ command: "unrelated-hook" }] }] }
      })
    );
    const calls: string[][] = [];

    const result = setupClaude(
      {
        HOME: root,
        KOED_HOME: koedHome,
        KOED_REPO_ROOT: root,
        CLAUDE_SETTINGS_PATH: settingsPath,
        KOED_CLAUDE_CODE_EXECUTABLE: "/bin/sh"
      },
      ((_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "--version") {
          return spawnResult("2.1.227 (Claude Code)\n");
        }
        if (args[0] === "auth") {
          return spawnResult(
            '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\n',
            1
          );
        }
        if (args[0] === "mcp" && args[1] === "get") {
          return spawnResult("", 1, "not found");
        }
        return spawnResult();
      }) as never
    );

    expect(result).toMatchObject({
      ok: true,
      state: "needs_attention",
      profileConfigured: true,
      authenticationState: "unauthenticated",
      executionCapabilities: "unavailable"
    });
    expect(result.action).toContain("claude auth login");
    expect(calls).toContainEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "koed",
      "--env",
      `KOED_HOME=${koedHome}`,
      "--",
      "node",
      mcpCli
    ]);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      theme: string;
      hooks: Record<string, unknown>;
    };
    expect(settings.theme).toBe("dark");
    expect(JSON.stringify(settings.hooks.SessionStart)).toContain(
      "unrelated-hook"
    );
    for (const eventName of CLAUDE_HOOK_EVENTS) {
      expect(JSON.stringify(settings.hooks[eventName])).toContain(captureHook);
    }
    expect(
      JSON.parse(
        readFileSync(
          resolve(koedHome, "config/ai-client-instances.json"),
          "utf8"
        )
      )
    ).toMatchObject({
      instances: [{ instanceId: "claude.default", driverId: "claude" }]
    });
  });

  it("removes only Koed-owned MCP and hooks while preserving unrelated settings", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-remove-"));
    temporaryDirectories.push(root);
    const settingsPath = resolve(root, ".claude/settings.json");
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    mkdirSync(resolve(root, ".claude"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    writeFileSync(
      resolve(root, "packages/mcp-server/dist/capture-hook.js"),
      ""
    );
    const settings = {
      theme: "dark",
      hooks: {
        SessionStart: [
          { hooks: [{ command: "unrelated-hook" }] },
          {
            hooks: [
              {
                command:
                  "node capture-hook.js --source claude --koed-home /tmp/koed"
              }
            ]
          }
        ]
      }
    };
    writeFileSync(settingsPath, JSON.stringify(settings));
    const registry = resolve(root, "koed/config/ai-client-instances.json");
    mkdirSync(resolve(registry, ".."), { recursive: true });
    writeFileSync(
      registry,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "claude.default",
            driverId: "claude",
            displayName: "Claude Code",
            executablePath: "/bin/sh"
          }
        ]
      })
    );
    const mcpCli = resolve(root, "packages/mcp-server/dist/cli.js");
    const calls: string[][] = [];
    const result = removeClaude(
      {
        HOME: root,
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root,
        CLAUDE_SETTINGS_PATH: settingsPath,
        KOED_CLAUDE_CODE_EXECUTABLE: "/bin/sh",
        KOED_AI_CLIENT_INSTANCE_REGISTRY: registry
      },
      ((_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "mcp" && args[1] === "get") {
          return spawnResult(
            `koed:\n  Command: node\n  Args: ${mcpCli}\n  Environment:\n    KOED_HOME=${resolve(root, "koed")}\n`
          );
        }
        return spawnResult();
      }) as never
    );

    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual(["mcp", "get", "koed"]);
    expect(calls[1]).toEqual(["mcp", "remove", "--scope", "user", "koed"]);
    const after = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      theme?: string;
      hooks?: Record<string, unknown>;
    };
    expect(after.theme).toBe("dark");
    expect(JSON.stringify(after.hooks)).toContain("unrelated-hook");
    expect(JSON.stringify(after.hooks)).not.toContain("capture-hook.js");
  });

  it("fails when Claude MCP lookup is a command failure rather than confirmed absence", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-lookup-fail-"));
    temporaryDirectories.push(root);
    const result = removeClaude(
      {
        HOME: root,
        KOED_HOME: resolve(root, "koed"),
        KOED_CLAUDE_CODE_EXECUTABLE: "/bin/sh"
      },
      ((_command: string, args: string[]) =>
        args[0] === "mcp" && args[1] === "get"
          ? ({
              stdout: "",
              stderr: "permission denied",
              status: 1,
              output: []
            } as never)
          : spawnResult()) as never
    );
    expect(result).toMatchObject({ ok: false, state: "needs_attention" });
    expect(result.error).toContain("permission denied");
  });

  it("removes newly added MCP and leaves no MCP when later setup fails without prior entry", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-rollback-absent-"));
    temporaryDirectories.push(root);
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    writeFileSync(
      resolve(root, "packages/mcp-server/dist/capture-hook.js"),
      ""
    );
    const registry = resolve(root, "koed/config/ai-client-instances.json");
    const calls: string[][] = [];
    const result = setupClaude(
      {
        HOME: root,
        PATH: "/bin",
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root,
        KOED_CLAUDE_CODE_EXECUTABLE: "/bin/sh",
        KOED_AI_CLIENT_INSTANCE_REGISTRY: registry
      },
      ((_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "--version")
          return spawnResult("2.1.227 (Claude Code)\\n");
        if (args[0] === "auth") return spawnResult('{"loggedIn":true}\n');
        if (args[0] === "mcp" && args[1] === "get") {
          return spawnResult("", 1, "not found");
        }
        if (args[0] === "mcp" && args[1] === "add") {
          mkdirSync(resolve(registry, ".."), { recursive: true });
          writeFileSync(registry, "{");
        }
        return spawnResult();
      }) as never
    );

    expect(result.ok).toBe(false);
    const mcpCalls = calls.filter(
      ([command, action]) =>
        command === "mcp" && (action === "add" || action === "remove")
    );
    expect(mcpCalls.map((args) => args.slice(0, 2))).toEqual([
      ["mcp", "add"],
      ["mcp", "remove"]
    ]);
    expect(mcpCalls.filter((args) => args[1] === "add")).toHaveLength(1);
  });

  it("removes replacement MCP then restores prior Koed entry when later setup fails", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-rollback-prior-"));
    temporaryDirectories.push(root);
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    const mcpCli = resolve(root, "packages/mcp-server/dist/cli.js");
    writeFileSync(mcpCli, "");
    writeFileSync(
      resolve(root, "packages/mcp-server/dist/capture-hook.js"),
      ""
    );
    const koedHome = resolve(root, "koed");
    const prior = `koed:\n  Command: node\n  Args: ${mcpCli}\n  Environment:\n    KOED_HOME=${koedHome}\n`;
    const registry = resolve(koedHome, "config/ai-client-instances.json");
    const calls: string[][] = [];
    let addCalls = 0;
    const result = setupClaude(
      {
        HOME: root,
        PATH: "/bin",
        KOED_HOME: koedHome,
        KOED_REPO_ROOT: root,
        KOED_CLAUDE_CODE_EXECUTABLE: "/bin/sh",
        KOED_AI_CLIENT_INSTANCE_REGISTRY: registry
      },
      ((_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "--version")
          return spawnResult("2.1.227 (Claude Code)\\n");
        if (args[0] === "auth") return spawnResult('{"loggedIn":true}\n');
        if (args[0] === "mcp" && args[1] === "get") return spawnResult(prior);
        if (args[0] === "mcp" && args[1] === "add") {
          addCalls += 1;
          if (addCalls === 1) {
            mkdirSync(resolve(registry, ".."), { recursive: true });
            writeFileSync(registry, "{");
          }
        }
        return spawnResult();
      }) as never
    );

    expect(result.ok).toBe(false);
    const mcpCalls = calls.filter(
      ([command, action]) =>
        command === "mcp" && (action === "add" || action === "remove")
    );
    expect(mcpCalls.map((args) => args.slice(0, 2))).toEqual([
      ["mcp", "remove"],
      ["mcp", "add"],
      ["mcp", "remove"],
      ["mcp", "add"]
    ]);
    expect(mcpCalls.at(-1)).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "koed",
      "--env",
      `KOED_HOME=${koedHome}`,
      "--",
      "node",
      mcpCli
    ]);
  });

  it("refuses to replace an unrelated user-scoped MCP name collision", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-collision-"));
    temporaryDirectories.push(root);
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    writeFileSync(
      resolve(root, "packages/mcp-server/dist/capture-hook.js"),
      ""
    );
    const calls: string[][] = [];

    const result = setupClaude(
      {
        HOME: root,
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root,
        KOED_CLAUDE_CODE_EXECUTABLE: "/bin/sh"
      },
      ((_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "--version") {
          return spawnResult("2.1.227 (Claude Code)\n");
        }
        if (args[0] === "auth") return spawnResult('{"loggedIn":true}\n');
        if (args[0] === "mcp" && args[1] === "get") {
          return spawnResult(
            "koed:\n  Type: stdio\n  Command: node\n  Args: /other/mcp-server/dist/cli.js\n  Environment:\n    KOED_HOME=/other\n"
          );
        }
        return spawnResult();
      }) as never
    );

    expect(result).toMatchObject({
      ok: false,
      state: "needs_attention"
    });
    expect(result.error).toContain("unrelated user-scoped MCP server");
    expect(calls).not.toContainEqual(expect.arrayContaining(["mcp", "remove"]));
    expect(calls).not.toContainEqual(expect.arrayContaining(["mcp", "add"]));
  });
});

describe("explicit Claude background recall opt-in", () => {
  const key = "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS";
  const fixture = (
    settings: Record<string, unknown> = {},
    fixtureOptions: { commandLine?: string; installed?: boolean } = {}
  ) => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-background-"));
    temporaryDirectories.push(root);
    const koedHome = resolve(root, "koed");
    const configHome = resolve(root, "isolated-claude");
    const settingsPath = resolve(configHome, "settings.json");
    const mcpCli = resolve(root, "packages/mcp-server/dist/cli.js");
    mkdirSync(resolve(mcpCli, ".."), { recursive: true });
    mkdirSync(configHome, { recursive: true });
    writeFileSync(mcpCli, "");
    writeFileSync(resolve(mcpCli, "../capture-hook.js"), "");
    writeFileSync(settingsPath, JSON.stringify(settings));
    const environment: NodeJS.ProcessEnv = {
      HOME: root,
      KOED_HOME: koedHome,
      KOED_REPO_ROOT: root,
      CLAUDE_CONFIG_DIR: configHome,
      KOED_CLAUDE_CODE_EXECUTABLE: "/bin/sh"
    };
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    let installed = fixtureOptions.installed ?? false;
    let failRegistration = false;
    let failJournal = false;
    const journal = resolve(koedHome, "config/claude-background-recall.json");
    const registry = resolve(koedHome, "config/ai-client-instances.json");
    const spawn = ((
      _command: string,
      args: string[],
      options?: { env?: NodeJS.ProcessEnv }
    ) => {
      calls.push({ args, env: options?.env });
      if (args[0] === "--version") return spawnResult("2.1.227 (Claude Code)");
      if (args[0] === "auth") return spawnResult('{"loggedIn":true}');
      if (args[1] === "get")
        return installed
          ? spawnResult(
              `koed:\n ${fixtureOptions.commandLine ?? "Command: node"}\n Args: ${mcpCli}\n Environment:\n KOED_HOME=${koedHome}\n`
            )
          : spawnResult("", 1, "not found");
      if (args[1] === "add") {
        installed = true;
        if (failRegistration) {
          mkdirSync(resolve(registry, ".."), { recursive: true });
          writeFileSync(registry, "{");
        }
        if (failJournal) {
          mkdirSync(resolve(journal, ".."), { recursive: true });
          mkdirSync(journal);
        }
      }
      if (args[1] === "remove") installed = false;
      return spawnResult();
    }) as never;
    const read = () =>
      JSON.parse(readFileSync(settingsPath, "utf8")) as {
        env?: Record<string, unknown>;
        theme?: string;
      };
    return {
      root,
      settingsPath,
      journal,
      environment,
      calls,
      spawn,
      read,
      failRegistration: () => {
        failRegistration = true;
      },
      failJournal: () => {
        failJournal = true;
      }
    };
  };
  it.each(["", "Command:", "Command:   "])(
    "rejects missing or blank original command %j before changing MCP or profile",
    (commandLine) => {
      const f = fixture({ theme: "dark" }, { commandLine, installed: true });
      const original = readFileSync(f.settingsPath, "utf8");
      const result = setupClaude(f.environment, f.spawn, {
        backgroundRecall: true
      });
      expect(result.ok).toBe(false);
      expect(
        f.calls.some(({ args }) => args[1] === "remove" || args[1] === "add")
      ).toBe(false);
      expect(readFileSync(f.settingsPath, "utf8")).toBe(original);
      expect(existsSync(f.journal)).toBe(false);
    }
  );
  it.each(["true", "yes", "on", " TrUe "])(
    "preserves native truthy background disable %j in settings and shell",
    (value) => {
      for (const fromSettings of [true, false]) {
        const f = fixture(
          fromSettings
            ? { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: value } }
            : {}
        );
        const environment = fromSettings
          ? f.environment
          : { ...f.environment, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: value };
        const result = setupClaude(environment, f.spawn, {
          backgroundRecall: true
        });
        expect(result.backgroundRecall?.state).toBe("disabled");
        expect(f.read().env?.[key]).toBeUndefined();
        expect(existsSync(f.journal)).toBe(false);
      }
    }
  );
  it("leaves host thresholds untouched without opt-in", () => {
    const f = fixture({ theme: "dark" });
    const result = setupClaude(f.environment, f.spawn);
    expect(result.ok).toBe(true);
    expect(result.backgroundRecall).toBeUndefined();
    expect(f.read().env).toBeUndefined();
    expect(existsSync(f.journal)).toBe(false);
  });
  it("writes host settings only with opt-in, is idempotent and removes only its owned value", () => {
    const f = fixture({ theme: "dark", env: { UNRELATED: "keep" } });
    const first = setupClaude(f.environment, f.spawn, {
      backgroundRecall: true
    });
    expect(first).toMatchObject({
      ok: true,
      settingsPath: f.settingsPath,
      backgroundRecall: {
        state: "configured",
        scope: "all_mcp_calls",
        thresholdMs: "500"
      }
    });
    expect(first.backgroundRecall?.message).toContain("all ordinary MCP calls");
    expect(f.read().env).toEqual({ UNRELATED: "keep", [key]: "500" });
    const originalJournal = readFileSync(f.journal, "utf8");
    expect(
      setupClaude(f.environment, f.spawn, { backgroundRecall: true })
        .backgroundRecall?.state
    ).toBe("preserved");
    expect(readFileSync(f.journal, "utf8")).toBe(originalJournal);
    expect(
      f.calls
        .filter((c) => c.args[1] === "add")
        .every(
          (c) =>
            !c.args.some((arg) => arg.includes(key)) &&
            c.env?.[key] === undefined
        )
    ).toBe(true);
    expect(removeClaude(f.environment, f.spawn).ok).toBe(true);
    expect(f.read().env).toEqual({ UNRELATED: "keep" });
    expect(f.read().theme).toBe("dark");
    expect(existsSync(f.journal)).toBe(false);
    expect(removeClaude(f.environment, f.spawn).ok).toBe(true);
  });
  it.each(["500", "9000", "0"])(
    "preserves a pre-existing host threshold %s without ownership",
    (value) => {
      const f = fixture({ env: { [key]: value, UNRELATED: "keep" } });
      const result = setupClaude(f.environment, f.spawn, {
        backgroundRecall: true
      });
      expect(result.backgroundRecall?.state).toBe(
        value === "0" ? "disabled" : "preserved"
      );
      expect(existsSync(f.journal)).toBe(false);
      expect(removeClaude(f.environment, f.spawn).ok).toBe(true);
      expect(f.read().env?.[key]).toBe(value);
    }
  );
  it.each([
    {
      settings: { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } },
      shell: {}
    },
    { settings: {}, shell: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } },
    { settings: {}, shell: { [key]: "0" } },
    { settings: {}, shell: { [key]: "750" } }
  ])(
    "preserves existing disabling and environment choices: %j",
    ({ settings, shell }) => {
      const f = fixture(settings);
      const result = setupClaude({ ...f.environment, ...shell }, f.spawn, {
        backgroundRecall: true
      });
      expect(result.ok).toBe(true);
      expect(result.backgroundRecall?.state).not.toBe("configured");
      expect(f.read().env?.[key]).toBeUndefined();
      expect(existsSync(f.journal)).toBe(false);
    }
  );
  it("preserves a later user edit on removal and restores created env only when empty", () => {
    const f = fixture();
    expect(
      setupClaude(f.environment, f.spawn, { backgroundRecall: true }).ok
    ).toBe(true);
    const settings = f.read();
    settings.env![key] = "1250";
    settings.env!.UNRELATED = "keep";
    writeFileSync(f.settingsPath, JSON.stringify(settings));
    expect(removeClaude(f.environment, f.spawn).ok).toBe(true);
    expect(f.read().env).toEqual({ [key]: "1250", UNRELATED: "keep" });
    expect(existsSync(f.journal)).toBe(false);
    const empty = fixture();
    expect(
      setupClaude(empty.environment, empty.spawn, { backgroundRecall: true }).ok
    ).toBe(true);
    expect(removeClaude(empty.environment, empty.spawn).ok).toBe(true);
    expect(empty.read().env).toBeUndefined();
  });
  it("rejects malformed env and ownership journals before changing MCP", () => {
    const f = fixture({ env: [] });
    expect(
      setupClaude(f.environment, f.spawn, { backgroundRecall: true }).ok
    ).toBe(false);
    expect(f.calls.some((c) => c.args[1] === "add")).toBe(false);
    const malformed = fixture();
    mkdirSync(resolve(malformed.journal, ".."), { recursive: true });
    writeFileSync(malformed.journal, '{"version":1,"entries":[{}]}');
    expect(
      setupClaude(malformed.environment, malformed.spawn, {
        backgroundRecall: true
      }).ok
    ).toBe(false);
    expect(malformed.calls.some((c) => c.args[1] === "add")).toBe(false);
  });
  it("rolls back both host settings and new ownership after registry failure", () => {
    const f = fixture({ theme: "dark" });
    const before = readFileSync(f.settingsPath, "utf8");
    f.failRegistration();
    const result = setupClaude(f.environment, f.spawn, {
      backgroundRecall: true
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(f.settingsPath, "utf8")).toBe(before);
    expect(existsSync(f.journal)).toBe(false);
  });
  it("rolls back host settings when ownership journal write fails", () => {
    const f = fixture({ theme: "dark" });
    const before = readFileSync(f.settingsPath, "utf8");
    f.failJournal();
    const result = setupClaude(f.environment, f.spawn, {
      backgroundRecall: true
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(f.settingsPath, "utf8")).toBe(before);
    expect(f.calls.some((c) => c.args[1] === "remove")).toBe(true);
  });
  it("rejects symlink and publicly readable ownership journals without changing their targets", () => {
    if (process.platform === "win32") return;
    for (const kind of ["symlink", "public"]) {
      const f = fixture({ theme: "dark" });
      mkdirSync(resolve(f.journal, ".."), { recursive: true });
      const target = resolve(f.root, "unrelated-journal.json");
      const content = JSON.stringify({ version: 1, entries: [] });
      writeFileSync(target, content, { mode: 0o600 });
      if (kind === "symlink") symlinkSync(target, f.journal);
      else {
        writeFileSync(f.journal, content, { mode: 0o644 });
        chmodSync(f.journal, 0o644);
      }
      const before = readFileSync(f.settingsPath, "utf8");
      expect(
        setupClaude(f.environment, f.spawn, { backgroundRecall: true }).ok
      ).toBe(false);
      expect(f.calls.some((c) => c.args[1] === "add")).toBe(false);
      expect(readFileSync(target, "utf8")).toBe(content);
      expect(readFileSync(f.settingsPath, "utf8")).toBe(before);
    }
  });
  it("rejects duplicate settingsPath ownership records before any MCP replacement", () => {
    const f = fixture({ theme: "dark" });
    mkdirSync(resolve(f.journal, ".."), { recursive: true });
    const entry = {
      settingsPath: f.settingsPath,
      writtenValue: "500",
      createdEnv: true
    };
    writeFileSync(
      f.journal,
      JSON.stringify({ version: 1, entries: [entry, entry] }),
      { mode: 0o600 }
    );
    const result = setupClaude(f.environment, f.spawn, {
      backgroundRecall: true
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("duplicate settings paths");
    expect(f.calls.some((c) => c.args[1] === "add")).toBe(false);
  });
  it("preserves the prior ownership journal and settings when replacement registration fails", () => {
    const f = fixture({ theme: "dark" });
    expect(
      setupClaude(f.environment, f.spawn, { backgroundRecall: true }).ok
    ).toBe(true);
    const originalSettings = readFileSync(f.settingsPath, "utf8"),
      originalJournal = readFileSync(f.journal, "utf8");
    f.failRegistration();
    expect(
      setupClaude(f.environment, f.spawn, { backgroundRecall: true }).ok
    ).toBe(false);
    expect(readFileSync(f.settingsPath, "utf8")).toBe(originalSettings);
    expect(readFileSync(f.journal, "utf8")).toBe(originalJournal);
  });
  it.each(["entries", "bytes"])(
    "fails exhausted journal %s capacity before changing profile or MCP",
    (bound) => {
      const f = fixture({ theme: "dark" });
      mkdirSync(resolve(f.journal, ".."), { recursive: true });
      let entries = Array.from({ length: 128 }, (_, i) => ({
        settingsPath: `/tmp/isolated-profile-${i}/settings.json`,
        writtenValue: "500",
        createdEnv: true
      }));
      if (bound === "bytes") {
        for (let size = 3800; size < 4090; size++) {
          const candidate = Array.from({ length: 16 }, (_, i) => ({
            settingsPath: `/tmp/${i}/${"x".repeat(size)}`,
            writtenValue: "500",
            createdEnv: true
          }));
          const raw = JSON.stringify({ version: 1, entries: candidate });
          const added = JSON.stringify(
            {
              version: 1,
              entries: [
                ...candidate,
                {
                  settingsPath: f.settingsPath,
                  writtenValue: "500",
                  createdEnv: true
                }
              ]
            },
            null,
            2
          );
          if (
            Buffer.byteLength(raw) <= 65536 &&
            Buffer.byteLength(added) > 65536
          ) {
            entries = candidate;
            break;
          }
        }
        expect(entries).toHaveLength(16);
      }
      const journal = JSON.stringify({ version: 1, entries });
      writeFileSync(f.journal, journal, { mode: 0o600 });
      const before = readFileSync(f.settingsPath, "utf8");
      const result = setupClaude(f.environment, f.spawn, {
        backgroundRecall: true
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("capacity is exhausted");
      expect(
        f.calls.some((c) => c.args[1] === "add" || c.args[1] === "remove")
      ).toBe(false);
      expect(readFileSync(f.settingsPath, "utf8")).toBe(before);
      expect(readFileSync(f.journal, "utf8")).toBe(journal);
    }
  );
  it.each(["null", "[]"])(
    "rejects malformed top-level settings %s before MCP changes",
    (raw) => {
      const f = fixture();
      writeFileSync(f.settingsPath, raw);
      expect(
        setupClaude(f.environment, f.spawn, { backgroundRecall: true }).ok
      ).toBe(false);
      expect(readFileSync(f.settingsPath, "utf8")).toBe(raw);
      expect(f.calls.some((c) => c.args[1] === "add")).toBe(false);
    }
  );
  it("leaves no private sibling temp files after atomic setup, rollback and remove", () => {
    const f = fixture({ theme: "dark" });
    expect(
      setupClaude(f.environment, f.spawn, { backgroundRecall: true }).ok
    ).toBe(true);
    expect(removeClaude(f.environment, f.spawn).ok).toBe(true);
    expect(readdirSync(resolve(f.journal, ".."))).not.toContainEqual(
      expect.stringContaining(".tmp")
    );
    expect(readdirSync(resolve(f.settingsPath, ".."))).not.toContainEqual(
      expect.stringContaining(".tmp")
    );
    const failed = fixture();
    failed.failRegistration();
    expect(
      setupClaude(failed.environment, failed.spawn, { backgroundRecall: true })
        .ok
    ).toBe(false);
    expect(readdirSync(resolve(failed.journal, ".."))).not.toContainEqual(
      expect.stringContaining(".tmp")
    );
    expect(readdirSync(resolve(failed.settingsPath, ".."))).not.toContainEqual(
      expect.stringContaining(".tmp")
    );
  });
});
