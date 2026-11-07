import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  X509Certificate,
  type KeyObject
} from "node:crypto";
import type { TLSSocket } from "node:tls";
import type {
  PeerOnlineAuthMember,
  PeerOnlineAuthMembershipSnapshot
} from "@koed/shared";
import { PEER_ONLINE_ALPN } from "./peer-online-tls.js";

export type { PeerOnlineAuthMember } from "@koed/shared";

export interface PeerOnlineAuthOptions {
  role: "client" | "server";
  /** Explicit self-signed membership-pin profile; never changes socket.authorized. */
  transportProfile?: "membership-pin";
  groupId: string;
  localDeviceId: string;
  peerDeviceId: string;
  signingPrivateKey: KeyObject | string;
  timeoutMs: number;
  /** Additional server acceptance fence, run before the signed confirmation. */
  beforeServerConfirmation?: (signal: AbortSignal) => Promise<void>;
  /** Return one atomic, current snapshot with a revision changed by every authorization-relevant update; reject stale, conflicted or incomplete state. Honour cancellation and bound backend work. */
  lookupMembership: (
    groupId: string,
    localDeviceId: string,
    peerDeviceId: string,
    signal: AbortSignal
  ) => Promise<PeerOnlineAuthMembershipSnapshot | null>;
}

const used = new WeakSet<TLSSocket>();
const label = "EXPORTER-koed-peer-online-auth-v1";
const maxFrame = 1024;

function fingerprint(raw: Buffer): string {
  return createHash("sha256")
    .update(
      new X509Certificate(raw).publicKey.export({ type: "spki", format: "der" })
    )
    .digest("base64url");
}

function validPinnedCertificate(raw: Buffer): boolean {
  const certificate = new X509Certificate(raw);
  const key = certificate.publicKey;
  const now = Date.now();
  return (
    key.asymmetricKeyType === "ec" &&
    key.asymmetricKeyDetails?.namedCurve === "prime256v1" &&
    certificate.subject === certificate.issuer &&
    certificate.verify(key) &&
    Date.parse(certificate.validFrom) <= now &&
    Date.parse(certificate.validTo) > now
  );
}

function pinMatches(pin: string, actual: string): boolean {
  if (typeof pin !== "string") return false;
  const decoded = Buffer.from(pin, "base64url");
  const expected = Buffer.from(actual, "base64url");
  return (
    decoded.length === 32 &&
    decoded.toString("base64url") === pin &&
    timingSafeEqual(decoded, expected)
  );
}

function publicKey(member: PeerOnlineAuthMember): KeyObject {
  const bytes = Buffer.from(member.signingPublicKey, "base64url");
  if (
    bytes.length !== 32 ||
    bytes.toString("base64url") !== member.signingPublicKey
  )
    throw new Error("Invalid membership signing key");
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: member.signingPublicKey },
    format: "jwk"
  });
}

function validId(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 256 &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  );
}

function transcript(parts: string[]): Buffer {
  return Buffer.from(JSON.stringify(parts), "utf8");
}

/**
 * Authenticate one exclusively owned, already verified TLS socket. The caller must
 * not read, write, or expose the socket to application code until this resolves.
 * The lookup is a trusted freshness and active-membership boundary. Applications
 * must revalidate/fence later operations and terminate sessions after revocation.
 * Success on one endpoint does not guarantee the other received its last message.
 */
