import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryApiClient, MemoryApiError } from "../src/index.js";
import { processPiTranscriptSignal } from "../src/pi-transcript-watcher.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

describe("Pi transcript watcher", () => {
  it("resumes from durable cursor and fails closed on truncation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-watch-"));
    temporaryDirectories.push(root);
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const sourceSessionId = randomUUID();
    const transcriptPath = path.join(sessions, `${sourceSessionId}.jsonl`);
    const cwd = "/tmp/pi-project";
    fs.writeFileSync(
      transcriptPath,
      line({ type: "session", version: 3, id: sourceSessionId, cwd }) +
        line({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-04-01T00:00:00.000Z",
          message: { role: "user", content: "Remember Pi" }
        })
    );

    let artifact: Record<string, unknown> | null = null;
    let cursor: Record<string, unknown> | null = null;
    const segments: Array<Record<string, unknown>> = [];
    const createdExternalItemIds: string[] = [];
    const client = {
      async lookupConversationSourceArtifact() {
        if (!artifact) throw new MemoryApiError("not found", { status: 404 });
        return { artifact };
      },
      async getEffectiveCapturePolicy() {
        return { policy: { captureState: "enabled" } };
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        artifact = {
          id: randomUUID(),
          sessionId: randomUUID(),
          providerCursorOffset: input.journalStartOffset,
          providerCursorLine: input.journalStartLine,
          journalStartOffset: input.journalStartOffset,
          liveStartOffset: input.liveStartOffset,
          liveStartLine: input.liveStartLine,
          sourceFingerprint: input.sourceFingerprint
        };
        return { artifact };
      },
      async appendConversationSourceSegment(
        artifactId: string,
        input: Record<string, unknown>
      ) {
        const bytes = Buffer.from(String(input.bytesBase64), "base64");
        const segment = {
          id: randomUUID(),
          segmentIndex: segments.length,
          sourceStartOffset: input.expectedProviderOffset,
          sourceEndOffset: input.sourceEndOffset,
          plaintextDigest: createHash("sha256").update(bytes).digest("hex"),
          plaintextSize: bytes.length
        };
        segments.push(segment);
        artifact = {
          ...artifact,
          id: artifactId,
          providerCursorOffset: input.sourceEndOffset,
          providerCursorLine: input.sourceEndLine
        };
        return { artifact };
      },
      async listConversationSourceSegments(
        _artifactId: string,
        input: { afterOffset: number; limit: number }
      ) {
        return {
          segments: segments
            .filter(
              (segment) => Number(segment.sourceEndOffset) > input.afterOffset
            )
            .slice(0, input.limit)
        };
      },
      async getConversationSourceCursor() {
        return { cursor };
      },
      async createConversationItems(input: {
        items: Array<Record<string, unknown>>;
      }) {
        createdExternalItemIds.push(
          ...input.items.map((item) => String(item.externalItemId))
        );
        return {
          items: input.items.map((item) => ({ ...item, id: randomUUID() }))
        };
      },
      async projectConversationItems() {
        return {};
      },
      async advanceConversationSourceCursor(
        _artifactId: string,
        input: Record<string, unknown>
      ) {
        cursor = {
          sourceOffset: input.sourceOffset,
          sourceLine: input.sourceLine,
          parserState: input.parserState
        };
        return { cursor };
      }
    } as unknown as MemoryApiClient;
    const env = {
      KOED_HOME: path.join(root, "koed"),
      PI_CODING_AGENT_SESSION_DIR: sessions
    };
    const state = {
      version: 1 as const,
      activatedAt: "1970-01-01T00:00:00.000Z",
      baselines: {}
    };
    const signal = { sourceSessionId, transcriptPath, cwd };

    await processPiTranscriptSignal(client, state, signal, env);
    const firstBoundary = fs.statSync(transcriptPath).size;
    expect((cursor as { sourceOffset?: unknown } | null)?.sourceOffset).toBe(
      firstBoundary
    );
    expect(createdExternalItemIds).toEqual([
      `${sourceSessionId}:0`,
      "user-1:0"
    ]);

    fs.appendFileSync(
      transcriptPath,
      line({
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-04-01T00:00:01.000Z",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.4-mini",
          content: [{ type: "text", text: "Pi remembered" }]
        }
      })
    );
    await processPiTranscriptSignal(client, state, signal, env);
    expect(createdExternalItemIds).toEqual([
      `${sourceSessionId}:0`,
      "user-1:0",
      "assistant-1:0"
    ]);
    expect((cursor as { sourceOffset?: unknown } | null)?.sourceOffset).toBe(
      fs.statSync(transcriptPath).size
    );

    fs.truncateSync(transcriptPath, firstBoundary);
    await expect(
      processPiTranscriptSignal(client, state, signal, env)
    ).rejects.toThrow("pi_session_truncated");
  });
});
