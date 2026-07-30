import { parsePersonalDevicePairingLink } from "../personal-device-pairing-link.js";
import { parsePersonalDevicePairingProgress } from "./personal-device-pairing-protocol.js";
import {
  personalDevicePairingLinkChannel,
  personalDevicePairingLinkConsumeChannel,
  personalDevicePairingProgressChannel
} from "./protocol.js";

type Invoke = (channel: string, value?: unknown) => Promise<unknown>;

type PairingLinkEvents = {
  on(channel: string, listener: (event: unknown, value: unknown) => void): void;
  removeListener(
    channel: string,
    listener: (event: unknown, value: unknown) => void
  ): void;
};

export const createPersonalDevicePairingPreloadApi = (
  invoke: Invoke,
  events: PairingLinkEvents
) =>
  Object.freeze({
    async consumePairingLink(expectedUrl?: string) {
      if (expectedUrl !== undefined) {
        parsePersonalDevicePairingLink(expectedUrl);
      }
      const value = await invoke(
        personalDevicePairingLinkConsumeChannel,
        expectedUrl
      );
      if (value === null) return null;
      if (typeof value !== "string") {
        throw new Error("Invalid pending pairing link.");
      }
      parsePersonalDevicePairingLink(value);
      return value;
    },
    subscribePairingLinks(listener: (url: string) => void) {
      if (typeof listener !== "function") {
        throw new TypeError("Pairing link listener is required.");
      }
      let active = true;
      const wrapped = (_event: unknown, value: unknown) => {
        if (!active || typeof value !== "string") return;
        try {
          parsePersonalDevicePairingLink(value);
          listener(value);
        } catch {
          // Main validates deep links too; preload still fails closed.
        }
      };
      events.on(personalDevicePairingLinkChannel, wrapped);
      return () => {
        active = false;
        events.removeListener(personalDevicePairingLinkChannel, wrapped);
      };
    },
    subscribePairingProgress(
      listener: (
        progress: ReturnType<typeof parsePersonalDevicePairingProgress>
      ) => void
    ) {
      if (typeof listener !== "function") {
        throw new TypeError("Pairing progress listener is required.");
      }
      let active = true;
      const wrapped = (_event: unknown, value: unknown) => {
        if (!active) return;
        try {
          listener(parsePersonalDevicePairingProgress(value));
        } catch {
          // Main validates progress too; preload still fails closed.
        }
      };
      events.on(personalDevicePairingProgressChannel, wrapped);
      return () => {
        active = false;
        events.removeListener(personalDevicePairingProgressChannel, wrapped);
      };
    }
  });
