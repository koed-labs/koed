import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptRuntimeSnapshot,
  managedConversationControls,
  ManagedChatError,
  managedRequest,
  managedMessagesWithTransientOutput,
  loadManagedRecallFeedback,
  updateManagedRecallFeedback,
  managedAgentRecoveryHref,
  parseManagedChatMemoryAttribution,
  parseLaunchInstances,
  parseRuntime,
  resolveLaunchSelection,
  shouldNavigateToExecutionAfterSendFailure,
  type RuntimeSnapshot
} from "./managed-agent-chat";

afterEach(() => vi.unstubAllGlobals());

const instances = parseLaunchInstances({
  instances: [
    {
      ready: true,
      instanceId: "codex.default",
      driverId: "codex",
      models: [{ id: "luna", supportedReasoningEfforts: ["high"] }],
      capabilities: {
        permissionModes: [{ mode: "supervised", support: "supported" }]
      }
    }
  ]
});
const selection = {
  agentId: "bob",
  provider: "codex",
  model: "luna",
  effort: "High",
  permissionMode: "ask" as const
};
const execution = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: null,
  provider: "codex",
  aiClientInstanceId: "codex.default",
  model: "luna",
  reasoningEffort: "high",
  permissionMode: "supervised",
  executionGeneration: 2,
  stateVersion: 3,
  state: "running",
  lastErrorCode: null
};

