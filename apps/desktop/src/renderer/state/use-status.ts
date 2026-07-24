import { useCallback, useSyncExternalStore } from "react";
import {
  type DesktopStatusStore,
  type StatusSnapshot
} from "../services/desktop-commands.js";

export const useDesktopStatus = (store: DesktopStatusStore): StatusSnapshot => {
  const subscribe = useCallback(
    (notify: () => void) => store.subscribe(notify),
    [store]
  );
  return useSyncExternalStore(subscribe, store.current, store.current);
};
