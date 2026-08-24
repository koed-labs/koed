import { existsSync } from "node:fs";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { KoedServerPaths } from "./paths.js";
import type { KoedServerComponentStatus } from "./types.js";
import {
  collectPrivacyModelStatus,
  resolvePrivacyModelPaths
} from "./privacy-model-runtime.js";
import { resolveKoedAppRuntime } from "./app-runtime.js";

type SpawnLike = (
  command: string,
  args: string[],
  options?: Parameters<typeof nodeSpawn>[2]
) => ChildProcess;

export interface LocalPrivacyRuntimeStatus extends KoedServerComponentStatus {
  runtime: "native-privacy";
  details?: Record<string, unknown>;
}

export interface LocalPrivacyRuntimeStartResult {
  ok: boolean;
  status: LocalPrivacyRuntimeStatus;
  env: NodeJS.ProcessEnv;
  process?: ChildProcess;
}

const trim = (value: string | undefined): string | undefined =>
  value?.trim() || undefined;

export const localPrivacyEnv = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const host = trim(environment.PRIVACY_SERVICE_HOST) ?? "127.0.0.1";
  const port = trim(environment.PRIVACY_SERVICE_PORT) ?? "8092";
  return {
    PRIVACY_SERVICE_HOST: host,
    PRIVACY_SERVICE_PORT: port,
    PRIVACY_SERVICE_URL: `http://${host}:${port}`,
    KOED_PRIVACY_TRANSFORMERS_CACHE: resolvePrivacyModelPaths(paths).cacheDir,
    PRIVACY_RUNTIME_PROVIDER:
      trim(environment.PRIVACY_RUNTIME_PROVIDER) ??
      trim(environment.KOED_HARDWARE_ACCELERATION) ??
      "auto",
    PRIVACY_GPU_IDLE_UNLOAD_SECONDS:
      trim(environment.PRIVACY_GPU_IDLE_UNLOAD_SECONDS) ?? "300"
  };
};

const runtimePaths = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv
) => {
  const runtime = resolveKoedAppRuntime(paths, environment);
  const entry =
    runtime.kind === "packaged"
      ? resolve(runtime.root, "privacy-service", "dist", "index.js")
      : resolve(paths.repoRoot, "apps", "privacy-service", "dist", "index.js");
  const bootstrap = resolve(
    dirname(import.meta.filename),
    "privacy-service-bootstrap.js"
  );
  return { entry, bootstrap, appDir: dirname(dirname(entry)) };
};

const collectLocalPrivacyHealth = async (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: { existsSync?: typeof existsSync; fetch?: typeof fetch } = {},
  modelPath?: string
): Promise<LocalPrivacyRuntimeStatus> => {
  const exists = dependencies.existsSync ?? existsSync;
  const env = localPrivacyEnv(paths, environment);
  const runtime = runtimePaths(paths, environment);
  const missing = [runtime.entry, runtime.bootstrap].filter(
    (path) => !exists(path)
  );
  if (missing.length > 0) {
    return {
      runtime: "native-privacy",
      state: "not_configured",
      message: `Bundled-local Privacy Filter Service runtime is missing: ${missing.join(", ")}.`,
      action: "Build or reinstall the Koed app runtime.",
      details: { missing }
    };
  }
  const healthUrl = `${env.PRIVACY_SERVICE_URL}/health`;
  try {
    const response = await (dependencies.fetch ?? fetch)(healthUrl);
    const body = (await response.json()) as {
      status?: string;
      runtime?: Record<string, unknown>;
    };
    let runtimeDetails = body.runtime;
    const token = trim(environment.PRIVACY_RUNTIME_CONTROL_TOKEN);
    if (response.ok && token) {
      try {
        const runtimeResponse = await (dependencies.fetch ?? fetch)(
          `${env.PRIVACY_SERVICE_URL}/v1/runtime/status`,
          { headers: { "x-koed-privacy-token": token } }
        );
        if (runtimeResponse.ok) {
          runtimeDetails = (await runtimeResponse.json()) as Record<
            string,
            unknown
          >;
        }
      } catch {
        // Coarse readiness remains authoritative if diagnostics are unavailable.
      }
    }
    return response.ok && body.status === "ok"
      ? {
          runtime: "native-privacy",
          state: "healthy",
          message: "Bundled-local Privacy Filter Service is ready.",
          details: {
            healthUrl,
            ...(modelPath ? { modelPath } : {}),
            ...(runtimeDetails ? { privacyFilterRuntime: runtimeDetails } : {})
          }
        }
      : {
          runtime: "native-privacy",
          state: "starting",
          message:
            "Bundled-local Privacy Filter Service is loading its verified model.",
          details: { healthUrl, httpStatus: response.status }
        };
  } catch {
    return {
      runtime: "native-privacy",
      state: "starting",
      message: "Bundled-local Privacy Filter Service is not reachable yet.",
      details: { healthUrl }
    };
  }
};

