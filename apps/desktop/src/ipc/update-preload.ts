import {
  desktopUpdateCommandChannel,
  desktopUpdateEventChannel,
  desktopUpdateRequestSchema,
  desktopUpdateStateSchema,
  type DesktopUpdateApi
} from "@koed-labs/shared/desktop-update-contract";

type Invoke = (channel: string, value: unknown) => Promise<unknown>;
type Events = {
  on(channel: string, listener: (...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (...args: unknown[]) => void): void;
};

export const createDesktopUpdatePreloadApi = (
  invoke: Invoke,
  events: Events
): DesktopUpdateApi => {
  const request = async (operation: "get_state" | "check" | "open_release") => {
    const value = await invoke(
      desktopUpdateCommandChannel,
      desktopUpdateRequestSchema.parse({ operation })
    );
    return desktopUpdateStateSchema.parse(value);
  };
  return Object.freeze({
    getState: () => request("get_state"),
    checkForUpdates: () => request("check"),
    openReleasePage: () => request("open_release"),
    subscribe(listener: Parameters<DesktopUpdateApi["subscribe"]>[0]) {
      if (typeof listener !== "function") {
        throw new TypeError("Desktop update listener is required.");
      }
      let active = true;
      const wrapped = (_event: unknown, value: unknown) => {
        if (!active) return;
        const parsed = desktopUpdateStateSchema.safeParse(value);
        if (parsed.success) listener(parsed.data);
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
