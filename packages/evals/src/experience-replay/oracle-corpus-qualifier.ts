import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createCoordinatorHarborLifecycle } from "./harbor-lifecycle.js";
import { RunJournal } from "./journal.js";
import { SafeRunDirectory } from "./output-path.js";
import {
  scheduleReplayJobs,
  type ReplaySchedulerJob
} from "./replay-scheduler.js";
import { CostAdmissionController } from "./cost-admission.js";
import { AtifSanitizationError, sanitizeAtifTrajectory } from "./atif/index.js";
import { buildOracleCorpus } from "./oracle-corpus.js";
import {
  admitOracleCorpusDirectory,
  persistOracleCorpusArtifact,
  type OracleCorpusArtifactEntry,
  type OracleCorpusArtifactIdentity
} from "./oracle-corpus-artifact.js";
import { inspectOracleCorpusCollection } from "./oracle-corpus-collection.js";
import { HarborClientError } from "./harbor-client.js";
import type {
  CoordinatorTask,
  ExperienceReplayCoordinatorDependencies
} from "./coordinator.js";
import type { PreflightResult } from "./preflight.js";
import type {
  OracleQualificationManifest,
  OracleQualificationTask
} from "./oracle-qualification-manifest.js";
import { writeTextArtifactAtomic } from "./artifacts.js";

export interface OracleQualificationResult {
  taskDigest: string;
  taskName: string;
  status: "qualified" | "unqualified" | "infrastructure_failed";
  attempts: number;
  corpusAttestationSha256: string | null;
  lastReward: number | null;
  lastFailureCategory: string | null;
  infrastructureCategory: string | null;
  infrastructureCode: string | null;
}

export interface OracleQualificationRunResult {
  runDirectory: string;
  corpusDirectory: string;
  results: readonly OracleQualificationResult[];
}

const safeTaskName = (name: string): string =>
  name.replace(/^terminal-bench\//u, "").replace(/[^a-zA-Z0-9._-]/gu, "-");

const safeInfrastructureFailure = (
  error: unknown
): {
  category: string;
  code: string | null;
} => {
  const pending = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === null || candidate === undefined || visited.has(candidate))
      continue;
    visited.add(candidate);
    if (candidate instanceof HarborClientError) {
      return {
        category: candidate.category,
        code:
          candidate.message.match(/:\s([A-Z][A-Z0-9_]{0,127})$/u)?.[1] ?? null
      };
    }
    if (candidate instanceof AtifSanitizationError) {
      return {
        category: "atif-sanitization",
        code: /^[A-Z][A-Z0-9_]{0,127}$/u.test(candidate.reason)
          ? candidate.reason
          : null
      };
    }
    if (candidate instanceof AggregateError) {
      const errors: unknown[] = candidate.errors;
      pending.push(...errors);
    }
    if (candidate instanceof Error && candidate.cause)
      pending.push(candidate.cause);
  }
  return { category: "infrastructure", code: null };
};

const taskFromPreflight = (
  admitted: PreflightResult,
  taskDigest: string
): CoordinatorTask => {
  const task = admitted.pins.selectedTasks.find(
    (candidate) => candidate.task_digest === taskDigest
  );
  if (!task) throw new Error(`Qualification task is not pinned: ${taskDigest}`);
  return {
    name: task.name,
    taskDigest: task.task_digest,
    category: task.category,
    expertTimeSeconds: task.expert_time_seconds,
    agentTimeoutSeconds: task.agent_timeout_seconds,
    verifierTimeoutSeconds: task.verifier_timeout_seconds,
    resourceClass: task.resource_class,
    reward: {
      minimum: task.primary_reward.minimum,
      maximum: task.primary_reward.maximum,
      successValue: task.primary_reward.success.value
    }
  };
};

