import { z } from "zod";

/** Owner-only device metadata. Availability describes current authorization,
 * rather than device connectivity or verified local source availability. */
export const sharingRulePublisherSchema = z
  .object({
    credentialId: z.uuid(),
    deviceInstanceId: z.string().min(1).max(512),
    label: z.string().min(1).max(4096).nullable(),
    available: z.boolean()
  })
  .strict();

export type SharingRulePublisher = z.infer<typeof sharingRulePublisherSchema>;
