import { randomBytes, randomUUID, verify } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
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
import { isPersonalDevicePairingUuid } from "./personal-device-pairing-link.js";
import {
  normalizeDeviceRequestRelayUrl,
  runPaseoRelayServer
} from "@koed/koed-server";
import {
  listPersonalDevicePairingNetworkAddresses,
  resolvePersonalDevicePairingBindAddress
} from "./personal-device-pairing-network.js";

export const PERSONAL_DEVICE_PAIRING_DEFAULT_PORT = 3310;
const MAX_REQUEST_BYTES = PERSONAL_DEVICE_PAIRING_MAX_PLAINTEXT_BYTES + 1_024;
const MAX_ACTIVE_INVITATIONS = 8;
const MAX_EXCHANGES_PER_INVITATION = 64;
// Claimed requests may need a bounded retry after a joiner loses its HTTP
// connection, but bearer capability must not survive indefinitely.
const COMMIT_RECOVERY_WINDOW_MS = 10 * 60_000;

type JsonObject = Record<string, unknown>;

type PairingPersistence = {
  get(reference: string): Promise<string | null>;
  put(reference: string, value: string): Promise<void>;
  delete(reference: string): Promise<void>;
};

const PAIRING_PERSISTENCE_REFERENCE = "pds-pairing-recovery";
const PAIRING_RELAY_ROUTES_REFERENCE = "pds-pairing-relay-routes";
const PAIRING_RELAY_ROUTES_VERSION = 2;
const MAX_PERSISTED_RELAY_ROUTES = 128;
const PAIRING_PERSISTENCE_VERSION = 1;
const PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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
  approvalPersistence: Promise<void> | null;
  authorizationExpired: boolean;
  recoveryExpiresAt: number | null;
  completedExpires: ReturnType<typeof setTimeout> | null;
  expires: ReturnType<typeof setTimeout>;
  recoveryExpires: ReturnType<typeof setTimeout> | null;
  usedMessageIds: Set<string>;
};

type PersistedRelayRoute = {
  id: string;
  token: string;
  relayUrl: string;
  purpose: "pairing" | "pds" | "legacy";
};

type PersistedPairing = {
  version: typeof PAIRING_PERSISTENCE_VERSION;
  id: string;
  token: string;
  invitation: PersonalDevicePairingInvitation;
  request: JsonObject;
  requestCanonical: string;
  joiningDeviceLabel: string;
  approvalClaimed: boolean;
  approved: boolean;
  authorizationExpired: boolean;
  recoveryExpiresAt: number;
  completedExpiresAt: number | null;
  usedMessageIds: string[];
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
  claimApproval(id: string): Promise<void>;
  /** Commit approval after durable membership write succeeds. */
  approve(id: string): Promise<void>;
  fail?(id: string): void;
  waitForCompletion(id: string, signal?: AbortSignal): Promise<void>;
  cancel(id: string): void;
  inspect(id?: string): PersonalDevicePairingView[];
  claimedInvitationIds?(): string[];
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
  persistence?: PairingPersistence;
  relayUrl?: string;
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

const pairingRelayHeaders = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Pairing relay headers are invalid.");
  const allowed = new Set([
    "accept",
    "content-type",
    "x-pds-membership-certificate",
    "x-pds-relay-proof"
  ]);
  const entries = Object.entries(value as JsonObject);
  if (
    entries.some(
      ([key, entry]) =>
        !allowed.has(key) ||
        typeof entry !== "string" ||
        entry.length > 128_000 ||
        /[\r\n\0]/.test(entry)
    )
  )
    throw new Error("Pairing relay headers are invalid.");
  return Object.fromEntries(entries as [string, string][]);
};

