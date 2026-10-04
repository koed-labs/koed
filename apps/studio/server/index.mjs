import { createServer as createHttpServer } from "node:http";
import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import {
  listLocalConversationSources,
  listProjectMetadata,
  resolveKoedServerPaths
} from "@koed/koed-server";
import { RetainedWorkspaceCatalog } from "@koed/koed-server/retained-workspace-catalog";
import { createGitExecutionCheckoutDriver } from "@koed/shared/execution-checkout";
import {
  collaborationCommandResultSchema,
  collaborationRendererCommandSchema,
  collaborationRendererEventSchema,
  collaborationSnapshotSchema
} from "@koed/shared/collaboration";
import { handlePullRequests } from "./pull-requests-http.mjs";
import {
  handleClientResources,
  handleHomeFeed,
  handlePersonalAgents,
  handleManagedConversations,
  handlePersonalAgentRoleTemplates,
  handlePublicSquare,
  handleTeamAgentRequests
} from "./personal-agents-http.mjs";
import { handleRetainedWorkspaces } from "./retained-workspaces-http.mjs";

const DEFAULT_PORT = 43110;
const DEFAULT_API_URL = "http://127.0.0.1:43300";
const DEFAULT_STATIC_DIR = resolve(
  fileURLToPath(new URL("../out", import.meta.url))
);
const MAX_EXECUTIONS = 50;
const MAX_REQUESTS_PER_EXECUTION = 100;
const MAX_TOTAL_REQUESTS = 100;
const MAX_RECENTS = 50;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 16_384;
const MAX_TITLE_LENGTH = 240;
const SCAN_CONCURRENCY = 4;
const UPSTREAM_TIMEOUT_MS = 8_000;
const GITHUB_BODY_MAX_BYTES = 4 * 1024;
const COLLABORATION_ACTION_BODY_MAX_BYTES = 3 * 1024;
const STUDIO_COLLABORATION_COMMAND_BODY_MAX_BYTES = 96 * 1024;
// Editing stores the draft, its base text and a conflicting saved version.
const STUDIO_TEAM_DRAFT_BODY_MAX_BYTES = 1024 * 1024;
const GITHUB_SESSION_TTL_MS = 10 * 60 * 1_000;
const GITHUB_SESSION_MAX = 64;
const PROJECT_SELECTION_TTL_MS = 10 * 60 * 1_000;
const PROJECT_SELECTION_MAX = 64;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const isLoopbackHost = (value) =>
  loopbackHosts.has(String(value ?? "").toLowerCase());
const asText = (value, fallback = "") =>
  typeof value === "string" ? value.slice(0, MAX_TEXT_LENGTH) : fallback;
const asTitle = (value, fallback = "Untitled conversation") => {
  const text = asText(value).trim();
  return text ? text.slice(0, MAX_TITLE_LENGTH) : fallback;
};
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const localApiBase = (value) => {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isLoopbackHost(parsed.hostname) &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
};

const validatePairedLocalApiAccess = (access) => {
  if (
    !access ||
    typeof access.apiToken !== "string" ||
    !access.apiToken ||
    !localApiBase(access.apiOrigin)
  ) {
    throw new Error("invalid_local_api_access");
  }
  const parsedOrigin = new URL(access.apiOrigin);
  if (
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search ||
    parsedOrigin.hash
  ) {
    throw new Error("invalid_local_api_access");
  }
  return { apiOrigin: parsedOrigin.origin, apiToken: access.apiToken };
};

const redactedMessage = (message, fallback) => {
  if (!message || typeof message !== "string") return fallback;
  const clean = message
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return clean.slice(0, 240) || fallback;
};

const readCredential = async ({ environment, readFile = fs.readFile } = {}) => {
  const configured = environment?.STUDIO_API_TOKEN?.trim();
  if (configured) return configured;
  const koedHome =
    environment?.KOED_HOME?.trim() || resolve(homedir(), ".koed");
  const path = resolve(koedHome, "config", "local-app-credential.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed?.apiToken === "string" && parsed.apiToken.trim()
      ? parsed.apiToken.trim()
      : null;
  } catch {
    return null;
  }
};

const parseJsonBody = async (response, maxBytes = MAX_BODY_BYTES) => {
  const contentLength = Number(response.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("upstream_response_too_large");
  }
  if (!response.body?.getReader) {
    if (typeof response.text !== "function") return response.json();
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes)
      throw new Error("upstream_response_too_large");
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("upstream_response_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return JSON.parse(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
  );
};

const requestUrl = (baseUrl, path, query = {}) => {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null)
      url.searchParams.set(key, String(value));
  }
  return url;
};

const isUnauthorized = (status) => status === 401 || status === 403;

const actionableRuntimeKinds = new Set([
  "command_approval",
  "file_approval",
  "permissions_approval",
  "user_input"
]);

const mapApiFailure = (error, status) => ({
  unauthorized: isUnauthorized(status),
  message: isUnauthorized(status)
    ? "Koed authorization is unavailable."
    : redactedMessage(error?.message, "Koed is unavailable right now.")
});

const makeFetch =
  ({
    fetchImpl,
    apiBase,
    token,
    resolveAccess,
    maxBodyBytes = MAX_BODY_BYTES
  }) =>
  async (path, query, signal) => {
    let apiOrigin;
    let apiToken;
    if (typeof resolveAccess === "function") {
      const access = validatePairedLocalApiAccess(await resolveAccess());
      apiOrigin = access.apiOrigin;
      apiToken = access.apiToken;
    } else {
      if (!localApiBase(apiBase)) throw new Error("invalid_local_api_base");
      apiOrigin = apiBase;
      apiToken = token;
    }
    const url = requestUrl(apiOrigin, path, query);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiToken}`
      },
      signal,
      redirect: "error"
    });
    if (!response.ok) {
      try {
        await response.body?.cancel?.();
      } catch {
        // The upstream status remains the useful failure signal.
      }
      const error = new Error(`upstream_status_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return parseJsonBody(response, maxBodyBytes);
  };

const withTimeout = async (operation, timeoutMs = UPSTREAM_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

const executionTitle = (execution, threadBySession) =>
  asTitle(
    threadBySession.get(execution.sessionId)?.title,
    "Untitled conversation"
  );

const executionMap = (execution, threadBySession) => ({
  id: asText(execution?.id),
  sessionId:
    typeof execution?.sessionId === "string" ? execution.sessionId : null,
  projectId:
    typeof execution?.projectId === "string" ? execution.projectId : null,
  title: executionTitle(execution, threadBySession),
  provider: asText(execution?.provider, "unknown"),
  state: asText(execution?.state, "unknown"),
  updatedAt: asText(execution?.updatedAt, asText(execution?.createdAt, "")),
  error:
    typeof execution?.lastErrorCode === "string"
      ? execution.lastErrorCode.slice(0, 160)
      : null
});

const requestTitle = (item) => {
  const presentation = isRecord(item?.presentation) ? item.presentation : {};
  const payload = isRecord(item?.payload) ? item.payload : {};
  return asTitle(
    presentation.title ??
      presentation.label ??
      payload.title ??
      payload.question ??
      payload.prompt,
    item?.itemKind === "user_input" ? "Input requested" : "Approval requested"
  );
};

const requestMap = (item, execution) => ({
  id: asText(item?.id),
  executionId: asText(execution?.id),
  sessionId:
    typeof execution?.sessionId === "string" ? execution.sessionId : null,
  title: requestTitle(item),
  kind: asText(item?.itemKind, "request"),
  updatedAt: asText(item?.updatedAt, asText(item?.createdAt, ""))
});

const compareRuntimeRequests = (left, right) => {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  if (leftValid && rightValid && leftTime !== rightTime)
    return rightTime - leftTime;
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  return (
    left.executionId.localeCompare(right.executionId) ||
    left.id.localeCompare(right.id)
  );
};

const flattenThreads = (payload) => {
  const result = [];
  for (const project of Array.isArray(payload?.projects)
    ? payload.projects
    : []) {
    for (const thread of Array.isArray(project?.threads)
      ? project.threads
      : []) {
      if (
        thread?.threadKind === "subagent" ||
        typeof thread?.sessionId !== "string"
      )
        continue;
      result.push({
        id: asText(thread.id, thread.sessionId),
        sessionId: thread.sessionId,
        projectId:
          typeof thread.projectId === "string" ? thread.projectId : null,
        projectName: asTitle(thread.projectName ?? project?.name, "Personal"),
        title: asTitle(thread.name),
        provider:
          typeof thread.sourceAiClient === "string"
            ? thread.sourceAiClient
            : null,
        updatedAt: asText(thread.latestAt, "")
      });
    }
  }
  return result;
};

const dedupeBy = (items, key) => {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(item);
  }
  return result;
};

