import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, MemoryApiError } from "../src/index.js";
import {
  buildRawTranscriptConversationItems,
  captureTranscriptPathForPayload,
  detachedHookChildEnv,
  emptyHookBreakerState,
  effectiveCaptureContext,
  extractTranscriptSessionMetadata,
  hookApiRequestTimeoutMs,
  hookBreakerEntryCanRetryHealth,
  hookBreakerEntryIsOpen,
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
  runTranscriptCatchup,
  selectRawConversationItemsForHook,
  selectCaptureItems,
  shouldReadTranscriptForHook,
  stateScopeKey,
  transcriptCatchupApiRequestTimeoutMs,
  transcriptCatchupRetryDelayMs
} from "../src/capture-hook.js";

const withHookStateFile = async (
  run: (input: { dir: string; statePath: string }) => Promise<void>
): Promise<void> => {
  const priorStatePath = process.env.MEMORY_HOOK_STATE_PATH;
  const priorApiUrl = process.env.MEMORY_API_URL;
  const priorApiToken = process.env.MEMORY_API_TOKEN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-hook-state-"));
  const statePath = path.join(dir, "hook-state.json");
  process.env.MEMORY_HOOK_STATE_PATH = statePath;
  process.env.MEMORY_API_URL = "http://127.0.0.1:3300";
  process.env.MEMORY_API_TOKEN = "test-token";
  try {
    await run({ dir, statePath });
  } finally {
    if (priorStatePath === undefined) {
      delete process.env.MEMORY_HOOK_STATE_PATH;
    } else {
      process.env.MEMORY_HOOK_STATE_PATH = priorStatePath;
    }
    if (priorApiUrl === undefined) {
      delete process.env.MEMORY_API_URL;
    } else {
      process.env.MEMORY_API_URL = priorApiUrl;
    }
    if (priorApiToken === undefined) {
      delete process.env.MEMORY_API_TOKEN;
    } else {
      process.env.MEMORY_API_TOKEN = priorApiToken;
    }
    fs.rmSync(dir, { force: true, recursive: true });
  }
};

const readOnlyTranscriptCatchupStatus = (
  statePath: string
): Record<string, unknown> => {
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    transcriptCatchups?: Record<string, Record<string, unknown>>;
  };
  const statuses = Object.values(parsed.transcriptCatchups ?? {});
  expect(statuses).toHaveLength(1);
  return statuses[0]!;
};

