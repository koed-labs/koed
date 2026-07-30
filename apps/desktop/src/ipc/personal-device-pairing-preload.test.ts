import { describe, expect, it, vi } from "vitest";
import { createPersonalDevicePairingPreloadApi } from "./personal-device-pairing-preload.js";
import {
  PERSONAL_DEVICE_PAIRING_PROGRESS_VERSION,
  type PersonalDevicePairingProgress
} from "./personal-device-pairing-protocol.js";
import {
  personalDevicePairingLinkChannel,
  personalDevicePairingLinkConsumeChannel,
  personalDevicePairingProgressChannel
} from "./protocol.js";

const invitationId = "11111111-2222-4333-8444-555555555555";
const token = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
const link = `http://192.168.1.20:3310/pair/${invitationId}#token=${token}`;

describe("Personal Device pairing preload bridge", () => {
  it("delivers only validated private-network links and unsubscribes exactly", () => {
    let wrapped: ((event: unknown, value: unknown) => void) | undefined;
    const events = {
      on: vi.fn((_channel, listener) => {
        wrapped = listener;
      }),
      removeListener: vi.fn()
    };
    const listener = vi.fn();
    const api = createPersonalDevicePairingPreloadApi(vi.fn(), events);
    const unsubscribe = api.subscribePairingLinks(listener);

    expect(events.on).toHaveBeenCalledWith(
      personalDevicePairingLinkChannel,
      expect.any(Function)
    );
    wrapped?.({}, link);
    wrapped?.({}, `https://example.com/pair/${invitationId}#token=${token}`);
    wrapped?.({}, { url: link });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(link);

    unsubscribe();
    wrapped?.({}, link);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(events.removeListener).toHaveBeenCalledWith(
      personalDevicePairingLinkChannel,
      wrapped
    );
  });

  it("requires a listener", () => {
    const api = createPersonalDevicePairingPreloadApi(vi.fn(), {
      on: vi.fn(),
      removeListener: vi.fn()
    });
    expect(() => api.subscribePairingLinks(null as never)).toThrow(
      "listener is required"
    );
    expect(() => api.subscribePairingProgress(null as never)).toThrow(
      "listener is required"
    );
  });

  it("delivers only exact, validated and correlated progress events", () => {
    let wrapped: ((event: unknown, value: unknown) => void) | undefined;
    const events = {
      on: vi.fn((_channel, listener) => {
        wrapped = listener;
      }),
      removeListener: vi.fn()
    };
    const listener = vi.fn();
    const api = createPersonalDevicePairingPreloadApi(vi.fn(), events);
    const unsubscribe = api.subscribePairingProgress(listener);
    const progress: PersonalDevicePairingProgress = {
      contractVersion: PERSONAL_DEVICE_PAIRING_PROGRESS_VERSION,
      requestId: invitationId,
      state: "approval_pending",
      shortCode: "A1B2C3D4"
    };

    expect(events.on).toHaveBeenCalledWith(
      personalDevicePairingProgressChannel,
      expect.any(Function)
    );
    wrapped?.({}, progress);
    wrapped?.({}, { ...progress, token });
    wrapped?.({}, { ...progress, shortCode: "invalid" });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(progress);

    unsubscribe();
    wrapped?.({}, progress);
    expect(listener).toHaveBeenCalledOnce();
    expect(events.removeListener).toHaveBeenCalledWith(
      personalDevicePairingProgressChannel,
      wrapped
    );
  });

  it("consumes and validates a retained pairing link", async () => {
    const invoke = vi.fn().mockResolvedValue(link);
    const api = createPersonalDevicePairingPreloadApi(invoke, {
      on: vi.fn(),
      removeListener: vi.fn()
    });

    await expect(api.consumePairingLink()).resolves.toBe(link);
    expect(invoke).toHaveBeenCalledWith(
      personalDevicePairingLinkConsumeChannel,
      undefined
    );

    invoke.mockResolvedValueOnce(null);
    await expect(api.consumePairingLink(link)).resolves.toBeNull();
    await expect(
      api.consumePairingLink(
        `https://example.com/pair/${invitationId}#token=${token}`
      )
    ).rejects.toThrow();

    invoke.mockResolvedValueOnce("malformed");
    await expect(api.consumePairingLink()).rejects.toThrow(
      "Pairing link is invalid"
    );
  });
});
