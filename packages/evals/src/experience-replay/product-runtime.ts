import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LocalAiRuntimeClient,
  startLocalAiRuntime,
  type LocalAiRuntimeHandle,
  type StartLocalAiRuntimeOptions
} from "@koed/mcp-server/runtime-contracts";
import {
  startBenchmarkBridge,
  type BenchmarkBridgeHandle,
  type TrialBridgeIdentity
} from "./bridge.js";
import {
  assertEvalDatabaseUrl,
  assertLoopbackUrl,
  startTrialRedis,
  type TrialRedisHandle
} from "./isolation.js";
import {
  AsyncResourceScope,
  type CleanupAttestation
} from "./resource-scope.js";
import {
  startProductApiProcess,
  type ProductApiHandle
} from "./product-api-process.js";

export type { ProductApiHandle } from "./product-api-process.js";

export interface ProductRuntimeAuxiliaryHandle {
  environment?: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

export interface ProductRuntimeDependencies {
  startRedis(): Promise<TrialRedisHandle>;
  startEmbeddingService(input: {
    root: string;
    environment: NodeJS.ProcessEnv;
  }): Promise<ProductRuntimeAuxiliaryHandle | undefined>;
  startAppServer(input: {
    root: string;
    environment: NodeJS.ProcessEnv;
  }): Promise<ProductRuntimeAuxiliaryHandle | undefined>;
  startApi(input: {
    databaseUrl: string;
    redisUrl: string;
    environment: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }): Promise<ProductApiHandle>;
  startRuntime(
    options: StartLocalAiRuntimeOptions
  ): Promise<LocalAiRuntimeHandle>;
  createRuntimeClient(environment: NodeJS.ProcessEnv): LocalAiRuntimeClient;
  startBridge(
    input: Parameters<typeof startBenchmarkBridge>[0]
  ): Promise<BenchmarkBridgeHandle>;
}

export interface StartExperienceReplayProductRuntimeOptions {
  scopeId: string;
  databaseUrl: string;
  apiToken: string;
  projectCwd: string;
  trialWorkspaceRoot: string;
  identity: TrialBridgeIdentity;
  scope?: AsyncResourceScope;
  environment?: NodeJS.ProcessEnv;
  codexAuthJsonPath?: string;
  dependencies?: Partial<ProductRuntimeDependencies>;
  bridgeCredentialLifetimeMs?: number;
  dockerAccessibleBridge?: boolean;
}

export interface ExperienceReplayProductRuntimeHandle {
  scope: AsyncResourceScope;
  root: string;
  koedHome: string;
  codexHome: string;
  environment: NodeJS.ProcessEnv;
  redis: TrialRedisHandle;
  api: ProductApiHandle;
  runtime: LocalAiRuntimeHandle;
  runtimeClient: LocalAiRuntimeClient;
  bridge: BenchmarkBridgeHandle;
  activateBridgeCredential(): void;
  close(): Promise<CleanupAttestation>;
}

const positiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
};

const assertApiToken = (value: string): void => {
  if (!value.trim() || /[\r\n]/.test(value)) {
    throw new Error("Experience Replay API Token is invalid");
  }
};

const assertIsolatedRedisUrl = (value: string): void => {
  const parsed = new URL(value);
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("Experience Replay Redis must use the Redis protocol");
  }
  const addressOnly = new URL(parsed);
  addressOnly.username = "";
  addressOnly.password = "";
  assertLoopbackUrl(addressOnly.href, "Experience Replay Redis");
  if (!parsed.password) {
    throw new Error("Experience Replay Redis must require authentication");
  }
};

const mergeEnvironment = (
  target: NodeJS.ProcessEnv,
  source: Readonly<Record<string, string>> | undefined
): void => {
  if (!source) return;
  for (const [name, value] of Object.entries(source)) target[name] = value;
};

const defaultStartApi: ProductRuntimeDependencies["startApi"] = (input) =>
  startProductApiProcess({
    environment: input.environment,
    signal: input.signal
  });

const defaultDependencies: ProductRuntimeDependencies = {
  startRedis: () => startTrialRedis(),
  startEmbeddingService: () => Promise.resolve(undefined),
  startAppServer: () => Promise.resolve(undefined),
  startApi: defaultStartApi,
  startRuntime: (options) => startLocalAiRuntime(options),
  createRuntimeClient: (environment) => new LocalAiRuntimeClient(environment),
  startBridge: (input) => startBenchmarkBridge(input)
};

