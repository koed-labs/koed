import { execFileSync } from "node:child_process";
import { randomBytes, X509Certificate, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connect as tlsConnect,
  createServer as createTlsServer
} from "node:tls";
import {
  connect as netConnect,
  createServer as createNetServer
} from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  listenPairingTransport,
  requestPairingTransport
} from "./peer-online-pairing-transport.js";

const dir = mkdtempSync(join(tmpdir(), "koed-pairing-test-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(dir, "key"),
    "-out",
    join(dir, "cert"),
    "-subj",
    "/CN=localhost",
    "-days",
    "1"
  ],
  { stdio: "ignore" }
);
const cert = readFileSync(join(dir, "cert"));
const key = readFileSync(join(dir, "key"));
const spki = new X509Certificate(cert).publicKey.export({
  type: "spki",
  format: "der"
});
const pin = createHash("sha256").update(spki).digest("base64url");
const capability = randomBytes(32).toString("base64url");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const base = {
  host: "127.0.0.1",
  cert,
  key,
  capability,
  timeoutMs: 300,
  onError: (_error: Error) => {}
};

describe("pairing transport", () => {
  it("exchanges bounded bytes with a matching pin and capability", async () => {
    const server = await listenPairingTransport({
      ...base,
      port: 0,
      handle: async (request) => Buffer.concat([Buffer.from("reply:"), request])
    });
    try {
      const response = await requestPairingTransport(
        {
          host: base.host,
          port: server.port,
          pin,
          capability,
          timeoutMs: 1000
        },
        Buffer.from("hello")
      );
      expect(response.toString()).toBe("reply:hello");
      await expect(
        requestPairingTransport(
          {
            host: base.host,
            port: server.port,
            pin,
            capability: randomBytes(32).toString("base64url"),
            timeoutMs: 1000
          },
          Buffer.from("hello")
        )
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it("rejects an invalid capability without waiting for a body or length", async () => {
    let handled = false;
    const server = await listenPairingTransport({
      ...base,
      port: 0,
      timeoutMs: 2000,
      handle: async () => {
        handled = true;
        return Buffer.alloc(0);
      }
    });
    const socket = tlsConnect({
      host: base.host,
      port: server.port,
      rejectUnauthorized: false,
      ALPNProtocols: ["koed-pairing/1"]
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
      socket.write(randomBytes(32));
      const closed = new Promise<boolean>((resolve) =>
        socket.once("close", () => resolve(true))
      );
      expect(
        await Promise.race([
          closed,
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 300)
          )
        ])
      ).toBe(true);
      expect(handled).toBe(false);
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  it.each([
    "8.8.8.8",
    "0.0.0.0",
    "::",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "ff02::1",
    "2001:db8::1",
    "fec0::1"
  ])("rejects non-LAN bind address %s", async (host) => {
    await expect(
      listenPairingTransport({
        ...base,
        host,
        port: 0,
        handle: async (body) => body
      })
    ).rejects.toThrow("Invalid pairing address");
  });

  it.each([
    "100.64.0.0",
    "100.127.255.255",
    "::ffff:100.64.0.0",
    "::ffff:100.127.255.255",
    "::ffff:6440:0",
    "::ffff:647f:ffff"
  ])(
    "accepts Tailscale bind address %s before opening a listener",
    async (host) => {
      await expect(
        listenPairingTransport({
          ...base,
          host,
          port: 0,
          cert: "",
          handle: async (body) => body
        })
      ).rejects.toThrow("Invalid pairing server options");
    }
  );

  it.each([
    "100.63.255.255",
    "100.128.0.0",
    "::ffff:100.63.255.255",
    "::ffff:100.128.0.0",
    "::ffff:643f:ffff",
    "::ffff:6480:0"
  ])("rejects addresses outside Tailscale range %s", async (host) => {
    await expect(
      listenPairingTransport({
        ...base,
        host,
        port: 0,
        handle: async (body) => body
      })
    ).rejects.toThrow("Invalid pairing address");
  });

  it("accepts IPv6 loopback when available", async () => {
    const probe = createNetServer();
    const available = await new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(0, "::1", () => probe.close(() => resolve(true)));
    });
    if (!available) return;
    const server = await listenPairingTransport({
      ...base,
      host: "::1",
      port: 0,
      handle: async (body) => body
    });
    try {
      const response = await requestPairingTransport(
        { host: "::1", port: server.port, pin, capability, timeoutMs: 1000 },
        Buffer.from("ipv6")
      );
      expect(response.toString()).toBe("ipv6");
    } finally {
      await server.close();
    }
  });

  it("throttles aggregate connection attempts and recovers as tokens refill", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const server = await listenPairingTransport({
      ...base,
      port: 0,
      handle: async (body) => body
    });
    const request = () =>
      requestPairingTransport(
        {
          host: base.host,
          port: server.port,
          pin,
          capability,
          timeoutMs: 1000
        },
        Buffer.from("ok")
      );
    try {
      for (let i = 0; i < 32; i++)
        expect((await request()).toString()).toBe("ok");
      const rejected = tlsConnect({
        host: base.host,
        port: server.port,
        rejectUnauthorized: false,
        ALPNProtocols: ["koed-pairing/1"]
      });
      const completedHandshake = await new Promise<boolean>(
        (resolve, reject) => {
          rejected.setTimeout(1000, () => {
            rejected.destroy();
            reject(new Error("Rejected connection did not close"));
          });
          rejected.once("secureConnect", () => resolve(true));
          rejected.on("error", () => {});
          rejected.once("close", () => resolve(false));
        }
      );
      rejected.destroy();
      expect(completedHandshake).toBe(false);
      now += 1000;
      expect((await request()).toString()).toBe("ok");
    } finally {
      await server.close();
      clock.mockRestore();
    }
  });

  it("bounds stalled handlers and recovers when one settles", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const releases: Array<() => void> = [];
    const aborted: Array<Promise<void>> = [];
    let notify!: () => void;
    let started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const server = await listenPairingTransport({
      ...base,
      timeoutMs: 10_000,
      port: 0,
      handle: (_body, signal) =>
        new Promise<Buffer>((resolve) => {
          aborted.push(
            new Promise<void>((done) => {
              signal.addEventListener("abort", () => done(), { once: true });
            })
          );
          releases.push(() => resolve(Buffer.from("ok")));
          notify();
        })
    });
    const request = () =>
      requestPairingTransport(
        {
          host: base.host,
          port: server.port,
          pin,
          capability,
          timeoutMs: 100
        },
        Buffer.alloc(0)
      );
    const pending: Array<Promise<Buffer | undefined>> = [];
    try {
      for (let i = 0; i < 32; i++) {
        now += 1000;
        pending.push(request().catch(() => undefined));
        await started;
        await pending[i];
        await aborted[i];
        started = new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      now += 1000;
      await expect(request()).rejects.toThrow();
      expect(releases).toHaveLength(32);
      releases[0]!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      now += 1000;
      const recovered = request();
      await started;
      releases[32]!();
      expect((await recovered).toString()).toBe("ok");
    } finally {
      for (const release of releases) release();
      await server.close();
      await Promise.all(pending);
      clock.mockRestore();
    }
  });

  it("reports handler failures without exposing secrets", async () => {
    const errors: Error[] = [];
    const server = await listenPairingTransport({
      ...base,
      port: 0,
      onError: (error) => errors.push(error),
      handle: async () => {
        throw new Error(`secret ${capability}`);
      }
    });
    try {
      await expect(
        requestPairingTransport(
          {
            host: base.host,
            port: server.port,
            pin,
            capability,
            timeoutMs: 1000
          },
          Buffer.alloc(0)
        )
      ).rejects.toThrow();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe("Pairing handler failed");
      expect(String(errors[0]?.stack)).not.toContain(capability);
    } finally {
      await server.close();
    }
  });

  it.each([false, true])(
    "contains handler error callback failures (async: %s)",
    async (asyncFailure) => {
      let reported = false;
      const server = await listenPairingTransport({
        ...base,
        port: 0,
        onError: ((error: Error) => {
          expect(error.message).toBe("Pairing handler failed");
          reported = true;
          if (asyncFailure)
            return Promise.reject(new Error(`callback secret ${capability}`));
          throw new Error(`callback secret ${capability}`);
        }) as (error: Error) => void,
        handle: async () => {
          throw new Error(`handler secret ${capability}`);
        }
      });
      try {
        await expect(
          requestPairingTransport(
            {
              host: base.host,
              port: server.port,
              pin,
              capability,
              timeoutMs: 1000
            },
            Buffer.alloc(0)
          )
        ).rejects.toThrow();
        expect(reported).toBe(true);
      } finally {
        await server.close();
      }
    }
  );

  it("requires a listener error callback", async () => {
    await expect(
      listenPairingTransport({
        ...base,
        port: 0,
        handle: async (body) => body,
        onError: undefined as never
      })
    ).rejects.toThrow("Invalid pairing server options");
  });

  it("aborts a running handler on timeout", async () => {
    let notify!: (value: boolean) => void;
    const aborted = new Promise<boolean>((resolve) => {
      notify = resolve;
    });
    const server = await listenPairingTransport({
      ...base,
      timeoutMs: 100,
      port: 0,
      handle: async (_body, signal) => {
        signal.addEventListener("abort", () => notify(true), { once: true });
        return new Promise<Buffer>(() => {});
      }
    });
    try {
      const request = requestPairingTransport(
        {
          host: base.host,
          port: server.port,
          pin,
          capability,
          timeoutMs: 1000
        },
        Buffer.alloc(0)
      ).catch(() => undefined);
      expect(
        await Promise.race([
          aborted,
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 500)
          )
        ])
      ).toBe(true);
      await request;
    } finally {
      await server.close();
    }
  });

  it("aborts a running handler on shutdown", async () => {
    let started!: () => void;
    let notify!: (value: boolean) => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const aborted = new Promise<boolean>((resolve) => {
      notify = resolve;
    });
    const server = await listenPairingTransport({
      ...base,
      timeoutMs: 2000,
      port: 0,
      handle: async (_body, signal) => {
        signal.addEventListener("abort", () => notify(true), { once: true });
        started();
        return new Promise<Buffer>(() => {});
      }
    });
    const request = requestPairingTransport(
      { host: base.host, port: server.port, pin, capability, timeoutMs: 2000 },
      Buffer.alloc(0)
    ).catch(() => undefined);
    try {
      await ready;
      await server.close();
      expect(
        await Promise.race([
          aborted,
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 300)
          )
        ])
      ).toBe(true);
      await request;
    } finally {
      await server.close();
    }
  });

  it("sends no application bytes to a server with the wrong pin", async () => {
    let bytes = 0;
    const server = createTlsServer(
      {
        cert,
        key,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        ALPNProtocols: ["koed-pairing/1"]
      },
      (socket) => {
        socket.on("data", (data: Buffer) => {
          bytes += data.length;
        });
      }
    );
    const socketClosed = new Promise<void>((resolve) => {
      server.once("connection", (socket) => socket.once("close", resolve));
    });
    await new Promise<void>((resolve) => server.listen(0, base.host, resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");
    try {
      await expect(
        requestPairingTransport(
          {
            host: base.host,
            port: address.port,
            pin: randomBytes(32).toString("base64url"),
            capability,
            timeoutMs: 1000
          },
          Buffer.from("secret")
        )
      ).rejects.toThrow();
      await socketClosed;
      expect(bytes).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("enforces client deadline against a stalled handshake", async () => {
    const server = createNetServer((socket) => socket.resume());
    await new Promise<void>((resolve) => server.listen(0, base.host, resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");
    try {
      await expect(
        requestPairingTransport(
          {
            host: base.host,
            port: address.port,
            pin,
            capability,
            timeoutMs: 50
          },
          Buffer.alloc(0)
        )
      ).rejects.toThrow("timed out");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("enforces the server deadline while a handler stalls", async () => {
    const server = await listenPairingTransport({
      ...base,
      timeoutMs: 60,
      port: 0,
      handle: () => new Promise<Buffer>(() => {})
    });
    try {
      await expect(
        requestPairingTransport(
          {
            host: base.host,
            port: server.port,
            pin,
            capability,
            timeoutMs: 1000
          },
          Buffer.alloc(0)
        )
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it("rejects oversized requests before connecting", () => {
    expect(() =>
      requestPairingTransport(
        { host: base.host, port: 1, pin, capability, timeoutMs: 1000 },
        Buffer.alloc(1024 * 1024 + 1)
      )
    ).toThrow();
  });

  it("shutdown closes stalled incoming connections", async () => {
    const server = await listenPairingTransport({
      ...base,
      port: 0,
      handle: async (request) => request
    });
    const socket = netConnect(server.port, base.host);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve())
    );
    await server.close();
    await closed;
    expect(socket.destroyed).toBe(true);
  });
});
