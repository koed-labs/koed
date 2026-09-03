import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
  it("proves MCP ownership with exact runtime and Koed home paths", () => {
    const output =
      "koed:\n  Args: /expected/mcp-server/dist/cli.js\n  Environment:\n    KOED_HOME=/expected/koed\n";

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
            `koed:\n  Args: ${mcpCli}\n  Environment:\n    KOED_HOME=${resolve(root, "koed")}\n`
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
