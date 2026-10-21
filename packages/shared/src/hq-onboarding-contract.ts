import { z } from "zod";

export const hqOnboardingRoleSchema = z.enum(["software", "studying", "other"]);
export type HqOnboardingRole = z.infer<typeof hqOnboardingRoleSchema>;

/** This text is the exact, user-confirmed Personal Note and proposal claim. */
export const hqOnboardingPreferenceClaim = (role: HqOnboardingRole): string =>
  role === "software"
    ? "I mostly use Koed for building software."
    : role === "studying"
      ? "I mostly use Koed for studying."
      : "I mostly use Koed for something else.";

export const hqOnboardingPreferenceRequestSchema = z
  .object({
    role: hqOnboardingRoleSchema,
    noteId: z.uuid(),
    memoryEventId: z.uuid()
  })
  .strict();
