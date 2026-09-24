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
  parseDeviceRequestLink,
  resolveDeviceRequestHost
} from "./personal-device-request.js";
import { encryptPersonalDevicePairingMessage } from "./personal-device-request-crypto.js";
import { WebSocketServer } from "ws";

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
describe("Paseo relay device requests", () => {
  it("uses encrypted relay exchange and still requires explicit acceptance", async () => {
    const relay = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: "/ws"
    });
    await new Promise<void>((resolve) => relay.once("listening", resolve));
    const address = relay.address();
    if (!address || typeof address === "string")
      throw new Error("relay bind failed");
    const relayUrl = `ws://localhost:${address.port}/ws`;
    const peers = new Map<
      string,
      { server?: import("ws").WebSocket; client?: import("ws").WebSocket }
    >();
    relay.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "/", "http://relay.invalid");
      const route = url.searchParams.get("serverId") ?? "";
      const role = url.searchParams.get("role");
      const pair = peers.get(route) ?? {};
      if (role === "server") pair.server = socket;
      else if (role === "client") {
        pair.client?.close(1008, "Replaced by new connection");
        pair.client = socket;
      }
      peers.set(route, pair);
      socket.on("message", (frame) => {
        const target = role === "server" ? pair.client : pair.server;
        if (target?.readyState === 1) target.send(frame);
      });
      socket.on("close", () => {
        if (pair[role === "server" ? "server" : "client"] === socket)
          delete pair[role === "server" ? "server" : "client"];
        if (!pair.server && !pair.client) peers.delete(route);
      });
    });

    const home = mkdtempSync("/tmp/koed-relay-request-");
    const paths = resolveKoedServerPaths({ KOED_HOME: home });
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    const redeem = vi.fn(async () => {});
    const service = await startDeviceRequestService({
      paths,
      redeem,
      enrolled: async () => false,
      addresses: () => [],
      relayUrl
    });
    cleanups.push(
      () => new Promise<void>((resolve) => relay.close(() => resolve())),
      () => rmSync(home, { recursive: true, force: true }),
      () => service.close()
    );
    const request = await deviceRequestCommand(
      paths,
      "create",
      "Headless Desktop"
    );
    expect(new URL(request.link!).hostname).toBe("localhost");
    const parsed = parseDeviceRequestLink(request.link, relayUrl);
    expect(parsed.mode).toBe("relay");
    await expect(
      exchangeDeviceRequest(request.link!, "inspect", undefined, relayUrl)
    ).resolves.toMatchObject({ label: "Headless Desktop", state: "waiting" });
    expect(redeem).not.toHaveBeenCalled();
    await expect(
      Promise.all([
        exchangeDeviceRequest(request.link!, "inspect", undefined, relayUrl),
        exchangeDeviceRequest(request.link!, "inspect", undefined, relayUrl)
      ])
    ).resolves.toEqual([
      expect.objectContaining({ state: "waiting" }),
      expect.objectContaining({ state: "waiting" })
    ]);
    await exchangeDeviceRequest(
      request.link!,
      "accept",
      "opaque-invitation",
      relayUrl
    );
    await vi.waitFor(() => expect(redeem).toHaveBeenCalledOnce());
    await vi.waitFor(async () =>
      expect(await deviceRequestCommand(paths, "status")).toMatchObject({
        state: "connected"
      })
    );
  });
});

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
describe("device request interface selection", () => {
  it("prefers an explicit host over automatic selection on a dual-interface device", () => {
    // "10." sorts before "100." lexicographically, so automatic selection
    // would otherwise pick the LAN address even when only Tailscale is
    // reachable from the Authority device.
    expect(
      resolveDeviceRequestHost("100.90.1.2", ["10.0.0.5", "100.90.1.2"])
    ).toBe("100.90.1.2");
  });
  it("falls back to automatic selection when no host is configured", () => {
    expect(
      resolveDeviceRequestHost(undefined, ["100.90.1.2", "10.0.0.5"])
    ).toBe("10.0.0.5");
  });
  it("rejects a configured host that is not a private IPv4 address", () => {
    expect(() => resolveDeviceRequestHost("8.8.8.8", ["10.0.0.5"])).toThrow(
      "private IPv4"
    );
  });
  it("wires an explicit host through the running service into the request link", async () => {
    const home = mkdtempSync("/tmp/koed-request-");
    const paths = resolveKoedServerPaths({ KOED_HOME: home });
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    if (!addresses.length) return;
    const pinned = addresses[0]!;
    const service = await startDeviceRequestService({
      paths,
      redeem: vi.fn(async () => {}),
      enrolled: vi.fn(async () => false),
      addresses: () => addresses,
      host: pinned
    });
    cleanups.push(() => service.close());
    const request = await deviceRequestCommand(paths, "create", "Studio");
    expect(new URL(request.link!).hostname).toBe(pinned);
  });
});
