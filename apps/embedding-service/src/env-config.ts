import { cpus } from "node:os";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveSupportedEmbeddingModelConfig } from "@koed/shared";

export interface SupportedEmbeddingModel {
  key: string;
  repo: string;
  file: string;
  dimensions: number;
}

export interface SupportedRerankerModel {
  key: string;
  repo: string;
  file: string;
}

export interface EmbeddingServiceEnv {
  host: string;
  port: number;
  modelKey: string;
  modelRepo: string;
  modelFile: string;
  modelPath: string | null;
  modelName: string;
  modelArtifact: string;
  modelArtifactRevision: string;
  modelArtifactSha256: string;
  modelTokenizer: string;
  modelTokenizerRevision: string;
  modelAcceleration: string;
  expectedDimensions: number;
  batchLimit: number;
  llamaNCtx: number;
  embeddingMaxTokens: number;
  embeddingMaxTextChars: number;
  embeddingMaxRequestChars: number;
  llamaNThreads: number;
  llamaNBatch: number;
  llamaBatchTokenHeadroom: number;
  llamaNUbatch: number;
  llamaParallel: number;
  llamaServerBinary: string;
  llamaServerStartupTimeoutSeconds: number;
  embeddingServerPort: number;
  rerankerKey: string | null;
  rerankerRepo: string | null;
  rerankerFile: string | null;
  rerankerModelPath: string | null;
  rerankerArtifact: string | null;
  rerankerArtifactSha256: string | null;
  rerankerServerPort: number;
  rerankerBatchLimit: number;
  rerankerContextPerSlot: number;
  rerankerNCtx: number;
  rerankerNThreads: number;
  rerankerNBatch: number;
  rerankerNUbatch: number;
  rerankerParallel: number;
  rerankerPromptCacheEnabled: boolean;
  embeddingServiceToken: string;
  backendClass: "cpu" | "metal" | "cuda" | "unknown";
  runtimeVersion: string;
  logLevel: string;
}

export const SUPPORTED_EMBEDDING_MODELS: Record<
  string,
  SupportedEmbeddingModel
> = {
  "qwen3-0.6b": {
    key: "qwen3-0.6b",
    repo: "Qwen/Qwen3-Embedding-0.6B-GGUF",
    file: "Qwen3-Embedding-0.6B-Q8_0.gguf",
    dimensions: 1024
  }
};

export const SUPPORTED_RERANKER_MODELS: Record<string, SupportedRerankerModel> =
  {
    "qwen3-reranker-0.6b": {
      key: "qwen3-reranker-0.6b",
      repo: "Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp",
      file: "Qwen3-Reranker-0.6B-Q4_K_M.gguf"
    }
  };

export const DEFAULT_EMBEDDING_MODEL_KEY = "qwen3-0.6b";
export const DEFAULT_EMBEDDING_MAX_TOKENS = 4096;
export const DEFAULT_LLAMA_BATCH_TOKEN_HEADROOM = 8;
export const DEFAULT_LLAMA_SERVER_BINARY = "/opt/llama.cpp/llama-server";
export const QWEN_OPERATIONAL_MAX_TOKENS = 32768;

const appEnvPath = fileURLToPath(new URL("../.env", import.meta.url));

const parseEnvLine = (line: string): [string, string] | null => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const separator = trimmed.indexOf("=");
  if (separator <= 0) {
    return null;
  }
  const key = trimmed.slice(0, separator).trim();
  let value = trimmed.slice(separator + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return key ? [key, value] : null;
};

export const loadEmbeddingServiceEnv = (
  path = appEnvPath,
  environment: NodeJS.ProcessEnv = process.env
): void => {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed && environment[parsed[0]] === undefined) {
      environment[parsed[0]] = parsed[1];
    }
  }
};

export const intEnv = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const boolEnv = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean
): boolean => {
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return new Set(["1", "true", "yes", "on"]).has(value.trim().toLowerCase());
};

