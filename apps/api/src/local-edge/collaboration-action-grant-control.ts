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
import {
  deleteCollaborationActionGrantCustody,
  readCollaborationActionGrantCustodyStatus,
  resolveCollaborationActionGrantSecret,
  storeCollaborationActionGrantCustody,
  updateCollaborationActionGrantCustodyStatus
} from "@koed/shared";
import { z } from "zod";

import {
  highRiskActionGrantIntentFromCollaborationIntent,
  highRiskActionGrantRemoteEnvelopeSchema,
  resolveHighRiskActionGrantOperation,
  type HighRiskActionGrantOperation
} from "../high-risk/action-grant-protocol.js";
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
    representation: "memory_events" | "lcm_leaves" | "lcm_rollups";
    allowedRepresentations: Array<
      "memory_events" | "lcm_leaves" | "lcm_rollups"
    >;
  }) => Promise<{ remoteReplicaId: string } | null>;
  resolveSharedMemoryConsentPreview?: (input: {
    logicalMemoryId: string;
    teamId: string;
    workspaceId: string;
    selectedRepresentation: "memory_events" | "lcm_leaves" | "lcm_rollups";
    allowedRepresentations: Array<
      "memory_events" | "lcm_leaves" | "lcm_rollups"
    >;
    previewRevision: number;
    previewHash: string;
  }) => Promise<{ previewId: string } | null>;
}

export interface CollaborationActionGrantControlOptions {
  koedHome: string;
  fetch: typeof fetch;
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

type RemoteStatus = {
  version: 1;
  actionGrant: { id: string };
  state:
    | "pending"
    | "approved"
    | "consumed"
    | "denied"
    | "revoked"
    | "expired"
    | "canceled";
  activationUrl: string | null;
  expiresAt: string;
};

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
  status: RemoteStatus
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

const validatedRemoteStatus = (
  backend: LocalEdgeUpstreamBackend,
  payload: unknown
): RemoteStatus => {
  const parsed = highRiskActionGrantRemoteEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ControlFailure("temporarily_unavailable");
  }
  if (parsed.data.status.activationPath !== null) {
    try {
      const activationUrl = safeUpstreamProxyUrl(
        backend,
        parsed.data.status.activationPath
      );
      if (
        activationUrl.search ||
        activationUrl.hash ||
        activationUrl.toString().includes("hrg_")
      ) {
        throw new Error("invalid activation path");
      }
      return {
        version: 1,
        actionGrant: parsed.data.status.actionGrant,
        state: parsed.data.status.state,
        activationUrl: activationUrl.toString(),
        expiresAt: parsed.data.status.expiresAt
      };
    } catch {
      throw new ControlFailure("temporarily_unavailable");
    }
  }
  return {
    version: 1,
    actionGrant: parsed.data.status.actionGrant,
    state: parsed.data.status.state,
    activationUrl: null,
    expiresAt: parsed.data.status.expiresAt
  };
};

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

const ambiguousUntil = (
  options: Required<
    Pick<
      CollaborationActionGrantControlOptions,
      "now" | "ambiguousResponseWindowMs"
    >
  >
): string =>
  new Date(
    options.now().getTime() + options.ambiguousResponseWindowMs
  ).toISOString();

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

const actionGrantAccess = (
  context: CollaborationActionGrantControlContext,
  referenceId: string
) => ({
  referenceId,
  backendId: context.backend.id,
  deploymentBaseUrl: context.backend.baseUrl,
  deviceCredentialId: context.upstreamDeviceCredentialId ?? "",
  ...(context.localOwnerUserId
    ? { localOwnerUserId: context.localOwnerUserId }
    : {}),
  principalUserId: context.principalUserId
});

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

const persistRemoteStatus = (
  koedHome: string,
  context: CollaborationActionGrantControlContext,
  status: RemoteStatus,
  now: () => Date
): void => {
  if (status.state === "pending") {
    updateCollaborationActionGrantCustodyStatus(
      koedHome,
      {
        ...actionGrantAccess(context, status.actionGrant.id),
        state: "pending",
        activationUrl: status.activationUrl,
        expiresAt: status.expiresAt
      },
      { now }
    );
    return;
  }
  if (status.state === "approved") {
    updateCollaborationActionGrantCustodyStatus(
      koedHome,
      {
        ...actionGrantAccess(context, status.actionGrant.id),
        state: "approved",
        expiresAt: status.expiresAt
      },
      { now }
    );
    return;
  }
  updateCollaborationActionGrantCustodyStatus(
    koedHome,
    {
      ...actionGrantAccess(context, status.actionGrant.id),
      state: status.state,
      expiresAt: status.expiresAt
    },
    { now }
  );
};

