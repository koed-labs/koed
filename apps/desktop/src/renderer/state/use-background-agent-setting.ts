import { useCallback, useEffect, useState } from "react";
import type { DesktopApi, DesktopBackgroundAgentState } from "../../types.js";

export const useBackgroundAgentSetting = (
  api?: DesktopApi["backgroundAgent"]
) => {
  const [state, setState] = useState<DesktopBackgroundAgentState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let active = true;
    void api
      .get()
      .then((value) => {
        if (active) setState(value);
      })
      .catch(() => {
        if (active) setError("Background Agent status could not be read.");
      });
    return () => {
      active = false;
    };
  }, [api]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) return;
      setBusy(true);
      setError(null);
      try {
        setState(await api.set(enabled));
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Background Agent settings could not be changed."
        );
        const current = await api.get().catch(() => null);
        if (current) setState(current);
      } finally {
        setBusy(false);
      }
    },
    [api]
  );

  return { state, busy, error, setEnabled };
};
