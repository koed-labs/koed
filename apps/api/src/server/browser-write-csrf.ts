import type { FastifyInstance, FastifyRequest } from "fastify";

import { sessionCookieName } from "../auth/index.js";

const browserWriteMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const sessionEstablishingWritePaths = new Set([
  "/auth/setup",
  "/auth/register",
  "/auth/login"
]);

const highRiskBrowserWriteFamilies = [
  "/v1/high-risk/browser-activations",
  "/v1/shared-memory",
  "/v1/retention",
  "/v1/teams",
  "/v1/team-workspaces",
  "/v1/team-invites"
] as const;

const allowedFetchSites = new Set(["same-origin", "same-site", "none"]);

const normalizeOrigin = (value: string): string => value.replace(/\/+$/, "");

type HeaderEvidence =
  | { present: false }
  | { present: true; valid: false }
  | { present: true; valid: true; value: string };

const singleHeaderEvidence = (
  value: string | string[] | undefined
): HeaderEvidence => {
  if (value === undefined) return { present: false };
  if (Array.isArray(value)) {
    if (value.length !== 1) return { present: true, valid: false };
    value = value[0];
  }
  const trimmed = value?.trim();
  return trimmed
    ? { present: true, valid: true, value: trimmed }
    : { present: true, valid: false };
};

const parseOrigin = (origin: string): string | null => {
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.origin === "null" ||
      parsed.origin !== origin
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
};

const originFromReferer = (referer: string): string | null => {
  try {
    const parsed = new URL(referer);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.origin === "null"
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
};

const requestPathname = (request: FastifyRequest): string => {
  try {
    return new URL(request.url, "http://koed.local").pathname;
  } catch {
    return request.url.split("?")[0] ?? request.url;
  }
};

const matchesRouteFamily = (pathname: string, family: string): boolean =>
  pathname === family || pathname.startsWith(`${family}/`);

export const isHighRiskBrowserWrite = (
  method: string,
  pathname: string
): boolean =>
  browserWriteMethods.has(method.toUpperCase()) &&
  highRiskBrowserWriteFamilies.some((family) =>
    matchesRouteFamily(pathname, family)
  );

const forbidden = (message: string): Error & { statusCode: number } =>
  Object.assign(new Error(message), { statusCode: 403 });

export const registerBrowserWriteCsrfProtection = (
  app: FastifyInstance,
  corsOrigins: ReadonlySet<string>
): void => {
  app.addHook("preHandler", (request, _reply, done) => {
    if (!browserWriteMethods.has(request.method)) {
      done();
      return;
    }

    const pathname = requestPathname(request);
    const hasSessionCookie = Boolean(request.cookies[sessionCookieName]);
    const createsSessionCookie = sessionEstablishingWritePaths.has(pathname);
    if (!hasSessionCookie && !createsSessionCookie) {
      done();
      return;
    }

    const originHeader = singleHeaderEvidence(request.headers.origin);
    const refererHeader = singleHeaderEvidence(request.headers.referer);
    const fetchSiteHeader = singleHeaderEvidence(
      request.headers["sec-fetch-site"]
    );

    if (
      (fetchSiteHeader.present && !fetchSiteHeader.valid) ||
      (fetchSiteHeader.present &&
        fetchSiteHeader.valid &&
        !allowedFetchSites.has(fetchSiteHeader.value))
    ) {
      done(forbidden("Cross-site browser write is not allowed"));
      return;
    }

    const highRiskWrite =
      hasSessionCookie && isHighRiskBrowserWrite(request.method, pathname);
    if (
      highRiskWrite &&
      fetchSiteHeader.present &&
      fetchSiteHeader.valid &&
      fetchSiteHeader.value !== "same-origin"
    ) {
      done(forbidden("High-risk browser writes must be same-origin"));
      return;
    }

    if (originHeader.present && !originHeader.valid) {
      done(forbidden("Invalid request origin"));
      return;
    }
    if (refererHeader.present && !refererHeader.valid) {
      done(forbidden("Invalid request Referer"));
      return;
    }

    const origin =
      originHeader.present && originHeader.valid
        ? parseOrigin(originHeader.value)
        : null;
    const refererOrigin =
      refererHeader.present && refererHeader.valid
        ? originFromReferer(refererHeader.value)
        : null;

    if (originHeader.present && !origin) {
      done(forbidden("Invalid request origin"));
      return;
    }
    if (refererHeader.present && !refererOrigin) {
      done(forbidden("Invalid request Referer"));
      return;
    }

    if (hasSessionCookie && !origin && !refererOrigin) {
      done(forbidden("Request origin is required"));
      return;
    }

    if (origin && !corsOrigins.has(normalizeOrigin(origin))) {
      done(forbidden("Invalid request origin"));
      return;
    }
    if (refererOrigin && !corsOrigins.has(normalizeOrigin(refererOrigin))) {
      done(forbidden("Invalid request Referer"));
      return;
    }
    if (origin && refererOrigin && origin !== refererOrigin) {
      done(forbidden("Origin and Referer do not match"));
      return;
    }

    done();
  });
};
