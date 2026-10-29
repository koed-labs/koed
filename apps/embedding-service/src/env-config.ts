import { cpus } from "node:os";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveSupportedEmbeddingModelConfig } from "@koed/shared";
import type { AccelerationPolicy } from "./acceleration.js";

export interface SupportedEmbeddingModel {
  key: string;
  repo: string;
  file: string;
  dimensions: number;
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
  embeddingAccelerationPolicy: AccelerationPolicy;
  embeddingAccelerationDevice: string | null;
  embeddingGpuIdleUnloadSeconds: number;
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

  embeddingServiceToken: string;
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

export const DEFAULT_EMBEDDING_MODEL_KEY = "qwen3-0.6b";
export const DEFAULT_EMBEDDING_MAX_TOKENS = 4096;
export const DEFAULT_LLAMA_N_CTX = 8192;
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

const accelerationPolicy = (
  value: string | undefined,
  name: string,
  defaultPolicy: AccelerationPolicy = "auto"
): AccelerationPolicy => {
  const normalized = value?.trim().toLowerCase() || defaultPolicy;
  if (!["auto", "cpu", "metal", "cuda"].includes(normalized)) {
    throw new Error(`${name} must be auto, cpu, metal, or cuda`);
  }
  return normalized as AccelerationPolicy;
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

const nonNegativeIntAlias = (
  environment: NodeJS.ProcessEnv,
  names: string[],
  fallback: number
): number => {
  for (const name of names) {
    const value = environment[name];
    if (value === undefined || value.trim() === "") continue;
    if (!/^\d+$/.test(value.trim())) {
      throw new Error(`${name} must be a non-negative integer`);
    }
    const parsed = Number(value.trim());
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`${name} must be a non-negative integer`);
    }
    return parsed;
  }
  return fallback;
};

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

  const llamaNCtx = Math.min(
    intAlias(
      environment,
      ["LLAMA_N_CTX", "EMBEDDING_LLAMA_N_CTX"],
      DEFAULT_LLAMA_N_CTX
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

  const embeddingServerPort = intAlias(
    environment,
    ["LLAMA_EMBEDDING_SERVER_PORT", "EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT"],
    18080
  );

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
    embeddingAccelerationPolicy: accelerationPolicy(
      environment.KOED_EMBEDDING_ACCELERATION,
      "KOED_EMBEDDING_ACCELERATION"
    ),
    embeddingAccelerationDevice:
      trim(environment.KOED_EMBEDDING_DEVICE) ?? null,
    embeddingGpuIdleUnloadSeconds: nonNegativeIntAlias(
      environment,
      ["KOED_EMBEDDING_GPU_IDLE_UNLOAD_SECONDS"],
      300
    ),
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
    // Embedding past conversations can run for hours. Using every core made
    // the whole computer (and Koed's own replies) sluggish meanwhile, so by
    // default it uses half of them, at most four.
    llamaNThreads: intAlias(
      environment,
      ["LLAMA_N_THREADS", "EMBEDDING_LLAMA_N_THREADS"],
      Math.max(1, Math.min(4, Math.floor(cpuCount / 2)))
    ),
    llamaNBatch,
    llamaBatchTokenHeadroom,
    llamaNUbatch: intAlias(
      environment,
      ["LLAMA_N_UBATCH", "EMBEDDING_LLAMA_N_UBATCH"],
      512
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

    embeddingServiceToken: environment.EMBEDDING_SERVICE_TOKEN?.trim() ?? "",
    runtimeVersion:
      trim(environment.KOED_EMBEDDING_RUNTIME_VERSION) ?? "unknown",
    logLevel:
      firstEnv(environment, ["LOG_LEVEL", "EMBEDDING_LOG_LEVEL"]) ?? "info"
  };
};
