import { useCallback, useEffect, useState } from "react";
import type {
  AccountDesktopApi,
  AccountState
} from "@koed-labs/shared/account";

/** Main's unavailable state hides the sidebar account badge; no provider calls. */
export function useAccountState(api: AccountDesktopApi | undefined) {
  const [snapshot, setSnapshot] = useState<{
    api: AccountDesktopApi | undefined;
    state: AccountState | null;
  }>({ api, state: null });
  const accept = useCallback(
    (next: AccountState) => {
      setSnapshot((current) => {
        if (
          current.api === api &&
          current.state &&
          next.revision < current.state.revision
        )
          return current;
        return { api, state: next };
      });
    },
    [api]
  );
  useEffect(() => {
    if (!api) return;
    let active = true;
    let latest: AccountState | null = null;
    let refreshing = false;
    let retryRequested = false;
    let retryAfter = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const receive = (next: AccountState) => {
      if (!active || (latest && next.revision < latest.revision)) return;
      latest = next;
      accept(next);
      if (retryRequested && !next.busy && !refreshing) {
        retryRequested = false;
        retry();
      }
    };
    const retry = () => {
      if (
        !active ||
        !latest ||
        latest.status !== "signed_in" ||
        !latest.stale ||
        !latest.profile
      )
        return;
      if (refreshing || latest.busy) {
        retryRequested = true;
        return;
      }
      const delay = retryAfter - Date.now();
      if (delay > 0) {
        // Keep one trailing retry when focus and connectivity events overlap.
        retryTimer ??= setTimeout(
          () => {
            retryTimer = undefined;
            read(true);
          },
          Math.max(delay, 1000)
        );
        return;
      }
      retryRequested = false;
      refreshing = true;
      retryAfter = Date.now() + 30000;
      void api
        .refreshProfile()
        .then(receive)
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
          if (retryRequested) {
            retryRequested = false;
            retry();
          }
        });
    };
    const read = (recover = false) => {
      void api
        .getState()
        .then((next) => {
          receive(next);
          if (recover) retry();
        })
        .catch(() => undefined);
    };
    const recover = () => read(true);
    const unsubscribe = api.onStateChanged(receive);
    // Initial availability reads remain local. Only a cached signed-in account
    // can request a throttled refresh after focus or connectivity returns.
    read();
    window.addEventListener("focus", recover);
    window.addEventListener("online", recover);
    return () => {
      active = false;
      clearTimeout(retryTimer);
      unsubscribe();
      window.removeEventListener("focus", recover);
      window.removeEventListener("online", recover);
    };
  }, [api, accept]);
  const current = snapshot.api === api ? snapshot : null;
  return {
    state: api ? (current?.state ?? null) : null,
    accept
  };
}
