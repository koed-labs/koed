import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalConversationItemKey } from "@koed/shared";

const filesystemRace = vi.hoisted(() => ({
  failReaddirPath: null as string | null,
  remainingFailures: 0
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const actualReaddir = actual.readdir as (
    ...args: unknown[]
  ) => Promise<unknown>;
  return {
    ...actual,
    readdir: (...args: unknown[]) => {
      if (
        String(args[0]) === filesystemRace.failReaddirPath &&
        filesystemRace.remainingFailures > 0
      ) {
        filesystemRace.remainingFailures -= 1;
        return Promise.reject(
          Object.assign(new Error("project directory was renamed"), {
            code: "ENOENT"
          })
        );
      }
      return actualReaddir(...args);
    }
  };
});

const { getSessionMessages, getSubagentMessages, listSubagents } = vi.hoisted(
  () => ({
    getSessionMessages: vi.fn(),
    getSubagentMessages: vi.fn(),
    listSubagents: vi.fn()
  })
);

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  getSessionMessages,
  getSubagentMessages,
  listSubagents
}));

import { MemoryApiError, type MemoryApiClient } from "../src/index.js";
import { processClaudeTranscriptSignal } from "../src/claude-transcript-capture.js";
import { discoverClaudeTranscriptSignals } from "../src/claude-transcript-discovery.js";
import { registerClaudeHistoricalTranscriptSources } from "../src/claude-transcript-source.js";
import { startClaudeTranscriptWatcher } from "../src/claude-transcript-watcher.js";
import {
  claudeWatcherSignalDirectory,
  signalClaudeTranscriptWatcher
} from "../src/claude-transcript-watcher-signal.js";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  filesystemRace.failReaddirPath = null;
  filesystemRace.remainingFailures = 0;
  listSubagents.mockResolvedValue([]);
});

