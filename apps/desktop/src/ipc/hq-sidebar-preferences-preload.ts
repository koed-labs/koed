import {
  hqSidebarPreferencesGetArgsSchema,
  hqSidebarPreferencesGetChannel,
  hqSidebarPreferencesResultSchema,
  hqSidebarPreferencesSchema,
  hqSidebarPreferencesSetArgsSchema,
  hqSidebarPreferencesSetChannel,
  type HqSidebarPreferencesApi
} from "./hq-sidebar-preferences-protocol.js";

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export const createHqSidebarPreferencesPreloadApi = (
  invoke: Invoke
): HqSidebarPreferencesApi =>
  Object.freeze({
    get: async (...args: unknown[]) => {
      hqSidebarPreferencesGetArgsSchema.parse(args);
      return hqSidebarPreferencesResultSchema.parse(
        await invoke(hqSidebarPreferencesGetChannel)
      );
    },
    set: async (...args: unknown[]) => {
      const [value] = hqSidebarPreferencesSetArgsSchema.parse(args);
      const preferences = hqSidebarPreferencesSchema.parse(value);
      return hqSidebarPreferencesResultSchema.parse(
        await invoke(hqSidebarPreferencesSetChannel, preferences)
      );
    }
  });
