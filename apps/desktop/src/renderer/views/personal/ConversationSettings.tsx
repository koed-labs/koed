import { useState } from "react";
import type { LocalAiClientAssignment } from "../../../ipc/local-ai-client-protocol.js";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Shield
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPopup,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from "@koed/ui";
import type { ManagedConversationLaunchOptions } from "../../../ipc/managed-conversation-protocol.js";
import type {
  AiClientPermissionMode,
  SupportedAiClientDriverId
} from "@koed/shared/ai-client-contract";
import { AiClientLogo } from "./AiClientLogo.js";
import "./conversation-settings.css";

export type ConversationSelection = {
  instanceId: string;
  model: string;
  reasoningEffort: string;
  permissionMode: AiClientPermissionMode | "";
};

export const permissionLabels: Record<AiClientPermissionMode, string> = {
  supervised: "Supervised",
  auto_edit: "Auto-accept edits",
  auto: "Auto",
  full_access: "Full access"
};
const permissionDescriptions: Record<AiClientPermissionMode, string> = {
  supervised: "Ask before actions that need approval.",
  auto_edit: "Allow edits; ask for other actions as needed.",
  auto: "Use the AI Client’s automatic approval mode.",
  full_access: "Allow actions without approval prompts."
};
export const reasoningLabel = (value: string) =>
  ({
    none: "Default",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Maximum"
  })[value] ?? value;

export const selectionForInstance = (
  options: ManagedConversationLaunchOptions,
  instanceId: string
): ConversationSelection => {
  const instance = options.instances.find(
    (candidate) => candidate.instanceId === instanceId
  );
  const model =
    instance?.models.find((candidate) => candidate.isDefault) ??
    instance?.models[0];
  const modes =
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
    permissionMode:
      modes.find(
        (mode) => mode.mode === instance?.capabilities.defaultPermissionMode
      )?.mode ??
      modes[0]?.mode ??
      ""
  };
};

export const selectionForAssignment = (
  options: ManagedConversationLaunchOptions,
  assignment: LocalAiClientAssignment
): ConversationSelection => {
  const selection = selectionForInstance(
    options,
    assignment.ai_client_instance_id
  );
  const model = options.instances
    .find(
      (instance) => instance.instanceId === assignment.ai_client_instance_id
    )
    ?.models.find((candidate) => candidate.id === assignment.model);
  return {
    ...selection,
    model: model?.id ?? assignment.model,
    reasoningEffort:
      assignment.reasoning_effort === "none" &&
      model?.supportedReasoningEfforts.length === 0
        ? ""
        : assignment.reasoning_effort
  };
};

