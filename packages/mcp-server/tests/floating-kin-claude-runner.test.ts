import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { expect, it, vi } from "vitest";
import { runAiClientJsonTask } from "../src/ai-client-runner.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

it("closes the isolated Claude query on caller cancellation", async () => {
  const controller = new AbortController();
  let resolveClosed = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const close = vi.fn(() => resolveClosed());
  let cwd: string | undefined;
  const configHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "kin-test-profile-")
  );
  fs.writeFileSync(path.join(configHome, ".credentials.json"), "synthetic");
  vi.mocked(query).mockImplementation(({ options }) => {
    cwd = options?.cwd;
    expect(cwd).not.toBe(os.tmpdir());
    expect(options).toMatchObject({
      env: {
        CLAUDE_CONFIG_DIR: configHome,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: configHome
      },
      tools: [],
      mcpServers: {},
      skills: [],
      settingSources: [],
      extraArgs: { "safe-mode": null },
      settings: { disableAllHooks: true, autoMemoryEnabled: false },
      managedSettings: { disableAllHooks: true },
      persistSession: false,
      maxTurns: 1
    });
    expect(fs.readdirSync(path.dirname(cwd!))).toEqual(["work"]);
    setImmediate(() => controller.abort(new Error("dismissed")));
    return {
      close,
      [Symbol.asyncIterator]() {
        return {
          async next() {
            await Promise.race([
              closed,
              new Promise<void>((resolve) => setTimeout(resolve, 100))
            ]);
            return { done: true, value: undefined };
          }
        };
      }
    } as unknown as Query;
  });
  try {
    await expect(
      runAiClientJsonTask(
        "summarize",
        {
          ...summaryConfig,
          env: { CLAUDE_CONFIG_DIR: configHome },
          signal: controller.signal
        },
        300
      )
    ).rejects.toThrow("dismissed");
    expect(close).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.dirname(cwd!))).toBe(false);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

const summaryConfig = {
  provider: "claude",
  model: "haiku",
  reasoningEffort: "none",
  cwd: os.tmpdir(),
  executablePath: process.execPath,
  clientName: "test",
  systemPrompt: "summarize",
  isolatedSummary: true
} as const;

it("preserves default Keychain lookup and classifies a Claude login failure without exposing stderr", async () => {
  vi.mocked(query).mockImplementation(({ options }) => {
    expect(options?.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(options?.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
    options?.stderr?.(
      "Not logged in · Please run /login\nprivate provider details"
    );
    throw new Error("Claude process failed: private provider details");
  });
  await expect(
    runAiClientJsonTask("summarize", { ...summaryConfig, env: {} }, 300)
  ).rejects.toMatchObject({
    reason: "authentication_required"
  });
});

it("fails closed when Claude does not recognize safe mode", async () => {
  vi.mocked(query).mockImplementation(({ options }) => {
    options?.stderr?.("error: unknown option '--safe-mode'");
    throw new Error("Claude Code process exited");
  });
  await expect(
    runAiClientJsonTask("summarize", { ...summaryConfig, env: {} }, 300)
  ).rejects.toMatchObject({ reason: "safe_mode_unsupported" });
});

it("does not send evidence into a debug-enabled SDK host", async () => {
  vi.mocked(query).mockClear();
  vi.stubEnv("DEBUG_CLAUDE_AGENT_SDK", "1");
  try {
    await expect(
      runAiClientJsonTask("summarize", { ...summaryConfig, env: {} }, 300)
    ).rejects.toMatchObject({ reason: "sdk_debug_enabled" });
    expect(query).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});
