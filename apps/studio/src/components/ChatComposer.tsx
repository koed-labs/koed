"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import type { AgentModelCapability } from "@/lib/agentIdentityEditor";
import { AgentAvatarView } from "@/components/AgentAvatarView";
import {
  canonicalAgentMentionToken,
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
  Square,
  SmilePlus,
  Strikethrough,
  Quote,
  Zap
} from "lucide-react";
import { Tooltip } from "./Tooltip";
import {
  NativeSkillPicker,
  type NativeSkill,
  type NativeSkillScope,
  type NativeSkillKeyboardHandler
} from "./NativeSkillPicker";
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
  /** Canonical parser-safe token; the display label may include owner context. */
  mentionToken?: string;
  role: string;
  avatar?: { image?: string; spec?: Record<string, unknown> };
  lifecycle: "active" | "retired";
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
  /** Team requests route to the owner's private execution; requester runtime controls do not apply. */
  teamRequestOnly?: boolean;
}>;

export type ChatComposerSelection = Readonly<{
  agentId: string | null;
  mentionUserIds?: string[];
  expectedAgentVersion?: number;
  provider: string | null;
  model: string;
  effort: string;
  permissionMode: AccessMode;
  instanceId?: string;
  hostedInstanceId?: string;
  selectedResourceIds?: string[];
}>;

export type ChatComposerRestoreSelection = Readonly<{
  key: string;
  instanceId?: string;
  hostedInstanceId?: string;
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
  projectSelector?: ReactNode;
  branch: string;
  footer?: string;
  value?: string;
  onChange?: (value: string) => void;
  onSend?: (
    text: string,
    selection: ChatComposerSelection,
    continueWithoutMemory?: true
  ) => void | false | Promise<void | false>;
  memoryRecallFailure?: string | null;
  sendEnabled?: boolean;
  sendDisabledReason?: string;
  showExecutionControls?: boolean;
  switchToExecutionControlsOnMention?: boolean;
  showMetaBar?: boolean;
  environmentSwitchDisabled?: boolean;
  executionPreset?: ChatComposerExecutionPreset;
  agents?: readonly ChatMentionAgent[];
  teamMembers?: readonly { id: string; name: string }[];
  initialMentionUserIds?: readonly string[];
  onMentionUserIdsChange?: (userIds: string[]) => void;
  activeAgentId?: string | null;
  onAgentMention?: (agentId: string) => void;
  onActiveAgentChange?: (agentId: string | null) => void;
  modelOptions?: readonly AgentModelCapability[];
  modelAvailabilityWarning?: string | null;
  clientResourceScope?: NativeSkillScope;
  onSelectedResourceIdsChange?: (resourceIds: string[]) => void;
  restoreSelection?: ChatComposerRestoreSelection;
  initialPermissionMode?: AccessMode;
  initialModel?: string;
  initialEffort?: string;
  showFormattingToolbar?: boolean;
  showContinueWithoutMemory?: boolean;
  showSendButton?: boolean;
  allowEnterNewline?: boolean;
  required?: boolean;
  ariaLabel?: string;
  textareaClassName?: string;
  interruptActive?: boolean;
  interruptDisabled?: boolean;
  onInterrupt?: () => void;
};

