import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  issueMemoryAnswerAuthorizationBoundary,
  MemoryAnswerAuthorizationBoundaryError,
  verifyMemoryAnswerAuthorizationBoundary
} from "./memory-answer-authorization-boundary.js";

const secret = "test-only-boundary-secret";
const subjectUserId = randomUUID();
const teamWorkspaceId = randomUUID();
const boundary = {
  teamId: randomUUID(),
  teamVersion: 3,
  teamWorkspaceId,
  workspaceVersion: 4,
  membershipVersion: 5,
  workspaceAccessVersion: 6,
  userRowVersion: "424242",
  shareGrantIds: [randomUUID(), randomUUID()]
};

describe("Memory Answer authorization boundary", () => {
  it("round-trips an exact server-issued Team boundary", () => {
    const now = new Date("2026-08-11T01:00:00.000Z");
    const token = issueMemoryAnswerAuthorizationBoundary({
      secret,
      subjectUserId,
      boundary,
      now
    });

    expect(
      verifyMemoryAnswerAuthorizationBoundary({
        token,
        secret,
        subjectUserId,
        teamWorkspaceId,
        now
      })
    ).toEqual(boundary);
  });

  it("rejects tampering, cross-user replay, cross-Workspace replay, and expiry", () => {
    const now = new Date("2026-08-11T01:00:00.000Z");
    const token = issueMemoryAnswerAuthorizationBoundary({
      secret,
      subjectUserId,
      boundary,
      now
    });
    const attempts = [
      { token: `${token.slice(0, -1)}x`, subjectUserId, teamWorkspaceId, now },
      { token, subjectUserId: randomUUID(), teamWorkspaceId, now },
      { token, subjectUserId, teamWorkspaceId: randomUUID(), now },
      {
        token,
        subjectUserId,
        teamWorkspaceId,
        now: new Date("2026-08-11T01:16:00.000Z")
      }
    ];

    for (const attempt of attempts) {
      expect(() =>
        verifyMemoryAnswerAuthorizationBoundary({ secret, ...attempt })
      ).toThrow(MemoryAnswerAuthorizationBoundaryError);
    }
  });
});
