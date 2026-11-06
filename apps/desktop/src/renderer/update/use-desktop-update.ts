import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DesktopUpdateApi,
  DesktopUpdateState
} from "@koed/shared/desktop-update-contract";

export type DesktopUpdateController = {
  state: DesktopUpdateState | null;
  error: string | null;
  busy: boolean;
  check: () => Promise<void>;
  open: () => Promise<void>;
};

const unavailableState: DesktopUpdateState = {
  installedVersion: "Unknown",
  status: "disabled",
  release: null,
  checkedAt: null
};

export function useDesktopUpdate(
  api?: DesktopUpdateApi
): DesktopUpdateController {
  const [state, setState] = useState<DesktopUpdateState | null>(
    api ? null : unavailableState
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);

  useEffect(() => {
    if (!api) return;
    let active = true;
    let eventSeen = false;
    const unsubscribe = api.subscribe((next) => {
      eventSeen = true;
      revision.current += 1;
      if (active) setState(next);
    });
    void api
      .getState()
      .then((snapshot) => {
        if (active && !eventSeen) setState(snapshot);
      })
      .catch(() => {
        if (active) setError("Update status could not be read.");
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  const run = useCallback(
    async (operation: "check" | "open") => {
      if (!api || busy) return;
      setBusy(true);
      setError(null);
      const startedAtRevision = revision.current;
      try {
        const next =
          operation === "check"
            ? await api.checkForUpdates()
            : await api.openReleasePage();
        if (revision.current === startedAtRevision) setState(next);
      } catch {
        setError(
          operation === "check"
            ? "Update status could not be checked."
            : "Release page could not be opened."
        );
      } finally {
        setBusy(false);
      }
    },
    [api, busy]
  );

  return {
    state,
    error,
    busy,
    check: () => run("check"),
    open: () => run("open")
  };
}
