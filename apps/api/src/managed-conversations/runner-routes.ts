import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createRecipientPublicKeyEnvelopeEncryptionProvider,
  MANAGED_CONVERSATION_TARGET_READINESS_PROTOCOL,
  type RecipientPublicKeyMaterial
} from "@koed/shared";

import type { ApiRouteContext } from "../server/context.js";
import { resolveConversationSourceDownloadMaterial } from "../source-replication/download-material.js";
import { sourceReplicationRecipientKeySchema } from "../source-replication/schemas.js";

const uuid = z.uuid();
const boundedRunnerId = z.string().trim().min(1).max(160);
const leaseMs = z.number().int().safe().min(5_000).max(300_000);

const claimSchema = z
  .object({
    runnerId: boundedRunnerId,
    limit: z.number().int().safe().min(1).max(32).default(8),
    leaseMs
  })
  .strict();

const commandParamsSchema = z.object({ commandId: uuid }).strict();
const executionParamsSchema = z.object({ executionId: uuid }).strict();
const handoffParamsSchema = z.object({ handoffId: uuid }).strict();
const forkParamsSchema = z.object({ forkId: uuid }).strict();
const handoffSnapshotParamsSchema = handoffParamsSchema
  .extend({ snapshotId: uuid })
  .strict();
const forkSnapshotParamsSchema = forkParamsSchema
  .extend({ snapshotId: uuid })
  .strict();
const handoffSnapshotChunkParamsSchema = handoffSnapshotParamsSchema
  .extend({
    chunkIndex: z.coerce.number().int().safe().nonnegative().max(255)
  })
  .strict();
const forkSnapshotChunkParamsSchema = forkSnapshotParamsSchema
  .extend({
    chunkIndex: z.coerce.number().int().safe().nonnegative().max(255)
  })
  .strict();

const commandLeaseSchema = z
  .object({
    leaseToken: uuid,
    runnerId: boundedRunnerId,
    executionId: uuid,
    leaseMs
  })
  .strict();

const executionLeaseSchema = z
  .object({
    executionGeneration: z.number().int().safe().positive(),
    runnerId: boundedRunnerId,
    leaseMs
  })
  .strict();

const releaseExecutionSchema = z
  .object({
    executionGeneration: z.number().int().safe().positive(),
    runnerId: boundedRunnerId
  })
  .strict();

const completeCommandSchema = z
  .object({
    leaseToken: uuid,
    result: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

const failCommandSchema = z
  .object({
    leaseToken: uuid,
    state: z.enum(["queued", "indeterminate", "failed"]),
    errorCode: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/)
  })
  .strict();

const blockCommandSchema = z
  .object({
    leaseToken: uuid,
    sourceGenerationId: uuid,
    readiness: z.enum(["finalized", "registered"]).default("finalized"),
    errorCode: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/)
  })
  .strict();

const releaseSourceDependencySchema = z
  .object({
    sourceGenerationId: uuid,
    readiness: z.enum(["finalized", "registered"]).default("finalized")
  })
  .strict();

const sourceGenerationParamsSchema = z
  .object({
    sourceGenerationId: uuid
  })
  .strict();
const sourceGenerationStatusQuerySchema = z
  .object({
    readiness: z.enum(["finalized", "registered"]).default("finalized")
  })
  .strict();

const runtimeBindingReadySchema = z
  .object({
    executionGeneration: z.number().int().safe().positive()
  })
  .strict();

const transferSourceAuthorizationSchema = z
  .object({
    targetDeploymentId: uuid,
    sourceGenerationId: uuid,
    firstSegmentIndex: z.number().int().safe().nonnegative().default(0),
    recipientKey: sourceReplicationRecipientKeySchema
  })
  .strict();

const bindRuntimeSchema = z
  .object({
    expectedStateVersion: z.number().int().safe().positive(),
    executionGeneration: z.number().int().safe().positive(),
    runnerId: boundedRunnerId,
    logicalSessionId: uuid,
    providerThreadId: z.string().trim().min(1).max(2_048),
    providerCliVersion: z.string().trim().min(1).max(255).optional(),
    sourceGenerationId: uuid.optional()
  })
  .strict();

const bindSourceGenerationSchema = z
  .object({
    executionGeneration: z.number().int().safe().positive(),
    runnerId: boundedRunnerId,
    expectedSourceGenerationId: uuid.optional(),
    sourceGenerationId: uuid
  })
  .strict();

const executionStateSchema = z
  .object({
    expectedStateVersion: z.number().int().safe().positive(),
    executionGeneration: z.number().int().safe().positive(),
    state: z.enum([
      "starting",
      "running",
      "reconciling",
      "quiesce_requested",
      "quiesced",
      "stopping",
      "stopped",
      "failed",
      "fenced"
    ]),
    lastErrorCode: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/)
      .optional()
  })
  .strict();

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const beginWorkspaceSnapshotSchema = z
  .object({
    id: uuid,
    executionId: uuid,
    sourceGenerationId: uuid,
    sourceDeploymentId: uuid,
    sourceDeviceId: uuid
  })
  .strict();
const workspaceSnapshotChunkSchema = z
  .object({
    chunkCount: z.number().int().safe().min(1).max(256),
    plaintextDigest: digest,
    plaintextByteCount: z
      .number()
      .int()
      .safe()
      .min(1)
      .max(1024 * 1024),
    bytesBase64: z.string().min(4).max(1_398_104)
  })
  .strict();
const finalizeWorkspaceSnapshotSchema = z
  .object({
    manifestDigest: digest,
    sourceStateDigest: digest,
    packageDigest: digest,
    packageByteCount: z
      .number()
      .int()
      .safe()
      .positive()
      .max(256 * 1024 * 1024),
    chunkCount: z.number().int().safe().min(1).max(256),
    readinessEvidence: z.record(z.string(), z.unknown())
  })
  .strict();

const prepareHandoffSchema = z
  .object({
    expectedStateVersion: z.number().int().safe().positive(),
    runnerId: boundedRunnerId,
    providerArtifactRelativePath: z.string().trim().min(1).max(4_096),
    logicalSourceId: uuid,
    sourceGenerationId: uuid,
    sourceClosureHash: digest,
    sourceEndByteCursor: z.number().int().safe().nonnegative(),
    sourceEndItemCursor: z.number().int().safe().nonnegative(),
    workspaceSnapshotId: uuid
  })
  .strict();

