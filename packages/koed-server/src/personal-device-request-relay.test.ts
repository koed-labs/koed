import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  paseoRelayServerId,
  runPaseoRelayServer
} from "./personal-device-request-relay.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const open = (socket: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

const startRelayPair = async (limits: {
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  maxFrameBytes?: number;
}) => {
  const relay = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/ws"
  });
  await new Promise<void>((resolve) => relay.once("listening", resolve));
  const address = relay.address();
  if (!address || typeof address === "string")
    throw new Error("relay bind failed");
  const relayUrl = `ws://127.0.0.1:${address.port}/ws`;
  let serverSocket: WebSocket | undefined;
  let clientSocket: WebSocket | undefined;
  relay.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    if (url.searchParams.get("role") === "server") serverSocket = socket;
    else clientSocket = socket;
    socket.on("message", (frame) => {
      const target = socket === serverSocket ? clientSocket : serverSocket;
      if (target?.readyState === WebSocket.OPEN) target.send(frame);
    });
    socket.on("close", (code, reason) => {
      const target = socket === serverSocket ? clientSocket : serverSocket;
      if (target?.readyState === WebSocket.OPEN)
        target.close(code, reason.toString());
      if (serverSocket === socket) serverSocket = undefined;
      if (clientSocket === socket) clientSocket = undefined;
    });
  });
  const controller = new AbortController();
  const processedFrames: string[] = [];
  const frameSignals: AbortSignal[] = [];
  let connected!: () => void;
  let frameStarted!: () => void;
  const frameProcessing = new Promise<void>(
    (resolve) => (frameStarted = resolve)
  );
  const serverConnected = new Promise<void>((resolve) => (connected = resolve));
  const serverTask = runPaseoRelayServer({
    relayUrl,
    id: "bounded-queue-test",
    token: "test-token",
    routeContext: "koed/test/v1",
    signal: controller.signal,
    ...limits,
    onConnected: connected,
    onFrame: async (frame, signal) => {
      processedFrames.push(frame);
      frameSignals.push(signal);
      frameStarted();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      return "ok";
    }
  });
  await serverConnected;
  const serverId = paseoRelayServerId(
    "koed/test/v1",
    "bounded-queue-test",
    "test-token"
  );
  const client = new WebSocket(`${relayUrl}?serverId=${serverId}&role=client`, {
    perMessageDeflate: false
  });
  clientSocket = client;
  await open(client);
  cleanups.push(async () => {
    controller.abort();
    client.terminate();
    await serverTask;
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });
  return { client, processedFrames, frameSignals, frameProcessing };
};

const sendFrames = (socket: WebSocket, frames: string[]) =>
  new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 1_000);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve(true);
    });
    for (const frame of frames) socket.send(frame);
  });

describe("Paseo relay server queue bounds", () => {
  it("rejects excess queued messages before adding them to serialized work", async () => {
    const { client, processedFrames, frameSignals, frameProcessing } =
      await startRelayPair({ maxQueuedMessages: 1, maxQueuedBytes: 100 });
    client.send("first");
    await frameProcessing;
    expect(await sendFrames(client, ["second", "third"])).toBe(true);
    expect(processedFrames).toEqual(["first"]);
    expect(frameSignals[0]?.aborted).toBe(true);
  });

  it("rejects queued bytes beyond configured byte budget", async () => {
    const { client, processedFrames, frameSignals, frameProcessing } =
      await startRelayPair({ maxQueuedMessages: 10, maxQueuedBytes: 3 });
    client.send("a");
    await frameProcessing;
    expect(await sendFrames(client, ["ab", "cd"])).toBe(true);
    expect(processedFrames).toEqual(["a"]);
    expect(frameSignals[0]?.aborted).toBe(true);
  });

  it("keeps handling socket errors after queue overflow starts close handshake", async () => {
    const { client, processedFrames, frameSignals, frameProcessing } =
      await startRelayPair({
        maxQueuedMessages: 1,
        maxQueuedBytes: 100,
        maxFrameBytes: 16
      });
    client.send("first");
    await frameProcessing;
    const uncaughtErrors: Error[] = [];
    const captureUncaught = (error: Error) => uncaughtErrors.push(error);
    process.on("uncaughtException", captureUncaught);
    try {
      expect(
        await sendFrames(client, ["queued", "overflow", "x".repeat(1024)])
      ).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(uncaughtErrors).toEqual([]);
      expect(processedFrames).toEqual(["first"]);
      expect(frameSignals[0]?.aborted).toBe(true);
    } finally {
      process.off("uncaughtException", captureUncaught);
    }
  });
});
