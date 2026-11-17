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
    const receive = (next: AccountState) => {
      if (active) accept(next);
    };
    const unsubscribe = api.onStateChanged(receive);
    // Keep unknown availability hidden. Focus retries only the local state
    // read, never authentication or a provider network request.
    const read = () => {
      void api
        .getState()
        .then(receive)
        .catch(() => undefined);
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("focus", read);
    };
  }, [api, accept]);
  const current = snapshot.api === api ? snapshot : null;
  return {
    state: api ? (current?.state ?? null) : null,
    accept
  };
}