const attestSchema = z
  .object({
    expectedStateVersion: z.number().int().safe().positive(),
    sourceKeyId: z.string().trim().min(1).max(255),
    sourceSignature: z.string().trim().min(1).max(4_096)
  })
  .strict();

const readinessProofSchema = z
  .object({
    status: z.literal("verified"),
    evidenceDigest: digest,
    checkedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true })
  })
  .strict();
const targetReadinessEvidenceSchema = z
  .object({
    protocol: z.literal(MANAGED_CONVERSATION_TARGET_READINESS_PROTOCOL),
    operationId: uuid,
    executionId: uuid,
    snapshotId: uuid,
    sourceGenerationId: uuid,
    targetDeploymentId: uuid,
    targetDeviceId: uuid,
    dimensions: z
      .object({
        snapshotIntegrity: readinessProofSchema,
        objectClosure: readinessProofSchema,
        filesystemFidelity: readinessProofSchema,
        environmentAvailability: readinessProofSchema,
        providerCompatibility: readinessProofSchema,
        executionBoundary: readinessProofSchema
      })
      .strict()
  })
  .strict();
const verifyHandoffSchema = z
  .object({
    expectedStateVersion: z.number().int().safe().positive(),
    evidence: targetReadinessEvidenceSchema
  })
  .strict();

const versionSchema = z
  .object({ expectedStateVersion: z.number().int().safe().positive() })
  .strict();

const beginRestoreSchema = z
  .object({
    expectedStateVersion: z.number().int().safe().positive(),
    runnerId: boundedRunnerId,
    leaseMs
  })
  .strict();

const restoreLeaseSchema = beginRestoreSchema;

const completeRestoreSchema = z
  .object({
    expectedStateVersion: z.number().int().safe().positive(),
    runnerId: boundedRunnerId,
    logicalSessionId: uuid,
    providerThreadId: z.string().trim().min(1).max(2_048),
    providerCliVersion: z.string().trim().min(1).max(255),
    sourceGenerationId: uuid
  })
  .strict();

const prepareForkSourceSchema = prepareHandoffSchema
  .omit({})
  .extend({ parentLogicalSessionId: uuid })
  .strict();

const prepareForkChildSchema = versionSchema;

const completeForkSchema = z
  .object({
    expectedStateVersion: z.number().int().safe().positive(),
    childExecutionId: uuid,
    childLogicalSessionId: uuid,
    childLogicalSourceId: uuid,
    childProviderThreadId: z.string().trim().min(1).max(2_048)
  })
  .strict();

const failForkSchema = z
  .object({
    expectedStateVersion: z.number().int().safe().positive(),
    state: z.enum(["indeterminate", "failed"]),
    failureCode: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/)
  })
  .strict();

type RunnerAuth = {
  userId: string;
  credentialId: string;
  deviceId: string;
  deploymentId: string;
  operationFamilies: readonly string[];
};

const protocolDeploymentId = (
  metadata: Record<string, unknown>
): string | null => {
  const value = metadata.protocolDeploymentId;
  return typeof value === "string" && uuid.safeParse(value).success
    ? value
    : null;
};

const authenticateRunner = async (
  request: FastifyRequest,
  context: ApiRouteContext
): Promise<RunnerAuth> => {
  const auth = await context.auth.authenticateDeviceCredential(request);
  if (!auth.credential.operationFamilies.includes("managed_execution")) {
    throw Object.assign(
      new Error("Device credential is not allowed for managed execution"),
      { statusCode: 403 }
    );
  }
  const deploymentId = protocolDeploymentId(auth.credential.metadata);
  if (!deploymentId) {
    throw Object.assign(
      new Error("Device credential has no verified deployment identity"),
      { statusCode: 409 }
    );
  }
  return {
    userId: auth.user.id,
    credentialId: auth.credential.id,
    deviceId: auth.credential.deviceInstanceId,
    deploymentId,
    operationFamilies: auth.credential.operationFamilies
  };
};

const requireSyncRunner = (auth: RunnerAuth): void => {
  if (!auth.operationFamilies.includes("sync")) {
    throw Object.assign(
      new Error("Device credential is not allowed for source replication"),
      { statusCode: 403 }
    );
  }
};

const createTransferSourceAuthorization = async (
  context: ApiRouteContext,
  auth: RunnerAuth,
  input: {
    sourceGenerationId: string;
    targetDeploymentId: string;
    firstSegmentIndex: number;
    recipientKey: RecipientPublicKeyMaterial;
    initiatingOperation: {
      kind: "handoff" | "fork";
      id: string;
    };
  }
) => {
  requireSyncRunner(auth);
  if (input.targetDeploymentId !== auth.deploymentId) {
    throw Object.assign(
      new Error("Source download target deployment does not match the runner"),
      { statusCode: 403 }
    );
  }
  createRecipientPublicKeyEnvelopeEncryptionProvider(input.recipientKey);
  const repository = context.requireRepository();
  const { artifact, registration, source, sourceClosure } =
    await resolveConversationSourceDownloadMaterial({
      repository,
      ownerUserId: auth.userId,
      sourceGenerationId: input.sourceGenerationId,
      sourceComponentId: "main",
      allowedReplicaRoles: new Set([
        "origin_local",
        "peer_personal",
        "hosted_personal"
      ])
    });
  const capability = `csd_${randomBytes(32).toString("base64url")}`;
  const authorization =
    await repository.createConversationSourceDownloadAuthorization(
      { userId: auth.userId },
      {
        deviceCredentialId: auth.credentialId,
        artifactId: artifact.id,
        recipientKey: {
          targetDeploymentId: input.targetDeploymentId,
          key: input.recipientKey
        },
        initiatingOperation: input.initiatingOperation,
        capabilityHash: sha256(capability),
        firstSegmentIndex: input.firstSegmentIndex,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString()
      }
    );
  return {
    authorizationId: authorization.id,
    capability,
    sourceGenerationId: input.sourceGenerationId,
    firstSegmentIndex: authorization.firstSegmentIndex,
    lastSegmentIndex: authorization.lastSegmentIndex,
    expiresAt: authorization.expiresAt,
    registration,
    source,
    sourceClosure
  };
};

