import {
  desktopUpdateCommandChannel, desktopUpdateEventChannel,
  desktopUpdateStateSchema, type DesktopUpdateApi, type DesktopUpdateRequest,
  type DesktopUpdateState
} from "@koed/shared/desktop-update-contract";

type Events = {
  on(channel: string, listener: (...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (...args: unknown[]) => void): void;
};

export const createDesktopUpdatePreloadApi = (
  invoke: (channel: string, value: unknown) => Promise<unknown>, events: Events
): DesktopUpdateApi => {
  const command = async (operation: DesktopUpdateRequest["operation"]) =>
    desktopUpdateStateSchema.parse(await invoke(desktopUpdateCommandChannel, { operation }));
  return Object.freeze({
    getState: () => command("get_state"),
    checkForUpdates: () => command("check"),
    openReleasePage: () => command("open_release"),
    subscribe: (listener: (state: DesktopUpdateState) => void) => {
      if (typeof listener !== "function") throw new TypeError("Desktop update listener is required.");
      let active = true;
      const wrapped = (_event: unknown, value: unknown) => {
        if (active) listener(desktopUpdateStateSchema.parse(value));
      };
      events.on(desktopUpdateEventChannel, wrapped);
      return () => {
        if (!active) return;
        active = false;
        events.removeListener(desktopUpdateEventChannel, wrapped);
      };
    }
  });
};
