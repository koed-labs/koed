import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, MemoryApiError } from "../src/index.js";
import {
  buildRawTranscriptConversationItems,
  captureTranscriptPathForPayload,
  emptyHookBreakerState,
  effectiveCaptureContext,
  extractTranscriptSessionMetadata,
  filterTranscriptItemsAlreadyCapturedFromImmediatePrompts,
  hookApiRequestTimeoutMs,
  hookBreakerEntryCanRetryHealth,
  hookBreakerEntryIsOpen,
  hookBreakerKey,
  isRetryableTranscriptCatchupError,
  loadConfig,
  parseForegroundTranscriptFileRecords,
  parseTranscriptFileRecords,
  parseTranscriptText,
  rawItemBatches,
  rawItemsForCapture,
  rawItemRequestChunks,
  recordHookBreakerFailure,
  runForegroundCapturePass,
  selectRawConversationItemsForHook,
  selectCaptureItems,
  shouldReadTranscriptForHook,
  stateScopeKey,
  transcriptCatchupApiRequestTimeoutMs,
  transcriptCatchupRetryDelayMs
} from "../src/capture-hook.js";

describe("Codex capture hook transcript parsing", () => {
  it("uses a short hook API timeout without changing the MCP default timeout", () => {
    const priorApiTimeout = process.env.MEMORY_API_REQUEST_TIMEOUT_MS;
    const priorHookTimeout = process.env.MEMORY_HOOK_API_REQUEST_TIMEOUT_MS;
    const priorCatchupTimeout =
      process.env.MEMORY_TRANSCRIPT_CATCHUP_API_REQUEST_TIMEOUT_MS;
    process.env.MEMORY_API_REQUEST_TIMEOUT_MS = "42000";
    delete process.env.MEMORY_HOOK_API_REQUEST_TIMEOUT_MS;
    delete process.env.MEMORY_TRANSCRIPT_CATCHUP_API_REQUEST_TIMEOUT_MS;
    try {
      expect(defaultConfig().requestTimeoutMs).toBe(42000);
      expect(hookApiRequestTimeoutMs()).toBe(1500);
      expect(transcriptCatchupApiRequestTimeoutMs()).toBe(60000);
      expect(loadConfig(undefined, "foreground").requestTimeoutMs).toBe(1500);
      expect(loadConfig(undefined, "catchup").requestTimeoutMs).toBe(60000);

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-hook-config-"));
      const configPath = path.join(dir, "config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          apiUrl: "http://127.0.0.1:3000",
          requestTimeoutMs: 1500
        })
      );
      expect(loadConfig(configPath, "foreground").requestTimeoutMs).toBe(1500);
      expect(loadConfig(configPath, "catchup").requestTimeoutMs).toBe(60000);

      const catchupConfigPath = path.join(dir, "catchup-config.json");
      fs.writeFileSync(
        catchupConfigPath,
        JSON.stringify({
          apiUrl: "http://127.0.0.1:3000",
          requestTimeoutMs: 1500,
          catchupRequestTimeoutMs: 45000
        })
      );
      expect(loadConfig(catchupConfigPath, "catchup").requestTimeoutMs).toBe(
        45000
      );
    } finally {
      if (priorApiTimeout === undefined) {
        delete process.env.MEMORY_API_REQUEST_TIMEOUT_MS;
      } else {
        process.env.MEMORY_API_REQUEST_TIMEOUT_MS = priorApiTimeout;
      }
      if (priorHookTimeout === undefined) {
        delete process.env.MEMORY_HOOK_API_REQUEST_TIMEOUT_MS;
      } else {
        process.env.MEMORY_HOOK_API_REQUEST_TIMEOUT_MS = priorHookTimeout;
      }
      if (priorCatchupTimeout === undefined) {
        delete process.env.MEMORY_TRANSCRIPT_CATCHUP_API_REQUEST_TIMEOUT_MS;
      } else {
        process.env.MEMORY_TRANSCRIPT_CATCHUP_API_REQUEST_TIMEOUT_MS =
          priorCatchupTimeout;
      }
    }
  });

  it("retries only transient transcript catch-up API failures", () => {
    expect(
      isRetryableTranscriptCatchupError(
        new MemoryApiError("Could not reach memory API")
      )
    ).toBe(true);
    expect(
      isRetryableTranscriptCatchupError(
        new MemoryApiError("server restart", { status: 503 })
      )
    ).toBe(true);
    expect(
      isRetryableTranscriptCatchupError(
        new MemoryApiError("rate limited", { status: 429 })
      )
    ).toBe(true);
    expect(
      isRetryableTranscriptCatchupError(
        new MemoryApiError("bad token", { status: 401 })
      )
    ).toBe(false);
    expect(
      isRetryableTranscriptCatchupError(
        new MemoryApiError("capture forbidden", { status: 403 })
      )
    ).toBe(false);
  });

  it("bounds transcript catch-up retry backoff", () => {
    process.env.MEMORY_TRANSCRIPT_CATCHUP_RETRY_INITIAL_DELAY_MS = "100";
    process.env.MEMORY_TRANSCRIPT_CATCHUP_RETRY_MAX_DELAY_MS = "450";
    try {
      expect(transcriptCatchupRetryDelayMs(0)).toBe(100);
      expect(transcriptCatchupRetryDelayMs(1)).toBe(200);
      expect(transcriptCatchupRetryDelayMs(2)).toBe(400);
      expect(transcriptCatchupRetryDelayMs(3)).toBe(450);
      expect(transcriptCatchupRetryDelayMs(100)).toBe(450);
    } finally {
      delete process.env.MEMORY_TRANSCRIPT_CATCHUP_RETRY_INITIAL_DELAY_MS;
      delete process.env.MEMORY_TRANSCRIPT_CATCHUP_RETRY_MAX_DELAY_MS;
    }
  });

  it("opens the hook breaker after three retryable foreground failures", () => {
    const state = emptyHookBreakerState();
    const key = "breaker-key";
    recordHookBreakerFailure(state, key, new MemoryApiError("timeout"), 1000);
    expect(hookBreakerEntryIsOpen(state.foregroundFailures[key], 1001)).toBe(
      false
    );
    recordHookBreakerFailure(state, key, new MemoryApiError("timeout"), 2000);
    expect(hookBreakerEntryIsOpen(state.foregroundFailures[key], 2001)).toBe(
      false
    );
    const entry = recordHookBreakerFailure(
      state,
      key,
      new MemoryApiError("timeout"),
      3000
    );

    expect(entry).toMatchObject({
      consecutiveFailures: 3,
      openedAt: 3000,
      retryAfter: 63000
    });
    expect(hookBreakerEntryIsOpen(entry, 3001)).toBe(true);
    expect(hookBreakerEntryCanRetryHealth(entry, 63000)).toBe(true);
  });

  it("short-circuits foreground capture while the hook breaker is open", async () => {
    const priorStatePath = process.env.MEMORY_HOOK_STATE_PATH;
    const priorToken = process.env.MEMORY_API_TOKEN;
    const priorUrl = process.env.MEMORY_API_URL;
    const priorCatchup = process.env.MEMORY_HOOK_TRIGGER_TRANSCRIPT_CATCHUP;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-hook-state-"));
    const statePath = path.join(dir, "hook-state.json");
    process.env.MEMORY_HOOK_STATE_PATH = statePath;
    process.env.MEMORY_API_TOKEN = "token-open";
    process.env.MEMORY_API_URL = "http://127.0.0.1:1";
    process.env.MEMORY_HOOK_TRIGGER_TRANSCRIPT_CATCHUP = "false";
    const key = hookBreakerKey({
      apiUrl: process.env.MEMORY_API_URL,
      apiToken: process.env.MEMORY_API_TOKEN
    });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        foregroundFailures: {
          [key]: {
            consecutiveFailures: 3,
            openedAt: Date.now(),
            retryAfter: Date.now() + 60_000
          }
        }
      })
    );
    const runPass = vi.fn();
    try {
      const result = await runForegroundCapturePass({
        payload: {
          hook_event_name: "PostToolUse",
          session_id: "session-open",
          transcript_path: path.join(dir, "transcript.jsonl")
        },
        runPass
      });

      expect(runPass).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        rawItemsStored: 0,
        transcriptBacklogRemaining: true,
        transcriptCheckpointAdvanced: false
      });
    } finally {
      if (priorStatePath === undefined) {
        delete process.env.MEMORY_HOOK_STATE_PATH;
      } else {
        process.env.MEMORY_HOOK_STATE_PATH = priorStatePath;
      }
      if (priorToken === undefined) {
        delete process.env.MEMORY_API_TOKEN;
      } else {
        process.env.MEMORY_API_TOKEN = priorToken;
      }
      if (priorUrl === undefined) {
        delete process.env.MEMORY_API_URL;
      } else {
        process.env.MEMORY_API_URL = priorUrl;
      }
      if (priorCatchup === undefined) {
        delete process.env.MEMORY_HOOK_TRIGGER_TRANSCRIPT_CATCHUP;
      } else {
        process.env.MEMORY_HOOK_TRIGGER_TRANSCRIPT_CATCHUP = priorCatchup;
      }
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("uses a successful access check to reset the hook breaker after cooldown", async () => {
    const priorStatePath = process.env.MEMORY_HOOK_STATE_PATH;
    const priorToken = process.env.MEMORY_API_TOKEN;
    const priorUrl = process.env.MEMORY_API_URL;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-hook-state-"));
    const statePath = path.join(dir, "hook-state.json");
    process.env.MEMORY_HOOK_STATE_PATH = statePath;
    process.env.MEMORY_API_TOKEN = "token-reset";
    process.env.MEMORY_API_URL = "http://127.0.0.1:1";
    const key = hookBreakerKey({
      apiUrl: process.env.MEMORY_API_URL,
      apiToken: process.env.MEMORY_API_TOKEN
    });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        foregroundFailures: {
          [key]: {
            consecutiveFailures: 3,
            openedAt: Date.now() - 120_000,
            retryAfter: Date.now() - 1
          }
        }
      })
    );
    const runPass = vi.fn(async () => ({
      rawItemsStored: 1,
      transcriptBacklogRemaining: false,
      transcriptCheckpointAdvanced: true
    }));
    try {
      const result = await runForegroundCapturePass({
        payload: { hook_event_name: "UserPromptSubmit", session_id: "s" },
        runPass,
        healthCheck: async () => ({
          ok: true,
          auth: "bearer_api_token",
          user: { id: "user-1", email: "u@example.com" },
          canWritePersonal: true
        })
      });

      expect(runPass).toHaveBeenCalledOnce();
      expect(result.rawItemsStored).toBe(1);
      const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
        foregroundFailures?: Record<string, unknown>;
      };
      expect(state.foregroundFailures?.[key]).toBeUndefined();
    } finally {
      if (priorStatePath === undefined) {
        delete process.env.MEMORY_HOOK_STATE_PATH;
      } else {
        process.env.MEMORY_HOOK_STATE_PATH = priorStatePath;
      }
      if (priorToken === undefined) {
        delete process.env.MEMORY_API_TOKEN;
      } else {
        process.env.MEMORY_API_TOKEN = priorToken;
      }
      if (priorUrl === undefined) {
        delete process.env.MEMORY_API_URL;
      } else {
        process.env.MEMORY_API_URL = priorUrl;
      }
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("does not open the hook breaker for non-retryable foreground failures", async () => {
    const priorStatePath = process.env.MEMORY_HOOK_STATE_PATH;
    const priorToken = process.env.MEMORY_API_TOKEN;
    const priorUrl = process.env.MEMORY_API_URL;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-hook-state-"));
    const statePath = path.join(dir, "hook-state.json");
    process.env.MEMORY_HOOK_STATE_PATH = statePath;
    process.env.MEMORY_API_TOKEN = "token-nonretryable";
    process.env.MEMORY_API_URL = "http://127.0.0.1:1";
    const key = hookBreakerKey({
      apiUrl: process.env.MEMORY_API_URL,
      apiToken: process.env.MEMORY_API_TOKEN
    });
    const runPass = vi.fn(async () => {
      throw new MemoryApiError("bad token", { status: 401 });
    });
    try {
      await expect(
        runForegroundCapturePass({
          payload: { hook_event_name: "UserPromptSubmit", session_id: "s" },
          runPass
        })
      ).rejects.toThrow("bad token");
      const state = fs.existsSync(statePath)
        ? (JSON.parse(fs.readFileSync(statePath, "utf8")) as {
            foregroundFailures?: Record<string, unknown>;
          })
        : { foregroundFailures: {} };
      expect(state.foregroundFailures?.[key]).toBeUndefined();
    } finally {
      if (priorStatePath === undefined) {
        delete process.env.MEMORY_HOOK_STATE_PATH;
      } else {
        process.env.MEMORY_HOOK_STATE_PATH = priorStatePath;
      }
      if (priorToken === undefined) {
        delete process.env.MEMORY_API_TOKEN;
      } else {
        process.env.MEMORY_API_TOKEN = priorToken;
      }
      if (priorUrl === undefined) {
        delete process.env.MEMORY_API_URL;
      } else {
        process.env.MEMORY_API_URL = priorUrl;
      }
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("keeps transcript checkpoints stable when the API token changes", () => {
    const workspaceId = "/home/mark/code/koed/koed-self-hosted";

    expect(
      stateScopeKey(
        { apiUrl: "http://localhost:3000", apiToken: "old-token" },
        workspaceId,
        "user-1"
      )
    ).toBe(
      stateScopeKey(
        { apiUrl: "http://localhost:3000/", apiToken: "new-token" },
        workspaceId,
        "user-1"
      )
    );
  });

  it("keeps transcript checkpoints separate for different API token owners", () => {
    const workspaceId = "/home/mark/code/koed/koed-self-hosted";

    expect(
      stateScopeKey(
        { apiUrl: "http://localhost:3000", apiToken: "token-a" },
        workspaceId,
        "user-1"
      )
    ).not.toBe(
      stateScopeKey(
        { apiUrl: "http://localhost:3000", apiToken: "token-b" },
        workspaceId,
        "user-2"
      )
    );
  });

  it("carries transcript event time into raw conversation items", () => {
    const items = buildRawTranscriptConversationItems({
      records: [
        {
          type: "response_item",
          timestamp: "2026-05-01T10:00:00.000Z",
          payload: {
            id: "msg-1",
            type: "message",
            role: "user",
            content: "Older transcript prompt"
          }
        }
      ],
      effectiveContext: effectiveCaptureContext({
        hook_event_name: "Stop",
        cwd: "/repo",
        session_id: "session-1"
      }),
      payload: { hook_event_name: "Stop", cwd: "/repo", session_id: "s" }
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      eventTime: "2026-05-01T10:00:00.000Z",
      sourceSequence: 0
    });
  });

  it("uses stable raw transcript idempotency across foreground and catch-up offsets", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const line = (message: string) =>
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message
        }
      })}\n`;
    fs.writeFileSync(
      transcriptPath,
      [
        line("first checkpoint line"),
        line("same duplicate message"),
        line("same duplicate message")
      ].join("")
    );
    const firstLineBytes = Buffer.byteLength(line("first checkpoint line"));
    const context = effectiveCaptureContext({
      hook_event_name: "PostToolUse",
      cwd: "/repo",
      session_id: "session-1"
    });
    const payload = {
      hook_event_name: "PostToolUse" as const,
      cwd: "/repo",
      session_id: "session-1"
    };

    try {
      const state = {
        seen: {},
        rawSeen: {},
        transcriptOffsets: {
          [`scope:${transcriptPath}`]: {
            offset: firstLineBytes,
            lineCount: 1,
            size: firstLineBytes
          }
        }
      };
      const foreground = parseForegroundTranscriptFileRecords({
        transcriptPath,
        state,
        stateScope: "scope",
        foregroundMaxBytes: Buffer.byteLength(line("same duplicate message"))
      });
      const catchup = parseTranscriptFileRecords({
        transcriptPath,
        state,
        stateScope: "scope",
        maxBytes: Number.MAX_SAFE_INTEGER
      });
      const foregroundItems = buildRawTranscriptConversationItems({
        records: foreground.records,
        indexOffset: foreground.indexOffset,
        effectiveContext: context,
        transcriptPath,
        payload
      });
      const catchupItems = buildRawTranscriptConversationItems({
        records: catchup.records,
        indexOffset: catchup.indexOffset,
        effectiveContext: context,
        transcriptPath,
        payload
      });

      expect(foregroundItems).toHaveLength(1);
      expect(catchupItems).toHaveLength(2);
      expect(catchupItems[0]!.idempotencyKey).not.toBe(
        catchupItems[1]!.idempotencyKey
      );
      expect(foregroundItems[0]!.idempotencyKey).toBe(
        catchupItems[1]!.idempotencyKey
      );
      expect(foregroundItems[0]!.sourceSequence).toBeLessThan(10);
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("checkpoints an existing transcript on first contact instead of replaying history", () => {
    process.env.MEMORY_HOOK_TRANSCRIPT_TAIL_BYTES = "140";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const line = (message: string) =>
      `${JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message }
      })}\n`;
    fs.writeFileSync(
      transcriptPath,
      `${line("old message one")}${line("old message two")}`
    );
    const size = fs.statSync(transcriptPath).size;

    try {
      const result = parseTranscriptFileRecords({
        transcriptPath,
        state: { seen: {}, rawSeen: {}, transcriptOffsets: {} },
        stateScope: "scope"
      });

      expect(result.records).toEqual([]);
      expect(result.indexOffset).toBe(0);
      expect(result.checkpoint).toMatchObject({
        offset: size,
        lineCount: 0,
        size
      });
    } finally {
      delete process.env.MEMORY_HOOK_TRANSCRIPT_TAIL_BYTES;
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("does not scan old transcript content when checkpointing first contact", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "already captured elsewhere"
        }
      })}\n`
    );
    const openSpy = vi.spyOn(fs, "openSync");

    try {
      const result = parseTranscriptFileRecords({
        transcriptPath,
        state: { seen: {}, rawSeen: {}, transcriptOffsets: {} },
        stateScope: "scope"
      });

      expect(result.records).toEqual([]);
      expect(result.checkpoint?.offset).toBe(fs.statSync(transcriptPath).size);
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("reads only appended transcript records after the initial checkpoint", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const line = (message: string) =>
      `${JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message }
      })}\n`;
    fs.writeFileSync(transcriptPath, line("old message"));
    const initialSize = fs.statSync(transcriptPath).size;
    fs.appendFileSync(transcriptPath, line("new message"));
    const finalSize = fs.statSync(transcriptPath).size;

    try {
      const result = parseTranscriptFileRecords({
        transcriptPath,
        state: {
          seen: {},
          rawSeen: {},
          transcriptOffsets: {
            [`scope:${transcriptPath}`]: {
              offset: initialSize,
              lineCount: 1,
              size: initialSize
            }
          }
        },
        stateScope: "scope"
      });

      expect(result.records).toHaveLength(1);
      expect(JSON.stringify(result.records[0])).toContain("new message");
      expect(result.indexOffset).toBe(1);
      expect(result.checkpoint).toMatchObject({
        offset: finalSize,
        lineCount: 2,
        size: finalSize
      });
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("continues from the prior transcript checkpoint without jumping to the tail", () => {
    process.env.MEMORY_HOOK_TRANSCRIPT_TAIL_BYTES = "140";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const line = (message: string) =>
      `${JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message }
      })}\n`;
    fs.writeFileSync(
      transcriptPath,
      `${line("first message")}${line("second message")}${line("third message")}`
    );
    const size = fs.statSync(transcriptPath).size;

    try {
      const result = parseTranscriptFileRecords({
        transcriptPath,
        state: {
          seen: {},
          rawSeen: {},
          transcriptOffsets: {
            [`scope:${transcriptPath}`]: {
              offset: 0,
              lineCount: 0,
              size: Math.floor(size / 2)
            }
          }
        },
        stateScope: "scope"
      });

      expect(JSON.stringify(result.records[0])).toContain("first message");
      expect(result.checkpoint?.offset).toBeGreaterThan(0);
      expect(result.checkpoint?.offset).toBeLessThan(size);
    } finally {
      delete process.env.MEMORY_HOOK_TRANSCRIPT_TAIL_BYTES;
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("lets foreground hooks read the latest tail while leaving backlog checkpointing to background catch-up", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const line = (message: string) =>
      `${JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message }
      })}\n`;
    fs.writeFileSync(
      transcriptPath,
      [
        line("first backlog message"),
        line("second backlog message"),
        line("third backlog message"),
        line("latest foreground message")
      ].join("")
    );
    const firstLineBytes = Buffer.byteLength(line("first backlog message"));

    try {
      const result = parseForegroundTranscriptFileRecords({
        transcriptPath,
        state: {
          seen: {},
          rawSeen: {},
          transcriptOffsets: {
            [`scope:${transcriptPath}`]: {
              offset: firstLineBytes,
              lineCount: 1,
              size: firstLineBytes
            }
          }
        },
        stateScope: "scope",
        foregroundMaxBytes: Buffer.byteLength(line("latest foreground message"))
      });

      expect(result.backgroundCatchupNeeded).toBe(true);
      expect(result.checkpoint).toBeUndefined();
      expect(JSON.stringify(result.records)).toContain(
        "latest foreground message"
      );
      expect(JSON.stringify(result.records)).not.toContain(
        "second backlog message"
      );

      const background = parseTranscriptFileRecords({
        transcriptPath,
        state: {
          seen: {},
          rawSeen: {},
          transcriptOffsets: {
            [`scope:${transcriptPath}`]: {
              offset: firstLineBytes,
              lineCount: 1,
              size: firstLineBytes
            }
          }
        },
        stateScope: "scope",
        maxBytes: Buffer.byteLength(line("second backlog message"))
      });

      expect(JSON.stringify(background.records)).toContain(
        "second backlog message"
      );
      expect(JSON.stringify(background.records)).not.toContain(
        "latest foreground message"
      );
      expect(background.checkpoint?.offset).toBeGreaterThan(firstLineBytes);
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("labels main Codex agent messages as agent", () => {
    const items = parseTranscriptText(
      JSON.stringify([
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Fix the backend capture path"
          }
        },
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "I will inspect the graph API."
          }
        }
      ])
    );

    expect(items).toMatchObject([
      { actor: "user", eventType: "codex_transcript_user" },
      { actor: "agent", eventType: "codex_transcript_agent" }
    ]);
  });

  it("uses child session metadata to label subagent conversation actors", () => {
    const records = [
      {
        type: "session_meta",
        payload: {
          id: "child-session",
          parentSessionId: "parent-session",
          parentThreadId: "parent-thread"
        }
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Review the capture hook for tool calls."
        }
      },
      {
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "The hook drops response_item function calls."
        }
      }
    ];

    const context = extractTranscriptSessionMetadata(records);
    const items = parseTranscriptText(JSON.stringify(records));

    expect(context).toMatchObject({
      threadKind: "subagent",
      parentThreadId: "parent-thread",
      parentSessionId: "parent-session"
    });
    expect(items).toMatchObject([
      {
        actor: "agent",
        metadata: {
          threadKind: "subagent",
          parentThreadId: "parent-thread"
        }
      },
      {
        actor: "subagent",
        metadata: {
          threadKind: "subagent",
          parentThreadId: "parent-thread"
        }
      }
    ]);
  });

  it("uses Codex subagent session metadata to link child threads", () => {
    const records = [
      {
        type: "session_meta",
        payload: {
          id: "child-session",
          thread_source: "subagent",
          agent_nickname: "Reviewer",
          agent_role: "code-reviewer",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-thread",
                depth: 1,
                agent_role: "worker_gpt55_high"
              }
            }
          }
        }
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Review the backend branch."
        }
      }
    ];

    const context = extractTranscriptSessionMetadata(records);
    const items = parseTranscriptText(JSON.stringify(records));

    expect(context).toMatchObject({
      threadKind: "subagent",
      parentThreadId: "parent-thread",
      transcriptSessionId: "child-session",
      transcriptMetadata: {
        id: "child-session",
        thread_source: "subagent",
        agent_nickname: "Reviewer",
        agent_role: "code-reviewer"
      }
    });
    expect(items[0]).toMatchObject({
      actor: "agent",
      metadata: {
        threadKind: "subagent",
        parentThreadId: "parent-thread"
      }
    });
  });

  it("uses the child transcript id as the effective subagent external session", () => {
    const records = [
      {
        type: "session_meta",
        payload: {
          id: "child-thread",
          thread_source: "subagent",
          agent_nickname: "Reviewer",
          agent_role: "code-reviewer",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-thread"
              }
            }
          }
        }
      }
    ];

    const transcriptContext = extractTranscriptSessionMetadata(records);
    const effectiveContext = effectiveCaptureContext(
      {
        session_id: "parent-thread",
        agent_id: "agent-thread-from-hook",
        agent_type: "review",
        hook_event_name: "SubagentStop",
        transcript_path: "/tmp/parent.jsonl",
        agent_transcript_path: "/tmp/child.jsonl"
      },
      transcriptContext
    );

    expect(effectiveContext).toMatchObject({
      externalSessionId: "child-thread",
      parentThreadId: "parent-thread",
      transcriptPath: "/tmp/child.jsonl",
      parentTranscriptPath: "/tmp/parent.jsonl",
      agentId: "agent-thread-from-hook",
      agentType: "review",
      isSubagent: true
    });

    expect(
      selectCaptureItems(
        [],
        {
          session_id: "parent-thread",
          agent_id: "agent-thread-from-hook",
          hook_event_name: "UserPromptSubmit",
          prompt: "Review this change"
        },
        effectiveContext
      )
    ).toMatchObject([
      {
        actor: "agent",
        metadata: {
          threadKind: "subagent",
          externalSessionId: "child-thread",
          parentThreadId: "parent-thread"
        }
      }
    ]);
  });

  it("falls back to hook agent_id for subagent capture when metadata has no id", () => {
    const effectiveContext = effectiveCaptureContext(
      {
        session_id: "parent-thread",
        agent_id: "child-thread-from-hook",
        hook_event_name: "SubagentStart"
      },
      {
        threadKind: "subagent",
        parentThreadId: "parent-thread",
        transcriptMetadata: {}
      }
    );

    expect(effectiveContext).toMatchObject({
      externalSessionId: "child-thread-from-hook",
      parentThreadId: "parent-thread",
      isSubagent: true
    });
  });

  it("does not preserve a self-referential parent link", () => {
    const effectiveContext = effectiveCaptureContext(
      {
        session_id: "parent-thread",
        agent_id: "child-thread",
        hook_event_name: "SubagentStop"
      },
      {
        threadKind: "subagent",
        transcriptSessionId: "child-thread",
        parentThreadId: "child-thread",
        transcriptMetadata: {}
      }
    );

    expect(effectiveContext).toMatchObject({
      externalSessionId: "child-thread",
      parentThreadId: "parent-thread"
    });
  });

  it("uses agent_transcript_path for SubagentStop transcript parsing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-hook-"));
    const parentTranscriptPath = path.join(dir, "parent.jsonl");
    const agentTranscriptPath = path.join(dir, "child.jsonl");
    fs.writeFileSync(
      parentTranscriptPath,
      `${JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "Parent answer" }
      })}\n`
    );
    fs.writeFileSync(
      agentTranscriptPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "child-thread",
            thread_source: "subagent",
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: "parent-thread"
                }
              }
            }
          }
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Child final answer"
          }
        })
      ].join("\n")
    );

    const payload = {
      session_id: "parent-thread",
      agent_id: "child-thread",
      hook_event_name: "SubagentStop",
      transcript_path: parentTranscriptPath,
      agent_transcript_path: agentTranscriptPath
    };
    const selectedPath = captureTranscriptPathForPayload(payload);
    const items = parseTranscriptText(fs.readFileSync(selectedPath!, "utf8"));
    const transcriptContext = extractTranscriptSessionMetadata([
      {
        type: "session_meta",
        payload: {
          id: "child-thread",
          thread_source: "subagent",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-thread"
              }
            }
          }
        }
      }
    ]);
    const effectiveContext = effectiveCaptureContext(
      payload,
      transcriptContext
    );

    expect(selectedPath).toBe(agentTranscriptPath);
    expect(items).toMatchObject([
      {
        actor: "subagent",
        content: "Child final answer",
        metadata: {
          threadKind: "subagent",
          parentThreadId: "parent-thread",
          transcriptSessionId: "child-thread"
        }
      }
    ]);
    expect(effectiveContext).toMatchObject({
      externalSessionId: "child-thread",
      parentThreadId: "parent-thread"
    });
  });

  it("captures response_item function calls and outputs as tool events", () => {
    const items = parseTranscriptText(
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "exec_command",
            arguments: { cmd: "pnpm test" },
            status: "completed"
          }
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "fco_1",
            call_id: "call_1",
            output: "Tests passed"
          }
        })
      ].join("\n")
    );

    expect(items).toMatchObject([
      {
        actor: "tool",
        eventType: "codex_transcript_tool_call",
        metadata: {
          transcriptType: "function_call",
          callId: "call_1",
          toolName: "exec_command",
          toolEventKind: "function_call",
          status: "completed",
          toolCall: {
            kind: "call",
            id: "call_1",
            name: "exec_command",
            input: { cmd: "pnpm test" },
            status: "completed"
          }
        }
      },
      {
        actor: "tool",
        eventType: "codex_transcript_tool_output",
        metadata: {
          transcriptType: "function_call_output",
          callId: "call_1",
          toolEventKind: "function_call_output",
          toolCall: {
            kind: "output",
            id: "call_1",
            output: "Tests passed"
          }
        }
      }
    ]);
    expect(items[0]?.content).toContain("Tool call: exec_command");
    expect(items[1]?.content).toContain("Tests passed");
  });

  it("captures custom tool calls and outputs as structured tool events", () => {
    const items = parseTranscriptText(
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            id: "ctc_1",
            call_id: "call_patch",
            name: "apply_patch",
            input: "*** Begin Patch\n*** End Patch",
            status: "completed"
          }
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            id: "ctco_1",
            call_id: "call_patch",
            output: '{"output":"Success. Updated files"}'
          }
        })
      ].join("\n")
    );

    expect(items).toMatchObject([
      {
        actor: "tool",
        eventType: "codex_transcript_tool_call",
        metadata: {
          transcriptType: "custom_tool_call",
          toolName: "apply_patch",
          toolCallId: "call_patch",
          toolCall: {
            kind: "call",
            id: "call_patch",
            name: "apply_patch",
            input: "*** Begin Patch\n*** End Patch"
          }
        }
      },
      {
        actor: "tool",
        eventType: "codex_transcript_tool_output",
        metadata: {
          transcriptType: "custom_tool_call_output",
          toolCallId: "call_patch",
          toolCall: {
            kind: "output",
            id: "call_patch",
            output: '{"output":"Success. Updated files"}'
          }
        }
      }
    ]);
    expect(items[0]?.content).toContain("Tool call: apply_patch");
    expect(items[1]?.content).toContain("Success. Updated files");
  });

  it("keeps fallback tool events when transcript messages were found", () => {
    const transcriptItems = parseTranscriptText(
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "Done" }
      })
    );

    const items = selectCaptureItems(transcriptItems, {
      session_id: "session-a",
      hook_event_name: "PostToolUse",
      tool_use_id: "toolu-1",
      tool_name: "exec_command",
      tool_input: { cmd: "git status" },
      tool_response: "clean"
    });

    expect(items.map((item) => item.actor)).toEqual(["agent", "tool"]);
    expect(items[1]).toMatchObject({
      eventType: "codex_tool_result",
      metadata: {
        toolName: "exec_command",
        toolUseId: "toolu-1",
        toolCall: {
          kind: "hook",
          id: "toolu-1",
          name: "exec_command",
          input: { cmd: "git status" },
          output: "clean"
        }
      }
    });
    expect(items[1]?.content).toContain("Tool result: exec_command");
  });

  it("reads the transcript tail on PostToolUse so agent commentary is not delayed until Stop", () => {
    expect(
      shouldReadTranscriptForHook({
        hook_event_name: "PostToolUse",
        tool_name: "exec_command"
      })
    ).toBe(true);
  });

  it("reads transcript checkpoints on lifecycle hooks that can start or advance capture", () => {
    for (const hook_event_name of [
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
      "SubagentStart",
      "SubagentStop"
    ]) {
      expect(shouldReadTranscriptForHook({ hook_event_name })).toBe(true);
    }
  });

  it("uses fallback hook payloads when no transcript messages are available", () => {
    const items = selectCaptureItems([], {
      session_id: "session-b",
      hook_event_name: "UserPromptSubmit",
      prompt: "Capture this prompt"
    });

    expect(items).toMatchObject([
      {
        actor: "user",
        eventType: "codex_user_prompt",
        content: "Capture this prompt",
        metadata: { externalSessionId: "session-b" }
      }
    ]);
  });

  it("keeps UserPromptSubmit hook payloads when transcript backlog exists without the new prompt", () => {
    const effectiveContext = effectiveCaptureContext({
      session_id: "session-userprompt-backlog",
      turn_id: "turn-1",
      hook_event_name: "UserPromptSubmit",
      prompt: "Immediate prompt from hook"
    });
    const items = selectRawConversationItemsForHook({
      transcriptRecords: [
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Older unread transcript backlog"
          }
        }
      ],
      payload: {
        session_id: "session-userprompt-backlog",
        turn_id: "turn-1",
        hook_event_name: "UserPromptSubmit",
        prompt: "Immediate prompt from hook"
      },
      effectiveContext,
      mode: "foreground"
    });

    expect(items.map((item) => item.rawText)).toEqual([
      "Older unread transcript backlog",
      "Immediate prompt from hook"
    ]);
    expect(items[1]).toMatchObject({
      sourceRecordType: "hook_payload",
      sourceEventType: "UserPromptSubmit",
      rawText: "Immediate prompt from hook"
    });
  });

  it("does not duplicate UserPromptSubmit hook payloads already present in the transcript batch", () => {
    const payload = {
      session_id: "session-userprompt-present",
      turn_id: "turn-2",
      hook_event_name: "UserPromptSubmit",
      prompt: "Prompt already in transcript"
    };
    const effectiveContext = effectiveCaptureContext(payload);
    const items = selectRawConversationItemsForHook({
      transcriptRecords: [
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Prompt already in transcript"
          }
        }
      ],
      payload,
      effectiveContext,
      mode: "foreground"
    });

    expect(items.map((item) => item.rawText)).toEqual([
      "Prompt already in transcript"
    ]);
    expect(items).toHaveLength(1);
  });

  it("does not duplicate UserPromptSubmit hook payloads present after mixed transcript backlog", () => {
    const payload = {
      session_id: "session-userprompt-mixed-present",
      turn_id: "turn-mixed-present",
      hook_event_name: "UserPromptSubmit",
      prompt: "Prompt already present after backlog"
    };
    const effectiveContext = effectiveCaptureContext(payload);
    const items = selectRawConversationItemsForHook({
      transcriptRecords: [
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Older unread transcript backlog"
          }
        },
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Prompt already present after backlog"
          }
        }
      ],
      payload,
      effectiveContext,
      mode: "foreground"
    });

    expect(items.map((item) => item.rawText)).toEqual([
      "Older unread transcript backlog",
      "Prompt already present after backlog"
    ]);
    expect(items).toHaveLength(2);
  });

  it("does not suppress a repeated prompt when transcript backlog contains older matching text", () => {
    const payload = {
      session_id: "session-userprompt-repeat",
      turn_id: "turn-repeat",
      hook_event_name: "UserPromptSubmit",
      prompt: "Repeated prompt"
    };
    const effectiveContext = effectiveCaptureContext(payload);
    const items = selectRawConversationItemsForHook({
      transcriptRecords: [
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Repeated prompt"
          }
        },
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Older backlog after the repeated prompt"
          }
        }
      ],
      payload,
      effectiveContext,
      mode: "foreground"
    });

    expect(items.map((item) => item.rawText)).toEqual([
      "Repeated prompt",
      "Older backlog after the repeated prompt",
      "Repeated prompt"
    ]);
    expect(items[2]).toMatchObject({
      sourceRecordType: "hook_payload",
      sourceEventType: "UserPromptSubmit"
    });
  });

  it("deduplicates subagent UserPromptSubmit payloads already present in the transcript batch", () => {
    const payload = {
      session_id: "parent-thread",
      agent_id: "subagent-thread",
      turn_id: "subagent-turn",
      hook_event_name: "UserPromptSubmit",
      prompt: "Subagent prompt already in transcript"
    };
    const effectiveContext = effectiveCaptureContext(payload, {
      threadKind: "subagent",
      transcriptSessionId: "subagent-thread",
      parentThreadId: "parent-thread",
      transcriptMetadata: {}
    });
    const items = selectRawConversationItemsForHook({
      transcriptRecords: [
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Subagent prompt already in transcript"
          }
        }
      ],
      payload,
      effectiveContext,
      mode: "foreground"
    });

    expect(items.map((item) => item.rawText)).toEqual([
      "Subagent prompt already in transcript"
    ]);
    expect(items).toHaveLength(1);
  });

  it("keeps transcript raw identity stable between foreground and catch-up reads", () => {
    const payload = {
      session_id: "session-userprompt-later",
      turn_id: "turn-3",
      hook_event_name: "UserPromptSubmit",
      prompt: "Prompt later appears in transcript"
    };
    const effectiveContext = effectiveCaptureContext(payload);
    const record = {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Prompt later appears in transcript"
      }
    };
    const foregroundTranscript = buildRawTranscriptConversationItems({
      records: [record],
      payload,
      effectiveContext
    });
    const catchupTranscript = buildRawTranscriptConversationItems({
      records: [record],
      payload: {
        session_id: "session-userprompt-later",
        hook_event_name: "UserPromptSubmit"
      },
      effectiveContext
    });

    expect(foregroundTranscript[0]?.sourceHash).toBe(
      catchupTranscript[0]?.sourceHash
    );
    expect(foregroundTranscript[0]?.idempotencyKey).toBe(
      catchupTranscript[0]?.idempotencyKey
    );
  });

  it("deduplicates detached catch-up transcript prompts without suppressing older repeated backlog", () => {
    const stateScope = "scope-detached-prompt";
    const prompt = "Repeated detached prompt";
    const payload = {
      session_id: "session-detached-prompt",
      hook_event_name: "PostToolUse"
    };
    const effectiveContext = effectiveCaptureContext(payload);
    const transcriptItems = buildRawTranscriptConversationItems({
      records: [
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: prompt
          }
        },
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Backlog between repeated prompts"
          }
        },
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: prompt
          }
        }
      ],
      payload,
      effectiveContext
    });

    const filtered = filterTranscriptItemsAlreadyCapturedFromImmediatePrompts(
      {
        seen: {},
        rawSeen: {},
        immediatePrompts: {
          [`${stateScope}:immediate-prompt-1`]: {
            sourceHash: "immediate-source-hash",
            externalSessionId: "session-detached-prompt",
            externalTurnId: "turn-immediate-prompt",
            actor: "user",
            prompt,
            capturedAt: Date.now()
          }
        },
        transcriptOffsets: {}
      },
      stateScope,
      transcriptItems
    );

    expect(filtered.map((item) => item.rawText)).toEqual([
      prompt,
      "Backlog between repeated prompts"
    ]);
  });

  it("batches raw conversation items under the configured request budget", () => {
    process.env.MEMORY_RAW_INGEST_BATCH_BYTES = "1200";
    try {
      const item = {
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        sourceTransport: "hook",
        sourceRecordType: "event_msg",
        rawJson: { payload: "x".repeat(220) },
        sourceHash: "source",
        idempotencyKey: "source",
        projectionStatus: "pending",
        projectionVersion: "codex-transcript-v1",
        metadata: {}
      };
      const batches = rawItemBatches([
        { ...item, sourceHash: "source-1", idempotencyKey: "source-1" },
        { ...item, sourceHash: "source-2", idempotencyKey: "source-2" },
        { ...item, sourceHash: "source-3", idempotencyKey: "source-3" }
      ]);

      expect(batches.length).toBeGreaterThan(1);
      expect(batches.flat()).toHaveLength(3);
    } finally {
      delete process.env.MEMORY_RAW_INGEST_BATCH_BYTES;
    }
  });

  it("splits a single oversized raw conversation item without dropping the source sequence", () => {
    process.env.MEMORY_RAW_INGEST_BATCH_BYTES = "1200";
    try {
      const chunks = rawItemRequestChunks({
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        sourceTransport: "hook",
        externalSessionId: "thread-1",
        externalThreadId: "thread-1",
        sourceRecordType: "event_msg",
        sourceEventType: "tool_output",
        sourceSequence: 42,
        eventTime: "2026-05-01T10:00:00.000Z",
        rawJson: { payload: "x".repeat(2_000) },
        rawText: "large tool output ".repeat(500),
        sourceHash: "large-source",
        idempotencyKey: "large-source",
        projectionStatus: "pending",
        projectionVersion: "codex-transcript-v1",
        metadata: { transcriptIndex: 42 }
      });

      expect(chunks.length).toBeGreaterThan(1);
      expect(new Set(chunks.map((chunk) => chunk.sourceSequence))).toEqual(
        new Set([42])
      );
      expect(new Set(chunks.map((chunk) => chunk.eventTime))).toEqual(
        new Set(["2026-05-01T10:00:00.000Z"])
      );
      expect(chunks[0]?.metadata).toMatchObject({
        sourceItemHash: "large-source",
        sourceChunkIndex: 0,
        sourceChunkCount: chunks.length
      });
      expect(chunks[0]).toMatchObject({
        logicalSourceId: "large-source",
        transportChunkIndex: 0,
        transportChunkCount: chunks.length,
        transportChunkEncoding: "conversation-item-json-v1"
      });
      expect(typeof chunks[0]?.transportChunkText).toBe("string");
      expect(chunks.every((chunk) => chunk.sourceHash !== "large-source")).toBe(
        true
      );
      expect(
        chunks.every(
          (chunk) =>
            Buffer.byteLength(JSON.stringify({ items: [chunk] }), "utf8") <=
            1200
        )
      ).toBe(true);
    } finally {
      delete process.env.MEMORY_RAW_INGEST_BATCH_BYTES;
    }
  });

  it("keeps escaped oversized raw chunks under the request budget", () => {
    process.env.MEMORY_RAW_INGEST_BATCH_BYTES = "1400";
    try {
      const chunks = rawItemRequestChunks({
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        sourceTransport: "hook",
        externalSessionId: "thread-escaped",
        externalThreadId: "thread-escaped",
        sourceRecordType: "event_msg",
        sourceSequence: 7,
        rawJson: {
          payload: '"quoted" \\\\ backslash \\n newline '.repeat(600)
        },
        sourceHash: "escaped-source",
        idempotencyKey: "escaped-source",
        projectionStatus: "pending",
        projectionVersion: "codex-transcript-v1",
        metadata: { transcriptIndex: 7 }
      });

      expect(chunks.length).toBeGreaterThan(1);
      expect(
        chunks.every(
          (chunk) =>
            Buffer.byteLength(JSON.stringify({ items: [chunk] }), "utf8") <=
            1400
        )
      ).toBe(true);
    } finally {
      delete process.env.MEMORY_RAW_INGEST_BATCH_BYTES;
    }
  });

  it("delta-filters raw conversation items while retaining records needed for new projections", () => {
    const item = {
      sourceKind: "codex",
      sourceAdapterVersion: "codex-transcript-v1",
      sourceTransport: "hook",
      sourceRecordType: "event_msg",
      rawJson: { type: "event_msg" },
      sourceHash: "raw-1",
      idempotencyKey: "raw-1",
      projectionStatus: "pending",
      projectionVersion: "codex-transcript-v1",
      metadata: {}
    };

    const filtered = rawItemsForCapture(
      [
        { ...item, sourceHash: "raw-1", idempotencyKey: "raw-1" },
        {
          ...item,
          sourceHash: "raw-2",
          idempotencyKey: "raw-2",
          sourceSequence: 2
        },
        {
          ...item,
          sourceHash: "raw-3",
          idempotencyKey: "raw-3",
          sourceSequence: 3
        }
      ],
      { "raw-1": true, "raw-2": true },
      new Set([2])
    );

    expect(filtered.map((rawItem) => rawItem.sourceHash)).toEqual([
      "raw-2",
      "raw-3"
    ]);
  });

  it("delta-filters raw hook payloads by required source hash when no transcript sequence exists", () => {
    const item = {
      sourceKind: "codex",
      sourceAdapterVersion: "codex-hook-v1",
      sourceTransport: "hook",
      sourceRecordType: "hook_payload",
      rawJson: { hook_event_name: "PostToolUse" },
      sourceHash: "hook-raw",
      idempotencyKey: "hook-raw",
      projectionStatus: "pending",
      projectionVersion: "codex-hook-v1",
      metadata: {}
    };

    expect(
      rawItemsForCapture(
        [item],
        { "hook-raw": true },
        new Set(),
        new Set(["hook-raw"])
      )
    ).toEqual([item]);
  });
});