afterEach(() => {
  getSessionMessages.mockReset();
  getSubagentMessages.mockReset();
  listSubagents.mockReset();
  listSubagents.mockResolvedValue([]);
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-claude-watch-"));
  temporaryDirectories.push(root);
  const claudeHome = path.join(root, ".claude");
  const projectDirectory = path.join(claudeHome, "projects", "fixture");
  fs.mkdirSync(projectDirectory, { recursive: true });
  const sourceSessionId = randomUUID();
  const transcriptPath = path.join(
    projectDirectory,
    `${sourceSessionId}.jsonl`
  );
  return { root, claudeHome, sourceSessionId, transcriptPath };
};

describe("Claude transcript watcher", () => {
  it("pins component frontiers and journals only one bounded component page", async () => {
    const { claudeHome, sourceSessionId, transcriptPath } = fixture();
    const agentId = "bounded-history";
    const subagentDirectory = path.join(
      path.dirname(transcriptPath),
      sourceSessionId,
      "subagents"
    );
    const subagentPath = path.join(subagentDirectory, `agent-${agentId}.jsonl`);
    fs.mkdirSync(subagentDirectory, { recursive: true });
    const historicalRecord = (id: string, type: string) =>
      `${JSON.stringify({
        uuid: id,
        sessionId: sourceSessionId,
        cwd: "/tmp/project",
        timestamp: "2026-08-11T12:00:00.000Z",
        type,
        payload: "x".repeat(700)
      })}\n`;
    const mainHistory = [
      historicalRecord(randomUUID(), "user"),
      historicalRecord(randomUUID(), "assistant"),
      historicalRecord(randomUUID(), "assistant")
    ].join("");
    const auxiliaryHistory = historicalRecord(randomUUID(), "assistant");
    fs.writeFileSync(transcriptPath, mainHistory);
    fs.writeFileSync(subagentPath, auxiliaryHistory);
    const mainFrontier = Buffer.byteLength(mainHistory);
    const auxiliaryFrontier = Buffer.byteLength(auxiliaryHistory);
    fs.appendFileSync(
      transcriptPath,
      historicalRecord(randomUUID(), "assistant")
    );
    fs.appendFileSync(
      subagentPath,
      historicalRecord(randomUUID(), "assistant")
    );
    listSubagents.mockResolvedValue([agentId]);

    const artifacts = new Map<string, Record<string, unknown>>();
    const appended: string[] = [];
    const client = {
      async lookupConversationSourceArtifact(input: {
        sourceComponentId: string;
      }) {
        const artifact = artifacts.get(input.sourceComponentId);
        if (!artifact) throw new MemoryApiError("not found", { status: 404 });
        return { artifact };
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        const componentId = String(input.sourceComponentId);
        const artifact = {
          id: `artifact-${componentId}`,
          sessionId: randomUUID(),
          sourceComponentId: componentId,
          providerCursorOffset: 0,
          providerCursorLine: 0,
          journalStartOffset: 0,
          liveStartOffset: input.liveStartOffset
        };
        artifacts.set(componentId, artifact);
        return { artifact };
      },
      async appendConversationSourceSegment(
        artifactId: string,
        input: Record<string, unknown>
      ) {
        const componentId = artifactId.replace("artifact-", "");
        appended.push(componentId);
        const artifact = {
          ...artifacts.get(componentId),
          providerCursorOffset: input.sourceEndOffset,
          providerCursorLine: input.sourceEndLine
        };
        artifacts.set(componentId, artifact);
        return { artifact };
      }
    } as unknown as MemoryApiClient;

    const registered = await registerClaudeHistoricalTranscriptSources(
      client,
      {
        sourceSessionId,
        transcriptPath,
        cwd: "/tmp/project",
        hookEventName: "HistoricalImport"
      },
      { CLAUDE_CONFIG_DIR: claudeHome },
      {
        components: [
          {
            componentId: "main",
            componentRole: "primary",
            parentComponentId: null,
            frontierOffset: mainFrontier,
            frontierLine: 3
          },
          {
            componentId: `subagent.${agentId}`,
            componentRole: "auxiliary",
            parentComponentId: "main",
            frontierOffset: auxiliaryFrontier,
            frontierLine: 1
          }
        ],
        maxBytesPerPass: 1_024
      }
    );

    expect(appended).toEqual(["main"]);
    expect(artifacts.get("main")).toMatchObject({
      liveStartOffset: mainFrontier
    });
    expect(artifacts.get(`subagent.${agentId}`)).toMatchObject({
      liveStartOffset: auxiliaryFrontier,
      providerCursorOffset: 0
    });
    expect(registered[0]?.providerCursorOffset).toBeLessThan(mainFrontier);
    expect(
      registered.map((artifact) => artifact.registrationFrontierOffset)
    ).toEqual([mainFrontier, auxiliaryFrontier]);
  });

  it("uses the earlier activation frontier of an existing live artifact", async () => {
    const { claudeHome, sourceSessionId, transcriptPath } = fixture();
    const activationRecord = `${JSON.stringify({
      uuid: randomUUID(),
      sessionId: sourceSessionId,
      cwd: "/tmp/project",
      timestamp: "2026-08-11T12:00:00.000Z",
      type: "user"
    })}\n`;
    fs.writeFileSync(transcriptPath, activationRecord);
    const activationFrontier = Buffer.byteLength(activationRecord);
    fs.appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        uuid: randomUUID(),
        sessionId: sourceSessionId,
        cwd: "/tmp/project",
        timestamp: "2026-08-11T12:01:00.000Z",
        type: "assistant"
      })}\n`
    );
    const discoveryFrontier = fs.statSync(transcriptPath).size;
    const digest = createHash("sha256").update(activationRecord).digest("hex");
    const appendConversationSourceSegment = vi.fn();
    const client = {
      lookupConversationSourceArtifact: vi.fn(async () => ({
        artifact: {
          id: "artifact-main",
          sessionId: randomUUID(),
          sourceComponentId: "main",
          providerCursorOffset: activationFrontier,
          providerCursorLine: 1,
          journalStartOffset: 0,
          liveStartOffset: activationFrontier,
          liveStartLine: 1
        }
      })),
      listConversationSourceSegments: vi.fn(async () => ({
        segments: [
          {
            id: "segment-main",
            sourceStartOffset: 0,
            sourceEndOffset: activationFrontier,
            plaintextDigest: digest,
            plaintextSize: activationFrontier
          }
        ]
      })),
      appendConversationSourceSegment
    } as unknown as MemoryApiClient;

    const registered = await registerClaudeHistoricalTranscriptSources(
      client,
      {
        sourceSessionId,
        transcriptPath,
        cwd: "/tmp/project",
        hookEventName: "HistoricalImport"
      },
      { CLAUDE_CONFIG_DIR: claudeHome },
      {
        components: [
          {
            componentId: "main",
            componentRole: "primary",
            parentComponentId: null,
            frontierOffset: discoveryFrontier,
            frontierLine: 2
          }
        ]
      }
    );

    expect(registered[0]?.registrationFrontierOffset).toBe(activationFrontier);
    expect(appendConversationSourceSegment).not.toHaveBeenCalled();
  });

  it("retains failed signal work and converges after a transient API outage", async () => {
    const { root, claudeHome, sourceSessionId, transcriptPath } = fixture();
    const messageId = randomUUID();
    const timestamp = new Date(Date.now() + 1_000).toISOString();
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "user",
        uuid: messageId,
        sessionId: sourceSessionId,
        cwd: "/tmp/project",
        timestamp
      })}\n`
    );
    getSessionMessages.mockResolvedValue([
      {
        type: "user",
        uuid: messageId,
        message: { content: [{ type: "text", text: "Recover me" }] }
      }
    ]);
    const capturedSessionId = randomUUID();
    let artifact: Record<string, unknown> | null = null;
    const segments: Array<Record<string, unknown>> = [];
    let projectionAttempts = 0;
    let apiAvailable = false;
    const client = {
      async lookupConversationSourceArtifact() {
        if (!artifact) throw new MemoryApiError("not found", { status: 404 });
        return { artifact };
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        artifact = {
          id: randomUUID(),
          sessionId: capturedSessionId,
          sourceGenerationId: randomUUID(),
          sourceComponentId: "main",
          providerCursorOffset: input.journalStartOffset,
          providerCursorLine: input.journalStartLine,
          journalStartOffset: input.journalStartOffset
        };
        return { artifact };
      },
      async appendConversationSourceSegment(
        artifactId: string,
        input: Record<string, unknown>
      ) {
        const bytes = Buffer.from(String(input.bytesBase64), "base64");
        segments.push({
          id: randomUUID(),
          sourceStartOffset: input.expectedProviderOffset,
          sourceEndOffset: input.sourceEndOffset,
          plaintextDigest: createHash("sha256").update(bytes).digest("hex"),
          plaintextSize: bytes.length
        });
        artifact = {
          ...artifact,
          id: artifactId,
          providerCursorOffset: input.sourceEndOffset,
          providerCursorLine: input.sourceEndLine
        };
        return { artifact };
      },
      async listConversationSourceSegments() {
        return { segments };
      },
      async createConversationItems(input: {
        items: Array<Record<string, unknown>>;
      }) {
        return {
          items: input.items.map((item) => ({ ...item, id: randomUUID() }))
        };
      },
      async projectConversationItems() {
        projectionAttempts += 1;
        if (!apiAvailable) {
          throw new Error("memory API unavailable");
        }
        return {};
      }
    } as unknown as MemoryApiClient;
    const env = {
      CLAUDE_CONFIG_DIR: claudeHome,
      KOED_HOME: path.join(root, "koed"),
      MEMORY_CLAUDE_TRANSCRIPT_DEBOUNCE_MS: "25",
      MEMORY_CLAUDE_TRANSCRIPT_RETRY_BASE_MS: "100",
      MEMORY_CLAUDE_TRANSCRIPT_RETRY_MAX_MS: "100"
    };
    const watcher = startClaudeTranscriptWatcher(client, env);
    signalClaudeTranscriptWatcher(env, {
      sourceSessionId,
      transcriptPath,
      cwd: "/tmp/project",
      observedAt: timestamp
    });

    try {
      await vi.waitFor(() => expect(projectionAttempts).toBeGreaterThan(0), {
        timeout: 2_000,
        interval: 20
      });
      const signalEntries = fs.readdirSync(claudeWatcherSignalDirectory(env), {
        withFileTypes: true
      });
      expect(signalEntries).toHaveLength(1);
      expect(signalEntries[0]?.name).toMatch(/\.json$/);

      apiAvailable = true;
      const failedAttempts = projectionAttempts;
      await vi.waitFor(
        () => expect(projectionAttempts).toBeGreaterThan(failedAttempts),
        {
          timeout: 2_000,
          interval: 20
        }
      );
      await vi.waitFor(
        () =>
          expect(
            fs
              .readdirSync(claudeWatcherSignalDirectory(env))
              .filter((name) => name.endsWith(".json"))
          ).toEqual([]),
        {
          timeout: 2_000,
          interval: 20
        }
      );
    } finally {
      await watcher.stop();
    }
  });

  it("discovers a live transcript after a missed hook without importing pre-activation history", async () => {
    const { claudeHome, sourceSessionId, transcriptPath } = fixture();
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        sessionId: sourceSessionId,
        cwd: "/tmp/claude-project",
        timestamp: "2026-08-11T12:00:01.000Z"
      })}\n`
    );
    fs.utimesSync(
      transcriptPath,
      new Date("2026-08-11T12:00:01.000Z"),
      new Date("2026-08-11T12:00:01.000Z")
    );

    await expect(
      discoverClaudeTranscriptSignals(
        {
          version: 2,
          activatedAt: "2026-08-11T12:00:00.000Z",
          cursors: {}
        },
        { CLAUDE_CONFIG_DIR: claudeHome }
      )
    ).resolves.toEqual([
      expect.objectContaining({
        sourceSessionId,
        transcriptPath,
        cwd: "/tmp/claude-project",
        hookEventName: "FilesystemRecovery"
      })
    ]);

    await expect(
      discoverClaudeTranscriptSignals(
        {
          version: 2,
          activatedAt: "2026-08-11T12:00:02.000Z",
          cursors: {}
        },
        { CLAUDE_CONFIG_DIR: claudeHome }
      )
    ).resolves.toEqual([]);
  });

  it("rehydrates component cursors after restart and ingests only new records", async () => {
    const { claudeHome, sourceSessionId, transcriptPath } = fixture();
    const firstUserId = randomUUID();
    const assistantId = randomUUID();
    const firstLine = `${JSON.stringify({
      uuid: firstUserId,
      sessionId: sourceSessionId,
      cwd: "/tmp/claude-project",
      timestamp: "2026-08-11T12:00:00.000Z",
      type: "user"
    })}\n`;
    const secondLine = `${JSON.stringify({
      uuid: assistantId,
      sessionId: sourceSessionId,
      cwd: "/tmp/claude-project",
      timestamp: "2026-08-11T12:00:01.000Z",
      type: "assistant"
    })}\n`;
    fs.writeFileSync(transcriptPath, firstLine);
    const persistedBeforeRestart = JSON.stringify({
      version: 2,
      activatedAt: "2026-08-11T11:59:59.000Z",
      cursors: {
        [`${sourceSessionId}\u0000main`]: {
          messageCount: 1,
          updatedAt: "2026-08-11T12:00:00.000Z"
        }
      }
    });
    const state = JSON.parse(persistedBeforeRestart) as {
      version: 2;
      activatedAt: string;
      cursors: Record<string, { messageCount: number; updatedAt: string }>;
    };
    fs.appendFileSync(transcriptPath, secondLine);
    fs.utimesSync(
      transcriptPath,
      new Date("2026-08-11T12:00:01.000Z"),
      new Date("2026-08-11T12:00:01.000Z")
    );
    getSessionMessages.mockResolvedValue([
      {
        type: "user",
        uuid: firstUserId,
        message: { content: [{ type: "text", text: "Before restart" }] }
      },
      {
        type: "assistant",
        uuid: assistantId,
        message: { content: [{ type: "text", text: "After restart" }] }
      }
    ]);

    const discovered = await discoverClaudeTranscriptSignals(state, {
      CLAUDE_CONFIG_DIR: claudeHome
    });
    expect(discovered).toHaveLength(1);

    const capturedSessionId = randomUUID();
    const sourceGenerationId = randomUUID();
    let artifact: Record<string, unknown> | null = null;
    const segments: Array<Record<string, unknown>> = [];
    const createdItems: Array<Record<string, unknown>> = [];
    const client = {
      async lookupConversationSourceArtifact() {
        if (!artifact) throw new MemoryApiError("not found", { status: 404 });
        return { artifact };
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        artifact = {
          id: randomUUID(),
          sessionId: capturedSessionId,
          sourceGenerationId,
          sourceComponentId: "main",
          providerCursorOffset: input.journalStartOffset,
          providerCursorLine: input.journalStartLine,
          journalStartOffset: input.journalStartOffset
        };
        return { artifact };
      },
      async appendConversationSourceSegment(
        artifactId: string,
        input: Record<string, unknown>
      ) {
        const bytes = Buffer.from(String(input.bytesBase64), "base64");
        segments.push({
          id: randomUUID(),
          sourceStartOffset: input.expectedProviderOffset,
          sourceEndOffset: input.sourceEndOffset,
          plaintextDigest: createHash("sha256").update(bytes).digest("hex"),
          plaintextSize: bytes.length
        });
        artifact = {
          ...artifact,
          id: artifactId,
          providerCursorOffset: input.sourceEndOffset,
          providerCursorLine: input.sourceEndLine
        };
        return { artifact };
      },
      async listConversationSourceSegments() {
        return { segments };
      },
      async createConversationItems(input: {
        items: Array<Record<string, unknown>>;
      }) {
        createdItems.push(...input.items);
        return {
          items: input.items.map((item) => ({ ...item, id: randomUUID() }))
        };
      },
      async projectConversationItems() {
        return {};
      }
    } as unknown as MemoryApiClient;

    await processClaudeTranscriptSignal(client, state, discovered[0]!, {
      CLAUDE_CONFIG_DIR: claudeHome
    });

    expect(createdItems.map((item) => item.sourceEventType)).toEqual([
      "agent_message"
    ]);
    expect(createdItems.map((item) => item.rawText)).toEqual(["After restart"]);
    expect(state.cursors[`${sourceSessionId}\u0000main`]?.messageCount).toBe(2);
    await expect(
      discoverClaudeTranscriptSignals(state, {
        CLAUDE_CONFIG_DIR: claudeHome
      })
    ).resolves.toEqual([]);
  });

  it("journals complete source bytes before projecting official SDK messages", async () => {
    const { claudeHome, sourceSessionId, transcriptPath } = fixture();
    const userId = randomUUID();
    const assistantId = randomUUID();
    const toolResultId = randomUUID();
    const finalAssistantId = randomUUID();
    const timestamp = "2026-08-11T12:00:00.000Z";
    fs.writeFileSync(
      transcriptPath,
      [
        { uuid: userId, timestamp, type: "user" },
        {
          uuid: assistantId,
          timestamp: "2026-08-11T12:00:01.000Z",
          type: "assistant"
        },
        {
          uuid: toolResultId,
          timestamp: "2026-08-11T12:00:02.000Z",
          type: "user"
        },
        {
          uuid: finalAssistantId,
          timestamp: "2026-08-11T12:00:03.000Z",
          type: "assistant"
        }
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n"
    );
    getSessionMessages.mockResolvedValue([
      {
        type: "user",
        uuid: userId,
        message: { content: [{ type: "text", text: "Question" }] }
      },
      {
        type: "assistant",
        uuid: assistantId,
        message: {
          content: [
            { type: "text", text: "Answer" },
            { type: "thinking", text: "Check the source first." },
            { type: "tool_use", id: "tool-1", name: "Read", input: {} }
          ]
        }
      },
      {
        type: "user",
        uuid: toolResultId,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "source contents"
            }
          ]
        }
      },
      {
        type: "assistant",
        uuid: finalAssistantId,
        message: { content: [{ type: "text", text: "Final answer" }] }
      }
    ]);

    const operations: string[] = [];
    const capturedSessionId = randomUUID();
    let artifact: Record<string, unknown> | null = null;
    let ensuredArtifact: Record<string, unknown> | null = null;
    const createdItems: Array<Record<string, unknown>> = [];
    const client = {
      async lookupConversationSourceArtifact() {
        throw new MemoryApiError("not found", { status: 404 });
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        operations.push("journal-created");
        ensuredArtifact = input;
        artifact = {
          id: randomUUID(),
          sessionId: capturedSessionId,
          sourceGenerationId: randomUUID(),
          sourceComponentId: input.sourceComponentId,
          providerCursorOffset: input.journalStartOffset,
          providerCursorLine: input.journalStartLine,
          journalStartOffset: input.journalStartOffset
        };
        return { artifact };
      },
      async appendConversationSourceSegment(
        _artifactId: string,
        input: Record<string, unknown>
      ) {
        operations.push("journal-appended");
        artifact = {
          ...artifact,
          providerCursorOffset: input.sourceEndOffset,
          providerCursorLine: input.sourceEndLine
        };
        return { artifact };
      },
      async listConversationSourceSegments() {
        throw new Error("existing source segments were not expected");
      },
      async createConversationItems(input: {
        items: Record<string, unknown>[];
      }) {
        operations.push("items");
        createdItems.push(...input.items);
        return {
          items: input.items.map((item) => ({ ...item, id: randomUUID() }))
        };
      },
      async projectConversationItems() {
        operations.push("project");
        return {};
      }
    } as unknown as MemoryApiClient;
    const state: {
      version: 2;
      activatedAt: string;
      cursors: Record<string, { messageCount: number; updatedAt: string }>;
    } = {
      version: 2 as const,
      activatedAt: "2026-08-11T11:59:59.000Z",
      cursors: {}
    };

    await processClaudeTranscriptSignal(
      client,
      state,
      {
        sourceSessionId,
        transcriptPath,
        cwd: "/tmp/project",
        hookEventName: "Stop",
        observedAt: "2026-08-11T12:00:02.000Z"
      },
      { CLAUDE_CONFIG_DIR: claudeHome }
    );

    expect(operations.indexOf("journal-appended")).toBeLessThan(
      operations.indexOf("items")
    );
    expect(ensuredArtifact).toMatchObject({
      sourceKind: "claude-code",
      sourceComponentId: "main",
      sourceComponentRole: "primary",
      parentSourceComponentId: null,
      contentFraming: "jsonl",
      artifactFormat: "claude_session_jsonl",
      artifactFormatVersion: 1
    });
    expect(ensuredArtifact).not.toHaveProperty("sourceComponentSchemaVersion");
    expect(createdItems).toHaveLength(7);
    expect(new Set(createdItems.map((item) => item.sourceSequence)).size).toBe(
      7
    );
    expect(createdItems.map((item) => item.sourceEventType)).toEqual([
      "user_message",
      "agent_message",
      "agent_reasoning",
      "tool_call",
      "tool_result",
      "agent_message",
      "turn_completed"
    ]);
    expect(
      new Set(createdItems.slice(0, -1).map((item) => item.externalTurnId))
    ).toEqual(new Set([userId]));
    expect(createdItems.slice(0, -1).map((item) => item.eventTime)).toEqual([
      "2026-08-11T12:00:00.000Z",
      "2026-08-11T12:00:01.000Z",
      "2026-08-11T12:00:01.000Z",
      "2026-08-11T12:00:01.000Z",
      "2026-08-11T12:00:02.000Z",
      "2026-08-11T12:00:03.000Z"
    ]);
    expect(createdItems[0]).toMatchObject({
      canonicalStableItemId: `main:${userId}:0`,
      observationComponent: "message",
      canonicalItemKey: canonicalConversationItemKey({
        provider: "claude-code",
        externalThreadId: sourceSessionId,
        externalTurnId: userId,
        stableItemId: `main:${userId}:0`,
        component: "message"
      })
    });
    expect(state.cursors[`${sourceSessionId}\u0000main`]?.messageCount).toBe(4);
  });

  it("keeps assistant records in their user turn across incremental scans", async () => {
    const { claudeHome, sourceSessionId, transcriptPath } = fixture();
    const userId = randomUUID();
    const assistantId = randomUUID();
    const userLine = `${JSON.stringify({
      uuid: userId,
      timestamp: "2026-08-11T12:00:00.000Z",
      type: "user"
    })}\n`;
    const assistantLine = `${JSON.stringify({
      uuid: assistantId,
      timestamp: "2026-08-11T12:00:01.000Z",
      type: "assistant"
    })}\n`;
    fs.writeFileSync(transcriptPath, userLine);
    const userMessage = {
      type: "user",
      uuid: userId,
      message: { content: [{ type: "text", text: "Question" }] }
    };
    const assistantMessage = {
      type: "assistant",
      uuid: assistantId,
      message: { content: [{ type: "text", text: "Answer" }] }
    };
    getSessionMessages
      .mockResolvedValueOnce([userMessage])
      .mockResolvedValueOnce([userMessage, assistantMessage]);

    const capturedSessionId = randomUUID();
    const sourceGenerationId = randomUUID();
    let artifact: Record<string, unknown> | null = null;
    const segments: Array<Record<string, unknown>> = [];
    const createdItems: Array<Record<string, unknown>> = [];
    const client = {
      async lookupConversationSourceArtifact() {
        if (!artifact) throw new MemoryApiError("not found", { status: 404 });
        return { artifact };
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        artifact = {
          id: randomUUID(),
          sessionId: capturedSessionId,
          sourceGenerationId,
          sourceComponentId: "main",
          providerCursorOffset: input.journalStartOffset,
          providerCursorLine: input.journalStartLine,
          journalStartOffset: input.journalStartOffset
        };
        return { artifact };
      },
      async appendConversationSourceSegment(
        _artifactId: string,
        input: Record<string, unknown>
      ) {
        const bytes = Buffer.from(String(input.bytesBase64), "base64");
        segments.push({
          id: randomUUID(),
          sourceStartOffset: input.expectedProviderOffset,
          sourceEndOffset: input.sourceEndOffset,
          plaintextDigest: createHash("sha256").update(bytes).digest("hex"),
          plaintextSize: bytes.length
        });
        artifact = {
          ...artifact,
          providerCursorOffset: input.sourceEndOffset,
          providerCursorLine: input.sourceEndLine
        };
        return { artifact };
      },
      async listConversationSourceSegments() {
        return { segments };
      },
      async createConversationItems(input: {
        items: Array<Record<string, unknown>>;
      }) {
        createdItems.push(...input.items);
        return {
          items: input.items.map((item) => ({ ...item, id: randomUUID() }))
        };
      },
      async projectConversationItems() {
        return {};
      }
    } as unknown as MemoryApiClient;
    const state: {
      version: 2;
      activatedAt: string;
      cursors: Record<string, { messageCount: number; updatedAt: string }>;
    } = {
      version: 2 as const,
      activatedAt: "2026-08-11T11:59:59.000Z",
      cursors: {}
    };
    const signal = {
      sourceSessionId,
      transcriptPath,
      cwd: "/tmp/project",
      observedAt: "2026-08-11T12:00:02.000Z"
    };

    await processClaudeTranscriptSignal(client, state, signal, {
      CLAUDE_CONFIG_DIR: claudeHome
    });
    fs.appendFileSync(transcriptPath, assistantLine);
    await processClaudeTranscriptSignal(client, state, signal, {
      CLAUDE_CONFIG_DIR: claudeHome
    });

    expect(createdItems.map((item) => item.externalTurnId)).toEqual([
      userId,
      userId
    ]);
    expect(createdItems.map((item) => item.sourceEventType)).toEqual([
      "user_message",
      "agent_message"
    ]);
  });

  it("does not advance the durable message cursor until projection succeeds", async () => {
    const { claudeHome, sourceSessionId, transcriptPath } = fixture();
    const userId = randomUUID();
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        uuid: userId,
        timestamp: "2026-08-11T12:00:00.000Z",
        type: "user"
      })}\n`
    );
    getSessionMessages.mockResolvedValue([
      {
        type: "user",
        uuid: userId,
        message: { content: [{ type: "text", text: "Retry me" }] }
      }
    ]);
    const capturedSessionId = randomUUID();
    const sourceGenerationId = randomUUID();
    let artifact: Record<string, unknown> | null = null;
    const segments: Array<Record<string, unknown>> = [];
    let projectAttempts = 0;
    let appendAttempts = 0;
    const createdBatches: Array<Array<Record<string, unknown>>> = [];
    const client = {
      async lookupConversationSourceArtifact() {
        if (!artifact) throw new MemoryApiError("not found", { status: 404 });
        return { artifact };
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        artifact = {
          id: randomUUID(),
          sessionId: capturedSessionId,
          sourceGenerationId,
          sourceComponentId: "main",
          providerCursorOffset: input.journalStartOffset,
          providerCursorLine: input.journalStartLine,
          journalStartOffset: input.journalStartOffset
        };
        return { artifact };
      },
      async appendConversationSourceSegment(
        artifactId: string,
        input: Record<string, unknown>
      ) {
        appendAttempts += 1;
        if (appendAttempts === 1) {
          throw Object.assign(new Error("journal storage full"), {
            code: "ENOSPC"
          });
        }
        const bytes = Buffer.from(String(input.bytesBase64), "base64");
        segments.push({
          id: randomUUID(),
          sourceStartOffset: input.expectedProviderOffset,
          sourceEndOffset: input.sourceEndOffset,
          plaintextDigest: createHash("sha256").update(bytes).digest("hex"),
          plaintextSize: bytes.length
        });
        artifact = {
          ...artifact,
          id: artifactId,
          providerCursorOffset: input.sourceEndOffset,
          providerCursorLine: input.sourceEndLine
        };
        return { artifact };
      },
      async listConversationSourceSegments() {
        return { segments };
      },
      async createConversationItems(input: {
        items: Array<Record<string, unknown>>;
      }) {
        createdBatches.push(input.items);
        return {
          items: input.items.map((item) => ({ ...item, id: randomUUID() }))
        };
      },
      async projectConversationItems() {
        projectAttempts += 1;
        if (projectAttempts === 1) throw new Error("memory API unavailable");
        return {};
      }
    } as unknown as MemoryApiClient;
    const state: {
      version: 2;
      activatedAt: string;
      cursors: Record<string, { messageCount: number; updatedAt: string }>;
    } = {
      version: 2,
      activatedAt: "2026-08-11T11:59:59.000Z",
      cursors: {}
    };
    const signal = {
      sourceSessionId,
      transcriptPath,
      cwd: "/tmp/project",
      observedAt: "2026-08-11T12:00:01.000Z"
    };

    await expect(
      processClaudeTranscriptSignal(client, state, signal, {
        CLAUDE_CONFIG_DIR: claudeHome
      })
    ).rejects.toMatchObject({ code: "ENOSPC" });
    expect(state.cursors).toEqual({});

    await expect(
      processClaudeTranscriptSignal(client, state, signal, {
        CLAUDE_CONFIG_DIR: claudeHome
      })
    ).rejects.toThrow("memory API unavailable");
    expect(state.cursors).toEqual({});

    await processClaudeTranscriptSignal(client, state, signal, {
      CLAUDE_CONFIG_DIR: claudeHome
    });

    expect(createdBatches).toHaveLength(2);
    expect(createdBatches[1]?.map((item) => item.canonicalItemKey)).toEqual(
      createdBatches[0]?.map((item) => item.canonicalItemKey)
    );
    expect(state.cursors[`${sourceSessionId}\u0000main`]?.messageCount).toBe(1);
  });

  it("waits for the provider transcript timestamp instead of inventing one", async () => {
    const { claudeHome, sourceSessionId, transcriptPath } = fixture();
    const transcriptId = randomUUID();
    const sdkMessageId = randomUUID();
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        uuid: transcriptId,
        timestamp: "2026-08-11T12:00:00.000Z",
        type: "user"
      })}\n`
    );
    getSessionMessages.mockResolvedValue([
      {
        type: "user",
        uuid: sdkMessageId,
        message: { content: [{ type: "text", text: "Not flushed yet" }] }
      }
    ]);
    const capturedSessionId = randomUUID();
    const state = {
      version: 2 as const,
      activatedAt: "2026-08-11T11:59:59.000Z",
      cursors: {}
    };
    const client = {
      async lookupConversationSourceArtifact() {
        throw new MemoryApiError("not found", { status: 404 });
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        return {
          artifact: {
            id: randomUUID(),
            sessionId: capturedSessionId,
            sourceGenerationId: randomUUID(),
            sourceComponentId: "main",
            providerCursorOffset: input.journalStartOffset,
            providerCursorLine: input.journalStartLine,
            journalStartOffset: input.journalStartOffset
          }
        };
      },
      async appendConversationSourceSegment(
        artifactId: string,
        input: Record<string, unknown>
      ) {
        return {
          artifact: {
            id: artifactId,
            sessionId: capturedSessionId,
            sourceComponentId: "main",
            providerCursorOffset: input.sourceEndOffset,
            providerCursorLine: input.sourceEndLine,
            journalStartOffset: 0
          }
        };
      }
    } as unknown as MemoryApiClient;

    await expect(
      processClaudeTranscriptSignal(
        client,
        state,
        {
          sourceSessionId,
          transcriptPath,
          cwd: "/tmp/project"
        },
        { CLAUDE_CONFIG_DIR: claudeHome }
      )
    ).rejects.toThrow(`claude_source_timestamp_missing:${sdkMessageId}`);
    expect(state.cursors).toEqual({});
  });

  it("quarantines malformed hook signals instead of retrying them forever", async () => {
    const { root, claudeHome } = fixture();
    const koedHome = path.join(root, ".koed");
    const signalDirectory = path.join(
      koedHome,
      "run",
      "claude-transcript-signals"
    );
    fs.mkdirSync(signalDirectory, { recursive: true });
    const signalPath = path.join(signalDirectory, "broken.json");
    fs.writeFileSync(signalPath, "{not-json", { mode: 0o600 });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const watcher = startClaudeTranscriptWatcher({} as MemoryApiClient, {
      KOED_HOME: koedHome,
      CLAUDE_CONFIG_DIR: claudeHome
    });

    try {
      await watcher.scanNow();
      expect(fs.existsSync(signalPath)).toBe(false);
      expect(fs.existsSync(`${signalPath}.invalid`)).toBe(true);
      await watcher.scanNow();
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      await watcher.stop();
      error.mockRestore();
    }
  });

  it("contains transient project refresh failures and recovers on a later scan", async () => {
    const { root, claudeHome, sourceSessionId, transcriptPath } = fixture();
    const messageId = randomUUID();
    const timestamp = new Date(Date.now() + 2_000);
    const source = `${JSON.stringify({
      type: "user",
      uuid: messageId,
      sessionId: sourceSessionId,
      cwd: "/tmp/project",
      timestamp: timestamp.toISOString()
    })}\n`;
    fs.writeFileSync(transcriptPath, source);
    fs.utimesSync(transcriptPath, timestamp, timestamp);
    getSessionMessages.mockResolvedValue([]);
    const projectsHome = path.join(claudeHome, "projects");
    filesystemRace.failReaddirPath = projectsHome;
    filesystemRace.remainingFailures = 1;
    const refreshErrors: unknown[] = [];
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    const error = vi.spyOn(console, "error").mockImplementation((message) => {
      if (String(message).includes("project watcher refresh")) {
        refreshErrors.push(message);
      }
    });
    let appendCount = 0;
    const capturedSessionId = randomUUID();
    const client = {
      async lookupConversationSourceArtifact() {
        throw new MemoryApiError("not found", { status: 404 });
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        return {
          artifact: {
            id: "recovered-artifact",
            sessionId: capturedSessionId,
            sourceGenerationId: randomUUID(),
            sourceComponentId: "main",
            providerCursorOffset: input.journalStartOffset,
            providerCursorLine: input.journalStartLine,
            journalStartOffset: input.journalStartOffset
          }
        };
      },
      async appendConversationSourceSegment(
        artifactId: string,
        input: Record<string, unknown>
      ) {
        appendCount += 1;
        return {
          artifact: {
            id: artifactId,
            sessionId: capturedSessionId,
            sourceGenerationId: randomUUID(),
            sourceComponentId: "main",
            providerCursorOffset: input.sourceEndOffset,
            providerCursorLine: input.sourceEndLine,
            journalStartOffset: 0
          }
        };
      }
    } as unknown as MemoryApiClient;
    const watcher = startClaudeTranscriptWatcher(client, {
      CLAUDE_CONFIG_DIR: claudeHome,
      KOED_HOME: path.join(root, "koed"),
      MEMORY_CLAUDE_TRANSCRIPT_DEBOUNCE_MS: "25",
      MEMORY_CLAUDE_TRANSCRIPT_RETRY_BASE_MS: "100",
      MEMORY_CLAUDE_TRANSCRIPT_RETRY_MAX_MS: "100"
    });

    try {
      await vi.waitFor(() => expect(refreshErrors).toHaveLength(1), {
        timeout: 2_000,
        interval: 20
      });
      await vi.waitFor(() => expect(appendCount).toBe(1), {
        timeout: 2_000,
        interval: 20
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(unhandledRejections).toEqual([]);
    } finally {
      await watcher.stop();
      error.mockRestore();
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("waits for a stable complete source set before SessionEnd finalization", async () => {
    const { claudeHome, sourceSessionId, transcriptPath } = fixture();
    const userId = randomUUID();
    const assistantId = randomUUID();
    fs.writeFileSync(
      transcriptPath,
      [
        {
          uuid: userId,
          timestamp: "2026-08-11T12:00:00.000Z",
          type: "user"
        },
        {
          uuid: assistantId,
          timestamp: "2026-08-11T12:00:01.000Z",
          type: "assistant"
        }
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n"
    );
    const userMessage = {
      type: "user",
      uuid: userId,
      message: { content: [{ type: "text", text: "Finish safely" }] }
    };
    const assistantMessage = {
      type: "assistant",
      uuid: assistantId,
      message: { content: [{ type: "text", text: "Finished" }] }
    };
    getSessionMessages
      .mockResolvedValueOnce([userMessage])
      .mockResolvedValueOnce([userMessage, assistantMessage])
      .mockResolvedValueOnce([userMessage, assistantMessage]);
    const capturedSessionId = randomUUID();
    const sourceGenerationId = randomUUID();
    const finalizations: string[] = [];
    const client = {
      async lookupConversationSourceArtifact() {
        throw new MemoryApiError("not found", { status: 404 });
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        return {
          artifact: {
            id: "artifact-main",
            sessionId: capturedSessionId,
            sourceGenerationId,
            sourceComponentId: input.sourceComponentId,
            providerCursorOffset: input.journalStartOffset,
            providerCursorLine: input.journalStartLine,
            journalStartOffset: input.journalStartOffset
          }
        };
      },
      async appendConversationSourceSegment(
        artifactId: string,
        input: Record<string, unknown>
      ) {
        return {
          artifact: {
            id: artifactId,
            sessionId: capturedSessionId,
            sourceGenerationId,
            sourceComponentId: "main",
            providerCursorOffset: input.sourceEndOffset,
            providerCursorLine: input.sourceEndLine,
            journalStartOffset: 0
          }
        };
      },
      async createConversationItems(input: {
        items: Array<Record<string, unknown>>;
      }) {
        return {
          items: input.items.map((item) => ({ ...item, id: randomUUID() }))
        };
      },
      async projectConversationItems() {
        return {};
      },
      async finalizeConversationSourceArtifact(id: string) {
        finalizations.push(id);
        return {};
      },
      async finalizeConversationSourceSet(id: string) {
        finalizations.push(id);
        return {};
      }
    } as unknown as MemoryApiClient;

    await processClaudeTranscriptSignal(
      client,
      {
        version: 2,
        activatedAt: "2026-08-11T11:59:59.000Z",
        cursors: {}
      },
      {
        sourceSessionId,
        transcriptPath,
        cwd: "/tmp/project",
        hookEventName: "SessionEnd",
        observedAt: "2026-08-11T12:00:02.000Z"
      },
      {
        CLAUDE_CONFIG_DIR: claudeHome,
        MEMORY_CLAUDE_SOURCE_SET_QUIET_MS: "25",
        MEMORY_CLAUDE_SOURCE_SET_STABILIZATION_TIMEOUT_MS: "100"
      }
    );

    expect(getSessionMessages).toHaveBeenCalledTimes(3);
    expect(finalizations).toEqual(["artifact-main", sourceGenerationId]);
  });

  it("registers the main historical source before auxiliary components", async () => {
    const { claudeHome, sourceSessionId, transcriptPath } = fixture();
    const agentId = "historical-researcher";
    const subagentDirectory = path.join(
      path.dirname(transcriptPath),
      sourceSessionId,
      "subagents"
    );
    const subagentPath = path.join(subagentDirectory, `agent-${agentId}.jsonl`);
    fs.mkdirSync(subagentDirectory, { recursive: true });
    const mainId = randomUUID();
    const subagentId = randomUUID();
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        uuid: mainId,
        sessionId: sourceSessionId,
        cwd: "/tmp/project",
        timestamp: "2026-08-11T12:00:00.000Z",
        type: "user"
      })}\n`
    );
    fs.writeFileSync(
      subagentPath,
      `${JSON.stringify({
        uuid: subagentId,
        sessionId: sourceSessionId,
        cwd: "/tmp/project",
        timestamp: "2026-08-11T12:00:01.000Z",
        type: "assistant"
      })}\n`
    );
    getSessionMessages.mockResolvedValue([]);
    listSubagents.mockResolvedValue([agentId]);
    getSubagentMessages.mockResolvedValue([]);

    const operations: string[] = [];
    const capturedSessionId = randomUUID();
    const sourceGenerationId = randomUUID();
    const artifacts = new Map<string, Record<string, unknown>>();
    let mainRegistrationComplete = false;
    const client = {
      async lookupConversationSourceArtifact(input: {
        sourceComponentId: string;
      }) {
        const artifact = artifacts.get(input.sourceComponentId);
        if (!artifact) throw new MemoryApiError("not found", { status: 404 });
        return { artifact };
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        const componentId = String(input.sourceComponentId);
        if (componentId !== "main" && !mainRegistrationComplete) {
          throw new Error("Conversation source parent component not found");
        }
        operations.push(`ensure:${componentId}`);
        const artifact = {
          id: `artifact-${componentId}`,
          sessionId: capturedSessionId,
          sourceGenerationId,
          sourceComponentId: componentId,
          providerCursorOffset: 0,
          providerCursorLine: 0,
          journalStartOffset: 0
        };
        artifacts.set(componentId, artifact);
        return { artifact };
      },
      async appendConversationSourceSegment(
        artifactId: string,
        input: Record<string, unknown>
      ) {
        const componentId = artifactId.replace("artifact-", "");
        operations.push(`append:${componentId}`);
        const artifact = {
          ...artifacts.get(componentId),
          providerCursorOffset: input.sourceEndOffset,
          providerCursorLine: input.sourceEndLine
        };
        artifacts.set(componentId, artifact);
        if (componentId === "main") mainRegistrationComplete = true;
        return { artifact };
      }
    } as unknown as MemoryApiClient;

    const registered = await registerClaudeHistoricalTranscriptSources(
      client,
      {
        sourceSessionId,
        transcriptPath,
        cwd: "/tmp/project",
        hookEventName: "HistoricalImport"
      },
      { CLAUDE_CONFIG_DIR: claudeHome }
    );

    expect(operations).toEqual([
      "ensure:main",
      "append:main",
      `ensure:subagent.${agentId}`,
      `append:subagent.${agentId}`
    ]);
    expect(registered.map((artifact) => artifact.sourceComponentId)).toEqual([
      "main",
      `subagent.${agentId}`
    ]);
  });

  it("journals and projects Claude subagent sidechains as separate source components", async () => {
    const { claudeHome, sourceSessionId, transcriptPath } = fixture();
    const projectDirectory = path.dirname(transcriptPath);
    const agentId = "researcher-1";
    const subagentDirectory = path.join(
      projectDirectory,
      sourceSessionId,
      "subagents"
    );
    const subagentPath = path.join(subagentDirectory, `agent-${agentId}.jsonl`);
    fs.mkdirSync(subagentDirectory, { recursive: true });
    const mainId = randomUUID();
    const subagentId = randomUUID();
    const mainRecord = {
      uuid: mainId,
      sessionId: sourceSessionId,
      cwd: "/tmp/project",
      timestamp: "2026-08-11T12:00:00.000Z",
      type: "user"
    };
    const subagentRecord = {
      uuid: subagentId,
      sessionId: sourceSessionId,
      cwd: "/tmp/project",
      timestamp: "2026-08-11T12:00:01.000Z",
      type: "assistant",
      agentId
    };
    fs.writeFileSync(transcriptPath, `${JSON.stringify(mainRecord)}\n`);
    fs.writeFileSync(subagentPath, `${JSON.stringify(subagentRecord)}\n`);
    getSessionMessages.mockResolvedValue([
      {
        type: "user",
        uuid: mainId,
        message: { content: [{ type: "text", text: "Investigate" }] }
      }
    ]);
    listSubagents.mockResolvedValue([agentId]);
    getSubagentMessages.mockResolvedValue([
      {
        type: "assistant",
        uuid: subagentId,
        message: { content: [{ type: "text", text: "Subagent result" }] },
        parent_agent_id: null,
        parent_tool_use_id: "task-1"
      }
    ]);
    const ensured: Array<Record<string, unknown>> = [];
    const createdItems: Array<Record<string, unknown>> = [];
    const sourceGenerationId = randomUUID();
    const capturedSessionId = randomUUID();
    const componentByArtifactId = new Map<string, unknown>();
    const client = {
      async lookupConversationSourceArtifact() {
        throw new MemoryApiError("not found", { status: 404 });
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        ensured.push(input);
        const id = randomUUID();
        componentByArtifactId.set(id, input.sourceComponentId);
        return {
          artifact: {
            id,
            sessionId: capturedSessionId,
            sourceGenerationId,
            sourceComponentId: input.sourceComponentId,
            providerCursorOffset: input.journalStartOffset,
            providerCursorLine: input.journalStartLine,
            journalStartOffset: input.journalStartOffset
          }
        };
      },
      async appendConversationSourceSegment(
        artifactId: string,
        input: Record<string, unknown>
      ) {
        return {
          artifact: {
            id: artifactId,
            sessionId: capturedSessionId,
            sourceGenerationId,
            sourceComponentId: componentByArtifactId.get(artifactId),
            providerCursorOffset: input.sourceEndOffset,
            providerCursorLine: input.sourceEndLine,
            journalStartOffset: 0
          }
        };
      },
      async createConversationItems(input: {
        items: Record<string, unknown>[];
      }) {
        createdItems.push(...input.items);
        return {
          items: input.items.map((item) => ({ ...item, id: randomUUID() }))
        };
      },
      async projectConversationItems() {
        return {};
      }
    } as unknown as MemoryApiClient;

    await processClaudeTranscriptSignal(
      client,
      {
        version: 2,
        activatedAt: "2026-08-11T11:59:59.000Z",
        cursors: {}
      },
      {
        sourceSessionId,
        transcriptPath,
        cwd: "/tmp/project",
        observedAt: "2026-08-11T12:00:02.000Z"
      },
      { CLAUDE_CONFIG_DIR: claudeHome }
    );

    expect(ensured).toEqual([
      expect.objectContaining({
        sourceComponentId: "main",
        sourceComponentRole: "primary",
        parentSourceComponentId: null
      }),
      expect.objectContaining({
        sourceComponentId: `subagent.${agentId}`,
        sourceComponentRole: "auxiliary",
        parentSourceComponentId: "main"
      })
    ]);
    expect(
      createdItems.map(
        (item) => (item.metadata as Record<string, unknown>).sourceComponentId
      )
    ).toEqual(["main", `subagent.${agentId}`]);
  });

  it("rolls a finalized Claude source set into one coordinated successor generation", async () => {
    const { claudeHome, sourceSessionId, transcriptPath } = fixture();
    const agentId = "resume-agent";
    const subagentDirectory = path.join(
      path.dirname(transcriptPath),
      sourceSessionId,
      "subagents"
    );
    const subagentPath = path.join(subagentDirectory, `agent-${agentId}.jsonl`);
    fs.mkdirSync(subagentDirectory, { recursive: true });
    const userId = randomUUID();
    const resumedAssistantId = randomUUID();
    const subagentId = randomUUID();
    const firstMainLine = `${JSON.stringify({
      uuid: userId,
      sessionId: sourceSessionId,
      cwd: "/tmp/project",
      timestamp: "2026-08-11T12:00:00.000Z",
      type: "user"
    })}\n`;
    const resumedMainLine = `${JSON.stringify({
      uuid: resumedAssistantId,
      sessionId: sourceSessionId,
      cwd: "/tmp/project",
      timestamp: "2026-08-11T12:00:02.000Z",
      type: "assistant"
    })}\n`;
    const auxiliaryLine = `${JSON.stringify({
      uuid: subagentId,
      sessionId: sourceSessionId,
      cwd: "/tmp/project",
      timestamp: "2026-08-11T12:00:01.000Z",
      type: "assistant"
    })}\n`;
    fs.writeFileSync(transcriptPath, firstMainLine + resumedMainLine);
    fs.writeFileSync(subagentPath, auxiliaryLine);
    const userMessage = {
      type: "user",
      uuid: userId,
      message: { content: [{ type: "text", text: "Before SessionEnd" }] }
    };
    const resumedAssistantMessage = {
      type: "assistant",
      uuid: resumedAssistantId,
      message: { content: [{ type: "text", text: "After resume" }] }
    };
    getSessionMessages.mockResolvedValue([
      userMessage,
      resumedAssistantMessage
    ]);
    listSubagents.mockResolvedValue([agentId]);
    getSubagentMessages.mockResolvedValue([
      {
        type: "assistant",
        uuid: subagentId,
        message: { content: [{ type: "text", text: "Prior sidechain" }] },
        parent_agent_id: null,
        parent_tool_use_id: "task-1"
      }
    ]);

    const capturedSessionId = randomUUID();
    const parentGenerationId = randomUUID();
    const parentMain = {
      id: "parent-main",
      sessionId: capturedSessionId,
      sourceGenerationId: parentGenerationId,
      sourceComponentId: "main",
      sourceComponentRole: "primary" as const,
      parentSourceComponentId: null,
      lifecycle: "finalized" as const,
      closureHash: "a".repeat(64),
      sourceSetFinalizedAt: "2026-08-11T12:00:01.500Z",
      providerCursorOffset: Buffer.byteLength(firstMainLine),
      providerCursorLine: 1,
      journalStartOffset: 0
    };
    const parentAuxiliary = {
      id: "parent-auxiliary",
      sessionId: capturedSessionId,
      sourceGenerationId: parentGenerationId,
      sourceComponentId: `subagent.${agentId}`,
      sourceComponentRole: "auxiliary" as const,
      parentSourceComponentId: "main",
      lifecycle: "finalized" as const,
      closureHash: "b".repeat(64),
      sourceSetFinalizedAt: null,
      providerCursorOffset: Buffer.byteLength(auxiliaryLine),
      providerCursorLine: 1,
      journalStartOffset: 0
    };
    const parents = [parentMain, parentAuxiliary];
    const latest = new Map<string, Record<string, unknown>>(
      parents.map((artifact) => [artifact.sourceComponentId, artifact])
    );
    const successorCalls: Array<{
      parentId: string;
      input: {
        expectedParentClosureHash: string;
        sourceGenerationId: string;
        originKeyId: string;
      };
    }> = [];
    const appended: Array<{
      artifactId: string;
      expectedProviderOffset: number;
      sourceEndOffset: number;
    }> = [];
    const createdItems: Array<Record<string, unknown>> = [];
    let auxiliaryAttempts = 0;
    const client = {
      async lookupConversationSourceArtifact(input: {
        sourceComponentId: string;
      }) {
        const artifact = latest.get(input.sourceComponentId);
        if (!artifact) throw new MemoryApiError("not found", { status: 404 });
        return { artifact };
      },
      async listConversationSourceGenerationComponents(id: string) {
        expect(id).toBe(parentGenerationId);
        return {
          components: parents.map((artifact) => ({ artifact }))
        };
      },
      async createConversationSourceSuccessorGeneration(
        parentId: string,
        input: {
          expectedParentClosureHash: string;
          sourceGenerationId: string;
          originKeyId: string;
        }
      ) {
        successorCalls.push({ parentId, input });
        const parent = parents.find((artifact) => artifact.id === parentId)!;
        if (parent.sourceComponentId !== "main" && auxiliaryAttempts++ === 0) {
          throw new Error("transient successor creation failure");
        }
        const artifact = {
          ...parent,
          id: `successor-${parent.sourceComponentId}`,
          sourceGenerationId: input.sourceGenerationId,
          lifecycle: "active",
          closureHash: null,
          sourceSetFinalizedAt: null,
          journalStartOffset: parent.providerCursorOffset,
          priorGenerationClosure: {
            sourceGenerationId: parentGenerationId,
            contentDigest: parent.closureHash,
            closedAt: "2026-08-11T12:00:01.500Z"
          }
        };
        latest.set(parent.sourceComponentId, artifact);
        if (parent.sourceComponentId !== "main") {
          throw new MemoryApiError("successor already exists", { status: 409 });
        }
        return { artifact };
      },
      async getConversationSourceArtifactByGeneration(
        generationId: string,
        componentId: string
      ) {
        const artifact = latest.get(componentId);
        if (artifact?.sourceGenerationId !== generationId) {
          throw new MemoryApiError("not found", { status: 404 });
        }
        return { artifact };
      },
      async appendConversationSourceSegment(
        artifactId: string,
        input: Record<string, unknown>
      ) {
        appended.push({
          artifactId,
          expectedProviderOffset: Number(input.expectedProviderOffset),
          sourceEndOffset: Number(input.sourceEndOffset)
        });
        const componentId = [...latest.entries()].find(
          ([, artifact]) => artifact.id === artifactId
        )?.[0];
        const artifact = {
          ...latest.get(componentId!),
          providerCursorOffset: input.sourceEndOffset,
          providerCursorLine: input.sourceEndLine
        };
        latest.set(componentId!, artifact);
        return { artifact };
      },
      async createConversationItems(input: {
        items: Array<Record<string, unknown>>;
      }) {
        createdItems.push(...input.items);
        return {
          items: input.items.map((item) => ({ ...item, id: randomUUID() }))
        };
      },
      async projectConversationItems() {
        return {};
      }
    } as unknown as MemoryApiClient;
    const state = {
      version: 2 as const,
      activatedAt: "2026-08-11T11:59:59.000Z",
      cursors: {
        [`${sourceSessionId}\u0000main`]: {
          messageCount: 1,
          updatedAt: "2026-08-11T12:00:01.500Z"
        },
        [`${sourceSessionId}\u0000subagent.${agentId}`]: {
          messageCount: 1,
          updatedAt: "2026-08-11T12:00:01.500Z"
        }
      }
    };

    const signal = {
      sourceSessionId,
      transcriptPath,
      cwd: "/tmp/project",
      hookEventName: "UserPromptSubmit" as const,
      observedAt: "2026-08-11T12:00:02.000Z"
    };
    await expect(
      processClaudeTranscriptSignal(client, state, signal, {
        CLAUDE_CONFIG_DIR: claudeHome
      })
    ).rejects.toThrow("transient successor creation failure");
    expect(latest.get("main")).toMatchObject({ lifecycle: "active" });
    expect(state.cursors[`${sourceSessionId}\u0000main`]?.messageCount).toBe(1);

    await processClaudeTranscriptSignal(client, state, signal, {
      CLAUDE_CONFIG_DIR: claudeHome
    });

    expect(successorCalls.map((call) => call.parentId)).toEqual([
      "parent-main",
      "parent-auxiliary",
      "parent-auxiliary"
    ]);
    expect(
      new Set(successorCalls.map((call) => call.input.sourceGenerationId)).size
    ).toBe(1);
    expect(successorCalls[0]?.input.originKeyId).not.toBe(
      successorCalls[1]?.input.originKeyId
    );
    expect(latest.get(`subagent.${agentId}`)).toMatchObject({
      sourceComponentRole: "auxiliary",
      parentSourceComponentId: "main",
      priorGenerationClosure: {
        sourceGenerationId: parentGenerationId,
        contentDigest: parentAuxiliary.closureHash
      }
    });
    expect(appended).toEqual([
      {
        artifactId: "successor-main",
        expectedProviderOffset: Buffer.byteLength(firstMainLine),
        sourceEndOffset: Buffer.byteLength(firstMainLine + resumedMainLine)
      }
    ]);
    expect(createdItems.map((item) => item.rawText)).toEqual(["After resume"]);
    expect(state.cursors[`${sourceSessionId}\u0000main`]?.messageCount).toBe(2);
  });

  it("holds an incomplete trailing record until Claude finishes writing it", async () => {
    const { claudeHome, sourceSessionId, transcriptPath } = fixture();
    const userId = randomUUID();
    const complete = `${JSON.stringify({
      uuid: userId,
      timestamp: "2026-08-11T12:00:00.000Z",
      type: "user"
    })}\n`;
    fs.writeFileSync(transcriptPath, `${complete}{"uuid":"partial`);
    getSessionMessages.mockResolvedValue([
      {
        type: "user",
        uuid: userId,
        message: { content: [{ type: "text", text: "Question" }] }
      }
    ]);
    let appended = Buffer.alloc(0);
    const capturedSessionId = randomUUID();
    const client = {
      async lookupConversationSourceArtifact() {
        throw new MemoryApiError("not found", { status: 404 });
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        return {
          artifact: {
            id: randomUUID(),
            sessionId: capturedSessionId,
            sourceGenerationId: randomUUID(),
            sourceComponentId: input.sourceComponentId,
            providerCursorOffset: input.journalStartOffset,
            providerCursorLine: input.journalStartLine,
            journalStartOffset: input.journalStartOffset
          }
        };
      },
      async appendConversationSourceSegment(
        artifactId: string,
        input: Record<string, unknown>
      ) {
        appended = Buffer.from(String(input.bytesBase64), "base64");
        return {
          artifact: {
            id: artifactId,
            sessionId: capturedSessionId,
            providerCursorOffset: input.sourceEndOffset,
            providerCursorLine: input.sourceEndLine,
            journalStartOffset: 0
          }
        };
      },
      async createConversationItems(input: {
        items: Record<string, unknown>[];
      }) {
        return {
          items: input.items.map((item) => ({ ...item, id: randomUUID() }))
        };
      },
      async projectConversationItems() {
        return {};
      }
    } as unknown as MemoryApiClient;

    await processClaudeTranscriptSignal(
      client,
      {
        version: 2,
        activatedAt: "2026-08-11T11:59:59.000Z",
        cursors: {}
      },
      {
        sourceSessionId,
        transcriptPath,
        cwd: "/tmp/project",
        observedAt: "2026-08-11T12:00:01.000Z"
      },
      { CLAUDE_CONFIG_DIR: claudeHome }
    );

    expect(appended.equals(Buffer.from(complete))).toBe(true);
  });

  it("rejects mutation of source bytes that were already journaled", async () => {
    const { claudeHome, sourceSessionId, transcriptPath } = fixture();
    const source = `${JSON.stringify({
      uuid: randomUUID(),
      timestamp: "2026-08-11T12:00:00.000Z",
      type: "user"
    })}\n`;
    fs.writeFileSync(transcriptPath, source);
    getSessionMessages.mockResolvedValue([]);
    const capturedSessionId = randomUUID();
    const client = {
      async lookupConversationSourceArtifact() {
        return {
          artifact: {
            id: randomUUID(),
            sessionId: capturedSessionId,
            providerCursorOffset: Buffer.byteLength(source),
            providerCursorLine: 1,
            journalStartOffset: 0
          }
        };
      },
      async listConversationSourceSegments() {
        return {
          segments: [
            {
              id: randomUUID(),
              sourceStartOffset: 0,
              sourceEndOffset: Buffer.byteLength(source),
              plaintextDigest: "0".repeat(64),
              plaintextSize: Buffer.byteLength(source)
            }
          ]
        };
      }
    } as unknown as MemoryApiClient;

    await expect(
      processClaudeTranscriptSignal(
        client,
        {
          version: 2,
          activatedAt: "2026-08-11T11:59:59.000Z",
          cursors: {}
        },
        {
          sourceSessionId,
          transcriptPath,
          cwd: "/tmp/project"
        },
        { CLAUDE_CONFIG_DIR: claudeHome }
      )
    ).rejects.toThrow("claude_transcript_append_only_identity_violation");
  });

  it("rejects a hook-selected transcript outside the configured Claude home", async () => {
    const { root, claudeHome, sourceSessionId } = fixture();
    const transcriptPath = path.join(root, `${sourceSessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, "{}\n");

    await expect(
      processClaudeTranscriptSignal(
        {} as MemoryApiClient,
        {
          version: 2,
          activatedAt: "2026-08-11T11:59:59.000Z",
          cursors: {}
        },
        {
          sourceSessionId,
          transcriptPath,
          cwd: "/tmp/project"
        },
        { CLAUDE_CONFIG_DIR: claudeHome }
      )
    ).rejects.toThrow("claude_transcript_outside_config_home");
    expect(getSessionMessages).not.toHaveBeenCalled();
  });
});
