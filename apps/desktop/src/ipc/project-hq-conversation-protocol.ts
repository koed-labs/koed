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
          .optional()
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
  start(
    projectId: string,
    prompt: string,
    permissionMode?: "supervised" | "auto_edit" | "auto" | "full_access"
  ): Promise<{
    projectId: string;
    executionId: string;
    commandId: string;
    commandState: "blocked" | "queued" | "dispatching" | "completed";
  }>;
}
