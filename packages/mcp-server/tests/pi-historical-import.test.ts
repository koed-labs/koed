import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryApiClient, MemoryApiError } from "../src/index.js";
import { registerPiHistoricalTranscriptSource } from "../src/pi-historical-import.js";

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
