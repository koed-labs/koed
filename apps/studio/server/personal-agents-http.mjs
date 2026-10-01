const prefix = "/studio-api/personal-agents";
const uuid =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const detail = new RegExp(`^/(${uuid})(/(?:retire|restore))?$`);
const history = new RegExp(`^/(${uuid})/jobs$`);
const maximum = 256 * 1024;

function validPersonalAgentActivityQuery(searchParams) {
  const ids = searchParams.getAll("agentId");
  return (
    [...searchParams.keys()].every((key) => key === "agentId") &&
    ids.length >= 1 &&
    ids.length <= 100 &&
    new Set(ids).size === ids.length &&
    ids.every((id) => new RegExp(`^${uuid}$`, "i").test(id))
  );
}

function validPersonalAgentHistoryQuery(searchParams) {
  const limits = searchParams.getAll("limit");
  const cursors = searchParams.getAll("before");
  return (
    [...searchParams.keys()].every(
      (key) => key === "limit" || key === "before"
    ) &&
    limits.length <= 1 &&
    cursors.length <= 1 &&
    (!limits.length || /^(?:[1-9]|1[0-9]|20)$/.test(limits[0])) &&
    (!cursors.length || /^[A-Za-z0-9_-]{1,256}$/.test(cursors[0]))
  );
}

async function boundedConflictCode(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return payload?.code === "name_conflict" ? "name_conflict" : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function handlePersonalAgents({
  request,
  url,
  validCsrf,
  resolveToken,
  resolveAccess,
  apiBase,
  fetchImpl,
  send,
  routeFamily = "personal-agents"
}) {
  const routePrefix =
    routeFamily === "public-square"
      ? "/studio-api/public-square"
      : routeFamily === "managed-conversations"
        ? "/studio-api/managed-conversations"
        : routeFamily === "team-agent-requests"
          ? "/studio-api/collaboration"
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
  const historyMatch = history.exec(suffix);
  const activityRoute =
    routeFamily === "personal-agents" && suffix === "/activity";
  const squareRoute =
    routeFamily === "public-square" ? publicSquareRoute(suffix) : null;
  const teamAgentRequestRoute =
    routeFamily === "team-agent-requests"
      ? teamAgentRequestsRoute(suffix)
      : null;
  const methods =
    routeFamily === "team-agent-requests"
      ? (teamAgentRequestRoute?.methods ?? [])
      : routeFamily === "public-square"
        ? (squareRoute?.methods ?? [])
        : routeFamily === "personal-agent-role-templates"
          ? suffix === ""
            ? ["GET"]
            : []
          : routeFamily === "managed-conversations"
            ? managedMethods(suffix)
            : suffix === ""
              ? ["GET", "POST"]
              : activityRoute || historyMatch
                ? ["GET"]
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
  const teamAgentRequestList =
    routeFamily === "team-agent-requests" &&
    request.method === "GET" &&
    Boolean(teamAgentRequestRoute?.list);
  const recoveryLookup =
    routeFamily === "managed-conversations" && suffix === "/recovery/lookup";
  const squareList =
    routeFamily === "public-square" && squareRoute?.list === true;
  if (
    url.search &&
    !recoveryLookup &&
    !squareList &&
    !teamAgentRequestList &&
    !activityRoute &&
    !historyMatch
  ) {
    send(400, { error: "query_not_allowed" });
    return true;
  }
  if (recoveryLookup && !validRecoveryLookupQuery(url.searchParams)) {
    send(400, { error: "invalid_recovery_lookup" });
    return true;
  }
  if (squareList && !validPublicSquareQuery(url.searchParams)) {
    send(400, { error: "invalid_public_square_query" });
    return true;
  }
  if (
    teamAgentRequestList &&
    !validTeamAgentRequestQuery(
      url.searchParams,
      teamAgentRequestRoute?.list === "inbox"
    )
  ) {
    send(400, { error: "invalid_team_agent_request_query" });
    return true;
  }
  if (activityRoute && !validPersonalAgentActivityQuery(url.searchParams)) {
    send(400, { error: "invalid_activity_query" });
    return true;
  }
  if (historyMatch && !validPersonalAgentHistoryQuery(url.searchParams)) {
    send(400, { error: "invalid_history_query" });
    return true;
  }
  try {
    let base;
    if (typeof resolveAccess !== "function") {
      base = validLocalApiBase(apiBase);
      if (!base) {
        send(503, { error: "invalid_local_api_base" });
        return true;
      }
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
    let token;
    if (typeof resolveAccess === "function") {
      let access;
      try {
        access = await resolveAccess();
      } catch {
        send(503, { error: "Koed is unavailable right now." });
        return true;
      }
      base = validLocalApiBase(access?.apiOrigin, { requireOrigin: true });
      if (!base || typeof access?.apiToken !== "string" || !access.apiToken) {
        send(503, { error: "invalid_local_api_access" });
        return true;
      }
      token = access.apiToken;
    } else {
      token = await resolveToken();
      if (!token) {
        send(401, { error: "Koed authorization is unavailable." });
        return true;
      }
    }
    const upstream = await fetchImpl(
      new URL(
        teamAgentRequestRoute
          ? `${teamAgentRequestRoute.path}${teamAgentRequestList ? url.search : ""}`
          : squareRoute
            ? `${squareRoute.path}${squareList ? url.search : ""}`
            : `/v1/${routeFamily}${suffix}${recoveryLookup || activityRoute || historyMatch ? url.search : ""}`,
        base
      ),
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
      let memoryRecallError = null;
      if (
        routeFamily === "managed-conversations" &&
        upstream.status === 503 &&
        upstream.body
      ) {
        try {
          const reader = upstream.body.getReader();
          const chunks = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4096) {
              await reader.cancel();
              break;
            }
            chunks.push(Buffer.from(value));
          }
          reader.releaseLock();
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (
            payload?.error?.code === "MEMORY_RECALL_UNAVAILABLE" &&
            typeof payload?.error?.message === "string"
          ) {
            memoryRecallError = {
              error: {
                code: "MEMORY_RECALL_UNAVAILABLE",
                message:
                  "Memory could not be checked. Retry or continue without Memory."
              }
            };
          }
        } catch {
          memoryRecallError = null;
        }
      }
      const conflictCode =
        routeFamily === "personal-agents" && upstream.status === 409
          ? await boundedConflictCode(upstream)
          : null;
      if (conflictCode === null && memoryRecallError === null)
        await upstream.body?.cancel?.();
      const status = [400, 401, 403, 404, 409, 422, 429].includes(
        upstream.status
      )
        ? upstream.status
        : 503;
      send(
        status,
        memoryRecallError ?? {
          error:
            conflictCode === "name_conflict"
              ? "An Agent with this name or a previous name already exists. Choose another name."
              : status === 409
                ? "The request conflicts with the current state. Refresh and check agent, model, and runtime availability before trying again."
                : status === 429
                  ? "Koed is receiving too many requests. Wait a minute, then try again. Your changes have not been confirmed."
                  : status === 503
                    ? "The runtime service is unavailable. Check the configured local or remote connection before retrying."
                    : "The request could not be completed.",
          ...(conflictCode ? { code: conflictCode } : {})
        }
      );
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
        const maximumResponseBytes = historyMatch
          ? 8 * 1024 * 1024
          : activityRoute
            ? 1024 * 1024
            : 4 * 1024 * 1024;
        if (size > maximumResponseBytes) {
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
        routeFamily === "public-square"
          ? "Public Square is unavailable. Check the Koed connection and try again."
          : routeFamily === "team-agent-requests"
            ? "Team Agent requests are unavailable. Check the Koed connection and try again."
            : "Agents are unavailable. Check the local Koed connection and try again."
    });
  }
  return true;
}

