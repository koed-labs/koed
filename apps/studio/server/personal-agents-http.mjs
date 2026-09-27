const prefix = "/studio-api/personal-agents";
const uuid =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const detail = new RegExp(`^/(${uuid})(/retire)?$`);
const maximum = 256 * 1024;

export async function handlePersonalAgents({
  request,
  url,
  validCsrf,
  resolveToken,
  apiBase,
  fetchImpl,
  send,
  routeFamily = "personal-agents"
}) {
  const routePrefix =
    routeFamily === "managed-conversations"
      ? "/studio-api/managed-conversations"
      : routeFamily === "personal-agent-role-templates"
        ? "/studio-api/personal-agent-role-templates"
        : prefix;
  if (
    url.pathname !== routePrefix &&
    !url.pathname.startsWith(`${routePrefix}/`)
  )
    return false;
  const suffix = url.pathname.slice(routePrefix.length);
  const match = detail.exec(suffix);
  const methods =
    routeFamily === "personal-agent-role-templates"
      ? suffix === ""
        ? ["GET"]
        : []
      : routeFamily === "managed-conversations"
        ? managedMethods(suffix)
        : suffix === ""
          ? ["GET", "POST"]
          : suffix === "/capabilities"
            ? ["GET"]
            : match
              ? match[2]
                ? ["POST"]
                : ["GET", "PATCH"]
              : [];
  if (!methods.length) {
    send(404, { error: "not_found" });
    return true;
  }
  if (!methods.includes(request.method)) {
    send(405, { error: "method_not_allowed" });
    return true;
  }
  if (url.search) {
    send(400, { error: "query_not_allowed" });
    return true;
  }
  try {
    const base = new URL(apiBase);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
      base.username ||
      base.password
    ) {
      send(503, { error: "invalid_local_api_base" });
      return true;
    }
    let body;
    if (request.method !== "GET") {
      if (!validCsrf(request)) {
        send(403, { error: "forbidden" });
        return true;
      }
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
        if (size > maximum) {
          send(413, { error: "body_too_large" });
          return true;
        }
        chunks.push(chunk);
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
    const token = await resolveToken();
    if (!token) {
      send(401, { error: "Koed authorization is unavailable." });
      return true;
    }
    const upstream = await fetchImpl(
      new URL(`/v1/${routeFamily}${suffix}`, base),
      {
        method: request.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {})
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(15000)
      }
    );
    if (!upstream.ok) {
      await upstream.body?.cancel?.();
      const status = [400, 401, 403, 404, 409, 422, 429].includes(
        upstream.status
      )
        ? upstream.status
        : 503;
      send(status, {
        error:
          status === 409
            ? "The request conflicts with the current state. Refresh and check agent, model, and runtime availability before trying again."
            : status === 429
              ? "Koed is receiving too many requests. Wait a minute, then try again. Your changes have not been confirmed."
              : status === 503
                ? "The runtime service is unavailable. Check the configured local or remote connection before retrying."
                : "The request could not be completed."
      });
      return true;
    }
    const reader = upstream.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("response_too_large");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    send(upstream.status, JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    send(503, {
      error:
        "Agents are unavailable. Check the local Koed connection and try again."
    });
  }
  return true;
}

function managedMethods(suffix) {
  if (suffix === "") return ["GET", "POST"];
  if (suffix === "/access" || suffix === "/launch-options") return ["GET"];
  if (new RegExp(`^/${uuid}/project-moves$`).test(suffix)) return ["POST"];
  if (new RegExp(`^/${uuid}/project-moves/latest$`).test(suffix)) return ["GET"];
  if (new RegExp(`^/${uuid}/project-moves/${uuid}/cancel$`).test(suffix))
    return ["POST"];
  if (new RegExp(`^/${uuid}(?:/runtime|/agent-state)?$`).test(suffix))
    return ["GET"];
  if (new RegExp(`^/${uuid}/(?:prompts|interrupt|stop)$`).test(suffix))
    return ["POST"];
  if (new RegExp(`^/${uuid}/runtime-items/${uuid}/respond$`).test(suffix))
    return ["POST"];
  return [];
}

export function handleManagedConversations(options) {
  return handlePersonalAgents({
    ...options,
    routeFamily: "managed-conversations"
  });
}

export function handlePersonalAgentRoleTemplates(options) {
  return handlePersonalAgents({
    ...options,
    routeFamily: "personal-agent-role-templates"
  });
}
