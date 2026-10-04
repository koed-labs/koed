"use client";

import {
  AlertTriangle,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Share2
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentModelCapability } from "@/lib/agentIdentityEditor";
import { managedRequest, parseLaunchInstances } from "@/lib/managed-agent-chat";
import type {
  HomeExecution,
  HomeRecent,
  HomeRequest,
  HomeSnapshot
} from "@/lib/studio-contract";
import { StudioCollaborationClient } from "@/lib/studio-collaboration-client";
import type { CollaborationSnapshot } from "@koed/shared/collaboration";
import { filterHomeCollections, homeProjects } from "@/lib/studio-home";
import type { HomeItem } from "@koed/shared/home";
import type { HomeFeedController } from "@/lib/use-home-feed";
import { StudioSidebar } from "./StudioSidebar";
import { usePersonalRemovals } from "./usePersonalRemovals";
import { useVerifiedPersonalScope } from "./useVerifiedPersonalScope";
import type { PersonalRemovalTarget } from "@/lib/personal-removals-client";
import { HomeAttentionView } from "./HomeAttentionView";
import { OwnedConversationShareDialog } from "./OwnedConversationShareDialog";
import { ChatComposer, type ChatComposerSelection } from "../ChatComposer";
import { SharedChatUI } from "../SharedChatUI";
import {
  indexShareablePersonalConversations,
  indexShareableConversationRows,
  isSyntheticIndependentProject,
  matchLocalConversationToHome,
  matchManagedExecutionForCapturedSession,
  managedConversationSourceIds,
  managedConversationActivityLabel,
  managedProviderSourceIdsByExecution,
  normalizeConversationProvider,
  ownerSnapshotMaySurviveRefresh,
  ownerMemoryLoadMayApply,
  shareDialogSourceMayRemainOpen,
  type ShareablePersonalConversation
} from "./LocalConversationBrowser.match";
import {
  hasConversationRemoval,
  hasProjectRemoval,
  managedConversationRemovalTarget
} from "./personal-removals-view";

type LoadState = "loading" | "offline" | "snapshot";
type LocalRunnerAvailability =
  | "checking"
  | "available"
  | "unavailable"
  | "unknown";
