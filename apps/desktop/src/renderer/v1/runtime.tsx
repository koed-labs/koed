import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ComponentProps
} from "react";
import {
  SecureMarkdown,
  SourceDiff,
  VirtualizedTimeline,
  threadSelectionKey
} from "@koed/memory-ui";
import type { NativeConversationSurfaceProps } from "../../NativeConversationSurface.js";
import {
  conversationEventText,
  conversationEventPatch,
  conversationEventToolDisplay,
  expandConversationDisplayEvents,
  groupConversationEvents,
  stabilizeConversationTimelineItems,
  type StableConversationTimelineItemsState
} from "../../desktop-conversation.js";
import {
  permissionLabels,
  selectionForInstance
} from "../views/personal/ConversationSettings.js";
import type { ConversationInput } from "../views/personal/ConversationInput.js";
import { createRendererPlatform } from "../services/platform.js";
import {
  ModelPicker,
  V1Composer,
  V1Message,
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

export function V1ConversationSurface(props: NativeConversationSurfaceProps) {
  const agent = useContext(V1AgentContext);
  const platform = useMemo(() => createRendererPlatform(), []);
  const adapters = props.markdownAdapters ?? {
    openExternal: platform.openExternal,
    writeClipboard: platform.copyText
  };
  const events = useMemo(
    () =>
      expandConversationDisplayEvents(props.model?.events ?? []).filter(
        (event) =>
          event.responseStreaming ||
          Boolean(event.approvalDecisionDisplay) ||
          event.actor === "tool" ||
          conversationEventText(event).length > 0
      ),
    [props.model?.events]
  );
  const previous = useRef<StableConversationTimelineItemsState>({
    byId: new Map(),
    result: []
  });
  const items = useMemo(() => {
    const state = stabilizeConversationTimelineItems(
      groupConversationEvents(events),
      previous.current
    );
    previous.current = state;
    return state.result;
  }, [events]);
  const [copyError, setCopyError] = useState("");
  if (!props.model)
    return <p role="alert">Conversation state is unavailable.</p>;
  return (
    <div className="v1-conversation-content">
      {props.model.error && (
        <p role="alert">
          {props.model.error}{" "}
          <button onClick={() => void props.onRetry()}>Retry</button>
        </p>
      )}
      {copyError && <p role="alert">{copyError}</p>}
      {!items.length && !props.model.error && (
        <p role="status">
          {props.model.status === "loading"
            ? "Loading conversation…"
            : "Getting ready…"}
        </p>
      )}
      <VirtualizedTimeline
        className="v1-conversation-scroll"
        events={items}
        hasOlderEvents={props.model.hasOlderEvents}
        onLoadOlder={props.onLoadOlder}
        threadKey={threadSelectionKey(props.thread)}
        renderEvent={(item) => {
          if (item.kind === "tool-group")
            return (
              <details className="v1-tool-activity">
                <summary>
                  {item.events.length} tool{" "}
                  {item.events.length === 1 ? "action" : "actions"}
                </summary>
                {item.events.map((event) => (
                  <section key={event.id}>
                    <strong>{conversationEventToolDisplay(event).label}</strong>
                    <time dateTime={event.timestamp}>
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </time>
                    {conversationEventPatch(event) ? (
                      <SourceDiff
                        details={conversationEventPatch(event)!}
                        sourceText={conversationEventPatch(event)!.sourceText}
                      />
                    ) : (
                      <SecureMarkdown
                        adapters={adapters}
                        source={conversationEventText(event)}
                      />
                    )}
                    {props.onInspectEvent && (
                      <button
                        type="button"
                        onClick={() => props.onInspectEvent?.(event)}
                      >
                        View source
                      </button>
                    )}
                  </section>
                ))}
              </details>
            );
          const event = item.event,
            text = conversationEventText(event);
          if (event.approvalDecisionDisplay) {
            const decision = event.approvalDecisionDisplay;
            return (
              <section className="v1-tool-activity" aria-label="Auto approval">
                <strong>
                  {decision.outcome === "allow" ? "Allowed" : "Denied"}
                </strong>
                <p>
                  Risk: {decision.riskLevel} · Authorization:{" "}
                  {decision.userAuthorization}
                </p>
                <p>{decision.rationale}</p>
                {props.onInspectEvent && (
                  <button onClick={() => props.onInspectEvent?.(event)}>
                    View source
                  </button>
                )}
              </section>
            );
          }
          if (
            event.presentation?.mode === "collapsed" ||
            !["user", "agent", "assistant"].includes(event.actor ?? "")
          )
            return (
              <details className="v1-tool-activity">
                <summary>{event.activityDisplay?.label ?? "Activity"}</summary>
                <SecureMarkdown adapters={adapters} source={text} />
              </details>
            );
          return (
            <V1Message
              role={event.actor === "user" ? "user" : "assistant"}
              look={agent.look}
              meta={
                <time dateTime={event.timestamp}>
                  {new Date(event.timestamp).toLocaleTimeString()}
                </time>
              }
              working={Boolean(event.responseStreaming && !text)}
              actions={
                text && event.actor !== "user" ? (
                  <button
                    type="button"
                    aria-label="Copy response"
                    onClick={() => {
                      void Promise.resolve()
                        .then(() => adapters.writeClipboard(text ?? ""))
                        .catch(() =>
                          setCopyError("The response could not be copied.")
                        );
                    }}
                  >
                    Copy
                  </button>
                ) : undefined
              }
            >
              {event.responseStreaming && !text ? (
                `${agent.name} is working…`
              ) : (
                <SecureMarkdown adapters={adapters} source={text} />
              )}
              {event.invalidatedAt && (
                <small>Excluded from current memory recall</small>
              )}
            </V1Message>
          );
        }}
      />
    </div>
  );
}
