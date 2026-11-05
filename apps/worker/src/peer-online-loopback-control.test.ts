import { connect, createServer, type Socket } from "node:net";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  requestLoopbackControl,
  startLoopbackControl,
  type DiscoveryRecord,
  type DiscoveryStore
} from "./peer-online-loopback-control.js";

function discovery() {
  let record: DiscoveryRecord | undefined;
  return {
    async publish(value: DiscoveryRecord) {
      record = value;
    },
    async read() {
      return record;
    },
    async clear(value: DiscoveryRecord) {
      if (record === value) record = undefined;
    }
  };
}

function wire(value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}

async function readWire(socket: Socket): Promise<{ nonce: string }> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= 4 && data.length >= data.readUInt32BE(0) + 4) {
        socket.pause();
        socket.off("data", onData);
        socket.off("error", reject);
        resolve(JSON.parse(data.subarray(4).toString()) as { nonce: string });
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.resume();
  });
}

describe("loopback control", () => {
  it("does not send capability or request to a forged listener", async () => {
    const fake = createServer();
    fake.listen(0, "127.0.0.1");
    await once(fake, "listening");
    const store = discovery();
    const capability = "af".repeat(32);
    await store.publish({
      host: "127.0.0.1",
      port: (fake.address() as { port: number }).port,
      capability
    });
    let observed = "";
    fake.on("connection", (socket) => {
      socket.on("data", (data) => {
        observed += data.toString();
        socket.end(wire({ nonce: "b".repeat(64), proof: "c".repeat(64) }));
      });
    });
    try {
      await expect(
        requestLoopbackControl(store, "private-request")
      ).rejects.toThrow();
      expect(observed).not.toContain(capability);
      expect(observed).not.toContain("private-request");
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });

  it("keeps requests and responses confidential through a byte relay", async () => {
    const store = discovery();
    const server = await startLoopbackControl(store, () => "private-response");
    const record = (await store.read())!;
    let observed = "";
    const relay = createServer((client) => {
      const upstream = connect(record.port, record.host);
      client.on("error", () => {});
      upstream.on("error", () => {});
      client.on("data", (chunk) => {
        observed += chunk.toString();
      });
      upstream.on("data", (chunk) => {
        observed += chunk.toString();
      });
      client.pipe(upstream).pipe(client);
      client.on("close", () => upstream.destroy());
    });
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    await store.publish({
      ...record,
      port: (relay.address() as { port: number }).port
    });
    try {
      await expect(
        requestLoopbackControl(store, "private-request")
      ).resolves.toBe("private-response");
      expect(observed).not.toContain("private-request");
      expect(observed).not.toContain("private-response");
      expect(observed).not.toContain(record.capability);
    } finally {
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await server.close();
    }
  });

  it("accepts a frame fragmented into single bytes", async () => {
    const store = discovery();
    const server = await startLoopbackControl(store, () => null);
    const record = (await store.read())!;
    const socket = connect(record.port, record.host);
    try {
      const response = readWire(socket);
      for (const byte of wire({ nonce: randomBytes(32).toString("hex") })) {
        socket.write(Buffer.from([byte]));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect((await response).nonce).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  it("cancels stalled publication and clears a late publication", async () => {
    let release!: () => void;
    let published!: () => void;
    const entered = new Promise<void>((resolve) => {
      published = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = discovery();
    const publish = store.publish;
    let port = 0;
    store.publish = async (record) => {
      port = record.port;
      published();
      await gate;
      await publish(record);
    };
    const abort = new AbortController();
    const startup = startLoopbackControl(store, () => null, {
      signal: abort.signal
    });
    await entered;
    abort.abort();
    await expect(startup).rejects.toThrow();
    const probe = connect(port, "127.0.0.1");
    await expect(once(probe, "connect")).rejects.toThrow();
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await store.read()).toBeUndefined();
  });

  it("aborts publication before a delayed store may commit", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const backing = discovery();
    const store: DiscoveryStore = {
      ...backing,
      async publish(record, signal) {
        entered();
        await gate;
        if (signal.aborted) throw new Error("publication aborted");
        await backing.publish(record);
      }
    };
    const abort = new AbortController();
    const startup = startLoopbackControl(store, () => null, {
      signal: abort.signal
    });
    await started;
    abort.abort();
    await expect(startup).rejects.toThrow();
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await backing.read()).toBeUndefined();
  });

  it("rejects excess sockets without evicting an existing handshake", async () => {
    const store = discovery();
    const server = await startLoopbackControl(store, () => "ok", {
      maxConcurrency: 1,
      timeoutMs: 1000
    });
    const address = (await store.read())!;
    const first = connect(address.port, address.host);
    const second = connect(address.port, address.host);
    const nonce = randomBytes(32).toString("hex");
    first.on("error", () => {});
    second.on("error", () => {});
    try {
      first.write(wire({ nonce }));
      const challenge = await readWire(first);
      second.write(wire({ nonce: randomBytes(32).toString("hex") }));
      await readWire(second);
      const third = connect(address.port, address.host);
      third.on("error", () => {});
      await once(third, "close");
      expect(first.destroyed).toBe(false);
      const proof = createHmac("sha256", Buffer.from(address.capability, "hex"))
        .update("koed-loopback-client-v1\0")
        .update(Buffer.from(nonce, "hex"))
        .update(Buffer.from(challenge.nonce, "hex"))
        .digest("hex");
      const confirmation = readWire(first);
      first.write(wire({ proof }));
      await expect(confirmation).resolves.toHaveProperty("proof");
    } finally {
      first.destroy();
      second.destroy();
      await server.close();
    }
  });

  it("rejects cancelled startup when discovery cleanup stalls and closes the listener", async () => {
    let entered!: () => void;
    let port = 0;
    const published = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const store: DiscoveryStore = {
      async publish(record) {
        port = record.port;
        entered();
        await new Promise(() => {});
      },
      async read() {
        return undefined;
      },
      async clear() {
        await new Promise(() => {});
      }
    };
    const abort = new AbortController();
    const startup = startLoopbackControl(store, () => null, {
      signal: abort.signal,
      timeoutMs: 40
    });
    await published;
    abort.abort();
    await expect(
      Promise.race([
        startup,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("test deadline")), 250)
        )
      ])
    ).rejects.toThrow("cleanup");
    const probe = connect(port, "127.0.0.1");
    await expect(once(probe, "connect")).rejects.toThrow();
  });

  it("rejects close when discovery cleanup stalls while still closing the listener", async () => {
    const store = discovery();
    store.clear = async () => {
      await new Promise(() => {});
    };
    const server = await startLoopbackControl(store, () => null, {
      timeoutMs: 40
    });
    const address = (await store.read())!;
    await expect(
      Promise.race([
        server.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("test deadline")), 250)
        )
      ])
    ).rejects.toThrow("cleanup");
    const probe = connect(address.port, address.host);
    await expect(once(probe, "connect")).rejects.toThrow();
  });

  it("rejects replayed client proof after a fresh server challenge", async () => {
    const store = discovery();
    let calls = 0;
    const server = await startLoopbackControl(store, () => {
      calls++;
      return null;
    });
    const address = (await store.read())!;
    const nonce = randomBytes(32).toString("hex");
    const first = connect(address.port, address.host);
    const second = connect(address.port, address.host);
    try {
      first.write(wire({ nonce }));
      const challenge = await readWire(first);
      const proof = createHmac("sha256", Buffer.from(address.capability, "hex"))
        .update("koed-loopback-client-v1\0")
        .update(Buffer.from(nonce, "hex"))
        .update(Buffer.from(challenge.nonce, "hex"))
        .digest("hex");
      second.write(wire({ nonce }));
      await readWire(second);
      second.resume();
      second.write(wire({ proof }));
      await once(second, "close");
      expect(calls).toBe(0);
    } finally {
      first.destroy();
      second.destroy();
      await server.close();
    }
  });
  it("round trips over an ephemeral loopback listener and clears discovery on close", async () => {
    const store = discovery();
    const server = await startLoopbackControl(store, (value) => ({ value }));
    try {
      const address = await store.read();
      expect(address?.host).toBe("127.0.0.1");
      expect(address?.port).toBeGreaterThan(0);
      expect(address?.capability).toMatch(/^[a-f0-9]{64}$/);
      await expect(requestLoopbackControl(store, "hello")).resolves.toEqual({
        value: "hello"
      });
    } finally {
      await server.close();
    }
    expect(await store.read()).toBeUndefined();
    await expect(requestLoopbackControl(store, null)).rejects.toThrow();
  });

  it("rejects unauthenticated frames without calling the handler", async () => {
    const store = discovery();
    let calls = 0;
    const server = await startLoopbackControl(store, () => {
      calls++;
      return null;
    });
    try {
      const address = (await store.read())!;
      const payload = Buffer.from(
        JSON.stringify({ capability: "wrong", request: null })
      );
      const frame = Buffer.alloc(4 + payload.length);
      frame.writeUInt32BE(payload.length);
      payload.copy(frame, 4);
      await new Promise<void>((resolve, reject) => {
        const socket = connect(address.port, address.host, () =>
          socket.write(frame)
        );
        socket.on("data", () => reject(new Error("unexpected response")));
        socket.on("close", () => resolve());
        socket.on("error", reject);
      });
      expect(calls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("aborts a timed out handler and retains its concurrency slot until it settles", async () => {
    const store = discovery();
    let aborted = false;
    let finish!: () => void;
    let calls = 0;
    const server = await startLoopbackControl(
      store,
      (_value, signal) => {
        calls++;
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      { timeoutMs: 80, maxConcurrency: 1 }
    );
    try {
      await expect(
        requestLoopbackControl(store, null, { timeoutMs: 300 })
      ).rejects.toThrow();
      expect(aborted).toBe(true);
      await expect(
        requestLoopbackControl(store, null, { timeoutMs: 300 })
      ).rejects.toThrow();
      expect(calls).toBe(1);
      finish();
    } finally {
      await server.close();
    }
  });

  it("closes stalled connections at the deadline and aborts active work on close", async () => {
    const store = discovery();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let aborted = false;
    const server = await startLoopbackControl(
      store,
      (_value, signal) => {
        entered();
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => {});
      },
      { timeoutMs: 100 }
    );
    const address = (await store.read())!;
    const stalled = connect(address.port, address.host);
    const closed = new Promise<void>((resolve) =>
      stalled.once("close", () => resolve())
    );
    stalled.write(Buffer.from([0, 0]));
    await closed;
    const request = requestLoopbackControl(store, null);
    const rejected = expect(request).rejects.toThrow();
    await started;
    await server.close();
    await rejected;
    expect(aborted).toBe(true);
    await server.close();
  });

  it("applies the request deadline while discovery is stalled", async () => {
    const store = discovery();
    store.read = () => new Promise(() => {});
    await expect(
      requestLoopbackControl(store, null, { timeoutMs: 30 })
    ).rejects.toThrow();
  }, 500);

  it("cancels discovery without connecting when the abort signal fires", async () => {
    const store = discovery();
    store.read = () => new Promise(() => {});
    const controller = new AbortController();
    const request = requestLoopbackControl(store, null, {
      signal: controller.signal
    });
    controller.abort();
    await expect(request).rejects.toThrow();
  });

  it("refuses non-loopback discovery before connecting", async () => {
    const store = discovery();
    await store.publish({
      host: "192.0.2.1" as "127.0.0.1",
      port: 1,
      capability: "a".repeat(64)
    });
    await expect(requestLoopbackControl(store, null)).rejects.toThrow(
      "Invalid control discovery"
    );
  });

  it("rejects oversized requests and responses", async () => {
    const store = discovery();
    let calls = 0;
    const server = await startLoopbackControl(
      store,
      () => {
        calls++;
        return "x".repeat(1000);
      },
      { maxFrameBytes: 256 }
    );
    try {
      await expect(
        requestLoopbackControl(store, "x".repeat(1000), { maxFrameBytes: 256 })
      ).rejects.toThrow();
      expect(calls).toBe(0);
      await expect(
        requestLoopbackControl(store, null, { maxFrameBytes: 256 })
      ).rejects.toThrow();
      expect(calls).toBe(1);
    } finally {
      await server.close();
    }
  });
});
