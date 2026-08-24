import { managedConversationDiffSchema } from "@koed/shared/managed-conversation-diff";
import {
  managedConversationFileOperationResultSchema,
  managedConversationFileOperationSchema
} from "@koed/shared/managed-conversation-files";
import {
  managedDevelopmentPreviewCandidateSchema,
  managedDevelopmentPreviewRecordSchema
} from "@koed/shared/managed-development-preview";
import {
  createManagedTerminalInputSchema,
  managedTerminalClientFrameSchema,
  managedTerminalRecordSchema,
  managedTerminalServerFrameSchema,
  managedTerminalShellProfileSchema
} from "@koed/shared/managed-terminal";
import {
  sourceControlOperationSchema,
  sourceControlResultSchema
} from "@koed/shared/source-control";
import { z } from "zod";

export const managedWorkspaceCommandChannel = "koed:managed-workspace:command";
export const managedWorkspaceEventChannel = "koed:managed-workspace:event";

const requestBase = {
  requestId: z.uuid(),
  executionId: z.uuid()
} as const;

const previewBoundsSchema = z
  .object({
    x: z.number().int().safe().nonnegative().max(32_768),
    y: z.number().int().safe().nonnegative().max(32_768),
    width: z.number().int().safe().positive().max(16_384),
    height: z.number().int().safe().positive().max(16_384)
  })
  .strict();

export const managedWorkspaceRequestSchema = z.union([
  z
    .object({
      ...requestBase,
      operation: z.literal("diff_read"),
      scope: z.literal("full")
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("checkpoint_restore"),
      executionGeneration: z.number().int().safe().positive(),
      checkpointId: z.uuid(),
      idempotencyKey: z.string().trim().min(16).max(160)
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("diff_read"),
      scope: z.literal("turn"),
      commandId: z.uuid()
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("file_start"),
      executionGeneration: z.number().int().safe().positive(),
      idempotencyKey: z.string().trim().min(16).max(160),
      fileOperation: managedConversationFileOperationSchema
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("file_result"),
      commandId: z.uuid()
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("terminal_profiles")
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("terminal_list")
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("terminal_create"),
      input: createManagedTerminalInputSchema
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("terminal_attach"),
      connectionId: z.uuid(),
      terminalId: z.uuid(),
      lifecycleGeneration: z.number().int().safe().positive(),
      afterOutputSequence: z.number().int().safe().nonnegative()
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("terminal_send"),
      connectionId: z.uuid(),
      frame: managedTerminalClientFrameSchema
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("terminal_stop"),
      terminalId: z.uuid()
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("terminal_detach"),
      connectionId: z.uuid()
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("preview_list")
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("preview_nominate"),
      candidate: managedDevelopmentPreviewCandidateSchema
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("preview_attach"),
      surfaceId: z.uuid(),
      previewId: z.uuid(),
      lifecycleGeneration: z.number().int().safe().positive(),
      bounds: previewBoundsSchema
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("preview_bounds"),
      surfaceId: z.uuid(),
      bounds: previewBoundsSchema
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("preview_reload"),
      surfaceId: z.uuid()
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("preview_detach"),
      surfaceId: z.uuid()
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("source_control"),
      sourceControlOperation: sourceControlOperationSchema
    })
    .strict()
]);

const commandSchema = z
  .object({
    id: z.uuid(),
    state: z.string().trim().min(1).max(64),
    commandKind: z.string().trim().min(1).max(64),
    executionId: z.uuid(),
    executionGeneration: z.number().int().safe().positive(),
    attempts: z.number().int().safe().nonnegative().optional(),
    lastErrorCode: z.string().trim().min(1).max(160).nullable().optional(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }).optional(),
    completedAt: z.iso.datetime({ offset: true }).nullable().optional()
  })
  .strict();

const responseBase = {
  requestId: z.uuid(),
  executionId: z.uuid()
} as const;

export const managedWorkspaceResultSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...responseBase,
      operation: z.literal("diff_read"),
      value: managedConversationDiffSchema
    })
    .strict(),
  z
    .object({
      ...responseBase,
      operation: z.literal("checkpoint_restore"),
      command: commandSchema
    })
    .strict(),
  z
    .object({
      ...responseBase,
      operation: z.literal("file_start"),
      command: commandSchema
    })
    .strict(),
  z
    .object({
      ...responseBase,
      operation: z.literal("file_result"),
      command: commandSchema,
      result: managedConversationFileOperationResultSchema.nullable()
    })
    .strict(),
  z
    .object({
      ...responseBase,
      operation: z.literal("terminal_profiles"),
      profiles: z.array(managedTerminalShellProfileSchema).max(16)
    })
    .strict(),
  z
    .object({
      ...responseBase,
      operation: z.literal("terminal_list"),
      terminals: z.array(managedTerminalRecordSchema).max(32)
    })
    .strict(),
  z
    .object({
      ...responseBase,
      operation: z.literal("terminal_create"),
      terminal: managedTerminalRecordSchema
    })
    .strict(),
  z
    .object({
      ...responseBase,
      operation: z.literal("terminal_attach"),
      connectionId: z.uuid(),
      accepted: z.literal(true)
    })
    .strict(),
  z
    .object({
      ...responseBase,
      operation: z.literal("terminal_send"),
      connectionId: z.uuid(),
      accepted: z.literal(true)
    })
    .strict(),
  z
    .object({
      ...responseBase,
      operation: z.literal("terminal_stop"),
      terminal: managedTerminalRecordSchema
    })
    .strict(),
  z
    .object({
      ...responseBase,
      operation: z.literal("terminal_detach"),
      connectionId: z.uuid(),
      accepted: z.literal(true)
    })
    .strict(),
  z
    .object({
      ...responseBase,
      operation: z.literal("preview_list"),
      previews: z.array(managedDevelopmentPreviewRecordSchema).max(16)
    })
    .strict(),
  z
    .object({
      ...responseBase,
      operation: z.literal("preview_nominate"),
      preview: managedDevelopmentPreviewRecordSchema
    })
    .strict(),
  z
    .object({
      ...responseBase,
      operation: z.literal("source_control"),
      result: sourceControlResultSchema
    })
    .strict(),
  z
    .object({
      ...responseBase,
      operation: z.enum([
        "preview_attach",
        "preview_bounds",
        "preview_reload",
        "preview_detach"
      ]),
      surfaceId: z.uuid(),
      accepted: z.literal(true)
    })
    .strict()
]);

export const managedWorkspaceEventSchema = z.union([
  z
    .object({
      kind: z.literal("terminal"),
      connectionId: z.uuid(),
      frame: managedTerminalServerFrameSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("preview"),
      surfaceId: z.uuid(),
      previewId: z.uuid(),
      lifecycleGeneration: z.number().int().safe().positive(),
      state: z.enum(["loading", "ready", "failed", "closed"]),
      code: z.string().trim().min(1).max(160).optional()
    })
    .strict()
]);

export type ManagedWorkspaceRequest = z.infer<
  typeof managedWorkspaceRequestSchema
>;
export type ManagedWorkspaceResult = z.infer<
  typeof managedWorkspaceResultSchema
>;
export type ManagedWorkspaceEvent = z.infer<typeof managedWorkspaceEventSchema>;

export interface ManagedWorkspaceDesktopApi {
  command(request: ManagedWorkspaceRequest): Promise<ManagedWorkspaceResult>;
  subscribe(listener: (event: ManagedWorkspaceEvent) => void): () => void;
}
