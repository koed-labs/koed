import { createHash } from "node:crypto";
import { clip } from "./utils.js";
import type { KoedApiClient } from "./koed-client.js";

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface CaptureRuntimeState {
  externalSessionId: string;
  backendSessionId?: string;
  backendSessionRegistered: boolean;
}

export interface CaptureContext {
  cwd: string;
  model?: {
    provider: string;
    id: string;
  };
}

export const ensureBackendSession = async (
  client: KoedApiClient,
  runtimeState: CaptureRuntimeState,
  ctx: CaptureContext,
  signal?: AbortSignal
): Promise<void> => {
  if (runtimeState.backendSessionRegistered) {
    return;
  }

  const response = await client.createSession(
    {
      externalSessionId: runtimeState.externalSessionId,
      sourceRuntime: "pi",
      captureMethod: "api",
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      cwd: ctx.cwd,
      idempotencyKey: hash({
        externalSessionId: runtimeState.externalSessionId,
        cwd: ctx.cwd
      })
    },
    signal
  );

  runtimeState.backendSessionRegistered = true;
  if (response.session?.id) {
    runtimeState.backendSessionId = response.session.id;
  }
};

export const captureMessageEvent = async (
  client: KoedApiClient,
  runtimeState: CaptureRuntimeState,
  input: {
    actor: "user" | "assistant";
    eventType: string;
    content: string;
    metadata?: Record<string, unknown>;
  },
  ctx: CaptureContext,
  signal?: AbortSignal
): Promise<void> => {
  await ensureBackendSession(client, runtimeState, ctx, signal);

  const idempotencyKey = hash({
    externalSessionId: runtimeState.externalSessionId,
    actor: input.actor,
    eventType: input.eventType,
    content: input.content,
    metadata: input.metadata
  });

  await client.capturePersonalEvent(
    {
      workspaceId: ctx.cwd,
      sessionId: runtimeState.backendSessionId,
      actor: input.actor,
      eventType: input.eventType,
      content: clip(input.content),
      metadata: {
        ...input.metadata,
        externalSessionId: runtimeState.externalSessionId,
        automaticCaptureScope: "personal",
        sourceHash: idempotencyKey
      },
      sourceRuntime: "pi",
      captureMethod: "api",
      idempotencyKey,
      sourceHash: idempotencyKey
    },
    signal
  );
};

export const captureToolEvent = async (
  client: KoedApiClient,
  runtimeState: CaptureRuntimeState,
  input: {
    toolName: string;
    content: string;
    isError: boolean;
  },
  ctx: CaptureContext,
  signal?: AbortSignal
): Promise<void> => {
  if (input.toolName.startsWith("memory_")) {
    return;
  }

  await ensureBackendSession(client, runtimeState, ctx, signal);

  const idempotencyKey = hash({
    externalSessionId: runtimeState.externalSessionId,
    toolName: input.toolName,
    content: input.content,
    isError: input.isError
  });

  await client.capturePersonalEvent(
    {
      workspaceId: ctx.cwd,
      sessionId: runtimeState.backendSessionId,
      actor: "tool",
      eventType: "pi_tool_result",
      content: clip(input.content),
      metadata: {
        toolName: input.toolName,
        isError: input.isError,
        externalSessionId: runtimeState.externalSessionId,
        automaticCaptureScope: "personal",
        sourceHash: idempotencyKey
      },
      sourceRuntime: "pi",
      captureMethod: "api",
      idempotencyKey,
      sourceHash: idempotencyKey
    },
    signal
  );
};
