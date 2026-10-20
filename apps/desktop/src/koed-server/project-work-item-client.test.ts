import { describe, expect, it, vi } from "vitest";
import type { WorkItem } from "@koed/shared";
import { createProjectWorkItemClient } from "./project-work-item-client.js";

const projectId = "00000000-0000-4000-8000-000000004001";
const id = "00000000-0000-4000-8000-000000004002";
const item: WorkItem = {
  id,
  projectId,
  kind: "todo",
  key: null,
  title: "Review notes",
  goal: "Review notes",
  origin: "manual",
  originRef: null,
  idempotencyKey: null,
  status: "todo",
  blockedReason: null,
  assigneeAgentId: null,
  executionId: null,
  dispatchKey: null,
  prProvider: null,
  prNumber: null,
  prUrl: null,
  prState: null,
  dueOn: null,
  doneAt: null,
  doneBy: null,
  createdBy: id,
  createdAt: "2026-10-20T09:00:00Z",
  updatedAt: "2026-10-20T09:00:00Z",
  version: 1
};
const json = (method: string, body: unknown) => ({
  method,
  body: JSON.stringify(body)
});

describe("Desktop Work Item client", () => {
  it("follows every list page and rejects foreign Project rows", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        items: [item],
        hasMore: true,
        nextCursor: "next"
      })
      .mockResolvedValueOnce({
        items: [{ ...item, id: "00000000-0000-4000-8000-000000004003" }],
        hasMore: false,
        nextCursor: null
      });
    const client = createProjectWorkItemClient(send, json);
    const result = await client({ operation: "workItemList", projectId });
    expect(result.operation).toBe("workItemList");
    if (result.operation === "workItemList")
      expect(result.items).toHaveLength(2);
    expect(send.mock.calls[1]?.[0]).toContain("cursor=next");
    const foreign = createProjectWorkItemClient(
      vi.fn().mockResolvedValue({
        items: [{ ...item, projectId: id }],
        hasMore: false,
        nextCursor: null
      }),
      json
    );
    await expect(
      foreign({ operation: "workItemList", projectId })
    ).rejects.toThrow("identity mismatch");
  });

  it("passes versioned writes and validates returned identity", async () => {
    const send = vi.fn().mockResolvedValue(item);
    const client = createProjectWorkItemClient(send, json);
    await client({
      operation: "workItemPatch",
      projectId,
      itemId: id,
      value: { version: 1, action: "mark_done" }
    });
    expect(send.mock.calls[0]?.[0]).toBe(`/v1/work-items/${id}`);
    expect(send.mock.calls[0]?.[1]).toEqual(
      json("PATCH", { version: 1, action: "mark_done" })
    );
    const foreign = createProjectWorkItemClient(
      vi.fn().mockResolvedValue({ ...item, projectId: id }),
      json
    );
    await expect(
      foreign({
        operation: "workItemPatch",
        projectId,
        itemId: id,
        value: { version: 1, action: "mark_done" }
      })
    ).rejects.toThrow("identity mismatch");
  });
});
