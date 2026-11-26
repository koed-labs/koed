import type {
  FloatingKinActivity,
  FloatingKinPreview,
  FloatingKinPreviewRequest,
  FloatingKinSummary,
  FloatingKinSummaryLatest,
  FloatingKinSummaryOpen,
  FloatingKinSummaryRequest,
  FloatingKinSummaryTarget
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

export type KinSummaryTarget = FloatingKinSummaryTarget;
export type KinLatestSummary = FloatingKinSummaryLatest;
export type KinReopenedSummary = FloatingKinSummaryOpen;

export type KinActivityBridge = {
  activity: () => Promise<FloatingKinActivityState>;
  preview: (input: FloatingKinPreviewRequest) => Promise<FloatingKinPreview>;
  summarize: (input: FloatingKinSummaryRequest) => Promise<FloatingKinSummary>;
  latest: (target: KinSummaryTarget) => Promise<KinLatestSummary>;
  reopen: (target: KinSummaryTarget) => Promise<KinReopenedSummary>;
  cancel: () => Promise<void>;
};

export type KinSurfaceBridge = {
  activity: (revision?: number) => Promise<FloatingKinActivityState>;
  preview: (
    input: FloatingKinPreviewRequest,
    revision?: number
  ) => Promise<FloatingKinPreview>;
  summarize: (
    input: FloatingKinSummaryRequest,
    revision?: number
  ) => Promise<FloatingKinSummary>;
  latest: (
    target: KinSummaryTarget,
    revision?: number
  ) => Promise<KinLatestSummary>;
  reopen: (
    target: KinSummaryTarget,
    revision?: number
  ) => Promise<KinReopenedSummary>;
  cancel: (revision?: number) => Promise<void>;
  onPresentation?: (listener: (state: KinPresentation) => void) => () => void;
};

export type DesktopKinBridge = KinSurfaceBridge & {
  setShellVisible: (visible: boolean) => void;
  confirmPresentation: (revision: number) => void;
  onOpenAiModels: (listener: () => void) => () => void;
  onOpenConversation: (listener: (sessionId: string) => void) => () => void;
  onPresentation: (listener: (state: KinPresentation) => void) => () => void;
};

export type FloatingKinBridge = KinSurfaceBridge & {
  completeExit: (revision: number) => void;
  openDesktop: (revision: number) => void;
  openAiModels: (revision: number) => void;
  openConversation: (revision: number, sessionId: string) => void;
  setInteractive: (interactive: boolean) => void;
  setSize: (size: FloatingKinSize) => void;
  drag: (input: FloatingKinDrag) => void;
  onMainWindowFocus: (listener: (focused: boolean) => void) => () => void;
};

export const floatingKinChannels = {
  activity: "koed:floating-kin:activity",
  preview: "koed:floating-kin:preview",
  summarize: "koed:floating-kin:summarize",
  latest: "koed:floating-kin:latest-summary",
  reopen: "koed:floating-kin:reopen-summary",
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
  openDesktop: "koed:floating-kin:open-desktop",
  openAiModels: "koed:floating-kin:open-ai-models",
  showAiModels: "koed:floating-kin:show-ai-models",
  openConversation: "koed:floating-kin:open-conversation",
  showConversation: "koed:floating-kin:show-conversation",
  presentationChanged: "koed:floating-kin:presentation-changed"
} as const;
