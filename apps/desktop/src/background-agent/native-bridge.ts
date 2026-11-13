import type { BackgroundAgentNativeBridge } from "./xpc-transport.js";

export type NativeAgentAddon = BackgroundAgentNativeBridge & { teamId: string };

export type NativeAgentBridgeResult =
  | { available: true; bridge: NativeAgentAddon; teamId: string }
  | {
      available: false;
      reason:
        | "unsupported-platform"
        | "unpackaged-app"
        | "missing-team-id"
        | "native-addon-load-failed"
        | "invalid-native-bridge";
    };

export const loadBackgroundAgentNativeBridge = (input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  loadAddon: () => unknown;
}): NativeAgentBridgeResult => {
  if (input.platform !== "darwin")
    return { available: false, reason: "unsupported-platform" };
  if (!input.isPackaged) return { available: false, reason: "unpackaged-app" };
  let addon: unknown;
  try {
    addon = input.loadAddon();
  } catch {
    return { available: false, reason: "native-addon-load-failed" };
  }
  if (!isNativeAgentAddon(addon))
    return { available: false, reason: "invalid-native-bridge" };
  if (!/^[A-Z0-9]{10}$/u.test(addon.teamId))
    return { available: false, reason: "missing-team-id" };
  return { available: true, bridge: addon, teamId: addon.teamId };
};

const isNativeAgentAddon = (value: unknown): value is NativeAgentAddon => {
  if (!value || typeof value !== "object") return false;
  const addon = value as Partial<NativeAgentAddon>;
  return (
    typeof addon.connect === "function" &&
    typeof addon.listen === "function" &&
    typeof addon.teamId === "string"
  );
};
