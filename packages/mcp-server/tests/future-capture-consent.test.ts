import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryApiError, type MemoryApiClient } from "../src/index.js";
import { processPiTranscriptSignal } from "../src/pi-transcript-watcher.js";
import { journalClaudeTranscript } from "../src/claude-transcript-source.js";
import { transcriptIndex } from "../src/claude-transcript-discovery.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("headless future capture consent", () => {
  it("uploads only post-baseline Pi bytes without changing the source session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-consent-"));
    directories.push(root);
    const transcriptPath = path.join(root, "session.jsonl");
    const cwd = "/tmp/project";
    const previous = `${JSON.stringify({ type: "session", version: 3, id: "original-session", cwd })}\n${JSON.stringify({ content: "PRE_CONSENT_CANARY" })}\n`;
    const later = `${JSON.stringify({ type: "model_change", content: "AFTER_CONSENT_CANARY" })}\n`;
    fs.writeFileSync(transcriptPath, previous + later);
    const baseline = Buffer.byteLength(previous);
    const ensure = vi.fn(async (input: Record<string, unknown>) => ({
      artifact: {
        id: "artifact",
        sessionId: "captured",
        providerCursorOffset: input.journalStartOffset,
        providerCursorLine: input.journalStartLine,
        journalStartOffset: input.journalStartOffset,
        liveStartOffset: input.liveStartOffset,
        liveStartLine: input.liveStartLine
      }
    }));
    const append = vi.fn(
      async (_id: string, input: Record<string, unknown>) => ({
        artifact: {
          id: "artifact",
          sessionId: "captured",
          providerCursorOffset: input.sourceEndOffset,
          providerCursorLine: input.sourceEndLine,
          liveStartOffset: baseline,
          liveStartLine: 2
        }
      })
    );
    const client = {
      lookupConversationSourceArtifact: async () => {
        throw new MemoryApiError("missing", { status: 404 });
      },
      getEffectiveCapturePolicy: async () => ({
        policy: { captureState: "enabled" }
      }),
      ensureConversationSourceArtifact: ensure,
      appendConversationSourceSegment: append,
      getConversationSourceCursor: async () => ({
        cursor: {
          sourceOffset: Buffer.byteLength(previous + later),
          sourceLine: 3
        }
      })
    } as unknown as MemoryApiClient;
    await processPiTranscriptSignal(
      client,
      {
        version: 1,
        activatedAt: new Date().toISOString(),
        baselines: { [transcriptPath]: baseline }
      },
      { sourceSessionId: "original-session", transcriptPath, cwd },
      {
        PI_CODING_AGENT_SESSION_DIR: root,
        KOED_HOME: root,
        KOED_HEADLESS_FUTURE_CAPTURE_ONLY: "1"
      }
    );
    expect(ensure.mock.calls[0]?.[0]).toMatchObject({
      externalSessionId: "original-session",
      journalStartOffset: baseline,
      journalStartLine: 2
    });
    expect(
      Buffer.from(
        String(append.mock.calls[0]?.[1].bytesBase64),
        "base64"
      ).toString()
    ).toBe(later);
  });
  it("journals only Claude source bytes after activation with unchanged source identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-consent-"));
    directories.push(root);
    const transcriptPath = path.join(root, "session.jsonl");
    const previous = `${JSON.stringify({ uuid: "old", timestamp: "2026-10-01T00:00:00Z", content: "PRE_CONSENT_CANARY" })}\n`;
    const later = `${JSON.stringify({ uuid: "new", timestamp: "2026-10-02T00:00:00Z", content: "AFTER_CONSENT_CANARY" })}\n`;
    fs.writeFileSync(transcriptPath, previous + later);
    const ensure = vi.fn(async (input: Record<string, unknown>) => ({
      artifact: {
        id: "artifact",
        sessionId: "captured",
        providerCursorOffset: input.journalStartOffset,
        providerCursorLine: input.journalStartLine,
        journalStartOffset: input.journalStartOffset
      }
    }));
    const append = vi.fn(
      async (_id: string, input: Record<string, unknown>) => ({
        artifact: {
          id: "artifact",
          sessionId: "captured",
          providerCursorOffset: input.sourceEndOffset,
          providerCursorLine: input.sourceEndLine,
          journalStartOffset: Buffer.byteLength(previous)
        }
      })
    );
    const client = {
      ensureConversationSourceArtifact: ensure,
      appendConversationSourceSegment: append
    } as unknown as MemoryApiClient;
    const input = {
      client,
      signal: {
        sourceSessionId: "original-session",
        cwd: root,
        transcriptPath
      },
      transcriptPath,
      index: await transcriptIndex(transcriptPath, "2026-10-01T12:00:00Z"),
      componentId: "main",
      componentRole: "primary" as const,
      parentComponentId: null,
      artifact: null,
      futureCaptureOnly: true
    };
    await journalClaudeTranscript(input);
    expect(ensure.mock.calls[0]?.[0]).toMatchObject({
      externalSessionId: "original-session",
      journalStartOffset: Buffer.byteLength(previous),
      journalStartLine: 1,
      liveStartOffset: Buffer.byteLength(previous)
    });
    expect(
      Buffer.from(
        String(append.mock.calls[0]?.[1].bytesBase64),
        "base64"
      ).toString()
    ).toBe(later);
    append.mockClear();
    for (const prior of [
      { providerCursorOffset: 0, journalStartOffset: 0, liveStartOffset: 0 },
      {
        providerCursorOffset: Buffer.byteLength(previous + later),
        journalStartOffset: 0,
        liveStartOffset: 0
      },
      {
        providerCursorOffset: Buffer.byteLength(previous + later),
        journalStartOffset: Buffer.byteLength(previous),
        liveStartOffset: 0
      }
    ]) {
      await expect(
        journalClaudeTranscript({
          ...input,
          artifact: {
            id: "prior",
            sessionId: "captured",
            ...prior,
            providerCursorLine: 0
          }
        })
      ).rejects.toThrow("claude_source_precedes_capture_consent");
    }
    expect(append).not.toHaveBeenCalled();
  });
});
