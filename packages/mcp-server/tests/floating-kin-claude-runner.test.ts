import fs from "node:fs";
import os from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ClaudeSummaryClientError,
  runAiClientJsonTask,
  runClaudeAgentSdkTask
} from "../src/ai-client-runner.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

const summaryConfig = {
  provider: "claude",
  model: "haiku",
  reasoningEffort: "none",
  cwd: os.tmpdir(),
  executablePath: process.execPath,
  clientName: "test",
  systemPrompt: "summarize",
  env: {},
  isolatedSummary: true
} as const;

beforeEach(() => {
  vi.stubEnv("DEBUG_CLAUDE_AGENT_SDK", "");
  vi.mocked(query).mockReset();
  vi.mocked(query).mockImplementation(() => {
    throw new Error("unexpected Claude SDK launch");
  });
});

afterEach(() => vi.unstubAllEnvs());

it.each([
  { label: "default", env: {} },
  { label: "custom", env: { CLAUDE_CONFIG_DIR: "/synthetic-claude-profile" } }
])(
  "blocks isolated Claude summaries before SDK startup with a $label profile",
  async ({ env }) => {
    const run = runAiClientJsonTask(
      "synthetic evidence",
      { ...summaryConfig, env },
      300
    );
    await expect(run).rejects.toBeInstanceOf(ClaudeSummaryClientError);
    await expect(run).rejects.toMatchObject({
      reason: "hook_policy_unverified"
    });
    expect(query).not.toHaveBeenCalled();
  }
);

it("reports Claude unavailable without allocating a workspace", async () => {
  const mkdtemp = vi.spyOn(fs, "mkdtempSync").mockImplementation(() => {
    throw new Error("workspace unavailable");
  });
  try {
    await expect(
      runAiClientJsonTask("synthetic evidence", summaryConfig, 300)
    ).rejects.toMatchObject({ reason: "hook_policy_unverified" });
    expect(mkdtemp).not.toHaveBeenCalled();
  } finally {
    mkdtemp.mockRestore();
  }
});

it("blocks direct isolated Claude runner calls before SDK startup", async () => {
  await expect(
    runClaudeAgentSdkTask("synthetic evidence", summaryConfig, 300)
  ).rejects.toMatchObject({ reason: "hook_policy_unverified" });
  expect(query).not.toHaveBeenCalled();
});

it("preserves caller cancellation before SDK startup", async () => {
  const reason = new Error("dismissed");
  await expect(
    runAiClientJsonTask(
      "synthetic evidence",
      { ...summaryConfig, env: {}, signal: AbortSignal.abort(reason) },
      300
    )
  ).rejects.toBe(reason);
  expect(query).not.toHaveBeenCalled();
});

it.each([
  { label: "default", configDir: undefined, secureStorageDir: "" },
  {
    label: "custom",
    configDir: "/synthetic-claude-profile",
    secureStorageDir: "/synthetic-claude-profile"
  }
])(
  "preserves native sign-in for non-isolated Claude tasks with a $label profile",
  async ({ configDir, secureStorageDir }) => {
    const providerError = new Error("synthetic provider failure");
    vi.mocked(query).mockImplementation(({ options }) => {
      expect(options?.env?.CLAUDE_CONFIG_DIR).toBe(configDir);
      expect(options?.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(
        secureStorageDir
      );
      throw providerError;
    });
    await expect(
      runAiClientJsonTask(
        "synthetic prompt",
        {
          ...summaryConfig,
          isolatedSummary: false,
          env: { CLAUDE_CONFIG_DIR: configDir }
        },
        300
      )
    ).rejects.toBe(providerError);
  }
);

it("does not send evidence into a debug-enabled SDK host", async () => {
  vi.stubEnv("DEBUG_CLAUDE_AGENT_SDK", "1");
  await expect(
    runAiClientJsonTask(
      "synthetic evidence",
      { ...summaryConfig, env: {} },
      300
    )
  ).rejects.toMatchObject({ reason: "sdk_debug_enabled" });
  expect(query).not.toHaveBeenCalled();
});
