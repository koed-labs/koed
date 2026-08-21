import { randomBytes, randomUUID } from "node:crypto";

import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationActionGrantIntentSchema,
  collaborationCommandResultSchema,
  collaborationRendererCommandSchema,
  collaborationSafeErrorMessages,
  fetchBoundedJsonObject,
  RemoteRequestTimeoutError,
  type CollaborationActionGrantIntent,
  type CollaborationActionGrantReference,
  type CollaborationCommandResult,
  type CollaborationRendererCommand
} from "@koed/shared";
import { z } from "zod";

import {
  highRiskActionGrantIntentFromCollaborationIntent,
  resolveHighRiskActionGrantOperation,
  type HighRiskActionGrantOperation
} from "../high-risk/action-grant-protocol.js";
import {
  createCollaborationActionGrantLifecycle,
  type ActionGrantRemoteStatus,
  type CollaborationActionGrantLifecycle
} from "./collaboration-action-grant-lifecycle.js";
import {
  safeUpstreamProxyUrl,
  type LocalEdgeUpstreamBackend
} from "./upstream-routing.js";

const RESPONSE_LIMIT_BYTES = 64 * 1_024;
const REQUEST_TIMEOUT_MS = 30_000;
const ACTION_GRANT_TTL_MS = 5 * 60_000;
const AMBIGUOUS_RESPONSE_WINDOW_MS = 30_000;

export const collaborationActionGrantControlCommandNames = [
  "collaboration.request_action_grant",
  "collaboration.await_action_grant",
  "collaboration.confirm_action_grant",
  "collaboration.cancel_action_grant"
] as const;

export type CollaborationActionGrantControlCommandName =
  (typeof collaborationActionGrantControlCommandNames)[number];

export type CollaborationActionGrantControlCommand = Extract<
  CollaborationRendererCommand,
  { command: CollaborationActionGrantControlCommandName }
>;

export interface CollaborationActionGrantIntentOperation extends Omit<
  HighRiskActionGrantOperation,
  "operationFamily"
> {
  operationFamily: "admin" | "share_grant_management" | "managed_execution";
  idempotencyKey: string;
}

export interface CollaborationActionGrantControlContext {
  backend: LocalEdgeUpstreamBackend;
  localOwnerUserId?: string;
  principalUserId: string;
  upstreamDeviceCredentialId: string | null;
  upstreamDeviceAuthorization: string | null;
  operationFamilies: ReadonlySet<
    "action_grant" | "share_grant_management" | "managed_execution"
  >;
  resolveSharedMemoryPreviewTarget?: (input: {
    logicalMemoryId: string;
    teamId: string;
    workspaceId: string;
    representation:
      | "memory_events"
      | "lcm_leaves"
      | "lcm_rollups"
      | "curated_assertions";
    maximumFidelity: "memory_events" | "lcm_leaves" | "lcm_rollups";
    includeCuratedMemory: boolean;
  }) => Promise<{ remoteReplicaId: string } | null>;
  resolveSharedMemoryConsentPreview?: (input: {
    logicalMemoryId: string;
    teamId: string;
    workspaceId: string;
    maximumFidelity: "memory_events" | "lcm_leaves" | "lcm_rollups";
    includeCuratedMemory: boolean;
    previewRevision: number;
    previewHash: string;
  }) => Promise<{ previewId: string } | null>;
}

export interface CollaborationActionGrantControlOptions {
  koedHome: string;
  fetch: typeof fetch;
  actionGrantLifecycle?: CollaborationActionGrantLifecycle;
  now?: () => Date;
  randomBytes?: typeof randomBytes;
  randomUuid?: () => string;
  requestTimeoutMs?: number;
  responseLimitBytes?: number;
  actionGrantTtlMs?: number;
  ambiguousResponseWindowMs?: number;
  random?: () => number;
}

export interface CollaborationActionGrantControl {
  dispatch(
    command: unknown,
    context: CollaborationActionGrantControlContext
  ): Promise<CollaborationCommandResult | null>;
  describeIntent(
    backend: LocalEdgeUpstreamBackend,
    intent: CollaborationActionGrantIntent
  ): CollaborationActionGrantIntentOperation | null;
  resolveSecret(input: {
    reference: CollaborationActionGrantReference;
    intent: CollaborationActionGrantIntent;
    context: CollaborationActionGrantControlContext;
  }): Promise<string | null>;
}

class ControlFailure extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "not_available"
      | "permission_denied"
      | "conflict"
      | "rate_limited"
      | "temporarily_unavailable"
      | "internal_error",
    readonly retryAfterMs: number | null = null
  ) {
    super(code);
  }
}