describe("Codex capture hook transcript parsing", () => {
  it("keeps upstream and device credentials out of detached hook children", () => {
    const env = detachedHookChildEnv({
      PATH: "/usr/bin",
      CODEX_HOME: "/tmp/codex",
      MEMORY_API_URL: "http://127.0.0.1:3300",
      MEMORY_API_TOKEN: "local-capture-token",
      KOED_UPSTREAM_ACCESS_TOKEN: "upstream-token",
      KOED_DEVICE_CREDENTIAL_SECRET: "device-secret",
      WORKOS_API_KEY: "workos-secret",
      AUTHKIT_CLIENT_SECRET: "authkit-secret",
      UPSTREAM_COOKIE: "cloud-cookie"
    });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      CODEX_HOME: "/tmp/codex",
      MEMORY_API_URL: "http://127.0.0.1:3300",
      MEMORY_API_TOKEN: "local-capture-token"
    });
    expect(env.KOED_UPSTREAM_ACCESS_TOKEN).toBeUndefined();
    expect(env.KOED_DEVICE_CREDENTIAL_SECRET).toBeUndefined();
    expect(env.WORKOS_API_KEY).toBeUndefined();
    expect(env.AUTHKIT_CLIENT_SECRET).toBeUndefined();
    expect(env.UPSTREAM_COOKIE).toBeUndefined();
  });

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
          apiUrl: "http://127.0.0.1:3300",
          requestTimeoutMs: 1500
        })
      );
      expect(loadConfig(configPath, "foreground").requestTimeoutMs).toBe(1500);
      expect(loadConfig(configPath, "catchup").requestTimeoutMs).toBe(60000);

      const catchupConfigPath = path.join(dir, "catchup-config.json");
      fs.writeFileSync(
        catchupConfigPath,
        JSON.stringify({
          apiUrl: "http://127.0.0.1:3300",
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

  it("signals detached transcript ingestion from foreground hooks", async () => {
    await withHookStateFile(async () => {
      const triggerCatchup = vi.fn();
      const transcriptPath = path.join(
        os.tmpdir(),
        `koed-transcript-${process.pid}-${Date.now()}.jsonl`
      );

      const result = await runForegroundCapturePass({
        payload: {
          hook_event_name: "PostToolUse",
          session_id: "session-open",
          turn_id: "turn-open",
          tool_use_id: "tool-use-open",
          tool_name: "Read",
          transcript_path: transcriptPath
        },
        triggerCatchup
      });

      expect(triggerCatchup).toHaveBeenCalledWith(undefined, {
        hook_event_name: "PostToolUse",
        session_id: "session-open",
        turn_id: "turn-open",
        tool_use_id: "tool-use-open",
        tool_name: "Read",
        transcript_path: transcriptPath
      });
      expect(result).toEqual({
        rawItemsStored: 0,
        rawItemsProjected: 0,
        transcriptPath,
        transcriptBacklogRemaining: true,
        transcriptCheckpointAdvanced: false
      });
    });
  });

  it("runs foreground transcript capture when detached catch-up is disabled", async () => {
    const priorTrigger = process.env.MEMORY_HOOK_TRIGGER_TRANSCRIPT_CATCHUP;
    process.env.MEMORY_HOOK_TRIGGER_TRANSCRIPT_CATCHUP = "false";
    try {
      await withHookStateFile(async () => {
        const triggerCatchup = vi.fn();
        const runPass = vi.fn(async () => ({
          rawItemsStored: 2,
          rawItemsProjected: 2,
          transcriptPath: "/tmp/koed-disabled-catchup.jsonl",
          transcriptBacklogRemaining: false,
          transcriptCheckpointAdvanced: true
        }));

        const result = await runForegroundCapturePass({
          payload: {
            hook_event_name: "PostToolUse",
            session_id: "session-disabled-catchup",
            transcript_path: "/tmp/koed-disabled-catchup.jsonl"
          },
          runPass,
          triggerCatchup
        });

        expect(triggerCatchup).not.toHaveBeenCalled();
        expect(runPass).toHaveBeenCalledWith({
          configPath: undefined,
          payload: {
            hook_event_name: "PostToolUse",
            session_id: "session-disabled-catchup",
            transcript_path: "/tmp/koed-disabled-catchup.jsonl"
          },
          mode: "foreground"
        });
        expect(result).toMatchObject({
          rawItemsStored: 2,
          rawItemsProjected: 2,
          transcriptBacklogRemaining: false,
          transcriptCheckpointAdvanced: true
        });
      });
    } finally {
      if (priorTrigger === undefined) {
        delete process.env.MEMORY_HOOK_TRIGGER_TRANSCRIPT_CATCHUP;
      } else {
        process.env.MEMORY_HOOK_TRIGGER_TRANSCRIPT_CATCHUP = priorTrigger;
      }
    }
  });

  it("throttles duplicate detached catch-up spawns for an in-flight transcript", async () => {
    await withHookStateFile(async () => {
      const triggerCatchup = vi.fn();
      const payload = {
        hook_event_name: "PostToolUse" as const,
        session_id: "session-throttled-catchup",
        transcript_path: "/tmp/koed-throttled-catchup.jsonl",
        cwd: "/repo"
      };

      const first = await runForegroundCapturePass({
        payload,
        triggerCatchup
      });
      const second = await runForegroundCapturePass({
        payload,
        triggerCatchup
      });

      expect(triggerCatchup).toHaveBeenCalledTimes(1);
      expect(first).toMatchObject({
        transcriptPath: payload.transcript_path,
        transcriptBacklogRemaining: true
      });
      expect(second).toMatchObject({
        transcriptPath: payload.transcript_path,
        transcriptBacklogRemaining: true
      });
    });
  });

  it("queues Stop catch-up without duplicate foreground capture while an earlier catch-up is in flight", async () => {
    await withHookStateFile(async () => {
      const triggerCatchup = vi.fn();
      const runPass = vi.fn(async () => ({
        rawItemsStored: 1,
        rawItemsProjected: 1,
        transcriptPath: "/tmp/koed-stop-seal-catchup.jsonl",
        transcriptCheckpointOffset: 128,
        transcriptSize: 128,
        transcriptBacklogBytes: 0,
        transcriptBacklogRemaining: false,
        transcriptCheckpointAdvanced: true
      }));
      const transcriptPath = "/tmp/koed-stop-seal-catchup.jsonl";
      const postToolPayload = {
        hook_event_name: "PostToolUse" as const,
        session_id: "session-stop-seal",
        transcript_path: transcriptPath,
        cwd: "/repo"
      };
      const stopPayload = {
        hook_event_name: "Stop" as const,
        session_id: "session-stop-seal",
        turn_id: "turn-stop-seal",
        transcript_path: transcriptPath,
        cwd: "/repo"
      };

      await runForegroundCapturePass({
        payload: postToolPayload,
        triggerCatchup
      });
      const result = await runForegroundCapturePass({
        payload: stopPayload,
        triggerCatchup,
        runPass
      });

      expect(triggerCatchup).toHaveBeenCalledTimes(2);
      expect(triggerCatchup).toHaveBeenNthCalledWith(
        1,
        undefined,
        postToolPayload
      );
      expect(triggerCatchup).toHaveBeenNthCalledWith(2, undefined, stopPayload);
      expect(runPass).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        rawItemsStored: 0,
        rawItemsProjected: 0,
        transcriptPath,
        transcriptBacklogRemaining: true,
        transcriptCheckpointAdvanced: false
      });
    });
  });

  it("records successful detached transcript catch-up breadcrumbs", async () => {
    await withHookStateFile(async ({ dir, statePath }) => {
      const transcriptPath = path.join(dir, "transcript.jsonl");
      fs.writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:00.000Z",
          payload: { type: "user_message", message: "hello" }
        })}\n`
      );

      await runTranscriptCatchup(
        undefined,
        {
          hook_event_name: "PostToolUse",
          session_id: "session-status-success",
          transcript_path: transcriptPath,
          cwd: "/repo"
        },
        {
          client: {
            accessCheck: async () => ({
              ok: true,
              auth: "bearer_api_token",
              user: {
                id: "user-status-success",
                email: "user@example.com",
                displayName: null
              },
              canWritePersonal: true
            })
          },
          acquireCatchupLock: () => ({
            heartbeat() {},
            release() {}
          }),
          runCapturePass: async () => ({
            rawItemsStored: 2,
            rawItemsProjected: 2,
            transcriptPath,
            transcriptCheckpointOffset: 123,
            transcriptSize: 456,
            transcriptBacklogBytes: 333,
            transcriptBacklogRemaining: false,
            transcriptCheckpointAdvanced: true
          }),
          maxRuntimeMs: 10_000
        }
      );

      const status = readOnlyTranscriptCatchupStatus(statePath);
      expect(typeof status.lastStartedAt).toBe("string");
      expect(typeof status.lastSucceededAt).toBe("string");
      expect(status).toMatchObject({
        transcriptPath,
        lastError: null,
        checkpointOffset: 123,
        transcriptSize: 456,
        backlogBytes: 333,
        rawItemsStored: 2,
        rawItemsProjected: 2
      });
    });
  });

  it("records retryable detached catch-up failures and supersedes them on later success", async () => {
    await withHookStateFile(async ({ dir, statePath }) => {
      const transcriptPath = path.join(dir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");

      await runTranscriptCatchup(
        undefined,
        {
          hook_event_name: "PostToolUse",
          session_id: "session-status-retry",
          transcript_path: transcriptPath,
          cwd: "/repo"
        },
        {
          client: {
            accessCheck: async () => {
              throw new MemoryApiError("rate limited", { status: 429 });
            }
          },
          sleepUntilCatchupStop: async () => false,
          maxRuntimeMs: 10_000
        }
      );

      const failedStatus = readOnlyTranscriptCatchupStatus(statePath);
      expect(typeof failedStatus.lastStartedAt).toBe("string");
      expect(typeof failedStatus.lastFailedAt).toBe("string");
      expect(failedStatus).toMatchObject({
        transcriptPath,
        lastError: "rate limited"
      });

      await runTranscriptCatchup(
        undefined,
        {
          hook_event_name: "PostToolUse",
          session_id: "session-status-retry",
          transcript_path: transcriptPath,
          cwd: "/repo"
        },
        {
          client: {
            accessCheck: async () => ({
              ok: true,
              auth: "bearer_api_token",
              user: {
                id: "user-status-retry",
                email: "user@example.com",
                displayName: null
              },
              canWritePersonal: true
            })
          },
          acquireCatchupLock: () => ({
            heartbeat() {},
            release() {}
          }),
          runCapturePass: async () => ({
            rawItemsStored: 1,
            rawItemsProjected: 1,
            transcriptPath,
            transcriptCheckpointOffset: 50,
            transcriptSize: 50,
            transcriptBacklogBytes: 0,
            transcriptBacklogRemaining: false,
            transcriptCheckpointAdvanced: true
          }),
          maxRuntimeMs: 10_000
        }
      );

      const recoveredStatus = readOnlyTranscriptCatchupStatus(statePath);
      expect(typeof recoveredStatus.lastFailedAt).toBe("string");
      expect(typeof recoveredStatus.lastSucceededAt).toBe("string");
      expect(recoveredStatus).toMatchObject({
        transcriptPath,
        lastError: null,
        checkpointOffset: 50,
        rawItemsStored: 1,
        rawItemsProjected: 1
      });
    });
  });

  it("returns quickly when a foreground hook has no transcript path", async () => {
    const triggerCatchup = vi.fn();

    const result = await runForegroundCapturePass({
      payload: { hook_event_name: "UserPromptSubmit", session_id: "s" },
      triggerCatchup
    });

    expect(triggerCatchup).not.toHaveBeenCalled();
    expect(result).toEqual({
      rawItemsStored: 0,
      rawItemsProjected: 0,
      transcriptBacklogRemaining: false,
      transcriptCheckpointAdvanced: false
    });
  });

  it("keeps transcript checkpoints stable when the API token changes", () => {
    const workspaceId = "/home/mark/code/koed/koed-self-hosted";

    expect(
      stateScopeKey(
        { apiUrl: "http://localhost:3300", apiToken: "old-token" },
        workspaceId,
        "user-1"
      )
    ).toBe(
      stateScopeKey(
        { apiUrl: "http://localhost:3300/", apiToken: "new-token" },
        workspaceId,
        "user-1"
      )
    );
  });

  it("keeps transcript checkpoints separate for different API token owners", () => {
    const workspaceId = "/home/mark/code/koed/koed-self-hosted";

    expect(
      stateScopeKey(
        { apiUrl: "http://localhost:3300", apiToken: "token-a" },
        workspaceId,
        "user-1"
      )
    ).not.toBe(
      stateScopeKey(
        { apiUrl: "http://localhost:3300", apiToken: "token-b" },
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

  it("assigns transcript rows to their real Codex turns instead of the hook payload turn", () => {
    const payload = {
      hook_event_name: "Stop" as const,
      cwd: "/repo",
      session_id: "hook-session",
      turn_id: "hook-signal-turn"
    };
    const records = [
      {
        type: "event_msg",
        timestamp: "2026-05-01T10:00:00.000Z",
        payload: { type: "task_started", turn_id: "turn-a" }
      },
      {
        type: "event_msg",
        timestamp: "2026-05-01T10:00:01.000Z",
        payload: { type: "user_message", message: "Prompt A" }
      },
      {
        type: "event_msg",
        timestamp: "2026-05-01T10:00:02.000Z",
        payload: { type: "agent_message", message: "Reply A" }
      },
      {
        type: "event_msg",
        timestamp: "2026-05-01T10:00:03.000Z",
        payload: { type: "task_complete", turn_id: "turn-a" }
      },
      {
        type: "event_msg",
        timestamp: "2026-05-01T10:00:04.000Z",
        payload: { type: "task_started", turn_id: "turn-b" }
      },
      {
        type: "event_msg",
        timestamp: "2026-05-01T10:00:05.000Z",
        payload: { type: "user_message", message: "Prompt B" }
      }
    ];

    const items = buildRawTranscriptConversationItems({
      records,
      transcriptPath: "/tmp/session.jsonl",
      effectiveContext: effectiveCaptureContext(payload),
      payload
    });

    expect(
      items.map((item) => ({
        rawText: item.rawText,
        sourceEventType: item.sourceEventType,
        externalTurnId: item.externalTurnId
      }))
    ).toEqual([
      {
        rawText: "",
        sourceEventType: "task_started",
        externalTurnId: "turn-a"
      },
      {
        rawText: "Prompt A",
        sourceEventType: "user_message",
        externalTurnId: "turn-a"
      },
      {
        rawText: "Reply A",
        sourceEventType: "agent_message",
        externalTurnId: "turn-a"
      },
      {
        rawText: "",
        sourceEventType: "task_complete",
        externalTurnId: "turn-a"
      },
      {
        rawText: "",
        sourceEventType: "task_started",
        externalTurnId: "turn-b"
      },
      {
        rawText: "Prompt B",
        sourceEventType: "user_message",
        externalTurnId: "turn-b"
      }
    ]);
    expect(
      items.some((item) => item.externalTurnId === "hook-signal-turn")
    ).toBe(false);
  });

  it("starts a fresh semantic turn for each transcript user prompt when Codex omits turn ids", () => {
    const payload = {
      hook_event_name: "Stop" as const,
      cwd: "/repo",
      session_id: "session-no-turns"
    };
    const items = buildRawTranscriptConversationItems({
      records: [
        {
          type: "event_msg",
          timestamp: "2026-05-01T10:00:00.000Z",
          payload: { type: "user_message", message: "First prompt" }
        },
        {
          type: "event_msg",
          timestamp: "2026-05-01T10:00:01.000Z",
          payload: { type: "agent_message", message: "First reply" }
        },
        {
          type: "event_msg",
          timestamp: "2026-05-01T10:00:02.000Z",
          payload: { type: "user_message", message: "Second prompt" }
        },
        {
          type: "event_msg",
          timestamp: "2026-05-01T10:00:03.000Z",
          payload: { type: "agent_message", message: "Second reply" }
        }
      ],
      transcriptPath: "/tmp/session-no-turns.jsonl",
      effectiveContext: effectiveCaptureContext(payload),
      payload
    });

    expect(items.map((item) => item.rawText)).toEqual([
      "First prompt",
      "First reply",
      "Second prompt",
      "Second reply"
    ]);
    expect(items[0]!.externalTurnId).toBe(items[1]!.externalTurnId);
    expect(items[2]!.externalTurnId).toBe(items[3]!.externalTurnId);
    expect(items[0]!.externalTurnId).not.toBe(items[2]!.externalTurnId);
  });

  it("uses stable raw transcript idempotency across foreground and catch-up offsets", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const line = (message: string, timestamp: string) =>
      `${JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: {
          type: "agent_message",
          message
        }
      })}\n`;
    fs.writeFileSync(
      transcriptPath,
      [
        line("first checkpoint line", "2026-05-01T10:00:00.000Z"),
        line("same duplicate message", "2026-05-01T10:00:01.000Z"),
        line("same duplicate message", "2026-05-01T10:00:02.000Z")
      ].join("")
    );
    const firstLineBytes = Buffer.byteLength(
      line("first checkpoint line", "2026-05-01T10:00:00.000Z")
    );
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
        foregroundMaxBytes: Buffer.byteLength(
          line("same duplicate message", "2026-05-01T10:00:02.000Z")
        )
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
      expect(foregroundItems[0]!.sourceSequence).toBe(
        catchupItems[1]!.sourceSequence
      );
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("can scan an existing transcript from the start without a first-contact cutoff", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const line = (message: string, timestamp: string) =>
      `${JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: { type: "agent_message", message }
      })}\n`;
    fs.writeFileSync(
      transcriptPath,
      `${line("old message one", "2026-05-01T10:00:00.000Z")}${line(
        "old message two",
        "2026-05-01T10:00:01.000Z"
      )}`
    );
    const size = fs.statSync(transcriptPath).size;

    try {
      const result = parseTranscriptFileRecords({
        transcriptPath,
        state: { seen: {}, rawSeen: {}, transcriptOffsets: {} },
        stateScope: "scope"
      });

      expect(result.records).toHaveLength(2);
      expect(JSON.stringify(result.records)).toContain("old message one");
      expect(JSON.stringify(result.records)).toContain("old message two");
      expect(result.indexOffset).toBe(0);
      expect(result.checkpoint).toMatchObject({
        offset: size,
        lineCount: 2,
        size
      });
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("baselines first-contact live capture to timestamped records near the hook signal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const oldTimestamp = "2026-01-01T00:00:00.000Z";
    const liveTimestamp = "2026-01-01T00:10:00.000Z";
    const oldLine = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "agent_message",
        timestamp: oldTimestamp,
        message: "old transcript history"
      }
    });
    const liveLine = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "agent_message",
        timestamp: liveTimestamp,
        message: "live hook window message"
      }
    });
    fs.writeFileSync(
      transcriptPath,
      [
        oldLine,
        oldLine.replace("old transcript history", "older transcript history"),
        liveLine
      ].join("\n") + "\n"
    );
    const size = fs.statSync(transcriptPath).size;
    const openSpy = vi.spyOn(fs, "openSync");

    try {
      const result = parseTranscriptFileRecords({
        transcriptPath,
        state: { seen: {}, rawSeen: {}, transcriptOffsets: {} },
        stateScope: "scope",
        firstContactAfter: "2026-01-01T00:05:00.000Z",
        maxBytes: Buffer.byteLength(`${liveLine}\n`) + 4
      });

      expect(result.records).toHaveLength(1);
      expect(JSON.stringify(result.records[0])).toContain(
        "live hook window message"
      );
      expect(JSON.stringify(result.records)).not.toContain(
        "old transcript history"
      );
      expect(result.checkpoint?.offset).toBe(size);
      expect(result.checkpoint?.size).toBe(size);
      expect(openSpy).toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("keeps first-contact live rows and interpolates missing timestamps between source timestamps", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const line = (message: string, timestamp?: string) =>
      `${JSON.stringify({
        type: "event_msg",
        ...(timestamp ? { timestamp } : {}),
        payload: { type: "agent_message", message }
      })}\n`;
    fs.writeFileSync(
      transcriptPath,
      [
        line("old transcript history", "2026-01-01T00:00:00.000Z"),
        line("live source timestamp", "2026-01-01T00:10:00.000Z"),
        line("missing timestamp inside live window"),
        line("next source timestamp", "2026-01-01T00:10:04.000Z")
      ].join("")
    );
    const size = fs.statSync(transcriptPath).size;

    try {
      const result = parseTranscriptFileRecords({
        transcriptPath,
        state: { seen: {}, rawSeen: {}, transcriptOffsets: {} },
        stateScope: "scope",
        firstContactAfter: "2026-01-01T00:05:00.000Z",
        maxBytes: Number.MAX_SAFE_INTEGER
      });
      const rawItems = buildRawTranscriptConversationItems({
        records: result.records,
        transcriptPath,
        effectiveContext: effectiveCaptureContext({
          hook_event_name: "Stop",
          session_id: "live-interpolation"
        }),
        payload: { hook_event_name: "Stop", session_id: "live-interpolation" }
      });

      expect(rawItems.map((item) => item.rawText)).toEqual([
        "live source timestamp",
        "missing timestamp inside live window",
        "next source timestamp"
      ]);
      expect(rawItems.map((item) => item.eventTime)).toEqual([
        "2026-01-01T00:10:00.000Z",
        "2026-01-01T00:10:02.000Z",
        "2026-01-01T00:10:04.000Z"
      ]);
      expect(rawItems[1]!.metadata).toMatchObject({
        sourceEventTimeAccuracy: "interpolated_between_sources"
      });
      expect(result.checkpoint).toMatchObject({
        offset: size,
        lineCount: 4,
        size,
        lastEventTime: "2026-01-01T00:10:04.000Z"
      });
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("holds a stampless transcript tail until a later source timestamp anchors it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const line = (message: string, timestamp?: string) =>
      `${JSON.stringify({
        type: "event_msg",
        ...(timestamp ? { timestamp } : {}),
        payload: { type: "agent_message", message }
      })}\n`;
    const previousLine = line(
      "previous timestamped row",
      "2026-01-01T00:10:00.000Z"
    );
    const missingLine = line("stampless tail row");
    fs.writeFileSync(transcriptPath, previousLine + missingLine);
    const previousSize = Buffer.byteLength(previousLine);
    const state = {
      seen: {},
      rawSeen: {},
      transcriptOffsets: {
        [`scope:${transcriptPath}`]: {
          offset: previousSize,
          lineCount: 1,
          size: previousSize,
          lastEventTime: "2026-01-01T00:10:00.000Z"
        }
      }
    };

    try {
      const held = parseTranscriptFileRecords({
        transcriptPath,
        state,
        stateScope: "scope",
        maxBytes: Number.MAX_SAFE_INTEGER
      });
      expect(held.records).toEqual([]);
      expect(held.checkpoint).toMatchObject({
        offset: previousSize,
        lineCount: 1,
        lastEventTime: "2026-01-01T00:10:00.000Z"
      });

      fs.appendFileSync(
        transcriptPath,
        line("later timestamped row", "2026-01-01T00:10:04.000Z")
      );
      const anchored = parseTranscriptFileRecords({
        transcriptPath,
        state,
        stateScope: "scope",
        maxBytes: Number.MAX_SAFE_INTEGER
      });
      const rawItems = buildRawTranscriptConversationItems({
        records: anchored.records,
        transcriptPath,
        effectiveContext: effectiveCaptureContext({
          hook_event_name: "Stop",
          session_id: "stampless-tail"
        }),
        payload: { hook_event_name: "Stop", session_id: "stampless-tail" }
      });

      expect(rawItems.map((item) => item.rawText)).toEqual([
        "stampless tail row",
        "later timestamped row"
      ]);
      expect(rawItems.map((item) => item.eventTime)).toEqual([
        "2026-01-01T00:10:02.000Z",
        "2026-01-01T00:10:04.000Z"
      ]);
      expect(rawItems[0]!.metadata).toMatchObject({
        sourceEventTimeAccuracy: "interpolated_between_sources"
      });
      expect(anchored.checkpoint).toMatchObject({
        lineCount: 3,
        lastEventTime: "2026-01-01T00:10:04.000Z"
      });
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("preserves the prior timestamp anchor across empty transcript polls", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const line = (message: string, timestamp?: string) =>
      `${JSON.stringify({
        type: "event_msg",
        ...(timestamp ? { timestamp } : {}),
        payload: { type: "agent_message", message }
      })}\n`;
    const previousLine = line(
      "previous timestamped row",
      "2026-01-01T00:10:00.000Z"
    );
    fs.writeFileSync(transcriptPath, previousLine);
    const previousSize = fs.statSync(transcriptPath).size;
    const state = {
      seen: {},
      rawSeen: {},
      transcriptOffsets: {
        [`scope:${transcriptPath}`]: {
          offset: previousSize,
          lineCount: 1,
          size: previousSize,
          lastEventTime: "2026-01-01T00:10:00.000Z"
        }
      }
    };

    try {
      const emptyPoll = parseTranscriptFileRecords({
        transcriptPath,
        state,
        stateScope: "scope",
        maxBytes: Number.MAX_SAFE_INTEGER
      });

      expect(emptyPoll.records).toEqual([]);
      expect(emptyPoll.checkpoint).toMatchObject({
        offset: previousSize,
        lineCount: 1,
        size: previousSize,
        lastEventTime: "2026-01-01T00:10:00.000Z"
      });

      const nextState = {
        seen: {},
        rawSeen: {},
        transcriptOffsets: {
          [`scope:${transcriptPath}`]: emptyPoll.checkpoint!
        }
      };
      fs.appendFileSync(
        transcriptPath,
        line("stampless row after empty poll") +
          line("later timestamped row", "2026-01-01T00:10:04.000Z")
      );
      const anchored = parseTranscriptFileRecords({
        transcriptPath,
        state: nextState,
        stateScope: "scope",
        maxBytes: Number.MAX_SAFE_INTEGER
      });
      const rawItems = buildRawTranscriptConversationItems({
        records: anchored.records,
        transcriptPath,
        effectiveContext: effectiveCaptureContext({
          hook_event_name: "Stop",
          session_id: "empty-poll-anchor"
        }),
        payload: { hook_event_name: "Stop", session_id: "empty-poll-anchor" }
      });

      expect(rawItems.map((item) => item.rawText)).toEqual([
        "stampless row after empty poll",
        "later timestamped row"
      ]);
      expect(rawItems.map((item) => item.eventTime)).toEqual([
        "2026-01-01T00:10:02.000Z",
        "2026-01-01T00:10:04.000Z"
      ]);
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("reads only appended transcript records after the initial checkpoint", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const line = (message: string, timestamp: string) =>
      `${JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: { type: "agent_message", message }
      })}\n`;
    fs.writeFileSync(
      transcriptPath,
      line("old message", "2026-05-01T10:00:00.000Z")
    );
    const initialSize = fs.statSync(transcriptPath).size;
    fs.appendFileSync(
      transcriptPath,
      line("new message", "2026-05-01T10:00:01.000Z")
    );
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
    const line = (message: string, timestamp: string) =>
      `${JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: { type: "agent_message", message }
      })}\n`;
    fs.writeFileSync(
      transcriptPath,
      `${line("first message", "2026-05-01T10:00:00.000Z")}${line(
        "second message",
        "2026-05-01T10:00:01.000Z"
      )}${line("third message", "2026-05-01T10:00:02.000Z")}`
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
    const line = (message: string, timestamp: string) =>
      `${JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: { type: "agent_message", message }
      })}\n`;
    fs.writeFileSync(
      transcriptPath,
      [
        line("first backlog message", "2026-05-01T10:00:00.000Z"),
        line("second backlog message", "2026-05-01T10:00:01.000Z"),
        line("third backlog message", "2026-05-01T10:00:02.000Z"),
        line("latest foreground message", "2026-05-01T10:00:03.000Z")
      ].join("")
    );
    const firstLineBytes = Buffer.byteLength(
      line("first backlog message", "2026-05-01T10:00:00.000Z")
    );

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
        foregroundMaxBytes: Buffer.byteLength(
          line("latest foreground message", "2026-05-01T10:00:03.000Z")
        )
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
        maxBytes: Buffer.byteLength(
          line("second backlog message", "2026-05-01T10:00:01.000Z")
        )
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

  it("labels structured VS Code additional context as IDE client context", () => {
    // Synthetic fixture: the repo does not contain a real VS Code Codex
    // transcript with Include IDE Context enabled, so this locks the
    // structured additionalContext shape referenced by KOE-179.
    const items = parseTranscriptText(
      JSON.stringify([
        {
          type: "turn_start",
          payload: {
            type: "turn_start",
            additionalContext: {
              vscode: {
                kind: "application",
                value:
                  "Open file: src/server.ts\nSelected text: createMemoryEvent"
              }
            }
          }
        },
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Why did the capture path include the selected file?"
          }
        }
      ])
    );

    expect(items).toMatchObject([
      {
        actor: "system",
        eventType: "codex_transcript_ide_context",
        content:
          "vscode application\nOpen file: src/server.ts\nSelected text: createMemoryEvent",
        metadata: {
          contextKind: "ide_client_context",
          contextSource: "vscode_codex",
          sourceRole: "supporting_context",
          transcriptType: "ide_context",
          additionalContextSources: ["vscode"]
        }
      },
      {
        actor: "user",
        eventType: "codex_transcript_user"
      }
    ]);
  });

  it("preserves the user message when VS Code context shares its transcript record", () => {
    const record = {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Please review this file.",
        additionalContext: {
          vscode: {
            kind: "application",
            value: "Open file: SECURITY.md"
          }
        }
      }
    };
    const parsed = parseTranscriptText(JSON.stringify([record]));

    expect(parsed).toMatchObject([
      {
        actor: "system",
        eventType: "codex_transcript_ide_context",
        content: "vscode application\nOpen file: SECURITY.md"
      },
      {
        actor: "user",
        eventType: "codex_transcript_user",
        content: "Please review this file."
      }
    ]);

    const rawItems = buildRawTranscriptConversationItems({
      records: [record],
      effectiveContext: effectiveCaptureContext({
        hook_event_name: "UserPromptSubmit",
        session_id: "same-record-context"
      }),
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "same-record-context",
        prompt: "Please review this file."
      }
    });

    expect(rawItems.map((item) => item.rawText)).toEqual([
      "vscode application\nOpen file: SECURITY.md",
      "Please review this file."
    ]);
    expect(rawItems.map((item) => item.sourceSequence)).toEqual([0, 1]);
    expect(rawItems[0]!.sourceHash).not.toBe(rawItems[1]!.sourceHash);
    expect(rawItems[0]!.metadata).toMatchObject({
      contextKind: "ide_client_context",
      sourceRole: "supporting_context"
    });
  });

  it("splits rendered Codex IDE prompt wrappers into supporting context plus user prompt", () => {
    const wrappedPrompt = `# Context from my IDE setup:

