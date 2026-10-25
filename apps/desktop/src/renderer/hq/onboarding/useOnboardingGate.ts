import { useEffect, useState } from "react";
import type { HqOnboardingIdentity } from "../../../ipc/hq-onboarding-protocol.js";
import {
  readHqOnboarding,
  hqOnboardingStorageKey
} from "./onboarding-preference.js";

/** Transport reconnect epochs are not onboarding identities. */
export function useOnboardingGate(
  ownerId: string | null,
  transportKey: string | null,
  enabled: boolean
) {
  const scope =
    ownerId && transportKey
      ? hqOnboardingStorageKey(ownerId, transportKey)
      : null;
  const [resolved, setResolved] = useState<{
    scope: string;
    profileKey?: string;
    error?: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const legacyComplete = Boolean(
    ownerId && transportKey && readHqOnboarding(ownerId, transportKey).completed
  );
  useEffect(() => {
    if (!enabled || !ownerId || !scope || legacyComplete) return;
    let active = true;
    setResolved(null);
    void (async () => {
      if (!window.koedDesktop?.invoke)
        throw new Error("Onboarding identity is unavailable.");
      const identity = await window.koedDesktop.invoke<HqOnboardingIdentity>(
        "hq_onboarding_identity"
      );
      if (
        identity.ownerId !== ownerId ||
        typeof identity.profileKey !== "string" ||
        !identity.profileKey.trim()
      )
        throw new Error("Onboarding owner identity changed.");
      if (active) setResolved({ scope, profileKey: identity.profileKey });
    })().catch((error: unknown) => {
      if (active)
        setResolved({
          scope,
          error:
            error instanceof Error
              ? error.message
              : "Your setup could not be read."
        });
    });
    return () => {
      active = false;
    };
  }, [enabled, ownerId, legacyComplete, scope, retry]);
  const profileKey = legacyComplete
    ? transportKey
    : resolved?.scope === scope
      ? resolved.profileKey
      : null;
  return {
    loading:
      enabled &&
      Boolean(ownerId && transportKey) &&
      !profileKey &&
      !(resolved?.scope === scope && resolved.error),
    error:
      enabled && !legacyComplete && resolved?.scope === scope
        ? resolved.error
        : undefined,
    profileKey,
    record:
      enabled && ownerId && profileKey
        ? readHqOnboarding(ownerId, profileKey)
        : null,
    retry: () => setRetry((value) => value + 1)
  };
}
