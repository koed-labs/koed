import { randomUUID } from "node:crypto";
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
  vi.mocked(query).mockImplementation(({ options }) => {
    cwd = options?.cwd;
    expect(cwd).not.toBe(os.tmpdir());
    expect(options).toMatchObject({
      tools: [],
      skills: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 1
    });
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
  await expect(
    runAiClientJsonTask(
      "summarize",
      {
        provider: "claude",
        model: "haiku",
        reasoningEffort: "low",
        cwd: os.tmpdir(),
        env: { CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), randomUUID()) },
        executablePath: process.execPath,
        clientName: "test",
        systemPrompt: "summarize",
        isolatedSummary: true,
        signal: controller.signal
      },
      300
    )
  ).rejects.toThrow("dismissed");
  expect(close).toHaveBeenCalledOnce();
  expect(fs.existsSync(path.dirname(cwd!))).toBe(false);
});
