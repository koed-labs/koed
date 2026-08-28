import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryApiError, type MemoryApiClient } from "../src/index.js";
import {
  createClaudeHistoricalProviderAdapter,
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
  it("uses the frozen component frontier and yields while journaling is incomplete", async () => {
    const sourceSessionId = randomUUID();
    const artifactId = randomUUID();
    watcherMocks.discover.mockResolvedValueOnce([
      { sourceSessionId, cwd: "/work/project" }
    ]);
    watcherMocks.register.mockResolvedValueOnce([
      {
        id: artifactId,
        sourceComponentId: "main",
        providerCursorOffset: 1_024,
        registrationFrontierOffset: 2_048
      }
    ]);
    const client = {
      effectiveCapturePolicy: vi.fn(async () => ({
        policy: {
          visibility: "personal",
          captureState: "enabled",
          paused: false
        }
      })),
      historicalImportAdmission: vi.fn(async () => ({ admitted: true })),
      lookupConversationSourceArtifact: vi.fn(async () => {
        throw new MemoryApiError("not found", { status: 404 });
      }),
      lookupHistoricalImportSource: vi.fn(),
      createHistoricalImportRun: vi.fn(),
      createHistoricalImportSource: vi.fn()
    } as unknown as MemoryApiClient;
    const adapter = createClaudeHistoricalProviderAdapter({
      client,
      env: { MEMORY_HISTORICAL_IMPORT_JOURNAL_BATCH_BYTES: "1024" }
    });
    const candidate = {
      sourceSessionId,
      transcriptPath: `/private/${sourceSessionId}.jsonl`,
      cwd: "/work/project",
      latestActivityAt: "2026-08-17T00:00:00.000Z",
      frontierOffset: 2_048,
      frontierLine: 2,
      components: [
        {
          componentId: "main",
          componentRole: "primary" as const,
          parentComponentId: null,
          transcriptPath: `/private/${sourceSessionId}.jsonl`,
          frontierOffset: 2_048,
          frontierLine: 2
        }
      ]
    };
    const selection = adapter.selectCandidates(
      [candidate],
      new Date("2026-08-17T12:00:00.000Z")
    )[0]!;

    await expect(
      adapter.processNextBatch({ candidate, selection })
    ).resolves.toMatchObject({ state: "progress", selection });

    expect(watcherMocks.register).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ sourceSessionId }),
      expect.any(Object),
      {
        components: [
          {
            componentId: "main",
            componentRole: "primary",
            parentComponentId: null,
            frontierOffset: 2_048,
            frontierLine: 2
          }
        ],
        maxBytesPerPass: 1_024
      }
    );
    expect(client.lookupHistoricalImportSource).not.toHaveBeenCalled();
    expect(client.createHistoricalImportSource).not.toHaveBeenCalled();
  });

  it("rehydrates legacy auxiliary frontiers from existing artifacts", async () => {
    const sourceSessionId = randomUUID();
    watcherMocks.discover.mockResolvedValueOnce([
      { sourceSessionId, cwd: "/work/project" }
    ]);
    watcherMocks.register.mockResolvedValueOnce([
      {
        id: randomUUID(),
        sourceComponentId: "main",
        providerCursorOffset: 0,
        registrationFrontierOffset: 100
      }
    ]);
    const client = {
      effectiveCapturePolicy: vi.fn(async () => ({
        policy: {
          visibility: "personal",
          captureState: "enabled",
          paused: false
        }
      })),
      historicalImportAdmission: vi.fn(async () => ({ admitted: true })),
      lookupConversationSourceArtifact: vi.fn(
        async (query: { sourceComponentId?: string }) => {
          if (query.sourceComponentId === "main") {
            throw new MemoryApiError("not found", { status: 404 });
          }
          return {
            artifact: {
              id: randomUUID(),
              sessionId: randomUUID(),
              providerCursorOffset: 1_500,
              providerCursorLine: 3,
              journalStartOffset: 0,
              liveStartOffset: 1_500,
              liveStartLine: 3
            }
          };
        }
      ),
      lookupHistoricalImportSource: vi.fn()
    } as unknown as MemoryApiClient;
    const adapter = createClaudeHistoricalProviderAdapter({ client, env: {} });
    const candidate = {
      sourceSessionId,
      transcriptPath: `/private/${sourceSessionId}.jsonl`,
      cwd: "/work/project",
      latestActivityAt: "2026-08-17T00:00:00.000Z",
      frontierOffset: 100,
      frontierLine: 1,
      components: [
        {
          componentId: "main",
          componentRole: "primary" as const,
          parentComponentId: null,
          transcriptPath: `/private/${sourceSessionId}.jsonl`,
          frontierOffset: 200,
          frontierLine: 2
        },
        {
          componentId: "subagent.legacy",
          componentRole: "auxiliary" as const,
          parentComponentId: "main",
          transcriptPath: "/private/subagent-legacy.jsonl",
          frontierOffset: 2_000,
          frontierLine: 4
        }
      ]
    };
    const selection = {
      aiClient: "claude",
      candidateId: sourceSessionId,
      frontierOffset: 100,
      frontierLine: 1,
      latestActivityAt: candidate.latestActivityAt,
      adapterState: { projectId: candidate.cwd }
    };

    const result = await adapter.processNextBatch({ candidate, selection });

    expect(result.selection.adapterState?.componentFrontiers).toEqual([
      {
        componentId: "main",
        componentRole: "primary",
        parentComponentId: null,
        frontierOffset: 100,
        frontierLine: 1
      },
      {
        componentId: "subagent.legacy",
        componentRole: "auxiliary",
        parentComponentId: "main",
        frontierOffset: 1_500,
        frontierLine: 3
      }
    ]);
    expect(watcherMocks.register).toHaveBeenCalledWith(
      client,
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        components: result.selection.adapterState?.componentFrontiers
      })
    );
  });

  it("narrows a frozen selection to an earlier live artifact frontier", async () => {
    const sourceSessionId = randomUUID();
    watcherMocks.discover.mockResolvedValueOnce([
      { sourceSessionId, cwd: "/work/project" }
    ]);
    watcherMocks.register.mockResolvedValueOnce([
      {
        id: randomUUID(),
        sourceComponentId: "main",
        providerCursorOffset: 1_024,
        registrationFrontierOffset: 1_500
      }
    ]);
    const client = {
      effectiveCapturePolicy: vi.fn(async () => ({
        policy: {
          visibility: "personal",
          captureState: "enabled",
          paused: false
        }
      })),
      historicalImportAdmission: vi.fn(async () => ({ admitted: true })),
      lookupConversationSourceArtifact: vi.fn(async () => ({
        artifact: {
          id: randomUUID(),
          sessionId: randomUUID(),
          providerCursorOffset: 2_000,
          providerCursorLine: 2,
          journalStartOffset: 0,
          liveStartOffset: 1_500,
          liveStartLine: 1
        }
      })),
      lookupHistoricalImportSource: vi.fn()
    } as unknown as MemoryApiClient;
    const adapter = createClaudeHistoricalProviderAdapter({ client, env: {} });
    const candidate = {
      sourceSessionId,
      transcriptPath: `/private/${sourceSessionId}.jsonl`,
      cwd: "/work/project",
      latestActivityAt: "2026-08-17T00:00:00.000Z",
      frontierOffset: 2_000,
      frontierLine: 2,
      components: [
        {
          componentId: "main",
          componentRole: "primary" as const,
          parentComponentId: null,
          transcriptPath: `/private/${sourceSessionId}.jsonl`,
          frontierOffset: 2_000,
          frontierLine: 2
        }
      ]
    };
    const selection = adapter.selectCandidates(
      [candidate],
      new Date("2026-08-17T12:00:00.000Z")
    )[0]!;

    const result = await adapter.processNextBatch({ candidate, selection });

    expect(result.selection).toMatchObject({
      frontierOffset: 1_500,
      frontierLine: 1,
      adapterState: {
        componentFrontiers: [
          expect.objectContaining({
            componentId: "main",
            frontierOffset: 1_500,
            frontierLine: 1
          })
        ]
      }
    });
    expect(watcherMocks.register).toHaveBeenCalledWith(
      client,
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        components: [
          expect.objectContaining({
            componentId: "main",
            frontierOffset: 1_500,
            frontierLine: 1
          })
        ]
      })
    );
  });

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
    expect(client.createHistoricalImportSource).toHaveBeenCalledWith(
      expect.objectContaining({
        aiClient: "claude",
        detectedProject: { path: "/work/project", cwd: "/work/project" }
      })
    );
    expect(transitionHistoricalImportSource).toHaveBeenCalledTimes(4);
  });

  it("attaches new candidate sources to the coordinator's existing run", async () => {
    const artifactId = randomUUID();
    const sourceId = randomUUID();
    const runId = randomUUID();
    const source = {
      id: sourceId,
      runId,
      artifactId,
      sessionId: randomUUID(),
      sourceSessionId: "claude-session-cohort",
      sourceFingerprint: "c".repeat(64),
      historicalCursorOffset: 0,
      historicalCursorLine: 0,
      registrationFrontierOffset: 0,
      state: "discovered"
    };
    watcherMocks.discover.mockResolvedValueOnce([
      { externalSessionId: "claude-session-cohort", cwd: "/work/project" }
    ]);
    watcherMocks.register.mockResolvedValueOnce([
      { id: artifactId, sourceComponentId: "main" }
    ]);
    const client = {
      lookupHistoricalImportSource: vi.fn(async () => {
        throw new MemoryApiError("not found", { status: 404 });
      }),
      createHistoricalImportRun: vi.fn(),
      transitionHistoricalImportRun: vi.fn(),
      createHistoricalImportSource: vi.fn(async () => ({ source })),
      transitionHistoricalImportSource: vi.fn(
        async (_id: string, transition: Record<string, unknown>) => ({
          source: { ...source, state: transition.state }
        })
      ),
      listConversationSourceSegments: vi.fn()
    } as unknown as MemoryApiClient;

    await expect(
      importSelectedClaudeHistory({
        client,
        sourceSessionIds: ["claude-session-cohort"],
        runId
      })
    ).resolves.toMatchObject({ runId, runIds: [runId] });

    expect(client.createHistoricalImportRun).not.toHaveBeenCalled();
    expect(client.transitionHistoricalImportRun).not.toHaveBeenCalled();
    expect(client.createHistoricalImportSource).toHaveBeenCalledWith(
      expect.objectContaining({ runId, aiClient: "claude" })
    );
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
