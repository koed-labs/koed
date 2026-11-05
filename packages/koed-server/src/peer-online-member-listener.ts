import {
  constants,
  createHash,
  timingSafeEqual,
  X509Certificate,
  type KeyObject
} from "node:crypto";
import { type Socket } from "node:net";
import { connect, createServer, type TLSSocket } from "node:tls";
import {
  authenticatePeerOnline,
  type PeerOnlineAuthOptions
} from "./peer-online-auth.js";
import {
  PeerOnlineMessageChannel,
  type PeerOnlineMessageChannelOptions
} from "./peer-online-message-channel.js";
import { PEER_ONLINE_ALPN } from "./peer-online-tls.js";

type Lookup = PeerOnlineAuthOptions["lookupMembership"];
type Snapshot = NonNullable<Awaited<ReturnType<Lookup>>>;
export interface MemberOptions {
  cert: string | Buffer;
  key: string | Buffer;
  groupId: string;
  localDeviceId: string;
  signingPrivateKey: KeyObject | string;
  timeoutMs: number;
  lookupMembership: Lookup;
}
export interface MemberSession {
  readonly peerDeviceId: string;
  /** Membership revision both peers were authenticated against. Callers must
   * still recheck current membership at every durable commit. */
  readonly membershipRevision: string;
  /** Takes ownership of the authenticated socket as a bounded framed channel.
   * May be called once; grants no authorization by itself. */
  openChannel(
    options?: PeerOnlineMessageChannelOptions
  ): PeerOnlineMessageChannel;
  close(): void;
}
export interface MemberListenerOptions extends MemberOptions {
  host: string;
  port: number;
  onSession(session: MemberSession): void;
  onError(error: Error): void;
}
export interface MemberClientOptions extends MemberOptions {
  host: string;
  port: number;
  peerDeviceId: string;
}