describe("managed agent chat boundary", () => {
  it("loads and updates feedback through the exact local answer route", async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/studio-api/github/session") {
          return Response.json({ csrfToken: "csrf" });
        }
        requests.push({
          path,
          method: init?.method ?? "GET",
          ...(typeof init?.body === "string" ? { body: init.body } : {})
        });
        return Response.json({
          feedback: {
            rating: "down",
            comment: "Please check this",
            updatedAt: "2026-10-01T10:00:00.000Z"
          }
        });
      })
    );
    const executionId = "11111111-1111-4111-8111-111111111111";
    const answerId = "provider:22222222-2222-4222-8222-222222222222";
    await loadManagedRecallFeedback(executionId, answerId);
    await updateManagedRecallFeedback(executionId, answerId, {
      rating: "down"
    });
    expect(requests).toEqual([
      {
        path: `/studio-api/managed-conversations/${executionId}/recall-feedback/provider%3A22222222-2222-4222-8222-222222222222`,
        method: "GET"
      },
      {
        path: `/studio-api/managed-conversations/${executionId}/recall-feedback/provider%3A22222222-2222-4222-8222-222222222222`,
        method: "PUT",
        body: '{"rating":"down"}'
      }
    ]);
  });

  it("navigates to a reload-safe execution and Agent recovery URL", () => {
    expect(shouldNavigateToExecutionAfterSendFailure(true, "execution-1")).toBe(
      true
    );
    expect(
      shouldNavigateToExecutionAfterSendFailure(false, "execution-1")
    ).toBe(false);
    const recoveryUrl = new URL(
      managedAgentRecoveryHref("execution-1", "agent-1"),
      "https://studio.local"
    );
    expect(recoveryUrl.searchParams.get("execution")).toBe("execution-1");
    expect(recoveryUrl.searchParams.get("agent")).toBe("agent-1");
    expect(recoveryUrl.searchParams.get("chat")).toBe("1");
  });

  it("preserves the bounded local Memory recall error code", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf" }))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "MEMORY_RECALL_UNAVAILABLE",
              message:
                "Memory could not be checked. Retry or continue without Memory."
            }
          },
          { status: 503 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      managedRequest("/execution/prompts", { prompt: "goal" })
    ).rejects.toMatchObject({
      status: 503,
      code: "MEMORY_RECALL_UNAVAILABLE"
    } satisfies Partial<ManagedChatError>);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toContain('"prompt":"goal"');
  });
  it("strictly parses optional owner-authorized memory attribution", () => {
    expect(
      parseManagedChatMemoryAttribution({
        used: true,
        status: "available",
        citations: [{ label: "Source no longer available" }]
      })
    ).toEqual({
      used: true,
      status: "available",
      citations: [{ label: "Source no longer available" }]
    });
    expect(
      parseManagedChatMemoryAttribution({
        used: false,
        status: "unavailable",
        citations: []
      })
    ).toEqual({ used: false, status: "unavailable", citations: [] });
    expect(
      parseManagedChatMemoryAttribution({
        used: false,
        status: "skipped",
        citations: []
      })
    ).toEqual({ used: false, status: "skipped", citations: [] });
    for (const malformed of [
      { used: "true", status: "available", citations: [] },
      { used: true, status: "pending", citations: [] },
      { used: true, status: "available", citations: [{ label: 42 }] },
      { used: true, status: "available", citations: [{ label: "  " }] },
      { used: true, status: "available", citations: "Source" },
      { used: false, status: "available", citations: [{ label: "Source" }] }
    ]) {
      expect(parseManagedChatMemoryAttribution(malformed)).toBeNull();
    }
  });
  it("resolves the actual instance and preserves explicitly selected permissions", () => {
    expect(resolveLaunchSelection(selection, instances)).toMatchObject({
      permissionMode: "supervised",
      reasoningEffort: "high",
      aiClientInstanceId: "codex.default"
    });
    expect(() =>
      resolveLaunchSelection(
        { ...selection, permissionMode: "read" },
        instances
      )
    ).toThrow("read-only");
    expect(() =>
      resolveLaunchSelection(
        { ...selection, permissionMode: "full" },
        instances
      )
    ).toThrow("not available");
  });
  it("never substitutes an unavailable agent model or effort", () => {
    expect(() =>
      resolveLaunchSelection({ ...selection, model: "astra" }, instances)
    ).toThrow("not available");
    expect(() =>
      resolveLaunchSelection({ ...selection, effort: "max" }, instances)
    ).toThrow("not available");
    expect(
      resolveLaunchSelection({ ...selection, agentId: null }, instances)
    ).toMatchObject({ provider: selection.provider, model: selection.model });
  });
  it("ignores unready models and old-generation runtime items", () => {
    expect(
      parseLaunchInstances({ instances: [{ ...instances[0], ready: false }] })
    ).toEqual([]);
    const snapshot = parseRuntime({
      execution,
      items: [
        {
          id: "old",
          executionGeneration: 1,
          itemKind: "transient_output",
          state: "pending",
          payload: { text: "old" }
        }
      ]
    });
    expect(snapshot.items).toEqual([]);
    expect(snapshot.hasIndeterminatePrompt).toBe(false);
    expect(
      parseRuntime({
        execution,
        hasIndeterminatePrompt: true,
        items: []
      }).hasIndeterminatePrompt
    ).toBe(true);
    expect(
      acceptRuntimeSnapshot(
        snapshot,
        parseRuntime({
          execution: { ...execution, stateVersion: 2 },
          items: []
        })
      )
    ).toBe(false);
    expect(
      acceptRuntimeSnapshot(
        snapshot,
        parseRuntime({
          execution: { ...execution, executionGeneration: 1, stateVersion: 99 },
          items: []
        })
      )
    ).toBe(false);
  });
  it("shows only visible active-generation transient output and reconciles provider history", () => {
    const history = [
      {
        id: "provider:answer",
        role: "assistant" as const,
        content: "Canonical answer",
        createdAt: 10,
        author: null,
        providerTurnId: "turn-1",
        providerItemId: "item-1"
      }
    ];
    const runtime = parseRuntime({
      execution,
      latestCommand: {
        id: "prompt-1",
        commandKind: "prompt",
        state: "running"
      },
      items: [
        {
          id: "runtime-1",
          executionGeneration: execution.executionGeneration,
          itemKind: "transient_output",
          state: "pending",
          providerTurnId: "turn-1",
          providerItemId: "item-1",
          updatedAt: new Date(20).toISOString(),
          presentation: {
            mode: "expanded",
            renderer: "message",
            policyKey: "transient_output"
          },
          payload: { text: "Partial answer" }
        }
      ]
    });
    expect(
      managedMessagesWithTransientOutput(execution.id, runtime, history)
    ).toEqual(history);
    expect(
      managedMessagesWithTransientOutput("other-execution", runtime, [])
    ).toEqual([]);
    const uncertainRuntime: RuntimeSnapshot = {
      ...runtime,
      latestCommand: { ...runtime.latestCommand!, state: "indeterminate" }
    };
    expect(
      managedMessagesWithTransientOutput(execution.id, uncertainRuntime, [])
    ).toEqual([
      expect.objectContaining({
        id: "transient:runtime-1",
        content: "Partial answer",
        providerTurnId: "turn-1",
        providerItemId: "item-1"
      })
    ]);
    expect(
      managedMessagesWithTransientOutput(
        execution.id,
        uncertainRuntime,
        history
      )
    ).toEqual(history);
    expect(
      managedMessagesWithTransientOutput(
        execution.id,
        {
          ...runtime,
          latestCommand: { ...runtime.latestCommand!, state: "completed" }
        },
        []
      )
    ).toEqual([]);

    const visible = managedMessagesWithTransientOutput(
      execution.id,
      parseRuntime({
        execution,
        latestCommand: {
          id: "prompt-1",
          commandKind: "prompt",
          state: "dispatching"
        },
        items: [
          {
            id: "runtime-2",
            executionGeneration: execution.executionGeneration,
            itemKind: "transient_output",
            state: "pending",
            providerTurnId: "turn-2",
            providerItemId: "item-2",
            presentation: {
              mode: "expanded",
              renderer: "message",
              policyKey: "transient_output"
            },
            payload: {
              text: "Partial /Users/jacobo/private.txt token=privatevalue"
            }
          }
        ]
      }),
      []
    );
    expect(visible).toEqual([
      expect.objectContaining({
        id: "transient:runtime-2",
        content: "Partial [local path hidden] token=[redacted]",
        providerTurnId: "turn-2",
        providerItemId: "item-2"
      })
    ]);

    const withheldFooter = managedMessagesWithTransientOutput(
      execution.id,
      parseRuntime({
        execution,
        latestCommand: {
          id: "prompt-1",
          commandKind: "prompt",
          state: "dispatching"
        },
        items: [
          {
            id: "runtime-footer",
            executionGeneration: execution.executionGeneration,
            itemKind: "transient_output",
            state: "pending",
            providerTurnId: "turn-footer",
            presentation: {
              mode: "expanded",
              renderer: "message",
              policyKey: "transient_output"
            },
            payload: {
              text: "Visible answer\n<!-- koed-memory-attribution:v1:partial"
            }
          }
        ]
      }),
      []
    );
    expect(withheldFooter[0]?.content).toBe("Visible answer");

    for (const item of [
      {
        id: "old",
        executionGeneration: 1,
        itemKind: "transient_output",
        state: "pending",
        providerTurnId: "old-turn",
        presentation: {
          mode: "expanded",
          renderer: "message",
          policyKey: "transient_output"
        },
        payload: { text: "old generation" }
      },
      {
        id: "hidden",
        executionGeneration: 2,
        itemKind: "transient_output",
        state: "pending",
        providerTurnId: "hidden-turn",
        presentation: {
          mode: "hidden",
          renderer: "message",
          policyKey: "transient_output"
        },
        payload: { text: "hidden" }
      },
      {
        id: "tool",
        executionGeneration: 2,
        itemKind: "transient_output",
        state: "pending",
        providerTurnId: "tool-turn",
        presentation: {
          mode: "expanded",
          renderer: "tool",
          policyKey: "transient_output"
        },
        payload: { text: "tool details" }
      }
    ]) {
      const guarded = parseRuntime({
        execution,
        latestCommand: {
          id: "prompt-1",
          commandKind: "prompt",
          state: "running"
        },
        items: [item]
      });
      expect(
        managedMessagesWithTransientOutput(execution.id, guarded, [])
      ).toEqual([]);
    }
  });
});