export const strEnv = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string
): string => {
  const value = environment[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
};

const trim = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const embeddingBackendClass = (
  value: string | undefined
): EmbeddingServiceEnv["backendClass"] => {
  const normalized = value?.trim().toLowerCase() ?? "cpu";
  if (!["cpu", "metal", "cuda", "unknown"].includes(normalized)) {
    throw new Error(
      "KOED_EMBEDDING_BACKEND_CLASS must be cpu, metal, cuda, or unknown"
    );
  }
  return normalized as EmbeddingServiceEnv["backendClass"];
};

const firstEnv = (
  environment: NodeJS.ProcessEnv,
  names: string[]
): string | undefined => {
  for (const name of names) {
    const value = trim(environment[name]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
};

const optionalPathEnv = (
  environment: NodeJS.ProcessEnv,
  names: string[]
): string | null => firstEnv(environment, names) ?? null;

const intAlias = (
  environment: NodeJS.ProcessEnv,
  names: string[],
  fallback: number
): number => {
  for (const name of names) {
    const value = environment[name];
    if (value !== undefined && value.trim() !== "") {
      return intEnv(environment, name, fallback);
    }
  }
  return fallback;
};

const boolAlias = (
  environment: NodeJS.ProcessEnv,
  names: string[],
  fallback: boolean
): boolean => {
  for (const name of names) {
    const value = environment[name];
    if (value !== undefined && value.trim() !== "") {
      return boolEnv(environment, name, fallback);
    }
  }
  return fallback;
};

const rerankerKeyFromEnv = (
  environment: NodeJS.ProcessEnv
): string | undefined =>
  Object.prototype.hasOwnProperty.call(environment, "RERANKER_KEY")
    ? environment.RERANKER_KEY?.trim()
    : firstEnv(environment, ["EMBEDDING_RERANKER_KEY"]);

export const rerankerEnabled = (config: EmbeddingServiceEnv): boolean =>
  config.rerankerRepo !== null || config.rerankerModelPath !== null;

export const verifyEmbeddingModelArtifact = async (
  config: Pick<
    EmbeddingServiceEnv,
    "modelPath" | "modelFile" | "modelArtifactSha256"
  >
): Promise<void> => {
  const modelPath = config.modelPath ?? `/models/${config.modelFile}`;
  const actualArtifactSha256 = await sha256File(modelPath);
  if (actualArtifactSha256 !== config.modelArtifactSha256) {
    throw new Error(
      `embedding model artifact SHA-256 mismatch: configured ${config.modelArtifactSha256}, actual ${actualArtifactSha256}`
    );
  }
};

export const sha256File = async (path: string): Promise<string> => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
};

export const verifyRerankerModelArtifact = async (
  config: Pick<
    EmbeddingServiceEnv,
    "rerankerModelPath" | "rerankerArtifactSha256"
  >
): Promise<string> => {
  if (!config.rerankerModelPath || !config.rerankerArtifactSha256) {
    throw new Error(
      "enabled reranker requires a model path and expected artifact SHA-256"
    );
  }
  const actualArtifactSha256 = await sha256File(config.rerankerModelPath);
  if (actualArtifactSha256 !== config.rerankerArtifactSha256) {
    throw new Error(
      `reranker model artifact SHA-256 mismatch: configured ${config.rerankerArtifactSha256}, actual ${actualArtifactSha256}`
    );
  }
  return actualArtifactSha256;
};

export const rerankerModel = (config: EmbeddingServiceEnv): string | null => {
  if (config.rerankerKey === null) {
    return null;
  }
  if (config.rerankerModelPath !== null) {
    return config.rerankerModelPath;
  }
  if (config.rerankerRepo !== null && config.rerankerFile !== null) {
    return `${config.rerankerRepo}:${config.rerankerFile}`;
  }
  return config.rerankerKey;
};

export const resolveEnv = (
  environment: NodeJS.ProcessEnv = process.env
): EmbeddingServiceEnv => {
  const modelKey =
    firstEnv(environment, [
      "MODEL_KEY",
      "EMBEDDING_MODEL_KEY",
      "EMBEDDING_MODEL"
    ]) ?? DEFAULT_EMBEDDING_MODEL_KEY;
  const modelConfig = SUPPORTED_EMBEDDING_MODELS[modelKey];
  if (!modelConfig) {
    throw new Error(
      `Unsupported MODEL_KEY ${JSON.stringify(
        modelKey
      )}. Supported model keys: ${Object.keys(SUPPORTED_EMBEDDING_MODELS)
        .sort()
        .join(", ")}`
    );
  }
  const canonicalModel = resolveSupportedEmbeddingModelConfig(modelKey);
  const configuredArtifactSha256 =
    firstEnv(environment, [
      "MODEL_ARTIFACT_SHA256",
      "EMBEDDING_MODEL_ARTIFACT_SHA256",
      "KOED_EMBEDDING_MODEL_SHA256"
    ]) ?? canonicalModel.defaultArtifactSha256;
  if (!/^[a-f0-9]{64}$/i.test(configuredArtifactSha256)) {
    throw new Error(
      "embedding model artifact SHA-256 must be 64 hex characters"
    );
  }

  const rerankerKey = rerankerKeyFromEnv(environment) ?? "";
  const rerankerModelPath = optionalPathEnv(environment, [
    "RERANKER_MODEL_PATH",
    "EMBEDDING_RERANKER_MODEL_PATH",
    "KOED_RERANKER_MODEL_PATH"
  ]);
  const rerankerConfig = rerankerKey
    ? SUPPORTED_RERANKER_MODELS[rerankerKey]
    : undefined;
  if (rerankerKey && !rerankerConfig) {
    throw new Error(
      `Unsupported RERANKER_KEY ${JSON.stringify(
        rerankerKey
      )}. Supported model keys: ${Object.keys(SUPPORTED_RERANKER_MODELS)
        .sort()
        .join(", ")}`
    );
  }
  if (!rerankerKey && rerankerModelPath) {
    throw new Error(
      "RERANKER_MODEL_PATH requires a supported RERANKER_KEY for model identity"
    );
  }
  const configuredRerankerArtifactSha256 = firstEnv(environment, [
    "RERANKER_ARTIFACT_SHA256",
    "EMBEDDING_RERANKER_ARTIFACT_SHA256",
    "KOED_RERANKER_MODEL_SHA256"
  ]);
  if (rerankerConfig && !configuredRerankerArtifactSha256) {
    throw new Error(
      "enabled reranker requires KOED_RERANKER_MODEL_SHA256 (or RERANKER_ARTIFACT_SHA256)"
    );
  }
  if (
    configuredRerankerArtifactSha256 &&
    !/^[a-f0-9]{64}$/i.test(configuredRerankerArtifactSha256)
  ) {
    throw new Error("reranker artifact SHA-256 must be 64 hex characters");
  }

  const llamaNCtx = Math.min(
    intAlias(
      environment,
      ["LLAMA_N_CTX", "EMBEDDING_LLAMA_N_CTX"],
      QWEN_OPERATIONAL_MAX_TOKENS
    ),
    QWEN_OPERATIONAL_MAX_TOKENS
  );
  const llamaNBatch = intAlias(
    environment,
    ["LLAMA_N_BATCH", "EMBEDDING_LLAMA_N_BATCH"],
    8192
  );
  const llamaBatchTokenHeadroom = intAlias(
    environment,
    ["LLAMA_BATCH_TOKEN_HEADROOM", "EMBEDDING_LLAMA_BATCH_TOKEN_HEADROOM"],
    DEFAULT_LLAMA_BATCH_TOKEN_HEADROOM
  );
  const embeddingMaxTokens = Math.max(
    1,
    Math.min(
      intAlias(
        environment,
        ["EMBEDDING_MAX_TOKENS"],
        DEFAULT_EMBEDDING_MAX_TOKENS
      ),
      llamaNCtx,
      llamaNBatch - llamaBatchTokenHeadroom
    )
  );
  const rerankerContextPerSlot = Math.min(
    intAlias(
      environment,
      ["RERANKER_CONTEXT_PER_SLOT", "EMBEDDING_RERANKER_CONTEXT_PER_SLOT"],
      8192
    ),
    QWEN_OPERATIONAL_MAX_TOKENS
  );
  const rerankerParallel = intAlias(
    environment,
    ["RERANKER_PARALLEL", "EMBEDDING_RERANKER_PARALLEL"],
    4
  );
  const rerankerNCtx = Math.min(
    intAlias(
      environment,
      ["RERANKER_LLAMA_N_CTX", "EMBEDDING_RERANKER_LLAMA_N_CTX"],
      rerankerContextPerSlot * rerankerParallel
    ),
    QWEN_OPERATIONAL_MAX_TOKENS * rerankerParallel
  );
  const rerankerNBatch = intAlias(
    environment,
    ["RERANKER_LLAMA_N_BATCH", "EMBEDDING_RERANKER_LLAMA_N_BATCH"],
    rerankerContextPerSlot
  );
  const embeddingServerPort = intAlias(
    environment,
    ["LLAMA_EMBEDDING_SERVER_PORT", "EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT"],
    18080
  );
  const rerankerServerPort = intAlias(
    environment,
    ["LLAMA_RERANKER_SERVER_PORT", "EMBEDDING_LLAMA_RERANKER_SERVER_PORT"],
    18081
  );
  if (embeddingServerPort === rerankerServerPort) {
    throw new Error(
      "LLAMA_EMBEDDING_SERVER_PORT and LLAMA_RERANKER_SERVER_PORT must differ"
    );
  }

  const cpuCount = cpus().length || 1;
  return {
    host:
      firstEnv(environment, [
        "KOED_EMBEDDING_HOST",
        "EMBEDDING_SERVICE_HOST",
        "HOST"
      ]) ?? "127.0.0.1",
    port: intAlias(
      environment,
      [
        "KOED_EMBEDDING_PORT",
        "EMBEDDING_SERVICE_PORT",
        "EMBEDDING_SERVICE_HOST_PORT",
        "PORT"
      ],
      3800
    ),
    modelKey: modelConfig.key,
    modelRepo: modelConfig.repo,
    modelFile: modelConfig.file,
    modelPath: optionalPathEnv(environment, [
      "MODEL_PATH",
      "EMBEDDING_MODEL_PATH",
      "KOED_EMBEDDING_MODEL_PATH"
    ]),
    modelName: modelConfig.key,
    modelArtifact:
      firstEnv(environment, [
        "MODEL_ARTIFACT",
        "EMBEDDING_MODEL_ARTIFACT",
        "KOED_EMBEDDING_MODEL_URL"
      ]) ?? canonicalModel.artifact,
    modelArtifactRevision:
      firstEnv(environment, [
        "MODEL_ARTIFACT_REVISION",
        "EMBEDDING_MODEL_ARTIFACT_REVISION"
      ]) ?? canonicalModel.artifactRevision,
    modelArtifactSha256: configuredArtifactSha256.toLowerCase(),
    modelTokenizer: canonicalModel.tokenizer,
    modelTokenizerRevision: canonicalModel.tokenizerRevision,
    modelAcceleration: canonicalModel.acceleration,
    expectedDimensions: modelConfig.dimensions,
    batchLimit: intAlias(environment, ["EMBEDDING_BATCH_LIMIT"], 16),
    llamaNCtx,
    embeddingMaxTokens,
    embeddingMaxTextChars: intAlias(
      environment,
      ["EMBEDDING_MAX_TEXT_CHARS"],
      200000
    ),
    embeddingMaxRequestChars: intAlias(
      environment,
      ["EMBEDDING_MAX_REQUEST_CHARS"],
      1000000
    ),
    llamaNThreads: intAlias(
      environment,
      ["LLAMA_N_THREADS", "EMBEDDING_LLAMA_N_THREADS"],
      cpuCount
    ),
    llamaNBatch,
    llamaBatchTokenHeadroom,
    llamaNUbatch: intAlias(
      environment,
      ["LLAMA_N_UBATCH", "EMBEDDING_LLAMA_N_UBATCH"],
      llamaNBatch
    ),
    llamaParallel: intAlias(
      environment,
      ["LLAMA_PARALLEL", "EMBEDDING_LLAMA_PARALLEL"],
      1
    ),
    llamaServerBinary:
      firstEnv(environment, [
        "LLAMA_SERVER_BINARY",
        "EMBEDDING_LLAMA_SERVER_BINARY",
        "KOED_EMBEDDING_LLAMA_SERVER_BIN"
      ]) ?? DEFAULT_LLAMA_SERVER_BINARY,
    llamaServerStartupTimeoutSeconds: intAlias(
      environment,
      [
        "LLAMA_SERVER_STARTUP_TIMEOUT_SECONDS",
        "EMBEDDING_LLAMA_SERVER_STARTUP_TIMEOUT_SECONDS"
      ],
      180
    ),
    embeddingServerPort,
    rerankerKey: rerankerConfig?.key ?? null,
    rerankerRepo: rerankerConfig?.repo ?? null,
    rerankerFile: rerankerConfig?.file ?? null,
    rerankerModelPath,
    rerankerArtifact: rerankerConfig
      ? (firstEnv(environment, [
          "RERANKER_ARTIFACT",
          "EMBEDDING_RERANKER_ARTIFACT",
          "KOED_RERANKER_MODEL_URL"
        ]) ?? `${rerankerConfig.repo}:${rerankerConfig.file}`)
      : null,
    rerankerArtifactSha256:
      rerankerConfig && configuredRerankerArtifactSha256
        ? configuredRerankerArtifactSha256.toLowerCase()
        : null,
    rerankerServerPort,
    rerankerBatchLimit: intAlias(
      environment,
      ["RERANKER_BATCH_LIMIT", "EMBEDDING_RERANKER_BATCH_LIMIT"],
      100
    ),
    rerankerContextPerSlot,
    rerankerNCtx,
    rerankerNThreads: intAlias(
      environment,
      ["RERANKER_LLAMA_N_THREADS", "EMBEDDING_RERANKER_LLAMA_N_THREADS"],
      intAlias(
        environment,
        ["LLAMA_N_THREADS", "EMBEDDING_LLAMA_N_THREADS"],
        cpuCount
      )
    ),
    rerankerNBatch,
    rerankerNUbatch: intAlias(
      environment,
      ["RERANKER_LLAMA_N_UBATCH", "EMBEDDING_RERANKER_LLAMA_N_UBATCH"],
      rerankerNBatch
    ),
    rerankerParallel,
    rerankerPromptCacheEnabled: boolAlias(
      environment,
      [
        "RERANKER_PROMPT_CACHE_ENABLED",
        "EMBEDDING_RERANKER_PROMPT_CACHE_ENABLED"
      ],
      true
    ),
    embeddingServiceToken: environment.EMBEDDING_SERVICE_TOKEN?.trim() ?? "",
    backendClass: embeddingBackendClass(
      environment.KOED_EMBEDDING_BACKEND_CLASS
    ),
    runtimeVersion:
      trim(environment.KOED_EMBEDDING_RUNTIME_VERSION) ?? "unknown",
    logLevel:
      firstEnv(environment, ["LOG_LEVEL", "EMBEDDING_LOG_LEVEL"]) ?? "info"
  };
};
