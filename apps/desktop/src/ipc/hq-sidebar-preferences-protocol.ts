import { z } from "zod";

export const hqSidebarPreferencesGetChannel = "koed:hq-sidebar-preferences:get";
export const hqSidebarPreferencesSetChannel = "koed:hq-sidebar-preferences:set";
export const hqSidebarFoldedGroupLimit = 1001;

const foldedGroupsSchema = z
  .record(z.string().trim().min(1).max(520), z.boolean())
  .refine((groups) => Object.keys(groups).length <= hqSidebarFoldedGroupLimit);

export const hqSidebarPreferencesSchema = z
  .object({ foldedGroups: foldedGroupsSchema })
  .strict();

export type HqSidebarPreferences = z.infer<typeof hqSidebarPreferencesSchema>;

export const defaultHqSidebarPreferences: HqSidebarPreferences = {
  foldedGroups: {}
};

export const hqSidebarPreferencesGetArgsSchema = z.tuple([]);
export const hqSidebarPreferencesSetArgsSchema = z.tuple([
  hqSidebarPreferencesSchema
]);
export const hqSidebarPreferencesResultSchema = hqSidebarPreferencesSchema;

export interface HqSidebarPreferencesApi {
  get: () => Promise<HqSidebarPreferences>;
  set: (preferences: HqSidebarPreferences) => Promise<HqSidebarPreferences>;
}
