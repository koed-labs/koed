import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertLoopbackUrl } from "./isolation.js";

export type ProductApiJson =
  | null
  | boolean
  | number
  | string
  | ProductApiJson[]
  | { [key: string]: ProductApiJson };

export interface ProductApiRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  headers?: Readonly<Record<string, string>>;
  body?: ProductApiJson;
  signal?: AbortSignal;
}

export interface ProductApiCloseAttestation {
  pid: number;
  graceful: boolean;
  forced: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProductApiHandle {
  url: string;
  pid?: number;
  request(input: ProductApiRequest): Promise<ProductApiJson>;
  close(): Promise<ProductApiCloseAttestation>;
}

interface ProductApiChildMessage {
  type: "listening" | "closed" | "startup-error";
  url?: string;
}

export interface StartProductApiProcessOptions {
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  maxResponseBytes?: number;
  childModuleUrl?: URL;
  spawnChild?: typeof spawn;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

// This is deliberately explicit. A benchmark trial cannot smuggle the
// coordinator's environment into the API process by adding arbitrary keys.
export const PRODUCT_API_ENV_ALLOWLIST = new Set([
  "API_DATA_ENCRYPTION_KEY",
  "API_TOKEN_PEPPER",
  "CACHE_REDIS_URL",
  "CACHE_STORE",
  "COLLABORATION_LOCAL_BROKER_SECRET",
  "COLLABORATION_REALTIME_CURSOR_SECRET",
  "DATABASE_URL",
  "EMBEDDING_MAX_TOKENS",
  "EMBEDDING_MODEL",
  "EMBEDDING_QUERY_INSTRUCTION",
  "EMBEDDING_QUERY_INSTRUCTION_ENABLED",
  "EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS",
  "EMBEDDING_SERVICE_TOKEN",
  "EMBEDDING_SERVICE_URL",
  "KOED_DEPENDENCY_MODE",
  "KOED_DEPLOYMENT_PROFILE",
  "KOED_EMBEDDING_MODEL_SHA256",
  "KOED_HOME",
  "KOED_RUNTIME_MODE",
  "LOG_LEVEL",
  "MEMORY_EVENT_MAX_TOKENS",
  "MEMORY_LCM_SUMMARY_MODEL",
  "MEMORY_PROJECTION_REBUILD_MAX_ITEMS",
  "MEMORY_PROJECTION_REBUILD_RATE_LIMIT_MAX",
  "MEMORY_PROJECTION_REBUILD_RATE_LIMIT_WINDOW_MS",
  "MEMORY_RAG_RAW_FALLBACK_ENABLED",
  "MEMORY_READ_RATE_LIMIT_MAX",
  "MEMORY_READ_RATE_LIMIT_WINDOW_MS",
  "MEMORY_RECALL_RATE_LIMIT_MAX",
  "MEMORY_RECALL_RATE_LIMIT_WINDOW_MS",
  "MEMORY_WRITE_RATE_LIMIT_MAX",
  "MEMORY_WRITE_RATE_LIMIT_WINDOW_MS",
  "NODE_ENV",
  "RATE_LIMIT_REDIS_URL",
  "RATE_LIMIT_STORE",
  "REDIS_URL",
  "WORK_QUEUE_BACKEND"
]);

export const allowlistedProductApiEnvironment = (
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of PRODUCT_API_ENV_ALLOWLIST) {
    const value = environment[name];
    if (value !== undefined) selected[name] = value;
  }
  // These values are process controls, not accepted trial configuration.
  selected.API_HOST = "127.0.0.1";
  selected.API_PORT = "0";
  selected.LOG_LEVEL = "silent";
  return selected;
};

const positiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
};

const waitForExit = (
  child: ChildProcess
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ exitCode: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });

const readBoundedJson = async (
  response: Response,
  maximumBytes: number
): Promise<ProductApiJson> => {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error("Koed API response exceeded the size limit");
      }
      chunks.push(next.value);
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text || "{}") as ProductApiJson;
  } catch {
    throw new Error(`Koed API returned non-JSON HTTP ${response.status}`);
  }
};

