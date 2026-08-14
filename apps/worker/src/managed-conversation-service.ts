import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

import {
  DEVELOPMENT_WORKSPACE_SNAPSHOT_CHUNK_BYTES,
  DEVELOPMENT_WORKSPACE_SNAPSHOT_MAX_BYTES,
  type ClaimedManagedConversationCommand,
  type ManagedConversationExecutionRecord,
  type ManagedConversationForkRecord,
  type ManagedConversationRuntimeBindingRecord,
  type MemorySourceRepository
} from "@koed/db";
import {
  assertCodexConversationProtocolCompatibility,
  checkCodexAppServerAvailability,
  checkClaudeCodeAvailability,
  ClaudeManagedConversationSession,
  CodexManagedConversationIdentityError,
  CodexManagedConversationSession,
  destroyManagedCodexHome,
  destroyManagedClaudeHome,
  forkClaudeTranscript,
  MemoryApiClient,
  MemoryApiError,
  prepareManagedCodexHome,
  prepareManagedClaudeHome,
  processClaudeTranscriptSignal,
  retainManagedClaudeHome,
  resolveClaudeManagedConversationSource,
  reuseManagedCodexHome,
  reuseManagedClaudeHome,
  type ClaudeWatcherState,
  type CodexManagedConversationSealedSource
} from "@koed/mcp-server";
import {
  canonicalManagedConversationHandoffManifest,
  canonicalManagedConversationForkManifest,
  createDeviceBoundSourceSigner,
  managedConversationForkManifestDigest,
  managedConversationHandoffCertificateDigest,
  managedConversationTargetReadinessEvidenceDigest,
  managedConversationTargetReadinessIsFresh,
  MANAGED_CONVERSATION_TARGET_READINESS_PROTOCOL,
  verifyManagedConversationForkManifest,
  verifyManagedConversationHandoffCertificate,
  verifyManagedConversationHandoffSourceAttestation,
  upstreamApiUrl,
  type EnvelopeEncryptionProvider,
  type ManagedConversationTargetReadinessEvidence
} from "@koed/shared";
import type { Logger } from "pino";

import {
  createDevelopmentWorkspaceSnapshot,
  materializeDevelopmentWorkspaceSnapshot,
  verifyDevelopmentWorkspaceSnapshotMaterialization,
  type DevelopmentWorkspaceSnapshotPackage
} from "./development-workspace-snapshot.js";
import { discoverManagedConversationRuntime } from "./managed-conversation-runtime-discovery.js";
import {
  ManagedConversationRuntimeRegistry,
  runWithManagedConversationLease,
  type ManagedConversationProvider
} from "./managed-conversation-provider-runtime.js";

const commandLeaseMs = 180_000;
const commandHeartbeatMs = 45_000;
const restorationLeaseMs = 180_000;
const defaultTurnTimeoutMs = 10 * 60_000;
const maximumSourceSegments = 1_000_000;
const maximumSourceBytes = 512 * 1024 * 1024;
const targetReadinessTtlMs = 5 * 60_000;

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const managedClaudeCaptureState = (target: string): ClaudeWatcherState => {
  try {
    const state = JSON.parse(
      readFileSync(target, "utf8")
    ) as ClaudeWatcherState;
    if (
      state.version === 2 &&
      Number.isFinite(Date.parse(state.activatedAt)) &&
      state.cursors &&
      typeof state.cursors === "object"
    ) {
      return state;
    }
  } catch {
    // A missing or invalid cursor file is recovered through idempotent replay.
  }
  return {
    version: 2,
    activatedAt: new Date(0).toISOString(),
    cursors: {}
  };
};

const strictBase64 = (value: unknown): Buffer => {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw new Error("ManagedConversationSourceEncodingError");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error("ManagedConversationSourceEncodingError");
  }
  return bytes;
};

type ForkSourceBoundary = {
  threadId: string;
  sessionId: string;
  logicalSessionId: string;
  artifactId: string;
  logicalSourceId: string;
  sourceGenerationId: string;
  originKeyId: string;
  closureHash: string;
  providerCursorOffset: number;
  providerCursorLine: number;
};

type CommandWakeClient = {
  query(sql: string): Promise<unknown>;
  on(
    event: "notification",
    listener: (message: { channel: string; payload?: string }) => void
  ): void;
  on(event: "error", listener: (error: unknown) => void): void;
  removeAllListeners(event?: "notification" | "error"): void;
  release(): void;
};

type CommandWakePool = {
  connect(): Promise<CommandWakeClient>;
};

export interface ManagedConversationService {
  start(): void;
  stop(): Promise<void>;
  processOnce(): Promise<{ completed: number; failed: number }>;
}

class ManagedConversationLeaseLostError extends Error {
  constructor() {
    super("Managed Conversation execution lease was lost");
    this.name = "ManagedConversationLeaseLostError";
  }
}

export class ManagedConversationSourceReplicaPendingError extends Error {
  constructor(
    readonly sourceGenerationId: string,
    readonly readinessLocation: "local" | "authority" = "local",
    readonly replicationAction: "none" | "restore" | "publish" = "none",
    readonly readiness: "finalized" | "registered" = "finalized"
  ) {
    super("The exact Conversation source generation is not materialized yet");
    this.name = "ManagedConversationSourceReplicaPendingError";
  }
}

export const shouldRecoverForkPreparationFailure = (error: unknown): boolean =>
  !(error instanceof ManagedConversationSourceReplicaPendingError);

export const shouldRequestManagedConversationSourceRestore = (
  error: unknown
): boolean =>
  error instanceof ManagedConversationSourceReplicaPendingError &&
  error.replicationAction === "restore";

export const shouldPublishManagedConversationSource = (
  error: unknown
): boolean =>
  error instanceof ManagedConversationSourceReplicaPendingError &&
  error.replicationAction === "publish";

export const reconcileBlockedManagedConversationSource = async (input: {
  blocked: boolean;
  sourceGenerationId: string;
  isReady: (sourceGenerationId: string) => Promise<boolean>;
  release: (sourceGenerationId: string) => Promise<void>;
}): Promise<boolean> => {
  if (!input.blocked || !(await input.isReady(input.sourceGenerationId))) {
    return false;
  }
  await input.release(input.sourceGenerationId);
  return true;
};

export const managedClaudeRuntimeHome = (
  binding: Pick<
    ManagedConversationRuntimeBindingRecord,
    "managedHome" | "transcriptPath"
  >,
  override?: string
): string | undefined => override ?? binding.managedHome ?? undefined;

const managedConversationErrorCodePattern =
  /^ManagedConversation[A-Za-z0-9_.-]{0,100}$/;

export const managedConversationFailureCode = (error: unknown): string => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof CodexManagedConversationIdentityError) {
      return "ManagedConversationSourceIdentityError";
    }
    if (
      current instanceof Error &&
      current.name === "CodexManagedConversationCapacityError"
    ) {
      return "ManagedConversationCapacityError";
    }
    const candidate = record(current);
    const payload = record(candidate.payload);
    if (
      typeof payload.error === "string" &&
      managedConversationErrorCodePattern.test(payload.error)
    ) {
      return payload.error;
    }
    if (current instanceof Error) {
      if (managedConversationErrorCodePattern.test(current.name)) {
        return current.name;
      }
      if (
        current.name === "Error" &&
        managedConversationErrorCodePattern.test(current.message)
      ) {
        return current.message;
      }
      current = current.cause;
      continue;
    }
    current = candidate.cause;
  }
  return "ManagedConversationFailure";
};

const errorCode = managedConversationFailureCode;

const managedConversationError = (name: string, cause?: unknown): Error => {
  const error = new Error(name, cause === undefined ? undefined : { cause });
  error.name = name;
  return error;
};

export const managedConversationOriginSourceGeneration = (
  value: unknown,
  expected: {
    sessionId: string;
    providerThreadId: string;
    sourceKind: "codex" | "claude-code";
  }
): string => {
  const artifact = record(value);
  if (
    artifact.sourceKind !== expected.sourceKind ||
    artifact.externalSessionId !== expected.providerThreadId ||
    artifact.replicaRole !== "origin_local" ||
    artifact.sessionId !== expected.sessionId ||
    typeof artifact.sourceGenerationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      artifact.sourceGenerationId
    )
  ) {
    throw managedConversationError("ManagedConversationSourceIdentityError");
  }
  return artifact.sourceGenerationId;
};

const promptFrom = (command: ClaimedManagedConversationCommand): string => {
  const prompt = command.payload?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw Object.assign(new Error("Managed Conversation prompt is invalid"), {
      name: "ManagedConversationPayloadError"
    });
  }
  return prompt;
};

