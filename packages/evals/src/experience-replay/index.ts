import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseExperienceReplayCommand } from "./command.js";
import { mergeOracleCampaignRuns } from "./campaign-merge.js";
import {
  reportExistingRun,
  readExperienceReplayResumeIdentity,
  resumeExperienceReplay,
  runExperienceReplay,
  sanitizeRunReport
} from "./coordinator.js";
import {
  EXPERIENCE_REPLAY_REPOSITORY_ROOT,
  loadExperienceReplayConfig,
  preflightExperienceReplay
} from "./preflight.js";
import { createRecordedPreflightRuntime } from "./recorded-preflight-runtime.js";
import {
  createCliExperienceReplayDependencies,
  requiresForcedMemoryAnswerProof
} from "./runtime-options.js";
import {
  inspectOracleCorpusArtifact,
  loadOracleCorpusArtifact,
  type OracleCorpusArtifactEntry,
  type OracleCorpusArtifactIdentity,
  type OracleCorpusArtifactLocation
} from "./oracle-corpus-artifact.js";
import {
  inspectOracleCorpusCollection,
  loadPersistedOracleCorpusCollection
} from "./oracle-corpus-collection.js";
import { inspectOracleCampaignDefinition } from "./oracle-campaign-manifest.js";
import { inspectOracleQualificationManifest } from "./oracle-qualification-manifest.js";
import { qualifyOracleCorpusCollection } from "./oracle-corpus-qualifier.js";
import type {
  OracleCampaignProtocol,
  OracleCampaignShardManifest
} from "./core/index.js";
import { assertExperienceReplayHostPlatform } from "./host-platform.js";

const oracleArtifactLocation = (
  corpusDirectory: string,
  repositoryRoot: string
): OracleCorpusArtifactLocation => ({ corpusDirectory, repositoryRoot });

const oracleArtifactIdentity = (
  result: Awaited<ReturnType<typeof preflightExperienceReplay>>,
  corpus?: OracleCorpusArtifactEntry,
  taskDigest?: string
): OracleCorpusArtifactIdentity => {
  const selectedDigest = taskDigest ?? corpus?.identity.task.digest;
  const task = selectedDigest
    ? result.pins.selectedTasks.find(
        (candidate) => candidate.task_digest === selectedDigest
      )
    : result.pins.selectedTasks[0];
  const image = selectedDigest
    ? result.recordedRunAttestation?.taskImages.find(
        (candidate) => candidate.taskDigest === selectedDigest
      )
    : result.recordedRunAttestation?.taskImages[0];
  if (!task || !image) {
    throw new Error(
      "Oracle corpus requires one recorded task-image attestation"
    );
  }
  return {
    model: corpus?.identity.model ?? result.config.coding_agent.id,
    reasoningEffort:
      corpus?.identity.reasoningEffort ??
      result.config.coding_agent.reasoning_effort,
    task: { name: task.name, digest: task.task_digest },
    codex: { version: result.config.codex_cli.version },
    taskImage: {
      ...image,
      resolvedBaseImageDigests: [...image.resolvedBaseImageDigests]
    },
    sanitizer: { name: "koed-atif-sanitizer", version: "ATIF-v1.7" }
  };
};

const campaignShardEntries = (
  collection: Awaited<ReturnType<typeof inspectOracleCorpusCollection>>,
  shardTaskDigests: readonly string[]
): readonly OracleCorpusArtifactEntry[] =>
  shardTaskDigests.map((taskDigest) => {
    const entry = collection.entries.get(taskDigest);
    if (!entry)
      throw new Error(`Oracle campaign shard corpus is missing ${taskDigest}`);
    return entry;
  });

const assertCampaignCorpusIdentity = (
  entries: Iterable<OracleCorpusArtifactEntry>,
  config: Awaited<ReturnType<typeof loadExperienceReplayConfig>>
): void => {
  for (const entry of entries) {
    if (
      entry.identity.model !== config.coding_agent.id ||
      entry.identity.reasoningEffort !== config.coding_agent.reasoning_effort ||
      entry.identity.codex.version !== config.codex_cli.version ||
      entry.identity.sanitizer.name !== "koed-atif-sanitizer" ||
      entry.identity.sanitizer.version !== "ATIF-v1.7"
    ) {
      throw new Error(
        `Oracle campaign corpus identity differs from the frozen campaign policy for ${entry.identity.task.digest}`
      );
    }
  }
};

