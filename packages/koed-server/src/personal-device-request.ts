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
} from "@koed-labs/shared";
import {
  encryptPersonalDevicePairingMessage as encrypt,
  decryptPersonalDevicePairingMessage as decrypt
} from "./personal-device-request-crypto.js";
import type { KoedServerPaths } from "./paths.js";
import type {
  EnrollmentFenceEpoch,
  EnrollmentFenceOperation
} from "./enrollment-fence-ipc-client.js";

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
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const parseDeviceRequestLink = (value: unknown) => {
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("Invalid device request link.");
  const match =
    /^http:\/\/(\d+\.\d+\.\d+\.\d+):([1-9][0-9]{0,4})\/device-request\/([0-9a-f-]{36})#token=([A-Za-z0-9_-]{43})$/.exec(
      value.trim()
    );
  if (
    !match ||
    !isPrivateNetworkIpv4Address(match[1]!) ||
    !uuid.test(match[3]!) ||
    Number(match[2]) > 65535 ||
    Buffer.from(match[4]!, "base64url").toString("base64url") !== match[4]
  )
    throw new Error(
      "Use a Koed device request link from your LAN or Tailscale network."
    );
  const url = new URL(value.trim());
  url.hash = "";
  return { url, id: match[3]!, token: match[4]! };
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
export const exchangeDeviceRequest = async (
  link: string,
  operation: "inspect" | "accept",
  invitation?: string
): Promise<Json> => {
  const parsed = parseDeviceRequestLink(link);
  const envelope = encrypt(
    { operation, ...(invitation ? { invitation } : {}) },
    { invitationId: parsed.id, token: parsed.token, direction: "request" }
  );
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

export class DeviceRequestCleanupError extends AggregateError {
  constructor(
    errors: unknown[],
    public readonly quiescence: "proven" | "uncertain"
  ) {
    super(errors, "Pairing service cleanup incomplete.");
    this.name = "DeviceRequestCleanupError";
  }
}

export class DeviceRequestStartupUncertainError extends Error {
  constructor(
    cause: unknown,
    public readonly ownership: { waitForCleanup: () => Promise<void> }
  ) {
    super(
      "Pairing service startup and cleanup failed; work may still be active.",
      { cause }
    );
    this.name = "DeviceRequestStartupUncertainError";
  }
}

/** Owned by the local supervisor. Local controls use an owner-only Unix socket;
 * only the bounded encrypted request exchange is reachable on a private interface. */
export const startDeviceRequestService = async (options: {
  paths: KoedServerPaths;
  redeem: (
    invitation: string,
    label: string,
    signal: AbortSignal,
    operation?: EnrollmentFenceOperation
  ) => Promise<void>;
  // Caller owns the bound dependency and must fence it after local work drains.
  // Local cleanup does not establish API or remote quiescence.
  managedEnrollment?: {
    createEpoch(): Promise<EnrollmentFenceEpoch>;
    register(epoch: EnrollmentFenceEpoch): Promise<EnrollmentFenceOperation>;
  };
  enrolled: () => boolean | Promise<boolean>;
  addresses?: () => string[];
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
  let enrollmentError: unknown;
  let mutation = Promise.resolve();
  const handlers = new Set<Promise<void>>();
  const handlerErrors: unknown[] = [];
  const trackHandler = (work: Promise<void>) => {
    const tracked = work
      .catch((error: unknown) => {
        handlerErrors.push(error);
      })
      .finally(() => handlers.delete(tracked));
    handlers.add(tracked);
  };
  const drainHandlers = async () => {
    while (handlers.size) await Promise.all([...handlers]);
  };
  let closed = false;
  const enrollmentAbort = new AbortController();
  const persistenceErrors: unknown[] = [];
  const persist = (value = pending) => {
    try {
      if (value) store.put(reference, JSON.stringify(value));
      else store.delete(reference);
    } catch (error) {
      persistenceErrors.push(error);
      throw error;
    }
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
            link: `http://${pending.host}:${pending.port}/device-request/${pending.id}#token=${pending.token}`
          }
        : {})
    };
  };
  const resume = () => {
    if (
      persistenceErrors.length ||
      !pending?.invitation ||
      running ||
      pending.state !== "connecting"
    )
      return;
    const current = pending;
    const admission = options.managedEnrollment;
    running = (
      admission
        ? Promise.resolve().then(async () => {
            if (closed) return;
            const epoch = await admission.createEpoch();
            if (closed) return;
            const operation = await admission.register(epoch);
            if (closed) return;
            await options.redeem(
              current.invitation!,
              current.label,
              enrollmentAbort.signal,
              operation
            );
          })
        : options.redeem(
            current.invitation!,
            current.label,
            enrollmentAbort.signal
          )
    )
      .then(
        () => "connected" as const,
        () => "failed" as const
      )
      .then((state) => {
        if (closed) return;
        // Never expose underlying transport errors: they can contain capability URLs.
        current.state = state;
        delete current.invitation;
        current.token = "";
        persist();
      })
      .catch((error: unknown) => {
        enrollmentError = error;
      })
      .finally(() => {
        running = null;
      });
  };
  const listen = async () => {
    if (!pending) return;
    const current = pending;
    const server = createServer((request, response) => {
      trackHandler(
        (async () => {
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
              persistenceErrors.length > 0 ||
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
            }
            const next: Pending = {
              ...current,
              used: [...current.used, decoded.messageId],
              ...(operation === "accept"
                ? {
                    invitation: decoded.value.invitation as string,
                    state: "connecting" as const
                  }
                : {})
            };
            persist(next);
            Object.assign(current, next);
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
        )
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
    publicServer = server;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Pairing listener unavailable.");
    current.port = address.port;
    if (closed) {
      await closePublic();
      throw new Error("Pairing service stopped.");
    }
    persist();
  };
  let publicClosing: Promise<void> | undefined;
  const closePublic = () => {
    if (publicClosing) return publicClosing;
    const server = publicServer;
    if (!server) return Promise.resolve();
    publicClosing = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    })
      .then(() => {
        if (publicServer === server) publicServer = null;
      })
      .finally(() => {
        publicClosing = undefined;
      });
    return publicClosing;
  };
  let local: ReturnType<typeof createServer> | null = null;
  let localListenAcquired = false;
  let localClosing: Promise<void> | undefined;
  const closeLocal = () => {
    if (localClosing) return localClosing;
    const server = local;
    if (!server || !localListenAcquired) return Promise.resolve();
    localClosing = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    })
      .then(() => {
        if (local === server) local = null;
      })
      .finally(() => {
        localClosing = undefined;
      });
    return localClosing;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing: Promise<void> | undefined;
  const drain = (work: Promise<void>) =>
    new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () =>
          reject(
            new Error(
              "Pairing service drain timed out; work may still be active."
            )
          ),
        5_000
      );
      work.then(
        () => {
          clearTimeout(deadline);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(deadline);
          reject(error);
        }
      );
    });
  const close = () => {
    if (closing) return closing;
    let resolveClosing!: () => void;
    let rejectClosing!: (error: unknown) => void;
    closing = new Promise<void>((resolve, reject) => {
      resolveClosing = resolve;
      rejectClosing = reject;
    });
    closed = true;
    enrollmentAbort.abort();
    if (timer) clearInterval(timer);
    void (async () => {
      const errors: unknown[] = [];
      // Stop accepting connections even if queued or enrollment work does not drain.
      try {
        await drain(closePublic());
      } catch (error) {
        errors.push(error);
      }
      try {
        await drain(closeLocal());
      } catch (error) {
        errors.push(error);
      }
      for (const work of [
        async () => {
          await Promise.all([mutation, drainHandlers()]);
        },
        closePublic,
        () => running ?? Promise.resolve()
      ]) {
        try {
          await drain(work());
        } catch (error) {
          errors.push(error);
        }
      }
      if (enrollmentError !== undefined) errors.push(enrollmentError);
      errors.push(...handlerErrors, ...persistenceErrors);
      if (errors.length)
        throw new AggregateError(
          errors,
          "Pairing service cleanup incomplete; work may still be active."
        );
    })().then(resolveClosing, rejectClosing);
    return closing;
  };
  let cleanupWait: Promise<void> | undefined;
  const waitForCleanup = () => {
    if (!closed)
      return Promise.reject(new Error("Pairing service has not been stopped."));
    if (cleanupWait) return cleanupWait;
    cleanupWait = (async () => {
      if (closing) await closing.catch(() => undefined);
      // Mutation can open a listener or start enrollment, so snapshot afterward.
      await mutation;
      const results = await Promise.allSettled([
        closePublic(),
        closeLocal(),
        running ?? Promise.resolve(),
        drainHandlers()
      ]);
      // A listener can admit handlers until its close completes.
      await drainHandlers();
      await mutation;
      if (running) await running;
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (errors.length)
        throw new DeviceRequestCleanupError(errors, "uncertain");
      const failures = [...handlerErrors, ...persistenceErrors];
      if (enrollmentError !== undefined) failures.push(enrollmentError);
      if (failures.length)
        throw new DeviceRequestCleanupError(failures, "proven");
    })().finally(() => {
      cleanupWait = undefined;
    });
    return cleanupWait;
  };
  try {
    const saved = store.get(reference);
    if (saved) {
      let value: Pending | undefined;
      try {
        value = JSON.parse(saved) as Pending;
      } catch {
        value = undefined;
      }
      if (
        value &&
        typeof value === "object" &&
        typeof value.id === "string" &&
        uuid.test(value.id) &&
        typeof value.host === "string" &&
        isPrivateNetworkIpv4Address(value.host) &&
        Number.isInteger(value.port) &&
        value.port > 0 &&
        value.port <= 65535 &&
        typeof value.label === "string" &&
        value.label.length <= 80 &&
        Array.isArray(value.used) &&
        value.used.length <= 64 &&
        value.used.every((id) => typeof id === "string" && uuid.test(id)) &&
        typeof value.expiresAt === "string" &&
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
          resume();
        } else {
          pending.state = "expired";
          pending.token = "";
          delete pending.invitation;
          persist();
        }
      } else {
        store.delete(reference);
      }
    }
    local = createServer((request, response) => {
      trackHandler(
        (async () => {
          if (request.method !== "POST" || request.url !== "/")
            throw new Error("Invalid command.");
          const input = (await body(request)) as Json;
          const transaction = mutation.then(async () => {
            if (closed) throw new Error("Pairing service stopped.");
            if (persistenceErrors.length && input.command !== "status")
              throw new Error("Pairing storage unavailable.");
            if (input.command === "create") {
              if (pending?.state !== "connecting" && (await options.enrolled()))
                throw new Error(
                  "This installation already belongs to a Personal Device Group."
                );
              if (closed) throw new Error("Pairing service stopped.");
              if (
                !pending ||
                !["waiting", "connecting"].includes(pending.state)
              ) {
                await closePublic();
                if (closed) throw new Error("Pairing service stopped.");
                const availableAddresses =
                  options.addresses?.() ??
                  Object.values(networkInterfaces())
                    .flatMap((entries) => entries ?? [])
                    .filter(
                      (entry) => entry.family === "IPv4" && !entry.internal
                    )
                    .map((entry) => entry.address);
                const host = resolveDeviceRequestHost(
                  options.host,
                  availableAddresses
                );
                if (!host)
                  throw new Error(
                    "Connect to a private LAN or Tailscale network before pairing."
                  );
                const label =
                  typeof input.label === "string"
                    ? input.label.trim()
                    : hostname();
                if (
                  !label ||
                  label.length > 80 ||
                  Array.from(label).some(
                    (char) =>
                      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
                  )
                )
                  throw new Error(
                    "Device name must contain 1–80 printable characters."
                  );
                const previous = pending;
                pending = {
                  id: randomUUID(),
                  label,
                  host,
                  port: 0,
                  token: randomBytes(32).toString("base64url"),
                  expiresAt: new Date(Date.now() + ttl).toISOString(),
                  state: "waiting",
                  used: []
                };
                try {
                  await listen();
                } catch (error) {
                  // Only undo an unacquired bind, before any persistence attempt.
                  if (!publicServer && pending.port === 0) pending = previous;
                  throw error;
                }
              }
              return view(true);
            }
            if (input.command === "cancel") {
              if (
                pending?.state === "connecting" ||
                pending?.state === "connected"
              )
                throw new Error(
                  "Enrollment has started. Check its result and use device removal to revoke membership."
                );
              if (pending?.state === "waiting") {
                const next = {
                  ...pending,
                  state: "cancelled" as const,
                  token: ""
                };
                delete next.invitation;
                persist(next);
                Object.assign(pending, next);
                delete pending.invitation;
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
            error:
              error instanceof Error ? error.message : "Pairing unavailable."
          })
        )
      );
    });
    const path = socketPath(paths);
    if (existsSync(path)) {
      if (!lstatSync(path).isSocket())
        throw new Error("Unsafe pairing socket path.");
      unlinkSync(path);
    }
    await new Promise<void>((resolve, reject) => {
      local!.once("error", reject);
      local!.listen(path, () => {
        localListenAcquired = true;
        try {
          chmodSync(path, 0o600);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    timer = setInterval(() => {
      mutation = mutation
        .then(async () => {
          if (
            closed ||
            persistenceErrors.length > 0 ||
            !pending ||
            pending.state !== "waiting" ||
            Date.now() < Date.parse(pending.expiresAt)
          )
            return;
          const next = { ...pending, state: "expired" as const, token: "" };
          persist(next);
          Object.assign(pending, next);
          await closePublic();
        })
        .catch(() => undefined);
    }, 1000);
    timer.unref();
    return { close, waitForCleanup };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      if (
        cleanupError instanceof AggregateError &&
        cleanupError.errors.every((failure) =>
          persistenceErrors.includes(failure)
        )
      )
        throw error;
      throw new DeviceRequestStartupUncertainError(
        new AggregateError([error, cleanupError]),
        { waitForCleanup }
      );
    }
    throw error;
  }
};
