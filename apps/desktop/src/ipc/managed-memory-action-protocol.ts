import { z } from "zod";
import {
  managedMemoryActionSchema,
  type ManagedMemoryAction
} from "@koed/shared/managed-memory-actions";

export type { ManagedMemoryAction } from "@koed/shared/managed-memory-actions";
export const managedMemoryActionChannel = "koed:managed-memory-action:command";
export const managedMemoryActionRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({ operation: z.literal("list"), executionId: z.uuid() }).strict(),
    z
      .object({
        operation: z.literal("undo"),
        executionId: z.uuid(),
        actionId: z.uuid()
      })
      .strict()
  ]
);
export type ManagedMemoryActionRequest = z.infer<
  typeof managedMemoryActionRequestSchema
>;
export const managedMemoryActionResultSchema = z.discriminatedUnion(
  "operation",
  [
    z
      .object({
        operation: z.literal("list"),
        executionId: z.uuid(),
        actions: z.array(managedMemoryActionSchema).max(100)
      })
      .strict(),
    z
      .object({
        operation: z.literal("undo"),
        executionId: z.uuid(),
        action: managedMemoryActionSchema
      })
      .strict()
  ]
);
export type ManagedMemoryActionResult = z.infer<
  typeof managedMemoryActionResultSchema
>;
export interface ManagedMemoryActionDesktopApi {
  list(executionId: string): Promise<ManagedMemoryAction[]>;
  undo(executionId: string, actionId: string): Promise<ManagedMemoryAction>;
}