const scanRuntime = async ({ executions, fetchApi, warnings }) => {
  const requests = [];
  const activityByExecution = new Map();
  let failed = false;
  let capped = false;
  let cursor = 0;
  const worker = async () => {
    while (cursor < executions.length) {
      const execution = executions[cursor++];
      try {
        const payload = await withTimeout((signal) =>
          fetchApi(
            `/v1/managed-conversations/${encodeURIComponent(execution.id)}/runtime`,
            undefined,
            signal
          )
        );
        const latestCommand = isRecord(payload?.latestCommand)
          ? payload.latestCommand
          : null;
        const commandKind = asText(latestCommand?.commandKind, "");
        const commandState = asText(latestCommand?.state, "");
        const isTurnCommand =
          commandKind === "start" || commandKind === "prompt";
        let activity = "unknown";
        if (latestCommand) {
          if (["queued", "blocked"].includes(commandState)) {
            activity = isTurnCommand ? "pending" : "operation-pending";
          } else if (commandState === "dispatching") {
            activity =
              latestCommand.leaseActive === true
                ? isTurnCommand
                  ? "running"
                  : "operation"
                : "uncertain";
          } else if (commandState === "indeterminate") {
            activity = "uncertain";
          } else if (
            ["completed", "failed", "canceled"].includes(commandState)
          ) {
            activity = isTurnCommand ? "idle" : "unknown";
          }
        } else if (["stopped", "failed", "fenced"].includes(execution.state)) {
          activity = "idle";
        }
        activityByExecution.set(execution.id, activity);
        const allItems = Array.isArray(payload?.items) ? payload.items : [];
        const items = allItems.slice(0, MAX_REQUESTS_PER_EXECUTION);
        if (allItems.length > items.length) {
          capped = true;
          warnings.push("Some request coverage is capped.");
        }
        for (const item of items) {
          if (
            !isRecord(item) ||
            typeof item.id !== "string" ||
            !item.id ||
            !actionableRuntimeKinds.has(item.itemKind) ||
            item.state !== "pending" ||
            item.answered === true
          )
            continue;
          requests.push(requestMap(item, execution));
        }
      } catch (error) {
        failed = true;
        activityByExecution.set(execution.id, "unknown");
        const failure = mapApiFailure(error, error?.status);
        warnings.push(
          failure.unauthorized
            ? "Some request status is unauthorized."
            : "Some request status could not be read."
        );
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(SCAN_CONCURRENCY, executions.length) },
      worker
    )
  );
  const ordered = dedupeBy(requests.sort(compareRuntimeRequests), "id");
  if (ordered.length > MAX_TOTAL_REQUESTS) {
    capped = true;
    warnings.push("Total request coverage is capped.");
  }
  return {
    requests: ordered.slice(0, MAX_TOTAL_REQUESTS),
    activityByExecution,
    failed,
    capped
  };
};

const unavailableSnapshot = (fetchedAt, message, unauthorized = false) => ({
  state: unauthorized ? "unauthorized" : "unavailable",
  fetchedAt,
  scopeKey: null,
  message,
  warnings: [],
  coverage: { executions: false, requests: false, recents: false },
  executions: [],
  requests: [],
  recents: []
});

const scopeKeyFor = (apiBase, userId) => {
  let backend = String(apiBase);
  try {
    backend = new URL(apiBase).origin;
  } catch {
    // makeFetch validates this before any data is read; retain a stable fallback
  }
  return `${backend}|${userId}`;
};

const compareLatestAt = (left, right) => {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  if (leftValid && rightValid && leftTime !== rightTime)
    return rightTime - leftTime;
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  return right.id.localeCompare(left.id);
};

export const readHomeSnapshot = async ({
  fetchImpl = globalThis.fetch,
  apiBase = DEFAULT_API_URL,
  token,
  resolveAccess,
  now = () => new Date()
} = {}) => {
  const fetchedAt = now().toISOString();
  if (!token && typeof resolveAccess !== "function")
    return unavailableSnapshot(
      fetchedAt,
      "Koed authorization is not configured.",
      true
    );
  let localAccess;
  try {
    localAccess =
      typeof resolveAccess === "function"
        ? validatePairedLocalApiAccess(await resolveAccess())
        : { apiOrigin: apiBase, apiToken: token };
  } catch (error) {
    const failure = mapApiFailure(error, error?.status);
    return unavailableSnapshot(
      fetchedAt,
      failure.message,
      failure.unauthorized
    );
  }
  const fetchApi = makeFetch({
    fetchImpl,
    apiBase: localAccess.apiOrigin,
    token: localAccess.apiToken
  });
  let scopeKey = null;
  try {
    const access = await withTimeout((signal) =>
      fetchApi("/v1/managed-conversations/access", undefined, signal)
    );
    scopeKey =
      typeof access?.user?.id === "string"
        ? scopeKeyFor(localAccess.apiOrigin, access.user.id)
        : null;
  } catch (error) {
    const failure = mapApiFailure(error, error?.status);
    return unavailableSnapshot(
      fetchedAt,
      failure.message,
      failure.unauthorized
    );
  }

  const warnings = [];
  const threadBySession = new Map();
  let executions = [];
  let recents = [];
  let executionFailed = false;
  let recentsFailed = false;
  let executionCapped = false;
  let recentsCapped = false;
  const [executionResult, recentsResult] = await Promise.allSettled([
    withTimeout((signal) =>
      fetchApi("/v1/managed-conversations", { limit: MAX_EXECUTIONS }, signal)
    ),
    withTimeout((signal) =>
      fetchApi(
        "/v1/memory/graph/threads",
        { limit: MAX_RECENTS, offset: 0, includeInvalidated: false },
        signal
      )
    )
  ]);

  if (executionResult.status === "fulfilled") {
    const rows = Array.isArray(executionResult.value?.executions)
      ? executionResult.value.executions
      : [];
    executionCapped = rows.length >= MAX_EXECUTIONS;
    executions = dedupeBy(
      rows.filter((row) => row?.id),
      "id"
    ).slice(0, MAX_EXECUTIONS);
  } else {
    executionFailed = true;
    const failure = mapApiFailure(
      executionResult.reason,
      executionResult.reason?.status
    );
    warnings.push(
      failure.unauthorized
        ? "Managed execution status is unauthorized."
        : "Managed execution status could not be read."
    );
  }
  if (recentsResult.status === "fulfilled") {
    const threads = flattenThreads(recentsResult.value).sort(compareLatestAt);
    for (const thread of threads) threadBySession.set(thread.sessionId, thread);
    recentsCapped = threads.length >= MAX_RECENTS;
    recents = dedupeBy(threads, "sessionId").slice(0, MAX_RECENTS);
  } else {
    recentsFailed = true;
    const failure = mapApiFailure(
      recentsResult.reason,
      recentsResult.reason?.status
    );
    warnings.push(
      failure.unauthorized
        ? "Recent Personal conversations are unauthorized."
        : "Recent Personal conversations could not be read."
    );
  }

  const runtimeResult = executionFailed
    ? {
        requests: [],
        activityByExecution: new Map(),
        failed: true,
        capped: false
      }
    : await scanRuntime({ executions, fetchApi, warnings });
  const mappedExecutions = executions.map((execution) => ({
    ...executionMap(execution, threadBySession),
    activity: executionFailed
      ? "unknown"
      : (runtimeResult.activityByExecution.get(execution.id) ?? "unknown")
  }));
  if (executionCapped) warnings.push("Managed execution coverage is capped.");
  if (recentsCapped) warnings.push("Recent conversation coverage is capped.");
  const coverage = {
    executions: !executionFailed && !executionCapped,
    requests:
      !executionFailed &&
      !runtimeResult.failed &&
      !runtimeResult.capped &&
      !executionCapped,
    recents: !recentsFailed && !recentsCapped
  };
  if (!coverage.executions || !coverage.requests || !coverage.recents) {
    warnings.push(
      "Home data is partial; missing records are not treated as clear."
    );
  }
  const state = warnings.length ? "partial" : "ready";
  return {
    state,
    fetchedAt,
    scopeKey,
    message:
      state === "partial"
        ? "Some Personal Home data could not be fully checked."
        : null,
    warnings: [...new Set(warnings)].slice(0, 12),
    coverage,
    executions: mappedExecutions,
    requests: runtimeResult.requests,
    recents
  };
};

