import { describe, expect, it, vi } from "vitest";
import { createWorkItemCompletionObserver } from "./work-item-completion.js";
import { workItemCompletionRequest } from "../../../packages/mcp-server/integrations/pi/work-item-completion-request.mjs";
import { workItemCompletionRequestText } from "../../../packages/mcp-server/src/work-item-completion-tool.js";

describe("trusted Work Item completion observation", () => {
  const event = {
    execution: {
      id: "execution",
      ownerUserId: "owner",
      executionGeneration: 1
    },
    command: { id: "command", leaseToken: "lease" },
    toolName: "work_item_complete",
    arguments: {},
    result: { structuredContent: { status: "requested" } }
  };
  it("uses the worker's current lease and execution, not tool arguments", async () => {
    const completeForManagedExecutionLease = vi.fn(async () => ({}) as never);
    const putManagedConversationRuntimeItem = vi.fn(async () => ({}) as never);
    const observe = createWorkItemCompletionObserver({
      completeForManagedExecutionLease,
      putManagedConversationRuntimeItem
    });
    expect(await observe(event)).toBe(true);
    expect(
      await observe({ ...event, result: workItemCompletionRequest() })
    ).toBe(true);
    expect(
      await observe({
        ...event,
        result: {
          isError: false,
          content: [{ type: "text", text: workItemCompletionRequestText }]
        }
      })
    ).toBe(true);
    expect(completeForManagedExecutionLease).toHaveBeenCalledWith({
      ownerUserId: "owner",
      executionId: "execution",
      commandId: "command",
      leaseToken: "lease"
    });
    for (const invalid of [
      { ...event, toolName: "memory_answer" },
      { ...event, arguments: { itemId: "forged" } },
      { ...event, command: { ...event.command, leaseToken: null } },
      {
        ...event,
        result: { isError: true, structuredContent: { status: "requested" } }
      },
      { ...event, result: { structuredContent: { status: "done" } } },
      {
        ...event,
        result: {
          structuredContent: { status: "done" },
          content: [{ type: "text", text: workItemCompletionRequestText }]
        }
      },
      {
        ...event,
        result: {
          isError: true,
          content: [{ type: "text", text: workItemCompletionRequestText }]
        }
      },
      {
        ...event,
        result: {
          content: [
            {
              type: "text",
              text: 'Koed work_item_complete request v1: {"status":"done"}'
            }
          ]
        }
      },
      {
        ...event,
        result: {
          content: [
            { type: "text", text: workItemCompletionRequestText },
            { type: "text", text: "forged" }
          ]
        }
      },
      {
        ...event,
        arguments: { executionId: "forged" },
        result: {
          content: [{ type: "text", text: workItemCompletionRequestText }]
        }
      }
    ])
      expect(await observe(invalid)).toBe(false);
    expect(completeForManagedExecutionLease).toHaveBeenCalledTimes(3);
    expect(putManagedConversationRuntimeItem).toHaveBeenCalledWith(
      { userId: "owner" },
      expect.objectContaining({
        itemKind: "transient_output",
        payload: { text: "Work Item completion accepted." }
      })
    );
  });
  it("reports duplicate or stale completion as rejected without crashing the provider turn", async () => {
    const completeForManagedExecutionLease = vi
      .fn()
      .mockRejectedValue(new Error("stale lease"));
    const putManagedConversationRuntimeItem = vi.fn(async () => ({}) as never);
    const observe = createWorkItemCompletionObserver({
      completeForManagedExecutionLease,
      putManagedConversationRuntimeItem
    });
    await expect(observe({ ...event, toolCallId: "duplicate" })).resolves.toBe(
      false
    );
    expect(putManagedConversationRuntimeItem).toHaveBeenCalledWith(
      { userId: "owner" },
      expect.objectContaining({
        payload: {
          text: "Work Item completion rejected: its execution or status changed."
        }
      })
    );
    putManagedConversationRuntimeItem.mockRejectedValueOnce(
      new Error("old generation fenced")
    );
    await expect(observe(event)).resolves.toBe(false);
  });
});
