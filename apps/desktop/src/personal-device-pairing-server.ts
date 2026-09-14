import { randomBytes, randomUUID, verify } from "node:crypto";
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
import {
  canonicalizePdsJson,
  pdsEd25519PublicKey,
  PDS_PROTOCOL
} from "@koed/shared";
import {
  isPersonalDevicePairingUuid,
  isPrivatePersonalDevicePairingIpv4
} from "./personal-device-pairing-link.js";

export const PERSONAL_DEVICE_PAIRING_DEFAULT_PORT = 3310;
const MAX_REQUEST_BYTES = PERSONAL_DEVICE_PAIRING_MAX_PLAINTEXT_BYTES + 1_024;
const MAX_ACTIVE_INVITATIONS = 8;
const MAX_EXCHANGES_PER_INVITATION = 64;
// Claimed requests may need a bounded retry after a joiner loses its HTTP
// connection, but bearer capability must not survive indefinitely.
const COMMIT_RECOVERY_WINDOW_MS = 10 * 60_000;

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
  expiresAt: string;
  state:
    | "waiting"
    | "connecting"
    | "completed"
    | "expired"
    | "cancelled"
    | "failed";
  phase:
    | "waiting"
    | "request_received"
    | "committing"
    | "awaiting_joiner"
    | "completed";
  joiningDeviceLabel: string | null;
};

type PendingInvitation = {
  id: string;
  token: string;
  invitation: PersonalDevicePairingInvitation;
  view: PersonalDevicePairingView;
  request: JsonObject | null;
  requestCanonical: string | null;
  requestWaiters: Array<{
    resolve: (request: JsonObject) => void;
    reject: (error: Error) => void;
  }>;
  completionWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>;
  submission: {
    resolve: (value: { approved: true }) => void;
    reject: (error: Error) => void;
  } | null;
  approved: boolean;
  approvalClaimed: boolean;
  authorizationExpired: boolean;
  recoveryExpiresAt: number | null;
  expires: ReturnType<typeof setTimeout>;
  recoveryExpires: ReturnType<typeof setTimeout> | null;
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
  /** Claim approval before any durable membership write begins. */
  claimApproval(id: string): void;
  /** Commit approval after durable membership write succeeds. */
  approve(id: string): void;
  fail?(id: string): void;
  waitForCompletion(id: string, signal?: AbortSignal): Promise<void>;
  cancel(id: string): void;
  inspect(id?: string): PersonalDevicePairingView[];
  close(): Promise<void>;
  port: number;
  relayUrl: string | null;
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
    signal: AbortSignal;
  }): Promise<{
    status: number;
    headers?: Record<string, string>;
    body: string;
  }>;
  validateCompletion?: (input: {
    groupId: string;
    deviceId: string;
  }) => Promise<boolean>;
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

const isPdsKey = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, "base64url").length === 32;

const isSafeIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 240 &&
  /^[\x21-\x7e]+$/.test(value);

const validateInvitation = (
  invitation: Omit<
    PersonalDevicePairingInvitation,
    "protocol" | "control_url" | "relay_url"
  >,
  now: Date
): void => {
  if (
    !isSafeIdentifier(invitation.group_id) ||
    !isPersonalDevicePairingUuid(invitation.challenge_id) ||
    !isPdsKey(invitation.challenge) ||
    !isSafeIdentifier(invitation.browser_subject_id) ||
    !isSafeIdentifier(invitation.browser_deployment_id) ||
    !isSafeIdentifier(invitation.authority.key_id) ||
    !isPdsKey(invitation.authority.public_key)
  ) {
    throw new Error("Pairing invitation is invalid.");
  }
  const expiresAt = Date.parse(invitation.expires_at);
  if (expiresAt <= now.getTime()) {
    throw new Error("Pairing invitation expired.");
  }
  if (!Number.isFinite(expiresAt) || expiresAt - now.getTime() > 10 * 60_000) {
    throw new Error("Pairing invitation lifetime is invalid.");
  }
};