function nullable(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function validSnapshot(value: unknown): value is HomeSnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<HomeSnapshot>;
  const execution = (candidate: unknown): candidate is HomeExecution =>
    Boolean(
      candidate &&
      typeof candidate === "object" &&
      typeof (candidate as HomeExecution).id === "string" &&
      typeof (candidate as HomeExecution).title === "string" &&
      typeof (candidate as HomeExecution).provider === "string" &&
      typeof (candidate as HomeExecution).state === "string" &&
      typeof (candidate as HomeExecution).updatedAt === "string" &&
      ((candidate as HomeExecution).activity === undefined ||
        [
          "running",
          "pending",
          "uncertain",
          "idle",
          "operation",
          "operation-pending",
          "unknown"
        ].includes(String((candidate as HomeExecution).activity))) &&
      nullable((candidate as HomeExecution).projectId) &&
      nullable((candidate as HomeExecution).sessionId) &&
      nullable((candidate as HomeExecution).error)
    );
  const request = (candidate: unknown): candidate is HomeRequest =>
    Boolean(
      candidate &&
      typeof candidate === "object" &&
      typeof (candidate as HomeRequest).id === "string" &&
      typeof (candidate as HomeRequest).executionId === "string" &&
      typeof (candidate as HomeRequest).title === "string" &&
      typeof (candidate as HomeRequest).kind === "string" &&
      nullable((candidate as HomeRequest).sessionId)
    );
  const recent = (candidate: unknown): candidate is HomeRecent =>
    Boolean(
      candidate &&
      typeof candidate === "object" &&
      typeof (candidate as HomeRecent).id === "string" &&
      typeof (candidate as HomeRecent).sessionId === "string" &&
      nullable((candidate as HomeRecent).projectId) &&
      typeof (candidate as HomeRecent).projectName === "string" &&
      typeof (candidate as HomeRecent).title === "string" &&
      typeof (candidate as HomeRecent).updatedAt === "string"
    );
  return (
    ["ready", "partial", "unavailable", "unauthorized"].includes(
      item.state ?? ""
    ) &&
    typeof item.fetchedAt === "string" &&
    nullable(item.scopeKey) &&
    nullable(item.message) &&
    Array.isArray(item.warnings) &&
    item.warnings.every((warning) => typeof warning === "string") &&
    Boolean(item.coverage) &&
    typeof item.coverage?.executions === "boolean" &&
    typeof item.coverage?.requests === "boolean" &&
    typeof item.coverage?.recents === "boolean" &&
    Array.isArray(item.executions) &&
    item.executions.every(execution) &&
    Array.isArray(item.requests) &&
    item.requests.every(request) &&
    Array.isArray(item.recents) &&
    item.recents.every(recent)
  );
}
function greeting(now = new Date()) {
  const hour = now.getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function homeSummary(count: number) {
  if (count === 0)
    return "Nothing here needs you. Start something, or pick up where you left off.";
  return count === 1
    ? "1 thing needs you on your personal side."
    : `${count} things need you on your personal side.`;
}

export function PersonalHome({
  canCreateLocalProject,
  onNewChat,
  onNewProject,
  onStartChat,
  onResumeChat,
  onMoveManagedExecution,
  onPlugins,
  onPullRequests,
  homeFeed,
  onOpenHomeItem
}: {
  canCreateLocalProject: boolean;
  onNewChat?: () => void;
  onNewProject?: () => void;
  onStartChat: (
    prompt: string,
    projectId?: string,
    selection?: ChatComposerSelection
  ) => void;
  onResumeChat: (executionId: string) => void;
  onMoveManagedExecution?: (
    executionId: string,
    destinationProjectId: string
  ) => void;
  onPlugins?: () => void;
  onPullRequests?: () => void;
  homeFeed: HomeFeedController;
  onOpenHomeItem: (item: HomeItem) => void;
}) {
  const [snapshot, setSnapshot] = useState<HomeSnapshot | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [modelOptions, setModelOptions] = useState<AgentModelCapability[]>([]);
  const [modelOptionsLoaded, setModelOptionsLoaded] = useState(false);
  const [localRunnerAvailability, setLocalRunnerAvailability] =
    useState<LocalRunnerAvailability>("checking");
  const [recentsOpen, setRecentsOpen] = useState(false);
  const collaborationClient = useMemo(
    () => new StudioCollaborationClient(),
    []
  );
  const [sharingReloadKey, setSharingReloadKey] = useState(0);
  const [sharingSessionState, setSharingSessionState] = useState<{
    key: string;
    homeScopeKey: string;
    snapshot: CollaborationSnapshot | null;
    message: string | null;
  } | null>(null);
  const sharingSessionSequenceRef = useRef(0);
  const scopeRef = useRef<string | null | undefined>(undefined);
  const requestSequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const runnerRequestSequenceRef = useRef(0);
  const runnerControllerRef = useRef<AbortController | null>(null);
  const usable = Boolean(
    snapshot && (snapshot.state === "ready" || snapshot.state === "partial")
  );
  const homeScopeKey = usable ? (snapshot?.scopeKey ?? null) : null;
  const personalScopeKey = useVerifiedPersonalScope(homeScopeKey);
  const personalRemovalState = usePersonalRemovals({
    scopeKey: personalScopeKey
  });
  const sharingSessionKey =
    homeScopeKey === null ? null : `${homeScopeKey}:${sharingReloadKey}`;
  const ownerSharingSession =
    homeScopeKey && sharingSessionState?.homeScopeKey === homeScopeKey
      ? sharingSessionState
      : null;
  const ownerSharingAuthorityKey: string | null = ownerSharingSession?.snapshot
    ? `${ownerSharingSession.snapshot.connection.backendId ?? ""}:${ownerSharingSession.snapshot.navigation.teamPrincipal?.id ?? ""}`
    : null;
  const ownerMemoryBySessionId = useMemo(
    () =>
      indexShareablePersonalConversations(
        ownerSharingSession?.snapshot?.navigation.personal.memory ?? []
      ),
    [ownerSharingSession]
  );
  const ownerMemoryForLocalSource = useMemo(
    () =>
      indexShareableConversationRows({
        entriesBySessionId: ownerMemoryBySessionId,
        recents: snapshot?.recents ?? [],
        executions: snapshot?.executions ?? []
      }).byLocalSourceId,
    [ownerMemoryBySessionId, snapshot]
  );
  const ownerMemoryForExecution = useMemo(
    () =>
      indexShareableConversationRows({
        entriesBySessionId: ownerMemoryBySessionId,
        recents: snapshot?.recents ?? [],
        executions: snapshot?.executions ?? []
      }).byExecutionId,
    [ownerMemoryBySessionId, snapshot]
  );
  const [shareConversation, setShareConversation] = useState<{
    sessionId: string;
    memory: ShareablePersonalConversation;
    authorityKey: string;
    homeScopeKey: string;
  } | null>(null);
  const currentShareMemory = shareConversation
    ? (ownerMemoryBySessionId.get(shareConversation.sessionId)
        ?.logicalMemoryId ?? null)
    : null;
  const activeShareConversation =
    shareConversation &&
    shareDialogSourceMayRemainOpen({
      sourceHomeScopeKey: shareConversation.homeScopeKey,
      currentHomeScopeKey: homeScopeKey,
      sourceAuthorityKey: shareConversation.authorityKey,
      currentAuthorityKey: ownerSharingAuthorityKey,
      sourceLogicalMemoryId: shareConversation.memory.logicalMemoryId,
      currentLogicalMemoryId: currentShareMemory
    })
      ? shareConversation
      : null;
  const load = useCallback(async () => {
    const sequence = ++requestSequenceRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRefreshing(true);
    try {
      const response = await fetch("/studio-api/home", {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!validSnapshot(payload)) throw new Error("Home unavailable");
      if (sequence !== requestSequenceRef.current) return;
      if (
        payload.state === "unauthorized" ||
        payload.state === "unavailable" ||
        (scopeRef.current !== undefined &&
          scopeRef.current !== payload.scopeKey)
      ) {
        setFilter(null);
      }
      scopeRef.current = payload.scopeKey;
      setSnapshot(payload);
      setLoadState("snapshot");
    } catch (reason: unknown) {
      if (
        sequence !== requestSequenceRef.current ||
        (reason as { name?: string })?.name === "AbortError"
      )
        return;
      setFilter(null);
      scopeRef.current = undefined;
      setSnapshot(null);
      setLoadState("offline");
    } finally {
      if (sequence === requestSequenceRef.current) {
        setRefreshing(false);
        controllerRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    const refreshSharingSession = () =>
      setSharingReloadKey((value) => value + 1);
    window.addEventListener("focus", refreshSharingSession);
    return () => window.removeEventListener("focus", refreshSharingSession);
  }, []);

  useEffect(() => {
    if (!sharingSessionKey || !homeScopeKey) return;
    const sequence = ++sharingSessionSequenceRef.current;
    let active = true;
    void collaborationClient
      .loadSession()
      .then((current) => {
        if (
          !ownerMemoryLoadMayApply({
            active,
            sequence,
            currentSequence: sharingSessionSequenceRef.current,
            homeScopeKey,
            currentHomeScopeKey: scopeRef.current
          })
        ) {
          return;
        }
        setSharingSessionState({
          key: sharingSessionKey,
          homeScopeKey,
          snapshot: current,
          message: null
        });
      })
      .catch((reason: unknown) => {
        if (
          !ownerMemoryLoadMayApply({
            active,
            sequence,
            currentSequence: sharingSessionSequenceRef.current,
            homeScopeKey,
            currentHomeScopeKey: scopeRef.current
          })
        ) {
          return;
        }
        const status =
          reason && typeof reason === "object" && "status" in reason
            ? (reason as { status?: unknown }).status
            : null;
        setSharingSessionState((previous) => ({
          key: sharingSessionKey,
          homeScopeKey,
          snapshot: ownerSnapshotMaySurviveRefresh({
            sameHomeScope: previous?.homeScopeKey === homeScopeKey,
            authorizationDenied: status === 401 || status === 403
          })
            ? (previous?.snapshot ?? null)
            : null,
          message:
            status === 404
              ? "Connect a Team backend to preview and share Personal Memory."
              : "Team sharing is unavailable. Check the Team connection and retry."
        }));
      });
    return () => {
      active = false;
      if (sequence === sharingSessionSequenceRef.current) {
        sharingSessionSequenceRef.current += 1;
      }
    };
  }, [collaborationClient, homeScopeKey, sharingSessionKey]);

  const loadLocalRunnerAvailability = useCallback(async () => {
    const sequence = ++runnerRequestSequenceRef.current;
    runnerControllerRef.current?.abort();
    const controller = new AbortController();
    runnerControllerRef.current = controller;
    setLocalRunnerAvailability("checking");
    try {
      const payload = await managedRequest(
        "/launch-options",
        undefined,
        controller.signal
      );
      if (controller.signal.aborted) return;
      if (!Array.isArray(payload.instances)) {
        throw new Error("Invalid launch options response");
      }
      const instances = parseLaunchInstances(payload);
      if (sequence !== runnerRequestSequenceRef.current) return;
      setModelOptions(instances.flatMap((instance) => instance.models));
      setLocalRunnerAvailability(
        instances.some((instance) => instance.models.length > 0)
          ? "available"
          : "unavailable"
      );
    } catch {
      if (
        sequence === runnerRequestSequenceRef.current &&
        !controller.signal.aborted
      ) {
        setModelOptions([]);
        setLocalRunnerAvailability("unknown");
      }
    } finally {
      if (sequence === runnerRequestSequenceRef.current) {
        runnerControllerRef.current = null;
        setModelOptionsLoaded(true);
      }
    }
  }, []);

  const refresh = useCallback(() => {
    void load();
    void loadLocalRunnerAvailability();
  }, [load, loadLocalRunnerAvailability]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    void loadLocalRunnerAvailability();
    return () => {
      requestSequenceRef.current += 1;
      controllerRef.current?.abort();
      runnerRequestSequenceRef.current += 1;
      runnerControllerRef.current?.abort();
      runnerControllerRef.current = null;
    };
  }, [load, loadLocalRunnerAvailability]);
  const allRecents = filterHomeCollections(
    {
      executions: [],
      requests: [],
      recents: usable && snapshot?.coverage.recents ? snapshot.recents : []
    },
    null
  ).recents;
  const coveredExecutions = useMemo(
    () => (usable && snapshot?.coverage.executions ? snapshot.executions : []),
    [usable, snapshot]
  );
  const providerSourceIdsByExecution = useMemo(() => {
    return managedProviderSourceIdsByExecution({
      recents: allRecents,
      executions: coveredExecutions
    });
  }, [allRecents, coveredExecutions]);
  const browseRecents = personalRemovalState.ready
    ? allRecents.filter((recent) => {
        if (
          hasProjectRemoval(
            personalRemovalState.removals,
            recent.projectId ?? ""
          )
        )
          return false;
        const provider = normalizeConversationProvider(recent.provider);
        const sourceId = provider
          ? `${provider}:${encodeURIComponent(recent.id)}`
          : null;
        const executionId =
          (provider
            ? matchManagedExecutionForCapturedSession({
                sessionId: recent.sessionId,
                provider,
                executions: coveredExecutions
              })
            : null) ??
          coveredExecutions.find(
            (execution) => execution.sessionId === recent.sessionId
          )?.id ??
          null;
        return !hasConversationRemoval(personalRemovalState.removals, [
          sourceId,
          executionId ? `managed:${executionId}` : null
        ]);
      })
    : [];
  const browseExecutions = personalRemovalState.ready
    ? coveredExecutions.filter(
        (execution) =>
          !hasProjectRemoval(
            personalRemovalState.removals,
            execution.projectId ?? ""
          ) &&
          !hasConversationRemoval(personalRemovalState.removals, [
            `managed:${execution.id}`
          ])
      )
    : [];
  const removePersonalItem = useCallback(
    async (target: PersonalRemovalTarget) => {
      let resolvedTarget = target;
      if (target.kind === "project") {
        if (filter === target.projectId) setFilter(null);
      } else {
        const executionId = target.sourceId.startsWith("managed:")
          ? target.sourceId.slice("managed:".length)
          : Object.entries(providerSourceIdsByExecution).find(([, sourceIds]) =>
              sourceIds.includes(target.sourceId)
            )?.[0];
        if (executionId) {
          resolvedTarget = managedConversationRemovalTarget({
            executionId,
            providerSourceIds: providerSourceIdsByExecution[executionId]
          });
        }
      }
      await personalRemovalState.remove(resolvedTarget);
    },
    [filter, personalRemovalState, providerSourceIdsByExecution]
  );
  const collections = filterHomeCollections(
    {
      executions: browseExecutions,
      requests: usable && snapshot?.coverage.requests ? snapshot.requests : [],
      recents: browseRecents
    },
    filter
  );
  const recents = collections.recents;
  const executions = collections.executions;
  const executionForRecent = (recent: HomeRecent) => {
    const provider = normalizeConversationProvider(recent.provider);
    const executionId = provider
      ? matchManagedExecutionForCapturedSession({
          sessionId: recent.sessionId,
          provider,
          executions
        })
      : null;
    return executions.find((candidate) => candidate.id === executionId);
  };
  const resumableRecents = recents.flatMap((recent) => {
    const execution = executionForRecent(recent);
    return execution ? [{ recent, executionId: execution.id }] : [];
  });
  const displayedConversationRecents = recents.flatMap((recent) => {
    const execution = executionForRecent(recent);
    const memory = ownerMemoryBySessionId.get(recent.sessionId);
    return execution || memory
      ? [
          {
            recent,
            executionId: execution?.id ?? null,
            execution,
            memory: memory ?? null
          }
        ]
      : [];
  });
  const projects = homeProjects(browseRecents, browseExecutions);
  const firstModelOption = modelOptions[0];
  const firstModelEffort =
    firstModelOption?.supportedReasoningEfforts.find(
      (effort) => effort.trim().toLowerCase() === "medium"
    ) ?? firstModelOption?.supportedReasoningEfforts[0];
  const prompts = [
    "What should I work on next?",
    "Help me think through a problem",
    ...(resumableRecents[0]
      ? [`Recap ${resumableRecents[0].recent.title}`]
      : [])
  ];
  const startChat = (prompt: string, selection?: ChatComposerSelection) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onStartChat(trimmed, filter ?? undefined, selection);
    setDraft("");
  };
  return (
    <div className="flex h-full min-h-0 w-full">
      <StudioSidebar
        projects={projects}
        personalScopeKey={personalScopeKey}
        homeBadgeCount={homeFeed.snapshot?.badgeCount ?? 0}
        showLocalCatalog
        managedConversations={executions}
        managedSourceIds={[
          ...managedConversationSourceIds({
            recents: allRecents,
            executions: coveredExecutions
          })
        ]}
        personalRemovals={personalRemovalState.removals}
        personalRemovalsReady={personalRemovalState.ready}
        personalRemovalError={personalRemovalState.error}
        onRetryPersonalRemovals={() =>
          void personalRemovalState.load().catch(() => undefined)
        }
        onRemovePersonalItem={
          personalRemovalState.ready ? removePersonalItem : undefined
        }
        lastRemovedPersonalItem={personalRemovalState.lastRemoved}
        onUndoPersonalRemoval={
          personalRemovalState.ready ? personalRemovalState.undoLast : undefined
        }
        managedProviderSourceIds={providerSourceIdsByExecution}
        canShareLocalSource={(sourceId, provider) =>
          ownerMemoryForLocalSource.has(
            `${provider}:${encodeURIComponent(sourceId)}`
          )
        }
        onShareLocalSource={(sourceId, provider) => {
          const memory = ownerMemoryForLocalSource.get(
            `${provider}:${encodeURIComponent(sourceId)}`
          );
          if (!memory) return;
          if (ownerSharingAuthorityKey && homeScopeKey)
            setShareConversation({
              sessionId: memory.id,
              memory,
              authorityKey: ownerSharingAuthorityKey,
              homeScopeKey
            });
        }}
        canShareManagedExecution={(executionId) =>
          ownerMemoryForExecution.has(executionId)
        }
        onShareManagedExecution={(executionId) => {
          const memory = ownerMemoryForExecution.get(executionId);
          if (!memory) return;
          if (ownerSharingAuthorityKey && homeScopeKey)
            setShareConversation({
              sessionId: memory.id,
              memory,
              authorityKey: ownerSharingAuthorityKey,
              homeScopeKey
            });
        }}
        onSelectManagedExecution={onResumeChat}
        collapsed={collapsed}
        selectedProject={filter}
        onProjectSelect={(projectId) => setFilter(projectId || null)}
        onToggle={() => setCollapsed((value) => !value)}
        onLocalSourceSelect={async (sourceId, provider, signal) => {
          const match = matchLocalConversationToHome({
            sourceId,
            provider,
            recents: allRecents,
            executions
          });
          if (match?.type === "managed") {
            onResumeChat(match.executionId);
            return { type: "managed", executionId: match.executionId };
          }
          if (match?.type === "captured") {
            const executionId = matchManagedExecutionForCapturedSession({
              sessionId: match.recent.sessionId,
              provider,
              executions
            });
            if (executionId) {
              onResumeChat(executionId);
              return { type: "managed", executionId };
            }
            return {
              type: "unavailable",
              message: `This ${provider} conversation is captured in Koed, but it has no active Koed-managed execution. Studio cannot continue or send messages here.`
            };
          }

          const query = new URLSearchParams({ sourceId });
          let payload: unknown;
          try {
            const response = await fetch(
              `/studio-api/local-conversations/resolve?${query}`,
              {
                headers: { Accept: "application/json" },
                cache: "no-store",
                signal
              }
            );
            payload = await response.json().catch(() => null);
            if (!response.ok) {
              return {
                type: "unavailable",
                message:
                  "Koed could not verify whether this source has captured conversation history. Studio cannot show a transcript or send messages."
              };
            }
          } catch (error) {
            if (signal.aborted) throw error;
            return {
              type: "unavailable",
              message:
                "Koed could not verify whether this source has captured conversation history. Studio cannot show a transcript or send messages."
            };
          }
          if (!payload || typeof payload !== "object") {
            return {
              type: "unavailable",
              message:
                "Koed returned no source verification result. Studio cannot show a transcript or send messages."
            };
          }
          const resolved = payload as {
            state?: unknown;
            sessionId?: unknown;
            title?: unknown;
            projectName?: unknown;
            provider?: unknown;
          };
          if (resolved.state === "not_captured") {
            return {
              type: "unavailable",
              message: `This local ${provider} conversation is not captured in Koed and has no writable managed execution. Continue it in ${provider}; Studio cannot show its transcript or send messages.`
            };
          }
          if (resolved.state === "unauthorized") {
            return {
              type: "unavailable",
              message:
                "Koed did not authorize access to captured conversation history. Studio cannot show a transcript or send messages."
            };
          }
          if (resolved.state !== "captured") {
            return {
              type: "unavailable",
              message:
                "Koed could not verify whether this source has captured conversation history. Studio cannot show a transcript or send messages."
            };
          }
          if (
            typeof resolved.sessionId !== "string" ||
            !resolved.sessionId ||
            typeof resolved.title !== "string" ||
            typeof resolved.projectName !== "string" ||
            typeof resolved.provider !== "string" ||
            normalizeConversationProvider(resolved.provider) !== provider
          ) {
            return {
              type: "unavailable",
              message:
                "Koed returned an incomplete or mismatched source verification result. Studio cannot show a transcript or send messages."
            };
          }
          const executionId = matchManagedExecutionForCapturedSession({
            sessionId: resolved.sessionId,
            provider,
            executions
          });
          if (executionId) {
            onResumeChat(executionId);
            return { type: "managed", executionId };
          }
          return {
            type: "unavailable",
            message: `This ${provider} conversation is captured in Koed, but it has no active Koed-managed execution. Studio cannot continue or send messages here.`
          };
        }}
        onNewChat={onNewChat}
        onMoveManagedExecution={onMoveManagedExecution}
        onNewProject={onNewProject}
        canCreateLocalProject={canCreateLocalProject}
        onPullRequests={onPullRequests}
        onPlugins={onPlugins}
      />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="z-10 flex h-14 items-center justify-between gap-3 bg-background/80 px-4 pt-4 backdrop-blur-sm drag-region">
          <p className="text-sm text-foreground no-drag">Home</p>
          <div className="flex items-center gap-1 no-drag">
            <button
              type="button"
              disabled={!onNewChat}
              onClick={onNewChat}
              title="New chat"
              className="rounded-md px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              New chat
            </button>
            <button
              type="button"
              disabled={!canCreateLocalProject || !onNewProject}
              onClick={onNewProject}
              title={
                canCreateLocalProject
                  ? "New project"
                  : "New projects are available in Koed Studio for Electron."
              }
              className="rounded-md px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              New project
            </button>
          </div>
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3 sm:p-4">
          <div className="mx-auto max-w-2xl space-y-8 pb-20 pt-8">
            <section>
              <div className="mb-2 px-1">
                <h1 className="text-[26px] font-medium text-foreground">
                  {greeting()}
                </h1>
              </div>
              <div className="flex items-center justify-between gap-3 px-1">
                <p className="text-[15px] text-muted" aria-live="polite">
                  {loadState === "loading"
                    ? "Checking your personal Home…"
                    : loadState === "offline"
                      ? "Home could not be reached. Your data is not available right now."
                      : snapshot?.state === "unauthorized"
                        ? "Personal Home is not authorized for this session."
                        : snapshot?.state === "unavailable"
                          ? "Personal Home is unavailable right now."
                          : homeSummary(homeFeed.snapshot?.badgeCount ?? 0)}
                </p>
                <button
                  type="button"
                  onClick={refresh}
                  disabled={refreshing}
                  title="Refresh Home"
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-subtle transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                >
                  {refreshing ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              <p className="mt-1 px-1 text-xs text-subtle" aria-live="polite">
                Local runner:{" "}
                {localRunnerAvailability === "checking"
                  ? "checking availability…"
                  : localRunnerAvailability === "available"
                    ? "available"
                    : localRunnerAvailability === "unavailable"
                      ? "no ready local instance or model is available"
                      : "availability unknown"}
              </p>
            </section>
            <section className="no-drag" aria-label="Start a chat">
              <SharedChatUI
                mode={{ kind: "agent", controls: "execution" }}
                scopeKey={`home:${homeScopeKey ?? "unavailable"}`}
                messages={[]}
                composerOnly
                composer={
                  <ChatComposer
                    placeholder="Ask Koed anything…"
                    projectName={
                      projects.find((project) => project.id === filter)?.name ??
                      "Personal"
                    }
                    branch="local"
                    value={draft}
                    onChange={setDraft}
                    onSend={(text, selection) => {
                      const hasVerifiedModel = modelOptions.some(
                        (option) =>
                          option.provider === selection.provider &&
                          option.id === selection.model
                      );
                      startChat(text, hasVerifiedModel ? selection : undefined);
                    }}
                    clientResourceScope={{ projectId: filter ?? null }}
                    modelOptions={modelOptions}
                    initialModel={
                      firstModelOption
                        ? `${firstModelOption.provider}:${firstModelOption.id}`
                        : undefined
                    }
                    initialEffort={firstModelEffort}
                    key={
                      modelOptionsLoaded
                        ? "home-model-options-loaded"
                        : "home-model-options-loading"
                    }
                    footer={
                      modelOptionsLoaded && modelOptions.length > 0
                        ? "Opens a draft chat only. Nothing is sent yet. Available model settings carry over."
                        : "Opens a draft chat only. Nothing is sent yet. Live model settings load in the chat."
                    }
                    showExecutionControls
                  />
                }
              />
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {prompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => setDraft(prompt)}
                    className="rounded-full px-2.5 py-1 text-xs text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </section>
            {loadState === "loading" && (
              <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-subtle">
                <LoaderCircle className="animate-spin" size={17} />
                Loading Home…
              </div>
            )}
            {loadState === "offline" && (
              <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center text-sm text-danger">
                <CircleAlert size={18} />
                <p>Koed is offline or the Home service cannot be reached.</p>
                <button
                  type="button"
                  onClick={refresh}
                  className="rounded-md border border-border-strong px-3 py-1.5 text-xs text-muted"
                >
                  Retry
                </button>
              </div>
            )}
            {snapshot?.state === "unauthorized" && (
              <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-danger">
                <CircleAlert size={18} />
                {snapshot.message ??
                  "Personal Home is not authorized for this session."}
              </div>
            )}
            {snapshot?.state === "unavailable" && (
              <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center text-sm text-danger">
                <AlertTriangle size={18} />
                <p>
                  {snapshot.message ??
                    "Personal Home is unavailable right now."}
                </p>
                <button
                  type="button"
                  onClick={refresh}
                  className="rounded-md border border-border-strong px-3 py-1.5 text-xs text-muted"
                >
                  Retry
                </button>
              </div>
            )}
            <HomeAttentionView
              state={homeFeed.state}
              snapshot={homeFeed.snapshot}
              refreshing={homeFeed.refreshing}
              mutationError={homeFeed.mutationError}
              pendingItemIds={homeFeed.pendingItemIds}
              loadingSources={homeFeed.loadingSources}
              canMutate={homeFeed.canMutate}
              onRefresh={() => void homeFeed.refresh()}
              onOpen={onOpenHomeItem}
              onSetCleared={(item, cleared) =>
                void homeFeed.setCleared(item, cleared)
              }
              onLoadMore={(source) => void homeFeed.loadMore(source)}
            />
            {usable && snapshot && (
              <>
                <section className="border-t border-border pt-5">
                  <button
                    type="button"
                    aria-expanded={recentsOpen}
                    aria-controls="home-recents"
                    onClick={() => setRecentsOpen((value) => !value)}
                    className="flex items-center gap-2 px-1 text-sm font-medium text-foreground"
                  >
                    <ChevronRight
                      className={`h-3.5 w-3.5 text-subtle transition-transform ${recentsOpen ? "rotate-90" : ""}`}
                    />
                    Pick up where you left off
                    {displayedConversationRecents.length > 0 && (
                      <span className="text-[11px] text-faint">
                        {displayedConversationRecents.length}
                      </span>
                    )}
                  </button>
                  {recentsOpen && (
                    <div id="home-recents" className="mt-3">
                      {displayedConversationRecents.length === 0 ? (
                        <p className="px-1 text-sm text-subtle">
                          Your resumable chats will appear here.
                        </p>
                      ) : (
                        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface/30">
                          {displayedConversationRecents.map(
                            ({ recent, executionId, execution, memory }) => (
                              <li
                                key={recent.id}
                                className="flex items-center gap-1 pr-2"
                              >
                                <button
                                  type="button"
                                  disabled={!executionId}
                                  onClick={() =>
                                    executionId && onResumeChat(executionId)
                                  }
                                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-hover/50 disabled:cursor-not-allowed"
                                >
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm text-foreground">
                                      {recent.title}
                                    </span>
                                    <span className="block truncate text-xs text-muted">
                                      {isSyntheticIndependentProject(
                                        recent.projectId,
                                        recent.projectName
                                      ) || !recent.projectId
                                        ? "No Project"
                                        : recent.projectName}{" "}
                                      · {recent.provider ?? "AI client"}
                                      {execution &&
                                      ["stopped", "failed", "fenced"].includes(
                                        execution.state
                                      )
                                        ? ` · ${managedConversationActivityLabel(execution.activity, execution.state)}`
                                        : ""}
                                      {executionId
                                        ? ""
                                        : " · captured, cannot continue here"}
                                    </span>
                                  </span>
                                  <span className="flex-shrink-0 text-xs text-faint">
                                    {formatHomeTime(recent.updatedAt)}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  disabled={!memory}
                                  onClick={() =>
                                    memory &&
                                    ownerSharingAuthorityKey &&
                                    homeScopeKey &&
                                    setShareConversation({
                                      sessionId: memory.id,
                                      memory,
                                      authorityKey: ownerSharingAuthorityKey,
                                      homeScopeKey
                                    })
                                  }
                                  aria-label={`Share ${recent.title} with a Team`}
                                  title={
                                    memory
                                      ? "Share processed Personal Memory"
                                      : "This conversation has no verified Personal Memory source yet"
                                  }
                                  className="shrink-0 rounded-md p-1.5 text-faint hover:bg-surface-hover hover:text-foreground-secondary disabled:cursor-not-allowed disabled:opacity-30"
                                >
                                  <Share2 className="h-3.5 w-3.5" />
                                </button>
                              </li>
                            )
                          )}
                        </ul>
                      )}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </main>
      </div>
      {activeShareConversation && ownerSharingSession?.snapshot ? (
        <OwnedConversationShareDialog
          key={`${homeScopeKey}:${activeShareConversation.sessionId}`}
          client={collaborationClient}
          source={activeShareConversation.memory}
          teams={ownerSharingSession.snapshot.navigation.teams
            .filter((team) => team.lifecycle === "active")
            .map(({ id, name }) => ({ id, name }))}
          onClose={() => setShareConversation(null)}
        />
      ) : null}
    </div>
  );
}

function formatHomeTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown time"
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      }).format(date);
}