export * from "./artifacts.js";
export * from "./campaign-merge.js";
export * from "./command.js";
export * from "./coordinator.js";
export * from "./cost-admission.js";
export * from "./journal.js";
export * from "./local-product-adapter.js";
export * from "./oracle-corpus.js";
export * from "./oracle-corpus-artifact.js";
export * from "./oracle-corpus-collection.js";
export * from "./oracle-campaign-manifest.js";
export * from "./oracle-qualification-manifest.js";
export * from "./oracle-corpus-qualifier.js";
export * from "./preflight.js";
export * from "./recorded-preflight-runtime.js";
export * from "./replay-scheduler.js";
export * from "./runtime-options.js";
export * from "./host-platform.js";

export const runExperienceReplayCli = async (
  argv: readonly string[]
): Promise<unknown> => {
  const command = parseExperienceReplayCommand(argv);
  if (["preflight", "run", "resume"].includes(command.name)) {
    assertExperienceReplayHostPlatform();
  }
  switch (command.name) {
    case "campaign-merge": {
      const manifest = JSON.parse(
        await readFile(command.manifestPath, "utf8")
      ) as { run_directories?: unknown };
      if (
        !Array.isArray(manifest.run_directories) ||
        manifest.run_directories.some((value) => typeof value !== "string")
      ) {
        throw new Error(
          "Campaign merge manifest requires a run_directories string array"
        );
      }
      return mergeOracleCampaignRuns({
        runDirectories: manifest.run_directories as string[],
        outputDirectory: command.outputDirectory,
        repositoryRoot: EXPERIENCE_REPLAY_REPOSITORY_ROOT
      });
    }
    case "preflight": {
      const config = await loadExperienceReplayConfig(command.configPath);
      const oracleBrief = command.oracleBriefPath
        ? await readFile(command.oracleBriefPath, "utf8")
        : undefined;
      const oracleBriefSha256 = oracleBrief
        ? createHash("sha256").update(oracleBrief).digest("hex")
        : undefined;
      const codexAuthMode = command.codexSubscription
        ? "subscription"
        : "api_key";
      const inspectedCorpus = command.oracleRepeatedStudy
        ? await inspectOracleCorpusArtifact(
            oracleArtifactLocation(
              command.oracleCorpusPath!,
              EXPERIENCE_REPLAY_REPOSITORY_ROOT
            )
          )
        : undefined;
      const inspectedCollection = command.oracleCampaign
        ? await inspectOracleCorpusCollection({
            corpusRoot: command.oracleCorpusPath!,
            repositoryRoot: EXPERIENCE_REPLAY_REPOSITORY_ROOT
          })
        : undefined;
      const campaignDefinition = command.oracleCampaign
        ? await inspectOracleCampaignDefinition({
            manifestPath: command.oracleCampaignManifestPath!,
            repositoryRoot: EXPERIENCE_REPLAY_REPOSITORY_ROOT
          })
        : undefined;
      const qualificationManifest = command.oracleCorpusQualification
        ? await inspectOracleQualificationManifest({
            manifestPath: command.oracleQualificationManifestPath!,
            repositoryRoot: EXPERIENCE_REPLAY_REPOSITORY_ROOT
          })
        : undefined;
      if (
        inspectedCollection &&
        campaignDefinition &&
        (inspectedCollection.entries.size !==
          campaignDefinition.taskUniverseDigests.length ||
          campaignDefinition.taskUniverseDigests.some(
            (digest) => !inspectedCollection.entries.has(digest)
          ))
      ) {
        throw new Error(
          "Oracle campaign corpus collection must exactly cover the declared task universe"
        );
      }
      if (inspectedCollection)
        assertCampaignCorpusIdentity(
          inspectedCollection.entries.values(),
          config
        );
      const recorded =
        config.profile === "smoke"
          ? null
          : createRecordedPreflightRuntime(
              config,
              process.env,
              {},
              codexAuthMode,
              inspectedCollection && campaignDefinition
                ? campaignShardEntries(
                    inspectedCollection,
                    campaignDefinition.shardTaskDigests
                  ).map((entry) => entry.identity.taskImage)
                : inspectedCorpus
                  ? [inspectedCorpus.identity.taskImage]
                  : undefined
            );
      const result = await preflightExperienceReplay({
        config,
        confirmPaidRun: command.confirmPaidRun || command.codexSubscription,
        executionKind: command.oracleSeededProof
          ? "oracle_seeded_product_proof"
          : command.oracleRepeatedStudy
            ? "oracle_seeded_repeated_study"
            : command.oracleCampaign
              ? "oracle_seeded_campaign"
              : command.oracleCorpusQualification
                ? "oracle_corpus_qualification"
                : command.productPathProof
                  ? "product_path_proof"
                  : "benchmark_profile",
        oracleBriefSha256,
        oracleCorpusManifestSha256: inspectedCorpus?.attestationSha256,
        ...(qualificationManifest
          ? { oracleCorpusManifestSha256: qualificationManifest.manifestSha256 }
          : {}),
        oracleCorpusCollectionManifestSha256:
          inspectedCollection?.manifest.manifestSha256,
        oracleCampaignDefinitionSha256: campaignDefinition?.manifestSha256,
        campaignTaskDigests: campaignDefinition?.shardTaskDigests,
        ...(qualificationManifest
          ? {
              campaignTaskDigests: qualificationManifest.tasks.map(
                (task) => task.taskDigest
              ),
              oracleQualificationMaximumAttempts:
                qualificationManifest.tasks.reduce(
                  (sum, task) => sum + task.maximumAttempts,
                  0
                )
            }
          : {}),
        campaignTaskUniverseDigests: campaignDefinition?.taskUniverseDigests,
        campaignId: campaignDefinition?.campaignId,
        campaignShardId: campaignDefinition?.shardId,
        campaignReferenceScore: campaignDefinition?.referenceScore,
        ...(command.oracleRepeats === null
          ? {}
          : { oracleRepeats: command.oracleRepeats }),
        codexAuthMode,
        requireRunnable: true,
        ...(recorded
          ? {
              recordedRunAdapters: recorded.adapters,
              productPathReady: recorded.productPathReady
            }
          : {})
      });
      if (command.oracleRepeatedStudy) {
        await loadOracleCorpusArtifact(
          oracleArtifactLocation(
            command.oracleCorpusPath!,
            EXPERIENCE_REPLAY_REPOSITORY_ROOT
          ),
          oracleArtifactIdentity(result, inspectedCorpus)
        );
      }
      if (inspectedCollection) {
        const shardTaskDigests = new Set(campaignDefinition!.shardTaskDigests);
        for (const entry of inspectedCollection.entries.values()) {
          await loadOracleCorpusArtifact(
            oracleArtifactLocation(
              inspectedCollection.directories.get(entry.identity.task.digest)!,
              EXPERIENCE_REPLAY_REPOSITORY_ROOT
            ),
            shardTaskDigests.has(entry.identity.task.digest)
              ? oracleArtifactIdentity(
                  result,
                  entry,
                  entry.identity.task.digest
                )
              : entry.identity
          );
        }
      }
      return {
        executionKind: result.runPlan.kind,
        codexAuthMode: result.runPlan.codexAuthMode,
        profile: result.config.profile,
        semanticConfigHash: result.config.semantic_config_hash,
        codingAgentAttempts: result.runPlan.codingAgentAttemptCount,
        sourceTasks: result.runPlan.sourceTaskDigests.length,
        replayTargetTasks: result.runPlan.replayTargetTaskDigests.length,
        concurrency: result.config.concurrency,
        paidCostStopUsd: result.config.paid_cost_stop_usd ?? null,
        capacity: result.capacity,
        recordedModelPathReady: result.recordedModelPathReady
      };
    }
    case "run": {
      const config = await loadExperienceReplayConfig(command.configPath);
      const oracleBrief = command.oracleBriefPath
        ? await readFile(command.oracleBriefPath, "utf8")
        : undefined;
      const oracleBriefSha256 = oracleBrief
        ? createHash("sha256").update(oracleBrief).digest("hex")
        : undefined;
      const codexAuthMode = command.codexSubscription
        ? "subscription"
        : "api_key";
      const artifactLocation = command.oracleCorpusPath
        ? oracleArtifactLocation(
            command.oracleCorpusPath,
            EXPERIENCE_REPLAY_REPOSITORY_ROOT
          )
        : undefined;
      const inspectedCorpus = command.oracleRepeatedStudy
        ? await inspectOracleCorpusArtifact(artifactLocation!)
        : undefined;
      const inspectedCollection = command.oracleCampaign
        ? await inspectOracleCorpusCollection({
            corpusRoot: command.oracleCorpusPath!,
            repositoryRoot: EXPERIENCE_REPLAY_REPOSITORY_ROOT
          })
        : undefined;
      const campaignDefinition = command.oracleCampaign
        ? await inspectOracleCampaignDefinition({
            manifestPath: command.oracleCampaignManifestPath!,
            repositoryRoot: EXPERIENCE_REPLAY_REPOSITORY_ROOT
          })
        : undefined;
      const qualificationManifest = command.oracleCorpusQualification
        ? await inspectOracleQualificationManifest({
            manifestPath: command.oracleQualificationManifestPath!,
            repositoryRoot: EXPERIENCE_REPLAY_REPOSITORY_ROOT
          })
        : undefined;
      if (
        inspectedCollection &&
        campaignDefinition &&
        (inspectedCollection.entries.size !==
          campaignDefinition.taskUniverseDigests.length ||
          campaignDefinition.taskUniverseDigests.some(
            (digest) => !inspectedCollection.entries.has(digest)
          ))
      ) {
        throw new Error(
          "Oracle campaign corpus collection must exactly cover the declared task universe"
        );
      }
      if (inspectedCollection)
        assertCampaignCorpusIdentity(
          inspectedCollection.entries.values(),
          config
        );
      const recorded =
        config.profile === "smoke"
          ? null
          : createRecordedPreflightRuntime(
              config,
              process.env,
              {},
              codexAuthMode,
              inspectedCollection && campaignDefinition
                ? campaignShardEntries(
                    inspectedCollection,
                    campaignDefinition.shardTaskDigests
                  ).map((entry) => entry.identity.taskImage)
                : inspectedCorpus
                  ? [inspectedCorpus.identity.taskImage]
                  : undefined
            );
      const result = await preflightExperienceReplay({
        config,
        confirmPaidRun: command.confirmPaidRun || command.codexSubscription,
        executionKind: command.oracleSeededProof
          ? "oracle_seeded_product_proof"
          : command.oracleRepeatedStudy
            ? "oracle_seeded_repeated_study"
            : command.oracleCampaign
              ? "oracle_seeded_campaign"
              : command.oracleCorpusQualification
                ? "oracle_corpus_qualification"
                : command.productPathProof
                  ? "product_path_proof"
                  : "benchmark_profile",
        oracleBriefSha256,
        oracleCorpusManifestSha256: inspectedCorpus?.attestationSha256,
        ...(qualificationManifest
          ? { oracleCorpusManifestSha256: qualificationManifest.manifestSha256 }
          : {}),
        oracleCorpusCollectionManifestSha256:
          inspectedCollection?.manifest.manifestSha256,
        oracleCampaignDefinitionSha256: campaignDefinition?.manifestSha256,
        campaignTaskDigests: campaignDefinition?.shardTaskDigests,
        ...(qualificationManifest
          ? {
              campaignTaskDigests: qualificationManifest.tasks.map(
                (task) => task.taskDigest
              ),
              oracleQualificationMaximumAttempts:
                qualificationManifest.tasks.reduce(
                  (sum, task) => sum + task.maximumAttempts,
                  0
                )
            }
          : {}),
        campaignTaskUniverseDigests: campaignDefinition?.taskUniverseDigests,
        campaignId: campaignDefinition?.campaignId,
        campaignShardId: campaignDefinition?.shardId,
        campaignReferenceScore: campaignDefinition?.referenceScore,
        ...(command.oracleRepeats === null
          ? {}
          : { oracleRepeats: command.oracleRepeats }),
        codexAuthMode,
        requireRunnable: true,
        ...(recorded
          ? {
              recordedRunAdapters: recorded.adapters,
              productPathReady: recorded.productPathReady
            }
          : {})
      });
      const oracleCorpus: OracleCorpusArtifactEntry | undefined =
        command.oracleRepeatedStudy
          ? await loadOracleCorpusArtifact(
              artifactLocation!,
              oracleArtifactIdentity(result, inspectedCorpus)
            )
          : undefined;
      const oracleCorpusCollection = inspectedCollection
        ? new Map(
            await Promise.all(
              [...inspectedCollection.entries.values()].map(
                async (entry) =>
                  [
                    entry.identity.task.digest,
                    await loadOracleCorpusArtifact(
                      oracleArtifactLocation(
                        inspectedCollection.directories.get(
                          entry.identity.task.digest
                        )!,
                        EXPERIENCE_REPLAY_REPOSITORY_ROOT
                      ),
                      campaignDefinition!.shardTaskDigests.includes(
                        entry.identity.task.digest
                      )
                        ? oracleArtifactIdentity(
                            result,
                            entry,
                            entry.identity.task.digest
                          )
                        : entry.identity
                    )
                  ] as const
              )
            )
          )
        : undefined;
      const dependencies = createCliExperienceReplayDependencies(
        config,
        process.env,
        undefined,
        result.frozenTaskImages,
        codexAuthMode,
        requiresForcedMemoryAnswerProof(result.runPlan.kind)
      );
      if (qualificationManifest) {
        return qualifyOracleCorpusCollection({
          preflight: result,
          dependencies,
          manifest: qualificationManifest,
          corpusDirectory: command.oracleCorpusPath!
        });
      }
      return runExperienceReplay(config, {
        preflight: result,
        dependencies,
        ...(oracleBrief ? { oracleBrief } : {}),
        ...(oracleCorpus ? { oracleCorpusArtifactEntry: oracleCorpus } : {}),
        ...(oracleCorpusCollection
          ? { oracleCorpusArtifactEntries: oracleCorpusCollection }
          : {}),
        ...(command.oracleSeededProof && artifactLocation
          ? {
              oracleCorpusArtifactTarget: {
                location: artifactLocation,
                identity: oracleArtifactIdentity(result)
              }
            }
          : {})
      });
    }
    case "resume": {
      const identity = await readExperienceReplayResumeIdentity(
        command.runDirectory
      );
      const persistedCampaignProtocol =
        identity.runPlan.kind === "oracle_seeded_campaign"
          ? (JSON.parse(
              await readFile(
                path.join(identity.runRoot, "campaign/protocol.json"),
                "utf8"
              )
            ) as OracleCampaignProtocol)
          : undefined;
      const persistedCampaignShard =
        identity.runPlan.kind === "oracle_seeded_campaign"
          ? (JSON.parse(
              await readFile(
                path.join(identity.runRoot, "campaign/shard.json"),
                "utf8"
              )
            ) as OracleCampaignShardManifest)
          : undefined;
      const recorded =
        identity.config.profile === "smoke"
          ? null
          : createRecordedPreflightRuntime(
              identity.config,
              process.env,
              {},
              identity.runPlan.codexAuthMode,
              identity.recordedRunAttestation?.taskImages
            );
      const result = await preflightExperienceReplay({
        config: identity.config,
        confirmPaidRun: identity.config.profile !== "smoke",
        executionKind: identity.runPlan.kind,
        oracleBriefSha256: identity.runPlan.oracleBriefSha256,
        oracleCorpusManifestSha256: identity.runPlan.oracleCorpusManifestSha256,
        oracleCorpusCollectionManifestSha256:
          identity.runPlan.oracleCorpusCollectionManifestSha256,
        oracleCampaignDefinitionSha256:
          identity.runPlan.oracleCampaignDefinitionSha256,
        campaignTaskDigests:
          identity.runPlan.kind === "oracle_seeded_campaign"
            ? identity.runPlan.replayTargetTaskDigests
            : undefined,
        campaignShardId: persistedCampaignShard?.shardId,
        persistedCampaignProtocol,
        codexAuthMode: identity.runPlan.codexAuthMode,
        requireRunnable: true,
        ...(recorded
          ? {
              recordedRunAdapters: recorded.adapters,
              productPathReady: recorded.productPathReady
            }
          : {})
      });
      const dependencies = createCliExperienceReplayDependencies(
        identity.config,
        process.env,
        identity.runId,
        result.frozenTaskImages,
        identity.runPlan.codexAuthMode,
        requiresForcedMemoryAnswerProof(identity.runPlan.kind)
      );
      const resumedCorpusLocation = oracleArtifactLocation(
        path.join(identity.runRoot, "oracle-private"),
        EXPERIENCE_REPLAY_REPOSITORY_ROOT
      );
      const inspectedResumedCorpus = identity.runPlan.oracleCorpusManifestSha256
        ? await inspectOracleCorpusArtifact(resumedCorpusLocation)
        : undefined;
      const resumedOracleCorpus = inspectedResumedCorpus
        ? await loadOracleCorpusArtifact(
            resumedCorpusLocation,
            oracleArtifactIdentity(result, inspectedResumedCorpus)
          )
        : undefined;
      const resumedOracleCorpusCollection =
        identity.runPlan.kind === "oracle_seeded_campaign"
          ? await loadPersistedOracleCorpusCollection(identity.runRoot)
          : undefined;
      return {
        reportPath: await resumeExperienceReplay(identity.runRoot, {
          preflight: result,
          dependencies,
          ...(resumedOracleCorpus
            ? { oracleCorpusArtifactEntry: resumedOracleCorpus }
            : {}),
          ...(resumedOracleCorpusCollection
            ? { oracleCorpusArtifactEntries: resumedOracleCorpusCollection }
            : {})
        })
      };
    }
    case "report":
      return { reportPath: await reportExistingRun(command.runDirectory) };
    case "sanitize":
      return {
        publicationDirectory: await sanitizeRunReport(command.runDirectory)
      };
  }
};

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runExperienceReplayCli(process.argv.slice(2))
    .then((result) =>
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    )
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`experience-replay: ${message}\n`);
      process.exitCode = 1;
    });
}