const validPairingRelayPath = (path: string): boolean => {
  if (path.length > 2_048 || path.startsWith("//") || /\\\\|%2e/i.test(path))
    return false;
  try {
    const url = new URL(path, "http://koed.invalid");
    return (
      url.origin === "http://koed.invalid" &&
      url.pathname.startsWith("/v1/personal-device-sync/relay/")
    );
  } catch {
    return false;
  }
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
  const availableAddresses = (
    options.addresses ?? listPersonalDevicePairingNetworkAddresses
  )();
  const configuredRelayUrl = options.relayUrl
    ? normalizeDeviceRequestRelayUrl(options.relayUrl)
    : undefined;
  const host = configuredRelayUrl
    ? "127.0.0.1"
    : resolvePersonalDevicePairingBindAddress(options.host, availableAddresses);
  const configuredPort = options.port ?? PERSONAL_DEVICE_PAIRING_DEFAULT_PORT;
  const now = options.now ?? (() => new Date());
  const persistence = options.persistence;
  if (configuredRelayUrl && !persistence)
    throw new Error(
      "Paseo pairing relay requires encrypted route persistence."
    );
  const invitations = new Map<string, PendingInvitation>();
  const relaySessions = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  const persistedRelayRoutes = new Map<string, PersistedRelayRoute>();
  const pdsRouteFromInvitation = (
    invitation: PersonalDevicePairingInvitation
  ): PersistedRelayRoute | null => {
    if (!configuredRelayUrl) return null;
    try {
      const relay = new URL(configuredRelayUrl);
      const expectedOrigin = `${relay.protocol === "wss:" ? "https" : "http"}://${relay.host}`;
      const url = new URL(invitation.relay_url);
      const id = /^\/pds\/([^/]+)$/.exec(url.pathname)?.[1];
      const token = /^#token=([A-Za-z0-9_-]{43})$/.exec(url.hash)?.[1];
      if (
        url.origin !== expectedOrigin ||
        !id ||
        !isPersonalDevicePairingUuid(id) ||
        !token ||
        Buffer.from(token, "base64url").toString("base64url") !== token
      )
        return null;
      return { id, token, relayUrl: configuredRelayUrl, purpose: "pds" };
    } catch {
      return null;
    }
  };
  const relayRoutesForInvitation = (
    pending: PendingInvitation
  ): PersistedRelayRoute[] => {
    if (!configuredRelayUrl) return [];
    const pdsRoute = pdsRouteFromInvitation(pending.invitation);
    const sharedRoute = pdsRoute?.id === pending.id;
    const pairingRoute: PersistedRelayRoute = {
      id: pending.id,
      token: pending.token,
      relayUrl: configuredRelayUrl ?? "",
      purpose: sharedRoute ? "legacy" : "pairing"
    };
    return pdsRoute && !sharedRoute ? [pairingRoute, pdsRoute] : [pairingRoute];
  };
  const stopRelaySession = (id: string): void => {
    relaySessions.get(id)?.controller.abort();
    relaySessions.delete(id);
  };
  let relayRouteWrite: Promise<void> = Promise.resolve();
  const persisted = new Map<string, PersistedPairing>();
  let persistenceWrite: Promise<void> = Promise.resolve();

  const persistedValue = (): string =>
    JSON.stringify({
      version: PAIRING_PERSISTENCE_VERSION,
      invitations: [...persisted.values()]
    });

  const writePersistence = async (
    value: string,
    deleteWhenEmpty: boolean
  ): Promise<void> => {
    if (!persistence) return;
    if (deleteWhenEmpty) {
      await persistence.delete(PAIRING_PERSISTENCE_REFERENCE);
    } else {
      await persistence.put(PAIRING_PERSISTENCE_REFERENCE, value);
    }
  };

  const savePersistence = async (
    value = persistedValue(),
    deleteWhenEmpty = persisted.size === 0
  ): Promise<void> => {
    if (!persistence) return;
    const write = persistenceWrite
      .catch(() => undefined)
      .then(() => writePersistence(value, deleteWhenEmpty));
    persistenceWrite = write;
    await write;
  };

  const saveRelayRoutes = async (): Promise<void> => {
    if (!persistence) return;
    const value = JSON.stringify({
      version: PAIRING_RELAY_ROUTES_VERSION,
      routes: [...persistedRelayRoutes.values()]
    });
    const write = relayRouteWrite
      .catch(() => undefined)
      .then(async () => {
        if (persistedRelayRoutes.size === 0)
          await persistence.delete(PAIRING_RELAY_ROUTES_REFERENCE);
        else await persistence.put(PAIRING_RELAY_ROUTES_REFERENCE, value);
      });
    relayRouteWrite = write;
    await write;
  };

  const restoreRelayRoutes = async (): Promise<void> => {
    if (!persistence) return;
    const raw = await persistence.get(PAIRING_RELAY_ROUTES_REFERENCE);
    if (!raw) return;
    try {
      const value = JSON.parse(raw) as { version?: unknown; routes?: unknown };
      if (
        (value.version !== 1 &&
          value.version !== PAIRING_RELAY_ROUTES_VERSION) ||
        !Array.isArray(value.routes) ||
        value.routes.length > MAX_PERSISTED_RELAY_ROUTES
      )
        throw new Error("invalid relay route state");
      for (const entry of value.routes) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          throw new Error("invalid relay route state");
        const candidate = entry as JsonObject;
        const legacy = value.version === 1;
        if (
          !hasExactKeys(
            candidate,
            legacy
              ? ["id", "token", "relayUrl"]
              : ["id", "token", "relayUrl", "purpose"]
          ) ||
          !isPersonalDevicePairingUuid(candidate.id) ||
          typeof candidate.token !== "string" ||
          !PAIRING_TOKEN_PATTERN.test(candidate.token) ||
          typeof candidate.relayUrl !== "string" ||
          normalizeDeviceRequestRelayUrl(candidate.relayUrl) !==
            candidate.relayUrl ||
          (!legacy &&
            !["pairing", "pds", "legacy"].includes(String(candidate.purpose)))
        )
          throw new Error("invalid relay route state");
        const route: PersistedRelayRoute = {
          id: candidate.id,
          token: candidate.token,
          relayUrl: candidate.relayUrl,
          purpose: legacy
            ? "legacy"
            : (candidate.purpose as PersistedRelayRoute["purpose"])
        };
        persistedRelayRoutes.set(route.id, route);
      }
    } catch {
      persistedRelayRoutes.clear();
      await persistence.delete(PAIRING_RELAY_ROUTES_REFERENCE);
    }
  };

  const persistRelayRoute = async (
    route: PersistedRelayRoute
  ): Promise<void> => {
    const previous = persistedRelayRoutes.get(route.id);
    if (!previous && persistedRelayRoutes.size >= MAX_PERSISTED_RELAY_ROUTES)
      throw new Error("Too many paired relay routes are already stored.");
    persistedRelayRoutes.set(route.id, route);
    try {
      await saveRelayRoutes();
    } catch (error) {
      if (previous) persistedRelayRoutes.set(route.id, previous);
      else persistedRelayRoutes.delete(route.id);
      throw error;
    }
  };

  const removePersistedRelayRoute = async (id: string): Promise<void> => {
    if (!persistedRelayRoutes.delete(id)) return;
    await saveRelayRoutes();
  };

  const snapshot = (pending: PendingInvitation): PersistedPairing => ({
    version: PAIRING_PERSISTENCE_VERSION,
    id: pending.id,
    token: pending.token,
    invitation: pending.invitation,
    request: pending.request as JsonObject,
    requestCanonical: pending.requestCanonical as string,
    joiningDeviceLabel: pending.view.joiningDeviceLabel as string,
    approvalClaimed: pending.approvalClaimed,
    approved: pending.approved,
    authorizationExpired: pending.authorizationExpired,
    recoveryExpiresAt: pending.recoveryExpiresAt as number,
    completedExpiresAt:
      pending.view.state === "completed" ? pending.recoveryExpiresAt : null,
    usedMessageIds: [...pending.usedMessageIds]
  });

  const persistPending = async (pending: PendingInvitation): Promise<void> => {
    if (!persistence || !pending.request || !pending.requestCanonical) return;
    const next = snapshot(pending);
    const write = persistenceWrite
      .catch(() => undefined)
      .then(async () => {
        const previous = persisted.get(pending.id);
        persisted.set(pending.id, next);
        try {
          await writePersistence(persistedValue(), persisted.size === 0);
        } catch (error) {
          if (persisted.get(pending.id) === next) {
            if (previous) persisted.set(pending.id, previous);
            else persisted.delete(pending.id);
          }
          throw error;
        }
      });
    persistenceWrite = write;
    await write;
  };

  const deletePersisted = (id: string): void => {
    if (!persistence) return;
    const write = persistenceWrite
      .catch(() => undefined)
      .then(async () => {
        const previous = persisted.get(id);
        if (!previous) return;
        persisted.delete(id);
        try {
          await writePersistence(persistedValue(), persisted.size === 0);
        } catch (error) {
          if (!persisted.has(id)) persisted.set(id, previous);
          throw error;
        }
      });
    persistenceWrite = write;
    void write.catch(() => undefined);
  };

  const markAuthorizationExpired = (pending: PendingInvitation): void => {
    pending.authorizationExpired = true;
    pending.view.url = "";
    void persistPending(pending).catch(() => undefined);
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
    const wasCompleted = pending.view.state === "completed";
    if (
      (pending.view.state === "completed" && !force) ||
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
    if (pending.completedExpires) clearTimeout(pending.completedExpires);
    pending.recoveryExpires = null;
    pending.recoveryExpiresAt = null;
    pending.completedExpires = null;
    deletePersisted(pending.id);
    stopRelaySession(pending.id);
    if (!wasCompleted) {
      const pdsRoute = pdsRouteFromInvitation(pending.invitation);
      if (pdsRoute && pdsRoute.id !== pending.id) stopRelaySession(pdsRoute.id);
    } else if (configuredRelayUrl) {
      void removePersistedRelayRoute(pending.id).catch(() => undefined);
    }
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

  const restorePersisted = async (): Promise<void> => {
    if (!persistence) return;
    const raw = await persistence.get(PAIRING_PERSISTENCE_REFERENCE);
    if (!raw) return;
    let entries: unknown[];
    try {
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        invitations?: unknown;
      };
      if (
        parsed.version !== PAIRING_PERSISTENCE_VERSION ||
        !Array.isArray(parsed.invitations)
      ) {
        throw new Error("invalid pairing recovery state");
      }
      entries = parsed.invitations;
    } catch {
      await persistence.delete(PAIRING_PERSISTENCE_REFERENCE);
      return;
    }
    const currentTime = now().getTime();
    for (const value of entries.slice(0, MAX_ACTIVE_INVITATIONS)) {
      try {
        const entry = value as PersistedPairing;
        if (
          entry.version !== PAIRING_PERSISTENCE_VERSION ||
          !isPersonalDevicePairingUuid(entry.id) ||
          !PAIRING_TOKEN_PATTERN.test(entry.token) ||
          !entry.invitation ||
          entry.invitation.protocol !== PERSONAL_DEVICE_PAIRING_PROTOCOL ||
          !entry.request ||
          typeof entry.requestCanonical !== "string" ||
          typeof entry.joiningDeviceLabel !== "string" ||
          entry.joiningDeviceLabel.length < 1 ||
          entry.joiningDeviceLabel.length > 80 ||
          /[\r\n\0]/.test(entry.joiningDeviceLabel) ||
          typeof entry.approvalClaimed !== "boolean" ||
          !entry.approvalClaimed ||
          typeof entry.approved !== "boolean" ||
          typeof entry.authorizationExpired !== "boolean" ||
          !Number.isFinite(entry.recoveryExpiresAt) ||
          entry.recoveryExpiresAt <= currentTime ||
          !Array.isArray(entry.usedMessageIds) ||
          entry.usedMessageIds.length > MAX_EXCHANGES_PER_INVITATION ||
          !entry.usedMessageIds.every(
            (messageId) =>
              typeof messageId === "string" &&
              isPersonalDevicePairingUuid(messageId)
          )
        ) {
          continue;
        }
        const invitationExpiresAt = Date.parse(entry.invitation.expires_at);
        if (!Number.isFinite(invitationExpiresAt)) continue;
        validateInvitation(
          {
            group_id: entry.invitation.group_id,
            challenge_id: entry.invitation.challenge_id,
            challenge: entry.invitation.challenge,
            expires_at: entry.invitation.expires_at,
            browser_subject_id: entry.invitation.browser_subject_id,
            browser_deployment_id: entry.invitation.browser_deployment_id,
            authority: entry.invitation.authority
          },
          new Date(invitationExpiresAt - 1)
        );
        validatePairingRequest(entry.request, entry.invitation);
        if (configuredRelayUrl && !pdsRouteFromInvitation(entry.invitation))
          continue;
        if (canonicalizePdsJson(entry.request) !== entry.requestCanonical) {
          continue;
        }
        const completed = entry.completedExpiresAt !== null;
        if (
          completed &&
          (!entry.approved ||
            !Number.isFinite(entry.completedExpiresAt) ||
            (entry.completedExpiresAt as number) <= currentTime)
        ) {
          continue;
        }
        const authorizationExpired =
          entry.authorizationExpired || invitationExpiresAt <= currentTime;
        const view: PersonalDevicePairingView = {
          id: entry.id,
          // Rebuilt after listener bind so recovered links cannot retain a
          // stale or unrelated origin from persisted state.
          url: "",
          expiresAt: entry.invitation.expires_at,
          state: completed ? "completed" : "connecting",
          phase: completed
            ? "completed"
            : entry.approved
              ? "awaiting_joiner"
              : "committing",
          joiningDeviceLabel: entry.joiningDeviceLabel
        };
        const pending: PendingInvitation = {
          id: entry.id,
          token: entry.token,
          invitation: entry.invitation,
          view,
          request: entry.request,
          requestCanonical: entry.requestCanonical,
          requestWaiters: [],
          completionWaiters: [],
          submission: null,
          approved: entry.approved,
          approvalClaimed: true,
          approvalPersistence: null,
          authorizationExpired,
          recoveryExpiresAt: entry.recoveryExpiresAt,
          completedExpires: null,
          expires: setTimeout(
            () => {
              if (!pending.authorizationExpired)
                markAuthorizationExpired(pending);
            },
            Math.max(1, Date.parse(entry.invitation.expires_at) - currentTime)
          ),
          recoveryExpires: null,
          usedMessageIds: new Set(entry.usedMessageIds)
        };
        if (completed) {
          pending.completedExpires = setTimeout(
            () =>
              expire(
                pending,
                "expired",
                "Pairing invitation recovery expired.",
                true
              ),
            Math.max(1, (entry.completedExpiresAt as number) - currentTime)
          );
        } else {
          pending.recoveryExpires = setTimeout(
            () =>
              expire(
                pending,
                "expired",
                "Pairing invitation recovery expired.",
                true
              ),
            Math.max(1, entry.recoveryExpiresAt - currentTime)
          );
        }
        invitations.set(pending.id, pending);
        persisted.set(pending.id, snapshot(pending));
      } catch {
        // Ignore one malformed recovery entry without exposing its contents.
      }
    }
    await savePersistence();
  };

  const clearInvitationTimers = (): void => {
    for (const pending of invitations.values()) {
      clearTimeout(pending.expires);
      if (pending.recoveryExpires) clearTimeout(pending.recoveryExpires);
      if (pending.completedExpires) clearTimeout(pending.completedExpires);
    }
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
        const reserveMessageId = async (persist = true): Promise<void> => {
          if (pending.usedMessageIds.size >= MAX_EXCHANGES_PER_INVITATION) {
            throw new Error("Pairing invitation exchange limit reached.");
          }
          pending.usedMessageIds.add(decrypted.messageId);
          if (!persist) return;
          try {
            await persistPending(pending);
          } catch {
            pending.usedMessageIds.delete(decrypted.messageId);
            throw new Error("Pairing state could not be persisted.");
          }
        };
        if (pending.view.state === "completed") {
          if (
            operation !== "complete" ||
            !hasExactKeys(decrypted.value, ["operation"])
          ) {
            json(response, 410, {
              error: "Pairing invitation is unavailable."
            });
            return;
          }
          await reserveMessageId();
          encryptedResponse(response, pending, decrypted.messageId, {
            completed: true
          });
          return;
        }
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
        const waitForApprovalPersistence = async (): Promise<boolean> => {
          const transition = pending.approvalPersistence;
          if (!transition) return true;
          try {
            await transition;
            return true;
          } catch {
            return false;
          }
        };
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
          await reserveMessageId(false);
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
              if (!(await waitForApprovalPersistence())) {
                throw new Error("Pairing state could not be persisted.");
              }
              await reserveMessageId();
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
            await reserveMessageId();
            const approval = await waitForApproval();
            encryptedResponse(response, pending, decrypted.messageId, approval);
            return;
          }
          pending.request = pairingRequest as JsonObject;
          pending.requestCanonical = requestCanonical;
          pending.view.state = "connecting";
          pending.view.phase = "request_received";
          pending.view.joiningDeviceLabel = deviceLabel;
          await reserveMessageId(false);
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
          if (!(await waitForApprovalPersistence())) {
            throw new Error("Pairing state could not be persisted.");
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
          await reserveMessageId();
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
          if (!(await waitForApprovalPersistence())) {
            throw new Error("Pairing state could not be persisted.");
          }
          await reserveMessageId();
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
          const completionIsActive = (): boolean => {
            const current = activeInvitation(pending.id);
            return (
              current === pending &&
              pending.view.state !== "expired" &&
              pending.view.state !== "cancelled" &&
              pending.view.state !== "failed" &&
              (pending.recoveryExpiresAt === null ||
                pending.recoveryExpiresAt > now().getTime())
            );
          };
          if (!completionIsActive()) {
            json(response, 410, {
              error: "Pairing invitation recovery expired."
            });
            return;
          }
          const previousRecoveryExpiresAt = pending.recoveryExpiresAt;
          pending.view.state = "completed";
          pending.view.phase = "completed";
          pending.view.url = "";
          pending.recoveryExpiresAt =
            now().getTime() + COMMIT_RECOVERY_WINDOW_MS;
          pending.completedExpires = setTimeout(
            () =>
              expire(
                pending,
                "expired",
                "Pairing invitation recovery expired.",
                true
              ),
            COMMIT_RECOVERY_WINDOW_MS
          );
          const persistedRouteIds: string[] = [];
          try {
            await persistPending(pending);
            for (const route of relayRoutesForInvitation(pending)) {
              await persistRelayRoute(route);
              persistedRouteIds.push(route.id);
            }
          } catch {
            for (const routeId of persistedRouteIds)
              await removePersistedRelayRoute(routeId).catch(() => undefined);
            if (pending.completedExpires)
              clearTimeout(pending.completedExpires);
            pending.completedExpires = null;
            pending.view.state = "connecting";
            pending.view.phase = "awaiting_joiner";
            pending.view.url = "";
            pending.recoveryExpiresAt = previousRecoveryExpiresAt;
            pending.usedMessageIds.delete(decrypted.messageId);
            await persistPending(pending).catch(() => undefined);
            throw new Error("Pairing state could not be persisted.");
          }
          if (!completionIsActive()) {
            if (configuredRelayUrl)
              await removePersistedRelayRoute(pending.id).catch(
                () => undefined
              );
            json(response, 410, {
              error: "Pairing invitation recovery expired."
            });
            return;
          }
          clearTimeout(pending.expires);
          if (pending.recoveryExpires) clearTimeout(pending.recoveryExpires);
          pending.recoveryExpires = null;
          encryptedResponse(response, pending, decrypted.messageId, {
            completed: true
          });
          for (const waiter of pending.completionWaiters.splice(0)) {
            waiter.resolve();
          }
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
          : message === "Pairing invitation exchange limit reached."
            ? 429
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

  try {
    await restorePersisted();
    await restoreRelayRoutes();
  } catch {
    clearInvitationTimers();
    throw new Error("Pairing recovery state is unavailable.");
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(configuredPort, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    clearInvitationTimers();
    throw error;
  }
  const address = server.address();
  const port =
    address && typeof address === "object" ? address.port : configuredPort;
  const localOrigin = `http://${host}:${port}`;
  const relayOrigin = configuredRelayUrl
    ? `${new URL(configuredRelayUrl).protocol === "wss:" ? "https" : "http"}://${new URL(configuredRelayUrl).host}`
    : localOrigin;
  const pairingExchangeUrl = (id: string) =>
    `${relayOrigin}/v1/pair/${id}/exchange`;
  const pdsRelayUrl = (id: string, token: string) =>
    configuredRelayUrl
      ? `${relayOrigin}/pds/${id}#token=${token}`
      : `${localOrigin}/pds`;
  const pairingDisplayUrl = (id: string, token: string) =>
    `${relayOrigin}/pair/${id}#token=${token}`;
  const forwardTunnelFrame = async (
    pending: PersistedRelayRoute,
    frame: string,
    signal: AbortSignal
  ): Promise<string> => {
    const message = strictObject(frame);
    if (message.protocol === "koed/pds-http-tunnel/v1") {
      if (pending.purpose === "pairing")
        throw new Error("Pairing route cannot carry PDS relay traffic.");
      const expectedKeys =
        message.body === undefined
          ? ["protocol", "request_id", "method", "path", "headers"]
          : ["protocol", "request_id", "method", "path", "headers", "body"];
      if (
        !hasExactKeys(message, expectedKeys) ||
        typeof message.request_id !== "string" ||
        !isPersonalDevicePairingUuid(message.request_id) ||
        (message.method !== "GET" &&
          message.method !== "POST" &&
          message.method !== "PUT") ||
        typeof message.path !== "string" ||
        !validPairingRelayPath(message.path) ||
        (message.body !== undefined && typeof message.body !== "string")
      )
        throw new Error("Pairing relay request is invalid.");
      const forwarded = await options.forwardControl({
        method: message.method,
        path: message.path,
        headers: pairingRelayHeaders(message.headers),
        ...(typeof message.body === "string" ? { body: message.body } : {}),
        mode: "relay",
        signal
      });
      if (forwarded.status === 401 || forwarded.status === 403) {
        void removePersistedRelayRoute(pending.id).catch(() => undefined);
        const session = relaySessions.get(pending.id);
        if (session) {
          const revokeTimer = setTimeout(
            () => session.controller.abort(),
            1_000
          );
          revokeTimer.unref();
        }
      }
      return JSON.stringify({
        protocol: "koed/pds-http-tunnel/v1",
        request_id: message.request_id,
        status: forwarded.status,
        headers: forwarded.headers ?? {},
        body: forwarded.body
      });
    }
    if (pending.purpose === "pds")
      throw new Error("PDS route cannot carry pairing control traffic.");
    const response = await fetch(
      `${localOrigin}/v1/pair/${pending.id}/exchange`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: frame,
        redirect: "error",
        signal
      }
    );
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
      throw new Error("Pairing relay response is too large.");
    return JSON.stringify({
      protocol: "koed/pair-http-response/v1",
      status: response.status,
      body
    });
  };
  const startRelaySession = (route: PersistedRelayRoute): void => {
    if (relaySessions.has(route.id)) return;
    const controller = new AbortController();
    const task = runPaseoRelayServer({
      relayUrl: route.relayUrl,
      id: route.id,
      token: route.token,
      routeContext: PERSONAL_DEVICE_PAIRING_PROTOCOL,
      signal: controller.signal,
      onFrame: (frame, signal) => forwardTunnelFrame(route, frame, signal)
    });
    relaySessions.set(route.id, { controller, task });
  };
  const startInvitationRelaySessions = (pending: PendingInvitation): void => {
    if (!configuredRelayUrl) return;
    const pdsRoute = pdsRouteFromInvitation(pending.invitation);
    const sharedRoute = pdsRoute?.id === pending.id;
    startRelaySession({
      id: pending.id,
      token: pending.token,
      relayUrl: configuredRelayUrl,
      purpose: sharedRoute ? "legacy" : "pairing"
    });
    if (pdsRoute && !sharedRoute) startRelaySession(pdsRoute);
  };
  for (const pending of invitations.values())
    startInvitationRelaySessions(pending);
  for (const route of persistedRelayRoutes.values()) startRelaySession(route);
  for (const pending of invitations.values()) {
    pending.invitation = {
      ...pending.invitation,
      control_url: pairingExchangeUrl(pending.id),
      relay_url:
        pdsRouteFromInvitation(pending.invitation)?.id === pending.id
          ? pdsRelayUrl(pending.id, pending.token)
          : pending.invitation.relay_url
    };
    if (!pending.authorizationExpired && pending.view.state !== "completed") {
      pending.view.url = pairingDisplayUrl(pending.id, pending.token);
    }
  }

  return {
    port,
    relayUrl: configuredRelayUrl ? null : `${localOrigin}/pds`,
    createInvitation(baseInvitation) {
      for (const [id, pending] of invitations) {
        if (
          pending.view.state === "expired" ||
          pending.view.state === "cancelled" ||
          pending.view.state === "failed"
        ) {
          invitations.delete(id);
        }
      }
      if (invitations.size >= MAX_ACTIVE_INVITATIONS) {
        throw new Error("Too many pairing invitations are already active.");
      }
      if (!configuredRelayUrl && !availableAddresses.includes(host)) {
        throw new Error(
          "No private network address is available for device pairing."
        );
      }
      const id = randomUUID();
      const token = randomBytes(32).toString("base64url");
      const pdsRelayId = configuredRelayUrl ? randomUUID() : id;
      const pdsRelayToken = configuredRelayUrl
        ? randomBytes(32).toString("base64url")
        : token;
      const invitation: PersonalDevicePairingInvitation = {
        ...baseInvitation,
        protocol: PERSONAL_DEVICE_PAIRING_PROTOCOL,
        control_url: pairingExchangeUrl(id),
        relay_url: pdsRelayUrl(pdsRelayId, pdsRelayToken)
      };
      const url = pairingDisplayUrl(id, token);
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
        approvalPersistence: null,
        authorizationExpired: false,
        recoveryExpiresAt: null,
        completedExpires: null,
        expires: setTimeout(() => {
          if (pending.approvalClaimed) markAuthorizationExpired(pending);
          else expire(pending, "expired");
        }, delay),
        recoveryExpires: null,
        usedMessageIds: new Set()
      };
      invitations.set(id, pending);
      startInvitationRelaySessions(pending);
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
    async claimApproval(id) {
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
      pending.view.phase = "committing";
      try {
        await persistPending(pending);
      } catch {
        pending.approvalClaimed = false;
        pending.recoveryExpiresAt = null;
        pending.view.phase = "request_received";
        throw new Error("Pairing state could not be persisted.");
      }
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
    },
    async approve(id) {
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
        pending.view.phase = "committing";
        try {
          await persistPending(pending);
        } catch {
          pending.approvalClaimed = false;
          pending.recoveryExpiresAt = null;
          pending.view.phase = "request_received";
          throw new Error("Pairing state could not be persisted.");
        }
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
      const approvalPersistence = persistPending(pending);
      pending.approvalPersistence = approvalPersistence;
      try {
        await approvalPersistence;
      } catch {
        pending.approved = false;
        pending.view.phase = "committing";
        throw new Error("Pairing state could not be persisted.");
      } finally {
        if (pending.approvalPersistence === approvalPersistence) {
          pending.approvalPersistence = null;
        }
      }
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
    claimedInvitationIds() {
      return [...invitations.values()]
        .filter((pending) => pending.approvalClaimed)
        .map((pending) => pending.id);
    },
    async close() {
      for (const session of relaySessions.values()) session.controller.abort();
      for (const pending of invitations.values()) {
        if (pending.approvalClaimed) {
          clearTimeout(pending.expires);
          if (pending.recoveryExpires) clearTimeout(pending.recoveryExpires);
          if (pending.completedExpires) clearTimeout(pending.completedExpires);
          pending.recoveryExpires = null;
          pending.completedExpires = null;
          pending.submission?.reject(new Error("Pairing server was stopped."));
          pending.submission = null;
          for (const waiter of pending.completionWaiters.splice(0)) {
            waiter.reject(new Error("Pairing server was stopped."));
          }
        } else {
          expire(
            pending,
            "cancelled",
            "Pairing invitation was cancelled.",
            true
          );
        }
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await Promise.allSettled(
        [...relaySessions.values()].map((session) => session.task)
      );
      relaySessions.clear();
      await persistenceWrite.catch(() => undefined);
      await relayRouteWrite.catch(() => undefined);
    }
  };
};
