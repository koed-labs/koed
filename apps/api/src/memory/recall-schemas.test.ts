import { describe, expect, it } from "vitest";
import { searchMemorySchema } from "./recall-schemas.js";

describe("searchMemorySchema", () => {
  it("accepts a recency window for memory recall", () => {
    const parsed = searchMemorySchema.parse({
      query: "What did we discuss recently?",
      recent_days: "30"
    });

    expect(parsed.recent_days).toBe(30);
    expect(parsed.source_after).toBeUndefined();
    expect(parsed.source_before).toBeUndefined();
  });

  it("keeps Team Workspace authorization separate from project workspace matching", () => {
    const teamWorkspaceId = "11111111-1111-4111-8111-111111111111";
    const parsed = searchMemorySchema.parse({
      query: "What can this Workspace see?",
      search_domain: "project",
      project_id: "/fixture/projects/koed",
      team_workspace_id: teamWorkspaceId
    });

    expect(parsed.project_id).toBe("/fixture/projects/koed");
    expect(parsed.team_workspace_id).toBe(teamWorkspaceId);
  });

  it("rejects ambiguous recency and explicit source date bounds", () => {
    expect(() =>
      searchMemorySchema.parse({
        query: "What did we discuss recently?",
        recent_days: 30,
        source_after: "2026-05-01T00:00:00.000Z"
      })
    ).toThrow(/recent_days cannot be combined/);
  });

  it("rejects inverted explicit source date bounds", () => {
    expect(() =>
      searchMemorySchema.parse({
        query: "What did we discuss in May?",
        source_after: "2026-05-10T00:00:00.000Z",
        source_before: "2026-05-01T00:00:00.000Z"
      })
    ).toThrow(/source_after must be earlier/);
  });
});