function validLocalApiBase(value, { requireOrigin = false } = {}) {
  try {
    const base = new URL(value);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
      base.username ||
      base.password ||
      (requireOrigin && (base.pathname !== "/" || base.search || base.hash))
    ) {
      return null;
    }
    return requireOrigin ? new URL(base.origin) : base;
  } catch {
    return null;
  }
}

function managedMethods(suffix) {
  if (suffix === "") return ["GET", "POST"];
  if (suffix === "/recovery/lookup") return ["GET"];
  if (suffix === "/access" || suffix === "/launch-options") return ["GET"];
  if (
    new RegExp(
      `^/${uuid}/recall-feedback/(?:provider|agent)(?::|%3a)${uuid}$`,
      "i"
    ).test(suffix)
  )
    return ["GET", "PUT"];
  if (new RegExp(`^/${uuid}/project-moves$`).test(suffix)) return ["POST"];
  if (new RegExp(`^/${uuid}/project-moves/latest$`).test(suffix))
    return ["GET"];
  if (new RegExp(`^/${uuid}/project-moves/${uuid}/cancel$`).test(suffix))
    return ["POST"];
  if (new RegExp(`^/${uuid}(?:/runtime|/agent-state)?$`).test(suffix))
    return ["GET"];
  if (new RegExp(`^/${uuid}/prompts/${uuid}/cancel$`).test(suffix))
    return ["POST"];
  if (new RegExp(`^/${uuid}/(?:prompts|interrupt|stop)$`).test(suffix))
    return ["POST"];
  if (new RegExp(`^/${uuid}/runtime-items/${uuid}/respond$`).test(suffix))
    return ["POST"];
  return [];
}

