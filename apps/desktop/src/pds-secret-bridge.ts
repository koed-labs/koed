import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  unlinkSync
} from "node:fs";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import type { PdsDesktopSecretStore } from "./pds-secure-provider.js";

const maxFrameBytes = 2_100_000;
const validReference = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._-]{1,240}$/.test(value);

type Request =
  | { token: string; operation: "get" | "delete"; reference: string }
  | { token: string; operation: "put"; reference: string; value: string };

const equalToken = (received: unknown, expected: string): boolean => {
  if (typeof received !== "string") return false;
  const actual = Buffer.from(received, "base64url");
  const wanted = Buffer.from(expected, "base64url");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
};

const parseRequest = (value: unknown, token: string): Request | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (!equalToken(request.token, token) || !validReference(request.reference)) {
    return null;
  }
  if (request.operation === "get" || request.operation === "delete") {
    return {
      token,
      operation: request.operation,
      reference: request.reference
    };
  }
  if (
    request.operation === "put" &&
    typeof request.value === "string" &&
    Buffer.byteLength(request.value, "utf8") <= 2_000_000
  ) {
    return {
      token,
      operation: "put",
      reference: request.reference,
      value: request.value
    };
  }
  return null;
};

const socketPathFor = (koedHome: string, token: string): string =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\koed-pds-${token.slice(0, 24)}`
    : resolve(koedHome, "run", `p-${token.slice(0, 12)}.sock`);

const ensurePrivateRunDirectory = (koedHome: string): string => {
  const directory = resolve(koedHome, "run");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("PDS secret bridge requires a private Koed run directory.");
  }
  return directory;
};

export interface PdsSecretBridge {
  environment: Record<string, string>;
  close(): Promise<void>;
}

/**
 * Narrow main-process broker for the direct koed-server child. The renderer
 * cannot reach this socket or obtain its capability token.
 */
export const startPdsSecretBridge = async (input: {
  koedHome: string;
  providerProgram: string;
  providerArgs: string[];
  store: PdsDesktopSecretStore;
}): Promise<PdsSecretBridge> => {
  const token = randomBytes(32).toString("base64url");
  const path = socketPathFor(input.koedHome, token);
  if (process.platform !== "win32") {
    ensurePrivateRunDirectory(input.koedHome);
    if (existsSync(path)) unlinkSync(path);
  }
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxFrameBytes) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = buffer.slice(0, newline);
      buffer = "";
      void (async () => {
        try {
          const request = parseRequest(JSON.parse(frame), token);
          if (!request) throw new Error("Invalid request.");
          if (request.operation === "get") {
            const value = await input.store.get(request.reference);
            socket.end(`${JSON.stringify({ ok: true, value })}\n`);
          } else if (request.operation === "put") {
            await input.store.put(request.reference, request.value);
            socket.end('{"ok":true}\n');
          } else {
            await input.store.delete(request.reference);
            socket.end('{"ok":true}\n');
          }
        } catch {
          socket.end('{"ok":false}\n');
        }
      })();
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return {
    environment: {
      PDS_SECRET_PROVIDER: "desktop_bridge",
      PDS_SECRET_PROVIDER_COMMAND: input.providerProgram,
      PDS_SECRET_PROVIDER_COMMAND_ARGS_JSON: JSON.stringify(input.providerArgs),
      PDS_DESKTOP_SECRET_BRIDGE_SOCKET: path,
      PDS_DESKTOP_SECRET_BRIDGE_TOKEN: token
    },
    close: async () => {
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise())
      );
      if (process.platform !== "win32" && existsSync(path)) unlinkSync(path);
    }
  };
};
