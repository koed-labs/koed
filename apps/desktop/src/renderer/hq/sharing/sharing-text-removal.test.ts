import {
  sharingOverviewSchema,
  type CollaborationSnapshot
} from "@koed/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import { RemovalCoordinator } from "./removal-coordinator.js";
import type { SharingStore } from "./sharing-store.js";
import { sharingTextRemovalTargets } from "./sharing-text-removal.js";

const id = (suffix: number) =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const teamId = id(1),
  ownerId = id(2),
  personId = id(3);
const overview = sharingOverviewSchema.parse({
  backends: ["backend-a", "backend-b"].map((backendId) => ({
    backendId,
    status: "available",
    reachedAt: "2026-10-24T00:00:00.000Z",
    data: { projects: [], workspaceAccess: [], invitations: [] },
    incomingInvitations: []
  }))
});
const teamSnapshot = {
  connection: { backendId: "backend-b" },
  navigation: {
    teamPrincipal: { id: ownerId },
    teams: [
      {
        id: teamId,
        name: "Koed Team",
        role: "owner",
        lifecycle: "active",
        people: [
          {
            id: ownerId,
            displayName: "Owner",
            management: { role: "owner", status: "enabled", version: 4 }
          },
          {
            id: personId,
            displayName: "Sam",
            management: { role: "member", status: "enabled", version: 7 }
          }
        ]
      }
    ]
  }
} as unknown as CollaborationSnapshot;

afterEach(() => vi.useRealTimers());

describe("Chief sharing removal across enrolled backends", () => {
  it("reads and reviews exact Team B member while active Team A stays selected", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const store = {
      refresh,
      current: () => ({
        ownerId,
        profileKey: "profile",
        overview,
        loading: false,
        error: null
      })
    } as unknown as SharingStore;
    const readTeamForReview = vi.fn(async () => teamSnapshot);
    const execute = vi.fn(async () => undefined);
    const prepareDisableMember = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      execute
    }));
    const client = {
      readTeamForReview,
      prepareDisableMember,
      current: () => ({ connection: { backendId: "backend-a" } })
    } as unknown as CollaborationRendererClient;
    const targets = await sharingTextRemovalTargets(
      [
        {
          kind: "team_member",
          backendId: "backend-b",
          teamId,
          personId
        }
      ],
      store,
      client
    );
    const coordinator = new RemovalCoordinator();
    const started = coordinator.start(targets);
    await vi.waitFor(() => expect(coordinator.current().phase).toBe("pending"));
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await started;
    expect(coordinator.current().results).toEqual([
      { name: "Sam", state: "done" }
    ]);
    expect(readTeamForReview).toHaveBeenCalledTimes(2);
    expect(readTeamForReview).toHaveBeenCalledWith({
      backendId: "backend-b",
      teamId
    });
    expect(prepareDisableMember).toHaveBeenCalledWith({
      backendId: "backend-b",
      teamId,
      userId: personId,
      expectedVersion: 7
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(client.current()?.connection.backendId).toBe("backend-a");
  });
});
