import { describe, expect, it } from "vitest";
import {
  isTeamOverviewOutcomeSource,
  teamOverviewDestinationSchema,
  teamOverviewItemSchema,
  teamOverviewSourceKey
} from "./team-overview.js";

describe("Team overview native Agent contract", () => {
  it("accepts the native Team destination without private runtime identifiers", () => {
    const destination = {
      kind: "team_agent_work",
      publicationId: "8c2d53c4-23ef-4a1d-8f1a-2c0c7e71357b",
      teamProjectId: "e619352e-5c4b-4bb2-9a9b-39ee26b69c2a"
    };
    expect(teamOverviewDestinationSchema.parse(destination)).toEqual(
      destination
    );
    expect(
      teamOverviewDestinationSchema.safeParse({
        ...destination,
        executionId: "01f4fb24-282d-4652-889a-75d6ff7452d1"
      }).success
    ).toBe(false);
    expect(
      teamOverviewDestinationSchema.safeParse({
        ...destination,
        commandId: "4c71a62e-4b57-44b0-b09c-90a43efc9e0e"
      }).success
    ).toBe(false);

    expect(
      teamOverviewItemSchema.parse({
        sourceEventId: "agent-outcome:8c2d53c4-23ef-4a1d-8f1a-2c0c7e71357b",
        source: "team_agent_outcome",
        sourceId: "8c2d53c4-23ef-4a1d-8f1a-2c0c7e71357b",
        sourceRevision: "n8f23d87b",
        teamId: "4958ab8c-594b-4df0-8ec9-5ae083b21146",
        teamName: "Studio Team",
        kind: "agent_outcome",
        priority: "attention",
        state: "recent",
        title: "Published Agent work completed",
        summary: null,
        updatedAt: "2026-10-14T12:00:00.000Z",
        destination
      })
    ).toMatchObject({ source: "team_agent_outcome", kind: "agent_outcome" });
  });

  it("scopes reminder identities to the Team and only enables seen for outcomes", () => {
    expect(
      teamOverviewSourceKey({
        teamId: "4958ab8c-594b-4df0-8ec9-5ae083b21146",
        sourceEventId: "pr:8c2d53c4-23ef-4a1d-8f1a-2c0c7e71357b"
      })
    ).not.toBe(
      teamOverviewSourceKey({
        teamId: "2c57fb86-089f-48d4-bd71-f98de18a6801",
        sourceEventId: "pr:8c2d53c4-23ef-4a1d-8f1a-2c0c7e71357b"
      })
    );
    expect(isTeamOverviewOutcomeSource("team_job_outcome")).toBe(true);
    expect(isTeamOverviewOutcomeSource("team_agent_outcome")).toBe(true);
    expect(isTeamOverviewOutcomeSource("team_agent_action")).toBe(false);
  });
});
