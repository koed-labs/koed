import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  unlinkSync
} from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  createPdsApplicationSecretStore,
  isPrivateNetworkIpv4Address
} from "@koed/shared";
import {
  encryptPersonalDevicePairingMessage as encrypt,
  decryptPersonalDevicePairingMessage as decrypt
} from "./personal-device-request-crypto.js";
import {
  exchangeOverDeviceRequestRelay,
  normalizeDeviceRequestRelayUrl,
  runDeviceRequestRelayServer
} from "./personal-device-request-relay.js";
import type { KoedServerPaths } from "./paths.js";

const ttl = 10 * 60_000;
const maxBytes = 32_768;
const reference = "pds-device-request";
type Json = Record<string, unknown>;
export type DeviceRequestView = {
  id: string;
  label: string;
  expiresAt: string;
  state:
    | "waiting"
    | "connecting"
    | "connected"
    | "failed"
    | "expired"
    | "cancelled";
  link?: string;
};
type Pending = DeviceRequestView & {
  host: string;
  port: number;
  token: string;
  invitation?: string;
  used: string[];
  relayUrl?: string;
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const parseDeviceRequestLink = (
  value: unknown,
  configuredRelayUrl = process.env.KOED_PDS_REQUEST_RELAY_URL
) => {
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("Invalid device request link.");
  const match =
    /^http:\/\/(\d+\.\d+\.\d+\.\d+):([1-9][0-9]{0,4})\/device-request\/([0-9a-f-]{36})#token=([A-Za-z0-9_-]{43})$/.exec(
      value.trim()
    );
  if (match) {
    if (
      !isPrivateNetworkIpv4Address(match[1]!) ||
      !uuid.test(match[3]!) ||
      Number(match[2]) > 65535 ||
      Buffer.from(match[4]!, "base64url").toString("base64url") !== match[4]
    )
      throw new Error("Use a valid Koed LAN or Tailscale device request link.");
    const url = new URL(value.trim());
    url.hash = "";
    return { mode: "direct" as const, url, id: match[3]!, token: match[4]! };
  }
  if (!configuredRelayUrl)
    throw new Error("Configure the Koed pairing relay before using this link.");
  const relayUrl = normalizeDeviceRequestRelayUrl(configuredRelayUrl);
  const relay = new URL(relayUrl);
  const expectedOrigin = relay.protocol === "wss:" ? "https:" : "http:";
  const relayMatch =
    /^(https?):\/\/([^/]+)\/device-request\/([0-9a-f-]{36})#token=([A-Za-z0-9_-]{43})$/.exec(
      value.trim()
    );
  if (!relayMatch || !uuid.test(relayMatch[3]!))
    throw new Error("Use a valid Koed relay device request link.");
  const url = new URL(value.trim());
  if (
    url.protocol !== expectedOrigin ||
    url.host !== relay.host ||
    url.search ||
    url.username ||
    url.password ||
    Buffer.from(relayMatch[4]!, "base64url").toString("base64url") !==
      relayMatch[4]
  )
    throw new Error("Device request link does not match configured relay.");
  url.hash = "";
  return {
    mode: "relay" as const,
    url,
    relayUrl,
    id: relayMatch[3]!,
    token: relayMatch[4]!
  };
};
const body = async (input: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of input) {
    const chunk = Buffer.from(part as Uint8Array);
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};
const reply = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
};
const socketPath = (paths: KoedServerPaths) => {
  const direct = join(paths.runDir, "device-request.sock");
  if (Buffer.byteLength(direct) < 100) return direct;
  // macOS Unix sockets have a 104-byte path limit. Use an owner-only short
  // directory, never a shared socket in world-writable /tmp.
  const directory = `/tmp/koed-pairing-${process.getuid?.() ?? "local"}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const entry = lstatSync(directory);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    (entry.mode & 0o077) !== 0 ||
    (process.getuid && entry.uid !== process.getuid())
  )
    throw new Error("The private pairing socket directory is unsafe.");
  return join(
    directory,
    `${createHash("sha256").update(paths.koedHome).digest("hex").slice(0, 32)}.sock`
  );
};
export const deviceRequestCommand = (
  paths: KoedServerPaths,
  command: "create" | "status" | "cancel",
  label?: string
): Promise<DeviceRequestView> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        agent: false,
        socketPath: socketPath(paths),
        path: "/",
        method: "POST",
        timeout: 10_000,
        headers: { "content-type": "application/json" }
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += String(chunk);
          if (Buffer.byteLength(raw) > maxBytes)
            response.destroy(new Error("Invalid pairing response."));
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const value = JSON.parse(raw) as DeviceRequestView & {
              error?: string;
            };
            if (response.statusCode !== 200)
              throw new Error(value.error ?? "Pairing unavailable.");
            resolve(value);
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error("Invalid pairing response.")
            );
          }
        });
      }
    );
    request.on("timeout", () =>
      request.destroy(new Error("Koed pairing service timed out."))
    );
    request.on("error", () =>
      reject(new Error("Start Koed before connecting this device."))
    );
    request.end(JSON.stringify({ command, ...(label ? { label } : {}) }));
  });
const relayLocalExchange = (pending: Pending, frame: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: pending.host,
        port: pending.port,
        path: `/device-request/${pending.id}`,
        method: "POST",
        headers: {
          host: `${pending.host}:${pending.port}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(frame)
        },
        timeout: 10_000
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (part: Buffer | string) => {
          const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
          size += chunk.length;
          if (size > maxBytes)
            response.destroy(new Error("Response too large."));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error("Device request was rejected."));
            return;
          }
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
        response.on("error", () => reject(new Error("Device request failed.")));
      }
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => reject(new Error("Device request failed.")));
    request.end(frame);
  });

