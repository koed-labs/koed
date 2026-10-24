import type {
  PersonalSharingRead,
  SharingOverview
} from "@koed/shared/sharing-contract";
import type { SharingDesktopApi } from "./ipc/sharing-protocol.js";

// Every Team-enabled HQ fixture exposes the same read-only Desktop bridge.
// Only the Sharing-specific capture supplies populated example data.
export const emptySharingBrowserApi: SharingDesktopApi = {
  read: async () => ({ backends: [] })
};

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ownerId = "00000000-0000-4000-8000-000000000109";
const workspaceProjectId = "00000000-0000-4000-8000-000000007122";
const backendId = "fixture-team-backend";
const origin = (kind: "not_recorded" | "conversation" = "not_recorded") => ({
  actorKind: "person" as const,
  accessMode: "ask_first" as const,
  agentDisplayName: null,
  source:
    kind === "conversation"
      ? { kind: "conversation" as const, conversationId: id(2045) }
      : { kind: "not_recorded" as const }
});
const person = (displayName: string, n: number) => ({ id: id(n), displayName });
const names = [
  "Sam",
  "Mark",
  "Omar",
  "Lucia",
  "Ines",
  "Lukas",
  "Nadia",
  "Ravi",
  "Theo"
];
const project = (
  n: number,
  name: string,
  people: string[],
  recentEmpty: boolean
): PersonalSharingRead["projects"][number] => ({
  id: n === 10 ? workspaceProjectId : id(n),
  teamId: id(1),
  teamWorkspaceId: id(2),
  name,
  owner: { id: ownerId, displayName: "You" },
  group: { id: id(1), name: "Koed team" },
  ownedByMe: true,
  members: people.map((displayName, index) => ({
    kind: "workspace_access",
    teamId: id(1),
    teamWorkspaceId: id(2),
    workspaceProjectId: n === 10 ? workspaceProjectId : id(n),
    person: person(displayName, names.indexOf(displayName) + 20),
    how: "direct",
    access: "view",
    status: "joined",
    since: new Date(
      Date.now() -
        (recentEmpty || displayName !== "Sam" ? 48 * 60 + index : 40) * 60_000
    ).toISOString(),
    version: 1,
    origin:
      displayName === "Sam"
        ? {
            actorKind: "agent_on_behalf",
            accessMode: "full_access",
            agentDisplayName: "Cooper",
            source: { kind: "conversation", conversationId: id(2045) }
          }
        : origin(),
    canRemove: displayName !== "Theo"
  })),
  invitations: [],
  counts: { members: people.length, invitations: 0 },
  contentCounts: {
    sources: 1,
    toDos: 2,
    chatSummaries: 1,
    sharedMemoryItems: 2
  }
});

/** Populated Sharing data stays isolated to the Sharing-specific query. */
type IncomingInvitations = Extract<
  SharingOverview["backends"][number],
  { status: "available" }
>["incomingInvitations"];
export function createHq723SharingFixture(
  incoming: () => IncomingInvitations,
  joined: () => boolean,
  restoreInvitation: () => void
) {
  let unavailable = true;
  let recentEmpty = false;
  let priya = false;
  const removed = new Set<string>();
  const trace = { reads: 0 };
  const refresh = () => window.dispatchEvent(new Event("focus"));
  const overview = (): SharingOverview => {
    const owned = [
      project(
        10,
        "Investor deck",
        ["Sam", "Mark", "Omar", "Lucia"],
        recentEmpty
      ),
      project(11, "Koed mobile", ["Ines", "Lukas", "Nadia"], recentEmpty),
      project(12, "Japan trip", ["Ravi", "Theo"], recentEmpty)
    ];
    for (const entry of owned) {
      entry.members = entry.members.filter(
        (member) => !removed.has(`${entry.id}:${member.person.id}`)
      );
      entry.counts.members = entry.members.length;
    }
    if (priya)
      owned[0]!.invitations.push({
        kind: "invitation",
        id: id(77),
        teamId: id(1),
        workspaceProjectId,
        person: person("Priya", 77),
        role: "member",
        access: "view",
        status: "invited",
        since: new Date().toISOString(),
        origin: origin(),
        canCancel: true
      });
    const received = Array.from({ length: 7 }, (_, index) => ({
      ...project(60 + index, `Ana’s Project ${index + 1}`, [], recentEmpty),
      owner: person("Ana", 80),
      ownedByMe: false,
      joinedByMe: true
    }));
    if (joined()) {
      owned.shift();
      received[0] = {
        ...received[0]!,
        id: workspaceProjectId,
        name: "landing-site",
        joinedByMe: true
      };
    }
    return {
      backends: [
        {
          backendId,
          status: "available",
          reachedAt: new Date().toISOString(),
          data: {
            projects: [...owned, ...received],
            invitations: [
              {
                kind: "invitation",
                id: id(88),
                teamId: id(1),
                workspaceProjectId: null,
                teamName: "Koed team",
                workspaceName: "Design",
                person: person("Pat", 88),
                role: "member",
                access: "view",
                status: "invited",
                since: new Date().toISOString(),
                origin: origin(),
                canCancel: false
              }
            ],
            workspaceAccess: [
              {
                kind: "workspace_access",
                teamId: id(1),
                teamWorkspaceId: id(2),
                workspaceProjectId: null,
                teamName: "Koed team",
                workspaceName: "Design",
                person: person("Nora", 89),
                how: "direct",
                access: "view",
                status: "joined",
                since: new Date().toISOString(),
                version: 1,
                origin: origin(),
                canRemove: false
              }
            ]
          },
          incomingInvitations: incoming()
        },
        ...(unavailable
          ? [
              {
                backendId: "Studio Team",
                status: "unavailable" as const,
                lastReachedAt: null,
                reason: "unreachable" as const
              }
            ]
          : [])
      ]
    };
  };
  const api: SharingDesktopApi = {
    read: async () => {
      trace.reads++;
      return overview();
    }
  };
  const control = {
    id: "hq-sharing-fixture-v1",
    trace,
    invitePriya: () => {
      priya = true;
      refresh();
    },
    toggleRecent: () => {
      recentEmpty = !recentEmpty;
      refresh();
    },
    toggleBackend: () => {
      unavailable = !unavailable;
      refresh();
    },
    restoreInvitation: () => {
      restoreInvitation();
      refresh();
    },
    refresh,
    removeAccess: (projectId: string, userId: string) => {
      removed.add(`${projectId}:${userId}`);
      refresh();
    }
  };
  return { api, control };
}