const safeError = (
  code: ControlFailure["code"],
  retryAfterMs: number | null = null
) => ({
  code,
  userMessage: collaborationSafeErrorMessages[code],
  retryable:
    code === "conflict" ||
    code === "rate_limited" ||
    code === "temporarily_unavailable",
  retryAfterMs
});

const success = (
  command: CollaborationActionGrantControlCommand,
  status: ActionGrantRemoteStatus
): CollaborationCommandResult =>
  collaborationCommandResultSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: command.requestId,
    command: command.command,
    ok: true,
    data: {
      status: {
        version: 1,
        actionGrant: status.actionGrant,
        approvalTier: status.approvalTier,
        review: status.review,
        state: status.state,
        activationUrl: status.activationUrl,
        expiresAt: status.expiresAt
      }
    }
  });

const failure = (
  command: CollaborationActionGrantControlCommand,
  error: ControlFailure
): CollaborationCommandResult =>
  collaborationCommandResultSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: command.requestId,
    command: command.command,
    ok: false,
    error: safeError(error.code, error.retryAfterMs)
  });

const safeAuthorizationHeader = (value: string | null): string | null =>
  value && /^Koed-Device\s+[^:\s]+:[^\s]+$/.test(value) && !/[\r\n]/.test(value)
    ? value
    : null;

const collaborationActionGrantOperationForIntent = (
  backend: LocalEdgeUpstreamBackend,
  intent: CollaborationActionGrantIntent,
  referenceId: string,
  resolved?: {
    sharedMemoryRemoteReplicaId?: string;
    sharedMemoryPreviewId?: string;
  }
): CollaborationActionGrantIntentOperation | null => {
  const remoteIntent = highRiskActionGrantIntentFromCollaborationIntent(
    backend.baseUrl,
    intent,
    resolved
  );
  if (!remoteIntent) {
    return null;
  }
  const operation = resolveHighRiskActionGrantOperation({
    clientRequestId: referenceId,
    intent: remoteIntent
  });
  return operation === null ||
    operation instanceof Promise ||
    operation.operationFamily === "source_download"
    ? null
    : {
        operationFamily: operation.operationFamily,
        action: operation.action,
        teamId: operation.teamId,
        targetId: operation.targetId,
        method: operation.method,
        path: operation.path,
        body: operation.body,
        idempotencyKey: intent.commandRequestId
      };
};

const credentialOperationFamilyForGrant = (
  operationFamily: HighRiskActionGrantOperation["operationFamily"]
): "action_grant" | "share_grant_management" | "managed_execution" =>
  operationFamily === "admin"
    ? "action_grant"
    : operationFamily === "managed_execution"
      ? "managed_execution"
      : "share_grant_management";

const remoteRequest = async (
  options: Required<
    Pick<
      CollaborationActionGrantControlOptions,
      "fetch" | "requestTimeoutMs" | "responseLimitBytes"
    >
  >,
  context: CollaborationActionGrantControlContext,
  input: {
    method: "POST" | "GET" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
    requiredOperationFamily?:
      | "action_grant"
      | "share_grant_management"
      | "managed_execution"
      | undefined;
  }
): Promise<{ status: number; ok: boolean; payload: unknown }> => {
  const authorization = safeAuthorizationHeader(
    context.upstreamDeviceAuthorization
  );
  if (
    !authorization ||
    !context.upstreamDeviceCredentialId ||
    !z.uuid().safeParse(context.upstreamDeviceCredentialId).success ||
    (input.requiredOperationFamily !== undefined &&
      !context.operationFamilies.has(input.requiredOperationFamily))
  ) {
    throw new ControlFailure("permission_denied");
  }
  try {
    const remote = await fetchBoundedJsonObject(
      options.fetch,
      safeUpstreamProxyUrl(context.backend, input.path),
      {
        method: input.method,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization,
          ...(input.body === undefined
            ? {}
            : { "content-type": "application/json" })
        },
        ...(input.body === undefined
          ? {}
          : { body: JSON.stringify(input.body) })
      },
      {
        timeoutMs: options.requestTimeoutMs,
        maxBytes: options.responseLimitBytes,
        readErrorBody: true
      }
    );
    const { response } = remote;
    const payload = response.status === 204 ? null : remote.payload;
    return { status: response.status, ok: response.ok, payload };
  } catch (error) {
    if (error instanceof RemoteRequestTimeoutError) {
      throw new ControlFailure("temporarily_unavailable");
    }
    throw error;
  }
};

const createdExpiry = (
  options: Required<
    Pick<CollaborationActionGrantControlOptions, "now" | "actionGrantTtlMs">
  >
): string =>
  new Date(options.now().getTime() + options.actionGrantTtlMs).toISOString();

