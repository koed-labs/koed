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

export type KinPlacement = "sidebar" | "desktop";
export type KinPresentation = {
  placement: KinPlacement;
  revision: number;
  sidebarPending?: boolean;
};

export type KinActivityBridge = {
  activity: () => Promise<FloatingKinActivityState>;
  summarize: (input: FloatingKinSummaryRequest) => Promise<FloatingKinSummary>;
  cancel: () => Promise<void>;
};

export type KinSurfaceBridge = {
  activity: (revision?: number) => Promise<FloatingKinActivityState>;
  summarize: (
    input: FloatingKinSummaryRequest,
    revision?: number
  ) => Promise<FloatingKinSummary>;
  cancel: (revision?: number) => Promise<void>;
  onPresentation?: (listener: (state: KinPresentation) => void) => () => void;
};

export type DesktopKinBridge = KinSurfaceBridge & {
  setShellVisible: (visible: boolean) => void;
  confirmPresentation: (revision: number) => void;
  onPresentation: (listener: (state: KinPresentation) => void) => () => void;
};

export type FloatingKinBridge = KinSurfaceBridge & {
  completeExit: (revision: number) => void;
  setInteractive: (interactive: boolean) => void;
  setSize: (size: FloatingKinSize) => void;
  drag: (input: FloatingKinDrag) => void;
  onMainWindowFocus: (listener: (focused: boolean) => void) => () => void;
};

export const floatingKinChannels = {
  activity: "koed:floating-kin:activity",
  summarize: "koed:floating-kin:summarize",
  cancel: "koed:floating-kin:cancel",
  setInteractive: "koed:floating-kin:set-interactive",
  setSize: "koed:floating-kin:set-size",
  drag: "koed:floating-kin:drag",
  mainWindowFocused: "koed:floating-kin:main-window-focused",
  mainWindowFocusChanged: "koed:floating-kin:main-window-focus-changed",
  setShellVisible: "koed:floating-kin:set-shell-visible",
  presentation: "koed:floating-kin:presentation",
  confirmPresentation: "koed:floating-kin:confirm-presentation",
  completeExit: "koed:floating-kin:complete-exit",
  presentationChanged: "koed:floating-kin:presentation-changed"
} as const;
