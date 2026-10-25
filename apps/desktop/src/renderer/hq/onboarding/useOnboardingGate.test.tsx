// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../types.js";
import { useOnboardingGate } from "./useOnboardingGate.js";
import {
  initialHqOnboarding,
  writeHqOnboarding
} from "./onboarding-preference.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const original = Object.getOwnPropertyDescriptor(window, "koedDesktop");
afterEach(() => {
  localStorage.clear();
  if (original) Object.defineProperty(window, "koedDesktop", original);
  else delete window.koedDesktop;
});

it("never requests the maker while a completed canonical profile is loading", async () => {
  let resolve!: (value: { ownerId: string; profileKey: string }) => void;
  const pending = new Promise<{ ownerId: string; profileKey: string }>(
    (done) => {
      resolve = done;
    }
  );
  const invoke = vi.fn(() => pending);
  Object.defineProperty(window, "koedDesktop", {
    configurable: true,
    value: { invoke } as unknown as DesktopApi
  });
  writeHqOnboarding("owner", "canonical", {
    ...initialHqOnboarding,
    chiefName: "Cooper",
    completed: true
  });
  const rendered: string[] = [];
  function Probe({ epoch = "transport-epoch" }: { epoch?: string }) {
    const gate = useOnboardingGate("owner", `backend|${epoch}|`, true);
    const view = gate.loading
      ? "opening"
      : gate.error
        ? "error"
        : gate.record?.completed
          ? "Now"
          : "maker";
    rendered.push(view);
    return <p>{view}</p>;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toBe("opening");
    await act(async () =>
      resolve({ ownerId: "owner", profileKey: "canonical" })
    );
    expect(host.textContent).toBe("Now");
    expect(rendered).not.toContain("maker");
    expect(invoke).toHaveBeenCalledWith("hq_onboarding_identity");
    await act(async () => root.render(<Probe epoch="reconnected" />));
    expect(host.textContent).toBe("Now");
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not apply another owner's completed profile", async () => {
  Object.defineProperty(window, "koedDesktop", {
    configurable: true,
    value: {
      invoke: vi.fn(async () => ({ ownerId: "other", profileKey: "canonical" }))
    } as unknown as DesktopApi
  });
  writeHqOnboarding("other", "canonical", {
    ...initialHqOnboarding,
    completed: true
  });
  function Probe() {
    const gate = useOnboardingGate("owner", "connection", true);
    return <p>{gate.error ?? (gate.loading ? "opening" : "maker")}</p>;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toContain("owner identity changed");
  } finally {
    await act(async () => root.unmount());
  }
});
