import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import {
  aiClientExecutionIdentity,
  aiClientTaskDriverFor,
  assertClaudeCodeVersionCompatibility,
  checkClaudeCodeAvailability,
  claudeAgentSdkEffort,
  claudeAgentSdkEnvironment,
  claudeExecutableInstallationIdentity,
  claudeAgentSdkTokenUsage,
  isWslWindowsMount,
  listClaudeAgentSdkModels,
  resolveClaudeSdkExecutablePath,
  resolveClaudeCodeExecutable
} from "../src/ai-client-runner.js";

const temporaryDirectories: string[] = [];

const executable = (directory: string, name = "claude"): string => {
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, name);
  fs.writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return target;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Claude AI Client runner boundary", () => {
  it("normalizes Claude model usage into the shared token usage shape", () => {
    const tokenUsage = claudeAgentSdkTokenUsage({
      type: "result",
      modelUsage: {
        sonnet: {
          inputTokens: 100,
          outputTokens: 25,
          cacheReadInputTokens: 40,
          cacheCreationInputTokens: 10,
          contextWindow: 200_000
        },
        haiku: {
          inputTokens: 20,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 100_000
        }
      }
    } as never);

    expect(tokenUsage).toEqual({
      last: {
        inputTokens: 120,
        cachedInputTokens: 40,
        outputTokens: 30,
        totalTokens: 150
      },
      total: {
        inputTokens: 120,
        cachedInputTokens: 40,
        outputTokens: 30,
        totalTokens: 150
      },
      modelContextWindow: 200_000
    });
  });

  it("passes only explicit Claude effort values and never coerces an invalid option", () => {
    expect(claudeAgentSdkEffort("none")).toBeUndefined();
    expect(claudeAgentSdkEffort("low")).toBe("low");
    expect(claudeAgentSdkEffort("max")).toBe("max");
    expect(() => claudeAgentSdkEffort("minimal")).toThrow(
      "Unsupported Claude reasoning effort"
    );
  });

  it("derives provider-specific execution identity", () => {
    expect(aiClientExecutionIdentity("codex", "codex.work")).toMatchObject({
      aiClientInstanceId: "codex.work",
      transport: "app_server",
      sourceAdapterVersion: "codex-app-server-v1"
    });
    expect(aiClientExecutionIdentity("claude", "claude.work")).toMatchObject({
      aiClientInstanceId: "claude.work",
      transport: "agent_sdk",
      sourceRuntime: "claude-code",
      sourceAdapterVersion: "claude-agent-sdk-v1",
      usageSource: "connector_native"
    });
  });

  it("fails explicitly for an unavailable open driver ID", () => {
    expect(() => aiClientTaskDriverFor("future-client")).toThrow(
      'driver "future-client" is not available'
    );
  });

  it("rejects a relative executable override", () => {
    expect(() =>
      resolveClaudeCodeExecutable({
        KOED_CLAUDE_CODE_EXECUTABLE: "./claude"
      })
    ).toThrow("must be an absolute path");
  });

  it("uses the explicit canonical executable instead of a PATH shadow", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-claude-path-"));
    temporaryDirectories.push(root);
    const configured = executable(path.join(root, "confirmed"));
    executable(path.join(root, "shadow"));

    expect(
      resolveClaudeCodeExecutable({
        HOME: root,
        PATH: path.join(root, "shadow"),
        KOED_CLAUDE_CODE_EXECUTABLE: configured
      })
    ).toBe(fs.realpathSync(configured));
  });

  it("uses a confirmed unchanged installation before PATH and ignores a stale identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-claude-cache-"));
    temporaryDirectories.push(root);
    const remembered = executable(path.join(root, "remembered"));
    const pathShadow = executable(path.join(root, "path"));
    const cache = path.join(root, "state", "claude.json");
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(
      cache,
      JSON.stringify({
        version: 1,
        executablePath: remembered,
        installationIdentity: claudeExecutableInstallationIdentity(remembered)
      })
    );

    const env = {
      HOME: root,
      PATH: path.dirname(pathShadow),
      KOED_CLAUDE_CODE_DISCOVERY_CACHE: cache
    };
    expect(resolveClaudeCodeExecutable(env)).toBe(fs.realpathSync(remembered));

    fs.appendFileSync(remembered, "# changed\n");
    expect(resolveClaudeCodeExecutable(env)).toBe(fs.realpathSync(pathShadow));
  });

  it("records a confirmed installation only after version and auth probes succeed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-claude-probe-"));
    temporaryDirectories.push(root);
    const binaryDirectory = path.join(root, "bin");
    fs.mkdirSync(binaryDirectory, { recursive: true });
    const target = path.join(binaryDirectory, "claude");
    fs.writeFileSync(
      target,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.227"; else echo \'{"loggedIn":true,"authMethod":"subscription"}\'; fi\n',
      { mode: 0o700 }
    );
    const cache = path.join(root, "state", "claude.json");
    const availability = await checkClaudeCodeAvailability({
      HOME: root,
      PATH: binaryDirectory,
      KOED_CLAUDE_CODE_DISCOVERY_CACHE: cache
    });

    expect(availability).toMatchObject({
      available: true,
      version: "2.1.227",
      authenticated: true
    });
    expect(JSON.parse(fs.readFileSync(cache, "utf8"))).toMatchObject({
      version: 1,
      executablePath: fs.realpathSync(target),
      installationIdentity: claudeExecutableInstallationIdentity(target)
    });
  });

  it("rejects unparseable and older Claude Code versions", () => {
    expect(() => assertClaudeCodeVersionCompatibility("2.1.227")).not.toThrow();
    expect(() =>
      assertClaudeCodeVersionCompatibility("2.2.0 (Claude Code)")
    ).not.toThrow();
    expect(() => assertClaudeCodeVersionCompatibility("2.1.226")).toThrow(
      "requires Claude Code 2.1.227 or newer"
    );
    expect(() => assertClaudeCodeVersionCompatibility("unknown")).toThrow(
      "is incompatible"
    );
  });

  it("discovers models through SDK initialization without yielding a prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-claude-models-"));
    temporaryDirectories.push(root);
    const target = executable(path.join(root, "bin"));
    let inputState: "idle" | "yielded" = "idle";
    const queryFactory = ((input: {
      prompt: AsyncIterable<unknown>;
      options: { abortController: AbortController };
    }) => {
      const pendingInput = input.prompt[Symbol.asyncIterator]()
        .next()
        .then(() => {
          inputState = "yielded";
        });
      return {
        async supportedModels() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          expect(inputState).toBe("idle");
          return [
            {
              value: "claude-haiku",
              displayName: "Claude Haiku",
              description: "Fast model"
            }
          ];
        },
        close() {
          input.options.abortController.abort();
          void pendingInput;
        }
      };
    }) as never;

    await expect(
      listClaudeAgentSdkModels(
        {
          HOME: root,
          PATH: path.dirname(target),
          KOED_CLAUDE_CODE_EXECUTABLE: target
        },
        queryFactory
      )
    ).resolves.toEqual([
      {
        value: "claude-haiku",
        displayName: "Claude Haiku",
        description: "Fast model"
      }
    ]);
  });

  it("honors Windows PATHEXT order and resolves shims to an SDK-safe package entry", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-claude-platform-")
    );
    temporaryDirectories.push(root);
    const windowsBin = path.join(root, "windows-bin");
    executable(windowsBin, "claude.cmd");
    const packageEntry = executable(
      path.join(windowsBin, "node_modules", "@anthropic-ai", "claude-code"),
      "cli.js"
    );
    executable(windowsBin, "claude.exe");
    expect(
      resolveClaudeCodeExecutable(
        { HOME: root, PATH: windowsBin, PATHEXT: ".CMD;.EXE" },
        { platform: "win32", homeDirectory: root, isWsl: false }
      )
    ).toBe(fs.realpathSync(packageEntry));

    const macHint = executable(path.join(root, ".local", "bin"));
    expect(
      resolveClaudeCodeExecutable(
        { HOME: root, PATH: "/missing" },
        { platform: "darwin", homeDirectory: root, isWsl: false }
      )
    ).toBe(fs.realpathSync(macHint));
  });

  it("fails closed when a Windows command shim has no verifiable SDK entry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-claude-shim-"));
    temporaryDirectories.push(root);
    const shim = executable(root, "claude.cmd");
    expect(() => resolveClaudeSdkExecutablePath(shim, "win32")).toThrow(
      "cannot be passed safely"
    );
  });

  it("keeps WSL separate from Windows executables and rejects cwd PATH entries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-claude-wsl-"));
    temporaryDirectories.push(root);
    executable(root);
    expect(() =>
      resolveClaudeCodeExecutable(
        { HOME: root, PATH: ":relative" },
        { platform: "linux", homeDirectory: root, isWsl: true }
      )
    ).toThrow("Claude Code was not found");
    expect(isWslWindowsMount("/mnt/c/Users/alice/claude.exe")).toBe(true);
    expect(isWslWindowsMount("/home/alice/.local/bin/claude")).toBe(false);
    expect(() =>
      resolveClaudeCodeExecutable(
        {
          HOME: root,
          PATH: "/missing",
          KOED_CLAUDE_CODE_EXECUTABLE: "/mnt/c/Users/alice/claude.exe"
        },
        { platform: "linux", homeDirectory: root, isWsl: true }
      )
    ).toThrow("separate execution boundary");
  });

  it("does not search the Project cwd unless it is explicitly on PATH", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-claude-cwd-"));
    temporaryDirectories.push(root);
    executable(root);

    expect(() =>
      resolveClaudeCodeExecutable({ HOME: root, PATH: "/nonexistent" })
    ).toThrow("Claude Code was not found");
  });

  it("passes only the bounded environment and removes provider credentials", () => {
    expect(
      claudeAgentSdkEnvironment(
        {
          HOME: "/home/alice",
          PATH: "/usr/bin",
          CLAUDE_CONFIG_DIR: "/home/alice/.claude-work",
          ANTHROPIC_API_KEY: "must-not-pass",
          DATABASE_URL: "must-not-pass",
          MEMORY_API_TOKEN: "must-not-pass"
        },
        "test"
      )
    ).toEqual({
      HOME: "/home/alice",
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/home/alice/.claude-work",
      CLAUDE_AGENT_SDK_CLIENT_APP: "koed/test"
    });
  });

  it("pins an SDK package that contains no bundled Claude executable", () => {
    const require = createRequire(import.meta.url);
    const packageRoot = path.dirname(
      require.resolve("@anthropic-ai/claude-agent-sdk")
    );
    const files = fs
      .readdirSync(packageRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name.toLowerCase());

    expect(files).not.toContain("claude");
    expect(files).not.toContain("claude.exe");
    expect(files).not.toContain("claude.cmd");
  });
});
