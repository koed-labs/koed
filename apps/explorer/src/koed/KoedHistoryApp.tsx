import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseIcon,
  EyeIcon,
  FolderIcon,
  GitBranchIcon,
  PencilIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparklesIcon,
  XIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger
} from "../components/ui/sidebar";
import { useTheme } from "../hooks/useTheme";
import { cn } from "../lib/cn";
import koedMarkUrl from "./assets/koed-mark.svg";
import {
  askLocalMemoryQuestion,
  createMemoryQuestion,
  loadLocalMemoryAgentSettings,
  markMemoryQuestionError,
  saveLocalMemoryAgentFlowSetting,
  updateCapturedSessionTitle
} from "./api";
import {
  LcmNodeCard,
  MemoryComposer,
  MemoryQuestionDetail,
  MemoryQuestionSidebar,
  SettingsPanel,
  ThemeSelect,
  firstLine,
  formatDate
} from "./components";
import { koedDebug } from "./debug";
import { nodeMap, threadSelectionKey, uniqueNodeIds } from "./graph";
import {
  parseMemoryScopeCommand,
  stripMemoryScopeCommands
} from "./memoryComposerCommands";
import { memoryScopeLabel } from "./memory";
import {
  buildMemoryQuestionInput,
  selectedThreadSessionIdentifier
} from "./memoryQuestionInput";
import { visibleMemoryQuestionIndex } from "./memoryQuestionIndex";
import {
  clientStorageKey,
  manualMemoryAgentStorageKey,
  readConfiguredAnswerBridgeUrl,
  readConfiguredClient,
  readConfiguredToken,
  selectedThreadStorageKey,
  tokenStorageKey
} from "./storage";
import { prewarmNearbyRadius, prewarmThreadLimit } from "./threadDetailCache";
import {
  nearbyThreadCandidates,
  visiblePrewarmCandidates
} from "./threadIndex";
import type {
  AiClient,
  LocalMemoryAgentSettings,
  LocalMemoryAgentFlowKey,
  LocalMemoryAgentFlowSettings,
  ManualMemoryQuestionWorkerConfig,
  RetrievalScope,
  SearchDomain,
  SidebarMode,
  ThreadGroup,
  ToastState
} from "./types";
import { useKoedMemoryGraph } from "./useKoedMemoryGraph";
import { useKoedMemoryQuestions } from "./useKoedMemoryQuestions";
import { VirtualizedEventList } from "./VirtualizedEventList";

