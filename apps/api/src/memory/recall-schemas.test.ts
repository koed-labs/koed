import { describe, expect, it } from "vitest";
import {
  MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT,
  MEMORY_RETRIEVAL_HINT_MAX_LENGTH
} from "@koed/shared";
import { searchMemorySchema } from "./recall-schemas.js";

describe("searchMemorySchema", () => {
  it("accepts an opaque Team run boundary and rejects it without a Workspace", () => {
    expect(
      searchMemorySchema.parse({
        query: "follow up",
        team_workspace_id: "11111111-1111-4111-8111-111111111111",
        authorization_boundary: "server-issued"
      }).authorization_boundary
    ).toBe("server-issued");
    expect(() =>
      searchMemorySchema.parse({
        query: "follow up",
        authorization_boundary: "server-issued"
      })
    ).toThrow("authorization_boundary requires team_workspace_id");
  });
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

  it("accepts the canonical MCP exact-hint boundary", () => {
    const hints = Array.from(
      { length: MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT },
      (_, index) => `${index}`.padEnd(MEMORY_RETRIEVAL_HINT_MAX_LENGTH, "x")
    );
    expect(
      searchMemorySchema.parse({ query: "bounded hints", exact_hints: hints })
        .exact_hints
    ).toEqual(hints);
  });

  it("rejects exact hints beyond the shared count or length boundary", () => {
    expect(() =>
      searchMemorySchema.parse({
        query: "too many",
        exact_hints: Array.from(
          { length: MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT + 1 },
          () => "hint"
        )
      })
    ).toThrow();
    expect(() =>
      searchMemorySchema.parse({
        query: "too long",
        exact_hints: ["x".repeat(MEMORY_RETRIEVAL_HINT_MAX_LENGTH + 1)]
      })
    ).toThrow();
  });

  it("rejects the removed production plaintext lexical stage", () => {
    expect(() =>
      searchMemorySchema.parse({
        query: "plaintext lexical search must remain eval-only",
        retrieval_stage: "lexical_search"
      })
    ).toThrow();
  });
});
