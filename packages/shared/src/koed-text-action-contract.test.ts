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
    expect(koedTextActionNames).toContain("koed_deck_make");
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
  it("offers bounded Project and group leave proposals without caller authority", () => {
    const id = "90fd9cee-d5b1-4dda-9675-c044e4613ed7";
    expect(koedTextActionNames).toContain("koed_project_leave");
    expect(koedTextActionNames).toContain("koed_workspace_leave");
    expect(
      koedTextActionInputSchemas.koed_project_leave.parse({ projectId: id })
    ).toEqual({ projectId: id });
    expect(
      koedTextActionInputSchemas.koed_workspace_leave.parse({ teamId: id })
    ).toEqual({ teamId: id });
    expect(
      koedTextActionInputSchemas.koed_project_leave.safeParse({
        projectId: id,
        approved: true,
        backendId: id
      }).success
    ).toBe(false);
    expect(
      koedTextActionInputSchemas.koed_workspace_leave.safeParse({
        teamId: id,
        expectedMembershipVersion: 1
      }).success
    ).toBe(false);
    expect(koedTextActionReceipt("koed_workspace_leave")).toBe(
      'Koed koed_workspace_leave request v1: {"status":"requested"}'
    );
  });
  it("requires explicit bounded Deck scope and supplied cards, not model authority", () => {
    const request = {
      projectId: "90fd9cee-d5b1-4dda-9675-c044e4613ed7",
      title: "Chapter 7",
      scope: "Chapter 7; exclude topics not on the midterm",
      madeFrom: "Syllabus and chapter notes",
      cards: [
        {
          question: "What is X?",
          answer: "X is Y [m:1].",
          sourceRef: "Chapter 7"
        }
      ]
    };
    const schema = koedTextActionInputSchemas.koed_deck_make;
    expect(schema.parse(request).scope).toContain("exclude");
    expect(schema.safeParse({ ...request, cards: [] }).success).toBe(false);
    expect(schema.safeParse({ ...request, scope: "" }).success).toBe(false);
    expect(
      schema.safeParse({ ...request, createdByAgentId: request.projectId })
        .success
    ).toBe(false);
    expect(
      schema.safeParse({ ...request, teamBackendId: request.projectId }).success
    ).toBe(false);
  });
  it("keeps Scheduled Job text requests exact and browser-safe", () => {
    const create = {
      title: "Morning brief",
      instruction: "Summarize AI news",
      schedule: { kind: "weekdays", at: "08:00", tz: "Europe/Oslo" }
    };
    expect(
      koedTextActionInputSchemas.koed_job_create.safeParse(create).success
    ).toBe(true);
    expect(
      koedTextActionInputSchemas.koed_job_create.safeParse({
        ...create,
        schedule: { ...create.schedule, at: "8am" }
      }).success
    ).toBe(false);
    expect(
      koedTextActionInputSchemas.koed_job_create.safeParse({
        ...create,
        agentId: "forged"
      }).success
    ).toBe(false);
    expect(
      koedTextActionInputSchemas.koed_job_pause.safeParse({
        title: "Morning brief",
        paused: true
      }).success
    ).toBe(true);
    expect(
      koedTextActionInputSchemas.koed_job_pause.safeParse({
        title: "Morning",
        paused: true,
        jobId: "forged"
      }).success
    ).toBe(false);
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
