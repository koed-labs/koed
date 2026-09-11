import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID
} from "node:crypto";
import {
  readDesktopLocalCredentialAuthorization,
  isPrivateNetworkIpv4Address
} from "@koed/shared";
import type { PersonalSyncResult } from "./personal-sync.js";

const isPersonalDevicePairingUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value
  );

export const PERSONAL_DEVICE_PAIRING_PROTOCOL = "koed/pds-lan-pair/v1";
const MAX_PLAINTEXT_BYTES = 256 * 1_024;
const MAX_RESPONSE_BYTES = 1_048_576;

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

type Envelope = {
  protocol: typeof PERSONAL_DEVICE_PAIRING_PROTOCOL;
  message_id: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};

type RunPersonalSync = (
  args: string[],
  options: {
    environment: NodeJS.ProcessEnv;
    pairingToken: string;
    fetch: typeof globalThis.fetch;
  }
) => Promise<PersonalSyncResult>;

type WithJsonFd = <T>(
  payload: Record<string, unknown>,
  operation: (fd: number) => Promise<T>
) => Promise<T>;

const exactKeys = (
  value: Record<string, unknown>,
  expected: string[]
): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const strictBase64url = (value: unknown, bytes?: number): Buffer => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Pairing message is invalid.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    (bytes !== undefined && decoded.length !== bytes) ||
    decoded.toString("base64url") !== value
  ) {
    throw new Error("Pairing message is invalid.");
  }
  return decoded;
};

const pairingKey = (invitationId: string, token: string): Buffer => {
  if (
    !isPersonalDevicePairingUuid(invitationId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(token)
  ) {
    throw new Error("Pairing credentials are invalid.");
  }
  const tokenBytes = strictBase64url(token, 32);
  const salt = createHash("sha256")
    .update(`${PERSONAL_DEVICE_PAIRING_PROTOCOL}\0${invitationId}`, "utf8")
    .digest();
  return Buffer.from(
    hkdfSync(
      "sha256",
      tokenBytes,
      salt,
      Buffer.from(`${PERSONAL_DEVICE_PAIRING_PROTOCOL}/transport-key`, "utf8"),
      32
    )
  );
};

const additionalData = (
  direction: "request" | "response",
  invitationId: string,
  messageId: string
): Buffer =>
  Buffer.from(
    `${PERSONAL_DEVICE_PAIRING_PROTOCOL}/${direction}\n${invitationId}\n${messageId}`,
    "utf8"
  );

const parseEnvelope = (value: unknown): Envelope => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pairing message is invalid.");
  }
  const envelope = value as Record<string, unknown>;
  if (
    !exactKeys(envelope, [
      "protocol",
      "message_id",
      "nonce",
      "ciphertext",
      "tag"
    ]) ||
    envelope.protocol !== PERSONAL_DEVICE_PAIRING_PROTOCOL ||
    !isPersonalDevicePairingUuid(envelope.message_id)
  ) {
    throw new Error("Pairing message is invalid.");
  }
  strictBase64url(envelope.nonce, 12);
  strictBase64url(envelope.tag, 16);
  const ciphertext = strictBase64url(envelope.ciphertext);
  if (ciphertext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error("Pairing message is too large.");
  }
  return envelope as Envelope;
};

const encrypt = (
  input: Record<string, unknown>,
  options: {
    invitationId: string;
    token: string;
    direction: "request" | "response";
  }
): Envelope => {
  const plaintext = Buffer.from(JSON.stringify(input), "utf8");
  if (plaintext.length === 0 || plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error("Pairing message is too large.");
  }
  const messageId = randomUUID();
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    pairingKey(options.invitationId, options.token),
    nonce
  );
  cipher.setAAD(
    additionalData(options.direction, options.invitationId, messageId)
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    protocol: PERSONAL_DEVICE_PAIRING_PROTOCOL,
    message_id: messageId,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  };
};

const decrypt = (
  input: unknown,
  options: {
    invitationId: string;
    token: string;
    direction: "request" | "response";
  }
): { messageId: string; value: Record<string, unknown> } => {
  const envelope = parseEnvelope(input);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      pairingKey(options.invitationId, options.token),
      strictBase64url(envelope.nonce, 12)
    );
    decipher.setAAD(
      additionalData(
        options.direction,
        options.invitationId,
        envelope.message_id
      )
    );
    decipher.setAuthTag(strictBase64url(envelope.tag, 16));
    const plaintext = Buffer.concat([
      decipher.update(strictBase64url(envelope.ciphertext)),
      decipher.final()
    ]);
    if (plaintext.length === 0 || plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw new Error("Pairing message is too large.");
    }
    const value = JSON.parse(plaintext.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Pairing message is invalid.");
    }
    return {
      messageId: envelope.message_id,
      value: value as Record<string, unknown>
    };
  } catch {
    throw new Error("Pairing message authentication failed.");
  }
};

