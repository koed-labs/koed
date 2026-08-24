import { describe, expect, it } from "vitest";

import {
  commandEntriesForSnapshot,
  type DesktopCommand
} from "./command-palette.js";

const snapshot = {
  navigation: {
    personalOwner: { id: "personal-user" },
    personal: {
      channels: [
        {
          id: "personal-active",
          name: "Ideas",
          lifecycle: "active"
        },
        {
          id: "personal-purged",
          name: "Gone",
          lifecycle: "purged"
        }
      ]
    },
    teamPrincipal: { id: "team-user" },
    teams: [
      {
        id: "team-active",
        name: "Alpha",
        lifecycle: "active",
        people: [],
        directMessages: [
          {
            id: "dm-active",
            name: null,
            lifecycle: "active",
            participants: [
              { id: "team-user", displayName: "Me" },
              { id: "colleague", displayName: "Colleague" }
            ]
          }
        ],
        workspaces: [
          {
            id: "workspace-active",
            name: "Product",
            lifecycle: "active",
            channels: [
              {
                id: "channel-active",
                name: "Launch",
                lifecycle: "active"
              }
            ]
          }
        ]
      },
      {
        id: "team-revoked",
        name: "Revoked",
        lifecycle: "tombstoned",
        directMessages: [],
        workspaces: []
      }
    ]
  }
};

const ids = (commands: readonly DesktopCommand[]) =>
  commands.map(({ id }) => id);

describe("commandEntriesForSnapshot", () => {
  it("uses only currently authorized snapshot destinations", () => {
    const commands = commandEntriesForSnapshot(snapshot as never);
    expect(
      commands.find(({ id }) => id === "route:personal-memory-notes")
    ).toMatchObject({
      destination: {
        kind: "route",
        route: { kind: "personal-memory-notes" }
      },
      label: "Notes"
    });
    expect(ids(commands)).toContain("selection:team:team-active:people");
    expect(ids(commands)).toContain(
      "selection:team:team-active:workspace:workspace-active:channel:channel-active"
    );
    expect(ids(commands)).not.toContain("selection:personal:personal-purged");
    expect(commands.some(({ scope }) => scope.includes("Revoked"))).toBe(false);
  });

  it("evicts Team commands immediately with the authoritative snapshot", () => {
    const commands = commandEntriesForSnapshot({
      ...snapshot,
      navigation: {
        ...snapshot.navigation,
        teams: []
      }
    } as never);
    expect(ids(commands).some((id) => id.startsWith("selection:team:"))).toBe(
      false
    );
    expect(ids(commands)).toContain("route:personal-memory");
  });

  it("indexes full destinations only for the active Team", () => {
    const commands = commandEntriesForSnapshot(
      {
        ...snapshot,
        navigation: {
          ...snapshot.navigation,
          teams: [
            snapshot.navigation.teams[0]!,
            {
              ...snapshot.navigation.teams[0]!,
              id: "team-other",
              name: "Other",
              workspaces: [
                {
                  ...snapshot.navigation.teams[0]!.workspaces[0]!,
                  id: "workspace-other",
                  channels: [
                    {
                      ...snapshot.navigation.teams[0]!.workspaces[0]!
                        .channels[0]!,
                      id: "channel-other"
                    }
                  ]
                }
              ]
            }
          ]
        }
      } as never,
      "team-active"
    );

    expect(ids(commands)).toContain("selection:team:team-active:people");
    expect(ids(commands)).toContain("selection:team:team-other:people");
    expect(ids(commands)).toContain(
      "selection:team:team-active:workspace:workspace-active:channel:channel-active"
    );
    expect(ids(commands)).not.toContain(
      "selection:team:team-other:workspace:workspace-other:channel:channel-other"
    );
  });
});
