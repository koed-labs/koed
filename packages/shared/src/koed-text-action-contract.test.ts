import { describe, expect, it } from "vitest";
import {
  koedTextActionFutureNames,
  koedTextActionInputSchemas,
  koedTextActionNames,
  koedTextActionReceipt
} from "./koed-text-action-contract.js";
import {
  workspaceProjectHumanWorkItemCreateSchema,
  workspaceProjectWorkItemCreateSchema
} from "./workspace-project-contract.js";

describe("Koed managed text actions", () => {
  it("keeps current actions distinct from future owned actions", () => {
    expect(koedTextActionNames).toContain("koed_todo_add");
    expect(koedTextActionNames).toContain("koed_chat_delete");
    for (const future of koedTextActionFutureNames)
      expect(koedTextActionNames).not.toContain(future);
  });

  it("requires bounded targets and rejects authority-bearing extras", () => {
    const input = {
      projectId: "90fd9cee-d5b1-4dda-9675-c044e4613ed7",
      title: "Problem set 4",
      dueOn: "2026-10-23"
    };
    expect(koedTextActionInputSchemas.koed_todo_add.parse(input)).toEqual(
      input
    );
    expect(
      koedTextActionInputSchemas.koed_todo_add.safeParse({
        ...input,
        ownerUserId: "forged"
      }).success
    ).toBe(false);
    expect(
      koedTextActionInputSchemas.koed_todo_add.safeParse({
        ...input,
        dueOn: "Friday"
      }).success
    ).toBe(false);
    expect(
      koedTextActionInputSchemas.koed_project_move_chats.safeParse({
        projectId: input.projectId,
        sessionIds: []
      }).success
    ).toBe(false);
    expect(
      koedTextActionInputSchemas.koed_project_move_chats.safeParse({
        projectId: input.projectId,
        sessionIds: [input.projectId, input.projectId]
      }).success
    ).toBe(false);
  });

  it("emits only a request receipt", () => {
    expect(koedTextActionReceipt("koed_project_create")).toBe(
      'Koed koed_project_create request v1: {"status":"requested"}'
    );
  });
  it("keeps Team text-action receipts out of ordinary renderer creation", () => {
    const id = "90fd9cee-d5b1-4dda-9675-c044e4613ed7";
    const input = {
      idempotencyKey: id,
      kind: "todo",
      title: "Call",
      goal: "Call Sam",
      status: "todo",
      expectedProjectVersion: 2,
      expectedMemberVersion: 1,
      textActionId: id,
      textActionNonce: "a".repeat(43)
    };
    expect(workspaceProjectWorkItemCreateSchema.safeParse(input).success).toBe(
      true
    );
    expect(
      workspaceProjectWorkItemCreateSchema.safeParse({
        ...input,
        textActionNonce: undefined
      }).success
    ).toBe(false);
    expect(
      workspaceProjectHumanWorkItemCreateSchema.safeParse(input).success
    ).toBe(false);
    expect(
      workspaceProjectHumanWorkItemCreateSchema.safeParse({
        ...input,
        textActionId: undefined
      }).success
    ).toBe(false);
    const ordinary = {
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      title: input.title,
      goal: input.goal,
      status: input.status,
      expectedProjectVersion: input.expectedProjectVersion,
      expectedMemberVersion: input.expectedMemberVersion
    };
    expect(
      workspaceProjectHumanWorkItemCreateSchema.safeParse(ordinary).success
    ).toBe(true);
  });
});
