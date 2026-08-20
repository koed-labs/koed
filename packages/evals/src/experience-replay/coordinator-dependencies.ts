import { createHash } from "node:crypto";
import { mkdir, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getLatestMigrationTimestamp } from "@koed/db";
import type { AtifSanitizationResult } from "./atif/index.js";
import type {
  ExperienceReplayCoordinatorDependencies,
  PreparedTemplate,
  ReplayExecutionHandle,
  ReplayProductPathAttestation
} from "./coordinator.js";
import type { ResolvedExperienceReplayConfig } from "./core/index.js";
import { conditionUsesKoed } from "./core/index.js";
import {
  HarborExecutionAdapter,
  type HarborExecutionAdapterOptions
} from "./harbor-execution-adapter.js";
import type { SubprocessExecutor } from "./harbor-client.js";
import {
  createLocalExperienceReplayProductAdapter,
  type LocalExperienceReplayProductAdapter,
  type LocalProductAdapterOptions,
  type LocalProductReplayProvision,
  type LocalProductTemplateHandle,
  type RecordedEmbeddingServiceOptions
} from "./local-product-adapter.js";
import {
  startExperienceReplayProductRuntime,
  type ExperienceReplayProductRuntimeHandle,
  type ProductRuntimeDependencies
} from "./product-runtime.js";
import type { CleanupAttestation } from "./resource-scope.js";
import type { ProductApiCloseAttestation } from "./product-api-process.js";
import {
  createRecordedReplayTelemetryCollector,
  registerRecordedAttemptObservation
} from "./recorded-runtime-telemetry.js";
import type {
  TrajectoryJudgeInput,
  TrajectoryJudgeResult
} from "./trajectory-judge.js";
import {
  OracleCampaignTemplateCache,
  oracleCampaignTemplateContentIdentity,
  type OracleCampaignTemplateIdentity
} from "./oracle-campaign-template-cache.js";
import type { JsonValue } from "./core/hash.js";

const sha256 = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

type HarborPort = Pick<HarborExecutionAdapter, "runSource" | "runReplay">;
type ProductPort = Pick<
  LocalExperienceReplayProductAdapter,
  "prepareTemplate" | "prepareCampaignTemplate" | "cloneForReplay"
> & {
  adoptTemplate?: LocalExperienceReplayProductAdapter["adoptTemplate"];
  withCampaignTemplateLock?: LocalExperienceReplayProductAdapter["withCampaignTemplateLock"];
  close(options?: { preserveTemplates?: boolean }): Promise<void>;
};

export interface ReplayCleanupAttestation {
  cloneId: string;
  runtime: CleanupAttestation | null;
  product: { api: ProductApiCloseAttestation } | null;
  complete: boolean;
}

export interface ConcreteExperienceReplayCoordinatorDependencies extends ExperienceReplayCoordinatorDependencies {
  /** Re-attests a persisted, credential-free frozen template after restart. */
  adoptTemplate(template: PreparedTemplate): Promise<PreparedTemplate>;
  /** Incomplete runs preserve templates; completed runs omit this flag. */
  teardown(options?: { preserveTemplates?: boolean }): Promise<void>;
  /** Completed per-replay cleanup proofs, copied so callers cannot mutate them. */
  cleanupAttestations(): readonly ReplayCleanupAttestation[];
}

