import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { isPrivateNetworkIpv4Address } from "@koed/shared";
import { resolveKoedServerPaths } from "./paths.js";
import {
  startDeviceRequestService,
  deviceRequestCommand,
  exchangeDeviceRequest,
  parseDeviceRequestLink
} from "./personal-device-request.js";
import { encryptPersonalDevicePairingMessage } from "./personal-device-request-crypto.js";

const addresses = Object.values(networkInterfaces())
  .flatMap((list) => list ?? [])
  .filter(
    (entry) =>
      entry.family === "IPv4" &&
      !entry.internal &&
      isPrivateNetworkIpv4Address(entry.address)
  )
  .map((entry) => entry.address);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
const setup = async (
  redeem = vi.fn(async () => {}),
  enrolled = vi.fn(async () => false)
) => {
  const home = mkdtempSync("/tmp/koed-request-");
  const paths = resolveKoedServerPaths({ KOED_HOME: home });
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  const service = await startDeviceRequestService({
    paths,
    redeem,
    enrolled,
    addresses: () => addresses
  });
  cleanups.push(
    () => rmSync(home, { recursive: true, force: true }),
    () => service.close()
  );
  return { home, paths, service, redeem, enrolled };
};
describe("device request links", () => {
  it.each([
    "http://8.8.8.8:3310/device-request/",
    "http://127.0.0.1:3310/device-request/",
    "https://example.com/pair",
    "http://user:pass@192.168.0.2:3310/device-request/",
    "file:///tmp/request"
  ])("rejects unsafe destinations: %s", (value) => {
    expect(() => parseDeviceRequestLink(value)).toThrow();
  });
});
describe.skipIf(!addresses.length)("supervisor device requests", () => {
  it("requires explicit acceptance and completes only after reconciliation", async () => {
    let complete!: () => void;
    const redeem = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    const { paths, home } = await setup(redeem);
    const request = await deviceRequestCommand(paths, "create", "Studio");
    expect(request.link).toBeTruthy();
    expect(await exchangeDeviceRequest(request.link!, "inspect")).toMatchObject(
      { label: "Studio", state: "waiting" }
    );
    expect(redeem).not.toHaveBeenCalled();
    const status = await deviceRequestCommand(paths, "status");
    expect(status).not.toHaveProperty("link");
    const { token } = parseDeviceRequestLink(request.link!);
    expect(
      readFileSync(join(home, "secrets", "pds-secrets.json"), "utf8")
    ).not.toContain(token);
    await exchangeDeviceRequest(request.link!, "accept", "private-invitation");
    await vi.waitFor(() => expect(redeem).toHaveBeenCalledOnce());
    expect(await deviceRequestCommand(paths, "status")).toMatchObject({
      state: "connecting"
    });
    await expect(
      exchangeDeviceRequest(request.link!, "accept", "another-invitation")
    ).rejects.toThrow();
    complete();
    await vi.waitFor(async () =>
      expect(await deviceRequestCommand(paths, "status")).toMatchObject({
        state: "connected"
      })
    );
  });
  it("replays neither encrypted messages nor cancelled requests", async () => {
    const { paths, redeem } = await setup();
    const request = await deviceRequestCommand(paths, "create");
    const parsed = parseDeviceRequestLink(request.link!);
    const encrypted = encryptPersonalDevicePairingMessage(
      { operation: "inspect" },
      { invitationId: parsed.id, token: parsed.token, direction: "request" }
    );
    const send = () =>
      fetch(parsed.url, { method: "POST", body: JSON.stringify(encrypted) });
    const first = await send();
    expect(first.status).toBe(200);
    await first.body?.cancel();
    const replay = await send();
    expect(replay.status).toBe(400);
    await replay.body?.cancel();
    await deviceRequestCommand(paths, "cancel");
    await expect(
      exchangeDeviceRequest(request.link!, "accept", "invitation")
    ).rejects.toThrow();
    expect(redeem).not.toHaveBeenCalled();
  });
  it("restores a waiting link after supervisor restart", async () => {
    const { paths, service, redeem } = await setup();
    const before = await deviceRequestCommand(
      paths,
      "create",
      "Second Electron"
    );
    await service.close();
    const restarted = await startDeviceRequestService({
      paths,
      redeem,
      enrolled: async () => false,
      addresses: () => addresses
    });
    cleanups.push(() => restarted.close());
    expect(await deviceRequestCommand(paths, "create")).toEqual(before);
    expect(await exchangeDeviceRequest(before.link!, "inspect")).toMatchObject({
      label: "Second Electron"
    });
  });
  it("preserves redacted completion after a supervisor restart", async () => {
    const { paths, service, redeem, enrolled } = await setup();
    const request = await deviceRequestCommand(paths, "create");
    await exchangeDeviceRequest(request.link!, "accept", "private-invitation");
    await vi.waitFor(async () =>
      expect(await deviceRequestCommand(paths, "status")).toMatchObject({
        state: "connected"
      })
    );
    await service.close();
    const restarted = await startDeviceRequestService({
      paths,
      redeem,
      enrolled,
      addresses: () => addresses
    });
    cleanups.push(() => restarted.close());
    expect(await deviceRequestCommand(paths, "status")).toMatchObject({
      state: "connected"
    });
    expect(await deviceRequestCommand(paths, "status")).not.toHaveProperty(
      "link"
    );
    expect(redeem).toHaveBeenCalledOnce();
  });
  it("reuses one request for concurrent local callers and refuses enrolled installations", async () => {
    const { paths, enrolled } = await setup();
    const [a, b] = await Promise.all([
      deviceRequestCommand(paths, "create"),
      deviceRequestCommand(paths, "create")
    ]);
    expect(a.link).toEqual(b.link);
    enrolled.mockResolvedValue(true);
    await expect(deviceRequestCommand(paths, "create")).rejects.toThrow(
      "already belongs"
    );
  });
  it("does not advertise success or leak transport errors when reconciliation fails", async () => {
    const { paths } = await setup(
      vi.fn(async () => {
        throw new Error("secret-invitation-token");
      })
    );
    const request = await deviceRequestCommand(paths, "create");
    await exchangeDeviceRequest(request.link!, "accept", "private-invitation");
    await vi.waitFor(async () =>
      expect(await deviceRequestCommand(paths, "status")).toMatchObject({
        state: "failed"
      })
    );
    expect(
      JSON.stringify(await deviceRequestCommand(paths, "status"))
    ).not.toContain("secret");
  });
});
