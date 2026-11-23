// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi } from "vitest";
import type { FloatingKinBridge } from "../../ipc/floating-kin-protocol.js";

it("boots the Floating Kin hash route without initializing Desktop services", async () => {
  const stage = document.createElement("div");
  stage.id = "app";
  document.body.append(stage);
  const invoke = vi.fn(async () => ({ complete: false }));
  const activity = vi.fn(async () => ({ state: "stopped" as const }));
  const bridge: FloatingKinBridge = {
    activity,
    summarize: vi.fn(),
    preview: vi.fn(async () => null),
    latest: vi.fn(),
    reopen: vi.fn(),
    openAiModels: vi.fn(),
    cancel: vi.fn(),
    completeExit: vi.fn(),
    openDesktop: vi.fn(),
    setSize: vi.fn(),
    setInteractive: vi.fn(),
    drag: vi.fn(),
    onMainWindowFocus: vi.fn(() => () => {})
  };
  window.location.hash = "floating-kin";
  vi.stubGlobal("floatingKin", bridge);
  vi.stubGlobal("koedDesktop", { invoke });
  try {
    await act(async () => {
      await import("../main.js");
    });
    await vi.waitFor(() =>
      expect(stage.textContent).toContain("Local runtime stopped")
    );
    expect(activity).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    stage.remove();
    window.location.hash = "";
    vi.unstubAllGlobals();
  }
});
