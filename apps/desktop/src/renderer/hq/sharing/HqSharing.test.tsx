import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HqSharing } from "./HqSharing.js";
import { SharingStore } from "./sharing-store.js";
import type { SharingOverview } from "@koed/shared/sharing-contract";

describe("HQ-723 Sharing owner boundary", () => {
  it("N27 hides a prior owner's named member before the owner effect runs", async () => {
    const id = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const overview: SharingOverview = {
      backends: [
        {
          backendId: "secret-team",
          status: "available",
          reachedAt: "2026-10-24T10:00:00.000Z",
          data: {
            projects: [
              {
                id: id(1),
                teamId: id(2),
                teamWorkspaceId: id(3),
                name: "Secret Project",
                owner: { id: id(4), displayName: "Owner" },
                group: { id: id(2), name: "Secret Team" },
                ownedByMe: true,
                members: [
                  {
                    kind: "workspace_access",
                    teamId: id(2),
                    teamWorkspaceId: id(3),
                    workspaceProjectId: id(1),
                    person: { id: id(5), displayName: "Private Member" },
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
                    canRemove: false
                  }
                ],
                invitations: [],
                counts: { members: 1, invitations: 0 }
              }
            ],
            invitations: [],
            workspaceAccess: []
          },
          incomingInvitations: []
        }
      ]
    };
    const store = new SharingStore({ read: async () => overview });
    store.setOwner("owner-a", "profile-a");
    store.start();
    await store.refresh();
    const oldHtml = renderToStaticMarkup(
      <HqSharing store={store} ownerId="owner-a" profileKey="profile-a" />
    );
    expect(oldHtml).toContain("Private Member");
    const html = renderToStaticMarkup(
      <HqSharing store={store} ownerId="owner-b" profileKey="profile-b" />
    );
    expect(html).toContain("Sharing is unavailable");
    expect(html).not.toContain("Private Member");
    expect(html).not.toContain("Secret Project");
    store.stop();
  });
  it("S9 Manage filter keeps an identical Project ID on another backend out", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    const makeBackend = (
      backendId: string,
      personName: string
    ): SharingOverview["backends"][number] => ({
      backendId,
      status: "available",
      reachedAt: "2026-10-24T10:00:00.000Z",
      data: {
        projects: [
          {
            id: projectId,
            teamId: "00000000-0000-4000-8000-000000000002",
            teamWorkspaceId: "00000000-0000-4000-8000-000000000003",
            name: "Same Project",
            owner: {
              id: "00000000-0000-4000-8000-000000000004",
              displayName: "Owner"
            },
            group: { id: "00000000-0000-4000-8000-000000000002", name: "Team" },
            ownedByMe: true,
            members: [
              {
                kind: "workspace_access",
                teamId: "00000000-0000-4000-8000-000000000002",
                teamWorkspaceId: "00000000-0000-4000-8000-000000000003",
                workspaceProjectId: projectId,
                person: {
                  id:
                    backendId === "team-a"
                      ? "00000000-0000-4000-8000-000000000005"
                      : "00000000-0000-4000-8000-000000000006",
                  displayName: personName
                },
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
                canRemove: false
              }
            ],
            invitations: [],
            counts: { members: 1, invitations: 0 }
          }
        ],
        invitations: [],
        workspaceAccess: []
      },
      incomingInvitations: []
    });
    const store = new SharingStore({
      read: async () => ({
        backends: [makeBackend("team-a", "Alice"), makeBackend("team-b", "Bob")]
      })
    });
    store.setOwner("owner", "profile");
    store.start();
    await store.refresh();
    const html = renderToStaticMarkup(
      <HqSharing
        store={store}
        ownerId="owner"
        profileKey="profile"
        projectFilter={{
          id: projectId,
          name: "Same Project",
          backendId: "team-a"
        }}
      />
    );
    expect(html).toContain("Alice");
    expect(html).not.toContain("Bob");
    store.stop();
  });
});
