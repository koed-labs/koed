import { existsSync, statSync } from "node:fs";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { KoedServerComponentStatus } from "./types.js";
import type { KoedServerPaths } from "./paths.js";
import {
  canUseSourceCheckoutFallback,
  resolvePackagedKoedRuntimeRoot,
  type RuntimeArtifactSource
} from "./runtime-artifact-source.js";

type SpawnLike = (
  command: string,
  args: string[],
  options?: Parameters<typeof nodeSpawn>[2]
) => ChildProcess;

export interface LocalEmbeddingRuntimePaths {
  appDir: string;
  pythonBin: string;
  llamaServerBin: string;
  artifactSource: RuntimeArtifactSource;
  artifactSources: {
    app: RuntimeArtifactSource;
    python: RuntimeArtifactSource;
    llamaServer: RuntimeArtifactSource;
  };
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

const chooseRuntimePath = (
  candidates: Array<{ path: string; artifactSource: RuntimeArtifactSource }>,
  defaultPath: string,
  defaultSource: RuntimeArtifactSource,
  exists: typeof existsSync = existsSync
): { path: string; artifactSource: RuntimeArtifactSource } => {
  for (const candidate of candidates) {
    if (exists(candidate.path)) {
      return candidate;
    }
  }
  return { path: defaultPath, artifactSource: defaultSource };
};

const combinedArtifactSource = (
  sources: RuntimeArtifactSource[]
): RuntimeArtifactSource =>
  sources.every((source) => source === sources[0])
    ? sources[0]!
    : "explicit-override";

export const resolveLocalEmbeddingRuntimePaths = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  exists: typeof existsSync = existsSync
): LocalEmbeddingRuntimePaths => {
  const koedRuntimeAppDir = resolve(
    paths.koedHome,
    "runtime",
    "embedding-service"
  );
  const repoAppDir = resolve(paths.repoRoot, "apps", "embedding-service");
  const packagedRuntimeRoot = resolvePackagedKoedRuntimeRoot(environment);
  const packagedAppDir = packagedRuntimeRoot
    ? resolve(packagedRuntimeRoot, "embedding-service")
    : undefined;
  const app = chooseRuntimePath(
    [
      {
        path: resolve(koedRuntimeAppDir, "app.py"),
        artifactSource: "koed-home-runtime" as const
      },
      ...(packagedAppDir
        ? [
            {
              path: resolve(packagedAppDir, "app.py"),
              artifactSource: "packaged-resource" as const
            }
          ]
        : []),
      ...(canUseSourceCheckoutFallback(environment)
        ? [
            {
              path: resolve(repoAppDir, "app.py"),
              artifactSource: "source-checkout" as const
            }
          ]
        : [])
    ],
    resolve(koedRuntimeAppDir, "app.py"),
    "koed-home-runtime",
    exists
  );
  const appDir = dirname(app.path);
  const host = trim(environment.KOED_EMBEDDING_HOST) ?? "127.0.0.1";
  const port =
    trim(environment.KOED_EMBEDDING_PORT) ??
    trim(environment.EMBEDDING_SERVICE_HOST_PORT) ??
    "3800";
  const pythonBin = resolve(
    trim(environment.KOED_EMBEDDING_PYTHON_BIN) ??
      resolve(appDir, ".venv", "bin", "python")
  );
  const koedRuntimeLlamaServer = resolve(
    paths.koedHome,
    "runtime",
    "llama.cpp",
    "llama-server"
  );
  const packagedLlamaServer = packagedRuntimeRoot
    ? resolve(packagedRuntimeRoot, "llama.cpp", "llama-server")
    : undefined;
  const vendorLlamaServer = resolve(
    paths.repoRoot,
    "vendor",
    "llama.cpp",
    "llama-server"
  );
  const llamaOverride = nativeLlamaServerOverride(environment);
  const llama = llamaOverride
    ? {
        path: resolve(llamaOverride),
        artifactSource: "explicit-override" as const
      }
    : chooseRuntimePath(
        [
          {
            path: koedRuntimeLlamaServer,
            artifactSource: "koed-home-runtime" as const
          },
          ...(packagedLlamaServer
            ? [
                {
                  path: packagedLlamaServer,
                  artifactSource: "packaged-resource" as const
                }
              ]
            : []),
          ...(canUseSourceCheckoutFallback(environment)
            ? [
                {
                  path: vendorLlamaServer,
                  artifactSource: "source-checkout" as const
                }
              ]
            : [])
        ],
        koedRuntimeLlamaServer,
        "koed-home-runtime",
        exists
      );
  const llamaServerBin = resolve(llama.path);
  const pythonSource: RuntimeArtifactSource = trim(
    environment.KOED_EMBEDDING_PYTHON_BIN
  )
    ? "explicit-override"
    : app.artifactSource;
  return {
    appDir,
    pythonBin,
    llamaServerBin,
    artifactSource: combinedArtifactSource([
      app.artifactSource,
      pythonSource,
      llama.artifactSource
    ]),
    artifactSources: {
      app: app.artifactSource,
      python: pythonSource,
      llamaServer: llama.artifactSource
    },
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
    runtime.artifactSource === "source-checkout"
      ? "Install native Embedding Service and llama-server assets with koed-server runtime install --provider homebrew --dependency-mode bundled-local --json on macOS, Linux, or WSL, or set KOED_EMBEDDING_PYTHON_BIN / KOED_EMBEDDING_LLAMA_SERVER_BIN overrides."
      : "Inspect native runtime with koed-server runtime status --provider packaged --json, then install packaged assets with koed-server runtime install --provider packaged --dependency-mode bundled-local --json or Homebrew-backed assets with --provider homebrew on macOS, Linux, or WSL.",
  details: {
    missing,
    artifactSource: runtime.artifactSource,
    artifactSources: runtime.artifactSources
  },
  paths: runtime
});

