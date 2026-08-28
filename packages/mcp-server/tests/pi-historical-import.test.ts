import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryApiClient, MemoryApiError } from "../src/index.js";
import {
  createPiHistoricalProviderAdapter,
  importNextPiHistoricalBatch,
  registerPiHistoricalTranscriptSource
} from "../src/pi-historical-import.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const appendLargeValidPrefix = (target: string): number => {
  const recordsPerChunk = 256 * 1024;
  const chunk = "{}\n".repeat(recordsPerChunk);
  let bytes = 0;
  let lines = 0;
  while (bytes <= 17 * 1024 * 1024) {
    fs.appendFileSync(target, chunk);
    bytes += Buffer.byteLength(chunk);
    lines += recordsPerChunk;
  }
  return lines;
};

describe("Pi historical transcript registration", () => {
  it("pins the frozen frontier and appends one configured journal page", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-history-"));
    temporaryDirectories.push(root);
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const sourceSessionId = randomUUID();
    const transcriptPath = path.join(sessions, `${sourceSessionId}.jsonl`);
    const cwd = "/tmp/pi-history";
    const historical = [
      line({ type: "session", version: 3, id: sourceSessionId, cwd }),
      ...Array.from({ length: 4 }, (_, index) =>
        line({
          type: "message",
          id: `historical-${index}`,
          timestamp: `2026-08-17T00:00:0${index}.000Z`,
          message: { role: "user", content: "x".repeat(600) }
        })
      )
    ].join("");
    fs.writeFileSync(transcriptPath, historical);
    const frozenFrontier = Buffer.byteLength(historical);
    fs.appendFileSync(
      transcriptPath,
      line({
        type: "message",
        id: "live-after-selection",
        timestamp: "2026-08-17T00:01:00.000Z",
        message: { role: "user", content: "live" }
      })
    );
    let artifact: Record<string, unknown> | null = null;
    const appendedEnds: number[] = [];
    const createHistoricalImportRun = vi.fn();
    const createHistoricalImportSource = vi.fn();
    const client = {
      effectiveCapturePolicy: vi.fn(async () => ({
        policy: {
          visibility: "personal",
          captureState: "enabled",
          paused: false
        }
      })),
      historicalImportAdmission: vi.fn(async () => ({ admitted: true })),
      lookupHistoricalImportSource: vi.fn(async () => {
        throw new MemoryApiError("not found", { status: 404 });
      }),
      createHistoricalImportRun,
      createHistoricalImportSource,
      async lookupConversationSourceArtifact() {
        if (!artifact) throw new MemoryApiError("not found", { status: 404 });
        return { artifact };
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        artifact = {
          id: randomUUID(),
          sessionId: randomUUID(),
          providerCursorOffset: 0,
          providerCursorLine: 0,
          liveStartOffset: input.liveStartOffset,
          sourceFingerprint: input.sourceFingerprint
        };
        return { artifact };
      },
      async appendConversationSourceSegment(
        artifactId: string,
        input: Record<string, unknown>
      ) {
        appendedEnds.push(Number(input.sourceEndOffset));
        artifact = {
          ...artifact,
          id: artifactId,
          providerCursorOffset: input.sourceEndOffset,
          providerCursorLine: input.sourceEndLine
        };
        return { artifact };
      }
    } as unknown as MemoryApiClient;

    const registered = await registerPiHistoricalTranscriptSource(
      client,
      { sourceSessionId, transcriptPath, cwd },
      {
        KOED_HOME: path.join(root, "koed"),
        PI_CODING_AGENT_SESSION_DIR: sessions
      },
      {
        frontierOffset: frozenFrontier,
        frontierLine: 5,
        maxBytesPerPass: 1_024
      }
    );

    expect(artifact).toMatchObject({ liveStartOffset: frozenFrontier });
    expect(appendedEnds).toHaveLength(1);
    expect(appendedEnds[0]).toBeLessThan(frozenFrontier);
    expect(registered.registrationFrontierOffset).toBe(frozenFrontier);
    expect(registered.providerCursorOffset).toBe(appendedEnds[0]);

    const adapter = createPiHistoricalProviderAdapter({
      client,
      env: {
        KOED_HOME: path.join(root, "koed"),
        PI_CODING_AGENT_SESSION_DIR: sessions,
        MEMORY_HISTORICAL_IMPORT_JOURNAL_BATCH_BYTES: "1024"
      }
    });
    const candidate = {
      sourceSessionId,
      transcriptPath,
      cwd,
      latestActivityAt: "2026-08-17T00:00:00.000Z",
      frontierOffset: frozenFrontier,
      frontierLine: 5
    };
    const selection = adapter.selectCandidates(
      [candidate],
      new Date("2026-08-17T12:00:00.000Z")
    )[0]!;
    await expect(
      adapter.processNextBatch({ candidate, selection })
    ).resolves.toMatchObject({ state: "progress" });
    expect(appendedEnds).toHaveLength(2);
    expect(appendedEnds[1]).toBeLessThan(frozenFrontier);
    expect(createHistoricalImportRun).not.toHaveBeenCalled();
    expect(createHistoricalImportSource).not.toHaveBeenCalled();
  });

  it("converges when the live watcher wins a journal append race", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-history-"));
    temporaryDirectories.push(root);
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const sourceSessionId = randomUUID();
    const transcriptPath = path.join(sessions, `${sourceSessionId}.jsonl`);
    const cwd = "/tmp/pi-history";
    fs.writeFileSync(
      transcriptPath,
      line({ type: "session", version: 3, id: sourceSessionId, cwd })
    );
    const boundary = fs.statSync(transcriptPath).size;
    const artifactId = randomUUID();
    let lookupCount = 0;
    const client = {
      async lookupConversationSourceArtifact() {
        lookupCount += 1;
        if (lookupCount === 1) {
          throw new MemoryApiError("not found", { status: 404 });
        }
        return {
          artifact: {
            id: artifactId,
            sessionId: randomUUID(),
            providerCursorOffset: boundary,
            providerCursorLine: 1,
            sourceFingerprint: "fingerprint"
          }
        };
      },
      async ensureConversationSourceArtifact() {
        return {
          artifact: {
            id: artifactId,
            sessionId: randomUUID(),
            providerCursorOffset: 0,
            providerCursorLine: 0,
            sourceFingerprint: "fingerprint"
          }
        };
      },
      async appendConversationSourceSegment() {
        throw new MemoryApiError("cursor conflict", { status: 409 });
      }
    } as unknown as MemoryApiClient;

    const registered = await registerPiHistoricalTranscriptSource(
      client,
      { sourceSessionId, transcriptPath, cwd },
      {
        KOED_HOME: path.join(root, "koed"),
        PI_CODING_AGENT_SESSION_DIR: sessions
      }
    );

    expect(registered.providerCursorOffset).toBe(boundary);
    expect(lookupCount).toBe(2);
  });

  it("uses an earlier live activation frontier discovered after registration", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-history-"));
    temporaryDirectories.push(root);
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const sourceSessionId = randomUUID();
    const transcriptPath = path.join(sessions, `${sourceSessionId}.jsonl`);
    const cwd = "/tmp/pi-history";
    fs.writeFileSync(
      transcriptPath,
      line({ type: "session", version: 3, id: sourceSessionId, cwd })
    );
    const activationFrontier = fs.statSync(transcriptPath).size;
    fs.appendFileSync(
      transcriptPath,
      line({
        type: "message",
        id: "advanced-before-discovery",
        timestamp: "2026-08-17T00:01:00.000Z",
        message: { role: "user", content: "later" }
      })
    );
    const discoveryFrontier = fs.statSync(transcriptPath).size;
    const appendConversationSourceSegment = vi.fn();
    const client = {
      lookupConversationSourceArtifact: vi.fn(async () => ({
        artifact: {
          id: randomUUID(),
          sessionId: randomUUID(),
          providerCursorOffset: discoveryFrontier,
          providerCursorLine: 2,
          liveStartOffset: activationFrontier,
          liveStartLine: 1,
          sourceFingerprint: "fingerprint"
        }
      })),
      appendConversationSourceSegment
    } as unknown as MemoryApiClient;

    const registered = await registerPiHistoricalTranscriptSource(
      client,
      { sourceSessionId, transcriptPath, cwd },
      {
        KOED_HOME: path.join(root, "koed"),
        PI_CODING_AGENT_SESSION_DIR: sessions
      },
      { frontierOffset: discoveryFrontier, frontierLine: 2 }
    );

    expect(registered.registrationFrontierOffset).toBe(activationFrontier);
    expect(registered.registrationFrontierLine).toBe(1);
    expect(appendConversationSourceSegment).not.toHaveBeenCalled();
  });

  it("streams line counting across a large registration frontier", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-history-"));
    temporaryDirectories.push(root);
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const sourceSessionId = randomUUID();
    const transcriptPath = path.join(sessions, `${sourceSessionId}.jsonl`);
    const cwd = "/tmp/pi-history";
    fs.writeFileSync(
      transcriptPath,
      line({ type: "session", version: 3, id: sourceSessionId, cwd })
    );
    const historicalLines = appendLargeValidPrefix(transcriptPath);
    let artifact: Record<string, unknown> | null = null;
    let ensuredLiveStartLine: unknown;
    const client = {
      async lookupConversationSourceArtifact() {
        throw new MemoryApiError("not found", { status: 404 });
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        ensuredLiveStartLine = input.liveStartLine;
        artifact = {
          id: randomUUID(),
          sessionId: randomUUID(),
          providerCursorOffset: 0,
          providerCursorLine: 0,
          sourceFingerprint: input.sourceFingerprint
        };
        return { artifact };
      },
      async appendConversationSourceSegment(
        artifactId: string,
        input: Record<string, unknown>
      ) {
        artifact = {
          ...artifact,
          id: artifactId,
          providerCursorOffset: input.sourceEndOffset,
          providerCursorLine: input.sourceEndLine
        };
        return { artifact };
      }
    } as unknown as MemoryApiClient;

    const registered = await registerPiHistoricalTranscriptSource(
      client,
      { sourceSessionId, transcriptPath, cwd },
      {
        KOED_HOME: path.join(root, "koed"),
        PI_CODING_AGENT_SESSION_DIR: sessions
      }
    );

    expect(ensuredLiveStartLine).toBe(historicalLines + 1);
    expect(registered.registrationFrontierOffset).toBe(
      fs.statSync(transcriptPath).size
    );
  });
});