## Active file: koed-self-hosted/SECURITY.md

## Open tabs:
- SECURITY.md: koed-self-hosted/SECURITY.md

## My request for Codex:
Coffee cardamom sounds interesting - should I cool the coffee first?`;
    const record = {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: wrappedPrompt
      }
    };

    const parsed = parseTranscriptText(JSON.stringify([record]));
    expect(parsed).toMatchObject([
      {
        actor: "system",
        eventType: "codex_transcript_ide_context",
        metadata: {
          contextKind: "ide_client_context",
          sourceRole: "supporting_context",
          contextEncoding: "codex_rendered_prompt_wrapper"
        }
      },
      {
        actor: "user",
        eventType: "codex_transcript_user",
        content:
          "Coffee cardamom sounds interesting - should I cool the coffee first?"
      }
    ]);
    expect(parsed[0]?.content).toContain(
      "Active file: koed-self-hosted/SECURITY.md"
    );

    const effectiveContext = effectiveCaptureContext({
      hook_event_name: "UserPromptSubmit",
      session_id: "rendered-wrapper"
    });
    const rawItems = selectRawConversationItemsForHook({
      transcriptRecords: [],
      effectiveContext,
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "rendered-wrapper",
        prompt: wrappedPrompt
      },
      mode: "foreground"
    });

    expect(rawItems).toEqual([]);
  });

  it("splits browser-compatible rendered IDE wrapper variants", () => {
    const wrappedWithEnvironment = `<environment_context>
  <cwd>/Users/jacobo/Coding/koed</cwd>
