import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AtifSanitizationResult } from "./atif/index.js";
import {
  createExperienceReplayCoordinatorDependencies,
  type ExperienceReplayCoordinatorDependencyFactoryOptions
} from "./coordinator-dependencies.js";
import type {
  CoordinatorTask,
  PreparedTemplate,
  SourceAttemptExecution
} from "./coordinator.js";
import type { ResolvedExperienceReplayConfig } from "./core/index.js";
import {
  createDeterministicSmokeTelemetry,
  type HarborReplayExecution,
  type HarborReplayExecutionInput,
  type HarborSourceExecutionInput
} from "./harbor-execution-adapter.js";
import type {
  LocalProductReplayProvision,
  LocalProductTemplateHandle
} from "./local-product-adapter.js";
import type {
  ExperienceReplayProductRuntimeHandle,
  StartExperienceReplayProductRuntimeOptions
} from "./product-runtime.js";

const task: CoordinatorTask = {
  name: "terminal-bench/task-a",
  taskDigest: `sha256:${"a".repeat(64)}`,
  category: "fixture",
  expertTimeSeconds: 10,
  agentTimeoutSeconds: 60,
  verifierTimeoutSeconds: 30,
  resourceClass: "cpu",
  reward: { minimum: 0, maximum: 1, successValue: 1 }
};

const config = {
  profile: "smoke",
  coding_agent: { id: "fixture-model", reasoning_effort: "low" },
  timeouts: {
    setup_seconds: 1,
    agent_seconds: 1,
    verifier_seconds: 1,
    teardown_seconds: 1
  }
} as ResolvedExperienceReplayConfig;

const sanitized = {
  normalizedItems: [
    {
      adapterVersion: "1.0.0",
      sourceIdentity: "item-1",
      atifIdentity: "step-1",
      sequence: 0,
      stepId: 1,
      timestamp: null,
      type: "user_message",
      content: "  Which   deployment decision did we make?  "
    }
  ],
  manifest: {},
  trajectory: {},
  canonicalJson: "{}"
} as unknown as AtifSanitizationResult;

const localTemplateHandle = {
  templateId: "koed_eval_template_1",
  sourceStateHash: `sha256:${"b".repeat(64)}`,
  attestation: {
    project: { cwd: "/fixture/workspace/task-a/relevant" }
  }
} as unknown as LocalProductTemplateHandle;

const templateHandle = {
  ...localTemplateHandle,
  preparationCostUsd: 0
} as unknown as PreparedTemplate;

