import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticatePeerOnline } from "./peer-online-auth.js";

let cert: Buffer;
let key: Buffer;
let clientCert: Buffer;
let clientTlsKey: Buffer;
let directory: string;
let serverFingerprint: string;
let clientFingerprint: string;
const clientKey = generateKeyPairSync("ed25519");
const serverKey = generateKeyPairSync("ed25519");

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "koed-auth-test-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost"
    ],
    { stdio: "ignore" }
  );
  cert = readFileSync(join(directory, "cert.pem"));
  key = readFileSync(join(directory, "key.pem"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "client-key.pem"),
      "-out",
      join(directory, "client-cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=client"
    ],
    { stdio: "ignore" }
  );
  clientCert = readFileSync(join(directory, "client-cert.pem"));
  clientTlsKey = readFileSync(join(directory, "client-key.pem"));
  const fingerprint = (certificate: Buffer) =>
    createHash("sha256")
      .update(
        new X509Certificate(certificate).publicKey.export({
          type: "spki",
          format: "der"
        })
      )
      .digest("base64url");
  serverFingerprint = fingerprint(cert);
  clientFingerprint = fingerprint(clientCert);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function member(id: "client" | "server") {
  const publicKey = (id === "client" ? clientKey : serverKey).publicKey;
  return {
    deviceId: id,
    signingPublicKey: publicKey.export({ format: "jwk" }).x!,
    transportSpkiSha256: id === "client" ? clientFingerprint : serverFingerprint
  };
}

