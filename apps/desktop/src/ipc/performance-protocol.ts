import { performanceChoiceSchema } from "@koed-labs/server/performance-schema";
import { z } from "zod";

export { performanceChannel } from "./performance-channel.js";
// The private supervisor validates the same schema again before save.
export const performanceRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("inspect") }).strict(),
  z
    .object({
      operation: z.literal("apply"),
      choice: performanceChoiceSchema
    })
    .strict()
]);