const requireTransferSourceGeneration = async (
  context: ApiRouteContext,
  ownerUserId: string,
  input: {
    currentSourceGenerationId: string;
    currentClosureHash: string;
    requestedSourceGenerationId: string;
  }
): Promise<void> => {
  const repository = context.requireRepository();
  const actor = { userId: ownerUserId };
  let sourceGenerationId = input.currentSourceGenerationId;
  let expectedClosureHash = input.currentClosureHash;
  let logicalSourceId: string | null = null;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(sourceGenerationId) || seen.size >= 1_024) {
      throw Object.assign(
        new Error("Managed transfer source lineage is invalid"),
        { statusCode: 409 }
      );
    }
    seen.add(sourceGenerationId);
    const artifact = await repository.getConversationSourceArtifactByGeneration(
      actor,
      sourceGenerationId
    );
    if (
      !artifact ||
      artifact.lifecycle !== "finalized" ||
      artifact.closureHash !== expectedClosureHash ||
      (logicalSourceId !== null && artifact.logicalSourceId !== logicalSourceId)
    ) {
      throw Object.assign(
        new Error("Managed transfer source lineage is invalid"),
        { statusCode: 409 }
      );
    }
    logicalSourceId ??= artifact.logicalSourceId;
    if (sourceGenerationId === input.requestedSourceGenerationId) return;
    const prior = artifact.priorGenerationClosure;
    if (
      !prior ||
      typeof prior.sourceGenerationId !== "string" ||
      typeof prior.contentDigest !== "string"
    ) {
      throw Object.assign(
        new Error(
          "Requested source generation is outside the transfer lineage"
        ),
        { statusCode: 403 }
      );
    }
    sourceGenerationId = prior.sourceGenerationId;
    expectedClosureHash = prior.contentDigest;
  }
};

const requireExecutionForRunner = async (
  context: ApiRouteContext,
  auth: RunnerAuth,
  executionId: string
) => {
  const execution = await context
    .requireRepository()
    .getManagedConversationExecution({ userId: auth.userId }, executionId);
  if (
    !execution ||
    execution.runnerDeviceId !== auth.deviceId ||
    execution.runnerDeploymentId !== auth.deploymentId
  ) {
    throw Object.assign(new Error("Managed execution is not assigned here"), {
      statusCode: 403
    });
  }
  return execution;
};

const requireCommandForRunner = async (
  context: ApiRouteContext,
  auth: RunnerAuth,
  commandId: string
) => {
  const repository = context.requireRepository();
  const command = await repository.getManagedConversationCommand(
    { userId: auth.userId },
    commandId
  );
  if (!command) {
    throw Object.assign(new Error("Managed command not found"), {
      statusCode: 404
    });
  }
  const execution = await repository.getManagedConversationExecution(
    { userId: auth.userId },
    command.executionId
  );
  const assignedDeviceId =
    command.targetDeviceId ?? execution?.runnerDeviceId ?? null;
  const assignedDeploymentId =
    command.targetDeploymentId ?? execution?.runnerDeploymentId ?? null;
  if (
    !execution ||
    assignedDeviceId !== auth.deviceId ||
    assignedDeploymentId !== auth.deploymentId
  ) {
    throw Object.assign(new Error("Managed command is not assigned here"), {
      statusCode: 403
    });
  }
  return { command, execution };
};

const requireHandoffForRunner = async (
  context: ApiRouteContext,
  auth: RunnerAuth,
  handoffId: string,
  role: "source" | "target"
) => {
  const handoff = await context
    .requireRepository()
    .getManagedConversationHandoff({ userId: auth.userId }, handoffId);
  const deploymentId =
    role === "source"
      ? handoff?.sourceDeploymentId
      : handoff?.targetDeploymentId;
  const deviceId =
    role === "source" ? handoff?.sourceDeviceId : handoff?.targetDeviceId;
  if (
    !handoff ||
    deploymentId !== auth.deploymentId ||
    deviceId !== auth.deviceId
  ) {
    throw Object.assign(new Error("Managed handoff is not assigned here"), {
      statusCode: 403
    });
  }
  return handoff;
};

const requireHandoffForEitherRunner = async (
  context: ApiRouteContext,
  auth: RunnerAuth,
  handoffId: string
) => {
  const handoff = await context
    .requireRepository()
    .getManagedConversationHandoff({ userId: auth.userId }, handoffId);
  const isSource =
    handoff?.sourceDeploymentId === auth.deploymentId &&
    handoff.sourceDeviceId === auth.deviceId;
  const isTarget =
    handoff?.targetDeploymentId === auth.deploymentId &&
    handoff.targetDeviceId === auth.deviceId;
  if (!handoff || (!isSource && !isTarget)) {
    throw Object.assign(new Error("Managed handoff is not assigned here"), {
      statusCode: 403
    });
  }
  return {
    handoff,
    role: isSource ? ("source" as const) : ("target" as const)
  };
};

const requireForkForRunner = async (
  context: ApiRouteContext,
  auth: RunnerAuth,
  forkId: string,
  role: "source" | "target"
) => {
  const fork = await context
    .requireRepository()
    .getManagedConversationFork({ userId: auth.userId }, forkId);
  const deploymentId =
    role === "source" ? fork?.sourceDeploymentId : fork?.targetDeploymentId;
  const deviceId =
    role === "source" ? fork?.sourceDeviceId : fork?.targetDeviceId;
  if (
    !fork ||
    deploymentId !== auth.deploymentId ||
    deviceId !== auth.deviceId
  ) {
    throw Object.assign(new Error("Managed fork is not assigned here"), {
      statusCode: 403
    });
  }
  return fork;
};

