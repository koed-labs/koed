// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceRequestPanel } from "./DeviceRequestPanel.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
describe("device request UI", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  it("shows a joining Electron link and waits for durable completion", async () => {
    vi.useFakeTimers();
    const request = {
      id: "request",
      label: "Desktop",
      state: "waiting",
      link: "http://192.168.0.2:3311/device-request/test#token=secret",
      expiresAt: "2099-01-01T00:00:00.000Z"
    };
    let state = "waiting";
    const invoke = vi.fn(async (command: string) =>
      command === "personal_sync_request_create"
        ? request
        : { ...request, link: undefined, state }
    );
    const onConnected = vi.fn();
    await act(async () =>
      root.render(
        <DeviceRequestPanel
          mode="join"
          invoke={invoke as never}
          onBack={vi.fn()}
          onConnected={onConnected}
        />
      )
    );
    expect((container.querySelector("input") as HTMLInputElement).value).toBe(
      request.link
    );
    expect(container.textContent).toContain("Waiting for approval");
    state = "connecting";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(container.querySelector("input")).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
    state = "connected";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onConnected).toHaveBeenCalledOnce();
  });
  it("does not accept a device just by opening Add device", async () => {
    const invoke = vi.fn();
    await act(async () =>
      root.render(
        <DeviceRequestPanel
          mode="add"
          invoke={invoke}
          onBack={vi.fn()}
          onConnected={vi.fn()}
        />
      )
    );
    expect(container.textContent).toContain("koed-server pair");
    expect(invoke).not.toHaveBeenCalled();
    expect(
      (
        container.querySelector(
          "button.device-primary-button"
        ) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });
  it("reports request creation failures without inventing a connection", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("Start Koed before connecting this device.");
    });
    const connected = vi.fn();
    await act(async () =>
      root.render(
        <DeviceRequestPanel
          mode="join"
          invoke={invoke}
          onBack={vi.fn()}
          onConnected={connected}
        />
      )
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Start Koed"
    );
    expect(connected).not.toHaveBeenCalled();
  });
});
