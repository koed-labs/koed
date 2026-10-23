import {
  sharingOverviewSchema,
  type SharingOverview
} from "@koed/shared/sharing-contract";
import { z } from "zod";

export const sharingChannel = "koed:sharing:read";
export const sharingRequestSchema = z
  .object({ operation: z.literal("read") })
  .strict();
export const sharingResultSchema = sharingOverviewSchema;
export interface SharingDesktopApi {
  read(): Promise<SharingOverview>;
}