export const collectLocalPrivacyRuntimeHealthStatus = async (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: { existsSync?: typeof existsSync; fetch?: typeof fetch } = {}
): Promise<LocalPrivacyRuntimeStatus> =>
  collectLocalPrivacyHealth(paths, environment, dependencies);

export const collectLocalPrivacyRuntimeStatus = async (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: { existsSync?: typeof existsSync; fetch?: typeof fetch } = {}
): Promise<LocalPrivacyRuntimeStatus> => {
  const exists = dependencies.existsSync ?? existsSync;
  const runtime = runtimePaths(paths, environment);
  const missing = [runtime.entry, runtime.bootstrap].filter(
    (path) => !exists(path)
  );
  if (missing.length > 0) {
    return {
      runtime: "native-privacy",
      state: "not_configured",
      message: `Bundled-local Privacy Filter Service runtime is missing: ${missing.join(", ")}.`,
      action: "Build or reinstall the Koed app runtime.",
      details: { missing }
    };
  }
  const model = await collectPrivacyModelStatus(paths);
  if (!model.ok) {
    return {
      runtime: "native-privacy",
      state: model.state === "missing" ? "not_configured" : "needs_attention",
      message: model.message,
      action: model.action,
      details: { modelPath: model.modelPath }
    };
  }
  return collectLocalPrivacyHealth(
    paths,
    environment,
    dependencies,
    model.modelPath
  );
};

export const startLocalPrivacyRuntime = async (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: { existsSync?: typeof existsSync; spawn?: SpawnLike } = {}
): Promise<LocalPrivacyRuntimeStartResult> => {
  const env = { ...environment, ...localPrivacyEnv(paths, environment) };
  const runtime = runtimePaths(paths, environment);
  const exists = dependencies.existsSync ?? existsSync;
  if (!exists(runtime.entry) || !exists(runtime.bootstrap)) {
    const status = await collectLocalPrivacyRuntimeStatus(paths, env, {
      existsSync: exists
    });
    return { ok: false, status, env };
  }
  const model = await collectPrivacyModelStatus(paths);
  if (!model.ok) {
    return {
      ok: false,
      env,
      status: {
        runtime: "native-privacy",
        state: model.state === "missing" ? "not_configured" : "needs_attention",
        message: model.message,
        action: model.action,
        details: { modelPath: model.modelPath }
      }
    };
  }
  const child = (dependencies.spawn ?? nodeSpawn)(
    process.execPath,
    [runtime.bootstrap, runtime.entry, model.modelPath],
    { cwd: runtime.appDir, env, stdio: "inherit" }
  );
  return {
    ok: true,
    env,
    process: child,
    status: {
      runtime: "native-privacy",
      state: "starting",
      message: "Bundled-local Privacy Filter Service is starting.",
      details: { pid: child.pid ?? null, modelPath: model.modelPath }
    }
  };
};
