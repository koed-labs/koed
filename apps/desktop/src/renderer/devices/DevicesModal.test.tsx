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
  shortCode: "A1B2C3D4",
  expiresAt: "2099-07-28T12:00:00.000Z",
  state: "waiting" as const,
  joiningDeviceLabel: null
};

const status = {
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
        state: "approval_pending";
        shortCode: string;
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

  it("lists active devices and creates a QR/copyable one-time invitation", async () => {
    let releaseWait: ((value: unknown) => void) | undefined;
    let releaseApproval: ((value: unknown) => void) | undefined;
    const invoke = vi.fn(async (command: string) => {
      if (command === "personal_sync_status") return status;
      if (command === "personal_sync_pairing_create") {
        return { ok: true, pairing };
      }
      if (command === "personal_sync_pairing_wait") {
        return await new Promise((resolve) => {
          releaseWait = resolve;
        });
      }
      if (command === "personal_sync_pairing_approve") {
        return await new Promise((resolve) => {
          releaseApproval = resolve;
        });
      }
      throw new Error(`Unexpected command ${command}`);
    });
    await act(async () => {
      root.render(<DevicesModal invoke={invoke as never} onClose={vi.fn()} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Device 1");
    await click(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Pair another device")
      ) ?? null
    );
    expect(container.textContent).toContain("A1B2C3D4");
    expect(container.querySelector('img[alt*="Scan to pair"]')).not.toBeNull();
    expect(
      (container.querySelector("input[readonly]") as HTMLInputElement).value
    ).toBe(pairing.url);

    await click(
      container.querySelector('button[aria-label="Copy pairing link"]')
    );
    expect(
      window.koedDesktop?.clipboard?.writeText as ReturnType<typeof vi.fn>
    ).toHaveBeenCalledWith(pairing.url);

    await act(async () => {
      releaseWait?.({
        pairing: {
          ...pairing,
          state: "approval_required",
          joiningDeviceLabel: "Second laptop"
        }
      });
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Second laptop wants to connect");
    expect(container.textContent).toContain("Approve device");

    await click(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Approve device")
      ) ?? null
    );
    expect(
      (
        container.querySelector(
          'button[aria-label="Close Devices"]'
        ) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Cancel")
        ?.hasAttribute("disabled")
    ).toBe(true);
    await act(async () => {
      releaseApproval?.({
        state: "completed",
        pairing: { ...pairing, state: "completed" }
      });
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Your Personal devices");
  });

  it("accepts a pasted or deep-linked invitation without polling", async () => {
    let completeJoin: (() => void) | undefined;
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "personal_sync_status") return status;
        if (command === "personal_sync_pairing_redeem") {
          expect(args?.url).toBe(pairing.url);
          pairingProgressListener?.({
            requestId: String(args?.requestId),
            state: "approval_pending",
            shortCode: pairing.shortCode
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
        />
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Join your existing devices");
    await click(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Connect device")
      ) ?? null
    );
    expect(container.textContent).toContain(pairing.shortCode);
    expect(container.textContent).toContain(
      "Confirm that this code matches the connected device"
    );
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
      "Create the next pairing link on the device that originally set up this Personal Device Group."
    );
    expect(container.textContent).not.toContain("Pair another device");
    expect(container.textContent).not.toContain("Join with link");
  });

  it("shows pairing failures without Electron IPC transport wording", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "personal_sync_status") return status;
      if (command === "personal_sync_pairing_redeem") {
        throw new Error(
          "Error invoking remote method 'koed:invoke': Error: Same-network pairing requires a private-network link issued by Koed."
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
      "Same-network pairing requires a private-network link issued by Koed."
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

  it("creates the first device group and requires recovery confirmation", async () => {
    const recoveryCode = "test-recovery-code";
    const recoveryKitPath = "/home/user/Documents/koed-recovery-kit.json";
    let configured = false;
    const invoke = vi.fn(async (command: string) => {
      if (command === "personal_sync_status") {
        return configured ? status : { groups: [] };
      }
      if (command === "personal_sync_group_bootstrap") {
        configured = true;
        return {
          ok: true,
          state: "active",
          recoveryCode,
          recoveryKitPath
        };
      }
      if (command === "personal_sync_group_activate") {
        return { ok: true, state: "healthy" };
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
    expect(container.textContent).toContain("Save your recovery code");
    expect(container.textContent).toContain(recoveryKitPath);
    const recoveryCodeInput = container.querySelector(
      'input[aria-label="Recovery code"]'
    ) as HTMLInputElement;
    expect(recoveryCodeInput.value).toBe(recoveryCode);
    expect(recoveryCodeInput.readOnly).toBe(true);
    expect(recoveryCodeInput.autocomplete).toBe("off");
    expect(recoveryCodeInput.getAttribute("spellcheck")).toBe("false");
    expect(
      (
        container.querySelector(
          'button[aria-label="Close Devices"]'
        ) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    await click(
      container.querySelector('button[aria-label="Copy recovery code"]')
    );
    expect(
      window.koedDesktop?.clipboard?.writeText as ReturnType<typeof vi.fn>
    ).toHaveBeenCalledWith(recoveryCode);

    const confirmation = container.querySelector(
      'input[type="checkbox"]'
    ) as HTMLInputElement;
    await act(async () => {
      confirmation.click();
      await Promise.resolve();
    });
    await click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Done"
      ) ?? null
    );
    expect(invoke).toHaveBeenCalledWith("personal_sync_group_activate");
    expect(container.textContent).toContain("Device 1");
  });
});
