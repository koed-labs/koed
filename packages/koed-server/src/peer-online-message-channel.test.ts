import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { connect, createServer, type TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PeerOnlineMessageChannel } from "./peer-online-message-channel.js";

let cert: Buffer;
let key: Buffer;
let directory: string;

beforeAll(() => {
  directory = mkdtempSync(resolve("../../scratch/channel-test-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key"),
      "-out",
      join(directory, "cert"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost"
    ],
    { stdio: "ignore" }
  );
  cert = readFileSync(join(directory, "cert"));
  key = readFileSync(join(directory, "key"));
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function sockets(): Promise<[TLSSocket, TLSSocket, () => void]> {
  const server = createServer({ cert, key });
  const accepted = new Promise<TLSSocket>((resolve) =>
    server.once("secureConnection", resolve)
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bad address");
  const client = connect({
    host: "127.0.0.1",
    port: address.port,
    servername: "localhost",
    ca: cert
  });
  await new Promise<void>((resolve, reject) => {
    client.once("secureConnect", resolve);
    client.once("error", reject);
  });
  const peer = await accepted;
  return [
    client,
    peer,
    () => {
      client.destroy();
      peer.destroy();
      server.close();
    }
  ];
}

describe("peer online message channel", () => {
  it("receives fragmented frames and preserves buffered handoff bytes", async () => {
    const [client, peer, cleanup] = await sockets();
    try {
      peer.write(Buffer.from([0, 0]));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const channel = new PeerOnlineMessageChannel(client);
      const message = channel.receive();
      peer.write(Buffer.from([0, 3, 97]));
      peer.write(Buffer.from([98, 99, 0, 0, 0, 0]));
      expect(await message).toEqual(Buffer.from("abc"));
      expect(await channel.receive()).toEqual(Buffer.alloc(0));
      channel.close();
    } finally {
      cleanup();
    }
  });

  it("orders concurrent sends and snapshots mutable payloads", async () => {
    const [client, peer, cleanup] = await sockets();
    try {
      const sender = new PeerOnlineMessageChannel(client);
      const receiver = new PeerOnlineMessageChannel(peer);
      const payload = Buffer.from("first");
      const sends = [sender.send(payload), sender.send(Buffer.from("second"))];
      payload.fill(0);
      expect((await receiver.receive())?.toString()).toBe("first");
      expect((await receiver.receive())?.toString()).toBe("second");
      await Promise.all(sends);
      sender.close();
      receiver.close();
    } finally {
      cleanup();
    }
  });

  it("bounds outgoing frames and queued messages", async () => {
    const [client, , cleanup] = await sockets();
    try {
      const channel = new PeerOnlineMessageChannel(client, {
        maxFrameBytes: 3,
        maxQueuedMessages: 1,
        maxQueuedBytes: 7
      });
      const first = channel.send(Buffer.from("abc"));
      await expect(channel.send(Buffer.from("x"))).rejects.toThrow(
        "queue full"
      );
      await expect(channel.send(Buffer.from("abcd"))).rejects.toThrow(
        "Frame too large"
      );
      await first;
      channel.close();
    } finally {
      cleanup();
    }
  });

  it("rejects oversized headers and truncated frames", async () => {
    for (const bytes of [
      Buffer.from([0, 0, 0, 5]),
      Buffer.from([0, 0, 0, 3, 97])
    ]) {
      const [client, peer, cleanup] = await sockets();
      try {
        const channel = new PeerOnlineMessageChannel(client, {
          maxFrameBytes: 4
        });
        const received = channel.receive();
        peer.end(bytes);
        await expect(received).rejects.toThrow(
          bytes.length === 4 ? "Frame too large" : "Truncated frame"
        );
      } finally {
        cleanup();
      }
    }
  });

  it("delivers queued frames before clean EOF and rejects concurrent receive", async () => {
    const [client, peer, cleanup] = await sockets();
    try {
      const channel = new PeerOnlineMessageChannel(client);
      const first = channel.receive();
      await expect(channel.receive()).rejects.toThrow(
        "Receive already pending"
      );
      peer.end(Buffer.from([0, 0, 0, 1, 65, 0, 0, 0, 1, 66]));
      expect((await first)?.toString()).toBe("A");
      expect((await channel.receive())?.toString()).toBe("B");
      expect(await channel.receive()).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("aborts pending receives and future operations", async () => {
    const [client, , cleanup] = await sockets();
    try {
      const controller = new AbortController();
      const channel = new PeerOnlineMessageChannel(client, {
        signal: controller.signal
      });
      const received = channel.receive();
      controller.abort();
      await expect(received).rejects.toThrow("aborted");
      await expect(channel.send(Buffer.alloc(0))).rejects.toThrow("aborted");
    } finally {
      cleanup();
    }
  });
});