export async function authenticatePeerOnline(
  socket: TLSSocket,
  options: PeerOnlineAuthOptions
): Promise<{ peerDeviceId: string }> {
  if (used.has(socket))
    throw new Error("Socket authentication already attempted");
  used.add(socket);
  socket.pause();
  const controller = new AbortController();
  let active = true;
  let timer: NodeJS.Timeout | undefined;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const fail = (error: Error) => {
    if (active) {
      active = false;
      socket.destroy();
      rejectFailure(error);
    }
  };
  const onClose = () =>
    fail(new Error("Peer authentication connection closed"));
  const onEnd = () => fail(new Error("Peer authentication connection ended"));
  const onError = (error: Error) => fail(error);
  socket.on("error", onError);
  socket.once("close", onClose);
  socket.once("end", onEnd);
  const check = () => {
    if (!active || socket.destroyed || socket.readableEnded)
      throw new Error("Peer authentication stopped");
  };
  const read = async (length: number): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      check();
      const available = Math.min(remaining, socket.readableLength);
      const data =
        available > 0 ? (socket.read(available) as Buffer | null) : null;
      if (data) {
        chunks.push(data);
        remaining -= data.length;
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.off("readable", ready);
          socket.off("close", closed);
          socket.off("error", errored);
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        const closed = () => {
          cleanup();
          reject(new Error("Peer authentication connection closed"));
        };
        const errored = (error: Error) => {
          cleanup();
          reject(error);
        };
        socket.once("readable", ready);
        socket.once("close", closed);
        socket.once("error", errored);
      });
    }
    return Buffer.concat(chunks, length);
  };
  const receive = async (type: number, length: number) => {
    const header = await read(4);
    const size = header.readUInt32BE();
    if (size > maxFrame || size !== length + 1)
      throw new Error("Invalid peer authentication frame");
    const body = await read(size);
    if (body[0] !== type)
      throw new Error("Unexpected peer authentication frame");
    return body.subarray(1);
  };
  const send = (type: number, payload: Buffer) => {
    check();
    const header = Buffer.alloc(5);
    header.writeUInt32BE(payload.length + 1);
    header[4] = type;
    socket.write(Buffer.concat([header, payload]));
  };
  const run = async () => {
    if (
      (options.role !== "client" && options.role !== "server") ||
      (options.transportProfile !== undefined &&
        options.transportProfile !== "membership-pin") ||
      (!socket.authorized && options.transportProfile !== "membership-pin") ||
      socket.isSessionReused() ||
      socket.getProtocol() !== "TLSv1.3" ||
      socket.alpnProtocol !== PEER_ONLINE_ALPN ||
      !validId(options.groupId) ||
      !validId(options.localDeviceId) ||
      !validId(options.peerDeviceId) ||
      options.localDeviceId === options.peerDeviceId ||
      typeof options.lookupMembership !== "function" ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 2_147_483_647
    )
      throw new Error("Invalid peer authentication configuration");
    const localCert = socket.getCertificate();
    const peerCert = socket.getPeerCertificate();
    if (
      !localCert ||
      !("raw" in localCert) ||
      !Buffer.isBuffer(localCert.raw) ||
      !peerCert?.raw
    )
      throw new Error("Missing TLS certificates");
    if (
      options.transportProfile === "membership-pin" &&
      (!validPinnedCertificate(localCert.raw) ||
        !validPinnedCertificate(peerCert.raw))
    )
      throw new Error("Invalid pinned TLS certificate");
    const localPin = fingerprint(localCert.raw);
    const peerPin = fingerprint(peerCert.raw);
    const privateKey =
      typeof options.signingPrivateKey === "string"
        ? createPrivateKey({
            key: Buffer.from(options.signingPrivateKey, "base64"),
            format: "der",
            type: "pkcs8"
          })
        : options.signingPrivateKey;
    if (
      privateKey.type !== "private" ||
      privateKey.asymmetricKeyType !== "ed25519"
    )
      throw new Error("Invalid signing private key");
    const lookup = async () => {
      const snapshot = await options.lookupMembership(
        options.groupId,
        options.localDeviceId,
        options.peerDeviceId,
        controller.signal
      );
      check();
      if (!snapshot || !validId(snapshot.revision))
        throw new Error("Peer membership rejected");
      const { local, peer, revision } = snapshot;
      if (
        !local ||
        !peer ||
        local.deviceId !== options.localDeviceId ||
        peer.deviceId !== options.peerDeviceId ||
        !pinMatches(local.transportSpkiSha256, localPin) ||
        !pinMatches(peer.transportSpkiSha256, peerPin)
      )
        throw new Error("Peer membership rejected");
      const localKey = publicKey(local);
      const peerKey = publicKey(peer);
      if (
        !createPublicKey(privateKey)
          .export({ type: "spki", format: "der" })
          .equals(localKey.export({ type: "spki", format: "der" }))
      )
        throw new Error("Local signing key mismatch");
      return { local: { ...local }, peer: { ...peer }, peerKey, revision };
    };
    const members = await lookup();
    const exporter = socket
      .exportKeyingMaterial(32, label, Buffer.alloc(0))
      .toString("base64url");
    const client =
      options.role === "client" ? options.localDeviceId : options.peerDeviceId;
    const server =
      options.role === "server" ? options.localDeviceId : options.peerDeviceId;
    const clientPin = options.role === "client" ? localPin : peerPin;
    const serverPin = options.role === "server" ? localPin : peerPin;
    let clientNonce: Buffer;
    let serverNonce: Buffer;
    const proof = (role: string) =>
      transcript([
        "koed/peer-online-auth/v1",
        role,
        options.groupId,
        client,
        server,
        clientPin,
        serverPin,
        exporter,
        clientNonce.toString("base64url"),
        serverNonce.toString("base64url")
      ]);
    if (options.role === "client") {
      clientNonce = randomBytes(32);
      send(1, clientNonce);
      const response = await receive(2, 96);
      serverNonce = response.subarray(0, 32);
      if (
        !verify(null, proof("server"), members.peerKey, response.subarray(32))
      )
        throw new Error("Server proof rejected");
      send(3, sign(null, proof("client"), privateKey));
      const confirmation = await receive(4, 64);
      if (!verify(null, proof("server-confirm"), members.peerKey, confirmation))
        throw new Error("Server confirmation rejected");
    } else {
      clientNonce = await receive(1, 32);
      serverNonce = randomBytes(32);
      send(
        2,
        Buffer.concat([serverNonce, sign(null, proof("server"), privateKey)])
      );
      const signature = await receive(3, 64);
      if (!verify(null, proof("client"), members.peerKey, signature))
        throw new Error("Client proof rejected");
    }
    const current = await lookup();
    if (
      current.revision !== members.revision ||
      current.local.signingPublicKey !== members.local.signingPublicKey ||
      current.peer.signingPublicKey !== members.peer.signingPublicKey
    )
      throw new Error("Membership changed during authentication");
    if (options.role === "server") {
      if (options.beforeServerConfirmation) {
        await options.beforeServerConfirmation(controller.signal);
        check();
      }
      send(4, sign(null, proof("server-confirm"), privateKey));
    }
    check();
    socket.pause();
    return { peerDeviceId: options.peerDeviceId };
  };
  try {
    timer = setTimeout(
      () => fail(new Error("Peer authentication timed out")),
      Number.isSafeInteger(options.timeoutMs) &&
        options.timeoutMs > 0 &&
        options.timeoutMs <= 2_147_483_647
        ? options.timeoutMs
        : 1
    );
    return await Promise.race([run(), failure]);
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    active = false;
    controller.abort();
    clearTimeout(timer);
    socket.off("error", onError);
    socket.off("close", onClose);
    socket.off("end", onEnd);
  }
}
