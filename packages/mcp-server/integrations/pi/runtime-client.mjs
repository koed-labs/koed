/* global fetch, AbortSignal */
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";

// Standalone Pi installations cannot import the server's runtime client. Keep
// this registration fence equivalent to local-runtime-protocol's trusted read.
export const readRuntimeRegistration = (koedHome) => {
  const fd = openSync(
    join(koedHome, "run", "local-ai-runtime.json"),
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new Error(
        "Koed Local AI Runtime registration permissions are unsafe"
      );
    const registration = JSON.parse(readFileSync(fd, "utf8"));
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
  } finally {
    closeSync(fd);
  }
};

const request = async (
  koedHome,
  pathname,
  method,
  body,
  signal,
  bounded = false
) => {
  const registration = readRuntimeRegistration(koedHome);
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

export const callLocalRuntimeTool = async ({
  koedHome,
  name,
  input,
  context,
  signal,
  invocationKey
}) =>
  request(
    koedHome,
    `/v1/tools/${encodeURIComponent(name)}`,
    "POST",
    {
      input,
      caller: {
        cwd: context.cwd,
        clientInfo: { name: "pi", version: "koed-extension-v1" }
      },
      invocationKey
    },
    signal
  );
