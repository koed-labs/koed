// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(async () => "data:image/png;base64,cXItY29kZQ==")
  }
}));

import { DevicesModal } from "./DevicesModal.js";

const pairing = {
  id: "11111111-2222-4333-8444-555555555555",
  url: "http://192.168.1.2:3310/pair/11111111-2222-4333-8444-555555555555#token=abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
  expiresAt: "2099-07-28T12:00:00.000Z",
  state: "waiting" as const,
  joiningDeviceLabel: null
};

const status = {
  local_device_id: "device-1",
  pairing_invitation_group_ids: ["group-1"],
  groups: [
    {
      group_id: "group-1",
      members: [{ device_id: "device-1", status: "active" }],
      policy: { enabled: true }
    }
  ]
};

const click = async (element: Element | null) => {
  expect(element).not.toBeNull();
  await act(async () => {
    (element as HTMLElement).click();
    await Promise.resolve();
  });
};

describe("Devices modal", () => {
  let container: HTMLDivElement;
  let root: Root;
  let pairingProgressListener:
    | ((progress: {
        requestId: string;
        state: "connecting" | "completed";
      }) => void)
    | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: {
        clipboard: { writeText: vi.fn(async () => undefined) },
        devices: {
          subscribePairingProgress: vi.fn((listener) => {
            pairingProgressListener = listener;
            return () => {
              pairingProgressListener = undefined;
            };
          })
        }
      }
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("offers request-link review on the existing Electron device", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "personal_sync_status") return status;
      throw new Error(`Unexpected command ${command}`);
    });
    await act(async () => {
      root.render(<DevicesModal invoke={invoke as never} onClose={vi.fn()} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("This device");
    expect(container.textContent).toContain("No other devices connected yet");
    await click(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Add device")
      ) ?? null
    );
    expect(container.textContent).toContain("koed-server pair");
    expect(
      container.querySelector('input[aria-label="Device request link"]')
    ).not.toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      "personal_sync_pairing_create",
      expect.anything()
    );
  });

  it("accepts a pasted or deep-linked invitation without polling", async () => {
    let completeJoin: (() => void) | undefined;
    const onPairingLinkConsumed = vi.fn();
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "personal_sync_status") return status;
        if (command === "personal_sync_pairing_redeem") {
          expect(args?.url).toBe(pairing.url);
          pairingProgressListener?.({
            requestId: String(args?.requestId),
            state: "connecting"
          });
          return await new Promise((resolve) => {
            completeJoin = () => resolve({ ok: true });
          });
        }
        throw new Error(`Unexpected command ${command}`);
      }
    );
    await act(async () => {
      root.render(
        <DevicesModal
          initialPairingLink={pairing.url}
          invoke={invoke as never}
          onClose={vi.fn()}
          onPairingLinkConsumed={onPairingLinkConsumed}
        />
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Join your existing devices");
    expect(onPairingLinkConsumed).toHaveBeenCalledOnce();
    await click(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Connect device")
      ) ?? null
    );
    expect(container.textContent).toContain(
      "Connecting to your existing devices"
    );
    expect(container.textContent).not.toContain("short code");
    expect(invoke).toHaveBeenCalledWith(
      "personal_sync_pairing_redeem",
      expect.objectContaining({
        url: pairing.url,
        requestId: expect.any(String)
      })
    );
    await act(async () => {
      completeJoin?.();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Your Personal devices");
  });

  it("does not offer an authority-hosted invitation from a joined replica", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "personal_sync_status") {
        return { ...status, pairing_invitation_group_ids: [] };
      }
      throw new Error(`Unexpected command ${command}`);
    });
    await act(async () => {
      root.render(<DevicesModal invoke={invoke as never} onClose={vi.fn()} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "Add devices from the installation that originally created this Personal Device Group."
    );
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Add device"
      )
    ).toBe(false);
    expect(container.textContent).not.toContain("Join with link");
  });

  it("shows pairing failures without Electron IPC transport wording", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "personal_sync_status") return status;
      if (command === "personal_sync_pairing_redeem") {
        throw new Error(
          "Error invoking remote method 'koed:invoke': Error: Same-network pairing requires a private-network or Tailscale link issued by Koed."
        );
      }
      throw new Error(`Unexpected command ${command}`);
    });
    await act(async () => {
      root.render(
        <DevicesModal
          initialPairingLink="https://example.com/not-private"
          invoke={invoke as never}
          onClose={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    await click(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Connect device")
      ) ?? null
    );

    expect(container.textContent).toContain(
      "Same-network pairing requires a private-network or Tailscale link issued by Koed."
    );
    expect(container.textContent).not.toContain("remote method");

    await click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Back"
      ) ?? null
    );
    expect(container.textContent).not.toContain(
      "Same-network pairing requires a private-network link issued by Koed."
    );
  });

  it("creates the first device group without a recovery download or code", async () => {
    let configured = false;
    const invoke = vi.fn(async (command: string) => {
      if (command === "personal_sync_status")
        return configured ? status : { groups: [] };
      if (command === "personal_sync_group_bootstrap") {
        configured = true;
        return { ok: true, state: "active" };
      }
      throw new Error(`Unexpected command ${command}`);
    });
    await act(async () => {
      root.render(<DevicesModal invoke={invoke as never} onClose={vi.fn()} />);
      await Promise.resolve();
    });
    await click(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Set up device sync")
      ) ?? null
    );
    expect(invoke).toHaveBeenCalledWith("personal_sync_group_bootstrap");
    expect(container.textContent).not.toContain("recovery");
    expect(container.textContent).toContain("Add device");
  });
});
