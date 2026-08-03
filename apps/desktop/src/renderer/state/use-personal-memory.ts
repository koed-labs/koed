import { useCallback, useSyncExternalStore } from "react";
import {
  type PersonalMemorySnapshot,
  type PersonalMemoryStore
} from "./personal-memory.js";

export const usePersonalMemorySnapshot = (
  store: PersonalMemoryStore
): PersonalMemorySnapshot => {
  const subscribe = useCallback(
    (notify: () => void) => store.subscribe(notify),
    [store]
  );
  return useSyncExternalStore(subscribe, store.current, store.current);
};
