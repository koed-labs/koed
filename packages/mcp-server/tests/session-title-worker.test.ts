import { describe, expect, it } from "vitest";
import type { MemoryApiClient } from "../src/index.js";
import {
  SESSION_TITLE_PROMPT_VERSION,
  buildSessionTitlePrompt,
  generatePendingSessionTitles,
  type SessionTitleCandidate
} from "../src/session-title-worker.js";

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
      content: "Can we rename chat titles in the Koed history browser?",
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
        env: process.env
      },
      runner: async () => ({
        title: "History Browser Titles",
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
          title: "History Browser Titles",
          titleModel: "codex-app-server:test",
          titlePromptVersion: SESSION_TITLE_PROMPT_VERSION
        }
      }
    ]);
  });
});
