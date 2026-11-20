import type {
  FloatingKinActivity,
  FloatingKinSummary,
  FloatingKinSummaryRequest
} from "@koed-labs/shared";

export type FloatingKinActivityState =
  | { state: "stopped" | "starting" | "unavailable" | "signed_out" }
  | ({ state: "running" } & FloatingKinActivity);

export type FloatingKinSize = { width: number; height: number };
export type FloatingKinDrag =
  | { phase: "start" | "move"; x: number; y: number }
  | { phase: "end" };

export type FloatingKinBridge = {
  activity: () => Promise<FloatingKinActivityState>;
  summarize: (input: FloatingKinSummaryRequest) => Promise<FloatingKinSummary>;
  cancel: () => Promise<void>;
  setInteractive: (interactive: boolean) => void;
  setSize: (size: FloatingKinSize) => void;
  drag: (input: FloatingKinDrag) => void;
};

export const floatingKinChannels = {
  activity: "koed:floating-kin:activity",
  summarize: "koed:floating-kin:summarize",
  cancel: "koed:floating-kin:cancel",
  setInteractive: "koed:floating-kin:set-interactive",
  setSize: "koed:floating-kin:set-size",
  drag: "koed:floating-kin:drag"
} as const;
