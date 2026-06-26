import { existsSync } from "node:fs";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import type { KoedServerComponentStatus } from "./types.js";
import type { KoedServerPaths } from "./paths.js";

type SpawnLike = (
  command: string,
  args: string[],
  options?: Parameters<typeof nodeSpawn>[2]
) => ChildProcess;

export interface LocalEmbeddingRuntimePaths {
  appDir: string;
  pythonBin: string;
  llamaServerBin: string;
  host: string;
  port: string;
  healthUrl: string;
}

export interface LocalEmbeddingRuntimeStatus extends KoedServerComponentStatus {
  runtime: "native-embedding";
  paths: LocalEmbeddingRuntimePaths;
}

export interface LocalEmbeddingRuntimeStartResult {
  ok: boolean;
  status: LocalEmbeddingRuntimeStatus;
  env: NodeJS.ProcessEnv;
  process?: ChildProcess;
}

export interface LocalEmbeddingRuntimeDependencies {
  existsSync?: typeof existsSync;
  spawn?: SpawnLike;
  fetch?: typeof fetch;
}

const DOCKER_LLAMA_SERVER_BINARY = "/opt/llama.cpp/llama-server";

const trim = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const nativeLlamaServerOverride = (
  environment: NodeJS.ProcessEnv
): string | undefined => {
  const koedOverride = trim(environment.KOED_EMBEDDING_LLAMA_SERVER_BIN);
  if (koedOverride) {
    return koedOverride;
  }
  for (const value of [
    trim(environment.LLAMA_SERVER_BINARY),
    trim(environment.EMBEDDING_LLAMA_SERVER_BINARY)
  ]) {
    if (value && value !== DOCKER_LLAMA_SERVER_BINARY) {
      return value;
    }
  }
  return undefined;
};

export const resolveLocalEmbeddingRuntimePaths = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env
): LocalEmbeddingRuntimePaths => {
  const appDir = resolve(paths.repoRoot, "apps", "embedding-service");
  const host = trim(environment.KOED_EMBEDDING_HOST) ?? "127.0.0.1";
  const port =
    trim(environment.KOED_EMBEDDING_PORT) ??
    trim(environment.EMBEDDING_SERVICE_HOST_PORT) ??
    "3800";
  const pythonBin = resolve(
    trim(environment.KOED_EMBEDDING_PYTHON_BIN) ??
      resolve(appDir, ".venv", "bin", "python")
  );
  const llamaServerBin = resolve(
    nativeLlamaServerOverride(environment) ??
      resolve(paths.repoRoot, "vendor", "llama.cpp", "llama-server")
  );
  return {
    appDir,
    pythonBin,
    llamaServerBin,
    host,
    port,
    healthUrl: `http://${host}:${port}/health`
  };
};

const missingRuntime = (
  runtime: LocalEmbeddingRuntimePaths,
  missing: string[]
): LocalEmbeddingRuntimeStatus => ({
  runtime: "native-embedding",
  state: "not_configured",
  message: `Bundled-local native Embedding Service runtime is missing: ${missing.join(", ")}.`,
  action:
    "Install apps/embedding-service Python runtime and bundled llama-server, or set KOED_EMBEDDING_PYTHON_BIN / KOED_EMBEDDING_LLAMA_SERVER_BIN overrides.",
  details: { missing },
  paths: runtime
});

const runtimeMissing = (
  runtime: LocalEmbeddingRuntimePaths,
  exists: typeof existsSync
): string[] =>
  (
    [
      ["embedding service app", resolve(runtime.appDir, "app.py")],
      ["python", runtime.pythonBin],
      ["llama-server", runtime.llamaServerBin]
    ] satisfies Array<[string, string]>
  ).flatMap(([name, file]) => (exists(file) ? [] : [`${name} (${file})`]));

export const localEmbeddingRuntimeAvailable = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  exists: typeof existsSync = existsSync
): boolean =>
  runtimeMissing(resolveLocalEmbeddingRuntimePaths(paths, environment), exists)
    .length === 0;

export const resolveBundledEmbeddingMode = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  exists: typeof existsSync = existsSync
): "native" | "compose" => {
  const configured = trim(environment.KOED_BUNDLED_EMBEDDING_MODE);
  if (configured === "native") {
    return "native";
  }
  if (configured === "compose") {
    return "compose";
  }
  return localEmbeddingRuntimeAvailable(paths, environment, exists)
    ? "native"
    : "compose";
};

export const localEmbeddingEnv = (
  runtime: LocalEmbeddingRuntimePaths
): NodeJS.ProcessEnv => ({
  EMBEDDING_SERVICE_URL: `http://${runtime.host}:${runtime.port}`,
  LLAMA_SERVER_BINARY: runtime.llamaServerBin
});

export const collectLocalEmbeddingRuntimeStatus = async (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: LocalEmbeddingRuntimeDependencies = {}
): Promise<LocalEmbeddingRuntimeStatus> => {
  const exists = dependencies.existsSync ?? existsSync;
  const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const runtime = resolveLocalEmbeddingRuntimePaths(paths, environment);
  const missing = runtimeMissing(runtime, exists);
  if (missing.length > 0) {
    return missingRuntime(runtime, missing);
  }
  try {
    const response = await fetcher(runtime.healthUrl);
    const text = await response.text();
    const body = text ? (JSON.parse(text) as { status?: string }) : {};
    if (response.ok && body.status === "ok") {
      return {
        runtime: "native-embedding",
        state: "healthy",
        message: "Bundled-local native Embedding Service is running.",
        details: { healthUrl: runtime.healthUrl },
        paths: runtime
      };
    }
    return {
      runtime: "native-embedding",
      state: "starting",
      message: "Bundled-local native Embedding Service is not ready yet.",
      details: { healthUrl: runtime.healthUrl, httpStatus: response.status },
      paths: runtime
    };
  } catch (error) {
    return {
      runtime: "native-embedding",
      state: "starting",
      message: "Bundled-local native Embedding Service is not reachable yet.",
      details: {
        healthUrl: runtime.healthUrl,
        error: error instanceof Error ? error.message : String(error)
      },
      paths: runtime
    };
  }
};

export const startLocalEmbeddingRuntime = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: LocalEmbeddingRuntimeDependencies = {}
): LocalEmbeddingRuntimeStartResult => {
  const exists = dependencies.existsSync ?? existsSync;
  const spawn = dependencies.spawn ?? (nodeSpawn as SpawnLike);
  const runtime = resolveLocalEmbeddingRuntimePaths(paths, environment);
  const env = {
    ...environment,
    ...localEmbeddingEnv(runtime),
    LOG_LEVEL: trim(environment.EMBEDDING_LOG_LEVEL) ?? environment.LOG_LEVEL
  };
  const missing = runtimeMissing(runtime, exists);
  if (missing.length > 0) {
    return { ok: false, status: missingRuntime(runtime, missing), env };
  }
  const child = spawn(
    runtime.pythonBin,
    [
      "-m",
      "uvicorn",
      "app:app",
      "--host",
      runtime.host,
      "--port",
      runtime.port
    ],
    {
      cwd: runtime.appDir,
      env,
      stdio: "inherit"
    }
  );
  child.on("exit", (code) => {
    console.log(
      `Native Embedding Service exited with code ${code ?? "signal"}.`
    );
  });
  return {
    ok: true,
    env,
    process: child,
    status: {
      runtime: "native-embedding",
      state: "starting",
      message: "Bundled-local native Embedding Service is starting.",
      details: { pid: child.pid ?? null, healthUrl: runtime.healthUrl },
      paths: runtime
    }
  };
};