const assertReusableCorpus = (
  entry: OracleCorpusArtifactEntry,
  task: CoordinatorTask,
  preflight: PreflightResult
): void => {
  const expectedImage = preflight.recordedRunAttestation?.taskImages.find(
    (candidate) => candidate.taskDigest === task.taskDigest
  );
  if (!expectedImage) {
    throw new Error(
      `Qualification image attestation is missing for ${task.name}`
    );
  }
  const identity = entry.identity;
  const expectedBaseImages = [...expectedImage.resolvedBaseImageDigests].sort();
  const corpusBaseImages = [
    ...identity.taskImage.resolvedBaseImageDigests
  ].sort();
  if (
    identity.task.digest !== task.taskDigest ||
    identity.task.name !== task.name ||
    identity.model !== preflight.config.coding_agent.id ||
    identity.reasoningEffort !==
      preflight.config.coding_agent.reasoning_effort ||
    identity.codex.version !== preflight.config.codex_cli.version ||
    identity.sanitizer.name !== "koed-atif-sanitizer" ||
    identity.sanitizer.version !== "ATIF-v1.7" ||
    identity.taskImage.dockerfileSha256 !== expectedImage.dockerfileSha256 ||
    corpusBaseImages.length !== expectedBaseImages.length ||
    corpusBaseImages.some(
      (digest, index) => digest !== expectedBaseImages[index]
    )
  ) {
    throw new Error(
      `Existing oracle corpus identity differs from qualification policy for ${task.name}`
    );
  }
};

const feedbackInstructions = (
  specification: OracleQualificationTask,
  prior: {
    reward: number | null;
    failureCategory: string | null;
    result: unknown;
  } | null
): string => {
  if (!prior) return specification.oracleBrief;
  const feedback = JSON.stringify({
    reward: prior.reward,
    failureCategory: prior.failureCategory,
    verifierResult: prior.result
  });
  return `${specification.oracleBrief}\n\nThe previous qualification attempt did not pass the unchanged task verifier. Diagnose and correct the implementation using this verifier evidence. Do not weaken or modify the verifier.\n\n${feedback.slice(0, 128 * 1024)}`;
};

