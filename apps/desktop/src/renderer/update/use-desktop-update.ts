import { useEffect, useRef, useState } from "react";
import type { DesktopUpdateApi, DesktopUpdateState } from "@koed/shared/desktop-update-contract";

const useNoticeState = (api?: DesktopUpdateApi) => {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const generation = useRef(0);
  const action = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    let receivedEvent = false;
    setState(null); setError(null); setBusy(false);
    if (!api) return;
    const unsubscribe = api.subscribe((next) => {
      if (generation.current !== current) return;
      receivedEvent = true; revision.current += 1; setState(next);
    });
    void api.getState().then((next) => {
      if (generation.current === current && !receivedEvent) setState(next);
    }).catch(() => {
      if (generation.current === current && !receivedEvent) setError("Update checks are unavailable.");
    });
    return () => { generation.current += 1; unsubscribe(); };
  }, [api]);
  return { state, setState, error, setError, busy, setBusy, revision, generation, action };
};

export const useDesktopUpdate = (api?: DesktopUpdateApi) => {
  const notice = useNoticeState(api);
  const run = async (operation: "checkForUpdates" | "openReleasePage", failure: string) => {
    if (!api || notice.busy) return;
    const generation = notice.generation.current;
    const revision = notice.revision.current;
    const action = ++notice.action.current;
    const active = () => generation === notice.generation.current && action === notice.action.current;
    notice.setBusy(true); notice.setError(null);
    try {
      const next = await api[operation]();
      if (active() && revision === notice.revision.current) notice.setState(next);
    } catch {
      if (active()) notice.setError(failure);
    } finally {
      if (active()) notice.setBusy(false);
    }
  };
  return {
    state: notice.state, error: notice.error, busy: notice.busy,
    check: () => { void run("checkForUpdates", "Could not check for updates. Try again later."); },
    open: () => { void run("openReleasePage", "Could not open official release page. Try again later."); }
  };
};

export type DesktopUpdateController = ReturnType<typeof useDesktopUpdate>;
