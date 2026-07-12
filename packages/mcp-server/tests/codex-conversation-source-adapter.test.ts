import { describe, expect, it } from "vitest";

import {
  buildRawTranscriptConversationItems,
  effectiveCaptureContext
} from "../src/capture-hook.js";
import {
  adaptCodexAppServerConversationEvent,
  codexCanonicalConversationItemKey
} from "../src/codex-conversation-source-adapter.js";
import type { CodexAppServerRawEvent } from "../src/codex-app-server-runner.js";
import type { RawConversationItemRequest } from "../src/conversation-source-types.js";

const threadId = "thread-managed";
const turnId = "turn-managed";
const sessionId = "session-managed";
const observedAt = "2026-07-11T10:00:00.000Z";

const appEvent = (
  method: string,
  params: Record<string, unknown>,
  sequence = 1
): CodexAppServerRawEvent => ({ method, params, sequence, observedAt });

const adapt = (event: CodexAppServerRawEvent) =>
  adaptCodexAppServerConversationEvent(event, {
    sessionId,
    externalThreadId: threadId
  });

const transcriptItems = (records: unknown[]) =>
  buildRawTranscriptConversationItems({
    records,
    sessionId,
    transcriptPath: "/tmp/managed-rollout.jsonl",
    effectiveContext: effectiveCaptureContext({
      hook_event_name: "Stop",
      cwd: "/repo",
      session_id: threadId
    }),
    payload: {
      hook_event_name: "Stop",
      cwd: "/repo",
      session_id: threadId
    },
    sourceTransport: "transcript",
    preferStableResponseItems: true
  });

const canonicalKeys = (items: Array<{ canonicalItemKey?: string }>) =>
  items
    .map((item) => item.canonicalItemKey)
    .filter((key): key is string => Boolean(key));

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const structuralToolSemantics = (item: RawConversationItemRequest) => {
  const metadata = item.metadata;
  const toolCall = record(metadata.toolCall);
  return {
    observationComponent: item.observationComponent,
    rawText: item.rawText,
    transcriptType: metadata.transcriptType,
    toolEventKind: metadata.toolEventKind,
    toolSummary: metadata.toolSummary,
    toolName: metadata.toolName,
    toolTitle: metadata.toolTitle,
    callId: metadata.callId,
    toolCallId: metadata.toolCallId,
    status: metadata.status,
    toolCall: {
      kind: toolCall.kind,
      type: toolCall.type,
      name: toolCall.name,
      title: toolCall.title,
      id: toolCall.id,
      status: toolCall.status
    }
  };
};