const parseCommand = (
  command: unknown
): CollaborationActionGrantControlCommand | null => {
  const parsed = collaborationRendererCommandSchema.safeParse(command);
  if (!parsed.success) return null;
  return collaborationActionGrantControlCommandNames.includes(
    parsed.data.command as CollaborationActionGrantControlCommandName
  )
    ? (parsed.data as CollaborationActionGrantControlCommand)
    : null;
};

const mapPermanentFailure = (status: number): ControlFailure => {
  if (status === 401 || status === 403) {
    return new ControlFailure("permission_denied");
  }
  if (status === 404) {
    return new ControlFailure("not_available");
  }
  if (status === 409) {
    return new ControlFailure("conflict");
  }
  if (status === 429) {
    return new ControlFailure("rate_limited");
  }
  if (status >= 500) {
    return new ControlFailure("temporarily_unavailable");
  }
  return new ControlFailure("internal_error");
};

const decisionResponseMayBeAmbiguous = (status: number): boolean =>
  status >= 500;

const hasDeviceContext = (
  context: CollaborationActionGrantControlContext
): context is CollaborationActionGrantControlContext & {
  upstreamDeviceCredentialId: string;
  upstreamDeviceAuthorization: string;
} =>
  Boolean(
    context.upstreamDeviceCredentialId &&
    z.uuid().safeParse(context.upstreamDeviceCredentialId).success &&
    safeAuthorizationHeader(context.upstreamDeviceAuthorization)
  );

