import {
  hqLayoutPreferencesGetChannel,
  hqLayoutPreferencesGetArgsSchema,
  hqLayoutPreferencesResultSchema,
  hqLayoutPreferencesSchema,
  hqLayoutPreferencesSetChannel,
  hqLayoutPreferencesSetArgsSchema,
  type HqLayoutPreferencesApi
} from "./hq-layout-preferences-protocol.js";

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export const createHqLayoutPreferencesPreloadApi = (
  invoke: Invoke
): HqLayoutPreferencesApi =>
  Object.freeze({
    get: async (...args: unknown[]) => {
      hqLayoutPreferencesGetArgsSchema.parse(args);
      return hqLayoutPreferencesResultSchema.parse(
        await invoke(hqLayoutPreferencesGetChannel)
      );
    },
    set: async (...args: unknown[]) => {
      const [value] = hqLayoutPreferencesSetArgsSchema.parse(args);
      const preferences = hqLayoutPreferencesSchema.parse(value);
      return hqLayoutPreferencesResultSchema.parse(
        await invoke(hqLayoutPreferencesSetChannel, preferences)
      );
    }
  });