describe("Codex managed conversation source adapter", () => {
  it("filters current delta and outputDelta notifications case-insensitively", () => {
    const methods = [
      "item/agentMessage/delta",
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
      "item/plan/delta",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/textDelta",
      "command/exec/outputDelta",
      "process/outputDelta",
      "ITEM/COMMANDexecution/OUTPUTDELTA",
      "ITEM/AGENTMESSAGE/DELTA"
    ];

    for (const method of methods) {
      expect(
        adapt(
          appEvent(method, {
            threadId,
            turnId,
            itemId: "message-1",
            delta: "partial"
          })
        )
      ).toEqual({ items: [], identityIssues: [] });
    }
  });

  it("uses lifecycle identity for idempotency and payloads for integrity", () => {
    const original = adapt(
      appEvent("item/completed", {
        threadId,
        turnId,
        completedAtMs: Date.parse(observedAt),
        item: {
          id: "message-integrity",
          type: "agentMessage",
          text: "Original payload",
          phase: "final_answer"
        }
      })
    ).items[0]!;
    const changedPayload = adapt(
      appEvent(
        "item/completed",
        {
          threadId,
          turnId,
          completedAtMs: Date.parse(observedAt) + 1,
          item: {
            id: "message-integrity",
            type: "agentMessage",
            text: "Changed payload",
            phase: "final_answer"
          }
        },
        99
      )
    ).items[0]!;
    const transportReplay = adapt({
      ...appEvent(
        "item/completed",
        record((original.rawJson as Record<string, unknown>).params),
        100
      ),
      observedAt: "2026-07-11T10:01:00.000Z"
    }).items[0]!;

    expect(changedPayload.idempotencyKey).toBe(original.idempotencyKey);
    expect(changedPayload.sourceHash).not.toBe(original.sourceHash);
    expect(changedPayload.canonicalItemKey).toBe(original.canonicalItemKey);
    expect(transportReplay.idempotencyKey).toBe(original.idempotencyKey);
    expect(transportReplay.sourceHash).toBe(original.sourceHash);

    const turnStarted = adapt(
      appEvent("turn/started", {
        threadId,
        turn: { id: turnId, status: "inProgress", startedAt: 1 }
      })
    ).items[0]!;
    const turnStartedReplay = adapt(
      appEvent(
        "turn/started",
        {
          threadId,
          turn: { id: turnId, status: "inProgress", startedAt: 2 }
        },
        200
      )
    ).items[0]!;
    const identicalTurnStartedReplay = adapt(
      appEvent(
        "turn/started",
        {
          threadId,
          turn: { id: turnId, status: "inProgress", startedAt: 1 }
        },
        201
      )
    ).items[0]!;
    expect(turnStartedReplay.idempotencyKey).not.toBe(
      turnStarted.idempotencyKey
    );
    expect(turnStartedReplay.sourceHash).not.toBe(turnStarted.sourceHash);
    expect(identicalTurnStartedReplay.idempotencyKey).toBe(
      turnStarted.idempotencyKey
    );
  });

  it("content-addresses mutable noncanonical control snapshots across resumes", () => {
    const snapshot = {
      id: threadId,
      updatedAt: 10,
      turns: [{ id: turnId, status: "completed" }]
    };
    const resumeEvent = (
      thread: Record<string, unknown>,
      sequence: number
    ): CodexAppServerRawEvent => ({
      method: "thread/resume",
      params: { threadId },
      result: { thread },
      sequence,
      observedAt
    });
    const original = adapt(resumeEvent(snapshot, 0)).items[0]!;
    const identical = adapt(resumeEvent(snapshot, 99)).items[0]!;
    const changed = adapt(
      resumeEvent(
        {
          ...snapshot,
          updatedAt: 11,
          turns: [...snapshot.turns, { id: "turn-later", status: "completed" }]
        },
        0
      )
    ).items[0]!;

    expect(original.canonicalItemKey).toBeUndefined();
    expect(identical.idempotencyKey).toBe(original.idempotencyKey);
    expect(changed.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(changed.sourceHash).not.toBe(original.sourceHash);

    const unresolved = adapt(
      appEvent("turn/started", {
        threadId,
        turn: { status: "inProgress" }
      })
    ).items[0]!;
    const unresolvedReplay = adapt(
      appEvent(
        "turn/started",
        { threadId, turn: { status: "inProgress" } },
        100
      )
    ).items[0]!;
    const changedUnresolved = adapt(
      appEvent("turn/started", { threadId, turn: { status: "failed" } }, 1)
    ).items[0]!;
    expect(unresolvedReplay.idempotencyKey).toBe(unresolved.idempotencyKey);
    expect(changedUnresolved.idempotencyKey).not.toBe(
      unresolved.idempotencyKey
    );
  });

  it("fails managed transcript reconciliation without a provider thread id", () => {
    expect(() =>
      buildRawTranscriptConversationItems({
        records: [
          {
            timestamp: observedAt,
            type: "event_msg",
            payload: { type: "task_started", turn_id: turnId }
          },
          {
            timestamp: observedAt,
            type: "event_msg",
            payload: {
              type: "user_message",
              client_id: "koed-user-message:missing-thread",
              message: "Exact identity requires a thread."
            }
          }
        ],
        sessionId,
        transcriptPath: "/tmp/managed-rollout-without-thread.jsonl",
        effectiveContext: effectiveCaptureContext({
          hook_event_name: "Stop",
          cwd: "/repo"
        }),
        payload: { hook_event_name: "Stop", cwd: "/repo" },
        sourceTransport: "transcript",
        preferStableResponseItems: true
      })
    ).toThrow("could not establish exact identity for user_message");
  });

  it("keeps lifecycle snapshots as observations of one canonical agent item", () => {
    const started = adapt(
      appEvent("item/started", {
        threadId,
        turnId,
        startedAtMs: Date.parse("2026-07-11T09:59:58.000Z"),
        item: {
          id: "message-1",
          type: "agentMessage",
          text: "",
          phase: "final_answer"
        }
      })
    ).items[0]!;
    const completed = adapt(
      appEvent(
        "item/completed",
        {
          threadId,
          turnId,
          completedAtMs: Date.parse("2026-07-11T09:59:59.000Z"),
          item: {
            id: "message-1",
            type: "agentMessage",
            text: "Final answer",
            phase: "final_answer"
          }
        },
        2
      )
    ).items[0]!;

    expect(started.canonicalItemKey).toBe(completed.canonicalItemKey);
    expect(started.idempotencyKey).not.toBe(completed.idempotencyKey);
    expect(started).toMatchObject({
      observationKind: "lifecycle_started",
      projectionStatus: "raw_only",
      observedAt
    });
    expect(started.eventTime).toBe("2026-07-11T09:59:58.000Z");
    expect(completed).toMatchObject({
      observationKind: "lifecycle_completed",
      projectionStatus: "pending",
      rawText: "Final answer",
      metadata: { phase: "final_answer" }
    });
    expect(completed.eventTime).toBe("2026-07-11T09:59:59.000Z");
    expect(started).not.toHaveProperty("canonicalSourcePriority");
    expect(completed).not.toHaveProperty("canonicalSourcePriority");
  });

  it("uses the same canonical identities for app-server and JSONL items", () => {
    const clientUserMessageId = "koed-user-message:test-user-1";
    const appItems = [
      ...adapt(
        appEvent("item/completed", {
          threadId,
          turnId,
          item: {
            id: "user-item-1",
            type: "userMessage",
            clientId: clientUserMessageId,
            content: [{ type: "text", text: "Run the check" }]
          }
        })
      ).items,
      ...adapt(
        appEvent(
          "item/completed",
          {
            threadId,
            turnId,
            item: {
              id: "reasoning-1",
              type: "reasoning",
              summary: ["I should inspect the repository."],
              content: ["encrypted internal reasoning"]
            }
          },
          2
        )
      ).items,
      ...adapt(
        appEvent(
          "item/completed",
          {
            threadId,
            turnId,
            item: {
              id: "call-1",
              type: "mcpToolCall",
              server: "repo",
              tool: "search",
              arguments: { query: "projection" },
              result: { matches: 3 },
              status: "completed"
            }
          },
          3
        )
      ).items,
      ...adapt(
        appEvent(
          "item/completed",
          {
            threadId,
            turnId,
            item: {
              id: "message-1",
              type: "agentMessage",
              text: "The check passed."
            }
          },
          4
        )
      ).items
    ];
    const jsonlItems = transcriptItems([
      {
        timestamp: "2026-07-11T09:59:55.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: turnId }
      },
      {
        timestamp: "2026-07-11T09:59:56.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          client_id: clientUserMessageId,
          message: "Run the check"
        }
      },
      {
        timestamp: "2026-07-11T09:59:57.000Z",
        type: "response_item",
        payload: {
          id: "reasoning-1",
          type: "reasoning",
          summary: ["I should inspect the repository."],
          content: ["encrypted internal reasoning"]
        }
      },
      {
        timestamp: "2026-07-11T09:59:58.000Z",
        type: "response_item",
        payload: {
          id: "call-1",
          type: "function_call",
          name: "repo.search",
          call_id: "call-1",
          arguments: { query: "projection" }
        }
      },
      {
        timestamp: "2026-07-11T09:59:59.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: { matches: 3 },
          status: "completed"
        }
      },
      {
        timestamp: "2026-07-11T10:00:00.000Z",
        type: "response_item",
        payload: {
          id: "message-1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The check passed." }]
        }
      }
    ]).filter((item) => item.canonicalItemKey);

    expect(canonicalKeys(appItems).sort()).toEqual(
      canonicalKeys(jsonlItems).sort()
    );
    expect(appItems.map((item) => item.observationComponent).sort()).toEqual([
      "message",
      "message",
      "reasoning_summary",
      "tool_call",
      "tool_result"
    ]);
    expect(jsonlItems.every((item) => item.eventTime)).toBe(true);
    expect(
      jsonlItems.every(
        (item) => item.metadata.managedConversationReconciliation === true
      )
    ).toBe(true);
  });

  it("keeps role-user response context without a client id as raw provenance", () => {
    const [contextItem] = transcriptItems([
      {
        timestamp: "2026-07-11T09:59:55.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: turnId }
      },
      {
        timestamp: "2026-07-11T09:59:56.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Injected setup context" }]
        }
      }
    ]).filter((item) => item.sourceRecordType === "response_item");

    expect(contextItem).toMatchObject({
      projectionStatus: "raw_only",
      metadata: {
        managedConversationSourceRole: "ambiguous_user_context_provenance"
      }
    });
    expect(contextItem?.observationOnly).toBeUndefined();
    expect(contextItem?.canonicalItemKey).toBeUndefined();
    expect(contextItem?.canonicalStableItemId).toBeUndefined();
  });

  it("uses provider thread, turn, and item identity for external response items", () => {
    const externalItems = buildRawTranscriptConversationItems({
      records: [
        {
          timestamp: observedAt,
          type: "session_meta",
          payload: { id: threadId }
        },
        {
          timestamp: observedAt,
          type: "response_item",
          payload: {
            id: "message-external",
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Provider identified" }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId }
          }
        },
        {
          timestamp: observedAt,
          type: "response_item",
          payload: {
            id: "raw-external",
            type: "future_provider_item",
            internal_chat_message_metadata_passthrough: { turn_id: turnId }
          }
        },
        {
          timestamp: observedAt,
          type: "response_item",
          payload: {
            id: "response-item-call",
            type: "function_call",
            name: "repo.lookup",
            call_id: "provider-call",
            arguments: { query: "identity" },
            internal_chat_message_metadata_passthrough: { turn_id: turnId }
          }
        },
        {
          timestamp: observedAt,
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "provider-call",
            output: { found: true },
            internal_chat_message_metadata_passthrough: { turn_id: turnId }
          }
        }
      ],
      sessionId,
      transcriptPath: "/tmp/external-provider-items.jsonl",
      effectiveContext: effectiveCaptureContext({
        hook_event_name: "Stop",
        cwd: "/repo",
        session_id: threadId
      }),
      payload: {
        hook_event_name: "Stop",
        cwd: "/repo",
        session_id: threadId
      },
      sourceTransport: "transcript"
    }).filter((item) => item.sourceRecordType === "response_item");

    expect(externalItems).toHaveLength(4);
    expect(externalItems[0]).toMatchObject({
      externalThreadId: threadId,
      externalTurnId: turnId,
      externalItemId: "message-external",
      canonicalStableItemId: "message-external",
      observationComponent: "message",
      metadata: {
        canonicalIdentityBasis: "provider_ids",
        phase: "final_answer"
      }
    });
    expect(externalItems[0]?.metadata).not.toHaveProperty(
      "managedConversationReconciliation"
    );
    expect(externalItems[1]).toMatchObject({
      externalThreadId: threadId,
      externalTurnId: turnId,
      externalItemId: "raw-external",
      canonicalStableItemId: "raw-external",
      observationComponent: "raw",
      metadata: { canonicalIdentityBasis: "provider_ids" }
    });
    expect(externalItems[2]).toMatchObject({
      externalItemId: "response-item-call",
      canonicalStableItemId: "provider-call",
      observationComponent: "tool_call"
    });
    expect(externalItems[3]).toMatchObject({
      externalItemId: "provider-call",
      canonicalStableItemId: "provider-call",
      observationComponent: "tool_result"
    });

    const changedContent = buildRawTranscriptConversationItems({
      records: [
        {
          timestamp: "2026-07-11T10:01:00.000Z",
          type: "response_item",
          payload: {
            id: "message-external",
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Changed content" }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId }
          }
        }
      ],
      sessionId,
      transcriptPath: "/tmp/moved-external-provider-items.jsonl",
      effectiveContext: effectiveCaptureContext({
        hook_event_name: "Stop",
        session_id: threadId
      }),
      payload: { hook_event_name: "Stop", session_id: threadId },
      sourceTransport: "transcript"
    })[0]!;

    expect(changedContent.canonicalItemKey).toBe(
      externalItems[0]?.canonicalItemKey
    );
    expect(changedContent.sourceHash).not.toBe(externalItems[0]?.sourceHash);
  });

  it("keeps duplicate external event-message output as raw provenance", () => {
    const items = buildRawTranscriptConversationItems({
      records: [
        {
          timestamp: "2026-07-11T09:59:55.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: turnId }
        },
        {
          timestamp: "2026-07-11T10:00:00.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "The check passed." }
        },
        {
          timestamp: "2026-07-11T10:00:00.000Z",
          type: "response_item",
          payload: {
            id: "message-1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The check passed." }]
          }
        }
      ],
      sessionId,
      transcriptPath: "/tmp/external-duplicate-message.jsonl",
      effectiveContext: effectiveCaptureContext({
        hook_event_name: "Stop",
        session_id: threadId
      }),
      payload: { hook_event_name: "Stop", session_id: threadId },
      sourceTransport: "transcript"
    });
    const eventMessage = items.find(
      (item) => item.sourceEventType === "agent_message"
    );
    const responseMessage = items.find(
      (item) => item.sourceRecordType === "response_item"
    );

    expect(eventMessage).toMatchObject({
      observationOnly: true,
      projectionStatus: "raw_only"
    });
    expect(eventMessage?.canonicalItemKey).toBeUndefined();
    expect(responseMessage).toMatchObject({
      projectionStatus: "pending",
      observationComponent: "message",
      metadata: { canonicalIdentityBasis: "provider_ids" }
    });
    expect(responseMessage?.metadata).not.toHaveProperty(
      "managedConversationReconciliation"
    );
    expect(responseMessage?.canonicalItemKey).toMatch(
      /^conversation-item:[a-f0-9]{64}$/
    );
  });

  it("reconciles app-server and JSONL turn completion to one control item", () => {
    const appControl = adapt(
      appEvent("turn/completed", {
        threadId,
        turn: {
          id: turnId,
          status: "completed",
          completedAt: Date.parse("2026-07-11T10:00:01.000Z") / 1000
        }
      })
    ).items[0]!;
    const jsonlControl = transcriptItems([
      {
        timestamp: "2026-07-11T10:00:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: turnId }
      },
      {
        timestamp: "2026-07-11T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: turnId }
      }
    ]).find((item) => item.sourceEventType === "task_complete")!;

    expect(appControl.canonicalItemKey).toBe(jsonlControl.canonicalItemKey);
    expect(appControl.metadata.semanticControl).toBe("turn_completed");
    expect(appControl).not.toHaveProperty("canonicalSourcePriority");
    expect(appControl.projectionStatus).toBe("raw_only");
    expect(appControl.eventTime).toBe("2026-07-11T10:00:01.000Z");
    expect(jsonlControl.metadata.semanticControl).toBe("turn_completed");
    expect(jsonlControl.projectionStatus).toBe("pending");
  });

  it("fails visibly instead of guessing identity for a projectable item", () => {
    const missingItemId = adapt(
      appEvent("item/completed", {
        threadId,
        turnId,
        item: { type: "agentMessage", text: "No provider identity" }
      })
    );
    const missingTurnId = adapt(
      appEvent("item/completed", {
        threadId,
        item: {
          id: "message-without-turn",
          type: "agentMessage",
          text: "No turn identity"
        }
      })
    );

    expect(missingItemId.identityIssues).toHaveLength(1);
    expect(missingItemId.identityIssues[0]).toMatchObject({
      itemType: "agentMessage",
      externalTurnId: turnId
    });
    expect(missingItemId.identityIssues[0]?.reason).toContain(
      "provider item.id"
    );
    expect(missingItemId.items[0]).toMatchObject({
      observationOnly: true,
      projectionStatus: "raw_only",
      observationComponent: "unresolved"
    });
    expect(missingTurnId.identityIssues[0]?.reason).toContain("turn identity");
    expect(missingTurnId.items[0]?.canonicalItemKey).toBeUndefined();
  });

  it("normalizes completed app-server tools to JSONL core semantics", () => {
    const cases = [
      {
        name: "command success",
        appItem: {
          id: "command-success",
          type: "commandExecution",
          command: "printf command-success-secret",
          cwd: "/repo",
          commandActions: [
            { type: "unknown", command: "printf command-success-secret" }
          ],
          aggregatedOutput: "command-success-output",
          exitCode: 0,
          durationMs: 12,
          status: "completed"
        },
        jsonlCall: {
          name: "exec_command",
          arguments: { cmd: "printf command-success-secret" },
          status: "completed"
        },
        jsonlOutput: {
          output: { output: "command-success-output", exitCode: 0 },
          status: "completed"
        },
        expectedInput: { cmd: "printf command-success-secret" },
        expectedOutput: { output: "command-success-output", exitCode: 0 },
        expectedError: undefined,
        sensitiveText: [
          "printf command-success-secret",
          "command-success-output"
        ],
        rawOnlyText: ["/repo"]
      },
      {
        name: "command failure",
        appItem: {
          id: "command-failure",
          type: "commandExecution",
          command: "printf command-failure-secret",
          cwd: "/repo/private",
          commandActions: [
            { type: "unknown", command: "printf command-failure-secret" }
          ],
          aggregatedOutput: "command-failure-output",
          exitCode: 1,
          durationMs: 23,
          status: "failed"
        },
        jsonlCall: {
          name: "exec_command",
          arguments: { cmd: "printf command-failure-secret" },
          status: "failed"
        },
        jsonlOutput: {
          output: { output: "command-failure-output", exitCode: 1 },
          status: "failed"
        },
        expectedInput: { cmd: "printf command-failure-secret" },
        expectedOutput: { output: "command-failure-output", exitCode: 1 },
        expectedError: undefined,
        sensitiveText: [
          "printf command-failure-secret",
          "command-failure-output"
        ],
        rawOnlyText: ["/repo/private"]
      },
      {
        name: "MCP success",
        appItem: {
          id: "mcp-success",
          type: "mcpToolCall",
          server: "repo",
          tool: "lookup",
          arguments: { query: "mcp-success-input-secret" },
          appContext: { resourceUri: "repo://success" },
          result: {
            content: [{ type: "text", text: "mcp-success-output-secret" }],
            structuredContent: { detail: "mcp-structured-secret" },
            _meta: { token: "mcp-meta-secret" }
          },
          durationMs: 19,
          status: "completed"
        },
        jsonlCall: {
          name: "repo.lookup",
          arguments: { query: "mcp-success-input-secret" },
          status: "completed"
        },
        jsonlOutput: {
          output: "mcp-success-output-secret",
          status: "completed"
        },
        expectedInput: { query: "mcp-success-input-secret" },
        expectedOutput: {
          content: [{ type: "text", text: "mcp-success-output-secret" }],
          structuredContent: { detail: "mcp-structured-secret" },
          _meta: { token: "mcp-meta-secret" }
        },
        expectedError: undefined,
        sensitiveText: [
          "mcp-success-input-secret",
          "mcp-success-output-secret"
        ],
        rawOnlyText: ["mcp-structured-secret", "mcp-meta-secret"]
      },
      {
        name: "MCP failure",
        appItem: {
          id: "mcp-failure",
          type: "mcpToolCall",
          server: "repo",
          tool: "lookup",
          arguments: { query: "mcp-input-secret" },
          appContext: { resourceUri: "repo://one" },
          error: { message: "mcp-error-secret" },
          durationMs: 25,
          status: "failed"
        },
        jsonlCall: {
          name: "repo.lookup",
          arguments: { query: "mcp-input-secret" },
          status: "failed"
        },
        jsonlOutput: {
          error: { message: "mcp-error-secret" },
          status: "failed"
        },
        expectedInput: { query: "mcp-input-secret" },
        expectedOutput: undefined,
        expectedError: { message: "mcp-error-secret" },
        sensitiveText: ["mcp-input-secret", "mcp-error-secret"],
        rawOnlyText: ["repo://one"]
      },
      {
        name: "dynamic tool",
        appItem: {
          id: "dynamic-call",
          type: "dynamicToolCall",
          namespace: "koed_memory",
          tool: "scan",
          arguments: { query: "dynamic-input-secret" },
          contentItems: [{ type: "inputText", text: "dynamic-output-secret" }],
          success: true,
          durationMs: 31,
          status: "completed"
        },
        jsonlCall: {
          namespace: "koed_memory",
          name: "scan",
          arguments: { query: "dynamic-input-secret" },
          status: "completed"
        },
        jsonlOutput: {
          output: [{ type: "inputText", text: "dynamic-output-secret" }],
          status: "completed"
        },
        expectedInput: { query: "dynamic-input-secret" },
        expectedOutput: [{ type: "inputText", text: "dynamic-output-secret" }],
        expectedError: undefined,
        sensitiveText: ["dynamic-input-secret", "dynamic-output-secret"],
        rawOnlyText: ["koed_memory"]
      },
      {
        name: "collaboration tool",
        appItem: {
          id: "collab-call",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          senderThreadId: threadId,
          receiverThreadIds: ["child-thread"],
          prompt: "collab-input-secret",
          agentsStates: {
            "child-thread": {
              status: "completed",
              message: "collab-output-secret"
            }
          },
          status: "completed"
        },
        jsonlCall: {
          name: "spawnAgent",
          arguments: {
            prompt: "collab-input-secret",
            receiverThreadIds: ["child-thread"]
          },
          status: "completed"
        },
        jsonlOutput: {
          output: {
            "child-thread": {
              status: "completed",
              message: "collab-output-secret"
            }
          },
          status: "completed"
        },
        expectedInput: {
          prompt: "collab-input-secret",
          receiverThreadIds: ["child-thread"]
        },
        expectedOutput: {
          "child-thread": {
            status: "completed",
            message: "collab-output-secret"
          }
        },
        expectedError: undefined,
        sensitiveText: ["collab-input-secret", "collab-output-secret"],
        rawOnlyText: []
      }
    ];

    for (const [index, testCase] of cases.entries()) {
      const appItems = adapt(
        appEvent(
          "item/completed",
          {
            threadId,
            turnId,
            completedAtMs: Date.parse(observedAt) + index,
            item: testCase.appItem
          },
          index + 1
        )
      ).items;
      const jsonlItems = transcriptItems([
        {
          timestamp: "2026-07-11T09:59:55.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: turnId }
        },
        {
          timestamp: "2026-07-11T09:59:56.000Z",
          type: "response_item",
          payload: {
            id: testCase.appItem.id,
            type: "function_call",
            call_id: testCase.appItem.id,
            ...testCase.jsonlCall
          }
        },
        {
          timestamp: "2026-07-11T09:59:57.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: testCase.appItem.id,
            ...testCase.jsonlOutput
          }
        }
      ]).filter((item) =>
        ["tool_call", "tool_result"].includes(String(item.observationComponent))
      );

      expect(canonicalKeys(appItems), testCase.name).toEqual(
        canonicalKeys(jsonlItems)
      );
      expect(appItems.map(structuralToolSemantics), testCase.name).toEqual(
        jsonlItems.map(structuralToolSemantics)
      );
      const appCall = appItems.find(
        (item) => item.observationComponent === "tool_call"
      )!;
      const appOutput = appItems.find(
        (item) => item.observationComponent === "tool_result"
      )!;
      const callMetadata = record(appCall.metadata.toolCall);
      const outputMetadata = record(appOutput.metadata.toolCall);
      expect(callMetadata.input, testCase.name).toEqual(testCase.expectedInput);
      expect(outputMetadata.output, testCase.name).toEqual(
        testCase.expectedOutput
      );
      expect(outputMetadata.error, testCase.name).toEqual(
        testCase.expectedError
      );
      expect(callMetadata.status, testCase.name).toBe(testCase.appItem.status);
      expect(outputMetadata.status, testCase.name).toBe(
        testCase.appItem.status
      );
      expect(callMetadata.completedAtMs, testCase.name).toBe(
        Date.parse(observedAt) + index
      );
      expect(outputMetadata.completedAtMs, testCase.name).toBe(
        Date.parse(observedAt) + index
      );
      expect(callMetadata.durationMs, testCase.name).toBe(
        testCase.appItem.durationMs
      );
      expect(outputMetadata.durationMs, testCase.name).toBe(
        testCase.appItem.durationMs
      );
      for (const item of appItems) {
        expect(item.rawJson, testCase.name).toBeTruthy();
      }
      for (const sensitiveText of testCase.sensitiveText) {
        expect(JSON.stringify(appItems[0]?.rawJson), testCase.name).toContain(
          sensitiveText
        );
        expect(
          appItems.some((item) => item.rawText?.includes(sensitiveText)),
          testCase.name
        ).toBe(true);
      }
      for (const rawOnlyText of testCase.rawOnlyText) {
        expect(JSON.stringify(appItems[0]?.rawJson), testCase.name).toContain(
          rawOnlyText
        );
        expect(
          appItems.some((item) => item.rawText?.includes(rawOnlyText)),
          testCase.name
        ).toBe(false);
      }
    }
  });

  it("retains current raw ThreadItem variants for policy-driven projection", () => {
    const items = [
      {
        id: "hook-prompt",
        type: "hookPrompt",
        fragments: [{ text: "Hook context" }]
      },
      {
        id: "file-change",
        type: "fileChange",
        changes: [{ path: "/repo/a.ts", kind: "update" }],
        status: "completed"
      },
      {
        id: "subagent-activity",
        type: "subAgentActivity",
        kind: "spawned",
        agentThreadId: "child-thread",
        agentPath: "agent-1"
      },
      { id: "plan-1", type: "plan", text: "Inspect then test." },
      {
        id: "web-1",
        type: "webSearch",
        query: "Codex protocol",
        action: "search"
      },
      { id: "image-1", type: "imageView", path: "/tmp/a.png" },
      { id: "sleep-1", type: "sleep", durationMs: 50 },
      {
        id: "image-generation-1",
        type: "imageGeneration",
        status: "completed",
        result: "generated"
      },
      {
        id: "entered-review-1",
        type: "enteredReviewMode",
        review: "Review changes"
      },
      {
        id: "exited-review-1",
        type: "exitedReviewMode",
        review: "Review complete"
      },
      { id: "compact-1", type: "contextCompaction" }
    ];

    for (const [index, item] of items.entries()) {
      const appItem = adapt(
        appEvent(
          "item/completed",
          {
            threadId,
            turnId,
            completedAtMs: Date.parse(observedAt) + index,
            item
          },
          index + 1
        )
      ).items[0]!;
      const jsonlItem = transcriptItems([
        {
          timestamp: "2026-07-11T09:59:55.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: turnId }
        },
        {
          timestamp: "2026-07-11T09:59:56.000Z",
          type: "response_item",
          payload: item
        }
      ]).find((candidate) => candidate.sourceRecordType === "response_item")!;

      expect(appItem).toMatchObject({
        observationComponent: "raw",
        projectionStatus: "pending",
        metadata: { appServerItemType: item.type }
      });
      expect(jsonlItem.sourceRecordType).toBe("response_item");
      expect(appItem.rawJson).toMatchObject({ params: { item } });
      expect(jsonlItem.rawJson).toMatchObject({ payload: item });
      expect(jsonlItem.canonicalItemKey).toBe(appItem.canonicalItemKey);
      expect(jsonlItem.canonicalStableItemId).toBe(item.id);
      expect(jsonlItem.observationComponent).toBe("raw");
    }
  });

  it("pairs a final app-server message with its JSONL response item", () => {
    const appItem = adapt(
      appEvent(
        "item/completed",
        {
          threadId,
          turnId,
          completedAtMs: Date.parse(observedAt),
          item: {
            id: "message-final",
            type: "agentMessage",
            text: "Final response",
            phase: "final_answer"
          }
        },
        2
      )
    ).items[0]!;
    const jsonlItem = transcriptItems([
      {
        timestamp: "2026-07-11T09:59:55.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: turnId }
      },
      {
        timestamp: observedAt,
        type: "response_item",
        payload: {
          id: "message-final",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Final response" }]
        }
      }
    ]).find((item) => item.observationComponent === "message")!;

    expect(appItem.canonicalItemKey).toBe(jsonlItem.canonicalItemKey);
    expect(appItem.rawText).toBe(jsonlItem.rawText);
    expect(appItem.metadata.phase).toBe("final_answer");
    expect(jsonlItem.metadata.phase).toBe("final_answer");
    expect(appItem.observationKind).toBe("lifecycle_completed");
  });

  it("keeps turn identity distinct across consecutive and interrupted turns", () => {
    const first = adapt(
      appEvent("item/completed", {
        threadId,
        turnId: "turn-1",
        completedAtMs: Date.parse(observedAt),
        item: { id: "message-shared", type: "agentMessage", text: "First" }
      })
    ).items[0]!;
    const second = adapt(
      appEvent("item/completed", {
        threadId,
        turnId: "turn-2",
        completedAtMs: Date.parse(observedAt) + 1,
        item: { id: "message-shared", type: "agentMessage", text: "Second" }
      })
    ).items[0]!;
    const interrupted = adapt(
      appEvent("turn/completed", {
        threadId,
        turn: {
          id: "turn-2",
          status: "interrupted",
          completedAt: Date.parse(observedAt) / 1000
        }
      })
    ).items[0]!;

    expect(first.canonicalItemKey).not.toBe(second.canonicalItemKey);
    expect(interrupted).toMatchObject({
      projectionStatus: "raw_only",
      externalTurnId: "turn-2"
    });
    expect(interrupted.metadata.semanticControl).toBe("turn_completed");
  });

  it("builds canonical keys from provider identity rather than content", () => {
    const first = codexCanonicalConversationItemKey({
      externalThreadId: threadId,
      externalTurnId: turnId,
      stableItemId: "message-1",
      component: "message"
    });
    const same = codexCanonicalConversationItemKey({
      externalThreadId: threadId,
      externalTurnId: turnId,
      stableItemId: "message-1",
      component: "message"
    });
    const differentComponent = codexCanonicalConversationItemKey({
      externalThreadId: threadId,
      externalTurnId: turnId,
      stableItemId: "message-1",
      component: "reasoning_summary"
    });

    expect(first).toBe(same);
    expect(first).not.toBe(differentComponent);
  });
});