export function ChatComposer({
  placeholder,
  projectName,
  projectSelector,
  branch,
  footer,
  value,
  onChange,
  onSend,
  memoryRecallFailure,
  sendEnabled = true,
  sendDisabledReason,
  showExecutionControls = true,
  switchToExecutionControlsOnMention = false,
  showMetaBar = true,
  environmentSwitchDisabled = true,
  executionPreset,
  agents = [],
  teamMembers = [],
  initialMentionUserIds = [],
  onMentionUserIdsChange,
  activeAgentId: controlledActiveAgentId,
  onAgentMention,
  onActiveAgentChange,
  modelOptions = [],
  modelAvailabilityWarning,
  clientResourceScope,
  onSelectedResourceIdsChange,
  restoreSelection,
  initialPermissionMode = "full",
  initialModel,
  initialEffort,
  showFormattingToolbar = false,
  showContinueWithoutMemory = true,
  showSendButton = true,
  allowEnterNewline = false,
  required = false,
  ariaLabel,
  textareaClassName,
  interruptActive = false,
  interruptDisabled = false,
  onInterrupt
}: ChatComposerProps) {
  const [internalActiveAgentId, setInternalActiveAgentId] = useState<
    string | null
  >(null);
  const activeAgentId =
    controlledActiveAgentId === undefined
      ? internalActiveAgentId
      : controlledActiveAgentId;
  const changeActiveAgent = (id: string | null) => {
    if (controlledActiveAgentId === undefined) setInternalActiveAgentId(id);
    onActiveAgentChange?.(id);
  };
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
      ? `${restoreSelection.provider}:${restoreSelection.model}${restoreSelection.hostedInstanceId || restoreSelection.instanceId ? `:${restoreSelection.hostedInstanceId ?? restoreSelection.instanceId}` : ""}`
      : (initialModel ??
          (initialAgent?.defaultProvider && initialAgent.defaultModel
            ? `${initialAgent.defaultProvider}:${initialAgent.defaultModel}`
            : (initialAgent?.defaultModel ?? DEFAULT_MODEL)))
  );
  const [effortIndex, setEffortIndex] = useState<number | null>(() => {
    if (restoreSelection) {
      if (restoreSelection.effort === null) return null;
      const index = effortIndexFor(restoreSelection.effort);
      return index >= 0 ? index : null;
    }
    if (initialEffort !== undefined) {
      if (initialEffort === "") return null;
      const index = effortIndexFor(initialEffort);
      return index >= 0 ? index : null;
    }
    if (initialAgent) {
      if (!initialAgent.defaultReasoningEffort) return null;
      const index = effortIndexFor(initialAgent.defaultReasoningEffort);
      return index >= 0 ? index : null;
    }
    return DEFAULT_EFFORT_INDEX;
  });
  const [unavailableEffort, setUnavailableEffort] = useState<string | null>(
    () => {
      const restored = restoreSelection?.effort;
      if (restored && effortIndexFor(restored) < 0) return restored;
      const preferred = initialEffort ?? initialAgent?.defaultReasoningEffort;
      return preferred && effortIndexFor(preferred) < 0 ? preferred : null;
    }
  );
  const [confirmedAgentModelFor, setConfirmedAgentModelFor] = useState<
    string | null
  >(initialModel && initialAgent ? initialAgent.id : null);
  const [accessMode, setAccessMode] = useState<AccessMode>(
    restoreSelection?.permissionMode ?? initialPermissionMode
  );
  const [environment, setEnvironment] = useState<EnvironmentMode>("local");
  const [openMenu, setOpenMenu] = useState<null | "model" | "access" | "emoji">(
    null
  );
  const [isModelListOpen, setIsModelListOpen] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<{
    key: string;
    skills: NativeSkill[];
  } | null>(null);
  const skillKeyboardRef = useRef<NativeSkillKeyboardHandler | null>(null);
  const [skillCaret, setSkillCaret] = useState<number | null>(null);
  const [dismissedSkillQuery, setDismissedSkillQuery] = useState<string | null>(
    null
  );
  const composerRef = useRef<HTMLDivElement>(null);
  const modelMenuAnchorRef = useRef<HTMLDivElement>(null);
  const [modelMenuLayout, setModelMenuLayout] = useState({
    side: "above" as "above" | "below",
    maxHeight: 360
  });

  useLayoutEffect(() => {
    if (openMenu !== "model") return;
    const anchor = modelMenuAnchorRef.current;
    if (!anchor) return;
    const updateLayout = () => {
      const bounds = anchor.getBoundingClientRect();
      let top = 0;
      let bottom = window.innerHeight;
      // Stay inside the visible part of the composer's scrolling panel,
      // including Home's header, rather than just inside the window.
      for (
        let parent = anchor.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        if (
          /(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)
        ) {
          const rect = parent.getBoundingClientRect();
          top = Math.max(top, rect.top);
          bottom = Math.min(bottom, rect.bottom);
        }
      }
      const above = Math.max(0, bounds.top - top - 16);
      const below = Math.max(0, bottom - bounds.bottom - 16);
      const side = below >= above ? "below" : "above";
      const maxHeight = Math.min(360, side === "below" ? below : above);
      setModelMenuLayout((current) =>
        current.side === side && current.maxHeight === maxHeight
          ? current
          : { side, maxHeight }
      );
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    window.addEventListener("scroll", updateLayout, true);
    const observer = new ResizeObserver(updateLayout);
    observer.observe(anchor);
    return () => {
      window.removeEventListener("resize", updateLayout);
      window.removeEventListener("scroll", updateLayout, true);
      observer.disconnect();
    };
  }, [openMenu]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<{
    query: string;
    start: number;
    end: number;
  } | null>(null);
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);
  const [localResolvedMentionIds, setResolvedMentionIds] = useState<
    Record<string, string>
  >({});
  const byMemberId = new Map(teamMembers.map((member) => [member.id, member]));
  const restoredMentionIds = Object.fromEntries(
    initialMentionUserIds.flatMap((id) => {
      const member = byMemberId.get(id);
      return member
        ? [[canonicalAgentMentionToken(member.name, member.id), id]]
        : [];
    })
  );
  const resolvedMentionIds = {
    ...restoredMentionIds,
    ...localResolvedMentionIds
  };
  const [unsupportedDefaultEffortFor, setUnsupportedDefaultEffortFor] =
    useState<string | null>(() => {
      if (
        restoreSelection ||
        initialEffort !== undefined ||
        !initialAgent?.defaultReasoningEffort
      )
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
  const mentionCandidates: Array<ChatMentionAgent & { teamMember?: boolean }> =
    [
      ...agents,
      ...teamMembers.map((member) => ({
        id: member.id,
        name: member.name,
        mentionToken: canonicalAgentMentionToken(member.name, member.id),
        role: "Team member",
        lifecycle: "active" as const,
        defaultProvider: null,
        defaultModel: null,
        defaultReasoningEffort: null,
        teamMember: true
      }))
    ];
  const mentionMatches = mentionQuery
    ? matchMentionCandidates(mentionQuery.query, mentionCandidates)
    : [];
  const mentionIssues = unresolvedAgentMentions(
    draft,
    mentionCandidates
  ).filter(
    (issue) =>
      !resolvedMentionIds[issue.name.toLocaleLowerCase().replace(/\s+/g, "_")]
  );
  const channelAgentMode =
    switchToExecutionControlsOnMention && selectedAgent !== null;
  const executionControlsVisible =
    showExecutionControls ||
    (channelAgentMode && !selectedAgent?.teamRequestOnly);
  const modelUnavailable =
    channelAgentMode &&
    !selectedAgent?.teamRequestOnly &&
    Boolean(modelAvailabilityWarning);
  const formattingToolbarVisible = showFormattingToolbar && !channelAgentMode;
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
  const effectiveAccessLabel = executionPreset
    ? (presetAccess?.label ?? executionPreset.access)
    : effectiveAccess.label;
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
  const capabilityKey = (option: AgentModelCapability) => {
    const base = `${option.provider}:${option.id}`;
    const duplicates = modelOptions.filter(
      (item) => item.provider === option.provider && item.id === option.id
    );
    return duplicates.length > 1
      ? `${base}:${option.hostedInstanceId ?? option.instanceId ?? "unscoped"}`
      : base;
  };
  const selectedCandidates = modelOptions.filter(
    (option) =>
      capabilityKey(option) === model ||
      `${option.provider}:${option.id}` === model ||
      [option.hostedInstanceId, option.instanceId].some(
        (instanceId) =>
          Boolean(instanceId) &&
          `${option.provider}:${option.id}:${instanceId}` === model
      )
  );
  const selectedCapability =
    selectedCandidates.length === 1 ? selectedCandidates[0] : undefined;
  const resourceScope = clientResourceScope
    ? {
        ...clientResourceScope,
        hostedInstanceId:
          clientResourceScope.hostedInstanceId ??
          selectedCapability?.hostedInstanceId,
        provider: clientResourceScope.provider ?? selectedCapability?.provider,
        instanceId:
          clientResourceScope.instanceId ?? selectedCapability?.instanceId
      }
    : null;
  const skillScopeKey = JSON.stringify(resourceScope);
  const skillSelection =
    selectedSkills?.key === skillScopeKey ? selectedSkills.skills : [];
  useEffect(() => {
    onSelectedResourceIdsChange?.(
      selectedSkills?.key === skillScopeKey
        ? selectedSkills.skills.map((skill) => skill.resourceId)
        : []
    );
  }, [onSelectedResourceIdsChange, selectedSkills, skillScopeKey]);
  const slashMatch =
    resourceScope && executionControlsVisible && !selectedAgent?.teamRequestOnly
      ? /(?:^|\s)\/([^\s/]*)$/.exec(draft.slice(0, skillCaret ?? draft.length))
      : null;
  const slashQuery =
    slashMatch && dismissedSkillQuery !== `${skillScopeKey}:${draft}`
      ? slashMatch[1]
      : null;
  const selectNativeSkill = (skill: NativeSkill) => {
    if (!slashMatch || skillSelection.length >= 8) return;
    setSelectedSkills({
      key: skillScopeKey,
      skills: [
        ...skillSelection.filter(
          (item) => item.resourceId !== skill.resourceId
        ),
        skill
      ]
    });
    const end = skillCaret ?? draft.length;
    const start = end - slashMatch[1].length - 1;
    setDraft(`${draft.slice(0, start)}${draft.slice(end)}`);
    setSkillCaret(start);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(start, start);
    });
  };
  const effectiveModel = modelUnavailable
    ? "Model unavailable"
    : (executionPreset?.model ?? selectedCapability?.displayName ?? model);
  const availableModelOptions = modelOptions.length
    ? modelOptions.map((option) => ({
        id: capabilityKey(option),
        label: `${option.displayName?.trim() || option.id}${modelOptions.filter((item) => item.provider === option.provider && item.id === option.id).length > 1 ? ` · ${option.computerLabel ?? option.instanceId ?? "Choose Client"}` : ""}`
      }))
    : MODELS.map((name) => ({ id: name, label: name }));
  const modelIncompatible = Boolean(
    !executionPreset &&
    executionControlsVisible &&
    !selectedAgent?.teamRequestOnly &&
    modelOptions.length > 0 &&
    !selectedCapability
  );
  const agentNeedsExplicitModelSelection = Boolean(
    !selectedAgent?.teamRequestOnly &&
    selectedAgent &&
    (!selectedAgent.defaultProvider || !selectedAgent.defaultModel) &&
    confirmedAgentModelFor !== selectedAgent.id
  );
  const supportedEffortIndex = (value: string) => effortIndexFor(value);
  const supportedEffortIndices = new Set(
    (selectedCapability?.supportedReasoningEfforts ?? [])
      .map(supportedEffortIndex)
      .filter((index) => index >= 0)
  );
  const effortIncompatible = Boolean(
    !selectedAgent?.teamRequestOnly &&
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
    !agentNeedsExplicitModelSelection &&
    !effortIncompatible;

  const setDraft = (nextValue: string) => {
    draftVersionRef.current += 1;
    const tokens = new Set(
      Array.from(nextValue.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)/gu), (match) =>
        match[1].toLocaleLowerCase().replace(/\s+/g, "_")
      )
    );
    const retained = Object.fromEntries(
      Object.entries(resolvedMentionIds).filter(([token]) => tokens.has(token))
    );
    if (
      Object.keys(retained).length !== Object.keys(resolvedMentionIds).length
    ) {
      setResolvedMentionIds(retained);
      onMentionUserIdsChange?.(
        Array.from(
          new Set(
            Object.values(retained).filter((id) =>
              teamMembers.some((member) => member.id === id)
            )
          )
        )
      );
    }
    if (
      channelAgentMode &&
      !Object.values(retained).includes(activeAgentId ?? "")
    )
      changeActiveAgent(null);
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

  const submitDraft = async (continueWithoutMemory = false) => {
    const trimmed = draft.trim();
    if (!trimmed || !canSend) return;
    const selection: ChatComposerSelection = Object.freeze({
      agentId: activeAgentId,
      mentionUserIds: Array.from(
        new Set(
          Array.from(
            trimmed.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)/gu),
            (match) => {
              const token = match[1].toLocaleLowerCase().replace(/\s+/g, "_");
              const id = resolvedMentionIds[token];
              return teamMembers.some((member) => member.id === id) ? id : null;
            }
          ).filter((id): id is string => Boolean(id))
        )
      ),
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
      ...(skillSelection.length
        ? {
            selectedResourceIds: skillSelection.map((skill) => skill.resourceId)
          }
        : {}),
      ...(selectedCapability?.hostedInstanceId
        ? { hostedInstanceId: selectedCapability.hostedInstanceId }
        : {}),
      instanceId: selectedCapability?.instanceId
    });
    const submittedDraftVersion = draftVersionRef.current;
    try {
      const accepted = await onSend?.(
        trimmed,
        selection,
        continueWithoutMemory ? true : undefined
      );
      // A deferred send (for example, choosing a recipient) retains the draft.
      if (accepted === false) return;
      if (draftVersionRef.current === submittedDraftVersion) {
        setDraft("");
        setSelectedSkills(null);
      }
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

  const selectMention = (
    agent: ChatMentionAgent & { teamMember?: boolean }
  ) => {
    if (!mentionQuery) return;
    const token = agent.mentionToken ?? agent.name.replace(/\s+/g, "_");
    const mention = `@${token} `;
    const nextDraft = `${draft.slice(0, mentionQuery.start)}${mention}${draft.slice(mentionQuery.end)}`;
    setDraft(nextDraft);
    setMentionQuery(null);
    if (!agent.teamMember) {
      onAgentMention?.(agent.id);
      changeActiveAgent(agent.id);
    }
    const nextResolved = {
      ...resolvedMentionIds,
      [token.toLocaleLowerCase().replace(/\s+/g, "_")]: agent.id
    };
    setResolvedMentionIds(nextResolved);
    onMentionUserIdsChange?.(
      Array.from(
        new Set(
          Object.values(nextResolved).filter((id) =>
            teamMembers.some((member) => member.id === id)
          )
        )
      )
    );
    if (agent.teamMember) {
      return;
    }
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

    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      const menu =
        target instanceof Element
          ? target.closest(`[data-composer-menu="${openMenu}"]`)
          : null;
      if (!menu || !composerRef.current?.contains(menu)) {
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

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  return (
    <div ref={composerRef} className="relative [container-type:inline-size]">
      {(showMetaBar || channelAgentMode) && (
        <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-surface-hover/70 px-2.5 py-1.5 text-xs text-foreground-secondary sm:px-3">
          {projectSelector ?? (
            <span
              className="flex min-w-0 items-center gap-1.5"
              title={
                channelAgentMode
                  ? "Agent requests keep their Shared Project context. Ordinary channels choose a Shared Project before opening the private chat."
                  : undefined
              }
            >
              <Folder className="h-3.5 w-3.5 flex-shrink-0 text-subtle" />
              <span className="truncate">{projectName}</span>
            </span>
          )}
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
              <span
                className="flex flex-shrink-0 items-center gap-1.5 text-subtle"
                aria-label="Local execution"
                title="Uses the selected AI Client on this computer"
              >
                <Laptop className="h-3.5 w-3.5" />
                <span>Local</span>
              </span>
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
            {channelAgentMode && (
              <button
                type="button"
                aria-label="Stop addressing Agent"
                onClick={() => changeActiveAgent(null)}
                className="ml-auto text-subtle hover:text-foreground"
              >
                Cancel
              </button>
            )}
            {selectedAgent.teamRequestOnly && (
              <span className="text-subtle">
                The Agent owner chooses execution settings.
              </span>
            )}
          </div>
        )}
        {skillSelection.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1 px-2">
            {skillSelection.map((skill) => (
              <button
                key={skill.resourceId}
                type="button"
                className="rounded border border-border px-2 py-1 text-xs text-foreground-secondary"
                aria-label={`Remove Skill ${skill.name}`}
                onClick={() =>
                  setSelectedSkills({
                    key: skillScopeKey,
                    skills: skillSelection.filter(
                      (item) => item.resourceId !== skill.resourceId
                    )
                  })
                }
              >
                /{skill.name} ×
              </button>
            ))}
          </div>
        )}
        {resourceScope && slashQuery !== null && (
          <NativeSkillPicker
            scope={resourceScope}
            query={slashQuery}
            keyboardRef={skillKeyboardRef}
            onSelect={selectNativeSkill}
            onDismiss={() =>
              setDismissedSkillQuery(`${skillScopeKey}:${draft}`)
            }
          />
        )}
        <textarea
          ref={textareaRef}
          placeholder={placeholder}
          aria-label={ariaLabel}
          required={required}
          className={
            textareaClassName ??
            "min-h-[44px] max-h-48 w-full resize-none bg-transparent p-2 text-[15px] text-foreground outline-none placeholder-subtle"
          }
          rows={allowEnterNewline ? 2 : 1}
          value={draft}
          onSelect={(event) =>
            setSkillCaret(event.currentTarget.selectionStart)
          }
          onChange={(event) => {
            setSkillCaret(event.target.selectionStart);
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
            if (slashQuery !== null && skillKeyboardRef.current?.(event)) {
              event.preventDefault();
              return;
            }
            if (
              slashQuery !== null &&
              (event.key === "Enter" || event.key === "Escape")
            ) {
              event.preventDefault();
              if (event.key === "Escape")
                setDismissedSkillQuery(`${skillScopeKey}:${draft}`);
              return;
            }

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
              if (allowEnterNewline) return;
              event.preventDefault();
              if (interruptActive) {
                if (!interruptDisabled) onInterrupt?.();
              } else submitDraft();
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
            <div className="relative" data-composer-menu="emoji">
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
                  className="absolute bottom-full left-0 z-30 mb-2 grid w-[min(14rem,calc(100cqw-1rem))] grid-cols-8 gap-1 rounded-md border border-border-strong bg-surface p-2 shadow-xl"
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
            className="absolute bottom-full left-2 z-40 mb-2 max-h-56 w-[min(16rem,calc(100cqw-1rem))] overflow-y-auto rounded-lg border border-border-strong bg-surface p-1 shadow-xl"
            role="listbox"
            aria-label="Mention someone"
          >
            {mentionMatches.length ? (
              mentionMatches.map((agent, index) => {
                const duplicateCount = mentionCandidates.filter(
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
                    {agent.teamMember ? (
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-hover text-[10px] font-semibold text-muted">
                        {agent.name.slice(0, 1).toUpperCase()}
                      </span>
                    ) : (
                      <AgentAvatarView
                        image={agent.avatar?.image}
                        spec={agent.avatar?.spec}
                        name={agent.name}
                        size="sm"
                      />
                    )}
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
                No available people match this mention.
              </p>
            )}
          </div>
        )}

        {modelUnavailable && (
          <p role="alert" className="px-2 py-1 text-xs text-warning">
            {modelAvailabilityWarning}
          </p>
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
        {(modelIncompatible || agentNeedsExplicitModelSelection) && (
          <p className="px-2 pb-2 text-xs text-warning" role="status">
            {!selectedAgent
              ? "Choose an available model and AI Client for this chat. If several computers offer this model, select its exact Client."
              : selectedAgent.defaultProvider && selectedAgent.defaultModel
                ? "The active Agent’s default model is unavailable. Choose an available model for this Job from the model control. The Agent profile defaults will stay unchanged."
                : "This Agent has no default model. Choose an available model for this Job from the model control. The Agent profile will stay unchanged."}
          </p>
        )}
        {effortIncompatible && (
          <p className="px-2 pb-2 text-xs text-warning" role="status">
            The selected reasoning effort is unavailable for this model. Choose
            a supported effort before sending.
          </p>
        )}

        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pt-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
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

                <div className="relative" data-composer-menu="access">
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
                        ? "Execution access is fixed for this chat runtime"
                        : "Select execution access"
                    }
                  >
                    {effectiveAccess.id === "read" ? (
                      <Shield className="h-3.5 w-3.5" />
                    ) : (
                      <OctagonAlert className="h-3.5 w-3.5" />
                    )}
                    <span className="truncate">{effectiveAccessLabel}</span>
                  </button>

                  {openMenu === "access" && (
                    <div className="absolute bottom-full left-0 z-30 mb-2 w-[min(14rem,calc(100cqw-1rem))] rounded-xl border border-border-strong bg-surface p-1 shadow-xl shadow-black/50">
                      {ACCESS_MODES.map((mode) => {
                        const selected = mode.id === effectiveAccess.id;
                        const disabled = Boolean(executionPreset);
                        return (
                          <button
                            key={mode.id}
                            type="button"
                            disabled={disabled}
                            className={`flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition-colors ${
                              selected
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
                                ? "Execution access is fixed for this chat runtime"
                                : undefined
                            }
                          >
                            <span
                              className={`text-xs font-medium ${mode.id === "full" ? "text-danger" : "text-foreground-secondary"}`}
                            >
                              {mode.label}
                            </span>
                            <span className="mt-0.5 text-[11px] leading-snug text-subtle">
                              {disabled && !selected
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

          <div className="ml-auto flex min-w-0 max-w-full flex-shrink-0 items-center gap-1">
            {executionControlsVisible && (
              <div
                ref={modelMenuAnchorRef}
                className="relative"
                data-composer-menu="model"
              >
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
                  disabled={modelUnavailable}
                  title={
                    modelUnavailable
                      ? (modelAvailabilityWarning ?? undefined)
                      : undefined
                  }
                  aria-label="Select model and effort"
                >
                  <span className="max-w-[8rem] truncate text-foreground-secondary">
                    {effectiveModel}
                  </span>
                  <span className="text-subtle">{effectiveEffortLabel}</span>
                  <ChevronDown className="h-3 w-3 text-subtle" />
                </button>

                {openMenu === "model" && (
                  <div
                    role="dialog"
                    aria-label="Model and reasoning"
                    style={{ maxHeight: modelMenuLayout.maxHeight }}
                    className={`absolute right-0 z-30 flex w-[min(220px,calc(100cqw-1rem))] flex-col overflow-y-auto rounded-2xl border border-border-strong bg-surface px-3 py-3 shadow-xl shadow-black/50 ${
                      modelMenuLayout.side === "below"
                        ? "top-full mt-2"
                        : "bottom-full mb-2"
                    }`}
                  >
                    <div className="mb-3 flex shrink-0 items-start justify-between">
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

                    <div className="shrink-0">
                      <EffortSlider
                        effortIndex={presetEffortIndex}
                        onChange={(index) => {
                          setEffortIndex(index);
                          setUnavailableEffort(null);
                          setUnsupportedDefaultEffortFor(null);
                          setOpenMenu(null);
                          setIsModelListOpen(false);
                        }}
                        disabled={Boolean(executionPreset)}
                        supportedIndices={
                          modelOptions.length && selectedCapability
                            ? supportedEffortIndices
                            : undefined
                        }
                      />
                    </div>

                    {isModelListOpen && (
                      <div className="mt-3 min-h-0 overflow-y-auto overscroll-contain space-y-0.5 border-t border-border pt-2">
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
                                setConfirmedAgentModelFor(
                                  selectedAgent?.id ?? null
                                );
                                setIsModelListOpen(false);
                                setOpenMenu(null);
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

            {showSendButton && (
              <button
                type="button"
                className="rounded-full bg-chip p-1.5 text-chip-foreground transition-colors hover:bg-white disabled:opacity-40 disabled:hover:bg-chip"
                disabled={interruptActive ? interruptDisabled : !canSend}
                title={
                  interruptActive
                    ? "Stop active turn"
                    : sendEnabled
                      ? "Send message"
                      : sendDisabledReason
                }
                onClick={() =>
                  interruptActive ? onInterrupt?.() : void submitDraft()
                }
                aria-label={
                  interruptActive ? "Stop active turn" : "Send message"
                }
              >
                {interruptActive ? (
                  <Square className="h-4 w-4" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {footer && (
        <div className="mt-2 text-center text-[10px] text-faint">{footer}</div>
      )}
      {memoryRecallFailure ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/[0.06] px-3 py-2">
          <p role="status" className="text-xs text-foreground-secondary">
            {memoryRecallFailure}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!draft.trim() || !canSend}
              onClick={() => void submitDraft()}
              className="rounded border border-border px-2.5 py-1 text-[11px] font-medium text-foreground disabled:opacity-40"
            >
              Retry
            </button>
            {showContinueWithoutMemory ? (
              <button
                type="button"
                disabled={!draft.trim() || !canSend}
                onClick={() => void submitDraft(true)}
                className="rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-foreground disabled:opacity-40"
              >
                Continue without Memory
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
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
