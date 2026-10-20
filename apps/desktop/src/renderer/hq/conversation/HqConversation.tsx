import type { MarkdownPlatformAdapters } from "@koed/memory-ui";
import { createPortal } from "react-dom";
import type { ManagedConversationSettings } from "@koed/shared/ai-client-contract";
import type { ManagedConversationFileRevision } from "@koed/shared/managed-conversation-files";
import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
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
import {
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Folder,
  Paperclip,
  RotateCcw,
  Shield,
  Square,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import {
  conversationEventText,
  expandConversationDisplayEvents
} from "../../../desktop-conversation.js";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationIdentity,
  ManagedConversationLaunchOptions,
  ManagedConversationRuntimeItem,
  ManagedConversationTurnCitation
} from "../../../ipc/managed-conversation-protocol.js";
import type { ManagedProjectDesktopApi } from "../../../ipc/managed-project-protocol.js";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";
import type {
  ManagedConversationLifecycle,
  ManagedConversationDraft,
  ManagedConversationPendingSend
} from "../../state/use-managed-conversation-lifecycle.js";
import { usePersonalMemoryDetail } from "../../views/personal/use-personal-memory-detail.js";
import { useSlashCommandDiscovery } from "../../views/personal/use-slash-command-discovery.js";
import {
  applySlashCommandReplacement,
  filterSlashCommands,
  findActiveSlashCommand,
  findUnverifiedSlashCommand,
  type ManagedConversationSlashCommand
} from "../../views/personal/ai-client-slash-suggestions.js";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { DesktopApi } from "../../../types.js";
import { assignmentFrom } from "../../views/preferences/local-ai-client-settings-helpers.js";
import { HqRuntimeItem } from "./HqRuntimeItem.js";
import { ManagedMemoryActions } from "./ManagedMemoryActions.js";
import { CitedAnswer, CitationDetail } from "./Citations.js";
import { citationAliasBatches } from "./citation-alias-batches.js";
import { HqVisibilityLine } from "./HqVisibilityLine.js";
import {
  hqVisibilityIdentity,
  useHqConversationVisibility,
  type HqVisibility
} from "./hq-visibility.js";
import {
  hqPermissionLabel,
  hqReasoningHeat,
  hqReasoningLabel,
  hqSelectionForInstance,
  hqSelectionIsSupported,
  hqSettingsChange,
  type HqSelection
} from "./hq-conversation-model.js";
import "./hq-conversation.css";

type Attachment = { commandId: string; label: string };
const emptySelection: HqSelection = {
  instanceId: "",
  model: "",
  reasoningEffort: "",
  permissionMode: ""
};
const draftScope = (identity: ManagedConversationIdentity) => ({
  projectId: identity.projectId,
  capturedSessionId: identity.capturedSessionId,
  threadId: identity.threadId
});

