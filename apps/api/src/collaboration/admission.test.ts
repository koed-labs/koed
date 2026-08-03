import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLABORATION_DEPLOYMENT_MESSAGE_MAX_PER_MINUTE,
  COLLABORATION_MESSAGE_BURST_MAX_COUNT,
  COLLABORATION_MESSAGE_BURST_WINDOW_MS,
  COLLABORATION_MESSAGE_SUSTAINED_MAX_COUNT,
  COLLABORATION_TEAM_MESSAGE_MAX_PER_MINUTE
} from "@koed/shared";

import {
  MemoryRateLimitStore,
  resetMemoryRateLimitStore
} from "../infra/rate-limit.js";
import {
  CollaborationRateLimitError,
  createCollaborationAdmissionController
} from "./admission.js";

const hashKey = (value: string) => value;

describe("collaboration admission", () => {
  beforeEach(() => {
    resetMemoryRateLimitStore();
    vi.restoreAllMocks();
  });

  it("admits the exact per-User burst limit and rejects message 21", async () => {
    const admission = createCollaborationAdmissionController(
      new MemoryRateLimitStore(),
      hashKey
    );
    let atLimit = await admission.admitMessage({ userId: "alice" });
    for (
      let count = 1;
      count < COLLABORATION_MESSAGE_BURST_MAX_COUNT;
      count += 1
    ) {
      atLimit = await admission.admitMessage({ userId: "alice" });
    }

    expect(atLimit).toContainEqual(
      expect.objectContaining({ policy: "messageBurst", remaining: 0 })
    );
    await expect(
      admission.admitMessage({ userId: "alice" })
    ).rejects.toMatchObject({
      statusCode: 429,
      decision: expect.objectContaining({ policy: "messageBurst" })
    } satisfies Partial<CollaborationRateLimitError>);
  });

  it("admits the exact per-User sustained limit and rejects message 61", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const admission = createCollaborationAdmissionController(
      new MemoryRateLimitStore(),
      hashKey
    );

    let atLimit = await admission.admitMessage({ userId: "alice" });
    const burstWindows =
      COLLABORATION_MESSAGE_SUSTAINED_MAX_COUNT /
      COLLABORATION_MESSAGE_BURST_MAX_COUNT;
    for (let batch = 0; batch < burstWindows; batch += 1) {
      const start = batch === 0 ? 1 : 0;
      for (
        let index = start;
        index < COLLABORATION_MESSAGE_BURST_MAX_COUNT;
        index += 1
      ) {
        atLimit = await admission.admitMessage({ userId: "alice" });
      }
      if (batch < burstWindows - 1) {
        now += COLLABORATION_MESSAGE_BURST_WINDOW_MS + 1;
      }
    }

    expect(atLimit).toContainEqual(
      expect.objectContaining({ policy: "messageSustained", remaining: 0 })
    );
    now += COLLABORATION_MESSAGE_BURST_WINDOW_MS + 1;
    await expect(
      admission.admitMessage({ userId: "alice" })
    ).rejects.toMatchObject({
      statusCode: 429,
      decision: expect.objectContaining({ policy: "messageSustained" })
    } satisfies Partial<CollaborationRateLimitError>);
  });

  it("enforces Team-wide and deployment-wide message admission", async () => {
    const admission = createCollaborationAdmissionController(
      new MemoryRateLimitStore(20_000),
      hashKey
    );

    let teamAtLimit = await admission.admitMessage({
      userId: "team-user-0",
      teamId: "team-a"
    });
    for (
      let user = 0;
      user <
      COLLABORATION_TEAM_MESSAGE_MAX_PER_MINUTE /
        COLLABORATION_MESSAGE_BURST_MAX_COUNT;
      user += 1
    ) {
      const start = user === 0 ? 1 : 0;
      for (
        let message = start;
        message < COLLABORATION_MESSAGE_BURST_MAX_COUNT;
        message += 1
      ) {
        teamAtLimit = await admission.admitMessage({
          userId: `team-user-${user}`,
          teamId: "team-a"
        });
      }
    }
    expect(teamAtLimit).toContainEqual(
      expect.objectContaining({ policy: "teamMessage", remaining: 0 })
    );
    await expect(
      admission.admitMessage({ userId: "team-user-over", teamId: "team-a" })
    ).rejects.toMatchObject({
      decision: expect.objectContaining({ policy: "teamMessage" })
    });

    resetMemoryRateLimitStore();
    let deploymentAtLimit = await admission.admitMessage({
      userId: "deployment-user-0",
      teamId: "team-0"
    });
    for (
      let user = 0;
      user <
      COLLABORATION_DEPLOYMENT_MESSAGE_MAX_PER_MINUTE /
        COLLABORATION_MESSAGE_BURST_MAX_COUNT;
      user += 1
    ) {
      const start = user === 0 ? 1 : 0;
      for (
        let message = start;
        message < COLLABORATION_MESSAGE_BURST_MAX_COUNT;
        message += 1
      ) {
        deploymentAtLimit = await admission.admitMessage({
          userId: `deployment-user-${user}`,
          teamId: `team-${Math.floor(
            (user * COLLABORATION_MESSAGE_BURST_MAX_COUNT) /
              COLLABORATION_TEAM_MESSAGE_MAX_PER_MINUTE
          )}`
        });
      }
    }
    expect(deploymentAtLimit).toContainEqual(
      expect.objectContaining({ policy: "deploymentMessage", remaining: 0 })
    );
    await expect(
      admission.admitMessage({
        userId: "deployment-user-over",
        teamId: "team-over"
      })
    ).rejects.toMatchObject({
      decision: expect.objectContaining({ policy: "deploymentMessage" })
    });
  });

  it("enforces invite, channel, and failed-connection limits by exact scope", async () => {
    const admission = createCollaborationAdmissionController(
      new MemoryRateLimitStore(),
      hashKey
    );

    for (let index = 0; index < 10; index += 1) {
      await admission.admitInviteCreation({ userId: "alice", teamId: "a" });
      await admission.admitConnectionFailure({
        deviceId: "device-a",
        origin: "https://team.example"
      });
    }
    await expect(
      admission.admitInviteCreation({ userId: "alice", teamId: "a" })
    ).rejects.toMatchObject({
      decision: expect.objectContaining({ policy: "inviteCreate" })
    });
    await expect(
      admission.admitConnectionFailure({
        deviceId: "device-a",
        origin: "https://team.example"
      })
    ).rejects.toMatchObject({
      decision: expect.objectContaining({ policy: "connectionFailure" })
    });

    for (let index = 0; index < 20; index += 1) {
      await admission.admitChannelCreation({ userId: "alice", teamId: "a" });
    }
    await expect(
      admission.admitChannelCreation({ userId: "alice", teamId: "a" })
    ).rejects.toMatchObject({
      decision: expect.objectContaining({ policy: "channelCreate" })
    });

    await expect(
      admission.admitChannelCreation({ userId: "alice", teamId: "b" })
    ).resolves.toHaveLength(1);
  });
});