</environment_context>

# Context from my IDE setup:

## Active file: koed-self-hosted/SECURITY.md

## My request for Codex:
Review the active file.`;
    const unHashedWrappedPrompt = `Context from my IDE setup:

Active file: koed-self-hosted/SECURITY.md

Open tabs:
- SECURITY.md: koed-self-hosted/SECURITY.md

My request for Codex:
Review the active file.`;

    const parsed = parseTranscriptText(
      JSON.stringify([
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: wrappedWithEnvironment
          }
        },
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: unHashedWrappedPrompt
          }
        }
      ])
    );

    expect(parsed).toMatchObject([
      {
        actor: "system",
        eventType: "codex_transcript_ide_context"
      },
      {
        actor: "user",
        eventType: "codex_transcript_user",
        content: "Review the active file."
      },
      {
        actor: "system",
        eventType: "codex_transcript_ide_context"
      },
      {
        actor: "user",
        eventType: "codex_transcript_user",
        content: "Review the active file."
      }
    ]);
    expect(parsed[0]?.content).toContain(
      "Active file: koed-self-hosted/SECURITY.md"
    );
    expect(parsed[2]?.content).toContain("Open tabs:");
    expect(parsed.map((item) => item.content).join("\n")).not.toContain(
      "<environment_context>"
    );

    const rawItems = selectRawConversationItemsForHook({
      transcriptRecords: [],
      effectiveContext: effectiveCaptureContext({
        hook_event_name: "UserPromptSubmit",
        session_id: "browser-compatible-wrapper"
      }),
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "browser-compatible-wrapper",
        prompt: wrappedWithEnvironment
      },
      mode: "foreground"
    });

    expect(rawItems).toEqual([]);
  });

  it("keeps literal image tags but hides image-only wrapped prompts", () => {
    const literalImagePrompt = `# Context from my IDE setup:

