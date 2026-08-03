import { createHash } from "node:crypto";
import type {
  ClaimedManagedConversationCommand,
  DevelopmentWorkspaceSnapshotChunkRecord,
  DevelopmentWorkspaceSnapshotRecord,
  ManagedConversationExecutionRecord,
  ManagedConversationForkRecord,
  ManagedConversationForkTargetMaterial,
  ManagedConversationHandoffRecord,
  ManagedConversationHandoffTargetMaterial,
  MemorySourceRepository
} from "@koed/db";
import {
  fetchBoundedJsonObject,
  upstreamApiUrl,
  type EnvelopeEncryptionProvider,
  type RecipientPublicKeyMaterial
} from "@koed/shared";

const requestTimeoutMs = 60_000;
const ordinaryResponseBytes = 4 * 1024 * 1024;

export type ManagedConversationAuthorityRepository = Pick<
  MemorySourceRepository,
  | "claimManagedConversationCommands"
  | "reconcileAbandonedManagedConversationCommands"
  | "renewManagedConversationCommandLease"
  | "renewManagedConversationExecutionLease"
  | "acquireManagedConversationExecutionLease"
  | "releaseManagedConversationRunner"
  | "bindManagedConversationRuntime"
  | "bindManagedConversationSourceGeneration"
  | "setManagedConversationExecutionState"
  | "completeManagedConversationCommand"
  | "failManagedConversationCommand"
  | "blockManagedConversationCommand"
  | "releaseManagedConversationCommandsForSourceGeneration"
  | "isManagedConversationSourceGenerationReady"
  | "beginDevelopmentWorkspaceSnapshot"
  | "putDevelopmentWorkspaceSnapshotChunk"
  | "finalizeDevelopmentWorkspaceSnapshot"
  | "getDevelopmentWorkspaceSnapshot"
  | "getDevelopmentWorkspaceSnapshotChunk"
  | "getManagedConversationExecution"
  | "listManagedConversationExecutionsForRunner"
  | "getActiveManagedConversationHandoffForExecution"
  | "getLatestManagedConversationHandoffForExecution"
  | "getManagedConversationHandoffTargetMaterial"
  | "prepareManagedConversationHandoff"
  | "attestManagedConversationHandoffSource"
  | "verifyManagedConversationHandoffTarget"
  | "commitManagedConversationHandoff"
  | "beginManagedConversationHandoffRestore"
  | "renewManagedConversationHandoffRestoreLease"
  | "completeManagedConversationHandoffRestore"
  | "getActiveManagedConversationForkForParent"
  | "prepareManagedConversationForkSource"
  | "attestManagedConversationForkSource"
  | "getManagedConversationForkTargetMaterial"
  | "prepareManagedConversationForkChild"
  | "completeManagedConversationFork"
  | "failManagedConversationFork"
> & {
  createManagedConversationSourceDownloadAuthorization(input: {
    transferKind: "handoff" | "fork";
    transferId: string;
    targetDeploymentId: string;
    sourceGenerationId: string;
    firstSegmentIndex: number;
    recipientKey: RecipientPublicKeyMaterial;
  }): Promise<{
    authorizationId: string;
    capability: string;
    sourceGenerationId: string;
    firstSegmentIndex: number;
    lastSegmentIndex: number;
    expiresAt: string;
    registration: Record<string, unknown>;
    source: Record<string, unknown>;
    sourceClosure: Record<string, unknown> | null;
  }>;
};

class ManagedConversationAuthorityError extends Error {
  readonly transient: boolean;
  readonly code: string | null;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name =
      status === 401 || status === 403
        ? "ManagedConversationAuthorityAuthorizationError"
        : status === 409
          ? "ManagedConversationAuthorityConflictError"
          : status === 429
            ? "ManagedConversationAuthorityRateLimitError"
            : status >= 500
              ? "ManagedConversationAuthorityUnavailableError"
              : "ManagedConversationAuthorityRequestError";
    this.transient = status === 429 || status >= 500;
    this.code =
      typeof code === "string" && /^[a-z][a-z0-9_]{0,119}$/.test(code)
        ? code
        : null;
  }
}

const object = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedConversationAuthorityError(
      502,
      `Managed authority returned an invalid ${name}`
    );
  }
  return value as Record<string, unknown>;
};

