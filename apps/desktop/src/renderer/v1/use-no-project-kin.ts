import { useCallback, useEffect, useState } from "react";
import type { PersonalProjectKin } from "@koed-labs/shared";
import { personalProjectKinSchema } from "@koed-labs/shared/personal-desktop";

const storageKey = (scopeKey: string) => `koed:no-project-kin:${scopeKey}`;

/**
 * No project is not a Project, so its Kin has nowhere to sync. Keep it on
 * this device, isolated by the authenticated backend/owner scope.
 */
export function useNoProjectKin(scopeKey: string | null) {
  const [state, setState] = useState<{
    scope: string | null;
    kin?: PersonalProjectKin;
  }>({ scope: null });
  useEffect(() => {
    if (!scopeKey) {
      setState({ scope: null });
      return;
    }
    try {
      const raw = window.localStorage.getItem(storageKey(scopeKey));
      const parsed = raw
        ? personalProjectKinSchema.safeParse(JSON.parse(raw))
        : null;
      setState({
        scope: scopeKey,
        ...(parsed?.success ? { kin: parsed.data } : {})
      });
    } catch {
      setState({ scope: scopeKey });
    }
  }, [scopeKey]);
  const save = useCallback(
    (kin: PersonalProjectKin) => {
      if (!scopeKey) return false;
      try {
        window.localStorage.setItem(storageKey(scopeKey), JSON.stringify(kin));
        setState({ scope: scopeKey, kin });
        return true;
      } catch {
        return false;
      }
    },
    [scopeKey]
  );
  return {
    kin: state.scope === scopeKey ? state.kin : undefined,
    save,
    ready: Boolean(scopeKey && state.scope === scopeKey)
  };
}