describe("Pi automatic historical policy ordering", () => {
  it("persists an earlier live artifact frontier in the frozen selection", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-history-"));
    temporaryDirectories.push(root);
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const sourceSessionId = randomUUID();
    const transcriptPath = path.join(sessions, `${sourceSessionId}.jsonl`);
    const cwd = "/tmp/pi-history";
    fs.writeFileSync(
      transcriptPath,
      [
        line({ type: "session", version: 3, id: sourceSessionId, cwd }),
        ...Array.from({ length: 10 }, (_, index) =>
          line({
            type: "message",
            id: `activation-${index}`,
            timestamp: `2026-08-17T00:00:${String(index).padStart(2, "0")}.000Z`,
            message: { role: "user", content: "x".repeat(300) }
          })
        )
      ].join("")
    );
    const activationFrontier = fs.statSync(transcriptPath).size;
    fs.appendFileSync(
      transcriptPath,
      line({
        type: "message",
        id: "advanced-before-discovery",
        timestamp: "2026-08-17T00:01:00.000Z",
        message: { role: "user", content: "later" }
      })
    );
    const discoveryFrontier = fs.statSync(transcriptPath).size;
    let artifact: Record<string, unknown> = {
      id: randomUUID(),
      sessionId: randomUUID(),
      providerCursorOffset: 0,
      providerCursorLine: 0,
      liveStartOffset: activationFrontier,
      liveStartLine: 11,
      sourceFingerprint: "fingerprint"
    };
    const client = {
      effectiveCapturePolicy: vi.fn(async () => ({
        policy: {
          visibility: "personal",
          captureState: "enabled",
          paused: false
        }
      })),
      historicalImportAdmission: vi.fn(async () => ({ admitted: true })),
      lookupConversationSourceArtifact: vi.fn(async () => ({ artifact })),
      appendConversationSourceSegment: vi.fn(
        async (artifactId: string, input: Record<string, unknown>) => {
          artifact = {
            ...artifact,
            id: artifactId,
            providerCursorOffset: input.sourceEndOffset,
            providerCursorLine: input.sourceEndLine
          };
          return { artifact };
        }
      )
    } as unknown as MemoryApiClient;
    const adapter = createPiHistoricalProviderAdapter({
      client,
      env: {
        KOED_HOME: path.join(root, "koed"),
        PI_CODING_AGENT_SESSION_DIR: sessions,
        MEMORY_HISTORICAL_IMPORT_JOURNAL_BATCH_BYTES: "1024"
      }
    });
    const candidate = {
      sourceSessionId,
      transcriptPath,
      cwd,
      latestActivityAt: "2026-08-17T00:01:00.000Z",
      frontierOffset: discoveryFrontier,
      frontierLine: 12
    };
    const selection = adapter.selectCandidates(
      [candidate],
      new Date("2026-08-17T12:00:00.000Z")
    )[0]!;

    const result = await adapter.processNextBatch({ candidate, selection });

    expect(result).toMatchObject({
      state: "progress",
      selection: {
        artifactId: artifact.id,
        frontierOffset: activationFrontier,
        frontierLine: 11
      }
    });
    expect(Number(artifact.providerCursorOffset)).toBeLessThan(
      activationFrontier
    );
  });

  it("does not register or upload an artifact while Capture Pause is active", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-history-"));
    temporaryDirectories.push(root);
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const sourceSessionId = randomUUID();
    const transcriptPath = path.join(sessions, `${sourceSessionId}.jsonl`);
    const cwd = "/tmp/pi-history";
    fs.writeFileSync(
      transcriptPath,
      line({ type: "session", version: 3, id: sourceSessionId, cwd })
    );
    const lookupConversationSourceArtifact = vi.fn();
    const historicalImportAdmission = vi.fn();
    const client = {
      effectiveCapturePolicy: vi.fn(async () => ({
        policy: {
          visibility: "personal",
          captureState: "enabled",
          paused: true
        }
      })),
      historicalImportAdmission,
      lookupConversationSourceArtifact
    } as unknown as MemoryApiClient;
    const adapter = createPiHistoricalProviderAdapter({
      client,
      env: {
        KOED_HOME: path.join(root, "koed"),
        PI_CODING_AGENT_SESSION_DIR: sessions
      }
    });
    const frontierOffset = fs.statSync(transcriptPath).size;

    await expect(
      adapter.processNextBatch({
        candidate: {
          sourceSessionId,
          transcriptPath,
          cwd,
          latestActivityAt: "2026-08-17T00:00:00.000Z",
          frontierOffset,
          frontierLine: 1
        },
        selection: {
          aiClient: "pi",
          candidateId: sourceSessionId,
          frontierOffset,
          frontierLine: 1,
          latestActivityAt: "2026-08-17T00:00:00.000Z",
          adapterState: { projectId: cwd }
        }
      })
    ).resolves.toMatchObject({ state: "waiting" });

    expect(historicalImportAdmission).not.toHaveBeenCalled();
    expect(lookupConversationSourceArtifact).not.toHaveBeenCalled();
  });
});