const boolean = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") {
    throw new ManagedConversationAuthorityError(
      502,
      `Managed authority returned an invalid ${name}`
    );
  }
  return value;
};

const string = (value: unknown, name: string): string => {
  if (typeof value !== "string") {
    throw new ManagedConversationAuthorityError(
      502,
      `Managed authority returned an invalid ${name}`
    );
  }
  return value;
};

const nullableRecord = <T>(value: unknown, name: string): T | null =>
  value === null ? null : (object(value, name) as T);

export const createManagedConversationAuthorityClient = (options: {
  baseUrl: string;
  authorization: string;
  envelopeEncryptionProvider: EnvelopeEncryptionProvider;
  fetch?: typeof fetch;
}): ManagedConversationAuthorityRepository => {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const request = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    maxBytes = ordinaryResponseBytes,
    query?: Readonly<Record<string, string>>
  ): Promise<Record<string, unknown>> => {
    const url = upstreamApiUrl(options.baseUrl, path);
    for (const [name, value] of Object.entries(query ?? {})) {
      url.searchParams.set(name, value);
    }
    const { response, payload } = await fetchBoundedJsonObject(
      fetchFn,
      url,
      {
        method,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: options.authorization,
          ...(method === "POST" ? { "content-type": "application/json" } : {})
        },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {})
      },
      {
        timeoutMs: requestTimeoutMs,
        maxBytes,
        readErrorBody: true
      }
    );
    if (!response.ok) {
      const error =
        typeof payload.error === "string"
          ? payload.error
          : `Managed authority returned HTTP ${response.status}`;
      throw new ManagedConversationAuthorityError(
        response.status,
        error,
        typeof payload.code === "string" ? payload.code : undefined
      );
    }
    return payload;
  };

  const snapshotBasePath = (input: {
    operationKind: "handoff" | "fork";
    operationId: string;
  }): string =>
    `/v1/managed-conversation-runner/${
      input.operationKind === "handoff" ? "handoffs" : "forks"
    }/${encodeURIComponent(input.operationId)}/workspace-snapshots`;

  return {
    async listManagedConversationExecutionsForRunner() {
      const payload = await request(
        "GET",
        "/v1/managed-conversation-runner/executions"
      );
      if (!Array.isArray(payload.executions)) {
        throw new ManagedConversationAuthorityError(
          502,
          "Managed authority returned invalid executions"
        );
      }
      return payload.executions.map(
        (entry) =>
          object(
            entry,
            "managed execution"
          ) as unknown as ManagedConversationExecutionRecord
      );
    },

    async reconcileAbandonedManagedConversationCommands() {
      const payload = await request(
        "POST",
        "/v1/managed-conversation-runner/commands/reconcile-abandoned",
        {}
      );
      const reconciled = payload.reconciled;
      if (
        typeof reconciled !== "number" ||
        !Number.isSafeInteger(reconciled) ||
        reconciled < 0
      ) {
        throw new ManagedConversationAuthorityError(
          502,
          "Managed authority returned an invalid reconciliation count"
        );
      }
      return reconciled;
    },

    async beginDevelopmentWorkspaceSnapshot(_actor, input) {
      const payload = await request("POST", snapshotBasePath(input), {
        id: input.id,
        executionId: input.executionId,
        sourceGenerationId: input.sourceGenerationId,
        sourceDeploymentId: input.sourceDeploymentId,
        sourceDeviceId: input.sourceDeviceId
      });
      return object(
        payload.snapshot,
        "development workspace snapshot"
      ) as unknown as DevelopmentWorkspaceSnapshotRecord;
    },

    async putDevelopmentWorkspaceSnapshotChunk(actor, input) {
      const plaintext = Buffer.from(
        await options.envelopeEncryptionProvider.decrypt(
          input.encryptionEnvelope
        )
      );
      if (
        plaintext.byteLength !== input.plaintextByteCount ||
        createHash("sha256").update(plaintext).digest("hex") !==
          input.plaintextDigest
      ) {
        throw new ManagedConversationAuthorityError(
          409,
          "Local workspace snapshot chunk is invalid"
        );
      }
      const payload = await request(
        "POST",
        `${snapshotBasePath(input)}/${encodeURIComponent(
          input.snapshotId
        )}/chunks/${input.chunkIndex}`,
        {
          chunkCount: input.chunkCount,
          plaintextDigest: input.plaintextDigest,
          plaintextByteCount: input.plaintextByteCount,
          bytesBase64: plaintext.toString("base64")
        },
        1024 * 1024
      );
      const result = object(payload.result, "workspace snapshot chunk result");
      return {
        stored: result.stored === true,
        replayed: result.replayed === true
      };
    },

    async finalizeDevelopmentWorkspaceSnapshot(_actor, input) {
      const payload = await request(
        "POST",
        `${snapshotBasePath(input)}/${encodeURIComponent(
          input.snapshotId
        )}/finalize`,
        {
          manifestDigest: input.manifestDigest,
          sourceStateDigest: input.sourceStateDigest,
          packageDigest: input.packageDigest,
          packageByteCount: input.packageByteCount,
          chunkCount: input.chunkCount,
          readinessEvidence: input.readinessEvidence
        }
      );
      return object(
        payload.snapshot,
        "development workspace snapshot"
      ) as unknown as DevelopmentWorkspaceSnapshotRecord;
    },

    async getDevelopmentWorkspaceSnapshot(_actor, input) {
      const payload = await request(
        "GET",
        `${snapshotBasePath(input)}/${encodeURIComponent(input.snapshotId)}`
      );
      return nullableRecord<DevelopmentWorkspaceSnapshotRecord>(
        payload.snapshot,
        "development workspace snapshot"
      );
    },

    async getDevelopmentWorkspaceSnapshotChunk(actor, input) {
      const payload = await request(
        "GET",
        `${snapshotBasePath(input)}/${encodeURIComponent(
          input.snapshotId
        )}/chunks/${input.chunkIndex}`,
        undefined,
        2 * 1024 * 1024
      );
      if (payload.chunk === null) return null;
      const remote = object(payload.chunk, "development workspace chunk");
      const bytesBase64 = string(
        remote.bytesBase64,
        "workspace snapshot chunk bytes"
      );
      const bytes = Buffer.from(bytesBase64, "base64");
      const plaintextDigest = string(
        remote.plaintextDigest,
        "workspace snapshot chunk digest"
      );
      const chunkCount = Number(remote.chunkCount);
      if (
        bytes.toString("base64") !== bytesBase64 ||
        Number(remote.chunkIndex) !== input.chunkIndex ||
        !Number.isSafeInteger(chunkCount) ||
        Number(remote.plaintextByteCount) !== bytes.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== plaintextDigest
      ) {
        throw new ManagedConversationAuthorityError(
          502,
          "Managed authority returned an invalid workspace snapshot chunk"
        );
      }
      const envelope = await options.envelopeEncryptionProvider.encrypt({
        plaintext: bytes,
        scope: {
          tenantId: actor.userId,
          objectClass: "development_workspace_snapshot_chunk"
        },
        provenance: {
          rowFamily: "development_workspace_snapshot_chunks",
          sourceId: `${input.snapshotId}:${input.chunkIndex}`
        },
        ciphertextLocation:
          "development_workspace_snapshot_chunks.encryption_envelope",
        aad: {
          ownerUserId: actor.userId,
          operationId: input.operationId,
          snapshotId: input.snapshotId,
          chunkIndex: input.chunkIndex,
          chunkCount,
          plaintextDigest
        }
      });
      const ciphertext = Buffer.from(envelope.ciphertext, "base64");
      return {
        snapshotId: input.snapshotId,
        ownerUserId: actor.userId,
        chunkIndex: input.chunkIndex,
        chunkCount,
        plaintextDigest,
        plaintextByteCount: bytes.byteLength,
        ciphertextDigest: createHash("sha256").update(ciphertext).digest("hex"),
        encryptedByteCount: ciphertext.byteLength,
        encryptionEnvelope: envelope,
        createdAt: string(
          remote.createdAt,
          "workspace snapshot chunk creation time"
        )
      } satisfies DevelopmentWorkspaceSnapshotChunkRecord;
    },

    async createManagedConversationSourceDownloadAuthorization(input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/${input.transferKind === "handoff" ? "handoffs" : "forks"}/${encodeURIComponent(input.transferId)}/source-download-authorization`,
        {
          targetDeploymentId: input.targetDeploymentId,
          sourceGenerationId: input.sourceGenerationId,
          firstSegmentIndex: input.firstSegmentIndex,
          recipientKey: input.recipientKey
        }
      );
      const authorizationId = string(
        payload.authorizationId,
        "source download authorization id"
      );
      const capability = string(
        payload.capability,
        "source download capability"
      );
      const sourceGenerationId = string(
        payload.sourceGenerationId,
        "source download generation"
      );
      const firstSegmentIndex = Number(payload.firstSegmentIndex);
      const lastSegmentIndex = Number(payload.lastSegmentIndex);
      const expiresAt = string(
        payload.expiresAt,
        "source download authorization expiry"
      );
      if (
        !authorizationId ||
        !/^csd_[A-Za-z0-9_-]{43}$/.test(capability) ||
        !sourceGenerationId ||
        !Number.isSafeInteger(firstSegmentIndex) ||
        firstSegmentIndex < 0 ||
        !Number.isSafeInteger(lastSegmentIndex) ||
        lastSegmentIndex < firstSegmentIndex - 1 ||
        Number.isNaN(Date.parse(expiresAt))
      ) {
        throw new ManagedConversationAuthorityError(
          502,
          "Managed authority returned invalid source authorization"
        );
      }
      return {
        authorizationId,
        capability,
        sourceGenerationId,
        firstSegmentIndex,
        lastSegmentIndex,
        expiresAt,
        registration: object(payload.registration, "source registration"),
        source: object(payload.source, "source descriptor"),
        sourceClosure:
          payload.sourceClosure === null
            ? null
            : object(payload.sourceClosure, "source closure")
      };
    },

    async claimManagedConversationCommands(input) {
      const payload = await request(
        "POST",
        "/v1/managed-conversation-runner/commands/claim",
        {
          runnerId: input.runnerId,
          limit: input.limit,
          leaseMs: input.leaseMs
        }
      );
      if (!Array.isArray(payload.commands)) {
        throw new ManagedConversationAuthorityError(
          502,
          "Managed authority returned invalid commands"
        );
      }
      return payload.commands.map(
        (entry) =>
          object(
            entry,
            "managed command"
          ) as unknown as ClaimedManagedConversationCommand
      );
    },

    async renewManagedConversationCommandLease(input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/commands/${encodeURIComponent(
          input.commandId
        )}/lease`,
        {
          leaseToken: input.leaseToken,
          runnerId: input.runnerId,
          executionId: input.executionId,
          leaseMs: input.leaseMs
        }
      );
      return boolean(payload.renewed, "command lease result");
    },

    async renewManagedConversationExecutionLease(input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/executions/${encodeURIComponent(
          input.executionId
        )}/lease`,
        {
          executionGeneration: input.executionGeneration,
          runnerId: input.runnerId,
          leaseMs: input.leaseMs
        }
      );
      return boolean(payload.renewed, "execution lease result");
    },

    async acquireManagedConversationExecutionLease(input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/executions/${encodeURIComponent(
          input.executionId
        )}/acquire`,
        {
          executionGeneration: input.executionGeneration,
          runnerId: input.runnerId,
          leaseMs: input.leaseMs
        }
      );
      return boolean(payload.acquired, "execution lease acquisition result");
    },

    async releaseManagedConversationRunner(input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/executions/${encodeURIComponent(
          input.executionId
        )}/release`,
        {
          executionGeneration: input.executionGeneration,
          runnerId: input.runnerId
        }
      );
      return boolean(payload.released, "execution release result");
    },

    async bindManagedConversationRuntime(_actor, input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/executions/${encodeURIComponent(
          input.executionId
        )}/runtime`,
        {
          expectedStateVersion: input.expectedStateVersion,
          executionGeneration: input.executionGeneration,
          runnerId: input.runnerId,
          logicalSessionId: input.logicalSessionId,
          providerThreadId: input.providerThreadId,
          ...(input.providerCliVersion
            ? { providerCliVersion: input.providerCliVersion }
            : {}),
          ...(input.sourceGenerationId
            ? { sourceGenerationId: input.sourceGenerationId }
            : {})
        }
      );
      return object(
        payload.execution,
        "managed execution"
      ) as unknown as ManagedConversationExecutionRecord;
    },

    async bindManagedConversationSourceGeneration(_actor, input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/executions/${encodeURIComponent(
          input.executionId
        )}/source-generation`,
        {
          executionGeneration: input.executionGeneration,
          runnerId: input.runnerId,
          ...(input.expectedSourceGenerationId
            ? {
                expectedSourceGenerationId: input.expectedSourceGenerationId
              }
            : {}),
          sourceGenerationId: input.sourceGenerationId
        }
      );
      return object(
        payload.execution,
        "managed execution"
      ) as unknown as ManagedConversationExecutionRecord;
    },

    async setManagedConversationExecutionState(_actor, input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/executions/${encodeURIComponent(
          input.executionId
        )}/state`,
        {
          expectedStateVersion: input.expectedStateVersion,
          executionGeneration: input.executionGeneration,
          state: input.state,
          ...(input.lastErrorCode ? { lastErrorCode: input.lastErrorCode } : {})
        }
      );
      return object(
        payload.execution,
        "managed execution"
      ) as unknown as ManagedConversationExecutionRecord;
    },

    async completeManagedConversationCommand(input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/commands/${encodeURIComponent(
          input.commandId
        )}/complete`,
        {
          leaseToken: input.leaseToken,
          ...(input.result ? { result: input.result } : {})
        }
      );
      return boolean(payload.completed, "command completion result");
    },

    async failManagedConversationCommand(input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/commands/${encodeURIComponent(
          input.commandId
        )}/fail`,
        {
          leaseToken: input.leaseToken,
          state: input.state,
          errorCode: input.errorCode
        }
      );
      return {
        updated: boolean(payload.updated, "command failure result"),
        reconciled: boolean(payload.reconciled, "command reconciliation result")
      };
    },

    async blockManagedConversationCommand(input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/commands/${encodeURIComponent(
          input.commandId
        )}/block-on-source`,
        {
          leaseToken: input.leaseToken,
          sourceGenerationId: input.sourceGenerationId,
          readiness: input.readiness ?? "finalized",
          errorCode: input.errorCode
        }
      );
      return boolean(payload.blocked, "command source dependency result");
    },

    async releaseManagedConversationCommandsForSourceGeneration(input) {
      const payload = await request(
        "POST",
        "/v1/managed-conversation-runner/source-replicas/release",
        {
          sourceGenerationId: input.sourceGenerationId,
          readiness: input.readiness ?? "finalized"
        }
      );
      const released = payload.released;
      if (
        typeof released !== "number" ||
        !Number.isSafeInteger(released) ||
        released < 0
      ) {
        throw new ManagedConversationAuthorityError(
          502,
          "Managed authority returned invalid released command count"
        );
      }
      return released;
    },

    async isManagedConversationSourceGenerationReady(input) {
      const payload = await request(
        "GET",
        `/v1/managed-conversation-runner/source-replicas/${encodeURIComponent(
          input.sourceGenerationId
        )}/status`,
        undefined,
        ordinaryResponseBytes,
        { readiness: input.readiness ?? "finalized" }
      );
      return boolean(payload.ready, "managed source readiness result");
    },

    async getManagedConversationExecution(_actor, executionId) {
      const payload = await request(
        "GET",
        `/v1/managed-conversation-runner/executions/${encodeURIComponent(
          executionId
        )}`
      );
      return object(
        payload.execution,
        "managed execution"
      ) as unknown as ManagedConversationExecutionRecord;
    },

    async getActiveManagedConversationHandoffForExecution(_actor, executionId) {
      const payload = await request(
        "GET",
        `/v1/managed-conversation-runner/handoffs/active/${encodeURIComponent(
          executionId
        )}`
      );
      return nullableRecord<ManagedConversationHandoffRecord>(
        payload.handoff,
        "managed handoff"
      );
    },

    async getLatestManagedConversationHandoffForExecution(_actor, executionId) {
      const payload = await request(
        "GET",
        `/v1/managed-conversation-runner/handoffs/latest/${encodeURIComponent(
          executionId
        )}`
      );
      return nullableRecord<ManagedConversationHandoffRecord>(
        payload.handoff,
        "managed handoff"
      );
    },

    async prepareManagedConversationHandoff(_actor, input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/handoffs/${encodeURIComponent(
          input.handoffId
        )}/prepare`,
        {
          expectedStateVersion: input.expectedStateVersion,
          runnerId: input.runnerId,
          providerArtifactRelativePath: input.providerArtifactRelativePath,
          logicalSourceId: input.logicalSourceId,
          sourceGenerationId: input.sourceGenerationId,
          sourceClosureHash: input.sourceClosureHash,
          sourceEndByteCursor: input.sourceEndByteCursor,
          sourceEndItemCursor: input.sourceEndItemCursor,
          workspaceSnapshotId: input.workspaceSnapshotId
        }
      );
      return {
        handoff: object(
          payload.handoff,
          "managed handoff"
        ) as unknown as ManagedConversationHandoffRecord,
        manifest: object(payload.manifest, "managed handoff manifest") as never,
        sourceOriginKeyId: String(payload.sourceOriginKeyId)
      };
    },

    async attestManagedConversationHandoffSource(_actor, input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/handoffs/${encodeURIComponent(
          input.handoffId
        )}/attest`,
        {
          expectedStateVersion: input.expectedStateVersion,
          sourceKeyId: input.sourceKeyId,
          sourceSignature: input.sourceSignature
        }
      );
      return object(
        payload.handoff,
        "managed handoff"
      ) as unknown as ManagedConversationHandoffRecord;
    },

    async getManagedConversationHandoffTargetMaterial(_actor, input) {
      const payload = await request(
        "GET",
        `/v1/managed-conversation-runner/handoffs/${encodeURIComponent(
          input.handoffId
        )}/target-material`,
        undefined
      );
      return nullableRecord<ManagedConversationHandoffTargetMaterial>(
        payload.material,
        "managed handoff target material"
      );
    },

    async verifyManagedConversationHandoffTarget(_actor, input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/handoffs/${encodeURIComponent(
          input.handoffId
        )}/verify`,
        {
          expectedStateVersion: input.expectedStateVersion,
          evidence: input.evidence
        }
      );
      return object(
        payload.handoff,
        "managed handoff"
      ) as unknown as ManagedConversationHandoffRecord;
    },

    async commitManagedConversationHandoff(_actor, input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/handoffs/${encodeURIComponent(
          input.handoffId
        )}/commit`,
        { expectedStateVersion: input.expectedStateVersion }
      );
      return object(
        payload.handoff,
        "managed handoff"
      ) as unknown as ManagedConversationHandoffRecord;
    },

    async beginManagedConversationHandoffRestore(_actor, input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/handoffs/${encodeURIComponent(
          input.handoffId
        )}/restore`,
        {
          expectedStateVersion: input.expectedStateVersion,
          runnerId: input.runnerId,
          leaseMs: input.leaseMs
        }
      );
      return object(
        payload.handoff,
        "managed handoff"
      ) as unknown as ManagedConversationHandoffRecord;
    },

    async renewManagedConversationHandoffRestoreLease(input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/handoffs/${encodeURIComponent(
          input.handoffId
        )}/restore-lease`,
        {
          expectedStateVersion: input.expectedStateVersion,
          runnerId: input.runnerId,
          leaseMs: input.leaseMs
        }
      );
      return boolean(payload.renewed, "handoff restore lease result");
    },

    async completeManagedConversationHandoffRestore(_actor, input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/handoffs/${encodeURIComponent(
          input.handoffId
        )}/complete`,
        {
          expectedStateVersion: input.expectedStateVersion,
          runnerId: input.runnerId,
          logicalSessionId: input.logicalSessionId,
          providerThreadId: input.providerThreadId,
          providerCliVersion: input.providerCliVersion,
          sourceGenerationId: input.sourceGenerationId
        }
      );
      return object(
        payload.handoff,
        "managed handoff"
      ) as unknown as ManagedConversationHandoffRecord;
    },

    async getActiveManagedConversationForkForParent(_actor, executionId) {
      const payload = await request(
        "GET",
        `/v1/managed-conversation-runner/forks/active/${encodeURIComponent(
          executionId
        )}`
      );
      return nullableRecord<ManagedConversationForkRecord>(
        payload.fork,
        "managed fork"
      );
    },

    async prepareManagedConversationForkSource(_actor, input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/forks/${encodeURIComponent(
          input.forkId
        )}/prepare-source`,
        {
          expectedStateVersion: input.expectedStateVersion,
          runnerId: input.runnerId,
          providerArtifactRelativePath: input.providerArtifactRelativePath,
          logicalSourceId: input.logicalSourceId,
          sourceGenerationId: input.sourceGenerationId,
          sourceClosureHash: input.sourceClosureHash,
          sourceEndByteCursor: input.sourceEndByteCursor,
          sourceEndItemCursor: input.sourceEndItemCursor,
          workspaceSnapshotId: input.workspaceSnapshotId,
          parentLogicalSessionId: input.parentLogicalSessionId
        }
      );
      return {
        fork: object(
          payload.fork,
          "managed fork"
        ) as unknown as ManagedConversationForkRecord,
        manifest: object(payload.manifest, "managed fork manifest") as never,
        sourceOriginKeyId: String(payload.sourceOriginKeyId)
      };
    },

    async attestManagedConversationForkSource(_actor, input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/forks/${encodeURIComponent(
          input.forkId
        )}/attest`,
        {
          expectedStateVersion: input.expectedStateVersion,
          sourceKeyId: input.sourceKeyId,
          sourceSignature: input.sourceSignature
        }
      );
      return object(
        payload.fork,
        "managed fork"
      ) as unknown as ManagedConversationForkRecord;
    },

    async getManagedConversationForkTargetMaterial(_actor, input) {
      const payload = await request(
        "GET",
        `/v1/managed-conversation-runner/forks/${encodeURIComponent(
          input.forkId
        )}/target-material`,
        undefined
      );
      return nullableRecord<ManagedConversationForkTargetMaterial>(
        payload.material,
        "managed fork target material"
      );
    },

    async prepareManagedConversationForkChild(_actor, input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/forks/${encodeURIComponent(
          input.forkId
        )}/prepare-child`,
        { expectedStateVersion: input.expectedStateVersion }
      );
      return {
        fork: object(
          payload.fork,
          "managed fork"
        ) as unknown as ManagedConversationForkRecord,
        childExecution: object(
          payload.childExecution,
          "managed child execution"
        ) as unknown as ManagedConversationExecutionRecord
      };
    },

    async completeManagedConversationFork(_actor, input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/forks/${encodeURIComponent(
          input.forkId
        )}/complete`,
        {
          expectedStateVersion: input.expectedStateVersion,
          childExecutionId: input.childExecutionId,
          childLogicalSessionId: input.childLogicalSessionId,
          childLogicalSourceId: input.childLogicalSourceId,
          childProviderThreadId: input.childProviderThreadId
        }
      );
      return object(
        payload.fork,
        "managed fork"
      ) as unknown as ManagedConversationForkRecord;
    },

    async failManagedConversationFork(_actor, input) {
      const payload = await request(
        "POST",
        `/v1/managed-conversation-runner/forks/${encodeURIComponent(
          input.forkId
        )}/fail`,
        {
          expectedStateVersion: input.expectedStateVersion,
          state: input.state,
          failureCode: input.failureCode
        }
      );
      return object(
        payload.fork,
        "managed fork"
      ) as unknown as ManagedConversationForkRecord;
    }
  };
};