export function ConversationSettings({
  options,
  selection,
  onChange,
  clientLocked = false,
  disabledReason,
  clientLabel,
  clientProvider,
  onOpen
}: {
  options: ManagedConversationLaunchOptions | null;
  selection: ConversationSelection;
  onChange: (selection: ConversationSelection) => void;
  clientLocked?: boolean;
  disabledReason?: string;
  clientLabel?: string;
  clientProvider?: SupportedAiClientDriverId;
  onOpen?: () => void;
}) {
  const [modelView, setModelView] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const instance = options?.instances.find(
    (candidate) => candidate.instanceId === selection.instanceId
  );
  const model = instance?.models.find(
    (candidate) => candidate.id === selection.model
  );
  const blocked = Boolean(disabledReason) || !instance?.ready;
  const reason =
    disabledReason ??
    (!instance?.ready
      ? "This AI Client is unavailable. Refresh its status in Preferences."
      : undefined);
  const permissions = instance?.capabilities.permissionModes ?? [];
  const currentPermission = selection.permissionMode
    ? permissionLabels[selection.permissionMode]
    : options
      ? "Permissions unavailable"
      : "Permissions";
  const modelLabel = (model?.displayName ?? selection.model) || "Select model";
  const provider = instance?.driverId ?? clientProvider;
  const open = (value: boolean) => {
    if (value) onOpen?.();
  };
  return (
    <div className="conversation-settings">
      <div className="conversation-permission-control">
        <DropdownMenu onOpenChange={open}>
          <DropdownMenuTrigger
            className="conversation-setting-trigger"
            aria-label={`Permissions: ${currentPermission}`}
          >
            <Shield aria-hidden="true" />
            <span>{currentPermission}</span>
            <ChevronDown aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuPopup
            side="top"
            align="start"
            className="conversation-settings-popup"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Permissions</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={selection.permissionMode}
                onValueChange={(value) =>
                  onChange({
                    ...selection,
                    permissionMode: value as AiClientPermissionMode
                  })
                }
              >
                {permissions.map(({ mode, support }) => (
                  <DropdownMenuRadioItem
                    className="conversation-setting-option"
                    key={mode}
                    value={mode}
                    disabled={blocked || support !== "supported"}
                  >
                    <span>
                      {permissionLabels[mode]}
                      <small>
                        {support === "supported"
                          ? permissionDescriptions[mode]
                          : "Unavailable for this AI Client"}
                      </small>
                    </span>
                    {selection.permissionMode === mode && (
                      <Check aria-hidden="true" />
                    )}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            {reason && (
              <p className="conversation-settings-explanation">{reason}</p>
            )}
          </DropdownMenuPopup>
        </DropdownMenu>
      </div>
      <div className="conversation-model-controls">
        <DropdownMenu onOpenChange={open}>
          <DropdownMenuTrigger
            className="conversation-setting-trigger"
            aria-label={`AI Client: ${instance?.displayName ?? clientLabel ?? "Unavailable"}`}
          >
            {provider ? (
              <span
                aria-hidden="true"
                className="conversation-ai-client-logo"
                data-client={provider}
              >
                <AiClientLogo id={provider} />
              </span>
            ) : null}
            <span>{instance?.displayName ?? clientLabel ?? "AI Client"}</span>
            <ChevronDown aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuPopup
            side="top"
            align="end"
            className="conversation-settings-popup"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>AI Client</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={selection.instanceId}
                onValueChange={(value) => {
                  if (options)
                    onChange(selectionForInstance(options, String(value)));
                }}
              >
                {options?.instances.map((candidate) => (
                  <DropdownMenuRadioItem
                    className="conversation-setting-option"
                    key={candidate.instanceId}
                    value={candidate.instanceId}
                    disabled={
                      clientLocked ||
                      Boolean(disabledReason) ||
                      !candidate.ready ||
                      !candidate.models.length
                    }
                  >
                    <span>
                      {candidate.displayName}
                      {!candidate.ready && (
                        <small>
                          {candidate.readiness.replaceAll("_", " ")}
                        </small>
                      )}
                    </span>
                    {candidate.instanceId === selection.instanceId && (
                      <Check aria-hidden="true" />
                    )}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            {(clientLocked || !options || reason) && (
              <p className="conversation-settings-explanation">
                {clientLocked
                  ? "Start a new Conversation to change AI Client."
                  : (reason ?? "AI Clients are unavailable.")}
              </p>
            )}
          </DropdownMenuPopup>
        </DropdownMenu>
        <DropdownMenu
          open={modelOpen}
          onOpenChange={(value) => {
            setModelOpen(value);
            setModelView(false);
            open(value);
          }}
        >
          <DropdownMenuTrigger
            className="conversation-setting-trigger"
            aria-label={`Model and reasoning: ${modelLabel}${selection.reasoningEffort ? `, ${reasoningLabel(selection.reasoningEffort)}` : ""}`}
          >
            <span>
              {modelLabel}
              {selection.reasoningEffort &&
                ` · ${reasoningLabel(selection.reasoningEffort)}`}
            </span>
            <ChevronDown aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuPopup
            side="top"
            align="end"
            className="conversation-settings-popup"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                {modelView ? "Select model" : "Model & reasoning"}
              </DropdownMenuLabel>
              {modelView ? (
                <>
                  <DropdownMenuItem
                    closeOnClick={false}
                    onClick={() => setModelView(false)}
                  >
                    <ChevronLeft aria-hidden="true" />
                    Back
                  </DropdownMenuItem>
                  <DropdownMenuRadioGroup
                    value={selection.model}
                    onValueChange={(value) => {
                      const selected = instance?.models.find(
                        (candidate) => candidate.id === value
                      );
                      if (!selected) return;
                      onChange({
                        ...selection,
                        model: selected.id,
                        reasoningEffort:
                          selected.supportedReasoningEfforts.includes(
                            selection.reasoningEffort
                          )
                            ? selection.reasoningEffort
                            : (selected.defaultReasoningEffort ??
                              selected.supportedReasoningEfforts[0] ??
                              "")
                      });
                      setModelOpen(false);
                    }}
                  >
                    {instance?.models.map((candidate) => (
                      <DropdownMenuRadioItem
                        className="conversation-setting-option"
                        key={candidate.id}
                        value={candidate.id}
                        disabled={blocked}
                      >
                        <span>{candidate.displayName ?? candidate.id}</span>
                        {selection.model === candidate.id && (
                          <Check aria-hidden="true" />
                        )}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              ) : (
                <>
                  <DropdownMenuItem
                    className="conversation-model-overview"
                    closeOnClick={false}
                    onClick={() => setModelView(true)}
                  >
                    <span>{modelLabel}</span>
                    <ChevronRight aria-hidden="true" />
                  </DropdownMenuItem>
                  {Boolean(model?.supportedReasoningEfforts.length) && (
                    <DropdownMenuRadioGroup
                      className="conversation-reasoning-bar"
                      aria-label="Reasoning"
                      value={selection.reasoningEffort}
                      onValueChange={(value) =>
                        onChange({
                          ...selection,
                          reasoningEffort: String(value)
                        })
                      }
                    >
                      {model?.supportedReasoningEfforts.map((effort) => (
                        <DropdownMenuRadioItem
                          className="conversation-reasoning-step"
                          closeOnClick={false}
                          key={effort}
                          value={effort}
                          disabled={blocked}
                        >
                          {reasoningLabel(effort)}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  )}
                </>
              )}
            </DropdownMenuGroup>
            {reason && (
              <p className="conversation-settings-explanation">{reason}</p>
            )}
          </DropdownMenuPopup>
        </DropdownMenu>
      </div>
    </div>
  );
}