/**
 * Starts the complete single-trial product path. It deliberately exposes the
 * real product handles so the coordinator can import through the API, inspect
 * repository-backed state, and drive recall only through the benchmark MCP
 * bridge. It never writes Memory Events or substitutes memory_answer.
 */
export const startExperienceReplayProductRuntime = async (
  options: StartExperienceReplayProductRuntimeOptions
): Promise<ExperienceReplayProductRuntimeHandle> => {
  assertEvalDatabaseUrl(options.databaseUrl);
  assertApiToken(options.apiToken);
  const credentialLifetimeMs = options.bridgeCredentialLifetimeMs ?? 300_000;
  positiveInteger(credentialLifetimeMs, "Bridge credential lifetime");
  const scope =
    options.scope ?? new AsyncResourceScope({ scopeId: options.scopeId });
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const prefix = `product-runtime:${options.identity.trialId}`;

  try {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-replay-product-"));
    await chmod(root, 0o700);
    const koedHome = path.join(root, "koed-home");
    const codexHome = path.join(root, "codex-home");
    await Promise.all([
      mkdir(koedHome, { recursive: true, mode: 0o700 }),
      mkdir(codexHome, { recursive: true, mode: 0o700 })
    ]);
    if (options.codexAuthJsonPath) {
      const destination = path.join(codexHome, "auth.json");
      await copyFile(options.codexAuthJsonPath, destination);
      await chmod(destination, 0o600);
    }
    scope.register(`${prefix}:homes`, () =>
      rm(root, { recursive: true, force: true })
    );

    const redis = await dependencies.startRedis();
    assertIsolatedRedisUrl(redis.url);
    scope.register(`${prefix}:redis`, () => redis.close());

    const environment: NodeJS.ProcessEnv = {
      ...options.environment,
      NODE_ENV: options.environment?.NODE_ENV ?? "test",
      DATABASE_URL: options.databaseUrl,
      REDIS_URL: redis.url,
      RATE_LIMIT_REDIS_URL: redis.url,
      CACHE_REDIS_URL: redis.url,
      API_TOKEN_PEPPER:
        options.environment?.API_TOKEN_PEPPER ??
        randomBytes(32).toString("hex"),
      KOED_HOME: koedHome,
      CODEX_HOME: codexHome,
      MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED: "false"
    };

    const embedding = await dependencies.startEmbeddingService({
      root,
      environment
    });
    if (embedding) {
      mergeEnvironment(environment, embedding.environment);
      scope.register(`${prefix}:embedding-service`, () => embedding.close());
    }
    const appServer = await dependencies.startAppServer({ root, environment });
    if (appServer) {
      mergeEnvironment(environment, appServer.environment);
      scope.register(`${prefix}:app-server`, () => appServer.close());
    }

    const api = await dependencies.startApi({
      databaseUrl: options.databaseUrl,
      redisUrl: redis.url,
      environment,
      signal: scope.signal
    });
    assertLoopbackUrl(api.url, "Experience Replay Koed API");
    scope.register(`${prefix}:api`, async () => {
      await api.close();
    });
    environment.MEMORY_API_URL = api.url;
    environment.MEMORY_API_TOKEN = options.apiToken;

    const runtime = await dependencies.startRuntime({ environment });
    assertLoopbackUrl(runtime.url, "Experience Replay Local AI Runtime");
    scope.register(`${prefix}:local-ai-runtime`, () => runtime.close());
    const runtimeClient = dependencies.createRuntimeClient(environment);
    await runtimeClient.capabilities();

    const bridge = await dependencies.startBridge({
      runtimeClient,
      projectCwd: options.projectCwd,
      trialWorkspaceRoot: options.trialWorkspaceRoot,
      identity: options.identity,
      dockerAccess: options.dockerAccessibleBridge ?? false
    });
    assertLoopbackUrl(bridge.url, "Experience Replay benchmark bridge");
    scope.registerCredentialRevocation(`${prefix}:bridge-credential`, () => {
      bridge.revoke();
    });
    scope.register(`${prefix}:bridge`, () => bridge.close());
    let bridgeActivated = false;

    return {
      scope,
      root,
      koedHome,
      codexHome,
      environment,
      redis,
      api,
      runtime,
      runtimeClient,
      bridge,
      activateBridgeCredential() {
        if (bridgeActivated) {
          throw new Error("Benchmark bridge credential is already active");
        }
        bridge.activate(credentialLifetimeMs);
        bridgeActivated = true;
      },
      close: () => scope.close()
    };
  } catch (error) {
    try {
      await scope.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Experience Replay product runtime startup and cleanup failed",
        { cause: cleanupError }
      );
    }
    throw error;
  }
};
