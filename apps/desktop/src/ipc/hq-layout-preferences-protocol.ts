import { z } from "zod";

export const hqLayoutPreferencesGetChannel = "koed:hq-layout-preferences:get";
export const hqLayoutPreferencesSetChannel = "koed:hq-layout-preferences:set";

export const hqLayoutPreferencesSchema = z
  .object({
    sidebarWidth: z.number().finite().int().safe().min(200).max(440),
    rightColumnWidth: z
      .number()
      .finite()
      .int()
      .safe()
      .min(300)
      .max(16_384)
      .nullable(),
    rightColumnHidden: z.boolean()
  })
  .strict();

export type HqLayoutPreferences = z.infer<typeof hqLayoutPreferencesSchema>;

export const defaultHqLayoutPreferences: HqLayoutPreferences = {
  sidebarWidth: 268,
  rightColumnWidth: null,
  rightColumnHidden: false
};

export const hqLayoutPreferencesGetArgsSchema = z.tuple([]);
export const hqLayoutPreferencesSetArgsSchema = z.tuple([
  hqLayoutPreferencesSchema
]);
export const hqLayoutPreferencesResultSchema = hqLayoutPreferencesSchema;

export interface HqLayoutPreferencesApi {
  get: () => Promise<HqLayoutPreferences>;
  set: (preferences: HqLayoutPreferences) => Promise<HqLayoutPreferences>;
}
