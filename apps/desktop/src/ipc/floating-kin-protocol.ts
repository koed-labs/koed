import type {
  FloatingKinActivity,
  FloatingKinSummary,
  FloatingKinSummaryRequest
} from "@koed-labs/shared";

export type FloatingKinActivityState =
  | { state: "stopped" | "starting" | "unavailable" | "signed_out" }
  | ({ state: "running" } & FloatingKinActivity);

export type FloatingKinSize = { width: number; height: number };

export type FloatingKinBridge = {
  activity: () => Promise<FloatingKinActivityState>;
  summarize: (input: FloatingKinSummaryRequest) => Promise<FloatingKinSummary>;
  cancel: () => Promise<void>;
  setInteractive: (interactive: boolean) => void;
  setSize: (size: FloatingKinSize) => void;
};

export const floatingKinChannels = {
  activity: "koed:floating-kin:activity",
  summarize: "koed:floating-kin:summarize",
  cancel: "koed:floating-kin:cancel",
  setInteractive: "koed:floating-kin:set-interactive",
  setSize: "koed:floating-kin:set-size"
} as const;