const isExecutable = (path: string): boolean => {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return true;
  }
};

const runtimeMissing = (
  runtime: LocalEmbeddingRuntimePaths,
  exists: typeof existsSync
): string[] =>
  (
    [
      ["embedding service app", resolve(runtime.appDir, "app.py"), false],
      ["python", runtime.pythonBin, true],
      ["llama-server", runtime.llamaServerBin, true]
    ] satisfies Array<[string, string, boolean]>
  ).flatMap(([name, file, mustExecute]) => {
    if (!exists(file)) return [`${name} (${file})`];
    if (mustExecute && !isExecutable(file)) {
      return [`${name} is not executable (${file})`];
    }
    return [];
  });

export const localEmbeddingRuntimeAvailable = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  exists: typeof existsSync = existsSync
): boolean =>
  runtimeMissing(
    resolveLocalEmbeddingRuntimePaths(paths, environment, exists),
    exists
  ).length === 0;

export const resolveBundledEmbeddingMode = (
  paths: KoedServerPaths,
  environment?: NodeJS.ProcessEnv,
  exists?: typeof existsSync
): "native" => {
  void paths;
  void environment;
  void exists;
  return "native";
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
  const runtime = resolveLocalEmbeddingRuntimePaths(paths, environment, exists);
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
        details: {
          healthUrl: runtime.healthUrl,
          artifactSource: runtime.artifactSource,
          artifactSources: runtime.artifactSources
        },
        paths: runtime
      };
    }
    return {
      runtime: "native-embedding",
      state: "starting",
      message: "Bundled-local native Embedding Service is not ready yet.",
      details: {
        healthUrl: runtime.healthUrl,
        httpStatus: response.status,
        artifactSource: runtime.artifactSource,
        artifactSources: runtime.artifactSources
      },
      paths: runtime
    };
  } catch (error) {
    return {
      runtime: "native-embedding",
      state: "starting",
      message: "Bundled-local native Embedding Service is not reachable yet.",
      details: {
        healthUrl: runtime.healthUrl,
        artifactSource: runtime.artifactSource,
        artifactSources: runtime.artifactSources,
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
  const runtime = resolveLocalEmbeddingRuntimePaths(paths, environment, exists);
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
      details: {
        pid: child.pid ?? null,
        healthUrl: runtime.healthUrl,
        artifactSource: runtime.artifactSource,
        artifactSources: runtime.artifactSources
      },
      paths: runtime
    }
  };
};
