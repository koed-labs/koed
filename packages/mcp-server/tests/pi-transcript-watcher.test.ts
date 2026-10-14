import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { normalizeGitRemoteUrl } from "@koed/shared";
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
const appendPaddingRecords = (
  target: string,
  minimumBytes = 17 * 1024 * 1024
): number => {
  const recordsPerChunk = 256 * 1024;
  const chunk = "{}\n".repeat(recordsPerChunk);
  let bytes = 0;
  let lines = 0;
  while (bytes <= minimumBytes) {
    fs.appendFileSync(target, chunk);
    bytes += Buffer.byteLength(chunk);
    lines += recordsPerChunk;
  }
  return lines;
};

describe("Pi transcript watcher", () => {
  it.each([
    { checkout: "root", futureOnly: false },
    { checkout: "subdirectory", futureOnly: false },
    { checkout: "worktree-one", futureOnly: false },
    { checkout: "worktree-two", futureOnly: false },
    { checkout: "non-git", futureOnly: false },
    { checkout: "unavailable", futureOnly: false },
    { checkout: "root", futureOnly: true }
  ])(
    "preserves shared assignments and durable replay from $checkout (future only: $futureOnly)",
    async ({ checkout, futureOnly }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-watch-"));
      temporaryDirectories.push(root);
      const sessions = path.join(root, "sessions");
      fs.mkdirSync(sessions, { recursive: true });
      const sourceSessionId = randomUUID();
      const transcriptPath = path.join(sessions, `${sourceSessionId}.jsonl`);
      const repo = path.join(root, "repository");
      fs.mkdirSync(repo);
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
      git("init");
      git(
        "remote",
        "add",
        "origin",
        "https://example.test/team/pi-capture.git"
      );
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "Fixture"
      );
      fs.mkdirSync(path.join(repo, "subdirectory"));
      const worktree = path.join(root, checkout);
      if (checkout.startsWith("worktree"))
        git("worktree", "add", "-b", checkout, worktree);
      if (checkout === "non-git") fs.mkdirSync(worktree);
      const cwd =
        checkout === "root"
          ? repo
          : checkout === "subdirectory"
            ? path.join(repo, checkout)
            : worktree;
      const registrations: Record<string, unknown>[] = [];
      const preconsent = line({
        type: "session",
        version: 3,
        id: sourceSessionId,
        cwd
      });
      fs.writeFileSync(
        transcriptPath,
        preconsent +
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
      const segmentContent = new Map<string, string>();
      const uploaded: Buffer[] = [];
      const listedAfterOffsets: number[] = [];
      const createdExternalItemIds: string[] = [];
      let captureEnabled = true;
      let failSuccessor = futureOnly;
      const client = {
        async lookupConversationSourceArtifact() {
          if (!artifact) throw new MemoryApiError("not found", { status: 404 });
          return { artifact };
        },
        async getEffectiveCapturePolicy() {
          return {
            policy: { captureState: captureEnabled ? "enabled" : "disabled" }
          };
        },
        async ensureConversationSourceArtifact(input: Record<string, unknown>) {
          registrations.push(input);
          artifact = {
            id: randomUUID(),
            sourceGenerationId: randomUUID(),
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
          uploaded.push(bytes);
          const segment = {
            id: randomUUID(),
            segmentIndex: segments.length,
            sourceStartOffset: input.expectedProviderOffset,
            sourceEndOffset: input.sourceEndOffset,
            sourceStartLine: input.expectedProviderLine,
            sourceEndLine: input.sourceEndLine,
            plaintextDigest: createHash("sha256").update(bytes).digest("hex"),
            plaintextSize: bytes.length
          };
          segments.push(segment);
          segmentContent.set(segment.id, String(input.bytesBase64));
          artifact = {
            ...artifact,
            id: artifactId,
            providerCursorOffset: input.sourceEndOffset,
            providerCursorLine: input.sourceEndLine
          };
          return { artifact };
        },
        async finalizeConversationSourceArtifact() {
          if (artifact?.closureHash) throw new Error("closure already signed");
          artifact = { ...artifact, closureHash: "a".repeat(64) };
          return { artifact };
        },
        async createConversationSourceSuccessorGeneration(
          _id: string,
          input: Record<string, unknown>
        ) {
          if (failSuccessor) {
            failSuccessor = false;
            throw new Error("interrupted successor creation");
          }
          const rewrite = input.sourceRewrite as Record<string, unknown>;
          artifact = {
            ...artifact,
            id: randomUUID(),
            sourceGenerationId: input.sourceGenerationId,
            closureHash: undefined,
            providerCursorOffset: rewrite.journalStartOffset,
            providerCursorLine: rewrite.journalStartLine,
            journalStartOffset: rewrite.journalStartOffset,
            liveStartOffset: rewrite.liveStartOffset,
            liveStartLine: rewrite.liveStartLine
          };
          cursor = null;
          segments.length = 0;
          return { artifact };
        },
        async listConversationSourceSegments(
          _artifactId: string,
          input: { afterOffset: number; limit: number }
        ) {
          listedAfterOffsets.push(input.afterOffset);
          return {
            segments: segments
              .filter(
                (segment) => Number(segment.sourceEndOffset) > input.afterOffset
              )
              .slice(0, input.limit)
          };
        },
        async getConversationSourceSegmentContent(
          _artifactId: string,
          segmentId: string
        ) {
          return { bytesBase64: segmentContent.get(segmentId) };
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
        PI_CODING_AGENT_SESSION_DIR: sessions,
        MEMORY_PI_TRANSCRIPT_MAX_BYTES_PER_BATCH: "1024",
        KOED_HEADLESS_FUTURE_CAPTURE_ONLY: futureOnly ? "1" : "0"
      };
      const state = {
        version: 1 as const,
        activatedAt: "1970-01-01T00:00:00.000Z",
        baselines: futureOnly
          ? { [fs.realpathSync(transcriptPath)]: Buffer.byteLength(preconsent) }
          : {}
      };
      const signal = { sourceSessionId, transcriptPath, cwd };

      await processPiTranscriptSignal(client, state, signal, env);
      const expectedKind =
        checkout === "non-git"
          ? "non_git_project"
          : checkout === "unavailable"
            ? "unresolved"
            : "portable_repository";
      expect(registrations[0]).toMatchObject({
        sourceSession: {
          sourceRuntime: "pi",
          cwd,
          repositoryIdentity: { kind: expectedKind }
        }
      });
      if (expectedKind === "portable_repository")
        expect(registrations[0]).toMatchObject({
          sourceSession: {
            repositoryIdentity: {
              key: normalizeGitRemoteUrl(
                "https://example.test/team/pi-capture.git"
              ).fingerprint,
              root: fs.realpathSync(
                checkout.startsWith("worktree") ? worktree : repo
              )
            }
          }
        });
      const firstBoundary = fs.statSync(transcriptPath).size;
      expect((cursor as { sourceOffset?: unknown } | null)?.sourceOffset).toBe(
        firstBoundary
      );
      expect(createdExternalItemIds).toEqual([
        ...(futureOnly ? [] : [`${sourceSessionId}:0`]),
        "user-1:0"
      ]);

      captureEnabled = false;
      fs.appendFileSync(
        transcriptPath,
        line({
          type: "message",
          id: "paused-secret",
          message: { role: "user", content: "paused-secret-content" }
        })
      );
      const pausedLines = appendPaddingRecords(transcriptPath);
      await processPiTranscriptSignal(client, state, signal, env);
      fs.appendFileSync(
        transcriptPath,
        line({
          type: "message",
          id: "user-after-pause",
          parentId: "user-1",
          timestamp: "2026-04-01T00:00:10.000Z",
          message: { role: "user", content: "Capture resumed" }
        })
      );
      captureEnabled = true;
      if (futureOnly)
        await expect(
          processPiTranscriptSignal(client, state, signal, env)
        ).rejects.toThrow("interrupted successor creation");
      while (
        (cursor as { sourceOffset?: number } | null)?.sourceOffset !==
        fs.statSync(transcriptPath).size
      )
        await processPiTranscriptSignal(client, state, signal, env);
      expect(createdExternalItemIds).toEqual([
        ...(futureOnly ? [] : [`${sourceSessionId}:0`]),
        "user-1:0",
        "user-after-pause:0"
      ]);
      expect((cursor as { sourceLine?: unknown } | null)?.sourceLine).toBe(
        pausedLines + 4
      );
      if (futureOnly) {
        expect(Buffer.concat(uploaded).toString()).not.toContain(
          "paused-secret-content"
        );
        expect(Buffer.concat(uploaded).toString()).not.toContain(
          '"type":"session"'
        );
      }
      const restartedState = JSON.parse(JSON.stringify(state)) as typeof state;

      fs.appendFileSync(
        transcriptPath,
        Array.from({ length: 8 }, (_, index) =>
          line({
            type: "message",
            id: `assistant-${index + 1}`,
            parentId: index === 0 ? "user-1" : `assistant-${index}`,
            timestamp: `2026-04-01T00:00:0${index + 1}.000Z`,
            message: {
              role: "assistant",
              provider: "openai-codex",
              model: "gpt-5.4-mini",
              content: [{ type: "text", text: "x".repeat(256) }]
            }
          })
        ).join("")
      );
      listedAfterOffsets.length = 0;
      await processPiTranscriptSignal(client, state, signal, env);
      expect(listedAfterOffsets).not.toContain(0);
      expect(
        (cursor as { sourceOffset?: number } | null)?.sourceOffset
      ).toBeLessThan(fs.statSync(transcriptPath).size);
      while (
        (cursor as { sourceOffset?: number } | null)?.sourceOffset !==
        fs.statSync(transcriptPath).size
      )
        await processPiTranscriptSignal(client, restartedState, signal, env);
      expect(createdExternalItemIds).toEqual([
        ...(futureOnly ? [] : [`${sourceSessionId}:0`]),
        "user-1:0",
        "user-after-pause:0",
        ...Array.from({ length: 8 }, (_, index) => `assistant-${index + 1}:0`)
      ]);
      expect((cursor as { sourceOffset?: unknown } | null)?.sourceOffset).toBe(
        fs.statSync(transcriptPath).size
      );

      fs.truncateSync(transcriptPath, firstBoundary);
      await expect(
        processPiTranscriptSignal(client, state, signal, env)
      ).rejects.toThrow("pi_session_truncated");
    }
  );

  it("streams a large pre-activation baseline when opening live capture", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-baseline-"));
    temporaryDirectories.push(root);
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const sourceSessionId = randomUUID();
    const transcriptPath = path.join(sessions, `${sourceSessionId}.jsonl`);
    const cwd = "/tmp/pi-large-baseline";
    fs.writeFileSync(
      transcriptPath,
      line({ type: "session", version: 3, id: sourceSessionId, cwd })
    );
    const baselineLines = appendPaddingRecords(transcriptPath);
    const baseline = fs.statSync(transcriptPath).size;
    fs.appendFileSync(transcriptPath, line({ type: "model_change" }));
    let artifact: Record<string, unknown> | null = null;
    let ensuredLiveStartLine: unknown;
    const boundary = fs.statSync(transcriptPath).size;
    const client = {
      async lookupConversationSourceArtifact() {
        throw new MemoryApiError("not found", { status: 404 });
      },
      async getEffectiveCapturePolicy() {
        return { policy: { captureState: "enabled" } };
      },
      async ensureConversationSourceArtifact(input: Record<string, unknown>) {
        ensuredLiveStartLine = input.liveStartLine;
        artifact = {
          id: randomUUID(),
          sessionId: randomUUID(),
          providerCursorOffset: 0,
          providerCursorLine: 0,
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
        artifact = {
          ...artifact,
          id: artifactId,
          providerCursorOffset: input.sourceEndOffset,
          providerCursorLine: input.sourceEndLine
        };
        return { artifact };
      },
      async getConversationSourceCursor() {
        return {
          cursor: { sourceOffset: boundary, sourceLine: baselineLines + 2 }
        };
      }
    } as unknown as MemoryApiClient;

    await processPiTranscriptSignal(
      client,
      {
        version: 1,
        activatedAt: new Date(Date.now() + 60_000).toISOString(),
        baselines: { [fs.realpathSync(transcriptPath)]: baseline }
      },
      { sourceSessionId, transcriptPath, cwd },
      {
        KOED_HOME: path.join(root, "koed"),
        PI_CODING_AGENT_SESSION_DIR: sessions
      }
    );

    expect(ensuredLiveStartLine).toBe(baselineLines + 1);
  });
});
