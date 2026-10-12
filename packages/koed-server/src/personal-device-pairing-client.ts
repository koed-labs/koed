import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID
} from "node:crypto";
import {
  isLoopbackHostname,
  readDesktopLocalCredentialAuthorization,
  isPrivateNetworkIpv4Address
} from "@koed/shared";
import type { PersonalSyncResult } from "./personal-sync.js";
import {
  exchangeOverPaseoRelay,
  normalizeDeviceRequestRelayUrl
} from "./personal-device-request-relay.js";

const isPersonalDevicePairingUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value
  );

export const PERSONAL_DEVICE_PAIRING_PROTOCOL = "koed/pds-lan-pair/v1";
const MAX_PLAINTEXT_BYTES = 256 * 1_024;
const MAX_RESPONSE_BYTES = 1_048_576;
const COMPLETION_ATTEMPTS = 3;

class AmbiguousTransportFailure extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super("Pairing exchange transport failed.");
    this.name = "AmbiguousTransportFailure";
    this.originalError = originalError;
  }
}

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
  value: unknown,
  configuredRelayUrl?: string
): {
  invitationUrl: URL;
  invitationId: string;
  token: string;
  relayUrl?: string;
} => {
  if (typeof value !== "string" || value.length > 8_192) {
    throw new Error("Pairing link is invalid.");
  }
  const input = value.trim();
  let normalized = input;
  if (input.startsWith("koed://")) {
    try {
      const deepLink = new URL(input);
      const links = deepLink.searchParams.getAll("url");
      if (
        deepLink.protocol !== "koed:" ||
        deepLink.hostname !== "pair" ||
        deepLink.pathname !== "/redeem" ||
        deepLink.port ||
        deepLink.username ||
        deepLink.password ||
        deepLink.hash ||
        [...deepLink.searchParams.keys()].some((key) => key !== "url") ||
        links.length !== 1 ||
        links[0]!.length > 4_096
      ) {
        throw new Error("Pairing deep link is invalid.");
      }
      normalized = links[0]!;
    } catch {
      throw new Error("Pairing deep link is invalid.");
    }
  }
  const match =
    /^https?:\/\/([^/:?#]+)(?::([1-9][0-9]{0,4}))?(\/pair\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))#token=([A-Za-z0-9_-]{43})$/.exec(
      normalized
    );
  if (!match) throw new Error("Pairing link is invalid.");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Pairing link is invalid.");
  }
  const isDirect =
    url.protocol === "http:" &&
    Boolean(match[2]) &&
    isPrivateNetworkIpv4Address(url.hostname);
  let relayUrl: string | undefined;
  if (configuredRelayUrl) {
    const relay = new URL(normalizeDeviceRequestRelayUrl(configuredRelayUrl));
    const expectedProtocol = relay.protocol === "wss:" ? "https:" : "http:";
    const expectedOrigin = `${expectedProtocol.slice(0, -1)}://${relay.host}`;
    if (url.protocol === expectedProtocol && url.origin === expectedOrigin)
      relayUrl = configuredRelayUrl;
  }
  if (
    match[1] !== url.hostname ||
    (!isDirect && !relayUrl) ||
    url.username ||
    url.password ||
    url.search ||
    url.pathname !== match[3] ||
    url.hash !== `#token=${match[5]}`
  ) {
    throw new Error(
      "Pairing link must be a private-network Koed link or use configured Paseo relay."
    );
  }
  return {
    invitationUrl: url,
    invitationId: match[4]!,
    token: match[5]!,
    ...(relayUrl ? { relayUrl } : {})
  };
};

export const parseLoopbackOrigin = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("Local control URL must be an exact loopback origin.");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Local control URL must be an exact loopback origin.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !isLoopbackHostname(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Local control URL must be an exact loopback origin.");
  }
  return url.origin;
};

const readBoundedResponseText = async (
  response: Response,
  classifyAmbiguousTransportFailure = false
): Promise<string> => {
  const rawContentLength = response.headers.get("content-length");
  let declaredLength: number | undefined;
  if (rawContentLength !== null) {
    const contentLength = rawContentLength.trim();
    if (!/^\d+$/.test(contentLength)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Pairing response is invalid.");
    }
    declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Pairing response is invalid.");
    }
    if (declaredLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Pairing response exceeds maximum size.");
    }
  }
  if (!response.body) {
    if (classifyAmbiguousTransportFailure && declaredLength !== 0) {
      throw new AmbiguousTransportFailure(
        new Error("Pairing response body was dropped.")
      );
    }
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let overflow = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > MAX_RESPONSE_BYTES - bytes) {
        overflow = true;
        await reader.cancel().catch(() => undefined);
        throw new Error("Pairing response exceeds maximum size.");
      }
      bytes += next.value.byteLength;
      chunks.push(next.value);
    }
  } catch (error) {
    if (!overflow) await reader.cancel().catch(() => undefined);
    if (overflow || !classifyAmbiguousTransportFailure) throw error;
    throw new AmbiguousTransportFailure(error);
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== undefined && bytes !== declaredLength) {
    if (bytes < declaredLength && classifyAmbiguousTransportFailure) {
      throw new AmbiguousTransportFailure(
        new Error("Pairing response body was truncated.")
      );
    }
    throw new Error("Pairing response is invalid.");
  }
  if (
    bytes === 0 &&
    classifyAmbiguousTransportFailure &&
    declaredLength !== 0
  ) {
    throw new AmbiguousTransportFailure(
      new Error("Pairing response body was dropped.")
    );
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
};