export const exchangeDeviceRequest = async (
  link: string,
  operation: "inspect" | "accept",
  invitation?: string,
  configuredRelayUrl = process.env.KOED_PDS_REQUEST_RELAY_URL
): Promise<Json> => {
  const parsed = parseDeviceRequestLink(link, configuredRelayUrl);
  const envelope = encrypt(
    { operation, ...(invitation ? { invitation } : {}) },
    { invitationId: parsed.id, token: parsed.token, direction: "request" }
  );
  if (parsed.mode === "relay") {
    const response = await exchangeOverDeviceRequestRelay(
      parsed.relayUrl,
      parsed.id,
      parsed.token,
      JSON.stringify(envelope)
    );
    const result = decrypt(JSON.parse(response), {
      invitationId: parsed.id,
      token: parsed.token,
      direction: "response"
    });
    if (result.messageId !== envelope.message_id)
      throw new Error("Device request response does not match.");
    return result.value;
  }
  const response = await fetch(parsed.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      "Device request expired, was already used, or could not be reached. Create a new request on the joining device."
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing pairing response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maxBytes) throw new Error("Invalid pairing response.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const result = decrypt(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
    invitationId: parsed.id,
    token: parsed.token,
    direction: "response"
  });
  if (result.messageId !== envelope.message_id)
    throw new Error("Device request response does not match.");
  return result.value;
};

/**
 * Resolve one concrete private IPv4 interface address for the request link.
 * An explicit `configuredHost` always wins, so an Operator on a device with
 * more than one reachable private interface (for example LAN plus Tailscale)
 * can pin the one the Authority device can actually reach, rather than
 * relying on automatic selection, which is not reachability-aware.
 */
export const resolveDeviceRequestHost = (
  configuredHost: string | undefined,
  addresses: readonly string[]
): string | undefined => {
  const trimmed = configuredHost?.trim();
  if (trimmed) {
    if (!isPrivateNetworkIpv4Address(trimmed))
      throw new Error(
        "Request service host must be a private IPv4 interface address."
      );
    return trimmed;
  }
  return [...addresses].filter(isPrivateNetworkIpv4Address).sort()[0];
};

/** Owned by the local supervisor. Local controls use an owner-only Unix socket;
 * only the bounded encrypted request exchange is reachable on a private interface. */