const requireForkForEitherRunner = async (
  context: ApiRouteContext,
  auth: RunnerAuth,
  forkId: string
) => {
  const fork = await context
    .requireRepository()
    .getManagedConversationFork({ userId: auth.userId }, forkId);
  const isSource =
    fork?.sourceDeploymentId === auth.deploymentId &&
    fork.sourceDeviceId === auth.deviceId;
  const isTarget =
    fork?.targetDeploymentId === auth.deploymentId &&
    fork.targetDeviceId === auth.deviceId;
  if (!fork || (!isSource && !isTarget)) {
    throw Object.assign(new Error("Managed fork is not assigned here"), {
      statusCode: 403
    });
  }
  return { fork, role: isSource ? ("source" as const) : ("target" as const) };
};

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const strictBase64 = (value: string): Buffer => {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw Object.assign(
      new Error("Workspace snapshot chunk encoding is invalid"),
      {
        statusCode: 400
      }
    );
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw Object.assign(
      new Error("Workspace snapshot chunk encoding is invalid"),
      {
        statusCode: 400
      }
    );
  }
  return bytes;
};

const requireSnapshotSource = async (
  context: ApiRouteContext,
  auth: RunnerAuth,
  input: {
    executionId: string;
    sourceGenerationId: string;
    sourceDeploymentId: string;
    sourceDeviceId: string;
  }
): Promise<void> => {
  const execution = await context
    .requireRepository()
    .getManagedConversationExecution(
      { userId: auth.userId },
      input.executionId
    );
  if (
    !execution ||
    execution.sourceGenerationId !== input.sourceGenerationId ||
    input.sourceDeploymentId !== auth.deploymentId ||
    input.sourceDeviceId !== auth.deviceId
  ) {
    throw Object.assign(
      new Error("Workspace snapshot source identity is invalid"),
      { statusCode: 409 }
    );
  }
};

const putSnapshotChunk = async (
  context: ApiRouteContext,
  auth: RunnerAuth,
  input: {
    operationKind: "handoff" | "fork";
    operationId: string;
    snapshotId: string;
    chunkIndex: number;
    chunk: z.infer<typeof workspaceSnapshotChunkSchema>;
  }
) => {
  const bytes = strictBase64(input.chunk.bytesBase64);
  if (
    bytes.byteLength !== input.chunk.plaintextByteCount ||
    sha256(bytes) !== input.chunk.plaintextDigest
  ) {
    throw Object.assign(
      new Error("Workspace snapshot chunk digest is invalid"),
      {
        statusCode: 409
      }
    );
  }
  const provider = context.encryption.envelopeEncryptionProvider;
  if (!provider) {
    throw Object.assign(new Error("Workspace encryption is unavailable"), {
      statusCode: 503
    });
  }
  const envelope = await provider.encrypt({
    plaintext: bytes,
    scope: {
      tenantId: auth.userId,
      objectClass: "development_workspace_snapshot_chunk"
    },
    provenance: {
      rowFamily: "development_workspace_snapshot_chunks",
      sourceId: `${input.snapshotId}:${input.chunkIndex}`
    },
    ciphertextLocation:
      "development_workspace_snapshot_chunks.encryption_envelope",
    aad: {
      ownerUserId: auth.userId,
      operationId: input.operationId,
      snapshotId: input.snapshotId,
      chunkIndex: input.chunkIndex,
      chunkCount: input.chunk.chunkCount,
      plaintextDigest: input.chunk.plaintextDigest
    }
  });
  const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
  return context.requireRepository().putDevelopmentWorkspaceSnapshotChunk(
    { userId: auth.userId },
    {
      snapshotId: input.snapshotId,
      operationKind: input.operationKind,
      operationId: input.operationId,
      chunkIndex: input.chunkIndex,
      chunkCount: input.chunk.chunkCount,
      plaintextDigest: input.chunk.plaintextDigest,
      plaintextByteCount: bytes.byteLength,
      ciphertextDigest: sha256(ciphertext),
      encryptedByteCount: ciphertext.byteLength,
      encryptionEnvelope: envelope
    }
  );
};

const downloadSnapshotChunk = async (
  context: ApiRouteContext,
  auth: RunnerAuth,
  input: {
    operationKind: "handoff" | "fork";
    operationId: string;
    snapshotId: string;
    chunkIndex: number;
  }
) => {
  const chunk = await context
    .requireRepository()
    .getDevelopmentWorkspaceSnapshotChunk({ userId: auth.userId }, input);
  if (!chunk) return null;
  const provider = context.encryption.envelopeEncryptionProvider;
  if (!provider) {
    throw Object.assign(new Error("Workspace encryption is unavailable"), {
      statusCode: 503
    });
  }
  const bytes = Buffer.from(await provider.decrypt(chunk.encryptionEnvelope));
  if (
    bytes.byteLength !== chunk.plaintextByteCount ||
    sha256(bytes) !== chunk.plaintextDigest
  ) {
    throw Object.assign(new Error("Workspace snapshot chunk is corrupted"), {
      statusCode: 500
    });
  }
  return {
    chunkIndex: chunk.chunkIndex,
    chunkCount: chunk.chunkCount,
    plaintextDigest: chunk.plaintextDigest,
    plaintextByteCount: chunk.plaintextByteCount,
    bytesBase64: bytes.toString("base64"),
    createdAt: chunk.createdAt
  };
};

export const registerManagedConversationRunnerRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.get(
    "/v1/managed-conversation-runner/executions",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const executions = await context
        .requireRepository()
        .listManagedConversationExecutionsForRunner({
          ownerUserId: auth.userId,
          deploymentId: auth.deploymentId,
          deviceId: auth.deviceId,
          limit: 500
        });
      return { executions };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/commands/claim",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const input = claimSchema.parse(request.body);
      const commands = await context
        .requireRepository()
        .claimManagedConversationCommands({
          ownerUserId: auth.userId,
          runnerId: input.runnerId,
          deviceId: auth.deviceId,
          deploymentId: auth.deploymentId,
          limit: input.limit,
          leaseMs: input.leaseMs
        });
      return { commands };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/commands/reconcile-abandoned",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      if (
        request.body !== undefined &&
        (typeof request.body !== "object" ||
          request.body === null ||
          Array.isArray(request.body) ||
          Object.keys(request.body).length > 0)
      ) {
        throw Object.assign(
          new Error("Reconciliation request body must be empty"),
          { statusCode: 400 }
        );
      }
      return {
        reconciled: await context
          .requireRepository()
          .reconcileAbandonedManagedConversationCommands({
            ownerUserId: auth.userId,
            deviceId: auth.deviceId,
            deploymentId: auth.deploymentId,
            limit: 32
          })
      };
    }
  );

  app.get(
    "/v1/managed-conversation-runner/handoffs/active/:executionId",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { executionId } = executionParamsSchema.parse(request.params);
      const handoff = await context
        .requireRepository()
        .getActiveManagedConversationHandoffForExecution(
          { userId: auth.userId },
          executionId
        );
      if (
        handoff &&
        handoff.sourceDeviceId !== auth.deviceId &&
        handoff.targetDeviceId !== auth.deviceId
      ) {
        throw Object.assign(new Error("Managed handoff is not assigned here"), {
          statusCode: 403
        });
      }
      return { handoff };
    }
  );

  app.get(
    "/v1/managed-conversation-runner/handoffs/latest/:executionId",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { executionId } = executionParamsSchema.parse(request.params);
      const handoff = await context
        .requireRepository()
        .getLatestManagedConversationHandoffForExecution(
          { userId: auth.userId },
          executionId
        );
      if (
        handoff &&
        handoff.sourceDeviceId !== auth.deviceId &&
        handoff.targetDeviceId !== auth.deviceId
      ) {
        throw Object.assign(new Error("Managed handoff is not assigned here"), {
          statusCode: 403
        });
      }
      return { handoff };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/handoffs/:handoffId/workspace-snapshots",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { handoffId } = handoffParamsSchema.parse(request.params);
      const input = beginWorkspaceSnapshotSchema.parse(request.body);
      const handoff = await requireHandoffForRunner(
        context,
        auth,
        handoffId,
        "source"
      );
      if (input.executionId !== handoff.executionId) {
        throw Object.assign(
          new Error("Workspace snapshot execution is invalid"),
          { statusCode: 409 }
        );
      }
      await requireSnapshotSource(context, auth, input);
      return {
        snapshot: await context
          .requireRepository()
          .beginDevelopmentWorkspaceSnapshot(
            { userId: auth.userId },
            {
              ...input,
              operationKind: "handoff",
              operationId: handoff.id
            }
          )
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/handoffs/:handoffId/workspace-snapshots/:snapshotId/chunks/:chunkIndex",
    {
      bodyLimit: 2 * 1024 * 1024,
      preHandler: context.rateLimit.memoryWrite
    },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { handoffId, snapshotId, chunkIndex } =
        handoffSnapshotChunkParamsSchema.parse(request.params);
      const handoff = await requireHandoffForRunner(
        context,
        auth,
        handoffId,
        "source"
      );
      return {
        result: await putSnapshotChunk(context, auth, {
          operationKind: "handoff",
          operationId: handoff.id,
          snapshotId,
          chunkIndex,
          chunk: workspaceSnapshotChunkSchema.parse(request.body)
        })
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/handoffs/:handoffId/workspace-snapshots/:snapshotId/finalize",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { handoffId, snapshotId } = handoffSnapshotParamsSchema.parse(
        request.params
      );
      const handoff = await requireHandoffForRunner(
        context,
        auth,
        handoffId,
        "source"
      );
      const input = finalizeWorkspaceSnapshotSchema.parse(request.body);
      return {
        snapshot: await context
          .requireRepository()
          .finalizeDevelopmentWorkspaceSnapshot(
            { userId: auth.userId },
            {
              snapshotId,
              operationKind: "handoff",
              operationId: handoff.id,
              ...input
            }
          )
      };
    }
  );

  app.get(
    "/v1/managed-conversation-runner/handoffs/:handoffId/workspace-snapshots/:snapshotId",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { handoffId, snapshotId } = handoffSnapshotParamsSchema.parse(
        request.params
      );
      const { handoff, role } = await requireHandoffForEitherRunner(
        context,
        auth,
        handoffId
      );
      if (role === "target" && handoff.workspaceSnapshotId !== snapshotId) {
        throw Object.assign(
          new Error("Workspace snapshot is not assigned here"),
          {
            statusCode: 403
          }
        );
      }
      return {
        snapshot: await context
          .requireRepository()
          .getDevelopmentWorkspaceSnapshot(
            { userId: auth.userId },
            {
              snapshotId,
              operationKind: "handoff",
              operationId: handoff.id
            }
          )
      };
    }
  );

  app.get(
    "/v1/managed-conversation-runner/handoffs/:handoffId/workspace-snapshots/:snapshotId/chunks/:chunkIndex",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { handoffId, snapshotId, chunkIndex } =
        handoffSnapshotChunkParamsSchema.parse(request.params);
      const handoff = await requireHandoffForRunner(
        context,
        auth,
        handoffId,
        "target"
      );
      if (handoff.workspaceSnapshotId !== snapshotId) {
        throw Object.assign(
          new Error("Workspace snapshot is not assigned here"),
          {
            statusCode: 403
          }
        );
      }
      return {
        chunk: await downloadSnapshotChunk(context, auth, {
          operationKind: "handoff",
          operationId: handoff.id,
          snapshotId,
          chunkIndex
        })
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/handoffs/:handoffId/prepare",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { handoffId } = handoffParamsSchema.parse(request.params);
      const input = prepareHandoffSchema.parse(request.body);
      await requireHandoffForRunner(context, auth, handoffId, "source");
      const prepared = await context
        .requireRepository()
        .prepareManagedConversationHandoff(
          { userId: auth.userId },
          {
            handoffId,
            ...input
          }
        );
      return prepared;
    }
  );

  app.post(
    "/v1/managed-conversation-runner/handoffs/:handoffId/attest",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { handoffId } = handoffParamsSchema.parse(request.params);
      const input = attestSchema.parse(request.body);
      await requireHandoffForRunner(context, auth, handoffId, "source");
      return {
        handoff: await context
          .requireRepository()
          .attestManagedConversationHandoffSource(
            { userId: auth.userId },
            { handoffId, ...input }
          )
      };
    }
  );

  app.get(
    "/v1/managed-conversation-runner/handoffs/:handoffId/target-material",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { handoffId } = handoffParamsSchema.parse(request.params);
      await requireHandoffForRunner(context, auth, handoffId, "target");
      const material = await context
        .requireRepository()
        .getManagedConversationHandoffTargetMaterial(
          { userId: auth.userId },
          { handoffId, targetDeviceId: auth.deviceId }
        );
      return { material };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/handoffs/:handoffId/source-download-authorization",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      requireSyncRunner(auth);
      const { handoffId } = handoffParamsSchema.parse(request.params);
      const input = transferSourceAuthorizationSchema.parse(request.body);
      const handoff = await requireHandoffForRunner(
        context,
        auth,
        handoffId,
        "target"
      );
      if (
        !handoff.sourceGenerationId ||
        !handoff.sourceClosureHash ||
        ![
          "workspace_prepared",
          "target_verified",
          "lease_transferred",
          "restoring",
          "identity_verified",
          "running"
        ].includes(handoff.state)
      ) {
        throw Object.assign(
          new Error("Managed handoff source is not ready for transfer"),
          { statusCode: 409 }
        );
      }
      await requireTransferSourceGeneration(context, auth.userId, {
        currentSourceGenerationId: handoff.sourceGenerationId,
        currentClosureHash: handoff.sourceClosureHash,
        requestedSourceGenerationId: input.sourceGenerationId
      });
      return createTransferSourceAuthorization(context, auth, {
        ...input,
        sourceGenerationId: input.sourceGenerationId,
        initiatingOperation: { kind: "handoff", id: handoffId }
      });
    }
  );

  app.post(
    "/v1/managed-conversation-runner/handoffs/:handoffId/verify",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { handoffId } = handoffParamsSchema.parse(request.params);
      const input = verifyHandoffSchema.parse(request.body);
      await requireHandoffForRunner(context, auth, handoffId, "target");
      return {
        handoff: await context
          .requireRepository()
          .verifyManagedConversationHandoffTarget(
            { userId: auth.userId },
            {
              handoffId,
              ...input,
              targetDeviceId: auth.deviceId
            }
          )
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/handoffs/:handoffId/commit",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { handoffId } = handoffParamsSchema.parse(request.params);
      const input = versionSchema.parse(request.body);
      await requireHandoffForRunner(context, auth, handoffId, "target");
      return {
        handoff: await context
          .requireRepository()
          .commitManagedConversationHandoff(
            { userId: auth.userId },
            { handoffId, ...input }
          )
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/handoffs/:handoffId/restore",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { handoffId } = handoffParamsSchema.parse(request.params);
      const input = beginRestoreSchema.parse(request.body);
      await requireHandoffForRunner(context, auth, handoffId, "target");
      return {
        handoff: await context
          .requireRepository()
          .beginManagedConversationHandoffRestore(
            { userId: auth.userId },
            {
              handoffId,
              ...input,
              targetDeviceId: auth.deviceId
            }
          )
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/handoffs/:handoffId/restore-lease",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { handoffId } = handoffParamsSchema.parse(request.params);
      const input = restoreLeaseSchema.parse(request.body);
      await requireHandoffForRunner(context, auth, handoffId, "target");
      return {
        renewed: await context
          .requireRepository()
          .renewManagedConversationHandoffRestoreLease({
            handoffId,
            ...input,
            targetDeviceId: auth.deviceId
          })
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/handoffs/:handoffId/complete",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { handoffId } = handoffParamsSchema.parse(request.params);
      const input = completeRestoreSchema.parse(request.body);
      await requireHandoffForRunner(context, auth, handoffId, "target");
      return {
        handoff: await context
          .requireRepository()
          .completeManagedConversationHandoffRestore(
            { userId: auth.userId },
            {
              handoffId,
              ...input,
              targetDeviceId: auth.deviceId
            }
          )
      };
    }
  );

  app.get(
    "/v1/managed-conversation-runner/forks/active/:executionId",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { executionId } = executionParamsSchema.parse(request.params);
      const fork = await context
        .requireRepository()
        .getActiveManagedConversationForkForParent(
          { userId: auth.userId },
          executionId
        );
      if (
        fork &&
        fork.sourceDeviceId !== auth.deviceId &&
        fork.targetDeviceId !== auth.deviceId
      ) {
        throw Object.assign(new Error("Managed fork is not assigned here"), {
          statusCode: 403
        });
      }
      return { fork };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/forks/:forkId/workspace-snapshots",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { forkId } = forkParamsSchema.parse(request.params);
      const input = beginWorkspaceSnapshotSchema.parse(request.body);
      const fork = await requireForkForRunner(context, auth, forkId, "source");
      if (input.executionId !== fork.parentExecutionId) {
        throw Object.assign(
          new Error("Workspace snapshot execution is invalid"),
          { statusCode: 409 }
        );
      }
      await requireSnapshotSource(context, auth, input);
      return {
        snapshot: await context
          .requireRepository()
          .beginDevelopmentWorkspaceSnapshot(
            { userId: auth.userId },
            {
              ...input,
              operationKind: "fork",
              operationId: fork.id
            }
          )
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/forks/:forkId/workspace-snapshots/:snapshotId/chunks/:chunkIndex",
    {
      bodyLimit: 2 * 1024 * 1024,
      preHandler: context.rateLimit.memoryWrite
    },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { forkId, snapshotId, chunkIndex } =
        forkSnapshotChunkParamsSchema.parse(request.params);
      const fork = await requireForkForRunner(context, auth, forkId, "source");
      return {
        result: await putSnapshotChunk(context, auth, {
          operationKind: "fork",
          operationId: fork.id,
          snapshotId,
          chunkIndex,
          chunk: workspaceSnapshotChunkSchema.parse(request.body)
        })
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/forks/:forkId/workspace-snapshots/:snapshotId/finalize",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { forkId, snapshotId } = forkSnapshotParamsSchema.parse(
        request.params
      );
      const fork = await requireForkForRunner(context, auth, forkId, "source");
      const input = finalizeWorkspaceSnapshotSchema.parse(request.body);
      return {
        snapshot: await context
          .requireRepository()
          .finalizeDevelopmentWorkspaceSnapshot(
            { userId: auth.userId },
            {
              snapshotId,
              operationKind: "fork",
              operationId: fork.id,
              ...input
            }
          )
      };
    }
  );

  app.get(
    "/v1/managed-conversation-runner/forks/:forkId/workspace-snapshots/:snapshotId",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { forkId, snapshotId } = forkSnapshotParamsSchema.parse(
        request.params
      );
      const { fork, role } = await requireForkForEitherRunner(
        context,
        auth,
        forkId
      );
      if (role === "target" && fork.workspaceSnapshotId !== snapshotId) {
        throw Object.assign(
          new Error("Workspace snapshot is not assigned here"),
          {
            statusCode: 403
          }
        );
      }
      return {
        snapshot: await context
          .requireRepository()
          .getDevelopmentWorkspaceSnapshot(
            { userId: auth.userId },
            {
              snapshotId,
              operationKind: "fork",
              operationId: fork.id
            }
          )
      };
    }
  );

  app.get(
    "/v1/managed-conversation-runner/forks/:forkId/workspace-snapshots/:snapshotId/chunks/:chunkIndex",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { forkId, snapshotId, chunkIndex } =
        forkSnapshotChunkParamsSchema.parse(request.params);
      const fork = await requireForkForRunner(context, auth, forkId, "target");
      if (fork.workspaceSnapshotId !== snapshotId) {
        throw Object.assign(
          new Error("Workspace snapshot is not assigned here"),
          {
            statusCode: 403
          }
        );
      }
      return {
        chunk: await downloadSnapshotChunk(context, auth, {
          operationKind: "fork",
          operationId: fork.id,
          snapshotId,
          chunkIndex
        })
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/forks/:forkId/prepare-source",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { forkId } = forkParamsSchema.parse(request.params);
      const input = prepareForkSourceSchema.parse(request.body);
      await requireForkForRunner(context, auth, forkId, "source");
      const prepared = await context
        .requireRepository()
        .prepareManagedConversationForkSource(
          { userId: auth.userId },
          {
            forkId,
            ...input
          }
        );
      return prepared;
    }
  );

  app.post(
    "/v1/managed-conversation-runner/forks/:forkId/attest",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { forkId } = forkParamsSchema.parse(request.params);
      const input = attestSchema.parse(request.body);
      await requireForkForRunner(context, auth, forkId, "source");
      return {
        fork: await context
          .requireRepository()
          .attestManagedConversationForkSource(
            { userId: auth.userId },
            { forkId, ...input }
          )
      };
    }
  );

  app.get(
    "/v1/managed-conversation-runner/forks/:forkId/target-material",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { forkId } = forkParamsSchema.parse(request.params);
      await requireForkForRunner(context, auth, forkId, "target");
      const material = await context
        .requireRepository()
        .getManagedConversationForkTargetMaterial(
          { userId: auth.userId },
          { forkId, targetDeviceId: auth.deviceId }
        );
      return { material };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/forks/:forkId/source-download-authorization",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      requireSyncRunner(auth);
      const { forkId } = forkParamsSchema.parse(request.params);
      const input = transferSourceAuthorizationSchema.parse(request.body);
      const fork = await requireForkForRunner(context, auth, forkId, "target");
      if (
        fork.state !== "source_attested" ||
        !fork.parentSourceGenerationId ||
        !fork.parentClosureHash
      ) {
        throw Object.assign(
          new Error("Managed fork source is not ready for transfer"),
          { statusCode: 409 }
        );
      }
      await requireTransferSourceGeneration(context, auth.userId, {
        currentSourceGenerationId: fork.parentSourceGenerationId,
        currentClosureHash: fork.parentClosureHash,
        requestedSourceGenerationId: input.sourceGenerationId
      });
      return createTransferSourceAuthorization(context, auth, {
        ...input,
        sourceGenerationId: input.sourceGenerationId,
        initiatingOperation: { kind: "fork", id: forkId }
      });
    }
  );

  app.post(
    "/v1/managed-conversation-runner/forks/:forkId/prepare-child",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { forkId } = forkParamsSchema.parse(request.params);
      const input = prepareForkChildSchema.parse(request.body);
      await requireForkForRunner(context, auth, forkId, "target");
      return await context
        .requireRepository()
        .prepareManagedConversationForkChild(
          { userId: auth.userId },
          { forkId, ...input, targetDeviceId: auth.deviceId }
        );
    }
  );

  app.post(
    "/v1/managed-conversation-runner/forks/:forkId/complete",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { forkId } = forkParamsSchema.parse(request.params);
      const input = completeForkSchema.parse(request.body);
      await requireForkForRunner(context, auth, forkId, "target");
      return {
        fork: await context
          .requireRepository()
          .completeManagedConversationFork(
            { userId: auth.userId },
            { forkId, ...input, targetDeviceId: auth.deviceId }
          )
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/forks/:forkId/fail",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { forkId } = forkParamsSchema.parse(request.params);
      const input = failForkSchema.parse(request.body);
      const fork = await context
        .requireRepository()
        .getManagedConversationFork({ userId: auth.userId }, forkId);
      if (
        !fork ||
        (fork.sourceDeviceId !== auth.deviceId &&
          fork.targetDeviceId !== auth.deviceId)
      ) {
        throw Object.assign(new Error("Managed fork is not assigned here"), {
          statusCode: 403
        });
      }
      return {
        fork: await context
          .requireRepository()
          .failManagedConversationFork(
            { userId: auth.userId },
            { forkId, ...input, deviceId: auth.deviceId }
          )
      };
    }
  );

  app.get(
    "/v1/managed-conversation-runner/executions/:executionId",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { executionId } = executionParamsSchema.parse(request.params);
      return {
        execution: await requireExecutionForRunner(context, auth, executionId)
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/commands/:commandId/lease",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { commandId } = commandParamsSchema.parse(request.params);
      const input = commandLeaseSchema.parse(request.body);
      const { command } = await requireCommandForRunner(
        context,
        auth,
        commandId
      );
      if (command.executionId !== input.executionId) {
        throw Object.assign(new Error("Managed command identity conflicted"), {
          statusCode: 409
        });
      }
      const renewed = await context
        .requireRepository()
        .renewManagedConversationCommandLease({ commandId, ...input });
      return { renewed };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/executions/:executionId/acquire",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { executionId } = executionParamsSchema.parse(request.params);
      const input = executionLeaseSchema.parse(request.body);
      const execution = await requireExecutionForRunner(
        context,
        auth,
        executionId
      );
      if (execution.executionGeneration !== input.executionGeneration) {
        throw Object.assign(
          new Error("Managed execution generation conflicted"),
          { statusCode: 409 }
        );
      }
      return {
        acquired: await context
          .requireRepository()
          .acquireManagedConversationExecutionLease({
            executionId,
            executionGeneration: input.executionGeneration,
            deploymentId: auth.deploymentId,
            deviceId: auth.deviceId,
            runnerId: input.runnerId,
            leaseMs: input.leaseMs
          })
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/executions/:executionId/lease",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { executionId } = executionParamsSchema.parse(request.params);
      const input = executionLeaseSchema.parse(request.body);
      await requireExecutionForRunner(context, auth, executionId);
      const renewed = await context
        .requireRepository()
        .renewManagedConversationExecutionLease({ executionId, ...input });
      return { renewed };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/executions/:executionId/release",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { executionId } = executionParamsSchema.parse(request.params);
      const input = releaseExecutionSchema.parse(request.body);
      await requireExecutionForRunner(context, auth, executionId);
      return {
        released: await context
          .requireRepository()
          .releaseManagedConversationRunner({ executionId, ...input })
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/commands/:commandId/complete",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { commandId } = commandParamsSchema.parse(request.params);
      const input = completeCommandSchema.parse(request.body);
      await requireCommandForRunner(context, auth, commandId);
      const completed = await context
        .requireRepository()
        .completeManagedConversationCommand({ commandId, ...input });
      return { completed };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/commands/:commandId/fail",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { commandId } = commandParamsSchema.parse(request.params);
      const input = failCommandSchema.parse(request.body);
      await requireCommandForRunner(context, auth, commandId);
      return await context
        .requireRepository()
        .failManagedConversationCommand({ commandId, ...input });
    }
  );

  app.post(
    "/v1/managed-conversation-runner/commands/:commandId/block-on-source",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { commandId } = commandParamsSchema.parse(request.params);
      const input = blockCommandSchema.parse(request.body);
      await requireCommandForRunner(context, auth, commandId);
      return {
        blocked: await context
          .requireRepository()
          .blockManagedConversationCommand({ commandId, ...input })
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/source-replicas/release",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const input = releaseSourceDependencySchema.parse(request.body);
      return {
        released: await context
          .requireRepository()
          .releaseManagedConversationCommandsForSourceGeneration({
            ownerUserId: auth.userId,
            sourceGenerationId: input.sourceGenerationId,
            targetDeploymentId: auth.deploymentId,
            targetDeviceId: auth.deviceId,
            readiness: input.readiness
          })
      };
    }
  );

  app.get(
    "/v1/managed-conversation-runner/source-replicas/:sourceGenerationId/status",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { sourceGenerationId } = sourceGenerationParamsSchema.parse(
        request.params
      );
      const query = sourceGenerationStatusQuerySchema.parse(request.query);
      return {
        ready: await context
          .requireRepository()
          .isManagedConversationSourceGenerationReady({
            ownerUserId: auth.userId,
            sourceGenerationId,
            readiness: query.readiness
          })
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/executions/:executionId/runtime-binding-ready",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { executionId } = executionParamsSchema.parse(request.params);
      const input = runtimeBindingReadySchema.parse(request.body);
      const execution = await requireExecutionForRunner(
        context,
        auth,
        executionId
      );
      if (execution.executionGeneration !== input.executionGeneration) {
        throw Object.assign(
          new Error("Managed execution generation changed before readiness"),
          { statusCode: 409 }
        );
      }
      const released = await context
        .requireRepository()
        .releaseManagedConversationStartForRuntimeBinding({
          ownerUserId: auth.userId,
          executionId,
          executionGeneration: input.executionGeneration,
          deploymentId: auth.deploymentId,
          deviceId: auth.deviceId
        });
      if (!released) {
        throw Object.assign(
          new Error("Managed execution is not available for readiness"),
          { statusCode: 409 }
        );
      }
      return { ready: true };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/executions/:executionId/runtime",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { executionId } = executionParamsSchema.parse(request.params);
      const input = bindRuntimeSchema.parse(request.body);
      await requireExecutionForRunner(context, auth, executionId);
      return {
        execution: await context
          .requireRepository()
          .bindManagedConversationRuntime(
            { userId: auth.userId },
            { executionId, ...input }
          )
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/executions/:executionId/source-generation",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { executionId } = executionParamsSchema.parse(request.params);
      const input = bindSourceGenerationSchema.parse(request.body);
      await requireExecutionForRunner(context, auth, executionId);
      return {
        execution: await context
          .requireRepository()
          .bindManagedConversationSourceGeneration(
            { userId: auth.userId },
            { executionId, ...input }
          )
      };
    }
  );

  app.post(
    "/v1/managed-conversation-runner/executions/:executionId/state",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { executionId } = executionParamsSchema.parse(request.params);
      const input = executionStateSchema.parse(request.body);
      await requireExecutionForRunner(context, auth, executionId);
      return {
        execution: await context
          .requireRepository()
          .setManagedConversationExecutionState(
            { userId: auth.userId },
            { executionId, ...input }
          )
      };
    }
  );

  app.get("/v1/managed-conversation-runner/wake", async (request, reply) => {
    await authenticateRunner(request, context);
    const pool = context.managedConversations.commandWakePool;
    if (!pool) {
      throw Object.assign(new Error("Managed runner wake is unavailable"), {
        statusCode: 503
      });
    }
    const client = await pool.connect();
    await client.query("listen koed_managed_conversation_commands");
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    reply.raw.write("event: wake\ndata: {}\n\n");
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      client.removeAllListeners();
      void client
        .query("unlisten koed_managed_conversation_commands")
        .catch(() => undefined)
        .finally(() => client.release());
    };
    client.on("notification", (message) => {
      if (!closed && message.channel === "koed_managed_conversation_commands") {
        reply.raw.write("event: wake\ndata: {}\n\n");
      }
    });
    client.on("error", () => {
      close();
      reply.raw.destroy();
    });
    request.raw.on("close", close);
  });
};
