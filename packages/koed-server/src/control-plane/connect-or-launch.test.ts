import { describe, expect, it, vi } from "vitest";
import { connectOrLaunchControlPlane } from "./connect-or-launch.js";
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
        installationId: "install",
        productVersion: "1"
      })
    ).rejects.toThrow("no control-plane endpoint");
    expect(launch).not.toHaveBeenCalled();
  });
  it("refuses an incompatible installation without launching", async () => {
    const launch = vi.fn();
    await expect(
      connectOrLaunchControlPlane({
        read: () => discovery,
        isLocked: () => true,
        launch,
        connect: vi.fn(),
        installationId: "other",
        productVersion: "1"
      })
    ).rejects.toThrow("incompatible");
    expect(launch).not.toHaveBeenCalled();
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
