export const desktopCommandNames = [
  "status",
  "doctor",
  "stop",
  "setup_codex",
  "repair_codex",
  "runtime_status",
  "runtime_install",
  "models_status",
  "models_install",
  "package_status",
  "package_install",
  "project_list",
  "upstream_connect",
  "collaboration",
  "start",
  "start_daemon",
  "open_external",
  "open_logs",
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
export const setupCommandChannel = "koed:setup:command";
export const setupProgressEventChannel = "koed:setup:progress";
