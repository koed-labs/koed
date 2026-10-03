"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SetupChecklist } from "../../.desktop-ui/index.js";
import { DesktopStatusStore } from "../../.desktop-ui/index.js";

export function StudioStartupGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const settingsRoute = /^\/(?:studio\/)?settings\/?$/.test(pathname);
  const statusStore = useMemo(() => new DesktopStatusStore(), []);
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(
    null
  );

  useEffect(() => {
    let active = true;
    const bridge = window.koedDesktop;
    if (!bridge) {
      queueMicrotask(() => {
        if (active) setOnboardingComplete(true);
      });
      return () => {
        active = false;
      };
    }
    void bridge
      .invoke<{ complete: boolean }>("onboarding_status")
      .then((result) => {
        if (active) setOnboardingComplete(result.complete === true);
      })
      .catch(() => {
        if (active) setOnboardingComplete(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const completeOnboarding = useCallback(async () => {
    const result = await window.koedDesktop?.invoke<{ complete: boolean }>(
      "onboarding_complete"
    );
    if (result?.complete !== true) {
      throw new Error("Studio setup completion could not be saved.");
    }
    setOnboardingComplete(true);
  }, []);

  // Settings remains reachable for pairing and repairs during first setup.
  if (settingsRoute) return children;
  if (onboardingComplete === null) {
    return (
      <main className="flex h-full min-h-0 items-center justify-center bg-background text-sm text-muted">
        Checking this computer’s Koed setup…
      </main>
    );
  }
  if (!onboardingComplete) {
    return (
      <SetupChecklist
        nativeRunConfirmation
        onComplete={completeOnboarding}
        statusStore={statusStore}
      />
    );
  }
  return children;
}
