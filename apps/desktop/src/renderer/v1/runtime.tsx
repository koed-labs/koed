import {
  createContext,
  useContext,
  useState,
  type ComponentProps
} from "react";
import {
  permissionLabels,
  selectionForInstance
} from "../views/personal/ConversationSettings.js";
import type { ConversationInput } from "../views/personal/ConversationInput.js";
import {
  ModelPicker,
  V1Composer,
  DEFAULT_AGENT_LOOK,
  type AgentLook
} from "./visual.js";

export const V1AgentContext = createContext({
  name: "Koed",
  look: DEFAULT_AGENT_LOOK as AgentLook
});

export function V1ManagedInput(
  props: ComponentProps<typeof ConversationInput>
) {
  const agent = useContext(V1AgentContext);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const folder = props.folderPicker?.folders.find(
    (item) => item.id === props.folderPicker?.selectedId
  );
  const { settings } = props;
  const instance = settings.options?.instances.find(
    (i) => i.instanceId === settings.selection.instanceId
  );
  return (
    <div className="v1-runtime-input">
      {foldersOpen && props.folderPicker && (
        <div
          className="v1-permission-popover"
          role="dialog"
          aria-label="Execution Folder"
        >
          {props.folderPicker.folders.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => {
                props.folderPicker?.onSelect(item.id);
                setFoldersOpen(false);
              }}
            >
              {item.path}
            </button>
          ))}
          <button type="button" onClick={() => setFoldersOpen(false)}>
            Close
          </button>
        </div>
      )}
      {permissionsOpen && (
        <div
          className="v1-permission-popover"
          role="dialog"
          aria-label="Conversation access"
        >
          {instance?.capabilities.permissionModes
            .filter(
              (mode) =>
                mode.support === "supported" &&
                ["supervised", "full_access"].includes(mode.mode)
            )
            .map((mode) => (
              <button
                key={mode.mode}
                type="button"
                onClick={() => {
                  settings.onChange({
                    ...settings.selection,
                    permissionMode: mode.mode
                  });
                  setPermissionsOpen(false);
                }}
              >
                <strong>
                  {mode.mode === "supervised" ? "Ask first" : "Full access"}
                </strong>
                <small>
                  {mode.mode === "supervised"
                    ? "Ask before actions that need approval."
                    : "Allow actions without approval prompts."}
                </small>
              </button>
            ))}
          <button type="button" onClick={() => setPermissionsOpen(false)}>
            Close
          </button>
        </div>
      )}
      <V1Composer
        value={props.value}
        onChange={props.onChange}
        onSend={props.onSubmit}
        onStop={
          props.action.kind === "interrupt" && !props.action.disabled
            ? props.onSubmit
            : undefined
        }
        busy={props.action.kind === "interrupt"}
        disabled={props.disabled}
        actionDisabled={props.action.disabled}
        placeholder={props.placeholder || `Reply to ${agent.name}`}
        projectLabel={
          folder?.path.split(/[\\/]/).filter(Boolean).at(-1) ??
          props.folderPicker?.placeholder ??
          "Choose Folder"
        }
        onProject={
          props.folderPicker && !props.folderPicker.disabledReason
            ? () => setFoldersOpen((open) => !open)
            : undefined
        }
        inputLabel={props.label}
        permissionLabel={
          settings.selection.permissionMode === "supervised"
            ? "Ask first"
            : settings.selection.permissionMode
              ? permissionLabels[settings.selection.permissionMode]
              : "Access"
        }
        onPermission={
          !settings.disabledReason
            ? () => setPermissionsOpen((open) => !open)
            : undefined
        }
        modelPicker={
          <ModelPicker
            onOpen={settings.onOpen}
            look={agent.look}
            disabled={Boolean(settings.disabledReason)}
            lockedProviderId={
              settings.clientLocked ? settings.selection.instanceId : undefined
            }
            providers={(settings.options?.instances ?? [])
              .filter(
                (i) =>
                  !settings.clientLocked ||
                  i.instanceId === settings.selection.instanceId
              )
              .map((i) => ({
                id: i.instanceId,
                label: i.displayName,
                models: i.models.map((m) => ({
                  id: m.id,
                  label: m.displayName ?? m.id,
                  description: m.description,
                  efforts: m.supportedReasoningEfforts,
                  defaultEffort: m.defaultReasoningEffort,
                  disabled: !i.ready
                }))
              }))}
            selection={{
              providerId: settings.selection.instanceId,
              modelId: settings.selection.model,
              effort: settings.selection.reasoningEffort
            }}
            onChange={(next) =>
              settings.onChange({
                ...(next.providerId !== settings.selection.instanceId &&
                settings.options
                  ? selectionForInstance(settings.options, next.providerId)
                  : settings.selection),
                instanceId: next.providerId,
                model: next.modelId,
                reasoningEffort: next.effort
              })
            }
          />
        }
      />
      {props.action.kind === "busy" && (
        <p role="status">Getting the conversation ready…</p>
      )}
    </div>
  );
}

export { V1ConversationSurface } from "./conversation/ConversationSurface.js";