## Active file: koed-self-hosted/fixture.html

## My request for Codex:
Please explain why <image>logo</image> is invalid HTML in this fixture.`;
    const imageOnlyPrompt = `# Context from my IDE setup:

## Active file: koed-self-hosted/SECURITY.md

## My request for Codex:
<image name=[Image #1]>raw image metadata</image>`;

    const parsed = parseTranscriptText(
      JSON.stringify([
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: literalImagePrompt
          }
        },
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: imageOnlyPrompt
          }
        }
      ])
    );

    expect(parsed).toMatchObject([
      {
        actor: "system",
        eventType: "codex_transcript_ide_context"
      },
      {
        actor: "user",
        eventType: "codex_transcript_user",
        content:
          "Please explain why <image>logo</image> is invalid HTML in this fixture."
      },
      {
        actor: "system",
        eventType: "codex_transcript_ide_context"
      },
      {
        actor: "user",
        eventType: "codex_transcript_user",
        content: ""
      }
    ]);

    const rawItems = selectRawConversationItemsForHook({
      transcriptRecords: [],
      effectiveContext: effectiveCaptureContext({
        hook_event_name: "UserPromptSubmit",
        session_id: "image-only-wrapper"
      }),
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "image-only-wrapper",
        prompt: imageOnlyPrompt
      },
      mode: "foreground"
    });

    expect(rawItems).toEqual([]);
  });

  it("keeps marker-like user-authored prompts as normal user text", () => {
    const markerLikePrompt = `# Context from my IDE setup:

This is a markdown example, not client-provided IDE context.

## My request for Codex:
Explain why this template exists.`;
    const fencedExample = `Please review this fixture:

\`\`\`text
# Context from my IDE setup:

## Active file: example.ts

## My request for Codex:
Do the thing.
\`\`\``;

    const parsed = parseTranscriptText(
      JSON.stringify([
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: markerLikePrompt
          }
        },
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: fencedExample
          }
        }
      ])
    );

    expect(parsed).toEqual([
      expect.objectContaining({
        actor: "user",
        eventType: "codex_transcript_user",
        content: markerLikePrompt
      }),
      expect.objectContaining({
        actor: "user",
        eventType: "codex_transcript_user",
        content: fencedExample
      })
    ]);
    expect(
      parsed.some((item) => item.eventType === "codex_transcript_ide_context")
    ).toBe(false);
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
      selectRawConversationItemsForHook({
        transcriptRecords: [
          {
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "Review this change"
            }
          }
        ],
        payload: {
          session_id: "parent-thread",
          agent_id: "agent-thread-from-hook",
          hook_event_name: "UserPromptSubmit",
          prompt: "Review this change"
        },
        effectiveContext,
        mode: "foreground"
      })
    ).toMatchObject([
      {
        externalSessionId: "child-thread",
        rawText: "Review this change",
        sourceRecordType: "event_msg",
        metadata: {
          threadKind: "subagent",
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

  it("uses transcript messages as the only capture items when hook payloads include tool output", () => {
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

    expect(items.map((item) => item.actor)).toEqual(["agent"]);
    expect(items).toHaveLength(1);
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

  it("does not create capture items from UserPromptSubmit hook payloads", () => {
    const items = selectCaptureItems([], {
      session_id: "session-b",
      hook_event_name: "UserPromptSubmit",
      prompt: "Capture this prompt"
    });

    expect(items).toEqual([]);
  });

  it("keeps only transcript backlog when UserPromptSubmit hook payload has not reached the transcript", () => {
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
      "Older unread transcript backlog"
    ]);
    expect(items).toHaveLength(1);
  });

  it("stores Stop hook payloads only as stripped control records", () => {
    const payload = {
      session_id: "session-stop-control",
      turn_id: "turn-stop-control",
      hook_event_name: "Stop",
      last_assistant_message: "This must come from the transcript instead.",
      tool_response: "This must not be captured from the hook."
    };
    const effectiveContext = effectiveCaptureContext(payload);
    const items = selectRawConversationItemsForHook({
      transcriptRecords: [],
      payload,
      effectiveContext,
      mode: "foreground"
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceRecordType: "hook_payload",
      sourceEventType: "Stop",
      rawJson: {
        session_id: "session-stop-control",
        turn_id: "turn-stop-control",
        hook_event_name: "Stop"
      },
      metadata: {
        hookPayloadContentOmitted: true
      }
    });
    expect(items[0]?.rawText).toBeUndefined();
    expect(JSON.stringify(items[0]?.rawJson)).not.toContain(
      "This must come from the transcript instead."
    );
    expect(JSON.stringify(items[0]?.rawJson)).not.toContain(
      "This must not be captured from the hook."
    );
  });

  it("keeps transcript content and adds a stripped Stop control record in foreground capture", () => {
    const payload = {
      session_id: "session-stop-transcript",
      turn_id: "turn-stop-transcript",
      hook_event_name: "Stop",
      last_assistant_message: "Hook copy must not be stored."
    };
    const effectiveContext = effectiveCaptureContext(payload);
    const items = selectRawConversationItemsForHook({
      transcriptRecords: [
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Transcript answer"
          }
        }
      ],
      payload,
      effectiveContext,
      mode: "foreground"
    });

    expect(items.map((item) => item.sourceRecordType)).toEqual([
      "event_msg",
      "hook_payload"
    ]);
    expect(items.map((item) => item.rawText)).toEqual([
      "Transcript answer",
      undefined
    ]);
    expect(JSON.stringify(items[1]?.rawJson)).not.toContain(
      "Hook copy must not be stored."
    );
  });

  it("keeps transcript UserPromptSubmit content when it is present in the transcript batch", () => {
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

  it("keeps mixed transcript backlog without adding UserPromptSubmit hook content", () => {
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

  it("does not add repeated UserPromptSubmit hook content when transcript backlog contains matching text", () => {
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
      "Older backlog after the repeated prompt"
    ]);
    expect(items).toHaveLength(2);
  });

  it("keeps subagent UserPromptSubmit content when it is present in the transcript batch", () => {
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

  it("delta-filters raw Stop control records by required source hash when no transcript sequence exists", () => {
    const item = {
      sourceKind: "codex",
      sourceAdapterVersion: "codex-hook-v1",
      sourceTransport: "hook",
      sourceRecordType: "hook_payload",
      rawJson: { hook_event_name: "Stop" },
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