describe("Pi bounded historical record representation", () => {
  const sourceFor = (bytes: Buffer) => ({
    id: randomUUID(),
    runId: randomUUID(),
    artifactId: randomUUID(),
    sessionId: randomUUID(),
    sourceSessionId: randomUUID(),
    sourceFingerprint: "a".repeat(64),
    historicalCursorOffset: 0,
    historicalCursorLine: 0,
    registrationFrontierOffset: bytes.length,
    state: "importing"
  });

  const clientFor = (source: ReturnType<typeof sourceFor>, bytes: Buffer) => {
    const batches: Array<Record<string, unknown>> = [];
    const client = {
      listConversationSourceSegments: vi.fn(async () => ({
        segments: [
          {
            id: "segment-0",
            segmentIndex: 0,
            sourceStartOffset: 0,
            sourceEndOffset: bytes.length,
            plaintextDigest: "b".repeat(64)
          }
        ]
      })),
      getConversationSourceSegmentContent: vi.fn(async () => ({
        bytesBase64: bytes.toString("base64")
      })),
      ingestHistoricalImportBatch: vi.fn(
        async (_sourceId: string, batch: Record<string, unknown>) => {
          batches.push(batch);
          return { source };
        }
      )
    } as unknown as MemoryApiClient;
    return { batches, client };
  };

  const messageRecord = (id: string, text: string): string =>
    line({
      type: "message",
      id,
      timestamp: "2026-08-17T00:00:00.000Z",
      message: { role: "user", content: text }
    });

  it("uses transport chunks for a record above the configured batch target and continues", async () => {
    const firstRecord = messageRecord("large", "x".repeat(1_100_000));
    const bytes = Buffer.from(
      `${firstRecord}${messageRecord("later", "valid later record")}`
    );
    const source = sourceFor(bytes);
    const { batches, client } = clientFor(source, bytes);

    await expect(
      importNextPiHistoricalBatch(client, source, {
        maxRows: 100,
        maxBytes: 1_000_000
      })
    ).resolves.toBe(true);
    const first = batches[0]!;
    const firstItems = first.items as Array<Record<string, unknown>>;
    expect(firstItems.length).toBeGreaterThan(1);
    expect(firstItems.every((item) => item.logicalSourceId)).toBe(true);
    expect(first.skippedRecordCount).toBeUndefined();

    await expect(
      importNextPiHistoricalBatch(
        client,
        {
          ...source,
          historicalCursorOffset: first.sourceOffset as number,
          historicalCursorLine: first.sourceLine as number,
          historicalCursorParserState: first.parserState as Record<
            string,
            unknown
          >
        },
        { maxRows: 100, maxBytes: 1_000_000 }
      )
    ).resolves.toBe(true);
    expect(batches[1]?.items).toEqual([
      expect.objectContaining({ rawText: "valid later record" })
    ]);
  });

  it("persists an auditable gap above the hard payload ceiling and continues", async () => {
    const firstRecord = messageRecord("too-large", "x".repeat(4_100_000));
    const bytes = Buffer.from(
      `${firstRecord}${messageRecord("later", "valid after gap")}`
    );
    const source = sourceFor(bytes);
    const { batches, client } = clientFor(source, bytes);

    await importNextPiHistoricalBatch(client, source, {
      maxRows: 100,
      maxBytes: 1_000_000
    });
    const gap = batches[0]!;
    expect(gap).toMatchObject({ skippedRecordCount: 1 });
    const gapItems = gap.items as Array<Record<string, unknown>>;
    expect(gapItems).toHaveLength(1);
    expect(gapItems[0]).toMatchObject({
      sourceRecordType: "historical_gap",
      sourceEventType: "record_skipped",
      projectionStatus: "raw_only",
      rawJson: {
        reason: "pi_historical_record_exceeds_product_ceiling"
      }
    });

    await importNextPiHistoricalBatch(
      client,
      {
        ...source,
        historicalCursorOffset: gap.sourceOffset as number,
        historicalCursorLine: gap.sourceLine as number,
        historicalCursorParserState: gap.parserState as Record<string, unknown>
      },
      { maxRows: 100, maxBytes: 1_000_000 }
    );
    expect(batches[1]?.items).toEqual([
      expect.objectContaining({ rawText: "valid after gap" })
    ]);
  });
});
