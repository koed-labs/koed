import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_HOOK_EVENTS,
  claudeMcpEntryIsKoedOwned,
  setupClaude
} from "./claude-setup.js";

const temporaryDirectories: string[] = [];
const spawnResult = (stdout = "", status = 0) =>
  ({ stdout, stderr: "", status, signal: null, pid: 1, output: [] }) as never;

afterEach(() => {
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
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    mkdirSync(resolve(root, ".claude"), { recursive: true });
    writeFileSync(mcpCli, "");
    writeFileSync(captureHook, "");
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
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];

    const result = setupClaude(
      {
        HOME: root,
        KOED_HOME: resolve(root, "koed"),
        KOED_REPO_ROOT: root,
        CLAUDE_SETTINGS_PATH: settingsPath,
        KOED_CLAUDE_CODE_EXECUTABLE: "/opt/claude",
        MEMORY_API_TOKEN: "must-not-leak",
        MEMORY_API_URL: "https://must-not-leak.example",
        ANTHROPIC_API_KEY: "provider-secret-must-not-leak",
        OPENAI_API_KEY: "other-provider-secret-must-not-leak"
      },
      ((
        _command: string,
        args: string[],
        options?: { env?: NodeJS.ProcessEnv }
      ) => {
        calls.push({ args, env: options?.env });
        return args[0] === "--version"
          ? spawnResult("2.1.227 (Claude Code)\n")
          : args[0] === "mcp" && args[1] === "get"
            ? spawnResult("", 1)
            : spawnResult();
      }) as never
    );

    expect(result).toMatchObject({ ok: true, state: "healthy" });
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
        KOED_CLAUDE_CODE_EXECUTABLE: "/opt/claude"
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