const isTruncatedJson = (text: string, error: unknown): boolean => {
  const trimmed = text.trim();
  if (
    !(error instanceof SyntaxError) ||
    (!trimmed.startsWith("{") && !trimmed.startsWith("["))
  ) {
    return false;
  }
  if (/unexpected end|unterminated string/i.test(error.message)) return true;
  const position = /position (\d+)/i.exec(error.message)?.[1];
  return position !== undefined && Number(position) >= text.length;
};

const responseJson = async (
  response: Response,
  classifyAmbiguousTransportFailure = false
): Promise<Record<string, unknown>> => {
  const text = await readBoundedResponseText(
    response,
    classifyAmbiguousTransportFailure && response.ok
  );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (
      classifyAmbiguousTransportFailure &&
      response.ok &&
      isTruncatedJson(text, error)
    ) {
      throw new AmbiguousTransportFailure(error);
    }
    throw new Error("Pairing response is invalid.", { cause: error });
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
  deviceLabel: string;
  requestId: string;
  localControlUrl: string;
  koedHome: string;
  environment: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  runPersonalSync: RunPersonalSync;
  withJsonFd: WithJsonFd;
}): Promise<PersonalSyncResult> => {
  const { invitationUrl, invitationId, token, relayUrl } = parseLink(
    options.link,
    options.environment.KOED_PDS_REQUEST_RELAY_URL
  );
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!relayUrl && !fetcher)
    throw new Error("Pairing network access is unavailable.");

  const exchange = async (
    payload: Record<string, unknown>,
    timeoutMs = 10_000,
    classifyTransportFailure = false
  ): Promise<Record<string, unknown>> => {
    const encrypted = encrypt(payload, {
      invitationId,
      token,
      direction: "request"
    });
    let response: Response;
    try {
      if (relayUrl) {
        const raw = await exchangeOverPaseoRelay({
          relayUrl,
          id: invitationId,
          token,
          routeContext: PERSONAL_DEVICE_PAIRING_PROTOCOL,
          frame: JSON.stringify(encrypted),
          maxFrameBytes: MAX_RESPONSE_BYTES,
          timeoutMs
        });
        const tunnelResponse = JSON.parse(raw) as Record<string, unknown>;
        if (
          !exactKeys(tunnelResponse, ["protocol", "status", "body"]) ||
          tunnelResponse.protocol !== "koed/pair-http-response/v1" ||
          typeof tunnelResponse.status !== "number" ||
          !Number.isInteger(tunnelResponse.status) ||
          tunnelResponse.status < 100 ||
          tunnelResponse.status > 599 ||
          typeof tunnelResponse.body !== "string"
        )
          throw new Error("Pairing relay response is invalid.");
        response = new Response(tunnelResponse.body, {
          status: tunnelResponse.status,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      } else {
        response = await fetcher!(
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
      }
    } catch (error) {
      if (classifyTransportFailure) throw new AmbiguousTransportFailure(error);
      throw error;
    }
    const decrypted = decrypt(
      await responseJson(response, classifyTransportFailure),
      {
        invitationId,
        token,
        direction: "response"
      }
    );
    if (decrypted.messageId !== encrypted.message_id) {
      const error = new Error("Pairing response binding is invalid.");
      if (classifyTransportFailure) throw new AmbiguousTransportFailure(error);
      throw error;
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
  const relayEndpointUrl = new URL(typedInvitation.relay_url);
  const pdsRouteId = /^\/pds\/([0-9a-f-]{36})$/.exec(
    relayEndpointUrl.pathname
  )?.[1];
  const pdsRouteToken = /^#token=([A-Za-z0-9_-]{43})$/.exec(
    relayEndpointUrl.hash
  )?.[1];
  if (
    typedInvitation.protocol !== PERSONAL_DEVICE_PAIRING_PROTOCOL ||
    controlUrl.origin !== invitationUrl.origin ||
    controlUrl.pathname !== `/v1/pair/${invitationId}/exchange` ||
    controlUrl.search ||
    controlUrl.hash ||
    relayEndpointUrl.origin !== invitationUrl.origin ||
    relayEndpointUrl.search ||
    (relayEndpointUrl.pathname === "/pds"
      ? Boolean(relayEndpointUrl.hash)
      : !pdsRouteId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          pdsRouteId
        ) ||
        !pdsRouteToken ||
        Buffer.from(pdsRouteToken, "base64url").toString("base64url") !==
          pdsRouteToken)
  ) {
    throw new Error("Pairing invitation endpoint binding is invalid.");
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
    Array.isArray(joinPairing) ||
    (joinPairing as Record<string, unknown>).challengeId !==
      typedInvitation.challenge_id
  ) {
    throw new Error("Koed could not verify the pairing challenge binding.");
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
    const localOrigin = parseLoopbackOrigin(options.localControlUrl);
    const response = await fetcher(new URL(path, `${localOrigin}/`), {
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
  let completion: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < COMPLETION_ATTEMPTS; attempt += 1) {
    try {
      completion = await exchange({ operation: "complete" }, 10_000, true);
      break;
    } catch (error) {
      if (!(error instanceof AmbiguousTransportFailure)) throw error;
      if (attempt === COMPLETION_ATTEMPTS - 1) throw error.originalError;
    }
  }
  if (!completion || completion.completed !== true) {
    throw new Error("Pairing invitation was not closed after enrollment.");
  }
  const publicResult = { ...completed };
  delete publicResult.localGroupReconciliation;
  return publicResult;
};