function isManualReasoningEffort(
  value: unknown
): value is ManualMemoryQuestionWorkerConfig["reasoningEffort"] {
  return (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function readManualWorkerConfig(): ManualMemoryQuestionWorkerConfig | null {
  try {
    const raw = window.localStorage.getItem(manualMemoryAgentStorageKey);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<ManualMemoryQuestionWorkerConfig>;
    if (
      parsed.provider === "codex" &&
      typeof parsed.model === "string" &&
      parsed.model.trim() &&
      isManualReasoningEffort(parsed.reasoningEffort)
    ) {
      return {
        provider: "codex",
        model: parsed.model,
        reasoningEffort: parsed.reasoningEffort,
        ...(typeof parsed.timeoutMs === "number"
          ? { timeoutMs: parsed.timeoutMs }
          : {}),
        ...(typeof parsed.maxAttempts === "number"
          ? { maxAttempts: parsed.maxAttempts }
          : {})
      };
    }
  } catch {
    window.localStorage.removeItem(manualMemoryAgentStorageKey);
  }
  return null;
}

export function KoedHistoryApp() {
  const { theme, setTheme } = useTheme();
  const [apiToken, setApiToken] = useState(readConfiguredToken);
  const [answerBridgeUrl] = useState(readConfiguredAnswerBridgeUrl);
  const [selectedClient, setSelectedClient] =
    useState<AiClient>(readConfiguredClient);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState(
    () => window.localStorage.getItem(selectedThreadStorageKey) ?? ""
  );
  const [rawOpen, setRawOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(
    () => new Set()
  );
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("chats");
  const [memoryQuestion, setMemoryQuestion] = useState("");
  const [memorySearchDomain, setMemorySearchDomain] =
    useState<SearchDomain>("project");
  const [localAgentSettings, setLocalAgentSettings] =
    useState<LocalMemoryAgentSettings | null>(null);
  const [localAgentSettingsError, setLocalAgentSettingsError] = useState<
    string | null
  >(null);
  const [manualWorkerConfig, setManualWorkerConfigState] = useState(
    readManualWorkerConfig
  );
  const memoryRetrievalScope: RetrievalScope = "personal";
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(
    null
  );
  const [askingMemory, setAskingMemory] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [renameThreadKey, setRenameThreadKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set()
  );
  const {
    loadQuestionDetail,
    prewarmQuestions,
    questions: memoryQuestions,
    refreshQuestionFromStream,
    upsertQuestion
  } = useKoedMemoryQuestions({
    apiToken,
    setToast
  });
  const {
    data,
    hasOlderThreadEvents,
    loadEventDetail,
    loadGraph,
    loadOlderThreadEvents,
    loading,
    prewarmThreads,
    renameThread,
    selectedEventId,
    selectedThread,
    setSelectedEventId,
    threadEvents,
    threadLoading
  } = useKoedMemoryGraph({
    apiToken,
    onMemoryQuestionUpdate: refreshQuestionFromStream,
    selectedThreadId,
    setToast
  });
  const memoryScopeCommand = useMemo(
    () => parseMemoryScopeCommand(memoryQuestion),
    [memoryQuestion]
  );
  const submittedMemoryQuestion = useMemo(
    () => stripMemoryScopeCommands(memoryQuestion),
    [memoryQuestion]
  );
  const effectiveMemorySearchDomain =
    memoryScopeCommand?.searchDomain ?? memorySearchDomain;
  const selectedThreadSessionId =
    selectedThreadSessionIdentifier(selectedThread);
  const sessionScopeUnavailable =
    effectiveMemorySearchDomain === "session" && !selectedThreadSessionId;

  useEffect(() => {
    window.localStorage.setItem(tokenStorageKey, apiToken);
  }, [apiToken]);

  useEffect(() => {
    window.localStorage.setItem(clientStorageKey, selectedClient);
  }, [selectedClient]);

  useEffect(() => {
    if (manualWorkerConfig) {
      window.localStorage.setItem(
        manualMemoryAgentStorageKey,
        JSON.stringify(manualWorkerConfig)
      );
    }
  }, [manualWorkerConfig]);

  const applyLocalAgentSettings = useCallback(
    (settings: LocalMemoryAgentSettings) => {
      setLocalAgentSettings(settings);
      const manual = settings.flows.manualMemoryAnswer;
      const modelOptions = settings.modelOptions ?? [];
      setManualWorkerConfigState((existing) => {
        if (
          existing &&
          modelOptions.some((option) => option.model === existing.model)
        ) {
          return {
            ...existing,
            timeoutMs: manual.timeoutMs,
            maxAttempts: manual.maxAttempts
          };
        }
        const reasoning = isManualReasoningEffort(manual.reasoningEffort)
          ? manual.reasoningEffort
          : "high";
        return {
          provider: "codex",
          model: manual.model || modelOptions[0]?.model || "",
          reasoningEffort: reasoning,
          timeoutMs: manual.timeoutMs,
          maxAttempts: manual.maxAttempts
        };
      });
    },
    []
  );

  const refreshLocalAgentSettings = useCallback(
    async () =>
      loadLocalMemoryAgentSettings({
        apiToken,
        bridgeUrl: answerBridgeUrl
      }),
    [apiToken, answerBridgeUrl]
  );

  useEffect(() => {
    let cancelled = false;
    setLocalAgentSettingsError(null);
    refreshLocalAgentSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        applyLocalAgentSettings(settings);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setLocalAgentSettings(null);
        setLocalAgentSettingsError(
          error instanceof Error ? error.message : String(error)
        );
      });
    return () => {
      cancelled = true;
    };
  }, [apiToken, applyLocalAgentSettings, refreshLocalAgentSettings]);

  const groups = data.projects;
  const nodesById = useMemo(() => nodeMap(data.nodes), [data.nodes]);
  const selectedEvent = useMemo(
    () =>
      threadEvents.find((event) => event.id === selectedEventId) ??
      threadEvents.at(-1) ??
      null,
    [selectedEventId, threadEvents]
  );
  const linkedNodes = useMemo(
    () => uniqueNodeIds(threadEvents).flatMap((id) => nodesById.get(id) ?? []),
    [nodesById, threadEvents]
  );
  const selectedEventLinkedNodes = useMemo(
    () =>
      (selectedEvent?.linkedNodeIds ?? []).flatMap(
        (id) => nodesById.get(id) ?? []
      ),
    [nodesById, selectedEvent]
  );
  const selectedQuestion = useMemo(
    () =>
      memoryQuestions.find((question) => question.id === selectedQuestionId) ??
      null,
    [memoryQuestions, selectedQuestionId]
  );
  const localAgentReady = useMemo(
    () =>
      Boolean(
        localAgentSettings?.aiClients.some(
          (client) => client.id === "codex" && client.status === "ready"
        )
      ),
    [localAgentSettings]
  );
  const setManualWorkerConfig = useCallback(
    (value: ManualMemoryQuestionWorkerConfig) => {
      setManualWorkerConfigState(value);
    },
    []
  );
  const saveLocalAgentFlowSetting = useCallback(
    async (
      flowKey: LocalMemoryAgentFlowKey,
      setting: Pick<
        LocalMemoryAgentFlowSettings,
        "provider" | "model" | "reasoningEffort" | "timeoutMs" | "maxAttempts"
      >
    ) => {
      await saveLocalMemoryAgentFlowSetting({
        apiToken,
        bridgeUrl: answerBridgeUrl,
        flowKey,
        setting
      });
      applyLocalAgentSettings(await refreshLocalAgentSettings());
    },
    [
      apiToken,
      answerBridgeUrl,
      applyLocalAgentSettings,
      refreshLocalAgentSettings
    ]
  );
  const filteredMemoryQuestions = useMemo(() => {
    return visibleMemoryQuestionIndex(memoryQuestions, query);
  }, [memoryQuestions, query]);

  useEffect(() => {
    if (!selectedThread) {
      return;
    }
    const selectedProject = groups.find(
      (group) => group.id === selectedThread.projectId
    );
    if (!selectedProject) {
      return;
    }
    setExpandedProjectIds((current) => {
      if (current.has(selectedProject.id)) {
        return current;
      }
      const next = new Set(current);
      next.add(selectedProject.id);
      return next;
    });
  }, [groups, selectedThread]);

  useEffect(() => {
    koedDebug("thread.renderEvents", {
      selectedThreadId,
      events: threadEvents.length,
      firstEventId: threadEvents[0]?.id ?? null,
      latestEventId: threadEvents.at(-1)?.id ?? null,
      selectedEventId
    });
  }, [selectedEventId, selectedThreadId, threadEvents]);

  useEffect(() => {
    if (rawOpen && selectedEvent && selectedEvent.rawContent === undefined) {
      void loadEventDetail(selectedEvent.id);
    }
  }, [loadEventDetail, rawOpen, selectedEvent]);

  useEffect(() => {
    if (
      sidebarMode === "questions" &&
      memoryQuestions.length > 0 &&
      (!selectedQuestionId ||
        !memoryQuestions.some((question) => question.id === selectedQuestionId))
    ) {
      setSelectedQuestionId(memoryQuestions[0]?.id ?? null);
    }
  }, [memoryQuestions, selectedQuestionId, sidebarMode]);

  useEffect(() => {
    if (selectedQuestionId) {
      void loadQuestionDetail(
        selectedQuestionId,
        selectedQuestion?.updatedAt
          ? { minUpdatedAt: selectedQuestion.updatedAt }
          : undefined
      );
    }
  }, [
    loadQuestionDetail,
    selectedQuestion?.status,
    selectedQuestion?.updatedAt,
    selectedQuestionId
  ]);

  useEffect(() => {
    if (sidebarMode === "questions") {
      prewarmQuestions(
        memoryQuestions.slice(0, 10).map((question) => question.id)
      );
    }
  }, [memoryQuestions, prewarmQuestions, sidebarMode]);

  useEffect(() => {
    window.localStorage.setItem(selectedThreadStorageKey, selectedThreadId);
  }, [selectedThreadId]);

  const filteredGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return groups;
    }
    return groups
      .map((group) => ({
        ...group,
        threads: group.threads.filter(
          (thread) =>
            thread.name.toLowerCase().includes(needle) ||
            thread.sample.toLowerCase().includes(needle) ||
            group.name.toLowerCase().includes(needle) ||
            (group.path ?? "").toLowerCase().includes(needle)
        )
      }))
      .filter((group) => group.threads.length > 0);
  }, [groups, query]);

  useEffect(() => {
    if (
      sidebarMode !== "chats" ||
      filteredGroups.length === 0 ||
      threadLoading
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const visibleCandidates = visiblePrewarmCandidates(
        filteredGroups,
        selectedThread,
        prewarmThreadLimit
      );
      const nearbyCandidates = nearbyThreadCandidates(
        filteredGroups,
        selectedThread,
        prewarmNearbyRadius
      );
      prewarmThreads([...nearbyCandidates, ...visibleCandidates]);
    }, 5000);
    return () => window.clearTimeout(timeout);
  }, [
    filteredGroups,
    prewarmThreads,
    selectedThread,
    sidebarMode,
    threadLoading
  ]);

  const selectedThreadKey = selectedThread
    ? threadSelectionKey(selectedThread)
    : "";
  const renamingSelectedThread =
    Boolean(selectedThreadKey) && renameThreadKey === selectedThreadKey;

  const beginRenameThread = (thread: ThreadGroup) => {
    if (!thread.sessionId) {
      return;
    }
    setSelectedThreadId(threadSelectionKey(thread));
    setRenameThreadKey(threadSelectionKey(thread));
    setRenameValue(thread.name);
  };

  const beginRenameSelectedThread = () => {
    if (!selectedThread) {
      return;
    }
    beginRenameThread(selectedThread);
  };

  const cancelRename = () => {
    if (renameSaving) {
      return;
    }
    setRenameThreadKey(null);
    setRenameValue("");
  };

  const submitRename = async () => {
    const title = renameValue.replace(/\s+/g, " ").trim();
    if (!selectedThread?.sessionId || !title || renameSaving) {
      return;
    }
    setRenameSaving(true);
    try {
      await updateCapturedSessionTitle({
        apiToken,
        sessionId: selectedThread.sessionId,
        title
      });
      renameThread(selectedThread, title);
      setRenameThreadKey(null);
      setRenameValue("");
      setToast(null);
    } catch (error) {
      setToast({
        tone: "destructive",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setRenameSaving(false);
    }
  };

  const askMemory = async () => {
    const trimmed = submittedMemoryQuestion;
    if (!trimmed || askingMemory) {
      return;
    }
    if (sessionScopeUnavailable) {
      setToast({
        tone: "destructive",
        message: "Select a session before asking session-scoped memory."
      });
      return;
    }
    if (!localAgentReady || !manualWorkerConfig?.model.trim()) {
      setToast({
        tone: "destructive",
        message:
          localAgentSettingsError ??
          "Install or configure Codex before asking local memory."
      });
      return;
    }

    const searchDomain = effectiveMemorySearchDomain;
    const questionInput = buildMemoryQuestionInput({
      query: trimmed,
      retrievalScope: memoryRetrievalScope,
      searchDomain,
      selectedThread
    });
    setSidebarMode("questions");
    setMemoryQuestion("");
    setAskingMemory(true);
    let pendingQuestionId: string | null = null;
    try {
      const pendingQuestion = await createMemoryQuestion({
        apiToken,
        input: {
          ...questionInput,
          localMemoryWorkerConfig: manualWorkerConfig
        }
      });
      pendingQuestionId = pendingQuestion.id;
      upsertQuestion(pendingQuestion);
      setSelectedQuestionId(pendingQuestion.id);
      const result = await askLocalMemoryQuestion({
        apiToken,
        bridgeUrl: answerBridgeUrl,
        input: {
          ...questionInput,
          questionId: pendingQuestion.id,
          localMemoryWorkerConfig: manualWorkerConfig
        }
      });
      upsertQuestion(result.question);
      setSelectedQuestionId(result.question.id);
      if (!result.ok) {
        setToast({
          tone: "destructive",
          message: result.error ?? "Memory answer failed."
        });
      } else {
        setToast(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (pendingQuestionId) {
        try {
          const erroredQuestion = await markMemoryQuestionError({
            apiToken,
            errorMessage: message,
            questionId: pendingQuestionId
          });
          upsertQuestion(erroredQuestion);
          setSelectedQuestionId(erroredQuestion.id);
        } catch {
          // Keep the original local MCP bridge error visible.
        }
      }
      setToast({
        tone: "destructive",
        message
      });
    } finally {
      setAskingMemory(false);
    }
  };

  const toggleNode = (nodeId: string) => {
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  const toggleProject = (projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
        resizable={{
          minWidth: 13 * 16,
          storageKey: "koed_history_sidebar_width"
        }}
      >
        <SidebarHeader className="gap-2 border-border border-b px-3 py-3">
          <div className="-mx-3 -mt-3 flex h-[52px] items-center justify-between gap-2 border-border border-b px-3">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-primary">
                <img
                  alt=""
                  aria-hidden="true"
                  className="size-4.5"
                  draggable={false}
                  src={koedMarkUrl}
                />
              </div>
              <div className="min-w-0">
                <div className="truncate font-semibold text-sm">
                  Koed History
                </div>
                <div className="truncate text-muted-foreground text-xs">
                  LCM graph browser
                </div>
              </div>
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => void loadGraph()}
            >
              <RefreshCwIcon
                className={cn("size-3.5", loading && "animate-spin")}
              />
            </Button>
          </div>

          <div className="relative">
            <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground" />
            <input
              className="h-8 w-full rounded-lg border border-input bg-background pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                sidebarMode === "chats"
                  ? "Search projects and sessions"
                  : "Search memory questions"
              }
            />
          </div>

          <div className="grid grid-cols-2 rounded-lg border border-border bg-background p-0.5">
            <button
              className={cn(
                "h-7 rounded-md px-2 text-xs transition-colors",
                sidebarMode === "chats"
                  ? "bg-secondary text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setSidebarMode("chats")}
              type="button"
            >
              Chats
            </button>
            <button
              className={cn(
                "h-7 rounded-md px-2 text-xs transition-colors",
                sidebarMode === "questions"
                  ? "bg-secondary text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setSidebarMode("questions")}
              type="button"
            >
              Questions
            </button>
          </div>
        </SidebarHeader>

        <SidebarContent>
          {sidebarMode === "chats" ? (
            filteredGroups.map((group) => {
              const isExpanded = query.trim()
                ? true
                : expandedProjectIds.has(group.id);
              return (
                <SidebarGroup key={group.id}>
                  <button
                    className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-muted-foreground text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    onClick={() => toggleProject(group.id)}
                    type="button"
                  >
                    {isExpanded ? (
                      <ChevronDownIcon className="size-3.5 shrink-0" />
                    ) : (
                      <ChevronRightIcon className="size-3.5 shrink-0" />
                    )}
                    <FolderIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {group.name}
                    </span>
                    <span className="shrink-0 text-muted-foreground/70">
                      {group.eventCount}
                    </span>
                  </button>
                  {isExpanded ? (
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {group.threads.map((thread) => (
                          <SidebarMenuItem key={`${group.id}:${thread.id}`}>
                            <SidebarMenuButton
                              className="h-auto items-start py-2"
                              isActive={thread === selectedThread}
                              onClick={() =>
                                setSelectedThreadId(threadSelectionKey(thread))
                              }
                            >
                              <GitBranchIcon className="mt-0.5 size-4" />
                              <span className="min-w-0">
                                <span className="block truncate text-sm">
                                  {thread.name}
                                </span>
                                <span className="block truncate text-muted-foreground text-xs">
                                  {formatDate(thread.latestAt)} -{" "}
                                  {thread.eventCount} events
                                </span>
                                <span className="block truncate text-muted-foreground/75 text-xs">
                                  {firstLine(thread.sample)}
                                </span>
                              </span>
                            </SidebarMenuButton>
                            {thread.sessionId ? (
                              <SidebarMenuAction
                                aria-label={`Rename ${thread.name}`}
                                onClick={() => beginRenameThread(thread)}
                                showOnHover
                              >
                                <PencilIcon className="size-3.5" />
                              </SidebarMenuAction>
                            ) : null}
                          </SidebarMenuItem>
                        ))}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  ) : null}
                </SidebarGroup>
              );
            })
          ) : (
            <MemoryQuestionSidebar
              groupedQuestions={filteredMemoryQuestions}
              onSelectQuestion={setSelectedQuestionId}
              queryActive={Boolean(query.trim())}
              selectedQuestionId={selectedQuestionId}
            />
          )}
        </SidebarContent>
        <SidebarSeparator />
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
          <header className="border-border border-b px-3 py-2 sm:px-5 sm:py-3">
            <div className="flex w-full min-w-0 items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <SidebarTrigger className="size-7 shrink-0 md:hidden" />
                <div className="min-w-0">
                  {sidebarMode === "chats" && renamingSelectedThread ? (
                    <form
                      className="flex min-w-0 items-center gap-1"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitRename();
                      }}
                    >
                      <input
                        aria-label="Chat title"
                        autoFocus
                        className="h-7 min-w-0 rounded-md border border-input bg-background px-2 font-medium text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        disabled={renameSaving}
                        maxLength={120}
                        onChange={(event) => setRenameValue(event.target.value)}
                        value={renameValue}
                      />
                      <Button
                        aria-label="Save chat title"
                        disabled={!renameValue.trim() || renameSaving}
                        size="icon-xs"
                        type="submit"
                        variant="ghost"
                      >
                        <CheckIcon className="size-3.5" />
                      </Button>
                      <Button
                        aria-label="Cancel chat title edit"
                        disabled={renameSaving}
                        onClick={cancelRename}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    </form>
                  ) : (
                    <div className="flex min-w-0 items-center gap-1">
                      <h1 className="truncate font-medium text-foreground text-sm">
                        {sidebarMode === "questions"
                          ? (selectedQuestion?.query ?? "Memory questions")
                          : (selectedThread?.name ??
                            "No conversation selected")}
                      </h1>
                      {sidebarMode === "chats" && selectedThread?.sessionId ? (
                        <Button
                          aria-label="Rename chat"
                          onClick={beginRenameSelectedThread}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <PencilIcon className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  )}
                  <p className="truncate text-muted-foreground text-xs">
                    {sidebarMode === "questions"
                      ? selectedQuestion
                        ? `${memoryScopeLabel(selectedQuestion)} - ${selectedQuestion.retrievalScope}`
                        : "Ask Koed memory from the composer"
                      : (selectedThread?.projectName ??
                        "Connect to Koed to browse captured sessions")}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <ThemeSelect onChange={setTheme} value={theme} />
                <Button
                  aria-label="Koed settings"
                  size="icon-xs"
                  variant={settingsOpen ? "secondary" : "ghost"}
                  onClick={() => setSettingsOpen((value) => !value)}
                >
                  <SettingsIcon className="size-3.5" />
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setInspectorOpen((value) => !value)}
                >
                  {inspectorOpen ? (
                    <PanelRightCloseIcon className="size-3.5" />
                  ) : (
                    <PanelRightOpenIcon className="size-3.5" />
                  )}
                  LCM
                </Button>
              </div>
            </div>
          </header>

          {toast ? (
            <div
              className={cn(
                "mx-3 mt-3 rounded-lg border px-3 py-2 text-sm sm:mx-5",
                toast.tone === "destructive"
                  ? "border-destructive/30 bg-destructive/8 text-destructive-foreground"
                  : "border-success/30 bg-success/8 text-success-foreground"
              )}
            >
              {toast.message}
            </div>
          ) : null}

          {settingsOpen ? (
            <SettingsPanel
              apiToken={apiToken}
              localAgentSettings={localAgentSettings}
              localAgentSettingsError={localAgentSettingsError}
              selectedClient={selectedClient}
              saveLocalAgentFlowSetting={saveLocalAgentFlowSetting}
              setApiToken={setApiToken}
              setSelectedClient={setSelectedClient}
            />
          ) : null}

          <div className="flex min-h-0 min-w-0 flex-1">
            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-hidden">
                {sidebarMode === "questions" ? (
                  <div className="h-full overflow-auto px-3 py-4 sm:px-5">
                    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
                      {selectedQuestion ? (
                        <MemoryQuestionDetail question={selectedQuestion} />
                      ) : (
                        <div className="rounded-lg border border-border/60 bg-card/40 px-8 py-12 text-center">
                          <SparklesIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
                          <div className="font-medium">
                            No memory questions yet
                          </div>
                          <p className="mt-1 text-muted-foreground text-sm">
                            Ask from the composer below to inspect a scoped
                            memory answer.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                ) : selectedThread && threadEvents.length > 0 ? (
                  <VirtualizedEventList
                    key={threadSelectionKey(selectedThread)}
                    events={threadEvents}
                    hasOlderEvents={hasOlderThreadEvents}
                    onLoadOlder={loadOlderThreadEvents}
                    onSelectEvent={setSelectedEventId}
                    selectedEventId={selectedEvent?.id ?? null}
                    threadKey={threadSelectionKey(selectedThread)}
                  />
                ) : (
                  <div className="h-full overflow-auto px-3 py-4 sm:px-5">
                    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
                      {loading || threadLoading ? (
                        <div className="rounded-lg border border-border bg-card/60 px-4 py-3 text-muted-foreground text-sm">
                          Loading Koed graph...
                        </div>
                      ) : null}
                      {!loading && !threadLoading && !selectedThread ? (
                        <div className="rounded-lg border border-border/60 bg-card/40 px-8 py-12 text-center">
                          <DatabaseIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
                          <div className="font-medium">
                            Select a conversation
                          </div>
                          <p className="mt-1 text-muted-foreground text-sm">
                            Choose a captured session from the sidebar to load
                            its events.
                          </p>
                        </div>
                      ) : null}
                      {!loading &&
                      !threadLoading &&
                      selectedThread &&
                      threadEvents.length === 0 ? (
                        <div className="rounded-lg border border-border/60 bg-card/40 px-8 py-12 text-center">
                          <DatabaseIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
                          <div className="font-medium">
                            No captured events visible
                          </div>
                          <p className="mt-1 text-muted-foreground text-sm">
                            Start the Koed API, then reload the graph.
                          </p>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>

              <MemoryComposer
                disabled={askingMemory}
                canAsk={
                  localAgentReady &&
                  !sessionScopeUnavailable &&
                  submittedMemoryQuestion.length > 0
                }
                localAgentReady={localAgentReady}
                localAgentSettings={localAgentSettings}
                manualWorkerConfig={manualWorkerConfig}
                onAsk={() => void askMemory()}
                question={memoryQuestion}
                scopeCommand={memoryScopeCommand}
                scopeLocked={memoryScopeCommand !== null}
                scopeUnavailable={sessionScopeUnavailable}
                searchDomain={effectiveMemorySearchDomain}
                selectedThread={selectedThread}
                setManualWorkerConfig={setManualWorkerConfig}
                setQuestion={setMemoryQuestion}
                setSearchDomain={setMemorySearchDomain}
              />
            </section>

            <aside
              className={cn(
                "hidden shrink-0 border-border border-l bg-card/35 lg:min-h-0 lg:flex-col",
                inspectorOpen ? "lg:flex lg:w-[28rem]" : "lg:hidden"
              )}
            >
              <div className="border-border border-b px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-medium text-sm">LCM inspector</div>
                    <div className="text-muted-foreground text-xs">
                      Selected event, summaries, and source links
                    </div>
                  </div>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => setInspectorOpen(false)}
                  >
                    <PanelRightCloseIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
                {selectedEvent ? (
                  <section className="rounded-lg border border-border bg-background/80 p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="font-medium text-sm">Event</div>
                      <span className="rounded-md border border-border bg-secondary px-1.5 py-0.5 text-muted-foreground text-xs">
                        {selectedEvent.visibility}
                      </span>
                    </div>
                    <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">ID</dt>
                      <dd className="truncate">{selectedEvent.id}</dd>
                      <dt className="text-muted-foreground">Runtime</dt>
                      <dd>{selectedEvent.sourceRuntime ?? "unknown"}</dd>
                      <dt className="text-muted-foreground">Model</dt>
                      <dd>{selectedEvent.model ?? "unknown"}</dd>
                      <dt className="text-muted-foreground">Capture</dt>
                      <dd>{selectedEvent.captureMethod}</dd>
                    </dl>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setRawOpen((value) => !value)}
                      >
                        <EyeIcon className="size-3.5" />
                        {rawOpen ? "Hide raw" : "Show raw"}
                      </Button>
                    </div>
                    {rawOpen ? (
                      <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-secondary/50 p-2 text-[11px] leading-relaxed">
                        {JSON.stringify(selectedEvent, null, 2)}
                      </pre>
                    ) : null}
                  </section>
                ) : null}

                <section className="rounded-lg border border-border bg-background/80 p-3">
                  <div className="mb-3 flex items-center gap-2 font-medium text-sm">
                    <ShieldCheckIcon className="size-4 text-primary" />
                    Linked LCM nodes
                  </div>
                  {selectedEventLinkedNodes.length > 0 ? (
                    <div className="mb-4 space-y-2">
                      <div className="text-muted-foreground text-xs">
                        Selected event
                      </div>
                      {selectedEventLinkedNodes.map((node, index) => (
                        <LcmNodeCard
                          expanded={expandedNodeIds.has(node.id)}
                          key={`selected:${node.id}:${index}`}
                          node={node}
                          onToggle={() => toggleNode(node.id)}
                        />
                      ))}
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    {linkedNodes.length === 0 ? (
                      <p className="text-muted-foreground text-sm">
                        No linked LCM nodes for the loaded conversation.
                      </p>
                    ) : (
                      <>
                        <div className="text-muted-foreground text-xs">
                          Conversation
                        </div>
                        {linkedNodes.map((node) => (
                          <LcmNodeCard
                            expanded={expandedNodeIds.has(node.id)}
                            key={`conversation:${node.id}`}
                            node={node}
                            onToggle={() => toggleNode(node.id)}
                          />
                        ))}
                      </>
                    )}
                  </div>
                </section>
              </div>
            </aside>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