describe("managed conversation controls", () => {
  it("preserves only a valid server cancellation grant and defaults older or malformed DTOs to false", () => {
    const parseGrant = (value: unknown) =>
      parseRuntime({
        execution,
        latestCommand: {
          id: "prompt-1",
          commandKind: "prompt",
          state: "queued",
          canCancelBeforeClaim: value
        }
      }).latestCommand?.canCancelBeforeClaim;
    expect(parseGrant(true)).toBe(true);
    expect(parseGrant(false)).toBe(false);
    expect(parseGrant("true")).toBe(false);
    expect(parseGrant({})).toBe(false);
    expect(
      parseRuntime({
        execution,
        latestCommand: {
          id: "prompt-1",
          commandKind: "prompt",
          state: "queued"
        }
      }).latestCommand?.canCancelBeforeClaim
    ).toBe(false);
  });

  it("offers cancellation only for a server-authorized queued prompt and Stop only after claim", () => {
    const command = (state: string, canCancelBeforeClaim?: boolean) => ({
      id: "11111111-1111-4111-8111-111111111111",
      state,
      commandKind: "prompt",
      ...(canCancelBeforeClaim === undefined ? {} : { canCancelBeforeClaim }),
      lastErrorCode: null
    });
    expect(managedConversationControls(command("queued", true))).toEqual({
      canCancelPendingPrompt: true,
      canInterrupt: false
    });
    for (const queued of [command("queued", false), command("queued")]) {
      expect(managedConversationControls(queued)).toEqual({
        canCancelPendingPrompt: false,
        canInterrupt: false
      });
    }
    expect(managedConversationControls(command("running", true))).toEqual({
      canCancelPendingPrompt: false,
      canInterrupt: true
    });
    expect(managedConversationControls(command("dispatching", true))).toEqual({
      canCancelPendingPrompt: false,
      canInterrupt: true
    });
    expect(managedConversationControls(command("completed"))).toEqual({
      canCancelPendingPrompt: false,
      canInterrupt: false
    });
    expect(managedConversationControls(null)).toEqual({
      canCancelPendingPrompt: false,
      canInterrupt: false
    });
  });
});