const fixture = () => {
  const runSource = vi.fn(
    async (
      input: HarborSourceExecutionInput
    ): Promise<SourceAttemptExecution> => {
      void input;
      return {
        frozenTrajectory: "{}",
        freezeManifest: {} as SourceAttemptExecution["freezeManifest"],
        reward: 1,
        passed: true,
        failureCategory: null,
        costUsd: 0,
        sanitizedTokenQuartile: 0,
        result: {}
      };
    }
  );
  const runReplay = vi.fn(
    async (
      input: HarborReplayExecutionInput
    ): Promise<HarborReplayExecution> => {
      const identity = {
        taskDigest: input.task.taskDigest,
        condition: input.condition,
        repeat: input.repeat
      };
      return {
        result: {} as HarborReplayExecution["result"],
        replayTrajectoryArtifact: {
          path: "harbor-replay-trajectories/replay.json",
          sha256: `sha256:${"a".repeat(64)}`,
          freezeManifest:
            {} as HarborReplayExecution["replayTrajectoryArtifact"] extends {
              freezeManifest: infer T;
            }
              ? T
              : never
        },
        telemetry: {
          identity,
          harbor: {
            identity,
            status: "available",
            metrics: { reward: 1, passed: true }
          },
          ...createDeterministicSmokeTelemetry(identity)
        }
      };
    }
  );
  const prepareTemplate = vi.fn(async () => localTemplateHandle);
  const prepareCampaignTemplate = vi.fn(async () => localTemplateHandle);
  const campaignTemplateLockCalls: string[] = [];
  const withCampaignTemplateLock = async <T>(
    contentIdentity: string,
    operation: () => Promise<T>
  ): Promise<T> => {
    campaignTemplateLockCalls.push(contentIdentity);
    return operation();
  };
  const adoptTemplate = vi.fn(
    async (
      template: LocalProductTemplateHandle,
      cachedContentIdentity?: string
    ) => {
      void template;
      void cachedContentIdentity;
      return localTemplateHandle;
    }
  );
  const provisionClose = vi.fn(async () => ({
    api: {
      pid: 11,
      graceful: true,
      forced: false,
      exitCode: 0,
      signal: null
    }
  }));
  const api = {
    url: "http://127.0.0.1:4101",
    request: vi.fn(),
    close: vi.fn()
  };
  const cloneForReplay = vi.fn(
    async (
      template: LocalProductTemplateHandle,
      targetTaskDigest?: string
    ): Promise<LocalProductReplayProvision> => ({
      cloneId: "koed_eval_clone_1",
      databaseUrl: "postgres://eval:secret@127.0.0.1/koed_eval_clone_1",
      actor: { userId: "user-1" },
      authorization: "Bearer api-token",
      api: api as LocalProductReplayProvision["api"],
      taskDigest: targetTaskDigest ?? template.attestation.taskDigest,
      projectId: template.attestation.project.id,
      project: template.attestation.project,
      templateAttestationHash: `sha256:${"c".repeat(64)}`,
      close: provisionClose
    })
  );
  const productClose = vi.fn(async () => undefined);
  const runtimeClose = vi.fn(async () => ({
    scopeId: "scope",
    trigger: "explicit",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.001Z",
    durationMs: 1,
    cleanupCount: 1,
    omittedCleanupCount: 0,
    errorCount: 0,
    omittedErrorCount: 0,
    deadlineExceeded: false,
    cleanups: [],
    errors: []
  }));
  const bridge = {
    url: "http://127.0.0.1:4104/mcp",
    token: "bridge-token",
    revoke: vi.fn(),
    activate: vi.fn(),
    credentialId: "credential-1",
    attestation: vi.fn(),
    close: vi.fn()
  };
  const activateBridgeCredential = vi.fn();
  const startProductRuntime = vi.fn(
    async (
      input: StartExperienceReplayProductRuntimeOptions
    ): Promise<ExperienceReplayProductRuntimeHandle> => {
      void input;
      return {
        api,
        redis: { url: "redis://default:secret@127.0.0.1/0" },
        runtime: { url: "http://127.0.0.1:4103" },
        bridge,
        activateBridgeCredential,
        close: runtimeClose
      } as unknown as ExperienceReplayProductRuntimeHandle;
    }
  );
  const workspaceClose = vi.fn(async () => undefined);
  const materializeProjectWorkspace = vi.fn(async () => ({
    trialWorkspaceRoot: "/fixture/workspace",
    close: workspaceClose
  }));
  const product: NonNullable<
    ExperienceReplayCoordinatorDependencyFactoryOptions["product"]
  > = {
    prepareTemplate,
    prepareCampaignTemplate,
    async withCampaignTemplateLock(contentIdentity, operation) {
      expect(this).toBe(product);
      return withCampaignTemplateLock(contentIdentity, operation);
    },
    async adoptTemplate(template, cachedContentIdentity) {
      expect(this).toBe(product);
      return cachedContentIdentity === undefined
        ? adoptTemplate(template)
        : adoptTemplate(template, cachedContentIdentity);
    },
    cloneForReplay,
    close: productClose
  };
  const options: ExperienceReplayCoordinatorDependencyFactoryOptions = {
    mode: "smoke",
    runId: "fixture-run",
    corpusManifest: "/fixture/corpus.json",
    postgres: {
      adminUrl: "postgres://127.0.0.1/postgres",
      user: "eval",
      password: "secret"
    },
    countEmbeddingTokens: (text: string) => text.split(/\s+/u).length,
    harbor: { runSource, runReplay },
    product,
    startProductRuntime,
    materializeProjectWorkspace
  };
  return {
    options,
    runSource,
    runReplay,
    prepareTemplate,
    prepareCampaignTemplate,
    withCampaignTemplateLock,
    campaignTemplateLockCalls,
    adoptTemplate,
    cloneForReplay,
    productClose,
    provisionClose,
    startProductRuntime,
    activateBridgeCredential,
    bridge,
    runtimeClose,
    workspaceClose,
    materializeProjectWorkspace
  };
};