export const createCollaborationActionGrantControl = (
  input: CollaborationActionGrantControlOptions
): CollaborationActionGrantControl => {
  const options = {
    fetch: input.fetch,
    koedHome: input.koedHome,
    now: input.now ?? (() => new Date()),
    randomBytes: input.randomBytes ?? randomBytes,
    randomUuid: input.randomUuid ?? randomUUID,
    requestTimeoutMs: input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    responseLimitBytes: input.responseLimitBytes ?? RESPONSE_LIMIT_BYTES,
    actionGrantTtlMs: input.actionGrantTtlMs ?? ACTION_GRANT_TTL_MS,
    ambiguousResponseWindowMs:
      input.ambiguousResponseWindowMs ?? AMBIGUOUS_RESPONSE_WINDOW_MS,
    random: input.random ?? Math.random
  };
  const lifecycle =
    input.actionGrantLifecycle ??
    createCollaborationActionGrantLifecycle({
      koedHome: options.koedHome,
      now: options.now,
      randomBytes: options.randomBytes,
      ambiguousResponseWindowMs: options.ambiguousResponseWindowMs
    });

  const dispatch = async (
    commandInput: unknown,
    context: CollaborationActionGrantControlContext
  ): Promise<CollaborationCommandResult | null> => {
    const command = parseCommand(commandInput);
    if (!command) return null;
    try {
      switch (command.command) {
        case "collaboration.request_action_grant": {
          const intent = collaborationActionGrantIntentSchema.parse(
            command.input.intent
          );
          const previewTarget =
            intent.intent === "collaboration.preview_shared_memory"
              ? await context.resolveSharedMemoryPreviewTarget?.({
                  logicalMemoryId: intent.logicalMemoryId,
                  teamId: intent.teamId,
                  workspaceId: intent.workspaceId,
                  representation: intent.representation,
                  maximumFidelity: intent.maximumFidelity,
                  includeCuratedMemory: intent.includeCuratedMemory
                })
              : null;
          const consentPreview =
            intent.intent === "collaboration.share_memory" ||
            intent.intent === "collaboration.change_shared_memory_fidelity"
              ? await context.resolveSharedMemoryConsentPreview?.({
                  logicalMemoryId: intent.logicalMemoryId,
                  teamId: intent.teamId,
                  workspaceId: intent.workspaceId,
                  maximumFidelity: intent.maximumFidelity,
                  includeCuratedMemory: intent.includeCuratedMemory,
                  previewRevision: intent.previewRevision,
                  previewHash: intent.previewHash
                })
              : null;
          if (
            intent.intent === "collaboration.preview_shared_memory" &&
            !intent.candidate &&
            !previewTarget
          ) {
            return failure(command, new ControlFailure("permission_denied"));
          }
          if (
            intent.intent === "collaboration.share_memory" &&
            !consentPreview
          ) {
            return failure(command, new ControlFailure("permission_denied"));
          }
          if (
            intent.intent === "collaboration.change_shared_memory_fidelity" &&
            !consentPreview
          ) {
            return failure(command, new ControlFailure("permission_denied"));
          }
          const resolved =
            previewTarget || consentPreview
              ? {
                  sharedMemoryRemoteReplicaId: previewTarget?.remoteReplicaId,
                  sharedMemoryPreviewId: consentPreview?.previewId
                }
              : undefined;
          const remoteIntent = highRiskActionGrantIntentFromCollaborationIntent(
            context.backend.baseUrl,
            intent,
            resolved
          );
          if (!remoteIntent) {
            return failure(command, new ControlFailure("invalid_input"));
          }
          const referenceId = options.randomUuid();
          const operation = collaborationActionGrantOperationForIntent(
            context.backend,
            intent,
            referenceId,
            resolved
          );
          if (!operation) {
            return failure(command, new ControlFailure("invalid_input"));
          }
          if (
            !hasDeviceContext(context) ||
            !context.operationFamilies.has(
              credentialOperationFamilyForGrant(operation.operationFamily)
            )
          ) {
            return failure(command, new ControlFailure("permission_denied"));
          }
          const expiresAt = createdExpiry(options);
          const stored = lifecycle.create({
            referenceId,
            backendId: context.backend.id,
            deploymentBaseUrl: context.backend.baseUrl,
            deviceCredentialId: context.upstreamDeviceCredentialId,
            ...(context.localOwnerUserId
              ? { localOwnerUserId: context.localOwnerUserId }
              : {}),
            principalUserId: context.principalUserId,
            operationFamily: operation.operationFamily,
            action: operation.action,
            teamId: operation.teamId,
            targetId: operation.targetId,
            method: operation.method,
            path: operation.path,
            body: operation.body,
            idempotencyKey: operation.idempotencyKey,
            expiresAt
          });
          try {
            const remote = await remoteRequest(options, context, {
              method: "POST",
              path: "/v1/high-risk/action-grants",
              requiredOperationFamily: credentialOperationFamilyForGrant(
                operation.operationFamily
              ),
              body: {
                version: 1,
                clientRequestId: stored.referenceId,
                grantCommitment: `v1:${stored.commitmentHash}`,
                intent: remoteIntent
              }
            });
            if (!remote.ok) {
              lifecycle.discard({ id: stored.referenceId }, "request_rejected");
              return failure(command, mapPermanentFailure(remote.status));
            }
            const status = lifecycle.acceptRemote(
              context,
              { id: stored.referenceId },
              remote.payload
            );
            if (!status) {
              return failure(
                command,
                new ControlFailure("temporarily_unavailable")
              );
            }
            return success(command, status);
          } catch (error) {
            lifecycle.markAmbiguous(context, { id: stored.referenceId });
            if (error instanceof ControlFailure) {
              return failure(command, error);
            }
            return failure(
              command,
              new ControlFailure("temporarily_unavailable")
            );
          }
        }
        case "collaboration.await_action_grant": {
          if (!hasDeviceContext(context)) {
            return failure(command, new ControlFailure("permission_denied"));
          }
          const status = lifecycle.read(context, command.input.actionGrant);
          if (!status) {
            return failure(command, new ControlFailure("not_available"));
          }
          try {
            const remote = await remoteRequest(options, context, {
              method: "GET",
              path: `/v1/high-risk/action-grants/${encodeURIComponent(status.actionGrant.id)}/await`
            });
            if (!remote.ok) {
              if (
                remote.status === 401 ||
                remote.status === 403 ||
                remote.status === 404
              ) {
                lifecycle.discard(status.actionGrant, "authority_lost");
              }
              return failure(command, mapPermanentFailure(remote.status));
            }
            const next = lifecycle.acceptRemote(
              context,
              status.actionGrant,
              remote.payload
            );
            if (!next) {
              return failure(
                command,
                new ControlFailure("temporarily_unavailable")
              );
            }
            if (next.state === "pending") {
              return failure(
                command,
                new ControlFailure("temporarily_unavailable")
              );
            }
            return success(command, next);
          } catch (error) {
            lifecycle.markAmbiguous(context, status.actionGrant, {
              ...status,
              state:
                status.state === "pending" || status.state === "review_required"
                  ? status.state
                  : "approved"
            });
            return failure(
              command,
              error instanceof ControlFailure
                ? error
                : new ControlFailure("temporarily_unavailable")
            );
          }
        }
        case "collaboration.confirm_action_grant": {
          if (!hasDeviceContext(context)) {
            return failure(command, new ControlFailure("permission_denied"));
          }
          const status = lifecycle.read(context, command.input.actionGrant);
          if (
            !status ||
            status.state !== "review_required" ||
            status.approvalTier !== "native_review"
          ) {
            return failure(command, new ControlFailure("not_available"));
          }
          const path = `/v1/high-risk/action-grants/${encodeURIComponent(
            status.actionGrant.id
          )}`;
          try {
            if (command.input.decision === "cancel") {
              const remote = await remoteRequest(options, context, {
                method: "DELETE",
                path
              });
              if (!remote.ok && remote.status !== 404) {
                return failure(command, mapPermanentFailure(remote.status));
              }
              return success(
                command,
                lifecycle.transitionTerminal(context, status, "canceled")
              );
            }
            const remote = await remoteRequest(options, context, {
              method: "POST",
              path: `${path}/native-decision`,
              body: { decision: "approve" }
            });
            if (!remote.ok) {
              if (decisionResponseMayBeAmbiguous(remote.status)) {
                lifecycle.markAmbiguous(context, status.actionGrant, status);
              }
              return failure(command, mapPermanentFailure(remote.status));
            }
            const next = lifecycle.acceptRemote(
              context,
              status.actionGrant,
              remote.payload
            );
            if (!next) {
              return failure(
                command,
                new ControlFailure("temporarily_unavailable")
              );
            }
            if (
              next.state === "consumed" ||
              next.state === "denied" ||
              next.state === "revoked" ||
              next.state === "expired" ||
              next.state === "canceled"
            ) {
              return success(command, next);
            }
            if (
              next.approvalTier !== "native_review" ||
              next.state !== "approved"
            ) {
              lifecycle.markAmbiguous(context, status.actionGrant, status);
              return failure(
                command,
                new ControlFailure("temporarily_unavailable")
              );
            }
            return success(command, next);
          } catch (error) {
            lifecycle.markAmbiguous(context, status.actionGrant, status);
            return failure(
              command,
              error instanceof ControlFailure
                ? error
                : new ControlFailure("temporarily_unavailable")
            );
          }
        }
        case "collaboration.cancel_action_grant": {
          if (!hasDeviceContext(context)) {
            return failure(command, new ControlFailure("permission_denied"));
          }
          const status = lifecycle.read(context, command.input.actionGrant);
          if (!status) {
            return failure(command, new ControlFailure("not_available"));
          }
          try {
            const remote = await remoteRequest(options, context, {
              method: "DELETE",
              path: `/v1/high-risk/action-grants/${encodeURIComponent(status.actionGrant.id)}`
            });
            if (!remote.ok && remote.status !== 404) {
              return failure(command, mapPermanentFailure(remote.status));
            }
            return success(
              command,
              lifecycle.transitionTerminal(context, status, "canceled")
            );
          } catch (error) {
            lifecycle.markAmbiguous(context, status.actionGrant, {
              ...status,
              state:
                status.state === "pending" || status.state === "review_required"
                  ? status.state
                  : "approved"
            });
            return failure(
              command,
              error instanceof ControlFailure
                ? error
                : new ControlFailure("temporarily_unavailable")
            );
          }
        }
      }
    } catch (error) {
      return failure(
        command,
        error instanceof ControlFailure
          ? error
          : new ControlFailure("internal_error")
      );
    }
  };

  const resolveSecret = (input: {
    reference: CollaborationActionGrantReference;
    intent: CollaborationActionGrantIntent;
    context: CollaborationActionGrantControlContext;
  }): Promise<string | null> => {
    const operation = collaborationActionGrantOperationForIntent(
      input.context.backend,
      input.intent,
      input.reference.id
    );
    const deviceCredentialId = input.context.upstreamDeviceCredentialId;
    if (
      !operation ||
      !deviceCredentialId ||
      !z.uuid().safeParse(deviceCredentialId).success ||
      !input.context.operationFamilies.has(
        credentialOperationFamilyForGrant(operation.operationFamily)
      )
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve(
      lifecycle.resolve({
        referenceId: input.reference.id,
        backendId: input.context.backend.id,
        deploymentBaseUrl: input.context.backend.baseUrl,
        deviceCredentialId,
        ...(input.context.localOwnerUserId
          ? { localOwnerUserId: input.context.localOwnerUserId }
          : {}),
        principalUserId: input.context.principalUserId,
        operationFamily: operation.operationFamily,
        action: operation.action,
        teamId: operation.teamId,
        targetId: operation.targetId,
        method: operation.method,
        path: operation.path,
        body: operation.body,
        idempotencyKey: operation.idempotencyKey
      })
    );
  };

  return {
    dispatch,
    describeIntent: (backend, intent) =>
      collaborationActionGrantOperationForIntent(
        backend,
        intent,
        intent.commandRequestId
      ),
    resolveSecret
  };
};
