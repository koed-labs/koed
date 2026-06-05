import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryApiClient } from "../src/index.js";
import {
  SESSION_TITLE_PROMPT_VERSION,
  buildSessionTitlePrompt,
  generatePendingSessionTitles,
  type SessionTitleCandidate
} from "../src/session-title-worker.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

const tempLockPath = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "koed-title-test-"));
  tempDirs.push(directory);
  return path.join(directory, "lcm-summary.lock");
};

const candidate: SessionTitleCandidate = {
  id: "00000000-0000-4000-8000-000000000101",
  externalSessionId: "019e-title-test",
  projectName: "koed-self-hosted",
  projectPath: "/workspace/koed-self-hosted",
  currentTitle: "019e-title-test",
  eventCount: 3,
  sourceItems: [
    {
      id: "00000000-0000-4000-8000-000000000102",
      actor: "user",
      content: "Can we rename chat titles in Koed Explorer?",
      capturedAt: "2026-06-02T10:00:00.000Z"
    },
    {
      id: "00000000-0000-4000-8000-000000000103",
      actor: "assistant",
      content: "We can add manual rename plus generated short titles.",
      capturedAt: "2026-06-02T10:01:00.000Z"
    }
  ]
};

describe("session title worker", () => {
  it("builds a strict local JSON title prompt", () => {
    const prompt = buildSessionTitlePrompt(candidate);

    expect(prompt).toContain("Return only one JSON object");
    expect(prompt).toContain('"title"');
    expect(prompt).toContain("Do not include a UUID");
    expect(prompt).toContain("Can we rename chat titles");
    expect(prompt).toContain(candidate.id);
  });

  it("bounds large source excerpts before building the title prompt", () => {
    const prompt = buildSessionTitlePrompt({
      ...candidate,
      sourceItems: [
        {
          ...candidate.sourceItems[0]!,
          content: `start ${"large paste ".repeat(2_000)} end`
        }
      ]
    });

    expect(prompt).toContain("start large paste");
    expect(prompt).toContain("[truncated]");
    expect(prompt).not.toContain(" end");
    expect(prompt.length).toBeLessThan(2_000);
  });

  it("removes Codex environment and IDE wrappers from title evidence", () => {
    const wrappedPrompt = `<environment_context>
  <cwd>/Users/hill399/code/@koed-labs/koed-self-hosted</cwd>
</environment_context>

# Context from my IDE setup:

## Active file: koed-self-hosted/packages/core/src/index.test.ts

## My request for Codex:
Please review the IDE parser parity fix.`;
    const prompt = buildSessionTitlePrompt({
      ...candidate,
      currentTitle: wrappedPrompt,
      sourceItems: [
        {
          ...candidate.sourceItems[0]!,
          content: wrappedPrompt
        }
      ]
    });

    expect(prompt).toContain("Please review the IDE parser parity fix.");
    expect(prompt).not.toContain("<environment_context>");
    expect(prompt).not.toContain("Context from my IDE setup");
    expect(prompt).not.toContain("Active file:");
  });

  it("submits generated titles for pending sessions", async () => {
    const submitted: unknown[] = [];
    const client = {
      async listPendingSessionTitles(input: Record<string, unknown>) {
        expect(input).toMatchObject({ limit: 2, minUserEvents: 3 });
        return { sessions: [candidate] };
      },
      async submitSessionTitle(
        sessionId: string,
        input: Record<string, unknown>
      ) {
        submitted.push({ sessionId, input });
        return { sessionId, title: input.title };
      }
    } as unknown as MemoryApiClient;

    const result = await generatePendingSessionTitles(client, {
      limit: 2,
      minUserEvents: 3,
      config: {
        provider: "codex",
        model: "codex-app-server:test",
        reasoningEffort: "low",
        timeoutMs: 1,
        maxAttempts: 1,
        retryDelayMs: 0,
        concurrency: 1,
        maxPromptTokens: 1000,
        appServerBinary: "codex",
        cwd: process.cwd(),
        env: {
          ...process.env,
          MEMORY_LCM_SUMMARY_LOCK_PATH: await tempLockPath()
        }
      },
      runner: async () => ({
        title: "Explorer Titles",
        model: "codex-app-server:test"
      })
    });

    expect(result).toMatchObject({
      requestedLimit: 2,
      minUserEvents: 3,
      processedCount: 1,
      submittedCount: 1,
      failedCount: 0
    });
    expect(submitted).toEqual([
      {
        sessionId: candidate.id,
        input: {
          title: "Explorer Titles",
          titleModel: "codex-app-server:test",
          titlePromptVersion: SESSION_TITLE_PROMPT_VERSION
        }
      }
    ]);
  });

  it("skips title generation while another local memory worker holds the lock", async () => {
    const lockPath = await tempLockPath();
    await writeFile(lockPath, JSON.stringify({ pid: process.pid }));
    let listed = false;
    const client = {
      async listPendingSessionTitles() {
        listed = true;
        return { sessions: [candidate] };
      }
    } as unknown as MemoryApiClient;

    const result = await generatePendingSessionTitles(client, {
      limit: 1,
      config: {
        provider: "codex",
        model: "codex-app-server:test",
        reasoningEffort: "low",
        timeoutMs: 1,
        maxAttempts: 1,
        retryDelayMs: 0,
        concurrency: 1,
        maxPromptTokens: 1000,
        appServerBinary: "codex",
        cwd: process.cwd(),
        env: {
          ...process.env,
          MEMORY_LCM_SUMMARY_LOCK_PATH: lockPath
        }
      }
    });

    expect(listed).toBe(false);
    expect(result).toMatchObject({
      processedCount: 0,
      submittedCount: 0,
      skippedReason: "already_running"
    });
  });
});
