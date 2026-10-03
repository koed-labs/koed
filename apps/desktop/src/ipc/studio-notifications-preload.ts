import {
  studioNotificationIntentSchema,
  studioNotificationNavigationSchema,
  studioNotificationSourceSchema,
  type StudioNotificationSource,
  type StudioNotificationIntent,
  type StudioNotificationNavigation
} from "@koed/shared/studio-notifications";
import {
  studioNotificationGetPreferenceChannel,
  studioNotificationNavigationChannel,
  studioNotificationNotifyChannel,
  studioNotificationResetChannel,
  studioNotificationSetPreferenceChannel
} from "./protocol.js";

export const createStudioNotificationsPreloadApi = (
  invoke: (channel: string, value?: unknown) => Promise<unknown>,
  events: {
    on(
      channel: string,
      listener: (event: unknown, value: unknown) => void
    ): void;
    removeListener(
      channel: string,
      listener: (event: unknown, value: unknown) => void
    ): void;
  }
) =>
  Object.freeze({
    notify: (value: StudioNotificationIntent): Promise<{ shown: boolean }> =>
      invoke(
        studioNotificationNotifyChannel,
        studioNotificationIntentSchema.parse(value)
      ) as Promise<{ shown: boolean }>,
    getPreference: async (): Promise<{ enabled: boolean }> => {
      const result = await invoke(studioNotificationGetPreferenceChannel);
      if (
        !result ||
        typeof result !== "object" ||
        typeof (result as { enabled?: unknown }).enabled !== "boolean"
      )
        throw new Error("Invalid notification preference response.");
      return { enabled: (result as { enabled: boolean }).enabled };
    },
    reset: async (source?: StudioNotificationSource): Promise<void> => {
      if (source !== undefined)
        source = studioNotificationSourceSchema.parse(source);
      await invoke(studioNotificationResetChannel, source);
    },
    setEnabled: async (enabled: boolean): Promise<{ enabled: boolean }> => {
      if (typeof enabled !== "boolean")
        throw new TypeError("Notification preference must be boolean.");
      const result = await invoke(
        studioNotificationSetPreferenceChannel,
        enabled
      );
      if (
        !result ||
        typeof result !== "object" ||
        typeof (result as { enabled?: unknown }).enabled !== "boolean"
      )
        throw new Error("Invalid notification preference response.");
      return { enabled: (result as { enabled: boolean }).enabled };
    },
    onNavigate: (
      listener: (navigation: StudioNotificationNavigation) => void
    ) => {
      if (typeof listener !== "function")
        throw new TypeError("Notification navigation listener is required.");
      let active = true;
      const wrapped = (_event: unknown, value: unknown) => {
        if (!active) return;
        const parsed = studioNotificationNavigationSchema.safeParse(value);
        if (parsed.success) listener(parsed.data);
      };
      events.on(studioNotificationNavigationChannel, wrapped);
      return () => {
        active = false;
        events.removeListener(studioNotificationNavigationChannel, wrapped);
      };
    }
  });
