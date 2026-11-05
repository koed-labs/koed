import {
  createHash,
  createPrivateKey,
  createPublicKey,
  X509Certificate
} from "node:crypto";
import { connect, createSecureContext, createServer } from "node:tls";
import { describe, expect, it } from "vitest";
import {
  createPeerOnlineCertificate,
  loadPeerOnlineCertificate,
  type PeerOnlineCertificateStore
} from "./peer-online-certificate.js";

function store(): PeerOnlineCertificateStore & { value: string | null } {
  return {
    value: null,
    async read() {
      return this.value;
    },
    async create(value) {
      if (this.value !== null) return false;
      this.value = value;
      return true;
    }
  };
}

const authorize = async () => true;

describe("peer online certificate custody", () => {
  it("creates a self-signed TLS certificate and loads the same key and pin", async () => {
    const storage = store();
    const created = await createPeerOnlineCertificate(storage, authorize);
    const loaded = await loadPeerOnlineCertificate(storage);
    expect(loaded).toEqual(created);
    expect(await createPeerOnlineCertificate(storage, authorize)).toEqual(
      created
    );
    const cert = new X509Certificate(created.certificate);
    expect(cert.verify(cert.publicKey)).toBe(true);
    const publicDer = cert.publicKey.export({ type: "spki", format: "der" });
    expect(created.spkiPin).toBe(
      createHash("sha256").update(publicDer).digest("base64url")
    );
    expect(
      createPublicKey(createPrivateKey(created.privateKey)).export({
        type: "spki",
        format: "der"
      })
    ).toEqual(publicDer);
    expect(() =>
      createSecureContext({
        cert: created.certificate,
        key: created.privateKey,
        minVersion: "TLSv1.3"
      })
    ).not.toThrow();
  });

  it("authenticates a TLS 1.3 handshake with the generated certificate", async () => {
    const credential = await createPeerOnlineCertificate(store(), authorize);
    const server = createServer(
      {
        cert: credential.certificate,
        key: credential.privateKey,
        minVersion: "TLSv1.3"
      },
      (socket) => socket.end()
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("missing server address");
      await new Promise<void>((resolve, reject) => {
        const socket = connect(
          {
            host: "127.0.0.1",
            port: address.port,
            servername: "Koed Peer Online",
            ca: credential.certificate,
            minVersion: "TLSv1.3",
            checkServerIdentity: () => undefined
          },
          () => {
            try {
              expect(socket.authorized).toBe(true);
              expect(socket.getProtocol()).toBe("TLSv1.3");
              const peer = new X509Certificate(socket.getPeerCertificate().raw);
              expect(
                createHash("sha256")
                  .update(
                    peer.publicKey.export({ type: "spki", format: "der" })
                  )
                  .digest("base64url")
              ).toBe(credential.spkiPin);
              socket.end();
              resolve();
            } catch (error) {
              reject(error);
              socket.destroy();
            }
          }
        );
        socket.once("error", reject);
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("fails closed on missing, malformed, partial and mismatched stored material", async () => {
    const storage = store();
    await expect(loadPeerOnlineCertificate(storage)).rejects.toThrow();
    const first = await createPeerOnlineCertificate(storage, authorize);
    const saved = storage.value!;
    for (const value of [
      "not json",
      "{}",
      JSON.stringify({ version: 1, certificate: first.certificate })
    ]) {
      storage.value = value;
      await expect(loadPeerOnlineCertificate(storage)).rejects.toThrow();
      await expect(
        createPeerOnlineCertificate(storage, authorize)
      ).rejects.toThrow();
    }
    const otherStore = store();
    const other = await createPeerOnlineCertificate(otherStore, authorize);
    storage.value = JSON.stringify({
      version: 1,
      certificate: first.certificate,
      privateKey: other.privateKey
    });
    await expect(loadPeerOnlineCertificate(storage)).rejects.toThrow();
    storage.value = null;
    await expect(loadPeerOnlineCertificate(storage)).rejects.toThrow();
    await expect(
      createPeerOnlineCertificate(storage, async () => false)
    ).rejects.toThrow();
    storage.value = saved;
    expect(await loadPeerOnlineCertificate(storage)).toEqual(first);
  });

  it("propagates storage errors and rejects a missing concurrent winner", async () => {
    const failure = new Error("secure store unavailable");
    const brokenRead: PeerOnlineCertificateStore = {
      read: async () => {
        throw failure;
      },
      create: async () => true
    };
    await expect(loadPeerOnlineCertificate(brokenRead)).rejects.toBe(failure);
    await expect(
      createPeerOnlineCertificate(brokenRead, authorize)
    ).rejects.toBe(failure);
    const brokenWrite: PeerOnlineCertificateStore = {
      read: async () => null,
      create: async () => {
        throw failure;
      }
    };
    await expect(
      createPeerOnlineCertificate(brokenWrite, authorize)
    ).rejects.toBe(failure);
    const lostWinner: PeerOnlineCertificateStore = {
      read: async () => null,
      create: async () => false
    };
    await expect(
      createPeerOnlineCertificate(lostWinner, authorize)
    ).rejects.toThrow();
  });

  it("serializes competing creation through atomic secure store", async () => {
    const storage = store();
    const [one, two] = await Promise.all([
      createPeerOnlineCertificate(storage, authorize),
      createPeerOnlineCertificate(storage, authorize)
    ]);
    expect(one).toEqual(two);
    expect(await loadPeerOnlineCertificate(storage)).toEqual(one);
  });
});