function validId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    Buffer.byteLength(id) <= 256 &&
    !Array.from(id).some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  );
}
function validate(options: MemberOptions): void {
  if (
    !options.cert ||
    !options.key ||
    !validId(options.groupId) ||
    !validId(options.localDeviceId) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 2_147_483_647 ||
    typeof options.lookupMembership !== "function"
  )
    throw new Error("Invalid member TLS options");
}
function pin(raw: Buffer): Buffer {
  const certificate = new X509Certificate(raw);
  const key = certificate.publicKey;
  const now = Date.now();
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
    certificate.subject !== certificate.issuer ||
    !certificate.verify(key) ||
    !(
      Date.parse(certificate.validFrom) <= now &&
      Date.parse(certificate.validTo) > now
    )
  )
    throw new Error("Invalid member certificate");
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest();
}
function pinEqual(encoded: string, actual: Buffer): boolean {
  if (typeof encoded !== "string") return false;
  const bytes = Buffer.from(encoded, "base64url");
  return (
    bytes.length === 32 &&
    bytes.toString("base64url") === encoded &&
    timingSafeEqual(bytes, actual)
  );
}
async function bufferedLookup<T>(
  socket: TLSSocket,
  signal: AbortSignal,
  lookup: () => Promise<T>
): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const aborted = () =>
    rejectFailure(new Error("Member authentication stopped"));
  const read = () => {
    let chunk: Buffer | null;
    while ((chunk = socket.read() as Buffer | null)) {
      size += chunk.length;
      if (size > 4096) {
        socket.destroy();
        rejectFailure(new Error("Excess data during membership lookup"));
        return;
      }
      chunks.push(chunk);
    }
  };
  socket.on("readable", read);
  signal.addEventListener("abort", aborted, { once: true });
  try {
    if (signal.aborted) throw new Error("Member authentication stopped");
    read();
    const result = await Promise.race([lookup(), failure]);
    if (signal.aborted || socket.destroyed || socket.readableEnded)
      throw new Error("Member authentication stopped");
    if (size) socket.unshift(Buffer.concat(chunks, size));
    return result;
  } finally {
    socket.off("readable", read);
    signal.removeEventListener("abort", aborted);
  }
}
async function checkMembership(
  socket: TLSSocket,
  options: MemberOptions,
  peerId: string,
  signal: AbortSignal
): Promise<Snapshot> {
  if (
    socket.getProtocol() !== "TLSv1.3" ||
    socket.alpnProtocol !== PEER_ONLINE_ALPN ||
    socket.isSessionReused()
  )
    throw new Error("Invalid TLS profile");
  const local = socket.getCertificate();
  const peer = socket.getPeerCertificate();
  if (!local || !("raw" in local) || !Buffer.isBuffer(local.raw) || !peer?.raw)
    throw new Error("Missing TLS certificate");
  const localPin = pin(local.raw);
  const peerPin = pin(peer.raw);
  const snapshot = await bufferedLookup(socket, signal, () =>
    options.lookupMembership(
      options.groupId,
      options.localDeviceId,
      peerId,
      signal
    )
  );
  if (
    signal.aborted ||
    socket.destroyed ||
    !snapshot ||
    !validId(snapshot.revision) ||
    snapshot.local?.deviceId !== options.localDeviceId ||
    snapshot.peer?.deviceId !== peerId ||
    !pinEqual(snapshot.local.transportSpkiSha256, localPin) ||
    !pinEqual(snapshot.peer.transportSpkiSha256, peerPin)
  )
    throw new Error("Peer membership rejected");
  return {
    revision: snapshot.revision,
    local: { ...snapshot.local },
    peer: { ...snapshot.peer }
  };
}
function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return (
    a.revision === b.revision &&
    a.local.signingPublicKey === b.local.signingPublicKey &&
    a.peer.signingPublicKey === b.peer.signingPublicKey &&
    a.local.transportSpkiSha256 === b.local.transportSpkiSha256 &&
    a.peer.transportSpkiSha256 === b.peer.transportSpkiSha256
  );
}
function readBytes(socket: TLSSocket, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let remaining = size;
    const cleanup = () => {
      socket.off("readable", read);
      socket.off("end", closed);
      socket.off("close", closed);
      socket.off("error", failed);
    };
    const closed = () => {
      cleanup();
      reject(new Error("Connection closed during preface"));
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const read = () => {
      while (remaining > 0 && socket.readableLength) {
        const part = socket.read(
          Math.min(remaining, socket.readableLength)
        ) as Buffer | null;
        if (!part) break;
        chunks.push(part);
        remaining -= part.length;
      }
      if (!remaining) {
        cleanup();
        resolve(Buffer.concat(chunks, size));
      }
    };
    socket.on("readable", read);
    socket.once("end", closed);
    socket.once("close", closed);
    socket.once("error", failed);
    read();
  });
}
async function receivePreface(
  socket: TLSSocket
): Promise<[string, string, string]> {
  const size = (await readBytes(socket, 4)).readUInt32BE();
  if (size < 1 || size > 1024) throw new Error("Invalid member preface");
  const bytes = await readBytes(socket, size);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes))
    throw new Error("Invalid member preface");
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length !== 3 || !value.every(validId))
    throw new Error("Invalid member preface");
  return value as [string, string, string];
}
function sendPreface(socket: TLSSocket, options: MemberClientOptions): void {
  const body = Buffer.from(
    JSON.stringify([
      options.groupId,
      options.localDeviceId,
      options.peerDeviceId
    ])
  );
  if (body.length > 1024) throw new Error("Invalid member preface");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  socket.write(Buffer.concat([header, body]));
}
async function authenticate(
  socket: TLSSocket,
  options: MemberOptions,
  peerId: string,
  role: "client" | "server",
  signal: AbortSignal
): Promise<MemberSession> {
  const before = await checkMembership(socket, options, peerId, signal);
  await authenticatePeerOnline(socket, {
    ...options,
    role,
    peerDeviceId: peerId,
    transportProfile: "membership-pin",
    beforeServerConfirmation: async (authSignal) => {
      const current = await checkMembership(
        socket,
        options,
        peerId,
        AbortSignal.any([signal, authSignal])
      );
      if (!sameSnapshot(before, current))
        throw new Error("Membership changed during authentication");
    },
    lookupMembership: async (group, local, peer, lookupSignal) => {
      const current = await bufferedLookup(socket, lookupSignal, () =>
        options.lookupMembership(group, local, peer, lookupSignal)
      );
      return current && sameSnapshot(before, current) ? current : null;
    }
  });
  if (role === "client") {
    const after = await checkMembership(socket, options, peerId, signal);
    if (!sameSnapshot(before, after))
      throw new Error("Membership changed during authentication");
  }
  let channel: PeerOnlineMessageChannel | undefined;
  return Object.freeze({
    peerDeviceId: peerId,
    membershipRevision: before.revision,
    openChannel(channelOptions?: PeerOnlineMessageChannelOptions) {
      if (channel) throw new Error("Member channel already open");
      channel = new PeerOnlineMessageChannel(socket, channelOptions);
      return channel;
    },
    close: () => socket.destroy()
  });
}
function deadline(
  socket: TLSSocket,
  timeoutMs: number
): { signal: AbortSignal; stop(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const readEnd = () => {
    socket.read(0);
  };
  const timer = setTimeout(() => {
    controller.abort();
    socket.destroy();
  }, timeoutMs);
  socket.on("readable", readEnd);
  socket.once("end", abort);
  socket.once("close", abort);
  socket.once("error", abort);
  return {
    signal: controller.signal,
    stop: () => {
      clearTimeout(timer);
      socket.off("readable", readEnd);
      socket.off("end", abort);
      socket.off("close", abort);
      socket.off("error", abort);
      controller.abort();
    }
  };
}
function address(
  options: { host: string; port: number },
  allowZero: boolean
): void {
  if (
    !options.host ||
    !Number.isInteger(options.port) ||
    options.port < (allowZero ? 0 : 1) ||
    options.port > 65535
  )
    throw new Error("Invalid member address");
}
export async function connectPeerOnlineMember(
  options: MemberClientOptions
): Promise<MemberSession> {
  validate(options);
  address(options, false);
  if (
    !validId(options.peerDeviceId) ||
    options.peerDeviceId === options.localDeviceId
  )
    throw new Error("Invalid peer identity");
  const socket = connect({
    host: options.host,
    port: options.port,
    cert: options.cert,
    key: options.key,
    rejectUnauthorized: false,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    ALPNProtocols: [PEER_ONLINE_ALPN]
  });
  socket.pause();
  const guard = deadline(socket, options.timeoutMs);
  socket.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("TLS connection closed")));
    });
    const before = await checkMembership(
      socket,
      options,
      options.peerDeviceId,
      guard.signal
    );
    sendPreface(socket, options);
    const session = await authenticate(
      socket,
      options,
      options.peerDeviceId,
      "client",
      guard.signal
    );
    const after = await checkMembership(
      socket,
      options,
      options.peerDeviceId,
      guard.signal
    );
    if (!sameSnapshot(before, after))
      throw new Error("Membership changed during authentication");
    return session;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    guard.stop();
  }
}
export async function listenPeerOnlineMembers(
  options: MemberListenerOptions
): Promise<{ port: number; close(): Promise<void> }> {
  validate(options);
  address(options, true);
  if (
    typeof options.onSession !== "function" ||
    typeof options.onError !== "function"
  )
    throw new Error("Invalid member callbacks");
  const sockets = new Set<Socket>();
  const deadlines = new Map<Socket, NodeJS.Timeout>();
  const server = createServer({
    cert: options.cert,
    key: options.key,
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    ALPNProtocols: [PEER_ONLINE_ALPN],
    handshakeTimeout: options.timeoutMs,
    secureOptions: constants.SSL_OP_NO_TICKET
  });
  server.maxConnections = 128;
  let closing = false;
  server.on("connection", (socket) => {
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), options.timeoutMs);
    deadlines.set(socket, timer);
    socket.once("close", () => {
      clearTimeout(timer);
      deadlines.delete(socket);
      sockets.delete(socket);
    });
  });
  const report = (error: Error) => {
    try {
      options.onError(error);
    } catch (failure) {
      process.emitWarning(`Member error callback failed: ${String(failure)}`);
    }
  };
  server.on("newSession", (_id, _data, callback) => callback());
  server.on("resumeSession", (_id, callback) => callback(null, undefined));
  server.on("tlsClientError", report);
  server.on("secureConnection", (socket) => {
    for (const [raw, timer] of deadlines) {
      if (
        raw.localPort === socket.localPort &&
        raw.remotePort === socket.remotePort &&
        raw.remoteAddress === socket.remoteAddress
      ) {
        clearTimeout(timer);
        deadlines.delete(raw);
        break;
      }
    }
    socket.pause();
    socket.on("error", report);
    const guard = deadline(socket, options.timeoutMs);
    void (async () => {
      if (
        closing ||
        socket.getProtocol() !== "TLSv1.3" ||
        socket.alpnProtocol !== PEER_ONLINE_ALPN ||
        socket.isSessionReused() ||
        !socket.getPeerCertificate()?.raw
      )
        throw new Error("Invalid TLS profile");
      const [group, peerId, localId] = await receivePreface(socket);
      if (
        group !== options.groupId ||
        localId !== options.localDeviceId ||
        peerId === localId
      )
        throw new Error("Invalid member identity");
      const session = await authenticate(
        socket,
        options,
        peerId,
        "server",
        guard.signal
      );
      if (closing) throw new Error("Listener closing");
      // Release handshake listeners so the session can own the socket.
      guard.stop();
      options.onSession(session);
    })()
      .catch((error: unknown) => {
        socket.destroy();
        report(
          error instanceof Error
            ? error
            : new Error("Member authentication failed", { cause: error })
        );
      })
      .finally(() => guard.stop());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  server.on("error", report);
  const bound = server.address();
  if (!bound || typeof bound === "string") {
    server.close();
    throw new Error("Invalid listen address");
  }
  return {
    port: bound.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        closing = true;
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
