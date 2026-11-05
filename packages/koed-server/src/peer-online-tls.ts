import { type Socket } from "node:net";
import {
  connect,
  createServer,
  type PeerCertificate,
  type TLSSocket
} from "node:tls";

export const PEER_ONLINE_ALPN = "koed-peer-online/1";

type Material = string | Buffer;
export interface PeerOnlineTlsIdentity {
  cert: Material;
  key: Material;
  ca: Material | Material[];
  handshakeTimeoutMs: number;
  // Must compare certificate or SPKI against trusted pins for this identity.
  expectedPeerId: string;
  verifyPeer: (certificate: PeerCertificate, expectedPeerId: string) => boolean;
  onSocketError: (error: Error) => void;
}

export interface PeerOnlineClientOptions extends PeerOnlineTlsIdentity {
  host: string;
  port: number;
  servername: string;
}

export interface PeerOnlineServerOptions extends PeerOnlineTlsIdentity {
  host: string;
  port: number;
  onConnection: (socket: TLSSocket) => void;
  onError: (error: Error) => void;
}

function validate(options: PeerOnlineTlsIdentity): void {
  const material = [
    options.cert,
    options.key,
    ...(Array.isArray(options.ca) ? options.ca : [options.ca])
  ];
  if (
    material.length < 3 ||
    material.some((value) => !value || value.length === 0)
  ) {
    throw new Error(
      "Explicit certificate, key and trusted CA material are required"
    );
  }
  if (
    !Number.isSafeInteger(options.handshakeTimeoutMs) ||
    options.handshakeTimeoutMs < 1 ||
    options.handshakeTimeoutMs > 2_147_483_647
  ) {
    throw new Error("Invalid handshake timeout");
  }
  if (
    typeof options.expectedPeerId !== "string" ||
    !options.expectedPeerId.trim() ||
    typeof options.verifyPeer !== "function" ||
    typeof options.onSocketError !== "function"
  )
    throw new Error("Peer verification and socket error callbacks required");
}

function verify(socket: TLSSocket, options: PeerOnlineTlsIdentity): void {
  if (!socket.authorized || socket.alpnProtocol !== PEER_ONLINE_ALPN)
    throw new Error("Peer TLS authorization or ALPN failed");
  const certificate = socket.getPeerCertificate();
  if (
    !certificate.raw ||
    options.verifyPeer(certificate, options.expectedPeerId) !== true
  )
    throw new Error("Peer certificate pin rejected");
}

// Transport validation never authorizes application traffic. TLS 1.3 client
// completion does not confirm server acceptance of its pin. A separate mutual,
// replay-resistant, exporter-bound authentication exchange is required.
function report(callback: (error: Error) => void, error: Error): void {
  try {
    callback(error);
  } catch (failure) {
    process.emitWarning(`Peer TLS error callback failed: ${String(failure)}`);
  }
}
export function connectPeerOnline(
  options: PeerOnlineClientOptions
): Promise<TLSSocket> {
  validate(options);
  if (
    !options.host ||
    !options.servername ||
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  )
    throw new Error("Invalid peer address");
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: options.host,
      port: options.port,
      servername: options.servername,
      cert: options.cert,
      key: options.key,
      ca: options.ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ALPNProtocols: [PEER_ONLINE_ALPN]
    });
    const timer = setTimeout(
      () => fail(new Error("Peer TLS handshake timed out")),
      options.handshakeTimeoutMs
    );
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("error", fail);
      socket.off("close", closed);
      socket.off("secureConnect", secure);
    };
    const socketError = (error: Error) => report(options.onSocketError, error);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.on("error", socketError);
      socket.once("close", () => socket.off("error", socketError));
      cleanup();
      socket.destroy();
      reject(error);
    };
    const closed = () =>
      fail(new Error("Peer TLS connection closed during handshake"));
    const secure = () => {
      if (settled) return;
      try {
        verify(socket, options);
      } catch (error) {
        fail(
          error instanceof Error
            ? error
            : new Error("Peer verification failed", { cause: error })
        );
        return;
      }
      if (settled) return;
      settled = true;
      socket.on("error", socketError);
      cleanup();
      resolve(socket);
    };
    socket.once("error", fail);
    socket.once("close", closed);
    socket.once("secureConnect", secure);
  });
}

export async function listenPeerOnline(
  options: PeerOnlineServerOptions
): Promise<{ port: number; close: () => Promise<void> }> {
  validate(options);
  if (
    !options.host ||
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535 ||
    typeof options.onConnection !== "function" ||
    typeof options.onError !== "function"
  )
    throw new Error("Invalid listen options");
  const sockets = new Set<Socket>();
  const secureSockets = new Set<TLSSocket>();
  let isClosing = false;
  const server = createServer({
    cert: options.cert,
    key: options.key,
    ca: options.ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    ALPNProtocols: [PEER_ONLINE_ALPN],
    handshakeTimeout: options.handshakeTimeoutMs
  });
  server.maxConnections = 128;
  // Node's TLS timeout can report an error without closing the underlying socket.
  const deadlines = new Map<Socket, NodeJS.Timeout>();
  server.on("connection", (socket) => {
    if (isClosing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    deadlines.set(
      socket,
      setTimeout(() => {
        socket.destroy();
        report(options.onError, new Error("Peer TLS handshake timed out"));
      }, options.handshakeTimeoutMs)
    );
    socket.once("close", () => {
      clearTimeout(deadlines.get(socket));
      deadlines.delete(socket);
      sockets.delete(socket);
    });
  });
  server.on("tlsClientError", (error, socket) => {
    socket.destroy();
    report(options.onError, error);
  });
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
    socket.on("error", (error) => report(options.onSocketError, error));
    if (isClosing) {
      socket.destroy();
      return;
    }
    secureSockets.add(socket);
    socket.once("close", () => secureSockets.delete(socket));
    try {
      verify(socket, options);
    } catch (error) {
      socket.destroy();
      report(
        options.onError,
        error instanceof Error
          ? error
          : new Error("Peer verification failed", { cause: error })
      );
      return;
    }
    if (isClosing) {
      socket.destroy();
      return;
    }
    try {
      options.onConnection(socket);
    } catch (error) {
      socket.destroy();
      report(
        options.onError,
        new Error("Peer connection callback failed", { cause: error })
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    let listening = false;
    server.on("error", (error) => {
      if (!listening) reject(error);
      else report(options.onError, error);
    });
    server.listen(options.port, options.host, () => {
      listening = true;
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Invalid listen address");
  }
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    close: () => {
      if (closing) return closing;
      isClosing = true;
      return (closing = new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          for (const socket of secureSockets) socket.destroy();
          for (const socket of sockets) socket.destroy();
        }, options.handshakeTimeoutMs);
        server.close((error) => {
          clearTimeout(deadline);
          if (error) reject(error);
          else resolve();
        });
        for (const socket of deadlines.keys()) socket.destroy();
        for (const socket of secureSockets) socket.end();
      }));
    }
  };
}
