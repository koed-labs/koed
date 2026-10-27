// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PhoneGatewayDesktopApi,
  PhoneGatewayStatusView
} from "../../../ipc/phone-gateway-protocol.js";
import { HqSettingsPhone } from "./HqSettingsPhone.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const off: PhoneGatewayStatusView = {
  enabled: false,
  listening: [],
  error: null,
  phones: [],
  pairing: null
};
const on: PhoneGatewayStatusView = {
  enabled: true,
  listening: ["http://192.168.1.4:47917"],
  error: null,
  phones: [
    {
      id: "6f7c3b2a-6a4f-4d55-9d43-2f3c1b2a1e10",
      name: "Jacobo's iPhone",
      platform: "ios",
      pairedAt: "2026-10-27T10:00:00.000Z",
      lastSeenAt: null,
      push: true,
      connected: true
    }
  ],
  pairing: {
    link: "koed://pair?v=1&s=x",
    code: "482913",
    addresses: ["192.168.1.4:47917"],
    expiresAt: "2026-10-27T10:10:00.000Z"
  }
};

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const render = async (api: PhoneGatewayDesktopApi) => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<HqSettingsPhone api={api} />));
  return host;
};

describe("Settings › Phone", () => {
  it("turns phone access on from the switch", async () => {
    const command = vi.fn(
      async (request: Parameters<PhoneGatewayDesktopApi["command"]>[0]) =>
        request.operation === "enable" ? on : off
    );
    const host = await render({ command, onChange: () => () => undefined });
    const toggle = host.querySelector<HTMLInputElement>(
      'input[role="switch"]'
    )!;
    expect(toggle.checked).toBe(false);
    await act(async () => toggle.click());
    expect(command).toHaveBeenCalledWith({
      operation: "enable",
      enabled: true
    });
  });

  it("shows the typed code, the address and paired phones while pairing", async () => {
    const command = vi.fn(async () => on);
    const host = await render({ command, onChange: () => () => undefined });
    expect(host.textContent).toContain("482 913");
    expect(host.textContent).toContain("192.168.1.4:47917");
    expect(host.textContent).toContain("Jacobo's iPhone");
    expect(host.textContent).toContain("Connected now");
    const remove = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Remove"
    )!;
    await act(async () => remove.click());
    expect(command).toHaveBeenLastCalledWith({
      operation: "revoke",
      phoneId: "6f7c3b2a-6a4f-4d55-9d43-2f3c1b2a1e10"
    });
  });
});