export interface ExperienceReplayCoordinatorDependencyFactoryOptions {
  mode: "smoke" | "recorded";
  runId: string;
  corpusManifest: string;
  postgres: LocalProductAdapterOptions["postgres"];
  countEmbeddingTokens(text: string): number;
  smokeExecutor?: SubprocessExecutor;
  providerApiKey?: string;
  codexAuthJsonPath?: string;
  containerCodexBinary?: string;
  frozenTaskImages?: Readonly<Record<string, string>>;
  productPathProof?: boolean;
  collectReplayTelemetry?: HarborExecutionAdapterOptions["collectReplayTelemetry"];
  recordedEmbedding?: RecordedEmbeddingServiceOptions;
  productApiEnvironment?: Readonly<NodeJS.ProcessEnv>;
  productRuntimeEnvironment?: Readonly<NodeJS.ProcessEnv>;
  productRuntimeDependencies?: Partial<ProductRuntimeDependencies>;
  lcmSummaryConfig?: LocalProductAdapterOptions["lcmSummaryConfig"];
  runScheduledLcmJobs?: LocalProductAdapterOptions["runScheduledLcmJobs"];
  judgeTrajectory?: (
    input: TrajectoryJudgeInput
  ) => Promise<TrajectoryJudgeResult>;
  preparationCostUsd?: (
    template: LocalProductTemplateHandle,
    config: ResolvedExperienceReplayConfig
  ) => number;
  campaignTemplateCacheDirectory?: string;
  repositoryCommit?: string;
  campaignTemplateMaterializationSourceHash?: string;
  readinessTimeoutMs?: number;
  readinessIntervalMs?: number;
  preparationRequestTimeoutMs?: number;
  bridgeCredentialLifetimeMs?: number;
  harbor?: HarborPort;
  product?: ProductPort;
  startProductRuntime?: typeof startExperienceReplayProductRuntime;
  materializeProjectWorkspace?: (input: {
    projectCwd: string;
  }) => Promise<{ trialWorkspaceRoot: string; close(): Promise<void> }>;
}

const sourceQuartile = (taskDigest: string): 0 | 1 | 2 | 3 => {
  const digest = createHash("sha256").update(taskDigest).digest();
  return (digest[0]! % 4) as 0 | 1 | 2 | 3;
};

const normalizedProbe = (
  taskName: string,
  source: AtifSanitizationResult | null
): string => {
  const preferred = source?.normalizedItems
    .filter(
      (item) =>
        (item.type === "user_message" || item.type === "agent_message") &&
        item.content?.trim()
    )
    .at(-1)?.content;
  const fallback = source?.normalizedItems.find((item) =>
    item.content?.trim()
  )?.content;
  const compact = (preferred ?? fallback ?? `Terminal task ${taskName}`)
    .replace(/\s+/gu, " ")
    .trim();
  return compact.slice(0, 512);
};

const cachedTemplateHandle = (value: JsonValue): LocalProductTemplateHandle => {
  const candidate = value as unknown as Partial<LocalProductTemplateHandle>;
  if (
    typeof candidate.templateId !== "string" ||
    typeof candidate.sourceStateHash !== "string" ||
    !candidate.attestation ||
    typeof candidate.attestation !== "object"
  ) {
    throw new Error("Campaign template cache handle is invalid");
  }
  return candidate as LocalProductTemplateHandle;
};

const tokenFromAuthorization = (authorization: string): string => {
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  if (!match)
    throw new Error("Replay provision returned invalid authorization");
  return match[1]!;
};

const origin = (value: string): string => {
  const parsed = new URL(value);
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return parsed.origin;
};

const defaultWorkspace = async ({
  projectCwd
}: {
  projectCwd: string;
}): Promise<{ trialWorkspaceRoot: string; close(): Promise<void> }> => {
  const trialWorkspaceRoot = path.dirname(path.dirname(projectCwd));
  const relative = path.relative(trialWorkspaceRoot, projectCwd);
  if (
    !path.isAbsolute(projectCwd) ||
    !path.isAbsolute(trialWorkspaceRoot) ||
    trialWorkspaceRoot === path.parse(trialWorkspaceRoot).root ||
    !trialWorkspaceRoot.startsWith(
      `${path.join(os.tmpdir(), "koed-eval")}${path.sep}`
    ) ||
    relative.split(path.sep).length !== 2 ||
    relative.startsWith("..")
  ) {
    throw new Error("Template Project cwd cannot be safely materialized");
  }
  // A killed coordinator can leave this run-owned directory behind before its
  // resource scope closes. The journal lock prevents a concurrent resume, so
  // remove only the attested Project directory before recreating it.
  await rm(projectCwd, { recursive: true, force: true });
  await mkdir(path.dirname(projectCwd), { recursive: true, mode: 0o700 });
  // Exclusive creation proves this factory owns the directory it later removes.
  await mkdir(projectCwd, { mode: 0o700 });
  const removeIfEmpty = async (directory: string): Promise<void> => {
    try {
      await rmdir(directory);
    } catch (error) {
      if (
        !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
          (error as NodeJS.ErrnoException).code ?? ""
        )
      )
        throw error;
    }
  };
  return {
    trialWorkspaceRoot,
    async close() {
      await rm(projectCwd, { recursive: true, force: true });
      await removeIfEmpty(path.dirname(projectCwd));
      await removeIfEmpty(trialWorkspaceRoot);
      await removeIfEmpty(path.join(os.tmpdir(), "koed-eval"));
    }
  };
};