export const qualifyOracleCorpusCollection = async (input: {
  preflight: PreflightResult;
  dependencies: ExperienceReplayCoordinatorDependencies;
  manifest: Readonly<OracleQualificationManifest>;
  corpusDirectory: string;
}): Promise<OracleQualificationRunResult> => {
  if (input.preflight.runPlan.kind !== "oracle_corpus_qualification")
    throw new Error(
      "Oracle corpus qualifier requires a qualification run plan"
    );
  if (
    input.preflight.runPlan.oracleCorpusManifestSha256 !==
    input.manifest.manifestSha256
  ) {
    throw new Error("Oracle qualification manifest differs from the run plan");
  }
  const expectedDigests = new Set(input.preflight.runPlan.sourceTaskDigests);
  if (
    input.manifest.tasks.length !== expectedDigests.size ||
    input.manifest.tasks.some((task) => !expectedDigests.has(task.taskDigest))
  ) {
    throw new Error("Oracle qualification tasks differ from the run plan");
  }
  const created = await SafeRunDirectory.create({
    outputPath: input.preflight.config.output_dir,
    repositoryRoot: input.preflight.repositoryRoot,
    requiredBytes: input.preflight.capacity.requiredBytes,
    reserveBytes: input.preflight.capacity.reserveBytes
  });
  const corpusDirectory = await admitOracleCorpusDirectory(
    {
      corpusDirectory: input.corpusDirectory,
      repositoryRoot: input.preflight.repositoryRoot
    },
    true
  );
  const journal = new RunJournal(
    created.directory,
    input.preflight.config.semantic_config_hash,
    []
  );
  const results = new Map<string, OracleQualificationResult>();
  const attemptsStarted = new Map<string, number>();
  let ledgerWrite = Promise.resolve();
  let ledgerSequence = 0;
  const writeLedger = (): Promise<void> => {
    ledgerWrite = ledgerWrite.then(() => {
      ledgerSequence += 1;
      return writeTextArtifactAtomic(
        created.directory.root,
        `qualification/ledger/${String(ledgerSequence).padStart(4, "0")}.json`,
        `${JSON.stringify(
          {
            schemaVersion: "koed-oracle-qualification-ledger-v1",
            manifestSha256: input.manifest.manifestSha256,
            results: [...results.values()].sort((left, right) =>
              left.taskDigest.localeCompare(right.taskDigest)
            )
          },
          null,
          2
        )}\n`
      );
    });
    return ledgerWrite;
  };
  const corpusChildren = await readdir(corpusDirectory);
  if (corpusChildren.length > 0) {
    const existing = await inspectOracleCorpusCollection({
      corpusRoot: corpusDirectory,
      repositoryRoot: input.preflight.repositoryRoot
    });
    for (const specification of input.manifest.tasks) {
      const entry = existing.entries.get(specification.taskDigest);
      if (!entry) continue;
      const task = taskFromPreflight(input.preflight, specification.taskDigest);
      assertReusableCorpus(entry, task, input.preflight);
      results.set(task.taskDigest, {
        taskDigest: task.taskDigest,
        taskName: task.name,
        status: "qualified",
        attempts: 0,
        corpusAttestationSha256: entry.attestationSha256,
        lastReward: entry.source.reward,
        lastFailureCategory: null,
        infrastructureCategory: null,
        infrastructureCode: null
      });
    }
    if (results.size > 0) await writeLedger();
  }
  const pendingSpecifications = input.manifest.tasks.filter(
    (specification) => !results.has(specification.taskDigest)
  );
  const jobs: ReplaySchedulerJob<OracleQualificationResult>[] =
    pendingSpecifications.map((specification) => {
      const task = taskFromPreflight(input.preflight, specification.taskDigest);
      return {
        id: `qualify:${task.taskDigest}`,
        exclusiveKey: task.taskDigest,
        maximumCostUsd: Math.max(
          Number.EPSILON,
          input.preflight.config.maximum_top_level_attempt_cost_usd *
            specification.maximumAttempts
        ),
        async run({ signal }) {
          let prior: {
            reward: number | null;
            failureCategory: string | null;
            result: unknown;
          } | null = null;
          let observedCostUsd = 0;
          for (
            let attempt = 1;
            attempt <= specification.maximumAttempts;
            attempt += 1
          ) {
            const sourceAttemptIdentity = `qualify:${task.taskDigest}:${attempt}`;
            attemptsStarted.set(task.taskDigest, attempt);
            await journal.append({
              type: "attempt_state",
              attemptId: sourceAttemptIdentity,
              executionGeneration: 1,
              state: "admitted"
            });
            const lifecycle = createCoordinatorHarborLifecycle({
              attemptId: sourceAttemptIdentity,
              executionGeneration: 1,
              journal,
              activateCredential: () => undefined,
              revokeCredential: () => undefined
            });
            const root = `qualification/${safeTaskName(task.name)}/attempt-${attempt}`;
            const attemptInstructions = feedbackInstructions(
              specification,
              prior
            );
            const source = await input.dependencies.runSource({
              task,
              attemptId: sourceAttemptIdentity,
              executionGeneration: attempt,
              runRoot: created.directory.root,
              freezeTrajectoryPath: `${root}/frozen-trajectory.json`,
              freezeManifestPath: `${root}/freeze-manifest.json`,
              lifecycle,
              config: input.preflight.config,
              developerInstructions: attemptInstructions,
              signal
            });
            observedCostUsd += source.costUsd;
            await writeTextArtifactAtomic(
              created.directory.root,
              `${root}/result.json`,
              `${JSON.stringify(source, null, 2)}\n`
            );
            if (source.failureCategory === "other")
              throw new Error(
                `Qualification infrastructure failed for ${task.name}`
              );
            if (
              source.passed &&
              source.reward === task.reward.successValue &&
              source.failureCategory === null
            ) {
              const sanitization = sanitizeAtifTrajectory(
                source.frozenTrajectory,
                {
                  taskDigest: task.taskDigest,
                  sourceAttemptId: sourceAttemptIdentity,
                  countEmbeddingTokens: input.dependencies.countEmbeddingTokens,
                  freezeManifest: source.freezeManifest
                }
              );
              const successfulSource = {
                taskDigest: task.taskDigest,
                sourceAttemptId: sourceAttemptIdentity,
                passed: true,
                reward: source.reward,
                expectedSuccessValue: task.reward.successValue,
                failureCategory: null,
                sanitization
              };
              const oracleBriefSha256 = createHash("sha256")
                .update(attemptInstructions)
                .digest("hex");
              const corpus = buildOracleCorpus({
                oracleBrief: attemptInstructions,
                oracleBriefSha256,
                source: successfulSource
              });
              const image =
                input.preflight.recordedRunAttestation?.taskImages.find(
                  (candidate) => candidate.taskDigest === task.taskDigest
                );
              if (!image)
                throw new Error(
                  `Qualification image attestation is missing for ${task.name}`
                );
              const identity: OracleCorpusArtifactIdentity = {
                model: input.preflight.config.coding_agent.id,
                reasoningEffort:
                  input.preflight.config.coding_agent.reasoning_effort,
                task: { name: task.name, digest: task.taskDigest },
                codex: { version: input.preflight.config.codex_cli.version },
                taskImage: {
                  ...image,
                  resolvedBaseImageDigests: [...image.resolvedBaseImageDigests]
                },
                sanitizer: {
                  name: "koed-atif-sanitizer",
                  version: "ATIF-v1.7"
                }
              };
              const artifact: OracleCorpusArtifactEntry =
                await persistOracleCorpusArtifact(
                  {
                    corpusDirectory: path.join(
                      corpusDirectory,
                      `${safeTaskName(task.name)}-${task.taskDigest.slice(-12)}`
                    ),
                    repositoryRoot: input.preflight.repositoryRoot
                  },
                  {
                    identity,
                    oracleBrief: attemptInstructions,
                    source: successfulSource,
                    corpus
                  }
                );
              const result: OracleQualificationResult = {
                taskDigest: task.taskDigest,
                taskName: task.name,
                status: "qualified",
                attempts: attempt,
                corpusAttestationSha256: artifact.attestationSha256,
                lastReward: source.reward,
                lastFailureCategory: source.failureCategory,
                infrastructureCategory: null,
                infrastructureCode: null
              };
              results.set(task.taskDigest, result);
              await writeLedger();
              return { value: result, observedCostUsd };
            }
            prior = {
              reward: source.reward,
              failureCategory: source.failureCategory,
              result: source.result
            };
          }
          const result: OracleQualificationResult = {
            taskDigest: task.taskDigest,
            taskName: task.name,
            status: "unqualified",
            attempts: specification.maximumAttempts,
            corpusAttestationSha256: null,
            lastReward: prior?.reward ?? null,
            lastFailureCategory: prior?.failureCategory ?? null,
            infrastructureCategory: null,
            infrastructureCode: null
          };
          results.set(task.taskDigest, result);
          await writeLedger();
          return { value: result, observedCostUsd };
        }
      };
    });
  const subscription = input.preflight.runPlan.codexAuthMode === "subscription";
  const costAdmission = subscription
    ? undefined
    : new CostAdmissionController(
        input.preflight.config.paid_cost_stop_usd!,
        input.preflight.config.admission.provider_spending_limit_usd!,
        input.preflight.config.concurrency
      );
  try {
    const scheduled = await scheduleReplayJobs({
      jobs,
      concurrency: input.preflight.config.concurrency,
      ...(subscription
        ? { mode: "subscription" as const }
        : {
            mode: "paid" as const,
            paidCostStopUsd: input.preflight.config.paid_cost_stop_usd!,
            providerSpendingLimitUsd:
              input.preflight.config.admission.provider_spending_limit_usd!,
            costAdmission
          })
    });
    for (const outcome of scheduled.results) {
      if (outcome.status === "completed") continue;
      if (outcome.status === "failed" || outcome.status === "cancelled") {
        if (process.env.KOED_EXPERIENCE_REPLAY_DEBUG_SETUP_ERRORS === "1") {
          console.error(
            "[experience-replay qualification diagnostic]",
            outcome.error
          );
        }
        const digest = outcome.id.split(":").slice(1).join(":");
        const task = taskFromPreflight(input.preflight, digest);
        const failure = safeInfrastructureFailure(outcome.error);
        results.set(digest, {
          taskDigest: digest,
          taskName: task.name,
          status: "infrastructure_failed",
          attempts: attemptsStarted.get(digest) ?? 0,
          corpusAttestationSha256: null,
          lastReward: null,
          lastFailureCategory: "infrastructure",
          infrastructureCategory: failure.category,
          infrastructureCode: failure.code
        });
      }
    }
    await writeLedger();
    return {
      runDirectory: created.directory.root,
      corpusDirectory,
      results: [...results.values()].sort((left, right) =>
        left.taskDigest.localeCompare(right.taskDigest)
      )
    };
  } finally {
    await input.dependencies.teardown();
  }
};
