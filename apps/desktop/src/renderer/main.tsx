import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { V1App as App } from "./v1/App.js";
import { installWindowActivity } from "./window-activity.js";
import "./index.css";

installWindowActivity();

function DesktopRoot() {
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(
    null
  );

  useEffect(() => {
    let active = true;
    void window.koedDesktop
      ?.invoke<{ complete: boolean }>("onboarding_status")
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

  if (onboardingComplete === null) {
    return (
      <main aria-live="polite" className="desktop-starting">
        Opening Koed…
      </main>
    );
  }

  return (
    <App
      completeOnboarding={async () => {
        const result = await window.koedDesktop?.invoke<{ complete: boolean }>(
          "onboarding_complete"
        );
        if (result?.complete !== true) {
          throw new Error("Onboarding completion could not be saved.");
        }
        setOnboardingComplete(true);
      }}
      onboardingComplete={onboardingComplete}
    />
  );
}

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing app root.");

createRoot(root).render(
  <StrictMode>
    <DesktopRoot />
  </StrictMode>
);