export const resolveLocalConversationCapture = async ({
  sourceId,
  fetchImpl = globalThis.fetch,
  apiBase = DEFAULT_API_URL,
  token,
  resolveAccess
} = {}) => {
  if (typeof sourceId !== "string" || sourceId.length > 1024) {
    return { state: "invalid" };
  }
  const separator = sourceId.indexOf(":");
  const provider = sourceId.slice(0, separator);
  if (separator < 1 || !["codex", "claude-code", "pi"].includes(provider)) {
    return { state: "invalid" };
  }
  let nativeId;
  try {
    nativeId = decodeURIComponent(sourceId.slice(separator + 1));
  } catch {
    return { state: "invalid" };
  }
  if (!nativeId || nativeId.length > 512 || /[\u0000-\u001f]/.test(nativeId)) {
    return { state: "invalid" };
  }
  if (!token && typeof resolveAccess !== "function")
    return { state: "unauthorized" };
  try {
    const fetchApi = makeFetch({ fetchImpl, apiBase, token, resolveAccess });
    const payload = await withTimeout((signal) =>
      fetchApi(
        "/v1/memory/graph/threads",
        {
          threadId: nativeId,
          limit: 100,
          offset: 0,
          includeInvalidated: false
        },
        signal
      )
    );
    const matches = flattenThreads(payload).filter(
      (thread) =>
        thread.id === nativeId &&
        (provider === "codex"
          ? thread.provider === "codex" || thread.provider === "codex-cli"
          : thread.provider === provider)
    );
    if (matches.length === 0) return { state: "not_captured" };
    if (matches.length !== 1) return { state: "unavailable" };
    const thread = matches[0];
    return {
      state: "captured",
      sessionId: thread.sessionId,
      title: thread.title,
      projectName: thread.projectName,
      provider: thread.provider
    };
  } catch (error) {
    return {
      state: isUnauthorized(error?.status) ? "unauthorized" : "unavailable"
    };
  }
};

const hostWithPort = (host, port) => {
  const value = String(host ?? "").toLowerCase();
  if (!value) return false;
  if (value.startsWith("["))
    return value === `[::1]:${port}` || value === "[::1]";
  const separator = value.lastIndexOf(":");
  if (separator > -1)
    return (
      loopbackHosts.has(value.slice(0, separator)) &&
      value.slice(separator + 1) === String(port)
    );
  return loopbackHosts.has(value);
};

const originAllowed = (origin, host, port) => {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const requestHost = String(host ?? "").toLowerCase();
    return (
      parsed.protocol === "http:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === String(port) &&
      parsed.host.toLowerCase() === requestHost &&
      hostWithPort(parsed.host, port)
    );
  } catch {
    return false;
  }
};

const githubPaths = new Set([
  "/studio-api/github/session",
  "/studio-api/github/status",
  "/studio-api/github/connect",
  "/studio-api/github/disconnect",
  "/studio-api/github/repositories",
  "/studio-api/github/pulls",
  "/studio-api/github/pull"
]);

const exactRequestOrigin = (request) => {
  const origin = String(request.headers.origin ?? "");
  const host = String(request.headers.host ?? "");
  if (!origin || !host) return null;
  try {
    const originUrl = new URL(origin);
    const hostUrl = new URL(`http://${host}`);
    const originPort = originUrl.port || "80";
    const hostPort = hostUrl.port || "80";
    if (
      originUrl.protocol !== "http:" ||
      originUrl.hostname.toLowerCase() !== hostUrl.hostname.toLowerCase() ||
      originPort !== hostPort
    )
      return null;
    return originUrl.origin;
  } catch {
    return null;
  }
};

const requestNowMs = (now) => {
  const value = now?.();
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
};

const readEmptyJsonObject = async (request) => {
  const contentLength = Number(request.headers["content-length"] ?? "");
  if (Number.isFinite(contentLength) && contentLength > GITHUB_BODY_MAX_BYTES)
    throw Object.assign(new Error("body_too_large"), { statusCode: 413 });
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  await new Promise((resolveBody, rejectBody) => {
    request.on("data", (chunk) => {
      if (tooLarge) return;
      total += chunk.byteLength;
      if (total > GITHUB_BODY_MAX_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        rejectBody(
          Object.assign(new Error("body_too_large"), { statusCode: 413 })
        );
      } else {
        resolveBody();
      }
    });
    request.on("error", rejectBody);
  });
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid_json"), { statusCode: 400 });
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 0 ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  )
    throw Object.assign(new Error("invalid_payload"), { statusCode: 400 });
  return parsed;
};

const readProjectCreateBody = async (request) => {
  const chunks = [];
  let total = 0;
  await new Promise((resolveBody, rejectBody) => {
    request.on("data", (chunk) => {
      total += chunk.byteLength;
      if (total <= 1024) chunks.push(chunk);
    });
    request.on("end", resolveBody);
    request.on("error", rejectBody);
  });
  if (total > 1024)
    throw Object.assign(new Error("body_too_large"), { statusCode: 413 });
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid_json"), { statusCode: 400 });
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).sort().join(",") !== "name,selectionId" ||
    typeof parsed.name !== "string" ||
    parsed.name.trim().length < 1 ||
    parsed.name.trim().length > 120 ||
    /[\u0000-\u001f\u007f]/.test(parsed.name) ||
    typeof parsed.selectionId !== "string" ||
    !/^[a-zA-Z0-9_-]{32,64}$/.test(parsed.selectionId)
  )
    throw Object.assign(new Error("invalid_payload"), { statusCode: 400 });
  return { name: parsed.name.trim(), selectionId: parsed.selectionId };
};

const readCollaborationActionBody = async (request) => {
  const contentLength = Number(request.headers["content-length"] ?? "");
  if (
    Number.isFinite(contentLength) &&
    contentLength > COLLABORATION_ACTION_BODY_MAX_BYTES
  )
    throw Object.assign(new Error("body_too_large"), { statusCode: 413 });
  const chunks = [];
  let total = 0;
  await new Promise((resolveBody, rejectBody) => {
    request.on("data", (chunk) => {
      total += chunk.byteLength;
      if (total > COLLABORATION_ACTION_BODY_MAX_BYTES) return;
      chunks.push(chunk);
    });
    request.on("end", resolveBody);
    request.on("error", rejectBody);
  });
  if (total > COLLABORATION_ACTION_BODY_MAX_BYTES)
    throw Object.assign(new Error("body_too_large"), { statusCode: 413 });
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid_json"), { statusCode: 400 });
  }
  if (!isRecord(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype)
    throw Object.assign(new Error("invalid_payload"), { statusCode: 400 });
  const keys = Object.keys(parsed).sort().join(",");
  const hasRemoteUrl = parsed.action === "connect_backend";
  if (
    keys !==
      (hasRemoteUrl ? "action,remoteUrl,requestId" : "action,requestId") ||
    !["connect_backend", "reconnect_backend", "disconnect_backend"].includes(
      parsed.action
    ) ||
    typeof parsed.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      parsed.requestId
    )
  )
    throw Object.assign(new Error("invalid_payload"), { statusCode: 400 });
  if (hasRemoteUrl) {
    if (
      typeof parsed.remoteUrl !== "string" ||
      !parsed.remoteUrl.trim() ||
      Buffer.byteLength(parsed.remoteUrl, "utf8") > 2_048 ||
      /[\s\u0000-\u001f\u007f]/u.test(parsed.remoteUrl)
    )
      throw Object.assign(new Error("invalid_payload"), { statusCode: 400 });
    try {
      const url = new URL(parsed.remoteUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("invalid_remote_url");
    } catch {
      throw Object.assign(new Error("invalid_payload"), { statusCode: 400 });
    }
    return {
      action: parsed.action,
      requestId: parsed.requestId,
      remoteUrl: parsed.remoteUrl.trim()
    };
  }
  return { action: parsed.action, requestId: parsed.requestId };
};

