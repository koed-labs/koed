import type { IpcRenderer } from "electron";
import {
  floatingKinChannels as channels,
  type DesktopKinBridge,
  type KinPresentation,
  type KinSurfaceBridge
} from "./floating-kin-protocol.js";

type KinIpc = Pick<IpcRenderer, "invoke" | "send" | "on" | "removeListener">;

export function createKinSurfacePreloadApi(ipc: KinIpc) {
  return {
    activity: (revision) => ipc.invoke(channels.activity, revision),
    summarize: (input, revision) =>
      ipc.invoke(channels.summarize, input, revision),
    cancel: (revision) => ipc.invoke(channels.cancel, revision),
    onPresentation(listener) {
      let changed = false;
      const receive = (_event: unknown, presentation: KinPresentation) => {
        changed = true;
        listener(presentation);
      };
      ipc.on(channels.presentationChanged, receive);
      void ipc
        .invoke(channels.presentation)
        .then((state: KinPresentation) => {
          if (!changed) listener(state);
        })
        .catch((error: unknown) =>
          console.warn("Chief of Staff placement is unavailable.", error)
        );
      return () => {
        changed = true;
        ipc.removeListener(channels.presentationChanged, receive);
      };
    }
  } satisfies KinSurfaceBridge;
}

export function createDesktopKinPreloadApi(ipc: KinIpc): DesktopKinBridge {
  return {
    ...createKinSurfacePreloadApi(ipc),
    setShellVisible: (visible) => ipc.send(channels.setShellVisible, visible),
    confirmPresentation: (revision) =>
      ipc.send(channels.confirmPresentation, revision)
  };
}
