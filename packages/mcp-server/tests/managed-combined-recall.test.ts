import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { presentManagedCombinedRecall } from "../src/managed-combined-recall.js";
import {
  managedMemoryAnswerExecutionSchema,
  memoryAnswerInputSchema
} from "../src/memory-tool-schemas.js";

const linked = {
  linked: true as const,
  personalProjectId: randomUUID(),
  teamWorkspaceId: randomUUID(),
  workspaceProjectId: randomUUID(),
  teamBackendId: "team-a",
  projectVersion: 7
};
const answer = (team: boolean) => ({
  question_id: randomUUID(),
  citation_receipt_id: randomUUID(),
  markdown: team ? "Shared summary" : "Project and Me decision",
  citations: [
    {
      sourceType: team ? "memory_node" : "curated_memory",
      sourceId: randomUUID(),
      visibility: team ? "team" : "personal"
    }
  ]
});

describe("managed Project recall presentation", () => {
  it("keeps both verified branch identities and independent aliases", () => {
    const presented = presentManagedCombinedRecall(
      answer(false),
      answer(true),
      linked
    );
    expect(presented).toMatchObject({
      status: "completed",
      availability: "team_checked",
      selected_personal_project_id: linked.personalProjectId,
      selected_team_backend_id: linked.teamBackendId,
      selected_team_workspace_id: linked.teamWorkspaceId,
      selected_project_version: linked.projectVersion
    });
    expect(presented.recalls).toHaveLength(2);
    const recalls = z
      .array(
        z.object({ citations: z.array(z.object({ citationId: z.string() })) })
      )
      .parse(presented.recalls);
    expect(recalls[0]!.citations[0]!.citationId).not.toBe(
      recalls[1]!.citations[0]!.citationId
    );
    expect(presented.combined_text).toContain("Shared summary");
  });

  it("persists an explicit Team-not-checked notice alongside Personal evidence", () => {
    const presented = presentManagedCombinedRecall(answer(false), null, linked);
    expect(presented).toMatchObject({
      status: "partial",
      availability: "team_not_checked"
    });
    expect(presented.team_not_checked_notice).toContain(
      "Team memory was not checked"
    );
    expect(presented.recalls).toHaveLength(1);
    expect(presented.combined_text).toContain("Project and Me decision");
  });

  it("keeps the trusted selector out of the model-facing contract", () => {
    expect(() =>
      memoryAnswerInputSchema.parse({
        query: "anything",
        managed_project_recall: {
          execution_id: randomUUID(),
          execution_generation: 1
        }
      })
    ).toThrow();
    expect(
      managedMemoryAnswerExecutionSchema.parse({
        query: "anything",
        managed_project_recall: {
          execution_id: randomUUID(),
          execution_generation: 1
        }
      }).managed_project_recall
    ).toBeDefined();
    expect(() =>
      managedMemoryAnswerExecutionSchema.parse({
        query: "anything",
        search_domain: "project",
        project_id: linked.personalProjectId,
        personal_project_and_me: true,
        team_workspace_id: linked.teamWorkspaceId
      })
    ).toThrow();
  });
});
