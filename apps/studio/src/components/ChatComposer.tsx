"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentModelCapability } from "@/lib/agentIdentityEditor";
import { AgentAvatarView } from "@/components/AgentAvatarView";
import {
  matchMentionCandidates,
  mentionQueryAtCursor,
  unresolvedAgentMentions
} from "@/lib/agent-mentions";
import {
  ArrowUp,
  Bold,
  ChevronDown,
  ChevronRight,
  Code,
  Cloud,
  Folder,
  GitBranch,
  Laptop,
  Italic,
  List,
  ListOrdered,
  Minus,
  OctagonAlert,
  Plus,
  RotateCcw,
  Shield,
  SmilePlus,
  Strikethrough,
  Quote,
  Zap
} from "lucide-react";
import { Tooltip } from "./Tooltip";
import { formatComposerText, type ComposerFormat } from "@/lib/chatFormatting";

const MODELS = [
  "GPT-6 Astra",
  "GPT-5.6 Luna",
  "Claude 4 Sonnet",
  "Claude 3.5 Sonnet",
  "GPT-5"
] as const;

const EFFORT_LEVELS = ["Low", "Medium", "High", "Extra High", "Max"] as const;

const DEFAULT_MODEL = MODELS[0];
const DEFAULT_EFFORT_INDEX = 1;

function effortIndexFor(value: string): number {
  const normalized = value.trim().toLowerCase();
  if (normalized === "xhigh" || normalized === "extra high") {
    return EFFORT_LEVELS.indexOf("Extra High");
  }
  return EFFORT_LEVELS.findIndex((level) => level.toLowerCase() === normalized);
}

type AccessMode = "full" | "ask" | "read";
type EnvironmentMode = "local" | "cloud";

export type ChatComposerExecutionPreset = Readonly<{
  environment: EnvironmentMode;
  model: string;
  effort: string;
  access: string;
}>;

export type ChatMentionAgent = Readonly<{
  id: string;
  currentVersion?: number;
  name: string;
  role: string;
  avatar?: { image?: string; spec?: Record<string, unknown> };
  lifecycle: "active" | "retired";
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
}>;

export type ChatComposerSelection = Readonly<{
  agentId: string | null;
  expectedAgentVersion?: number;
  provider: string | null;
  model: string;
  effort: string;
  permissionMode: AccessMode;
  instanceId?: string;
}>;

export type ChatComposerRestoreSelection = Readonly<{
  key: string;
  provider: string;
  model: string;
  effort: string | null;
  permissionMode: AccessMode;
}>;

const ACCESS_MODES: {
  id: AccessMode;
  label: string;
  description: string;
}[] = [
  {
    id: "full",
    label: "Full access",
    description: "Read, write, and run commands without asking"
  },
  {
    id: "ask",
    label: "Ask before run",
    description: "Confirm before writes or shell commands"
  },
  {
    id: "read",
    label: "Read-only",
    description: "Inspect the repo without making changes"
  }
];

type ChatComposerProps = {
  placeholder: string;
  projectName: string;
  branch: string;
  footer?: string;
  value?: string;
  onChange?: (value: string) => void;
  onSend?: (
    text: string,
    selection: ChatComposerSelection
  ) => void | Promise<void>;
  sendEnabled?: boolean;
  sendDisabledReason?: string;
  showExecutionControls?: boolean;
  switchToExecutionControlsOnMention?: boolean;
  showMetaBar?: boolean;
  environmentSwitchDisabled?: boolean;
  executionPreset?: ChatComposerExecutionPreset;
  agents?: readonly ChatMentionAgent[];
  activeAgentId?: string | null;
  onAgentMention?: (agentId: string) => void;
  onActiveAgentChange?: (agentId: string | null) => void;
  modelOptions?: readonly AgentModelCapability[];
  restoreSelection?: ChatComposerRestoreSelection;
  initialPermissionMode?: AccessMode;
  initialModel?: string;
  initialEffort?: string;
  showFormattingToolbar?: boolean;
};