const parseLink = (
  value: unknown
): { invitationUrl: URL; invitationId: string; token: string } => {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new Error("Pairing link is invalid.");
  }
  const normalized = value.trim();
  const match =
    /^http:\/\/([^/:?#]+):([1-9][0-9]{0,4})(\/pair\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))#token=([A-Za-z0-9_-]{43})$/.exec(
      normalized
    );
  if (!match) throw new Error("Pairing link is invalid.");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Pairing link is invalid.");
  }
  if (
    match[1] !== url.hostname ||
    !isPrivateNetworkIpv4Address(url.hostname) ||
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.pathname !== match[3] ||
    url.hash !== `#token=${match[5]}`
  ) {
    throw new Error(
      "Same-network pairing requires a private-network or Tailscale link issued by Koed."
    );
  }
  return {
    invitationUrl: url,
    invitationId: match[4]!,
    token: match[5]!
  };
};

const responseJson = async (
  response: Response
): Promise<Record<string, unknown>> => {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("Pairing response exceeds maximum size.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Pairing response exceeds maximum size.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Pairing response is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pairing response is invalid.");
  }
  if (!response.ok) {
    const error = value as Record<string, unknown>;
    throw new Error(
      typeof error.error === "string" ? error.error : "Pairing exchange failed."
    );
  }
  return value as Record<string, unknown>;
};