const readStudioCollaborationCommand = async (request) => {
  const contentLength = Number(request.headers["content-length"] ?? "");
  if (
    Number.isFinite(contentLength) &&
    contentLength > STUDIO_COLLABORATION_COMMAND_BODY_MAX_BYTES
  ) {
    throw Object.assign(new Error("body_too_large"), { statusCode: 413 });
  }
  const chunks = [];
  let total = 0;
  await new Promise((resolveBody, rejectBody) => {
    request.on("data", (chunk) => {
      total += chunk.byteLength;
      if (total <= STUDIO_COLLABORATION_COMMAND_BODY_MAX_BYTES)
        chunks.push(chunk);
    });
    request.on("end", resolveBody);
    request.on("error", rejectBody);
  });
  if (total > STUDIO_COLLABORATION_COMMAND_BODY_MAX_BYTES) {
    throw Object.assign(new Error("body_too_large"), { statusCode: 413 });
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid_json"), { statusCode: 400 });
  }
  const command = collaborationRendererCommandSchema.safeParse(parsed);
  if (!command.success) {
    throw Object.assign(new Error("invalid_payload"), { statusCode: 400 });
  }
  return command.data;
};

const readStudioTeamDraftAction = async (request) => {
  const contentLength = Number(request.headers["content-length"] ?? "");
  if (
    Number.isFinite(contentLength) &&
    contentLength > STUDIO_TEAM_DRAFT_BODY_MAX_BYTES
  ) {
    throw Object.assign(new Error("body_too_large"), { statusCode: 413 });
  }
  const chunks = [];
  let total = 0;
  await new Promise((resolveBody, rejectBody) => {
    request.on("data", (chunk) => {
      total += chunk.byteLength;
      if (total <= STUDIO_TEAM_DRAFT_BODY_MAX_BYTES) chunks.push(chunk);
    });
    request.on("end", resolveBody);
    request.on("error", rejectBody);
  });
  if (total > STUDIO_TEAM_DRAFT_BODY_MAX_BYTES) {
    throw Object.assign(new Error("body_too_large"), { statusCode: 413 });
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid_json"), { statusCode: 400 });
  }
  if (
    !isRecord(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype
  ) {
    throw Object.assign(new Error("invalid_payload"), { statusCode: 400 });
  }
  const keys = Object.keys(payload).sort().join(",");
  const hasDraft = payload.action === "save";
  if (
    keys !== (hasDraft ? "action,authority,draft" : "action,authority") ||
    !["load", "save", "delete"].includes(payload.action) ||
    !isRecord(payload.authority) ||
    Object.keys(payload.authority).some(
      (key) =>
        ![
          "backendId",
          "principalUserId",
          "teamId",
          "threadId",
          "rootMessageId",
          "editMessageId"
        ].includes(key)
    ) ||
    !["backendId", "principalUserId", "teamId", "threadId"].every((key) =>
      Object.hasOwn(payload.authority, key)
    ) ||
    (payload.authority.rootMessageId !== undefined &&
      payload.authority.editMessageId !== undefined) ||
    [payload.authority.rootMessageId, payload.authority.editMessageId].some(
      (value) =>
        value !== undefined &&
        (typeof value !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            value
          ))
    ) ||
    typeof payload.authority.backendId !== "string" ||
    payload.authority.backendId.length < 1 ||
    payload.authority.backendId.length > 240 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.authority.principalUserId
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.authority.teamId
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.authority.threadId
    )
  ) {
    throw Object.assign(new Error("invalid_payload"), { statusCode: 400 });
  }
  if (hasDraft) {
    const draft = payload.draft;
    if (
      !isRecord(draft) ||
      Object.keys(draft).some(
        (key) =>
          ![
            "text",
            "pendingSend",
            "receiptAckPending",
            "updatedAt",
            "edit"
          ].includes(key)
      ) ||
      typeof draft.text !== "string" ||
      Buffer.byteLength(draft.text, "utf8") > 128 * 1024 ||
      !(draft.pendingSend === null || isRecord(draft.pendingSend)) ||
      !(
        draft.receiptAckPending === undefined ||
        draft.receiptAckPending === null ||
        isRecord(draft.receiptAckPending)
      )
    ) {
      throw Object.assign(new Error("invalid_payload"), { statusCode: 400 });
    }
    if (draft.edit !== undefined) {
      const edit = draft.edit;
      const boundedText = (value) =>
        typeof value === "string" &&
        Buffer.byteLength(value, "utf8") <= 128 * 1024;
      const positiveVersion = (value) =>
        Number.isSafeInteger(value) && value > 0;
      if (
        !payload.authority.editMessageId ||
        draft.pendingSend !== null ||
        draft.receiptAckPending != null ||
        !isRecord(edit) ||
        Object.keys(edit).some(
          (key) =>
            !["expectedVersion", "baseBodyText", "conflict"].includes(key)
        ) ||
        !positiveVersion(edit.expectedVersion) ||
        !boundedText(edit.baseBodyText) ||
        (edit.conflict !== undefined &&
          (!isRecord(edit.conflict) ||
            Object.keys(edit.conflict).sort().join(",") !==
              "latestBodyText,latestVersion" ||
            !positiveVersion(edit.conflict.latestVersion) ||
            !boundedText(edit.conflict.latestBodyText)))
      )
        throw Object.assign(new Error("invalid_payload"), { statusCode: 400 });
    }
    if (draft.pendingSend !== null) {
      const pending = draft.pendingSend;
      if (
        Object.keys(pending).sort().join(",") !==
          "body,clientMessageId,createdAt" ||
        typeof pending.body !== "string" ||
        Buffer.byteLength(pending.body, "utf8") > 128 * 1024 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          pending.clientMessageId
        ) ||
        typeof pending.createdAt !== "string" ||
        !Number.isFinite(Date.parse(pending.createdAt))
      ) {
        throw Object.assign(new Error("invalid_payload"), { statusCode: 400 });
      }
    }
    if (
      draft.receiptAckPending !== undefined &&
      draft.receiptAckPending !== null
    ) {
      const receipt = draft.receiptAckPending;
      if (
        Object.keys(receipt).sort().join(",") !== "clientMessageId,messageId" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          receipt.clientMessageId
        ) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          receipt.messageId
        )
      ) {
        throw Object.assign(new Error("invalid_payload"), { statusCode: 400 });
      }
    }
  }
  return payload;
};

const projectDto = (value) => {
  if (!isRecord(value) || !/^lp_[0-9a-f]{32}$/.test(value.localProjectId ?? ""))
    return null;
  if (typeof value.displayName !== "string" || !value.displayName.trim())
    return null;
  return {
    id: value.localProjectId,
    name: value.displayName.slice(0, 120),
    lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : null
  };
};

const staticPathFor = (staticDir, pathname) => {
  if (pathname === "/") return resolve(staticDir, "index.html");
  if (pathname === "/plugins") return resolve(staticDir, "plugins.html");
  if (pathname === "/agents") return resolve(staticDir, "agents.html");
  if (pathname === "/settings") return resolve(staticDir, "settings.html");
  if (pathname === "/memory-inbox")
    return resolve(staticDir, "memory-inbox.html");
  if (pathname === "/collaboration")
    return resolve(staticDir, "collaboration.html");
  if (pathname === "/personal-preview")
    return resolve(staticDir, "personal-preview.html");
  if (pathname === "/pull-requests")
    return resolve(staticDir, "pull-requests.html");
  if (
    pathname.startsWith("/studio-api/") ||
    pathname.includes("\\") ||
    pathname.includes("\0") ||
    /%2f|%5c/i.test(pathname)
  )
    return null;
  if (
    !(
      pathname.startsWith("/_next/") ||
      /^\/(?:agents|plugins|settings|memory-inbox|collaboration|personal-preview|pull-requests)\/__next\.[a-zA-Z0-9_.-]+\.txt$/.test(
        pathname
      ) ||
      (pathname.startsWith("/") && !pathname.slice(1).includes("/"))
    )
  )
    return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const root = resolve(staticDir);
  const target = resolve(root, `.${decoded}`);
  const rel = relative(root, target);
  return rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.includes(`${sep}..${sep}`)
    ? null
    : target;
};

const sendJson = (response, status, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff"
  });
  response.end(payload);
};

