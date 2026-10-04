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
  claudeAuthenticationState,
  claudeMcpEntryIsKoedOwned,
  removeClaude,
  resolveClaudeExecutablePath,
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
  it("discovers the newest valid Claude Desktop bundled executable on macOS", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-desktop-"));
    temporaryDirectories.push(root);
    const installRoot = resolve(
      root,
      "Library/Application Support/Claude/claude-code"
    );
    const oldExecutable = resolve(
      installRoot,
      "2.1.286/old-hash/claude.app/Contents/MacOS/claude"
    );
    const latestNonExecutable = resolve(
      installRoot,
      "2.1.287/aaa-invalid/claude.app/Contents/MacOS/claude"
    );
    const latestExecutable = resolve(
      installRoot,
      "2.1.287/f2326db61802/claude.app/Contents/MacOS/claude"
    );
    for (const path of [oldExecutable, latestNonExecutable, latestExecutable]) {
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
    }
    chmodSync(oldExecutable, 0o755);
    chmodSync(latestExecutable, 0o755);

    expect(
      resolveClaudeExecutablePath(
        { HOME: root, PATH: "/usr/bin:/bin" },
        {},
        "darwin"
      )
    ).toBe(latestExecutable);
  });

  it("prefers a valid PATH Claude executable to the bundled app", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-path-"));
    temporaryDirectories.push(root);
    const pathExecutable = resolve(root, "bin/claude");
    const desktopExecutable = resolve(
      root,
      "Library/Application Support/Claude/claude-code/2.1.999/hash/claude.app/Contents/MacOS/claude"
    );
    for (const path of [pathExecutable, desktopExecutable]) {
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o755);
    }

    expect(
      resolveClaudeExecutablePath(
        { HOME: root, PATH: resolve(root, "bin") },
        {},
        "darwin"
      )
    ).toBe(pathExecutable);
  });

  it("keeps an explicit Claude executable override fail-closed", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-override-"));
    temporaryDirectories.push(root);
    const desktopExecutable = resolve(
      root,
      "Library/Application Support/Claude/claude-code/2.1.999/hash/claude.app/Contents/MacOS/claude"
    );
    mkdirSync(resolve(desktopExecutable, ".."), { recursive: true });
    writeFileSync(desktopExecutable, "#!/bin/sh\nexit 0\n");
    chmodSync(desktopExecutable, 0o755);

    expect(() =>
      resolveClaudeExecutablePath(
        {
          HOME: root,
          PATH: "/usr/bin:/bin",
          KOED_CLAUDE_CODE_EXECUTABLE: resolve(root, "missing/claude")
        },
        {},
        "darwin"
      )
    ).toThrow("AI Client executable was not found");
  });

  it("does not search Claude Desktop app bundles off macOS", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-platform-"));
    temporaryDirectories.push(root);
    const desktopExecutable = resolve(
      root,
      "Library/Application Support/Claude/claude-code/2.1.999/hash/claude.app/Contents/MacOS/claude"
    );
    mkdirSync(resolve(desktopExecutable, ".."), { recursive: true });
    writeFileSync(desktopExecutable, "#!/bin/sh\nexit 0\n");
    chmodSync(desktopExecutable, 0o755);

    expect(() =>
      resolveClaudeExecutablePath(
        { HOME: root, PATH: "/usr/bin:/bin" },
        {},
        "linux"
      )
    ).toThrow("AI Client executable was not found");
  });

  it("rejects a Claude Desktop GUI executable before launching it", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-gui-path-"));
    temporaryDirectories.push(root);
    const guiExecutable = resolve(
      root,
      "Applications/Claude.app/Contents/MacOS/Claude"
    );
    const spawnCalls: string[][] = [];

    const result = setupClaude(
      {
        HOME: root,
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root,
        KOED_CLAUDE_CODE_EXECUTABLE: guiExecutable
      },
      ((_command: string, args: string[]) => {
        spawnCalls.push(args);
        return spawnResult();
      }) as never
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Claude Desktop, not the Claude Code CLI");
    expect(spawnCalls).toEqual([]);
  });

  it("requires explicit Claude executable paths to be absolute", () => {
    expect(() =>
      resolveClaudeExecutablePath(
        {
          HOME: "/tmp",
          KOED_CLAUDE_CODE_EXECUTABLE: "./claude"
        },
        {},
        "darwin"
      )
    ).toThrow("KOED_CLAUDE_CODE_EXECUTABLE must be an absolute path");
  });

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

  it("recognizes a verified source MCP package during migration to packaged runtime", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-mcp-migration-"));
    temporaryDirectories.push(root);
    const sourcePackage = resolve(root, "checkout/packages/mcp-server");
    const sourceCli = resolve(sourcePackage, "dist/cli.js");
    const packagedCli = resolve(root, "koed-runtime/mcp-server/dist/cli.js");
    const koedHome = resolve(root, "koed-home");
    mkdirSync(resolve(sourceCli, ".."), { recursive: true });
    writeFileSync(
      resolve(sourcePackage, "package.json"),
      JSON.stringify({
        name: "@koed/mcp-server",
        bin: { "koed-mcp": "dist/cli.js" }
      })
    );
    writeFileSync(sourceCli, "// source Koed MCP entry\n");
    const output = `koed:\n  Command: node\n  Args: ${sourceCli}\n  Environment:\n    KOED_HOME=${koedHome}\n`;

    expect(claudeMcpEntryIsKoedOwned(output, packagedCli, koedHome)).toBe(true);
    expect(
      claudeMcpEntryIsKoedOwned(
        output,
        packagedCli,
        resolve(root, "other-home")
      )
    ).toBe(false);
  });

  it("requires Koed package metadata and its declared CLI entry for migration", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-mcp-untrusted-"));
    temporaryDirectories.push(root);
    const packageRoot = resolve(root, "checkout/packages/mcp-server");
    const candidateCli = resolve(packageRoot, "dist/cli.js");
    const koedHome = resolve(root, "koed-home");
    mkdirSync(resolve(candidateCli, ".."), { recursive: true });
    writeFileSync(
      resolve(packageRoot, "package.json"),
      JSON.stringify({
        name: "@someone-else/mcp-server",
        bin: { "koed-mcp": "dist/cli.js" }
      })
    );
    writeFileSync(candidateCli, "// unrelated CLI\n");
    const output = `koed:\n  Command: node\n  Args: ${candidateCli}\n  Environment:\n    KOED_HOME=${koedHome}\n`;

    expect(
      claudeMcpEntryIsKoedOwned(
        output,
        "/new/koed-runtime/mcp-server/dist/cli.js",
        koedHome
      )
    ).toBe(false);

    writeFileSync(
      resolve(packageRoot, "package.json"),
      JSON.stringify({
        name: "@koed/mcp-server",
        bin: { "koed-mcp": "other.js" }
      })
    );
    expect(
      claudeMcpEntryIsKoedOwned(
        output,
        "/new/koed-runtime/mcp-server/dist/cli.js",
        koedHome
      )
    ).toBe(false);

    const unrelatedCli = resolve(root, "unrelated/package/dist/cli.js");
    mkdirSync(resolve(unrelatedCli, ".."), { recursive: true });
    writeFileSync(unrelatedCli, "// same filename, unverified owner\n");
    const unrelatedOutput = output.replace(candidateCli, unrelatedCli);
    expect(
      claudeMcpEntryIsKoedOwned(
        unrelatedOutput,
        "/new/koed-runtime/mcp-server/dist/cli.js",
        koedHome
      )
    ).toBe(false);
  });

  it("verifies packaged MCP wrappers through staged @koed/mcp-server metadata", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-claude-mcp-packaged-"));
    temporaryDirectories.push(root);
    const runtimeRoot = resolve(root, "koed-runtime");
    const packagedCli = resolve(runtimeRoot, "mcp-server/dist/cli.js");
    const stagedPackage = resolve(
      runtimeRoot,
      "node_modules/@koed/mcp-server/package.json"
    );
    const koedHome = resolve(root, "koed-home");
    mkdirSync(resolve(packagedCli, ".."), { recursive: true });
    mkdirSync(resolve(stagedPackage, ".."), { recursive: true });
    writeFileSync(
      stagedPackage,
      JSON.stringify({
        name: "@koed/mcp-server",
        bin: { "koed-mcp": "dist/cli.js" }
      })
    );
    writeFileSync(
      packagedCli,
      [
        "#!/usr/bin/env node",
        'import { fileURLToPath } from "node:url";',
        'const entry = new URL("../../node_modules/@koed/mcp-server/dist/cli.js", import.meta.url);',
        "process.argv[1] = fileURLToPath(entry);",
        "await import(entry.href);",
        ""
      ].join("\n")
    );
    const output = `koed:\n  Command: node\n  Args: ${packagedCli}\n  Environment:\n    KOED_HOME=${koedHome}\n`;

    expect(
      claudeMcpEntryIsKoedOwned(
        output,
        "/new/runtime/mcp-server/dist/cli.js",
        koedHome
      )
    ).toBe(true);
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
      instances: [
        {
          instanceId: "claude.default",
          driverId: "claude",
          executablePath: "/bin/sh"
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