describe("Experience Replay coordinator dependency factory", () => {
  it("delegates source execution with a stable source-only quartile", async () => {
    const f = fixture();
    const dependencies = createExperienceReplayCoordinatorDependencies(
      f.options
    );
    const input = {
      task,
      attemptId: `source:${task.taskDigest}`,
      executionGeneration: 1,
      runRoot: "/run",
      freezeTrajectoryPath: "source/trajectory.json",
      freezeManifestPath: "source/manifest.json",
      lifecycle: {},
      config
    };
    await dependencies.runSource(input);
    await dependencies.runSource(input);

    const quartiles = f.runSource.mock.calls.map(
      ([call]) => call.sanitizedTokenQuartile
    );
    expect(quartiles).toHaveLength(2);
    expect(quartiles[0]).toBe(quartiles[1]);
    expect([0, 1, 2, 3]).toContain(quartiles[0]);
    await dependencies.teardown();
  });

  it("derives a stable semantic probe and delegates canonical preparation", async () => {
    const f = fixture();
    const dependencies = createExperienceReplayCoordinatorDependencies(
      f.options
    );
    const prepared = await dependencies.prepareTemplate({
      task,
      condition: "relevant",
      sourceTask: task,
      sanitizedSource: sanitized,
      runRoot: "/run",
      config
    });

    expect(f.prepareTemplate).toHaveBeenCalledWith({
      condition: "relevant",
      taskDigest: task.taskDigest,
      sourceTaskDigest: task.taskDigest,
      sourceAttemptId: `source:${task.taskDigest}`,
      sanitizedSource: sanitized,
      recallQuery: "Which deployment decision did we make?"
    });
    expect(prepared.preparationCostUsd).toBe(0);
    await dependencies.teardown();
  });

  it("builds one recorded campaign cache entry and re-adopts it on reuse", async () => {
    const f = fixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-campaign-cache-"));
    const campaignConfig = {
      ...config,
      profile: "quick",
      semantic_config_hash: `sha256:${"f".repeat(64)}`,
      lcm_summary: {
        model: { id: "gpt-5.6-luna", reasoning_effort: "low" },
        prompt_version: "lcm-v1",
        output_schema_version: "lcm-summary-v1"
      },
      memory_answer: {
        model: { id: "gpt-5.6-luna", reasoning_effort: "low" },
        prompt_version: "memory-answer-v9"
      },
      admission: {
        max_input_tokens_per_call: 32_768
      },
      embedding: {
        model: "qwen3-0.6b",
        artifact_sha256: `sha256:${"e".repeat(64)}`,
        tokenizer: "qwen3",
        transform: "query-prefix-v1",
        dimensions: 1024
      }
    } as unknown as ResolvedExperienceReplayConfig;
    const dependencies = createExperienceReplayCoordinatorDependencies({
      ...f.options,
      mode: "recorded",
      providerApiKey: "test-provider-key",
      recordedEmbedding: {
        url: "http://127.0.0.1:18000",
        token: "embedding-token",
        model: "qwen3-0.6b",
        dimensions: 1024,
        modelArtifactHash: `sha256:${"e".repeat(64)}`
      },
      preparationCostUsd: () => 1.25,
      runScheduledLcmJobs: vi.fn(),
      productRuntimeDependencies: { startAppServer: vi.fn() as never },
      containerCodexBinary: "/fixture/codex",
      campaignTemplateCacheDirectory: path.join(root, "cache"),
      repositoryCommit: "a".repeat(40),
      campaignTemplateMaterializationSourceHash: `sha256:${"b".repeat(64)}`
    });
    const input = {
      tasks: [
        {
          task,
          corpusAttestationSha256: `sha256:${"c".repeat(64)}`,
          sourceAttemptId: `oracle:relevant_full:${task.taskDigest}`,
          sanitizedSource: sanitized
        }
      ],
      corpusCollectionManifestSha256: `sha256:${"d".repeat(64)}`,
      runRoot: "/run",
      config: campaignConfig
    };
    try {
      const built = await dependencies.prepareCampaignTemplate!(input);
      const reused = await dependencies.prepareCampaignTemplate!(input);
      const reusedAfterReplayPromptChange =
        await dependencies.prepareCampaignTemplate!({
          ...input,
          config: {
            ...campaignConfig,
            semantic_config_hash: `sha256:${"1".repeat(64)}`,
            coding_agent: {
              id: "another-coding-agent",
              reasoning_effort: "high"
            },
            memory_answer: {
              ...campaignConfig.memory_answer,
              model: { id: "another-answer-model", reasoning_effort: "high" },
              prompt_version: "memory-answer-v10"
            }
          }
        });
      const rebuiltAfterLcmPromptChange =
        await dependencies.prepareCampaignTemplate!({
          ...input,
          config: {
            ...campaignConfig,
            lcm_summary: {
              ...campaignConfig.lcm_summary,
              prompt_version: "lcm-v2"
            }
          }
        });

      expect(built.preparationCostUsd).toBe(1.25);
      expect(reused.preparationCostUsd).toBe(0);
      expect(reusedAfterReplayPromptChange.preparationCostUsd).toBe(0);
      expect(rebuiltAfterLcmPromptChange.preparationCostUsd).toBe(1.25);
      expect(f.prepareCampaignTemplate).toHaveBeenCalledTimes(2);
      expect(f.adoptTemplate).toHaveBeenCalledTimes(2);
      expect(f.adoptTemplate.mock.calls[0]?.[1]).toMatch(
        /^sha256:[a-f0-9]{64}$/u
      );
      expect(f.campaignTemplateLockCalls).toHaveLength(4);
      expect(new Set(f.campaignTemplateLockCalls)).toHaveLength(2);
    } finally {
      await dependencies.teardown({ preserveTemplates: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-attests persisted templates without reconstructing credentials", async () => {
    const f = fixture();
    const dependencies = createExperienceReplayCoordinatorDependencies(
      f.options
    );

    const adopted = await dependencies.adoptTemplate(templateHandle);

    expect(f.adoptTemplate).toHaveBeenCalledWith(templateHandle);
    expect(adopted).toEqual(templateHandle);
    await dependencies.teardown({ preserveTemplates: true });
    expect(f.productClose).toHaveBeenCalledWith({ preserveTemplates: true });
  });

  it("keeps cold replay free of every Koed product resource", async () => {
    const f = fixture();
    const dependencies = createExperienceReplayCoordinatorDependencies(
      f.options
    );
    const replay = await dependencies.createReplay({
      task,
      condition: "cold",
      repeat: 0,
      executionGeneration: 1,
      template: null,
      sourceTaskDigest: null,
      runRoot: "/run",
      config
    });
    await replay.run({ lifecycle: {} });

    expect(replay.cloneId).toBeNull();
    expect(replay.productPathAttestation).toBeNull();
    expect(f.cloneForReplay).not.toHaveBeenCalled();
    expect(f.startProductRuntime).not.toHaveBeenCalled();
    expect(f.runReplay.mock.calls[0]?.[0]).not.toHaveProperty("bridgeUrl");
    await dependencies.teardown();
  });

  it("starts the cloned full product path, forwards only the live bridge pair, and attests cleanup", async () => {
    const f = fixture();
    const before = process.env.KOED_BENCHMARK_MCP_TOKEN;
    const dependencies = createExperienceReplayCoordinatorDependencies(
      f.options
    );
    const replay = await dependencies.createReplay({
      task,
      condition: "relevant",
      repeat: 0,
      executionGeneration: 1,
      template: templateHandle,
      sourceTaskDigest: task.taskDigest,
      runRoot: "/run",
      config
    });

    await replay.activateCredential();
    await replay.run({ lifecycle: {} });
    await replay.revokeCredential();
    await replay.close();

    expect(f.startProductRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseUrl: "postgres://eval:secret@127.0.0.1/koed_eval_clone_1",
        apiToken: "api-token",
        projectCwd: "/fixture/workspace/task-a/relevant",
        trialWorkspaceRoot: "/fixture/workspace",
        environment: {}
      })
    );
    expect(f.runReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeUrl: "http://127.0.0.1:4104/mcp",
        bridgeToken: "bridge-token"
      })
    );
    expect(f.activateBridgeCredential).toHaveBeenCalledOnce();
    expect(f.bridge.revoke).toHaveBeenCalledOnce();
    expect(dependencies.cleanupAttestations()).toEqual([
      expect.objectContaining({ cloneId: "koed_eval_clone_1", complete: true })
    ]);
    expect(process.env.KOED_BENCHMARK_MCP_TOKEN).toBe(before);
    await dependencies.teardown();
    expect(f.productClose).toHaveBeenCalledOnce();
  });

  it("recovers an interrupted run's stale owned Project workspace", async () => {
    const f = fixture();
    const runPart = `resume-${process.pid}-${Date.now()}`;
    const projectCwd = path.join(
      os.tmpdir(),
      "koed-eval",
      runPart,
      "task-a",
      "relevant"
    );
    const staleFile = path.join(projectCwd, "stale.txt");
    await mkdir(projectCwd, { recursive: true });
    await writeFile(staleFile, "stale", "utf8");
    const resumedTemplate = {
      ...templateHandle,
      attestation: {
        ...templateHandle.attestation,
        project: { ...templateHandle.attestation.project, cwd: projectCwd }
      }
    } as PreparedTemplate;
    const dependencies = createExperienceReplayCoordinatorDependencies({
      ...f.options,
      materializeProjectWorkspace: undefined
    });

    const replay = await dependencies.createReplay({
      task,
      condition: "relevant",
      repeat: 0,
      executionGeneration: 2,
      template: resumedTemplate,
      sourceTaskDigest: task.taskDigest,
      runRoot: "/run",
      config
    });

    await expect(readFile(staleFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await replay.close();
    await dependencies.teardown();
  });

  it("fails closed before allocation when recorded collectors and providers are absent", () => {
    const f = fixture();
    expect(() =>
      createExperienceReplayCoordinatorDependencies({
        ...f.options,
        mode: "recorded"
      })
    ).toThrow(
      "exactly one Codex authentication source, recorded Embedding Service credentials, preparation cost collector, Local AI Runtime preparation collector, Local AI Runtime provider"
    );
    expect(f.prepareTemplate).not.toHaveBeenCalled();
    expect(f.cloneForReplay).not.toHaveBeenCalled();
  });
});