const validatePairingRequest = (
  request: JsonObject,
  invitation: PersonalDevicePairingInvitation
): void => {
  if (
    !hasExactKeys(request, [
      "group_id",
      "device_id",
      "signing_key_id",
      "signing_public_key",
      "kem_key_id",
      "kem_public_key",
      "operation_families",
      "proof"
    ]) ||
    request.group_id !== invitation.group_id ||
    !isSafeIdentifier(request.device_id) ||
    !isSafeIdentifier(request.signing_key_id) ||
    !isSafeIdentifier(request.kem_key_id) ||
    !isPdsKey(request.signing_public_key) ||
    !isPdsKey(request.kem_public_key) ||
    !Array.isArray(request.operation_families) ||
    request.operation_families.length !== 1 ||
    request.operation_families[0] !== "pds_relay"
  ) {
    throw new Error("Pairing request is invalid.");
  }
  const proof = request.proof as JsonObject;
  if (
    !proof ||
    typeof proof !== "object" ||
    Array.isArray(proof) ||
    !hasExactKeys(proof as JsonObject, [
      "challenge_id",
      "challenge",
      "device_id",
      "signature",
      "expires_at"
    ]) ||
    proof.challenge_id !== invitation.challenge_id ||
    proof.challenge !== invitation.challenge ||
    proof.device_id !== request.device_id ||
    proof.expires_at !== invitation.expires_at ||
    !isPdsKey(proof.challenge) ||
    typeof proof.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(proof.signature) ||
    Buffer.from(proof.signature, "base64url").length !== 64
  ) {
    throw new Error("Pairing request is invalid.");
  }
  const unsigned = {
    challengeId: invitation.challenge_id,
    challenge: invitation.challenge,
    groupId: invitation.group_id,
    deviceId: request.device_id,
    deviceSigningKeyId: request.signing_key_id,
    deviceSigningPublicKey: request.signing_public_key,
    deviceKemKeyId: request.kem_key_id,
    deviceKemPublicKey: request.kem_public_key,
    browserSubjectId: invitation.browser_subject_id,
    browserDeploymentId: invitation.browser_deployment_id,
    expiresAt: invitation.expires_at
  };
  try {
    if (
      !verify(
        null,
        Buffer.from(
          `${PDS_PROTOCOL}/enrollment-proof\n${canonicalizePdsJson(unsigned)}`,
          "utf8"
        ),
        pdsEd25519PublicKey(request.signing_public_key),
        Buffer.from(proof.signature, "base64url")
      )
    ) {
      throw new Error("Pairing request signature is invalid.");
    }
  } catch {
    throw new Error("Pairing request signature is invalid.");
  }
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

  const markAuthorizationExpired = (pending: PendingInvitation): void => {
    pending.authorizationExpired = true;
    pending.view.url = "";
  };

  const expire = (
    pending: PendingInvitation,
    state: "expired" | "cancelled" | "failed",
    reason = state === "expired"
      ? "Pairing invitation expired."
      : state === "cancelled"
        ? "Pairing invitation was cancelled."
        : "Pairing enrollment failed.",
    force = false
  ) => {
    if (
      pending.view.state === "completed" ||
      pending.view.state === "expired" ||
      pending.view.state === "cancelled" ||
      pending.view.state === "failed"
    ) {
      return;
    }
    // Claimed requests keep one bounded recovery window. Never let invitation
    // expiry authorize a different request, and never keep its bearer token
    // alive after recovery closes.
    if (pending.approvalClaimed && !force) {
      markAuthorizationExpired(pending);
      return;
    }
    clearTimeout(pending.expires);
    if (pending.recoveryExpires) clearTimeout(pending.recoveryExpires);
    pending.recoveryExpires = null;
    pending.recoveryExpiresAt = null;
    pending.view.state = state;
    pending.view.url = "";
    pending.submission?.reject(new Error(reason));
    pending.submission = null;
    for (const waiter of pending.requestWaiters.splice(0)) {
      waiter.reject(new Error(reason));
    }
    for (const waiter of pending.completionWaiters.splice(0)) {
      waiter.reject(new Error(reason));
    }
    pending.request = null;
    pending.requestCanonical = null;
    pending.token = "";
    pending.usedMessageIds.clear();
  };

  const activeInvitation = (id: string): PendingInvitation | undefined => {
    const pending = invitations.get(id);
    if (
      !pending ||
      pending.view.state === "completed" ||
      pending.view.state === "expired" ||
      pending.view.state === "cancelled" ||
      pending.view.state === "failed"
    ) {
      return pending;
    }
    const currentTime = now().getTime();
    if (
      pending.recoveryExpiresAt !== null &&
      pending.recoveryExpiresAt <= currentTime
    ) {
      expire(pending, "expired", "Pairing invitation recovery expired.", true);
    } else if (Date.parse(pending.invitation.expires_at) <= currentTime) {
      if (pending.approvalClaimed) markAuthorizationExpired(pending);
      else expire(pending, "expired");
    }
    return pending;
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
    const forwardingAbort = new AbortController();
    const abortForwarding = () => forwardingAbort.abort();
    request.once("aborted", abortForwarding);
    response.once("close", abortForwarding);
    try {
      const url = new URL(request.url ?? "/", "http://koed.invalid");
      const landing = /^\/pair\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && landing) {
        const invitationId = landing[1];
        const pending = isPersonalDevicePairingUuid(invitationId)
          ? activeInvitation(invitationId)
          : undefined;
        if (
          !pending ||
          pending.view.state === "completed" ||
          pending.view.state === "expired" ||
          pending.view.state === "cancelled" ||
          pending.view.state === "failed" ||
          pending.authorizationExpired
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
          ? activeInvitation(invitationId)
          : undefined;
        if (
          !pending ||
          pending.view.state === "completed" ||
          pending.view.state === "expired" ||
          pending.view.state === "cancelled" ||
          pending.view.state === "failed"
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
        const operation = decrypted.value.operation;
        const exactRecoveryRequest = (): boolean => {
          if (
            !pending.authorizationExpired ||
            !pending.approvalClaimed ||
            operation !== "request" ||
            !hasExactKeys(decrypted.value, [
              "operation",
              "request",
              "device_label"
            ]) ||
            !pending.requestCanonical ||
            typeof decrypted.value.device_label !== "string" ||
            decrypted.value.device_label !== pending.view.joiningDeviceLabel ||
            !decrypted.value.request ||
            typeof decrypted.value.request !== "object" ||
            Array.isArray(decrypted.value.request)
          ) {
            return false;
          }
          try {
            return (
              canonicalizePdsJson(decrypted.value.request) ===
              pending.requestCanonical
            );
          } catch {
            return false;
          }
        };
        const approvedRecoveryOperation =
          pending.authorizationExpired &&
          pending.approved &&
          (operation === "control" || operation === "complete");
        if (
          pending.authorizationExpired &&
          !approvedRecoveryOperation &&
          !exactRecoveryRequest()
        ) {
          json(response, 410, { error: "Pairing invitation is unavailable." });
          return;
        }
        if (pending.usedMessageIds.size >= MAX_EXCHANGES_PER_INVITATION) {
          json(response, 429, {
            error: "Pairing invitation exchange limit reached."
          });
          return;
        }
        pending.usedMessageIds.add(decrypted.messageId);
        const waitForApproval = (): Promise<{ approved: true }> =>
          new Promise<{ approved: true }>((resolve, reject) => {
            pending.submission = { resolve, reject };
            response.once("close", () => {
              if (
                !response.writableEnded &&
                pending.submission?.reject === reject
              ) {
                pending.submission = null;
                if (pending.approvalClaimed) {
                  // Keep durable request binding for exact recovery after the
                  // joiner's original HTTP connection is gone.
                  pending.view.state = "connecting";
                  pending.view.phase = "committing";
                } else {
                  pending.request = null;
                  pending.requestCanonical = null;
                  pending.view.state = "waiting";
                  pending.view.phase = "waiting";
                  pending.view.joiningDeviceLabel = null;
                }
                reject(new Error("Joining device disconnected."));
              }
            });
          });
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
          validatePairingRequest(
            pairingRequest as JsonObject,
            pending.invitation
          );
          const requestCanonical = canonicalizePdsJson(pairingRequest);
          if (pending.request) {
            if (
              pending.requestCanonical !== requestCanonical ||
              pending.view.joiningDeviceLabel !== deviceLabel
            ) {
              json(response, pending.authorizationExpired ? 410 : 409, {
                error: pending.authorizationExpired
                  ? "Pairing invitation is unavailable."
                  : "Pairing invitation has already been redeemed."
              });
              return;
            }
            if (pending.approved) {
              encryptedResponse(response, pending, decrypted.messageId, {
                approved: true
              });
              return;
            }
            if (!pending.approvalClaimed || pending.submission) {
              json(response, 409, {
                error: "Pairing request is already being processed."
              });
              return;
            }
            const approval = await waitForApproval();
            encryptedResponse(response, pending, decrypted.messageId, approval);
            return;
          }
          pending.request = pairingRequest as JsonObject;
          pending.requestCanonical = requestCanonical;
          pending.view.state = "connecting";
          pending.view.phase = "request_received";
          pending.view.joiningDeviceLabel = deviceLabel;
          for (const waiter of pending.requestWaiters.splice(0)) {
            waiter.resolve(pending.request);
          }
          const approval = await waitForApproval();
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
          if (!pending.approved) {
            json(response, 403, {
              error: "Pairing enrollment is still being processed."
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
            mode: "pairing",
            signal: forwardingAbort.signal
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
          if (!pending.approved) {
            json(response, 403, {
              error: "Pairing enrollment is still being processed."
            });
            return;
          }
          if (
            options.validateCompletion &&
            !(await options.validateCompletion({
              groupId: pending.invitation.group_id,
              deviceId: String(
                (pending.request as JsonObject | null)?.device_id ?? ""
              )
            }))
          ) {
            json(response, 409, {
              error:
                "Pairing enrollment has not reached its activation boundary."
            });
            return;
          }
          encryptedResponse(response, pending, decrypted.messageId, {
            completed: true
          });
          clearTimeout(pending.expires);
          if (pending.recoveryExpires) clearTimeout(pending.recoveryExpires);
          pending.recoveryExpires = null;
          pending.recoveryExpiresAt = null;
          pending.view.state = "completed";
          pending.view.phase = "completed";
          pending.view.url = "";
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
          mode: "relay",
          signal: forwardingAbort.signal
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
      if (forwardingAbort.signal.aborted || response.destroyed) return;
      const message =
        error instanceof Error ? error.message : "Pairing failed.";
      const status =
        message === "Pairing invitation expired." ||
        message === "Pairing invitation recovery expired."
          ? 410
          : 400;
      json(response, status, { error: message });
    } finally {
      request.off("aborted", abortForwarding);
      response.off("close", abortForwarding);
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
  const advertisedAddress = (options.addresses ?? localIpv4Addresses)().find(
    isPrivatePersonalDevicePairingIpv4
  );

  return {
    port,
    relayUrl: advertisedAddress
      ? `http://${advertisedAddress}:${port}/pds`
      : null,
    createInvitation(baseInvitation) {
      for (const [id, pending] of invitations) {
        if (
          pending.view.state === "expired" ||
          pending.view.state === "cancelled" ||
          pending.view.state === "failed" ||
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
      validateInvitation(baseInvitation, now());
      const view: PersonalDevicePairingView = {
        id,
        url,
        expiresAt: baseInvitation.expires_at,
        state: "waiting",
        phase: "waiting",
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
        approved: false,
        approvalClaimed: false,
        authorizationExpired: false,
        recoveryExpiresAt: null,
        expires: setTimeout(() => {
          if (pending.approvalClaimed) markAuthorizationExpired(pending);
          else expire(pending, "expired");
        }, delay),
        recoveryExpires: null,
        usedMessageIds: new Set()
      };
      invitations.set(id, pending);
      return { ...view };
    },
    async waitForRequest(id, signal) {
      const pending = activeInvitation(id);
      if (!pending) throw new Error("Pairing invitation is unavailable.");
      if (
        pending.view.state === "expired" ||
        pending.view.state === "cancelled"
      ) {
        throw new Error("Pairing invitation is unavailable.");
      }
      if (pending.view.state === "failed") {
        throw new Error("Pairing enrollment failed.");
      }
      if (pending.request) return pending.request;
      return await new Promise<JsonObject>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Pairing wait was cancelled."));
          return;
        }
        const aborted = () => {
          const index = pending.requestWaiters.indexOf(waiter);
          if (index >= 0) pending.requestWaiters.splice(index, 1);
          reject(new Error("Pairing wait was cancelled."));
        };
        const waiter = {
          resolve: (request: JsonObject) => {
            signal?.removeEventListener("abort", aborted);
            resolve(request);
          },
          reject: (error: Error) => {
            signal?.removeEventListener("abort", aborted);
            reject(error);
          }
        };
        signal?.addEventListener("abort", aborted, { once: true });
        pending.requestWaiters.push(waiter);
      });
    },
    claimApproval(id) {
      const pending = activeInvitation(id);
      if (
        !pending ||
        pending.view.state === "expired" ||
        pending.view.state === "cancelled"
      ) {
        throw new Error("Pairing invitation is unavailable.");
      }
      if (pending.approved || pending.approvalClaimed) return;
      if (!pending.request || !pending.submission) {
        throw new Error("No joining device is awaiting approval.");
      }
      pending.approvalClaimed = true;
      pending.recoveryExpiresAt = now().getTime() + COMMIT_RECOVERY_WINDOW_MS;
      pending.recoveryExpires = setTimeout(
        () =>
          expire(
            pending,
            "expired",
            "Pairing invitation recovery expired.",
            true
          ),
        COMMIT_RECOVERY_WINDOW_MS
      );
      pending.view.phase = "committing";
    },
    approve(id) {
      const pending = activeInvitation(id);
      if (
        !pending ||
        pending.view.state === "expired" ||
        pending.view.state === "cancelled"
      ) {
        throw new Error("Pairing invitation is unavailable.");
      }
      if (pending.approved) return;
      if (
        !pending.request ||
        (!pending.approvalClaimed && !pending.submission)
      ) {
        throw new Error("No joining device is awaiting approval.");
      }
      // Keep low-level callers compatible; normal manager flow claims before
      // durable I/O, making cancellation race-safe.
      if (!pending.approvalClaimed) {
        pending.approvalClaimed = true;
        pending.recoveryExpiresAt = now().getTime() + COMMIT_RECOVERY_WINDOW_MS;
        pending.recoveryExpires = setTimeout(
          () =>
            expire(
              pending,
              "expired",
              "Pairing invitation recovery expired.",
              true
            ),
          COMMIT_RECOVERY_WINDOW_MS
        );
      }
      pending.approved = true;
      pending.view.phase = "awaiting_joiner";
      pending.submission?.resolve({ approved: true });
      pending.submission = null;
    },
    fail(id) {
      const pending = invitations.get(id);
      if (pending)
        expire(pending, "failed", "Pairing enrollment failed.", true);
    },
    async waitForCompletion(id, signal) {
      const pending = activeInvitation(id);
      if (!pending) throw new Error("Pairing invitation is unavailable.");
      if (pending.view.state === "completed") return;
      if (
        pending.view.state === "expired" ||
        pending.view.state === "cancelled" ||
        pending.view.state === "failed"
      ) {
        throw new Error(
          pending.view.state === "failed"
            ? "Pairing enrollment failed."
            : "Pairing invitation is unavailable."
        );
      }
      return await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Pairing wait was cancelled."));
          return;
        }
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
      const pending = activeInvitation(id);
      if (!pending) return;
      if (pending.view.state === "completed") {
        throw new Error("Completed device pairing cannot be cancelled.");
      }
      if (pending.approvalClaimed || pending.approved) {
        throw new Error(
          "Pairing enrollment cannot be cancelled after commit started."
        );
      }
      expire(pending, "cancelled");
    },
    inspect(id) {
      return [...invitations.values()]
        .filter((pending) => !id || pending.id === id)
        .map((pending) => {
          activeInvitation(pending.id);
          return { ...pending.view };
        });
    },
    async close() {
      for (const pending of invitations.values()) {
        expire(pending, "cancelled", "Pairing invitation was cancelled.", true);
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  };
};
