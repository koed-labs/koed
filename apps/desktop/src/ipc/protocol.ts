export const desktopCommandNames = [
  "status",
  "doctor",
  "stop",
  "setup_core",
  "setup_codex",
  "check_codex",
  "repair_codex",
  "remove_codex",
  "setup_pi",
  "check_pi",
  "repair_pi",
  "remove_pi",
  "setup_claude",
  "check_claude",
  "repair_claude",
  "remove_claude",
  "runtime_status",
  "runtime_install",
  "models_status",
  "models_install",
  "package_status",
  "package_install",
  "project_list",
  "personal_sync_status",
  "personal_sync_group_bootstrap",
  "personal_sync_group_activate",
  "personal_sync_pause",
  "personal_sync_resume",
  "personal_sync_retry",
  "personal_sync_join_request",
  "personal_sync_pairing_create",
  "personal_sync_pairing_wait",
  "personal_sync_pairing_approve",
  "personal_sync_pairing_cancel",
  "personal_sync_pairing_redeem",
  "personal_sync_recovery_guidance",
  "personal_sync_revoke",
  "upstream_connect",
  "collaboration",
  "start",
  "start_daemon",
  "open_external",
  "open_logs",
  "onboarding_status",
  "onboarding_complete",
  "setup_inspect",
  "setup_run"
] as const;

export type DesktopCommandName = (typeof desktopCommandNames)[number];

const desktopCommandNameSet = new Set<string>(desktopCommandNames);

export const isDesktopCommandName = (
  value: unknown
): value is DesktopCommandName =>
  typeof value === "string" && desktopCommandNameSet.has(value);

export const desktopRendererOrigin = (value: string): string => {
  const parsed = new URL(value);
  return parsed.protocol === "koed:"
    ? `${parsed.protocol}//${parsed.host}`
    : parsed.origin;
};

export const collaborationCommandChannel = "koed:collaboration:command";
export const collaborationEventChannel = "koed:collaboration:event";
export const clipboardWriteChannel = "koed:clipboard:write";
export const themePreferenceGetChannel = "koed:theme-preference:get";
export const themePreferenceSetChannel = "koed:theme-preference:set";
export const personalMemoryCommandChannel = "koed:personal-memory:command";
export const personalMemoryEventChannel = "koed:personal-memory:event";
export { localAiClientCommandChannel } from "./local-ai-client-protocol.js";
export const personalDevicePairingLinkChannel =
  "koed:personal-device-pairing:link";
export const personalDevicePairingLinkConsumeChannel =
  "koed:personal-device-pairing:link:consume";
export const personalDevicePairingProgressChannel =
  "koed:personal-device-pairing:progress";
export { managedConversationCommandChannel } from "./managed-conversation-protocol.js";
export const setupCommandChannel = "koed:setup:command";
export const setupProgressEventChannel = "koed:setup:progress";
