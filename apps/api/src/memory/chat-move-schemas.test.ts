import { describe, expect, it } from "vitest";

import { graphSessionProjectPatchSchema } from "./graph-schemas.js";

const projectId = "d842f836-b906-4eec-b1bb-8f0065a30924";
const batchId = "a6b6b27d-d329-4527-bc9e-cf42bc4a803a";

describe("Conversation placement request schema", () => {
  it("accepts a local Project reference and an explicit placement compare-and-swap", () => {
    expect(
      graphSessionProjectPatchSchema.parse({
        action: "move",
        project: { id: "local-project-context", name: "Writing" },
        expectedProjectId: projectId
      })
    ).toEqual({
      action: "move",
      project: { id: "local-project-context", name: "Writing", path: null },
      expectedProjectId: projectId
    });
  });

  it("accepts a loose move from no Project without inventing a destination", () => {
    expect(
      graphSessionProjectPatchSchema.parse({
        action: "loose",
        expectedProjectId: null
      })
    ).toEqual({ action: "loose", expectedProjectId: null });
  });

  it("keeps legacy requests without an explicit expected placement valid", () => {
    expect(
      graphSessionProjectPatchSchema.safeParse({
        action: "move",
        project: { id: projectId, name: "Personal" }
      }).success
    ).toBe(true);
    expect(
      graphSessionProjectPatchSchema.safeParse({ action: "reset" }).success
    ).toBe(true);
  });

  it("allows a bounded text-action placement identity only on move or loose", () => {
    expect(
      graphSessionProjectPatchSchema.parse({
        action: "move",
        project: { id: projectId, name: "Writing" },
        expectedProjectId: null,
        textActionId: batchId
      })
    ).toMatchObject({
      action: "move",
      textActionId: batchId
    });
    expect(
      graphSessionProjectPatchSchema.safeParse({
        action: "reset",
        textActionId: batchId
      }).success
    ).toBe(false);
    expect(
      graphSessionProjectPatchSchema.safeParse({
        action: "undo_move",
        batchId,
        expectedProjectId: null,
        textActionId: batchId
      }).success
    ).toBe(false);
  });

  it("requires a move batch and explicit destination placement for Undo", () => {
    expect(
      graphSessionProjectPatchSchema.parse({
        action: "undo_move",
        batchId,
        expectedProjectId: null
      })
    ).toEqual({ action: "undo_move", batchId, expectedProjectId: null });

    for (const input of [
      { action: "undo_move", expectedProjectId: null },
      { action: "undo_move", batchId },
      { action: "undo_move", batchId: "not-a-uuid", expectedProjectId: null },
      { action: "undo_move", batchId, expectedProjectId: "not-a-uuid" }
    ]) {
      expect(graphSessionProjectPatchSchema.safeParse(input).success).toBe(
        false
      );
    }
  });

  it("rejects malformed placements and action-specific extra fields", () => {
    for (const input of [
      { action: "move", project: { id: "", name: "Personal" } },
      { action: "move", project: { id: "project", name: " " } },
      {
        action: "move",
        project: { id: "project", name: "Personal", grantId: batchId }
      },
      {
        action: "move",
        project: { id: "project", name: "Personal" },
        expectedProjectId: "old-project"
      },
      { action: "loose", project: { id: projectId, name: "Personal" } },
      { action: "loose", expectedProjectId: "old-project" },
      { action: "reset", batchId },
      {
        action: "undo_move",
        batchId,
        expectedProjectId: null,
        project: { id: projectId, name: "Personal" }
      }
    ]) {
      expect(graphSessionProjectPatchSchema.safeParse(input).success).toBe(
        false
      );
    }
  });
});