export const createManagedConversationService = (options: {
  repository: MemorySourceRepository;
  apiUrl: string;
  apiToken: string;
  localOwnerUserId: string;
  appServerBinary: string;
  model: string;
  claudeModel: string;
  reasoningEffort: string;
  deviceId: string;
  deploymentId: string;
  koedHome: string;
  envelopeEncryptionProvider: EnvelopeEncryptionProvider;
  sourceRestoreControl?: {
    ensure(input: {
      transferKind: "handoff" | "fork";
      transferId: string;
      operationId: string;
      sourceGenerationId: string;
    }): Promise<void>;
  };
  sourcePublishControl?: {
    ensure(input: { sourceGenerationId: string }): Promise<void>;
    ensureRegistration(input: { sourceGenerationId: string }): Promise<void>;
  };
  commandWakePool?: CommandWakePool;
  remoteWake?: {
    baseUrl: string;
    authorization: string;
    fetch?: typeof fetch;
  };
  turnTimeoutMs?: number;
  logger: Logger;
}): ManagedConversationService => {
  const runnerId = randomUUID();
  const runtimeSessions = new ManagedConversationRuntimeRegistry();
  const claudeCaptureStatePath = resolve(
    options.koedHome,
    "state",
    "managed-claude-capture.json"
  );
  const claudeCaptureState = managedClaudeCaptureState(claudeCaptureStatePath);
  const turnTimeoutMs = Math.max(
    options.turnTimeoutMs ?? defaultTurnTimeoutMs,
    1_000
  );
  let running = false;
  let drainPromise: Promise<void> | null = null;
  let runAgain = false;
  let stopped = false;
  let wakeClient: CommandWakeClient | null = null;
  let sourceWakeClient: CommandWakeClient | null = null;
  let sourceWakeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let sourceWakeReconnectAttempt = 0;
  let startupRecovery: Promise<void> | null = null;
  let remoteWakeAbort: AbortController | null = null;
  let wakeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeReconnectAttempt = 0;
  let runnerHeartbeat: ReturnType<typeof setInterval> | null = null;
  let runtimeRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  const memoryClient = new MemoryApiClient({
    apiUrl: options.apiUrl,
    apiToken: options.apiToken,
    requestTimeoutMs: 60_000
  });

  const persistClaudeCaptureState = async (): Promise<void> => {
    await mkdir(dirname(claudeCaptureStatePath), {
      recursive: true,
      mode: 0o700
    });
    const temporary = `${claudeCaptureStatePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(claudeCaptureState)}\n`, {
      mode: 0o600
    });
    await rename(temporary, claudeCaptureStatePath);
  };

  const renewOwnedRuntimes = async (): Promise<void> => {
    for (const [executionId, managed] of runtimeSessions.entries()) {
      let renewed: boolean;
      try {
        renewed =
          await options.repository.renewManagedConversationExecutionLease({
            executionId,
            executionGeneration: managed.executionGeneration,
            runnerId,
            leaseMs: commandLeaseMs
          });
      } catch {
        renewed = false;
      }
      if (!renewed) {
        runtimeSessions.deleteAny(executionId);
        await managed.session.closeAndWait().catch(() => undefined);
        options.logger.warn(
          {
            event: {
              name: "worker.managed_conversation.runner_fenced",
              category: "managed_conversation"
            },
            execution_id: executionId
          },
          "managed Conversation runner lost execution authority"
        );
      }
    }
  };

  const createSession = (
    execution: ManagedConversationExecutionRecord,
    binding: ManagedConversationRuntimeBindingRecord,
    override?: {
      projectPath: string;
      resume?: {
        threadId: string;
        sessionId: string;
        transcriptPath: string;
        codexHome: string;
      };
      fork?: {
        parentThreadId: string;
        sourceTranscriptPath: string;
        codexHome: string;
      };
    }
  ): CodexManagedConversationSession =>
    new CodexManagedConversationSession({
      memoryClient,
      projectId: execution.projectId,
      appServer: {
        appServerBinary: options.appServerBinary,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        cwd: override?.projectPath ?? binding.projectPath,
        env: process.env,
        clientName: "koed-server-managed-conversation",
        baseInstructions:
          "You are Codex, an AI coding agent working with the user in the selected Project."
      },
      ...(override?.resume
        ? { resume: override.resume }
        : override?.fork
          ? { fork: override.fork }
          : binding.localSessionId &&
              binding.providerThreadId &&
              binding.transcriptPath &&
              binding.managedHome
            ? {
                resume: {
                  threadId: binding.providerThreadId,
                  sessionId: binding.localSessionId,
                  transcriptPath: binding.transcriptPath,
                  codexHome: binding.managedHome
                }
              }
            : {})
    });

  const createClaudeSession = (
    execution: ManagedConversationExecutionRecord,
    binding: ManagedConversationRuntimeBindingRecord,
    override?: {
      projectPath?: string;
      sessionId?: string;
      resumeSessionId?: string;
      managedHome?: string;
    }
  ): ClaudeManagedConversationSession => {
    const managedHome = managedClaudeRuntimeHome(
      binding,
      override?.managedHome
    );
    const exactHome = managedHome
      ? reuseManagedClaudeHome(managedHome, process.env)
      : undefined;
    if (!exactHome) {
      throw new Error("ManagedConversationClaudeSessionStoreMissingError");
    }
    return new ClaudeManagedConversationSession({
      cwd: override?.projectPath ?? binding.projectPath,
      model: options.claudeModel,
      permissionMode: "acceptEdits",
      env: process.env,
      managedHome: exactHome,
      clientName: "koed-server-managed-conversation",
      tools: { type: "preset", preset: "claude_code" },
      settingSources: [],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          "You are Claude Code working with the user in the selected Koed Project."
      },
      maxTurns: 100,
      ...(override?.resumeSessionId
        ? { resumeSessionId: override.resumeSessionId }
        : override?.sessionId
          ? { sessionId: override.sessionId }
          : binding.providerThreadId
            ? binding.transcriptPath
              ? { resumeSessionId: binding.providerThreadId }
              : { sessionId: binding.providerThreadId }
            : {})
    });
  };

  const captureClaudeTurn = async (input: {
    sessionId: string;
    cwd: string;
    turnBoundary: boolean;
    hookEventName?: "Stop" | "SessionEnd";
    managedHome?: string;
  }): Promise<{
    transcriptPath: string;
    managedHome: string;
    localSessionId: string;
    sourceGenerationId: string;
  }> => {
    const captureEnvironment = input.managedHome
      ? { ...process.env, KOED_CLAUDE_SESSION_STORE_DIR: input.managedHome }
      : process.env;
    const source = resolveClaudeManagedConversationSource(
      input.sessionId,
      captureEnvironment
    );
    await processClaudeTranscriptSignal(
      memoryClient,
      claudeCaptureState,
      {
        sourceSessionId: input.sessionId,
        transcriptPath: source.transcriptPath,
        cwd: input.cwd,
        hookEventName: input.hookEventName ?? "Stop",
        turnBoundary: input.turnBoundary,
        observedAt: new Date().toISOString()
      },
      captureEnvironment
    );
    await persistClaudeCaptureState();
    const artifact = record(
      (
        await memoryClient.lookupConversationSourceArtifact({
          sourceKind: "claude-code",
          externalSessionId: input.sessionId
        })
      ).artifact
    );
    if (
      typeof artifact.sessionId !== "string" ||
      typeof artifact.sourceGenerationId !== "string"
    ) {
      throw managedConversationError("ManagedConversationSourceIdentityError");
    }
    return {
      ...source,
      localSessionId: artifact.sessionId,
      sourceGenerationId: managedConversationOriginSourceGeneration(artifact, {
        sessionId: artifact.sessionId,
        providerThreadId: input.sessionId,
        sourceKind: "claude-code"
      })
    };
  };

  const runtimeBindingFor = async (
    execution: ManagedConversationExecutionRecord,
    ownerUserId: string,
    projectPathOverride?: string
  ): Promise<ManagedConversationRuntimeBindingRecord> => {
    if (
      execution.runnerDeviceId !== options.deviceId ||
      execution.runnerDeploymentId !== options.deploymentId
    ) {
      throw new Error("ManagedConversationRunnerAssignmentError");
    }
    const actor = { userId: ownerUserId };
    const current =
      await options.repository.getManagedConversationRuntimeBinding(
        actor,
        execution.id
      );
    if (
      current &&
      current.deviceId === options.deviceId &&
      current.deploymentId === options.deploymentId &&
      current.executionGeneration === execution.executionGeneration &&
      (!projectPathOverride || current.projectPath === projectPathOverride)
    ) {
      return current;
    }
    let projectPath = projectPathOverride?.trim();
    if (!projectPath) {
      const projects = await options.repository.listLcmGraphThreads(actor, {
        projectId: execution.projectId,
        limit: 1
      });
      projectPath =
        projects.find(
          (candidate) =>
            candidate.id === execution.projectId && candidate.path?.trim()
        )?.path ?? undefined;
    }
    if (!projectPath) {
      throw new Error("ManagedConversationProjectUnavailableError");
    }
    return options.repository.upsertManagedConversationRuntimeBinding(actor, {
      executionId: execution.id,
      deploymentId: options.deploymentId,
      deviceId: options.deviceId,
      executionGeneration: execution.executionGeneration,
      projectPath
    });
  };

  const recoverLocalRuntimeBinding = async (
    execution: ManagedConversationExecutionRecord,
    currentBinding: ManagedConversationRuntimeBindingRecord | null
  ): Promise<ManagedConversationRuntimeBindingRecord> => {
    if (
      currentBinding?.localSessionId &&
      currentBinding.providerThreadId &&
      currentBinding.transcriptPath &&
      currentBinding.managedHome
    ) {
      return currentBinding;
    }
    if (
      execution.state !== "running" ||
      !execution.providerThreadId ||
      !execution.logicalSessionId
    ) {
      if (currentBinding) return currentBinding;
      return runtimeBindingFor(execution, execution.ownerUserId);
    }
    const discovered = await discoverManagedConversationRuntime({
      koedHome: options.koedHome,
      providerThreadId: execution.providerThreadId
    }).catch((error: unknown) => {
      throw managedConversationError(
        "ManagedConversationRuntimeDiscoveryError",
        error
      );
    });
    if (!discovered) {
      throw managedConversationError(
        "ManagedConversationRuntimeRecoveryPendingError"
      );
    }
    if (!discovered.projectPath) {
      throw managedConversationError(
        "ManagedConversationProjectUnavailableError"
      );
    }
    const binding =
      currentBinding ??
      (await runtimeBindingFor(
        execution,
        execution.ownerUserId,
        discovered.projectPath
      ).catch((error: unknown) => {
        throw managedConversationError(
          "ManagedConversationRuntimeRecoveryBindingError",
          error
        );
      }));
    if (
      execution.providerCliVersion &&
      discovered.providerCliVersion !== execution.providerCliVersion
    ) {
      throw managedConversationError(
        "ManagedConversationProviderCompatibilityError"
      );
    }
    const transcript = await stat(discovered.transcriptPath);
    if (!transcript.isFile()) {
      throw managedConversationError(
        "ManagedConversationRuntimeRecoverySourceError"
      );
    }
    const artifact = await memoryClient
      .lookupConversationSourceArtifact({
        sourceKind: "codex",
        externalSessionId: execution.providerThreadId
      })
      .then((lookup) => record(lookup.artifact))
      .catch((error: unknown) => {
        if (error instanceof MemoryApiError && error.status === 404)
          return null;
        throw error;
      });
    if (
      artifact &&
      (artifact.sourceKind !== "codex" ||
        artifact.externalSessionId !== execution.providerThreadId ||
        artifact.replicaRole !== "origin_local" ||
        typeof artifact.sessionId !== "string" ||
        typeof artifact.sourceGenerationId !== "string" ||
        typeof artifact.providerCursorOffset !== "number" ||
        transcript.size < artifact.providerCursorOffset ||
        (execution.sourceGenerationId !== null &&
          artifact.sourceGenerationId !== execution.sourceGenerationId))
    ) {
      throw managedConversationError(
        "ManagedConversationRuntimeRecoverySourceError"
      );
    }
    const capturedSession = artifact
      ? await options.repository.getCapturedSession(
          { userId: execution.ownerUserId },
          artifact.sessionId as string
        )
      : await options.repository
          .createCapturedSession(
            { userId: execution.ownerUserId },
            {
              logicalSessionId: execution.logicalSessionId,
              projectId: execution.projectId,
              externalSessionId: execution.providerThreadId,
              sourceRuntime: "codex",
              captureMethod: "api",
              model: options.model,
              cwd: binding.projectPath,
              idempotencyKey: `managed-codex-session:${execution.providerThreadId}`,
              detectedProjects: [
                {
                  id: execution.projectId,
                  name: basename(binding.projectPath),
                  path: binding.projectPath
                }
              ],
              metadata: {
                managedConversation: true,
                externalThreadId: execution.providerThreadId,
                recoveredRuntimeBinding: true,
                cliVersion:
                  execution.providerCliVersion ??
                  discovered.providerCliVersion ??
                  null
              }
            }
          )
          .catch((error: unknown) => {
            throw managedConversationError(
              "ManagedConversationRuntimeRecoverySessionError",
              error
            );
          });
    if (
      !capturedSession ||
      capturedSession.logicalSessionId !== execution.logicalSessionId ||
      capturedSession.externalSessionId !== execution.providerThreadId
    ) {
      throw managedConversationError(
        "ManagedConversationRuntimeRecoveryIdentityError"
      );
    }
    const providerCliVersion =
      execution.providerCliVersion ?? discovered.providerCliVersion;
    return options.repository
      .bindManagedConversationLocalRuntime(
        { userId: execution.ownerUserId },
        {
          executionId: execution.id,
          deploymentId: options.deploymentId,
          deviceId: options.deviceId,
          executionGeneration: execution.executionGeneration,
          localSessionId: capturedSession.id,
          providerThreadId: execution.providerThreadId,
          transcriptPath: discovered.transcriptPath,
          managedHome: discovered.managedHome,
          ...(providerCliVersion ? { providerCliVersion } : {}),
          ...(artifact?.sourceGenerationId
            ? { sourceGenerationId: artifact.sourceGenerationId as string }
            : execution.sourceGenerationId
              ? { sourceGenerationId: execution.sourceGenerationId }
              : {})
        }
      )
      .catch((error: unknown) => {
        throw managedConversationError(
          "ManagedConversationRuntimeRecoveryBindingError",
          error
        );
      });
  };

  const recoverOwnedRuntimes = async (): Promise<void> => {
    const executions =
      await options.repository.listManagedConversationExecutionsForRunner({
        ownerUserId: options.localOwnerUserId,
        deploymentId: options.deploymentId,
        deviceId: options.deviceId,
        limit: 500
      });
    for (const execution of executions) {
      if (stopped) return;
      if (execution.state !== "running") continue;
      let acquired = false;
      let recoveredSession:
        | CodexManagedConversationSession
        | ClaudeManagedConversationSession
        | null = null;
      try {
        const binding =
          await options.repository.getManagedConversationRuntimeBinding(
            { userId: execution.ownerUserId },
            execution.id
          );
        if (execution.provider === "claude") {
          if (
            !binding ||
            !binding.localSessionId ||
            !binding.providerThreadId ||
            binding.providerThreadId !== execution.providerThreadId ||
            !execution.logicalSessionId
          ) {
            throw managedConversationError(
              "ManagedConversationRuntimeRecoveryPendingError"
            );
          }
          const captured = await options.repository.getCapturedSession(
            { userId: execution.ownerUserId },
            binding.localSessionId
          );
          if (
            !captured ||
            captured.logicalSessionId !== execution.logicalSessionId ||
            captured.externalSessionId !== binding.providerThreadId
          ) {
            throw managedConversationError(
              "ManagedConversationRuntimeRecoveryIdentityError"
            );
          }
          acquired =
            await options.repository.acquireManagedConversationExecutionLease({
              executionId: execution.id,
              executionGeneration: execution.executionGeneration,
              deploymentId: options.deploymentId,
              deviceId: options.deviceId,
              runnerId,
              leaseMs: commandLeaseMs
            });
          if (!acquired) continue;
          recoveredSession = createClaudeSession(execution, binding);
          const started = await recoveredSession.start();
          if (started.identity.sessionId !== execution.providerThreadId) {
            throw managedConversationError(
              "ManagedConversationRuntimeRecoveryIdentityError"
            );
          }
          runtimeSessions.set("claude", execution.id, {
            executionGeneration: execution.executionGeneration,
            session: recoveredSession
          });
          continue;
        }
        const recovered = await recoverLocalRuntimeBinding(execution, binding);
        acquired =
          await options.repository.acquireManagedConversationExecutionLease({
            executionId: execution.id,
            executionGeneration: execution.executionGeneration,
            deploymentId: options.deploymentId,
            deviceId: options.deviceId,
            runnerId,
            leaseMs: commandLeaseMs
          });
        if (stopped && acquired) {
          await options.repository
            .releaseManagedConversationRunner({
              executionId: execution.id,
              executionGeneration: execution.executionGeneration,
              runnerId
            })
            .catch(() => false);
          acquired = false;
          return;
        }
        if (!acquired) {
          const expiresAt = execution.runnerLeaseExpiresAt
            ? Date.parse(execution.runnerLeaseExpiresAt)
            : Number.NaN;
          if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
            const delayMs = Math.max(expiresAt - Date.now() + 50, 50);
            if (runtimeRecoveryTimer) clearTimeout(runtimeRecoveryTimer);
            runtimeRecoveryTimer = setTimeout(() => {
              runtimeRecoveryTimer = null;
              startupRecovery = null;
              void ensureStartupRecovery().catch(() => undefined);
            }, delayMs);
            runtimeRecoveryTimer.unref?.();
          }
          continue;
        }
        recoveredSession = createSession(execution, recovered);
        const started = await recoveredSession.start();
        if (
          started.thread.id !== execution.providerThreadId ||
          started.sessionId !== recovered.localSessionId ||
          (execution.providerCliVersion &&
            started.thread.cliVersion !== execution.providerCliVersion)
        ) {
          throw managedConversationError(
            "ManagedConversationRuntimeRecoveryIdentityError"
          );
        }
        if (stopped) {
          await recoveredSession.closeAndWait().catch(() => undefined);
          recoveredSession = null;
          await options.repository
            .releaseManagedConversationRunner({
              executionId: execution.id,
              executionGeneration: execution.executionGeneration,
              runnerId
            })
            .catch(() => false);
          acquired = false;
          return;
        }
        runtimeSessions.set("codex", execution.id, {
          executionGeneration: execution.executionGeneration,
          session: recoveredSession
        });
      } catch (error) {
        if (recoveredSession) {
          await recoveredSession.closeAndWait().catch(() => undefined);
        }
        if (acquired) {
          await options.repository
            .releaseManagedConversationRunner({
              executionId: execution.id,
              executionGeneration: execution.executionGeneration,
              runnerId
            })
            .catch(() => false);
        }
        options.logger.warn(
          {
            event: {
              name: "worker.managed_conversation.runtime_recovery_deferred",
              category: "managed_conversation"
            },
            execution_id: execution.id,
            error_name: errorCode(error)
          },
          "managed Conversation runtime recovery is waiting for exact local state"
        );
      }
    }
  };

  const ensureStartupRecovery = (): Promise<void> => {
    startupRecovery ??= recoverOwnedRuntimes().catch((error) => {
      startupRecovery = null;
      throw error;
    });
    return startupRecovery;
  };

  const logicalSessionIdFor = async (
    ownerUserId: string,
    localSessionId: string
  ): Promise<string> => {
    const session = await options.repository.getCapturedSession(
      { userId: ownerUserId },
      localSessionId
    );
    if (!session) {
      throw new Error("ManagedConversationCapturedSessionMissingError");
    }
    return session.logicalSessionId;
  };

  const ensureAuthoritySourceRegistration = async (
    ownerUserId: string,
    sourceGenerationId: string
  ): Promise<void> => {
    if (!options.sourcePublishControl) return;
    await options.sourcePublishControl.ensureRegistration({
      sourceGenerationId
    });
    const registered =
      await options.repository.isManagedConversationSourceGenerationReady({
        ownerUserId,
        sourceGenerationId,
        readiness: "registered"
      });
    if (!registered) {
      throw new ManagedConversationSourceReplicaPendingError(
        sourceGenerationId,
        "authority",
        "publish",
        "registered"
      );
    }
  };

  const targetWorkspacePath = (
    executionId: string,
    generation: number
  ): string =>
    resolve(
      options.koedHome,
      "managed-workspaces",
      executionId,
      `generation-${generation}`
    );

  const forkWorkspacePath = (forkId: string): string =>
    resolve(options.koedHome, "managed-workspaces", "forks", forkId);

  const managedWorkspaceRoot = resolve(options.koedHome, "managed-workspaces");

  const verifyTargetProviderEnvironment = async (
    projectPath: string,
    expectedCliVersion: string,
    provider: string
  ): Promise<{ environmentDigest: string; compatibilityDigest: string }> => {
    if (provider === "claude") {
      const availability = await checkClaudeCodeAvailability(process.env);
      if (
        !availability.available ||
        !availability.authenticated ||
        availability.version !== expectedCliVersion
      ) {
        throw new Error("ManagedConversationProviderCompatibilityError");
      }
      return {
        environmentDigest: sha256(
          JSON.stringify({
            claudeCodeAvailable: true,
            authenticated: true,
            model: options.claudeModel
          })
        ),
        compatibilityDigest: sha256(
          JSON.stringify({
            provider: "claude",
            cliVersion: availability.version,
            transport: "official-claude-agent-sdk"
          })
        )
      };
    }
    if (provider !== "codex") {
      throw new Error("ManagedConversationProviderCompatibilityError");
    }
    const compatibility = assertCodexConversationProtocolCompatibility({
      binary: options.appServerBinary,
      cwd: projectPath,
      env: process.env
    });
    const availability = await checkCodexAppServerAvailability(
      {
        appServerBinary: options.appServerBinary,
        model: options.model,
        cwd: projectPath,
        env: process.env,
        clientName: "koed-managed-conversation-handoff-readiness"
      },
      10_000
    );
    if (!availability.available) {
      throw new Error("ManagedConversationTargetEnvironmentUnavailableError");
    }
    const version = spawnSync(options.appServerBinary, ["--version"], {
      cwd: projectPath,
      env: process.env,
      encoding: "utf8",
      timeout: 10_000,
      shell: process.platform === "win32",
      windowsHide: true
    });
    const versionText =
      `${version.stdout ?? ""}\n${version.stderr ?? ""}`.trim();
    if (
      version.error ||
      version.status !== 0 ||
      !versionText ||
      !versionText.includes(expectedCliVersion)
    ) {
      throw new Error("ManagedConversationProviderCompatibilityError");
    }
    return {
      environmentDigest: sha256(
        JSON.stringify({
          appServerAvailable: true,
          model: options.model,
          reasoningEffort: options.reasoningEffort
        })
      ),
      compatibilityDigest: sha256(
        JSON.stringify({
          cliVersion: expectedCliVersion,
          schemaSha256: compatibility.schemaSha256
        })
      )
    };
  };

  const buildTargetReadinessEvidence = async (input: {
    handoff: {
      operationId: string;
      executionId: string;
      sourceGenerationId: string | null;
      sourceClosureHash: string | null;
      sourceExecutionGeneration: number;
      nextExecutionGeneration: number;
      targetDeploymentId: string;
      targetDeviceId: string;
      workspaceSnapshotId: string | null;
      workspaceManifestDigest: string | null;
      stateVersion: number;
    };
    snapshot: DevelopmentWorkspaceSnapshotPackage;
    packageDigest: string;
    restoredStateDigest: string;
    projectPath: string;
    providerCliVersion: string;
    provider: string;
  }): Promise<ManagedConversationTargetReadinessEvidence> => {
    if (
      !input.handoff.sourceGenerationId ||
      !input.handoff.sourceClosureHash ||
      !input.handoff.workspaceSnapshotId ||
      !input.handoff.workspaceManifestDigest
    ) {
      throw new Error("ManagedConversationReadinessBoundaryError");
    }
    const provider = await verifyTargetProviderEnvironment(
      input.projectPath,
      input.providerCliVersion,
      input.provider
    );
    const checkedAt = new Date();
    const expiresAt = new Date(
      checkedAt.getTime() + targetReadinessTtlMs
    ).toISOString();
    const proof = (evidenceDigest: string) => ({
      status: "verified" as const,
      evidenceDigest,
      checkedAt: checkedAt.toISOString(),
      expiresAt
    });
    const evidence: ManagedConversationTargetReadinessEvidence = {
      protocol: MANAGED_CONVERSATION_TARGET_READINESS_PROTOCOL,
      operationId: input.handoff.operationId,
      executionId: input.handoff.executionId,
      snapshotId: input.handoff.workspaceSnapshotId,
      sourceGenerationId: input.handoff.sourceGenerationId,
      targetDeploymentId: input.handoff.targetDeploymentId,
      targetDeviceId: input.handoff.targetDeviceId,
      dimensions: {
        snapshotIntegrity: proof(
          sha256(
            `${input.snapshot.manifestDigest}:${input.packageDigest}:${input.handoff.workspaceManifestDigest}`
          )
        ),
        objectClosure: proof(
          sha256(`${input.snapshot.bundleSha256}:${input.restoredStateDigest}`)
        ),
        filesystemFidelity: proof(
          sha256(
            `${input.snapshot.sourceStateDigest}:${input.restoredStateDigest}`
          )
        ),
        environmentAvailability: proof(provider.environmentDigest),
        providerCompatibility: proof(provider.compatibilityDigest),
        executionBoundary: proof(
          sha256(
            [
              input.handoff.executionId,
              input.handoff.sourceExecutionGeneration,
              input.handoff.nextExecutionGeneration,
              input.handoff.sourceGenerationId,
              input.handoff.sourceClosureHash,
              input.handoff.stateVersion
            ].join(":")
          )
        )
      }
    };
    managedConversationTargetReadinessEvidenceDigest(evidence);
    return evidence;
  };

  const persistWorkspaceSnapshot = async (input: {
    ownerUserId: string;
    projectId: string;
    executionId: string;
    operationKind: "handoff" | "fork";
    operationId: string;
    sourceGenerationId: string;
    sourceDeploymentId: string;
    sourceDeviceId: string;
    snapshot: DevelopmentWorkspaceSnapshotPackage;
    readinessEvidence: Record<string, unknown>;
  }): Promise<string> => {
    const bytes = Buffer.from(JSON.stringify(input.snapshot), "utf8");
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > DEVELOPMENT_WORKSPACE_SNAPSHOT_MAX_BYTES
    ) {
      throw new Error("ManagedConversationWorkspaceCapacityError");
    }
    const chunkCount = Math.ceil(
      bytes.byteLength / DEVELOPMENT_WORKSPACE_SNAPSHOT_CHUNK_BYTES
    );
    const packageDigest = sha256(bytes);
    const actor = { userId: input.ownerUserId };
    const existing = await options.repository.beginDevelopmentWorkspaceSnapshot(
      actor,
      {
        id: input.snapshot.snapshotId,
        executionId: input.executionId,
        operationKind: input.operationKind,
        operationId: input.operationId,
        sourceGenerationId: input.sourceGenerationId,
        sourceDeploymentId: input.sourceDeploymentId,
        sourceDeviceId: input.sourceDeviceId
      }
    );
    if (existing.state === "ready") {
      if (
        existing.manifestDigest !== input.snapshot.manifestDigest ||
        existing.sourceStateDigest !== input.snapshot.sourceStateDigest ||
        existing.packageDigest !== packageDigest ||
        existing.packageByteCount !== bytes.byteLength ||
        existing.chunkCount !== chunkCount
      ) {
        throw new Error("ManagedConversationWorkspaceSnapshotConflictError");
      }
      return existing.id;
    }
    if (existing.state !== "capturing") {
      throw new Error("ManagedConversationWorkspaceSnapshotConflictError");
    }
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const chunk = bytes.subarray(
        chunkIndex * DEVELOPMENT_WORKSPACE_SNAPSHOT_CHUNK_BYTES,
        Math.min(
          (chunkIndex + 1) * DEVELOPMENT_WORKSPACE_SNAPSHOT_CHUNK_BYTES,
          bytes.byteLength
        )
      );
      const plaintextDigest = sha256(chunk);
      const envelope = await options.envelopeEncryptionProvider.encrypt({
        plaintext: chunk,
        scope: {
          tenantId: input.ownerUserId,
          projectId: input.projectId,
          objectClass: "development_workspace_snapshot_chunk"
        },
        provenance: {
          rowFamily: "development_workspace_snapshot_chunks",
          sourceId: `${input.snapshot.snapshotId}:${chunkIndex}`
        },
        ciphertextLocation:
          "development_workspace_snapshot_chunks.encryption_envelope",
        aad: {
          ownerUserId: input.ownerUserId,
          operationId: input.operationId,
          snapshotId: input.snapshot.snapshotId,
          chunkIndex,
          chunkCount,
          plaintextDigest
        }
      });
      const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
      await options.repository.putDevelopmentWorkspaceSnapshotChunk(actor, {
        snapshotId: input.snapshot.snapshotId,
        operationKind: input.operationKind,
        operationId: input.operationId,
        chunkIndex,
        chunkCount,
        plaintextDigest,
        plaintextByteCount: chunk.byteLength,
        ciphertextDigest: sha256(ciphertext),
        encryptedByteCount: ciphertext.byteLength,
        encryptionEnvelope: envelope
      });
    }
    const stored =
      await options.repository.finalizeDevelopmentWorkspaceSnapshot(actor, {
        snapshotId: input.snapshot.snapshotId,
        operationKind: input.operationKind,
        operationId: input.operationId,
        manifestDigest: input.snapshot.manifestDigest,
        sourceStateDigest: input.snapshot.sourceStateDigest,
        packageDigest,
        packageByteCount: bytes.byteLength,
        chunkCount,
        readinessEvidence: input.readinessEvidence
      });
    if (stored.state !== "ready") {
      throw new Error("ManagedConversationWorkspaceSnapshotNotReadyError");
    }
    return stored.id;
  };

  const reusableWorkspaceSnapshotId = async (input: {
    ownerUserId: string;
    executionId: string;
    operationKind: "handoff" | "fork";
    operationId: string;
    sourceGenerationId: string;
    sourceDeploymentId: string;
    sourceDeviceId: string;
  }): Promise<string | null> => {
    const existing = await options.repository.getDevelopmentWorkspaceSnapshot(
      { userId: input.ownerUserId },
      {
        snapshotId: input.operationId,
        operationKind: input.operationKind,
        operationId: input.operationId
      }
    );
    if (!existing || existing.state === "capturing") return null;
    if (
      existing.state !== "ready" ||
      existing.executionId !== input.executionId ||
      existing.sourceGenerationId !== input.sourceGenerationId ||
      existing.sourceDeploymentId !== input.sourceDeploymentId ||
      existing.sourceDeviceId !== input.sourceDeviceId ||
      !existing.manifestDigest ||
      !existing.sourceStateDigest ||
      !existing.packageDigest ||
      !existing.packageByteCount ||
      !existing.chunkCount
    ) {
      throw new Error("ManagedConversationWorkspaceSnapshotConflictError");
    }
    return existing.id;
  };

  const sourceReplicaPending = (
    error: unknown,
    sourceGenerationId: string,
    codes: readonly string[]
  ): never => {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null;
    if (code && codes.includes(code)) {
      throw new ManagedConversationSourceReplicaPendingError(
        sourceGenerationId,
        "authority",
        "publish"
      );
    }
    throw error;
  };

  const loadWorkspaceSnapshot = async (input: {
    ownerUserId: string;
    operationKind: "handoff" | "fork";
    operationId: string;
    snapshot: {
      id: string;
      manifestDigest: string;
      sourceStateDigest: string;
      packageDigest: string;
      packageByteCount: number;
      chunkCount: number;
    };
  }): Promise<DevelopmentWorkspaceSnapshotPackage> => {
    if (
      input.snapshot.packageByteCount < 1 ||
      input.snapshot.packageByteCount >
        DEVELOPMENT_WORKSPACE_SNAPSHOT_MAX_BYTES ||
      input.snapshot.chunkCount < 1 ||
      input.snapshot.chunkCount >
        Math.ceil(
          DEVELOPMENT_WORKSPACE_SNAPSHOT_MAX_BYTES /
            DEVELOPMENT_WORKSPACE_SNAPSHOT_CHUNK_BYTES
        )
    ) {
      throw new Error("ManagedConversationWorkspaceCapacityError");
    }
    const chunks: Buffer[] = [];
    let byteCount = 0;
    for (
      let chunkIndex = 0;
      chunkIndex < input.snapshot.chunkCount;
      chunkIndex += 1
    ) {
      const chunk =
        await options.repository.getDevelopmentWorkspaceSnapshotChunk(
          { userId: input.ownerUserId },
          {
            snapshotId: input.snapshot.id,
            operationKind: input.operationKind,
            operationId: input.operationId,
            chunkIndex
          }
        );
      if (
        !chunk ||
        chunk.chunkIndex !== chunkIndex ||
        chunk.chunkCount !== input.snapshot.chunkCount
      ) {
        throw new Error("ManagedConversationWorkspaceChunkMissingError");
      }
      const ciphertext = Buffer.from(
        chunk.encryptionEnvelope.ciphertext,
        "base64url"
      );
      if (
        ciphertext.byteLength !== chunk.encryptedByteCount ||
        sha256(ciphertext) !== chunk.ciphertextDigest
      ) {
        throw new Error("ManagedConversationWorkspaceCiphertextError");
      }
      const plaintext = Buffer.from(
        await options.envelopeEncryptionProvider.decrypt(
          chunk.encryptionEnvelope
        )
      );
      if (
        plaintext.byteLength !== chunk.plaintextByteCount ||
        sha256(plaintext) !== chunk.plaintextDigest
      ) {
        throw new Error("ManagedConversationWorkspaceDigestError");
      }
      byteCount += plaintext.byteLength;
      if (byteCount > DEVELOPMENT_WORKSPACE_SNAPSHOT_MAX_BYTES) {
        throw new Error("ManagedConversationWorkspaceCapacityError");
      }
      chunks.push(plaintext);
    }
    const bytes = Buffer.concat(chunks, byteCount);
    if (
      bytes.byteLength !== input.snapshot.packageByteCount ||
      sha256(bytes) !== input.snapshot.packageDigest
    ) {
      throw new Error("ManagedConversationWorkspacePackageError");
    }
    const snapshot = JSON.parse(
      bytes.toString("utf8")
    ) as DevelopmentWorkspaceSnapshotPackage;
    if (
      snapshot.snapshotId !== input.snapshot.id ||
      snapshot.manifestDigest !== input.snapshot.manifestDigest ||
      snapshot.sourceStateDigest !== input.snapshot.sourceStateDigest
    ) {
      throw new Error("ManagedConversationWorkspaceManifestError");
    }
    return snapshot;
  };

  const reconstructSealedTranscript = async (input: {
    threadId: string;
    logicalSourceId: string;
    sourceGenerationId: string;
    closureHash: string;
    endOffset: number;
    endLine: number;
  }): Promise<{
    artifactId: string;
    sourceSessionId: string;
    bytes: Buffer;
  }> => {
    const loadArtifact = async (sourceGenerationId: string) => {
      const lookup = await memoryClient
        .getConversationSourceArtifactByGeneration(sourceGenerationId)
        .catch((error: unknown) => {
          if (error instanceof MemoryApiError && error.status === 404) {
            throw new ManagedConversationSourceReplicaPendingError(
              sourceGenerationId,
              "local",
              "restore"
            );
          }
          throw error;
        });
      return record(lookup.artifact);
    };
    const chain: Array<{
      artifact: Record<string, unknown>;
      expectedClosureHash: string;
    }> = [];
    let sourceGenerationId = input.sourceGenerationId;
    let expectedClosureHash = input.closureHash;
    const seen = new Set<string>();
    while (true) {
      if (seen.has(sourceGenerationId) || seen.size >= 1_024) {
        throw new Error("ManagedConversationSourceGenerationChainError");
      }
      seen.add(sourceGenerationId);
      const artifact = await loadArtifact(sourceGenerationId);
      if (
        artifact.logicalSourceId !== input.logicalSourceId ||
        artifact.sourceGenerationId !== sourceGenerationId ||
        artifact.externalSessionId !== input.threadId
      ) {
        throw new Error("ManagedConversationSourceBoundaryError");
      }
      if (artifact.lifecycle !== "finalized") {
        throw new ManagedConversationSourceReplicaPendingError(
          sourceGenerationId
        );
      }
      if (
        artifact.closureHash !== expectedClosureHash ||
        typeof artifact.id !== "string" ||
        typeof artifact.sessionId !== "string"
      ) {
        throw new Error("ManagedConversationSourceBoundaryError");
      }
      chain.unshift({ artifact, expectedClosureHash });
      const prior = record(artifact.priorGenerationClosure);
      if (Object.keys(prior).length === 0) break;
      if (
        typeof prior.sourceGenerationId !== "string" ||
        typeof prior.contentDigest !== "string"
      ) {
        throw new Error("ManagedConversationSourceGenerationChainError");
      }
      sourceGenerationId = prior.sourceGenerationId;
      expectedClosureHash = prior.contentDigest;
    }
    const first = chain[0]?.artifact;
    const current = chain.at(-1)?.artifact;
    if (
      !first ||
      !current ||
      first.journalStartOffset !== 0 ||
      first.journalStartLine !== 0 ||
      current.providerCursorOffset !== input.endOffset ||
      current.providerCursorLine !== input.endLine
    ) {
      throw new Error("ManagedConversationSourceHistoryIncompleteError");
    }
    const chunks: Buffer[] = [];
    let expectedOffset = 0;
    let expectedLine = 0;
    let count = 0;
    for (const { artifact } of chain) {
      const generationEndOffset = artifact.providerCursorOffset;
      const generationEndLine = artifact.providerCursorLine;
      if (
        artifact.journalStartOffset !== expectedOffset ||
        artifact.journalStartLine !== expectedLine ||
        typeof generationEndOffset !== "number" ||
        typeof generationEndLine !== "number"
      ) {
        throw new Error("ManagedConversationSourceGenerationChainError");
      }
      while (expectedOffset < generationEndOffset) {
        const page = await memoryClient.listConversationSourceSegments(
          artifact.id as string,
          { afterOffset: expectedOffset, limit: 100 }
        );
        const segments = Array.isArray(page.segments) ? page.segments : [];
        if (segments.length === 0) {
          throw new ManagedConversationSourceReplicaPendingError(
            artifact.sourceGenerationId as string
          );
        }
        for (const raw of segments) {
          const segment = record(raw);
          if (
            typeof segment.id !== "string" ||
            segment.sourceStartOffset !== expectedOffset ||
            segment.sourceStartLine !== expectedLine ||
            typeof segment.sourceEndOffset !== "number" ||
            typeof segment.sourceEndLine !== "number" ||
            segment.sourceEndOffset <= expectedOffset ||
            segment.sourceEndOffset > generationEndOffset ||
            typeof segment.plaintextDigest !== "string"
          ) {
            throw new Error("ManagedConversationSourceChainError");
          }
          const content =
            await memoryClient.getConversationSourceSegmentContent(
              artifact.id as string,
              segment.id
            );
          const bytes = strictBase64(content.bytesBase64);
          if (
            bytes.byteLength !== segment.sourceEndOffset - expectedOffset ||
            sha256(bytes) !== segment.plaintextDigest
          ) {
            throw new Error("ManagedConversationSourceDigestError");
          }
          chunks.push(bytes);
          expectedOffset = segment.sourceEndOffset;
          expectedLine = segment.sourceEndLine;
          count += 1;
          if (
            count > maximumSourceSegments ||
            expectedOffset > maximumSourceBytes
          ) {
            throw new Error("ManagedConversationSourceCapacityError");
          }
          if (expectedOffset === generationEndOffset) break;
        }
      }
    }
    if (expectedOffset !== input.endOffset || expectedLine !== input.endLine) {
      throw new Error("ManagedConversationSourceBoundaryError");
    }
    return {
      artifactId: current.id as string,
      sourceSessionId: current.sessionId as string,
      bytes: Buffer.concat(chunks, input.endOffset)
    };
  };

  const reconstructTransferTranscript = async (input: {
    transferKind: "handoff" | "fork";
    transferId: string;
    operationId: string;
    threadId: string;
    logicalSourceId: string;
    sourceGenerationId: string;
    closureHash: string;
    endOffset: number;
    endLine: number;
  }): Promise<{
    artifactId: string;
    sourceSessionId: string;
    bytes: Buffer;
  }> => {
    try {
      return await reconstructSealedTranscript(input);
    } catch (error) {
      if (
        error instanceof ManagedConversationSourceReplicaPendingError &&
        shouldRequestManagedConversationSourceRestore(error) &&
        options.sourceRestoreControl
      ) {
        await options.sourceRestoreControl.ensure({
          transferKind: input.transferKind,
          transferId: input.transferId,
          operationId: input.operationId,
          sourceGenerationId: error.sourceGenerationId
        });
      }
      throw error;
    }
  };

  const sourceGenerationIsReady = async (
    sourceGenerationId: string
  ): Promise<boolean> => {
    try {
      const lookup =
        await memoryClient.getConversationSourceArtifactByGeneration(
          sourceGenerationId
        );
      const artifact = record(lookup.artifact);
      return (
        artifact.sourceGenerationId === sourceGenerationId &&
        artifact.lifecycle === "finalized" &&
        typeof artifact.closureHash === "string"
      );
    } catch (error) {
      if (error instanceof MemoryApiError && error.status === 404) return false;
      throw error;
    }
  };

  const finalizedForkSource = async (
    execution: ManagedConversationExecutionRecord,
    binding: ManagedConversationRuntimeBindingRecord
  ): Promise<ForkSourceBoundary> => {
    if (
      !execution.providerThreadId ||
      !execution.logicalSessionId ||
      !binding.localSessionId ||
      !execution.sourceGenerationId
    ) {
      throw new Error("ManagedConversationForkSourceIdentityError");
    }
    const lookup = await memoryClient.getConversationSourceArtifactByGeneration(
      execution.sourceGenerationId
    );
    const artifact = record(lookup.artifact);
    if (
      artifact.lifecycle !== "finalized" ||
      artifact.externalSessionId !== execution.providerThreadId ||
      artifact.sessionId !== binding.localSessionId ||
      artifact.sourceGenerationId !== execution.sourceGenerationId ||
      typeof artifact.id !== "string" ||
      typeof artifact.logicalSourceId !== "string" ||
      typeof artifact.originKeyId !== "string" ||
      typeof artifact.closureHash !== "string" ||
      typeof artifact.providerCursorOffset !== "number" ||
      typeof artifact.providerCursorLine !== "number"
    ) {
      throw new Error("ManagedConversationForkSourceBoundaryError");
    }
    return {
      threadId: execution.providerThreadId,
      sessionId: binding.localSessionId,
      logicalSessionId: execution.logicalSessionId,
      artifactId: artifact.id,
      logicalSourceId: artifact.logicalSourceId,
      sourceGenerationId: execution.sourceGenerationId,
      originKeyId: artifact.originKeyId,
      closureHash: artifact.closureHash,
      providerCursorOffset: artifact.providerCursorOffset,
      providerCursorLine: artifact.providerCursorLine
    };
  };

  const sealActiveForkSource = async (
    command: ClaimedManagedConversationCommand,
    execution: ManagedConversationExecutionRecord,
    binding: ManagedConversationRuntimeBindingRecord
  ): Promise<ForkSourceBoundary> => {
    if (
      !execution.providerThreadId ||
      !execution.logicalSessionId ||
      !execution.sourceGenerationId ||
      !binding.localSessionId
    ) {
      throw new Error("ManagedConversationForkSourceIdentityError");
    }
    const lookup = await memoryClient.getConversationSourceArtifactByGeneration(
      execution.sourceGenerationId
    );
    const artifact = record(lookup.artifact);
    if (
      artifact.lifecycle !== "active" ||
      artifact.externalSessionId !== execution.providerThreadId ||
      artifact.sessionId !== binding.localSessionId ||
      artifact.sourceGenerationId !== execution.sourceGenerationId ||
      typeof artifact.id !== "string" ||
      typeof artifact.logicalSourceId !== "string" ||
      typeof artifact.originKeyId !== "string" ||
      typeof artifact.providerCursorOffset !== "number" ||
      typeof artifact.providerCursorLine !== "number"
    ) {
      throw new Error("ManagedConversationForkSourceBoundaryError");
    }
    let sealed: CodexManagedConversationSealedSource | undefined;
    if (execution.provider === "claude") {
      sealed = await withClaudeLease(command, () =>
        sealClaudePrimarySource(execution)
      );
      runtimeSessions.delete("claude", execution.id);
    } else {
      const session = await sessionFor(execution);
      const sealedSources = await withLease(
        command,
        async () => {
          const started = await session.start();
          if (
            started.thread.id !== execution.providerThreadId ||
            started.sessionId !== binding.localSessionId ||
            (execution.providerCliVersion &&
              started.thread.cliVersion !== execution.providerCliVersion)
          ) {
            throw new Error("ManagedConversationProviderCompatibilityError");
          }
          return session.quiesceAndSealSources();
        },
        session
      );
      runtimeSessions.delete("codex", execution.id);
      sealed = sealedSources.find(
        (candidate) =>
          candidate.threadId === execution.providerThreadId &&
          candidate.sessionId === binding.localSessionId &&
          candidate.sourceGenerationId === execution.sourceGenerationId
      );
    }
    if (!sealed || sealed.logicalSourceId !== artifact.logicalSourceId) {
      throw new Error("ManagedConversationForkSourceBoundaryError");
    }
    return {
      ...sealed,
      logicalSessionId: execution.logicalSessionId
    };
  };

  const sourceArtifactRelativePath = (
    binding: ManagedConversationRuntimeBindingRecord
  ): string => {
    if (!binding.managedHome || !binding.transcriptPath) {
      throw new Error("ManagedConversationForkSourcePathError");
    }
    const path = relative(
      resolve(binding.managedHome),
      resolve(binding.transcriptPath)
    ).replaceAll("\\", "/");
    if (
      !path ||
      path.startsWith("../") ||
      path === ".." ||
      path.startsWith("/")
    ) {
      throw new Error("ManagedConversationForkSourcePathError");
    }
    return path;
  };

  const workspaceForTarget = async (
    command: ClaimedManagedConversationCommand
  ) => {
    if (!options.deviceId || !options.deploymentId) {
      throw new Error("ManagedConversationDeviceIdentityError");
    }
    const handoff =
      await options.repository.getActiveManagedConversationHandoffForExecution(
        { userId: command.ownerUserId },
        command.executionId
      );
    if (
      !handoff ||
      handoff.targetDeviceId !== options.deviceId ||
      handoff.targetDeploymentId !== options.deploymentId
    ) {
      throw new Error("ManagedConversationHandoffTargetError");
    }
    const material =
      await options.repository.getManagedConversationHandoffTargetMaterial(
        { userId: command.ownerUserId },
        { handoffId: handoff.id, targetDeviceId: options.deviceId }
      );
    if (
      !material ||
      !material.handoff.transferManifest ||
      !material.handoff.sourceAttestation
    ) {
      throw new Error("ManagedConversationHandoffMaterialError");
    }
    const source = material.handoff.sourceAttestation as {
      keyId?: unknown;
      signature?: unknown;
    };
    if (
      typeof source.keyId !== "string" ||
      typeof source.signature !== "string" ||
      !verifyManagedConversationHandoffSourceAttestation({
        manifest: material.handoff.transferManifest,
        source: { keyId: source.keyId, signature: source.signature },
        sourcePublicKey: material.sourcePublicKey
      })
    ) {
      throw new Error("ManagedConversationSourceAttestationError");
    }
    const snapshot = await loadWorkspaceSnapshot({
      ownerUserId: command.ownerUserId,
      operationKind: "handoff",
      operationId: handoff.id,
      snapshot: material.snapshot
    });
    const path = targetWorkspacePath(
      command.executionId,
      material.handoff.nextExecutionGeneration
    );
    let verified;
    try {
      verified = await materializeDevelopmentWorkspaceSnapshot(
        snapshot,
        path,
        managedWorkspaceRoot
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "WorkspaceSnapshotTargetExistsError"
      ) {
        throw error;
      }
      verified = await verifyDevelopmentWorkspaceSnapshotMaterialization(
        snapshot,
        path
      );
    }
    const manifest = material.handoff.transferManifest;
    const transcript = await reconstructTransferTranscript({
      transferKind: "handoff",
      transferId: handoff.id,
      operationId: handoff.operationId,
      threadId: manifest.providerThreadId,
      logicalSourceId: manifest.logicalSourceId,
      sourceGenerationId: manifest.sourceGenerationId,
      closureHash: manifest.sourceClosureHash,
      endOffset: manifest.sourceEndByteCursor,
      endLine: manifest.sourceEndItemCursor
    });
    const readinessEvidence = await buildTargetReadinessEvidence({
      handoff: material.handoff,
      snapshot,
      packageDigest: material.snapshot.packageDigest,
      restoredStateDigest: verified.stateDigest,
      projectPath: verified.path,
      providerCliVersion: manifest.providerCliVersion,
      provider: manifest.provider
    });
    return {
      handoff: material.handoff,
      material,
      path: verified.path,
      transcript,
      readinessEvidence
    };
  };

  const workspaceForForkTarget = async (
    command: ClaimedManagedConversationCommand
  ) => {
    if (!options.deviceId || !options.deploymentId) {
      throw new Error("ManagedConversationDeviceIdentityError");
    }
    const fork =
      await options.repository.getActiveManagedConversationForkForParent(
        { userId: command.ownerUserId },
        command.executionId
      );
    if (
      !fork ||
      fork.state !== "source_attested" ||
      fork.targetDeviceId !== options.deviceId ||
      fork.targetDeploymentId !== options.deploymentId
    ) {
      throw new Error("ManagedConversationForkTargetError");
    }
    const material =
      await options.repository.getManagedConversationForkTargetMaterial(
        { userId: command.ownerUserId },
        { forkId: fork.id, targetDeviceId: options.deviceId }
      );
    if (
      !material ||
      !verifyManagedConversationForkManifest({
        signed: material.signedManifest,
        sourcePublicKey: material.sourcePublicKey,
        expectedTargetDeviceId: options.deviceId
      }) ||
      managedConversationForkManifestDigest(material.signedManifest) !==
        fork.manifestDigest
    ) {
      throw new Error("ManagedConversationForkAttestationError");
    }
    const manifest = material.signedManifest.manifest;
    if (
      manifest.targetDeploymentId !== options.deploymentId ||
      manifest.parentExecutionId !== command.executionId ||
      manifest.parentExecutionGeneration !== command.executionGeneration
    ) {
      throw new Error("ManagedConversationForkBoundaryError");
    }
    const snapshot = await loadWorkspaceSnapshot({
      ownerUserId: command.ownerUserId,
      operationKind: "fork",
      operationId: fork.id,
      snapshot: material.snapshot
    });
    if (snapshot.manifestDigest !== manifest.workspaceManifestDigest) {
      throw new Error("ManagedConversationWorkspaceManifestError");
    }
    const path = forkWorkspacePath(fork.id);
    let verified;
    try {
      verified = await materializeDevelopmentWorkspaceSnapshot(
        snapshot,
        path,
        managedWorkspaceRoot
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "WorkspaceSnapshotTargetExistsError"
      ) {
        throw error;
      }
      verified = await verifyDevelopmentWorkspaceSnapshotMaterialization(
        snapshot,
        path
      );
    }
    const transcript = await reconstructTransferTranscript({
      transferKind: "fork",
      transferId: fork.id,
      operationId: fork.operationId,
      threadId: manifest.providerThreadId,
      logicalSourceId: manifest.logicalSourceId,
      sourceGenerationId: manifest.sourceGenerationId,
      closureHash: manifest.sourceClosureHash,
      endOffset: manifest.sourceEndByteCursor,
      endLine: manifest.sourceEndItemCursor
    });
    return {
      fork,
      material,
      manifest,
      path: verified.path,
      transcript
    };
  };

  const sessionFor = async (
    execution: ManagedConversationExecutionRecord
  ): Promise<CodexManagedConversationSession> => {
    const current = runtimeSessions.get("codex", execution.id);
    if (
      current &&
      current.executionGeneration === execution.executionGeneration
    ) {
      return current.session;
    }
    if (current) {
      void current.session.closeAndWait().catch(() => undefined);
      runtimeSessions.delete("codex", execution.id);
    }
    let binding = await options.repository.getManagedConversationRuntimeBinding(
      { userId: execution.ownerUserId },
      execution.id
    );
    binding = await recoverLocalRuntimeBinding(execution, binding);
    if (
      execution.state === "running" &&
      (!binding.localSessionId ||
        !binding.providerThreadId ||
        !binding.transcriptPath ||
        !binding.managedHome)
    ) {
      throw new Error("ManagedConversationRuntimeRecoveryPendingError");
    }
    const session = createSession(execution, binding);
    runtimeSessions.set("codex", execution.id, {
      executionGeneration: execution.executionGeneration,
      session
    });
    return session;
  };

  const sessionForClaude = async (
    execution: ManagedConversationExecutionRecord
  ): Promise<ClaudeManagedConversationSession> => {
    const current = runtimeSessions.get("claude", execution.id);
    if (
      current &&
      current.executionGeneration === execution.executionGeneration
    ) {
      return current.session;
    }
    if (current) {
      void current.session.closeAndWait().catch(() => undefined);
      runtimeSessions.delete("claude", execution.id);
    }
    const binding = await runtimeBindingFor(execution, execution.ownerUserId);
    const session = createClaudeSession(execution, binding);
    runtimeSessions.set("claude", execution.id, {
      executionGeneration: execution.executionGeneration,
      session
    });
    return session;
  };

  const sealedPrimarySourceFor = async (
    execution: ManagedConversationExecutionRecord
  ): Promise<CodexManagedConversationSealedSource> => {
    if (!execution.providerThreadId || !execution.sourceGenerationId) {
      throw new Error("ManagedConversationPrimarySourceError");
    }
    const lookup = await memoryClient.lookupConversationSourceArtifact({
      sourceKind: execution.provider === "claude" ? "claude-code" : "codex",
      externalSessionId: execution.providerThreadId
    });
    const artifact = record(lookup.artifact);
    if (
      artifact.externalSessionId !== execution.providerThreadId ||
      artifact.sourceGenerationId !== execution.sourceGenerationId ||
      artifact.lifecycle !== "finalized" ||
      typeof artifact.id !== "string" ||
      typeof artifact.sessionId !== "string" ||
      typeof artifact.logicalSourceId !== "string" ||
      typeof artifact.originKeyId !== "string" ||
      typeof artifact.closureHash !== "string" ||
      typeof artifact.providerCursorOffset !== "number" ||
      typeof artifact.providerCursorLine !== "number"
    ) {
      throw new Error("ManagedConversationPrimarySourceError");
    }
    return {
      threadId: execution.providerThreadId,
      sessionId: artifact.sessionId,
      artifactId: artifact.id,
      logicalSourceId: artifact.logicalSourceId,
      sourceGenerationId: execution.sourceGenerationId,
      originKeyId: artifact.originKeyId,
      closureHash: artifact.closureHash,
      providerCursorOffset: artifact.providerCursorOffset,
      providerCursorLine: artifact.providerCursorLine
    };
  };

  const sealClaudePrimarySource = async (
    execution: ManagedConversationExecutionRecord
  ): Promise<CodexManagedConversationSealedSource> => {
    if (!execution.providerThreadId) {
      throw new Error("ManagedConversationPrimarySourceError");
    }
    const binding = await runtimeBindingFor(execution, execution.ownerUserId);
    const session = await sessionForClaude(execution);
    await session.closeAndWait();
    const captured = await captureClaudeTurn({
      sessionId: execution.providerThreadId,
      cwd: binding.projectPath,
      turnBoundary: true,
      hookEventName: "SessionEnd",
      ...(binding.managedHome ? { managedHome: binding.managedHome } : {})
    });
    const lookup = await memoryClient.lookupConversationSourceArtifact({
      sourceKind: "claude-code",
      externalSessionId: execution.providerThreadId
    });
    const artifact = record(lookup.artifact);
    if (
      artifact.sourceGenerationId !== captured.sourceGenerationId ||
      typeof artifact.id !== "string" ||
      typeof artifact.logicalSourceId !== "string" ||
      typeof artifact.originKeyId !== "string" ||
      typeof artifact.providerCursorOffset !== "number" ||
      typeof artifact.providerCursorLine !== "number"
    ) {
      throw new Error("ManagedConversationPrimarySourceError");
    }
    const sealed = artifact;
    if (
      sealed.lifecycle !== "finalized" ||
      typeof sealed.closureHash !== "string"
    ) {
      throw new Error("ManagedConversationPrimarySourceError");
    }
    return {
      threadId: execution.providerThreadId,
      sessionId: captured.localSessionId,
      artifactId: artifact.id,
      logicalSourceId: artifact.logicalSourceId,
      sourceGenerationId: captured.sourceGenerationId,
      originKeyId: artifact.originKeyId,
      closureHash: sealed.closureHash,
      providerCursorOffset: artifact.providerCursorOffset,
      providerCursorLine: artifact.providerCursorLine
    };
  };

  const withProviderLease = async <
    Session extends {
      closeAndWait(): Promise<void>;
    },
    Result
  >(
    command: ClaimedManagedConversationCommand,
    provider: ManagedConversationProvider,
    session: Session,
    operation: (session: Session) => Promise<Result>
  ): Promise<Result> => {
    if (!command.leaseToken) throw new ManagedConversationLeaseLostError();
    if (command.execution.provider !== provider) {
      throw managedConversationError(
        "ManagedConversationProviderMismatchError"
      );
    }
    return runWithManagedConversationLease({
      session,
      heartbeatMs: commandHeartbeatMs,
      renew: () =>
        options.repository.renewManagedConversationCommandLease({
          commandId: command.id,
          leaseToken: command.leaseToken!,
          runnerId,
          executionId: command.executionId,
          leaseMs: commandLeaseMs
        }),
      close: (ownedSession) => ownedSession.closeAndWait(),
      operation,
      leaseLostError: () => new ManagedConversationLeaseLostError()
    });
  };

  const withLease = async <T>(
    command: ClaimedManagedConversationCommand,
    operation: (session: CodexManagedConversationSession) => Promise<T>,
    sessionOverride?: CodexManagedConversationSession
  ): Promise<T> =>
    withProviderLease(
      command,
      "codex",
      sessionOverride ?? (await sessionFor(command.execution)),
      operation
    );

  const withClaudeLease = async <T>(
    command: ClaimedManagedConversationCommand,
    operation: (session: ClaudeManagedConversationSession) => Promise<T>,
    sessionOverride?: ClaudeManagedConversationSession
  ): Promise<T> =>
    withProviderLease(
      command,
      "claude",
      sessionOverride ?? (await sessionForClaude(command.execution)),
      operation
    );

  const withCommandHeartbeat = async <T>(
    command: ClaimedManagedConversationCommand,
    operation: () => Promise<T>
  ): Promise<T> => {
    if (!command.leaseToken) throw new ManagedConversationLeaseLostError();
    let leaseLost = false;
    let stoppedHeartbeat = false;
    const heartbeat = async () => {
      if (stoppedHeartbeat || leaseLost) return;
      try {
        leaseLost =
          !(await options.repository.renewManagedConversationCommandLease({
            commandId: command.id,
            leaseToken: command.leaseToken!,
            runnerId,
            executionId: command.executionId,
            leaseMs: commandLeaseMs
          }));
      } catch {
        leaseLost = true;
      }
    };
    const timer = setInterval(() => void heartbeat(), commandHeartbeatMs);
    timer.unref?.();
    try {
      const result = await operation();
      if (leaseLost) throw new ManagedConversationLeaseLostError();
      return result;
    } finally {
      stoppedHeartbeat = true;
      clearInterval(timer);
    }
  };

  const destroyManagedHome = (managedHome: string): void => {
    try {
      destroyManagedCodexHome(managedHome, process.env);
    } catch (error) {
      options.logger.warn(
        {
          event: {
            name: "worker.managed_conversation.home_cleanup_failed",
            category: "managed_conversation"
          },
          error_name: errorCode(error)
        },
        "managed Conversation home cleanup failed"
      );
    }
  };

  const writeManagedTranscript = async (input: {
    managedHome: string;
    relativePath: string;
    bytes: Uint8Array;
  }): Promise<string> => {
    const transcriptPath = resolve(
      input.managedHome,
      ...input.relativePath.split("/")
    );
    if (!transcriptPath.startsWith(`${resolve(input.managedHome)}${sep}`)) {
      throw new Error("ManagedConversationTranscriptPathError");
    }
    await mkdir(dirname(transcriptPath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(transcriptPath, input.bytes, {
        flag: "wx",
        mode: 0o600
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      const existing = await readFile(transcriptPath);
      const expected = Buffer.from(input.bytes);
      if (
        existing.byteLength !== expected.byteLength ||
        !existing.equals(expected)
      ) {
        throw new Error("ManagedConversationTranscriptConflictError", {
          cause: error
        });
      }
    }
    return transcriptPath;
  };

  const resumeForkParent = async (input: {
    command: ClaimedManagedConversationCommand;
    fork: ManagedConversationForkRecord;
    source: ForkSourceBoundary;
    providerArtifactRelativePath: string;
    providerCliVersion: string;
  }): Promise<ManagedConversationExecutionRecord> => {
    const { command, fork, source } = input;
    const transcript = await reconstructSealedTranscript({
      threadId: source.threadId,
      logicalSourceId: source.logicalSourceId,
      sourceGenerationId: source.sourceGenerationId,
      closureHash: source.closureHash,
      endOffset: source.providerCursorOffset,
      endLine: source.providerCursorLine
    });
    const successor =
      await memoryClient.createConversationSourceSuccessorGeneration(
        transcript.artifactId,
        {
          expectedParentClosureHash: source.closureHash,
          sourceGenerationId: fork.parentNextSourceGenerationId,
          originKeyId: fork.parentNextOriginKeyId
        }
      );
    const successorArtifact = record(successor.artifact);
    if (
      successorArtifact.logicalSourceId !== source.logicalSourceId ||
      successorArtifact.sourceGenerationId !==
        fork.parentNextSourceGenerationId ||
      successorArtifact.originKeyId !== fork.parentNextOriginKeyId ||
      successorArtifact.originDeploymentId !== options.deploymentId ||
      successorArtifact.originDeviceId !== options.deviceId ||
      successorArtifact.lifecycle !== "active" ||
      successorArtifact.providerCursorOffset !== source.providerCursorOffset ||
      successorArtifact.providerCursorLine !== source.providerCursorLine
    ) {
      throw new Error("ManagedConversationSuccessorGenerationError");
    }
    let execution = await options.repository.getManagedConversationExecution(
      { userId: command.ownerUserId },
      command.executionId
    );
    if (!execution) {
      throw new Error("ManagedConversationForkParentMissingError");
    }
    let binding = await runtimeBindingFor(execution, command.ownerUserId);
    if (execution.state === "quiesce_requested") {
      execution = await options.repository.setManagedConversationExecutionState(
        { userId: command.ownerUserId },
        {
          executionId: execution.id,
          expectedStateVersion: execution.stateVersion,
          executionGeneration: execution.executionGeneration,
          state: "quiesced"
        }
      );
    }
    if (execution.state === "quiesced") {
      execution = await options.repository.setManagedConversationExecutionState(
        { userId: command.ownerUserId },
        {
          executionId: execution.id,
          expectedStateVersion: execution.stateVersion,
          executionGeneration: execution.executionGeneration,
          state: "reconciling"
        }
      );
    }
    if (execution.state === "reconciling") {
      if (execution.provider === "claude") {
        const managedHome = prepareManagedClaudeHome(process.env);
        let resumed: ClaudeManagedConversationSession | undefined;
        try {
          const transcriptPath = await writeManagedTranscript({
            managedHome,
            relativePath: input.providerArtifactRelativePath,
            bytes: transcript.bytes
          });
          resumed = createClaudeSession(execution, binding, {
            projectPath: binding.projectPath,
            resumeSessionId: source.threadId,
            managedHome
          });
          const started = await withClaudeLease(
            command,
            () => resumed!.start(),
            resumed
          );
          if (started.identity.sessionId !== source.threadId) {
            throw new Error("ManagedConversationProviderCompatibilityError");
          }
          execution = await options.repository.bindManagedConversationRuntime(
            { userId: command.ownerUserId },
            {
              executionId: execution.id,
              expectedStateVersion: execution.stateVersion,
              executionGeneration: execution.executionGeneration,
              runnerId,
              logicalSessionId: source.logicalSessionId,
              providerThreadId: source.threadId,
              providerCliVersion: input.providerCliVersion,
              sourceGenerationId: fork.parentNextSourceGenerationId
            }
          );
          binding =
            await options.repository.bindManagedConversationLocalRuntime(
              { userId: command.ownerUserId },
              {
                executionId: execution.id,
                deploymentId: options.deploymentId!,
                deviceId: options.deviceId!,
                executionGeneration: execution.executionGeneration,
                localSessionId: source.sessionId,
                providerThreadId: source.threadId,
                transcriptPath,
                managedHome,
                providerCliVersion: input.providerCliVersion,
                sourceGenerationId: fork.parentNextSourceGenerationId
              }
            );
          retainManagedClaudeHome(managedHome, process.env);
          runtimeSessions.set("claude", execution.id, {
            executionGeneration: execution.executionGeneration,
            session: resumed
          });
        } catch (error) {
          await resumed?.closeAndWait().catch(() => undefined);
          destroyManagedClaudeHome(managedHome, process.env);
          throw error;
        }
      } else {
        const managedHome = prepareManagedCodexHome(process.env);
        let resumed: CodexManagedConversationSession | undefined;
        try {
          const transcriptPath = await writeManagedTranscript({
            managedHome,
            relativePath: input.providerArtifactRelativePath,
            bytes: transcript.bytes
          });
          resumed = createSession(execution, binding, {
            projectPath: binding.projectPath,
            resume: {
              threadId: source.threadId,
              sessionId: source.sessionId,
              transcriptPath,
              codexHome: managedHome
            }
          });
          const started = await withLease(
            command,
            () => resumed!.start(),
            resumed
          );
          if (
            started.sessionId !== source.sessionId ||
            started.thread.id !== source.threadId ||
            started.thread.cliVersion !== input.providerCliVersion
          ) {
            throw new Error("ManagedConversationProviderCompatibilityError");
          }
          const logicalSessionId = await logicalSessionIdFor(
            command.ownerUserId,
            started.sessionId
          );
          if (logicalSessionId !== source.logicalSessionId) {
            throw new Error("ManagedConversationLogicalSessionMismatchError");
          }
          execution = await options.repository.bindManagedConversationRuntime(
            { userId: command.ownerUserId },
            {
              executionId: execution.id,
              expectedStateVersion: execution.stateVersion,
              executionGeneration: execution.executionGeneration,
              runnerId,
              logicalSessionId,
              providerThreadId: started.thread.id,
              providerCliVersion: started.thread.cliVersion,
              sourceGenerationId: fork.parentNextSourceGenerationId
            }
          );
          binding =
            await options.repository.bindManagedConversationLocalRuntime(
              { userId: command.ownerUserId },
              {
                executionId: execution.id,
                deploymentId: options.deploymentId!,
                deviceId: options.deviceId!,
                executionGeneration: execution.executionGeneration,
                localSessionId: started.sessionId,
                providerThreadId: started.thread.id,
                transcriptPath: started.transcriptPath,
                managedHome: started.codexHome,
                providerCliVersion: started.thread.cliVersion,
                sourceGenerationId: fork.parentNextSourceGenerationId
              }
            );
          runtimeSessions.set("codex", execution.id, {
            executionGeneration: execution.executionGeneration,
            session: resumed
          });
        } catch (error) {
          await resumed?.closeAndWait().catch(() => undefined);
          destroyManagedHome(managedHome);
          throw error;
        }
      }
    } else if (
      execution.state === "running" &&
      execution.sourceGenerationId === fork.parentNextSourceGenerationId &&
      execution.providerThreadId === source.threadId &&
      execution.logicalSessionId === source.logicalSessionId &&
      binding.localSessionId === source.sessionId
    ) {
      if (execution.provider === "claude") {
        const resumed = await sessionForClaude(execution);
        const started = await withClaudeLease(
          command,
          () => resumed.start(),
          resumed
        );
        if (started.identity.sessionId !== source.threadId) {
          throw new Error("ManagedConversationProviderCompatibilityError");
        }
      } else {
        const resumed = await sessionFor(execution);
        const started = await withLease(
          command,
          () => resumed.start(),
          resumed
        );
        if (
          started.thread.id !== source.threadId ||
          started.sessionId !== source.sessionId ||
          started.thread.cliVersion !== input.providerCliVersion
        ) {
          throw new Error("ManagedConversationProviderCompatibilityError");
        }
      }
    } else {
      throw new Error("ManagedConversationForkParentRestartError");
    }
    await ensureAuthoritySourceRegistration(
      command.ownerUserId,
      fork.parentNextSourceGenerationId
    );
    return execution;
  };

  const prepareFork = async (
    command: ClaimedManagedConversationCommand
  ): Promise<{ forkId: string; state: string }> => {
    if (!options.deviceId || !options.deploymentId) {
      throw new Error("ManagedConversationDeviceIdentityError");
    }
    let fork =
      await options.repository.getActiveManagedConversationForkForParent(
        { userId: command.ownerUserId },
        command.executionId
      );
    if (
      !fork ||
      fork.sourceDeviceId !== options.deviceId ||
      fork.sourceDeploymentId !== options.deploymentId
    ) {
      throw new Error("ManagedConversationForkSourceError");
    }
    if (fork.state === "requested") {
      let execution = await options.repository.getManagedConversationExecution(
        { userId: command.ownerUserId },
        command.executionId
      );
      if (!execution) {
        throw new Error("ManagedConversationForkParentMissingError");
      }
      const binding = await runtimeBindingFor(execution, command.ownerUserId);
      let source: ForkSourceBoundary;
      if (
        execution.state === "running" ||
        execution.state === "quiesce_requested"
      ) {
        try {
          source = await finalizedForkSource(execution, binding);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "ManagedConversationForkSourceBoundaryError"
          ) {
            throw error;
          }
          source = await sealActiveForkSource(command, execution, binding);
        }
        execution =
          await options.repository.setManagedConversationExecutionState(
            { userId: command.ownerUserId },
            {
              executionId: execution.id,
              expectedStateVersion: execution.stateVersion,
              executionGeneration: execution.executionGeneration,
              state: "quiesced"
            }
          );
      } else if (execution.state === "quiesced") {
        source = await finalizedForkSource(execution, binding);
      } else {
        throw new Error("ManagedConversationForkParentStateError");
      }
      let workspaceSnapshotId = await reusableWorkspaceSnapshotId({
        ownerUserId: command.ownerUserId,
        executionId: execution.id,
        operationKind: "fork",
        operationId: fork.id,
        sourceGenerationId: source.sourceGenerationId,
        sourceDeploymentId: fork.sourceDeploymentId,
        sourceDeviceId: fork.sourceDeviceId
      });
      if (!workspaceSnapshotId) {
        const snapshot = await createDevelopmentWorkspaceSnapshot(
          binding.projectPath,
          { snapshotId: fork.id, createdAt: fork.createdAt }
        );
        workspaceSnapshotId = await persistWorkspaceSnapshot({
          ownerUserId: command.ownerUserId,
          projectId: execution.projectId,
          executionId: execution.id,
          operationKind: "fork",
          operationId: fork.id,
          sourceGenerationId: source.sourceGenerationId,
          sourceDeploymentId: fork.sourceDeploymentId,
          sourceDeviceId: fork.sourceDeviceId,
          snapshot,
          readinessEvidence: {
            snapshotIntegrity: "verified",
            sourceStateDigest: snapshot.sourceStateDigest,
            parentExecutionStateVersion: execution.stateVersion
          }
        });
      }
      const prepared = await options.repository
        .prepareManagedConversationForkSource(
          { userId: command.ownerUserId },
          {
            forkId: fork.id,
            expectedStateVersion: fork.stateVersion,
            runnerId,
            parentLogicalSessionId: source.logicalSessionId,
            providerArtifactRelativePath: sourceArtifactRelativePath(binding),
            logicalSourceId: source.logicalSourceId,
            sourceGenerationId: source.sourceGenerationId,
            sourceClosureHash: source.closureHash,
            sourceEndByteCursor: source.providerCursorOffset,
            sourceEndItemCursor: source.providerCursorLine,
            workspaceSnapshotId
          }
        )
        .catch((error: unknown) =>
          sourceReplicaPending(error, source.sourceGenerationId, [
            "managed_conversation_fork_source_boundary_conflict"
          ])
        );
      fork = prepared.fork;
    }
    if (fork.state === "source_attested") {
      return { forkId: fork.id, state: fork.state };
    }
    if (fork.state !== "source_prepared" || !fork.forkManifest) {
      throw new Error("ManagedConversationForkPreparationStateError");
    }
    const manifest = fork.forkManifest;
    const sourceLookup =
      await memoryClient.getConversationSourceArtifactByGeneration(
        manifest.sourceGenerationId
      );
    const sourceArtifact = record(sourceLookup.artifact);
    const sourceLogicalSessionId =
      typeof sourceArtifact.sessionId === "string"
        ? await logicalSessionIdFor(
            command.ownerUserId,
            sourceArtifact.sessionId
          )
        : null;
    if (
      sourceArtifact.logicalSourceId !== manifest.logicalSourceId ||
      sourceArtifact.sourceGenerationId !== manifest.sourceGenerationId ||
      sourceArtifact.lifecycle !== "finalized" ||
      sourceArtifact.closureHash !== manifest.sourceClosureHash ||
      sourceArtifact.externalSessionId !== manifest.providerThreadId ||
      sourceLogicalSessionId !== manifest.parentLogicalSessionId ||
      sourceArtifact.providerCursorOffset !== manifest.sourceEndByteCursor ||
      sourceArtifact.providerCursorLine !== manifest.sourceEndItemCursor ||
      typeof sourceArtifact.id !== "string" ||
      typeof sourceArtifact.originKeyId !== "string"
    ) {
      throw new Error("ManagedConversationForkSourceBoundaryError");
    }
    const signer = createDeviceBoundSourceSigner({
      koedHome: options.koedHome,
      sourceGenerationId: manifest.sourceGenerationId,
      originKeyId: sourceArtifact.originKeyId
    });
    if (
      signer.deploymentId !== manifest.sourceDeploymentId ||
      signer.deviceInstanceId !== manifest.sourceDeviceId
    ) {
      throw new Error("ManagedConversationSourceDeviceError");
    }
    await resumeForkParent({
      command,
      fork,
      source: {
        threadId: manifest.providerThreadId,
        sessionId: sourceArtifact.sessionId as string,
        logicalSessionId: manifest.parentLogicalSessionId,
        artifactId: sourceArtifact.id,
        logicalSourceId: manifest.logicalSourceId,
        sourceGenerationId: manifest.sourceGenerationId,
        originKeyId: sourceArtifact.originKeyId,
        closureHash: manifest.sourceClosureHash,
        providerCursorOffset: manifest.sourceEndByteCursor,
        providerCursorLine: manifest.sourceEndItemCursor
      },
      providerArtifactRelativePath: manifest.providerArtifactRelativePath,
      providerCliVersion: manifest.providerCliVersion
    });
    const signature = signer.sign(
      Buffer.from(canonicalManagedConversationForkManifest(manifest), "utf8")
    );
    const attested =
      await options.repository.attestManagedConversationForkSource(
        { userId: command.ownerUserId },
        {
          forkId: fork.id,
          expectedStateVersion: fork.stateVersion,
          sourceKeyId: signer.keyId,
          sourceSignature: signature
        }
      );
    return { forkId: attested.id, state: attested.state };
  };

  const recoverForkParent = async (
    command: ClaimedManagedConversationCommand
  ): Promise<ManagedConversationForkRecord | null> => {
    const fork =
      await options.repository.getActiveManagedConversationForkForParent(
        { userId: command.ownerUserId },
        command.executionId
      );
    if (!fork) return null;
    let execution = await options.repository.getManagedConversationExecution(
      { userId: command.ownerUserId },
      command.executionId
    );
    if (!execution) {
      throw new Error("ManagedConversationForkParentMissingError");
    }
    const binding = await runtimeBindingFor(execution, command.ownerUserId);
    if (
      execution.state === "running" &&
      execution.sourceGenerationId !== fork.parentNextSourceGenerationId
    ) {
      return fork;
    }
    let source: ForkSourceBoundary;
    let providerArtifactRelativePath: string;
    let providerCliVersion: string;
    if (fork.forkManifest) {
      const manifest = fork.forkManifest;
      const sourceLookup =
        await memoryClient.getConversationSourceArtifactByGeneration(
          manifest.sourceGenerationId
        );
      const artifact = record(sourceLookup.artifact);
      const artifactLogicalSessionId =
        typeof artifact.sessionId === "string"
          ? await logicalSessionIdFor(command.ownerUserId, artifact.sessionId)
          : null;
      if (
        artifact.id === undefined ||
        artifact.lifecycle !== "finalized" ||
        artifact.logicalSourceId !== manifest.logicalSourceId ||
        artifact.externalSessionId !== manifest.providerThreadId ||
        artifactLogicalSessionId !== manifest.parentLogicalSessionId ||
        artifact.closureHash !== manifest.sourceClosureHash ||
        artifact.providerCursorOffset !== manifest.sourceEndByteCursor ||
        artifact.providerCursorLine !== manifest.sourceEndItemCursor ||
        typeof artifact.id !== "string" ||
        typeof artifact.originKeyId !== "string"
      ) {
        throw new Error("ManagedConversationForkSourceBoundaryError");
      }
      source = {
        threadId: manifest.providerThreadId,
        sessionId: artifact.sessionId as string,
        logicalSessionId: manifest.parentLogicalSessionId,
        artifactId: artifact.id,
        logicalSourceId: manifest.logicalSourceId,
        sourceGenerationId: manifest.sourceGenerationId,
        originKeyId: artifact.originKeyId,
        closureHash: manifest.sourceClosureHash,
        providerCursorOffset: manifest.sourceEndByteCursor,
        providerCursorLine: manifest.sourceEndItemCursor
      };
      providerArtifactRelativePath = manifest.providerArtifactRelativePath;
      providerCliVersion = manifest.providerCliVersion;
    } else {
      try {
        source = await finalizedForkSource(execution, binding);
      } catch (error) {
        if (execution.state !== "quiesce_requested") {
          throw error;
        }
        if (execution.provider === "claude") {
          const claudeManaged = runtimeSessions.get("claude", execution.id);
          if (
            !claudeManaged ||
            claudeManaged.executionGeneration !== execution.executionGeneration
          ) {
            throw error;
          }
          const started = await withClaudeLease(
            command,
            () => claudeManaged.session.start(),
            claudeManaged.session
          );
          if (started.identity.sessionId !== execution.providerThreadId) {
            throw new Error("ManagedConversationProviderCompatibilityError", {
              cause: error
            });
          }
        } else {
          const codexManaged = runtimeSessions.get("codex", execution.id);
          if (
            !codexManaged ||
            codexManaged.executionGeneration !== execution.executionGeneration
          ) {
            throw error;
          }
          const started = await withLease(
            command,
            () => codexManaged.session.start(),
            codexManaged.session
          );
          if (
            started.sessionId !== binding.localSessionId ||
            started.thread.id !== execution.providerThreadId ||
            started.thread.cliVersion !== execution.providerCliVersion
          ) {
            throw new Error("ManagedConversationProviderCompatibilityError", {
              cause: error
            });
          }
        }
        await options.repository.setManagedConversationExecutionState(
          { userId: command.ownerUserId },
          {
            executionId: execution.id,
            expectedStateVersion: execution.stateVersion,
            executionGeneration: execution.executionGeneration,
            state: "running"
          }
        );
        return fork;
      }
      providerArtifactRelativePath = sourceArtifactRelativePath(binding);
      if (!execution.providerCliVersion) {
        throw new Error("ManagedConversationProviderCompatibilityError");
      }
      providerCliVersion = execution.providerCliVersion;
    }
    execution = await resumeForkParent({
      command,
      fork,
      source,
      providerArtifactRelativePath,
      providerCliVersion
    });
    if (
      execution.state !== "running" ||
      execution.sourceGenerationId !== fork.parentNextSourceGenerationId
    ) {
      throw new Error("ManagedConversationForkParentRestartError");
    }
    return fork;
  };

  const runCommand = async (
    command: ClaimedManagedConversationCommand
  ): Promise<void> => {
    if (!command.leaseToken) throw new ManagedConversationLeaseLostError();
    if (command.execution.executionGeneration !== command.executionGeneration) {
      throw Object.assign(new Error("Managed Conversation command is stale"), {
        name: "ManagedConversationFencedError"
      });
    }
    if (command.commandKind === "start") {
      if (command.execution.provider === "claude") {
        const binding = await runtimeBindingFor(
          command.execution,
          command.ownerUserId
        );
        const availability = await checkClaudeCodeAvailability(process.env);
        if (
          !availability.available ||
          !availability.version ||
          !availability.executablePath
        ) {
          throw managedConversationError(
            "ManagedConversationProviderUnavailableError"
          );
        }
        const managedHome = prepareManagedClaudeHome(process.env);
        const session = createClaudeSession(command.execution, binding, {
          managedHome
        });
        let managedHomeRetained = false;
        try {
          const started = await withClaudeLease(
            command,
            (managed) => managed.start(),
            session
          );
          const logicalSessionId = randomUUID();
          const capturedSession =
            await options.repository.createCapturedSession(
              { userId: command.ownerUserId },
              {
                logicalSessionId,
                projectId: command.execution.projectId,
                externalSessionId: started.identity.sessionId,
                sourceRuntime: "claude-code",
                captureMethod: "api",
                model: options.claudeModel,
                cwd: binding.projectPath,
                idempotencyKey: `managed-claude-session:${started.identity.sessionId}`,
                detectedProjects: [
                  {
                    id: command.execution.projectId,
                    name: basename(binding.projectPath),
                    path: binding.projectPath
                  }
                ],
                metadata: {
                  managedConversation: true,
                  externalThreadId: started.identity.sessionId,
                  aiClientProvider: "claude",
                  cliVersion: availability.version
                }
              }
            );
          const bound = await options.repository.bindManagedConversationRuntime(
            { userId: command.ownerUserId },
            {
              executionId: command.executionId,
              expectedStateVersion: command.execution.stateVersion,
              executionGeneration: command.executionGeneration,
              runnerId,
              logicalSessionId: capturedSession.logicalSessionId,
              providerThreadId: started.identity.sessionId,
              providerCliVersion: availability.version
            }
          );
          await options.repository.bindManagedConversationLocalRuntime(
            { userId: command.ownerUserId },
            {
              executionId: command.executionId,
              deploymentId: options.deploymentId,
              deviceId: options.deviceId,
              executionGeneration: command.executionGeneration,
              localSessionId: capturedSession.id,
              providerThreadId: started.identity.sessionId,
              transcriptPath: null,
              managedHome,
              providerCliVersion: availability.version
            }
          );
          retainManagedClaudeHome(managedHome, process.env);
          managedHomeRetained = true;
          runtimeSessions.set("claude", bound.id, {
            executionGeneration: bound.executionGeneration,
            session
          });
          await options.repository.completeManagedConversationCommand({
            commandId: command.id,
            leaseToken: command.leaseToken,
            result: {
              sessionId: capturedSession.id,
              providerThreadId: started.identity.sessionId
            }
          });
          return;
        } catch (error) {
          await session.closeAndWait().catch(() => undefined);
          if (!managedHomeRetained) {
            destroyManagedClaudeHome(managedHome, process.env);
          }
          throw error;
        }
      }
      const started = await withLease(command, (session) => session.start());
      const logicalSessionId = await logicalSessionIdFor(
        command.ownerUserId,
        started.sessionId
      );
      await options.repository.bindManagedConversationRuntime(
        { userId: command.ownerUserId },
        {
          executionId: command.executionId,
          expectedStateVersion: command.execution.stateVersion,
          executionGeneration: command.executionGeneration,
          runnerId,
          logicalSessionId,
          providerThreadId: started.thread.id,
          ...(typeof started.thread.cliVersion === "string"
            ? { providerCliVersion: started.thread.cliVersion }
            : {})
        }
      );
      await options.repository.bindManagedConversationLocalRuntime(
        { userId: command.ownerUserId },
        {
          executionId: command.executionId,
          deploymentId: options.deploymentId!,
          deviceId: options.deviceId!,
          executionGeneration: command.executionGeneration,
          localSessionId: started.sessionId,
          providerThreadId: started.thread.id,
          transcriptPath: started.transcriptPath,
          managedHome: started.codexHome,
          ...(typeof started.thread.cliVersion === "string"
            ? { providerCliVersion: started.thread.cliVersion }
            : {})
        }
      );
      await options.repository.completeManagedConversationCommand({
        commandId: command.id,
        leaseToken: command.leaseToken,
        result: {
          sessionId: started.sessionId,
          providerThreadId: started.thread.id
        }
      });
      return;
    }
    if (command.commandKind === "prompt") {
      const clientUserMessageId = command.clientUserMessageId;
      if (!clientUserMessageId) {
        throw Object.assign(
          new Error("Managed Conversation prompt correlation is missing"),
          { name: "ManagedConversationPayloadError" }
        );
      }
      if (command.execution.provider === "claude") {
        const result = await withClaudeLease(command, (session) =>
          session.prompt(promptFrom(command))
        );
        const binding = await runtimeBindingFor(
          command.execution,
          command.ownerUserId
        );
        if (
          !command.execution.logicalSessionId ||
          !command.execution.providerThreadId ||
          result.sessionId !== command.execution.providerThreadId
        ) {
          throw managedConversationError(
            "ManagedConversationRuntimeBindingError"
          );
        }
        const captured = await captureClaudeTurn({
          sessionId: result.sessionId,
          cwd: binding.projectPath,
          turnBoundary: true,
          ...(binding.managedHome ? { managedHome: binding.managedHome } : {})
        });
        const logicalSessionId = await logicalSessionIdFor(
          command.ownerUserId,
          captured.localSessionId
        );
        if (logicalSessionId !== command.execution.logicalSessionId) {
          throw managedConversationError(
            "ManagedConversationLogicalSessionMismatchError"
          );
        }
        await options.repository.bindManagedConversationSourceGeneration(
          { userId: command.ownerUserId },
          {
            executionId: command.executionId,
            executionGeneration: command.executionGeneration,
            runnerId,
            ...(command.execution.sourceGenerationId
              ? {
                  expectedSourceGenerationId:
                    command.execution.sourceGenerationId
                }
              : {}),
            sourceGenerationId: captured.sourceGenerationId
          }
        );
        await options.repository.bindManagedConversationLocalRuntime(
          { userId: command.ownerUserId },
          {
            executionId: command.executionId,
            deploymentId: options.deploymentId,
            deviceId: options.deviceId,
            executionGeneration: command.executionGeneration,
            localSessionId: captured.localSessionId,
            providerThreadId: result.sessionId,
            transcriptPath: captured.transcriptPath,
            managedHome: captured.managedHome,
            ...(binding.providerCliVersion
              ? { providerCliVersion: binding.providerCliVersion }
              : {}),
            sourceGenerationId: captured.sourceGenerationId
          }
        );
        await options.repository.completeManagedConversationCommand({
          commandId: command.id,
          leaseToken: command.leaseToken,
          result: { model: result.model }
        });
        return;
      }
      const result = await withLease(command, (session) =>
        session.runTurn(
          promptFrom(command),
          turnTimeoutMs,
          `koed-user-message:${clientUserMessageId}`
        )
      );
      const binding = await runtimeBindingFor(
        command.execution,
        command.ownerUserId
      );
      if (
        !command.execution.providerThreadId ||
        !binding.localSessionId ||
        !binding.providerThreadId ||
        !binding.transcriptPath ||
        !binding.managedHome
      ) {
        throw managedConversationError(
          "ManagedConversationRuntimeBindingError"
        );
      }
      const sourceGenerationId = managedConversationOriginSourceGeneration(
        (
          await memoryClient.lookupConversationSourceArtifact({
            sourceKind: "codex",
            externalSessionId: command.execution.providerThreadId
          })
        ).artifact,
        {
          sessionId: binding.localSessionId,
          providerThreadId: command.execution.providerThreadId,
          sourceKind: "codex"
        }
      );
      await options.repository.bindManagedConversationSourceGeneration(
        { userId: command.ownerUserId },
        {
          executionId: command.executionId,
          executionGeneration: command.executionGeneration,
          runnerId,
          ...(command.execution.sourceGenerationId
            ? {
                expectedSourceGenerationId: command.execution.sourceGenerationId
              }
            : {}),
          sourceGenerationId
        }
      );
      await options.repository.bindManagedConversationLocalRuntime(
        { userId: command.ownerUserId },
        {
          executionId: command.executionId,
          deploymentId: options.deploymentId!,
          deviceId: options.deviceId!,
          executionGeneration: command.executionGeneration,
          localSessionId: binding.localSessionId,
          providerThreadId: binding.providerThreadId,
          transcriptPath: binding.transcriptPath,
          managedHome: binding.managedHome,
          ...(binding.providerCliVersion
            ? { providerCliVersion: binding.providerCliVersion }
            : {}),
          sourceGenerationId
        }
      );
      await options.repository.completeManagedConversationCommand({
        commandId: command.id,
        leaseToken: command.leaseToken,
        result: {
          ...(result.turnId ? { turnId: result.turnId } : {})
        }
      });
      return;
    }
    if (command.commandKind === "verify_target") {
      let handoff =
        await options.repository.getActiveManagedConversationHandoffForExecution(
          { userId: command.ownerUserId },
          command.executionId
        );
      if (
        !handoff ||
        handoff.targetDeviceId !== options.deviceId ||
        handoff.targetDeploymentId !== options.deploymentId
      ) {
        throw new Error("ManagedConversationHandoffTargetError");
      }
      if (["workspace_prepared", "target_verified"].includes(handoff.state)) {
        if (
          handoff.state === "workspace_prepared" ||
          !handoff.targetReadinessEvidence ||
          !managedConversationTargetReadinessIsFresh(
            handoff.targetReadinessEvidence
          )
        ) {
          const target = await workspaceForTarget(command);
          handoff =
            await options.repository.verifyManagedConversationHandoffTarget(
              { userId: command.ownerUserId },
              {
                handoffId: target.handoff.id,
                expectedStateVersion: target.handoff.stateVersion,
                targetDeviceId: options.deviceId!,
                evidence: target.readinessEvidence
              }
            );
        }
        handoff = await options.repository.commitManagedConversationHandoff(
          { userId: command.ownerUserId },
          {
            handoffId: handoff.id,
            expectedStateVersion: handoff.stateVersion
          }
        );
      }
      if (
        !["lease_transferred", "restoring", "identity_verified"].includes(
          handoff.state
        )
      ) {
        throw new Error("ManagedConversationHandoffVerificationStateError");
      }
      await options.repository.completeManagedConversationCommand({
        commandId: command.id,
        leaseToken: command.leaseToken,
        result: {
          handoffId: handoff.id,
          state: handoff.state,
          executionGeneration: handoff.nextExecutionGeneration
        }
      });
      return;
    }
    if (command.commandKind === "restore") {
      const latest =
        await options.repository.getLatestManagedConversationHandoffForExecution(
          { userId: command.ownerUserId },
          command.executionId
        );
      if (
        !latest ||
        latest.targetDeviceId !== options.deviceId ||
        latest.targetDeploymentId !== options.deploymentId
      ) {
        throw new Error("ManagedConversationHandoffTargetError");
      }
      if (latest.state === "running") {
        const binding =
          await options.repository.getManagedConversationRuntimeBinding(
            { userId: command.ownerUserId },
            command.executionId
          );
        if (
          !binding?.managedHome ||
          !binding.transcriptPath ||
          !binding.localSessionId ||
          binding.deviceId !== options.deviceId ||
          binding.deploymentId !== options.deploymentId ||
          binding.executionGeneration !== latest.nextExecutionGeneration ||
          binding.sourceGenerationId !==
            latest.transferManifest?.nextSourceGenerationId ||
          binding.providerThreadId !== latest.transferManifest?.providerThreadId
        ) {
          throw new Error("ManagedConversationRestoreRecoveryBindingError");
        }
        const recoveredProviderThreadId =
          command.execution.provider === "claude"
            ? await (async () => {
                const session = await sessionForClaude(command.execution);
                const started = await withClaudeLease(
                  command,
                  () => session.start(),
                  session
                );
                if (
                  started.identity.sessionId !== binding.providerThreadId ||
                  started.identity.sessionId !==
                    command.execution.providerThreadId
                ) {
                  throw new Error(
                    "ManagedConversationRestoreRecoveryIdentityError"
                  );
                }
                return started.identity.sessionId;
              })()
            : await (async () => {
                const session = await sessionFor(command.execution);
                const started = await withLease(
                  command,
                  () => session.start(),
                  session
                );
                if (
                  started.sessionId !== binding.localSessionId ||
                  started.thread.id !== binding.providerThreadId ||
                  started.thread.cliVersion !== binding.providerCliVersion
                ) {
                  throw new Error(
                    "ManagedConversationRestoreRecoveryIdentityError"
                  );
                }
                return started.thread.id;
              })();
        await options.repository.completeManagedConversationCommand({
          commandId: command.id,
          leaseToken: command.leaseToken,
          result: {
            handoffId: latest.id,
            state: latest.state,
            providerThreadId: recoveredProviderThreadId,
            recovered: true
          }
        });
        return;
      }
      const target = await workspaceForTarget(command);
      const certificate = target.material.handoff.certificate;
      if (
        !certificate ||
        !verifyManagedConversationHandoffCertificate({
          certificate,
          sourcePublicKey: target.material.sourcePublicKey,
          authorityPublicKey: target.material.authorityPublicKey,
          expectedTargetDeviceId: options.deviceId!,
          minimumAuthoritySequence: target.handoff.authoritySequence ?? 1,
          expectedPriorAuthorityLogHead: target.handoff.priorAuthorityLogHead,
          enforceExpiry: false
        }) ||
        managedConversationHandoffCertificateDigest(certificate) !==
          target.handoff.certificateDigest
      ) {
        throw new Error("ManagedConversationTransferCertificateError");
      }
      const restoring =
        await options.repository.beginManagedConversationHandoffRestore(
          { userId: command.ownerUserId },
          {
            handoffId: target.handoff.id,
            expectedStateVersion: target.handoff.stateVersion,
            targetDeviceId: options.deviceId!,
            runnerId,
            leaseMs: restorationLeaseMs
          }
        );
      const runtimeBinding = await runtimeBindingFor(
        command.execution,
        command.ownerUserId,
        target.path
      );
      const reusableBinding =
        runtimeBinding.managedHome &&
        runtimeBinding.transcriptPath &&
        runtimeBinding.localSessionId &&
        runtimeBinding.providerThreadId ===
          certificate.manifest.providerThreadId &&
        runtimeBinding.sourceGenerationId ===
          certificate.manifest.nextSourceGenerationId
          ? {
              ...runtimeBinding,
              managedHome: runtimeBinding.managedHome,
              transcriptPath: runtimeBinding.transcriptPath,
              localSessionId: runtimeBinding.localSessionId,
              providerThreadId: runtimeBinding.providerThreadId
            }
          : null;
      const isClaudeRestore = command.execution.provider === "claude";
      const managedHome = reusableBinding
        ? isClaudeRestore
          ? reuseManagedClaudeHome(reusableBinding.managedHome, process.env)
          : reuseManagedCodexHome(reusableBinding.managedHome, process.env)
        : isClaudeRestore
          ? prepareManagedClaudeHome(process.env)
          : prepareManagedCodexHome(process.env);
      let codexSession: CodexManagedConversationSession | undefined;
      let claudeSession: ClaudeManagedConversationSession | undefined;
      let localBindingPersisted = Boolean(reusableBinding);
      let restorationLeaseLost = false;
      let restorationHeartbeatStopped = false;
      const restorationHeartbeat = async () => {
        if (restorationHeartbeatStopped || restorationLeaseLost) return;
        try {
          restorationLeaseLost =
            !(await options.repository.renewManagedConversationHandoffRestoreLease(
              {
                handoffId: restoring.id,
                expectedStateVersion: restoring.stateVersion,
                targetDeviceId: options.deviceId!,
                runnerId,
                leaseMs: restorationLeaseMs
              }
            ));
        } catch {
          restorationLeaseLost = true;
        }
        if (restorationLeaseLost) {
          await (claudeSession ?? codexSession)
            ?.closeAndWait()
            .catch(() => undefined);
        }
      };
      const restorationHeartbeatTimer = setInterval(
        () => void restorationHeartbeat(),
        commandHeartbeatMs
      );
      restorationHeartbeatTimer.unref?.();
      try {
        const successor =
          await memoryClient.createConversationSourceSuccessorGeneration(
            target.transcript.artifactId,
            {
              expectedParentClosureHash: certificate.manifest.sourceClosureHash,
              sourceGenerationId: certificate.manifest.nextSourceGenerationId,
              originKeyId: certificate.manifest.targetOriginKeyId
            }
          );
        const successorArtifact = record(successor.artifact);
        if (
          successorArtifact.logicalSourceId !==
            certificate.manifest.logicalSourceId ||
          successorArtifact.sourceGenerationId !==
            certificate.manifest.nextSourceGenerationId ||
          successorArtifact.originKeyId !==
            certificate.manifest.targetOriginKeyId ||
          successorArtifact.originDeploymentId !== options.deploymentId ||
          successorArtifact.originDeviceId !== options.deviceId ||
          successorArtifact.lifecycle !== "active" ||
          successorArtifact.providerCursorOffset !==
            certificate.manifest.sourceEndByteCursor ||
          successorArtifact.providerCursorLine !==
            certificate.manifest.sourceEndItemCursor
        ) {
          throw new Error("ManagedConversationSuccessorGenerationError");
        }
        const transcriptPath =
          reusableBinding?.transcriptPath ??
          resolve(
            managedHome,
            ...certificate.manifest.providerArtifactRelativePath.split("/")
          );
        if (!transcriptPath.startsWith(`${resolve(managedHome)}${sep}`)) {
          throw new Error("ManagedConversationTranscriptPathError");
        }
        await mkdir(dirname(transcriptPath), {
          recursive: true,
          mode: 0o700
        });
        if (reusableBinding) {
          const existing = await readFile(transcriptPath);
          if (
            existing.byteLength !== target.transcript.bytes.byteLength ||
            !existing.equals(target.transcript.bytes)
          ) {
            throw new Error("ManagedConversationTranscriptConflictError");
          }
        } else {
          await writeFile(transcriptPath, target.transcript.bytes, {
            flag: "wx",
            mode: 0o600
          });
        }
        const started = isClaudeRestore
          ? await (async () => {
              claudeSession = createClaudeSession(
                command.execution,
                runtimeBinding,
                {
                  projectPath: target.path,
                  resumeSessionId: certificate.manifest.providerThreadId,
                  managedHome
                }
              );
              const value = await withClaudeLease(
                command,
                () => claudeSession!.start(),
                claudeSession
              );
              return {
                localSessionId: target.transcript.sourceSessionId,
                providerThreadId: value.identity.sessionId,
                providerCliVersion: certificate.manifest.providerCliVersion,
                transcriptPath,
                managedHome
              };
            })()
          : await (async () => {
              codexSession = createSession(command.execution, runtimeBinding, {
                projectPath: target.path,
                resume: {
                  threadId: certificate.manifest.providerThreadId,
                  sessionId: target.transcript.sourceSessionId,
                  transcriptPath,
                  codexHome: managedHome
                }
              });
              const value = await withLease(
                command,
                () => codexSession!.start(),
                codexSession
              );
              return {
                localSessionId: value.sessionId,
                providerThreadId: value.thread.id,
                providerCliVersion: value.thread.cliVersion,
                transcriptPath: value.transcriptPath,
                managedHome: value.codexHome
              };
            })();
        if (restorationLeaseLost) {
          throw new ManagedConversationLeaseLostError();
        }
        if (
          started.providerThreadId !== certificate.manifest.providerThreadId ||
          started.providerCliVersion !== certificate.manifest.providerCliVersion
        ) {
          throw new Error("ManagedConversationProviderCompatibilityError");
        }
        const logicalSessionId = await logicalSessionIdFor(
          command.ownerUserId,
          started.localSessionId
        );
        if (
          command.execution.logicalSessionId &&
          logicalSessionId !== command.execution.logicalSessionId
        ) {
          throw new Error("ManagedConversationLogicalSessionMismatchError");
        }
        await options.repository.bindManagedConversationLocalRuntime(
          { userId: command.ownerUserId },
          {
            executionId: command.executionId,
            deploymentId: options.deploymentId!,
            deviceId: options.deviceId!,
            executionGeneration: command.executionGeneration,
            localSessionId: started.localSessionId,
            providerThreadId: started.providerThreadId,
            transcriptPath: started.transcriptPath,
            managedHome: started.managedHome,
            providerCliVersion: started.providerCliVersion,
            sourceGenerationId: certificate.manifest.nextSourceGenerationId
          }
        );
        if (isClaudeRestore) {
          retainManagedClaudeHome(managedHome, process.env);
        }
        localBindingPersisted = true;
        await options.repository.completeManagedConversationHandoffRestore(
          { userId: command.ownerUserId },
          {
            handoffId: restoring.id,
            expectedStateVersion: restoring.stateVersion,
            targetDeviceId: options.deviceId!,
            runnerId,
            logicalSessionId,
            providerThreadId: started.providerThreadId,
            providerCliVersion: started.providerCliVersion,
            sourceGenerationId: certificate.manifest.nextSourceGenerationId
          }
        );
        if (claudeSession) {
          runtimeSessions.set("claude", command.executionId, {
            executionGeneration: command.executionGeneration,
            session: claudeSession
          });
        } else if (codexSession) {
          runtimeSessions.set("codex", command.executionId, {
            executionGeneration: command.executionGeneration,
            session: codexSession
          });
        }
        await options.repository.completeManagedConversationCommand({
          commandId: command.id,
          leaseToken: command.leaseToken,
          result: {
            handoffId: restoring.id,
            state: "running",
            providerThreadId: started.providerThreadId
          }
        });
      } catch (error) {
        await (claudeSession ?? codexSession)
          ?.closeAndWait()
          .catch(() => undefined);
        if (!localBindingPersisted) {
          if (isClaudeRestore) {
            destroyManagedClaudeHome(managedHome, process.env);
          } else {
            destroyManagedCodexHome(managedHome, process.env);
          }
        }
        throw error;
      } finally {
        restorationHeartbeatStopped = true;
        clearInterval(restorationHeartbeatTimer);
      }
      return;
    }
    if (command.commandKind === "fork_create") {
      let target:
        | Awaited<ReturnType<typeof workspaceForForkTarget>>
        | undefined;
      let prepared:
        | Awaited<
            ReturnType<
              typeof options.repository.prepareManagedConversationForkChild
            >
          >
        | undefined;
      let managedHome: string | undefined;
      let codexSession: CodexManagedConversationSession | undefined;
      let claudeSession: ClaudeManagedConversationSession | undefined;
      let claudeFork:
        | Awaited<ReturnType<typeof forkClaudeTranscript>>
        | undefined;
      try {
        target = await workspaceForForkTarget(command);
        prepared = await options.repository.prepareManagedConversationForkChild(
          { userId: command.ownerUserId },
          {
            forkId: target.fork.id,
            expectedStateVersion: target.fork.stateVersion,
            targetDeviceId: options.deviceId!
          }
        );
        const existingBinding =
          await options.repository.getManagedConversationRuntimeBinding(
            { userId: command.ownerUserId },
            prepared.childExecution.id
          );
        if (
          prepared.childExecution.state === "running" &&
          prepared.childExecution.logicalSessionId &&
          prepared.childExecution.providerThreadId &&
          existingBinding?.localSessionId &&
          existingBinding.providerThreadId ===
            prepared.childExecution.providerThreadId &&
          existingBinding.sourceGenerationId ===
            prepared.childExecution.sourceGenerationId &&
          existingBinding.sourceGenerationId
        ) {
          const sourceLookup =
            await memoryClient.getConversationSourceArtifactByGeneration(
              existingBinding.sourceGenerationId
            );
          const childSource = record(sourceLookup.artifact);
          if (
            childSource.lifecycle !== "active" ||
            childSource.externalSessionId !==
              prepared.childExecution.providerThreadId ||
            typeof childSource.logicalSourceId !== "string" ||
            childSource.logicalSourceId === target.manifest.logicalSourceId
          ) {
            throw new Error("ManagedConversationForkChildSourceError");
          }
          const childLogicalSessionId = await logicalSessionIdFor(
            command.ownerUserId,
            existingBinding.localSessionId
          );
          if (
            childLogicalSessionId !== prepared.childExecution.logicalSessionId
          ) {
            throw new Error("ManagedConversationLogicalSessionMismatchError");
          }
          await ensureAuthoritySourceRegistration(
            command.ownerUserId,
            existingBinding.sourceGenerationId
          );
          const completed =
            await options.repository.completeManagedConversationFork(
              { userId: command.ownerUserId },
              {
                forkId: prepared.fork.id,
                expectedStateVersion: prepared.fork.stateVersion,
                targetDeviceId: options.deviceId!,
                childExecutionId: prepared.childExecution.id,
                childLogicalSessionId,
                childLogicalSourceId: childSource.logicalSourceId,
                childProviderThreadId: prepared.childExecution.providerThreadId
              }
            );
          await options.repository.completeManagedConversationCommand({
            commandId: command.id,
            leaseToken: command.leaseToken,
            result: {
              forkId: completed.id,
              childExecutionId: prepared.childExecution.id,
              childSessionId: existingBinding.localSessionId,
              childProviderThreadId: prepared.childExecution.providerThreadId,
              state: completed.state
            }
          });
          return;
        }
        const isClaudeFork = prepared.childExecution.provider === "claude";
        managedHome = isClaudeFork
          ? prepareManagedClaudeHome(process.env)
          : prepareManagedCodexHome(process.env);
        const sourceTranscriptPath = await writeManagedTranscript({
          managedHome,
          relativePath: target.manifest.providerArtifactRelativePath,
          bytes: target.transcript.bytes
        });
        const binding = await runtimeBindingFor(
          prepared.childExecution,
          command.ownerUserId,
          target.path
        );
        if (isClaudeFork) {
          claudeFork = await forkClaudeTranscript({
            parentSessionId: target.manifest.providerThreadId,
            cwd: target.path,
            transcriptBytes: target.transcript.bytes
          });
          const childRelativePath = `${dirname(
            target.manifest.providerArtifactRelativePath
          ).replaceAll("\\", "/")}/${claudeFork.sessionId}.jsonl`;
          await writeManagedTranscript({
            managedHome,
            relativePath: childRelativePath,
            bytes: claudeFork.bytes
          });
          claudeSession = createClaudeSession(
            prepared.childExecution,
            binding,
            {
              projectPath: target.path,
              resumeSessionId: claudeFork.sessionId,
              managedHome
            }
          );
        } else {
          codexSession = createSession(prepared.childExecution, binding, {
            projectPath: target.path,
            fork: {
              parentThreadId: target.manifest.providerThreadId,
              sourceTranscriptPath,
              codexHome: managedHome
            }
          });
        }
      } catch (error) {
        if (error instanceof ManagedConversationSourceReplicaPendingError) {
          throw error;
        }
        if (managedHome) {
          if (prepared?.childExecution.provider === "claude") {
            destroyManagedClaudeHome(managedHome, process.env);
          } else {
            destroyManagedCodexHome(managedHome, process.env);
          }
        }
        if (target) {
          await options.repository
            .failManagedConversationFork(
              { userId: command.ownerUserId },
              {
                forkId: target.fork.id,
                expectedStateVersion:
                  prepared?.fork.stateVersion ?? target.fork.stateVersion,
                deviceId: options.deviceId!,
                state: "failed",
                failureCode: errorCode(error)
              }
            )
            .catch(() => undefined);
        }
        throw error;
      }
      try {
        const started = claudeSession
          ? await (async () => {
              if (!managedHome || !claudeFork) {
                throw new Error("ManagedConversationForkProviderStateError");
              }
              const value = await withClaudeLease(
                command,
                () => claudeSession!.start(),
                claudeSession
              );
              if (
                value.identity.sessionId !== claudeFork.sessionId ||
                value.identity.sessionId === target.manifest.providerThreadId
              ) {
                throw new Error("ManagedConversationForkProviderLineageError");
              }
              const captured = await captureClaudeTurn({
                sessionId: value.identity.sessionId,
                cwd: target.path,
                turnBoundary: false,
                managedHome
              });
              return {
                provider: "claude" as const,
                localSessionId: captured.localSessionId,
                providerThreadId: value.identity.sessionId,
                providerCliVersion: target.manifest.providerCliVersion,
                sourceGenerationId: captured.sourceGenerationId,
                transcriptPath: captured.transcriptPath,
                managedHome: captured.managedHome
              };
            })()
          : await (async () => {
              if (!codexSession) {
                throw new Error("ManagedConversationForkProviderStateError");
              }
              const value = await withLease(
                command,
                () => codexSession!.start(),
                codexSession
              );
              if (
                value.thread.forkedFromId !==
                  target.manifest.providerThreadId ||
                value.thread.id === target.manifest.providerThreadId ||
                value.thread.cliVersion !== target.manifest.providerCliVersion
              ) {
                throw new Error("ManagedConversationForkProviderLineageError");
              }
              return {
                provider: "codex" as const,
                localSessionId: value.sessionId,
                providerThreadId: value.thread.id,
                providerCliVersion: value.thread.cliVersion,
                sourceGenerationId: null,
                transcriptPath: value.transcriptPath,
                managedHome: value.codexHome
              };
            })();
        const sourceLookup =
          await memoryClient.lookupConversationSourceArtifact({
            sourceKind: started.provider === "claude" ? "claude-code" : "codex",
            externalSessionId: started.providerThreadId
          });
        const childSource = record(sourceLookup.artifact);
        if (
          childSource.lifecycle !== "active" ||
          typeof childSource.logicalSourceId !== "string" ||
          childSource.logicalSourceId === target.manifest.logicalSourceId ||
          typeof childSource.sourceGenerationId !== "string" ||
          (started.sourceGenerationId !== null &&
            childSource.sourceGenerationId !== started.sourceGenerationId)
        ) {
          throw new Error("ManagedConversationForkChildSourceError");
        }
        const childLogicalSessionId = await logicalSessionIdFor(
          command.ownerUserId,
          started.localSessionId
        );
        const bound = await options.repository.bindManagedConversationRuntime(
          { userId: command.ownerUserId },
          {
            executionId: prepared.childExecution.id,
            expectedStateVersion: prepared.childExecution.stateVersion,
            executionGeneration: prepared.childExecution.executionGeneration,
            runnerId,
            logicalSessionId: childLogicalSessionId,
            providerThreadId: started.providerThreadId,
            providerCliVersion: started.providerCliVersion,
            sourceGenerationId: childSource.sourceGenerationId
          }
        );
        await options.repository.bindManagedConversationLocalRuntime(
          { userId: command.ownerUserId },
          {
            executionId: bound.id,
            deploymentId: options.deploymentId!,
            deviceId: options.deviceId!,
            executionGeneration: bound.executionGeneration,
            localSessionId: started.localSessionId,
            providerThreadId: started.providerThreadId,
            transcriptPath: started.transcriptPath,
            managedHome: started.managedHome,
            providerCliVersion: started.providerCliVersion,
            sourceGenerationId: childSource.sourceGenerationId
          }
        );
        if (claudeSession && managedHome) {
          retainManagedClaudeHome(managedHome, process.env);
        }
        if (claudeSession) {
          runtimeSessions.set("claude", bound.id, {
            executionGeneration: bound.executionGeneration,
            session: claudeSession
          });
        } else if (codexSession) {
          runtimeSessions.set("codex", bound.id, {
            executionGeneration: bound.executionGeneration,
            session: codexSession
          });
        }
        await ensureAuthoritySourceRegistration(
          command.ownerUserId,
          childSource.sourceGenerationId
        );
        const completed =
          await options.repository.completeManagedConversationFork(
            { userId: command.ownerUserId },
            {
              forkId: prepared.fork.id,
              expectedStateVersion: prepared.fork.stateVersion,
              targetDeviceId: options.deviceId!,
              childExecutionId: bound.id,
              childLogicalSessionId,
              childLogicalSourceId: childSource.logicalSourceId,
              childProviderThreadId: started.providerThreadId
            }
          );
        await options.repository.completeManagedConversationCommand({
          commandId: command.id,
          leaseToken: command.leaseToken,
          result: {
            forkId: completed.id,
            childExecutionId: bound.id,
            childSessionId: started.localSessionId,
            childProviderThreadId: started.providerThreadId,
            state: completed.state
          }
        });
      } catch (error) {
        if (error instanceof ManagedConversationSourceReplicaPendingError) {
          throw error;
        }
        await (claudeSession ?? codexSession)
          ?.closeAndWait()
          .catch(() => undefined);
        if (prepared?.childExecution.id) {
          runtimeSessions.delete("codex", prepared.childExecution.id);
          runtimeSessions.delete("claude", prepared.childExecution.id);
        }
        await options.repository
          .failManagedConversationFork(
            { userId: command.ownerUserId },
            {
              forkId: prepared.fork.id,
              expectedStateVersion: prepared.fork.stateVersion,
              deviceId: options.deviceId!,
              state: "indeterminate",
              failureCode: errorCode(error)
            }
          )
          .catch(() => undefined);
        throw error;
      }
      return;
    }
    if (command.commandKind === "fork_prepare") {
      try {
        const prepared = await prepareFork(command);
        await options.repository.completeManagedConversationCommand({
          commandId: command.id,
          leaseToken: command.leaseToken,
          result: prepared
        });
      } catch (error) {
        if (!shouldRecoverForkPreparationFailure(error)) {
          throw error;
        }
        let recovered: ManagedConversationForkRecord | null = null;
        let recoveryError: unknown;
        try {
          recovered = await recoverForkParent(command);
        } catch (caught) {
          recoveryError = caught;
        }
        const current =
          recovered ??
          (await options.repository.getActiveManagedConversationForkForParent(
            { userId: command.ownerUserId },
            command.executionId
          ));
        if (current) {
          await options.repository
            .failManagedConversationFork(
              { userId: command.ownerUserId },
              {
                forkId: current.id,
                expectedStateVersion: current.stateVersion,
                deviceId: options.deviceId!,
                state: recoveryError ? "indeterminate" : "failed",
                failureCode: errorCode(recoveryError ?? error)
              }
            )
            .catch(() => undefined);
        }
        throw recoveryError ?? error;
      }
      return;
    }
    if (command.commandKind === "quiesce") {
      let sealedSources: CodexManagedConversationSealedSource[];
      let next = command.execution;
      if (command.execution.state === "quiesced") {
        sealedSources = [await sealedPrimarySourceFor(command.execution)];
      } else if (command.execution.provider === "claude") {
        const sealed = await withClaudeLease(command, () =>
          sealClaudePrimarySource(command.execution)
        );
        sealedSources = [sealed];
        if (
          command.execution.sourceGenerationId !== sealed.sourceGenerationId
        ) {
          await options.repository.bindManagedConversationSourceGeneration(
            { userId: command.ownerUserId },
            {
              executionId: command.executionId,
              executionGeneration: command.executionGeneration,
              runnerId,
              ...(command.execution.sourceGenerationId
                ? {
                    expectedSourceGenerationId:
                      command.execution.sourceGenerationId
                  }
                : {}),
              sourceGenerationId: sealed.sourceGenerationId
            }
          );
        }
        runtimeSessions.delete("claude", command.executionId);
        next = await options.repository.setManagedConversationExecutionState(
          { userId: command.ownerUserId },
          {
            executionId: command.executionId,
            expectedStateVersion: command.execution.stateVersion,
            executionGeneration: command.executionGeneration,
            state: "quiesced"
          }
        );
      } else {
        const session = await sessionFor(command.execution);
        sealedSources = await withLease(command, () =>
          session.quiesceAndSealSources()
        );
        runtimeSessions.delete("codex", command.executionId);
        next = await options.repository.setManagedConversationExecutionState(
          { userId: command.ownerUserId },
          {
            executionId: command.executionId,
            expectedStateVersion: command.execution.stateVersion,
            executionGeneration: command.executionGeneration,
            state: "quiesced"
          }
        );
      }
      const handoff =
        await options.repository.getActiveManagedConversationHandoffForExecution(
          { userId: command.ownerUserId },
          command.executionId
        );
      let preparedState: string | null = null;
      if (handoff) {
        if (!options.deviceId) {
          throw new Error("ManagedConversationDeviceIdentityError");
        }
        const source = sealedSources.find(
          (candidate) =>
            candidate.threadId === command.execution.providerThreadId
        );
        if (!source) {
          throw new Error("ManagedConversationPrimarySourceError");
        }
        const binding = await runtimeBindingFor(
          command.execution,
          command.ownerUserId
        );
        const signer = createDeviceBoundSourceSigner({
          koedHome: options.koedHome,
          sourceGenerationId: source.sourceGenerationId,
          originKeyId: source.originKeyId
        });
        if (
          signer.deploymentId !== handoff.sourceDeploymentId ||
          signer.deviceInstanceId !== handoff.sourceDeviceId
        ) {
          throw new Error("ManagedConversationSourceDeviceError");
        }
        let workspaceSnapshotId = await reusableWorkspaceSnapshotId({
          ownerUserId: command.ownerUserId,
          executionId: command.executionId,
          operationKind: "handoff",
          operationId: handoff.id,
          sourceGenerationId: source.sourceGenerationId,
          sourceDeploymentId: handoff.sourceDeploymentId,
          sourceDeviceId: handoff.sourceDeviceId
        });
        if (!workspaceSnapshotId) {
          const snapshot = await createDevelopmentWorkspaceSnapshot(
            binding.projectPath,
            { snapshotId: handoff.id, createdAt: handoff.createdAt }
          );
          workspaceSnapshotId = await persistWorkspaceSnapshot({
            ownerUserId: command.ownerUserId,
            projectId: command.execution.projectId,
            executionId: command.executionId,
            operationKind: "handoff",
            operationId: handoff.id,
            sourceGenerationId: source.sourceGenerationId,
            sourceDeploymentId: handoff.sourceDeploymentId,
            sourceDeviceId: handoff.sourceDeviceId,
            snapshot,
            readinessEvidence: {
              snapshotIntegrity: "verified",
              sourceStateDigest: snapshot.sourceStateDigest
            }
          });
        }
        const prepared = await options.repository
          .prepareManagedConversationHandoff(
            { userId: command.ownerUserId },
            {
              handoffId: handoff.id,
              expectedStateVersion: handoff.stateVersion,
              runnerId,
              providerArtifactRelativePath: sourceArtifactRelativePath(binding),
              logicalSourceId: source.logicalSourceId,
              sourceGenerationId: source.sourceGenerationId,
              sourceClosureHash: source.closureHash,
              sourceEndByteCursor: source.providerCursorOffset,
              sourceEndItemCursor: source.providerCursorLine,
              workspaceSnapshotId
            }
          )
          .catch((error: unknown) =>
            sourceReplicaPending(error, source.sourceGenerationId, [
              "managed_conversation_handoff_source_closure_conflict"
            ])
          );
        const sourceSignature = signer.sign(
          Buffer.from(
            canonicalManagedConversationHandoffManifest(prepared.manifest),
            "utf8"
          )
        );
        const attested =
          await options.repository.attestManagedConversationHandoffSource(
            { userId: command.ownerUserId },
            {
              handoffId: prepared.handoff.id,
              expectedStateVersion: prepared.handoff.stateVersion,
              sourceKeyId: signer.keyId,
              sourceSignature
            }
          );
        preparedState = attested.state;
      }
      await options.repository.completeManagedConversationCommand({
        commandId: command.id,
        leaseToken: command.leaseToken,
        result: {
          state: next.state,
          sealedSources,
          ...(preparedState ? { handoffState: preparedState } : {})
        }
      });
      return;
    }
    if (command.execution.provider === "claude") {
      const session = await sessionForClaude(command.execution);
      await withClaudeLease(
        command,
        async () => {
          if (command.execution.sourceGenerationId) {
            await sealClaudePrimarySource(command.execution);
          } else {
            await session.closeAndWait();
          }
        },
        session
      );
      runtimeSessions.delete("claude", command.executionId);
    } else {
      const session = await sessionFor(command.execution);
      await withLease(command, async () => {
        await session.closeAndWait();
      });
      runtimeSessions.delete("codex", command.executionId);
    }
    const next = await options.repository.setManagedConversationExecutionState(
      { userId: command.ownerUserId },
      {
        executionId: command.executionId,
        expectedStateVersion: command.execution.stateVersion,
        executionGeneration: command.executionGeneration,
        state: "stopped"
      }
    );
    await options.repository.completeManagedConversationCommand({
      commandId: command.id,
      leaseToken: command.leaseToken,
      result: { state: next.state }
    });
  };

  const processOnce = async () => {
    await ensureStartupRecovery();
    let completed = 0;
    let failed = 0;
    await options.repository.reconcileAbandonedManagedConversationCommands({
      ownerUserId: options.localOwnerUserId,
      deviceId: options.deviceId,
      deploymentId: options.deploymentId,
      limit: 32
    });
    const claims = await options.repository.claimManagedConversationCommands({
      runnerId,
      deviceId: options.deviceId,
      deploymentId: options.deploymentId,
      limit: 8,
      leaseMs: commandLeaseMs
    });
    for (const command of claims) {
      try {
        await withCommandHeartbeat(command, () => runCommand(command));
        completed += 1;
      } catch (error) {
        if (
          error instanceof ManagedConversationSourceReplicaPendingError &&
          command.leaseToken
        ) {
          const blocked =
            await options.repository.blockManagedConversationCommand({
              commandId: command.id,
              leaseToken: command.leaseToken,
              sourceGenerationId: error.sourceGenerationId,
              readiness: error.readiness,
              errorCode: error.name
            });
          if (blocked) {
            if (shouldPublishManagedConversationSource(error)) {
              if (!options.sourcePublishControl) {
                throw new Error(
                  "ManagedConversationSourcePublishControlError",
                  { cause: error }
                );
              }
              if (error.readiness === "registered") {
                await options.sourcePublishControl.ensureRegistration({
                  sourceGenerationId: error.sourceGenerationId
                });
              } else {
                await options.sourcePublishControl.ensure({
                  sourceGenerationId: error.sourceGenerationId
                });
              }
            }
            await reconcileBlockedManagedConversationSource({
              blocked,
              sourceGenerationId: error.sourceGenerationId,
              isReady:
                error.readinessLocation === "authority"
                  ? async (sourceGenerationId) =>
                      options.repository.isManagedConversationSourceGenerationReady(
                        {
                          ownerUserId: command.ownerUserId,
                          sourceGenerationId,
                          readiness: error.readiness
                        }
                      )
                  : sourceGenerationIsReady,
              release: async (sourceGenerationId) => {
                await options.repository.releaseManagedConversationCommandsForSourceGeneration(
                  {
                    ownerUserId: options.localOwnerUserId,
                    sourceGenerationId,
                    targetDeploymentId: options.deploymentId,
                    targetDeviceId: options.deviceId,
                    readiness: error.readiness
                  }
                );
              }
            }).catch((readinessError: unknown) => {
              options.logger.warn(
                {
                  event: {
                    name: "worker.managed_conversation.source_readiness_reconciliation_failed",
                    category: "managed_conversation"
                  },
                  error_name: errorCode(readinessError)
                },
                "managed Conversation source readiness reconciliation failed"
              );
            });
            options.logger.info(
              {
                event: {
                  name: "worker.managed_conversation.source_replica_pending",
                  category: "managed_conversation"
                },
                command_kind: command.commandKind
              },
              "managed Conversation command is waiting for its exact source replica"
            );
            continue;
          }
        }
        const isPrompt = command.commandKind === "prompt";
        const isForkCreate = command.commandKind === "fork_create";
        const isForkPrepare = command.commandKind === "fork_prepare";
        const isForkLifecycleCommand = isForkCreate || isForkPrepare;
        const isCoordinationCommand =
          isForkLifecycleCommand || command.commandKind === "verify_target";
        const isOneShot = isPrompt || isForkLifecycleCommand;
        const terminal =
          isOneShot ||
          error instanceof ManagedConversationLeaseLostError ||
          command.attempts >= 3;
        let promptWasReconciled = false;
        if (command.leaseToken) {
          const failure = await options.repository
            .failManagedConversationCommand({
              commandId: command.id,
              leaseToken: command.leaseToken,
              state: isOneShot
                ? "indeterminate"
                : terminal
                  ? "failed"
                  : "queued",
              errorCode: errorCode(error)
            })
            .catch(() => ({ updated: false, reconciled: false }));
          promptWasReconciled = failure.reconciled;
        }
        if (promptWasReconciled) {
          const managedClaude = runtimeSessions.get(
            "claude",
            command.executionId
          );
          if (managedClaude && command.execution.provider === "claude") {
            try {
              const started = await managedClaude.session.start();
              const binding = await runtimeBindingFor(
                command.execution,
                command.ownerUserId
              );
              await captureClaudeTurn({
                sessionId: started.identity.sessionId,
                cwd: binding.projectPath,
                turnBoundary: true,
                ...(binding.managedHome
                  ? { managedHome: binding.managedHome }
                  : {})
              });
              completed += 1;
              continue;
            } catch {
              // The accepted prompt remains fenced if exact source reconciliation fails.
            }
          }
          const managed = runtimeSessions.get("codex", command.executionId);
          if (managed) {
            try {
              await managed.session.start();
              await managed.session.reconcileTranscript();
              completed += 1;
              continue;
            } catch {
              // The prompt is accepted, but the runtime must remain fenced from writes.
            }
          }
        }
        failed += 1;
        if (terminal && !isCoordinationCommand) {
          const managedClaude = runtimeSessions.get(
            "claude",
            command.executionId
          );
          if (managedClaude) {
            runtimeSessions.delete("claude", command.executionId);
            await managedClaude.session.closeAndWait().catch(() => undefined);
          }
          const managed = runtimeSessions.get("codex", command.executionId);
          if (managed) {
            runtimeSessions.delete("codex", command.executionId);
            await managed.session.closeAndWait().catch(() => undefined);
          }
          const current =
            await options.repository.getManagedConversationExecution(
              { userId: command.ownerUserId },
              command.executionId
            );
          if (
            current &&
            current.executionGeneration === command.executionGeneration &&
            !["stopped", "failed", "fenced"].includes(current.state)
          ) {
            await options.repository
              .setManagedConversationExecutionState(
                { userId: command.ownerUserId },
                {
                  executionId: current.id,
                  expectedStateVersion: current.stateVersion,
                  executionGeneration: current.executionGeneration,
                  state: isPrompt ? "reconciling" : "failed",
                  lastErrorCode: errorCode(error)
                }
              )
              .catch(() => undefined);
          }
        }
        options.logger.warn(
          {
            event: {
              name: "worker.managed_conversation.command_failed",
              category: "managed_conversation"
            },
            command_kind: command.commandKind,
            error_name: errorCode(error)
          },
          "managed Conversation command failed"
        );
      }
    }
    return { completed, failed };
  };

  const requestProcessing = () => {
    if (stopped) return;
    if (running) {
      runAgain = true;
      return;
    }
    running = true;
    drainPromise = (async () => {
      do {
        runAgain = false;
        const processed = await processOnce();
        if (processed.completed + processed.failed > 0) runAgain = true;
      } while (!stopped && runAgain);
    })()
      .catch((error) => {
        options.logger.error(
          {
            event: {
              name: "worker.managed_conversation.drain_failed",
              category: "managed_conversation"
            },
            error_name: errorCode(error)
          },
          "managed Conversation command drain failed"
        );
      })
      .finally(() => {
        running = false;
        drainPromise = null;
        if (!stopped && runAgain) requestProcessing();
      });
  };

  const scheduleWakeReconnect = () => {
    if (stopped || wakeReconnectTimer) return;
    const delayMs = Math.min(250 * 2 ** wakeReconnectAttempt, 10_000);
    wakeReconnectAttempt += 1;
    wakeReconnectTimer = setTimeout(() => {
      wakeReconnectTimer = null;
      void connectWakeClient();
    }, delayMs);
    wakeReconnectTimer.unref?.();
  };

  const connectWakeClient = async (): Promise<void> => {
    if (stopped || wakeClient || remoteWakeAbort) return;
    if (options.remoteWake) {
      const controller = new AbortController();
      remoteWakeAbort = controller;
      try {
        const response = await (
          options.remoteWake.fetch ?? globalThis.fetch.bind(globalThis)
        )(
          upstreamApiUrl(
            options.remoteWake.baseUrl,
            "/v1/managed-conversation-runner/wake"
          ),
          {
            method: "GET",
            redirect: "error",
            headers: {
              accept: "text/event-stream",
              authorization: options.remoteWake.authorization
            },
            signal: controller.signal
          }
        );
        if (
          !response.ok ||
          !response.body ||
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("text/event-stream")
        ) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("ManagedConversationWakeUnavailableError");
        }
        wakeReconnectAttempt = 0;
        requestProcessing();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        while (!stopped) {
          const next = await reader.read();
          if (next.done) break;
          buffered += decoder.decode(next.value, { stream: true });
          let boundary = buffered.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffered.slice(0, boundary);
            buffered = buffered.slice(boundary + 2);
            if (
              frame.split("\n").some((line) => line.trim() === "event: wake")
            ) {
              requestProcessing();
            }
            boundary = buffered.indexOf("\n\n");
          }
          if (buffered.length > 64 * 1024) {
            throw new Error("ManagedConversationWakeFrameError");
          }
        }
      } catch (error) {
        if (
          !stopped &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          scheduleWakeReconnect();
        }
      } finally {
        if (remoteWakeAbort === controller) remoteWakeAbort = null;
      }
      return;
    }
    if (!options.commandWakePool) {
      throw new Error("ManagedConversationWakeSourceError");
    }
    try {
      const client = await options.commandWakePool.connect();
      if (stopped) {
        client.release();
        return;
      }
      wakeClient = client;
      await client.query("listen koed_managed_conversation_commands");
      wakeReconnectAttempt = 0;
      client.on("notification", (message) => {
        if (message.channel === "koed_managed_conversation_commands") {
          requestProcessing();
        }
      });
      client.on("error", () => {
        if (wakeClient === client) wakeClient = null;
        client.removeAllListeners();
        client.release();
        scheduleWakeReconnect();
      });
      requestProcessing();
    } catch {
      scheduleWakeReconnect();
    }
  };

  const scheduleSourceWakeReconnect = (): void => {
    if (stopped || sourceWakeReconnectTimer) return;
    const delayMs = Math.min(250 * 2 ** sourceWakeReconnectAttempt, 10_000);
    sourceWakeReconnectAttempt += 1;
    sourceWakeReconnectTimer = setTimeout(() => {
      sourceWakeReconnectTimer = null;
      void connectSourceWakeClient();
    }, delayMs);
    sourceWakeReconnectTimer.unref?.();
  };

  const connectSourceWakeClient = async (): Promise<void> => {
    if (stopped || sourceWakeClient || !options.commandWakePool) return;
    try {
      const client = await options.commandWakePool.connect();
      if (stopped) {
        client.release();
        return;
      }
      sourceWakeClient = client;
      await client.query("listen koed_conversation_source_replication");
      sourceWakeReconnectAttempt = 0;
      client.on("notification", (message) => {
        if (message.channel !== "koed_conversation_source_replication") return;
        let sourceGenerationId: string | null;
        try {
          const payload = JSON.parse(message.payload ?? "{}") as {
            sourceGenerationId?: unknown;
          };
          sourceGenerationId =
            typeof payload.sourceGenerationId === "string"
              ? payload.sourceGenerationId
              : null;
        } catch {
          return;
        }
        startupRecovery = null;
        void ensureStartupRecovery().catch(() => undefined);
        if (sourceGenerationId) {
          void options.repository
            .releaseManagedConversationCommandsForSourceGeneration({
              ownerUserId: options.localOwnerUserId,
              sourceGenerationId,
              targetDeploymentId: options.deploymentId,
              targetDeviceId: options.deviceId
            })
            .then(() => requestProcessing())
            .catch(() => undefined);
        }
      });
      client.on("error", () => {
        if (sourceWakeClient === client) sourceWakeClient = null;
        client.removeAllListeners();
        client.release();
        scheduleSourceWakeReconnect();
      });
    } catch {
      sourceWakeClient = null;
      scheduleSourceWakeReconnect();
    }
  };

  return {
    processOnce,
    start() {
      if (stopped || runnerHeartbeat) return;
      runnerHeartbeat = setInterval(
        () => void renewOwnedRuntimes(),
        commandHeartbeatMs
      );
      runnerHeartbeat.unref?.();
      void ensureStartupRecovery().catch((error) => {
        options.logger.warn(
          {
            event: {
              name: "worker.managed_conversation.startup_recovery_failed",
              category: "managed_conversation"
            },
            error_name: errorCode(error)
          },
          "managed Conversation startup recovery failed"
        );
      });
      void connectWakeClient();
      void connectSourceWakeClient();
      requestProcessing();
    },
    async stop() {
      stopped = true;
      if (wakeReconnectTimer) clearTimeout(wakeReconnectTimer);
      wakeReconnectTimer = null;
      if (sourceWakeReconnectTimer) clearTimeout(sourceWakeReconnectTimer);
      sourceWakeReconnectTimer = null;
      if (wakeClient) {
        const client = wakeClient;
        wakeClient = null;
        client.removeAllListeners();
        await client
          .query("unlisten koed_managed_conversation_commands")
          .catch(() => undefined);
        client.release();
      }
      if (sourceWakeClient) {
        const client = sourceWakeClient;
        sourceWakeClient = null;
        client.removeAllListeners();
        await client
          .query("unlisten koed_conversation_source_replication")
          .catch(() => undefined);
        client.release();
      }
      remoteWakeAbort?.abort();
      remoteWakeAbort = null;
      if (runnerHeartbeat) clearInterval(runnerHeartbeat);
      runnerHeartbeat = null;
      if (runtimeRecoveryTimer) clearTimeout(runtimeRecoveryTimer);
      runtimeRecoveryTimer = null;
      await Promise.all([
        startupRecovery?.catch(() => undefined),
        drainPromise?.catch(() => undefined)
      ]);
      const owned = [...runtimeSessions.entries()];
      await Promise.all(
        owned.map(([, { session }]) =>
          session.closeAndWait().catch(() => undefined)
        )
      );
      await Promise.all(
        owned.map(([executionId, managed]) =>
          options.repository
            .releaseManagedConversationRunner({
              executionId,
              executionGeneration: managed.executionGeneration,
              runnerId
            })
            .catch(() => false)
        )
      );
      runtimeSessions.clear();
    }
  };
};
