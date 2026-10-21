import {
  projectHqConversationSchema,
  projectHqConversationReadSchema
} from "@koed/shared/project-contract";
import { z } from "zod";

export const projectHqConversationChannel =
  "koed:project-hq-conversation:command";

export const projectHqConversationRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({ operation: z.literal("reserve"), projectId: z.uuid() }).strict(),
    z.object({ operation: z.literal("read"), projectId: z.uuid() }).strict(),
    z
      .object({ operation: z.literal("catch_up"), projectId: z.uuid() })
      .strict(),
    z
      .object({
        operation: z.literal("retry_catch_up"),
        projectId: z.uuid(),
        failedCommandId: z.uuid(),
        retryRequestId: z.uuid()
      })
      .strict(),
    z
      .object({
        operation: z.literal("start"),
        projectId: z.uuid(),
        prompt: z
          .string()
          .min(1)
          .max(256_000)
          .refine((value) => value.trim().length > 0),
        permissionMode: z
          .enum(["supervised", "auto_edit", "auto", "full_access"])
          .optional(),
        selectedDocumentSourceId: z.uuid().optional()
      })
      .strict()
  ]
);

export const projectHqConversationResultSchema = z.discriminatedUnion(
  "operation",
  [
    z
      .object({
        operation: z.literal("reserve"),
        value: projectHqConversationSchema
      })
      .strict(),
    z
      .object({
        operation: z.literal("read"),
        value: projectHqConversationReadSchema
      })
      .strict(),
    z
      .object({
        operation: z.literal("catch_up"),
        projectId: z.uuid(),
        status: z.enum([
          "nothing",
          "starting",
          "waiting",
          "queued",
          "recovered",
          "retry_available",
          "reconciliation_required"
        ]),
        executionId: z.uuid().nullable(),
        commandId: z.uuid().nullable()
      })
      .strict(),
    z
      .object({
        operation: z.literal("retry_catch_up"),
        projectId: z.uuid(),
        status: z.enum(["queued", "completed"]),
        executionId: z.uuid(),
        commandId: z.uuid(),
        commandState: z.enum([
          "queued",
          "blocked",
          "dispatching",
          "completed",
          "failed",
          "indeterminate",
          "canceled"
        ])
      })
      .strict(),
    z
      .object({
        operation: z.literal("start"),
        projectId: z.uuid(),
        executionId: z.uuid(),
        commandId: z.uuid(),
        commandState: z.enum(["blocked", "queued", "dispatching", "completed"])
      })
      .strict()
  ]
);

export type ProjectHqConversationRequest = z.infer<
  typeof projectHqConversationRequestSchema
>;
export type ProjectHqConversationResult = z.infer<
  typeof projectHqConversationResultSchema
>;

export interface ProjectHqConversationDesktopApi {
  read(
    projectId: string
  ): Promise<z.infer<typeof projectHqConversationReadSchema>>;
  reserve(
    projectId: string
  ): Promise<z.infer<typeof projectHqConversationSchema>>;
  catchUp(projectId: string): Promise<{
    projectId: string;
    status:
      | "nothing"
      | "starting"
      | "waiting"
      | "queued"
      | "recovered"
      | "retry_available"
      | "reconciliation_required";
    executionId: string | null;
    commandId: string | null;
  }>;
  retryCatchUp(
    projectId: string,
    failedCommandId: string,
    retryRequestId: string
  ): Promise<{
    projectId: string;
    status: "queued" | "completed";
    executionId: string;
    commandId: string;
    commandState:
      | "queued"
      | "blocked"
      | "dispatching"
      | "completed"
      | "failed"
      | "indeterminate"
      | "canceled";
  }>;
  start(
    projectId: string,
    prompt: string,
    permissionMode?: "supervised" | "auto_edit" | "auto" | "full_access",
    selectedDocumentSourceId?: string
  ): Promise<{
    projectId: string;
    executionId: string;
    commandId: string;
    commandState: "blocked" | "queued" | "dispatching" | "completed";
  }>;
}
