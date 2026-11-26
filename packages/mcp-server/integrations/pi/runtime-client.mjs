/* global fetch, AbortSignal */
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync
} from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";

// Standalone Pi installations cannot import the server's runtime client. Keep
// this registration fence equivalent to local-runtime-protocol's trusted read.
const registrationPath = (koedHome) =>
  join(koedHome, "run", "local-ai-runtime.json");
const registrationFlags =
  constants.O_RDONLY |
  (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);

const checkRegistrationFile = (stat) => {
  if (
    !stat.isFile() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0) ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new Error(
      "Koed Local AI Runtime registration permissions are unsafe"
    );
};

const parseRegistration = (content) => {
  const registration = JSON.parse(content);
  const url = new URL(registration.url);
  if (
    registration.protocolVersion !== 1 ||
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname) ||
    !/^Bearer [A-Za-z0-9_-]{32,}$/.test(registration.authorization) ||
    !Number.isInteger(registration.pid) ||
    registration.pid < 1 ||
    !Number.isFinite(Date.parse(registration.startedAt))
  )
    throw new Error("Koed Local AI Runtime registration is invalid");
  return registration;
};

export const readRuntimeRegistration = (koedHome) => {
  const fd = openSync(registrationPath(koedHome), registrationFlags);
  try {
    checkRegistrationFile(fstatSync(fd));
    return parseRegistration(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
};

const readLivenessRegistration = async (koedHome, signal) => {
  const file = await open(
    registrationPath(koedHome),
    registrationFlags | (constants.O_NONBLOCK ?? 0)
  );
  try {
    signal.throwIfAborted();
    checkRegistrationFile(await file.stat());
    signal.throwIfAborted();
    return parseRegistration(await file.readFile({ encoding: "utf8", signal }));
  } finally {
    await file.close();
  }
};

const requestWithRegistration = async (
  registration,
  pathname,
  method,
  body,
  signal,
  bounded = false
) => {
  const response = await fetch(new URL(pathname, registration.url), {
    method,
    redirect: "error",
    headers: {
      "content-type": "application/json",
      authorization: registration.authorization
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: bounded
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)].filter(Boolean))
      : signal
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    // Never relay provider/backend exception text into Pi diagnostics.
    throw Object.assign(
      new Error(`Koed Local AI Runtime returned HTTP ${response.status}`),
      {
        statusCode: response.status,
        ...(response.status === 429 &&
        Number.isSafeInteger(result?.retryAfterMs) &&
        result.retryAfterMs > 0 &&
        result.retryAfterMs <= 300_000
          ? { retryAfterMs: result.retryAfterMs }
          : {})
      }
    );
  }
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Koed Local AI Runtime returned an invalid response");
  return result;
};

const request = async (koedHome, ...args) =>
  requestWithRegistration(readRuntimeRegistration(koedHome), ...args);

/** Generic startup can reopen history, even when no messages exist. */
export const piSessionStartIsNewConversation = (reason) =>
  reason === "new" || reason === "fork";

export const recordCaptureFolderContext = (koedHome, input) =>
  request(
    koedHome,
    "/v1/capture/folder-context",
    "POST",
    input,
    undefined,
    true
  );

export const recordPiLiveness = async (koedHome, input, signal) => {
  const deadline = new globalThis.AbortController();
  const timeout = globalThis.setTimeout(() => deadline.abort(), 4_000);
  timeout.unref();
  try {
    const combined = AbortSignal.any([signal, deadline.signal]);
    const registration = await readLivenessRegistration(koedHome, combined);
    combined.throwIfAborted();
    const result = await requestWithRegistration(
      registration,
      "/v1/capture/pi-liveness",
      "POST",
      input,
      combined
    );
    if (result.ok !== true)
      throw new Error("Koed Local AI Runtime did not acknowledge Pi liveness");
  } finally {
    globalThis.clearTimeout(timeout);
  }
};

export const createRuntimeTaskPort = (koedHome) => {
  const scope = resolve(koedHome);
  return {
    scope,
    start: async (input, caller, invocationKey, signal) =>
      (
        await request(
          scope,
          "/v1/tasks/memory-answer",
          "POST",
          { input, caller, invocationKey },
          signal,
          true
        )
      ).task,
    get: async (taskId, signal) =>
      (
        await request(
          scope,
          `/v1/tasks/${encodeURIComponent(taskId)}`,
          "GET",
          undefined,
          signal,
          true
        )
      ).task,
    cancel: async (taskId, signal) =>
      (
        await request(
          scope,
          `/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
          "POST",
          undefined,
          signal,
          true
        )
      ).task
  };
};

export const piRuntimeCallerContext = (context) => {
  const externalSessionId = context.sessionManager?.getSessionId?.();
  return {
    cwd: context.cwd,
    clientInfo: { name: "pi", version: "koed-extension-v1" },
    ...(typeof externalSessionId === "string" &&
    externalSessionId.trim().length > 0 &&
    externalSessionId.length <= 4096 &&
    !externalSessionId.includes("\0")
      ? { conversation: { externalSessionId, sourceRuntime: "pi" } }
      : {})
  };
};

export const callLocalRuntimeTool = async ({
  koedHome,
  name,
  input,
  context,
  signal,
  invocationKey
}) => {
  // The runtime may outlive a Pi extension upgrade. Never forward fields that
  // an older runtime could silently discard, and recheck after runtime restarts.
  if (
    name === "memory_workspaces" ||
    (name === "memory_answer" && input.team_backend_id !== undefined)
  ) {
    const capabilities = await request(
      koedHome,
      "/v1/capabilities",
      "GET",
      undefined,
      signal,
      true
    );
    if (
      !Array.isArray(capabilities.supportedTools) ||
      !capabilities.supportedTools.includes(name) ||
      (name === "memory_answer" &&
        capabilities.memoryAnswerTeamBackendAvailable !== true)
    ) {
      throw Object.assign(
        new Error("Koed runtime Team recall feature unavailable"),
        {
          code: "runtime_feature_unavailable"
        }
      );
    }
  }
  return request(
    koedHome,
    `/v1/tools/${encodeURIComponent(name)}`,
    "POST",
    {
      input,
      caller: piRuntimeCallerContext(context),
      invocationKey
    },
    signal
  );
};