const safeCollaborationDto = (snapshot) => {
  if (
    !isRecord(snapshot) ||
    !isRecord(snapshot.connection) ||
    !Array.isArray(snapshot.teams)
  )
    throw new Error("invalid_collaboration_snapshot");
  const connection = snapshot.connection;
  if (
    ![
      "disconnected",
      "connecting",
      "live",
      "reconnecting",
      "unavailable",
      "access_revoked"
    ].includes(connection.state) ||
    !(
      connection.backendId === null || typeof connection.backendId === "string"
    ) ||
    !(
      connection.connectedAt === null ||
      typeof connection.connectedAt === "string"
    ) ||
    !(connection.retryAt === null || typeof connection.retryAt === "string") ||
    !Number.isSafeInteger(connection.reconnectAttempt) ||
    connection.reconnectAttempt < 0 ||
    !Number.isSafeInteger(connection.protocolVersion) ||
    connection.protocolVersion < 1
  )
    throw new Error("invalid_collaboration_connection");
  const teams = snapshot.teams.map((team) => {
    if (
      !isRecord(team) ||
      typeof team.id !== "string" ||
      typeof team.name !== "string" ||
      !["owner", "admin", "member"].includes(team.role) ||
      !Number.isSafeInteger(team.unreadCount) ||
      team.unreadCount < 0 ||
      !Array.isArray(team.people) ||
      !Array.isArray(team.workspaces)
    )
      throw new Error("invalid_collaboration_team");
    return {
      id: team.id,
      name: team.name,
      role: team.role,
      unreadCount: team.unreadCount,
      people: team.people.map((person) => {
        if (
          !isRecord(person) ||
          typeof person.id !== "string" ||
          typeof person.displayName !== "string"
        )
          throw new Error("invalid_collaboration_person");
        return { id: person.id, displayName: person.displayName };
      }),
      workspaces: team.workspaces.map((workspace) => {
        if (
          !isRecord(workspace) ||
          typeof workspace.id !== "string" ||
          typeof workspace.name !== "string"
        )
          throw new Error("invalid_collaboration_workspace");
        return { id: workspace.id, name: workspace.name };
      })
    };
  });
  const dto = {
    connection: {
      state: connection.state,
      backendId: connection.backendId,
      connectedAt: connection.connectedAt,
      retryAt: connection.retryAt,
      reconnectAttempt: connection.reconnectAttempt,
      protocolVersion: connection.protocolVersion
    },
    teams
  };
  return typeof snapshot.error === "string"
    ? { ...dto, error: snapshot.error.slice(0, 512) }
    : dto;
};

