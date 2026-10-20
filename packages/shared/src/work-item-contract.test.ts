import { describe, expect, it } from "vitest";
import {
  createWorkItemSchema,
  patchWorkItemSchema,
  workItemDateSchema
} from "./work-item-contract.js";

describe("Work Item contract", () => {
  it("accepts a calendar date and rejects invalid dates and instants", () => {
    expect(workItemDateSchema.parse("2026-10-22")).toBe("2026-10-22");
    expect(workItemDateSchema.safeParse("2026-02-29").success).toBe(false);
    expect(workItemDateSchema.safeParse("2026-10-22T00:00:00Z").success).toBe(
      false
    );
  });
  it("keeps runtime/provider authority off the owner create and patch surfaces", () => {
    const create = {
      kind: "todo",
      title: "Call",
      goal: "Call Sam",
      origin: "manual"
    };
    expect(createWorkItemSchema.safeParse(create).success).toBe(true);
    expect(
      createWorkItemSchema.safeParse({ ...create, executionId: "forged" })
        .success
    ).toBe(false);
    expect(
      createWorkItemSchema.safeParse({ ...create, key: "T-1" }).success
    ).toBe(false);
    for (const field of [
      "status",
      "assigneeAgentId",
      "executionId",
      "dispatchKey",
      "prState",
      "prUrl",
      "prProvider",
      "doneAt",
      "doneBy"
    ])
      expect(
        patchWorkItemSchema.safeParse({ version: 1, [field]: "forged" }).success
      ).toBe(false);
    expect(
      patchWorkItemSchema.safeParse({ version: 1, action: "mark_done" }).success
    ).toBe(true);
    expect(patchWorkItemSchema.safeParse({ version: 1 }).success).toBe(false);
  });
});
