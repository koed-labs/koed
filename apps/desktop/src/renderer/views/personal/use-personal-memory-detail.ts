import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
  type PersonalMemoryDetail,
  type PersonalMemoryStore
} from "../../state/personal-memory.js";

type DetailRevisionAdapter = {
  current: () => number;
  subscribe: (notify: () => void) => () => void;
};

const createDetailRevisionAdapter = (
  store: PersonalMemoryStore
): DetailRevisionAdapter => {
  let revision = 0;
  return {
    current: () => revision,
    subscribe: (notify) =>
      store.subscribe(() => {
        revision += 1;
        notify();
      })
  };
};

export const usePersonalMemoryDetail = (
  store: PersonalMemoryStore,
  thread: PersonalDesktopProjectThread,
  enabled = true
): {
  detail: PersonalMemoryDetail | null;
  loadOlder: () => Promise<void>;
  retry: () => Promise<void>;
} => {
  const adapter = useMemo(() => createDetailRevisionAdapter(store), [store]);
  useSyncExternalStore(adapter.subscribe, adapter.current, adapter.current);

  useEffect(() => {
    if (enabled) void store.loadInitial(thread);
  }, [enabled, store, thread]);

  const loadOlder = useCallback(async () => {
    if (enabled) await store.loadOlder(thread);
  }, [enabled, store, thread]);
  const retry = useCallback(async () => {
    if (enabled) await store.loadInitial(thread);
  }, [enabled, store, thread]);

  return {
    detail: enabled ? store.detail(thread) : null,
    loadOlder,
    retry
  };
};
