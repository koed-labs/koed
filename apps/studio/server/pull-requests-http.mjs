import { readDesktopLocalCredentialAuthorization } from "@koed/shared";
import { resolveKoedServerPaths } from "@koed/koed-server";

const uuid =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const prefix = "/studio-api/pull-requests";
const maximumBytes = 1024 * 1024;
function routeMethods(suffix) {
  if (suffix === "/runners") return ["GET"];
  if (
    suffix === "/action-grants" ||
    new RegExp(`^/action-grants/${uuid}$`).test(suffix)
  )
    return ["POST"];
  if (suffix === "" || suffix === "/operations") return ["GET", "POST"];
  if (new RegExp(`^/(?:operations/)?${uuid}$`).test(suffix)) return ["GET"];
  if (new RegExp(`^/${uuid}/(?:freezes/${uuid}|draft/frozen)$`).test(suffix))
    return ["GET"];
  if (new RegExp(`^/operations/${uuid}/cancel$`).test(suffix)) return ["POST"];
  if (new RegExp(`^/${uuid}/(?:reviews/draft|draft)$`).test(suffix))
    return ["GET", "PUT"];
  if (
    new RegExp(`^/${uuid}/(?:draft/freeze|enable-fixes|refresh)$`).test(suffix)
  )
    return ["POST"];
  return [];
}
export async function handlePullRequests({
  request,
  url,
  validCsrf,
  resolveAccess,
  apiBase,
  fetchImpl,
  send,
  environment = process.env,
  resolveCredential = readDesktopLocalCredentialAuthorization
}) {
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
    return false;
  const suffix = url.pathname.slice(prefix.length);
  const methods = routeMethods(suffix);
  if (!methods.length) {
    send(404, { error: "not_found" });
    return true;
  }
  if (!methods.includes(request.method)) {
    send(405, { error: "method_not_allowed" });
    return true;
  }
  if (request.method !== "GET" && !validCsrf(request)) {
    send(403, { error: "forbidden" });
    return true;
  }
  if (
    [...url.searchParams.keys()].some(
      (key) =>
        ![
          "repository",
          "number",
          "agentId",
          "limit",
          "before",
          "cursor",
          "executionId"
        ].includes(key)
    )
  ) {
    send(400, { error: "invalid_query" });
    return true;
  }
  try {
    const access = resolveAccess
      ? await resolveAccess()
      : { apiOrigin: apiBase };
    const base = new URL(access.apiOrigin);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash
    )
      throw new Error("invalid_local_api_base");
    const credential = resolveCredential(
      resolveKoedServerPaths(environment).koedHome
    );
    if (
      !credential?.authorization ||
      !credential.operationFamilies?.includes("managed_source_control")
    ) {
      send(503, {
        error: "GitHub access requires an authorized Studio Desktop connection."
      });
      return true;
    }
    let body;
    if (request.method !== "GET") {
      if (
        request.headers["content-type"]?.split(";")[0] !== "application/json"
      ) {
        send(415, { error: "unsupported_media_type" });
        return true;
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maximumBytes) {
          send(413, { error: "body_too_large" });
          return true;
        }
        chunks.push(Buffer.from(chunk));
      }
      try {
        body = JSON.stringify(
          JSON.parse(Buffer.concat(chunks).toString("utf8"))
        );
      } catch {
        send(400, { error: "invalid_json" });
        return true;
      }
    }
    const upstream = await fetchImpl(
      new URL(`/v1/pull-requests${suffix}${url.search}`, base),
      {
        method: request.method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          accept: "application/json",
          authorization: credential.authorization,
          ...(body
            ? {
                "content-type": "application/json",
                "x-koed-desktop-source-control-approval": "1"
              }
            : {})
        },
        body
      }
    );
    const reader = upstream.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader)
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4 * maximumBytes) {
            await reader.cancel();
            throw new Error("response_too_large");
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    send(upstream.status, payload);
  } catch {
    send(503, {
      error:
        "Pull Requests are unavailable. Check your Koed connection and try again."
    });
  }
  return true;
}