export const createStudioServer = ({
  port = Number(process.env.STUDIO_PORT ?? DEFAULT_PORT),
  host = "127.0.0.1",
  apiBase = process.env.STUDIO_API_URL?.trim() || DEFAULT_API_URL,
  token,
  resolveToken: providedResolveToken,
  resolveAccess: providedResolveAccess,
  environment = process.env,
  staticDir = DEFAULT_STATIC_DIR,
  fetchImpl = globalThis.fetch,
  readFile = fs.readFile,
  now = () => new Date(),
  listLocalSources = (options = {}) =>
    listLocalConversationSources({ ...options, env: environment }),
  listProjects = () => listProjectMetadata(resolveKoedServerPaths(environment)),
  retainedWorkspaceCatalog,
  openRetainedWorkspaceFolder,
  deleteRetainedManagedWorktree,
  loadCollaborationSnapshot,
  loadStudioCollaborationSnapshot,
  loadStudioTeamDraft,
  saveStudioTeamDraft,
  deleteStudioTeamDraft,
  deleteStudioTeamDraftsForTeam,
  runStudioCollaborationCommand,
  subscribeStudioCollaborationEvents,
  connectCollaborationBackend,
  reconnectCollaborationBackend,
  disconnectCollaborationBackend,
  chooseProjectDirectory,
  registerProject,
  randomBytes = nodeRandomBytes,
  githubSessionTtlMs = GITHUB_SESSION_TTL_MS
} = {}) => {
  if (!isLoopbackHost(host))
    throw new Error("Studio server must bind to loopback.");
  let activePort = Number.isFinite(port) ? port : DEFAULT_PORT;
  let rootPromise;
  let retainedCatalog = retainedWorkspaceCatalog;
  let retainedCheckoutDriver;
  const githubSessions = new Map();
  const collaborationRequestIds = new Map();
  const projectSelections = new Map();
  const pruneProjectSelections = () => {
    const timestamp = requestNowMs(now);
    for (const [id, selection] of projectSelections) {
      if (selection.expiresAt <= timestamp) projectSelections.delete(id);
    }
    while (projectSelections.size >= PROJECT_SELECTION_MAX) {
      const oldest = projectSelections.keys().next().value;
      if (oldest === undefined) break;
      projectSelections.delete(oldest);
    }
  };
  const pruneGithubSessions = (timestamp) => {
    for (const [token, session] of githubSessions) {
      if (session.expiresAt <= timestamp) githubSessions.delete(token);
    }
    while (githubSessions.size > GITHUB_SESSION_MAX) {
      const oldest = githubSessions.keys().next().value;
      if (oldest === undefined) break;
      githubSessions.delete(oldest);
    }
  };
  const issueGithubSession = (origin) => {
    const timestamp = requestNowMs(now);
    pruneGithubSessions(timestamp);
    const token = randomBytes(32).toString("base64url");
    githubSessions.delete(token);
    githubSessions.set(token, {
      origin,
      expiresAt: timestamp + githubSessionTtlMs
    });
    return token;
  };
  const validGithubSession = (token, origin) => {
    if (typeof token !== "string" || !token || !origin) return false;
    const timestamp = requestNowMs(now);
    pruneGithubSessions(timestamp);
    return githubSessions.get(token)?.origin === origin;
  };
  const consumeCollaborationRequestId = (requestId, origin, options = {}) => {
    const timestamp = requestNowMs(now);
    for (const [key, value] of collaborationRequestIds) {
      if (value.expiresAt <= timestamp) collaborationRequestIds.delete(key);
    }
    while (collaborationRequestIds.size >= 2_048) {
      const oldest = collaborationRequestIds.keys().next().value;
      if (oldest === undefined) break;
      collaborationRequestIds.delete(oldest);
    }
    const key = `${origin}\n${requestId}`;
    const fingerprint = options.fingerprint ?? null;
    const previous = collaborationRequestIds.get(key);
    if (previous) {
      return Boolean(
        options.allowExactCreateReplay === true &&
        previous.allowExactCreateReplay === true &&
        fingerprint &&
        previous.fingerprint === fingerprint
      );
    }
    collaborationRequestIds.set(key, {
      expiresAt: timestamp + GITHUB_SESSION_TTL_MS,
      fingerprint,
      allowExactCreateReplay: options.allowExactCreateReplay === true
    });
    return true;
  };
  const resolveToken = () =>
    typeof providedResolveToken === "function"
      ? providedResolveToken()
      : token === undefined
        ? readCredential({ environment, readFile })
        : Promise.resolve(token);
  const resolveAccess = async () => {
    return validatePairedLocalApiAccess(await providedResolveAccess());
  };
  const server = createHttpServer(async (request, response) => {
    try {
      const requestUrlObject = new URL(request.url ?? "/", "http://127.0.0.1");
      const fetchSite = String(
        request.headers["sec-fetch-site"] ?? ""
      ).toLowerCase();
      if (
        !hostWithPort(request.headers.host, activePort) ||
        !originAllowed(
          request.headers.origin,
          request.headers.host,
          activePort
        ) ||
        fetchSite === "cross-site"
      ) {
        sendJson(response, 403, { error: "forbidden" });
        return;
      }
      const localApiOptions = {
        request,
        url: requestUrlObject,
        apiBase,
        fetchImpl,
        resolveToken,
        resolveAccess: providedResolveAccess ? resolveAccess : undefined,
        validCsrf: (incoming) => {
          const origin = exactRequestOrigin(incoming);
          return Boolean(
            origin &&
            validGithubSession(
              String(incoming.headers["x-studio-csrf"] ?? ""),
              origin
            )
          );
        },
        send: (status, body) => sendJson(response, status, body)
      };
      if (
        requestUrlObject.pathname === "/studio-api/collaboration/studio-session"
      ) {
        if (typeof loadStudioCollaborationSnapshot !== "function") {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        if (requestUrlObject.search) {
          sendJson(response, 400, { error: "query_not_allowed" });
          return;
        }
        const requestOrigin = exactRequestOrigin(request);
        if (request.headers.origin && !requestOrigin) {
          sendJson(response, 403, { error: "forbidden" });
          return;
        }
        const origin =
          requestOrigin || `http://${String(request.headers.host ?? "")}`;
        try {
          const snapshot = collaborationSnapshotSchema.parse(
            await loadStudioCollaborationSnapshot()
          );
          sendJson(response, 200, {
            snapshot,
            csrfToken: issueGithubSession(origin)
          });
        } catch {
          sendJson(response, 503, { error: "collaboration_unavailable" });
        }
        return;
      }
      if (
        requestUrlObject.pathname === "/studio-api/collaboration/team-draft"
      ) {
        if (
          typeof loadStudioTeamDraft !== "function" ||
          typeof saveStudioTeamDraft !== "function" ||
          typeof deleteStudioTeamDraft !== "function" ||
          typeof deleteStudioTeamDraftsForTeam !== "function"
        ) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        if (requestUrlObject.search) {
          sendJson(response, 400, { error: "query_not_allowed" });
          return;
        }
        const origin = exactRequestOrigin(request);
        if (
          !origin ||
          !validGithubSession(
            String(request.headers["x-studio-csrf"] ?? ""),
            origin
          )
        ) {
          sendJson(response, 403, { error: "forbidden" });
          return;
        }
        if (
          String(request.headers["content-type"] ?? "").toLowerCase() !==
          "application/json"
        ) {
          sendJson(response, 415, { error: "unsupported_media_type" });
          return;
        }
        let action;
        try {
          action = await readStudioTeamDraftAction(request);
        } catch (error) {
          sendJson(response, error?.statusCode ?? 400, {
            error:
              error?.statusCode === 413 ? "body_too_large" : "invalid_request"
          });
          return;
        }
        try {
          if (action.action === "load") {
            const draft = await loadStudioTeamDraft(action.authority);
            sendJson(response, 200, { draft: draft ?? null });
          } else if (action.action === "save") {
            await saveStudioTeamDraft({
              authority: action.authority,
              draft: action.draft
            });
            sendJson(response, 200, { saved: true });
          } else {
            await deleteStudioTeamDraft(action.authority);
            sendJson(response, 200, { deleted: true });
          }
        } catch (error) {
          const revoked = error?.code === "access_revoked";
          sendJson(response, revoked ? 403 : 503, {
            error: revoked ? "access_revoked" : "draft_unavailable"
          });
        }
        return;
      }
      if (requestUrlObject.pathname === "/studio-api/collaboration/command") {
        if (typeof runStudioCollaborationCommand !== "function") {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        if (requestUrlObject.search) {
          sendJson(response, 400, { error: "query_not_allowed" });
          return;
        }
        const origin = exactRequestOrigin(request);
        if (
          !origin ||
          !validGithubSession(
            String(request.headers["x-studio-csrf"] ?? ""),
            origin
          )
        ) {
          sendJson(response, 403, { error: "forbidden" });
          return;
        }
        if (
          String(request.headers["content-type"] ?? "").toLowerCase() !==
          "application/json"
        ) {
          sendJson(response, 415, { error: "unsupported_media_type" });
          return;
        }
        let command;
        try {
          command = await readStudioCollaborationCommand(request);
        } catch (error) {
          sendJson(response, error?.statusCode ?? 400, {
            error:
              error?.statusCode === 413 ? "body_too_large" : "invalid_request"
          });
          return;
        }
        const idempotentCreate =
          command.command === "collaboration.create_team_channel" ||
          command.command === "collaboration.create_team_shared_project" ||
          command.command === "collaboration.start_direct_message" ||
          command.command === "collaboration.start_group_direct_message";
        const fingerprintInput =
          command.command === "collaboration.start_group_direct_message"
            ? {
                ...command.input,
                participantUserIds: [...command.input.participantUserIds].sort()
              }
            : command.input;
        const fingerprint = idempotentCreate
          ? createHash("sha256")
              .update(
                JSON.stringify({
                  command: command.command,
                  input: fingerprintInput
                })
              )
              .digest("hex")
          : null;
        if (
          !consumeCollaborationRequestId(command.requestId, origin, {
            allowExactCreateReplay: idempotentCreate,
            fingerprint
          })
        ) {
          sendJson(response, 409, { error: "request_replayed" });
          return;
        }
        try {
          const result = collaborationCommandResultSchema.parse(
            await runStudioCollaborationCommand(command)
          );
          if (result.requestId !== command.requestId) {
            sendJson(response, 502, { error: "invalid_collaboration_result" });
            return;
          }
          sendJson(response, 200, result);
        } catch {
          sendJson(response, 503, { error: "collaboration_unavailable" });
        }
        return;
      }
      if (requestUrlObject.pathname === "/studio-api/collaboration/events") {
        if (typeof subscribeStudioCollaborationEvents !== "function") {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        if (requestUrlObject.search) {
          sendJson(response, 400, { error: "query_not_allowed" });
          return;
        }
        const suppliedOrigin = request.headers.origin;
        const requestOrigin = exactRequestOrigin(request);
        const origin =
          requestOrigin ||
          (suppliedOrigin === undefined
            ? `http://${String(request.headers.host ?? "")}`
            : null);
        if (
          !origin ||
          !validGithubSession(
            String(request.headers["x-studio-csrf"] ?? ""),
            origin
          )
        ) {
          sendJson(response, 403, { error: "forbidden" });
          return;
        }
        response.writeHead(200, {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
          "x-content-type-options": "nosniff"
        });
        response.write("retry: 2000\n\n");
        let unsubscribe = () => {};
        let closed = false;
        const onClose = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
        };
        request.on("aborted", onClose);
        response.on("close", onClose);
        try {
          const stop = subscribeStudioCollaborationEvents((event) => {
            if (closed || response.destroyed) return;
            const parsed = collaborationRendererEventSchema.safeParse(event);
            if (!parsed.success) return;
            const payload = JSON.stringify(parsed.data);
            if (Buffer.byteLength(payload, "utf8") > MAX_BODY_BYTES) return;
            response.write(`data: ${payload}\n\n`);
          });
          if (typeof stop === "function") unsubscribe = stop;
          if (closed) unsubscribe();
        } catch {
          response.end();
          onClose();
        }
        return;
      }
      if (requestUrlObject.pathname === "/studio-api/collaboration/snapshot") {
        if (typeof loadCollaborationSnapshot !== "function") {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        try {
          const snapshot = await loadCollaborationSnapshot();
          if (
            !isRecord(snapshot) ||
            !isRecord(snapshot.connection) ||
            !Array.isArray(snapshot.teams)
          ) {
            throw new Error("invalid_collaboration_snapshot");
          }
          const teams = snapshot.teams.map((team) => {
            if (
              !isRecord(team) ||
              typeof team.id !== "string" ||
              typeof team.name !== "string" ||
              !["owner", "admin", "member"].includes(team.role) ||
              !Number.isSafeInteger(team.unreadCount) ||
              team.unreadCount < 0 ||
              !Array.isArray(team.people) ||
              !Array.isArray(team.workspaces)
            ) {
              throw new Error("invalid_collaboration_team");
            }
            const people = team.people.map((person) => {
              if (
                !isRecord(person) ||
                typeof person.id !== "string" ||
                typeof person.displayName !== "string"
              ) {
                throw new Error("invalid_collaboration_person");
              }
              return { id: person.id, displayName: person.displayName };
            });
            const workspaces = team.workspaces.map((workspace) => {
              if (
                !isRecord(workspace) ||
                typeof workspace.id !== "string" ||
                typeof workspace.name !== "string"
              ) {
                throw new Error("invalid_collaboration_workspace");
              }
              return { id: workspace.id, name: workspace.name };
            });
            return {
              id: team.id,
              name: team.name,
              role: team.role,
              unreadCount: team.unreadCount,
              people,
              workspaces
            };
          });
          sendJson(response, 200, {
            connection: {
              state: snapshot.connection.state,
              backendId: snapshot.connection.backendId,
              connectedAt: snapshot.connection.connectedAt,
              retryAt: snapshot.connection.retryAt,
              reconnectAttempt: snapshot.connection.reconnectAttempt,
              protocolVersion: snapshot.connection.protocolVersion
            },
            teams
          });
        } catch {
          sendJson(response, 503, { error: "collaboration_unavailable" });
        }
        return;
      }
      if (
        requestUrlObject.pathname === "/studio-api/collaboration/session" ||
        requestUrlObject.pathname === "/studio-api/collaboration/backend"
      ) {
        const callbacks = {
          connect_backend: connectCollaborationBackend,
          reconnect_backend: reconnectCollaborationBackend,
          disconnect_backend: disconnectCollaborationBackend
        };
        if (
          !loadCollaborationSnapshot ||
          Object.values(callbacks).some(
            (callback) => typeof callback !== "function"
          )
        ) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        if (requestUrlObject.search) {
          sendJson(response, 400, { error: "query_not_allowed" });
          return;
        }
        if (requestUrlObject.pathname.endsWith("/session")) {
          if (request.method !== "GET") {
            sendJson(response, 405, { error: "method_not_allowed" });
            return;
          }
          const requestOrigin = exactRequestOrigin(request);
          if (request.headers.origin && !requestOrigin) {
            sendJson(response, 403, { error: "forbidden" });
            return;
          }
          const origin =
            requestOrigin || `http://${String(request.headers.host ?? "")}`;
          try {
            const dto = safeCollaborationDto(await loadCollaborationSnapshot());
            sendJson(response, 200, {
              ...dto,
              csrfToken: issueGithubSession(origin)
            });
          } catch {
            sendJson(response, 503, { error: "collaboration_unavailable" });
          }
          return;
        }
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const origin = exactRequestOrigin(request);
        if (
          !origin ||
          !validGithubSession(
            String(request.headers["x-studio-csrf"] ?? ""),
            origin
          )
        ) {
          sendJson(response, 403, { error: "forbidden" });
          return;
        }
        if (
          String(request.headers["content-type"] ?? "").toLowerCase() !==
          "application/json"
        ) {
          sendJson(response, 415, { error: "unsupported_media_type" });
          return;
        }
        let action;
        try {
          action = await readCollaborationActionBody(request);
        } catch (error) {
          sendJson(response, error?.statusCode ?? 400, {
            error:
              error?.statusCode === 413 ? "body_too_large" : "invalid_request"
          });
          return;
        }
        if (!consumeCollaborationRequestId(action.requestId, origin)) {
          sendJson(response, 409, { error: "request_replayed" });
          return;
        }
        try {
          const result =
            action.action === "connect_backend"
              ? await callbacks.connect_backend(action.remoteUrl)
              : action.action === "reconnect_backend"
                ? await callbacks.reconnect_backend()
                : await callbacks.disconnect_backend();
          const dto = safeCollaborationDto(result);
          if (dto.error) {
            sendJson(response, 502, { ...dto, error: dto.error });
            return;
          }
          sendJson(response, 200, dto);
        } catch {
          sendJson(response, 503, { error: "collaboration_unavailable" });
        }
        return;
      }
      if (
        requestUrlObject.pathname.includes("/retained-workspaces") &&
        (await handleRetainedWorkspaces({
          request,
          url: requestUrlObject,
          catalog: (retainedCatalog ??= new RetainedWorkspaceCatalog({
            koedHome: resolveKoedServerPaths(environment).koedHome
          })),
          validSession: (incoming) => {
            const origin =
              exactRequestOrigin(incoming) ||
              `http://${String(incoming.headers.host ?? "")}`;
            return validGithubSession(
              String(incoming.headers["x-studio-csrf"] ?? ""),
              origin
            );
          },
          validWrite: localApiOptions.validCsrf,
          ...(openRetainedWorkspaceFolder
            ? { openFolder: openRetainedWorkspaceFolder }
            : {}),
          deleteManagedWorktree:
            deleteRetainedManagedWorktree ??
            (async (moveId) => {
              retainedCheckoutDriver ??= createGitExecutionCheckoutDriver({
                managedRoot: resolve(
                  resolveKoedServerPaths(environment).koedHome,
                  "managed-checkouts",
                  "worktrees"
                )
              });
              return retainedCatalog.removeManagedWorktree(
                moveId,
                await retainedCheckoutDriver,
                "delete_managed_worktree"
              );
            }),
          send: localApiOptions.send
        }))
      )
        return;
      if (
        (await handlePullRequests({ ...localApiOptions, environment })) ||
        (await handleClientResources(localApiOptions)) ||
        (await handleHomeFeed(localApiOptions)) ||
        (await handlePersonalAgents(localApiOptions)) ||
        (await handlePersonalAgents({
          ...localApiOptions,
          routeFamily: "personal-removals"
        })) ||
        (await handleTeamAgentRequests(localApiOptions)) ||
        (await handlePublicSquare(localApiOptions)) ||
        (await handlePersonalAgentRoleTemplates(localApiOptions)) ||
        (await handleManagedConversations(localApiOptions))
      )
        return;
      if (requestUrlObject.pathname.startsWith("/studio-api/pr-chat/")) {
        sendJson(response, 410, {
          error:
            "This preview chat endpoint has been replaced by managed Pull Request review chats."
        });
        return;
      }
      if (requestUrlObject.pathname.startsWith("/studio-api/projects")) {
        if (
          ![
            "/studio-api/projects",
            "/studio-api/projects/capabilities",
            "/studio-api/projects/session",
            "/studio-api/projects/choose-folder"
          ].includes(requestUrlObject.pathname)
        ) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        if (requestUrlObject.search) {
          sendJson(response, 400, { error: "query_not_allowed" });
          return;
        }
        if (
          request.method === "GET" &&
          requestUrlObject.pathname === "/studio-api/projects/session"
        ) {
          const requestOrigin = exactRequestOrigin(request);
          if (request.headers.origin && !requestOrigin) {
            sendJson(response, 403, { error: "forbidden" });
            return;
          }
          const origin =
            requestOrigin || `http://${String(request.headers.host ?? "")}`;
          sendJson(response, 200, { csrfToken: issueGithubSession(origin) });
          return;
        }
        if (
          request.method === "GET" &&
          requestUrlObject.pathname === "/studio-api/projects/capabilities"
        ) {
          sendJson(response, 200, {
            canCreateLocalProject: Boolean(
              chooseProjectDirectory && registerProject
            )
          });
          return;
        }
        if (
          request.method === "GET" &&
          requestUrlObject.pathname === "/studio-api/projects"
        ) {
          if (!listProjects) {
            sendJson(response, 501, { error: "project_catalog_unavailable" });
            return;
          }
          try {
            const result = await listProjects();
            if (!result?.ok || !Array.isArray(result.projects))
              throw new Error("invalid_project_catalog");
            const projects = result.projects
              .map(projectDto)
              .filter(Boolean)
              .sort((left, right) =>
                String(right.lastSeenAt ?? "").localeCompare(
                  String(left.lastSeenAt ?? "")
                )
              );
            sendJson(response, 200, { projects });
          } catch {
            sendJson(response, 503, { error: "project_catalog_unavailable" });
          }
          return;
        }
        if (
          request.method !== "POST" ||
          ![
            "/studio-api/projects",
            "/studio-api/projects/choose-folder"
          ].includes(requestUrlObject.pathname)
        ) {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const requestOrigin = exactRequestOrigin(request);
        if (
          !requestOrigin ||
          !validGithubSession(
            String(request.headers["x-studio-csrf"] ?? ""),
            requestOrigin
          )
        ) {
          sendJson(response, 403, { error: "forbidden" });
          return;
        }
        if (
          String(request.headers["content-type"] ?? "").toLowerCase() !==
          "application/json"
        ) {
          sendJson(response, 415, { error: "unsupported_media_type" });
          return;
        }
        if (
          requestUrlObject.pathname === "/studio-api/projects/choose-folder"
        ) {
          try {
            await readEmptyJsonObject(request);
          } catch (error) {
            sendJson(response, error?.statusCode === 413 ? 413 : 400, {
              error:
                error?.statusCode === 413 ? "body_too_large" : "invalid_payload"
            });
            return;
          }
          if (!chooseProjectDirectory) {
            sendJson(response, 501, {
              error: "native_folder_picker_unavailable"
            });
            return;
          }
          try {
            const path = await chooseProjectDirectory();
            if (path === null) {
              sendJson(response, 200, { canceled: true });
              return;
            }
            if (typeof path !== "string" || !path || path.length > 4096)
              throw new Error("invalid_selection");
            pruneProjectSelections();
            const selectionId = randomBytes(24).toString("base64url");
            projectSelections.set(selectionId, {
              path,
              origin: requestOrigin,
              expiresAt: requestNowMs(now) + PROJECT_SELECTION_TTL_MS
            });
            sendJson(response, 200, { canceled: false, selectionId, path });
          } catch {
            sendJson(response, 503, { error: "folder_picker_unavailable" });
          }
          return;
        }
        let input;
        try {
          input = await readProjectCreateBody(request);
        } catch (error) {
          sendJson(response, error?.statusCode === 413 ? 413 : 400, {
            error:
              error?.statusCode === 413 ? "body_too_large" : "invalid_payload"
          });
          return;
        }
        pruneProjectSelections();
        const selection = projectSelections.get(input.selectionId);
        if (!selection || selection.origin !== requestOrigin) {
          sendJson(response, 400, { error: "folder_selection_expired" });
          return;
        }
        if (!registerProject) {
          sendJson(response, 501, {
            error: "project_registration_unavailable"
          });
          return;
        }
        try {
          const result = await registerProject({
            path: selection.path,
            name: input.name
          });
          const project = projectDto(result?.project);
          if (!result?.ok || !project)
            throw new Error("project_registration_failed");
          projectSelections.delete(input.selectionId);
          sendJson(response, 201, { project });
        } catch {
          sendJson(response, 503, { error: "project_registration_failed" });
        }
        return;
      }
      if (githubPaths.has(requestUrlObject.pathname)) {
        if (requestUrlObject.pathname !== "/studio-api/github/session") {
          sendJson(response, 410, {
            error: "Use the selected computer’s managed GitHub connection."
          });
          return;
        }
        if (requestUrlObject.search) {
          sendJson(response, 400, { error: "query_not_allowed" });
          return;
        }
        const suppliedOrigin = String(request.headers.origin ?? "");
        const requestOrigin = exactRequestOrigin(request);
        if (suppliedOrigin && !requestOrigin) {
          sendJson(response, 403, { error: "forbidden" });
          return;
        }
        if (requestUrlObject.pathname === "/studio-api/github/session") {
          if (request.method !== "GET") {
            sendJson(response, 405, { error: "method_not_allowed" });
            return;
          }
          // Browser GET requests may omit Origin; bind such sessions to the
          // loopback host that served the request and require it on writes.
          const sessionOrigin =
            requestOrigin || `http://${String(request.headers.host ?? "")}`;
          const csrfToken = issueGithubSession(sessionOrigin);
          sendJson(response, 200, { csrfToken });
          return;
        }
      }
      if (requestUrlObject.pathname === "/studio-api/personal-scope") {
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        if (requestUrlObject.search) {
          sendJson(response, 400, { error: "query_not_allowed" });
          return;
        }
        try {
          const localAccess = providedResolveAccess
            ? validatePairedLocalApiAccess(await resolveAccess())
            : { apiOrigin: apiBase, apiToken: await resolveToken() };
          if (!localAccess.apiToken) throw new Error("not_authorized");
          const fetchApi = makeFetch({
            fetchImpl,
            apiBase: localAccess.apiOrigin,
            token: localAccess.apiToken
          });
          const access = await withTimeout((signal) =>
            fetchApi("/v1/managed-conversations/access", undefined, signal)
          );
          if (typeof access?.user?.id !== "string" || !access.user.id)
            throw new Error("identity_unavailable");
          sendJson(response, 200, {
            scopeKey: scopeKeyFor(localAccess.apiOrigin, access.user.id)
          });
        } catch (error) {
          const failure = mapApiFailure(error, error?.status);
          sendJson(response, failure.unauthorized ? 401 : 503, {
            error: "personal_scope_unavailable"
          });
        }
        return;
      }
      if (
        request.method === "GET" &&
        requestUrlObject.pathname === "/studio-api/home"
      ) {
        try {
          const snapshot = await readHomeSnapshot({
            fetchImpl,
            apiBase,
            ...(providedResolveAccess
              ? { resolveAccess }
              : { token: await resolveToken() }),
            now
          });
          sendJson(response, 200, snapshot);
        } catch {
          sendJson(
            response,
            200,
            unavailableSnapshot(
              now().toISOString(),
              "Koed Home is unavailable."
            )
          );
        }
        return;
      }
      if (requestUrlObject.pathname === "/studio-api/local-conversations") {
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        if (typeof listLocalSources !== "function") {
          sendJson(response, 503, { error: "local_discovery_unavailable" });
          return;
        }
        const allowed = new Set(["limit", "cursor", "provider", "refresh"]);
        for (const [key, value] of requestUrlObject.searchParams) {
          if (
            !allowed.has(key) ||
            !value ||
            requestUrlObject.searchParams.getAll(key).length !== 1
          ) {
            sendJson(response, 400, { error: "invalid_query" });
            return;
          }
        }
        const limitText = requestUrlObject.searchParams.get("limit");
        const limit = limitText === null ? 50 : Number(limitText);
        const cursor = requestUrlObject.searchParams.get("cursor") ?? undefined;
        const provider =
          requestUrlObject.searchParams.get("provider") ?? undefined;
        const refresh = requestUrlObject.searchParams.get("refresh");
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          (cursor !== undefined && cursor.length > 2048) ||
          (provider !== undefined &&
            !["codex", "claude-code", "pi"].includes(provider)) ||
          (refresh !== null && refresh !== "1")
        ) {
          sendJson(response, 400, { error: "invalid_query" });
          return;
        }
        try {
          sendJson(
            response,
            200,
            await listLocalSources({
              limit,
              cursor,
              provider,
              ...(refresh === "1" ? { refresh: true } : {})
            })
          );
        } catch (error) {
          sendJson(
            response,
            error?.message === "local_conversation_cursor_invalid" ? 400 : 503,
            {
              error:
                error?.message === "local_conversation_cursor_invalid"
                  ? "invalid_cursor"
                  : "local_discovery_unavailable"
            }
          );
        }
        return;
      }
      if (
        requestUrlObject.pathname === "/studio-api/local-conversations/resolve"
      ) {
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        if (
          [...requestUrlObject.searchParams.keys()].some(
            (key) => key !== "sourceId"
          ) ||
          requestUrlObject.searchParams.getAll("sourceId").length !== 1
        ) {
          sendJson(response, 400, { error: "invalid_query" });
          return;
        }
        const result = await resolveLocalConversationCapture({
          sourceId: requestUrlObject.searchParams.get("sourceId"),
          fetchImpl,
          apiBase,
          ...(providedResolveAccess
            ? { resolveAccess }
            : { token: await resolveToken() })
        });
        sendJson(response, result.state === "invalid" ? 400 : 200, result);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      const target = staticPathFor(staticDir, requestUrlObject.pathname);
      if (!target) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      try {
        const root = await (rootPromise ??= fs.realpath(staticDir));
        const realTarget = await fs.realpath(target);
        const relativeTarget = relative(root, realTarget);
        if (
          relativeTarget.startsWith("..") ||
          relativeTarget.includes(`${sep}..${sep}`)
        ) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        const data = await fs.readFile(realTarget);
        response.writeHead(200, {
          "cache-control": requestUrlObject.pathname.startsWith("/_next/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
          "content-type":
            MIME_TYPES[extname(realTarget).toLowerCase()] ||
            "application/octet-stream",
          "content-length": data.byteLength,
          "x-content-type-options": "nosniff"
        });
        response.end(request.method === "HEAD" ? undefined : data);
      } catch {
        sendJson(response, 404, { error: "not_found" });
      }
    } catch {
      if (!response.headersSent)
        sendJson(response, 500, { error: "request_failed" });
      else response.destroy();
    }
  });
  const start = () =>
    new Promise((resolveStart, rejectStart) => {
      const onError = (error) => {
        server.off("listening", onListening);
        rejectStart(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        activePort =
          typeof address === "object" && address ? address.port : activePort;
        resolveStart({
          server,
          url: `http://${host}:${activePort}`,
          close: () =>
            new Promise((resolveClose) => {
              server.close(() => {
                resolveClose();
              });
              // Event streams remain open while Studio runs. Shutdown must
              // release them even if the renderer does not disconnect first.
              server.closeAllConnections();
            })
        });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host, port: activePort });
    });
  return { server, start };
};

export const startStudioServer = async (options = {}) =>
  createStudioServer(options).start();

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  startStudioServer()
    .then(({ url }) =>
      process.stdout.write(`Koed Studio listening at ${url}\n`)
    )
    .catch((error) => {
      process.stderr.write(
        `Koed Studio failed to start: ${redactedMessage(error?.message, "startup failed")}\n`
      );
      process.exitCode = 1;
    });
}
