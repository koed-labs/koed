import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { networkInterfaces } from "node:os";
import {
  decryptPersonalDevicePairingMessage,
  encryptPersonalDevicePairingMessage,
  PERSONAL_DEVICE_PAIRING_MAX_PLAINTEXT_BYTES,
  PERSONAL_DEVICE_PAIRING_PROTOCOL
} from "./personal-device-pairing-crypto.js";
import { canonicalizePdsJson } from "@koed/shared";
import {
  isPersonalDevicePairingUuid,
  isPrivatePersonalDevicePairingIpv4
} from "./personal-device-pairing-link.js";

export const PERSONAL_DEVICE_PAIRING_DEFAULT_PORT = 3310;
const MAX_REQUEST_BYTES = PERSONAL_DEVICE_PAIRING_MAX_PLAINTEXT_BYTES + 1_024;
const MAX_ACTIVE_INVITATIONS = 8;
const MAX_EXCHANGES_PER_INVITATION = 64;

type JsonObject = Record<string, unknown>;

const hasExactKeys = (value: JsonObject, keys: string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

export type PersonalDevicePairingInvitation = {
  protocol: typeof PERSONAL_DEVICE_PAIRING_PROTOCOL;
  group_id: string;
  challenge_id: string;
  challenge: string;
  expires_at: string;
  browser_subject_id: string;
  browser_deployment_id: string;
  authority: { key_id: string; public_key: string };
  control_url: string;
  relay_url: string;
};

export type PersonalDevicePairingView = {
  id: string;
  url: string;
  shortCode: string;
  expiresAt: string;
  state:
    | "waiting"
    | "approval_required"
    | "approved"
    | "completed"
    | "expired"
    | "cancelled";
  joiningDeviceLabel: string | null;
};

type PendingInvitation = {
  id: string;
  token: string;
  invitation: PersonalDevicePairingInvitation;
  view: PersonalDevicePairingView;
  request: JsonObject | null;
  requestCanonical: string | null;
  requestWaiters: Array<(request: JsonObject) => void>;
  completionWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>;
  submission: {
    resolve: (value: { approved: true }) => void;
    reject: (error: Error) => void;
  } | null;
  expires: ReturnType<typeof setTimeout>;
  usedMessageIds: Set<string>;
};

export type PersonalDevicePairingServer = {
  createInvitation(
    invitation: Omit<
      PersonalDevicePairingInvitation,
      "protocol" | "control_url" | "relay_url"
    >
  ): PersonalDevicePairingView;
  waitForRequest(id: string, signal?: AbortSignal): Promise<JsonObject>;
  approve(id: string): void;
  waitForCompletion(id: string, signal?: AbortSignal): Promise<void>;
  cancel(id: string): void;
  inspect(id?: string): PersonalDevicePairingView[];
  close(): Promise<void>;
  port: number;
};

type PairingServerOptions = {
  port?: number;
  host?: string;
  now?: () => Date;
  addresses?: () => string[];
  forwardControl(input: {
    method: "GET" | "POST" | "PUT";
    path: string;
    headers: Record<string, string>;
    body?: string;
    mode: "pairing" | "relay";
  }): Promise<{
    status: number;
    headers?: Record<string, string>;
    body: string;
  }>;
};

export const resolvePersonalDevicePairingPort = (
  value: string | undefined
): number => {
  const configured = value?.trim();
  if (!configured) return PERSONAL_DEVICE_PAIRING_DEFAULT_PORT;
  if (!/^[1-9][0-9]{0,4}$/.test(configured)) {
    throw new Error("KOED_PDS_LAN_PORT must be a valid TCP port.");
  }
  const port = Number(configured);
  if (port > 65_535) {
    throw new Error("KOED_PDS_LAN_PORT must be a valid TCP port.");
  }
  return port;
};

const localIpv4Addresses = (): string[] => {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter(
      (entry) =>
        entry.family === "IPv4" &&
        !entry.internal &&
        isPrivatePersonalDevicePairingIpv4(entry.address)
    )
    .map((entry) => entry.address);
  return [...new Set(addresses)].sort((left, right) =>
    left.localeCompare(right)
  );
};

const json = (
  response: ServerResponse,
  status: number,
  value: JsonObject
): void => {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
};

const landingHtml = (nonce: string): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Pair with Koed</title>
  <style nonce="${nonce}">
    :root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color-scheme:light dark}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111315;color:#f4f5f6}
    main{width:min(28rem,calc(100% - 2rem));padding:2rem}
    h1{font-size:1.45rem;margin:0 0 .6rem}
    p{color:#aeb4bb;line-height:1.55;margin:0 0 1.4rem}
    button{appearance:none;border:0;border-radius:6px;padding:.75rem 1rem;background:#f4f5f6;color:#111315;font:inherit;font-weight:650;cursor:pointer}
  </style>
</head>
<body>
  <main>
    <h1>Pair this device with Koed</h1>
    <p>Koed must be installed on this device. The invitation expires shortly and can be used once.</p>
    <button id="open" type="button">Open Koed</button>
  </main>
  <script nonce="${nonce}">
    document.getElementById("open").addEventListener("click", function () {
      var token = location.hash.startsWith("#token=") ? location.hash.slice(7) : "";
      if (!token) return;
      location.href = "koed-pair://redeem?url=" + encodeURIComponent(location.origin + location.pathname + "#token=" + token);
    });
  </script>
</body>
</html>`;

const readBody = async (request: IncomingMessage): Promise<string> => {
  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (
    !Number.isFinite(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > MAX_REQUEST_BYTES
  ) {
    throw new Error("Pairing request is too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("Pairing request is too large.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const strictObject = (value: string): JsonObject => {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pairing request is invalid.");
  }
  return parsed as JsonObject;
};

const requestHeaders = (request: IncomingMessage): Record<string, string> =>
  Object.fromEntries(
    Object.entries(request.headers).flatMap(([key, value]) => {
      if (
        typeof value !== "string" ||
        ![
          "accept",
          "content-type",
          "x-pds-membership-certificate",
          "x-pds-relay-proof"
        ].includes(key)
      ) {
        return [];
      }
      return [[key, value]];
    })
  );

const pairingControlHeaders = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      (key === "accept" || key === "content-type") &&
      typeof entry === "string" &&
      entry.length <= 256 &&
      !/[\r\n\0]/.test(entry)
        ? [[key, entry]]
        : []
    )
  );
};

const validPairingControlPath = (path: string, groupId: string): boolean => {
  const encodedGroup = encodeURIComponent(groupId);
  const escapedGroup = encodedGroup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`^/v1/personal-device-sync/groups/${escapedGroup}$`),
    new RegExp(`^/v1/personal-device-sync/groups/${escapedGroup}/log$`),
    new RegExp(
      `^/v1/personal-device-sync/groups/${escapedGroup}/key-bundles/[0-9]+$`
    ),
    new RegExp(`^/v1/personal-device-sync/groups/${escapedGroup}/epoch-acks$`),
    new RegExp(
      `^/v1/personal-device-sync/groups/${escapedGroup}/certificates/[A-Za-z0-9._~-]{1,240}$`
    )
  ].some((candidate) => candidate.test(path));
};

export const startPersonalDevicePairingServer = async (
  options: PairingServerOptions
): Promise<PersonalDevicePairingServer> => {
  const host = options.host ?? "0.0.0.0";
  const configuredPort = options.port ?? PERSONAL_DEVICE_PAIRING_DEFAULT_PORT;
  const now = options.now ?? (() => new Date());
  const invitations = new Map<string, PendingInvitation>();

  const expire = (
    pending: PendingInvitation,
    state: "expired" | "cancelled"
  ) => {
    clearTimeout(pending.expires);
    pending.view.state = state;
    pending.submission?.reject(
      new Error(
        state === "expired"
          ? "Pairing invitation expired."
          : "Pairing invitation was cancelled."
      )
    );
    pending.submission = null;
    pending.requestWaiters.splice(0);
    for (const waiter of pending.completionWaiters.splice(0)) {
      waiter.reject(
        new Error(
          state === "expired"
            ? "Pairing invitation expired."
            : "Pairing invitation was cancelled."
        )
      );
    }
    pending.token = "";
    pending.usedMessageIds.clear();
  };

  const encryptedResponse = (
    response: ServerResponse,
    pending: PendingInvitation,
    messageId: string,
    value: JsonObject
  ): void => {
    json(
      response,
      200,
      encryptPersonalDevicePairingMessage(value, {
        invitationId: pending.id,
        token: pending.token,
        direction: "response",
        messageId
      })
    );
  };

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    try {
      const url = new URL(request.url ?? "/", "http://koed.invalid");
      const landing = /^\/pair\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && landing) {
        const invitationId = landing[1];
        const pending = isPersonalDevicePairingUuid(invitationId)
          ? invitations.get(invitationId)
          : undefined;
        if (
          !pending ||
          pending.view.state === "completed" ||
          pending.view.state === "expired" ||
          pending.view.state === "cancelled"
        ) {
          json(response, 410, { error: "Pairing invitation expired." });
          return;
        }
        const nonce = randomBytes(16).toString("base64");
        const body = landingHtml(nonce);
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          "content-type": "text/html; charset=utf-8",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY"
        });
        response.end(body);
        return;
      }

      const invitationRoute = /^\/v1\/pair\/([^/]+)\/exchange$/.exec(
        url.pathname
      );
      if (request.method === "POST" && invitationRoute) {
        const invitationId = invitationRoute[1];
        const pending = isPersonalDevicePairingUuid(invitationId)
          ? invitations.get(invitationId)
          : undefined;
        if (
          !pending ||
          pending.view.state === "completed" ||
          pending.view.state === "expired" ||
          pending.view.state === "cancelled"
        ) {
          json(response, 410, { error: "Pairing invitation is unavailable." });
          return;
        }
        const decrypted = decryptPersonalDevicePairingMessage(
          strictObject(await readBody(request)),
          {
            invitationId: pending.id,
            token: pending.token,
            direction: "request"
          }
        );
        if (pending.usedMessageIds.has(decrypted.messageId)) {
          json(response, 409, { error: "Pairing message was already used." });
          return;
        }
        if (pending.usedMessageIds.size >= MAX_EXCHANGES_PER_INVITATION) {
          json(response, 429, {
            error: "Pairing invitation exchange limit reached."
          });
          return;
        }
        pending.usedMessageIds.add(decrypted.messageId);
        const operation = decrypted.value.operation;
        if (operation === "invitation") {
          if (!hasExactKeys(decrypted.value, ["operation"])) {
            json(response, 400, { error: "Pairing operation is invalid." });
            return;
          }
          encryptedResponse(response, pending, decrypted.messageId, {
            invitation: pending.invitation
          });
          return;
        }
        if (operation === "request") {
          if (
            !hasExactKeys(decrypted.value, [
              "operation",
              "request",
              "device_label"
            ])
          ) {
            json(response, 400, { error: "Pairing operation is invalid." });
            return;
          }
          const submitted = decrypted.value;
          const pairingRequest = submitted.request;
          const deviceLabel = submitted.device_label;
          if (
            !pairingRequest ||
            typeof pairingRequest !== "object" ||
            Array.isArray(pairingRequest) ||
            typeof deviceLabel !== "string" ||
            deviceLabel.length < 1 ||
            deviceLabel.length > 80 ||
            /[\r\n\0]/.test(deviceLabel)
          ) {
            throw new Error("Pairing request is invalid.");
          }
          const requestCanonical = canonicalizePdsJson(pairingRequest);
          if (pending.request) {
            if (
              pending.requestCanonical !== requestCanonical ||
              pending.view.joiningDeviceLabel !== deviceLabel
            ) {
              json(response, 409, {
                error: "Pairing invitation has already been redeemed."
              });
              return;
            }
            if (pending.view.state === "approved") {
              encryptedResponse(response, pending, decrypted.messageId, {
                approved: true
              });
              return;
            }
            json(response, 409, {
              error: "The same pairing request is already awaiting approval."
            });
            return;
          }
          pending.request = pairingRequest as JsonObject;
          pending.requestCanonical = requestCanonical;
          pending.view.state = "approval_required";
          pending.view.joiningDeviceLabel = deviceLabel;
          for (const waiter of pending.requestWaiters.splice(0)) {
            waiter(pending.request);
          }
          const approval = await new Promise<{ approved: true }>(
            (resolve, reject) => {
              pending.submission = { resolve, reject };
              response.once("close", () => {
                if (
                  !response.writableEnded &&
                  pending.submission?.reject === reject
                ) {
                  pending.submission = null;
                  pending.request = null;
                  pending.requestCanonical = null;
                  pending.view.state = "waiting";
                  pending.view.joiningDeviceLabel = null;
                  reject(new Error("Joining device disconnected."));
                }
              });
            }
          );
          encryptedResponse(response, pending, decrypted.messageId, approval);
          return;
        }
        if (operation === "control") {
          if (
            !hasExactKeys(
              decrypted.value,
              decrypted.value.body === undefined
                ? ["operation", "method", "path", "headers"]
                : ["operation", "method", "path", "headers", "body"]
            )
          ) {
            json(response, 400, { error: "Pairing operation is invalid." });
            return;
          }
          if (pending.view.state !== "approved") {
            json(response, 403, {
              error: "Pairing approval is required."
            });
            return;
          }
          const controlPath =
            typeof decrypted.value.path === "string"
              ? decrypted.value.path
              : "/";
          const method = decrypted.value.method;
          if (
            (method !== "GET" && method !== "POST") ||
            !validPairingControlPath(controlPath, pending.invitation.group_id)
          ) {
            json(response, 404, { error: "Pairing route is unavailable." });
            return;
          }
          const forwarded = await options.forwardControl({
            method,
            path: controlPath,
            headers: pairingControlHeaders(decrypted.value.headers),
            ...(method === "POST" && typeof decrypted.value.body === "string"
              ? { body: decrypted.value.body }
              : {}),
            mode: "pairing"
          });
          encryptedResponse(response, pending, decrypted.messageId, {
            status: forwarded.status,
            headers: forwarded.headers ?? {},
            body: forwarded.body
          });
          return;
        }
        if (operation === "complete") {
          if (!hasExactKeys(decrypted.value, ["operation"])) {
            json(response, 400, { error: "Pairing operation is invalid." });
            return;
          }
          if (pending.view.state !== "approved") {
            json(response, 403, {
              error: "Pairing approval is required."
            });
            return;
          }
          encryptedResponse(response, pending, decrypted.messageId, {
            completed: true
          });
          clearTimeout(pending.expires);
          pending.view.state = "completed";
          for (const waiter of pending.completionWaiters.splice(0)) {
            waiter.resolve();
          }
          pending.token = "";
          pending.usedMessageIds.clear();
          return;
        }
        json(response, 400, { error: "Pairing operation is invalid." });
        return;
      }

      if (
        url.pathname.startsWith("/pds/v1/personal-device-sync/relay") &&
        (request.method === "GET" ||
          request.method === "POST" ||
          request.method === "PUT")
      ) {
        const forwarded = await options.forwardControl({
          method: request.method,
          path: url.pathname.slice("/pds".length) + url.search,
          headers: requestHeaders(request),
          ...(request.method === "GET"
            ? {}
            : { body: await readBody(request) }),
          mode: "relay"
        });
        response.writeHead(forwarded.status, {
          "cache-control": "no-store",
          "content-type":
            forwarded.headers?.["content-type"] ??
            "application/json; charset=utf-8",
          "x-content-type-options": "nosniff"
        });
        response.end(forwarded.body);
        return;
      }

      json(response, 404, { error: "Not found." });
    } catch (error) {
      json(response, 400, {
        error: error instanceof Error ? error.message : "Pairing failed."
      });
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(configuredPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port =
    address && typeof address === "object" ? address.port : configuredPort;

  return {
    port,
    createInvitation(baseInvitation) {
      for (const [id, pending] of invitations) {
        if (
          pending.view.state === "expired" ||
          pending.view.state === "cancelled" ||
          pending.view.state === "completed"
        ) {
          invitations.delete(id);
        }
      }
      if (invitations.size >= MAX_ACTIVE_INVITATIONS) {
        throw new Error("Too many pairing invitations are already active.");
      }
      const addresses = (options.addresses ?? localIpv4Addresses)().filter(
        isPrivatePersonalDevicePairingIpv4
      );
      const address = addresses[0];
      if (!address) {
        throw new Error(
          "No private network address is available for device pairing."
        );
      }
      const id = randomUUID();
      const token = randomBytes(32).toString("base64url");
      const origin = `http://${address}:${port}`;
      const invitation: PersonalDevicePairingInvitation = {
        ...baseInvitation,
        protocol: PERSONAL_DEVICE_PAIRING_PROTOCOL,
        control_url: `${origin}/v1/pair/${id}/exchange`,
        relay_url: `${origin}/pds`
      };
      const url = `${origin}/pair/${id}#token=${token}`;
      const view: PersonalDevicePairingView = {
        id,
        url,
        shortCode: baseInvitation.challenge_id
          .replaceAll("-", "")
          .slice(0, 8)
          .toUpperCase(),
        expiresAt: baseInvitation.expires_at,
        state: "waiting",
        joiningDeviceLabel: null
      };
      const delay = Math.max(
        1,
        new Date(baseInvitation.expires_at).getTime() - now().getTime()
      );
      const pending: PendingInvitation = {
        id,
        token,
        invitation,
        view,
        request: null,
        requestCanonical: null,
        requestWaiters: [],
        completionWaiters: [],
        submission: null,
        expires: setTimeout(() => expire(pending, "expired"), delay),
        usedMessageIds: new Set()
      };
      invitations.set(id, pending);
      return { ...view };
    },
    async waitForRequest(id, signal) {
      const pending = invitations.get(id);
      if (!pending) throw new Error("Pairing invitation is unavailable.");
      if (pending.request) return pending.request;
      return await new Promise<JsonObject>((resolve, reject) => {
        const done = (request: JsonObject) => {
          signal?.removeEventListener("abort", aborted);
          resolve(request);
        };
        const aborted = () => {
          const index = pending.requestWaiters.indexOf(done);
          if (index >= 0) pending.requestWaiters.splice(index, 1);
          reject(new Error("Pairing wait was cancelled."));
        };
        signal?.addEventListener("abort", aborted, { once: true });
        pending.requestWaiters.push(done);
      });
    },
    approve(id) {
      const pending = invitations.get(id);
      if (!pending?.request || !pending.submission) {
        throw new Error("No joining device is awaiting approval.");
      }
      pending.view.state = "approved";
      pending.submission.resolve({ approved: true });
      pending.submission = null;
    },
    async waitForCompletion(id, signal) {
      const pending = invitations.get(id);
      if (!pending) throw new Error("Pairing invitation is unavailable.");
      if (pending.view.state === "completed") return;
      if (
        pending.view.state === "expired" ||
        pending.view.state === "cancelled"
      ) {
        throw new Error("Pairing invitation is unavailable.");
      }
      return await new Promise<void>((resolve, reject) => {
        const completed = () => {
          signal?.removeEventListener("abort", aborted);
          resolve();
        };
        const failed = (error: Error) => {
          signal?.removeEventListener("abort", aborted);
          reject(error);
        };
        const waiter = { resolve: completed, reject: failed };
        const aborted = () => {
          const index = pending.completionWaiters.indexOf(waiter);
          if (index >= 0) pending.completionWaiters.splice(index, 1);
          reject(new Error("Pairing wait was cancelled."));
        };
        signal?.addEventListener("abort", aborted, { once: true });
        pending.completionWaiters.push(waiter);
      });
    },
    cancel(id) {
      const pending = invitations.get(id);
      if (!pending) return;
      if (
        pending.view.state === "approved" ||
        pending.view.state === "completed"
      ) {
        throw new Error("Approved device pairing cannot be cancelled.");
      }
      expire(pending, "cancelled");
    },
    inspect(id) {
      return [...invitations.values()]
        .filter((pending) => !id || pending.id === id)
        .map((pending) => ({ ...pending.view }));
    },
    async close() {
      for (const pending of invitations.values()) {
        expire(pending, "cancelled");
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  };
};