export function ChatComposer({
  placeholder,
  projectName,
  branch,
  footer,
  value,
  onChange,
  onSend,
  sendEnabled = true,
  sendDisabledReason,
  showExecutionControls = true,
  switchToExecutionControlsOnMention = false,
  showMetaBar = true,
  environmentSwitchDisabled = false,
  executionPreset,
  agents = [],
  activeAgentId = null,
  onAgentMention,
  onActiveAgentChange,
  modelOptions = [],
  restoreSelection,
  initialPermissionMode = "full",
  initialModel,
  initialEffort,
  showFormattingToolbar = false
}: ChatComposerProps) {
  const initialAgent = agents.find((agent) => agent.id === activeAgentId);
  const initialAgentCapability = initialAgent
    ? modelOptions.find(
        (option) =>
          option.provider === initialAgent.defaultProvider &&
          option.id === initialAgent.defaultModel
      )
    : undefined;
  const [internalDraft, setInternalDraft] = useState("");
  const [model, setModel] = useState<string>(
    restoreSelection
      ? `${restoreSelection.provider}:${restoreSelection.model}`
      : initialAgent?.defaultProvider && initialAgent.defaultModel
        ? `${initialAgent.defaultProvider}:${initialAgent.defaultModel}`
        : (initialModel ?? initialAgent?.defaultModel ?? DEFAULT_MODEL)
  );
  const [effortIndex, setEffortIndex] = useState<number | null>(() => {
    if (restoreSelection) {
      if (restoreSelection.effort === null) return null;
      const index = effortIndexFor(restoreSelection.effort);
      return index >= 0 ? index : null;
    }
    if (initialAgent) {
      if (!initialAgent.defaultReasoningEffort) return null;
      const index = effortIndexFor(initialAgent.defaultReasoningEffort);
      return index >= 0 ? index : null;
    }
    if (initialEffort !== undefined) {
      if (initialEffort === "") return null;
      const index = effortIndexFor(initialEffort);
      return index >= 0 ? index : null;
    }
    return DEFAULT_EFFORT_INDEX;
  });
  const [unavailableEffort, setUnavailableEffort] = useState<string | null>(
    () => {
      const restored = restoreSelection?.effort;
      if (restored && effortIndexFor(restored) < 0) return restored;
      const preferred = initialAgent?.defaultReasoningEffort;
      return preferred && effortIndexFor(preferred) < 0 ? preferred : null;
    }
  );
  const [accessMode, setAccessMode] = useState<AccessMode>(
    restoreSelection?.permissionMode ?? initialPermissionMode
  );
  const [environment, setEnvironment] = useState<EnvironmentMode>("local");
  const [openMenu, setOpenMenu] = useState<null | "model" | "access" | "emoji">(
    null
  );
  const [isModelListOpen, setIsModelListOpen] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<{
    query: string;
    start: number;
    end: number;
  } | null>(null);
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);
  const [resolvedMentionIds, setResolvedMentionIds] = useState<
    Record<string, string>
  >({});
  const [unsupportedDefaultEffortFor, setUnsupportedDefaultEffortFor] =
    useState<string | null>(() => {
      if (restoreSelection || !initialAgent?.defaultReasoningEffort)
        return null;
      const index = effortIndexFor(initialAgent.defaultReasoningEffort);
      return index < 0 ||
        (modelOptions.length > 0 &&
          !initialAgentCapability?.supportedReasoningEfforts.some(
            (effort) => effortIndexFor(effort) === index
          ))
        ? initialAgent.id
        : null;
    });

  const draft = value ?? internalDraft;
  const draftVersionRef = useRef(0);
  const selectedAgent =
    agents.find((agent) => agent.id === activeAgentId) ?? null;
  const mentionMatches = mentionQuery
    ? matchMentionCandidates(mentionQuery.query, agents)
    : [];
  const mentionIssues = unresolvedAgentMentions(draft, agents).filter(
    (issue) =>
      !resolvedMentionIds[issue.name.toLocaleLowerCase().replace(/\s+/g, "_")]
  );
  const executionControlsVisible =
    showExecutionControls ||
    (switchToExecutionControlsOnMention &&
      (mentionQuery !== null || activeAgentId !== null));
  const formattingToolbarVisible =
    showFormattingToolbar &&
    !(
      switchToExecutionControlsOnMention &&
      (mentionQuery !== null || activeAgentId !== null)
    );
  const effortLabel = unavailableEffort
    ? `Unavailable: ${unavailableEffort}`
    : effortIndex === null
      ? "Not set"
      : EFFORT_LEVELS[effortIndex];
  const selectedAccess =
    ACCESS_MODES.find((mode) => mode.id === accessMode) ?? ACCESS_MODES[0];
  const presetAccess = executionPreset
    ? ACCESS_MODES.find((mode) => {
        const normalizedPresetAccess = executionPreset.access
          .trim()
          .toLowerCase()
          .replace(/[\s_]+/g, "-");
        return (
          mode.id === normalizedPresetAccess ||
          mode.label.toLowerCase().replace(/\s+/g, "-") ===
            normalizedPresetAccess
        );
      })
    : null;
  const effectiveAccess = executionPreset
    ? (presetAccess ?? ACCESS_MODES.find((mode) => mode.id === "read")!)
    : selectedAccess;
  const presetEffortIndex = executionPreset
    ? executionPreset.effort
      ? effortIndexFor(executionPreset.effort) >= 0
        ? effortIndexFor(executionPreset.effort)
        : null
      : null
    : effortIndex;
  const effectiveEffortLabel = executionPreset
    ? (executionPreset.effort ?? "Not set")
    : effortLabel;
  const selectedCapability = modelOptions.find(
    (option) => `${option.provider}:${option.id}` === model
  );
  const effectiveModel =
    executionPreset?.model ?? selectedCapability?.displayName ?? model;
  const availableModelOptions = modelOptions.length
    ? modelOptions.map((option) => ({
        id: `${option.provider}:${option.id}`,
        label: option.displayName?.trim() || option.id
      }))
    : MODELS.map((name) => ({ id: name, label: name }));
  const modelIncompatible = Boolean(
    selectedAgent && modelOptions.length > 0 && !selectedCapability
  );
  const supportedEffortIndex = (value: string) => effortIndexFor(value);
  const supportedEffortIndices = new Set(
    (selectedCapability?.supportedReasoningEfforts ?? [])
      .map(supportedEffortIndex)
      .filter((index) => index >= 0)
  );
  const effortIncompatible = Boolean(
    selectedAgent &&
    selectedCapability &&
    modelOptions.length > 0 &&
    (unsupportedDefaultEffortFor === selectedAgent.id ||
      unavailableEffort !== null ||
      (effortIndex !== null && !supportedEffortIndices.has(effortIndex)))
  );
  const canSend =
    sendEnabled &&
    draft.trim().length > 0 &&
    mentionIssues.length === 0 &&
    !modelIncompatible &&
    !effortIncompatible;

  const setDraft = (nextValue: string) => {
    draftVersionRef.current += 1;
    if (onChange) {
      onChange(nextValue);
      return;
    }
    setInternalDraft(nextValue);
  };

  const applyFormat = (format: ComposerFormat) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const result = formatComposerText(draft, start, end, format);
    setDraft(result.text);
    setMentionQuery(mentionQueryAtCursor(result.text, result.end));
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(result.start, result.end);
    });
  };

  const insertEmoji = (emoji: string) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const next = `${draft.slice(0, start)}${emoji}${draft.slice(end)}`;
    const caret = start + emoji.length;
    setDraft(next);
    setMentionQuery(mentionQueryAtCursor(next, caret));
    setOpenMenu(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  };

  const submitDraft = async () => {
    const trimmed = draft.trim();
    if (!trimmed || !canSend) return;
    const selection: ChatComposerSelection = Object.freeze({
      agentId: activeAgentId,
      ...(selectedAgent?.currentVersion !== undefined
        ? { expectedAgentVersion: selectedAgent.currentVersion }
        : {}),
      provider: selectedCapability?.provider ?? null,
      model: selectedCapability?.id ?? model,
      effort:
        effortIndex === null
          ? ""
          : (selectedCapability?.supportedReasoningEfforts.find(
              (candidate) => effortIndexFor(candidate) === effortIndex
            ) ?? EFFORT_LEVELS[effortIndex]),
      permissionMode: effectiveAccess.id,
      instanceId: selectedCapability?.instanceId
    });
    const submittedDraftVersion = draftVersionRef.current;
    try {
      await onSend?.(trimmed, selection);
      if (draftVersionRef.current === submittedDraftVersion) setDraft("");
      setMentionQuery(null);
    } catch {
      // Keep the draft available for retry when the runtime rejects a turn.
    }
  };

  const resetModelAndEffort = () => {
    if (selectedAgent) {
      setUnavailableEffort(null);
      if (selectedAgent.defaultProvider && selectedAgent.defaultModel) {
        setModel(
          `${selectedAgent.defaultProvider}:${selectedAgent.defaultModel}`
        );
      } else if (selectedAgent.defaultModel) {
        setModel(selectedAgent.defaultModel);
      }
      const index = selectedAgent.defaultReasoningEffort
        ? effortIndexFor(selectedAgent.defaultReasoningEffort)
        : null;
      setEffortIndex(index !== null && index >= 0 ? index : null);
      const targetCapability = modelOptions.find(
        (option) =>
          option.provider === selectedAgent.defaultProvider &&
          option.id === selectedAgent.defaultModel
      );
      setUnsupportedDefaultEffortFor(
        selectedAgent.defaultReasoningEffort &&
          (index === null ||
            index < 0 ||
            (modelOptions.length > 0 &&
              !targetCapability?.supportedReasoningEfforts.some(
                (effort) => effortIndexFor(effort) === index
              )))
          ? selectedAgent.id
          : null
      );
    } else {
      setModel(DEFAULT_MODEL);
      setEffortIndex(DEFAULT_EFFORT_INDEX);
      setUnavailableEffort(null);
      setUnsupportedDefaultEffortFor(null);
    }
    setIsModelListOpen(false);
  };

  const selectMention = (agent: ChatMentionAgent) => {
    if (!mentionQuery) return;
    const mention = `@${agent.name.replace(/\s+/g, "_")} `;
    const nextDraft = `${draft.slice(0, mentionQuery.start)}${mention}${draft.slice(mentionQuery.end)}`;
    setDraft(nextDraft);
    setMentionQuery(null);
    onAgentMention?.(agent.id);
    onActiveAgentChange?.(agent.id);
    setResolvedMentionIds((current) => ({
      ...current,
      [agent.name.toLocaleLowerCase().replace(/\s+/g, "_")]: agent.id
    }));
    if (agent.defaultProvider && agent.defaultModel) {
      setModel(`${agent.defaultProvider}:${agent.defaultModel}`);
    } else if (agent.defaultModel) {
      setModel(agent.defaultModel);
    }
    if (agent.defaultReasoningEffort) {
      const index = effortIndexFor(agent.defaultReasoningEffort);
      setEffortIndex(index >= 0 ? index : null);
      setUnavailableEffort(index >= 0 ? null : agent.defaultReasoningEffort);
      const targetCapability = modelOptions.find(
        (option) =>
          option.provider === agent.defaultProvider &&
          option.id === agent.defaultModel
      );
      setUnsupportedDefaultEffortFor(
        index < 0 ||
          (modelOptions.length > 0 &&
            !targetCapability?.supportedReasoningEfforts.some(
              (effort) => effortIndexFor(effort) === index
            ))
          ? agent.id
          : null
      );
    } else {
      setEffortIndex(null);
      setUnavailableEffort(null);
      setUnsupportedDefaultEffortFor(null);
    }
    textareaRef.current?.focus();
  };

  useEffect(() => {
    if (!openMenu) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) {
        setOpenMenu(null);
        setIsModelListOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
        setIsModelListOpen(false);
      }
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  return (
    <div ref={composerRef} className="relative">
      {showMetaBar && (
        <div className="mb-1.5 flex items-center gap-3 overflow-hidden rounded-lg bg-surface-hover/70 px-3 py-1.5 text-xs text-foreground-secondary">
          <span className="flex min-w-0 items-center gap-1.5">
            <Folder className="h-3.5 w-3.5 flex-shrink-0 text-subtle" />
            <span className="truncate">{projectName}</span>
          </span>
          {executionControlsVisible && executionPreset ? (
            <span
              className="flex flex-shrink-0 items-center gap-1.5 text-subtle"
              title={`${executionPreset.environment === "local" ? "Local" : "Cloud"} execution selected`}
            >
              {executionPreset.environment === "local" ? (
                <Laptop className="h-3.5 w-3.5" />
              ) : (
                <Cloud className="h-3.5 w-3.5" />
              )}
              <span>
                {executionPreset.environment === "local" ? "Local" : "Cloud"}
              </span>
            </span>
          ) : executionControlsVisible ? (
            environmentSwitchDisabled ? (
              <Tooltip
                content="Cloud execution is not connected for this chat."
                side="top"
              >
                <span className="flex flex-shrink-0 items-center gap-1.5 text-subtle">
                  <button
                    type="button"
                    className="flex items-center gap-1.5"
                    disabled
                    aria-label="Local execution selected. Cloud execution is not connected for this chat."
                  >
                    <Laptop className="h-3.5 w-3.5" />
                    <span>Local</span>
                  </button>
                </span>
              </Tooltip>
            ) : (
              <button
                type="button"
                className="flex flex-shrink-0 items-center gap-1.5 transition-colors hover:text-foreground"
                onClick={() =>
                  setEnvironment((current) =>
                    current === "local" ? "cloud" : "local"
                  )
                }
                aria-label={
                  environment === "local"
                    ? "Local execution selected. Click to select cloud."
                    : "Cloud execution selected. Click to select local."
                }
              >
                {environment === "local" ? (
                  <Laptop className="h-3.5 w-3.5 text-subtle" />
                ) : (
                  <Cloud className="h-3.5 w-3.5 text-subtle" />
                )}
                <span>{environment === "local" ? "Local" : "Cloud"}</span>
              </button>
            )
          ) : (
            <span className="flex-shrink-0 text-subtle">Not connected</span>
          )}
          <span className="flex min-w-0 items-center gap-1.5">
            <GitBranch className="h-3.5 w-3.5 flex-shrink-0 text-subtle" />
            <span className="truncate">{branch}</span>
          </span>
        </div>
      )}

      <div className="rounded-xl border border-border bg-surface p-2 shadow-lg shadow-black/50 transition-all focus-within:ring-1 focus-within:ring-accent">
        {selectedAgent && (
          <div className="mb-2 flex items-center gap-2 border-b border-border px-2 pb-2 text-xs text-foreground-secondary">
            <AgentAvatarView
              image={selectedAgent.avatar?.image}
              spec={selectedAgent.avatar?.spec}
              name={selectedAgent.name}
              size="sm"
            />
            <span className="min-w-0 truncate">{selectedAgent.name}</span>
            <span className="text-subtle">Active respondent</span>
          </div>
        )}
        <textarea
          ref={textareaRef}
          placeholder={placeholder}
          className="min-h-[44px] max-h-48 w-full resize-none bg-transparent p-2 text-[15px] text-foreground outline-none placeholder-subtle"
          rows={1}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setHighlightedMentionIndex(0);
            setMentionQuery(
              mentionQueryAtCursor(
                event.target.value,
                event.target.selectionStart
              )
            );
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && !event.shiftKey) {
              const format =
                event.key.toLowerCase() === "b"
                  ? "bold"
                  : event.key.toLowerCase() === "i"
                    ? "italic"
                    : null;
              if (format) {
                event.preventDefault();
                applyFormat(format);
                return;
              }
            }
            if (mentionQuery && mentionMatches.length > 0) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setHighlightedMentionIndex(
                  (current) =>
                    (current + delta + mentionMatches.length) %
                    mentionMatches.length
                );
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                selectMention(
                  mentionMatches[highlightedMentionIndex] ?? mentionMatches[0]
                );
                return;
              }
            }
            if (event.key === "Escape" && mentionQuery) {
              event.preventDefault();
              setMentionQuery(null);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submitDraft();
            }
          }}
        />

        {formattingToolbarVisible && (
          <div
            className="mb-1 flex flex-wrap items-center gap-0.5 border-t border-border px-1 pt-1"
            role="toolbar"
            aria-label="Message formatting"
          >
            {(
              [
                ["bold", Bold, "Bold"],
                ["italic", Italic, "Italic"],
                ["strike", Strikethrough, "Strikethrough"],
                ["inline-code", Code, "Inline code"],
                ["code-block", Code, "Code block"],
                ["quote", Quote, "Quote"],
                ["bullet-list", List, "Bulleted list"],
                ["numbered-list", ListOrdered, "Numbered list"]
              ] as const
            ).map(([format, Icon, label]) => (
              <button
                key={format}
                type="button"
                aria-label={label}
                title={label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyFormat(format)}
                className="rounded p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground"
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
            <div className="relative">
              <button
                type="button"
                aria-label="Insert emoji"
                title="Insert emoji"
                aria-expanded={openMenu === "emoji"}
                aria-controls="chat-composer-emoji-picker"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() =>
                  setOpenMenu((current) =>
                    current === "emoji" ? null : "emoji"
                  )
                }
                className="rounded p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground"
              >
                <SmilePlus className="h-3.5 w-3.5" />
              </button>
              {openMenu === "emoji" && (
                <div
                  id="chat-composer-emoji-picker"
                  role="listbox"
                  aria-label="Choose an emoji"
                  className="absolute bottom-full left-0 z-30 mb-2 grid w-56 grid-cols-8 gap-1 rounded-md border border-border-strong bg-surface p-2 shadow-xl"
                >
                  {[
                    "😀",
                    "😂",
                    "😊",
                    "😉",
                    "😍",
                    "🤔",
                    "😅",
                    "😢",
                    "👍",
                    "👎",
                    "🙌",
                    "👏",
                    "🙏",
                    "💪",
                    "👀",
                    "🤝",
                    "❤️",
                    "🎉",
                    "🚀",
                    "✅",
                    "⚠️",
                    "🔥",
                    "✨",
                    "💡",
                    "📌",
                    "📎",
                    "🐛",
                    "⏰",
                    "💬",
                    "🤖",
                    "🧠",
                    "🎯"
                  ].map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      role="option"
                      aria-selected={false}
                      aria-label={emoji}
                      title={emoji}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertEmoji(emoji)}
                      className="rounded p-1 text-base leading-none hover:bg-surface-hover"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {mentionQuery && (
          <div
            className="absolute bottom-full left-2 z-40 mb-2 max-h-56 w-64 overflow-y-auto rounded-lg border border-border-strong bg-surface p-1 shadow-xl"
            role="listbox"
            aria-label="Available agents"
          >
            {mentionMatches.length ? (
              mentionMatches.map((agent, index) => {
                const duplicateCount = agents.filter(
                  (candidate) =>
                    candidate.name.toLocaleLowerCase() ===
                    agent.name.toLocaleLowerCase()
                ).length;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    role="option"
                    aria-selected={index === highlightedMentionIndex}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left ${index === highlightedMentionIndex ? "bg-surface-hover" : "hover:bg-surface-hover"}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectMention(agent)}
                  >
                    <AgentAvatarView
                      image={agent.avatar?.image}
                      spec={agent.avatar?.spec}
                      name={agent.name}
                      size="sm"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-xs text-foreground">
                        {agent.name}
                      </span>
                      <span className="block truncate text-[10px] text-subtle">
                        {agent.role}
                        {duplicateCount > 1 ? ` · ${agent.id.slice(-6)}` : ""}
                      </span>
                    </span>
                  </button>
                );
              })
            ) : (
              <p className="px-2 py-2 text-xs text-muted">
                No available agents match this mention.
              </p>
            )}
          </div>
        )}

        {mentionIssues.length > 0 && (
          <p className="px-2 pb-2 text-xs text-warning" role="status">
            {mentionIssues[0].kind === "ambiguous"
              ? `Select which ${mentionIssues[0].name} to address.`
              : mentionIssues[0].kind === "unselected"
                ? `Select ${mentionIssues[0].name} from the agent list to resolve its identity.`
                : mentionIssues[0].kind === "retired"
                  ? `${mentionIssues[0].name} is retired and cannot be addressed.`
                  : `No available agent named ${mentionIssues[0].name}.`}
          </p>
        )}
        {modelIncompatible && (
          <p className="px-2 pb-2 text-xs text-warning" role="status">
            The active agent&apos;s preferred model is unavailable. Select a
            supported model before sending.
          </p>
        )}
        {effortIncompatible && (
          <p className="px-2 pb-2 text-xs text-warning" role="status">
            The selected reasoning effort is unavailable for this model. Choose
            a supported effort before sending.
          </p>
        )}

        <div className="mt-1 flex items-center justify-between gap-2 pt-1">
          <div className="flex min-w-0 items-center gap-1">
            {executionControlsVisible && (
              <>
                {!executionPreset && (
                  <Tooltip content="Add context" side="top">
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary"
                      aria-label="Add context"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </Tooltip>
                )}

                <div className="relative">
                  <button
                    type="button"
                    className={`flex min-w-0 max-w-[9rem] items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium transition-colors ${
                      effectiveAccess.id === "full"
                        ? "text-danger hover:bg-danger/10"
                        : effectiveAccess.id === "ask"
                          ? "text-warning hover:bg-warning/10"
                          : "text-muted hover:bg-surface-hover"
                    }`}
                    onClick={() => {
                      setIsModelListOpen(false);
                      setOpenMenu((current) =>
                        current === "access" ? null : "access"
                      );
                    }}
                    aria-expanded={openMenu === "access"}
                    aria-label="Select execution access"
                    title={
                      executionPreset
                        ? "Read-only is enforced for this chat"
                        : "Select execution access"
                    }
                  >
                    {effectiveAccess.id === "read" ? (
                      <Shield className="h-3.5 w-3.5" />
                    ) : (
                      <OctagonAlert className="h-3.5 w-3.5" />
                    )}
                    <span className="truncate">{effectiveAccess.label}</span>
                  </button>

                  {openMenu === "access" && (
                    <div className="absolute bottom-full left-0 z-30 mb-2 w-56 rounded-xl border border-border-strong bg-surface p-1 shadow-xl shadow-black/50">
                      {ACCESS_MODES.map((mode) => {
                        const disabled = Boolean(
                          executionPreset && mode.id !== effectiveAccess.id
                        );
                        return (
                          <button
                            key={mode.id}
                            type="button"
                            disabled={disabled}
                            className={`flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition-colors ${
                              mode.id === effectiveAccess.id
                                ? "bg-surface-hover"
                                : disabled
                                  ? "cursor-not-allowed opacity-45"
                                  : "hover:bg-surface-hover/70"
                            }`}
                            onClick={() => {
                              if (disabled) return;
                              setAccessMode(mode.id);
                              setOpenMenu(null);
                            }}
                            title={
                              disabled
                                ? "This chat runtime is fixed to read-only"
                                : undefined
                            }
                          >
                            <span
                              className={`text-xs font-medium ${mode.id === "full" ? "text-danger" : "text-foreground-secondary"}`}
                            >
                              {mode.label}
                            </span>
                            <span className="mt-0.5 text-[11px] leading-snug text-subtle">
                              {disabled
                                ? "Unavailable for this chat runtime"
                                : mode.description}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="flex flex-shrink-0 items-center gap-1">
            {executionControlsVisible && (
              <div className="relative">
                <button
                  type="button"
                  className="flex min-w-0 max-w-[12rem] items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-surface-hover"
                  onClick={() => {
                    setOpenMenu((current) =>
                      current === "model" ? null : "model"
                    );
                    setIsModelListOpen(false);
                  }}
                  aria-expanded={openMenu === "model"}
                  aria-label="Select model and effort"
                >
                  <span className="max-w-[8rem] truncate text-foreground-secondary">
                    {effectiveModel}
                  </span>
                  <span className="text-subtle">{effectiveEffortLabel}</span>
                  <ChevronDown className="h-3 w-3 text-subtle" />
                </button>

                {openMenu === "model" && (
                  <div className="absolute bottom-full right-0 z-30 mb-2 w-[220px] rounded-2xl border border-border-strong bg-surface px-3 py-3 shadow-xl shadow-black/50">
                    <div className="mb-3 flex items-start justify-between">
                      <Zap className="mt-0.5 h-4 w-4 text-subtle" />
                      <button
                        type="button"
                        className="flex flex-col items-center"
                        onClick={() =>
                          setIsModelListOpen((current) => !current)
                        }
                      >
                        <span className="flex items-center gap-0.5 text-sm font-medium text-accent">
                          {effectiveEffortLabel}
                          <ChevronRight className="h-3.5 w-3.5" />
                        </span>
                        <span className="text-[11px] text-muted">
                          {effectiveModel}
                        </span>
                      </button>
                      <Tooltip content="Reset to defaults" side="top">
                        <button
                          type="button"
                          className="rounded-md p-0.5 text-subtle hover:text-foreground-secondary"
                          onClick={resetModelAndEffort}
                          aria-label="Reset model and effort"
                          disabled={Boolean(executionPreset)}
                          title={
                            executionPreset
                              ? "Model and effort are fixed for this chat runtime"
                              : undefined
                          }
                        >
                          <RotateCcw className="h-4 w-4" />
                        </button>
                      </Tooltip>
                    </div>

                    <EffortSlider
                      effortIndex={presetEffortIndex}
                      onChange={(index) => {
                        setEffortIndex(index);
                        setUnavailableEffort(null);
                        setUnsupportedDefaultEffortFor(null);
                      }}
                      disabled={Boolean(executionPreset)}
                      supportedIndices={
                        modelOptions.length && selectedCapability
                          ? supportedEffortIndices
                          : undefined
                      }
                    />

                    {isModelListOpen && (
                      <div className="mt-3 space-y-0.5 border-t border-border pt-2">
                        {availableModelOptions.map((option) => {
                          const disabled = Boolean(
                            executionPreset &&
                            option.label !== executionPreset.model
                          );
                          return (
                            <button
                              key={option.id}
                              type="button"
                              disabled={disabled}
                              className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                                option.label === effectiveModel
                                  ? "bg-surface-hover text-foreground"
                                  : disabled
                                    ? "cursor-not-allowed text-muted opacity-45"
                                    : "text-muted hover:bg-surface-hover/70 hover:text-foreground-secondary"
                              }`}
                              onClick={() => {
                                if (disabled) return;
                                setModel(option.id);
                                setIsModelListOpen(false);
                              }}
                              title={
                                disabled
                                  ? "Unavailable for this chat runtime"
                                  : undefined
                              }
                            >
                              {option.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              className="rounded-full bg-chip p-1.5 text-chip-foreground transition-colors hover:bg-white disabled:opacity-40 disabled:hover:bg-chip"
              disabled={!canSend}
              title={sendEnabled ? "Send message" : sendDisabledReason}
              onClick={submitDraft}
              aria-label="Send message"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {footer && (
        <div className="mt-2 text-center text-[10px] text-faint">{footer}</div>
      )}
    </div>
  );
}

function EffortSlider({
  effortIndex,
  onChange,
  disabled = false,
  supportedIndices
}: {
  effortIndex: number | null;
  onChange: (index: number | null) => void;
  disabled?: boolean;
  supportedIndices?: ReadonlySet<number>;
}) {
  const fillPercent =
    effortIndex === null ? 0 : (effortIndex / (EFFORT_LEVELS.length - 1)) * 100;

  return (
    <div className="relative px-1 pt-1">
      <div className="absolute left-2.5 right-2.5 top-[11px] h-1 rounded-full bg-surface-active">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${fillPercent}%` }}
        />
      </div>
      <div className="relative flex items-center justify-between">
        {EFFORT_LEVELS.map((level, index) => {
          const isSelected = index === effortIndex;
          const isFilled = effortIndex !== null && index <= effortIndex;
          const isSupported = !supportedIndices || supportedIndices.has(index);

          return (
            <button
              key={level}
              type="button"
              aria-label={level}
              aria-pressed={isSelected}
              className={`relative z-10 h-3.5 w-3.5 rounded-full border-2 transition-colors ${
                isSelected
                  ? "border-white bg-white shadow-sm"
                  : isFilled
                    ? "border-accent bg-accent"
                    : "border-border-strong bg-surface-hover"
              } ${disabled || !isSupported ? "cursor-not-allowed opacity-45" : ""}`}
              onClick={() => {
                if (!disabled && isSupported) onChange(index);
              }}
              disabled={disabled || !isSupported}
              title={
                disabled
                  ? "Model and effort are fixed for this chat runtime"
                  : !isSupported
                    ? "This model does not support this reasoning effort"
                    : undefined
              }
            />
          );
        })}
      </div>
      <button
        type="button"
        aria-pressed={effortIndex === null}
        className={`mt-2 inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] ${
          effortIndex === null
            ? "bg-surface-hover text-foreground"
            : "text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
        } ${disabled ? "cursor-not-allowed opacity-45" : ""}`}
        disabled={disabled}
        onClick={() => onChange(null)}
        title="Leave reasoning effort unset"
      >
        <Minus className="h-3 w-3" /> Not set
      </button>
    </div>
  );
}
