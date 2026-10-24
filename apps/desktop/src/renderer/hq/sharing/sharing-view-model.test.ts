import { describe, expect, it } from "vitest";
import type { SharingOverview } from "@koed/shared/sharing-contract";
import {
  sharingGroups,
  sharingRows,
  standaloneSharing,
  wordStartMatch
} from "./sharing-view-model.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const backend = (
  backendId: string,
  n: number
): SharingOverview["backends"][number] => ({
  backendId,
  status: "available",
  reachedAt: "2026-10-24T10:00:00.000Z",
  data: {
    projects: [
      {
        id: id(n),
        teamId: id(1),
        teamWorkspaceId: id(2),
        name: "Investor deck",
        owner: { id: id(3), displayName: "You" },
        group: { id: id(1), name: "Koed" },
        ownedByMe: true,
        members: [
          {
            kind: "workspace_access",
            teamId: id(1),
            teamWorkspaceId: id(2),
            workspaceProjectId: id(n),
            person: { id: id(4), displayName: "Sam" },
            how: "direct",
            access: "view",
            status: "joined",
            since: "2026-10-24T09:00:00.000Z",
            version: 1,
            origin: {
              actorKind: null,
              accessMode: null,
              agentDisplayName: null,
              source: { kind: "not_recorded" }
            },
            canRemove: true
          }
        ],
        invitations: [],
        counts: { members: 1, invitations: 0 },
        contentCounts: {
          sources: 1,
          toDos: 2,
          chatSummaries: 1,
          sharedMemoryItems: 2
        }
      }
    ],
    invitations: [],
    workspaceAccess: []
  },
  incomingInvitations: []
});

describe("HQ-723 sharing projection", () => {
  it("S8 filters at word starts, so mar finds Mark but not Omar", () => {
    expect(wordStartMatch("Mark", "mar")).toBe(true);
    expect(wordStartMatch("Omar", "mar")).toBe(false);
    expect(wordStartMatch("Investor deck", "dec")).toBe(true);
  });
  it("S3 keeps backend-qualified identities and direct Project access without inventing group inheritance", () => {
    const rows = sharingRows({
      backends: [backend("team-a", 10), backend("team-b", 11)]
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.key).not.toBe(rows[1]?.key);
    expect(rows.map((row) => row.how)).toEqual(["direct", "direct"]);
    expect(rows[0]?.contentCounts).toEqual({
      sources: 1,
      toDos: 2,
      chatSummaries: 1,
      sharedMemoryItems: 2
    });
  });
  it("N27 excludes records from an unavailable Team backend", () => {
    expect(
      sharingRows({
        backends: [
          backend("team-a", 10),
          {
            backendId: "team-b",
            status: "unavailable",
            lastReachedAt: null,
            reason: "unreachable"
          }
        ]
      })
    ).toHaveLength(1);
  });
  it("S2 keeps same-name people and same Project IDs separate across backends", () => {
    const rows = sharingRows({
      backends: [backend("team-a", 10), backend("team-b", 10)]
    });
    expect(sharingGroups(rows, "person")).toHaveLength(2);
    expect(sharingGroups(rows, "project")).toHaveLength(2);
    expect(sharingGroups(rows, "person").map((group) => group.key)).toEqual([
      `team-a:${id(4)}`,
      `team-b:${id(4)}`
    ]);
  });
  it("S2 includes standalone Workspace access and invitations without duplicating Project rows", () => {
    const data = backend("team-a", 10);
    if (data.status !== "available")
      throw new Error("fixture must be available");
    const projectAccess = data.data.projects[0]!.members[0]!;
    data.data.workspaceAccess = [
      {
        ...projectAccess,
        workspaceProjectId: null,
        workspaceName: "Design Workspace"
      },
      projectAccess
    ];
    const standaloneInvite: (typeof data.data.invitations)[number] = {
      kind: "invitation",
      id: id(20),
      teamId: id(1),
      workspaceProjectId: null,
      teamName: "Koed",
      workspaceName: "Design Workspace",
      person: { id: id(21), displayName: "Taylor" },
      role: "member",
      access: "view",
      status: "invited",
      since: "2026-10-24T09:00:00.000Z",
      origin: {
        actorKind: null,
        accessMode: null,
        agentDisplayName: null,
        source: { kind: "not_recorded" }
      },
      canCancel: true
    };
    data.data.invitations = [
      standaloneInvite,
      { ...standaloneInvite, id: id(22), workspaceProjectId: id(10) }
    ];
    const standalone = standaloneSharing({ backends: [data] });
    expect(standalone[0]?.access).toHaveLength(1);
    expect(standalone[0]?.invitations).toHaveLength(1);
    expect(standalone[0]?.access[0]?.workspaceName).toBe("Design Workspace");
  });
});
