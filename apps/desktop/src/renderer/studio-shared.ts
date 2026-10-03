// Browser-only entry point for Studio to reuse the existing Desktop controls.
export { SetupChecklist } from "./views/onboarding/SetupChecklist.js";
export { LocalAiClientSettingsSection } from "./views/preferences/LocalAiClientSettingsSection.js";
export { DevicesModal } from "./devices/DevicesModal.js";
export { DesktopStatusStore } from "./services/desktop-commands.js";
export { useDesktopStatus } from "./state/use-status.js";
export { ToastProvider, useToast } from "@koed/ui";
export type { ToastInput, ToastTone } from "@koed/ui";
