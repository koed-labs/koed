import { randomUUID } from "node:crypto";
import type { TeamInviteRecord } from "@koed/db";
import { describe, expect, it } from "vitest";
import { legacyTeamInvite } from "./invite-serialization.js";

const legacy = {
  id: randomUUID(),
  teamId: randomUUID(),
  defaultTeamWorkspaceId: randomUUID(),
  defaultWorkspaceAccess: "write" as const,
  email: "recipient@example.test",
  normalizedEmail: "recipient@example.test",
  backendOriginHash: "bound-origin",
  role: "member" as const,
  version: 1,
  lifecycle: "pending" as const,
  createdByUserId: randomUUID(),
  acceptedByUserId: null,
  createdAt: "2026-10-21T00:00:00.000Z",
  expiresAt: "2026-10-22T00:00:00.000Z",
  acceptedAt: null,
  revokedAt: null
};
describe("strict legacy invitation response", () => {
  it.each([null, randomUUID()])(
    "preserves the v1 record with internal Project handoff %s",
    (workspaceProjectId) => {
      const internal: TeamInviteRecord = { ...legacy, workspaceProjectId };
      expect(legacyTeamInvite(internal)).toEqual(legacy);
      expect(JSON.stringify(legacyTeamInvite(internal))).toBe(
        JSON.stringify(legacy)
      );
      expect(internal.workspaceProjectId).toBe(workspaceProjectId);
    }
  );
});