function validRecoveryLookupQuery(params) {
  const kind = params.get("kind");
  const keys = [...params.keys()];
  if (kind === "start") {
    return (
      keys.length === 2 &&
      keys.includes("idempotencyKey") &&
      validIdempotencyKey(params.get("idempotencyKey"))
    );
  }
  if (kind === "prompt") {
    const expected = [
      "kind",
      "idempotencyKey",
      "clientUserMessageId",
      "executionId",
      "executionGeneration"
    ];
    return (
      keys.length === expected.length &&
      expected.every((key) => keys.includes(key)) &&
      validIdempotencyKey(params.get("idempotencyKey")) &&
      validUuid(params.get("clientUserMessageId")) &&
      validUuid(params.get("executionId")) &&
      /^[1-9][0-9]*$/.test(params.get("executionGeneration") ?? "")
    );
  }
  return false;
}

function validUuid(value) {
  return typeof value === "string" && new RegExp(`^${uuid}$`).test(value);
}

function validIdempotencyKey(value) {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
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

export function handlePublicSquare(options) {
  return handlePersonalAgents({ ...options, routeFamily: "public-square" });
}

export function handleTeamAgentRequests(options) {
  return handlePersonalAgents({
    ...options,
    routeFamily: "team-agent-requests"
  });
}

function teamAgentRequestsRoute(suffix) {
  const team = new RegExp(
    `^/teams/(${uuid})(/agent-offers(?:/${uuid})?|/agent-requests(?:/inbox|/${uuid}(?:/review|/decision|/outcome))?)$`
  ).exec(suffix);
  if (!team) return null;
  const tail = team[2];
  const path = `/v1/collaboration/teams/${team[1]}${tail}`;
  if (tail === "/agent-offers") return { path, methods: ["GET"] };
  if (new RegExp(`^/agent-offers/${uuid}$`).test(tail))
    return { path, methods: ["PUT"] };
  if (tail === "/agent-requests")
    return { path, methods: ["GET", "POST"], list: "requests" };
  if (tail === "/agent-requests/inbox")
    return { path, methods: ["GET"], list: "inbox" };
  if (new RegExp(`^/agent-requests/${uuid}/review$`).test(tail))
    return { path, methods: ["GET", "PUT"] };
  if (new RegExp(`^/agent-requests/${uuid}/decision$`).test(tail))
    return { path, methods: ["PUT"] };
  if (new RegExp(`^/agent-requests/${uuid}/outcome$`).test(tail))
    return { path, methods: ["POST"] };
  if (new RegExp(`^/agent-requests/${uuid}$`).test(tail))
    return { path, methods: ["DELETE"] };
  return null;
}

function validTeamAgentRequestQuery(params, inbox = false) {
  const allowed = inbox
    ? new Set(["limit", "cursor"])
    : new Set(["teamProjectId", "channelId", "status", "limit", "cursor"]);
  const keys = [...params.keys()];
  if (
    keys.length !== new Set(keys).size ||
    keys.some((key) => !allowed.has(key))
  )
    return false;
  for (const key of ["teamProjectId", "channelId"]) {
    const value = params.get(key);
    if (value !== null && !validUuid(value)) return false;
  }
  const status = params.get("status");
  if (
    status !== null &&
    ![
      "awaiting_owner",
      "accepted",
      "declined",
      "withdrawn",
      "unavailable"
    ].includes(status)
  )
    return false;
  const limit = params.get("limit");
  if (limit !== null && (!/^[1-9][0-9]*$/.test(limit) || Number(limit) > 100))
    return false;
  const cursor = params.get("cursor");
  return (
    cursor === null ||
    (cursor.length > 0 &&
      cursor.length <= 512 &&
      !/[\u0000-\u001f\u007f]/.test(cursor))
  );
}

function publicSquareRoute(suffix) {
  const team = new RegExp(`^/teams/(${uuid})(.*)$`).exec(suffix);
  if (!team) return null;
  const tail = team[2];
  const path = `/v1/collaboration/teams/${team[1]}/public-square${tail}`;
  if (tail === "") return { path, methods: ["GET"], list: true };
  if (new RegExp(`^/projects/${uuid}/connection$`).test(tail))
    return { path, methods: ["GET", "PUT"] };
  if (new RegExp(`^/projects/${uuid}/unshare$`).test(tail))
    return { path, methods: ["POST"] };
  if (new RegExp(`^/${uuid}/brief-draft$`).test(tail))
    return { path, methods: ["GET"] };
  if (new RegExp(`^/${uuid}/brief$`).test(tail))
    return { path, methods: ["PUT"] };
  return null;
}

function validPublicSquareQuery(params) {
  const keys = [...params.keys()];
  if (
    keys.length !== new Set(keys).size ||
    keys.some((key) => !["limit", "cursor"].includes(key))
  )
    return false;
  const limit = params.get("limit");
  if (limit !== null && (!/^[1-9][0-9]*$/.test(limit) || Number(limit) > 100))
    return false;
  const cursor = params.get("cursor");
  return (
    cursor === null ||
    (cursor.length > 0 &&
      cursor.length <= 512 &&
      !/[\u0000-\u001f\u007f]/.test(cursor))
  );
}
