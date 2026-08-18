import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createKoedEmbeddingServiceProvider,
  resolveKoedEmbeddingServiceReproducibility
} from "./arms.js";
import { createAppServerRewriteProvider } from "./judge.js";
import { createKoedRuntimeProductProvider } from "./product-harness.js";
import { createOnDemandDatabaseLiveProductStateReader } from "./live-product-fixture.js";
import { runProductAuthorizationHarness } from "./authorization-harness.js";
import { runRetrievalArena } from "./runner.js";

export * from "./arms.js";
export * from "./cases.js";
export * from "./contracts.js";
export * from "./judge.js";
export * from "./metrics.js";
export * from "./runner.js";
export * from "./product-harness.js";
export * from "./authorization-harness.js";
export * from "./live-product-fixture.js";
export * from "./scale-runner.js";

const values = (name: string): string[] => {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
};

const has = (name: string): boolean =>
  process.argv.slice(2).includes(`--${name}`);

const optionalNumber = (value: string | undefined): number | undefined => {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid non-negative numeric value: ${value}`);
  }
  return parsed;
};

export const resolveArenaModelPricing = (
  environment: NodeJS.ProcessEnv = process.env
): Record<
  "reader" | "judge" | "rewrite" | "product",
  { input?: number; output?: number }
> => {
  const fallbackInput = optionalNumber(
    environment.KOED_EVAL_INPUT_PRICE_PER_MILLION_USD
  );
  const fallbackOutput = optionalNumber(
    environment.KOED_EVAL_OUTPUT_PRICE_PER_MILLION_USD
  );
  return Object.fromEntries(
    (["reader", "judge", "rewrite", "product"] as const).map((role) => [
      role,
      {
        input:
          optionalNumber(
            environment[
              `KOED_EVAL_${role.toUpperCase()}_INPUT_PRICE_PER_MILLION_USD`
            ]
          ) ?? fallbackInput,
        output:
          optionalNumber(
            environment[
              `KOED_EVAL_${role.toUpperCase()}_OUTPUT_PRICE_PER_MILLION_USD`
            ]
          ) ?? fallbackOutput
      }
    ])
  ) as Record<
    "reader" | "judge" | "rewrite" | "product",
    { input?: number; output?: number }
  >;
};

export const createArenaModelDescriptor = (options: {
  provider: string;
  config: { model: string; reasoningEffort: string };
  prefix: string;
  env?: NodeJS.ProcessEnv;
  inputPricePerMillionTokensUsd?: number;
  outputPricePerMillionTokensUsd?: number;
}) => {
  const environment = options.env ?? process.env;
  return {
    provider: options.provider,
    model: options.config.model,
    artifact: environment[`${options.prefix}_ARTIFACT`] ?? null,
    artifactRevision:
      environment[`${options.prefix}_ARTIFACT_REVISION`] ?? null,
    artifactHash: environment[`${options.prefix}_ARTIFACT_HASH`] ?? null,
    dimensions: null,
    tokenizer: environment[`${options.prefix}_TOKENIZER`] ?? null,
    tokenizerRevision:
      environment[`${options.prefix}_TOKENIZER_REVISION`] ?? null,
    reasoningEffort: options.config.reasoningEffort,
    inputPricePerMillionTokensUsd:
      options.inputPricePerMillionTokensUsd ?? null,
    outputPricePerMillionTokensUsd:
      options.outputPricePerMillionTokensUsd ?? null,
    acceleration:
      environment[`${options.prefix}_ACCELERATION`]?.trim() ||
      environment.KOED_EVAL_ACCELERATION?.trim() ||
      null
  };
};

const main = async (): Promise<void> => {
  const embeddingBaseUrl = process.env.KOED_EVAL_EMBEDDING_SERVICE_URL?.trim();
  const selectedLayers = values("layer") as Array<
    "retrieval_only" | "fixed_reader" | "product"
  >;
  const selectedSplits = values("split") as Array<
    "development" | "validation" | "held_out"
  >;
  const selectedCases = values("case");
  const selectedArms = values("arm");
  const appServerBinary =
    values("codex")[0] ?? process.env.MEMORY_CODEX_APP_SERVER_BINARY ?? "codex";
  const cwd = values("cwd")[0] ?? process.cwd();
  const timeoutMs = Number(values("model-timeout-ms")[0] ?? "120000");
  const modelConfig = (role: "reader" | "judge" | "rewrite") => ({
    appServerBinary,
    model:
      values(`${role}-model`)[0] ??
      process.env[`KOED_EVAL_${role.toUpperCase()}_MODEL`] ??
      "gpt-5.4-mini",
    reasoningEffort:
      values(`${role}-reasoning-effort`)[0] ??
      process.env[`KOED_EVAL_${role.toUpperCase()}_REASONING_EFFORT`] ??
      "medium",
    timeoutMs,
    cwd,
    env: process.env
  });
  const readerConfig = modelConfig("reader");
  const judgeConfig = modelConfig("judge");
  const rewriteConfig = modelConfig("rewrite");
  const rewriteProvider = createAppServerRewriteProvider(rewriteConfig);
  const authorization = process.env.KOED_EVAL_PRODUCT_AUTHORIZATION?.trim();
  const productBaseUrl = process.env.KOED_EVAL_PRODUCT_API_URL?.trim();
  const productStateManifestPath =
    process.env.KOED_EVAL_PRODUCT_STATE_MANIFEST?.trim();
  const productDatabaseUrl = process.env.KOED_EVAL_PRODUCT_DATABASE_URL?.trim();
  const liveStateReader = productDatabaseUrl
    ? createOnDemandDatabaseLiveProductStateReader({
        databaseUrl: productDatabaseUrl
      })
    : undefined;
  if (
    productBaseUrl &&
    authorization &&
    productStateManifestPath &&
    !liveStateReader
  )
    throw new Error(
      "Product Arena runs require KOED_EVAL_PRODUCT_DATABASE_URL for independent live-state attestation"
    );
  const inputPrice = optionalNumber(
    process.env.KOED_EVAL_INPUT_PRICE_PER_MILLION_USD
  );
  const outputPrice = optionalNumber(
    process.env.KOED_EVAL_OUTPUT_PRICE_PER_MILLION_USD
  );
  const modelPricing = resolveArenaModelPricing(process.env);
  const retrievalLayerSelected =
    selectedLayers.length === 0 ||
    selectedLayers.some((layer) => layer !== "product");
  const rerankerSelected =
    retrievalLayerSelected &&
    (selectedArms.length === 0 || selectedArms.includes("qwen-0.6b-reranked"));
  const embeddingReproducibility = embeddingBaseUrl
    ? await resolveKoedEmbeddingServiceReproducibility({
        baseUrl: embeddingBaseUrl,
        token: process.env.EMBEDDING_SERVICE_TOKEN,
        model: process.env.KOED_EVAL_EMBEDDING_MODEL,
        strict: has("strict-providers"),
        requireReranker: rerankerSelected
      })
    : undefined;
  const embeddingProvider = embeddingBaseUrl
    ? createKoedEmbeddingServiceProvider({
        baseUrl: embeddingBaseUrl,
        token: process.env.EMBEDDING_SERVICE_TOKEN,
        model: process.env.KOED_EVAL_EMBEDDING_MODEL,
        dimensions: optionalNumber(process.env.KOED_EVAL_EMBEDDING_DIMENSIONS),
        batchLimit: embeddingReproducibility?.batchLimit,
        reranker: embeddingReproducibility?.reranker
      })
    : undefined;
  const descriptor = (
    provider: string,
    config: ReturnType<typeof modelConfig>,
    prefix: string,
    prices: { input?: number; output?: number }
  ) =>
    createArenaModelDescriptor({
      provider,
      config,
      prefix,
      inputPricePerMillionTokensUsd: prices.input,
      outputPricePerMillionTokensUsd: prices.output
    });
  const report = await runRetrievalArena({
    embeddingProvider,
    rewriteProvider,
    productProvider:
      productBaseUrl && authorization && productStateManifestPath
        ? createKoedRuntimeProductProvider({
            baseUrl: productBaseUrl,
            authorization,
            productStateManifestPath,
            ...(liveStateReader ? { liveStateReader } : {}),
            embeddingProvider,
            rewriteProvider,
            ...(process.env.KOED_EVAL_NO_LEXICAL_PRODUCT_API_URL?.trim() &&
            process.env.KOED_EVAL_NO_LEXICAL_PRODUCT_AUTHORIZATION?.trim()
              ? {
                  noLexicalAnchorsRuntime: {
                    baseUrl:
                      process.env.KOED_EVAL_NO_LEXICAL_PRODUCT_API_URL.trim(),
                    authorization:
                      process.env.KOED_EVAL_NO_LEXICAL_PRODUCT_AUTHORIZATION.trim(),
                    indexManifestPath:
                      process.env.KOED_EVAL_NO_LEXICAL_INDEX_MANIFEST?.trim() ??
                      ""
                  }
                }
              : {}),
            worker: {
              executablePath: appServerBinary,
              model: process.env.KOED_EVAL_PRODUCT_MODEL ?? readerConfig.model,
              reasoningEffort:
                process.env.KOED_EVAL_PRODUCT_REASONING_EFFORT ??
                readerConfig.reasoningEffort,
              timeoutMs,
              cwd,
              env: process.env
            }
          })
        : undefined,
    readerConfig,
    judgeConfig,
    layers: selectedLayers.length ? selectedLayers : ["retrieval_only"],
    splits: selectedSplits.length ? selectedSplits : undefined,
    caseIds: selectedCases.length ? selectedCases : undefined,
    armIds: selectedArms.length ? selectedArms : undefined,
    runs: Number(values("runs")[0] ?? "1"),
    runNumber: Number(values("run-number")[0] ?? "1"),
    strictProviders: has("strict-providers"),
    costPerMillionInputTokensUsd: inputPrice,
    costPerMillionOutputTokensUsd: outputPrice,
    modelPricing,
    modelMetadata: {
      reader: descriptor(
        "codex-app-server",
        readerConfig,
        "KOED_EVAL_READER",
        modelPricing.reader
      ),
      judge: descriptor(
        "codex-app-server",
        judgeConfig,
        "KOED_EVAL_JUDGE",
        modelPricing.judge
      ),
      rewrite: descriptor(
        "codex-app-server",
        rewriteConfig,
        "KOED_EVAL_REWRITE",
        modelPricing.rewrite
      ),
      ...(embeddingBaseUrl
        ? {
            embedding: {
              ...descriptor(
                "koed-embedding-service",
                {
                  ...rewriteConfig,
                  model: embeddingProvider!.model,
                  reasoningEffort: "none"
                },
                "KOED_EVAL_EMBEDDING",
                {}
              ),
              dimensions: embeddingReproducibility!.dimensions,
              artifact: embeddingReproducibility!.artifact,
              artifactRevision: embeddingReproducibility!.artifactRevision,
              artifactHash: embeddingReproducibility!.artifactHash,
              tokenizer: embeddingReproducibility!.tokenizer,
              tokenizerRevision: embeddingReproducibility!.tokenizerRevision,
              acceleration: embeddingReproducibility!.acceleration
            },
            ...(embeddingReproducibility?.reranker
              ? {
                  reranker: {
                    ...descriptor(
                      "koed-embedding-service",
                      {
                        ...rewriteConfig,
                        model:
                          embeddingReproducibility.reranker.model ?? "unknown",
                        reasoningEffort: "none"
                      },
                      "KOED_EVAL_RERANKER",
                      {}
                    ),
                    artifact: embeddingReproducibility.reranker.artifact,
                    artifactRevision:
                      embeddingReproducibility.reranker.artifactRevision,
                    artifactHash: embeddingReproducibility.reranker.artifactHash
                  }
                }
              : {})
          }
        : {}),
      ...(productBaseUrl
        ? {
            productWorker: descriptor(
              "koed-runtime-memory-answer",
              {
                ...readerConfig,
                model:
                  process.env.KOED_EVAL_PRODUCT_MODEL ?? readerConfig.model,
                reasoningEffort:
                  process.env.KOED_EVAL_PRODUCT_REASONING_EFFORT ??
                  readerConfig.reasoningEffort
              },
              "KOED_EVAL_PRODUCT",
              modelPricing.product
            )
          }
        : {})
    }
  });
  const authorizationManifest = values("authorization-manifest")[0];
  const authorizationReport = authorizationManifest
    ? await runProductAuthorizationHarness({
        manifestPath: authorizationManifest,
        baseUrl: productBaseUrl
      })
    : undefined;
  const output = `${JSON.stringify(
    authorizationReport
      ? { ...report, authorization: authorizationReport }
      : report,
    null,
    2
  )}\n`;
  const outputPath = values("output")[0];
  if (outputPath) {
    const absolute = resolve(outputPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, output, "utf8");
    process.stdout.write(`${absolute}\n`);
  } else {
    process.stdout.write(output);
  }
  if (report.results.some((result) => result.status === "failed"))
    process.exitCode = 1;
  if (authorizationReport && !authorizationReport.passed) process.exitCode = 1;
};

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