export const redeemPersonalDevicePairing = async (options: {
  link: string;
  expectedShortCode?: string;
  deviceLabel: string;
  requestId: string;
  localControlUrl: string;
  koedHome: string;
  environment: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  runPersonalSync: RunPersonalSync;
  withJsonFd: WithJsonFd;
}): Promise<PersonalSyncResult> => {
  const { invitationUrl, invitationId, token } = parseLink(options.link);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("Pairing network access is unavailable.");

  const exchange = async (
    payload: Record<string, unknown>,
    timeoutMs = 10_000
  ): Promise<Record<string, unknown>> => {
    const encrypted = encrypt(payload, {
      invitationId,
      token,
      direction: "request"
    });
    const response = await fetcher(
      new URL(`/v1/pair/${invitationId}/exchange`, invitationUrl.origin),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify(encrypted),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
    const decrypted = decrypt(await responseJson(response), {
      invitationId,
      token,
      direction: "response"
    });
    if (decrypted.messageId !== encrypted.message_id) {
      throw new Error("Pairing response binding is invalid.");
    }
    return decrypted.value;
  };

  const invitationResponse = await exchange({ operation: "invitation" });
  const invitation = invitationResponse.invitation;
  if (
    !invitation ||
    typeof invitation !== "object" ||
    Array.isArray(invitation)
  ) {
    throw new Error("Pairing invitation is invalid.");
  }
  const typedInvitation =
    invitation as unknown as PersonalDevicePairingInvitation;
  const controlUrl = new URL(typedInvitation.control_url);
  const relayUrl = new URL(typedInvitation.relay_url);
  if (
    typedInvitation.protocol !== PERSONAL_DEVICE_PAIRING_PROTOCOL ||
    controlUrl.origin !== invitationUrl.origin ||
    controlUrl.pathname !== `/v1/pair/${invitationId}/exchange` ||
    relayUrl.origin !== invitationUrl.origin ||
    relayUrl.pathname !== "/pds"
  ) {
    throw new Error("Pairing invitation endpoint binding is invalid.");
  }

  const expected = options.expectedShortCode?.trim().toUpperCase();
  if (
    expected &&
    expected !==
      typedInvitation.challenge_id.replaceAll("-", "").slice(0, 8).toUpperCase()
  ) {
    throw new Error(
      "Pairing invitation code does not match the invitation link."
    );
  }

  const controlFetch = (async (
    input: URL | RequestInfo,
    init?: RequestInit
  ) => {
    const requestedUrl = new URL(
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : input.url
    );
    const prefix = controlUrl.toString().replace(/\/$/, "");
    if (
      requestedUrl.origin !== controlUrl.origin ||
      !requestedUrl.toString().startsWith(`${prefix}/`)
    ) {
      throw new Error("Pairing control request escaped its invitation.");
    }
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method !== "GET" && method !== "POST")
      throw new Error("Pairing control method is invalid.");
    const body =
      init?.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : (() => {
              throw new Error("Pairing control body is invalid.");
            })();
    const headers = new Headers(init?.headers);
    const result = await exchange(
      {
        operation: "control",
        method,
        path: requestedUrl.toString().slice(prefix.length),
        headers: Object.fromEntries(
          ["accept", "content-type"].flatMap((name) => {
            const value = headers.get(name);
            return value ? [[name, value]] : [];
          })
        ),
        ...(body === undefined ? {} : { body })
      },
      10_000
    );
    if (typeof result.status !== "number" || typeof result.body !== "string") {
      throw new Error("Pairing control response is invalid.");
    }
    return new Response(result.body, {
      status: result.status,
      headers:
        result.headers &&
        typeof result.headers === "object" &&
        !Array.isArray(result.headers)
          ? (result.headers as Record<string, string>)
          : { "content-type": "application/json; charset=utf-8" }
    });
  }) as typeof globalThis.fetch;

  const join = await options.withJsonFd(
    typedInvitation as unknown as Record<string, unknown>,
    async (fd) =>
      await options.runPersonalSync(
        [
          "join",
          "request",
          "--group-id",
          typedInvitation.group_id,
          "--invitation-fd",
          String(fd)
        ],
        {
          environment: {
            ...options.environment,
            PDS_CONTROL_URL: controlUrl.toString(),
            PDS_RUNTIME_SECRET_REF:
              options.environment.PDS_RUNTIME_SECRET_REF?.trim() ||
              "pds-runtime"
          },
          pairingToken: token,
          fetch: controlFetch
        }
      )
  );
  const request = join.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Koed could not create the signed pairing request.");
  }
  const joinPairing = join.pairing;
  if (
    !joinPairing ||
    typeof joinPairing !== "object" ||
    Array.isArray(joinPairing)
  ) {
    throw new Error("Koed could not verify the pairing short code.");
  }
  const joinPairingRecord = joinPairing as Record<string, unknown>;
  if (
    typeof joinPairingRecord.shortCode !== "string" ||
    !/^[0-9A-F]{8}$/.test(joinPairingRecord.shortCode)
  ) {
    throw new Error("Koed could not verify the pairing short code.");
  }
  if (expected && joinPairingRecord.shortCode !== expected) {
    throw new Error(
      "Pairing invitation code does not match the joining request."
    );
  }

  const submitted = await exchange(
    {
      operation: "request",
      request,
      device_label: options.deviceLabel.trim().slice(0, 80) || "SSH device"
    },
    10 * 60 * 1_000
  );
  if (submitted.approved !== true)
    throw new Error("Pairing approval was not completed.");

  const completed = await options.runPersonalSync(
    [
      "join",
      "complete",
      "--group-id",
      typedInvitation.group_id,
      "--challenge-id",
      typedInvitation.challenge_id
    ],
    {
      environment: {
        ...options.environment,
        PDS_CONTROL_URL: controlUrl.toString(),
        PDS_RUNTIME_SECRET_REF:
          options.environment.PDS_RUNTIME_SECRET_REF?.trim() || "pds-runtime"
      },
      pairingToken: token,
      fetch: controlFetch
    }
  );
  const reconciliation = completed.localGroupReconciliation;
  if (
    !reconciliation ||
    typeof reconciliation !== "object" ||
    Array.isArray(reconciliation)
  ) {
    throw new Error(
      "Koed could not verify the joining device's local sync state."
    );
  }
  const localCredential = readDesktopLocalCredentialAuthorization(
    options.koedHome
  );
  if (!localCredential) {
    throw new Error(
      "Koed local Desktop credential is unavailable for SSH enrollment."
    );
  }
  const localRequest = async (path: string, body?: Record<string, unknown>) => {
    const response = await fetcher(`${options.localControlUrl}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: localCredential.authorization,
        ...(body ? { "content-type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(30_000)
    });
    return await responseJson(response);
  };
  const localGroup = await localRequest(
    "/v1/personal-device-sync/local-group-reconciliation",
    reconciliation as Record<string, unknown>
  );
  const localUserId = localGroup.local_user_id;
  if (typeof localUserId !== "string")
    throw new Error("Local Personal identity binding failed.");
  await localRequest("/v1/personal-device-sync/local-runtime-wake");

  await options.runPersonalSync(
    [
      "join",
      "bind-local-user",
      "--group-id",
      typedInvitation.group_id,
      "--user-id",
      localUserId,
      "--challenge-id",
      typedInvitation.challenge_id
    ],
    {
      environment: {
        ...options.environment,
        PDS_CONTROL_URL: controlUrl.toString(),
        PDS_RUNTIME_SECRET_REF:
          options.environment.PDS_RUNTIME_SECRET_REF?.trim() || "pds-runtime"
      },
      pairingToken: token,
      fetch: controlFetch
    }
  );
  const completion = await exchange({ operation: "complete" });
  if (completion.completed !== true) {
    throw new Error("Pairing invitation was not closed after enrollment.");
  }
  const publicResult = { ...completed };
  delete publicResult.localGroupReconciliation;
  return publicResult;
};
