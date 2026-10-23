import { describe, expect, it } from "vitest";
import { teamSharingReadSchema } from "./sharing-contract.js";

const id = "11111111-1111-4111-8111-111111111111";
const invitation = {
  kind: "invitation",
  id,
  teamId: id,
  workspaceProjectId: null,
  person: { id: null, displayName: "Invitee" },
  role: "member",
  access: "view",
  status: "invited",
  since: "2026-10-23T10:00:00.000Z",
  canCancel: false,
  origin: { actorKind: null, accessMode: null, agentDisplayName: null }
};

describe("Team sharing transport boundary", () => {
  it("rejects a Personal Conversation id at every Team origin nesting", () => {
    const base = {
      projects: [],
      invitations: [invitation],
      workspaceAccess: []
    };
    expect(teamSharingReadSchema.safeParse(base).success).toBe(true);
    expect(
      teamSharingReadSchema.safeParse({
        ...base,
        invitations: [
          {
            ...invitation,
            origin: {
              ...invitation.origin,
              source: { kind: "conversation", conversationId: id }
            }
          }
        ]
      }).success
    ).toBe(false);
  });
});
