import { z } from "zod";

export const accelerationChannel = "koed:local-ai-acceleration";
export const accelerationInstallProgressSchema = z
  .object({
    phase: z.enum([
      "checking",
      "downloading",
      "verifying",
      "inference",
      "activating"
    ]),
    completedBytes: z.number().nonnegative().nullable(),
    totalBytes: z.number().positive().nullable(),
    message: z.string().max(500)
  })
  .strict();
export const accelerationChoiceSchema = z
  .object({
    preference: z.enum(["auto", "cpu"]),
    installCuda: z.boolean(),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
  .refine(
    (choice) => !choice.installCuda || choice.preference === "auto",
    "CUDA installation requires automatic processing."
  );
export const accelerationRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("inspect"), refresh: z.boolean() }).strict(),
  z
    .object({ operation: z.literal("apply"), choice: accelerationChoiceSchema })
    .strict(),
  z
    .object({ operation: z.literal("cancel"), operationId: z.string().uuid() })
    .strict()
]);