const assertFactoryOptions = (
  options: ExperienceReplayCoordinatorDependencyFactoryOptions
): void => {
  if (!options.runId.trim())
    throw new Error("Experience Replay run ID is required");
  if (options.mode === "smoke" && !options.harbor && !options.smokeExecutor) {
    throw new Error("Smoke mode requires the deterministic Harbor executor");
  }
  if (options.mode === "recorded") {
    const authenticationCount = [
      options.providerApiKey?.trim(),
      options.codexAuthJsonPath?.trim()
    ].filter(Boolean).length;
    const missing = [
      authenticationCount !== 1 && "exactly one Codex authentication source",
      !options.recordedEmbedding && "recorded Embedding Service credentials",
      !options.preparationCostUsd && "preparation cost collector",
      !options.runScheduledLcmJobs && "Local AI Runtime preparation collector",
      !options.productRuntimeDependencies?.startAppServer &&
        !options.productRuntimeEnvironment?.MEMORY_CODEX_APP_SERVER_BINARY &&
        "Local AI Runtime provider",
      !options.containerCodexBinary && "pinned container Codex binary"
    ].filter(Boolean);
    if (missing.length) {
      throw new Error(
        `Recorded mode prerequisites are absent: ${missing.join(", ")}`
      );
    }
  }
};

/**
 * Wires the coordinator to the canonical local product and Harbor paths.
 * Every child receives an explicit environment object; this factory never
 * reads from or writes to process.env.
 */
