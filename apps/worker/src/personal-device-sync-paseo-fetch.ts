import { createHash, randomUUID } from "node:crypto";
import { withPaseoRelayClientLock } from "@koed/shared";
import WebSocket from "ws";

const MAX_TUNNEL_BYTES = 2 * 1024 * 1024;
const PDS_RELAY_PREFIX = "/v1/personal-device-sync/relay/";
const ROUTE_CONTEXT = "koed/pds-lan-pair/v1";

type PaseoRoute = {
  relayUrl: string;
  id: string;
  token: string;
  baseUrl: string;
};

const paseoRoute = (
  pdsRelayUrl: string,
  configuredRelayUrl: string | undefined
): PaseoRoute | null => {
  let url: URL;
  try {
    url = new URL(pdsRelayUrl);
  } catch {
    return null;
  }
  const match = /^\/pds\/([0-9a-f-]{36})$/.exec(url.pathname);
  const token = /^#token=([A-Za-z0-9_-]{43})$/.exec(url.hash)?.[1];
  if (!match || !token || !configuredRelayUrl) return null;
  const relayUrl = new URL(configuredRelayUrl);
  const localRelay =
    relayUrl.protocol === "ws:" &&
    ["localhost", "127.0.0.1", "::1"].includes(relayUrl.hostname);
  if (
    (relayUrl.protocol !== "wss:" && !localRelay) ||
    relayUrl.pathname !== "/ws" ||
    relayUrl.search ||
    relayUrl.hash ||
    relayUrl.username ||
    relayUrl.password ||
    url.protocol !== (localRelay ? "http:" : "https:") ||
    url.origin !== `${localRelay ? "http" : "https"}://${relayUrl.host}` ||
    url.username ||
    url.password ||
    url.search ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      match[1]!
    ) ||
    Buffer.from(token, "base64url").toString("base64url") !== token
  ) {
    throw new Error("PDS Paseo relay capability is invalid.");
  }
  return {
    relayUrl: configuredRelayUrl,
    id: match[1]!,
    token,
    baseUrl: `${url.origin}${url.pathname}`
  };
};

const exchangePaseoFrame = (
  route: PaseoRoute,
  frame: string,
  signal?: AbortSignal
): Promise<string> => {
  const serverId = createHash("sha256")
    .update(`${ROUTE_CONTEXT}\0${route.id}\0${route.token}`)
    .digest("base64url");
  return withPaseoRelayClientLock(serverId, () =>
    exchangePaseoFrameUnlocked(route, frame, signal, serverId)
  );
};

const exchangePaseoFrameUnlocked = (
  route: PaseoRoute,
  frame: string,
  signal: AbortSignal | undefined,
  serverId: string
): Promise<string> => {
  const relay = new URL(route.relayUrl);
  relay.searchParams.set("serverId", serverId);
  relay.searchParams.set("role", "client");
  const socket = new WebSocket(relay.toString(), {
    maxPayload: MAX_TUNNEL_BYTES,
    perMessageDeflate: false
  });
  return new Promise<string>((resolve, reject) => {
    const fail = (message: string) => {
      cleanup();
      socket.once("error", () => undefined);
      socket.terminate();
      reject(new Error(message));
    };
    const timeout = setTimeout(
      () => fail("PDS relay request timed out."),
      31 * 60_000
    );
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      socket.off("open", opened);
      socket.off("message", received);
      socket.off("error", errored);
      socket.off("close", closed);
    };
    const opened = () => {
      socket.send(frame, (error) => {
        if (error) fail("PDS relay request could not be sent.");
      });
    };
    const received = (data: WebSocket.RawData) => {
      const response = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : data.toString();
      cleanup();
      socket.close();
      resolve(response);
    };
    const errored = () => fail("PDS relay is unavailable.");
    const closed = () => fail("PDS relay disconnected.");
    const abort = () => fail("PDS relay request was cancelled.");
    socket.once("open", opened);
    socket.once("message", received);
    socket.once("error", errored);
    socket.once("close", closed);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
};

export const createPdsPaseoRelayFetch = (
  pdsRelayUrl: string,
  configuredRelayUrl: string | undefined
): typeof fetch | undefined => {
  const route = paseoRoute(pdsRelayUrl, configuredRelayUrl);
  if (!route) return undefined;
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const requestUrl = new URL(
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : input.url
    );
    const basePath = route.baseUrl.slice(new URL(route.baseUrl).origin.length);
    const target = `${requestUrl.pathname.slice(basePath.length)}${requestUrl.search}`;
    if (
      requestUrl.origin !== new URL(route.baseUrl).origin ||
      !requestUrl.pathname.startsWith(`${basePath}${PDS_RELAY_PREFIX}`) ||
      target.length > 4_096
    ) {
      throw new Error("PDS relay request escaped its Paseo capability.");
    }
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method !== "GET" && method !== "POST" && method !== "PUT")
      throw new Error("PDS relay method is invalid.");
    const body =
      init?.body === undefined || init.body === null
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : Buffer.isBuffer(init.body)
            ? init.body.toString("utf8")
            : init.body instanceof Uint8Array
              ? Buffer.from(init.body).toString("utf8")
              : (() => {
                  throw new Error("PDS relay body is invalid.");
                })();
    const headers = new Headers(init?.headers);
    const tunnelHeaders: Record<string, string> = {};
    for (const name of [
      "accept",
      "content-type",
      "x-pds-membership-certificate",
      "x-pds-relay-proof"
    ]) {
      const value = headers.get(name);
      if (value !== null) tunnelHeaders[name] = value;
    }
    const requestId = randomUUID();
    const frame = JSON.stringify({
      protocol: "koed/pds-http-tunnel/v1",
      request_id: requestId,
      method,
      path: target,
      headers: tunnelHeaders,
      ...(body === undefined ? {} : { body })
    });
    if (Buffer.byteLength(frame) > MAX_TUNNEL_BYTES)
      throw new Error("PDS relay request exceeds maximum size.");
    const raw = await exchangePaseoFrame(
      route,
      frame,
      init?.signal ?? undefined
    );
    if (Buffer.byteLength(raw) > MAX_TUNNEL_BYTES)
      throw new Error("PDS relay response exceeds maximum size.");
    const response = JSON.parse(raw) as Record<string, unknown>;
    if (
      Object.keys(response).sort().join(",") !==
        ["body", "headers", "protocol", "request_id", "status"]
          .sort()
          .join(",") ||
      response.protocol !== "koed/pds-http-tunnel/v1" ||
      response.request_id !== requestId ||
      typeof response.status !== "number" ||
      !Number.isInteger(response.status) ||
      response.status < 100 ||
      response.status > 599 ||
      typeof response.body !== "string" ||
      !response.headers ||
      typeof response.headers !== "object" ||
      Array.isArray(response.headers)
    ) {
      throw new Error("PDS relay response is invalid.");
    }
    const responseHeaders = new Headers();
    const contentType = (response.headers as Record<string, unknown>)[
      "content-type"
    ];
    if (typeof contentType === "string")
      responseHeaders.set("content-type", contentType);
    return new Response(
      response.status === 204 || response.status === 304 ? null : response.body,
      { status: response.status, headers: responseHeaders }
    );
  }) as typeof fetch;
};