const persistAmbiguousWindow = (
  koedHome: string,
  context: CollaborationActionGrantControlContext,
  status: {
    actionGrant: { id: string };
    state: "pending" | "approved";
    activationUrl: string | null;
  },
  now: () => Date,
  ambiguousResponseWindowMs: number
): void => {
  if (status.state === "pending") {
    updateCollaborationActionGrantCustodyStatus(
      koedHome,
      {
        ...actionGrantAccess(context, status.actionGrant.id),
        state: "pending",
        activationUrl: status.activationUrl,
        ambiguousUntil: ambiguousUntil({
          now,
          ambiguousResponseWindowMs
        })
      },
      { now }
    );
    return;
  }
  updateCollaborationActionGrantCustodyStatus(
    koedHome,
    {
      ...actionGrantAccess(context, status.actionGrant.id),
      state: "approved",
      ambiguousUntil: ambiguousUntil({
        now,
        ambiguousResponseWindowMs
      })
    },
    { now }
  );
};

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
                  allowedRepresentations: intent.allowedRepresentations
                })
              : null;
          const consentPreview =
            intent.intent === "collaboration.consent_shared_memory"
              ? await context.resolveSharedMemoryConsentPreview?.({
                  logicalMemoryId: intent.logicalMemoryId,
                  teamId: intent.teamId,
                  workspaceId: intent.workspaceId,
                  selectedRepresentation: intent.selectedRepresentation,
                  allowedRepresentations: intent.allowedRepresentations,
                  previewRevision: intent.previewRevision,
                  previewHash: intent.previewHash
                })
              : null;
          if (
            intent.intent === "collaboration.preview_shared_memory" &&
            !previewTarget
          ) {
            return failure(command, new ControlFailure("permission_denied"));
          }
          if (
            intent.intent === "collaboration.consent_shared_memory" &&
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
          const stored = storeCollaborationActionGrantCustody(
            options.koedHome,
            {
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
            },
            {
              now: options.now,
              randomBytes: options.randomBytes
            }
          );
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
              deleteCollaborationActionGrantCustody(
                options.koedHome,
                stored.referenceId
              );
              return failure(command, mapPermanentFailure(remote.status));
            }
            const status = validatedRemoteStatus(
              context.backend,
              remote.payload
            );
            if (status.actionGrant.id !== stored.referenceId) {
              deleteCollaborationActionGrantCustody(
                options.koedHome,
                stored.referenceId
              );
              return failure(
                command,
                new ControlFailure("temporarily_unavailable")
              );
            }
            persistRemoteStatus(options.koedHome, context, status, options.now);
            return success(command, status);
          } catch (error) {
            updateCollaborationActionGrantCustodyStatus(
              options.koedHome,
              {
                ...actionGrantAccess(context, stored.referenceId),
                state: "pending",
                activationUrl: null,
                ambiguousUntil: ambiguousUntil(options)
              },
              { now: options.now }
            );
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
          const status = readCollaborationActionGrantCustodyStatus(
            options.koedHome,
            actionGrantAccess(context, command.input.actionGrant.id),
            { now: options.now }
          );
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
                deleteCollaborationActionGrantCustody(
                  options.koedHome,
                  status.actionGrant.id
                );
              }
              return failure(command, mapPermanentFailure(remote.status));
            }
            const next = validatedRemoteStatus(context.backend, remote.payload);
            if (next.actionGrant.id !== status.actionGrant.id) {
              persistAmbiguousWindow(
                options.koedHome,
                context,
                {
                  actionGrant: status.actionGrant,
                  state: status.state === "pending" ? "pending" : "approved",
                  activationUrl: status.activationUrl
                },
                options.now,
                options.ambiguousResponseWindowMs
              );
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
            persistRemoteStatus(options.koedHome, context, next, options.now);
            return success(command, next);
          } catch (error) {
            persistAmbiguousWindow(
              options.koedHome,
              context,
              {
                actionGrant: status.actionGrant,
                state: status.state === "pending" ? "pending" : "approved",
                activationUrl: status.activationUrl
              },
              options.now,
              options.ambiguousResponseWindowMs
            );
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
          const status = readCollaborationActionGrantCustodyStatus(
            options.koedHome,
            actionGrantAccess(context, command.input.actionGrant.id),
            { now: options.now }
          );
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
            deleteCollaborationActionGrantCustody(
              options.koedHome,
              status.actionGrant.id
            );
            return success(command, {
              version: 1,
              actionGrant: status.actionGrant,
              state: "canceled",
              activationUrl: null,
              expiresAt: status.expiresAt
            });
          } catch (error) {
            persistAmbiguousWindow(
              options.koedHome,
              context,
              {
                actionGrant: status.actionGrant,
                state: status.state === "pending" ? "pending" : "approved",
                activationUrl: status.activationUrl
              },
              options.now,
              options.ambiguousResponseWindowMs
            );
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
      resolveCollaborationActionGrantSecret(
        options.koedHome,
        {
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
        },
        { now: options.now }
      )
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