const localManagedConversationMethods = new Set<PropertyKey>([
  "upsertManagedConversationRuntimeBinding",
  "bindManagedConversationLocalRuntime",
  "getManagedConversationRuntimeBinding",
  "clearManagedConversationRuntimeBinding",
  "createCapturedSession",
  "getCapturedSession",
  "listLcmGraphThreads"
]);

export const combineManagedConversationRepositories = (
  local: MemorySourceRepository,
  authority: ManagedConversationAuthorityRepository,
  localOwnerUserId: string
): MemorySourceRepository =>
  new Proxy(local, {
    get(target, property) {
      const source = localManagedConversationMethods.has(property)
        ? target
        : (authority as unknown as Record<PropertyKey, unknown>);
      const sourceRecord = source as Record<PropertyKey, unknown>;
      const value: unknown = sourceRecord[property];
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (!localManagedConversationMethods.has(property)) {
        return (...args: unknown[]) => Reflect.apply(method, source, args);
      }
      return (...args: unknown[]) => {
        const [actor, ...rest] = args;
        if (
          actor &&
          typeof actor === "object" &&
          !Array.isArray(actor) &&
          "userId" in actor
        ) {
          return Reflect.apply(method, source, [
            { userId: localOwnerUserId },
            ...rest
          ]);
        }
        return Reflect.apply(method, source, args);
      };
    }
  });
