import { describe, expect, it, vi } from "vitest";
import {
  connectOrLaunchControlPlane,
  ControlOwnerGoneError
} from "./connect-or-launch.js";
import type { ControlDiscovery } from "./discovery.js";
import type { ControlClient } from "./client.js";
const discovery: ControlDiscovery = {
  schemaVersion: 1,
  home: "/home",
  instanceId: "id",
  installationId: "install",
  productVersion: "1",
  socketPath: "/socket",
  pid: 1,
  processIdentity: "identity"
};
describe("connect or launch", () => {
  it("connects to a matching published host without launching another", async () => {
    const launch = vi.fn();
    const client = {} as ControlClient;
    const connect = vi.fn(async () => client);
    await expect(
      connectOrLaunchControlPlane({
        read: () => discovery,
        isLocked: () => true,
        launch,
        connect,
        installationId: "install",
        productVersion: "1"
      })
    ).resolves.toBe(client);
    expect(launch).not.toHaveBeenCalled();
  });
  it("never falls back when an owner has no published discovery", async () => {
    const launch = vi.fn();
    await expect(
      connectOrLaunchControlPlane({
        read: () => undefined,
        isLocked: () => true,
        launch,
        connect: vi.fn(),
        waitForOwner: false,
        installationId: "install",
        productVersion: "1"
      })
    ).rejects.toThrow("no control-plane endpoint");
    expect(launch).not.toHaveBeenCalled();
  });
  it("reports a dead owner even when its lock path remains", async () => {
    let live = true;
    await expect(
      connectOrLaunchControlPlane({
        read: () => undefined,
        isLocked: () => true,
        hasLiveOwner: () => live,
        launch: vi.fn(),
        connect: vi.fn(),
        launchIfMissing: false,
        installationId: "install",
        productVersion: "1",
        sleep: async () => {
          live = false;
        }
      })
    ).rejects.toBeInstanceOf(ControlOwnerGoneError);
  });
  it("launches once for a definitively dead discovery and waits for replacement", async () => {
    const client = {} as ControlClient;
    const launch = vi.fn();
    const replacement = { ...discovery, instanceId: "replacement", pid: 2 };
    let time = 0;
    await expect(
      connectOrLaunchControlPlane({
        read: () => (time ? replacement : discovery),
        isLocked: () => false,
        isDiscoveryDead: (record) => record.instanceId === discovery.instanceId,
        launch,
        connect: async (record) => {
          expect(record).toEqual(replacement);
          return client;
        },
        installationId: "install",
        productVersion: "1",
        now: () => time,
        sleep: async () => {
          time += 100;
        }
      })
    ).resolves.toBe(client);
    expect(launch).toHaveBeenCalledOnce();
  });
  it("waits for a live replacement owner even when old discovery is dead", async () => {
    const client = {} as ControlClient;
    const launch = vi.fn();
    const replacement = { ...discovery, instanceId: "replacement", pid: 2 };
    let time = 0;
    await expect(
      connectOrLaunchControlPlane({
        read: () => (time ? replacement : discovery),
        isLocked: () => true,
        hasLiveOwner: () => true,
        isDiscoveryDead: (record) => record.instanceId === discovery.instanceId,
        launch,
        connect: async () => client,
        installationId: "install",
        productVersion: "1",
        now: () => time,
        sleep: async () => {
          time += 100;
        }
      })
    ).resolves.toBe(client);
    expect(launch).not.toHaveBeenCalled();
  });
  it("launches when a stale lock exists without discovery and its owner is definitively dead", async () => {
    let time = 0;
    const launch = vi.fn();
    const client = {} as ControlClient;
    await expect(
      connectOrLaunchControlPlane({
        read: () => (time ? discovery : undefined),
        isLocked: () => true,
        hasLiveOwner: () => false,
        launch,
        connect: async () => client,
        installationId: "install",
        productVersion: "1",
        now: () => time,
        sleep: async () => {
          time += 100;
        }
      })
    ).resolves.toBe(client);
    expect(launch).toHaveBeenCalledOnce();
  });
  it("waits when old live discovery belongs to a different current lock owner", async () => {
    let time = 0;
    const replacement = { ...discovery, instanceId: "replacement", pid: 2 };
    const client = {} as ControlClient;
    const launch = vi.fn();
    await expect(
      connectOrLaunchControlPlane({
        read: () => (time ? replacement : discovery),
        isLocked: () => true,
        hasLiveOwner: () => true,
        isDiscoveryDead: () => false,
        isCurrentDiscovery: (value) => value.instanceId === "replacement",
        launch,
        connect: async (value) => {
          expect(value).toEqual(replacement);
          return client;
        },
        installationId: "install",
        productVersion: "1",
        now: () => time,
        sleep: async () => {
          time += 100;
        }
      })
    ).resolves.toBe(client);
    expect(launch).not.toHaveBeenCalled();
  });
  it("does not launch a replacement for Stop with dead discovery", async () => {
    const launch = vi.fn();
    await expect(
      connectOrLaunchControlPlane({
        read: () => discovery,
        isLocked: () => false,
        isDiscoveryDead: () => true,
        launch,
        launchIfMissing: false,
        connect: vi.fn(),
        installationId: "install",
        productVersion: "1"
      })
    ).rejects.toThrow("Stop was recorded");
    expect(launch).not.toHaveBeenCalled();
  });
  it("does not replace discovery merely because an authenticated connect fails", async () => {
    const launch = vi.fn();
    await expect(
      connectOrLaunchControlPlane({
        read: () => discovery,
        isLocked: () => true,
        isDiscoveryDead: () => false,
        launch,
        connect: async () => {
          throw new Error("authentication failed");
        },
        installationId: "install",
        productVersion: "1"
      })
    ).rejects.toThrow("authentication failed");
    expect(launch).not.toHaveBeenCalled();
  });
  it.each([
    { installationId: "other", productVersion: "1" },
    { installationId: "install", productVersion: "2" }
  ])(
    "refuses incompatible preparation clients (%o) before connecting",
    async (identity) => {
      const launch = vi.fn();
      const connect = vi.fn();
      await expect(
        connectOrLaunchControlPlane({
          read: () => discovery,
          isLocked: () => true,
          launch,
          launchIfMissing: false,
          connect,
          ...identity
        })
      ).rejects.toThrow("incompatible");
      expect(connect).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    }
  );
  it("waits for a concurrent owner to publish before a launch-capable start", async () => {
    const client = {} as ControlClient;
    const launch = vi.fn();
    let time = 0;
    await expect(
      connectOrLaunchControlPlane({
        read: () => (time ? discovery : undefined),
        isLocked: () => true,
        launch,
        connect: async () => client,
        installationId: "install",
        productVersion: "1",
        now: () => time,
        sleep: async () => {
          time += 100;
        }
      })
    ).resolves.toBe(client);
    expect(launch).not.toHaveBeenCalled();
  });
  it("ignores a newly published discovery whose owner already died", async () => {
    let time = 0;
    const dead = { ...discovery, instanceId: "dead", pid: 2 };
    const client = {} as ControlClient;
    await expect(
      connectOrLaunchControlPlane({
        read: () => (time === 0 ? undefined : time < 200 ? dead : discovery),
        isLocked: () => true,
        hasLiveOwner: () => true,
        isDiscoveryDead: (value) => value.instanceId === "dead",
        launch: vi.fn(),
        connect: async (value) => {
          expect(value).toEqual(discovery);
          return client;
        },
        installationId: "install",
        productVersion: "1",
        now: () => time,
        sleep: async () => {
          time += 100;
        },
        timeoutMs: 1_000
      })
    ).resolves.toBe(client);
  });
  it("waits beyond ten seconds for a healthy launch-capable owner", async () => {
    let time = 0;
    const client = {} as ControlClient;
    await expect(
      connectOrLaunchControlPlane({
        read: () => (time >= 11_000 ? discovery : undefined),
        isLocked: () => true,
        launch: vi.fn(),
        connect: async () => client,
        installationId: "install",
        productVersion: "1",
        now: () => time,
        sleep: async () => {
          time += 1_000;
        },
        timeoutMs: 15_000
      })
    ).resolves.toBe(client);
  });
  it("times out without launching a competing host when the owner never publishes", async () => {
    let time = 0;
    const launch = vi.fn();
    await expect(
      connectOrLaunchControlPlane({
        read: () => undefined,
        isLocked: () => true,
        launch,
        connect: vi.fn(),
        installationId: "install",
        productVersion: "1",
        timeoutMs: 250,
        now: () => time,
        sleep: async () => {
          time += 100;
        }
      })
    ).rejects.toThrow("Operator attention required");
    expect(launch).not.toHaveBeenCalled();
  });
  it("waits for a concurrent owner to publish before connecting for Stop", async () => {
    const client = {} as ControlClient;
    let time = 0;
    const connect = vi.fn(async () => client);
    await expect(
      connectOrLaunchControlPlane({
        read: () => (time ? discovery : undefined),
        isLocked: () => true,
        launch: vi.fn(),
        launchIfMissing: false,
        waitForOwner: true,
        connect,
        installationId: "install",
        productVersion: "1",
        now: () => time,
        sleep: async () => {
          time += 100;
        }
      })
    ).resolves.toBe(client);
  });
  it("does not launch a persistent host for Stop", async () => {
    const launch = vi.fn();
    await expect(
      connectOrLaunchControlPlane({
        read: () => undefined,
        isLocked: () => false,
        launch,
        launchIfMissing: false,
        connect: vi.fn(),
        installationId: "install",
        productVersion: "1"
      })
    ).rejects.toThrow("Stop was not recorded");
    expect(launch).not.toHaveBeenCalled();
  });
  it("waits briefly for a concurrent winner when its own launch fails first", async () => {
    let time = 0;
    const client = {} as ControlClient;
    await expect(
      connectOrLaunchControlPlane({
        read: () => (time >= 200 ? discovery : undefined),
        isLocked: () => time >= 100,
        launch: vi.fn(),
        launchFailure: () => new Error("host exited"),
        connect: async () => client,
        installationId: "install",
        productVersion: "1",
        now: () => time,
        sleep: async () => {
          time += 100;
        }
      })
    ).resolves.toBe(client);
  });
  it("reports a failed launch with a definitively dead lock owner", async () => {
    let time = 0;
    await expect(
      connectOrLaunchControlPlane({
        read: () => undefined,
        isLocked: () => true,
        hasLiveOwner: () => false,
        launch: vi.fn(),
        launchFailure: () => new Error("host exited"),
        connect: vi.fn(),
        installationId: "install",
        productVersion: "1",
        now: () => time,
        sleep: async () => {
          time += 100;
        },
        timeoutMs: 120_000
      })
    ).rejects.toThrow("host exited");
    expect(time).toBeLessThan(2_000);
  });
  it("reports a failed launch without waiting for the timeout", async () => {
    await expect(
      connectOrLaunchControlPlane({
        read: () => undefined,
        isLocked: () => false,
        launch: vi.fn(),
        launchFailure: () => new Error("host exited"),
        connect: vi.fn(),
        installationId: "install",
        productVersion: "1"
      })
    ).rejects.toThrow("host exited");
  });
  it("waits for the newly launched host before connecting", async () => {
    const read = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValue(discovery);
    const launch = vi.fn();
    const client = {} as ControlClient;
    await expect(
      connectOrLaunchControlPlane({
        read,
        isLocked: () => false,
        launch,
        connect: async () => client,
        installationId: "install",
        productVersion: "1",
        sleep: async () => {},
        now: () => 0
      })
    ).resolves.toBe(client);
    expect(launch).toHaveBeenCalledOnce();
  });
});
