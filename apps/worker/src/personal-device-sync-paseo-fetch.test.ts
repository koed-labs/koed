import { createHash } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createPdsPaseoRelayFetch } from "./personal-device-sync-paseo-fetch.js";

const id = "11111111-2222-4333-8444-555555555555";
const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const context = "koed/pds-lan-pair/v1";
const relayServerId = () =>
  createHash("sha256")
    .update(`${context}\0${id}\0${token}`)
    .digest("base64url");

const relays: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(
    relays.splice(0).map((relay) => {
      for (const client of relay.clients) client.terminate();
      return new Promise<void>((resolve) => relay.close(() => resolve()));
    })
  );
});

describe("PDS Paseo relay fetch", () => {
  it("accepts capability only on configured relay origin", () => {
    const capability = `https://koed-relay.fly.dev/pds/${id}#token=${token}`;
    expect(
      createPdsPaseoRelayFetch(capability, "wss://koed-relay.fly.dev/ws")
    ).toBeTypeOf("function");
    expect(() =>
      createPdsPaseoRelayFetch(capability, "wss://other-relay.fly.dev/ws")
    ).toThrow("capability is invalid");
  });

  it("rejects requests outside narrow PDS relay route before network access", async () => {
    const capability = `https://koed-relay.fly.dev/pds/${id}#token=${token}`;
    const fetcher = createPdsPaseoRelayFetch(
      capability,
      "wss://koed-relay.fly.dev/ws"
    )!;
    await expect(
      fetcher(`https://koed-relay.fly.dev/pds/${id}/v1/health`)
    ).rejects.toThrow("escaped its Paseo capability");
  });

  it("maps authenticated PDS requests over Paseo frames and checks response binding", async () => {
    const relay = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: "/ws"
    });
    relays.push(relay);
    await new Promise<void>((resolve) => relay.once("listening", resolve));
    const address = relay.address();
    if (!address || typeof address === "string")
      throw new Error("relay bind failed");
    const relayUrl = `ws://127.0.0.1:${address.port}/ws`;
    const capability = `http://127.0.0.1:${address.port}/pds/${id}#token=${token}`;
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
      if (role === "client") {
        pair.client?.close(1008, "Replaced by new connection");
        pair.client = socket;
      }
      peers.set(route, pair);
      socket.on("message", (data) => {
        const target = role === "client" ? pair.server : pair.client;
        target?.send(data);
      });
    });
    const serverId = relayServerId();
    const serverSocket = await new Promise<import("ws").WebSocket>(
      (resolve, reject) => {
        const socket = new WebSocket(
          relayUrl + `?serverId=${serverId}&role=server`
        );
        socket.once("open", () => resolve(socket));
        socket.once("error", reject);
      }
    );
    serverSocket.on("message", (data) => {
      const requestFrame = JSON.parse(data.toString()) as Record<
        string,
        unknown
      >;
      serverSocket.send(
        JSON.stringify({
          protocol: "koed/pds-http-tunnel/v1",
          request_id: requestFrame.request_id,
          status: 200,
          headers: { "content-type": "application/json" },
          body: '{"accepted":true}'
        })
      );
    });
    const fetcher = createPdsPaseoRelayFetch(capability, relayUrl);
    const requestUrl = `http://127.0.0.1:${address.port}/pds/${id}/v1/personal-device-sync/relay/transports`;
    const init = {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-pds-membership-certificate": "certificate",
        "x-pds-relay-proof": "proof"
      },
      body: "{}"
    };
    const responses = await Promise.all([
      fetcher!(requestUrl, init),
      fetcher!(requestUrl, init)
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await expect(
      Promise.all(responses.map((response) => response.json()))
    ).resolves.toEqual([{ accepted: true }, { accepted: true }]);
    serverSocket.close();
  });
});