async function sockets(): Promise<[TLSSocket, TLSSocket, () => void]> {
  const server = createServer({
    cert,
    key,
    ca: [cert, clientCert],
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
    ALPNProtocols: ["koed-peer-online/1"]
  });
  const accepted = new Promise<TLSSocket>((resolve, reject) => {
    server.once("secureConnection", resolve);
    server.once("tlsClientError", reject);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bad address");
  const client = connect({
    host: "127.0.0.1",
    port: address.port,
    servername: "localhost",
    cert: clientCert,
    key: clientTlsKey,
    ca: cert,
    minVersion: "TLSv1.3",
    ALPNProtocols: ["koed-peer-online/1"]
  });
  await new Promise<void>((resolve, reject) => {
    client.once("secureConnect", resolve);
    client.once("error", reject);
  });
  const remote = await accepted;
  client.on("error", () => {});
  remote.on("error", () => {});
  return [
    client,
    remote,
    () => {
      client.destroy();
      remote.destroy();
      server.close();
    }
  ];
}

function options(role: "client" | "server") {
  return {
    role,
    groupId: "group",
    localDeviceId: role,
    peerDeviceId: role === "client" ? "server" : "client",
    signingPrivateKey:
      role === "client" ? clientKey.privateKey : serverKey.privateKey,
    timeoutMs: 1000,
    lookupMembership: async (_group: string, local: string, peer: string) => ({
      revision: "one",
      local: member(local as "client" | "server"),
      peer: member(peer as "client" | "server")
    })
  } as const;
}

describe("peer application authentication", () => {
  it("authenticates both members over a real mutually authenticated TLS channel", async () => {
    const [client, server, close] = await sockets();
    try {
      const results = await Promise.all([
        authenticatePeerOnline(client, options("client")),
        authenticatePeerOnline(server, options("server"))
      ]);
      expect(results.map((result) => result.peerDeviceId)).toEqual([
        "server",
        "client"
      ]);
    } finally {
      close();
    }
  });

  it("pauses a previously flowing socket while membership lookup waits", async () => {
    const [client, server, close] = await sockets();
    try {
      server.resume();
      const lookup = options("server").lookupMembership;
      const delayed = {
        ...options("server"),
        lookupMembership: async (
          group: string,
          local: string,
          peer: string
        ) => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return lookup(group, local, peer);
        }
      };
      const result = await Promise.all([
        authenticatePeerOnline(client, options("client")),
        authenticatePeerOnline(server, delayed)
      ]);
      expect(result.map((entry) => entry.peerDeviceId)).toEqual([
        "server",
        "client"
      ]);
    } finally {
      close();
    }
  });

  it("rejects a revoked member and closes the socket", async () => {
    const [client, server, close] = await sockets();
    try {
      const bad = { ...options("server"), lookupMembership: async () => null };
      const result = await Promise.allSettled([
        authenticatePeerOnline(client, options("client")),
        authenticatePeerOnline(server, bad)
      ]);
      expect(result.every((entry) => entry.status === "rejected")).toBe(true);
      expect(server.destroyed).toBe(true);
    } finally {
      close();
    }
  });

  it("rejects different group identifiers", async () => {
    const [client, server, close] = await sockets();
    try {
      const result = await Promise.allSettled([
        authenticatePeerOnline(client, options("client")),
        authenticatePeerOnline(server, {
          ...options("server"),
          groupId: "other"
        })
      ]);
      expect(result.every((entry) => entry.status === "rejected")).toBe(true);
    } finally {
      close();
    }
  });

  it("rejects a substituted TLS certificate pin", async () => {
    const [client, server, close] = await sockets();
    try {
      const bad = {
        ...options("server"),
        lookupMembership: async () => ({
          revision: "one",
          local: member("server"),
          peer: { ...member("client"), transportSpkiSha256: serverFingerprint }
        })
      };
      const result = await Promise.allSettled([
        authenticatePeerOnline(client, options("client")),
        authenticatePeerOnline(server, bad)
      ]);
      expect(result.every((entry) => entry.status === "rejected")).toBe(true);
    } finally {
      close();
    }
  });

  it("rejects a signing key not enrolled for the local device", async () => {
    const [client, server, close] = await sockets();
    try {
      const result = await Promise.allSettled([
        authenticatePeerOnline(client, {
          ...options("client"),
          signingPrivateKey: serverKey.privateKey
        }),
        authenticatePeerOnline(server, options("server"))
      ]);
      expect(result.every((entry) => entry.status === "rejected")).toBe(true);
    } finally {
      close();
    }
  });

  it("rejects changed membership revision during the exchange", async () => {
    const [client, server, close] = await sockets();
    let calls = 0;
    try {
      const lookup = options("server").lookupMembership;
      const changed = {
        ...options("server"),
        lookupMembership: async (
          group: string,
          local: string,
          peer: string
        ) => ({
          ...(await lookup(group, local, peer)),
          revision: ++calls === 1 ? "one" : "two"
        })
      };
      const result = await Promise.allSettled([
        authenticatePeerOnline(client, options("client")),
        authenticatePeerOnline(server, changed)
      ]);
      expect(result.every((entry) => entry.status === "rejected")).toBe(true);
    } finally {
      close();
    }
  });

  it("rejects oversized frames before buffering their contents", async () => {
    const [client, server, close] = await sockets();
    try {
      const auth = authenticatePeerOnline(server, options("server"));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(0xffffffff);
      client.write(header);
      await expect(auth).rejects.toThrow("Invalid peer authentication frame");
      expect(server.destroyed).toBe(true);
    } finally {
      close();
    }
  });

  it("rejects a forged server proof", async () => {
    const [client, server, close] = await sockets();
    try {
      server.once("data", () => {
        const frame = Buffer.alloc(101);
        frame.writeUInt32BE(97);
        frame[4] = 2;
        server.write(frame);
      });
      await expect(
        authenticatePeerOnline(client, options("client"))
      ).rejects.toThrow("Server proof rejected");
    } finally {
      close();
    }
  });

  it("rejects a replay when only the TLS exporter differs", async () => {
    const [firstClient, firstServer, closeFirst] = await sockets();
    const [client, server, close] = await sockets();
    try {
      const label = "EXPORTER-koed-peer-online-auth-v1";
      const exporter = (socket: TLSSocket) =>
        socket.exportKeyingMaterial(32, label, Buffer.alloc(0));
      expect(exporter(firstClient).equals(exporter(firstServer))).toBe(true);
      expect(exporter(client).equals(exporter(server))).toBe(true);
      expect(exporter(firstClient).equals(exporter(client))).toBe(false);

      // Forward the client's real random nonce to the first server, then relay
      // its unchanged nonce and signature back over the other TLS connection.
      const hello = new Promise<Buffer>((resolve) =>
        server.once("data", resolve)
      );
      const clientAuth = authenticatePeerOnline(client, options("client"));
      const clientResult = expect(clientAuth).rejects.toThrow(
        "Server proof rejected"
      );
      const firstAuth = authenticatePeerOnline(firstServer, options("server"));
      const firstResult = firstAuth.then(
        () => null,
        (error: unknown) => error
      );
      const clientHello = await hello;
      expect(clientHello.length).toBe(37);
      const response = new Promise<Buffer>((resolve) =>
        firstClient.once("data", resolve)
      );
      firstClient.write(clientHello);
      const serverProof = await response;
      expect(serverProof.length).toBe(101);
      server.write(serverProof);
      await clientResult;
      firstClient.destroy();
      expect(await firstResult).toBeInstanceOf(Error);
    } finally {
      close();
      closeFirst();
    }
  });

  it("accepts fragmented framing but rejects an unexpected message type", async () => {
    const [client, server, close] = await sockets();
    try {
      const auth = authenticatePeerOnline(server, options("server"));
      const frame = Buffer.alloc(37);
      frame.writeUInt32BE(33);
      frame[4] = 9;
      for (const byte of frame) client.write(Buffer.from([byte]));
      await expect(auth).rejects.toThrow(
        "Unexpected peer authentication frame"
      );
    } finally {
      close();
    }
  });

  it("aborts a stalled membership lookup at the deadline", async () => {
    const [, server, close] = await sockets();
    let aborted = false;
    try {
      const lookupMembership = async (
        _group: string,
        _local: string,
        _peer: string,
        signal: AbortSignal
      ): Promise<null> =>
        new Promise((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve(null);
            },
            { once: true }
          )
        );
      await expect(
        authenticatePeerOnline(server, {
          ...options("server"),
          lookupMembership,
          timeoutMs: 30
        })
      ).rejects.toThrow("timed out");
      expect(aborted).toBe(true);
      expect(server.destroyed).toBe(true);
    } finally {
      close();
    }
  });

  it("rejects repeated authentication on the same socket", async () => {
    const [client, server, close] = await sockets();
    try {
      await Promise.all([
        authenticatePeerOnline(client, options("client")),
        authenticatePeerOnline(server, options("server"))
      ]);
      await expect(
        authenticatePeerOnline(client, options("client"))
      ).rejects.toThrow("already attempted");
    } finally {
      close();
    }
  });

  it("times out and destroys a silent connection", async () => {
    const [, server, close] = await sockets();
    try {
      await expect(
        authenticatePeerOnline(server, { ...options("server"), timeoutMs: 30 })
      ).rejects.toThrow();
      expect(server.destroyed).toBe(true);
    } finally {
      close();
    }
  });
});
