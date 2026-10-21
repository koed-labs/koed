// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { HqRolePreferenceSettings } from "./HqRolePreferenceSettings.js";
import { readHqOnboarding } from "./onboarding-preference.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("does not propose or persist an old Note response after Settings unmounts", async () => {
  localStorage.clear();
  let release!: (value: unknown) => void;
  const createNote = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const proposeOnboardingPreference = vi.fn();
  const previous = window.koedDesktop;
  window.koedDesktop = {
    curatedMemory: { proposeOnboardingPreference }
  } as never;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let unmounted = false;
  try {
    await act(async () =>
      root.render(
        <HqRolePreferenceSettings
          authorityKey="owner|profile"
          personalMemoryApi={{ createNote } as never}
        />
      )
    );
    await act(async () => host.querySelector("button")!.click());
    expect(createNote).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    unmounted = true;
    await act(async () =>
      release({
        noteId: "11111111-1111-4111-8111-111111111111",
        memoryEventId: "22222222-2222-4222-8222-222222222222",
        body: "I mostly use Koed for something else."
      })
    );
    expect(proposeOnboardingPreference).not.toHaveBeenCalled();
    expect(readHqOnboarding("owner", "profile").noteId).toBeNull();
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    window.koedDesktop = previous;
    host.remove();
  }
});
