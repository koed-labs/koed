import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryApiError, type MemoryApiClient } from "../src/index.js";
import {
  importClaudeHistoricalSource,
  importSelectedClaudeHistory
} from "../src/claude-historical-import.js";

const watcherMocks = vi.hoisted(() => ({
  discover: vi.fn(),
  register: vi.fn()
}));

vi.mock("../src/claude-transcript-watcher.js", () => ({
  discoverClaudeHistoricalTranscriptSignals: watcherMocks.discover,
  registerClaudeHistoricalTranscriptSources: watcherMocks.register
}));

describe("Claude historical import", () => {
  it("resumes an existing artifact source without creating duplicate state", async () => {
    const artifactId = randomUUID();
    const sourceId = randomUUID();
    const runId = randomUUID();
    watcherMocks.discover.mockResolvedValueOnce([
      { externalSessionId: "claude-session", cwd: "/work/project" }
    ]);
    watcherMocks.register.mockResolvedValueOnce([
      { id: artifactId, sourceComponentId: "main" }
    ]);
    const client = {
      lookupHistoricalImportSource: vi.fn(async () => ({
        source: {
          id: sourceId,
          runId,
          artifactId,
          sessionId: randomUUID(),
          sourceSessionId: "claude-session",
          sourceFingerprint: "b".repeat(64),
          historicalCursorOffset: 100,
          historicalCursorLine: 2,
          registrationFrontierOffset: 100,
          state: "importing"
        }
      })),
      createHistoricalImportRun: vi.fn(),
      createHistoricalImportSource: vi.fn(),
      listConversationSourceSegments: vi.fn(),
      transitionHistoricalImportSource: vi.fn(async () => ({ source: {} }))
    } as unknown as MemoryApiClient;

    await expect(
      importSelectedClaudeHistory({
        client,
        sourceSessionIds: ["claude-session"]
      })
    ).resolves.toMatchObject({
      runId,
      runIds: [runId],
      sources: [
        {
          sourceId,
          sourceComponentId: "main",
          resumed: true,
          batchCount: 0,
          itemCount: 0
        }
      ]
    });
    expect(client.createHistoricalImportRun).not.toHaveBeenCalled();
    expect(client.createHistoricalImportSource).not.toHaveBeenCalled();
    expect(client.listConversationSourceSegments).not.toHaveBeenCalled();
  });

  it("creates durable import state only when the artifact is new", async () => {
    const artifactId = randomUUID();
    const sourceId = randomUUID();
    const runId = randomUUID();
    const source = {
      id: sourceId,
      runId,
      artifactId,
      sessionId: randomUUID(),
      sourceSessionId: "claude-session-new",
      sourceFingerprint: "c".repeat(64),
      historicalCursorOffset: 0,
      historicalCursorLine: 0,
      registrationFrontierOffset: 0,
      state: "discovered"
    };
    watcherMocks.discover.mockResolvedValueOnce([
      { externalSessionId: "claude-session-new", cwd: "/work/project" }
    ]);
    watcherMocks.register.mockResolvedValueOnce([
      { id: artifactId, sourceComponentId: "main" }
    ]);
    const transitionHistoricalImportSource = vi.fn(
      async (_id: string, input: Record<string, unknown>) => ({
        source: { ...source, state: input.state }
      })
    );
    const client = {
      lookupHistoricalImportSource: vi.fn(async () => {
        throw new MemoryApiError("not found", { status: 404 });
      }),
      createHistoricalImportRun: vi.fn(async () => ({ run: { id: runId } })),
      transitionHistoricalImportRun: vi.fn(async () => ({
        run: { id: runId }
      })),
      createHistoricalImportSource: vi.fn(async () => ({ source })),
      transitionHistoricalImportSource,
      listConversationSourceSegments: vi.fn()
    } as unknown as MemoryApiClient;

    await expect(
      importSelectedClaudeHistory({
        client,
        sourceSessionIds: ["claude-session-new"]
      })
    ).resolves.toMatchObject({ runId, runIds: [runId] });
    expect(client.createHistoricalImportRun).toHaveBeenCalledTimes(1);
    expect(client.createHistoricalImportSource).toHaveBeenCalledTimes(1);
    expect(transitionHistoricalImportSource).toHaveBeenCalledTimes(4);
  });

  it("imports the signed pre-activation range in source order", async () => {
    const externalSessionId = randomUUID();
    const capturedSessionId = randomUUID();
    const records = [
      {
        type: "user",
        uuid: randomUUID(),
        timestamp: "2026-08-11T12:00:00.000Z",
        message: { role: "user", content: "Historical question" }
      },
      {
        type: "assistant",
        uuid: randomUUID(),
        timestamp: "2026-08-11T12:00:01.000Z",
        message: { role: "assistant", content: "Historical answer" }
      }
    ];
    const bytes = Buffer.from(
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
    );
    const batches: Array<Record<string, unknown>> = [];
    const client = {
      listConversationSourceSegments: vi.fn(async () => ({
        segments: [
          {
            id: "segment-1",
            segmentIndex: 0,
            sourceStartOffset: 0,
            sourceEndOffset: bytes.length,
            plaintextDigest: "a".repeat(64)
          }
        ]
      })),
      getConversationSourceSegmentContent: vi.fn(async () => ({
        bytesBase64: bytes.toString("base64")
      })),
      ingestHistoricalImportBatch: vi.fn(
        async (_sourceId: string, batch: Record<string, unknown>) => {
          batches.push(batch);
          return { replayed: false };
        }
      )
    } as unknown as MemoryApiClient;

    const result = await importClaudeHistoricalSource({
      client,
      sourceComponentId: "subagent.researcher",
      source: {
        id: randomUUID(),
        runId: randomUUID(),
        artifactId: randomUUID(),
        sessionId: capturedSessionId,
        sourceSessionId: externalSessionId,
        sourceFingerprint: "b".repeat(64),
        historicalCursorOffset: 0,
        historicalCursorLine: 0,
        registrationFrontierOffset: bytes.length,
        state: "importing"
      }
    });

    expect(result).toMatchObject({ batchCount: 1, itemCount: 2 });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      expectedSourceOffset: 0,
      sourceOffset: bytes.length,
      sourceLine: 2,
      segmentIndex: 0,
      lastVerifiedDigest: "a".repeat(64)
    });
    expect(batches[0]?.items).toEqual([
      expect.objectContaining({
        sourceEventType: "user_message",
        projectionVersion: "claude-code-transcript-v1"
      }),
      expect.objectContaining({
        sourceEventType: "agent_message",
        projectionVersion: "claude-code-transcript-v1"
      })
    ]);
    const importedItems = batches[0]?.items as
      | Array<Record<string, unknown>>
      | undefined;
    expect(
      importedItems?.every(
        (item) =>
          typeof item.canonicalStableItemId === "string" &&
          item.canonicalStableItemId.startsWith("subagent.researcher:")
      )
    ).toBe(true);
  });

  it("restores the persisted turn when resuming before assistant and tool records", async () => {
    const externalSessionId = randomUUID();
    const capturedSessionId = randomUUID();
    const userTurnId = randomUUID();
    const records = [
      {
        type: "user",
        uuid: userTurnId,
        timestamp: "2026-08-11T12:00:00.000Z",
        message: { role: "user", content: "Historical question" }
      },
      {
        type: "assistant",
        uuid: randomUUID(),
        timestamp: "2026-08-11T12:00:01.000Z",
        message: { role: "assistant", content: "Historical answer" }
      },
      {
        type: "user",
        uuid: randomUUID(),
        timestamp: "2026-08-11T12:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "Tool output" }]
        }
      }
    ];
    const encodedRecords = records.map(
      (record) => `${JSON.stringify(record)}\n`
    );
    const bytes = Buffer.from(encodedRecords.join(""));
    const firstCheckpoint = Buffer.byteLength(encodedRecords[0]!, "utf8");
    const segment = {
      id: "segment-resume",
      segmentIndex: 0,
      sourceStartOffset: 0,
      sourceEndOffset: bytes.length,
      plaintextDigest: "f".repeat(64)
    };
    const source = {
      id: randomUUID(),
      runId: randomUUID(),
      artifactId: randomUUID(),
      sessionId: capturedSessionId,
      sourceSessionId: externalSessionId,
      sourceFingerprint: "a".repeat(64),
      historicalCursorOffset: 0,
      historicalCursorLine: 0,
      registrationFrontierOffset: bytes.length,
      state: "importing"
    };
    const batchesFor = () => {
      const batches: Array<Record<string, unknown>> = [];
      const client = {
        listConversationSourceSegments: vi.fn(async () => ({
          segments: [segment]
        })),
        getConversationSourceSegmentContent: vi.fn(async () => ({
          bytesBase64: bytes.toString("base64")
        })),
        ingestHistoricalImportBatch: vi.fn(
          async (_sourceId: string, batch: Record<string, unknown>) => {
            batches.push(batch);
            return { replayed: false };
          }
        )
      } as unknown as MemoryApiClient;
      return { batches, client };
    };

    const uninterrupted = batchesFor();
    await importClaudeHistoricalSource({
      client: uninterrupted.client,
      source
    });

    const firstPart = batchesFor();
    await importClaudeHistoricalSource({
      client: firstPart.client,
      source: { ...source, registrationFrontierOffset: firstCheckpoint }
    });
    const persistedState = firstPart.batches[0]?.parserState as
      | { currentTurnId?: string }
      | undefined;
    expect(persistedState).toEqual({ currentTurnId: userTurnId });

    const resumed = batchesFor();
    await importClaudeHistoricalSource({
      client: resumed.client,
      source: {
        ...source,
        historicalCursorOffset: firstCheckpoint,
        historicalCursorLine: 1,
        historicalCursorCurrentTurnId: persistedState?.currentTurnId
      }
    });

    const uninterruptedItems = uninterrupted.batches[0]?.items as Array<
      Record<string, unknown>
    >;
    const resumedItems = resumed.batches[0]?.items as Array<
      Record<string, unknown>
    >;
    expect(resumedItems).toEqual(uninterruptedItems.slice(1));
    expect(
      resumedItems.map((item) => ({
        sourceEventType: item.sourceEventType,
        externalTurnId: item.externalTurnId,
        canonicalItemKey: item.canonicalItemKey
      }))
    ).toEqual([
      expect.objectContaining({
        sourceEventType: "agent_message",
        externalTurnId: userTurnId
      }),
      expect.objectContaining({
        sourceEventType: "tool_result",
        externalTurnId: userTurnId
      })
    ]);
  });

  it("does no work once the historical cursor reaches the frontier", async () => {
    const client = {
      listConversationSourceSegments: vi.fn()
    } as unknown as MemoryApiClient;
    const frontier = 100;
    await expect(
      importClaudeHistoricalSource({
        client,
        source: {
          id: randomUUID(),
          runId: randomUUID(),
          artifactId: randomUUID(),
          sessionId: randomUUID(),
          sourceSessionId: randomUUID(),
          sourceFingerprint: "b".repeat(64),
          historicalCursorOffset: frontier,
          historicalCursorLine: 2,
          registrationFrontierOffset: frontier,
          state: "importing"
        }
      })
    ).resolves.toMatchObject({ batchCount: 0, itemCount: 0 });
    expect(client.listConversationSourceSegments).not.toHaveBeenCalled();
  });

  it("rejects an oversized single record without advancing the import cursor", async () => {
    const bytes = Buffer.from(
      `${JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        timestamp: "2026-08-11T12:00:00.000Z",
        message: { role: "user", content: "x".repeat(3_500_000) }
      })}\n`
    );
    const client = {
      listConversationSourceSegments: vi.fn(async () => ({
        segments: [
          {
            id: "oversized-segment",
            segmentIndex: 0,
            sourceStartOffset: 0,
            sourceEndOffset: bytes.length,
            plaintextDigest: "d".repeat(64)
          }
        ]
      })),
      getConversationSourceSegmentContent: vi.fn(async () => ({
        bytesBase64: bytes.toString("base64")
      })),
      ingestHistoricalImportBatch: vi.fn()
    } as unknown as MemoryApiClient;

    await expect(
      importClaudeHistoricalSource({
        client,
        source: {
          id: randomUUID(),
          runId: randomUUID(),
          artifactId: randomUUID(),
          sessionId: randomUUID(),
          sourceSessionId: randomUUID(),
          sourceFingerprint: "e".repeat(64),
          historicalCursorOffset: 0,
          historicalCursorLine: 0,
          registrationFrontierOffset: bytes.length,
          state: "importing"
        }
      })
    ).rejects.toThrow("claude_historical_record_exceeds_batch_limit");
    expect(client.ingestHistoricalImportBatch).not.toHaveBeenCalled();
  });
});
