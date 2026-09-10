import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalAiRuntimeClient } from "../src/local-runtime-client.js";
import { localRuntimeRegistrationPath } from "../src/local-runtime-protocol.js";
import type { MemoryAnswerTaskView } from "../src/memory-answer-task-scheduler.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const task = (
  overrides: Partial<MemoryAnswerTaskView> = {}
): MemoryAnswerTaskView => {
  const now = new Date().toISOString();
  return {
    id: "7c07a3cc-5679-4df2-bb67-c86571df93c2",
    origin: "mcp",
    questionId: null,
    status: "accepted",
    statusMessage: null,
    attemptCount: 0,
    maxAttempts: 3,
    fenceGeneration: 0,
    cancelRequestedAt: null,
    startedAt: null,
    lastProgressAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    result: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt: now,
    ...overrides
  };
};

describe("Local AI Runtime task client", () => {
  it("reconciles state after a dropped stream and delivers one terminal result", async () => {
    const koedHome = mkdtempSync(join(tmpdir(), "koed-runtime-task-client-"));
    roots.push(koedHome);
    mkdirSync(join(koedHome, "run"), { recursive: true, mode: 0o700 });
    writeFileSync(
      localRuntimeRegistrationPath(koedHome),
      JSON.stringify({
        protocolVersion: 1,
        url: "http://127.0.0.1:32123",
        authorization: `Bearer ${"a".repeat(32)}`,
        pid: process.pid,
        startedAt: new Date().toISOString()
      }),
      { mode: 0o600 }
    );
    const accepted = task();
    const running = task({ status: "running", version: 2 });
    const completed = task({
      status: "completed",
      questionId: "80c70edb-0334-4b50-9e97-8f4d240b6c22",
      completedAt: new Date().toISOString(),
      result: { markdown: "remembered" },
      version: 3
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task: accepted }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task: running }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          `id: 3\nevent: task\ndata: ${JSON.stringify(completed)}\n\n`,
          {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          }
        )
      );

    await expect(
      new LocalAiRuntimeClient(
        { KOED_HOME: koedHome },
        fetchMock
      ).waitForMemoryAnswerTask(accepted.id)
    ).resolves.toMatchObject({
      status: "completed",
      version: 3,
      result: { markdown: "remembered" }
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
