import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

export const apiLogSchemaVersion = "api_log_v1";
export const apiServiceName = "koed-api";

export type AuthLogKind =
  | "anonymous"
  | "api_token"
  | "session"
  | "device_credential";

export interface RequestLogContext {
  auth?: {
    kind: AuthLogKind;
  };
  actor?: {
    user_id: string;
  };
}

const requestLogContext = new WeakMap<FastifyRequest, RequestLogContext>();

const requestIdPattern = /^[A-Za-z0-9._~:-]{1,128}$/;

const firstHeaderValue = (
  value: string | string[] | undefined
): string | undefined => (Array.isArray(value) ? value[0] : value);

export const resolveRequestId = (value: unknown): string => {
  const candidate =
    typeof value === "string" && requestIdPattern.test(value) ? value : null;
  return candidate ?? randomUUID();
};

const parsePath = (
  url: string | undefined
): {
  path?: string;
  query_keys?: string[];
} => {
  if (!url) {
    return {};
  }

  try {
    const parsed = new URL(url, "http://koed.local");
    const queryKeys = [...new Set([...parsed.searchParams.keys()])].sort();
    return {
      path: parsed.pathname,
      ...(queryKeys.length > 0 ? { query_keys: queryKeys } : {})
    };
  } catch {
    return { path: url.split("?")[0] ?? url };
  }
};

const sensitiveIdentifierRoutes = [
  "/high-risk/browser-activations/:selector",
  "/device-enrollment/:challengeId",
  "/v1/high-risk/browser-activations/:selector",
  "/v1/high-risk/browser-activations/:selector/decision",
  "/v1/local-edge/device-enrollments/challenges/:challengeId",
  "/v1/local-edge/device-enrollments/challenges/:challengeId/approval"
] as const;

export const redactSensitiveRoutePath = (
  path: string | undefined,
  route: string | undefined
): string | undefined =>
  route && sensitiveIdentifierRoutes.includes(route as never) ? route : path;

const getString = (
  value: Record<string, unknown>,
  key: string
): string | undefined => {
  const current = value[key];
  return typeof current === "string" ? current : undefined;
};

const getNumber = (
  value: Record<string, unknown>,
  key: string
): number | undefined => {
  const current = value[key];
  return typeof current === "number" ? current : undefined;
};

const getRecord = (
  value: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined => {
  const current = value[key];
  return typeof current === "object" && current !== null
    ? (current as Record<string, unknown>)
    : undefined;
};

const safeLogString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return undefined;
};

const parseTraceparent = (
  traceparent: string | undefined
): { trace_id: string; span_id: string } | undefined => {
  const match = traceparent?.match(
    /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i
  );
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return { trace_id: match[1].toLowerCase(), span_id: match[2].toLowerCase() };
};

export const serializeApiRequest = (request: unknown) => {
  if (typeof request !== "object" || request === null) {
    return {};
  }

  const record = request as Record<string, unknown>;
  const raw = getRecord(record, "raw");
  const headers =
    (getRecord(record, "headers") as
      | Record<string, string | string[] | undefined>
      | undefined) ??
    (raw
      ? (getRecord(raw, "headers") as
          | Record<string, string | string[] | undefined>
          | undefined)
      : undefined);
  const routeOptions = getRecord(record, "routeOptions");
  const url =
    getString(record, "url") ?? (raw ? getString(raw, "url") : undefined);
  const route =
    (routeOptions ? getString(routeOptions, "url") : undefined) ??
    getString(record, "routerPath");
  const trace = parseTraceparent(firstHeaderValue(headers?.traceparent));

  const parsedPath = parsePath(url);
  const safePath = redactSensitiveRoutePath(parsedPath.path, route);
  const pdsRelay =
    route?.startsWith("/v1/personal-device-sync/relay/") ||
    parsedPath.path?.startsWith("/v1/personal-device-sync/relay/");
  return {
    id: safeLogString(record.id) ?? "",
    method: getString(record, "method"),
    ...(pdsRelay
      ? {
          path: route ?? "/v1/personal-device-sync/relay",
          category: "pds_relay"
        }
      : {
          ...(safePath ? { path: safePath } : {}),
          ...(parsedPath.query_keys
            ? { query_keys: parsedPath.query_keys }
            : {})
        }),
    ...(route ? { route } : {}),
    ...(trace ? { trace } : {})
  };
};

export const serializeApiClient = (request: unknown) => {
  if (typeof request !== "object" || request === null) {
    return {};
  }

  const record = request as Record<string, unknown>;
  const raw = getRecord(record, "raw");
  const socket = raw ? getRecord(raw, "socket") : undefined;
  return socket
    ? {
        ...(getString(socket, "remoteAddress")
          ? { ip: getString(socket, "remoteAddress") }
          : {}),
        ...(getNumber(socket, "remotePort")
          ? { port: getNumber(socket, "remotePort") }
          : {})
      }
    : {};
};

export const serializeApiResponse = (response: unknown) => {
  if (typeof response !== "object" || response === null) {
    return {};
  }

  const record = response as Record<string, unknown>;
  const statusCode = getNumber(record, "statusCode");
  return {
    ...(statusCode ? { status_code: statusCode } : {})
  };
};

export const formatApiLogBindings = (bindings: Record<string, unknown>) => {
  const { req, res, responseTime, ...rest } = bindings;
  const client = serializeApiClient(req);
  const durationMs =
    typeof responseTime === "number" ? Math.round(responseTime) : undefined;
  const http = {
    ...(getRecord(rest, "http") ?? {}),
    ...(durationMs === undefined ? {} : { duration_ms: durationMs })
  };
  return {
    ...rest,
    ...(req ? { request: serializeApiRequest(req) } : {}),
    ...(Object.keys(client).length > 0 ? { client } : {}),
    ...(Object.keys(http).length > 0 ? { http } : {}),
    ...(res ? { response: serializeApiResponse(res) } : {})
  };
};

export const setRequestLogContext = (
  request: FastifyRequest,
  context: RequestLogContext
): void => {
  const current = requestLogContext.get(request) ?? {};
  requestLogContext.set(request, {
    ...current,
    ...context,
    auth: context.auth ?? current.auth,
    actor: context.actor ?? current.actor
  });
};

export const getRequestLogContext = (
  request: FastifyRequest
): RequestLogContext => requestLogContext.get(request) ?? {};

export const authenticatedRequestLogContext = (
  kind: Exclude<AuthLogKind, "anonymous">,
  userId: string
): RequestLogContext => ({
  auth: { kind },
  actor: { user_id: userId }
});

export const sanitizeZodIssues = (error: z.ZodError) =>
  error.issues.map((issue) => ({
    code: issue.code,
    path: issue.path.map(String)
  }));
