import { describe, expect, it } from "vitest";
import {
  publicSquarePageSchema,
  publicSquarePublicationSchema,
  teamProjectMemberConnectionInputSchema
} from "./public-square-contract.js";

const ids = {
  team: "018f47b2-3f6d-7a45-8c52-5a1f62090001",
  project: "018f47b2-3f6d-7a45-8c52-5a1f62090002",
  publication: "018f47b2-3f6d-7a45-8c52-5a1f62090003",
  job: "018f47b2-3f6d-7a45-8c52-5a1f62090004",
  agent: "018f47b2-3f6d-7a45-8c52-5a1f62090005",
  owner: "018f47b2-3f6d-7a45-8c52-5a1f62090006"
};

const safeCard = {
  id: ids.publication,
  jobId: ids.job,
  agentId: ids.agent,
  agentName: "Research Agent",
  ownerId: ids.owner,
  ownerName: "Alex",
  projectId: ids.project,
  projectName: "Orchard",
  status: "waiting",
  lastKnownStatus: null,
  publishedAt: "2026-09-30T12:00:00.000Z",
  updatedAt: "2026-09-30T12:02:00.000Z",
  completedAt: null,
  lastSeenAt: "2026-09-30T12:02:00.000Z",
  ownerLeftTeam: false,
  sharedBrief: "Review the result before the meeting.",
  version: 1,
  canEditBrief: false,
  canRemoveRetainedBrief: false
} as const;

describe("Public Square contracts", () => {
  it("accepts a bounded sanitized activity card and rejects private source fields", () => {
    expect(publicSquarePublicationSchema.safeParse(safeCard).success).toBe(
      true
    );
    for (const field of [
      "goal",
      "prompt",
      "path",
      "model",
      "output",
      "transcript"
    ]) {
      expect(
        publicSquarePublicationSchema.safeParse({
          ...safeCard,
          [field]: "private"
        }).success
      ).toBe(false);
    }
  });

  it("requires the page Team scope and rejects malformed member Project IDs", () => {
    expect(
      publicSquarePageSchema.safeParse({
        teamId: ids.team,
        items: [safeCard],
        nextCursor: null,
        serverTime: "2026-09-30T12:03:00.000Z"
      }).success
    ).toBe(true);
    expect(
      teamProjectMemberConnectionInputSchema.safeParse({
        expectedVersion: 0,
        localProjectId: "../private/path"
      }).success
    ).toBe(false);
    expect(
      teamProjectMemberConnectionInputSchema.safeParse({
        expectedVersion: 0,
        localProjectId: "unassigned"
      }).success
    ).toBe(false);
    expect(
      teamProjectMemberConnectionInputSchema.safeParse({
        expectedVersion: 0,
        localProjectId: `lp_${"a".repeat(32)}`
      }).success
    ).toBe(true);
    expect(
      teamProjectMemberConnectionInputSchema.safeParse({
        expectedVersion: 0,
        localProjectId: `project:${ids.project}`
      }).success
    ).toBe(true);
  });
});