export const startProductApiProcess = async (
  options: StartProductApiProcessOptions
): Promise<ProductApiHandle> => {
  const startupTimeoutMs =
    options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  positiveInteger(startupTimeoutMs, "Product API startup timeout");
  positiveInteger(requestTimeoutMs, "Product API request timeout");
  positiveInteger(closeTimeoutMs, "Product API close timeout");
  positiveInteger(maxResponseBytes, "Product API response limit");
  if (options.signal?.aborted)
    throw new Error("Product API startup was cancelled");

  const adjacentChild = new URL("./product-api-child.js", import.meta.url);
  const compiledChild = new URL(
    "../../dist/experience-replay/product-api-child.js",
    import.meta.url
  );
  const childFile = fileURLToPath(
    options.childModuleUrl ??
      (existsSync(fileURLToPath(adjacentChild)) ? adjacentChild : compiledChild)
  );
  if (!existsSync(childFile)) {
    throw new Error(
      "Koed API child is not built; build @koed/evals before starting the product runtime"
    );
  }
  const spawnChild = options.spawnChild ?? spawn;
  const child = spawnChild(process.execPath, [childFile], {
    env: allowlistedProductApiEnvironment(options.environment),
    shell: false,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true
  });
  // Keep post-readiness process errors from becoming uncaught exceptions. They
  // are represented by failed requests or the close attestation, never logs.
  child.on("error", () => undefined);
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGTERM");
    throw new Error("Koed API subprocess did not receive a PID");
  }

  let closePromise: Promise<ProductApiCloseAttestation> | undefined;
  const lifecycleAbort = () => void terminate(false);
  const terminate = async (
    graceful: boolean
  ): Promise<ProductApiCloseAttestation> => {
    if (closePromise) return closePromise;
    options.signal?.removeEventListener("abort", lifecycleAbort);
    closePromise = (async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return {
          pid,
          graceful: false,
          forced: false,
          exitCode: child.exitCode,
          signal: child.signalCode
        };
      }
      if (graceful && child.connected) child.send({ type: "close" });
      else child.kill("SIGTERM");
      const exited = waitForExit(child);
      let forced = false;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), closeTimeoutMs);
        timer.unref();
      });
      let result = await Promise.race([exited, timeout]);
      if (!result) {
        forced = true;
        child.kill("SIGKILL");
        const forcedTimeout = new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), closeTimeoutMs);
          timer.unref();
        });
        result = await Promise.race([exited, forcedTimeout]);
        if (!result) {
          throw new Error("Koed API subprocess did not exit after SIGKILL");
        }
      }
      if (timer) clearTimeout(timer);
      return {
        pid,
        graceful: graceful && !forced && result.exitCode === 0,
        forced,
        ...result
      };
    })();
    return closePromise;
  };

  const startupDeadline = Date.now() + startupTimeoutMs;
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => finish(new Error("Koed API startup/readiness timed out")),
        startupTimeoutMs
      );
      timer.unref();
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value as string);
      };
      const abort = () => finish(new Error("Koed API startup was cancelled"));
      const fail = () =>
        finish(new Error("Koed API subprocess exited before readiness"));
      const spawnError = () =>
        finish(new Error("Koed API subprocess failed to start"));
      const message = (value: unknown) => {
        const event = value as ProductApiChildMessage;
        if (event?.type === "startup-error") fail();
        if (event?.type === "listening" && event.url)
          finish(undefined, event.url);
      };
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        child.removeListener("exit", fail);
        child.removeListener("error", spawnError);
        child.removeListener("message", message);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      child.once("exit", fail);
      child.once("error", spawnError);
      child.on("message", message);
    });
    assertLoopbackUrl(url, "Experience Replay Koed API");

    const requestWithTimeout = async (
      input: ProductApiRequest,
      timeoutMs: number
    ): Promise<ProductApiJson> => {
      if (!input.path.startsWith("/") || input.path.startsWith("//")) {
        throw new Error("Koed API request path must be absolute and local");
      }
      const abort = new AbortController();
      const timeout = setTimeout(
        () => abort.abort("request-timeout"),
        timeoutMs
      );
      timeout.unref();
      const cancel = () => abort.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", cancel, { once: true });
      if (input.signal?.aborted) cancel();
      try {
        const response = await fetch(new URL(input.path, url), {
          method: input.method,
          headers: {
            ...(input.body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...input.headers
          },
          ...(input.body === undefined
            ? {}
            : { body: JSON.stringify(input.body) }),
          signal: abort.signal
        });
        const body = await readBoundedJson(response, maxResponseBytes);
        if (!response.ok) {
          throw new Error(`Koed API returned HTTP ${response.status}`);
        }
        return body;
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", cancel);
      }
    };
    const request = (input: ProductApiRequest) =>
      requestWithTimeout(input, requestTimeoutMs);

    // Listening is not readiness: wait until the production probe succeeds.
    while (true) {
      try {
        const remainingMs = startupDeadline - Date.now();
        if (remainingMs <= 0) throw new Error("readiness deadline reached");
        await requestWithTimeout(
          { method: "GET", path: "/ready" },
          Math.min(requestTimeoutMs, remainingMs)
        );
        break;
      } catch {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error("Koed API subprocess exited before readiness");
        }
        if (Date.now() >= startupDeadline)
          throw new Error("Koed API startup/readiness timed out");
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(50, Math.max(1, startupDeadline - Date.now()))
          )
        );
      }
    }
    options.signal?.addEventListener("abort", lifecycleAbort, { once: true });
    return { url, pid, request, close: () => terminate(true) };
  } catch (error) {
    await terminate(false);
    throw error;
  }
};