export const startDeviceRequestService = async (options: {
  paths: KoedServerPaths;
  redeem: (
    invitation: string,
    label: string,
    signal: AbortSignal
  ) => Promise<void>;
  enrolled: () => boolean | Promise<boolean>;
  addresses?: () => string[];
  relayUrl?: string;
  /** Explicit private IPv4 interface for the request link, overriding
   * automatic selection. Required on devices with more than one reachable
   * private interface (for example LAN plus Tailscale) where the Authority
   * device cannot reach every candidate address. */
  host?: string;
}) => {
  const { paths } = options;
  const store = createPdsApplicationSecretStore({ rootPath: paths.koedHome });
  let pending: Pending | null = null;
  let publicServer: ReturnType<typeof createServer> | null = null;
  let running: Promise<void> | null = null;
  let mutation = Promise.resolve();
  let closed = false;
  let relayAbort: AbortController | null = null;
  let relayTask: Promise<void> | null = null;
  const configuredRelayUrl = options.relayUrl
    ? normalizeDeviceRequestRelayUrl(options.relayUrl)
    : undefined;
  const enrollmentAbort = new AbortController();
  const persist = () => {
    if (pending) store.put(reference, JSON.stringify(pending));
    else store.delete(reference);
  };
  const view = (includeLink = false): DeviceRequestView => {
    if (!pending)
      throw new Error("No pending device request. Create one first.");
    return {
      id: pending.id,
      label: pending.label,
      expiresAt: pending.expiresAt,
      state: pending.state,
      ...(includeLink && pending.state === "waiting"
        ? {
            link: pending.relayUrl
              ? `${new URL(pending.relayUrl).protocol === "wss:" ? "https" : "http"}://${new URL(pending.relayUrl).host}/device-request/${pending.id}#token=${pending.token}`
              : `http://${pending.host}:${pending.port}/device-request/${pending.id}#token=${pending.token}`
          }
        : {})
    };
  };
  const resume = () => {
    if (!pending?.invitation || running || pending.state !== "connecting")
      return;
    const current = pending;
    running = options
      .redeem(current.invitation!, current.label, enrollmentAbort.signal)
      .then(() => {
        if (closed) return;
        current.state = "connected";
        delete current.invitation;
        current.token = "";
        persist();
      })
      .catch(() => {
        if (closed) return;
        // Never expose underlying transport errors: they can contain capability URLs.
        current.state = "failed";
        delete current.invitation;
        current.token = "";
        persist();
      })
      .finally(() => {
        running = null;
      });
  };
  const listen = async () => {
    if (!pending) return;
    const current = pending;
    const server = createServer((request, response) => {
      void (async () => {
        if (
          request.method !== "POST" ||
          request.url !== `/device-request/${current.id}` ||
          request.headers.host !== `${current.host}:${current.port}` ||
          request.headers.origin
        )
          throw new Error("Invalid request.");
        const raw = await body(request);
        // Serialize replay checks and durable acceptance before any enrollment work.
        const transaction = mutation.then(() => {
          if (
            closed ||
            Date.now() >= Date.parse(current.expiresAt) ||
            !current.token ||
            current.used.length >= 64
          )
            throw new Error("Expired.");
          const decoded = decrypt(raw, {
            invitationId: current.id,
            token: current.token,
            direction: "request"
          });
          if (current.used.includes(decoded.messageId))
            throw new Error("Replay.");
          const operation = decoded.value.operation;
          if (operation !== "inspect" && operation !== "accept")
            throw new Error("Invalid operation.");
          const expected =
            operation === "inspect"
              ? ["operation"]
              : ["invitation", "operation"];
          if (Object.keys(decoded.value).sort().join() !== expected.join())
            throw new Error("Invalid request.");
          if (operation === "accept") {
            if (
              typeof decoded.value.invitation !== "string" ||
              decoded.value.invitation.length > 4096
            )
              throw new Error("Invalid invitation.");
            // The existing enrollment client validates the Authority and signed challenge.
            if (
              current.state !== "waiting" &&
              !(
                current.state === "connecting" &&
                current.invitation === decoded.value.invitation
              )
            )
              throw new Error("Already accepted.");
            current.invitation = decoded.value.invitation;
            current.state = "connecting";
          }
          current.used.push(decoded.messageId);
          persist();
          const result = encrypt(
            {
              id: current.id,
              label: current.label,
              expiresAt: current.expiresAt,
              state: current.state
            },
            {
              invitationId: current.id,
              token: current.token,
              direction: "response",
              messageId: decoded.messageId
            }
          );
          reply(response, 200, result);
          if (operation === "accept") resume();
        });
        mutation = transaction.catch(() => undefined);
        await transaction;
      })().catch(() =>
        reply(response, 400, { error: "Device request unavailable." })
      );
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(current.port, current.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Pairing listener unavailable.");
    current.port = address.port;
    publicServer = server;
    persist();
  };
  const startRelay = async (current: Pending): Promise<void> => {
    if (!current.relayUrl || relayTask) return;
    const controller = new AbortController();
    relayAbort = controller;
    let signalConnected!: () => void;
    const connected = new Promise<void>((resolve) => {
      signalConnected = resolve;
    });
    relayTask = runDeviceRequestRelayServer({
      relayUrl: current.relayUrl,
      id: current.id,
      token: current.token,
      signal: controller.signal,
      onConnected: signalConnected,
      onFrame: (frame) => relayLocalExchange(current, frame)
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connected,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Pairing relay is unavailable.")),
            10_000
          );
        })
      ]);
    } catch (error) {
      controller.abort();
      await relayTask;
      relayTask = null;
      relayAbort = null;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const closeRelay = async (): Promise<void> => {
    relayAbort?.abort();
    await relayTask;
    relayTask = null;
    relayAbort = null;
  };
  const closePublic = async () => {
    const server = publicServer;
    publicServer = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await closeRelay();
  };
  const saved = store.get(reference);
  if (saved) {
    try {
      const value = JSON.parse(saved) as Pending;
      if (
        uuid.test(value.id) &&
        (isPrivateNetworkIpv4Address(value.host) ||
          (value.host === "127.0.0.1" &&
            typeof value.relayUrl === "string" &&
            normalizeDeviceRequestRelayUrl(value.relayUrl) ===
              configuredRelayUrl)) &&
        (!value.relayUrl || value.relayUrl === configuredRelayUrl) &&
        Number.isInteger(value.port) &&
        value.port > 0 &&
        value.port <= 65535 &&
        typeof value.label === "string" &&
        value.label.length <= 80 &&
        Array.isArray(value.used) &&
        value.used.length <= 64 &&
        value.used.every((id) => typeof id === "string" && uuid.test(id)) &&
        Number.isFinite(Date.parse(value.expiresAt)) &&
        Date.parse(value.expiresAt) <= Date.now() + ttl &&
        typeof value.token === "string" &&
        ((["waiting", "connecting"].includes(value.state) &&
          /^[A-Za-z0-9_-]{43}$/.test(value.token)) ||
          (["connected", "failed", "cancelled", "expired"].includes(
            value.state
          ) &&
            value.token === "" &&
            !value.invitation))
      ) {
        pending = value;
        if (!["waiting", "connecting"].includes(value.state)) {
          // Preserve redacted terminal status across supervisor restarts.
        } else if (Date.now() < Date.parse(value.expiresAt)) {
          await listen();
          if (pending.relayUrl) await startRelay(pending);
          resume();
        } else {
          pending.state = "expired";
          pending.token = "";
          delete pending.invitation;
          persist();
        }
      }
    } catch {
      pending = null;
      store.delete(reference);
    }
  }
  const local = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/")
        throw new Error("Invalid command.");
      const input = (await body(request)) as Json;
      const transaction = mutation.then(async () => {
        if (closed) throw new Error("Pairing service stopped.");
        if (input.command === "create") {
          if (pending?.state !== "connecting" && (await options.enrolled()))
            throw new Error(
              "This installation already belongs to a Personal Device Group."
            );
          if (!pending || !["waiting", "connecting"].includes(pending.state)) {
            await closePublic();
            const availableAddresses =
              options.addresses?.() ??
              Object.values(networkInterfaces())
                .flatMap((entries) => entries ?? [])
                .filter((entry) => entry.family === "IPv4" && !entry.internal)
                .map((entry) => entry.address);
            const host = configuredRelayUrl
              ? "127.0.0.1"
              : resolveDeviceRequestHost(options.host, availableAddresses);
            if (!host)
              throw new Error(
                "Configure a pairing relay or connect to a private LAN or Tailscale network."
              );
            const label =
              typeof input.label === "string" ? input.label.trim() : hostname();
            if (
              !label ||
              label.length > 80 ||
              Array.from(label).some(
                (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
              )
            )
              throw new Error(
                "Device name must contain 1–80 printable characters."
              );
            pending = {
              id: randomUUID(),
              label,
              host,
              port: 0,
              token: randomBytes(32).toString("base64url"),
              expiresAt: new Date(Date.now() + ttl).toISOString(),
              state: "waiting",
              used: [],
              ...(configuredRelayUrl ? { relayUrl: configuredRelayUrl } : {})
            };
            await listen();
            if (pending.relayUrl) await startRelay(pending);
          }
          return view(true);
        }
        if (input.command === "cancel") {
          if (pending?.state === "connecting" || pending?.state === "connected")
            throw new Error(
              "Enrollment has started. Check its result and use device removal to revoke membership."
            );
          if (pending?.state === "waiting") {
            pending.state = "cancelled";
            pending.token = "";
            delete pending.invitation;
            persist();
            await closePublic();
          }
        } else if (input.command !== "status")
          throw new Error("Invalid command.");
        return view();
      });
      mutation = transaction.then(
        () => undefined,
        () => undefined
      );
      reply(response, 200, await transaction);
    })().catch((error) =>
      reply(response, 400, {
        error: error instanceof Error ? error.message : "Pairing unavailable."
      })
    );
  });
  const path = socketPath(paths);
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket())
      throw new Error("Unsafe pairing socket path.");
    unlinkSync(path);
  }
  await new Promise<void>((resolve, reject) => {
    local.once("error", reject);
    local.listen(path, () => {
      chmodSync(path, 0o600);
      resolve();
    });
  });
  const timer = setInterval(() => {
    mutation = mutation
      .then(async () => {
        if (
          closed ||
          !pending ||
          pending.state !== "waiting" ||
          Date.now() < Date.parse(pending.expiresAt)
        )
          return;
        pending.state = "expired";
        pending.token = "";
        persist();
        await closePublic();
      })
      .catch(() => undefined);
  }, 1000);
  timer.unref();
  return {
    close: async () => {
      closed = true;
      enrollmentAbort.abort();
      clearInterval(timer);
      await mutation;
      await closePublic();
      local.closeAllConnections();
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  };
};
