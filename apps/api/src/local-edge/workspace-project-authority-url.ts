import { assertSecureHttpTransport } from "@koed/shared";
import { safeUpstreamProxyUrl } from "./upstream-routing.js";

/** Server-owned principal checks need this exact read-only status route.
 * Keep it separate from the caller-selected upstream proxy allowlist. */
export const workspaceProjectAuthorityUrl = (
  backend: Parameters<typeof safeUpstreamProxyUrl>[0],
  path: string
): URL => {
  if (path !== "/v1/local-edge/device-credentials/status")
    return safeUpstreamProxyUrl(backend, path);
  const base = new URL(`${backend.baseUrl.replace(/\/+$/, "")}/`);
  assertSecureHttpTransport(base, "Team authority URL");
  if (base.username || base.password || base.search || base.hash)
    throw Object.assign(new Error("Unsafe Team authority URL"), {
      statusCode: 400
    });
  return new URL("v1/local-edge/device-credentials/status", base);
};
