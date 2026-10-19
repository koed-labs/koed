import type {
  AiClientPermissionMode,
  ManagedConversationSettingsChange
} from "@koed/shared/ai-client-contract";
import type { ManagedConversationLaunchOptions } from "../../../ipc/managed-conversation-protocol.js";

export type HqSelection = {
  instanceId: string;
  model: string;
  reasoningEffort: string;
  permissionMode: AiClientPermissionMode | "";
};

export const hqPermissionLabel: Record<AiClientPermissionMode, string> = {
  supervised: "Ask first",
  auto_edit: "Auto-accept edits",
  auto: "Auto",
  full_access: "Full access"
};

export const hqReasoningLabel = (effort: string): string =>
  effort === "xhigh"
    ? "Extra high"
    : effort
      ? effort.charAt(0).toUpperCase() + effort.slice(1)
      : "Default";

export const hqReasoningHeat = (index: number, count: number): number =>
  count <= 1 ? 1 : Math.floor(1 + (index * 3) / (count - 1));

export function hqSelectionForInstance(
  options: ManagedConversationLaunchOptions,
  instanceId: string
): HqSelection {
  const instance = options.instances.find(
    (candidate) => candidate.instanceId === instanceId
  );
  const model =
    instance?.models.find((candidate) => candidate.isDefault) ??
    instance?.models[0];
  const supported =
    instance?.capabilities.permissionModes.filter(
      (mode) => mode.support === "supported"
    ) ?? [];
  return {
    instanceId,
    model: model?.id ?? "",
    reasoningEffort:
      model?.defaultReasoningEffort ??
      model?.supportedReasoningEfforts[0] ??
      "",
    // HQ/Now may start only with the accepted Ask first default. Do not
    // silently substitute the AI Client's broader default.
    permissionMode: supported.some(({ mode }) => mode === "supervised")
      ? "supervised"
      : ""
  };
}

export function hqSelectionIsSupported(
  options: ManagedConversationLaunchOptions | null,
  selection: HqSelection
): boolean {
  const instance = options?.instances.find(
    (candidate) => candidate.instanceId === selection.instanceId
  );
  const model = instance?.models.find(
    (candidate) => candidate.id === selection.model
  );
  return Boolean(
    instance?.ready &&
    model &&
    selection.permissionMode &&
    instance.capabilities.permissionModes.some(
      ({ mode, support }) =>
        mode === selection.permissionMode && support === "supported"
    ) &&
    (!selection.reasoningEffort ||
      model.supportedReasoningEfforts.includes(selection.reasoningEffort))
  );
}

export function hqSettingsChange(
  expected: ManagedConversationSettingsChange["expected"] | null,
  selection: HqSelection
): ManagedConversationSettingsChange | null {
  if (!expected || !selection.permissionMode) return null;
  const next = {
    model: selection.model,
    reasoningEffort: selection.reasoningEffort || null,
    permissionMode: selection.permissionMode
  };
  return JSON.stringify(expected) === JSON.stringify(next)
    ? null
    : { expected, next };
}