export function HqConversationSettings({
  options,
  selection,
  onChange,
  locked,
  disabled,
  permissionOnly = false
}: {
  options: ManagedConversationLaunchOptions | null;
  selection: HqSelection;
  onChange: (value: HqSelection) => void;
  locked?: boolean;
  disabled?: boolean;
  permissionOnly?: boolean;
}) {
  const instance = options?.instances.find(
    (item) => item.instanceId === selection.instanceId
  );
  const model = instance?.models.find((item) => item.id === selection.model);
  const supported = instance?.capabilities.permissionModes ?? [];
  const [moreModes, setMoreModes] = useState(false);
  const [modelList, setModelList] = useState(false);
  const efforts = model?.supportedReasoningEfforts ?? [];
  const effortIndex = Math.max(0, efforts.indexOf(selection.reasoningEffort));
  const effortButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const chooseEffort = (index: number) => {
    const effort = efforts[index];
    if (effort) onChange({ ...selection, reasoningEffort: effort });
  };
  const chooseModel = (instanceId: string, modelId: string) => {
    if (!options || (locked && instanceId !== selection.instanceId)) return;
    const nextInstance = options.instances.find(
      (item) => item.instanceId === instanceId
    );
    const next = nextInstance?.models.find((item) => item.id === modelId);
    if (!nextInstance?.ready || !next) return;
    const base =
      instanceId === selection.instanceId
        ? selection
        : hqSelectionForInstance(options, instanceId);
    onChange({
      ...base,
      model: next.id,
      reasoningEffort: next.supportedReasoningEfforts.includes(
        base.reasoningEffort
      )
        ? base.reasoningEffort
        : (next.defaultReasoningEffort ??
          next.supportedReasoningEfforts[0] ??
          "")
    });
  };
  const permission = (
    mode: "supervised" | "full_access" | "auto_edit" | "auto"
  ) => (
    <DropdownMenuRadioItem
      key={mode}
      value={mode}
      disabled={
        disabled ||
        !instance?.ready ||
        !supported.some(
          (item) => item.mode === mode && item.support === "supported"
        )
      }
      className="hq-conversation-menu__item"
    >
      {hqPermissionLabel[mode]}
      {selection.permissionMode === mode ? " ✓" : ""}
    </DropdownMenuRadioItem>
  );
  return (
    <>
      <DropdownMenu onOpenChange={() => setMoreModes(false)}>
        <DropdownMenuTrigger
          className="hq-composer__setting-trigger hq-composer__permission-trigger"
          aria-label={`Permissions: ${selection.permissionMode ? hqPermissionLabel[selection.permissionMode] : "Ask first unavailable"}`}
          disabled={disabled}
        >
          <Shield size={15} />
          <span>
            {selection.permissionMode
              ? hqPermissionLabel[selection.permissionMode]
              : "Ask first unavailable"}
          </span>
          <ChevronDown size={14} />
        </DropdownMenuTrigger>
        <DropdownMenuPopup
          side="top"
          align="start"
          className="hq-conversation-menu"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              {moreModes ? "More permissions" : "Permissions"}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          {moreModes ? (
            <DropdownMenuItem
              closeOnClick={false}
              onClick={() => setMoreModes(false)}
            >
              <ChevronLeft size={14} /> Back
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuRadioGroup
            value={selection.permissionMode}
            onValueChange={(value) =>
              onChange({
                ...selection,
                permissionMode: value as HqSelection["permissionMode"]
              })
            }
          >
            {moreModes ? (
              <>
                {permission("auto_edit")}
                {permission("auto")}
              </>
            ) : (
              <>
                {permission("supervised")}
                {permission("full_access")}
              </>
            )}
          </DropdownMenuRadioGroup>
          {!moreModes ? (
            <DropdownMenuItem
              closeOnClick={false}
              onClick={() => setMoreModes(true)}
            >
              More permissions <ChevronRight size={14} />
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuPopup>
      </DropdownMenu>
      <div className="hq-composer__spacer" />
      {!permissionOnly ? (
        <div className="hq-conversation-settings">
          <DropdownMenu onOpenChange={() => setModelList(false)}>
            <DropdownMenuTrigger
              className="hq-composer__setting-trigger hq-composer__model-trigger"
              aria-label={`Model and reasoning: ${(model?.displayName ?? selection.model) || "Unavailable"}${selection.reasoningEffort ? `, ${hqReasoningLabel(selection.reasoningEffort)}` : ""}; AI Client: ${instance?.displayName ?? "Unavailable"}`}
              disabled={disabled}
            >
              <span>{(model?.displayName ?? selection.model) || "Model"}</span>
              {selection.reasoningEffort ? (
                <>
                  <span
                    className="hq-composer__heat"
                    style={{
                      background: `var(--hq-heat-${hqReasoningHeat(effortIndex, efforts.length)})`
                    }}
                    aria-hidden="true"
                  />
                  <span className="hq-composer__effort-label">
                    {hqReasoningLabel(selection.reasoningEffort)}
                  </span>
                </>
              ) : null}
              <ChevronDown size={14} />
            </DropdownMenuTrigger>
            <DropdownMenuPopup
              side="top"
              align="end"
              className="hq-conversation-menu hq-conversation-menu--model"
            >
              {modelList ? (
                <>
                  <DropdownMenuItem
                    closeOnClick={false}
                    onClick={() => setModelList(false)}
                  >
                    <ChevronLeft size={14} /> Back
                  </DropdownMenuItem>
                  <DropdownMenuRadioGroup
                    value={`${selection.instanceId}\u0000${selection.model}`}
                    onValueChange={(value) => {
                      const [instanceId, modelId] = value.split("\u0000");
                      if (instanceId && modelId)
                        chooseModel(instanceId, modelId);
                    }}
                  >
                    {options?.instances.map((client) => (
                      <DropdownMenuGroup key={client.instanceId}>
                        <DropdownMenuLabel>
                          {client.displayName}
                        </DropdownMenuLabel>
                        {client.models.map((item) => (
                          <DropdownMenuRadioItem
                            className="hq-conversation-menu__item"
                            key={`${client.instanceId}:${item.id}`}
                            value={`${client.instanceId}\u0000${item.id}`}
                            disabled={
                              !client.ready ||
                              (locked &&
                                client.instanceId !== selection.instanceId)
                            }
                          >
                            {item.displayName ?? item.id}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuGroup>
                    ))}
                  </DropdownMenuRadioGroup>
                  {locked ? (
                    <p>Start a new Conversation to change AI Client.</p>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="hq-reasoning__top">
                    <div className="hq-reasoning__title">
                      <strong>
                        {hqReasoningLabel(selection.reasoningEffort)}
                      </strong>
                      <button
                        type="button"
                        onClick={() => setModelList(true)}
                        aria-label="Choose AI Client and model"
                      >
                        {(model?.displayName ?? selection.model) ||
                          "Select model"}
                        <ChevronRight size={12} />
                      </button>
                    </div>
                    <button
                      type="button"
                      className="hq-reasoning__reset"
                      aria-label="Reset reasoning effort"
                      title="Reset reasoning effort"
                      disabled={!model || !efforts.length}
                      onClick={() => {
                        if (!model) return;
                        onChange({
                          ...selection,
                          reasoningEffort: efforts.includes("medium")
                            ? "medium"
                            : (model.defaultReasoningEffort ?? efforts[0] ?? "")
                        });
                      }}
                    >
                      <RotateCcw size={14} />
                    </button>
                  </div>
                  {efforts.length ? (
                    <div
                      className="hq-reasoning__bars"
                      role="radiogroup"
                      aria-label="Reasoning effort"
                    >
                      {efforts.map((effort, index) => (
                        <button
                          key={effort}
                          type="button"
                          ref={(node) => {
                            effortButtons.current[index] = node;
                          }}
                          role="radio"
                          aria-label={`Reasoning effort: ${hqReasoningLabel(effort)}`}
                          aria-checked={selection.reasoningEffort === effort}
                          tabIndex={
                            selection.reasoningEffort === effort ? 0 : -1
                          }
                          onClick={() => chooseEffort(index)}
                          onKeyDown={(event) => {
                            const next =
                              event.key === "ArrowRight" ||
                              event.key === "ArrowUp"
                                ? (index + 1) % efforts.length
                                : event.key === "ArrowLeft" ||
                                    event.key === "ArrowDown"
                                  ? (index - 1 + efforts.length) %
                                    efforts.length
                                  : event.key === "Home"
                                    ? 0
                                    : event.key === "End"
                                      ? efforts.length - 1
                                      : -1;
                            if (next < 0) return;
                            event.preventDefault();
                            chooseEffort(next);
                            effortButtons.current[next]?.focus();
                          }}
                          style={
                            {
                              "--hq-reasoning-heat": `var(--hq-heat-${hqReasoningHeat(index, efforts.length)})`
                            } as React.CSSProperties
                          }
                        >
                          {Array.from(
                            { length: hqReasoningHeat(index, efforts.length) },
                            (_, segment) => (
                              <i key={segment} aria-hidden="true" />
                            )
                          )}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p>Reasoning effort is unavailable for this model.</p>
                  )}
                </>
              )}
            </DropdownMenuPopup>
          </DropdownMenu>
        </div>
      ) : null}
    </>
  );
}

function Composer({
  value,
  setValue,
  onSubmit,
  onAttach,
  attachments,
  onRemoveAttachment,
  projects,
  projectId,
  onProjectChange,
  options,
  selection,
  onSelectionChange,
  locked,
  busy,
  canSend,
  active,
  onStop,
  error,
  slashCommands,
  lockDraft,
  settingsDisabled,
  privateProjectHq,
  visibility,
  contextLabel,
  onClearContext
}: {
  value: string;
  setValue: (value: string) => void;
  onSubmit: () => void;
  onAttach?: () => void;
  attachments: Attachment[];
  onRemoveAttachment: (id: string) => void;
  projects: readonly DesktopProject[];
  projectId: string;
  onProjectChange?: (id: string) => void;
  options: ManagedConversationLaunchOptions | null;
  selection: HqSelection;
  onSelectionChange: (value: HqSelection) => void;
  locked?: boolean;
  busy?: boolean;
  canSend: boolean;
  active?: boolean;
  onStop?: () => void;
  error?: string;
  slashCommands?: ManagedConversationSlashCommand[];
  lockDraft?: boolean;
  settingsDisabled?: boolean;
  privateProjectHq?: boolean;
  visibility: HqVisibility;
  contextLabel?: string | null;
  onClearContext?: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(value.length);
  const slash = findActiveSlashCommand({ text: value, cursorIndex: cursor });
  const suggestions = slash
    ? filterSlashCommands(slashCommands ?? [], slash.query).slice(0, 8)
    : [];
  useEffect(() => {
    if (!locked) input.current?.focus();
  }, [locked]);
  return (
    <div className="hq-composer-wrap">
      <HqVisibilityLine visibility={visibility} />
      {privateProjectHq && contextLabel ? (
        <div className="hq-project-conversation__context">
          About <strong>{contextLabel}</strong>
          <button
            type="button"
            aria-label="Stop talking about this"
            onClick={onClearContext}
          >
            ×
          </button>
        </div>
      ) : null}
      <form
        className="hq-composer"
        aria-label="Conversation composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {attachments.length ? (
          <div className="hq-composer__attachments">
            {attachments.map((item) => (
              <span key={item.commandId}>
                {item.label}
                <button
                  aria-label={`Remove ${item.label}`}
                  type="button"
                  disabled={lockDraft}
                  onClick={() => onRemoveAttachment(item.commandId)}
                >
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={input}
          aria-label="Message your AI Client"
          placeholder="What do you want to get done?"
          rows={1}
          value={value}
          disabled={busy || lockDraft}
          onChange={(event) => {
            setValue(event.target.value);
            setCursor(event.target.selectionStart);
          }}
          onClick={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        {slash && suggestions.length ? (
          <div
            className="hq-slash-list"
            role="listbox"
            aria-label="AI Client commands"
          >
            {suggestions.map((item) => (
              <button
                key={`${item.source}:${item.name}`}
                role="option"
                aria-selected="false"
                type="button"
                onClick={() => {
                  const next = applySlashCommandReplacement({
                    text: value,
                    range: slash.range,
                    commandName: item.name
                  });
                  setValue(next);
                  setCursor(next.length);
                  input.current?.focus();
                }}
              >
                <b>/{item.name}</b>
                <small>{item.description}</small>
              </button>
            ))}
          </div>
        ) : null}
        <div className="hq-composer__toolbar">
          <button
            aria-label="Attach a Project file"
            title="Attach a Project file"
            type="button"
            onClick={onAttach}
            disabled={!onAttach || busy}
          >
            <Paperclip size={17} />
          </button>
          {!privateProjectHq ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="hq-composer__setting-trigger hq-composer__project-trigger"
                aria-label={`Project: ${projects.find((item) => item.id === projectId)?.name ?? "Choose Project"}`}
                disabled={!onProjectChange || busy}
              >
                <Folder size={15} />
                <span>
                  {projects.find((item) => item.id === projectId)
                    ?.contextKind === "independent"
                    ? "Just me"
                    : (projects.find((item) => item.id === projectId)?.name ??
                      "Choose Project")}
                </span>
                <ChevronDown size={14} />
              </DropdownMenuTrigger>
              <DropdownMenuPopup
                side="top"
                align="start"
                className="hq-conversation-menu"
              >
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Project</DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuRadioGroup
                  value={projectId}
                  onValueChange={(value) => onProjectChange?.(value)}
                >
                  {projects.map((item) => (
                    <DropdownMenuRadioItem
                      className="hq-conversation-menu__item"
                      key={item.id}
                      value={item.id}
                    >
                      {item.contextKind === "independent"
                        ? "Just me"
                        : item.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuPopup>
            </DropdownMenu>
          ) : null}
          <HqConversationSettings
            options={options}
            selection={selection}
            onChange={onSelectionChange}
            locked={locked}
            disabled={busy || active || settingsDisabled}
            permissionOnly={privateProjectHq}
          />
          {privateProjectHq ? (
            <span className="hq-project-conversation__status">Auto</span>
          ) : null}
          {active ? (
            <button
              className="hq-composer__send"
              aria-label="Stop response"
              type="button"
              onClick={onStop}
              disabled={!onStop || busy}
            >
              <Square size={15} fill="currentColor" />
            </button>
          ) : (
            <button
              className="hq-composer__send"
              aria-label="Send message"
              type="submit"
              disabled={!canSend || busy}
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
      </form>
      {error ? (
        <p className="hq-conversation-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function HqBlankConversation({
  variant = "blank",
  api,
  localAiClients,
  projects,
  project,
  onProjectChange,
  lifecycle,
  managedProject,
  onStarted,
  onLaunchAttempt
}: {
  variant?: "blank" | "now";
  api: ManagedConversationDesktopApi | null;
  projects: readonly DesktopProject[];
  project: DesktopProject | null;
  localAiClients?: DesktopApi["localAiClients"];
  onProjectChange: (id: string) => void;
  lifecycle: ManagedConversationLifecycle;
  managedProject: ManagedProjectDesktopApi | null;
  onStarted: (
    projectId: string,
    routeId: string,
    attachRequested: boolean
  ) => void;
  onLaunchAttempt?: () => void;
}) {
  const [options, setOptions] =
    useState<ManagedConversationLaunchOptions | null>(null);
  const [selection, setSelection] = useState<HqSelection>(emptySelection);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [launchAttempted, setLaunchAttempted] = useState(false);
  const [savedAssignmentUnavailable, setSavedAssignmentUnavailable] =
    useState("");
  const startRef = useRef<
    Parameters<ManagedConversationDesktopApi["start"]>[0] | null
  >(null);
  const promptId = useRef<string | null>(null);
  const attachIntent = useRef<boolean | null>(null);
  const slash = useSlashCommandDiscovery(
    api,
    options?.instances.find((item) => item.instanceId === selection.instanceId)
      ?.driverId ?? null,
    selection.instanceId || null,
    project?.id ?? null,
    project?.path ?? null
  );
  useEffect(() => {
    if (!api) return;
    let alive = true;
    void Promise.all([api.launchOptions(), localAiClients?.list()])
      .then(([{ options }, settings]) => {
        if (!alive) return;
        setOptions(options);
        const assignment = settings
          ? assignmentFrom(settings.readModel, "conversations")
          : null;
        const preferred = assignment
          ? options.instances.find(
              (item) => item.instanceId === assignment.ai_client_instance_id
            )
          : null;
        const instance = assignment
          ? preferred
          : options.instances.find(
              (item) =>
                item.ready &&
                item.capabilities.permissionModes.some(
                  (mode) =>
                    mode.mode === "supervised" && mode.support === "supported"
                )
            );
        const base = hqSelectionForInstance(
          options,
          instance?.instanceId ?? assignment?.ai_client_instance_id ?? ""
        );
        const assignedModel = instance?.models.find((item) =>
          [item.id, item.fullId, item.model].includes(assignment?.model)
        );
        setSelection({
          ...base,
          model: assignment
            ? (assignedModel?.id ?? assignment.model)
            : base.model,
          reasoningEffort: assignment
            ? assignment.reasoning_effort === "none" &&
              !assignedModel?.supportedReasoningEfforts.length
              ? ""
              : assignment.reasoning_effort
            : base.reasoningEffort
        });
        setSavedAssignmentUnavailable(
          assignment && (!preferred || !assignedModel)
            ? "The saved Conversations AI Client or model is unavailable. Choose a supported AI Client and model before sending."
            : ""
        );
      })
      .catch(() => {
        if (alive)
          setError(
            "AI Client options are unavailable. Retry when your AI Client is ready."
          );
      });
    return () => {
      alive = false;
    };
  }, [api, localAiClients]);
  const start = async (requestedAttach = false) => {
    const attach = attachIntent.current ?? requestedAttach;
    if (
      !api ||
      !project ||
      lifecycle.recoveryStatus !== "ready" ||
      !lifecycle.persistPendingSend ||
      busy ||
      !hqSelectionIsSupported(options, selection) ||
      (!attach && !prompt.trim())
    )
      return;
    const unverified = findUnverifiedSlashCommand(prompt, slash.commands);
    if (unverified) {
      setError(`/${unverified} is not verified and cannot be dispatched.`);
      return;
    }
    setBusy(true);
    setError("");
    const instance = options!.instances.find(
      (item) => item.instanceId === selection.instanceId
    )!;
    const launch = startRef.current ?? {
      projectId: project.id,
      contextKind: project.contextKind ?? "project",
      aiClientDriverId: instance.driverId,
      aiClientInstanceId: instance.instanceId,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort || null,
      permissionMode: selection.permissionMode as
        | "supervised"
        | "full_access"
        | "auto_edit"
        | "auto",
      runnerKind: "local_device" as const,
      idempotencyKey: `desktop-conversation:${crypto.randomUUID()}`
    };
    startRef.current = launch;
    attachIntent.current = attach;
    setLaunchAttempted(true);
    onLaunchAttempt?.();
    try {
      const result = await api.start(launch);
      // A starting execution may not have a captured identity yet. The
      // execution-scoped placeholders are only a recovery route; lifecycle
      // replaces them when the owner reports the canonical source identity.
      const conversation = result.conversation ?? {
        executionId: result.executionId,
        projectId: launch.projectId,
        capturedSessionId: result.executionId,
        threadId: result.executionId,
        executionOwner: {
          driverId: launch.aiClientDriverId,
          instanceId: launch.aiClientInstanceId
        }
      };
      if (
        !conversation.executionId ||
        conversation.executionId !== result.executionId
      )
        throw new Error(
          "Koed has not confirmed this Conversation execution. Retry start to recover the same launch; your message is unchanged."
        );
      const firstPrompt:
        | {
            clientUserMessageId: string;
            prompt: string;
            status: "queued" | "rejected" | "reconciling";
            message: string;
          }
        | undefined = prompt.trim()
        ? {
            clientUserMessageId: promptId.current ?? crypto.randomUUID(),
            prompt,
            status: "rejected",
            message: attach
              ? "Attach a Project file, then send this saved draft."
              : "The prompt was not sent. Your draft is available below."
          }
        : undefined;
      if (firstPrompt) {
        promptId.current = firstPrompt.clientUserMessageId;
        try {
          await api.writeDraft({
            ...draftScope(conversation),
            value: firstPrompt.prompt
          });
        } catch {
          firstPrompt.message =
            "Koed could not save this draft securely. The text remains in this Conversation; copy it before leaving.";
        }
        if (
          !attach &&
          firstPrompt.message !==
            "Koed could not save this draft securely. The text remains in this Conversation; copy it before leaving."
        ) {
          if (
            !lifecycle.started(project, conversation, result.status, launch, {
              ...firstPrompt,
              status: "reconciling",
              message: "Checking first-prompt delivery."
            })
          )
            throw new Error(
              "Conversation recovery is unavailable. Nothing was sent."
            );
          const request: ManagedConversationPendingSend["request"] = {
            executionId: result.executionId,
            capturedSessionId: conversation.capturedSessionId,
            threadId: conversation.threadId,
            idempotencyKey: `desktop-prompt:${firstPrompt.clientUserMessageId}`,
            clientUserMessageId: firstPrompt.clientUserMessageId,
            prompt: firstPrompt.prompt,
            fileMentionCommandIds: [],
            terminalContextReferences: []
          };
          let intentSaved = false;
          try {
            await lifecycle.persistPendingSend(result.executionId, {
              request,
              attachments: []
            });
            intentSaved = true;
          } catch {
            firstPrompt.message =
              "Koed could not save delivery recovery securely. Nothing was sent; retry this saved draft.";
          }
          if (intentSaved)
            try {
              const sent = await api.send(request);
              firstPrompt.status = sent.status;
              firstPrompt.message = sent.message ?? "";
              if (sent.status === "queued") {
                await api.deleteDraft(draftScope(sent.conversation));
                await lifecycle.persistPendingSend(
                  result.executionId,
                  null,
                  {
                    clientUserMessageId: firstPrompt.clientUserMessageId,
                    status: "queued",
                    message: ""
                  },
                  request
                );
              } else if (sent.status === "rejected")
                await lifecycle.persistPendingSend(
                  result.executionId,
                  null,
                  {
                    clientUserMessageId: firstPrompt.clientUserMessageId,
                    status: "rejected",
                    message: firstPrompt.message
                  },
                  request
                );
            } catch {
              firstPrompt.status = "reconciling";
              firstPrompt.message =
                "Koed cannot confirm whether this prompt was dispatched. It will not resend automatically.";
            }
        }
      }
      const routeId = lifecycle.started(
        project,
        conversation,
        result.status,
        launch,
        firstPrompt
      );
      if (routeId) onStarted(project.id, routeId, attach);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The AI Client could not start. Retry checks the same Conversation."
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={`hq-conversation hq-conversation--blank${variant === "now" ? " hq-conversation--now" : ""}`}
    >
      <div className="hq-conversation__hero">
        <h1>
          {options?.instances.find(
            (item) => item.instanceId === selection.instanceId
          )?.displayName ?? "New Conversation"}
        </h1>
        <Composer
          visibility="personal-private"
          value={prompt}
          setValue={setPrompt}
          onSubmit={() => void start()}
          onAttach={
            managedProject &&
            !launchAttempted &&
            lifecycle.recoveryStatus === "ready"
              ? () => void start(true)
              : undefined
          }
          attachments={[]}
          onRemoveAttachment={() => undefined}
          projects={projects}
          projectId={project?.id ?? ""}
          onProjectChange={launchAttempted ? undefined : onProjectChange}
          options={options}
          selection={selection}
          onSelectionChange={
            launchAttempted
              ? () => undefined
              : (value) => {
                  setSelection(value);
                  setSavedAssignmentUnavailable("");
                }
          }
          locked={launchAttempted}
          lockDraft={launchAttempted}
          busy={busy}
          canSend={Boolean(
            api &&
            project &&
            lifecycle.recoveryStatus === "ready" &&
            lifecycle.persistPendingSend &&
            prompt.trim() &&
            hqSelectionIsSupported(options, selection)
          )}
          error={
            error ||
            savedAssignmentUnavailable ||
            slash.error ||
            (lifecycle.recoveryStatus === "unavailable"
              ? "Secure Conversation recovery is unavailable. Sending is paused."
              : "") ||
            (options && !selection.permissionMode
              ? "Ask first is unavailable for this AI Client. Choose a supported mode explicitly to continue."
              : "")
          }
          slashCommands={slash.commands}
        />
        {launchAttempted && error ? (
          <button
            className="hq-conversation__retry"
            type="button"
            disabled={busy}
            onClick={() => void start()}
          >
            Retry the same launch
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function HqActiveConversation({
  api,
  privateProjectHq = false,
  privateProjectHqIdentity,
  managedProject,
  store,
  project,
  thread,
  draft,
  lifecycle,
  onRetryStart,
  markdownAdapters,
  authorizeTransfer,
  visibilityClient,
  visibilityOwnerId,
  visibilityRevision,
  visibilityConnected = false,
  openFilePickerOnReady = false,
  inventoryOnly = false,
  contextLabel,
  documentWorkItemIntent,
  onDocumentWorkItemIntentConsumed,
  onClearContext,
  inspectorOpen = false,
  panelHostRef,
  onOpenCitationMessage,
  onOfferChatForget,
  focusEventId
}: {
  api: ManagedConversationDesktopApi | null;
  privateProjectHq?: boolean;
  privateProjectHqIdentity?: ManagedConversationIdentity;
  managedProject: ManagedProjectDesktopApi | null;
  store: PersonalMemoryStore;
  project: DesktopProject;
  thread: PersonalDesktopProjectThread;
  draft: ManagedConversationDraft | null;
  lifecycle?: ManagedConversationLifecycle;
  onRetryStart: () => void;
  markdownAdapters: MarkdownPlatformAdapters;
  authorizeTransfer?: CollaborationRendererClient["authorizeManagedConversationTransfer"];
  visibilityClient?: CollaborationRendererClient;
  visibilityOwnerId?: string | null;
  visibilityRevision?: string | null;
  visibilityConnected?: boolean;
  openFilePickerOnReady?: boolean;
  inventoryOnly?: boolean;
  contextLabel?: string | null;
  documentWorkItemIntent?: {
    id: string;
    prompt: string;
    sourceId: string;
  } | null;
  onDocumentWorkItemIntentConsumed?: (id: string) => void;
  onClearContext?: () => void;
  inspectorOpen?: boolean;
  panelHostRef?: (node: HTMLDivElement | null) => void;
  onOpenCitationMessage?: (target: {
    messageId: string;
    sessionId: string;
    projectId: string;
    threadId: string;
  }) => Promise<boolean>;
  onOfferChatForget?: (sourceSessionId: string) => Promise<boolean>;
  focusEventId?: string | null;
}) {
  const detailThread = draft?.thread ?? thread;
  const { detail, loadOlder, retry } = usePersonalMemoryDetail(
    store,
    detailThread,
    !inventoryOnly &&
      (!draft ||
        draft.conversation.capturedSessionId !== draft.conversation.executionId)
  );
  const identityKey = [
    project.id,
    draft?.conversation.executionId ?? "",
    draft?.conversation.capturedSessionId ?? detailThread.sessionId ?? "",
    draft?.conversation.threadId ?? detailThread.id
  ].join("\u0000");
  const identityKeyRef = useRef(identityKey);
  identityKeyRef.current = identityKey;
  const [resumed, setResumed] = useState<{
    key: string;
    status: "ready" | "read_only" | "reconciling";
    conversation: ManagedConversationIdentity;
  } | null>(null);
  const resumeStatus = resumed?.key === identityKey ? resumed.status : null;
  const conversation =
    resumed?.key === identityKey
      ? resumed.conversation
      : (draft?.conversation ?? privateProjectHqIdentity ?? null);
  const visibilityIdentity = hqVisibilityIdentity(
    thread,
    detailThread,
    conversation?.capturedSessionId
  );
  const visibility = useHqConversationVisibility({
    client: visibilityClient,
    logicalMemoryId: visibilityIdentity?.logicalMemoryId,
    sessionId: visibilityIdentity?.sessionId,
    ownerId: visibilityOwnerId,
    revision: visibilityRevision,
    connected: visibilityConnected
  });
  const [runtimeState, setRuntimeState] = useState<{
    key: string;
    value: Awaited<ReturnType<ManagedConversationDesktopApi["runtime"]>>;
  } | null>(null);
  const runtime =
    resumeStatus === "ready" && runtimeState?.key === identityKey
      ? runtimeState.value
      : null;
  const [usageState, setUsageState] = useState<{
    key: string;
    value: Awaited<ReturnType<ManagedConversationDesktopApi["usage"]>>;
  } | null>(null);
  const usage = usageState?.key === identityKey ? usageState.value : null;
  const [options, setOptions] =
    useState<ManagedConversationLaunchOptions | null>(null);
  const [selection, setSelection] = useState<HqSelection>(() =>
    draft
      ? {
          instanceId: draft.launchInput.aiClientInstanceId,
          model: draft.launchInput.model,
          reasoningEffort: draft.launchInput.reasoningEffort ?? "",
          permissionMode: draft.launchInput.permissionMode
        }
      : emptySelection
  );
  const [expected, setExpected] = useState<ManagedConversationSettings | null>(
    () =>
      draft
        ? {
            model: draft.launchInput.model,
            reasoningEffort: draft.launchInput.reasoningEffort,
            permissionMode: draft.launchInput.permissionMode
          }
        : null
  );
  const [expectedForExecution, setExpectedForExecution] = useState<
    string | null
  >(draft?.conversation.executionId ?? null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [prompt, setPrompt] = useState(
    draft?.initialPrompt?.status === "rejected" ||
      draft?.initialPrompt?.status === "reconciling"
      ? draft.initialPrompt.prompt
      : ""
  );
  const promptEdited = useRef(false);
  const consumedDocumentIntent = useRef<string | null>(null);
  const [draftReadForIdentity, setDraftReadForIdentity] = useState<
    string | null
  >(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileOpen, setFileOpen] = useState(false);
  const initialFilePicker = useRef(openFilePickerOnReady);
  const [files, setFiles] = useState<
    Array<{ path: string; name: string; entryKind: string }>
  >([]);
  const [filePath, setFilePath] = useState("");
  const [filePage, setFilePage] = useState<{
    totalEntries: number;
    nextOffset: number | null;
    revision: ManagedConversationFileRevision;
  } | null>(null);
  const [pendingFile, setPendingFile] = useState<{
    commandId: string;
    kind: "browse" | "mention";
    path: string;
    offset?: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertainSend, setUncertainSend] = useState(
    draft?.initialPrompt?.status === "reconciling"
  );
  const [optimistic, setOptimistic] = useState<
    Array<{ id: string; prompt: string; status?: "sending" | "queued" }>
  >([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [devices, setDevices] = useState<
    Awaited<ReturnType<ManagedConversationDesktopApi["targets"]>>["devices"]
  >([]);
  const [deviceId, setDeviceId] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferMessage, setTransferMessage] = useState("");
  const pending = useRef<{
    key: string;
    messageId: string;
    prompt: string;
    selectedDocumentSourceId?: string;
    attachments: Attachment[];
    settingsChange: ReturnType<typeof hqSettingsChange>;
    request?: ManagedConversationPendingSend["request"];
  } | null>(
    draft?.initialPrompt?.status === "reconciling"
      ? {
          key: `desktop-prompt:${draft.initialPrompt.clientUserMessageId}`,
          messageId: draft.initialPrompt.clientUserMessageId,
          prompt: draft.initialPrompt.prompt,
          attachments: [],
          settingsChange: null
        }
      : null
  );
  const lastSubmitted = useRef<typeof pending.current>(null);
  const recoveredPending = conversation?.executionId
    ? lifecycle?.pendingSends?.get(conversation.executionId)
    : undefined;
  const sendLocked = uncertainSend || Boolean(recoveredPending);
  const refreshedTerminalCommand = useRef<string | null>(null);
  const draftWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveValue = useRef<{
    value: string;
    identity: ManagedConversationIdentity;
    api: ManagedConversationDesktopApi;
  } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flushAutosave();
    };
  }, []);
  const queueDraftOperation = useCallback(
    <T,>(operation: () => Promise<T>): Promise<T> => {
      const result = draftWriteChainRef.current.then(operation);
      draftWriteChainRef.current = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
    []
  );
  const cancelAutosave = () => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = null;
    autosaveValue.current = null;
  };
  const flushAutosave = () => {
    const pendingWrite = autosaveValue.current;
    cancelAutosave();
    if (!pendingWrite) return;
    void queueDraftOperation(() =>
      pendingWrite.api.writeDraft({
        ...draftScope(pendingWrite.identity),
        value: pendingWrite.value
      })
    ).catch(() => {
      if (mounted.current) setError("Koed could not save this draft securely.");
    });
  };
  const scheduleAutosave = (
    value: string,
    identity: ManagedConversationIdentity
  ) => {
    if (!api) return;
    autosaveValue.current = { value, identity, api };
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      flushAutosave();
    }, 250);
  };
  useEffect(() => () => flushAutosave(), [identityKey]);
  const executionId =
    resumeStatus === "ready" ? (conversation?.executionId ?? null) : null;
  // Invalidate private citation state during render, before an effect can clear
  // it. The generation also rejects late replies after an A→B→A identity hop.
  const citationScopeRef = useRef({
    api,
    store,
    identityKey,
    owner: visibilityOwnerId,
    generation: 0
  });
  if (
    citationScopeRef.current.api !== api ||
    citationScopeRef.current.store !== store ||
    citationScopeRef.current.identityKey !== identityKey ||
    citationScopeRef.current.owner !== visibilityOwnerId
  ) {
    citationScopeRef.current = {
      api,
      store,
      identityKey,
      owner: visibilityOwnerId,
      generation: citationScopeRef.current.generation + 1
    };
  }
  const citationGeneration = citationScopeRef.current.generation;
  const [citationState, setCitationState] = useState<{
    generation: number;
    byTurn: Record<string, ManagedConversationTurnCitation[]>;
    byAlias: ManagedConversationTurnCitation[];
  }>({ generation: citationGeneration, byTurn: {}, byAlias: [] });
  const citationsByTurn =
    citationState.generation === citationGeneration ? citationState.byTurn : {};
  const citationsByAlias =
    citationState.generation === citationGeneration
      ? citationState.byAlias
      : [];
  const [citationDetailState, setCitationDetailState] = useState<{
    generation: number;
    citation: ManagedConversationTurnCitation | null;
  }>({ generation: citationGeneration, citation: null });
  const citationDetail =
    citationDetailState.generation === citationGeneration
      ? citationDetailState.citation
      : null;
  const [citationLoading, setCitationLoading] = useState(false);
  const citationRequestSequence = useRef(0);
  useEffect(() => {
    citationRequestSequence.current++;
    setCitationState({
      generation: citationGeneration,
      byTurn: {},
      byAlias: []
    });
    setCitationDetailState({ generation: citationGeneration, citation: null });
    setCitationLoading(false);
  }, [citationGeneration]);
  const openCitation = (citation: ManagedConversationTurnCitation) => {
    if (!api?.citationDetail || !executionId) return;
    const sequence = ++citationRequestSequence.current;
    setCitationLoading(true);
    setCitationDetailState({ generation: citationGeneration, citation: null });
    const generation = citationGeneration;
    void api
      .citationDetail(executionId, citation.providerTurnId, citation.alias)
      .then((result) => {
        if (
          citationScopeRef.current.generation === generation &&
          citationRequestSequence.current === sequence
        )
          setCitationDetailState({ generation, citation: result.citation });
      })
      .catch(() => {
        if (
          citationScopeRef.current.generation === generation &&
          citationRequestSequence.current === sequence
        )
          setCitationDetailState({
            generation,
            citation: {
              ...citation,
              detailAvailable: false,
              summary: null,
              title: "Memory source unavailable"
            }
          });
      })
      .finally(() => {
        if (
          citationScopeRef.current.generation === generation &&
          citationRequestSequence.current === sequence
        )
          setCitationLoading(false);
      });
  };
  const recoveryReady = lifecycle?.recoveryStatus === "ready";
  useEffect(() => {
    if (!recoveredPending || !recoveryReady) return;
    const request = recoveredPending.request;
    pending.current = {
      key: request.idempotencyKey,
      messageId: request.clientUserMessageId,
      prompt: request.prompt,
      attachments: recoveredPending.attachments,
      settingsChange: request.settingsChange ?? null,
      request
    };
    setPrompt(request.prompt);
    setAttachments(recoveredPending.attachments);
    setUncertainSend(true);
  }, [recoveredPending, recoveryReady]);
  useEffect(() => {
    setBusy(false);
    setFileOpen(false);
    setPendingFile(null);
    setFilePage(null);
    setTransferBusy(false);
    setTransferMessage("");
    setDevices([]);
    setDeviceId("");
  }, [identityKey]);
  const slash = useSlashCommandDiscovery(
    api,
    conversation?.executionOwner?.driverId ??
      draft?.conversation.executionOwner?.driverId ??
      null,
    conversation?.executionOwner?.instanceId ??
      draft?.conversation.executionOwner?.instanceId ??
      null,
    project.id,
    project.path ?? null
  );
  const runtimeBusy =
    runtime?.latestCommand?.commandKind === "prompt" &&
    ["queued", "blocked", "dispatching", "indeterminate"].includes(
      runtime.latestCommand.state
    );
  const active =
    runtimeBusy && runtime?.latestCommand?.state !== "indeterminate";
  const matchingTerminal =
    runtime?.latestCommand?.commandKind === "prompt" &&
    runtime.latestCommand.clientUserMessageId === pending.current?.messageId &&
    ["completed", "failed"].includes(runtime.latestCommand.state);
  const refresh = useCallback(async () => {
    if (!api || !executionId) return;
    const [run, nextUsage, launch] = await Promise.allSettled([
      api.runtime(executionId),
      api.usage(executionId),
      api.launchOptions()
    ]);
    if (identityKeyRef.current !== identityKey) return;
    if (run.status === "fulfilled") {
      setRuntimeState({ key: identityKey, value: run.value });
      const latest = run.value.latestCommand;
      const previous = lastSubmitted.current;
      if (
        latest?.commandKind === "prompt" &&
        ["completed", "failed", "indeterminate"].includes(latest.state)
      ) {
        const key = `${latest.id}:${latest.updatedAt}:${conversation?.threadId ?? detailThread.id}`;
        if (refreshedTerminalCommand.current !== key) {
          refreshedTerminalCommand.current = key;
          store.refreshFromDurableEvent();
          void store.loadInitial(
            {
              ...detailThread,
              id: privateProjectHq
                ? detailThread.id
                : (conversation?.threadId ?? detailThread.id),
              sessionId:
                conversation?.capturedSessionId ?? detailThread.sessionId
            },
            { refresh: true }
          );
        }
      }
      if (
        (latest?.lastErrorCode ?? run.value.executionLastErrorCode) ===
        "ManagedConversationAuthenticationError"
      ) {
        const retained = previous?.prompt ?? draft?.initialPrompt?.prompt;
        if (retained) {
          setPrompt((current) => current || retained);
          if (previous) setAttachments(previous.attachments);
          if (conversation)
            void queueDraftOperation(() =>
              api.writeDraft({ ...draftScope(conversation), value: retained })
            ).catch(() =>
              setError(
                "Authentication failed, and Koed could not save the restored draft. Copy it before leaving."
              )
            );
        }
        if (previous)
          setOptimistic((current) =>
            current.filter((item) => item.id !== previous.messageId)
          );
        lastSubmitted.current = null;
        setError(
          "The AI Client rejected authentication. Sign in, then retry this saved draft."
        );
      }
      if (
        previous &&
        latest?.clientUserMessageId === previous.messageId &&
        latest.state === "failed" &&
        latest.lastErrorCode === "ManagedConversationSettingsUnavailableError"
      ) {
        setPrompt((current) => current || previous.prompt);
        setAttachments(previous.attachments);
        setOptimistic((current) =>
          current.filter((item) => item.id !== previous.messageId)
        );
        setError(
          "The selected settings became unavailable. Review them and send the restored draft manually."
        );
        lastSubmitted.current = null;
      }
      if (
        pending.current &&
        latest?.commandKind === "prompt" &&
        latest?.clientUserMessageId === pending.current.messageId
      ) {
        const settling = pending.current;
        if (
          ["queued", "blocked", "dispatching", "completed"].includes(
            latest.state
          )
        ) {
          try {
            if (!conversation?.executionId || !lifecycle?.persistPendingSend)
              return;
            cancelAutosave();
            await queueDraftOperation(() =>
              api.deleteDraft(draftScope(conversation))
            );
            await lifecycle.persistPendingSend(
              conversation.executionId,
              null,
              {
                clientUserMessageId: settling.messageId,
                status: "queued",
                message: ""
              },
              settling.request
            );
          } catch {
            if (
              mounted.current &&
              identityKeyRef.current === identityKey &&
              pending.current === settling
            )
              setError(
                "Koed could not finish securing this prompt. Check delivery again."
              );
            return;
          }
          if (
            !mounted.current ||
            identityKeyRef.current !== identityKey ||
            pending.current !== settling
          )
            return;
          pending.current = null;
          lastSubmitted.current = settling;
          setUncertainSend(false);
          setPrompt("");
          setAttachments([]);
          setOptimistic((current) =>
            current.map((item) =>
              item.id === settling.messageId
                ? { ...item, status: "queued" }
                : item
            )
          );
          setError("");
          store.refreshFromDurableEvent();
        } else if (latest.state === "failed") {
          try {
            if (!conversation?.executionId || !lifecycle?.persistPendingSend)
              return;
            await lifecycle.persistPendingSend(
              conversation.executionId,
              null,
              {
                clientUserMessageId: settling.messageId,
                status: "rejected",
                message:
                  "The AI Client rejected this prompt. Review the saved draft before retrying."
              },
              settling.request
            );
          } catch {
            if (
              mounted.current &&
              identityKeyRef.current === identityKey &&
              pending.current === settling
            )
              setError(
                "Koed could not secure the failed prompt state. Check delivery again."
              );
            return;
          }
          if (
            !mounted.current ||
            identityKeyRef.current !== identityKey ||
            pending.current !== settling
          )
            return;
          setPrompt(settling.prompt);
          setAttachments(settling.attachments);
          setOptimistic((current) =>
            current.filter((item) => item.id !== latest.clientUserMessageId)
          );
          pending.current = null;
          setUncertainSend(false);
          setError(
            latest.lastErrorCode === "ManagedConversationAuthenticationError"
              ? "The AI Client rejected authentication. Sign in, then retry this saved draft."
              : latest.lastErrorCode ===
                  "ManagedConversationSettingsUnavailableError"
                ? "The selected settings became unavailable. Review them and send the restored draft manually."
                : "The AI Client rejected this prompt. Review the saved draft before retrying."
          );
        }
      }
    }
    if (nextUsage.status === "fulfilled") {
      setUsageState({ key: identityKey, value: nextUsage.value });
      if (nextUsage.value.model && nextUsage.value.permissionMode) {
        const settings = {
          model: nextUsage.value.model,
          reasoningEffort: nextUsage.value.reasoningEffort,
          permissionMode: nextUsage.value.permissionMode
        };
        setExpected(settings);
        setExpectedForExecution(executionId);
        if (!settingsDirty && !pending.current) {
          setSelection({
            instanceId:
              conversation?.executionOwner?.instanceId ??
              draft?.conversation.executionOwner?.instanceId ??
              "",
            model: settings.model,
            reasoningEffort: settings.reasoningEffort ?? "",
            permissionMode: settings.permissionMode
          });
        }
      }
    }
    if (launch.status === "fulfilled") setOptions(launch.value.options);
  }, [
    api,
    identityKey,
    executionId,
    conversation?.executionOwner?.instanceId,
    conversation?.threadId,
    conversation?.capturedSessionId,
    draft?.initialPrompt?.prompt,
    draft?.conversation.executionOwner?.instanceId,
    settingsDirty,
    store,
    detailThread,
    queueDraftOperation,
    lifecycle
  ]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!api || !executionId) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [api, executionId, refresh]);
  useEffect(() => {
    if (!api || !detailThread.sessionId) return;
    let active = true;
    void api
      .resume({
        projectId: project.id,
        capturedSessionId: detailThread.sessionId,
        threadId: privateProjectHqIdentity?.threadId ?? detailThread.id
      })
      .then((result) => {
        if (!active || identityKeyRef.current !== identityKey) return;
        setResumed({
          key: identityKey,
          status: result.status,
          conversation: result.conversation
        });
      })
      .catch((cause: unknown) => {
        if (!active || identityKeyRef.current !== identityKey) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to resume this Conversation."
        );
      });
    return () => {
      active = false;
    };
  }, [
    api,
    identityKey,
    project.id,
    detailThread.id,
    detailThread.sessionId,
    privateProjectHqIdentity?.threadId
  ]);
  useEffect(() => {
    if (!api || !conversation) return;
    let alive = true;
    void api
      .readDraft(draftScope(conversation))
      .then((result) => {
        if (
          alive &&
          !promptEdited.current &&
          !(
            draft?.initialPrompt?.status === "queued" &&
            result.value === draft.initialPrompt.prompt
          )
        )
          setPrompt((current) => current || result.value);
        if (alive) setDraftReadForIdentity(identityKey);
      })
      .catch(() => {
        if (alive && documentWorkItemIntent)
          setError(
            "The saved draft could not be checked. Review this Conversation before making Work Items."
          );
      });
    return () => {
      alive = false;
    };
  }, [
    api,
    identityKey,
    conversation,
    documentWorkItemIntent,
    draft?.initialPrompt?.status,
    draft?.initialPrompt?.prompt
  ]);
  const send = async (
    manualRetry = false,
    documentPrompt?: string,
    selectedDocumentSourceId?: string
  ) => {
    const effectivePrompt =
      documentPrompt ??
      (privateProjectHq && contextLabel && !manualRetry
        ? `About ${contextLabel}: ${prompt}`
        : prompt);
    const exactRetry =
      manualRetry &&
      pending.current?.request &&
      pending.current.request.executionId === conversation?.executionId &&
      pending.current.request.capturedSessionId ===
        conversation?.capturedSessionId &&
      pending.current.request.threadId === conversation?.threadId;
    if (manualRetry && pending.current?.request && !exactRetry) {
      setError(
        "This saved prompt belongs to a different Conversation execution. Check its delivery from the original Conversation; Koed will not resend it here."
      );
      return;
    }
    const unverified = findUnverifiedSlashCommand(
      effectivePrompt,
      slash.commands
    );
    if (unverified && !exactRetry) {
      setError(`/${unverified} is not verified and cannot be dispatched.`);
      return;
    }
    if (
      !api ||
      !recoveryReady ||
      !lifecycle?.persistPendingSend ||
      !conversation?.executionId ||
      (!runtime && !exactRetry) ||
      resumeStatus !== "ready" ||
      (expectedForExecution !== conversation.executionId && !exactRetry) ||
      !effectivePrompt.trim() ||
      busy ||
      (manualRetry && matchingTerminal) ||
      (runtimeBusy &&
        !(manualRetry && runtime?.latestCommand?.state === "indeterminate")) ||
      runtime?.executionState === "failed" ||
      (sendLocked && !manualRetry) ||
      (!expected && !exactRetry) ||
      (!manualRetry && !hqSelectionIsSupported(options, selection))
    )
      return;
    const settingsChange = expected
      ? hqSettingsChange(expected, selection)
      : null;
    const submission: NonNullable<typeof pending.current> =
      manualRetry && pending.current
        ? pending.current
        : pending.current &&
            pending.current.prompt === effectivePrompt &&
            (pending.current.selectedDocumentSourceId ?? null) ===
              (selectedDocumentSourceId ?? null) &&
            JSON.stringify(pending.current.attachments) ===
              JSON.stringify(attachments) &&
            JSON.stringify(pending.current.settingsChange) ===
              JSON.stringify(settingsChange)
          ? pending.current
          : {
              key: `desktop-prompt:${crypto.randomUUID()}`,
              messageId: crypto.randomUUID(),
              prompt: effectivePrompt,
              selectedDocumentSourceId,
              attachments,
              settingsChange
            };
    const request: ManagedConversationPendingSend["request"] =
      submission.request ?? {
        executionId: conversation.executionId,
        capturedSessionId: conversation.capturedSessionId,
        threadId: conversation.threadId,
        idempotencyKey: submission.key,
        clientUserMessageId: submission.messageId,
        prompt: submission.prompt,
        ...(submission.selectedDocumentSourceId
          ? { selectedDocumentSourceId: submission.selectedDocumentSourceId }
          : {}),
        fileMentionCommandIds: submission.attachments.map(
          (item) => item.commandId
        ),
        terminalContextReferences: [],
        ...(submission.settingsChange
          ? { settingsChange: submission.settingsChange }
          : {})
      };
    submission.request = request;
    pending.current = submission;
    cancelAutosave();
    setBusy(true);
    setError("");
    setOptimistic((current) =>
      current.some((item) => item.id === submission.messageId)
        ? current
        : [...current, { id: submission.messageId, prompt: submission.prompt }]
    );
    try {
      await queueDraftOperation(() =>
        api.writeDraft({
          ...draftScope(conversation),
          value: submission.prompt
        })
      );
      if (!mounted.current || identityKeyRef.current !== identityKey) return;
      await lifecycle.persistPendingSend(conversation.executionId, {
        request,
        attachments: submission.attachments
      });
      if (!mounted.current || identityKeyRef.current !== identityKey) return;
    } catch {
      if (!mounted.current || identityKeyRef.current !== identityKey) return;
      setOptimistic((current) =>
        current.filter((item) => item.id !== submission.messageId)
      );
      setBusy(false);
      if (!manualRetry) pending.current = null;
      setError("Koed could not save this prompt securely. Nothing was sent.");
      return;
    }
    try {
      const result = await api.send(request);
      if (!mounted.current || identityKeyRef.current !== identityKey) return;
      setResumed((current) =>
        current?.key === identityKey
          ? { ...current, conversation: result.conversation }
          : current
      );
      if (result.status === "rejected") {
        await lifecycle.persistPendingSend(
          conversation.executionId,
          null,
          undefined,
          request
        );
        setOptimistic((current) =>
          current.filter((item) => item.id !== submission.messageId)
        );
        setError(
          result.message ??
            "The prompt was not sent. Review settings and retry manually."
        );
        pending.current = null;
        setUncertainSend(false);
        setSettingsDirty(false);
        void refresh();
      } else if (result.status === "reconciling") {
        setUncertainSend(true);
        setError(
          result.message ??
            "Koed cannot confirm whether this prompt arrived. It will not resend automatically."
        );
      } else {
        lastSubmitted.current = submission;
        setSettingsDirty(false);
        try {
          await queueDraftOperation(() =>
            api.deleteDraft(draftScope(result.conversation))
          );
          await lifecycle.persistPendingSend(
            conversation.executionId,
            null,
            {
              clientUserMessageId: submission.messageId,
              status: "queued",
              message: ""
            },
            request
          );
          if (
            !mounted.current ||
            identityKeyRef.current !== identityKey ||
            pending.current !== submission
          )
            return;
          pending.current = null;
          setUncertainSend(false);
          setPrompt("");
          setAttachments([]);
          setOptimistic((current) =>
            current.map((item) =>
              item.id === submission.messageId
                ? { ...item, status: "queued" }
                : item
            )
          );
          setError("");
          if (privateProjectHq && contextLabel && !manualRetry)
            onClearContext?.();
        } catch {
          if (
            !mounted.current ||
            identityKeyRef.current !== identityKey ||
            pending.current !== submission
          )
            return;
          setUncertainSend(true);
          setError(
            "The prompt was accepted, but secure recovery cleanup is incomplete. Check delivery before sending another."
          );
        }
        store.refreshFromDurableEvent();
        void refresh();
      }
    } catch {
      if (identityKeyRef.current !== identityKey) return;
      setUncertainSend(true);
      setError(
        "Koed cannot confirm whether this prompt arrived. It will not resend automatically."
      );
    } finally {
      if (identityKeyRef.current === identityKey) setBusy(false);
    }
  };
  useEffect(() => {
    if (
      !privateProjectHq ||
      !documentWorkItemIntent ||
      consumedDocumentIntent.current === documentWorkItemIntent.id ||
      !api ||
      !recoveryReady ||
      !lifecycle?.persistPendingSend ||
      !conversation?.executionId ||
      !runtime ||
      resumeStatus !== "ready" ||
      draftReadForIdentity !== identityKey ||
      expectedForExecution !== conversation.executionId ||
      busy ||
      runtimeBusy ||
      runtime.executionState === "failed" ||
      sendLocked ||
      !expected ||
      !hqSelectionIsSupported(options, selection)
    )
      return;
    if (prompt.trim() || attachments.length) {
      setError(
        "Send or clear the current draft before making Work Items from a document."
      );
      return;
    }
    consumedDocumentIntent.current = documentWorkItemIntent.id;
    onDocumentWorkItemIntentConsumed?.(documentWorkItemIntent.id);
    promptEdited.current = true;
    setPrompt(documentWorkItemIntent.prompt);
    void send(
      false,
      documentWorkItemIntent.prompt,
      documentWorkItemIntent.sourceId
    );
  }, [
    documentWorkItemIntent,
    onDocumentWorkItemIntentConsumed,
    privateProjectHq,
    api,
    recoveryReady,
    lifecycle,
    conversation?.executionId,
    runtime,
    resumeStatus,
    expectedForExecution,
    draftReadForIdentity,
    identityKey,
    busy,
    runtimeBusy,
    sendLocked,
    expected,
    options,
    selection,
    prompt,
    attachments
  ]);
  const respond = async (
    item: ManagedConversationRuntimeItem,
    response: {
      decision?: "accept" | "acceptForSession" | "decline" | "cancel";
      answers?: Record<string, string[]>;
    }
  ) => {
    if (
      !api ||
      !executionId ||
      busy ||
      item.answered ||
      item.state !== "pending"
    )
      return;
    setBusy(true);
    try {
      await api.respond({
        executionId,
        itemId: item.id,
        itemKind: item.itemKind as Exclude<
          ManagedConversationRuntimeItem["itemKind"],
          "transient_output"
        >,
        executionGeneration: item.executionGeneration,
        ...response
      });
      if (identityKeyRef.current !== identityKey) return;
      await refresh();
    } catch {
      if (identityKeyRef.current !== identityKey) return;
      setError(
        "Koed could not confirm this response. Refresh before trying again."
      );
    } finally {
      if (identityKeyRef.current === identityKey) setBusy(false);
    }
  };
  const control = async (action: "interrupt" | "stop") => {
    if (
      !api ||
      !executionId ||
      !runtime ||
      busy ||
      runtime.executionState !== "running"
    )
      return;
    setBusy(true);
    try {
      await api[action]({
        executionId,
        executionGeneration: runtime.executionGeneration,
        idempotencyKey: `desktop-${action}:${crypto.randomUUID()}`
      });
      if (identityKeyRef.current !== identityKey) return;
      await refresh();
    } catch {
      if (identityKeyRef.current !== identityKey) return;
      setError(
        `Koed could not confirm ${action}. Refresh before trying again.`
      );
    } finally {
      if (identityKeyRef.current === identityKey) setBusy(false);
    }
  };
  const transfer = async (kind: "handoff" | "fork") => {
    if (
      !authorizeTransfer ||
      !api ||
      !executionId ||
      !deviceId ||
      transferBusy ||
      resumeStatus !== "ready"
    )
      return;
    setTransferBusy(true);
    setTransferMessage("Waiting for your approval…");
    const operationId = crypto.randomUUID();
    try {
      const grant =
        kind === "fork"
          ? await authorizeTransfer({
              operation: "fork",
              executionId,
              operationId,
              targetDeviceId: deviceId,
              reason: "user_requested"
            })
          : await authorizeTransfer({
              operation: "handoff",
              executionId,
              operationId,
              targetDeviceId: deviceId
            });
      if (identityKeyRef.current !== identityKey) return;
      setTransferMessage(`Preparing ${kind === "fork" ? "fork" : "handoff"}…`);
      if (kind === "fork")
        await api.fork({
          actionGrantId: grant.id,
          executionId,
          operationId,
          targetDeviceId: deviceId,
          reason: "user_requested"
        });
      else
        await api.handoff({
          actionGrantId: grant.id,
          executionId,
          operationId,
          targetDeviceId: deviceId
        });
      if (identityKeyRef.current !== identityKey) return;
      setTransferMessage(
        kind === "fork"
          ? "Fork queued. The original Conversation remains here."
          : "Handoff queued. This device will stop writing after verification."
      );
    } catch (cause) {
      if (identityKeyRef.current !== identityKey) return;
      setTransferMessage(
        cause instanceof Error
          ? cause.message
          : "The transfer could not be confirmed."
      );
    } finally {
      if (identityKeyRef.current === identityKey) setTransferBusy(false);
    }
  };
  const settleFile = async (pending: {
    commandId: string;
    kind: "browse" | "mention";
    path: string;
    offset?: number;
  }) => {
    if (!managedProject || !executionId) return;
    const result = await managedProject.command({
      operation: "file_result",
      requestId: crypto.randomUUID(),
      executionId,
      commandId: pending.commandId
    });
    if (identityKeyRef.current !== identityKey) return;
    if (result.operation !== "file_result")
      throw new Error("File operation unavailable.");
    if (result.command.state === "indeterminate")
      throw new Error(
        "Koed cannot confirm the file operation. It will not retry automatically."
      );
    if (["failed", "cancelled"].includes(result.command.state)) {
      setPendingFile(null);
      throw new Error("File operation failed. The draft is unchanged.");
    }
    if (result.command.state !== "completed" || !result.result) {
      setPendingFile(pending);
      setError(
        "File operation is still running. Check the same operation to continue."
      );
      return;
    }
    setPendingFile(null);
    if (pending.kind === "browse" && result.result.kind === "browse") {
      const browseResult = result.result;
      setFiles((current) =>
        pending.offset && pending.offset > 0
          ? [
              ...current,
              ...browseResult.entries.filter(
                (entry) =>
                  !current.some((existing) => existing.path === entry.path)
              )
            ]
          : browseResult.entries
      );
      setFilePage({
        totalEntries: browseResult.totalEntries,
        nextOffset: browseResult.nextOffset,
        revision: browseResult.revision
      });
      setFilePath(pending.path);
      setFileOpen(true);
      return;
    }
    if (pending.kind === "mention" && result.result.kind === "mention") {
      setAttachments((current) =>
        current.some((item) => item.commandId === pending.commandId)
          ? current
          : [...current, { commandId: pending.commandId, label: pending.path }]
      );
      setFileOpen(false);
      return;
    }
    throw new Error("File result did not match the requested operation.");
  };
  const browse = async (
    path = "",
    offset = 0,
    revision: ManagedConversationFileRevision | null = null
  ) => {
    if (!managedProject || !executionId || !runtime) return;
    if (pendingFile) {
      setError("Check the current file operation before starting another.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const started = await managedProject.command({
        operation: "file_start",
        requestId: crypto.randomUUID(),
        executionId,
        executionGeneration: runtime.executionGeneration,
        idempotencyKey: `desktop-file:${crypto.randomUUID()}`,
        fileOperation: {
          kind: "browse",
          path,
          offset,
          limit: 200,
          revision
        }
      });
      if (identityKeyRef.current !== identityKey) return;
      if (started.operation !== "file_start")
        throw new Error("File browser unavailable");
      await settleFile({
        commandId: started.command.id,
        kind: "browse",
        path,
        offset
      });
    } catch (cause) {
      if (identityKeyRef.current !== identityKey) return;
      setError(
        cause instanceof Error ? cause.message : "File browser unavailable"
      );
    } finally {
      if (identityKeyRef.current === identityKey) setBusy(false);
    }
  };
  const attach = async (path: string) => {
    if (!managedProject || !executionId || !runtime) return;
    if (pendingFile) {
      setError("Check the current file operation before starting another.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const started = await managedProject.command({
        operation: "file_start",
        requestId: crypto.randomUUID(),
        executionId,
        executionGeneration: runtime.executionGeneration,
        idempotencyKey: `desktop-file:${crypto.randomUUID()}`,
        fileOperation: { kind: "mention", path, revision: null }
      });
      if (identityKeyRef.current !== identityKey) return;
      if (started.operation !== "file_start")
        throw new Error("File could not be attached");
      await settleFile({
        commandId: started.command.id,
        kind: "mention",
        path
      });
    } catch (cause) {
      if (identityKeyRef.current !== identityKey) return;
      setError(
        cause instanceof Error ? cause.message : "File could not be attached"
      );
    } finally {
      if (identityKeyRef.current === identityKey) setBusy(false);
    }
  };
  useEffect(() => {
    if (!initialFilePicker.current || !runtime || resumeStatus !== "ready")
      return;
    initialFilePicker.current = false;
    void browse();
  }, [runtime, resumeStatus]);
  const events = expandConversationDisplayEvents(detail?.events ?? []);
  const visibleEvents = events.filter(
    (event) =>
      event.actor === "user" ||
      event.actor === "assistant" ||
      event.actor === "agent" ||
      event.actor === "tool"
  );
  const lastFocusLoadRef = useRef("");
  const focusLoadCountRef = useRef({ key: "", count: 0 });
  const [focusUnavailable, setFocusUnavailable] = useState(false);
  useEffect(() => {
    if (!focusEventId) return;
    const focusKey = `${identityKey}\u0000${focusEventId}`;
    if (focusLoadCountRef.current.key !== focusKey) {
      focusLoadCountRef.current = { key: focusKey, count: 0 };
      setFocusUnavailable(false);
    }
    const target = [
      ...(scrollRef.current?.querySelectorAll<HTMLElement>(
        "[data-message-id]"
      ) ?? [])
    ].find((element) => element.dataset.messageId === focusEventId);
    if (target) {
      setFocusUnavailable(false);
      target.scrollIntoView({ block: "center" });
      return;
    }
    if (detail?.status !== "ready") return;
    if (!detail.hasOlder || focusLoadCountRef.current.count >= 20) {
      setFocusUnavailable(true);
      return;
    }
    const loadKey = `${identityKey}\u0000${focusEventId}\u0000${detail.events.length}`;
    if (lastFocusLoadRef.current === loadKey) return;
    lastFocusLoadRef.current = loadKey;
    focusLoadCountRef.current.count++;
    void loadOlder();
  }, [
    focusEventId,
    identityKey,
    detail?.events.length,
    detail?.hasOlder,
    detail?.status,
    visibleEvents.length,
    loadOlder
  ]);
  const citationTurnIds = [
    ...new Set(
      visibleEvents
        .filter(
          (event) => event.actor === "assistant" || event.actor === "agent"
        )
        .map((event) => event.metadata.providerTurnId)
        .filter((value): value is string => typeof value === "string")
    )
  ];
  const citationTurnKey = citationTurnIds.join("\u0000");
  const citationCommandRevision = runtime?.latestCommand
    ? `${runtime.latestCommand.id}\u0000${runtime.latestCommand.state}`
    : "";
  const completedCitationTags = [
    ...new Set(
      visibleEvents.flatMap((event) =>
        event.actor === "assistant" || event.actor === "agent"
          ? [
              ...conversationEventText(event).matchAll(
                /\[m:([A-Za-z0-9_-]+)\]/g
              )
            ].map((match) => match[1]!)
          : []
      )
    )
  ]
    .sort()
    .join("\u0000");
  useEffect(() => {
    if (
      !api?.turnCitations ||
      !executionId ||
      (!citationTurnIds.length && !completedCitationTags)
    )
      return;
    let cancelled = false;
    const generation = citationGeneration;
    const aliasBatches = citationAliasBatches(completedCitationTags);
    const byTurn = Promise.all(
      citationTurnIds.map(async (turnId) => {
        try {
          return [
            turnId,
            (await api.turnCitations!(executionId, turnId)).citations
          ] as const;
        } catch {
          return [turnId, []] as const;
        }
      })
    );
    const byAlias = (async () => {
      const cited: ManagedConversationTurnCitation[] = [];
      for (const aliases of aliasBatches) {
        if (cancelled || citationScopeRef.current.generation !== generation)
          break;
        try {
          const result = await api.turnCitations!(
            executionId,
            "alias-lookup",
            aliases
          );
          cited.push(...result.citations);
        } catch {
          // One unavailable batch must not hide verified aliases in other batches.
        }
      }
      return cited;
    })();
    void Promise.all([byTurn, byAlias]).then(([entries, cited]) => {
      if (!cancelled && citationScopeRef.current.generation === generation)
        setCitationState({
          generation,
          byTurn: Object.fromEntries(entries),
          byAlias: cited
        });
    });
    return () => {
      cancelled = true;
    };
  }, [
    api,
    executionId,
    citationTurnKey,
    completedCitationTags,
    citationCommandRevision,
    citationGeneration
  ]);
  const visibleOptimistic = optimistic.filter(
    (item) =>
      !visibleEvents.some(
        (event) =>
          event.actor === "user" &&
          event.metadata.clientUserMessageId === item.id
      )
  );
  const timelineRevision = JSON.stringify([
    visibleEvents.map((event) => [event.id, conversationEventText(event)]),
    runtime?.items
  ]);
  const isBlank =
    visibleEvents.length === 0 &&
    visibleOptimistic.length === 0 &&
    (!draft?.initialPrompt || draft.initialPrompt.status === "rejected");
  const selectedProject = [project];
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll && stickToBottom.current) scroll.scrollTop = scroll.scrollHeight;
  }, [
    timelineRevision,
    visibleOptimistic.length,
    runtime?.items.length,
    active
  ]);
  useEffect(() => {
    if (!privateProjectHq || !inspectorOpen) return;
    citationRequestSequence.current++;
    setCitationDetailState({ generation: citationGeneration, citation: null });
    setCitationLoading(false);
  }, [privateProjectHq, inspectorOpen, citationGeneration]);
  const citationPaneHost =
    typeof document === "undefined"
      ? null
      : document.querySelector(".hq-main-panel");
  const citationPane =
    privateProjectHq && inspectorOpen ? null : (
      <CitationDetail
        citation={citationDetail}
        loading={
          citationDetailState.generation === citationGeneration &&
          citationLoading
        }
        onOpenMessage={async (target) => {
          const selected = citationDetail;
          if (
            !selected ||
            !api?.citationDetail ||
            !executionId ||
            !onOpenCitationMessage
          )
            return false;
          const generation = citationGeneration;
          const sequence = ++citationRequestSequence.current;
          try {
            const fresh = (
              await api.citationDetail(
                executionId,
                selected.providerTurnId,
                selected.alias
              )
            ).citation;
            if (
              citationScopeRef.current.generation !== generation ||
              citationRequestSequence.current !== sequence
            )
              return false;
            if (
              !fresh?.detailAvailable ||
              fresh.visibility !== "personal" ||
              fresh.sourceType !== "message" ||
              fresh.sourceId !== selected.sourceId ||
              fresh.alias !== selected.alias ||
              !fresh.messageTarget ||
              fresh.messageTarget.messageId !== target.messageId ||
              fresh.messageTarget.sessionId !== target.sessionId ||
              fresh.messageTarget.projectId !== target.projectId ||
              fresh.messageTarget.threadId !== target.threadId
            )
              return false;
            return await onOpenCitationMessage(target);
          } catch {
            return false;
          }
        }}
        onClose={() => {
          citationRequestSequence.current++;
          setCitationDetailState({
            generation: citationGeneration,
            citation: null
          });
          setCitationLoading(false);
        }}
      />
    );
  return (
    <div
      className={`hq-conversation ${isBlank ? "hq-conversation--blank" : "hq-conversation--active"}`}
    >
      {privateProjectHq ? (
        <div
          className="hq-project-conversation__inspector"
          hidden={!inspectorOpen}
          ref={panelHostRef}
        />
      ) : null}
      {citationPaneHost
        ? createPortal(citationPane, citationPaneHost)
        : citationPane}
      {!isBlank ? (
        <div
          className="hq-conversation__scroll"
          hidden={privateProjectHq && inspectorOpen}
          ref={scrollRef}
          onScroll={(event) => {
            const target = event.currentTarget;
            stickToBottom.current =
              target.scrollHeight - target.scrollTop - target.clientHeight < 80;
          }}
        >
          <div className="hq-conversation__thread">
            {focusUnavailable ? (
              <p role="status">Source message unavailable.</p>
            ) : null}
            {detail?.hasOlder ? (
              <button type="button" onClick={() => void loadOlder()}>
                Load older messages
              </button>
            ) : null}
            {detail?.status === "error" ? (
              <button type="button" onClick={() => void retry()}>
                Retry loading messages
              </button>
            ) : null}
            {visibleEvents.map((event, index) => {
              const message = conversationEventText(event);
              if (!message) return null;
              const user = event.actor === "user";
              const precedingUser = visibleEvents
                .slice(0, index)
                .reverse()
                .find((candidate) => candidate.actor === "user");
              return (
                <article
                  className={`hq-conversation__message ${user ? "hq-conversation__message--user" : "hq-conversation__message--assistant"}`}
                  key={event.id}
                  data-message-id={event.id}
                >
                  {!user ? <b>AI Client</b> : null}
                  {user ? (
                    <p className="hq-conversation__bubble">{message}</p>
                  ) : (
                    <CitedAnswer
                      source={message}
                      citations={
                        event.metadata.providerTurnId
                          ? (citationsByTurn[event.metadata.providerTurnId] ??
                            [])
                          : citationsByAlias
                      }
                      adapters={markdownAdapters}
                      onOpen={openCitation}
                    />
                  )}
                  <div className="hq-conversation__actions">
                    <button
                      aria-label={`Copy ${user ? "message" : "reply"}`}
                      type="button"
                      onClick={() =>
                        void markdownAdapters.writeClipboard(message)
                      }
                    >
                      <Copy size={14} />
                    </button>
                    {!user &&
                    precedingUser &&
                    !active &&
                    !uncertainSend &&
                    resumeStatus === "ready" ? (
                      <button
                        aria-label="Retry last prompt"
                        type="button"
                        onClick={() =>
                          setPrompt(conversationEventText(precedingUser))
                        }
                      >
                        <RotateCcw size={14} />
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
            {executionId && window.koedDesktop?.managedMemoryActions ? (
              <ManagedMemoryActions
                key={`${citationGeneration}:${executionId}`}
                api={window.koedDesktop.managedMemoryActions}
                executionId={executionId}
                ownerId={visibilityOwnerId ?? undefined}
                profileKey={identityKey}
                onOfferChatForget={onOfferChatForget}
                onChanged={() => void refresh()}
              />
            ) : null}
            {visibleOptimistic.map((item) => (
              <article
                className="hq-conversation__message hq-conversation__message--user"
                key={item.id}
              >
                <p className="hq-conversation__bubble">{item.prompt}</p>
                <small>
                  {item.status === "queued" ? "Queued" : "Sending…"}
                </small>
              </article>
            ))}
            {draft?.initialPrompt &&
            draft.initialPrompt.status !== "rejected" &&
            !visibleEvents.some(
              (event) =>
                event.actor === "user" &&
                event.metadata.clientUserMessageId ===
                  draft.initialPrompt?.clientUserMessageId
            ) ? (
              <article className="hq-conversation__message hq-conversation__message--user">
                <p className="hq-conversation__bubble">
                  {draft.initialPrompt.prompt}
                </p>
              </article>
            ) : null}
            {runtime?.items
              .filter(
                (item) =>
                  item.itemKind === "transient_output" &&
                  item.presentation.renderer === "message" &&
                  !visibleEvents.some(
                    (event) =>
                      (event.actor === "assistant" ||
                        event.actor === "agent") &&
                      Date.parse(event.timestamp) >= Date.parse(item.createdAt)
                  )
              )
              .map((item) =>
                typeof item.payload.text === "string" ? (
                  <article
                    className="hq-conversation__message hq-conversation__message--assistant"
                    key={item.id}
                  >
                    <b>AI Client</b>
                    <CitedAnswer
                      source={item.payload.text}
                      citations={[]}
                      adapters={markdownAdapters}
                      onOpen={openCitation}
                    />
                  </article>
                ) : null
              )}
            {runtime?.items
              .filter((item) => item.itemKind !== "transient_output")
              .map((item) => (
                <HqRuntimeItem
                  key={item.id}
                  item={item}
                  busy={busy}
                  onRespond={(response) => void respond(item, response)}
                />
              ))}
            {active ? (
              <p className="hq-conversation__working" role="status">
                The AI Client is working…
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <div
          className="hq-conversation__hero"
          hidden={privateProjectHq && inspectorOpen}
        >
          <h1>
            {options?.instances.find(
              (item) => item.instanceId === selection.instanceId
            )?.displayName ?? "New Conversation"}
          </h1>
          {runtime?.items
            .filter((item) => item.itemKind !== "transient_output")
            .map((item) => (
              <HqRuntimeItem
                key={item.id}
                item={item}
                busy={busy}
                onRespond={(response) => void respond(item, response)}
              />
            ))}
        </div>
      )}
      <div
        className={
          isBlank ? "hq-conversation__hero-composer" : "hq-conversation__dock"
        }
      >
        {draft?.status === "failed" || draft?.status === "reconciling" ? (
          <button type="button" onClick={onRetryStart}>
            <RotateCcw size={15} /> Retry starting Conversation
          </button>
        ) : null}
        {runtime?.latestCommand?.state === "indeterminate" ? (
          <p className="hq-conversation-error" role="alert">
            Koed cannot prove whether the last command reached the AI Client. It
            will not retry automatically.
          </p>
        ) : null}
        <Composer
          visibility={privateProjectHq ? "personal-private" : visibility}
          privateProjectHq={privateProjectHq}
          contextLabel={contextLabel}
          onClearContext={onClearContext}
          value={prompt}
          setValue={(value) => {
            if (sendLocked || resumeStatus === "read_only" || !recoveryReady)
              return;
            promptEdited.current = true;
            pending.current = null;
            setPrompt(value);
            if (api && conversation) scheduleAutosave(value, conversation);
          }}
          onSubmit={() => void send()}
          onAttach={
            managedProject &&
            runtime &&
            resumeStatus !== "read_only" &&
            !sendLocked
              ? () => void browse()
              : undefined
          }
          attachments={attachments}
          onRemoveAttachment={(id) => {
            if (!sendLocked && resumeStatus === "ready" && recoveryReady)
              setAttachments((current) =>
                current.filter((item) => item.commandId !== id)
              );
          }}
          projects={selectedProject}
          projectId={project.id}
          options={options}
          selection={selection}
          onSelectionChange={(value) => {
            if (!sendLocked && resumeStatus === "ready" && recoveryReady) {
              setSelection(value);
              setSettingsDirty(true);
            }
          }}
          locked
          lockDraft={
            sendLocked ||
            resumeStatus === "read_only" ||
            !recoveryReady ||
            runtime?.executionState === "failed"
          }
          settingsDisabled={
            sendLocked || resumeStatus !== "ready" || !recoveryReady
          }
          busy={busy}
          canSend={Boolean(
            api &&
            conversation?.executionId &&
            recoveryReady &&
            runtime &&
            expectedForExecution === conversation.executionId &&
            resumeStatus !== "read_only" &&
            resumeStatus !== "reconciling" &&
            !sendLocked &&
            prompt.trim() &&
            expected &&
            !runtimeBusy &&
            runtime?.executionState !== "failed" &&
            hqSelectionIsSupported(options, selection)
          )}
          active={Boolean(active)}
          onStop={() => void control("interrupt")}
          error={
            error ||
            slash.error ||
            (draft?.initialPrompt?.status === "rejected" &&
            prompt === draft.initialPrompt.prompt
              ? draft.initialPrompt.message
              : "")
          }
          slashCommands={slash.commands}
        />
        {sendLocked ? (
          <div className="hq-conversation__uncertain">
            <button
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Check delivery
            </button>
            <button
              type="button"
              disabled={
                busy ||
                Boolean(active) ||
                Boolean(matchingTerminal) ||
                !recoveryReady
              }
              onClick={() => void send(true)}
            >
              Retry the same prompt
            </button>
          </div>
        ) : null}
        {!privateProjectHq && usage?.usage ? (
          <p
            className="hq-conversation__usage"
            title={`Input ${usage.usage.inputTokens ?? 0} · Output ${usage.usage.outputTokens ?? 0}`}
          >
            {usage.model ?? "AI Client"} ·{" "}
            {usage.usage.usedTokens ?? usage.usage.totalProcessedTokens ?? 0}{" "}
            tokens
            {usage.usage.modelContextWindow
              ? ` / ${usage.usage.modelContextWindow}`
              : ""}
          </p>
        ) : null}
        {resumeStatus === "read_only" ? (
          <p role="status">This Captured Conversation is read-only.</p>
        ) : null}
        {lifecycle?.recoveryStatus === "unavailable" ? (
          <p role="status">
            Secure Conversation recovery is unavailable. Sending is paused.
          </p>
        ) : null}
        {!privateProjectHq &&
        authorizeTransfer &&
        executionId &&
        resumeStatus === "ready" ? (
          <details
            className="hq-conversation__transfer"
            onToggle={(event) => {
              if (!event.currentTarget.open || devices.length || !api) return;
              void api
                .targets()
                .then((result) => {
                  if (identityKeyRef.current !== identityKey) return;
                  setDevices(result.devices);
                  setDeviceId(result.devices[0]?.deviceId ?? "");
                  setTransferMessage(
                    result.devices.length
                      ? ""
                      : "No other enrolled Personal Device is available."
                  );
                })
                .catch(() => {
                  if (identityKeyRef.current === identityKey)
                    setTransferMessage("Personal Devices are unavailable.");
                });
            }}
          >
            <summary>Switch device</summary>
            <select
              aria-label="Personal Device"
              value={deviceId}
              onChange={(event) => setDeviceId(event.target.value)}
              disabled={!devices.length || transferBusy}
            >
              {devices.map((item) => (
                <option key={item.deviceId} value={item.deviceId}>
                  {item.label ?? `Device ${item.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!deviceId || transferBusy}
              onClick={() => void transfer("handoff")}
            >
              Move
            </button>
            <button
              type="button"
              disabled={!deviceId || transferBusy}
              onClick={() => void transfer("fork")}
            >
              Fork
            </button>
            {transferMessage ? <p role="status">{transferMessage}</p> : null}
          </details>
        ) : null}
        {runtime?.executionState === "running" && !active ? (
          <button
            className="hq-conversation__stop"
            type="button"
            disabled={busy}
            onClick={() => void control("stop")}
          >
            Stop Conversation
          </button>
        ) : null}
        {fileOpen ? (
          <div
            className="hq-file-picker"
            role="dialog"
            aria-label="Attach a Project file"
          >
            <div>
              <strong>Project files</strong>
              <button
                aria-label="Close file picker"
                onClick={() => setFileOpen(false)}
                type="button"
              >
                <X size={16} />
              </button>
            </div>
            {filePath ? (
              <button
                onClick={() =>
                  void browse(filePath.split("/").slice(0, -1).join("/"))
                }
                type="button"
              >
                ..
              </button>
            ) : null}
            {files.map((item) => (
              <button
                key={item.path}
                onClick={() =>
                  item.entryKind === "directory"
                    ? void browse(item.path)
                    : void attach(item.path)
                }
                type="button"
              >
                {item.name}
                {item.entryKind === "directory" ? "/" : ""}
              </button>
            ))}
            {filePage?.nextOffset !== null &&
            filePage?.nextOffset !== undefined ? (
              <button
                type="button"
                disabled={busy || Boolean(pendingFile)}
                onClick={() =>
                  void browse(filePath, filePage.nextOffset!, filePage.revision)
                }
              >
                Load more ({files.length} of {filePage.totalEntries})
              </button>
            ) : null}
          </div>
        ) : null}
        {pendingFile ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError("");
              void settleFile(pendingFile).catch((cause: unknown) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "File operation unavailable."
                )
              );
            }}
          >
            Check file operation
          </button>
        ) : null}
      </div>
    </div>
  );
}
