import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:tls";
import {
  authenticatePeerOnline,
  type PeerOnlineAuthOptions
} from "./peer-online-auth.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectPeerOnlineMember,
  listenPeerOnlineMembers,
  type MemberSession
} from "./peer-online-member-listener.js";

const keys = {
  client: generateKeyPairSync("ed25519"),
  server: generateKeyPairSync("ed25519")
};
let directory: string;
const tls: Record<string, { cert: Buffer; key: Buffer; pin: string }> = {};
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "koed-member-test-"));
  for (const id of ["client", "server"]) {
    const keyPath = join(directory, `${id}.key`);
    const certPath = join(directory, `${id}.crt`);
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        `/CN=${id}`
      ],
      { stdio: "ignore" }
    );
    const cert = readFileSync(certPath);
    tls[id] = {
      cert,
      key: readFileSync(keyPath),
      pin: createHash("sha256")
        .update(
          new X509Certificate(cert).publicKey.export({
            type: "spki",
            format: "der"
          })
        )
        .digest("base64url")
    };
  }
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function member(id: "client" | "server") {
  return {
    deviceId: id,
    signingPublicKey: keys[id].publicKey.export({ format: "jwk" }).x!,
    transportSpkiSha256: tls[id]!.pin
  };
}
function config(
  id: "client" | "server",
  lookup: PeerOnlineAuthOptions["lookupMembership"] = async (
    _group,
    local,
    peer
  ) => ({
    revision: "one",
    local: member(local as "client" | "server"),
    peer: member(peer as "client" | "server")
  })
) {
  return {
    cert: tls[id]!.cert,
    key: tls[id]!.key,
    groupId: "group",
    localDeviceId: id,
    signingPrivateKey: keys[id].privateKey,
    timeoutMs: 500,
    lookupMembership: lookup
  };
}
describe("member TLS quarantine", () => {
  it("authenticates dynamically enrolled self-signed peers without exposing sockets", async () => {
    let accepted!: (value: { peerDeviceId: string; close: () => void }) => void;
    const session = new Promise<{ peerDeviceId: string; close: () => void }>(
      (resolve) => {
        accepted = resolve;
      }
    );
    const listener = await listenPeerOnlineMembers({
      ...config("server"),
      host: "127.0.0.1",
      port: 0,
      onSession: accepted,
      onError: () => {}
    });
    try {
      const client = await connectPeerOnlineMember({
        ...config("client"),
        peerDeviceId: "server",
        host: "127.0.0.1",
        port: listener.port
      });
      const server = await session;
      expect(client.peerDeviceId).toBe("server");
      expect(server.peerDeviceId).toBe("client");
      expect(client).not.toHaveProperty("socket");
      client.close();
      server.close();
    } finally {
      await listener.close();
    }
  });
  it("hands each authenticated session one bounded framed channel", async () => {
    let accepted!: (value: MemberSession) => void;
    const session = new Promise<MemberSession>((resolve) => {
      accepted = resolve;
    });
    const listener = await listenPeerOnlineMembers({
      ...config("server"),
      host: "127.0.0.1",
      port: 0,
      onSession: accepted,
      onError: () => {}
    });
    try {
      const client = await connectPeerOnlineMember({
        ...config("client"),
        peerDeviceId: "server",
        host: "127.0.0.1",
        port: listener.port
      });
      const server = await session;
      expect(client.membershipRevision).toBe("one");
      expect(server.membershipRevision).toBe("one");
      const clientChannel = client.openChannel();
      const serverChannel = server.openChannel();
      expect(() => client.openChannel()).toThrow(/already open/);
      await clientChannel.send(Buffer.from("hello"));
      expect((await serverChannel.receive())?.toString()).toBe("hello");
      await serverChannel.send(Buffer.from("world"));
      expect((await clientChannel.receive())?.toString()).toBe("world");
      clientChannel.close();
      serverChannel.close();
    } finally {
      await listener.close();
    }
  });
  it.each(["unknown", "pin mismatch", "revoked", "fork", "revision change"])(
    "rejects %s without handing out a session",
    async (mode) => {
      let calls = 0;
      let accepted = 0;
      const lookup: PeerOnlineAuthOptions["lookupMembership"] = async (
        _group,
        local,
        peer
      ) => {
        calls++;
        if (
          mode === "unknown" ||
          mode === "fork" ||
          (mode === "revoked" && calls > 1)
        )
          return null;
        const snapshot = {
          revision: mode === "revision change" && calls > 1 ? "two" : "one",
          local: member(local as "client" | "server"),
          peer: member(peer as "client" | "server")
        };
        if (mode === "pin mismatch")
          snapshot.peer.transportSpkiSha256 =
            Buffer.alloc(32).toString("base64url");
        return snapshot;
      };
      const listener = await listenPeerOnlineMembers({
        ...config("server", lookup),
        host: "127.0.0.1",
        port: 0,
        onSession: () => {
          accepted++;
        },
        onError: () => {}
      });
      try {
        await expect(
          connectPeerOnlineMember({
            ...config("client"),
            peerDeviceId: "server",
            host: "127.0.0.1",
            port: listener.port
          })
        ).rejects.toThrow();
        expect(accepted).toBe(0);
      } finally {
        await listener.close();
      }
    }
  );
  it("does not confirm authentication while the server final membership check is pending", async () => {
    let calls = 0;
    let started!: () => void;
    let release!: (value: null) => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const lookup: PeerOnlineAuthOptions["lookupMembership"] = async (
      _group,
      local,
      peer
    ) => {
      calls++;
      if (calls === 4) {
        started();
        return new Promise<null>((resolve) => {
          release = resolve;
        });
      }
      return {
        revision: "one",
        local: member(local as "client" | "server"),
        peer: member(peer as "client" | "server")
      };
    };
    let accepted = 0;
    const listener = await listenPeerOnlineMembers({
      ...config("server", lookup),
      timeoutMs: 2000,
      host: "127.0.0.1",
      port: 0,
      onSession: () => {
        accepted++;
      },
      onError: () => {}
    });
    try {
      let clientCompleted = false;
      const client = connectPeerOnlineMember({
        ...config("client"),
        timeoutMs: 2000,
        peerDeviceId: "server",
        host: "127.0.0.1",
        port: listener.port
      }).then(
        (session) => {
          clientCompleted = true;
          session.close();
          return true;
        },
        () => false
      );
      await waiting;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(clientCompleted).toBe(false);
      release(null);
      expect(await client).toBe(false);
      expect(accepted).toBe(0);
    } finally {
      release?.(null);
      await listener.close();
    }
  });
  it("sends no preface or proof to a server with an unenrolled pin", async () => {
    let bytes = 0;
    const server = createServer(
      {
        cert: tls.server!.cert,
        key: tls.server!.key,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
        ALPNProtocols: ["koed-peer-online/1"]
      },
      (socket) => {
        socket.on("data", (data: Buffer) => {
          bytes += data.length;
        });
        socket.on("error", () => {});
      }
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("Invalid address");
    const lookup: PeerOnlineAuthOptions["lookupMembership"] = async (
      _group,
      local,
      peer
    ) => ({
      revision: "one",
      local: member(local as "client" | "server"),
      peer: {
        ...member(peer as "client" | "server"),
        transportSpkiSha256: Buffer.alloc(32).toString("base64url")
      }
    });
    try {
      await expect(
        connectPeerOnlineMember({
          ...config("client", lookup),
          peerDeviceId: "server",
          host: "127.0.0.1",
          port: bound.port
        })
      ).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(bytes).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("rejects a client without its enrolled signing private key", async () => {
    let accepted = 0;
    const listener = await listenPeerOnlineMembers({
      ...config("server"),
      host: "127.0.0.1",
      port: 0,
      onSession: () => {
        accepted++;
      },
      onError: () => {}
    });
    try {
      await expect(
        connectPeerOnlineMember({
          ...config("client"),
          signingPrivateKey: generateKeyPairSync("ed25519").privateKey,
          peerDeviceId: "server",
          host: "127.0.0.1",
          port: listener.port
        })
      ).rejects.toThrow();
      expect(accepted).toBe(0);
    } finally {
      await listener.close();
    }
  });
  it("does not resume TLS sessions", async () => {
    const listener = await listenPeerOnlineMembers({
      ...config("server"),
      timeoutMs: 300,
      host: "127.0.0.1",
      port: 0,
      onSession: () => {},
      onError: () => {}
    });
    const open = (session?: Buffer) =>
      connect({
        host: "127.0.0.1",
        port: listener.port,
        cert: tls.client!.cert,
        key: tls.client!.key,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
        ALPNProtocols: ["koed-peer-online/1"],
        session
      });
    try {
      const first = open();
      first.on("error", () => {});
      let ticket: Buffer | undefined;
      first.on("session", (value: Buffer) => {
        ticket = value;
      });
      await new Promise<void>((resolve, reject) => {
        first.once("secureConnect", resolve);
        first.once("error", reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      first.destroy();
      expect(ticket).toBeDefined();
      const second = open(ticket);
      second.on("error", () => {});
      await new Promise<void>((resolve, reject) => {
        second.once("secureConnect", resolve);
        second.once("error", reject);
      });
      expect(second.isSessionReused()).toBe(false);
      second.destroy();
    } finally {
      await listener.close();
    }
  });
  it("rejects an actually resumed TLS connection before membership lookup", async () => {
    const server = createServer(
      {
        cert: tls.server!.cert,
        key: tls.server!.key,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        ALPNProtocols: ["koed-peer-online/1"]
      },
      (socket) => {
        socket.on("error", () => {});
      }
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("Invalid address");
    const open = (session?: Buffer) =>
      connect({
        host: "127.0.0.1",
        port: bound.port,
        cert: tls.client!.cert,
        key: tls.client!.key,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        ALPNProtocols: ["koed-peer-online/1"],
        session
      });
    const first = open();
    first.on("error", () => {});
    try {
      const ticket = await new Promise<Buffer>((resolve, reject) => {
        first.once("session", resolve);
        first.once("error", reject);
      });
      first.destroy();
      const resumed = open(ticket);
      resumed.on("error", () => {});
      try {
        await new Promise<void>((resolve, reject) => {
          resumed.once("secureConnect", resolve);
          resumed.once("error", reject);
        });
        expect(resumed.isSessionReused()).toBe(true);
        let lookups = 0;
        await expect(
          authenticatePeerOnline(resumed, {
            ...config("client"),
            role: "client",
            peerDeviceId: "server",
            transportProfile: "membership-pin",
            lookupMembership: async () => {
              lookups++;
              return null;
            }
          })
        ).rejects.toThrow("Invalid peer authentication configuration");
        expect(lookups).toBe(0);
      } finally {
        resumed.destroy();
      }
    } finally {
      first.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("rejects missing client certificates and wrong ALPN before a session", async () => {
    let accepted = 0;
    const listener = await listenPeerOnlineMembers({
      ...config("server"),
      host: "127.0.0.1",
      port: 0,
      onSession: () => {
        accepted++;
      },
      onError: () => {}
    });
    try {
      for (const options of [
        { ALPNProtocols: ["koed-peer-online/1"] },
        {
          ALPNProtocols: ["other"],
          cert: tls.client!.cert,
          key: tls.client!.key
        }
      ]) {
        const socket = connect({
          host: "127.0.0.1",
          port: listener.port,
          rejectUnauthorized: false,
          ...options
        });
        await new Promise<void>((resolve) => {
          socket.on("error", () => {});
          socket.once("close", () => resolve());
        });
      }
      expect(accepted).toBe(0);
    } finally {
      await listener.close();
    }
  });
  it.each(["oversized", "wrong identity", "stalled"])(
    "rejects %s preface before a session",
    async (mode) => {
      let accepted = 0;
      const listener = await listenPeerOnlineMembers({
        ...config("server"),
        timeoutMs: 100,
        host: "127.0.0.1",
        port: 0,
        onSession: () => {
          accepted++;
        },
        onError: () => {}
      });
      try {
        const socket = connect({
          host: "127.0.0.1",
          port: listener.port,
          cert: tls.client!.cert,
          key: tls.client!.key,
          rejectUnauthorized: false,
          minVersion: "TLSv1.3",
          ALPNProtocols: ["koed-peer-online/1"]
        });
        socket.on("error", () => {});
        await new Promise<void>((resolve, reject) => {
          socket.once("secureConnect", resolve);
          socket.once("error", reject);
        });
        if (mode === "oversized") {
          const header = Buffer.alloc(4);
          header.writeUInt32BE(1025);
          socket.write(header);
        }
        if (mode === "wrong identity") {
          const body = Buffer.from(
            JSON.stringify(["other-group", "client", "server"])
          );
          const header = Buffer.alloc(4);
          header.writeUInt32BE(body.length);
          socket.write(Buffer.concat([header, body]));
        }
        await new Promise<void>((resolve) =>
          socket.once("close", () => resolve())
        );
        expect(accepted).toBe(0);
      } finally {
        await listener.close();
      }
    }
  );
  it.each([
    ["peer disconnect", 1],
    ["peer disconnect", 2],
    ["shutdown", 1],
    ["shutdown", 2]
  ] as const)(
    "aborts pending membership lookup on %s at lookup %i",
    async (reason, pendingAt) => {
      let calls = 0;
      let started!: () => void;
      let aborted!: () => void;
      const waiting = new Promise<void>((resolve) => {
        started = resolve;
      });
      const cancelled = new Promise<void>((resolve) => {
        aborted = resolve;
      });
      const lookup: PeerOnlineAuthOptions["lookupMembership"] = (
        _group,
        local,
        peer,
        signal
      ) => {
        if (++calls !== pendingAt)
          return Promise.resolve({
            revision: "one",
            local: member(local as "client" | "server"),
            peer: member(peer as "client" | "server")
          });
        return new Promise((resolve) => {
          started();
          signal.addEventListener(
            "abort",
            () => {
              aborted();
              resolve(null);
            },
            { once: true }
          );
        });
      };
      const listener = await listenPeerOnlineMembers({
        ...config("server", lookup),
        timeoutMs: 3000,
        host: "127.0.0.1",
        port: 0,
        onSession: () => {},
        onError: () => {}
      });
      const socket = connect({
        host: "127.0.0.1",
        port: listener.port,
        cert: tls.client!.cert,
        key: tls.client!.key,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
        ALPNProtocols: ["koed-peer-online/1"]
      });
      socket.on("error", () => {});
      let closing: Promise<void> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("secureConnect", resolve);
          socket.once("error", reject);
        });
        const body = Buffer.from(JSON.stringify(["group", "client", "server"]));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length);
        socket.write(Buffer.concat([header, body]));
        await waiting;
        if (reason === "peer disconnect") {
          socket.write(Buffer.from([0, 0, 0, 33, 1]));
          socket.end();
        } else closing = listener.close();
        expect(
          await Promise.race([
            cancelled.then(() => true),
            new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(false), 300)
            )
          ])
        ).toBe(true);
      } finally {
        socket.destroy();
        await (closing ?? listener.close());
      }
    }
  );
  it("times out when membership lookup does not finish", async () => {
    const listener = await listenPeerOnlineMembers({
      ...config("server"),
      host: "127.0.0.1",
      port: 0,
      onSession: () => {},
      onError: () => {}
    });
    try {
      const pending: PeerOnlineAuthOptions["lookupMembership"] = () =>
        new Promise(() => {});
      await expect(
        connectPeerOnlineMember({
          ...config("client", pending),
          timeoutMs: 50,
          peerDeviceId: "server",
          host: "127.0.0.1",
          port: listener.port
        })
      ).rejects.toThrow();
    } finally {
      await listener.close();
    }
  });
});