export const createExperienceReplayCoordinatorDependencies = (
  options: ExperienceReplayCoordinatorDependencyFactoryOptions
): ConcreteExperienceReplayCoordinatorDependencies => {
  assertFactoryOptions(options);
  const harbor: HarborPort =
    options.harbor ??
    new HarborExecutionAdapter({
      mode: options.mode,
      corpusManifest: options.corpusManifest,
      ...(options.smokeExecutor ? { executor: options.smokeExecutor } : {}),
      ...(options.providerApiKey
        ? { providerApiKey: options.providerApiKey }
        : {}),
      ...(options.codexAuthJsonPath
        ? { codexAuthJsonPath: options.codexAuthJsonPath }
        : {}),
      ...(options.containerCodexBinary
        ? { containerCodexBinary: options.containerCodexBinary }
        : {}),
      productPathProof: options.productPathProof === true,
      ...(options.mode === "recorded"
        ? {
            collectReplayTelemetry:
              options.collectReplayTelemetry ??
              createRecordedReplayTelemetryCollector({
                authMode: "api_key",
                workflowModels: {
                  mcp_memory_answer: "unconfigured",
                  lcm_summary: "unconfigured",
                  session_title: "unconfigured"
                },
                prices: {}
              }),
            frozenTaskImages: options.frozenTaskImages
          }
        : {})
    });
  const product: ProductPort =
    options.product ??
    createLocalExperienceReplayProductAdapter({
      runId: options.runId,
      mode: options.mode,
      postgres: options.postgres,
      ...(options.recordedEmbedding
        ? { recordedEmbedding: options.recordedEmbedding }
        : {}),
      ...(options.productApiEnvironment
        ? { productApiEnvironment: { ...options.productApiEnvironment } }
        : {}),
      ...(options.lcmSummaryConfig
        ? { lcmSummaryConfig: options.lcmSummaryConfig }
        : {}),
      ...(options.runScheduledLcmJobs
        ? { runScheduledLcmJobs: options.runScheduledLcmJobs }
        : {}),
      ...(options.readinessTimeoutMs
        ? { readinessTimeoutMs: options.readinessTimeoutMs }
        : {}),
      ...(options.readinessIntervalMs
        ? { readinessIntervalMs: options.readinessIntervalMs }
        : {}),
      ...(options.preparationRequestTimeoutMs
        ? { preparationRequestTimeoutMs: options.preparationRequestTimeoutMs }
        : {})
    });
  let campaignCache: Promise<OracleCampaignTemplateCache> | undefined;
  const getCampaignCache = (): Promise<OracleCampaignTemplateCache> => {
    if (!options.campaignTemplateCacheDirectory) {
      throw new Error(
        "Recorded campaign requires a private template cache directory"
      );
    }
    campaignCache ??= OracleCampaignTemplateCache.open({
      cacheDirectory: options.campaignTemplateCacheDirectory,
      repositoryRoot: process.cwd()
    });
    return campaignCache;
  };
  const campaignIdentity = async (input: {
    corpusCollectionManifestSha256: string;
    config: ResolvedExperienceReplayConfig;
  }): Promise<OracleCampaignTemplateIdentity> => {
    if (!options.repositoryCommit?.trim()) {
      throw new Error(
        "Recorded campaign requires the clean Koed source commit"
      );
    }
    if (!options.campaignTemplateMaterializationSourceHash?.trim()) {
      throw new Error(
        "Recorded campaign requires the Koed materialization source hash"
      );
    }
    return {
      schema: "koed-oracle-campaign-template-identity-v2",
      corpusCollectionManifestSha256: input.corpusCollectionManifestSha256,
      materializationSourceHash:
        options.campaignTemplateMaterializationSourceHash,
      latestMigrationTimestamp: await getLatestMigrationTimestamp(),
      lcm: {
        model: input.config.lcm_summary.model.id,
        reasoningEffort: input.config.lcm_summary.model.reasoning_effort,
        promptVersion: input.config.lcm_summary.prompt_version,
        outputSchemaVersion: input.config.lcm_summary.output_schema_version,
        maxPromptTokens: input.config.admission.max_input_tokens_per_call
      },
      embedding: {
        model: input.config.embedding.model,
        artifactSha256: input.config.embedding.artifact_sha256,
        tokenizer: input.config.embedding.tokenizer,
        transform: input.config.embedding.transform,
        dimensions: input.config.embedding.dimensions
      }
    };
  };
  const startRuntime =
    options.startProductRuntime ?? startExperienceReplayProductRuntime;
  const materialize = options.materializeProjectWorkspace ?? defaultWorkspace;
  const openReplays = new Set<() => Promise<void>>();
  const cleanupProofs: ReplayCleanupAttestation[] = [];
  const workspaces = new Map<
    string,
    Promise<{
      trialWorkspaceRoot: string;
      refs: number;
      closeUnderlying(): Promise<void>;
    }>
  >();
  let closed = false;

  const acquireWorkspace = async (
    projectCwd: string
  ): Promise<{ trialWorkspaceRoot: string; close(): Promise<void> }> => {
    let pending = workspaces.get(projectCwd);
    if (!pending) {
      pending = materialize({ projectCwd }).then((workspace) => ({
        trialWorkspaceRoot: workspace.trialWorkspaceRoot,
        refs: 0,
        closeUnderlying: workspace.close
      }));
      workspaces.set(projectCwd, pending);
      pending.catch(() => workspaces.delete(projectCwd));
    }
    const shared = await pending;
    shared.refs += 1;
    let released = false;
    return {
      trialWorkspaceRoot: shared.trialWorkspaceRoot,
      async close() {
        if (released) return;
        released = true;
        shared.refs -= 1;
        if (shared.refs === 0) {
          workspaces.delete(projectCwd);
          await shared.closeUnderlying();
        }
      }
    };
  };

  const closeReplay = (
    provision: LocalProductReplayProvision,
    runtime: ExperienceReplayProductRuntimeHandle,
    workspace: { close(): Promise<void> }
  ): (() => Promise<void>) => {
    let promise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      promise ??= (async () => {
        let runtimeProof: CleanupAttestation | null = null;
        let productProof: { api: ProductApiCloseAttestation } | null = null;
        const failures: unknown[] = [];
        try {
          runtimeProof = await runtime.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          productProof = await provision.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await workspace.close();
        } catch (error) {
          failures.push(error);
        }
        cleanupProofs.push({
          cloneId: provision.cloneId,
          runtime: runtimeProof,
          product: productProof,
          complete: failures.length === 0
        });
        openReplays.delete(close);
        if (failures.length) {
          throw new AggregateError(
            failures,
            `Replay cleanup failed: ${provision.cloneId}`
          );
        }
      })();
      return promise;
    };
    return close;
  };

  return {
    runId: options.runId,
    ...(options.repositoryCommit
      ? { repositoryCommit: options.repositoryCommit }
      : {}),
    countEmbeddingTokens: options.countEmbeddingTokens,

    runSource: (input) =>
      harbor.runSource({
        ...input,
        sanitizedTokenQuartile: sourceQuartile(input.task.taskDigest)
      }),

    async prepareTemplate(input): Promise<PreparedTemplate> {
      if (closed) throw new Error("Experience Replay dependencies are closed");
      const sourceTaskDigest = input.sourceTask?.taskDigest ?? null;
      const prepared = await product.prepareTemplate({
        condition: input.condition,
        taskDigest: input.task.taskDigest,
        sourceTaskDigest,
        ...(sourceTaskDigest
          ? {
              sourceAttemptId:
                input.sourceAttemptId ?? `source:${sourceTaskDigest}`
            }
          : {}),
        sanitizedSource: input.sanitizedSource,
        recallQuery: normalizedProbe(input.task.name, input.sanitizedSource),
        signal: input.signal
      });
      const preparationCostUsd =
        options.mode === "smoke"
          ? 0
          : options.preparationCostUsd!(prepared, input.config);
      if (!Number.isFinite(preparationCostUsd) || preparationCostUsd < 0) {
        throw new Error("Preparation cost collector returned an invalid cost");
      }
      return { ...prepared, preparationCostUsd };
    },

    async prepareCampaignTemplate(input): Promise<PreparedTemplate> {
      if (closed) throw new Error("Experience Replay dependencies are closed");
      const sources = input.tasks.map((source) => ({
        taskDigest: source.task.taskDigest,
        corpusAttestationSha256: source.corpusAttestationSha256,
        sourceAttemptId: source.sourceAttemptId,
        sanitizedSource: source.sanitizedSource,
        recallQuery: normalizedProbe(source.task.name, source.sanitizedSource)
      }));
      if (options.mode === "smoke") {
        const prepared = await product.prepareCampaignTemplate({
          corpusCollectionManifestSha256: input.corpusCollectionManifestSha256,
          sources,
          signal: input.signal
        });
        return { ...prepared, preparationCostUsd: 0 };
      }
      if (!product.withCampaignTemplateLock || !product.adoptTemplate) {
        throw new Error(
          "Product adapter cannot safely cache campaign templates"
        );
      }
      const identity = await campaignIdentity(input);
      const contentIdentity = oracleCampaignTemplateContentIdentity(identity);
      return product.withCampaignTemplateLock(contentIdentity, async () => {
        const cache = await getCampaignCache();
        const cached = await cache.lookup(identity);
        if (cached) {
          const template = cachedTemplateHandle(cached.template);
          if (template.templateId !== cached.databaseName) {
            throw new Error(
              "Campaign template cache database and handle disagree"
            );
          }
          const adopted = await product.adoptTemplate!(
            template,
            contentIdentity
          );
          return { ...adopted, preparationCostUsd: 0 };
        }
        const prepared = await product.prepareCampaignTemplate({
          corpusCollectionManifestSha256: input.corpusCollectionManifestSha256,
          sources,
          cachedContentIdentity: contentIdentity,
          replaceOrphanedCachedTemplate: true,
          signal: input.signal
        });
        const preparationCostUsd = options.preparationCostUsd!(
          prepared,
          input.config
        );
        if (!Number.isFinite(preparationCostUsd) || preparationCostUsd < 0) {
          throw new Error(
            "Preparation cost collector returned an invalid cost"
          );
        }
        await cache.publish({
          identity,
          databaseName: prepared.templateId,
          template: JSON.parse(JSON.stringify(prepared)) as JsonValue
        });
        return { ...prepared, preparationCostUsd };
      });
    },

    async adoptTemplate(template): Promise<PreparedTemplate> {
      if (closed) throw new Error("Experience Replay dependencies are closed");
      if (!product.adoptTemplate) {
        throw new Error("Product adapter cannot re-attest persisted templates");
      }
      const adopted = await product.adoptTemplate(template);
      return { ...adopted, preparationCostUsd: template.preparationCostUsd };
    },

    async createReplay(input): Promise<ReplayExecutionHandle> {
      if (closed) throw new Error("Experience Replay dependencies are closed");
      if (!conditionUsesKoed(input.condition)) {
        if (input.template)
          throw new Error("Non-Koed replay cannot receive a template");
        return {
          cloneId: null,
          productPathAttestation: null,
          activateCredential: () => undefined,
          revokeCredential: () => undefined,
          run: async ({ lifecycle, signal }) => {
            const result = await harbor.runReplay({
              task: input.task,
              condition: input.condition,
              repeat: input.repeat,
              executionGeneration: input.executionGeneration,
              runRoot: input.runRoot,
              lifecycle,
              config: input.config,
              ...(input.developerInstructions
                ? { developerInstructions: input.developerInstructions }
                : {}),
              ...(input.requireMemoryAnswer
                ? { requireMemoryAnswer: true }
                : {}),
              signal
            });
            if (!result.replayTrajectoryArtifact)
              throw new Error("Harbor replay omitted its frozen trajectory");
            return {
              telemetry: result.telemetry,
              replayTrajectoryArtifact: result.replayTrajectoryArtifact
            };
          },
          close: () => Promise.resolve()
        };
      }
      if (!input.template) throw new Error("Koed replay requires a template");
      const template = input.template as LocalProductTemplateHandle;
      if (input.signal?.aborted)
        throw new Error("Replay was cancelled before clone provisioning");
      const provision = await product.cloneForReplay(
        template,
        input.task.taskDigest
      );
      let workspace:
        | { trialWorkspaceRoot: string; close(): Promise<void> }
        | undefined;
      let runtime: ExperienceReplayProductRuntimeHandle | undefined;
      try {
        workspace = await acquireWorkspace(provision.project.cwd);
        runtime = await startRuntime({
          scopeId: `experience-replay:${options.runId}:${provision.cloneId}`,
          databaseUrl: provision.databaseUrl,
          apiToken: tokenFromAuthorization(provision.authorization),
          projectCwd: provision.project.cwd,
          trialWorkspaceRoot: workspace.trialWorkspaceRoot,
          identity: {
            runId: options.runId,
            trialId: `${input.task.taskDigest}:${input.condition}:${input.repeat}:${input.executionGeneration}`,
            taskDigest: input.task.taskDigest,
            condition: input.condition
          },
          environment: { ...options.productRuntimeEnvironment },
          ...(options.codexAuthJsonPath
            ? { codexAuthJsonPath: options.codexAuthJsonPath }
            : {}),
          dependencies: {
            ...options.productRuntimeDependencies,
            // The cloned adapter API owns the matching token pepper. Reusing
            // that live API avoids ever exporting the pepper as coordinator data.
            startApi: () => Promise.resolve(provision.api)
          },
          ...(options.bridgeCredentialLifetimeMs
            ? { bridgeCredentialLifetimeMs: options.bridgeCredentialLifetimeMs }
            : {}),
          dockerAccessibleBridge: options.mode === "recorded"
        });
      } catch (error) {
        await Promise.allSettled([
          runtime?.close(),
          workspace?.close(),
          provision.close()
        ]);
        throw error;
      }
      const close = closeReplay(provision, runtime, workspace);
      openReplays.add(close);
      const attestation: ReplayProductPathAttestation = {
        schema: "koed-experience-replay-product-path-v1",
        cloneId: provision.cloneId,
        templateId: template.templateId,
        templateAttestationHash: provision.templateAttestationHash,
        databaseName: provision.cloneId,
        taskDigest: provision.taskDigest,
        projectId: provision.projectId,
        apiOrigin: origin(runtime.api.url),
        redisEndpointHash: sha256(runtime.redis.url),
        mcpBridgeOrigin: origin(runtime.bridge.url),
        localAiRuntimeOrigin: origin(runtime.runtime.url)
      };
      return {
        cloneId: provision.cloneId,
        productPathAttestation: attestation,
        activateCredential: () => runtime.activateBridgeCredential(),
        revokeCredential: () => runtime.bridge.revoke(),
        run: async ({ lifecycle, signal }) => {
          const unregister =
            options.mode === "recorded"
              ? registerRecordedAttemptObservation({
                  identity: {
                    taskDigest: input.task.taskDigest,
                    condition: input.condition,
                    repeat: input.repeat
                  },
                  databaseUrl: provision.databaseUrl,
                  ownerUserId: provision.actor.userId,
                  apiPid: provision.api.pid,
                  runtimePid: process.pid,
                  bridge: () => runtime.bridge.telemetry(),
                  embeddings: () => {
                    if (!provision.telemetry)
                      throw new Error(
                        "Replay provision embedding observer is absent"
                      );
                    return provision.telemetry().embeddings;
                  }
                })
              : () => undefined;
          try {
            const result = await harbor.runReplay({
              task: input.task,
              condition: input.condition,
              repeat: input.repeat,
              executionGeneration: input.executionGeneration,
              runRoot: input.runRoot,
              lifecycle,
              config: input.config,
              bridgeUrl: runtime.bridge.containerUrl ?? runtime.bridge.url,
              bridgeToken: runtime.bridge.token,
              ...(input.requireMemoryAnswer
                ? { requireMemoryAnswer: true }
                : {}),
              signal
            });
            if (!result.replayTrajectoryArtifact)
              throw new Error("Harbor replay omitted its frozen trajectory");
            return {
              telemetry: result.telemetry,
              replayTrajectoryArtifact: result.replayTrajectoryArtifact
            };
          } finally {
            unregister();
          }
        },
        close
      };
    },

    judgeTrajectory:
      options.judgeTrajectory ??
      (() => {
        throw new Error("Trajectory judge dependency is required");
      }),

    async teardown({
      preserveTemplates = false
    }: { preserveTemplates?: boolean } = {}): Promise<void> {
      if (closed) return;
      closed = true;
      const settled = await Promise.allSettled(
        [...openReplays].map((close) => close())
      );
      const failures = settled
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected"
        )
        .map((result) => result.reason as unknown);
      try {
        await product.close({ preserveTemplates });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(
          failures,
          "Experience Replay dependency teardown failed"
        );
      }
    },

    cleanupAttestations: () =>
      cleanupProofs.map((proof) => structuredClone(proof))
  };
};
